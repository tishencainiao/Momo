#!/usr/bin/env node
/* 测试：给主人的报告（整合版，plugins/report.js）
 * 用临时目录造数据，不联网、不碰真实 data/
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "momo-report-"));
const DATA = path.join(TMP, "data");
const SELF = path.join(TMP, "self");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(SELF, { recursive: true });

const now0 = Date.now();
const today = new Date();

// ---- 造数据 ----
fs.writeFileSync(path.join(DATA, "actions.jsonl"), [
  { ts: now0 - 60000, action: "chat", detail: "x" },
  { ts: now0 - 40000, action: "body_play", detail: "开心" },
  { ts: now0 - 300000000, action: "chat", detail: "old" },   // 很久以前，不该算进日报
].map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");

fs.writeFileSync(path.join(DATA, "body-events.jsonl"), [
  { ts: now0 - 20000, event: "click", x: 1, y: 2 },
  { ts: now0 - 15000, event: "click", x: 1, y: 2 },
  { ts: now0 - 10000, event: "self_play", anim: "东张西望" },
  { ts: now0 - 5000, event: "walk", dx: 100 },
].map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");

fs.writeFileSync(path.join(SELF, "journal.json"), JSON.stringify([
  { ts: now0 - 70000, text: "学会了在主人忙的时候安静待着", from: 1 },
  { ts: now0 - 60000, type: "adopt", title: "把回复变短了一点", text: "回复太啰嗦，改成简短" },
  { ts: now0 - 50000, type: "adopt", title: "记住主人爱喝温水", text: "主人说要温水" },
]), "utf8");
fs.writeFileSync(path.join(SELF, "selfmod-proposals.json"), JSON.stringify([
  { goal: "确实，非常香", name: "xiang", status: "pending" },
  { goal: "旧的想法", name: "old", status: "rejected" },
]), "utf8");
fs.writeFileSync(path.join(DATA, "budget.json"), JSON.stringify({ spent_cny: 0.66 }), "utf8");
fs.writeFileSync(path.join(DATA, "headpat.json"), JSON.stringify({ total: 42 }), "utf8");
fs.writeFileSync(path.join(DATA, "goals.json"), JSON.stringify({ goals: ["让主人开心"] }), "utf8");
fs.writeFileSync(path.join(DATA, "wishes.json"), JSON.stringify([{ text: "想要一张新表情" }]), "utf8");
fs.writeFileSync(path.join(DATA, "mind.json"), JSON.stringify({ thought: "想被摸头" }), "utf8");

// ---- ctx 桩 ----
const settingsStore = new Map();
const captured = { prompt: [], journalWritten: false, sent: [] };
const ctx = {
  DATA_DIR: DATA,
  SELF_DIR: SELF,
  config: { qq: { master_user: 1000 }, budget: { daily_cny: 1 } },
  apiKey: "test-key",
  isMaster: (u) => Number(u) === 1000,
  todayText: () => "2026-11-08 23:05",
  settings: () => ({ model: "test" }),
  getSetting: (k, d) => (settingsStore.has(k) ? settingsStore.get(k) : d),
  completeOnce: async (msgs) => { captured.prompt.push(String(msgs && msgs[0] && msgs[0].content || "")); return "这是一份测试报告：今天很有趣，花了 ¥0.66，还剩 ¥0.34。"; },
  log: () => {},
  recordAction: () => {},
  recordAndSend: async (u, t) => { captured.sent.push({ u, t }); },
  sendPrivate: () => {},
};

const plugin = require(path.join(ROOT, "plugins", "report.js"));
plugin.init(ctx);
const T = plugin.__test;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

// ---------- 日期/窗口 ----------
check("dayKey 格式", T.dayKey(new Date(2026, 10, 8)) === "2026-11-08");
check("monthKey 格式", T.monthKey(new Date(2026, 10, 8)) === "2026-11");
check("isoWeekKey 含 W", T.isoWeekKey(new Date(2026, 10, 8)).indexOf("-W") > 0);
check("日窗口起点=当天0点", T.windowStart("day", new Date(2026, 10, 8, 23, 0).getTime()) === new Date(2026, 10, 8, 0, 0).getTime());
check("周窗口起点=周一0点", T.windowStart("week", new Date(2026, 10, 8, 23, 0).getTime()) === new Date(2026, 10, 2, 0, 0).getTime());
check("月窗口起点=1号0点", T.windowStart("month", new Date(2026, 10, 8, 23, 0).getTime()) === new Date(2026, 10, 1, 0, 0).getTime());

// ---------- 采集 ----------
const st = T.collect("day", now0);
check("日报只取当天动作", st.actions.length === 2);
check("采集到自主实现(adopt)", st.adopted.length === 2 && st.adopted[0].indexOf("变短") >= 0);
check("采集到待批(仅pending)", st.proposals.length === 1 && st.proposals[0] === "确实，非常香");
check("生活费读对", Number(st.budget.spent_cny) === 0.66 && st.daily === 1);
check("身体事件统计", st.bodyEvents.filter((e) => e.event === "click").length === 2);
check("月报窗口含更多动作", T.collect("month", now0).actions.length >= T.collect("day", now0).actions.length);

// ---------- 周期判定（23:00，月>周>日）----------
// 2026-11-08 是周日；2026-11-01 是周日且是1号
const emptyState = { daily: "", weekly: "", monthly: "" };
check("23点前不发", T.dueKind(new Date(2026, 10, 8, 22, 59).getTime(), emptyState) === "");
check("普通日23点=日报", T.dueKind(new Date(2026, 10, 9, 23, 1).getTime(), emptyState) === "day");
check("周日23点=周报", T.dueKind(new Date(2026, 10, 8, 23, 1).getTime(), emptyState) === "week");
check("1号23点=月报(优先于周报)", T.dueKind(new Date(2026, 10, 1, 23, 1).getTime(), emptyState) === "month");
check("已发周报则回落到日报", T.dueKind(new Date(2026, 10, 8, 23, 1).getTime(), { daily: "", weekly: T.isoWeekKey(new Date(2026, 10, 8)), monthly: "" }) === "day");
check("当日已发则不再发", T.dueKind(new Date(2026, 10, 9, 23, 1).getTime(), { daily: T.dayKey(new Date(2026, 10, 9)), weekly: "", monthly: "" }) === "");

// ---------- 生成（mock LLM）----------
(async () => {
  const r = await T.buildReport(st);
  check("buildReport 返回 LLM 文本", r === "这是一份测试报告：今天很有趣，花了 ¥0.66，还剩 ¥0.34。");
  const prompt = captured.prompt[0] || "";
  check("提示词含生活费事实", prompt.indexOf("花了 ¥0.660") >= 0);
  check("提示词含自主实现", prompt.indexOf("变短") >= 0);
  check("提示词含待批想法", prompt.indexOf("确实，非常香") >= 0);
  check("提示词要求不列流水账", prompt.indexOf("不要流水账") >= 0);

  // ---------- 感知：写成长记忆 ----------
  T.rememberReport("报告内容 abc");
  const journalAfter = JSON.parse(fs.readFileSync(path.join(SELF, "journal.json"), "utf8"));
  check("发完写进 journal", journalAfter[journalAfter.length - 1].type === "report" && journalAfter[journalAfter.length - 1].text === "报告内容 abc");

  // journal 上限 200 截断
  for (let i = 0; i < 300; i++) T.rememberReport("填充 " + i);
  const journalBig = JSON.parse(fs.readFileSync(path.join(SELF, "journal.json"), "utf8"));
  check("journal 上限 200", journalBig.length === 200);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
