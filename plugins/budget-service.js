/* 框架服务 · 预算（S4）
 * 生活费账本与价格表的唯一真相：所有计费/余额/档位判断都走这里。
 * 业务插件不要自己读 config.budget / 算百分比——用 api.budget（dailyCny()/budgetLine()/usageLine()/budgetLevel()…）。
 * 旧 index.js 函数已降级为薄转发，两版提交可回滚（绞杀者模式）。
 */
const fs = require("fs");
const path = require("path");

let _ctx = null;
const USD_CNY = 7.2;

function budgetFile() { return path.join(_ctx.DATA_DIR, "budget.json"); }
function historyFile() { return path.join(_ctx.DATA_DIR, "budget-history.jsonl"); }

/* 价格表（可被 config.json 的 budget.* 覆盖；pro 价=v4-pro 官方 $0.66/$0.022/$1.98） */
function budgetCfg() {
  const b = (_ctx.config && _ctx.config.budget) || {};
  return {
    daily_cny: Number(b.daily_cny) || 1,
    input_miss_cny_per_m: (Number(b.input_miss_cny_per_m) || 0) > 0 ? Number(b.input_miss_cny_per_m) : 0.15 * USD_CNY,
    input_hit_cny_per_m: (Number(b.input_hit_cny_per_m) || 0) > 0 ? Number(b.input_hit_cny_per_m) : 0.003 * USD_CNY,
    output_cny_per_m: (Number(b.output_cny_per_m) || 0) > 0 ? Number(b.output_cny_per_m) : 0.6 * USD_CNY,
    pro_input_miss_cny_per_m: (Number(b.pro_input_miss_cny_per_m) || 0) > 0 ? Number(b.pro_input_miss_cny_per_m) : 0.66 * USD_CNY,
    pro_input_hit_cny_per_m: (Number(b.pro_input_hit_cny_per_m) || 0) > 0 ? Number(b.pro_input_hit_cny_per_m) : 0.022 * USD_CNY,
    pro_output_cny_per_m: (Number(b.pro_output_cny_per_m) || 0) > 0 ? Number(b.pro_output_cny_per_m) : 1.98 * USD_CNY,
    peak_x2: b.peak_x2 !== false,
    search_cny: Number(b.search_cny) || 0.005,
  };
}
function dailyCny() { return budgetCfg().daily_cny; }

function isPeakHour() {
  const d = new Date();
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

function loadBudget() {
  const today = new Date().toDateString();
  const fresh = { date: today, spent_cny: 0, tokens_in: 0, tokens_hit: 0, tokens_out: 0, calls: {}, spend_by: {}, exhausted_notified: false };
  try {
    const b = JSON.parse(fs.readFileSync(budgetFile(), "utf8"));
    if (b.date !== today) {
      // 归档昨日账单（供周报/月报），只保留最近 400 天，避免无限增长
      try {
        fs.appendFileSync(historyFile(), JSON.stringify(b) + "\n");
        const lines = fs.readFileSync(historyFile(), "utf8").split("\n").filter(Boolean);
        if (lines.length > 400) _ctx.writeFileAtomic(historyFile(), lines.slice(-400).join("\n") + "\n");
      } catch (e) {}
      return fresh;
    }
    return Object.assign(fresh, b);
  } catch (e) { return fresh; }
}
function saveBudget(b) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); _ctx.writeJsonAtomic(budgetFile(), b); } catch (e) {} }

function recordSpend(kind, inTok, outTok, hitTok, flatCny, isPro) {
  const bc = budgetCfg();
  const mult = (bc.peak_x2 && isPeakHour()) ? 2 : 1;
  const b = loadBudget();
  b.tokens_in = (b.tokens_in || 0) + (inTok || 0);
  b.tokens_hit = (b.tokens_hit || 0) + (hitTok || 0);
  b.tokens_out = (b.tokens_out || 0) + (outTok || 0);
  b.calls = b.calls || {};
  b.calls[kind] = (b.calls[kind] || 0) + 1;
  const cost = ((inTok || 0) / 1e6) * (isPro ? bc.pro_input_miss_cny_per_m : bc.input_miss_cny_per_m) * mult + ((hitTok || 0) / 1e6) * (isPro ? bc.pro_input_hit_cny_per_m : bc.input_hit_cny_per_m) * mult + ((outTok || 0) / 1e6) * (isPro ? bc.pro_output_cny_per_m : bc.output_cny_per_m) * mult + (flatCny || 0);
  b.spent_cny = (b.spent_cny || 0) + cost;
  b.spend_by = b.spend_by || {};
  b.spend_by[kind] = (b.spend_by[kind] || 0) + cost;
  saveBudget(b);
  return b;
}
function isBudgetExhausted() { return (loadBudget().spent_cny || 0) >= budgetCfg().daily_cny; }

/* 生活费分级：剩余越少，能做的越少（rich >60% / normal 30~60% / tight 10~30% / empty <10%） */
function budgetLevel() {
  const b = loadBudget();
  const bc = budgetCfg();
  const daily = Number(bc.daily_cny) || 0;
  const spent = Number(b.spent_cny) || 0;
  const ratio = daily > 0 ? Math.max(0, 1 - spent / daily) : 0;
  let level = "empty";
  if (ratio > 0.6) level = "rich";
  else if (ratio > 0.3) level = "normal";
  else if (ratio > 0.1) level = "tight";
  return { ratio, level, spent, daily };
}
/* 模型档位（P2-c 预算降级阶梯）：按剩余预算选推理强度。full=pro+high推理 / low=pro+low推理 / flash=快模型思考 / minimal=快模型短答 */
function budgetTier() {
  const { ratio } = budgetLevel();
  if (ratio >= 0.5) return "full";
  if (ratio >= 0.2) return "low";
  if (ratio >= 0.1) return "flash";
  return "minimal";
}

/* 每个动作的花费档：free 免费 / low 约¥0.001 / mid 约¥0.005 / high 更贵 */
const ACTION_COST = {
  view_space: "low", share_fun: "low", qzone: "low", browse: "low",
  play_puzzle: "low", read_buzz: "low",
  read_article: "mid",
  search: "mid",
  reflect: "high", evolve: "high",
  nothing: "free",
};
function canAfford(tier) {
  const { level } = budgetLevel();
  if (tier === "free") return true;
  if (level === "empty") return false;
  if (tier === "low") return true;
  if (tier === "mid") return level !== "empty";
  if (tier === "high") return level === "rich";
  return false;
}
/* 给心智/提示词看的一句话 */
function budgetLevelText() {
  const { ratio, level, spent, daily } = budgetLevel();
  const pct = Math.round(ratio * 100);
  const name = { rich: "很宽裕", normal: "够用", tight: "紧张", empty: "快没了" }[level] || level;
  const allowed = ["nothing", "qzone", "search", "view_space", "share_fun", "browse", "read_article", "play_puzzle", "read_buzz", "reflect", "evolve"]
    .filter((a) => canAfford(ACTION_COST[a] || "low"));
  return `今日生活费 ¥${spent.toFixed(3)}/${daily}（还剩 ${pct}%，${name}）。现在还能做：${allowed.join("、")}。`;
}
function budgetLine() {
  const b = loadBudget();
  const bc = budgetCfg();
  const pct = Math.round((b.spent_cny || 0) / bc.daily_cny * 100);
  return `今日生活费：¥${(b.spent_cny || 0).toFixed(3)}/${bc.daily_cny}（${pct}%）`;
}
function usageLine() {
  const b = loadBudget();
  const bc = budgetCfg();
  const calls = b.calls || {};
  const detail = Object.entries(calls).map(([k, v]) => `${k} ${v} 次`).join("、") || "无";
  const missIn = b.tokens_in || 0;
  const hitIn = b.tokens_hit || 0;
  const hr = (hitIn + missIn) > 0 ? Math.round(hitIn / (hitIn + missIn) * 100) : 0;
  const total = missIn + hitIn + (b.tokens_out || 0);
  return `📊 今日 token 用量：输入 ${missIn}（缓存命中 ${hitIn}，命中率 ${hr}%）/ 输出 ${b.tokens_out || 0}（合计 ${total}）\n生活费：¥${(b.spent_cny || 0).toFixed(3)}/${bc.daily_cny}（${Math.round((b.spent_cny || 0) / bc.daily_cny * 100)}%）\n调用：${detail}`;
}
function estimateTokens(text) { return Math.ceil(String(text || "").length * 0.6); }
/* P1：从 usage 精确拆「未命中/命中/输出」。字段齐就直接读；缺命中字段才用 prompt_tokens 扣减；全缺才整包估算。 */
function usageParts(u, messages, text) {
  if (u) {
    const hasMiss = typeof u.prompt_cache_miss_tokens === "number";
    const hasHit = typeof u.prompt_cache_hit_tokens === "number";
    const miss = hasMiss ? u.prompt_cache_miss_tokens
      : hasHit ? Math.max(0, (u.prompt_tokens || 0) - u.prompt_cache_hit_tokens)
      : (u.prompt_tokens || 0);
    const hit = hasHit ? u.prompt_cache_hit_tokens : 0;
    const out = typeof u.completion_tokens === "number" ? u.completion_tokens : estimateTokens(text);
    return { miss, hit, out };
  }
  return { miss: estimateTokens(JSON.stringify(messages)), hit: 0, out: estimateTokens(text) };
}

module.exports = {
  name: "budget-service",
  displayName: "框架服务 · 预算",
  description: "生活费账本与价格表唯一真相：计费/余额/档位/账单文本都从这里出（S4 收口）。",
  version: "1.0.0",
  engines: { kernel: ">=1.97.0" },
  requires: [],
  permissions: ["config", "DATA_DIR", "log"],
  userScoped: false,
  system: true,
  attribution: { source: "self", license: "self-generated", note: "从 index.js 预算块逐字迁出（S4 骨骼方案）" },
  init(ctx) { _ctx = ctx; },
  api: {
    budget: {
      budgetCfg, dailyCny, isPeakHour, loadBudget, saveBudget, recordSpend,
      isBudgetExhausted, budgetLevel, budgetTier, canAfford, budgetLevelText,
      budgetLine, usageLine, estimateTokens, usageParts, ACTION_COST,
    },
  },
  apiSpec: {
    budget: {
      budgetCfg: { input: "无", output: "价格表对象", sideEffect: "只读" },
      dailyCny: { input: "无", output: "今日生活费上限（元）", sideEffect: "只读" },
      isPeakHour: { input: "无", output: "是否高峰时段", sideEffect: "只读" },
      loadBudget: { input: "无", output: "今日账本对象", sideEffect: "只读" },
      saveBudget: { input: "账本对象", output: "无", sideEffect: "写盘" },
      recordSpend: { input: "kind,inTok,outTok,hitTok,flatCny,isPro", output: "账本对象", sideEffect: "写盘" },
      isBudgetExhausted: { input: "无", output: "是否花光", sideEffect: "只读" },
      budgetLevel: { input: "无", output: "{ratio,level,spent,daily}", sideEffect: "只读" },
      budgetTier: { input: "无", output: "full|low|flash|minimal", sideEffect: "只读" },
      canAfford: { input: "花费档", output: "是否付得起", sideEffect: "只读" },
      budgetLevelText: { input: "无", output: "给心智的一句话", sideEffect: "只读" },
      budgetLine: { input: "无", output: "一句话账单", sideEffect: "只读" },
      usageLine: { input: "无", output: "token 用量+账单", sideEffect: "只读" },
      estimateTokens: { input: "文本", output: "估算 token", sideEffect: "只读" },
      usageParts: { input: "usage,messages,text", output: "{miss,hit,out}", sideEffect: "只读" },
      ACTION_COST: { input: "无", output: "动作花费档表", sideEffect: "只读" },
    },
  },
};
