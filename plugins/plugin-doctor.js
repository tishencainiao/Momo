/* 插件：插件体检 —— plugin_doctor 工具 + /插件体检 命令 + 每日巡检（有问题才报）+ 落盘报告
 * 方式3(QQ命令) / 方式5(每日巡检，无问题不打扰) / 方式6(落盘 data/plugin-health.json)
 * 体检逻辑在 scripts/plugin-doctor.js（单一职责，check.js 也复用它）
 */
let _ctx = null;
const fs = require("fs");
const path = require("path");
const { diagnose, formatText } = require("../scripts/plugin-doctor");

const DATA = () => _ctx.DATA_DIR;
const SELF = () => _ctx.SELF_DIR;
const HEALTH_FILE = () => path.join(DATA(), "plugin-health.json");
const PATROL_FILE = () => path.join(DATA(), "plugin-patrol.json");

function readJson(file, def) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return def; } }
function pad2(n) { return String(n).padStart(2, "0"); }

/* 跑体检 + 落盘（方式6） */
function check() {
  const report = diagnose({ kernelVersion: _ctx.BASE_VERSION || "0.0.0" });
  try {
    fs.mkdirSync(DATA(), { recursive: true });
    fs.writeFileSync(HEALTH_FILE(), JSON.stringify({
      at: Date.now(), kernelVersion: report.kernelVersion, summary: report.summary,
      plugins: report.plugins.map((p) => ({ name: p.name, displayName: p.displayName, version: p.version, enabled: p.enabled, level: p.level })),
    }, null, 2));
  } catch (e) {}
  return report;
}

/* 给主人的问题简报（方式5，有问题才用；全绿返回空串） */
function issueBrief(report) {
  const s = report.summary;
  if (s.red === 0 && s.yellow === 0) return "";
  const lines = [`插件体检发现 ${s.red} 个硬问题、${s.yellow} 个缺元数据：`];
  for (const p of report.plugins) {
    if (p.level === "green") continue;
    const tag = p.level === "red" ? "🔴" : "🟡";
    const why = p.issues.slice(0, 2).map((i) => i.msg).join("；");
    lines.push(`${tag} ${p.name}：${why}`);
  }
  return lines.join("\n");
}

/* 感知：把巡检结论写进成长记忆，让她「知道」插件有问题（有问题才写） */
function rememberIssue(text) {
  try {
    const f = path.join(SELF(), "journal.json");
    const arr = readJson(f, []);
    arr.push({ type: "plugin_issue", ts: Date.now(), text: String(text).slice(0, 400) });
    while (arr.length > 200) arr.shift();
    fs.writeFileSync(f, JSON.stringify(arr), "utf8");
  } catch (e) {}
}

let lastTick = 0;

module.exports = {
  name: "plugin-doctor",
  displayName: "插件体检",
  description: "检查插件清单是否合规（plugin_doctor 工具 + /插件体检 命令 + 每日巡检 + 落盘报告）",
  version: "1.0.0",
  permissions: ["BASE_VERSION", "DATA_DIR", "SELF_DIR", "config", "getSetting", "isMaster", "log", "recordAction", "recordAndSend", "sendPrivate"],
  init(ctx) { _ctx = ctx; },
  apiSpec: {"pluginDoctor":{"check":{"input":"无","output":"report","sideEffect":"写 data/plugin-health.json"},"issueBrief":{"input":"无","output":"string","sideEffect":"只读"}}},

  api: { pluginDoctor: { check, issueBrief } },
  tools: [
    {
      def: {
        type: "function",
        function: {
          name: "plugin_doctor",
          description: "给插件平台做体检，报告哪些插件不满足规范（缺元数据/缺依赖/版本不满足/命名空间冲突）。主人说「插件体检」「检查下插件」「插件都正常吗」时调用。",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      async handler(args, info) {
        if (!_ctx.isMaster(info && info.userId)) return "（插件体检只给主人看哦）";
        const report = check();
        return formatText(report);
      },
    },
  ],
  commands: [
    {
      key: "/插件体检",
      regex: /^\/插件体检/,
      async handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "插件体检只给主人看哦～"); return; }
        const report = check();
        await _ctx.recordAndSend(msg.userId, formatText(report));
        _ctx.recordAction({ action: "plugin_doctor", ok: report.ok });
      },
    },
  ],
  settings: [
    { key: "plugin-doctor.enabled", label: "开启每日巡检", type: "boolean", default: true, desc: "每天自动巡检一次插件健康（无问题不打扰）" },
    { key: "plugin-doctor.patrol_time", label: "巡检时间", type: "string", default: "22:30", desc: "每天几点巡检（HH:MM）" },
  ],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (now - lastTick < 30000) return;   // 每 30 秒判断一次到点
      lastTick = now;
      if (_ctx.getSetting("plugin-doctor.enabled", true) === false) return;
      const d = new Date(now);
      const t = String(_ctx.getSetting("plugin-doctor.patrol_time", "22:30")).split(":").map(Number);
      const patrolMin = (t[0] || 22) * 60 + (t[1] || 30);
      const nowMin = d.getHours() * 60 + d.getMinutes();
      if (nowMin < patrolMin) return;       // 还没到点
      const today = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const state = readJson(PATROL_FILE(), { last: "" });
      if (state.last === today) return;     // 今天已巡检过
      const report = check();
      const brief = issueBrief(report);
      const master = Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
      if (brief && master) {
        _ctx.recordAndSend(master, "【插件体检】\n" + brief);
        rememberIssue(brief);
        _ctx.log("info", "插件巡检发现问题：" + report.summary.red + " 红 / " + report.summary.yellow + " 黄");
      }
      try { fs.writeFileSync(PATROL_FILE(), JSON.stringify({ last: today })); } catch (e) {}
    },
  },
  __test: { check, issueBrief, rememberIssue },
};
