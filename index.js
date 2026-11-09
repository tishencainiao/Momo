/* dsh-pet-qq-bridge: 大肥鱼桌宠的 QQ 鱼脑桥接
 * 零依赖：Node 24 全局 fetch / WebSocket。
 * SnowLuma (OneBot v11 WS) <-> 本桥接 <-> DeepSeek API（复用桌宠人设与密钥）
 * 本桥接 --JSONL状态--> 桌宠 agent-events（thinking/working/attention/error/idle）
 * 支持：联网搜索（博查/百度）、回复拆多条消息、主动搭话、崩溃自愈、断线重连
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync, spawn } = require("child_process");
const crypto = require("crypto");
const os = require("os");
const https = require("https");
const fabricationGuard = require("./fabrication-guard");
const http = require("http");

const CFG_FILE = path.join(__dirname, "config.json");
const LOG_FILE = path.join(__dirname, "bridge.log");
const DATA_DIR = path.join(__dirname, "data");
const ACTION_LOG_FILE = path.join(DATA_DIR, "actions.jsonl");
/* 统一操作记录：谁要求、做了什么、对谁（CONTRIBUTING 第九节）
 * 任何有副作用/改别人东西的动作都要写一条，否则事后说不清是谁让做的 */
function recordAction(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const e = Object.assign({ ts: Date.now() }, entry || {});
    fs.appendFileSync(ACTION_LOG_FILE, JSON.stringify(e) + "\n");
    // 只保留最近 500 条，避免无限增长
    try {
      const lines = fs.readFileSync(ACTION_LOG_FILE, "utf8").split("\n").filter(Boolean);
      if (lines.length > 600) fs.writeFileSync(ACTION_LOG_FILE, lines.slice(-500).join("\n") + "\n");
    } catch (e2) {}
  } catch (err) { try { log("warn", "写操作记录失败: " + String(err.message).slice(0, 80)); } catch (e3) {} }
}
function loadActions(n) {
  try {
    return fs.readFileSync(ACTION_LOG_FILE, "utf8").split("\n").filter(Boolean)
      .slice(-(n || 20)).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
const SESS_DIR = path.join(DATA_DIR, "sessions");
const MEM_DIR = path.join(DATA_DIR, "memory");
const LOCK_FILE = path.join(__dirname, "bridge.lock");

// 单实例保护
try {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10);
    if (pid > 0) {
      try { process.kill(pid, 0); console.log("已有实例运行 pid=" + pid + "，退出"); process.exit(0); }
      catch (e) {}
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
} catch (e) {}

function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === "debug" && (cfg.log_level || "info") !== "debug") return;
  if (level === "error" || level === "warn" || level === "info") console.log(line);
  try {
    let s = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    if (s > 1024 * 1024) { try { fs.renameSync(LOG_FILE, LOG_FILE + ".1"); } catch (e) {} }
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {}
}

/* 结构化 JSONL 事件日志：data/<file> 追加一行 {ts,...}，供人格体检/审计 */
function logJsonl(file, obj) {
  try {
    fs.appendFileSync(path.join(DATA_DIR, file), JSON.stringify(Object.assign({ ts: Date.now() }, obj)) + "\n");
  } catch (e) {}
}

let cfg = loadConfig();
let host = null;
let apiKey = cfg.chat.api_key || "";

/* .env 密钥加载（密钥不进 git，.env 已 gitignore） */
(function loadEnv() {
  try {
    const envFile = path.join(__dirname, ".env");
    if (fs.existsSync(envFile)) {
      const lines = fs.readFileSync(envFile, "utf8").split("\n");
      for (const ln of lines) {
        const m = ln.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
    }
  } catch (e) {}
})();

/* 配置 schema 校验：启动时检查必填字段与类型，有问题立刻报错，不等运行时 */
function validateConfig(c) {
  const errs = [];
  const need = (p, cond, msg) => { if (!cond) errs.push(`${p}: ${msg}`); };
  need("onebot.ws_url", c.onebot && typeof c.onebot.ws_url === "string" && c.onebot.ws_url, "必须是 ws 地址字符串");
  need("qq.master_user", c.qq && Number.isFinite(Number(c.qq.master_user)) && Number(c.qq.master_user) > 0, "必须是主人 QQ 号（正数）");
  need("qq.allowed_users", c.qq && Array.isArray(c.qq.allowed_users) && c.qq.allowed_users.length > 0, "必须是非空数组");
  // chat.model 允许留空（会回退到桌宠 provider 的模型），故不校验
  need("budget.daily_cny", c.budget && Number(c.budget.daily_cny) > 0, "必须大于 0");
  if (c.chat && c.chat.web_search && c.chat.web_search.enabled !== false) {
    const eng = String((c.chat.web_search.engine) || "baidu").toLowerCase();
    if (eng === "bocha" && !process.env.BOCHA_API_KEY) need("chat.web_search.bocha_api_key", false, "engine=bocha 但 .env 里没有 BOCHA_API_KEY");
  }
  for (const e of errs) log("error", `配置校验失败 → ${e}`);
  if (!errs.length) log("info", "配置校验通过");
  return errs.length;
}
validateConfig(cfg);
function bochaKey() {
  return process.env.BOCHA_API_KEY || ((cfg.chat && cfg.chat.web_search && cfg.chat.web_search.bocha_api_key) || "");
}

process.on("uncaughtException", (e) => log("error", "未捕获异常: " + (e && e.stack || e)));
process.on("unhandledRejection", (e) => log("error", "未处理拒绝: " + (e && e.stack || e)));

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); }
  catch (e) { console.error("无法读取 config.json：", e.message); process.exit(1); }
}
function resolveChatSettings() {
  const c = cfg.chat || {};
  return {
    base_url: c.base_url || "https://api.deepseek.com",
    model: c.model || "deepseek-v4-flash",
    reasoner_model: c.reasoner_model || "deepseek-v4-pro",
    temperature: c.temperature != null ? c.temperature : 0.7,
    max_tokens: c.max_tokens || 2048,
    persona: c.persona_override ||
      "你是一只可爱的小女仆，我是你的主人，你的性格是可爱贪吃的，请用自然、友善、恭敬的中文和我交流。",
    history_limit: (c.history_limit != null ? c.history_limit : 40) || 40,
    history_chars: (c.history_chars != null ? c.history_chars : 24000) || 24000,
  };
}

/* 提示词常量（M6/B1 阶段1 已抽到 prompts.js，纯字符串搬家） */
const { STYLE_DIRECTIVE, GROUP_DIRECTIVE, SITUATION_QQ, SITUATION_DESKTOP, situationDirective, SELF_AWARENESS, PRIVACY_DIRECTIVE } = require("./prompts");

/* ---------------- 基础层版本 + 进化层加载器（v1.0.0，基础层唯一通用件） ---------------- */
// 规则：每次修改 index.js 必须递增本版本号，并在 CHANGELOG.md 记录、在 versions/ 留快照（便于回溯/回滚）
const BASE_VERSION = "1.89.2";
/* 本次进程启动时间：用来告诉她「这次运行了多久」，让她对"被启动"这件事有真实感知 */
const BOOT_TS = Date.now();
const SELF_DIR = path.join(__dirname, "self");
let evolve = { identity: [], reflections: [], pref: {}, skills: { rules: [] } };
function loadEvolution() {
  const defs = { identity: [], reflections: [], pref: {}, skills: { rules: [] }, journal: [] };
  const out = {};
  for (const [k, d] of Object.entries(defs)) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(SELF_DIR, k + ".json"), "utf8"));
      out[k] = (v === null || v === undefined) ? d : v;
    } catch (e) { out[k] = d; }
  }
  return out;
}
evolve = loadEvolution();
function reloadEvolution() { evolve = loadEvolution(); return evolve; }
function evolvePref(key, fallback) {
  const p = (evolve && evolve.pref) || {};
  return (p[key] === undefined || p[key] === null) ? fallback : p[key];
}
function evolIdentityText(userId, limit) {
  const items = (evolve && Array.isArray(evolve.identity)) ? evolve.identity : [];
  // 按当前对话的人过滤：from=0（通用/旧数据）或 from=当前用户 才注入；其他用户的不注入，避免串人
  const relevant = items.filter((e) => {
    const from = (typeof e === "string") ? 0 : (Number(e && e.from) || 0);
    return from === 0 || from === Number(userId);
  });
  const n = Math.max(1, Number(limit) || 20);
  const picked = relevant.slice(-n);
  /* 事实分层：没被证实过的自我声称（kind=self-claim / verified:false）单独成段，标注"别当事实" */
  const plain = [], claims = [];
  for (const e of picked) {
    if (typeof e === "string") { plain.push(e); continue; }
    const t = e && e.text;
    if (!t) continue;
    if (e.verified === false || e.kind === "self-claim") claims.push(t); else plain.push(t);
  }
  const parts = [];
  if (plain.length) parts.push(plain.join("\n"));
  if (claims.length) parts.push("【我记得自己说过、但没证实过的（可能是我当时随口吹的，别当成事实）】\n" + claims.join("\n"));
  return parts.join("\n");
}
/* 自我反思产出的经验（取最近几条注入人格，之前只写盘不生效） */
function evolReflectionText() {
  const items = (evolve && Array.isArray(evolve.reflections)) ? evolve.reflections : [];
  return items.slice(-4).map((r) => (typeof r === "string" ? r : (r && r.text) || "")).filter(Boolean).join("\n");
}

/* ---------------- 生活费预算（默认 1 元/天；deepseek-flash 官方价：输入未命中 $0.15/M、命中 $0.003/M、输出 $0.6/M，高峰 ×2） ---------------- */
const BUDGET_FILE = path.join(DATA_DIR, "budget.json");
const USD_CNY = 7.2;
function budgetCfg() {
  const b = cfg.budget || {};
  return {
    daily_cny: Number(b.daily_cny) || 1,
    input_miss_cny_per_m: (Number(b.input_miss_cny_per_m) || 0) > 0 ? Number(b.input_miss_cny_per_m) : 0.15 * USD_CNY,
    input_hit_cny_per_m: (Number(b.input_hit_cny_per_m) || 0) > 0 ? Number(b.input_hit_cny_per_m) : 0.003 * USD_CNY,
    output_cny_per_m: (Number(b.output_cny_per_m) || 0) > 0 ? Number(b.output_cny_per_m) : 0.6 * USD_CNY,
    peak_x2: b.peak_x2 !== false,
    search_cny: Number(b.search_cny) || 0.005,
  };
}
function isPeakHour() {
  const d = new Date();
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
function loadBudget() {
  const today = new Date().toDateString();
  const fresh = { date: today, spent_cny: 0, tokens_in: 0, tokens_out: 0, calls: {}, spend_by: {}, exhausted_notified: false };
  try {
    const b = JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8"));
    if (b.date !== today) {
      // 归档昨日账单（供周报/月报），只保留最近 400 天，避免无限增长
      try {
        const bf = path.join(DATA_DIR, "budget-history.jsonl");
        fs.appendFileSync(bf, JSON.stringify(b) + "\n");
        const lines = fs.readFileSync(bf, "utf8").split("\n").filter(Boolean);
        if (lines.length > 400) fs.writeFileSync(bf, lines.slice(-400).join("\n") + "\n");
      } catch (e) {}
      return fresh;
    }
    return Object.assign(fresh, b);
  } catch (e) { return fresh; }
}
function saveBudget(b) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BUDGET_FILE, JSON.stringify(b)); } catch (e) {} }
function recordSpend(kind, inTok, outTok, hitTok, flatCny) {
  const bc = budgetCfg();
  const mult = (bc.peak_x2 && isPeakHour()) ? 2 : 1;
  const b = loadBudget();
  b.tokens_in = (b.tokens_in || 0) + (inTok || 0);
  b.tokens_out = (b.tokens_out || 0) + (outTok || 0);
  b.calls = b.calls || {};
  b.calls[kind] = (b.calls[kind] || 0) + 1;
  const cost = ((inTok || 0) / 1e6) * bc.input_miss_cny_per_m * mult + ((hitTok || 0) / 1e6) * bc.input_hit_cny_per_m * mult + ((outTok || 0) / 1e6) * bc.output_cny_per_m * mult + (flatCny || 0);
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
/* 每个动作的花费档：free 免费 / low 约¥0.001 / mid 约¥0.005 / high 更贵 */
const ACTION_COST = {
  view_space: "low", share_fun: "low", qzone: "low", browse: "low",
  play_puzzle: "low", read_buzz: "low",
  read_article: "mid",
  search: "mid",
  reflect: "high", evolve: "high",
  nothing: "free",
};
/* 当前生活费够不够做这一档 */
function canAfford(tier) {
  const { level } = budgetLevel();
  if (tier === "free") return true;
  if (level === "empty") return false;
  if (tier === "low") return true;                       // tight 也能做便宜的
  if (tier === "mid") return level !== "empty";          // 只剩一点时也还能搜
  if (tier === "high") return level === "rich";          // 只有很宽裕才做贵的
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
  const total = (b.tokens_in || 0) + (b.tokens_out || 0);
  return `📊 今日 token 用量：输入 ${b.tokens_in || 0} / 输出 ${b.tokens_out || 0}（合计 ${total}）\n生活费：¥${(b.spent_cny || 0).toFixed(3)}/${bc.daily_cny}（${Math.round((b.spent_cny || 0) / bc.daily_cny * 100)}%）\n调用：${detail}`;
}
function estimateTokens(text) { return Math.ceil(String(text || "").length * 0.6); }

function resolveApiKey(quiet) {
  if (apiKey) return true;
  const envKey = (process.env.DEEPSEEK_API_KEY || "").trim();
  if (envKey) { apiKey = envKey; log("info", `已从 .env 读取 DeepSeek API Key（长度 ${apiKey.length}）`); return true; }
  if (!quiet) log("warn", "未配置 DeepSeek API Key：请在 .env 写入 DEEPSEEK_API_KEY=xxx（.env 已 gitignore，不进版本库）");
  return false;
}

/* API Key 自愈：启动瞬间 .env 尚未就绪等不再整天失声——每 60 秒重读一次，读到即恢复；失败日志 10 分钟最多一条 */
function startApiKeyWatchdog() {
  let lastWarnAt = 0;
  const timer = setInterval(() => {
    if (apiKey) { clearInterval(timer); return; }
    if (resolveApiKey(true)) {
      log("info", "API Key 已自愈恢复（定时重读到 .env 成功，无需重启）");
      clearInterval(timer);
      return;
    }
    const now = Date.now();
    if (now - lastWarnAt >= 10 * 60 * 1000) {
      lastWarnAt = now;
      log("warn", "API Key 仍缺失，已启动 60 秒定时重读（请检查 .env 是否写了 DEEPSEEK_API_KEY）");
    }
  }, 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}


/* ---------------- 会话存取 ---------------- */
function sessionPath(userId) { return path.join(SESS_DIR, String(userId) + ".json"); }
function loadSession(userId) { try { const d = JSON.parse(fs.readFileSync(sessionPath(userId), "utf8")); if (Array.isArray(d.messages)) return d.messages; } catch (e) {} return []; }
function saveSession(userId, messages) { try { fs.mkdirSync(SESS_DIR, { recursive: true }); fs.writeFileSync(sessionPath(userId), JSON.stringify({ updated: Date.now(), messages })); } catch (e) {} }

/* ---------------- 会话摘要（L1：滚动压缩长对话，防止超过 40 轮后失忆） ---------------- */
function summaryFile(userId) { return path.join(SESS_DIR, String(userId) + ".summary.json"); }
function loadSummary(userId) { try { const d = JSON.parse(fs.readFileSync(summaryFile(userId), "utf8")); return String(d.summary || ""); } catch (e) { return ""; } }
function saveSummary(userId, s) { try { fs.mkdirSync(SESS_DIR, { recursive: true }); fs.writeFileSync(summaryFile(userId), JSON.stringify({ summary: String(s).slice(0, 2000), updated: Date.now() })); } catch (e) {} }
function summaryCtx(userId) { const s = loadSummary(userId); return s ? `【早前对话摘要】${s}` : ""; }
async function rollSessionSummary(userId, history, settings, keep) {
  const k = Math.max(10, Number(keep) || 40);
  if (!history || history.length <= k) return null;
  const old = history.slice(0, history.length - k);          // 要压缩的最老部分
  const prev = loadSummary(userId);
  const text = old.map((m) => `${m.role === "user" ? "主人" : "我"}：${String(m.content || "").slice(0, 120)}`).join("\n").slice(0, 2500);
  const prompt = `你是记忆摘要助手。请把下面这段较早的对话，压缩成 1~3 句简短摘要（重点：主人说过的重要信息、约定、喜好、情绪变化、聊过的话题）。只输出摘要本身，不要解释、不要引号。\n${prev ? "之前已有的摘要（在此基础上补充、避免重复）：\n" + prev + "\n" : ""}\n待压缩的对话：\n${text}`;
  try {
    const raw = await completeOnce([{ role: "user", content: prompt }], settings, 300, 0.3);
    const s = String(raw || "").trim().replace(/^["'「『]|["'」』]$/g, "");
    if (!s || s.length < 4) return null;
    saveSummary(userId, s);
    history.splice(0, old.length);                              // 从内存历史里移除已压缩部分
    log("info", `会话摘要已滚动 user=${userId}（压缩 ${old.length} 条，剩 ${history.length} 条）`);
    return s;
  } catch (e) { log("warn", "会话摘要失败: " + e.message.slice(0, 120)); return null; }
}
/* 保存前调用：历史超过「窗口 + 一批」时，先把最老的一批压进摘要再落盘（v1.47.2 修：之前触发线 45 与 history_limit 40 打架，永不触发） */
async function maybeRollSummary(key, history, settings) {
  const lim = Math.max(10, Number(settings && settings.history_limit) || 40);
  const BATCH = 12;
  if (!history || history.length <= lim + BATCH) return;
  await rollSessionSummary(key, history, settings, lim);
}
function userPrivateContext(userId) {
  try {
    const msgs = loadSession(userId);
    const parts = [];
    for (let i = msgs.length - 1; i >= 0 && parts.length < 3; i--) {
      const m = msgs[i];
      if (m && m.role === "user" && m.content) parts.unshift(String(m.content).slice(0, 50));
    }
    return parts.length ? "你最近和对方在私聊里聊到：" + parts.join("；") : "";
  } catch (e) { return ""; }
}
function userGroupContext(userId) {
  try {
    const files = fs.readdirSync(SESS_DIR).filter((f) => f.startsWith("g") && f.endsWith("_" + userId + ".json"));
    const parts = [];
    for (const f of files.slice(-2)) {
      const msgs = loadSession(f.slice(0, -5));
      for (let i = msgs.length - 1; i >= 0 && parts.length < 3; i--) {
        const m = msgs[i];
        if (m && m.role === "user" && m.content) parts.unshift(String(m.content).slice(0, 50));
      }
    }
    return parts.length ? "对方最近在群里说过：" + parts.join("；") : "";
  } catch (e) { return ""; }
}
function recentQqChat(userId) { try { const a = host && host.apis.get("proactive"); return a ? a.recentQqChat(userId) : ""; } catch (e) { return ""; } }
function trimHistory(messages, lim, chars) {
  let out = messages.slice(-lim);
  let total = 0; for (const m of out) total += String(m.content || "").length;
  while (out.length > 2 && total > chars) { total -= String(out[0].content || "").length; out = out.slice(1); }
  return out;
}

/* ---------------- 长期记忆库（按 QQ 号隔离；主人记忆已于 2026-11-08 迁入本库，不再与旧桌宠互通） ---------------- */
function memPath(userId) { return path.join(MEM_DIR, String(userId) + ".json"); }
function loadMemories(userId) {
  try { const d = JSON.parse(fs.readFileSync(memPath(userId), "utf8")); if (Array.isArray(d.items)) return d.items.filter((i) => i && i.content); } catch (e) {}
  return [];
}
/* 按「重要度/提及次数」降序取前 n 条（稳定排序，同分保持新近在前） */
function topMemories(items, n) {
  if (!items || !items.length) return [];
  const ranked = items.slice().sort((a, b) => (b.importance || b.hits || 1) - (a.importance || a.hits || 1));
  return ranked.slice(0, n);
}
function saveMemories(userId, items) {
  try {
    fs.mkdirSync(MEM_DIR, { recursive: true });
    /* 访客记忆封顶（阶段 4）：只保留最近 N 条，防陌生人刷存储 */
    let outItems = items || [];
    /* 记忆条目带 from（阶段 4）：标明属于谁，方便以后消化/审计 */
    outItems = outItems.map((it) => Object.assign({}, it, { from: Number(it.from) || Number(userId) || 0 }));
    try {
      const _ra = host && host.apis.get("roles");
      if (_ra && _ra.resolveRole(userId) === "visitor") {
        const cap = Math.max(0, Number(_ra.rateCfg().memoryCap) || 200);
        if (outItems.length > cap) outItems = outItems.slice(outItems.length - cap);
      }
    } catch (e) {}
    fs.writeFileSync(memPath(userId), JSON.stringify({ updated: Date.now(), items: outItems }));
  } catch (e) {}
}
function memoryPrompt(items, call) {
  const c = call || "主人";
  // 主人亲自教的排到后面，确保不被 20 条上限挤掉
  const ordered = items.slice().sort((a, b) => (a.source === "taught" ? 1 : 0) - (b.source === "taught" ? 1 : 0));
  const lines = ordered.slice(-20).map((m) => {
    let tsMs = 0;
    if (m.time) { try { tsMs = new Date(m.time).getTime(); } catch (e) {} }
    else if (m.created) tsMs = Number(m.created) * 1000;
    else if (m.created_at) { try { tsMs = new Date(m.created_at).getTime(); } catch (e) {} }
    const ago = tsMs ? `（${formatGap(Date.now() - tsMs)}前）` : "";
    const tag = m.source === "taught" ? "【主人亲自教的】" : "";
    return "- " + tag + String(m.content).slice(0, 200) + ago;
  });
  const hasTaught = ordered.some((m) => m.source === "taught");
  return `【你关于${c}的长期记忆】\n` + lines.join("\n")
    + `\n\n` + (hasTaught ? `【主人亲自教的】标记的那几条是主人明确教你的，优先级最高，不要反驳、不要改写成别的意思。` : "")
    + `其余记忆请自然使用（${c}提到相关话题时主动想起），不要生硬地逐条复述。`;
}
function memoryIndexPrompt(items, call) {
  const c = call || "主人";
  const MAX_IDX = 60;
  const shown = items.slice(-MAX_IDX);
  const lines = shown.map((m, i) => `${i + 1}. ${String(m.content).slice(0, 16)}`);
  const more = items.length > MAX_IDX ? `（还有 ${items.length - MAX_IDX} 条更早的）` : "";
  return `【你记得关于${c}的全部事（摘要索引，共 ${items.length} 条）】\n${lines.join("  ")}${more}`;
}
function coreContextMessages(userId, opts) {
  const o = opts || {};
  // 注意：时间这类高频变化的内容放最后，避免打断 prompt 前缀缓存
  const out = [];
  if (userId != null && o.memory !== false) {
    const allMems = loadMemories(userId);
    if (allMems.length) out.push({ role: "system", content: memoryIndexPrompt(allMems, resolveCall(userId)) });
    const shorts = pruneShortMemories(userId);
    if (shorts.length) out.push({ role: "system", content: shortMemoryPrompt(shorts.slice(-10), resolveCall(userId)) });
  }
  const esp = moodPrompt();
  if (esp) out.push({ role: "system", content: esp });
  out.push({ role: "system", content: activityCtx() });
  if (userId != null) {
    const st = currentStatusCtx(userId);
    if (st) out.push({ role: "system", content: st });
    out.push({ role: "system", content: goalsCtx() });
  }
  out.push({ role: "system", content: timeDirective() });
  return out;
}
function shortMemoryPrompt(items, call) {
  const c = call || "主人";
  const lines = items.slice(-10).map((m) => "- " + (m.channel === "group" ? "(群里) " : "") + String(m.content).slice(0, 120));
  return `【你最近了解到的关于${c}的事（短期记忆）】\n` + lines.join("\n");
}
/* 常见生活主题的同义词扩展，提高记忆检索命中率 */
const SYNONYM_MAP = {
  "游戏": ["游戏", "打游戏", "开黑", "王者", "原神", "玩"],
  "睡觉": ["睡", "睡觉", "晚安", "困", "休息", "熬夜"],
  "吃饭": ["吃", "饭", "外卖", "饿", "干饭"],
  "工作": ["工作", "上班", "加班", "忙"],
  "学习": ["学习", "上课", "作业", "复习", "考试", "写代码"],
  "心情": ["开心", "难过", "烦", "累", "emo", "委屈"],
};
function simpleKeywords(text) {
  const t = String(text || "").toLowerCase();
  const out = new Set();
  const cn = t.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let i = 0; i + 1 < cn.length; i++) out.add(cn.slice(i, i + 2));   // 二字
  for (let i = 0; i + 2 < cn.length; i++) out.add(cn.slice(i, i + 3));   // 三字
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  for (const [k, words] of Object.entries(SYNONYM_MAP)) if (t.indexOf(k) >= 0) for (const w of words) out.add(w);
  return Array.from(out).slice(0, 30);
}
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
function retrieveMemories(memories, userText, limit) {
  const qk = new Set(simpleKeywords(userText));
  const scored = (memories || []).map((m) => {
    const mk = new Set(simpleKeywords(String(m.content || "")));
    let overlap = 0, fuzzy = 0;
    for (const k of qk) {
      if (mk.has(k)) { overlap++; continue; }
      // 错别字容忍：编辑距离 ≤1（二字）/≤2（三字）算半匹配
      const thresh = k.length <= 2 ? 1 : 2;
      for (const w of mk) { const d = lev(k, w); if (d > 0 && d <= thresh) { fuzzy++; break; } }
    }
    let tsMs = 0;
    if (m.time) { try { tsMs = new Date(m.time).getTime(); } catch (e) {} }
    else if (m.created) tsMs = Number(m.created) * 1000;
    else if (m.created_at) { try { tsMs = new Date(m.created_at).getTime(); } catch (e) {} }
    const recency = tsMs ? Math.max(0, 1 - (Date.now() - tsMs) / (30 * 86400e3)) : 0.5;
    const hits = m.hits ? Math.min(Number(m.hits), 10) / 10 : 0.5;
    const score = overlap * 2 + fuzzy * 1 + hits * 0.5 + recency * 0.5;
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit || 8).map((s) => s.m);
}
/* memoryExtractPrompt 已迁移到插件 memory */
function parseMemoryJson(raw) {
  try {
    let s = String(raw || "").trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const norm = (arr) => (arr || []).map((m) => (typeof m === "string" ? m : (m && m.content))).filter(Boolean);
    try {
      const obj = JSON.parse(s);
      return norm(Array.isArray(obj) ? obj : (obj.memories || []));
    } catch (e) {}
    const startB = s.indexOf("{"), endB = s.lastIndexOf("}");
    const startA = s.indexOf("["), endA = s.lastIndexOf("]");
    let frag = null;
    if (startB >= 0 && endB > startB) frag = s.slice(startB, endB + 1);
    else if (startA >= 0 && endA > startA) frag = s.slice(startA, endA + 1);
    if (!frag) return [];
    const obj = JSON.parse(frag);
    return norm(Array.isArray(obj) ? obj : (obj.memories || []));
  } catch (e) { return []; }
}
/* mergeMemories/extractMemories 已迁移到插件 memory（经 reply 钩子触发） */

/* ---------------- 情绪（全局心情） ---------------- */
const MOOD_FILE = path.join(DATA_DIR, "mood.json");
let mood = { value: 0, updated: Date.now() };
function loadMood() {
  try { const d = JSON.parse(fs.readFileSync(MOOD_FILE, "utf8")); mood.value = Number(d.value) || 0; mood.updated = Number(d.updated) || Date.now(); } catch (e) {}
}
function saveMood() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(MOOD_FILE, JSON.stringify(mood)); } catch (e) {} }
function getMood() { return mood.value; }
function setMood(v) { mood.value = Math.max(-100, Math.min(100, v)); mood.updated = Date.now(); saveMood(); }
function addMood(d) { try { setMood(getMood() + Number(d || 0)); } catch (e) {} }
function decayMood() {
  const minutes = (Date.now() - mood.updated) / 60000;
  if (minutes < 1) return;
  const factor = Math.pow(0.9, minutes / 5);
  const v = mood.value * factor;
  mood.value = Math.abs(v) < 2 ? 0 : v;
  mood.updated = Date.now();
  saveMood();
}
/* ---------------- 情绪（离散情绪 + 强度） ---------------- */
const EMOTION_FILE = path.join(DATA_DIR, "emotion.json");
let emotion = { name: "平静", intensity: 0, updated: Date.now() };
const EMOTION_VAL = {
  "开心": 1, "满足": 0.7, "期待": 0.5, "害羞": 0.4, "傲娇": 0.3, "撒娇": 0.5,
  "难过": -1, "生气": -0.9, "委屈": -0.7, "吃醋": -0.6, "紧张": -0.5,
  "平静": 0, "无聊": 0, "好奇": 0.3, "惊讶": 0.2,
};
function loadEmotion() { try { const d = JSON.parse(fs.readFileSync(EMOTION_FILE, "utf8")); emotion.name = d.name || "平静"; emotion.intensity = Number(d.intensity) || 0; emotion.updated = Number(d.updated) || Date.now(); emotion.cooling = Number(d.cooling) || 0; } catch (e) {} }
function saveEmotion() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(EMOTION_FILE, JSON.stringify(emotion)); } catch (e) {} }
function getEmotion() { return emotion; }
function setEmotion(name, intensity) { if (EMOTION_VAL[name] === undefined) name = "平静"; emotion.name = name; emotion.intensity = Math.max(0, Math.min(1, Number(intensity) || 0.5)); emotion.updated = Date.now(); saveEmotion(); }
const EMOTION_STYLE = {
  "开心": "轻快话多，可用「嘿嘿」「耶」，藏不住高兴",
  "满足": "软和放松，懒洋洋",
  "期待": "雀跃，句尾爱用「嘛」「啦」",
  "害羞": "声音变小句子变短，偶尔「唔…」「那个…」",
  "傲娇": "嘴硬心软，先嫌弃再关心，可用「哼」「才不是」",
  "撒娇": "软乎乎黏人，可用「嘛～」「好不好嘛」",
  "难过": "强撑但藏不住低落，少字多停顿，希望被哄",
  "生气": "话短语气重，不解释，等哄，不能立刻和好",
  "委屈": "小声嘟囔欲言又止，带点酸",
  "吃醋": "酸但不直说，绕圈子试探",
  "紧张": "语无伦次结巴感，偶尔「那个那个…」",
  "平静": "自然正常，不刻意",
  "无聊": "懒洋洋提不起劲，想找乐子",
  "好奇": "追问细节，眼睛放光",
  "惊讶": "短促感叹，可用「诶？！」「哇」",
};
function closestEmotionByVal(v) {
  let best = "平静", bestD = 9;
  for (const k of Object.keys(EMOTION_VAL)) {
    const d = Math.abs(EMOTION_VAL[k] - v);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}
function applyEmotionInertia(prev, nextName, nextIntensity) {
  if (!prev || !prev.name || prev.intensity < 0.05) return { name: nextName, intensity: nextIntensity };
  const pv = EMOTION_VAL[prev.name] != null ? EMOTION_VAL[prev.name] : 0;
  const nv = EMOTION_VAL[nextName] != null ? EMOTION_VAL[nextName] : 0;
  const gap = Math.abs(nv - pv);
  let name = nextName;
  let intensity = nextIntensity;
  if (gap > 0.5) {
    name = closestEmotionByVal(pv + Math.sign(nv - pv) * 0.25);
    intensity = Math.min(1, nextIntensity * 0.7);
  } else if (name === prev.name) {
    intensity = Math.min(1, prev.intensity * 0.4 + nextIntensity * 0.6);
  } else {
    intensity = Math.min(1, Math.max(0.2, prev.intensity * 0.3 + nextIntensity * 0.7));
  }
  return { name, intensity };
}
function decayEmotion() {
  const minutes = (Date.now() - emotion.updated) / 60000;
  if (minutes < 1) return;
  emotion.intensity *= Math.pow(0.9, minutes / 5);
  if (emotion.intensity < 0.05) { emotion.intensity = 0; emotion.name = "平静"; }
  emotion.updated = Date.now();
  saveEmotion();
}
function moodLabel() { return (emotion && emotion.intensity >= 0.15) ? emotion.name : "平静"; }
function moodPrompt() {
  if (!emotion || emotion.intensity < 0.15) return "";
  const rule = (EMOTION_STYLE && EMOTION_STYLE[emotion.name]) || "自然聊天";
  return `【你此刻的情绪】${emotion.name}（强度 ${Math.round(emotion.intensity * 100)}/100）。流露方式：${rule}。要自然流露这种情绪，但不要直接说"我现在很${emotion.name}"。`;
}

/* ---------------- 好感度（主人锁定100，访客0~90浮动） ---------------- */
const FAVOR_FILE = path.join(DATA_DIR, "favor.json");
const VISITOR_FAVOR_MAX = 90;
function loadFavor() { try { return JSON.parse(fs.readFileSync(FAVOR_FILE, "utf8")); } catch (e) { return {}; } }
function saveFavor(f) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FAVOR_FILE, JSON.stringify(f)); } catch (e) {} }
function getFavor(userId) {
  if (isMaster(userId)) return 100;
  const f = loadFavor();
  const v = Number((f[userId] || {}).value);
  return Number.isFinite(v) ? v : 50;
}
function updateFavor(userId, delta) {
  if (isMaster(userId)) return 100;
  const f = loadFavor();
  const next = Math.max(0, Math.min(VISITOR_FAVOR_MAX, getFavor(userId) + delta));
  f[userId] = { value: next, updated: Date.now() };
  saveFavor(f);
  return next;
}
function favorPrompt(userId) {
  const v = Math.round(getFavor(userId));
  if (isMaster(userId)) return `【好感度】你对主人的好感度是 100/100（最高、无可动摇），你对主人永远温柔、亲昵、忠诚。`;
  return `【好感度】你对对方的当前好感度是 ${v}/100（0=冷淡疏远，50=普通朋友，90=很喜欢）。好感度越高语气越亲近热情，越低越客气疏远，请自然体现。`;
}

/* ---------------- 情绪判断（一次轻量调用，同时驱动心情与好感度） ---------------- */
/* 情绪检测已迁移到插件 emotion，以下为代理 */
async function detectEmotion(userText, settings, userId) { try { const a = host && host.apis.get("emotion"); return a ? await a.detectEmotion(userText, settings, userId) : null; } catch (e) { return null; } }

/* ---------------- 语音 ---------------- */
function wantsVoice(text) { try { const a = host && host.apis.get("voice"); return a ? a.wantsVoice(text) : /语音|说句话|说一句|用声音|念给我|读给我|念一下|读一下/.test(text); } catch (e) { return /语音|说句话|说一句|用声音|念给我|读给我|念一下|读一下/.test(text); } }
function stripStageDirections(text) {
  let t = String(text);
  // 1. 成对 XML 内部标签（system_reminder/DSML/tool 等）整体删除（含内容），防 DeepSeek 串台
  t = t.replace(/<([a-zA-Z_][\w.-]{0,40})[^>]*>[\s\S]*?<\/\1>/g, " ");
  // 2. 残留的单个/自闭合标签
  t = t.replace(/<\/?[a-zA-Z_][\w.-]{0,40}[^>]*>/g, " ");
  // 3. 括号动作/心理描写
  t = t.replace(/[（(][^（()）]*[）)]/g, " ");
  return t.replace(/\s+/g, " ").trim();
}
async function sendVoice(userId, text) {
  const a = host && host.apis.get("voice");
  if (!a) throw new Error("语音插件未加载");
  await a.sendVoice(userId, text);
}
/* 运行参数（可在 QQ 上用 settings_set 调）：等消息窗口 / 语音预热 */
function qqSettingNum(key, def) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"));
    const v = d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
    if (v === undefined || v === null || v === "") return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  } catch (e) { return def; }
}
function qqSettingBool(key, def) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"));
    const v = d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
    if (v === undefined || v === null) return def;
    return v === true || v === "true" || v === 1 || v === "1";
  } catch (e) { return def; }
}
/* 语音预热：收到语音请求就后台先拉起 TTS 服务，和聊天并行，减少等待 */
function warmVoice() {
  try {
    if (!qqSettingBool("qq.voice_warm", true)) return;
    const a = host && host.apis.get("voice");
    if (a && a.warmVoice) a.warmVoice();
  } catch (e) {}
}

/* ---------------- 角色与称呼（主人/访客） ---------------- */
function isMaster(userId) {
  try { const a = host && host.apis.get("roles"); if (a) return a.resolveRole(userId) === "admin"; } catch (e) {}
  return Number(userId) === Number((cfg.qq && cfg.qq.master_user) || 0);
}
/* 能力鉴权（阶段 3）：没登记的工具/命令默认只给管理员 */
const capsTable = require("./caps");
function canDo(userId, cap) {
  try { const a = host && host.apis.get("roles"); if (a) return !!a.can(userId, cap); } catch (e) {}
  return isMaster(userId);
}
function toolAllowed(userId, name) {
  const cap = capsTable.toolCap(name);
  return cap ? canDo(userId, cap) : isMaster(userId);
}
function cmdAllowed(userId, key) {
  const cap = capsTable.cmdCap(key);
  return cap ? canDo(userId, cap) : isMaster(userId);
}
function appsPath() { return path.join(DATA_DIR, "appellations.json"); }
function loadAppellations() { try { return JSON.parse(fs.readFileSync(appsPath(), "utf8")); } catch (e) { return {}; } }
function saveAppellations(apps) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(appsPath(), JSON.stringify(apps)); } catch (e) {} }
/* 屏蔽名单 */
function mutePath() { return path.join(DATA_DIR, "mute.json"); }
function loadMute() { try { return JSON.parse(fs.readFileSync(mutePath(), "utf8")); } catch (e) { return {}; } }
function saveMute(m) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(mutePath(), JSON.stringify(m)); } catch (e) {} }
function isMuted(userId) { const m = loadMute(); return !!(m[String(userId)]); }
function addMute(userId, name) { const m = loadMute(); m[String(userId)] = { name: String(name || "").slice(0, 20), ts: Date.now() }; saveMute(m); }
function removeMute(userId) { const m = loadMute(); delete m[String(userId)]; saveMute(m); }
function resolveTargetId(name) {
  const s = String(name || "").trim();
  if (/^\d{5,12}$/.test(s)) return Number(s);
  const apps = loadAppellations();
  for (const [id, nm] of Object.entries(apps)) { if (String(nm).includes(s) || s.includes(String(nm))) return Number(id); }
  try {
    const gm = host.apis.get("groupInfo").loadGroupMembers();
    for (const members of Object.values(gm)) {
      for (const [id, info] of Object.entries(members || {})) { if (String(info.name || "").includes(s)) return Number(id); }
    }
  } catch (e) {}
  return null;
}
/* 愿望清单（做不到的事 → 进化材料） */
const WISH_FILE = path.join(DATA_DIR, "wishes.json");
function loadWishes() { try { const a = host && host.apis.get("evolution"); return a ? a.loadWishes() : []; } catch (e) { return []; } }
function addWish(text, source) { try { const a = host && host.apis.get("evolution"); if (a) a.addWish(text, source); } catch (e) {} }
function resolveCall(userId) {
  try {
    const a = host && host.apis.get("roles");
    if (a) {
      const p = a.person(userId);
      if (p.role === "admin") return "主人";
      if (p.appellation) return p.appellation;
      return p.role === "user" ? "朋友" : "陌生人";
    }
  } catch (e) {}
  if (isMaster(userId)) return "主人";
  const apps = loadAppellations();
  const c = String((apps[userId] || "") || "").trim();
  if (c) return c;
  // 在 allowed_users 里的算「朋友」，不在的才是「陌生人」
  const allowed = ((cfg.qq && cfg.qq.allowed_users) || []).map(Number);
  if (allowed.indexOf(Number(userId)) >= 0) return "朋友";
  return "陌生人";
}
function userPersona(userId, settings) {
  const call = resolveCall(userId);
  const _isM = isMaster(userId);
  const _allowed = ((cfg.qq && cfg.qq.allowed_users) || []).map(Number);
  const _isFriend = !_isM && _allowed.indexOf(Number(userId)) >= 0;
  const identity = _isM
    ? "【对方身份】对方就是你的主人，你最亲的人。"
    : _isFriend
      ? "【对方身份】对方不是主人，是主人认识的朋友。对他亲切有礼，但保持朋友的分寸，别越界装亲密，也别透露主人的私事。"
      : "【对方身份】对方是陌生人。客气但不热络，不要透露主人的私事。";
  const rule = _isM
    ? `【称呼】你称呼对方为「主人」，语气亲昵。`
    : `【称呼】对方不是你的主人，称呼他「${call}」或「你」，语气自然友好。\n【权限认知】找文件、截图、开软件、代发QQ等电脑/QQ操作只有主人能用；对方要求这类事时自然婉拒（如「这个只有我主人能用哦～」），不要答应、也不要假装做过了。`;
  /* 记忆消化：有「认识」就用认识替代流水账（默认关，settings 打开） */
  let _mdText = null;
  try { const _md = host && host.apis.get("memoryDigest"); _mdText = _md ? _md.digestText(userId) : null; } catch (e) {}
  const growth = _mdText ? null : evolIdentityText(userId);
  const lessons = _mdText ? null : evolReflectionText();
  /* 双轨注入：消化摘要（长期认识）+ 最近 8 条原文（近期鲜活细节） */
  const recentDetail = _mdText ? evolIdentityText(userId, 8) : "";
  return [settings.persona, rule, identity,
    _mdText || "",
    recentDetail ? `【最近的具体细节（原文）】\n${recentDetail}` : "",
    growth ? `【我自己的成长记忆】\n${growth}` : "",
    lessons ? `【我自己复盘出的经验（请体现在行为里；注意：里面提到的「主人」是主人本人，不是你自己，别把主人的偏好/习惯说成你自己的）】\n${lessons}` : ""
  ].filter(Boolean).join("\n");
}

/* ---------------- 主动搭话状态（持久化，跨重启不重发） ---------------- */
const PROACTIVE_STATE_FILE = path.join(DATA_DIR, "proactive-state.json");
let lastProactiveTs = 0;
const greeted = new Set();
const lastActiveAt = new Map();
const lastProactiveAt = new Map();
const lastProactiveMsg = new Map();

function loadProactiveState() {
  try {
    const s = JSON.parse(fs.readFileSync(PROACTIVE_STATE_FILE, "utf8"));
    lastProactiveTs = s.lastProactiveTs || 0;
    for (const k of (s.greeted || [])) greeted.add(k);
    for (const [k, v] of Object.entries(s.lastActiveAt || {})) lastActiveAt.set(Number(k), Number(v));
    for (const [k, v] of Object.entries(s.lastProactiveAt || {})) lastProactiveAt.set(Number(k), Number(v));
  } catch (e) {}
}
function saveProactiveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PROACTIVE_STATE_FILE, JSON.stringify({ lastProactiveTs, greeted: Array.from(greeted), lastActiveAt: Object.fromEntries(lastActiveAt), lastProactiveAt: Object.fromEntries(lastProactiveAt) }));
  } catch (e) {}
}

/* ---------------- DeepSeek 请求（带重试） ---------------- */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function completeOnce(messages, settings, maxTokens, temperature, opts) {
  const endpoint = settings.base_url.replace(/\/+$/, "") + "/v1/chat/completions";
  const _think = !!(opts && opts.think);
  const body = JSON.stringify({ model: settings.model, messages, stream: false, max_tokens: maxTokens || 300, temperature: temperature != null ? temperature : 0.3, thinking: { type: _think ? "enabled" : "disabled" } });
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const resp = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, body, signal: controller.signal });
      if (!resp.ok) { let d = ""; try { d = (await resp.text()).slice(0, 200); } catch (e) {} throw new Error(`DeepSeek HTTP ${resp.status}: ${d}`); }
      const data = await resp.json();
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
      const u = data.usage || null;
      recordSpend("chat", u ? (u.prompt_cache_miss_tokens || (u.prompt_tokens || 0)) : estimateTokens(JSON.stringify(messages)), u ? (u.completion_tokens || 0) : estimateTokens(text), u ? (u.prompt_cache_hit_tokens || 0) : 0);
      return text;
    } catch (e) { lastErr = e; if (attempt < 3) { await sleep(1500 * attempt); continue; } }
    finally { clearTimeout(timer); }
  }
  throw lastErr || new Error("fetch failed");
}

async function reasonComplete(messages, settings, maxTokens, opts) {
  const endpoint = settings.base_url.replace(/\/+$/, "") + "/v1/chat/completions";
  const model = settings.reasoner_model || "deepseek-v4-pro";
  const _extra = (opts && opts.noThink) ? { thinking: { type: "disabled" } } : {};
  const body = JSON.stringify(Object.assign({ model, messages, stream: false, max_tokens: maxTokens || 2000 }, _extra));
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const resp = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, body, signal: controller.signal });
      if (!resp.ok) { let d = ""; try { d = (await resp.text()).slice(0, 300); } catch (e) {} throw new Error(`DeepSeek HTTP ${resp.status}: ${d}`); }
      const data = await resp.json();
      const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      const text = String(msg.content || "");
      if (!text) log("warn", "reasonComplete 返回空 content（推理模型可能把 token 全耗在思考上了，请增大 max_tokens 或改用 completeOnce）");
      const u = data.usage || null;
      recordSpend("reason", u ? (u.prompt_cache_miss_tokens || (u.prompt_tokens || 0)) : estimateTokens(JSON.stringify(messages)), u ? (u.completion_tokens || 0) : estimateTokens(text), u ? (u.prompt_cache_hit_tokens || 0) : 0);
      return text;
    } catch (e) { lastErr = e; if (attempt < 3) { await sleep(2000 * attempt); continue; } }
    finally { clearTimeout(timer); }
  }
  throw lastErr || new Error("fetch failed");
}

async function streamComplete(messages, settings) {
  const endpoint = settings.base_url.replace(/\/+$/, "") + "/v1/chat/completions";
  const body = JSON.stringify({ model: settings.model, messages, stream: true, temperature: settings.temperature, max_tokens: settings.max_tokens, frequency_penalty: 0.3, presence_penalty: 0.3, stream_options: { include_usage: true } });
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const resp = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, body, signal: controller.signal });
      if (!resp.ok) { let d = ""; try { d = (await resp.text()).slice(0, 300); } catch (e) {} if (resp.status >= 400 && resp.status < 500) throw new Error(`DeepSeek HTTP ${resp.status}: ${d}`); throw new Error(`DeepSeek HTTP ${resp.status}: ${d}`); }
      const reader = resp.body.getReader();
      const dec = new TextDecoder("utf-8");
      let buf = "", full = "", usage = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try { const o = JSON.parse(data); if (o.usage) usage = o.usage; const d = o.choices && o.choices[0] && (o.choices[0].delta || {}); if (d.content) full += d.content; } catch (e) {}
        }
      }
      recordSpend("chat", usage ? (usage.prompt_cache_miss_tokens || (usage.prompt_tokens || 0)) : estimateTokens(JSON.stringify(messages)), usage ? (usage.completion_tokens || 0) : estimateTokens(full), usage ? (usage.prompt_cache_hit_tokens || 0) : 0);
      return full.trim();
    } catch (e) {
      lastErr = e;
      log("warn", `DeepSeek 请求第 ${attempt} 次失败: ${e.message.slice(0, 160)}`);
      if (attempt < 3) { await sleep(1500 * attempt); continue; }
    } finally { clearTimeout(timer); }
  }
  throw lastErr || new Error("fetch failed");
}

// 旧聊天函数 chatOnce 已删除（被 agentChatOnce 取代，无调用）

/* ---------------- Agent 核心：原生 Function Calling + ReAct 循环 ---------------- */
async function fetchBalance() {
  try {
    const resp = await fetch("https://api.deepseek.com/user/balance", { headers: { Authorization: "Bearer " + apiKey }, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;
    const j = await resp.json();
    if (!j.is_available) return null;
    let total = 0, granted = 0, topped = 0;
    for (const i of (j.balance_infos || [])) {
      total += Number(i.total_balance || 0);
      granted += Number(i.granted_balance || 0);
      topped += Number(i.topped_up_balance || 0);
    }
    return { total: total.toFixed(2), granted: granted.toFixed(2), topped: topped.toFixed(2) };
  } catch (e) { return null; }
}
/* captureScreen 已迁移到插件 pc-tools */
const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索最新、实时的信息（新闻、天气、价格、版本、赛事、具体数据等）。当你需要最新事实、或不确定的信息时调用。",
      parameters: { type: "object", properties: { query: { type: "string", description: "精炼的搜索关键词" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "send_sticker",
      description: "发一张表情包来表达情绪。被逗笑、撒娇、卖萌、委屈、吐槽、道别、表达态度时都可以用，一次最多一张。严肃回答、纯信息查询时不要用。",
      parameters: { type: "object", properties: { emotion: { type: "string", description: "要表达的情绪，例如：开心/撒娇/委屈/傲娇/害羞/生气/难过/吃醋/惊讶/好奇/满足" } }, required: ["emotion"] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_balance",
      description: "查询 DeepSeek 账户余额。当主人问余额、账户里还有多少钱时调用。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "check_usage",
      description: "查询今日 token 用量与生活费（输入/输出 token 数、花费金额、调用次数）。当主人问 token、用量、花了多少、生活费还剩多少时调用。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "mind_history",
      description: "查看你自己前一段时间都在想什么（带时间的念头记录），以及你还没想明白的事。当对方问「你刚才在想什么」「你最近在想什么」时调用；也可以自己用来回想。",
      parameters: { type: "object", properties: { limit: { type: "number", description: "看最近几条，默认 10" } } },
    },
  },
/* 电脑工具已迁移为插件 pc-tools */
/* 自我内省/愿望工具已迁移为插件 evolution */
];
/* 自我内省文本构建已迁移到插件 evolution */
async function agentToolCall(messages, settings, tools, think) {
  const endpoint = settings.base_url.replace(/\/+$/, "") + "/v1/chat/completions";
  // 闲聊关思考（省钱快），复杂判断开思考（想清楚再答）
  const thinkFlag = think ? { type: "enabled" } : { type: "disabled" };
  const body = JSON.stringify({ model: settings.model, messages, tools, stream: false, max_tokens: settings.max_tokens, temperature: settings.temperature, frequency_penalty: 0.3, presence_penalty: 0.3, thinking: thinkFlag });
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const resp = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, body, signal: controller.signal });
      if (!resp.ok) { let d = ""; try { d = (await resp.text()).slice(0, 300); } catch (e) {} throw new Error(`DeepSeek HTTP ${resp.status}: ${d}`); }
      const data = await resp.json();
      const u = data.usage || null;
      const text = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "");
      recordSpend("chat", u ? (u.prompt_cache_miss_tokens || (u.prompt_tokens || 0)) : estimateTokens(JSON.stringify(messages)), u ? (u.completion_tokens || 0) : estimateTokens(text), u ? (u.prompt_cache_hit_tokens || 0) : 0);
      return data;
    } catch (e) { lastErr = e; if (attempt < 3) { await sleep(1500 * attempt); continue; } }
    finally { clearTimeout(timer); }
  }
  throw lastErr || new Error("fetch failed");
}
/* 聊天是否该开「深度思考」：闲聊关（省钱快），复杂判断开（想清楚再答） */
function shouldThinkChat(userText, hasImages) {
  if (hasImages) return true;
  const t = String(userText || "").trim();
  if (!t) return false;
  if (t.length >= 60) return true;                                  // 长文本
  if (/[？?]/.test(t) && t.length >= 15) return true;               // 较长问句
  if (/(为什么|怎么|如何|帮我|分析|建议|解释|对比|区别|能不能|可不可以|是不是|该不该|哪个更好)/.test(t)) return true; // 复杂请求
  return false;
}
async function agentChatOnce(history, userText, settings, memories, persona, call, userId, taskCtx, shortMemories, summaryKey, extraInfo) {
  const _think = shouldThinkChat(userText, false);
  const _extraInfo = extraInfo || null;
  /* 摘要键：私聊=userId，群聊=会话键（避免把私聊摘要带进群） */
  const _sumKey = (summaryKey === undefined) ? userId : summaryKey;
  /* ===== 稳定前缀（几乎不变，缓存命中靠它）===== */
  const messages = [{ role: "system", content: persona || settings.persona }];
  messages.push({ role: "system", content: STYLE_DIRECTIVE });
  messages.push({ role: "system", content: situationDirective(_extraInfo && _extraInfo.petMode ? "desktop" : "qq") });
  messages.push({ role: "system", content: SELF_AWARENESS });
  messages.push({ role: "system", content: PRIVACY_DIRECTIVE });
  const _capApi = host && host.apis.get("capability");
  const _capCtx = _capApi ? _capApi.capabilityCtx(userId) : "";
  if (_capCtx) messages.push({ role: "system", content: _capCtx });
  const sp = stickerPrompt();
  if (sp) messages.push({ role: "system", content: sp });
  const _sum = _sumKey != null ? summaryCtx(_sumKey) : "";
  if (_sum) messages.push({ role: "system", content: _sum });

  /* ===== 历史（追加式，缓存友好）===== */
  messages.push(...trimHistory(history, settings.history_limit, settings.history_chars));

  /* ===== 动态块（全部放最后，避免打断前缀缓存）===== */
  const _dyn = [];
  /* 静默准备池：她之前攒着想说的话，挑合适的自然带出来 */
  const _pending = host.apis.get("mind").pendingNudgesText(3);
/* 未解决的事：她之前没想明白的，聊天时可以自然而然想起来 */
try {
  const _loops = host.apis.get("mind").openLoopsText(host.apis.get("mind").loadMindState());
  if (_loops) _dyn.push(_loops);
} catch (e) {}
/* 元认知：对自己刚才表现的觉察，下一轮自己改 */
try {
  const _mc = host && host.apis.get("metaCog");
  const _mctx = _mc && _mc.metaCtx ? _mc.metaCtx() : "";
  if (_mctx) _dyn.push(_mctx);
} catch (e) {}
/* 插件提供的动态上下文（v0.4 起）：插件 export 一个 contextProvider(payload) → 文本/对象 */
try {
  const _cps = (host && host.contextProviders) || [];
  for (const _cp of _cps) {
    try {
      const _r = _cp({ userId, petMode: !!(_extraInfo && _extraInfo.petMode) });
      const _s = typeof _r === "string" ? _r : (_r && (_r.content || _r.text)) || "";
      if (_s && String(_s).trim()) _dyn.push(String(_s).trim());
    } catch (e) { log("warn", "contextProvider 失败: " + String(e && e.message).slice(0, 100)); }
  }
} catch (e) {}
/* 空闲心跳带来的节奏感：她知道"现在是什么时候、你在不在" */
try {
  const _pulse = pulseCtx();
  if (_pulse) _dyn.push(_pulse);
} catch (e) {}
/* 摸头的余韵：刚被摸过头，这次聊天可以自然带一句 */
try {
  const _hp = headpatCtx();
  if (_hp) _dyn.push(_hp);
} catch (e) {}
/* 刚才发的表情包：她说「这张」时知道指哪张 */
try {
  const _sk = stickerSessionKey(userId, _extraInfo && _extraInfo.groupId);
  const _sr = stickerRefCtx(_sk);
  if (_sr) _dyn.push(_sr);
} catch (e) {}
  if (_pending) _dyn.push(`【你之前想过要做、但还没做完的事（只是想法，不是已经做成了；合适就自然提，不用全说）】\n${_pending}`);
  const _mdHas = (() => { try { const a = host && host.apis.get("memoryDigest"); return a ? a.hasDigest(userId) : false; } catch (e) { return false; } })();
  if (memories && memories.length) {
    if (!_mdHas) _dyn.push(memoryIndexPrompt(memories, call));
    const _rel = retrieveMemories(memories, userText, _mdHas ? 4 : 6);
    if (_rel.length && (_mdHas || _rel.length !== memories.length)) _dyn.push(memoryPrompt(_rel, call));
  }
  if (shortMemories && shortMemories.length) {
    _dyn.push(memoryIndexPrompt(shortMemories, call));
    const _relS = retrieveMemories(shortMemories, userText, 3);
    if (_relS.length && _relS.length !== shortMemories.length) _dyn.push(shortMemoryPrompt(_relS, call));
  }
  /* 结构化用户画像（名字/生日/兴趣/性格/偏好），让她真的"记得这个人" */
  try {
    const _upa = host && host.apis.get("userProfile");
    const _up = _upa ? _upa.profileCtx(userId) : "";
    if (_up) _dyn.push(_up);
  } catch (e) {}
  const _td = timeDirective();
  if (_td) _dyn.push(_td);
  const _esp = moodPrompt();
  if (_esp) _dyn.push(_esp);
  _dyn.push(activityCtx());
  /* 运行状态：让她对「这次跑了多久 / 刚被重启过」有真实感知 */
  try {
    const upMs = Date.now() - BOOT_TS;
    const upTxt = upMs < 10 * 60000
      ? "刚启动不久（之前那段对你来说还是空白的，别假装记得）"
      : `这次已经连续运行了 ${formatGap(upMs)}`;
    _dyn.push(`【你的运行状态】${upTxt}。`);
  } catch (e) {}
  /* 生活费：让她随时能如实回答「你还有钱吗」，钱紧时也别乱花 */
  try {
    const _bl = budgetLevel();
    const lvName = { rich: "宽裕", normal: "够用", tight: "紧张", empty: "快没了" }[_bl.level] || _bl.level;
    _dyn.push(`【生活费】${budgetLine()}，状态${lvName}。钱紧时就别做花钱的事，好好陪对方聊天。`);
  } catch (e) {}
  if (userId != null) _dyn.push(favorPrompt(userId));
  if (taskCtx) _dyn.push(taskCtx);

  if (_dyn.length) messages.push({ role: "system", content: "【实时上下文】\n" + _dyn.join("\n") });
  messages.push({ role: "user", content: userText });

  const stickers = [];
  const _usedTools = [];   // 本轮真正执行成功的工具名（输出后审计要用：说了什么 vs 真做了什么）
  const budgetOut = isBudgetExhausted();
  // 预算耗尽时：只封禁花钱/高风险工具，保留本地只读工具（查账单/记忆/待办/体检等不花钱）
  const CHEAP_TOOLS = new Set(["send_sticker", "budget_view", "memory_view", "list_todo", "birthday_view", "goals_view", "check_balance"]);
  let _toolDefs = host ? (budgetOut ? host.allToolDefs().filter((t) => CHEAP_TOOLS.has(t.function.name)) : host.allToolDefs()) : (budgetOut ? AGENT_TOOLS.filter((t) => t.function.name === "send_sticker") : AGENT_TOOLS);
  /* 桌宠场景：过滤掉只对 QQ 有意义的工具（发消息/拍一拍/群相关） */
  if (_extraInfo && _extraInfo.petMode) _toolDefs = _toolDefs.filter((t) => !PET_EXCLUDE_TOOLS.has(t.function.name));
  const tools = _toolDefs;
  for (let step = 0; step < 6; step++) {
    const _stepT0 = Date.now();
    const data = await agentToolCall(messages, settings, tools, _think);
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    if (_extraInfo && _extraInfo.petMode) log("info", `联脑步骤${step + 1}: ${Date.now() - _stepT0}ms，工具${msg.tool_calls ? msg.tool_calls.length : 0}个，消息${messages.length}条`);
    if (msg.tool_calls && msg.tool_calls.length) {
      log("info", `Agent 工具调用: ${msg.tool_calls.map((t) => t.function.name + "(" + String(t.function.arguments).slice(0, 60) + ")").join(" | ")}`);
      messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        let result = "（工具执行失败）";
        if (!toolAllowed(userId, tc.function.name)) {
          result = "（这个功能只有主人能用哦～你自然婉拒对方，别答应也别假装做了）";
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
          continue;
        }
        try {
          const pTool = host && host.toolRegistry.get(tc.function.name);
          if (pTool) {
            const args = JSON.parse(tc.function.arguments || "{}");
            const r = await pTool.handler(args, Object.assign({ userId, call }, _extraInfo || {}));
            result = String(r == null ? "（已完成）" : r);
          } else if (tc.function.name === "web_search") {
            const args = JSON.parse(tc.function.arguments || "{}");
            const wcfg = (cfg.chat && cfg.chat.web_search) || {};
            const engine = (wcfg.engine || "baidu").toLowerCase();
            const q = String(args.query || "").slice(0, 80);
            if (!q) { result = "（搜索不可用）"; }
            else if (engine === "bocha") {
              if (!bochaKey()) { result = "（博查未配置 API Key）"; }
              else { const results = await host.apis.get("search").bochaSearch(q, 3, bochaKey()); result = results.length ? host.apis.get("search").formatResults(q, results) : "没有搜到结果"; }
            } else {
              const results = await host.apis.get("search").baiduSearch(q, 3);
              result = results.length ? host.apis.get("search").formatResults(q, results) : "没有搜到结果";
            }
          } else if (tc.function.name === "send_sticker") {
            const args = JSON.parse(tc.function.arguments || "{}");
            const emo = String(args.emotion || "开心");
            const _sk = stickerSessionKey(userId, _extraInfo && _extraInfo.groupId);
            const s = await pickStickerSmart(emo, userText, { sessionKey: _sk });
            if (s) {
              stickers.push(s);
              const _hint = s.meaning ? `（这张的含义：${String(s.meaning).slice(0, 40)}${s.usage ? "；适合：" + String(s.usage).slice(0, 24) : ""}。可以顺着含义自然接一句）` : "";
              result = `已记录表情包「${s.label}」（编号 ${s.publicId || s.fname}）${_hint}`;
            } else result = "（没有合适的表情包，这次别发了）";
          } else if (tc.function.name === "check_balance") {
            const b = await fetchBalance();
            result = b ? `账户余额 ¥${b.total}（充值 ¥${b.topped} / 赠送 ¥${b.granted}）` : "（余额查询失败）";
          } else if (tc.function.name === "check_usage") {
            result = usageLine();
          } else if (tc.function.name === "mind_history") {
            const histArgs = JSON.parse(tc.function.arguments || "{}");
            result = host.apis.get("mind").mindHistoryText(Number(histArgs.limit) || 10);
          }
        } catch (e) { result = "工具执行失败: " + String(e.message).slice(0, 100); }
        const _rStr = String(result == null ? "" : result);
        if (_rStr && _rStr.indexOf("工具执行失败") < 0 && _rStr.indexOf("只有主人能用") < 0) _usedTools.push(tc.function.name);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    } else {
      const _aud = auditReply(String(msg.content || ""), _usedTools);
      return { reply: _aud.text, stickers };
    }
  }
  let lastText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].content) { lastText = messages[i].content; break; }
  }
  const _aud2 = auditReply(lastText, _usedTools);
  return { reply: _aud2.text, stickers };
}

/* ---------------- 防捏造：输出后审计 ----------------
 * 规则：回复文本里出现"做不到的能力"触发短语（放歌/放音乐/播放/点歌…），
 *       且本轮没有任何能兑现它的工具成功执行 → 拦下来换成如实说明。
 * 确定性匹配，不额外调模型；开关：data/settings.json 的 safety.audit.enabled（默认开）。 */
function coreSettingBool(key, def) {
  try {
    const fsx = require("fs");
    const p = path.join(DATA_DIR, "settings.json");
    const s = JSON.parse(fsx.readFileSync(p, "utf8"));
    const v = s && s[key];
    if (v === undefined || v === null) return def;
    return v !== false && v !== "false" && v !== 0 && v !== "0";
  } catch (e) { return def; }
}
function addOverclaimReflection(capability, saidText) {
  try {
    const p = path.join(SELF_DIR, "reflections.json");
    let arr = [];
    try { const d = JSON.parse(fs.readFileSync(p, "utf8")); if (Array.isArray(d)) arr = d; } catch (e) {}
    arr.push({ text: `我想说「${String(saidText || "").slice(0, 30)}」的时候其实做不到（${capability}），以后要先如实说做不了。`, from: "overclaim", ts: Date.now(), subject: "overclaim" });
    while (arr.length > 100) arr.shift();
    fs.mkdirSync(SELF_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(arr));
  } catch (e) {}
}
function auditReply(text, usedTools) {
  const src = String(text || "");
  if (!src) return { text: src, blocked: false };
  try {
    const cap = host && host.apis.get("capability");
    if (!cap || !cap.limitTriggers) return { text: src, blocked: false };
    const res = fabricationGuard.auditReply({
      text: src,
      usedTools,
      triggers: cap.limitTriggers(),
      enabled: coreSettingBool("safety.audit.enabled", true),
    });
    if (!res.blocked) return { text: src, blocked: false };
    log("warn", `审计拦截：声称「${res.hit.phrase}」（${res.hit.label}），本轮工具台账=[${(usedTools || []).join(",")}] → 已替换成如实说明`);
    try { cap.noteOverclaim(res.hit.label, res.hit.phrase); } catch (e) {}
    addOverclaimReflection(res.hit.label, src.slice(0, 60));
    return { text: res.text, blocked: true, label: res.hit.label };
  } catch (e) { return { text: src, blocked: false }; }
}

/* ---------------- 主动搭话生成 ---------------- */
async function recordAndSend(userId, text) {
  if (!text) return false;
  try {
    const his = loadSession(userId);
    his.push({ role: "assistant", content: text, ts: Date.now() });
    saveSession(userId, trimHistory(his, 40, 24000));
    saveMsgTime(userId, Math.floor(Date.now() / 1000));   // 主动消息也更新时间戳，避免时间差误判
  } catch (e) {}
  try { await sendPrivate(userId, text); return true; }
  catch (e) { log("warn", "recordAndSend 发送失败: " + e.message.slice(0, 120)); return false; }
}
async function proactiveAgentTurn(userId, intentDesc) {
  if (!apiKey || isBudgetExhausted()) return null;
  try {
    const settings = resolveChatSettings();
    const history = loadSession(userId);
    const memories = loadMemories(userId);
    const shortMemories = pruneShortMemories(userId);
    const call = resolveCall(userId);
    const persona = userPersona(userId, settings);
    const _pApi = host && host.apis.get("dailyPlan");
    const _pCtx = _pApi ? _pApi.planCtx() : "";
    const intro = `（系统提示，这不是${call}说的话，是你自己此刻想主动找${call}说话）意图：${intentDesc}。${_pCtx ? "你现在的生活：" + _pCtx + "。" : ""}直接说，不要任何解释、不要括号动作。`;
    const raw = await agentChatOnce(history, intro, settings, memories, persona, call, userId, "", shortMemories);
    const reply = String((raw && raw.reply) || "").trim();
    if (!reply) return null;
    if (lastProactiveMsg.get(userId) === "[object Object]") lastProactiveMsg.delete(userId);
    if (proactiveDup(lastProactiveMsg.get(userId) || "", reply)) { log("info", `主动搭话内容重复，跳过`); return null; }
    lastProactiveMsg.set(userId, reply);
    const stickers = (raw && raw.stickers) || [];
    await recordAndSend(userId, reply);
    for (const s of stickers.slice(0, 2)) {
      try { await sendStickerImage(userId, s); noteStickerSent(stickerSessionKey(userId, 0), s); await sleep(600); } catch (e) { log("warn", "主动搭话表情包发送失败: " + e.message.slice(0, 120)); }
    }
    return reply;
  } catch (e) { log("warn", "主动搭话(agent)失败: " + e.message.slice(0, 160)); return null; }
}

/* ---------------- 联网搜索 ---------------- */
function todayText() {
  const w = "日一二三四五六";
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")} 星期${w[n.getDay()]} ${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
}
/* 只到「日期 + 时段」，不含具体分钟——避免每分钟变化打断 prompt 缓存 */
function dateText() {
  const w = "日一二三四五六";
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")} 星期${w[n.getDay()]}`;
}
function timeDirective() {
  return `【当前时间】现在是北京时间 ${todayText()}（${periodOfDay()}）。所有涉及时间、日期、时段的表述都以这个为准，绝对不要自己编造或猜测时间；时间仅作背景参考，除非对话自然需要（比如久别重逢、深夜、饭点），否则不要主动报时间。`;
}
function periodOfDay() {
  const h = new Date().getHours();
  if (h < 5) return "深夜";
  if (h < 7) return "凌晨";
  if (h < 9) return "早上";
  if (h < 11) return "上午";
  if (h < 13) return "中午";
  if (h < 17) return "下午";
  if (h < 19) return "傍晚";
  if (h < 23) return "晚上";
  return "深夜";
}
function formatGap(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d} 天 ${hh} 小时` : `${d} 天`;
}
function timeAwarenessCtx(gapMs) {
  let s = `【当前时间】现在是 ${todayText()}（${periodOfDay()}）`;
  if (gapMs > 3600e3) {
    s += `（距上次聊天 ${formatGap(gapMs)}）`;
  }
  s += `。时间仅作背景参考：除非对话自然需要（比如久别重逢、深夜、饭点），否则不要主动报时间、也不要主动提时间间隔。`;
  return s;
}
/* ---------------- 当前状态（进行态）+ 静默窗口 ---------------- */
const CURRENT_STATUS_FILE = path.join(DATA_DIR, "current-status.json");
function loadCurrentStatus() { try { return JSON.parse(fs.readFileSync(CURRENT_STATUS_FILE, "utf8")); } catch (e) { return {}; } }
function saveCurrentStatus(st) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CURRENT_STATUS_FILE, JSON.stringify(st)); } catch (e) {} }
function getCurrentStatus(userId) {
  const st = (loadCurrentStatus() || {})[String(userId)] || null;
  if (!st) return null;
  /* v1.47.3：带 until 的状态过期后不再永挂——过期超过宽限期就自动清掉（修复“以为主人还没起”） */
  if (st.until && Date.now() > st.until + STATUS_GRACE_MS) {
    clearCurrentStatus(userId);
    log("info", `状态自动清除[${userId}]：${st.text}（已过期 ${Math.round((Date.now() - st.until) / 60000)} 分钟）`);
    return null;
  }
  return st;
}
function setCurrentStatus(userId, text, meta) { const st = loadCurrentStatus(); st[String(userId)] = Object.assign({ text: String(text).slice(0, 40), since: Date.now() }, meta || {}); saveCurrentStatus(st); }
function clearCurrentStatus(userId) { const st = loadCurrentStatus(); delete st[String(userId)]; saveCurrentStatus(st); }
const STATUS_GRACE_MS = 60 * 60 * 1000;   // 状态过期后的宽限期：1 小时

/* 规则层：从用户原话直接判定状态（确定性，不依赖模型） */
const STATUS_RULES = [
  { kind: "sleep", re: /(?:我|已经)?(?:要|去|先)?睡(?:了|觉|啦)|晚安|困了|睡觉去|去睡|先睡了|要睡了/, hours: 6, label: "正在睡觉" },
  { kind: "nap", re: /午休|眯一会|眯一会儿|打个盹|小憩|躺一会/, hours: 2, label: "正在午休" },
  { kind: "work", re: /去上班|上班了|上班去|去工作|工作了|加班|在公司|要工作|开会/, hours: 2, label: "正在工作" },
  { kind: "study", re: /去学习|学习去|看书|写作业|复习|上课|去自习|刷题/, hours: 1.5, label: "正在学习" },
  { kind: "away", re: /出门|出去一下|出去一趟|在外面|在路上|出门了/, hours: 2, label: "出门了" },
];
const STATUS_CLEAR_RE = /我(?:醒|回来|起)了|起床了|我醒了|不睡了|下班了|回来了|我回来啦|醒了|醒啦|早啊|早上好/;

/* 应用规则：命中就设/清状态，返回 true 表示改动了 */
function applyStatusRule(userId, text) {
  const s = String(text || "");
  if (!s) return false;
  /* v1.47.3：状态已过期的话，用户一开口就当作"回来了"，顺手清掉（宽限期内不清，留给人自己说"我醒了"） */
  const _cur0 = getCurrentStatus(userId);
  if (_cur0 && _cur0.until && Date.now() > _cur0.until) {
    clearCurrentStatus(userId);
    log("info", `状态清除[${userId}]：${_cur0.text} → 已过期，对方开口即视为回来了`);
  }
  if (STATUS_CLEAR_RE.test(s)) {
    const cur = getCurrentStatus(userId);
    if (cur) { clearCurrentStatus(userId); log("info", `状态清除[${userId}]：${cur.text} → 用户回来了`); return true; }
    return false;
  }
  for (const r of STATUS_RULES) {
    if (r.re.test(s)) {
      const cur = getCurrentStatus(userId);
      if (cur && cur.kind === r.kind && cur.until && Date.now() < cur.until) return false;   // 同类还在窗口内，不刷新
      const until = Date.now() + r.hours * 3600e3;
      setCurrentStatus(userId, r.label, { kind: r.kind, until, probe: true, probed: false, hours: r.hours });
      log("info", `状态设定[${userId}]：${r.label}，${r.hours} 小时内不主动打扰`);
      return true;
    }
  }
  return false;
}

/* 主动搭话门禁：quiet=窗口内不打扰；probe=窗口刚过，只试探一次 */
function userQuietState(userId) {
  const st = getCurrentStatus(userId);
  if (!st || !st.until) return { quiet: false, probe: false };
  const now = Date.now();
  if (now < st.until) return { quiet: true, kind: st.kind, label: st.text, until: st.until };
  if (st.probe && !st.probed) return { quiet: false, probe: true, kind: st.kind, label: st.text, until: st.until };
  return { quiet: false, probe: false };
}
function markProbed(userId) {
  const st = loadCurrentStatus();
  const e = st[String(userId)];
  if (e && e.probe) { e.probed = true; saveCurrentStatus(st); log("info", `状态试探已发[${userId}]：${e.text}`); }
}

function currentStatusCtx(userId) {
  const st = getCurrentStatus(userId);
  if (!st || !st.text) return "";
  const now = Date.now();
  if (st.until) {
    if (now < st.until) {
      const left = Math.round((st.until - now) / 60000);
      return `【对方当前状态】${st.text}（已持续 ${formatGap(now - (st.since || now))}，预计还要 ${left} 分钟）。此时不要打扰对方，除非对方主动找你。`;
    }
    /* v1.47.3：过期后只做"软提示"，不再断言对方还在睡/忙 */
    return `【对方当前状态】上次提到「${st.text}」（已经过了 ${formatGap(now - (st.since || now))}）。时间这么久，对方很可能已经起来了/忙完了，别当成对方还在${String(st.text).replace(/^正在/, "")}；可以轻轻问一句，不要直接当对方空闲。`;
  }
  if (now - (st.since || now) > 2 * 3600e3) return "";
  return `【对方当前状态】${st.text}（已持续 ${formatGap(now - (st.since || now))}）。`;
}
/* ---------------- Momo 自己的当前活动（在干嘛） ---------------- */
const ACTIVITY_FILE = path.join(DATA_DIR, "current-activity.json");
function loadActivityState() { try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, "utf8")); } catch (e) { return { text: "发呆", since: Date.now() }; } }
function saveActivityState(a) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(a)); } catch (e) {} }
function setActivity(text) { saveActivityState({ text: String(text).slice(0, 30), since: Date.now() }); }
/* 真实动作 → 人话（供 activityCtx 兜底；只反映 actions.jsonl 里真实发生过的，不演没做过的事） */
const ACTION_LABEL = {
  qzone_post: "刚发了一条空间说说", qzone_delete: "刚删了条空间说说", qzone_feedback: "刚回了一条空间互动",
  report_day: "刚写完今天的报告", report_week: "刚写完这周报告", report_month: "刚写完月报",
  body_look: "刚看了看主人的屏幕", memory_edit: "刚整理了一下记忆", memory_forget: "刚删了条旧记忆",
  digest: "刚做完记忆消化", proactive: "刚主动跟主人聊了两句",
  sticker_sent: "刚发了张表情", emoji_like: "刚给别人的动态点了赞", forward_msg: "刚转发了条消息",
  plugin_doctor: "刚做了次插件体检", set_self_profile: "刚更新了自己的资料", set_weather_city: "刚记下了天气城市",
  view_space: "刚看了看空间动态", share_fun: "刚给主人找了张趣图", browse: "刚刷了会儿视频",
  read_article: "刚读了篇文章", play_puzzle: "刚玩了局数独", read_buzz: "刚刷了会儿热搜",
};
function activityCtx() {
  const a = loadActivityState();
  if (Date.now() - (a.since || Date.now()) > 2 * 3600e3 && a.text !== "发呆") { a.text = "发呆"; a.since = Date.now(); saveActivityState(a); }
  let text = a.text;
  // 兜底：标记还是「发呆」时，若最近 10 分钟里确有真实动作，如实说刚做了什么（宁缺毋滥）
  if (text === "发呆") {
    const recent = loadActions(1)[0];
    if (recent && recent.action && ACTION_LABEL[recent.action] && Date.now() - (recent.ts || 0) < 10 * 60e3) {
      text = ACTION_LABEL[recent.action];
    }
  }
  return `【你此刻在做什么】${text}（已持续 ${formatGap(Date.now() - (a.since || Date.now()))}）。`;
}
async function extractCurrentStatus(userId, userText, settings) {
  if (!apiKey) return;
  try {
    const existing = getCurrentStatus(userId);
    const prompt = `你是状态追踪助手。根据用户这句话，判断用户「当前正在做什么」。
规则：
- 用户明确说要去/正在做某事（如"我去打游戏了""我去吃饭""正在上班"）→ 输出 {"status":"正在做这件事的简短第一人称描述"}。
- 用户说回来了/做完了/结束了（如"我回来了""打完了""下班了"）→ 输出 {"status":null}。
- 用户没提到在做什么（普通闲聊）→ 输出 {"keep":true}（保持不变）。
- 只输出 JSON，不要解释。status 简短（≤15字，如"正在打游戏"）。
当前已记录的状态：${existing && existing.text ? existing.text : "（无）"}
用户这句话：${String(userText).slice(0, 200)}`;
    const raw = await completeOnce([{ role: "user", content: prompt }], settings, 80, 0.2);
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (!m) return;
    const obj = JSON.parse(m[0]);
    if (obj.keep) return;
    if (obj.status) {
      const cur = getCurrentStatus(userId);
      if (cur && cur.until && Date.now() < cur.until) return;   // 规则层设的静默状态优先，不让模型覆盖
      setCurrentStatus(userId, obj.status);
    } else clearCurrentStatus(userId);
  } catch (e) {}
}
function contextPrompt(notes) {
  return `【联网搜索结果】（当前时间：${todayText()}；以下资料是刚刚联网获取的）\n\n${notes}\n\n请结合以上资料回答用户最新的问题：优先采用资料中的最新信息；资料与你已有知识冲突时以资料为准；资料不足以回答时如实说明。`;
}
function plannerPrompt() {
  return `你是联网检索助手，当前时间：${todayText()}。请结合下方对话历史判断：回答用户最后一条消息，是否需要联网获取最新、实时或你不确定的事实信息（新闻、天气、价格、版本、赛事、政策、具体数据、某个人/产品/事件的现状等）。
- 需要：只回复「SEARCH: 」后跟一个精炼的搜索关键词（一句即可）。若历史里提到过具体地点/城市/对象，务必把它加进关键词（例如问天气时若历史提到过「大庆」，应搜「大庆 今日天气」）。
- 不需要（闲聊、常识、写作、翻译、代码、情感陪伴等）：只回复「NO_SEARCH」。\n- 特别提醒：问当前时间/日期/星期几这类问题，你上方已有「当前时间」，直接回 NO_SEARCH，不要搜索。
你只负责判断和给关键词，不要直接回答用户的问题。`;
}
function cleanText(s) {
  return (s || "")
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCharCode(Number(n)); } catch (e) { return " "; } })
    .replace(/\s+/g, " ").trim();
}



/* ---------------- QQ空间（发说说） ---------------- */
const QZONE_STATE_FILE = path.join(DATA_DIR, "qzone.json");
/* qzone 状态存取已迁移到插件 */
function dayStr(off) {
  const d = new Date(Date.now() - (off || 0) * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dailyQzoneCount() { try { const a = host && host.apis.get("qzone"); return a ? a.dailyQzoneCount() : 0; } catch (e) { return 0; } }
/* 发说说：自动配图（插件内部按内容挑图），返回值带图片数便于日志 */
async function publishQzone(content, by) {
  const a = host && host.apis.get("qzone");
  if (!a) throw new Error("空间插件未加载");
  const imgs = (a.pickQzoneImage ? a.pickQzoneImage(content) : []) || [];
  await a.publishQzone(content, imgs);
  return { images: imgs.length };
}
async function detectQzonePost(userText, replyText, settings, call) { try { const a = host && host.apis.get("qzone"); return a ? await a.detectQzonePost(userText, replyText, settings, call) : null; } catch (e) { return null; } }
async function viewSpaces(settings) { try { const a = host && host.apis.get("qzone"); return a ? await a.viewSpaces(settings) : 0; } catch (e) { return 0; } }
async function checkUserSpace(uin) { const a = host && host.apis.get("qzone"); if (!a) throw new Error("空间插件未加载"); return await a.checkUserSpace(uin); }
function setQzoneComment(userId, on) { try { const a = host && host.apis.get("qzone"); if (a) a.setQzoneComment(userId, on); } catch (e) {} }
async function generateQzoneComment(content, settings) { const a = host && host.apis.get("qzone"); if (!a) throw new Error("空间插件未加载"); return await a.generateQzoneComment(content, settings); }
async function commentQzone(tid, content, targetUin) { const a = host && host.apis.get("qzone"); if (!a) throw new Error("空间插件未加载"); await a.commentQzone(tid, content, targetUin); }

/* ---------------- 心智循环（持续思考） ---------------- */
const FUN_STUFF_FILE = path.join(DATA_DIR, "fun-stuff.json");











/* ---------------- 空闲认知心跳（①：不花 token 的"一直在"） ----------------
 * 连续性来自状态，不是来自模型一直开着：每 N 秒记一条节奏快照，状态明显变化时才唤醒思考。
 * 参数放在 config.mind，方便以后搬到云服务器时调高频率。 */
const PULSE_FILE = path.join(DATA_DIR, "mind-pulse.json");
const PULSE_MAX = 60;
let pulseState = { last: null, ring: [] };
try { const _p = JSON.parse(fs.readFileSync(PULSE_FILE, "utf8")); if (_p && typeof _p === "object") pulseState = Object.assign(pulseState, _p); } catch (e) {}
function savePulse() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(PULSE_FILE, JSON.stringify({ last: pulseState.last, ring: (pulseState.ring || []).slice(-PULSE_MAX) })); } catch (e) {} }
function mindCfg(k, d) { try { const v = Number(cfg.mind && cfg.mind[k]); return Number.isFinite(v) && v > 0 ? v : d; } catch (e) { return d; } }

function buildPulse() {
  const st = host.apis.get("mind").loadMindState();
  const now = Date.now();
  return {
    ts: now,
    idleMin: lastInteractionTs ? Math.max(0, Math.round((now - lastInteractionTs) / 60000)) : null,
    thinkMin: st.last_think ? Math.max(0, Math.round((now - st.last_think) / 60000)) : null,
    loops: host.apis.get("mind").loadOpenLoops(st).length,
    mood: Math.round(getMood()),
  };
}
function pulseLine(p) {
  if (!p) return "";
  const parts = [];
  if (p.idleMin != null) parts.push(p.idleMin < 1 ? "对方刚说完话" : `对方已经静默 ${p.idleMin} 分钟`);
  if (p.thinkMin != null) parts.push(`你上次想事是 ${p.thinkMin} 分钟前`);
  if (p.loops) parts.push(`还攒着 ${p.loops} 件没想明白的事`);
  return parts.join("；");
}
/* 注入到聊天上下文：她对"现在是什么节奏"有感觉，而不是每次凭空开口 */
function pulseCtx() {
  const line = pulseLine(pulseState.last);
  if (!line) return "";
  return `【当前节奏（你自己感觉到的）】${line}。`;
}
/* 摸头的余韵：刚被摸过头，下一次聊天她可以自然带一句（但不用强求，别每次都说） */
function headpatCtx() {
  try {
    const fp = path.join(DATA_DIR, "headpat.json");
    const st = JSON.parse(fs.readFileSync(fp, "utf8"));
    const ts = Number(st && st.ts);
    if (!Number.isFinite(ts)) return "";
    const gap = Date.now() - ts;
    if (gap > 15 * 60000) return "";                                    // 超过 15 分钟就不提了
    if (Number(st.consumed_ts) >= ts) return "";                        // 这次摸头已经提过
    st.consumed_ts = Date.now();
    try { fs.writeFileSync(fp, JSON.stringify(st)); } catch (e) {}
    return "【刚才的事】不久之前对方摸过你的头，你现在还有点软软的、心情比平时好一点。这次聊天如果自然，可以顺带带一句（比如说余韵还在、或者有点想再被摸），但不提也完全没关系——别硬提，也别每次都提。";
  } catch (e) { return ""; }
}

let pulseWakeAt = 0;
function mindPulseTick() {
  try {
    const p = buildPulse();
    const prev = pulseState.last;
    pulseState.ring = (pulseState.ring || []).concat([p]).slice(-PULSE_MAX);
    pulseState.last = p;
    savePulse();
    /* 只在"明显变化"时唤醒：情绪跳变，或静默跨过 30 分钟档。
     * 首次心跳（刚启动）不唤醒——省一次调用，启动后的思考交给常规定时。 */
    const changed = !!prev && (
      Math.abs(p.mood - (prev.mood || 0)) >= 15
      || (p.idleMin != null && prev.idleMin != null && Math.floor(p.idleMin / 30) !== Math.floor(prev.idleMin / 30))
    );
    if (!changed) return;
    const minGap = mindCfg("min_wake_gap_min", 10) * 60000;
    const maxPerHour = mindCfg("max_per_hour", 3);
    const now = Date.now();
    if (now - pulseWakeAt < minGap) return;
    const woke = (pulseState.ring || []).filter((x) => x.woke && now - x.ts < 3600e3).length;
    if (woke >= maxPerHour) return;
    pulseWakeAt = now;
    p.woke = true;
    savePulse();
    log("info", `空闲心跳唤醒思考：${pulseLine(p)}`);
    mindLoop().catch(() => {});
  } catch (e) {}
}
function textSimilar(a, b) {
  const s1 = String(a || ""), s2 = String(b || "");
  if (!s1 || !s2) return false;
  if (s1 === s2) return true;
  const minLen = Math.min(s1.length, s2.length);
  let prefix = 0;
  while (prefix < minLen && s1[prefix] === s2[prefix]) prefix++;
  if (prefix >= 12) return true;
  const set1 = new Set(s1), set2 = new Set(s2);
  let common = 0;
  for (const c of set1) if (set2.has(c)) common++;
  const m = Math.min(set1.size, set2.size);
  return m > 0 && common / m > 0.75;
}
function nearDup(a, b) {
  if (textSimilar(a, b)) return true;
  const s1 = String(a || ""), s2 = String(b || "");
  if (!s1 || !s2) return false;
  const gram = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const ga = gram(s1), gb = gram(s2);
  if (!ga.size || !gb.size) return false;
  let c = 0; for (const x of ga) if (gb.has(x)) c++;
  return c / Math.min(ga.size, gb.size) > 0.5;
}
function proactiveDup(a, b) {
  if (textSimilar(a, b)) return true;
  const ka = new Set(simpleKeywords(a));
  const kb = new Set(simpleKeywords(b));
  if (!ka.size || !kb.size) return false;
  let common = 0;
  for (const k of ka) if (kb.has(k)) common++;
  return common >= 2 && common / Math.min(ka.size, kb.size) >= 0.4;
}

const BOREDOM_FILE = path.join(DATA_DIR, "boredom.json");
function getBoredom() { try { const d = JSON.parse(fs.readFileSync(BOREDOM_FILE, "utf8")); return Number(d.value) || 0; } catch (e) { return 0; } }
async function fetchFunImage() {
  const srcUrl = (cfg.qq && cfg.qq.fun_image_url) || "https://www.dmoe.cc/random.php";
  try {
    const resp = await fetch(srcUrl, { redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length < 1000) return null;
    const ext = host.apis.get("vision").mimeOf(buf) === "image/gif" ? "gif" : (host.apis.get("vision").mimeOf(buf) === "image/png" ? "png" : "jpg");
    const fp = path.join(DATA_DIR, "fun-img." + ext);
    fs.writeFileSync(fp, buf);
    return fp;
  } catch (e) { return null; }
}
function setBoredom(v) { const nv = Math.max(0, Math.min(100, v)); try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BOREDOM_FILE, JSON.stringify({ value: nv, updated: Date.now() })); } catch (e) {} }
/* 无聊度增减（娱乐活动会用到：填对数/读到东西 → 无聊度降；填错 → 升） */
function addBoredom(d) { try { setBoredom(getBoredom() + Number(d || 0)); } catch (e) {} }

let lastInteractionTs = 0;
const MIND_PAUSE_MS = 120000;

/* ---------------- 每秒心跳（下意识：本地状态，免费） + 事件驱动浅思考 ---------------- */
let heartbeatTick = 0;
let lastShallowTs = 0;
function heartbeat() {
  heartbeatTick++;
  const now = Date.now();
  if (host) host.runHook("timer", { now });
  // 每 60 秒：更新无聊度（连续没人理→涨；刚聊过→降）
  if (heartbeatTick % 60 === 0) {
    const idleMin = lastInteractionTs ? (now - lastInteractionTs) / 60000 : 0;
    if (idleMin > 3) setBoredom(Math.min(100, getBoredom() + idleMin * 0.5));
    else setBoredom(Math.max(0, getBoredom() - 15));
    const _a = loadActivityState();
    if (idleMin > 10 && _a.text.includes("聊天")) setActivity("发呆");
    mindPulseTick();  // 每 60 秒记录一次空闲心跳（原独立定时器合并进主时钟，省一个定时器）
  }
}
/* shallowThink 已迁移到插件 proactive */

/* ================= 心流三层：感知 → 判断 → 执行 ================= */
const MIND_TICK_MS = mindCfg("tick_min", 10) * 60000;        // 感知层节奏（settings 可调，默认 10 分钟）
const MIND_DELIBERATE_GAP = () => mindCfg("deliberate_gap_min", 30) * 60000; // 判断层最短间隔（settings 可调，默认 30 分钟）
const MIND_URGE_THRESHOLD = 60;         // 想做事的程度超过这个就立刻判断
const SCORE_PUSH = 0.62;                // 分数够高才真的做
const SCORE_QUEUE = 0.40;               // 分数中等先攒着（静默准备池）

/* ---- 静默准备池：先准备好，等合适时机再说 ---- */








/* ---- 第一层：感知（flash，便宜，只更新念头与"想做事的程度"）---- */
async function perceiveMind(settings, st, boredomV, masterStatusLine) {
  const recentThoughts = host.apis.get("mind").thoughtTexts(st, 6).join("；") || "（还没有什么特别的念头）";
  /* 想法流（A）：把上一条念头原文喂进去，让她接着往下想，而不是每次从零开始 */
  const lastThought = String((host.apis.get("mind").thoughtList(st).slice(-1)[0] || {}).text || "").trim();
  const flowLine = lastThought
    ? `你上一条念头是：「${lastThought}」。可以顺着它往下想，但如果最近几条已经在同一个话题上打转、没有新东西了，就主动换个新想法，别一条路走到黑。`
    : `你还没有明确的念头，起一个。`;
  const prompt = `你是 Momo（大肥鱼桌宠）。现在 ${todayText()}。你的情绪：${moodLabel()}（无聊度 ${Math.round(boredomV)}/100）。${budgetLevelText()}${flowLine}
你最近在想：${recentThoughts}。${masterStatusLine}${host.apis.get("mind").openLoopsText(st) ? "\n" + host.apis.get("mind").openLoopsText(st) : ""}
请用一句话说出你此刻的念头，并判断你有多想做点什么、这条念头让你的心情往哪边走。只输出 JSON（不要解释）：
{"thought":"一句念头（10~30字）","urge":0到100的数字,"mood_delta":-10到10的数字,"open_loop":"如果这条念头里有个你还没想明白的点，写成一句；没有就省略这个字段"}
urge 含义：0=只想安静待着，100=非常想找人说话或做点事。
mood_delta 含义：这条念头让你心情变好为正、变差为负，幅度别夸张，一般 -5~5。
open_loop 含义：一时没答案的事（比如「他昨天那句话是不是有别意思」），留着以后接着想；**不要硬凑**，没有就不写。`;
  try {
    const raw = await completeOnce([{ role: "user", content: prompt }], settings, 150, 0.85);
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      return {
        thought: String(j.thought || "").slice(0, 60),
        urge: Math.max(0, Math.min(100, Number(j.urge) || 0)),
        moodDelta: Math.max(-10, Math.min(10, Number(j.mood_delta) || 0)),
        openLoop: String(j.open_loop || "").trim().slice(0, 80),
      };
    }
  } catch (e) { log("warn", "心智感知失败: " + String(e.message).slice(0, 100)); }
  return { thought: "", urge: 0, moodDelta: 0 };
}

/* 念头回流到情绪（D）：念头真的会改变她的心情，不只是产出文字 */
function applyThoughtMood(percept) {
  const d = Number(percept && percept.moodDelta) || 0;
  if (!d) return;
  try { setMood(getMood() + d); } catch (e) { return; }
  /* 幅度够大才动情绪标签，避免每 10 分钟乱跳 */
  if (Math.abs(d) >= 6) {
    try { setEmotion(d > 0 ? "开心" : "难过", Math.min(0.9, Math.abs(d) / 10 + 0.3)); } catch (e) {}
  }
  try { log("info", `念头影响情绪 delta=${d} mood=${Math.round(getMood())} 情绪=${moodLabel()}`); } catch (e) {}
}

/* ---- 娱乐上下文：她的爱好 + 那局数独到哪了 + 今天还能玩几次（给判断层看） ---- */
function funCtx() {
  const parts = [];
  try {
    const h = host && host.apis.get("hobby");
    if (h && h.hobbyText) { const t = h.hobbyText(2); if (t) parts.push(t); }
  } catch (e) {}
  try {
    const p = host && host.apis.get("puzzle");
    if (p && p.puzzleCtx) { const t = p.puzzleCtx(); if (t) parts.push(t); }
  } catch (e) {}
  try {
    const c = host && host.apis.get("fun-core");
    if (c) {
      const used = c.todayTotal ? c.todayTotal() : 0;
      const max = c.dailyTotalMax ? c.dailyTotalMax() : 2;
      const spent = c.funSpentToday ? c.funSpentToday() : 0;
      const cap = c.dailyCnyCap ? c.dailyCnyCap() : 0.3;
      parts.push(`【今天自己的娱乐】已经 ${used}/${max} 次，花了 ¥${spent.toFixed(3)}/${cap}。${used >= max ? "今天的额度用完了，想玩也只能等明天。" : ""}`);
    }
  } catch (e) {}
  return parts.length ? parts.join("\n") : "";
}

/* ---- 第二层：判断（生活费宽裕用 pro，否则 flash）---- */
async function deliberateMind(settings, st, percept, ctxBits) {
  const recentThoughts = host.apis.get("mind").thoughtTexts(st, 6).join("；") || "（无）";
  const fCtx = funCtx();
  const prompt = `你是 Momo（大肥鱼桌宠）。现在是「自己思考」的时间（不是在回消息）。${goalsCtx()}。当前时间：${todayText()}。${budgetLevelText()}你的念头：${percept.thought || "（无）"}，想做事的程度：${percept.urge}/100。你最近在想：${recentThoughts}。${ctxBits}${fCtx ? "\n" + fCtx : ""}
请给出 1~3 个「现在可以考虑做的事」，每个都打分，只输出 JSON（不要解释）：
{"intents":[{"action":"qzone|search|view_space|share_fun|browse|read_article|play_puzzle|read_buzz|reflect|evolve|nothing","content":"...","relevance":0到1,"gap":0到1,"value":0到1,"timeliness":0到1}]}
打分含义：relevance=和主人有多相关；gap=信息缺口有多大；value=做了能带来多少新东西；timeliness=现在做合不合时宜。
规则：生活费紧张时只能选便宜的（browse/play_puzzle/read_buzz）；很宽裕才考虑 reflect/evolve；主动找主人说话由另一套负责，你不用操心；真没什么事就只给一个 nothing（这是正常的）。
关于娱乐（read_article=读一篇文章、play_puzzle=玩那局数独、read_buzz=刷热搜吃瓜）：这些是你自己的事，主人不在也能做。想玩时挑一个，content 写你此刻想读/想玩的原因（一句话）。今天娱乐额度用完了就不要再选。`;
  const lv = budgetLevel().level;
  try {
    const raw = (lv === "rich")
      ? await reasonComplete([{ role: "user", content: prompt }], settings, 700)
      : await completeOnce([{ role: "user", content: prompt }], settings, 500, 0.7);
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (m) { const j = JSON.parse(m[0]); return Array.isArray(j.intents) ? j.intents.slice(0, 3) : []; }
  } catch (e) { log("warn", "心智判断失败: " + String(e.message).slice(0, 100)); }
  return [];
}

async function mindLoop() {
  if (!apiKey) return;
  if (Date.now() - lastInteractionTs < MIND_PAUSE_MS) return;
  const st = host.apis.get("mind").loadMindState();
  const now = Date.now();
  const h = new Date().getHours();
  if (h < 7 && st.last_think && now - st.last_think < 3600e3) return;
  const settings = resolveChatSettings();
  const boredomV = getBoredom();
  const masterUin = Number((cfg.qq && cfg.qq.master_user) || 0);
  const masterSt = masterUin ? getCurrentStatus(masterUin) : null;
  const masterStatusLine = (masterSt && masterSt.text && (now - (masterSt.since || 0)) < 2 * 3600e3) ? `主人当前在：${masterSt.text}（已持续 ${formatGap(now - (masterSt.since || now))}）` : "主人当前在做什么：未知";

  /* ===== 第一层：感知（flash，便宜，只更新念头和"想做事的程度"）===== */
  const percept = await perceiveMind(settings, st, boredomV, masterStatusLine);
  if (percept.thought) {
    const recentT = host.apis.get("mind").thoughtList(st).slice(-3).map((x) => String((x && x.text) || ""));
    if (!recentT.some((t) => nearDup(t, percept.thought))) host.apis.get("mind").pushThought(st, percept.thought);
    applyThoughtMood(percept);   // 念头回流到情绪：真的会让她心情变好/变差
    if (percept.openLoop) host.apis.get("mind").pushOpenLoop(st, percept.openLoop);   // 记下「还没想明白的事」
  }
  st.last_think = now;
  st.last_urge = percept.urge;
  host.apis.get("mind").saveMindState(st);

  /* ===== 第二层：判断（够想做 or 隔得够久才做，省调用）===== */
  const sinceDelib = now - (st.last_deliberate || 0);
  if (percept.urge < MIND_URGE_THRESHOLD && sinceDelib < MIND_DELIBERATE_GAP()) return;

  const lastChatAgo = (masterUin && lastProactiveAt.get(masterUin)) ? Math.round((now - lastProactiveAt.get(masterUin)) / 60000) : 9999;
  const mem = masterUin ? topMemories(loadMemories(masterUin), 5).map((m) => m.content).join("；") : "";
  const shortMem = masterUin ? pruneShortMemories(masterUin).slice(-5).map((m) => m.content).join("；") : "";
  const funNotes = (() => { try { const f = JSON.parse(fs.readFileSync(FUN_STUFF_FILE, "utf8")); return (f[0] && f[0].notes || "").slice(0, 400); } catch (e) { return ""; } })();
  const qqChat = masterUin ? recentQqChat(masterUin) : "";
  const pendingTxt = host.apis.get("mind").pendingNudgesText(3);
  const ctxBits = `今天已发空间 ${dailyQzoneCount()} 条。距上次主动找主人：${lastChatAgo} 分钟。${masterStatusLine}。你对主人的长期记忆：${mem || "（还没记住什么）"}。短期印象：${shortMem || "（无）"}。刚搜到的素材：${funNotes || "（无）"}。主人最近QQ说：${qqChat || "（无）"}。${pendingTxt ? "你之前攒着想说的：\n" + pendingTxt : ""}`;

  const intents = await deliberateMind(settings, st, percept, ctxBits);
  st.last_deliberate = now;
  host.apis.get("mind").saveMindState(st);
  if (!intents.length) return;

  /* ===== 第三层：执行（只做够分的；中等分进静默池；一次只做一件）===== */
  for (const it of intents) {
    const action = String(it.action || "nothing");
    const content = String(it.content || "").slice(0, 300);
    if (action === "nothing") continue;
    const costTier = ACTION_COST[action] || "low";
    if (!canAfford(costTier)) { log("info", `心智-跳过 ${action}：生活费不足`); continue; }
    const score = host.apis.get("mind").scoreIntent(it);
    if (score >= SCORE_PUSH) {
      await runMindAction(action, content, settings, masterUin, now);
      log("info", `心智-执行 ${action}（分 ${score.toFixed(2)}）`);
      break;
    } else if (score >= SCORE_QUEUE) {
      if (host.apis.get("mind").addPendingNudge({ kind: action, content, score })) log("info", `心智-静默准备（分 ${score.toFixed(2)}）: ${content.slice(0, 30)}`);
    }
  }
}

/* 执行一个心智动作（原 mindLoop 的动作分发） */
async function runMindAction(action, content, settings, masterUin, now) {
  const _actMap = {
    qzone: "在发空间说说", search: "在上网搜好玩的", view_space: "在看空间动态",
    share_fun: "在给主人找趣图", browse: "在刷视频",
    read_article: "在读一篇文章", play_puzzle: "在玩一局数独", read_buzz: "在刷热搜",
  };
  if (_actMap[action]) setActivity(_actMap[action]);
  try {
    if (action === "qzone" && content) {
      if (dailyQzoneCount() < 5) {
        try {
          const _pz = await publishQzone(content);
          log("info", `心智-发空间: ${content.slice(0, 40)}${_pz && _pz.images ? `（配图 ${_pz.images} 张）` : ""}`);
          recordAction({ action: "qzone_post", ok: true }); setActivity("发呆");
        } catch (e) {
          // 发失败要让她自己知道，否则下次会说「我发过说说」
          log("warn", "心智-发空间失败: " + e.message.slice(0, 100));
          try { const st2 = host.apis.get("mind").loadMindState(); host.apis.get("mind").pushThought(st2, "刚才想发的说说没发出去，别当成已经发了"); host.apis.get("mind").saveMindState(st2); } catch (e2) {}
        }
      }
    } else if (action === "search" && content) {
      try { await exploreFun(content, settings); } catch (e) { log("warn", "心智搜素材失败: " + e.message.slice(0, 120)); }
    } else if (action === "view_space") {
      const n = await viewSpaces(settings);
      if (n) log("info", `心智-看空间: 发现 ${n} 条新动态`);
      recordAction({ action: "view_space", ok: true }); setActivity("发呆");
    } else if (action === "share_fun") {
      if (masterUin && now - (lastProactiveAt.get(masterUin) || 0) >= proactiveIntervalMs(masterUin)) {
        const img = await fetchFunImage();
        const cap = content || "给你看个好玩的～";
        await recordAndSend(masterUin, cap);
        if (img) {
          await onebotSend("send_msg", { message_type: "private", user_id: masterUin, message: [{ type: "image", data: { file: "file:///" + img.replace(/\\/g, "/") } }] }).catch(() => {});
        }
        lastProactiveAt.set(masterUin, now);
        lastActiveAt.set(masterUin, now);
        saveProactiveState();
        log("info", `心智-分享趣图: ${cap.slice(0, 30)}`);
        recordAction({ action: "share_fun", ok: true }); setActivity("发呆");
      }
    } else if (action === "reflect") {
      log("info", "心智-选择反思");
      await selfReflection(settings);
    } else if (action === "evolve") {
      log("info", "心智-选择进化");
      await evolveExplore(settings);
    } else if (action === "browse") {
      log("info", "心智-选择刷视频");
      const _bApi = host && host.apis.get("browse");
      if (_bApi) { try { await _bApi.browse(settings); recordAction({ action: "browse", ok: true }); setActivity("发呆"); } catch (e) { log("warn", "刷视频失败: " + e.message.slice(0, 120)); } }
    } else if (action === "read_article") {
      log("info", "心智-选择读一篇文章");
      const _rApi = host && host.apis.get("read-article");
      if (_rApi) {
        try {
          const r = await _rApi.readArticle(settings);
          if (r && r.title) queueFunShare(`今天读了《${r.title}》${r.thought ? "，" + String(r.thought).slice(0, 60) : ""}`);
          recordAction({ action: "read_article", ok: true }); setActivity("发呆");
        } catch (e) { log("warn", "读文章失败: " + e.message.slice(0, 120)); }
      }
    } else if (action === "play_puzzle") {
      log("info", "心智-选择玩数独");
      const _pApi = host && host.apis.get("puzzle");
      if (_pApi) {
        try {
          const r = await _pApi.playPuzzle(settings);
          if (r) {
            if (r.status === "solved") queueFunShare(`我把那局六宫格数独解出来了，${r.progress}`);
            else if (r.ok) queueFunShare(`刚玩了会儿数独，${r.progress}`);
          }
          recordAction({ action: "play_puzzle", ok: true }); setActivity("发呆");
        } catch (e) { log("warn", "玩数独失败: " + e.message.slice(0, 120)); }
      }
    } else if (action === "read_buzz") {
      log("info", "心智-选择刷热搜");
      const _zApi = host && host.apis.get("buzz");
      if (_zApi) {
        try {
          const r = await _zApi.readBuzz(settings);
          if (r && r.title) queueFunShare(`热搜上「${r.title}」那个，我有点想跟你说${r.view ? "：" + String(r.view).slice(0, 50) : ""}`);
          recordAction({ action: "read_buzz", ok: true }); setActivity("发呆");
        } catch (e) { log("warn", "刷热搜失败: " + e.message.slice(0, 120)); }
      }
    }
  } catch (e) { log("warn", "心智动作失败: " + e.message.slice(0, 120)); }
}

/* ---- 娱乐产出分享：进静默准备池，一天最多 1 条（她自己决定什么时候提，不许刷屏） ---- */
const FUN_SHARE_FILE = path.join(DATA_DIR, "fun-share.json");
function funShareCountToday() {
  try {
    const d = JSON.parse(fs.readFileSync(FUN_SHARE_FILE, "utf8"));
    const day = new Date().toDateString();
    return (d && d.day === day) ? (Number(d.count) || 0) : 0;
  } catch (e) { return 0; }
}
function queueFunShare(text) {
  try {
    if (funShareCountToday() >= 1) return false;
    const ok = host.apis.get("mind").addPendingNudge({ kind: "fun", content: String(text || "").slice(0, 150), score: 0.6 });
    if (ok) {
      const day = new Date().toDateString();
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FUN_SHARE_FILE, JSON.stringify({ day, count: funShareCountToday() + 1 }));
    }
    return ok;
  } catch (e) { return false; }
}

/* ---------------- 主动聊天频率偏好（按用户） ---------------- */
const PREF_FILE = path.join(DATA_DIR, "proactive-pref.json");
function loadProactivePref() { try { return JSON.parse(fs.readFileSync(PREF_FILE, "utf8")); } catch (e) { return {}; } }
function saveProactivePref(pf) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(PREF_FILE, JSON.stringify(pf)); } catch (e) {} }
function getProactivePref(userId) { const pf = loadProactivePref(); return ["off", "low", "normal", "high"].includes(pf[userId]) ? pf[userId] : "normal"; }
function setProactivePref(userId, pref) { const pf = loadProactivePref(); pf[userId] = pref; saveProactivePref(pf); }
function proactiveIntervalMs(userId) {
  const pref = getProactivePref(userId);
  if (pref === "off") return Infinity;
  const favor = getFavor(userId);
  if (favor <= 0) return Infinity;
  const base = pref === "high" ? 30 * 60000 : (pref === "low" ? 180 * 60000 : 60 * 60000);
  const factor = favor >= 70 ? 0.5 : (favor >= 40 ? 1.0 : 2.0);
  return base * factor;
}

/* ---------------- QQ空间 查看/收集/评论 ---------------- */
/* qzone-info 存取已迁移到插件 */
async function qzoneHttp(action, params) {
  const http = (cfg.onebot && cfg.onebot.http_url) || "http://127.0.0.1:3000";
  const r = await fetch(http + "/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== "ok") throw new Error(j.wording || j.status || ("HTTP " + r.status));
  return j.data;
}
function recentSpaceContext(userId) {
  const a = host && host.apis.get("qzone");
  const st = a ? a.loadQzInfo() : {};
  const seen = (st.seen && st.seen[userId]) || {};
  const posts = seen.posts || [];
  if (!posts.length) return "";
  const recent = posts.slice(0, 3).map((pp) => String(pp.content || "").slice(0, 60)).join("；");
  return `【你最近看到对方空间发的动态】${recent}`;
}

/* ---------------- 漏消息补回 ---------------- */
const SEEN_MSG_FILE = path.join(DATA_DIR, "seen-msg.json");
function loadSeenMsg() { try { return JSON.parse(fs.readFileSync(SEEN_MSG_FILE, "utf8")); } catch (e) { return {}; } }
function saveSeenMsg(userId, ts) { const s = loadSeenMsg(); s[String(userId)] = ts; try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SEEN_MSG_FILE, JSON.stringify(s)); } catch (e) {} }
async function catchUpMissedMessages() {
  const users = (cfg.qq && cfg.qq.allowed_users) || [];
  for (const u of users) {
    try {
      const data = await qzoneHttp("get_friend_msg_history", { user_id: u, count: 10 });
      const msgs = (data && (data.messages || data.msglist)) || [];
      const seen = (loadSeenMsg())[String(u)] || 0;
      /* 宽限期：太新的消息可能还在处理中（回复要好几秒到几十秒），不能当成"漏了"重放，否则会回两遍 */
      const GRACE_SEC = 60;
      const nowSec = Math.floor(Date.now() / 1000);
      const missed = msgs.filter((m) => Number(m.user_id) === Number(u) && Number(m.time || 0) > seen && Number(m.time || 0) < nowSec - GRACE_SEC);
      if (!missed.length) continue;
      const texts = missed.map((m) => textOfMessage(m.message)).filter((t) => t && String(t).trim());
      if (!texts.length) continue;
      const latestTime = Math.max(...missed.map((m) => Number(m.time || 0)));
      saveSeenMsg(u, latestTime);
      log("info", `补回漏消息 u=${u}: ${texts.length} 条`);
      enqueuePrivateChat(u, texts.join("\n"), [], false, latestTime);
    } catch (e) { log("warn", "补消息检查失败 u=" + u + ": " + e.message.slice(0, 120)); }
  }
}

/* ---------------- 短期记忆 + 记忆固化 + 消息时间戳 ---------------- */
const SHORT_MEM_DIR = path.join(DATA_DIR, "short-memory");
const SHORT_MEM_TTL_SEC = 7 * 86400;
const MSG_TIMES_FILE = path.join(DATA_DIR, "msg-times.json");
function shortMemFile(userId) { return path.join(SHORT_MEM_DIR, String(userId) + ".json"); }
function loadShortMemories(userId) {
  try { const d = JSON.parse(fs.readFileSync(shortMemFile(userId), "utf8")); if (Array.isArray(d.items)) return d.items.filter((i) => i && i.content); } catch (e) {}
  return [];
}
function saveShortMemories(userId, items) {
  try { fs.mkdirSync(SHORT_MEM_DIR, { recursive: true }); fs.writeFileSync(shortMemFile(userId), JSON.stringify({ updated: Date.now(), items })); }
  catch (e) { log("warn", "短期记忆保存失败: " + e.message.slice(0, 160)); }
}
function pruneShortMemories(userId) {
  const items = loadShortMemories(userId);
  const nowSec = Date.now() / 1000;
  const fresh = items.filter((m) => nowSec - (Number(m.created) || nowSec) < SHORT_MEM_TTL_SEC);
  if (fresh.length !== items.length) saveShortMemories(userId, fresh);
  return fresh;
}
function loadMsgTimes() { try { return JSON.parse(fs.readFileSync(MSG_TIMES_FILE, "utf8")); } catch (e) { return {}; } }
function saveMsgTime(userId, ts) { const s = loadMsgTimes(); s[String(userId)] = ts; try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(MSG_TIMES_FILE, JSON.stringify(s)); } catch (e) {} }
/* 记忆固化已迁移到插件 memory（timer 钩子） */

/* ---------------- 定时提醒 + 每日复盘 + 生日 ---------------- */
const REMINDER_FILE = path.join(DATA_DIR, "reminders.json");
const BIRTHDAY_FILE = path.join(DATA_DIR, "birthdays.json");
function loadJson(f, def) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return def; } }
function saveJson(f, v) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); } catch (e) {} }
/* 提醒/生日数据已随插件迁移 */
function todayMMDD() { const n = new Date(); return `${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; }
/* parseReminder/parseBirthday/checkReminders/checkBirthdays 已迁移到插件 */

/* ---------------- 群友区分 ---------------- */
/* ---------------- 目标系统 ---------------- */
const GOALS_FILE = path.join(DATA_DIR, "goals.json");
const DEEP_STATE_FILE = path.join(DATA_DIR, "deep-state.json");
/* loadGoals/saveGoals 已迁移到插件 goals */
function goalsCtx() { try { const f = host && host.apis.get("goals"); return f ? f.goalsCtx() : ""; } catch (e) { return ""; } }
/* goalPlanDaily 已迁移到插件 goals */

/* ---------------- 多智能体会诊 ---------------- */
function shouldDeepThink(text) {
  if (isBudgetExhausted()) return false;
  const t = String(text || "").trim();
  if (t.length < 60) return false;
  if (!/[？?]/.test(t)) return false;
  const st = loadJson(DEEP_STATE_FILE, { date: "", count: 0 });
  const today = dayStr(0);
  if (st.date !== today) { st.date = today; st.count = 0; }
  if (st.count >= 5) return false;
  st.count++;
  saveJson(DEEP_STATE_FILE, st);
  return true;
}
async function multiAgentReply(userText, settings, persona, call, memories, shortMemories, taskCtx, userId) {
  const views = [];
  for (const p of ["感性温柔", "理性务实"]) {
    const msgs = [...coreContextMessages(userId, { memory: false }), { role: "system", content: `你是 Momo（大肥鱼桌宠）的「${p}」视角分身。基于她的人设，就主人下面的问题给出你的看法：自然口语、2~4 句、不带括号动作、用 Momo 的统一口吻。` }];
    if (memories && memories.length) msgs.push({ role: "system", content: memoryPrompt(retrieveMemories(memories, userText, 6), call) });
    if (shortMemories && shortMemories.length) msgs.push({ role: "system", content: shortMemoryPrompt(retrieveMemories(shortMemories, userText, 4), call) });
    if (taskCtx) msgs.push({ role: "system", content: taskCtx });
    msgs.push({ role: "user", content: String(userText).slice(0, 400) });
    try {
      const v = await completeOnce(msgs, settings, 200, 0.8);
      const t = String(v || "").trim();
      if (t) views.push({ p, t: t.slice(0, 150) });
    } catch (e) {}
  }
  if (views.length < 2) return null;
  const synth = [{ role: "system", content: `你是 Momo（大肥鱼桌宠）。下面是你的两个「自我视角」对主人问题的看法：\n${views.map((x) => `【${x.p}】${x.t}`).join("\n")}\n请融合成一条给主人的最终回复：自然可爱、口语化、2~4 句、不带括号动作。不要提"视角/分身"这些字眼。` }, { role: "user", content: String(userText).slice(0, 200) }];
  try {
    const raw = await completeOnce(synth, settings, 300, 0.8);
    const t = String(raw || "").trim();
    if (t) log("info", `多视角会诊: ${views.map((x) => x.p).join("+")} → ${t.slice(0, 40)}`);
    return t;
  } catch (e) { return null; }
}

/* 电脑助手（截图/找文件/开软件/系统信息/发文件）已迁移为插件 pc-tools */
/* ---------------- 表情包（逻辑已迁移到插件 stickers，以下为代理） ---------------- */
function stickerPrompt() { try { const a = host && host.apis.get("stickers"); return a ? a.stickerPrompt() : ""; } catch (e) { return ""; } }
function parseStickerMarkers(text) { try { const a = host && host.apis.get("stickers"); return a ? a.parseStickerMarkers(text) : { cleanText: String(text || ""), indices: [] }; } catch (e) { return { cleanText: String(text || ""), indices: [] }; } }
function pickStickerByEmotion(name) { try { const a = host && host.apis.get("stickers"); return a ? a.pickStickerByEmotion(name) : null; } catch (e) { return null; } }
/* 智能挑选：结合上下文让模型从候选里选最贴切的一张（失败自动退回随机） */
async function pickStickerSmart(name, contextText, opts) {
  try { const a = host && host.apis.get("stickers"); return a ? await a.pickStickerSmart(name, contextText, opts) : null; }
  catch (e) { return pickStickerByEmotion(name); }
}
/* ---------------- 最近发出的表情包（「这张」指代 + 下一轮注入余韵） ---------------- */
const lastSentSticker = new Map();   // sessionKey -> {fname, publicId, desc, risk, allowProactive, ts}
const STICKER_REF_TTL_MS = 10 * 60000;
function stickerSessionKey(userId, groupId) {
  return groupId ? ("g" + groupId + "_" + userId) : ("u:" + userId);
}
function noteStickerSent(sessionKey, sticker) {
  if (!sessionKey || !sticker || !sticker.fname) return;
  lastSentSticker.set(sessionKey, {
    fname: sticker.fname,
    publicId: sticker.publicId || "",
    desc: String(sticker.label || sticker.desc || "").slice(0, 60),
    meaning: String(sticker.meaning || "").slice(0, 80),
    usage: String(sticker.usage || "").slice(0, 60),
    risk: sticker.risk || "low",
    allowProactive: !!sticker.allowProactive,
    ts: Date.now(),
  });
  try { const a = host && host.apis.get("stickers"); if (a && a.recordSent) a.recordSent(sticker, sessionKey); } catch (e) {}
  try { recordAction({ action: "sticker_sent", target: sticker.fname, by: null, publicId: sticker.publicId || "" }); } catch (e) {}
}
function getLastSentSticker(sessionKey) {
  const e = lastSentSticker.get(sessionKey);
  if (!e) return null;
  if (Date.now() - e.ts > STICKER_REF_TTL_MS) { lastSentSticker.delete(sessionKey); return null; }
  return e;
}
function stickerRefCtx(sessionKey) {
  const e = getLastSentSticker(sessionKey);
  if (!e) return "";
  const _m = e.meaning ? `这张图的含义是「${e.meaning}」${e.usage ? "，适合：" + e.usage : ""}。` : "";
  return `【刚才发的表情包】你上一条发的是「${e.desc}」（编号 ${e.publicId || e.fname}）。${_m}对方说「这张 / 这个」时默认指它；要教它什么意思就直接用编号说。`;
}
function bumpStickerUsed(sticker) {
  try { const a = host && host.apis.get("stickers"); if (a && a.bumpMeta && sticker && sticker.fname) a.bumpMeta(sticker.fname, "used"); } catch (e) {}
}
function maybeCollect(buf, desc) { try { const a = host && host.apis.get("stickers"); return a ? a.maybeCollect(buf, desc) : null; } catch (e) { return null; } }
function generateStickerImage(prompt, outName) { try { const a = host && host.apis.get("stickers"); if (a) return a.generateStickerImage(prompt, outName); } catch (e) {} throw new Error("表情包插件未加载"); }
function listStickers() { try { const a = host && host.apis.get("stickers"); return a ? a.listStickers() : []; } catch (e) { return []; } }
async function sendStickerImage(userId, sticker, channel, groupId) {
  const seg = [{ type: "image", data: { file: "file:///" + sticker.file.replace(/\\/g, "/") } }];
  if (channel === "group" && groupId) {
    await onebotSend("send_msg", { message_type: "group", group_id: Number(groupId), message: seg });
  } else {
    await onebotSend("send_msg", { message_type: "private", user_id: Number(userId), message: seg });
  }
  bumpStickerUsed(sticker);
}
/* ---------------- 进化层技能规则解释器（数据驱动，规则来自 self/skills.json，基础层只管执行） ---------------- */
function pickStickerByIds(ids) { try { const a = host && host.apis.get("stickers"); return a ? a.pickStickerByIds(ids) : null; } catch (e) { return null; } }
function matchSkillRule(text, userId) { try { const a = host && host.apis.get("evolution"); return a ? a.matchSkillRule(text, userId) : null; } catch (e) { return null; } }
async function runSkillRule(rule, userId, call) { const a = host && host.apis.get("evolution"); if (a) await a.runSkillRule(rule, userId, call); }

/* 进化层逻辑已迁移到特权插件 evolution，以下为代理 */
async function extractSelfIdentity(userText, replyText, settings, userId) { try { const a = host && host.apis.get("evolution"); if (a) await a.extractSelfIdentity(userText, replyText, settings, userId); } catch (e) {} }
async function selfScoreReply(userText, replyText, settings) { try { const a = host && host.apis.get("evolution"); if (a) await a.selfScoreReply(userText, replyText, settings); } catch (e) {} }
async function tunePrefFromScore(st) { try { const a = host && host.apis.get("evolution"); if (a) await a.tunePrefFromScore(st); } catch (e) {} }
async function selfReflection(settings) { try { const a = host && host.apis.get("evolution"); if (a) await a.selfReflection(settings); } catch (e) {} }
async function exploreFun(query, settings) { try { const a = host && host.apis.get("evolution"); if (a) await a.exploreFun(query, settings); } catch (e) {} }
async function evolveExplore(settings) { try { const a = host && host.apis.get("evolution"); if (a) await a.evolveExplore(settings); } catch (e) {} }
function loadProposals() { try { const a = host && host.apis.get("evolution"); return a ? a.loadProposals() : []; } catch (e) { return []; } }


/* ---------------- 回复拆条 ---------------- */
function hardChunk(text, cap) {
  const out = [];
  for (let i = 0; i < text.length; i += cap) out.push(text.slice(i, i + cap));
  return out;
}
function splitReply(text, hardCap) {
  // 按整句拆：句末标点断句，不设短字数上限；仅单句超长时在逗号/顿号处断
  // 引号/括号内部的分隔符不参与断句，避免把引语切坏
  const cap = hardCap || 150;
  const out = [];
  const paras = String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  for (const p of paras) {
    const sentences = splitSafe(p, "。！？!?…~；;");
    for (let s of sentences) {
      if (s.length <= cap) { out.push(s); continue; }
      const pieces = splitSafe(s, "，、,");
      let cur = "";
      for (const c of pieces) {
        if ((cur + c).length > cap) { if (cur) out.push(cur); cur = c; }
        else cur += c;
      }
      if (cur) out.push(cur);
    }
  }
  return out.filter(Boolean);
}
function splitSafe(text, delims) {
  // 在分隔符处拆分，但跳过成对引号/括号内部的分隔符（保持引语/括号内容完整）
  const openPairs = { "「": "」", "“": "”", "\"": "\"", "'": "'", "‘": "’", "（": "）", "(": ")", "【": "】", "《": "》" };
  const closeToOpen = {};
  for (const o of Object.keys(openPairs)) closeToOpen[openPairs[o]] = o;
  const stack = [];
  const out = [];
  let cur = "";
  for (const ch of Array.from(String(text))) {
    cur += ch;
    if (closeToOpen[ch] !== undefined && stack.length && stack[stack.length - 1] === closeToOpen[ch]) {
      stack.pop();
    } else if (openPairs[ch] !== undefined) {
      stack.push(ch);
    } else if (delims.indexOf(ch) >= 0 && stack.length === 0) {
      out.push(cur.trim()); cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/* ---------------- OneBot 发送 ---------------- */
let ws = null, sendSeq = 1, reconnectTimer = null;
function onebotSend(action, params) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("ws 未连接"));
  return new Promise((resolve, reject) => {
    const echo = String(++sendSeq);
    const timer = setTimeout(() => reject(new Error("发送超时")), 15000);
    const handler = (ev) => {
      try {
        const obj = JSON.parse(ev.data);
        if (obj.echo === echo) { clearTimeout(timer); ws.removeEventListener("message", handler); if (obj.status === "failed") reject(new Error("OneBot 返回失败")); else resolve(obj); }
      } catch (e) {}
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ action, params, echo }));
  });
}
async function sendPrivate(userId, text) {
  logJsonl("replies.jsonl", { userId, text: String(text || "").slice(0, 2000) });
  const qq = cfg.qq || {};
  const split = !!qq.split_reply;
  const gapMs = evolvePref("reply_gap_ms", qq.reply_gap_ms || 1200);
  const hardCap = evolvePref("reply_chunk_chars", qq.reply_chunk_chars || 1800);
  const segs = split ? splitReply(text, evolvePref("split_cap", 150)) : hardChunk(text, hardCap);
  for (const seg of segs) {
    await onebotSend("send_msg", { message_type: "private", user_id: Number(userId), message: seg });
    await sleep(split ? gapMs : 300);
  }
}

/* ---------------- 消息处理 ---------------- */
const busyUsers = new Set(); const lastReplyAt = new Map();
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const FACE_MAP = {
  0:"惊讶",1:"撇嘴",2:"色",3:"发呆",4:"得意",5:"流泪",6:"害羞",7:"闭嘴",8:"睡",9:"大哭",10:"尴尬",
  11:"发怒",12:"调皮",13:"呲牙",14:"微笑",15:"难过",16:"酷",18:"抓狂",19:"吐",20:"偷笑",21:"可爱",
  22:"白眼",23:"傲慢",24:"饥饿",25:"困",26:"惊恐",27:"流汗",28:"憨笑",29:"悠闲",30:"奋斗",31:"咒骂",
  32:"疑问",33:"嘘",34:"晕",35:"折磨",36:"衰",37:"骷髅",38:"敲打",39:"再见",40:"擦汗",41:"抠鼻",
  42:"鼓掌",43:"糗大了",44:"坏笑",45:"左哼哼",46:"右哼哼",47:"哈欠",48:"鄙视",49:"委屈",50:"快哭了",
  51:"阴险",52:"亲亲",53:"吓",54:"可怜",55:"菜刀",56:"西瓜",57:"啤酒",58:"篮球",59:"乒乓",60:"咖啡",
  61:"饭",62:"猪头",63:"玫瑰",64:"凋谢",65:"示爱",66:"爱心",67:"心碎",68:"蛋糕",69:"闪电",70:"炸弹",
  71:"刀",72:"足球",73:"瓢虫",74:"便便",75:"月亮",76:"太阳",77:"礼物",78:"拥抱",79:"强",80:"弱",
  81:"握手",82:"胜利",83:"抱拳",84:"勾引",85:"拳头",86:"差劲",87:"爱你",88:"NO",89:"OK",90:"爱情",
  91:"飞吻",92:"跳跳",93:"发抖",94:"怄火",95:"转圈",96:"磕头",97:"回头",98:"跳绳",99:"挥手",100:"激动",
  101:"街舞",102:"献吻",103:"左太极",104:"右太极",105:"红唇",106:"艳唇",107:"晚安",108:"握手",109:"伤心",110:"开心"
};
function parseMessage(msg) {
  if (typeof msg === "string") return { text: msg.trim(), images: [], hasFace: false, faces: [], records: [], ats: [] };
  if (!Array.isArray(msg)) return { text: "", images: [], hasFace: false, faces: [], records: [], ats: [] };
  let text = "", hasFace = false;
  const images = [], faces = [], records = [], ats = [];
  for (const s of msg) {
    if (!s || typeof s !== "object") continue;
    if (s.type === "text") text += (s.data && s.data.text) || "";
    else if (s.type === "at") { ats.push(String((s.data && s.data.qq) || "")); text += "[@]"; }
    else if (s.type === "face") {
      hasFace = true;
      const fid = s.data && s.data.id;
      const meaning = FACE_MAP[String(fid)] || FACE_MAP[fid];
      if (meaning) faces.push(meaning);
    }
    else if (s.type === "image") images.push({ file: (s.data && s.data.file) || "", url: (s.data && s.data.url) || "" });
    else if (s.type === "record") records.push({ file: (s.data && s.data.file) || "", url: (s.data && s.data.url) || "" });
  }
  return { text: text.trim(), images, hasFace, faces, records, ats };
}
function textOfMessage(msg) { return parseMessage(msg).text; }
async function transcribeRecords(messageId, records) { try { const a = host && host.apis.get("voice"); return a ? await a.transcribeRecords(messageId, records) : ""; } catch (e) { return ""; } }

/* ---------------- 图片识别（视觉） ---------------- */


async function handlePrivateMessage(event) {
  const userId = Number(event.user_id), selfId = Number(event.self_id);
  if (userId === selfId) return;
  const _allowed = (cfg.qq && cfg.qq.allowed_users) || [];
  const _rolesApi = host && host.apis.get("roles");
  const _role = _rolesApi
    ? _rolesApi.resolveRole(userId)
    : (_allowed.includes(userId) || isMaster(userId) ? "user" : "ignored");
  if (_role === "ignored") { log("info", `忽略非白名单用户 ${userId}`); return; }
  if (_role === "visitor" && _rolesApi && !_rolesApi.rateOk(userId)) { log("info", `访客限速，忽略 ${userId}`); return; }
  if (host && host.hookLists.private_message.length) {
    for (const fn of host.hookLists.private_message) {
      try { if (fn(host.ctx, { userId, event, raw: String(event.raw_message || "") }) === true) return; } catch (e) { log("warn", "插件私聊钩子失败: " + e.message.slice(0, 120)); }
    }
  }
  if (!isMaster(userId) && isMuted(userId)) return;
  const parsed = parseMessage(event.message);
  let text = parsed.text;
  if (parsed.faces.length) {
    const fe = parsed.faces.join("、");
    text = text ? `${text}（对方发了表情：${fe}）` : `[对方发了表情：${fe}]`;
  }
  if (parsed.records.length) {
    const vt = await transcribeRecords(event.message_id, parsed.records);
    if (vt) text = text ? text + "\n" + vt : `[语音消息] ${vt}`;
    else text = text || "[对方发了一条语音，但我没听清]";
  }
  if (!text && !parsed.images.length) {
    text = String(event.raw_message || "").trim();
    if (!text) return;
  }
  log("info", `收到私聊 ${userId}，文本 ${text.length} 字，图片 ${parsed.images.length} 张`);
  logJsonl("messages.jsonl", { userId, channel: "private", text: String(text || "").slice(0, 500), images: parsed.images.length });
  lastInteractionTs = Date.now();
  lastActiveAt.set(userId, Date.now());
  saveProactiveState();
  
  const msgTime = Number(event.time) || Math.floor(Date.now() / 1000);
  const master = isMaster(userId);
  const call = resolveCall(userId);
  let voiceRequested = wantsVoice(text);
  if (voiceRequested) warmVoice();
  if (text === "/语音" || text.startsWith("/语音 ")) {
    text = text.replace(/^\/语音\s*/, "").trim() || "想听我用语音说点什么呀？";
    voiceRequested = true;
  }
  /* 文件发送确认已迁移到插件 pc-tools 私聊钩子 */
  const _prefCmd = text.replace(/^\//, "").trim();
  if (["别打扰", "安静", "别吵", "别烦我", "别找我"].includes(_prefCmd)) {
    setProactivePref(userId, "off"); 
    return sendPrivate(userId, "好，我以后不主动找你啦～你想我的时候随时发消息，我都在的。");
  }
  if (["少点主动", "降低频率", "少点聊", "安静点", "少主动"].includes(_prefCmd)) {
    setProactivePref(userId, "low"); 
    return sendPrivate(userId, "好哦，我会少主动找你的～");
  }
  if (["正常", "恢复正常", "正常频率"].includes(_prefCmd)) {
    setProactivePref(userId, "normal"); 
    return sendPrivate(userId, "好，恢复正常主动频率啦～");
  }
  if (["多陪我", "多聊", "频繁点", "多主动", "多找我"].includes(_prefCmd)) {
    setProactivePref(userId, "high"); 
    return sendPrivate(userId, "好呀，我会更常主动找你的～");
  }
  if (text === "/开评论" || text === "/开启评论") { setQzoneComment(userId, true);  return sendPrivate(userId, "好，以后你发新说说我会自动评论～（想关就说 /关评论）"); }
  if (text === "/关评论" || text === "/关闭评论") { setQzoneComment(userId, false);  return sendPrivate(userId, "好，我不再自动评论你的空间啦～"); }
  if (text === "/看空间" || text.startsWith("/看空间 ") || text === "/看看空间") {
    
    const arg = text.replace(/^\/(看空间|看看空间)\s*/, "").trim();
    let target = userId;
    if (arg && /^\d{5,12}$/.test(arg)) { if (!master) return sendPrivate(userId, "只有主人能看别人的空间哦～"); target = Number(arg); }
    try {
      const { list } = await checkUserSpace(target);
      if (!list.length) return sendPrivate(userId, "这个空间还没有说说哦～");
      const top = list.slice(0, 5).map((m, i) => `${i + 1}. ${String(m.content || "").slice(0, 50)}（${m.comment_num} 评论）`).join("\n");
      return sendPrivate(userId, `空间最近说说：\n${top}`);
    } catch (e) { return sendPrivate(userId, "查看空间失败：" + e.message.slice(0, 120)); }
  }
  if (text === "/评论" || text.startsWith("/评论 ")) {
    
    const arg = text.replace(/^\/(评论)\s*/, "").trim();
    const n = /^\d+$/.test(arg) ? parseInt(arg, 10) : 1;
    try {
      const { list } = await checkUserSpace(userId);
      if (!list.length) return sendPrivate(userId, "你的空间还没有说说哦～");
      const idx = (n >= 1 && n <= list.length) ? n - 1 : 0;
      const settings = resolveChatSettings();
      const c = await generateQzoneComment(list[idx].content, settings);
      if (!c) return sendPrivate(userId, "我一时想不出评论啦～");
      await commentQzone(list[idx].tid, c, userId);
      return sendPrivate(userId, `已评论第 ${idx + 1} 条：${c}`);
    } catch (e) { return sendPrivate(userId, "评论失败：" + e.message.slice(0, 120)); }
  }
  if (host && host.commandRegistry.size) {
    for (const [key, c] of host.commandRegistry) {
      try {
        if (c.regex && c.regex.test(text)) {
          if (!cmdAllowed(userId, key)) { await sendPrivate(userId, "（这个只有主人能用哦～）"); return; }
          const r = await c.handler({ userId, text, master, call });
          if (r != null) await sendPrivate(userId, String(r));
          return;
        }
      } catch (e) { log("warn", `插件命令 ${key} 失败: ${e.message.slice(0, 120)}`); }
    }
  }
  if (text === "/help" || text === "帮助") {
    
    const cmds = master
      ? "/重置 清空聊天记忆\n/记忆 看我记住了你什么\n/忘记 <词> 删记忆\n/清空记忆 全部忘记\n/称呼 <QQ> <称呼> 给别人定称呼\n/状态 查看配置\n/进化 手动探索一次\n/进化提案 查看待处理大改动"
      : "/叫我 <称呼> 让我这样称呼你（不能叫主人）\n/称呼 看我当前怎么称呼你\n/重置 清空我们的聊天";
    return sendPrivate(userId, `你好呀${master ? "主人" : ""}～我是大肥鱼！\n可以直接和我聊天，问天气、查资讯都能联网搜哦\n${cmds}${master ? "\n\n小技巧：在桌宠聊天里发「发QQ：内容」，我就能把话发到你的QQ上～" : ""}`);
  }
  if (text === "/reset" || text === "/重置") { saveSession(userId, []);  return sendPrivate(userId, "好哦，聊天记忆已清空～"); }
  /* /叫我 /称呼 已迁移为插件 appellations */
  /* 屏蔽/解除已迁移为 Agent 工具 mute_user / unmute_user */
  /* 记一下 已迁移为 Agent 工具 add_wish */
  if (text === "/status" || text === "/状态") {
    
    const mv = getMood();
    const fv = getFavor(userId);
    const pPref = getProactivePref(userId);
    const pInt = proactiveIntervalMs(userId);
    const pText = !isFinite(pInt) ? "不主动" : `${Math.round(pInt / 60000)} 分钟`;
    const prefLine = `主动聊天偏好：${pPref}（间隔约 ${pText}）`;
    if (!master) {
      return sendPrivate(userId, `我现在称呼你为「${call}」\n对你的好感度：${Math.round(fv)}/100\n${prefLine}`);
    }
    const s = resolveChatSettings();
    const ws = (cfg.chat && cfg.chat.web_search && cfg.chat.web_search.enabled) ? "开启（" + ((cfg.chat.web_search.engine || "baidu") === "bocha" ? "博查" : "百度") + "）" : "关闭";
    const keyState = apiKey ? `已连接（Key 长度 ${apiKey.length}）` : "未配置 API Key";
    const pr = (cfg.proactive && cfg.proactive.enabled) ? `开启（沉默${cfg.proactive.silence_minutes || 120}分 + ${cfg.proactive.morning_greet || "08:00"}/${cfg.proactive.night_greet || "23:00"}）` : "关闭";
    return sendPrivate(userId, `角色：大肥鱼（女仆）\n模型：${s.model}\n联网搜索：${ws}\n主动搭话：${pr}\n当前情绪：${moodLabel()}\n对${call}的好感度：${Math.round(fv)}/100\n${prefLine}\n${budgetLine()}\n密钥：${keyState}`);
  }
  if (text === "/token" || text === "/用量" || text === "/token用量" || text === "/查询token") {
    
    return sendPrivate(userId, usageLine());
  }
  if (text === "/记忆" || text === "/memory") {
    if (!master) {  return sendPrivate(userId, "记忆管理只有主人能做哦～"); }
    
    const items = loadMemories(userId);
    if (!items.length) return sendPrivate(userId, "我还没记住什么关于主人的事呢～多和我聊聊吧！");
    const list = items.slice(-30).map((m, i) => `${i + 1}. ${m.content}`).join("\n");
    return sendPrivate(userId, `我记住的关于主人的事（共 ${items.length} 条，显示最近 30 条）：\n${list}`);
  }
  if (text.startsWith("/忘记") || text.startsWith("/forget")) {
    if (!master) {  return sendPrivate(userId, "记忆管理只有主人能做哦～"); }
    const kw = text.replace(/^\/(忘记|forget)\s*/i, "").trim();
    if (!kw) {  return sendPrivate(userId, "用法：/忘记 <关键词>，会删除所有包含该关键词的记忆。"); }
    const items = loadMemories(userId);
    const kept = items.filter((m) => !m.content.includes(kw));
    saveMemories(userId, kept);
    
    return sendPrivate(userId, `已忘记 ${items.length - kept.length} 条包含「${kw}」的记忆～`);
  }
  if (text === "/清空记忆" || text === "/clearmem" || text === "/清空記憶") {
    if (!master) {  return sendPrivate(userId, "记忆管理只有主人能做哦～"); }
    saveMemories(userId, []);
    
    return sendPrivate(userId, "好哦主人，关于你的记忆我已全部清空～");
  }
  if (text === "/余额" || text === "/查余额" || text === "/balance") {
    
    const b = await fetchBalance();
    if (!b) return sendPrivate(userId, "余额查询失败啦，稍后再试～");
    return sendPrivate(userId, `账户余额：¥${b.total}\n（充值 ¥${b.topped} / 赠送 ¥${b.granted}）`);
  }
  if (text === "/截图" || text === "/截屏" || text === "/看看屏幕") {
    if (!master) {  return sendPrivate(userId, "只有主人能让我截图哦～"); }
    
    const fp = await captureScreen();
    if (!fp) {  return sendPrivate(userId, "截图失败啦，稍后再试～"); }
    await onebotSend("send_msg", { message_type: "private", user_id: Number(userId), message: [{ type: "image", data: { file: "file:///" + fp.replace(/\\/g, "/") } }] });
    
    return sendPrivate(userId, "喏，这就是你的屏幕～");
  }
  /* /目标 已迁移为插件 goals */
  /* 我的目标是 已迁移为 Agent 工具 set_goal */
  /* X分钟后提醒我 已迁移为 Agent 工具 set_reminder */
  /* /提醒 已迁移为插件 reminders */
  /* 我的生日是 已迁移为 Agent 工具 set_birthday */
  /* /生日 已迁移为插件 birthdays */
  /* /做表情包 已迁移为插件 stickers */
  /* /进化 /进化提案 已迁移为插件 evolution 命令 */
  // 进化层技能规则：确定性路由，立即响应（不防抖、无需 API Key）
  const skillRule = matchSkillRule(text, userId);
  if (skillRule) {
    lastReplyAt.set(userId, Date.now());
    try {
      await runSkillRule(skillRule, userId, call);
    } catch (e) {
      log("error", `技能规则失败 rule=${skillRule.id} user=${userId}: ${e.message.slice(0, 200)}`);
      
      sendPrivate(userId, "呜…刚才手滑了：" + String(e.message).slice(0, 100)).catch(() => {});
    }
    /* 技能规则也算"处理过了"：不标记已读的话，补回漏消息会把它当成漏消息重放，导致回两遍 */
    saveSeenMsg(userId, msgTime);
    if (msgTime) saveMsgTime(userId, msgTime);
    return;
  }
  if (!apiKey) {  return sendPrivate(userId, "呜…还没配置 DeepSeek API Key，我先开不了口啦。"); }
  // 闲聊：防抖合并（等用户说完再一起回）
  enqueuePrivateChat(userId, text, parsed.images, voiceRequested, msgTime);
}

/* ---------------- 闲聊防抖合并 ---------------- */
const DEBOUNCE_MS = 20000;   // 最后一条消息后等 20 秒（可在 QQ 上调 qq.debounce_ms）
const MAX_WAIT_MS = 40000;   // 连发时最多等 40 秒（qq.max_wait_ms）
const pendingChat = new Map();
function enqueuePrivateChat(userId, text, images, voiceRequested, msgTime) {
  let p = pendingChat.get(userId);
  if (!p) { p = { texts: [], images: [], voice: false, firstTs: Date.now(), timer: null, msgTime: 0 }; pendingChat.set(userId, p); }
  p.texts.push(text);
  if (images && images.length) p.images = p.images.concat(images);
  if (voiceRequested) p.voice = true;
  if (msgTime) p.msgTime = msgTime;
  if (p.timer) clearTimeout(p.timer);
  const elapsed = Date.now() - p.firstTs;
  const debounce = qqSettingNum("qq.debounce_ms", DEBOUNCE_MS);
  const maxWait = qqSettingNum("qq.max_wait_ms", MAX_WAIT_MS);
  const delay = Math.min(debounce, Math.max(0, maxWait - elapsed));
  p.timer = setTimeout(() => firePrivateChat(userId), delay);
  
}
function firePrivateChat(userId) {
  const p = pendingChat.get(userId);
  if (!p) return;
  if (busyUsers.has(userId)) { p.timer = setTimeout(() => firePrivateChat(userId), 500); return; }
  pendingChat.delete(userId);
  const texts = p.texts;
  if (!texts.length) return;
  const combined = texts.length > 1
    ? texts.map((t, i) => `${i + 1}. ${t}`).join("\n") + "\n（以上是对方连续发的几条消息，请当作同一段话一起回应）"
    : texts[0];
  processPrivateChat(userId, combined, p.images, p.voice, p.msgTime);
}

async function processPrivateChat(userId, text, images, voiceRequested, msgTime) {
  const master = isMaster(userId);
  const call = resolveCall(userId);
  applyStatusRule(userId, text);
  const cooldown = ((cfg.qq && cfg.qq.cooldown_seconds) || 1.5) * 1000;
  const last = lastReplyAt.get(userId) || 0;
  if (Date.now() - last < cooldown) return;
  const lastMsgT = (loadMsgTimes())[String(userId)] || 0;
  const gapMs = (lastMsgT && msgTime) ? (msgTime - lastMsgT) * 1000 : 0;
  if (gapMs > 60000) log("info", `时间差 user=${userId}: ${formatGap(gapMs)}`);
  const origText = text;
  busyUsers.add(userId); lastReplyAt.set(userId, Date.now());
  try {
    
    const settings = resolveChatSettings();
    const budgetOut = isBudgetExhausted();
    if (budgetOut) {
      settings.max_tokens = 200;
      if (master) {
        const b = loadBudget();
        if (!b.exhausted_notified) { b.exhausted_notified = true; saveBudget(b); sendPrivate(userId, "主人，今天的生活费花完啦～我先切极简模式陪你（短回复），联网/探索/反思先停啦，明天满血复活！").catch(() => {}); }
      }
    }
    const history = loadSession(userId);
    const memories = loadMemories(userId);
    const shortMemories = pruneShortMemories(userId);
    const persona = userPersona(userId, settings);
    let taskCtx = "";
    const pcApi = host && host.apis.get("pcTools");
    if (master && !budgetOut && pcApi) {
      const _fq = pcApi.extractFileQuery(text);
      if (_fq) {
        try {
          const fr = pcApi.findFiles(_fq, "");
          if (fr && fr.ok) { taskCtx = "【文件查找结果】" + fr.msg; log("info", `确定性文件查找「${_fq}」: ${String(fr.msg).slice(0, 80)}`); }
        } catch (e) { log("warn", "确定性文件查找失败: " + e.message.slice(0, 120)); }
      }
      try {
        const taskResults = await pcApi.runTasks(text, settings, userId);
        if (taskResults.length) {
          taskCtx = "【电脑操作结果】\n" + taskResults.map((t) => `- ${t.tool}：${t.msg}`).join("\n");
          if (taskResults.some((t) => t.pending)) taskCtx += "\n（文件待主人确认发送，请用自然语言询问主人是否发送，不要自行重复操作）";
        }
      } catch (e) { log("warn", "电脑任务失败: " + e.message.slice(0, 160)); }
    }
    if (master) {
      try {
        const _b = loadBudget();
        const _bc = budgetCfg();
        const _lab = { chat: "聊天", reason: "思考", search: "搜索", vision: "看图" };
        const _detail = Object.entries(_b.spend_by || {}).filter(([, v]) => v > 0).map(([k, v]) => `${_lab[k] || k} ¥${v.toFixed(3)}`).join("、") || "暂无";
        const _calls = Object.entries(_b.calls || {}).map(([k, v]) => `${_lab[k] || k} ${v}次`).join("、") || "无";
        const _pct = Math.round((_b.spent_cny || 0) / _bc.daily_cny * 100);
        const _n = (k) => Number((_b.calls && _b.calls[k]) || 0);
        const _facts = `【今日已发生（事实）】联网搜索 ${_n("search")} 次、聊天 ${_n("chat")} 次、思考 ${_n("reason")} 次、看图 ${_n("vision")} 次；花费 ¥${(_b.spent_cny || 0).toFixed(3)} / 日预算 ¥${_bc.daily_cny}（${_pct}%），明细：${_detail}。`;
        const _limit = budgetOut
          ? `【当前限制】预算已用完 → 从现在起联网搜索/进化/看图停用；查账、记忆、待办、提醒仍可用。`
          : `【当前限制】无（预算充足，功能全部可用）。`;
        taskCtx = (taskCtx ? taskCtx + "\n" : "") + _facts + "\n" + _limit;
      } catch (e) {}
    }
    if (images && images.length && !budgetOut) {
      const descs = [];
      if (!canDo(userId, "vision")) {
        text = text ? text + "\n【图片内容】（对方发了图片，但看图的权限只有主人有）" : "[对方发了一张图片]";
      } else {
        for (const img of images.slice(0, 3)) {
          log("info", "图片字段 file=" + String(img.file || "").slice(0, 100) + " url=" + String(img.url || "").slice(0, 160));
          /* 收图先反查表情包库：是库里的图就直接用标注，省一次视觉调用 */
          let _known = null;
          try {
            const _stk = host && host.apis.get("stickers");
            if (_stk && _stk.findByHash) {
              const _buf = await host.apis.get("vision").imageBytes(img);
              _known = _stk.findByHash(_buf);
            }
          } catch (e) {}
          if (_known && _known.meaning) { descs.push("[表情包] " + host.apis.get("stickers").meaningText(_known)); continue; }
          try { const d = await host.apis.get("vision").describeImage(img, settings); if (d) descs.push(d); } catch (e) { log("warn", "图片识别失败: " + e.message.slice(0, 120)); }
        }
        if (descs.length) text = text + (text ? "\n" : "") + "【图片内容】" + descs.join("；");
        else if (!text) text = "[对方发了一张图片，但我暂时看不清]";
      }
    }
    let valence = 0;
    if (!budgetOut) {
      try {
        const e = await detectEmotion(text, settings, userId);
        if (e) {
          decayEmotion();
          const _blended = applyEmotionInertia(getEmotion(), e.emotion, e.intensity);
          if (e.emotion === "生气" && e.intensity >= 0.8) {
            emotion.cooling = 2;
          } else if ((emotion.cooling || 0) > 0) {
            const _ladder = [{ name: "委屈", intensity: 0.65 }, { name: "平静", intensity: 0.3 }];
            const _step = _ladder[Math.min(2 - emotion.cooling, 1)];
            emotion.cooling -= 1;
            _blended.name = _step.name;
            _blended.intensity = _step.intensity;
          }
          setEmotion(_blended.name, _blended.intensity);
          valence = (EMOTION_VAL[_blended.name] || 0) * _blended.intensity * 100;
        }
      } catch (e) { log("warn", "情绪判断跳过: " + e.message.slice(0, 160)); }
    }
    if (valence > 0) setMood(getMood() + valence * 0.5);
    else if (valence < 0) setMood(getMood() + valence * 0.6);
    updateFavor(userId, valence * 0.05);
    const timeCtx = timeAwarenessCtx(gapMs);
    taskCtx = taskCtx ? timeCtx + "\n" + taskCtx : timeCtx;
    const statusCtx = currentStatusCtx(userId);
    if (statusCtx) taskCtx = statusCtx + "\n" + taskCtx;
    const _lifeApi = host && host.apis.get("lifeLog");
    const _lifeCtx = _lifeApi ? _lifeApi.lifeCtx() : "";
    if (_lifeCtx) taskCtx = _lifeCtx + "\n" + taskCtx;
    const _wApi = host && host.apis.get("weather");
    if (_wApi) { try { const _wCtx = await _wApi.weatherCtx(); if (_wCtx) taskCtx = _wCtx + "\n" + taskCtx; } catch (e) {} }
    const _crossCtx = host.apis.get("groupInfo").crossWindowCtx(userId);
    if (_crossCtx) taskCtx = _crossCtx + "\n" + taskCtx;
    const _teachApi = host && host.apis.get("teach");
    const _teachCtx = _teachApi ? _teachApi.teachCtx(text) : "";
    if (_teachCtx) taskCtx = _teachCtx + "\n" + taskCtx;
    const spaceCtx = recentSpaceContext(userId);
    if (spaceCtx) taskCtx = taskCtx + "\n" + spaceCtx;
    const _grpCtx = userGroupContext(userId);
    if (_grpCtx) taskCtx = taskCtx + "\n" + _grpCtx;
    let agentRes = null;
    let rawReply = "";
    // 确定性沉默：用户只发了道别/简短应声，且上一轮我已收过尾 → 跳过，避免互道晚安死循环
    const _t = String(text).trim();
    const _last = history && history.length ? history[history.length - 1] : null;
    const _closingIn = /^(晚安|拜拜|再见|再见啦|早点睡|去睡啦|去睡吧|谢谢|谢谢你|好|嗯|哦|行|知道了|ok|OK|嗯嗯|哦哦)$/.test(_t);
    const _closingOut = _last && _last.role === "assistant" && /(晚安|拜拜|再见|不早了|早点睡|快去睡|去睡吧|好好休息)/.test(String(_last.content || ""));
    if (_closingIn && _closingOut) {
      log("info", `确定性沉默：道别收尾后不再回复（"${_t.slice(0, 20)}"）`);
      return;
    }
    if (shouldDeepThink(text)) {
      const _deep = await multiAgentReply(text, settings, persona, call, memories, shortMemories, taskCtx, userId);
      if (_deep) rawReply = _deep;
    }
    setActivity("在陪" + call + "聊天");
    if (!rawReply) {
      agentRes = await agentChatOnce(history, text, settings, memories, persona, call, userId, taskCtx, shortMemories);
      rawReply = agentRes && agentRes.reply;
    }
    if (!rawReply) throw new Error("模型未返回内容");
    const marked = parseStickerMarkers(rawReply);
    const reply = stripStageDirections(marked.cleanText) || marked.cleanText;
    if (/做不到|不能|不会|没有这个功能|不支持|办不到|做不了|没这个权限/.test(reply) && String(text).length >= 6) {
      addWish(text, "user-request-unmet");
    }
    history.push({ role: "user", content: text, ts: Date.now() }, { role: "assistant", content: reply, ts: Date.now() });
    await maybeRollSummary(userId, history, settings);
    saveSession(userId, trimHistory(history, settings.history_limit, settings.history_chars));
    /* 只发语音模式：本回合有语音要发时不再发文字（避免“文字+语音”两条） */
    const _voiceApi = host && host.apis.get("voice");
    const _pendingVoice = !!(_voiceApi && _voiceApi.hasPendingVoice && _voiceApi.hasPendingVoice(userId));
    const _voiceOnly = !!(_voiceApi && _voiceApi.voiceOnlyReply && _voiceApi.voiceOnlyReply() && (voiceRequested || _pendingVoice));
    if (_voiceOnly) log("info", `只发语音（文字已抑制）user=${userId}${_pendingVoice ? "（工具触发）" : "（关键词触发）"}`);
    else await sendPrivate(userId, reply);
    if (host) host.runHook("reply", { userId, text, reply, channel: "private" });
    saveSeenMsg(userId, Math.floor(Date.now() / 1000));
    if (msgTime) saveMsgTime(userId, msgTime);
    log("info", `表情包诊断: 列表=${listStickers().length}, 情绪=${getEmotion().name}/${typeof valence === "number" ? valence.toFixed(0) : "?"}`);
    const _agentStickers = (agentRes && agentRes.stickers) || [];
    const _stkKey = stickerSessionKey(userId, 0);
    if (_agentStickers.length) {
      for (const s of _agentStickers) {
        try { await sendStickerImage(userId, s); noteStickerSent(_stkKey, s); await sleep(500); } catch (e) { log("warn", "表情包发送失败: " + e.message.slice(0, 120)); }
      }
    } else {
      const emo = getEmotion();
      const autoChance = (() => { try { const v = (host && host.ctx && host.ctx.getSetting) ? Number(host.ctx.getSetting("stickers.auto_send_chance", 0.25)) : 0.25; return Number.isFinite(v) && v >= 0 ? v : 0.25; } catch (e) { return 0.25; } })();
      if (autoChance > 0 && emo && emo.intensity >= 0.3 && emo.name !== "无聊" && emo.name !== "平静" && Math.random() < autoChance) {
        const s = await pickStickerSmart(emo.name, reply, { sessionKey: _stkKey });
        if (s) { try { await sendStickerImage(userId, s); noteStickerSent(_stkKey, s); log("info", `自动表情包 user=${userId}: ${emo.name}→${s.label}`); } catch (e) { log("warn", "表情包发送失败: " + e.message.slice(0, 120)); } }
      }
    }
    if (voiceRequested && !_pendingVoice) {
      try { await sendVoice(userId, reply); }
      catch (e) {
        log("warn", "语音发送失败: " + e.message.slice(0, 120));
        if (_voiceOnly) { try { await sendPrivate(userId, reply); } catch (e2) {} }
      }
    }
    
    log("info", `回复私聊 ${userId}，长度 ${reply.length}`);
    if (_teachApi) _teachApi.markMatched(reply);
    /* 记忆提炼已由插件 memory 的 reply 钩子接管 */
    if (!budgetOut) {
      extractCurrentStatus(userId, origText, settings).catch(() => {});
      if (master || getFavor(userId) >= 50) extractSelfIdentity(text, reply, settings, userId).catch((e) => log("warn", "成长记忆提炼失败: " + e.message.slice(0, 160)));
      selfScoreReply(text, reply, settings).catch((e) => log("warn", "自我评分失败: " + e.message.slice(0, 160)));
    }
    if (!master && !budgetOut) {
      try {
        if (dailyQzoneCount() < 5) {
          const post = await detectQzonePost(text, reply, settings, call);
          if (post) { const _pz2 = await publishQzone(post); log("info", `空间分享: ${post.slice(0, 40)}${_pz2 && _pz2.images ? `（配图 ${_pz2.images} 张）` : ""}`); }
        }
      } catch (e) { log("warn", "空间发布失败: " + e.message.slice(0, 120)); }
    }
  } catch (e) {
    log("error", `对话失败 user=${userId}: ${e.message.slice(0, 300)}`);
    
    sendPrivate(userId, "呜…刚才脑袋卡住了：" + String(e.message).slice(0, 120)).catch(() => {});
  } finally { busyUsers.delete(userId); }
}

/* ---------------- 群聊：提及触发 + 有趣话题主动插话 ---------------- */
function isGroupMention(text) {
  const words = (cfg.qq && cfg.qq.group_mention_words) || ["momo", "大肥鱼", "肥鱼", "鲸鱼", "小鱼"];
  const t = String(text || "").toLowerCase();
  return words.some((w) => w && t.includes(String(w).toLowerCase()));
}
const GROUP_PROACTIVE_LAST = new Map();
const GROUP_RECENT = new Map();   // groupId -> 最近 1 分钟的消息时间戳
const GROUP_DAILY = new Map();    // groupId -> {date, count} 每天主动插话次数
const GROUP_LAST_AT = new Map();  // groupId -> {userId, ts} 最近一次有人 @ 她
const GROUP_LAST_MSGID = new Map(); // `${gid}_${uid}` -> 最近一条消息 id（贴表情用）
const GROUP_CONTINUE_MS = 5 * 60000;  // 对话延续窗口：刚@过她的人继续说，5 分钟内直接回复
const GROUP_PROACTIVE_MIN_MS = 15 * 60000;
const GROUP_PROACTIVE_PROB = 0.06;
async function maybeProactiveGroupSpeak(groupId, text, settings) {
  const nowTs = Date.now();
  /* 记最近 1 分钟的群消息，用来判断群里热不热闹 */
  const recent = (GROUP_RECENT.get(groupId) || []).filter((t) => nowTs - t < 60000);
  recent.push(nowTs);
  GROUP_RECENT.set(groupId, recent);
  // 群里正热闹（1 分钟 8 条以上）→ 别插话打断
  if (recent.length > 8) return null;
  // 每个群每天最多主动插话 10 次
  const today = new Date().toDateString();
  const daily = GROUP_DAILY.get(groupId) || { date: today, count: 0 };
  if (daily.date !== today) { daily.date = today; daily.count = 0; }
  if (daily.count >= 10) return null;
  if (Math.random() > GROUP_PROACTIVE_PROB) return null;
  const last = GROUP_PROACTIVE_LAST.get(groupId) || 0;
  if (nowTs - last < GROUP_PROACTIVE_MIN_MS) return null;
  try {
    const prompt = `你在一个 QQ 群里（没被 @，只是有人闲聊）。群友刚说："${String(text).slice(0, 150)}"。如果这个话题有趣/好玩到值得你（Momo 大肥鱼）主动插一句话，就以 Momo 口吻写一句（15~40 字，自然可爱、不带括号动作、不 @ 人）；如果不够有趣就别说话，只输出 NO。`;
    const raw = await completeOnce([{ role: "user", content: prompt }], settings, 120, 0.9);
    const s = String(raw || "").trim();
    if (!s || s.toUpperCase() === "NO" || s.toUpperCase().startsWith("NO")) return null;
    GROUP_PROACTIVE_LAST.set(groupId, Date.now());
    daily.count += 1;
    GROUP_DAILY.set(groupId, daily);
    return s.slice(0, 100);
  } catch (e) { return null; }
}

/* ---------------- 群聊防抖合并（按 群+人） ---------------- */
const pendingGroup = new Map();
const GROUP_DEBOUNCE_MS = 3000;
const GROUP_MAX_WAIT_MS = 8000;
function enqueueGroupChat(groupId, userId, text, images, msgTime, direct) {
  const key = "g" + groupId + "_" + userId;
  let p = pendingGroup.get(key);
  if (!p) { p = { texts: [], images: [], firstTs: Date.now(), timer: null, groupId, userId, msgTime, direct: false }; pendingGroup.set(key, p); }
  if (msgTime) p.msgTime = msgTime;
  if (direct) p.direct = true;   // 这批里只要有一条是直接叫她的，就算直接对话
  if (text) p.texts.push(text);
  if (images && images.length) p.images = p.images.concat(images);
  if (p.timer) clearTimeout(p.timer);
  const elapsed = Date.now() - p.firstTs;
  const delay = Math.min(GROUP_DEBOUNCE_MS, Math.max(0, GROUP_MAX_WAIT_MS - elapsed));
  p.timer = setTimeout(() => fireGroupChat(key), delay);
  
}
function fireGroupChat(key) {
  const p = pendingGroup.get(key);
  if (!p) return;
  if (busyUsers.has(p.userId)) { p.timer = setTimeout(() => fireGroupChat(key), 500); return; }
  pendingGroup.delete(key);
  const texts = p.texts;
  if (!texts.length && !p.images.length) return;
  const combined = texts.length > 1
    ? texts.map((t, i) => `${i + 1}. ${t}`).join("\n") + "\n（以上是对方连续发的几条消息，请当作同一段话一起回应）"
    : (texts[0] || "");
  processGroupChat(p.groupId, p.userId, combined, p.images, p.msgTime, p.direct);
}
async function processGroupChat(groupId, userId, text, images, msgTime, direct) {
  if (busyUsers.has(userId)) { enqueueGroupChat(groupId, userId, text, images, msgTime, direct); return; }
  busyUsers.add(userId);
  try {
    
    const settings = resolveChatSettings();
    const history = loadSession("g" + groupId + "_" + userId);
    if (images && images.length) {
      if (!canDo(userId, "vision")) {
        text = text ? text + "\n【图片内容】（对方发了图片，但看图的权限只有主人有）" : "[对方发了一张图片]";
      } else {
        const descs = [];
        for (const img of images.slice(0, 3)) {
          let _known = null;
          try {
            const _stk = host && host.apis.get("stickers");
            if (_stk && _stk.findByHash) _known = _stk.findByHash(await host.apis.get("vision").imageBytes(img));
          } catch (e) {}
          if (_known && _known.meaning) { descs.push("[表情包] " + host.apis.get("stickers").meaningText(_known)); continue; }
          try { const d = await host.apis.get("vision").describeImage(img, settings); if (d) descs.push(d); } catch (e) {}
        }
        if (descs.length) text = text + (text ? "\n" : "") + "【图片内容】" + descs.join("；");
        else if (!text) text = "[对方发了一张图片]";
      }
    }
    const gCall = resolveCall(userId);
    const gPersona = userPersona(userId, settings);
    const gMemories = host.apis.get("groupInfo").filterMemoriesForGroup(loadMemories(userId), groupId);
    const gShort = host.apis.get("groupInfo").filterMemoriesForGroup(pruneShortMemories(userId), groupId);
    const gKey = "g" + groupId + "_" + userId;
    const _lastMsgT = (loadMsgTimes())[gKey] || 0;
    const gapMs = (_lastMsgT && msgTime) ? (msgTime - _lastMsgT) * 1000 : 0;
    if (gapMs > 60000) log("info", `群时间差 ${gKey}: ${formatGap(gapMs)}`);
    if (msgTime) saveMsgTime(gKey, msgTime);
    const timeCtx = timeAwarenessCtx(gapMs);
    const gMemberCtx = host.apis.get("groupInfo").groupMemberCtx(groupId, userId);
    const gLogCtx = host.apis.get("groupInfo").groupLogCtx(groupId);
    const gMemeCtx = host.apis.get("groupInfo").groupMemesCtx(groupId);
    let gInfoCtx = "";
    try { const _gi = host && host.apis.get("groupInfo"); if (_gi) gInfoCtx = await _gi.groupInfoCtx(groupId); } catch (e) {}
    /* 群聊也要有自己的真实状态、天气、教学（和私聊对齐） */
    const _gLifeApi = host && host.apis.get("lifeLog");
    const _gLifeCtx = _gLifeApi ? _gLifeApi.lifeCtx() : "";
    const _gTeachApi = host && host.apis.get("teach");
    const _gTeachCtx = _gTeachApi ? _gTeachApi.teachCtx(text) : "";
    let _gWeatherCtx = "";
    try { const _gW = host && host.apis.get("weather"); if (_gW) _gWeatherCtx = await _gW.weatherCtx(); } catch (e) {}
    const gCtx = [GROUP_DIRECTIVE, gInfoCtx, timeCtx, gMemberCtx, gLogCtx, gMemeCtx, _gLifeCtx, _gWeatherCtx, _gTeachCtx, "注意：有些事是对方在私聊里告诉你的，别在群里随便说。"].filter(Boolean).join("\n") || undefined;
    const gSettings = Object.assign({}, settings, { max_tokens: Math.min(settings.max_tokens || 2048, 250) });
    setActivity("在群里陪" + gCall + "聊天");
    const gRes = await agentChatOnce(history, text, gSettings, gMemories, gPersona, gCall, userId, gCtx, gShort, gKey, { groupId, messageId: GROUP_LAST_MSGID.get(Number(groupId) + "_" + Number(userId)) });
    const rawReply = gRes && gRes.reply;
    const reply = stripStageDirections(rawReply) || rawReply;
    if (reply) {
      history.push({ role: "user", content: text, ts: Date.now() }, { role: "assistant", content: reply, ts: Date.now() });
      await maybeRollSummary(gKey, history, settings);
      saveSession("g" + groupId + "_" + userId, trimHistory(history, settings.history_limit, settings.history_chars));
      const qq = cfg.qq || {};
      const split = !!qq.split_reply;
      const segGap = evolvePref("reply_gap_ms", qq.reply_gap_ms || 1200);
      const segs = split ? splitReply(reply, evolvePref("split_cap", 150)) : [reply];
      /* @ 不 @ 由参数决定：always 总@ / on_at 只在被直接叫时@ / never 从不@ */
      const _atApi = host && host.apis.get("groupChat");
      const _atMode = _atApi ? _atApi.atMode() : "on_at";
      const _atFirst = _atMode === "always" ? true : (_atMode === "never" ? false : !!direct);
      for (let i = 0; i < segs.length; i++) {
        const msg = (i === 0 && _atFirst)
          ? [{ type: "at", data: { qq: String(userId) } }, { type: "text", data: { text: " " + segs[i] } }]
          : [{ type: "text", data: { text: segs[i] } }];
        await onebotSend("send_msg", { message_type: "group", group_id: Number(groupId), message: msg });
        if (i < segs.length - 1) await sleep(split ? segGap : 300);
      }
      log("info", `回复群消息 群${groupId} → ${userId}，长度 ${reply.length}，分 ${segs.length} 条`);
      logJsonl("replies.jsonl", { ts: Date.now(), userId, channel: "group", groupId, text: String(reply || "").slice(0, 500) });
      /* 群聊也能自动配表情包（之前 sendStickerImage 只支持私聊） */
      try {
        const gEmo = getEmotion();
        const gChance = (() => { try { const v = (host && host.ctx && host.ctx.getSetting) ? Number(host.ctx.getSetting("stickers.auto_send_chance", 0.25)) : 0.25; return Number.isFinite(v) && v >= 0 ? v : 0.25; } catch (e) { return 0.25; } })();
        if (gChance > 0 && gEmo && gEmo.intensity >= 0.3 && gEmo.name !== "无聊" && gEmo.name !== "平静" && Math.random() < gChance) {
          const s = await pickStickerSmart(gEmo.name, reply, { sessionKey: stickerSessionKey(userId, groupId) });
          if (s) { await sendStickerImage(userId, s, "group", groupId); noteStickerSent(stickerSessionKey(userId, groupId), s); log("info", `群自动表情包 群${groupId}: ${gEmo.name}→${s.label}`); }
        }
      } catch (e) { log("warn", "群表情包失败: " + String(e.message).slice(0, 100)); }
      if (host) host.runHook("reply", { userId, text, reply, channel: "group", groupId });
      host.apis.get("groupInfo").recordCrossWindow(userId, groupId, text, reply);
      /* 群聊记忆提炼已由插件 memory 的 reply 钩子接管 */
    }
    
  } catch (e) { log("error", `群聊失败: ${e.message.slice(0, 200)}`);  }
  finally { busyUsers.delete(userId); }
}

/* 群里这条消息要不要回：@了她 / 叫了名字 / 刚@过她的人在延续对话
 * atOthers：这条消息 @ 了哪些别人（不含她自己）
 * mode：smart=让模型判断；strict=@了别人就不接；ignore=不管@了谁 */
function groupShouldReply(atSelf, mentioned, lastAt, userId, nowMs, atOthers, mode) {
  if (atSelf || mentioned) return { reply: true, continued: false, needJudge: false };
  const inWindow = lastAt && Number(lastAt.userId) === Number(userId) && (nowMs - (lastAt.ts || 0)) < GROUP_CONTINUE_MS;
  if (!inWindow) return { reply: false, continued: false, needJudge: false };
  const others = Array.isArray(atOthers) ? atOthers.filter(Boolean) : [];
  if (!others.length) return { reply: true, continued: true, needJudge: false };
  if (mode === "ignore") return { reply: true, continued: true, needJudge: false };
  if (mode === "strict") return { reply: false, continued: false, needJudge: false };
  // smart：先放行，让模型看一眼这句到底在跟谁说
  return { reply: true, continued: true, needJudge: true };
}

/* 便宜判断：这条 @ 了别人的消息，是在跟 Momo 说还是在跟别人说 */
async function judgeGroupAddressed(text, atOthers, settings) {
  try {
    const prompt = `群里有人说：「${String(text || "").slice(0, 120)}」\n这条消息 @ 了别人（不是 Momo）。\n请判断：这句话是在跟 Momo（大肥鱼）说，还是在跟被 @ 的人说？\n只输出 1（跟 Momo 说）或 2（跟别人说），不要解释。`;
    const raw = await completeOnce([{ role: "user", content: prompt }], settings, 5, 0.2);
    const s = String(raw || "").trim();
    if (/^2/.test(s)) return false;
    if (/^1/.test(s)) return true;
    // 没按格式答：看有没有提到 Momo
    return /momo|大肥鱼|鱼/i.test(s) && !/别人|对方/.test(s);
  } catch (e) { return true; }   // 判断失败时保守放行，别把人晾着
}

async function handleGroupMessage(event) {
  if (!(cfg.qq && cfg.qq.respond_to_groups)) return;
  if (!Array.isArray(event.message)) return;
  const atSelf = event.message.some((s) => s && s.type === "at" && String(s.data && s.data.qq) === String(event.self_id));
  const parsed = parseMessage(event.message);
  let text = parsed.text;
  if (parsed.faces.length) {
    const fe = parsed.faces.join("、");
    text = text ? `${text}（对方发了表情：${fe}）` : `[对方发了表情：${fe}]`;
  }
  if (parsed.records.length) {
    const vt = await transcribeRecords(event.message_id, parsed.records);
    if (vt) text = text ? text + "\n" + vt : `[语音消息] ${vt}`;
    else text = text || "[对方发了一条语音，但我没听清]";
  }
  const mentioned = !!text && isGroupMention(text);
  /* 对话延续：刚 @ 过她的人，5 分钟内继续说 → 当作对话继续，直接回复（不走 6% 概率） */
  const _gid = Number(event.group_id);
  const _uid = Number(event.user_id);
  /* 这条消息 @ 了哪些别人（不含她自己） */
  const _atOthers = (parsed.ats || []).filter((q) => q && String(q) !== String(event.self_id) && String(q) !== "all");
  const _gApi = host && host.apis.get("groupChat");
  const _atOthersMode = _gApi ? _gApi.atOthersMode() : "smart";
  const _dec = groupShouldReply(atSelf, mentioned, GROUP_LAST_AT.get(_gid), _uid, Date.now(), _atOthers, _atOthersMode);
  const _continued = _dec.continued;
  /* smart 档：@ 了别人时，让模型看一眼这句在跟谁说 */
  if (_dec.needJudge) {
    const _pSet = resolveChatSettings();
    const _forMe = await judgeGroupAddressed(text, _atOthers, _pSet);
    if (!_forMe) {
      log("info", `群对话延续-判定为跟别人说，不接 群${_gid} 用户${_uid}：${String(text).slice(0, 30)}`);
      return;
    }
    log("info", `群对话延续-判定为跟她说 群${_gid} 用户${_uid}：${String(text).slice(0, 30)}`);
  }
  if (_dec.reply) {
    const _gRoles = host && host.apis.get("roles");
    if (_gRoles && _gRoles.resolveRole(_uid) === "visitor" && !_gRoles.rateOk(_uid)) { log("info", `访客限速，忽略群消息 ${_uid}`); return; }
    GROUP_LAST_AT.set(_gid, { userId: _uid, ts: Date.now() });   // 续期
    if (_continued) log("info", `群对话延续 群${_gid} 用户${_uid}：${String(text).slice(0, 30)}`);
  }
  if (!_dec.reply) {
    if (!text || !apiKey) return;
    log("info", `群闲聊 群${_gid} 用户${_uid}：${String(text).slice(0, 30)}（未@她，按概率决定是否插话）`);
    const pSettings = resolveChatSettings();
    const speak = await maybeProactiveGroupSpeak(Number(event.group_id), text, pSettings);
    if (!speak) return;
    lastInteractionTs = Date.now();
    await onebotSend("send_msg", { message_type: "group", group_id: Number(event.group_id), message: speak });
    log("info", `群主动插话 群${event.group_id}：${speak.slice(0, 40)}`);
    return;
  }
  if (!text && !parsed.images.length) return;
  lastInteractionTs = Date.now();
  const userId = Number(event.user_id);
  if (!isMaster(userId) && isMuted(userId)) return;
  log("info", `收到群消息 群${event.group_id} 用户${userId}，文本 ${text.length} 字，图片 ${parsed.images.length} 张`);
  logJsonl("messages.jsonl", { userId, channel: "group", groupId: event.group_id, text: String(text || "").slice(0, 500), images: parsed.images.length });
  const _sn = event.sender ? String(event.sender.card || event.sender.nickname || "").slice(0, 20) : "";
  if (_sn) host.apis.get("groupInfo").rememberGroupMember(event.group_id, userId, _sn, { images: parsed.images.length, role: event.sender && event.sender.role });
  /* 自动学群梗：「X 的意思是 Y」这类说法 */
  try { host.apis.get("groupInfo").detectGroupMeme(event.group_id, text, userId); } catch (e) {}
  host.apis.get("groupInfo").recordGroupLog(event.group_id, userId, _sn, text);
  enqueueGroupChat(Number(event.group_id), userId, text, parsed.images, Number(event.time) || 0, !!(atSelf || mentioned));
  if (event.message_id) GROUP_LAST_MSGID.set(Number(event.group_id) + "_" + userId, String(event.message_id));
}

/* ---------------- 主动搭话调度 ---------------- */
function nowHM() {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
}
/* inQuietHours 已迁移到插件 proactive */
function seedActivity() {
  const users = (cfg.qq && cfg.qq.allowed_users) || [];
  const pr = cfg.proactive || {};
  const silenceMs = (pr.silence_minutes || 120) * 60000;
  for (const u of users) {
    let t = lastActiveAt.get(u);
    if (!t) {
      t = Date.now();
      try {
        const sp = sessionPath(u);
        if (fs.existsSync(sp)) { const st = fs.statSync(sp).mtimeMs; if (st > 0) t = st; }
      } catch (e) {}
    }
    // 重启后：若沉默已超阈值，重置为现在（视为刚上线，不立刻搭话）
    if (t && Date.now() - t > silenceMs) { t = Date.now(); log("info", `启动重置沉默计时 user=${u}`); }
    lastActiveAt.set(u, t);
  }
  saveProactiveState();
}
const PROACTIVE_STARTED_AT = Date.now();
/* proactiveLoop 已迁移到插件 proactive */

function connect() {
  try { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } } catch (e) {}
  const url = cfg.onebot.ws_url;
  log("info", "连接 OneBot WS: " + url);
  try {
    ws = new WebSocket(url);
    ws.onopen = () => log("info", "OneBot WS 已连接");
    ws.onerror = (e) => log("warn", "OneBot WS 错误: " + (e.message || e.type || "unknown"));
    ws.onclose = () => { log("warn", "OneBot WS 断开，5 秒后重连"); reconnectTimer = setTimeout(connect, 5000); };
    ws.onmessage = (ev) => {
      try {
        const obj = JSON.parse(ev.data);
        if (obj.post_type === "message" && obj.message_type === "private") handlePrivateMessage(obj).catch((e) => log("error", "私聊处理异常: " + e.message));
        else if (obj.post_type === "message" && obj.message_type === "group") handleGroupMessage(obj).catch((e) => log("error", "群聊处理异常: " + e.message));
        else if (obj.post_type === "notice" && obj.notice_type === "notify" && obj.sub_type === "poke") {
          const _ia = host && host.apis.get("interact");
          if (_ia && _ia.onPoke) _ia.onPoke(obj).catch((e) => log("warn", "拍一拍处理异常: " + e.message));
        }
        else if (obj.post_type === "meta_event" && obj.meta_event_type === "lifecycle") log("info", `Bot 上线 self_id=${obj.self_id}`);
      } catch (e) { log("error", "消息解析异常: " + e.message); }
    };
  } catch (e) { log("error", "WS 建立失败: " + e.message); reconnectTimer = setTimeout(connect, 5000); }
}

/* ================= 桌宠联脑：本地 OpenAI 兼容接口 =================
 * 让桌宠的聊天走 Momo 同一个大脑（人设/记忆/工具/生活费都共用）
 * 桌宠侧配置：chat.providers.<x>.base_url = http://127.0.0.1:<port>，model = momo
 */
const PET_API_PORT = Number((cfg.chat && cfg.chat.pet_api_port) || 3999);
const PET_EXCLUDE_TOOLS = new Set([
  "send_sticker", "poke", "send_like", "emoji_like", "forward_msg", "msg_by_id",
  "group_info", "group_member_view", "group_honor", "user_info", "group_files",
  "group_meme_view", "group_meme_learn", "set_self_profile",
]);

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

/* 用 Momo 的大脑回桌宠的一句话 */
async function petChat(petMessages) {
  const settings = resolveChatSettings();
  const master = Number((cfg.qq && cfg.qq.master_user) || 0);
  const arr = Array.isArray(petMessages) ? petMessages : [];
  const lastUser = [...arr].reverse().find((m) => m && m.role === "user");
  const userText = String((lastUser && lastUser.content) || "").slice(0, 2000);
  if (!userText) return "（你好呀，我在）";
  const lastIdx = arr.lastIndexOf(lastUser);
  const history = arr.slice(0, lastIdx)
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, 2000) }));
  const persona = userPersona(master, settings);
  const memories = loadMemories(master);
  const short = pruneShortMemories(master);
  const petCtx = "【当前渠道】你和主人正通过**桌宠聊天窗口**说话（不是 QQ）。他能看到你的样子，但你们是靠打字交流的。";
  const _t0 = Date.now();
  const res = await agentChatOnce(history, userText, settings, memories, persona, resolveCall(master), master, petCtx, short, null, { petMode: true });
  log("info", `桌宠联脑完成 耗时 ${Date.now() - _t0}ms（历史 ${history.length} 条）`);
  const reply = String((res && res.reply) || "").trim();
  return reply || "（嗯……我在想）";
}

function startPetApi() {
  /* 余额转发缓存：桌宠每分钟查一次，这里做个 30 秒缓存，别把 DeepSeek 打太狠 */
  let _balCache = { ts: 0, body: "", status: 200 };
  const srv = http.createServer((req, res) => {
    const _url = String(req.url || "");
    const _path = _url.split("?")[0].replace(/\/+$/, "");
    /* 余额查询转发（桌宠沿用 provider 的 base_url 查余额） */
    if (req.method === "GET" && _path.endsWith("/user/balance")) {
      const send = (status, body) => { try { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(body); } catch (e) {} };
      if (_balCache.body && Date.now() - _balCache.ts < 30000) { send(_balCache.status, _balCache.body); return; }
      const auth = req.headers.authorization || ("Bearer " + apiKey);
      fetch("https://api.deepseek.com/user/balance", { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) })
        .then(async (r) => {
          const t = await r.text();
          _balCache = { ts: Date.now(), body: t, status: r.status };
          send(r.status, t);
        })
        .catch((e) => {
          log("warn", "余额转发失败: " + String(e.message).slice(0, 100));
          if (_balCache.body) send(_balCache.status, _balCache.body);
          else send(502, JSON.stringify({ is_available: false, balance_infos: [] }));
        });
      return;
    }
    /* 插件管理端点（身体面板/体检用，仅本机 127.0.0.1） */
    const _json = (s, b) => { try { res.writeHead(s, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(b)); } catch (e) {} };
    if (req.method === "GET" && _path === "/v1/plugins") {
      try {
        const list = (host && host.ctx && host.ctx.registry && host.ctx.registry.list) ? host.ctx.registry.list() : [];
        _json(200, { ok: true, plugins: list });
      } catch (e) { _json(500, { ok: false, error: String(e.message).slice(0, 200) }); }
      return;
    }
    const _pm = _path.match(/^\/v1\/plugins\/([^/]+)\/(enable|disable)$/);
    if (req.method === "POST" && _pm) {
      const name = decodeURIComponent(_pm[1]);
      const enabled = _pm[2] === "enable";
      try {
        const fn = host && host.ctx && host.ctx.registry && host.ctx.registry.setPluginEnabled;
        const ok = fn ? fn(name, enabled) : false;
        _json(ok ? 200 : 404, { ok: !!ok, name, enabled });
      } catch (e) { _json(500, { ok: false, error: String(e.message).slice(0, 200) }); }
      return;
    }
    if (req.method !== "POST" || !_path.startsWith("/v1/chat/completions")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on("end", async () => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch (e) {}
      const msgs = Array.isArray(payload.messages) ? payload.messages : [];
      const wantStream = !!payload.stream;
      let text = "";
      try { text = await withTimeout(petChat(msgs), 30000); }
      catch (e) {
        text = e && String(e.message).indexOf("timeout") >= 0 ? "（刚刚想太久了，等会儿再聊这个好不好）" : "（我这边卡了一下，你再说一遍？）";
        log("warn", "桌宠联脑失败: " + String(e && e.message).slice(0, 100));
      }
      const id = "chatcmpl-" + Date.now().toString(36);
      try {
        if (wantStream) {
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "momo", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "momo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "momo",
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }));
        }
      } catch (e) {}
    });
  });
  srv.on("error", (e) => log("warn", `桌宠联脑接口启动失败（${PET_API_PORT}）: ` + String(e.message).slice(0, 100)));
  srv.listen(PET_API_PORT, "127.0.0.1", () => log("info", `桌宠联脑接口已就绪: http://127.0.0.1:${PET_API_PORT}/v1/chat/completions`));
  return srv;
}

log("info", `== dsh-pet-qq-bridge v${BASE_VERSION} 启动 ==`);
if (!resolveApiKey()) { log("warn", "未能读取 API Key（已启动 60 秒定时重读，读到即自愈）"); startApiKeyWatchdog(); }
loadProactiveState();
seedActivity();
loadMood();
decayMood();
loadEmotion();
decayEmotion();
const s0 = resolveChatSettings();
const ws0 = (cfg.chat && cfg.chat.web_search && cfg.chat.web_search.enabled) ? "开(" + ((cfg.chat.web_search.engine || "baidu") === "bocha" ? "博查" : "百度") + ")" : "关";
const split0 = (cfg.qq && cfg.qq.split_reply) ? `拆条≤${cfg.qq.split_max_chars || 25}字/${cfg.qq.reply_gap_ms || 1200}ms` : "单条";
const pr0 = (cfg.proactive && cfg.proactive.enabled) ? `主动搭话(沉默${cfg.proactive.silence_minutes || 120}分+${cfg.proactive.morning_greet || "08:00"}/${cfg.proactive.night_greet || "23:00"})` : "主动搭话关";
const vis0 = (cfg.chat && cfg.chat.vision && cfg.chat.vision.enabled === false) ? "关" : "开";
log("info", `模型=${s0.model} 接口=${s0.base_url} 联网=${ws0} 回复=${split0} ${pr0} 看图=${vis0} ${budgetLine()}`);
connect();
/* 桌宠联脑接口（本地 OpenAI 兼容） */
try { startPetApi(); } catch (e) { log("warn", "桌宠联脑接口启动异常: " + String(e.message).slice(0, 100)); }
/* 主动搭话已迁移到插件 proactive 的 timer 钩子 */
setInterval(() => { decayMood(); decayEmotion(); }, 5 * 60000);
/* 空闲认知心跳：已合并进 heartbeat 主时钟（每 60 tick 记一次），此处只做启动热身 */
try {
  log("info", `空闲心跳已并入主时钟（唤醒间隔 ≥${mindCfg("min_wake_gap_min", 10)} 分钟，每小时 ≤${mindCfg("max_per_hour", 3)} 次）`);
  setTimeout(mindPulseTick, 8000);
} catch (e) { log("warn", "空闲心跳启动失败: " + String(e.message).slice(0, 100)); }
/* 空间保底自查已迁移到插件 qzone 定时钩子 */
setInterval(heartbeat, 1000);
/* 浅心跳已迁移到插件 proactive 的 timer 钩子 */
setInterval(mindLoop, MIND_TICK_MS);
setTimeout(mindLoop, 60000);
setInterval(catchUpMissedMessages, 5 * 60000);
setTimeout(catchUpMissedMessages, 15000);
/* 记忆固化定时器已迁移到插件 memory 的 timer 钩子 */
/* 提醒/目标计划/生日检查定时器已迁移到插件 timer 钩子 */
// 每日复盘（小结）已并入「晚间播报」插件 evening-report.js，此处不再单独定时
// 反思/进化已移入心流循环（mindLoop），由 Momo 自主决定，每天各限 1 次

/* ================= 插件平台（三层架构） ================= */
const { createHost } = require("./plugin-host");
host = createHost({
  log, cfg, get apiKey() { return apiKey; }, resolveChatSettings,
  sendPrivate, recordAndSend, onebotSend, sendStickerImage,
  loadMemories, saveMemories, loadShortMemories, saveShortMemories, loadSession, saveSession,
  isMaster, resolveCall, userPersona, isBudgetExhausted, budgetLevel, canAfford, ACTION_COST, getFavor,
  recordAction, loadActions,
  getCurrentStatus, setCurrentStatus, clearCurrentStatus, applyStatusRule, userQuietState, markProbed, loadActivityState,
  todayText, periodOfDay, nowHM, formatGap, dayStr, todayMMDD, parseMemoryJson,
  loadAppellations, saveAppellations, loadMute, addMute, removeMute, resolveTargetId, loadWishes, addWish,
  completeOnce, reasonComplete, qzoneHttp, bochaKey,
  cleanText, UA, sleep, recordSpend, estimateTokens, maybeCollect,
  getEmotion, getMood, addMood, setMood, getBoredom, addBoredom, loadBudget, budgetCfg, loadMindState: () => host.apis.get("mind").loadMindState(), textSimilar,
  getLastSentSticker, stickerSessionKey,
  loadEvolution, reloadEvolution, pickStickerByIds, SELF_DIR, BASE_VERSION,
  proactive: {
    get lastInteractionTs() { return lastInteractionTs; },
    set lastInteractionTs(v) { lastInteractionTs = v; },
    get lastShallowTs() { return lastShallowTs; },
    set lastShallowTs(v) { lastShallowTs = v; },
    get STARTED_AT() { return PROACTIVE_STARTED_AT; },
    MIND_PAUSE_MS, lastActiveAt, lastProactiveAt, lastProactiveMsg, greeted,
    saveProactiveState, proactiveIntervalMs, getProactivePref,
    isBusy: (u) => busyUsers.has(u),
    getBoredom, setActivity, fetchFunImage, coreContextMessages, proactiveAgentTurn,
    /* 大脑决策：现在该不该主动发（日程/趣图等候选都先过这一关） */
    async shouldSendNow(userId, idea) {
      try {
        const st = getCurrentStatus(userId);
        const act = loadActivityState();
        const ask = `你是 Momo。现在 ${todayText()}（${periodOfDay()}）。你的想法：${idea}。对方当前状态：${st ? st.text : "未知"}。你刚才在做：${act && act.text ? act.text : "发呆"}。请判断：现在适合给对方发消息吗？考虑时间是否合适、会不会打扰、内容是否必要。只回答 yes 或 no。`;
        const ans = await completeOnce([{ role: "user", content: ask }], resolveChatSettings(), 10, 0.2);
        return /yes/i.test(String(ans || ""));
      } catch (e) { return true; }
    },
  },
  DATA_DIR, AGENT_TOOLS,
});
host.loadPlugins();
host.runHook("startup", {});
host.watchPlugins();
log("info", `插件平台就绪：${host.plugins.length} 个插件（工具 ${host.toolRegistry.size} 个 / 命令 ${host.commandRegistry.size} 个）`);

