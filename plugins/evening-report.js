/* 插件：晚间播报 —— 22:00 合成一条（账单 + 今日小结 + 体检）
 * 周报仍由 budget-report 在周日 18:00 单独发
 * 依赖：budget-report（dailyBill/loadBudget）、health（checkPersona/recentReplies） */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const stateFile = () => path.join(_ctx.DATA_DIR, "evening-report-state.json");
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch (e) { return {}; } }
function saveState(s) { try { fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch (e) {} }
function hmOf(now) { const d = new Date(now); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }

/* 今日小结：从 journal 里取今天的成长记录，用 flash 生成 2~3 句 */
async function buildSummary() {
  try {
    let journal = [];
    try { journal = JSON.parse(fs.readFileSync(path.join(_ctx.SELF_DIR, "journal.json"), "utf8")); } catch (e) {}
    const master = Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
    const now0 = Date.now();
    const todayEntries = (Array.isArray(journal) ? journal : []).filter((e) => now0 - (e.ts || 0) < 24 * 3600e3).slice(-20);
    const parts = todayEntries.map((e) => {
      let who = "某次聊天";
      if (e.from != null && Number(e.from) === master) who = "和主人";
      else if (e.from != null && Number(e.from) !== 0) who = "和朋友";
      const txt = String(e.text || e.title || e.rule_id || "").slice(0, 40);
      return `${who}：${txt}`;
    }).join("\n");
    const prompt = `你是 Momo（大肥鱼桌宠）。今天（${_ctx.todayText()}）你的成长记录（每条前面标注了「和主人」还是「和朋友」，别搞混）：\n${parts || "（今天没什么特别的）"}\n请以 Momo 口吻写 2~3 句「今日小结」：今天自己做了什么、学到/记住了什么、心情怎么样。注意：主人的事和朋友的事要分清，不要把朋友的事说成主人的，也不要把主人的事说成朋友的。自然可爱，不要括号动作，不要标题。`;
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], _ctx.settings(), 300, 0.8);
    return String(raw || "").trim();
  } catch (e) { return ""; }
}

async function eveningReport() {
  const master = Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
  if (!master || !_ctx.apiKey) return;
  const sections = [];
  // 1. 账单
  const br = _ctx.getApi && _ctx.getApi("budgetReport");
  if (br && br.dailyBill) {
    const b = br.loadBudget ? br.loadBudget() : null;
    if (b) sections.push(br.dailyBill(b));
  }
  // 2. 小结
  const summary = await buildSummary();
  if (summary) sections.push(`🌱 今日小结：${summary}`);
  // 3. 体检（每天都带一句）
  const h = _ctx.getApi && _ctx.getApi("health");
  if (h && h.checkPersona && h.recentReplies) {
    const r = h.checkPersona(h.recentReplies(200));
    const bad = r.ai + r.long + r.repeat;
    sections.push(bad === 0 ? "🔍 体检：✅ 都很健康～" : `🔍 体检：AI 腔 ${r.ai} 条、太长 ${r.long} 条、复读 ${r.repeat} 处`);
  }
  if (!sections.length) return;
  await _ctx.recordAndSend(master, "主人～今天的晚间播报 📋\n" + sections.join("\n"));
  _ctx.log("info", "晚间播报已发送");
}

let lastMin = "";
module.exports = {
  name: "evening-report",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  requires: ["budgetReport", "health"],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      const hm = hmOf(now);
      if (hm === lastMin) return;
      lastMin = hm;
      if (hm !== "22:00") return;
      const st = loadState();
      const today = new Date(now).toDateString();
      if (st.date === today) return;
      st.date = today; saveState(st);
      eveningReport().catch((e) => _ctx.log("warn", "晚间播报失败: " + String(e.message).slice(0, 120)));
    },
  },
};
