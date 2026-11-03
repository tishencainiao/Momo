/* 插件：DSH 联动通知（读 %APPDATA%\dsh-pet-bridge\dsh-*.jsonl → QQ 通知主人）
 * 开关：/dsh通知 开|关（默认关闭，状态存 data/dsh-link.json）
 * 通知事件：question/requested（等回答）、approval/asked（等审批）、
 *           turn/end(error)、execution/failed、model_access、llm_error、agent/request-error
 * 注：仅 3a 单向（DSH→Momo）；3b 反向/3c 问答已按需求移除 */
const fs = require("fs");
const path = require("path");
const os = require("os");
let _ctx = null;

const STATE_FILE = () => path.join(_ctx.DATA_DIR, "dsh-link.json");
const BRIDGE_DIR = () => {
  if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "dsh-pet-bridge");
  return path.join(os.homedir(), process.platform === "darwin" ? "Library/Application Support/dsh-pet-bridge" : ".config/dsh-pet-bridge");
};
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")); } catch (e) { return { enabled: false, offsets: {}, lastNotify: {} }; }
}
function saveState(s) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE(), JSON.stringify(s)); } catch (e) {} }

let lastScan = 0;

function questionText(questions) {
  try {
    const arr = Array.isArray(questions) ? questions : [];
    const parts = arr.map((q) => {
      if (typeof q === "string") return q;
      if (q && typeof q === "object") return String(q.text || q.title || q.label || q.content || "").trim();
      return "";
    }).filter(Boolean);
    return parts.length ? parts.join("；").slice(0, 120) : "（有提问，请到 DSH 界面查看）";
  } catch (e) { return "（有提问，请到 DSH 界面查看）"; }
}

function notifyOnce(state, key, text, now) {
  const last = (state.lastNotify && state.lastNotify[key]) || 0;
  if (now - last < 10 * 60000) return false;   // 同类型 10 分钟冷却
  state.lastNotify = state.lastNotify || {};
  state.lastNotify[key] = now;
  saveState(state);
  const master = Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
  if (!master) return false;
  _ctx.recordAndSend(master, text).catch(() => {});
  _ctx.log("info", `DSH通知: ${text.slice(0, 60)}`);
  try { _ctx.recordAction({ action: "dsh_notify", by: 0, detail: String(text).slice(0, 80), ok: true }); } catch (e) {}
  return true;
}

function scanDshEvents(now) {
  const st = loadState();
  if (!st.enabled) return;
  const dir = BRIDGE_DIR();
  let files = [];
  try {
    const all = fs.readdirSync(dir);
    files = all.filter((f) => /^dsh-.*\.jsonl(\.1)?$/.test(f)).map((f) => path.join(dir, f));
  } catch (e) { return; }   // 目录不存在/没权限，静默
  for (const fp of files) {
    try {
      const content = fs.readFileSync(fp, "utf8");
      const lines = content.split("\n").filter(Boolean);
      const key = path.basename(fp);
      let off = Number((st.offsets && st.offsets[key]) || 0);
      if (off > lines.length) off = 0;   // 轮转重建：从头读（冷却去重兜底）
      const fresh = lines.slice(off);
      st.offsets = st.offsets || {};
      st.offsets[key] = lines.length;
      for (const line of fresh) {
        let rec = null;
        try { rec = JSON.parse(line); } catch (e) { continue; }
        if (!rec || rec.agent !== "dsh") continue;
        const ev = String(rec.event || "");
        const sid = String(rec.sessionId || rec.sourceTurn || "");
        if (ev === "question/requested") {
          notifyOnce(st, `q|${rec.callId || sid}`, `主人～DSH 在等您回答问题：${questionText(rec.questions)}（去 DSH 界面回答它，它就能继续跑）`, now);
        } else if (ev === "approval/asked") {
          notifyOnce(st, `a|${sid}`, `主人～DSH 在等待您的审批操作，记得去看一眼～`, now);
        } else if (ev === "execution/failed") {
          notifyOnce(st, `f|${sid}`, `主人～DSH 那边的任务执行失败结束了，需要您去看看～`, now);
        } else if (ev === "turn/end" && String(rec.reasonKind || "") === "error") {
          notifyOnce(st, `te|${sid}`, `主人～DSH 这轮任务出错结束了（${String(rec.reasonKind || "error")}），需要您去看看～`, now);
        } else if (ev === "model_access") {
          notifyOnce(st, `m|${sid}`, `主人～DSH 连不上模型了（连续重试失败 ${String(rec.errorCode || "")}），可能要检查网络或 Key～`, now);
        } else if (ev === "llm_error" || ev === "agent/request-error") {
          notifyOnce(st, `e|${sid}|${ev}`, `主人～DSH 那边报了个错（${ev}），需要您去看看～`, now);
        }
      }
      saveState(st);
    } catch (e) { /* 单文件读取失败静默 */ }
  }
}

module.exports = {
  name: "dsh-link",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  tools: [{
    def: { type: "function", function: { name: "dsh_notify", description: "开关 DSH（DeepSeek Harness）联动通知。当主人说「打开/关闭 DSH 的通知」「DSH 动态要不要提醒我」时调用。", parameters: { type: "object", properties: { enable: { type: "boolean", description: "true=开启通知 false=关闭通知" } }, required: ["enable"] } } },
    handler(args, info) {
      if (!_ctx.isMaster(info.userId)) return "（只有主人能设置这个哦）";
      const st = loadState();
      st.enabled = !!args.enable;
      saveState(st);
      return st.enabled ? "已开启 DSH 动态通知：DSH 等回答/等审批/出错时我会在 QQ 告诉你～" : "已关闭 DSH 动态通知～";
    },
  }],
  commands: [
    {
      key: "/dsh通知",
      regex: /^\/dsh通知/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能设置这个哦～"); return; }
        const arg = msg.text.replace(/^\/dsh通知\s*/, "").trim();
        const st = loadState();
        if (arg === "开" || arg.toLowerCase() === "on") {
          st.enabled = true; saveState(st);
          _ctx.sendPrivate(msg.userId, "好，DSH 的动态我会在 QQ 上通知你～（等回答/等审批/出错时）");
        } else if (arg === "关" || arg.toLowerCase() === "off") {
          st.enabled = false; saveState(st);
          _ctx.sendPrivate(msg.userId, "好，DSH 通知已关闭～");
        } else {
          _ctx.sendPrivate(msg.userId, `DSH 通知现在${st.enabled ? "开" : "关"}着（/dsh通知 开 或 关 切换）`);
        }
      },
    },
  ],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (now - lastScan < 10000) return;   // 每 10 秒扫一次
      lastScan = now;
      try { scanDshEvents(now); } catch (e) { /* 静默 */ }
    },
  },
};
