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

/* v1.96.1 框架服务 time：中文时间词解析真相在 time 服务，这里只留薄转发 */
function _time() { try { return _ctx.getApi ? _ctx.getApi("time") : null; } catch (e) { return null; } }
function cnToNum(s) { const T = _time(); return T ? T.cnToNum(s) : NaN; }
function parseAmount(s) { const T = _time(); return T ? T.parseAmount(s) : NaN; }
function parseReminder(text) { const T = _time(); return T ? T.parseReminder(text) : null; }

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

module.exports = {
  name: "reminders",
  displayName: "提醒",
  description: "设提醒 + /提醒 + 到期检查定时器",
  userScoped: true,
  requires: ["time"],
  permissions: ["DATA_DIR", "formatGap", "getApi", "getSetting", "log", "recordAndSend", "sendPrivate"],
  version: "1.1.0",
  init(ctx) { _ctx = ctx; _dir = ctx.DATA_DIR; },
  apiSpec: {"reminders":{"parseReminder":{"input":"","output":"","sideEffect":""},"parseAmount":{"input":"","output":"","sideEffect":""},"cnToNum":{"input":"","output":"","sideEffect":""},"showDesktopToast":{"input":"","output":"","sideEffect":""}}},

  api: { reminders: { parseReminder, parseAmount, cnToNum, showDesktopToast } },
  settings: [
    { key: "reminder.desktop_toast", label: "提醒时弹桌面通知", type: "boolean", default: true, desc: "到期除了发 QQ，还在桌面上弹一个系统通知" },
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
      return `【成功】已设置提醒：${_ctx.formatGap(rem.dueTs - Date.now())}后提醒「${rem.text}」`;
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
        // v0.6：桌面上也播报一句（身体在跑时才有反应，失败静默）
        try {
          const ba = _ctx.getApi("body");
          if (ba && typeof ba.announce === "function") {
            ba.announce(`⏰ 到点啦：${x.text}`, { duration_ms: 8000 }).catch(() => {});
          }
        } catch (e) {}
        _ctx.log("info", `提醒触发 → ${x.userId}: ${x.text.slice(0, 30)}`);
      }
      if (changed) saveReminders(r);
    },
  },
};
