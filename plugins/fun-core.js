/* 插件：娱乐公共底座（活动流水 + 每日次数闸门 + 娱乐预算闸门）
 * 所有娱乐插件（read-article / puzzle / buzz）共用：
 *   - 每次尝试都写一条流水（成功 ok:true，失败 ok:false）——失败也占当天次数，堵住"占预算不产出"
 *   - 每日总次数上限（默认 2，主人定的"一天自娱 1~2 次"）
 *   - 每类活动各自日上限
 *   - 娱乐子预算上限（默认 ¥0.3/天），独立于总生活费
 * 流水文件：data/activities.jsonl */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const MAX_LINES_KEEP = 2000;

function actFile() { return path.join(_ctx.DATA_DIR, "activities.jsonl"); }
function budgetFile() { return path.join(_ctx.DATA_DIR, "fun-budget.json"); }

function loadActivities(n) {
  try {
    const lines = fs.readFileSync(actFile(), "utf8").split("\n").filter(Boolean);
    return lines.slice(-(n || 300)).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

function appendActivity(item) {
  try {
    fs.mkdirSync(_ctx.DATA_DIR, { recursive: true });
    const rec = Object.assign({ ts: Date.now(), day: _ctx.dayStr ? _ctx.dayStr(0) : new Date().toDateString() }, item);
    fs.appendFileSync(actFile(), JSON.stringify(rec) + "\n");
    trim();
    return rec;
  } catch (e) { return null; }
}

/* 流水过长时截断（保留最近 MAX_LINES_KEEP 行） */
function trim() {
  try {
    const lines = fs.readFileSync(actFile(), "utf8").split("\n").filter(Boolean);
    if (lines.length <= MAX_LINES_KEEP) return;
    fs.writeFileSync(actFile(), lines.slice(-MAX_LINES_KEEP).join("\n") + "\n");
  } catch (e) {}
}

function todayList() {
  const day = _ctx.dayStr ? _ctx.dayStr(0) : new Date().toDateString();
  return loadActivities(300).filter((x) => x && x.day === day);
}
function todayCount(type) { return todayList().filter((x) => (type ? x.type === type : true)).length; }
function todayTotal() { return todayList().length; }
function lastOfType(type) {
  const list = loadActivities(300).filter((x) => x && x.type === type);
  return list.length ? list[list.length - 1] : null;
}

function dailyTotalMax() { return Number(_ctx.getSetting("entertainment.daily_self_max", 2)) || 2; }
function dailyCnyCap() { return Number(_ctx.getSetting("entertainment.daily_cny", 0.3)) || 0.3; }

function funSpentToday() {
  try {
    const d = JSON.parse(fs.readFileSync(budgetFile(), "utf8"));
    const day = _ctx.dayStr ? _ctx.dayStr(0) : new Date().toDateString();
    return d && d.day === day ? Number(d.spent) || 0 : 0;
  } catch (e) { return 0; }
}
function addFunSpent(cny) {
  try {
    const day = _ctx.dayStr ? _ctx.dayStr(0) : new Date().toDateString();
    const cur = funSpentToday();
    fs.mkdirSync(_ctx.DATA_DIR, { recursive: true });
    fs.writeFileSync(budgetFile(), JSON.stringify({ day, spent: cur + (Number(cny) || 0) }));
  } catch (e) {}
}

/* 闸门：能不能再玩一次
 * type: 活动类型；perTypeMax: 该类每天上限；costCny: 本次预计花费 */
function canPlay(type, perTypeMax, costCny) {
  if (_ctx.isBudgetExhausted && _ctx.isBudgetExhausted()) return { ok: false, reason: "生活费已用完" };
  if (todayTotal() >= dailyTotalMax()) return { ok: false, reason: `今天自娱已经 ${todayTotal()} 次（上限 ${dailyTotalMax()}）` };
  if (todayCount(type) >= (perTypeMax || 1)) return { ok: false, reason: `今天这类活动已经够了` };
  if (funSpentToday() + (Number(costCny) || 0) > dailyCnyCap()) return { ok: false, reason: "今天的娱乐预算用完了" };
  return { ok: true };
}

module.exports = {
  name: "fun-core",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  settings: [
    { key: "entertainment.daily_self_max", label: "每天自娱总次数上限", type: "number", default: 2, min: 0, max: 6, desc: "所有娱乐活动加起来，超过就不玩了" },
    { key: "entertainment.daily_cny", label: "每天娱乐预算上限（元）", type: "number", default: 0.3, min: 0, max: 2, desc: "独立于生活费的小钱包" },
  ],
  api: {
    "fun-core": { loadActivities, appendActivity, todayList, todayCount, todayTotal, lastOfType, canPlay, funSpentToday, addFunSpent, dailyTotalMax, dailyCnyCap },
  },
};
