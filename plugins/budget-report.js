/* 插件：账单（每日账单 + 周报 + /花费 命令）
 * 数据源：data/budget.json（今日）+ data/budget-history.jsonl（每日归档，供周报）
 * 时间：每日 22:00 发账单、每周日 22:30 发周报（可在 config.budget_report 覆盖） */
const fs = require("fs");
const path = require("path");
let _ctx = null;
const budgetFile = () => path.join(_ctx.DATA_DIR, "budget.json");
const historyFile = () => path.join(_ctx.DATA_DIR, "budget-history.jsonl");
const stateFile = () => path.join(_ctx.DATA_DIR, "budget-report-state.json");

const KIND_LABEL = { chat: "聊天", reason: "思考", search: "搜索", vision: "看图" };

function loadBudget() { try { return JSON.parse(fs.readFileSync(budgetFile(), "utf8")); } catch (e) { return null; } }
function loadHistory() {
  try {
    return fs.readFileSync(historyFile(), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch (e) { return {}; } }
function saveState(s) { try { fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch (e) {} }
function cfgBR() { return (_ctx.config && _ctx.config.budget_report) || {}; }

function hmOf(now) { const d = new Date(now); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function dowOf(now) { return new Date(now).getDay(); }   // 0=周日

function breakdownLine(b) {
  const sb = b.spend_by || {};
  const parts = [];
  for (const [k, v] of Object.entries(sb)) if (v > 0) parts.push(`${KIND_LABEL[k] || k} ¥${v.toFixed(3)}`);
  return parts.length ? parts.join("、") : "暂无明细（今天还没花钱）";
}

function dailyBill(b) {
  const daily = Number((_ctx.config.budget && _ctx.config.budget.daily_cny) || 1);
  const pct = Math.round((b.spent_cny || 0) / daily * 100);
  const calls = Object.entries(b.calls || {}).map(([k, v]) => `${KIND_LABEL[k] || k} ${v}次`).join("、") || "无";
  return [
    `📊 今日账单`,
    `生活费：¥${(b.spent_cny || 0).toFixed(3)} / ¥${daily}（${pct}%）`,
    `花费明细：${breakdownLine(b)}`,
    `调用：${calls}`,
    `Token：入 ${b.tokens_in || 0} / 出 ${b.tokens_out || 0}`,
  ].join("\n");
}

function weeklyReport() {
  const hist = loadHistory();
  const b = loadBudget();
  if (b && b.spent_cny > 0) hist.push(b);
  const days = hist.slice(-7);
  if (!days.length) return null;
  const total = days.reduce((s, d) => s + (d.spent_cny || 0), 0);
  const byKind = {};
  for (const d of days) for (const [k, v] of Object.entries(d.spend_by || {})) byKind[k] = (byKind[k] || 0) + v;
  const kindStr = Object.entries(byKind).map(([k, v]) => `${KIND_LABEL[k] || k} ¥${v.toFixed(2)}`).join("、") || "无";
  const daily = Number((_ctx.config.budget && _ctx.config.budget.daily_cny) || 1);
  return [
    `📈 本周账单汇总（近 ${days.length} 天）`,
    `总花费：¥${total.toFixed(3)}（日均 ¥${(total / days.length).toFixed(3)}，日预算 ¥${daily}）`,
    `分类：${kindStr}`,
  ].join("\n");
}

let lastMin = "";
module.exports = {
  name: "budget-report",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  api: { budgetReport: { dailyBill, weeklyReport, loadBudget } },
  tools: [{
    def: { type: "function", function: { name: "budget_view", description: "查看今天/本周的生活费花销明细。当主人问「今天花多少了」「生活费花哪了」「这周花了多少钱」时调用。", parameters: { type: "object", properties: { range: { type: "string", description: "today=今天 / week=本周（默认 today）" } } } } },
    handler(args, info) {
      if (!_ctx.isMaster(info.userId)) return "（只有主人能看账单哦）";
      const range = String((args && args.range) || "today").toLowerCase();
      if (range === "week") { const r = weeklyReport(); return r || "（本周还没有账单数据）"; }
      const b = loadBudget();
      if (!b) return "（今天还没记账数据）";
      return dailyBill(b);
    },
  }],
  commands: [
    {
      key: "/花费",
      regex: /^\/花费/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能看账单哦～"); return; }
        const b = loadBudget();
        if (!b) { _ctx.sendPrivate(msg.userId, "今天还没记账数据～"); return; }
        _ctx.sendPrivate(msg.userId, dailyBill(b));
      },
    },
  ],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      const hm = hmOf(now);
      if (hm === lastMin) return;
      lastMin = hm;
      const br = cfgBR();
      const st = loadState();
      const today = new Date(now).toDateString();
      const master = Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
      if (!master) return;
      // 每日账单已并入「晚间播报」插件（evening-report.js），这里不再单独发
      // 每周账单（周日 18:00 单独发）
      const weeklyDay = Number(br.weekly_day ?? 0);
      const weeklyTime = br.weekly_time || "18:00";
      const weekKey = `${today}-${weeklyDay}`;
      if (hm === weeklyTime && dowOf(now) === weeklyDay && st.weeklyKey !== weekKey) {
        const r = weeklyReport();
        if (r) {
          st.weeklyKey = weekKey; saveState(st);
          _ctx.recordAndSend(master, r).catch(() => {});
          _ctx.log("info", "周报已发送");
        }
      }
    },
  },
};
