/* 插件：提醒（工具 set_reminder + 命令 /提醒 + 到期检查定时器）
 * v1.1.0：支持中文数字（一二两半…）；到期同时发 QQ 私聊 + Windows 桌面通知 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
let _dir = "", _ctx = null;
const remFile = () => path.join(_dir, "reminders.json");
function loadReminders() { try { return JSON.parse(fs.readFileSync(remFile(), "utf8")); } catch (e) { return []; } }
function saveReminders(r) { try { fs.mkdirSync(_dir, { recursive: true }); _ctx.writeJsonAtomic(remFile(), r); } catch (e) {} }
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
      const nid = "r" + Date.now().toString(36);
      /* Kimi 二轮 P0-3 方案 b：未到期的持久计划不进 open 行动表（不 propose），
       * 到期真正准备执行时才 tryBegin→end。这样重启对账不会把未来提醒误标 cancelled。 */
      const actKey = _ctx.actionKey ? _ctx.actionKey("reminder_fire", info.userId, rem.text, rem.dueTs) : "";
      r.push({ id: nid, userId: info.userId, text: rem.text, dueTs: rem.dueTs, done: false, actKey });
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
      const due = r.filter((x) => !x.done && x.dueTs <= now);
      if (!due.length) return;
      for (const x of due) {
        const key = x.actKey || (_ctx.actionKey ? _ctx.actionKey("reminder_fire", Number(x.userId) || 0, String(x.text), Number(x.dueTs) || 0) : "");
        if (key && x.actKey !== key) x.actKey = key;
        /* Kimi 二轮 P0-2：发送成功后才 done=true + endAction(succeeded)；
         * 失败写 failed 凭据、保留提醒下轮重试（最多 5 次后放弃），绝不「没发就记成功」。 */
        (async () => {
          if (x.done) return;
          const t = (key && _ctx.tryBeginAction)
            ? _ctx.tryBeginAction({ key, action: "reminder_fire", channel: "private", userId: Number(x.userId) || 0, requestedBy: Number(x.userId) || 0, detail: `提醒「${String(x.text).slice(0, 30)}」` })
            : { key, acquired: true };
          if (!t.acquired) return;   // 同键并发触发：交给已在执行的那次
          /* Kimi 三轮：消费语义化结果——只有 succeeded / duplicate_succeeded（此前已成功送达）才算发出 */
          const _sr = await _ctx.recordAndSend(Number(x.userId), `⏰ 提醒你：${x.text}`).catch(() => null);
          const sent = !!(_sr && (_sr.result === "succeeded" || _sr.result === "duplicate_succeeded"));
          if (sent) {
            x.done = true;
            if (key && _ctx.endAction) { try { _ctx.endAction(key, { ok: true, summary: "提醒已触发并发出" }); } catch (e) {} }
            if (cfgBool("reminder.desktop_toast", true)) showDesktopToast("Momo 提醒", x.text);
            // v0.6：桌面上也播报一句（身体在跑时才有反应，失败静默）
            try {
              const ba = _ctx.getApi("body");
              if (ba && typeof ba.announce === "function") {
                ba.announce(`⏰ 到点啦：${x.text}`, { duration_ms: 8000 }).catch(() => {});
              }
            } catch (e) {}
            _ctx.log("info", `提醒触发 → ${x.userId}: ${x.text.slice(0, 30)}`);
          } else {
            x.failCount = (x.failCount || 0) + 1;
            if (key && _ctx.endAction) { try { _ctx.endAction(key, { ok: false, error: "QQ 发送失败", summary: "提醒发送失败" }); } catch (e) {} }
            if (x.failCount >= 5) { x.done = true; _ctx.log("warn", `提醒重试 5 次仍失败，放弃 → ${x.userId}: ${String(x.text).slice(0, 30)}`); }
            else _ctx.log("warn", `提醒发送失败(${x.failCount}/5)，下轮重试 → ${x.userId}: ${String(x.text).slice(0, 30)}`);
          }
          saveReminders(r);
        })().catch((e) => { try { _ctx.log("warn", "提醒触发异常: " + String(e && e.message).slice(0, 80)); } catch (e2) {} });
      }
      saveReminders(r);   // actKey 回填立即落盘
    },
  },
};
