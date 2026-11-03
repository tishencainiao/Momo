/* 插件：提醒（工具 set_reminder + 命令 /提醒 + 到期检查定时器）
 * v1.1.0：支持中文数字（一二两半…）；到期同时发 QQ 私聊 + Windows 桌面通知 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
let _dir = "", _ctx = null;
const remFile = () => path.join(_dir, "reminders.json");
function loadReminders() { try { return JSON.parse(fs.readFileSync(remFile(), "utf8")); } catch (e) { return []; } }
function saveReminders(r) { try { fs.mkdirSync(_dir, { recursive: true }); fs.writeFileSync(remFile(), JSON.stringify(r)); } catch (e) {} }
function cfgBool(k, d) { try { const v = _ctx.getSetting(k, d); return v === false ? false : (v === true ? true : d); } catch (e) { return d; } }

/* 中文数字 → 数值（支持 一~九十九、半、两、一个半、二十） */
function cnToNum(s) {
  const t = String(s || "").trim();
  if (!t) return NaN;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const map = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (t === "十") return 10;
  if (t.indexOf("十") >= 0) {
    const parts = t.split("十");
    const hi = parts[0] === "" ? 1 : (map[parts[0]] || 0);
    const lo = parts[1] === "" ? 0 : (map[parts[1]] || 0);
    return hi * 10 + lo;
  }
  if (t.length === 1 && map[t] != null) return map[t];
  return NaN;
}
/* 数量：含「个」「半」（如 一个半、半小时、两） */
function parseAmount(s) {
  let t = String(s || "").trim().replace(/个/g, "");
  if (!t) return NaN;
  if (t === "半") return 0.5;
  if (t.endsWith("半")) {
    const base = t.slice(0, -1);
    const n = base === "" ? 1 : cnToNum(base);
    return Number.isFinite(n) ? n + 0.5 : NaN;
  }
  return cnToNum(t);
}

const AMOUNT = "([\\d零一二两三四五六七八九十百半个]+)";
const UNIT = "(分钟|分|小时|钟头|时|天)";
/* 清理提醒内容：去掉残留的「我/一下」等，太短就当没内容 */
function cleanContent(s) {
  let c = String(s || "").trim();
  c = c.replace(/^(一下|一句|下)/, "").trim();
  c = c.replace(/^[，。！？!?,.\s]+/, "").trim();
  if (!c || c.length < 2) return "";
  if (/^[我你他她它啊呀哦]$/.test(c)) return "";
  return c.slice(0, 60);
}
function parseReminder(text) {
  const s = String(text || "").replace(/\s+/g, "");
  // 1. 相对时间：「X分钟/小时后提醒我YY」「半小时后」「一个半小时后」
  let m = s.match(new RegExp(AMOUNT + UNIT + "(?:后|之后|以后)(?:提醒我|叫我|提醒一下|提醒|喊我)?[:：]?(.+)"));
  if (m) {
    const n = parseAmount(m[1]);
    if (Number.isFinite(n)) {
      const unit = String(m[2]);
      const ms = unit.startsWith("分") ? n * 60000 : (unit === "天" ? n * 86400e3 : n * 3600e3);
      const content = cleanContent(m[3]);
      if (content) return { dueTs: Date.now() + ms, text: content };
    }
  }
  // 2. 绝对时间：「明天/今晚/后天 X点Y分 提醒我ZZ」
  m = s.match(/(明天|明早|今晚|后天|今天)?(上午|下午|晚上|中午)?(\d{1,2}|[一二两三四五六七八九十]{1,3})[:：点时](\d{1,2}|[一二三四五六七八九十]{1,3})?分?(?:提醒我|叫我|提醒一下|提醒|喊我)?[:：]?(.+)/);
  if (m) {
    const dayWord = String(m[1] || "");
    const period = String(m[2] || "");
    let hour = parseAmount(m[3]);
    const min = m[4] ? parseAmount(m[4]) : 0;
    const content = cleanContent(m[5]);
    if (Number.isFinite(hour) && Number.isFinite(min) && content) {
      if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
      const now = new Date();
      let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, min, 0, 0);
      if (dayWord === "明天" || dayWord === "明早") target = new Date(target.getTime() + 86400e3);
      if (dayWord === "后天") target = new Date(target.getTime() + 2 * 86400e3);
      if (dayWord !== "明天" && dayWord !== "后天" && target.getTime() <= now.getTime()) target = new Date(target.getTime() + 86400e3);
      return { dueTs: target.getTime(), text: content };
    }
  }
  return null;
}

/* Windows 桌面通知（用系统 WinRT，无需装模块；-EncodedCommand 避免中文乱码） */
function showDesktopToast(title, body) {
  if (process.platform !== "win32") return;
  const t = String(title || "Momo").slice(0, 60);
  const b = String(body || "").slice(0, 200);
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null",
    "$tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$n = $tpl.GetElementsByTagName('text')",
    "$n.Item(0).AppendChild($tpl.CreateTextNode(" + JSON.stringify(t) + ")) | Out-Null",
    "$n.Item(1).AppendChild($tpl.CreateTextNode(" + JSON.stringify(b) + ")) | Out-Null",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Momo').Show($toast)",
  ].join("\n");
  try {
    const enc = Buffer.from(ps, "utf16le").toString("base64");
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc], { windowsHide: true, detached: true, stdio: "ignore" });
    p.unref();
  } catch (e) { if (_ctx && _ctx.log) _ctx.log("warn", "桌面通知失败: " + String(e.message).slice(0, 80)); }
}

let lastCheck = 0;

/* 桌宠待办文件：桌宠**只在启动时**读它，运行中会被它内存里的那份覆盖。
 * 所以写进去的条目能出现在「下次桌宠启动后的待办列表」里，但可能被桌宠自己的写入冲掉。 */
function petTodoFile() {
  try {
    const cp = _ctx.config && _ctx.config.pet && _ctx.config.pet.config_path;
    if (!cp) return null;
    return path.join(path.dirname(cp), "todo_items.json");
  } catch (e) { return null; }
}
function writePetTodo(text, dueTs) {
  if (!cfgBool("reminder.sync_pet_todo", true)) return false;
  const f = petTodoFile();
  if (!f) return false;
  try {
    if (!fs.existsSync(f)) return false;
    const d = new Date(dueTs);
    const pad = (n) => String(n).padStart(2, "0");
    const item = {
      id: crypto.randomBytes(16).toString("hex"),
      title: String(text || "").slice(0, 60),
      kind: "once",
      time: pad(d.getHours()) + ":" + pad(d.getMinutes()),
      date: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()),
      enabled: true,
      fired_lead_slot: "",
      fired_due_slot: "",
    };
    const cur = JSON.parse(fs.readFileSync(f, "utf8"));
    cur.items = Array.isArray(cur.items) ? cur.items : [];
    cur.items.push(item);
    fs.writeFileSync(f, JSON.stringify(cur, null, 2));
    return true;
  } catch (e) { return false; }
}

module.exports = {
  name: "reminders",
  version: "1.1.0",
  init(ctx) { _ctx = ctx; _dir = ctx.DATA_DIR; },
  api: { reminders: { parseReminder, parseAmount, cnToNum, showDesktopToast } },
  settings: [
    { key: "reminder.desktop_toast", label: "提醒时弹桌面通知", type: "boolean", default: true, desc: "到期除了发 QQ，还在桌面上弹一个系统通知" },
    { key: "reminder.sync_pet_todo", label: "提醒同步到桌宠待办", type: "boolean", default: true, desc: "写进桌宠的待办列表（桌宠启动时才会读到）" },
  ],
  tools: [{
    def: {
      type: "function",
      function: {
        name: "set_reminder",
        description: "设置定时提醒。当对方说「X分钟后/小时后/半小时后/明天X点提醒我XX」时调用（支持中文数字）。",
        parameters: { type: "object", properties: { content: { type: "string", description: "对方原话（含时间与内容）" } }, required: ["content"] },
      },
    },
    handler(args, info) {
      const raw = String(args.content || "");
      const rem = parseReminder(raw);
      if (!rem || !rem.text) {
        return "【失败】没听出时间和内容，提醒没有设置成功。请让对方说清楚「几分钟后」或「几点」，内容是什么。不要回答已经设好。";
      }
      const r = loadReminders();
      r.push({ id: "r" + Date.now().toString(36), userId: info.userId, text: rem.text, dueTs: rem.dueTs, done: false });
      saveReminders(r);
      const synced = writePetTodo(rem.text, rem.dueTs);
      return `【成功】已设置提醒：${_ctx.formatGap(rem.dueTs - Date.now())}后提醒「${rem.text}」${synced ? "（也记进桌宠待办了）" : ""}`;
    },
  }],
  commands: [{
    key: "/提醒",
    regex: /^\/提醒/,
    handler(msg) {
      const r = loadReminders().filter((x) => !x.done);
      if (!r.length) { _ctx.sendPrivate(msg.userId, "现在没有待办提醒哦～"); return; }
      const list = r.map((x, i) => `${i + 1}. ${x.text}（${_ctx.formatGap(x.dueTs - Date.now())}后）`).join("\n");
      _ctx.sendPrivate(msg.userId, `待办提醒：\n${list}`);
    },
  }],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (now - lastCheck < 30000) return;
      lastCheck = now;
      const r = loadReminders();
      let changed = false;
      for (const x of r) {
        if (x.done || x.dueTs > now) continue;
        x.done = true; changed = true;
        _ctx.recordAndSend(Number(x.userId), `⏰ 提醒你：${x.text}`).catch(() => {});
        if (cfgBool("reminder.desktop_toast", true)) showDesktopToast("Momo 提醒", x.text);
        _ctx.log("info", `提醒触发 → ${x.userId}: ${x.text.slice(0, 30)}`);
      }
      if (changed) saveReminders(r);
    },
  },
};
