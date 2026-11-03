/* 插件：健康（人格体检 /体检 + 每日自动体检 + 启动自检）
 * 数据源：data/replies.jsonl（由内核在 sendPrivate 时写入） */
const fs = require("fs");
const path = require("path");
let _ctx = null;
const repliesFile = () => path.join(_ctx.DATA_DIR, "replies.jsonl");

function recentReplies(n) {
  try {
    const lines = fs.readFileSync(repliesFile(), "utf8").split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

function checkPersona(recs) {
  const cliche = /作为(一个)?(AI|人工智能|语言模型|助手)|我是(AI|人工智能|语言模型)|综上所述|让我来为你|以下是[我你]?为|当然可以[，,]?让我/;
  let ai = 0, long = 0;
  const seen = new Map();
  for (const r of recs) {
    const t = String(r.text || "");
    if (cliche.test(t)) ai++;
    if (t.length > 300) long++;
    const k = t.slice(0, 40);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  let repeat = 0;
  for (const v of seen.values()) if (v >= 3) repeat++;
  return { total: recs.length, ai, long, repeat };
}

/* 合并体检：优先用 meta-cog 的逐条统计（含「括号动作」），没有才退回 replies 扫描 */
function metaStats() {
  try {
    const a = _ctx.getApi && _ctx.getApi("metaCog");
    if (a && a.loadState) return a.loadState();
  } catch (e) {}
  return null;
}
function unifiedCheck() {
  const mc = metaStats();
  if (mc && mc.stats && mc.stats.total) {
    const s = mc.stats;
    return { total: s.total, ai: s.ai || 0, long: s.long || 0, bracket: s.bracket || 0, repeat: s.repeat || 0 };
  }
  const r = checkPersona(recentReplies(100));
  return { total: r.total, ai: r.ai, long: r.long, bracket: 0, repeat: r.repeat };
}
function reportText(r) {
  const bad = r.ai + r.long + r.bracket + r.repeat;
  return `最近 ${r.total} 条回复体检：\nAI 腔 ${r.ai} 条、太长(>300字) ${r.long} 条、括号写动作 ${r.bracket} 条、复读 ${r.repeat} 处\n${bad === 0 ? "✅ 都很健康～" : "⚠️ 有点出戏，建议看看日志或让我调整人设"}`;
}

let lastReport = 0;

module.exports = {
  name: "health",
  version: "1.1.0",
  init(ctx) { _ctx = ctx; },
  api: { health: { checkPersona, recentReplies, unifiedCheck, reportText } },
  tools: [{
    def: { type: "function", function: { name: "health_check", description: "给自己做人格体检：检查最近回复有没有出戏（AI腔/太长/复读）。当主人说「体检一下」「你最近说话正不正常」时调用。", parameters: { type: "object", properties: {} } } },
    handler(args, info) {
      if (!_ctx.isMaster(info.userId)) return "（只有主人能给我体检哦）";
      return reportText(unifiedCheck());
    },
  }],
  commands: [
    {
      key: "/体检",
      regex: /^\/体检/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能给我体检哦～"); return; }
        _ctx.sendPrivate(msg.userId, reportText(unifiedCheck()));
      },
    },
  ],
  hooks: {
    startup() {
      try {
        const ok = !!_ctx.apiKey;
        _ctx.log(ok ? "info" : "error", `健康自检：apiKey=${ok ? "ok" : "MISSING"}`);
        if (!ok) {
          const master = Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
          if (master) _ctx.recordAndSend(master, "⚠️ 自检：我没读到 API Key，可能连不上模型，主人检查一下配置～").catch(() => {});
        }
      } catch (e) { _ctx.log("warn", "健康自检异常: " + (e.message || e)); }
    },
    timer(payload) {
      // 每日体检已并入「晚间播报」插件（evening-report.js），这里不再单独发
    },
  },
};
