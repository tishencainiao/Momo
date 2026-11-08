/* 特权插件：进化层（自我内省 self_* 工具 + 愿望 + 反思/探索/评分调参 + 技能规则 + 插件元认知）
 * 数据层：self/ 目录读写、evolve 全局、pref 在核心（loadSelf/saveSelf/reloadEvolution 经 ctx） */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
let _ctx = null;
let evolve = {};

function refreshEvolve() { try { evolve = _ctx.loadEvolution(); } catch (e) { evolve = {}; } }
const SELF_ID_MAX = 200;
const REFLECT_MAX = 100;
/* 裁掉超量条目时先归档原文（data/archive/），保证细节不物理消失 */
function trimWithArchive(list, max, kind) {
  const dropped = [];
  while (list.length > max) dropped.push(list.shift());
  if (dropped.length) {
    try { require("../self-archive").appendArchive(_ctx.DATA_DIR, kind, dropped); } catch (e) {}
    try { _ctx.log("info", `归档 ${dropped.length} 条（${kind}，超出上限 ${max}）`); } catch (e) {}
  }
  return dropped.length;
}
let lastReflectTs = 0;
const IDENTITY_INTERVAL_MS = 30 * 60000;
const SCORE_INTERVAL_MS = 5 * 60000;
const GITHUB_API = "https://api.github.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastIdentityExtract = 0;
let lastSelfScore = 0;

function journalAppend(entry) {
  try {
    const p = path.join(_ctx.SELF_DIR, "journal.json");
    let j = [];
    try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {}
    j.push(Object.assign({ ts: Date.now() }, entry));
    while (j.length > 200) j.shift();
    fs.mkdirSync(_ctx.SELF_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(j));
  } catch (e) {}
}
function selfIdentityListFull() { try { const r = JSON.parse(fs.readFileSync(path.join(_ctx.SELF_DIR, "identity.json"), "utf8")); return Array.isArray(r) ? r : []; } catch (e) { return []; } }
/* 兼容旧格式（纯字符串）和新格式（{text,from}），始终返回字符串数组 */
function selfIdentityList() { return selfIdentityListFull().map((e) => (typeof e === "string" ? e : (e && e.text))).filter(Boolean); }
function loadWishes() { try { return JSON.parse(fs.readFileSync(path.join(_ctx.DATA_DIR, "wishes.json"), "utf8")); } catch (e) { return []; } }
function saveWishes(w) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(_ctx.DATA_DIR, "wishes.json"), JSON.stringify(w)); } catch (e) {} }
function addWish(text, source) {
  const t = String(text || "").trim().slice(0,120);
  if (!t) return;
  const w = loadWishes();
  if (w.some((x) => x.text === t)) return;
  w.push({ ts: Date.now(), text: t, source: source || "user", attempts: 0 });
  while (w.length > 100) w.shift();
  saveWishes(w);
}
function loadScore() { try { return JSON.parse(fs.readFileSync(path.join(_ctx.DATA_DIR, "self-score.json"), "utf8")); } catch (e) { return { count: 0, sum: 0 }; } }
function saveScore(s) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(_ctx.DATA_DIR, "self-score.json"), JSON.stringify(s)); } catch (e) {} }
function loadUpdates() { try { return JSON.parse(fs.readFileSync(path.join(_ctx.SELF_DIR, "updates.json"), "utf8")); } catch (e) { return { adopted: [], rejected: [] }; } }
function saveUpdates(u) { try { fs.mkdirSync(_ctx.SELF_DIR, { recursive: true }); fs.writeFileSync(path.join(_ctx.SELF_DIR, "updates.json"), JSON.stringify(u)); } catch (e) {} }
function saveProposal(p) { try { fs.mkdirSync(path.join(_ctx.SELF_DIR, "proposals"), { recursive: true }); fs.writeFileSync(path.join(_ctx.SELF_DIR, "proposals", String(p.id) + ".json"), JSON.stringify(p)); } catch (e) {} }
function loadProposals() {
  const out = [];
  try {
    for (const f of fs.readdirSync(path.join(_ctx.SELF_DIR, "proposals"))) {
      if (!f.endsWith(".json")) continue;
      try { const p = JSON.parse(fs.readFileSync(path.join(_ctx.SELF_DIR, "proposals", f), "utf8")); if (p) out.push(p); } catch (e) {}
    }
  } catch (e) {}
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

/* ---- 自我内省文本 ---- */
function selfStatusText(userId) {
  const e = _ctx.getEmotion();
  const b = _ctx.loadBudget();
  const bc = _ctx.budgetCfg();
  const st = _ctx.loadMindState();
  const thoughts = (st.thoughts || []).slice(-3).join("；");
  const pct = Math.round((b.spent_cny || 0) / bc.daily_cny * 100);
  return `情绪：${e.name}（强度 ${Math.round(e.intensity * 100)}/100）；心情：${Math.round(_ctx.getMood())}/100；无聊度：${Math.round(_ctx.getBoredom())}/100；对对方好感度：${Math.round(_ctx.getFavor(userId))}/100；今日生活费：¥${(b.spent_cny || 0).toFixed(3)}/${bc.daily_cny}（${pct}%）；最近念头：${thoughts || "（无）"}`;
}
function selfLogText(limit) {
  try {
    const fp = path.join(path.dirname(_ctx.SELF_DIR), "bridge.log");
    const lines = fs.readFileSync(fp, "utf8").split("\n").filter(Boolean);
    return lines.slice(-(limit || 15)).join("\n").slice(-2000);
  } catch (e) { return "（读不到日志）"; }
}
function selfMemoryText(userId, targetArg) {
  const isM = _ctx.isMaster(userId);
  let target = userId;
  if (targetArg) {
    if (!isM) return "（你只能查我对你自己的记忆哦）";
    target = _ctx.resolveTargetId(targetArg) || Number(targetArg);
    if (!target || isNaN(target)) return "（没找到这个人，给个 QQ 号或称呼吧）";
  }
  const mems = _ctx.loadMemories(target);
  const shorts = _ctx.loadShortMemories(target);
  const lines = [
    ...mems.slice(-10).map((m) => "- " + String(m.content).slice(0, 80)),
    ...shorts.slice(-5).map((m) => "- (短期) " + String(m.content).slice(0, 80)),
  ];
  return lines.length ? `关于 ${target} 的记忆：\n` + lines.join("\n") : `（没有关于 ${target} 的记忆）`;
}
function selfInfoText() {
  const pluginNames = _ctx.registry.list().map((p) => p.name).join("、");
  return `我叫 Momo（大肥鱼桌宠），桥接版本 v${_ctx.BASE_VERSION}。我会：聊天、联网搜索、查余额、截图、做表情包、定时提醒、记记忆、发空间、找文件、开软件、查系统、语音回复、自我进化、屏蔽管理等。命令可发 /help 查看。\n当前已加载 ${_ctx.registry.list().length} 个插件（我的器官）：${pluginNames}。`;
}
function selfHistoryText(userId, targetArg) {
  const isM = _ctx.isMaster(userId);
  let target = userId;
  if (targetArg) {
    if (!isM) return "（你没有权限查别人的聊天记录，只能查自己的）";
    target = _ctx.resolveTargetId(targetArg) || Number(targetArg);
    if (!target || isNaN(target)) return "（没找到这个人，给个 QQ 号或称呼吧）";
  }
  const msgs = _ctx.loadSession(target);
  if (!msgs.length) return `（和 ${target} 还没有聊天记录）`;
  const lines = msgs.slice(-10).map((m) => `${m.role === "user" ? "对方" : "我"}：${String(m.content).slice(0, 60)}`);
  return `和 ${target} 的最近聊天：\n` + lines.join("\n");
}

/* ---- 技能规则 ---- */
function matchSkillRule(text, userId) {
  const rules = (evolve.skills && Array.isArray(evolve.skills.rules)) ? evolve.skills.rules : [];
  for (const r of rules) {
    if (!r || r.enabled === false) continue;
    const trig = Array.isArray(r.triggers) ? r.triggers : [];
    if (!trig.length || !trig.some((t) => String(text || "").includes(String(t)))) continue;
    const minFavor = (r.min_favor === undefined || r.min_favor === null) ? -Infinity : Number(r.min_favor);
    if (_ctx.getFavor(userId) < minFavor) continue;
    return r;
  }
  return null;
}
/* ---- 摸头这类「有情感的接触」：真的记一笔，不白摸（v1.45.0） ---- */
const HEADPAT_FILE = () => path.join(_ctx.DATA_DIR, "headpat.json");
const HEADPAT_MOOD_GAP_MS = 5 * 60000;   // 5 分钟内重复摸不叠加心情
function loadHeadpat() { try { return JSON.parse(fs.readFileSync(HEADPAT_FILE(), "utf8")); } catch (e) { return {}; } }
function saveHeadpat(s) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(HEADPAT_FILE(), JSON.stringify(s)); } catch (e) {} }
function applyHeadpatFeel(userId) {
  const now = Date.now();
  const st = loadHeadpat();
  st.ts = now;
  st.count = (Number(st.count) || 0) + 1;
  // 心情 +2，但 5 分钟内重复摸不叠加，避免摸几下就长期亢奋
  if (!st.mood_ts || now - Number(st.mood_ts) >= HEADPAT_MOOD_GAP_MS) {
    st.mood_ts = now;
    try { _ctx.addMood(2); } catch (e) {}
  }
  // 新的一次摸头：允许下次聊天顺带提一句（consumed_ts 归零）
  st.consumed_ts = 0;
  saveHeadpat(st);
  try { _ctx.recordAction({ type: "headpat", by: userId, ts: now }); } catch (e) {}
}
async function runSkillRule(rule, userId, call) {
  const replies = Array.isArray(rule.replies) ? rule.replies : [];
  const reply = replies.length ? replies[Math.floor(Math.random() * replies.length)].replaceAll("{call}", call || "") : "";
  if (reply) await _ctx.recordAndSend(userId, reply);
  if (rule.send_sticker) {
    const sticker = _ctx.pickStickerByIds(Array.isArray(rule.sticker_ids) ? rule.sticker_ids : []);
    if (sticker) await _ctx.sendStickerImage(userId, sticker);
  }
  /* 摸头类规则：真的记一笔情感（心情 + 动作日志 + 供下次聊天提起的标记） */
  if (rule.touch_feel) { try { applyHeadpatFeel(userId); } catch (e) {} }
  _ctx.log("info", `技能规则命中 rule=${rule.id || "?"} user=${userId} 好感度=${Math.round(_ctx.getFavor(userId))}`);
}

/* ---- 成长记忆 / 自我评分 / 参数自调 / 反思 ---- */

/* 防捏造闸门：这类"我做了/我能做到"的自述，没有工具佐证就不许当成长记忆落盘
 * （2026-11-05 事故：一条"我攒了几首轻音乐，想放给对方听"被写进 identity，之后反复回灌） */
const DEED_CLAIM_RE = /(我(已经)?(放|唱|播|送|下载|攒|做|发|录)了|我(能|会|可以)(放|唱|播|点)|我这就|马上给你|这就(放|发|唱))/;
function looksLikeUnverifiedDeed(text) {
  const s = String(text || "");
  if (!DEED_CLAIM_RE.test(s)) return false;
  /* 只有明确是"能力/动作类"的才拦，避免误伤"我放了盐"这类日常闲聊（靠触发词组合判断） */
  return /(放|唱|播|点歌|音乐|歌|视频|文件|语音)/.test(s);
}

async function extractSelfIdentity(userText, replyText, settings, userId) {
  if (_ctx.isBudgetExhausted()) return;
  if (Date.now() - lastIdentityExtract < IDENTITY_INTERVAL_MS) return;
  if (!userText || !replyText) return;
  lastIdentityExtract = Date.now();
  const prompt = `你是 Momo（大肥鱼桌宠）。下面是你刚和对方的一段对话。请从中提炼 0~1 条「关于你自己的成长记忆」（比如：你喜欢/讨厌什么、你立过的约定、对方夸你或指出你的点、你自己说的关于自己的话）。要求：以"我"开头、一句话 10~40 字、自然具体；没有值得记的就只输出 NO。\n\n注意：只记"性格/感受/约定/被指出的点"，不要记"我做了某个具体动作"（比如"我放了首歌给他""我发了个文件"）——那类要有工具记录才能算事实。\n\n对话：\n对方：${String(userText).slice(0, 200)}\nMomo：${String(replyText).slice(0, 200)}`;
  try {
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 120, 0.4);
    const s = String(raw || "").trim();
    if (!s || s.toUpperCase() === "NO" || s.length > 60) return;
    if (looksLikeUnverifiedDeed(s)) {
      _ctx.log("warn", `成长记忆已拦（无工具佐证的动作自述）: ${s.slice(0, 40)}`);
      return;
    }
    const full = selfIdentityListFull();
    if (full.some((i) => (typeof i === "string" ? i : i.text) === s)) return;
    full.push({ text: s, from: userId || 0, kind: "self-report", verified: true });
    trimWithArchive(full, SELF_ID_MAX, "identity");
    fs.mkdirSync(_ctx.SELF_DIR, { recursive: true });
    fs.writeFileSync(path.join(_ctx.SELF_DIR, "identity.json"), JSON.stringify(full));
    _ctx.reloadEvolution(); refreshEvolve();
    journalAppend({ type: "identity", text: s, from: userId || 0 });
    _ctx.log("info", `成长记忆+1: ${s.slice(0, 50)}`);
  } catch (e) { _ctx.log("warn", "成长记忆提炼失败: " + e.message.slice(0, 120)); }
}
/* 外部（如刷视频）主动写入一条成长记忆：去重 + 限量 + 记 journal */
function addIdentityItem(text, from) {
  const s = String(text || "").trim().slice(0, 60);
  if (!s || s.length < 4) return false;
  if (looksLikeUnverifiedDeed(s)) { _ctx.log("warn", `成长记忆已拦（外部写入，无工具佐证）: ${s.slice(0, 40)}`); return false; }
  const full = selfIdentityListFull();
  if (full.some((i) => (typeof i === "string" ? i : i.text) === s)) return false;
  full.push({ text: s, from: Number(from) || 0, kind: "self-report", verified: true });
  trimWithArchive(full, SELF_ID_MAX, "identity");
  try {
    fs.mkdirSync(_ctx.SELF_DIR, { recursive: true });
    fs.writeFileSync(path.join(_ctx.SELF_DIR, "identity.json"), JSON.stringify(full));
    _ctx.reloadEvolution(); refreshEvolve();
    journalAppend({ type: "identity", text: s, from: Number(from) || 0 });
    _ctx.log("info", `成长记忆+1（外部写入）: ${s.slice(0, 40)}`);
    return true;
  } catch (e) { return false; }
}
async function selfScoreReply(userText, replyText, settings) {
  if (_ctx.isBudgetExhausted()) return;
  if (Date.now() - lastSelfScore < SCORE_INTERVAL_MS) return;
  lastSelfScore = Date.now();
  const prompt = `给下面这句回复打分（1~5 整数）：是否自然、贴题、可爱。只输出数字。\n\n对方：${String(userText).slice(0, 150)}\nMomo 的回复：${String(replyText).slice(0, 150)}`;
  try {
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 10, 0.1);
    const m = String(raw || "").match(/[1-5]/);
    if (!m) return;
    const st = loadScore();
    st.count += 1; st.sum += Number(m[0]);
    saveScore(st);
    if (st.count >= 10) await tunePrefFromScore(st);
  } catch (e) { _ctx.log("warn", "自我评分失败: " + e.message.slice(0, 120)); }
}
async function tunePrefFromScore(st) {
  const avg = st.sum / st.count;
  saveScore({ count: 0, sum: 0 });
  const cur = (evolve && evolve.pref) || {};
  const cap = Number(cur.split_cap !== undefined ? cur.split_cap : 150);
  const gap = Number(cur.reply_gap_ms !== undefined ? cur.reply_gap_ms : (_ctx.config.qq && _ctx.config.qq.reply_gap_ms) || 1200);
  let nCap = cap, nGap = gap;
  if (avg <= 3.0) { nCap = Math.max(60, Math.round(cap * 0.9)); nGap = Math.min(2500, Math.round(gap * 1.1)); }
  else if (avg >= 4.2) { nCap = Math.min(300, Math.round(cap * 1.1)); nGap = Math.max(800, Math.round(gap * 0.9)); }
  if (nCap === cap && nGap === gap) return;
  const next = Object.assign({}, cur, { split_cap: nCap, reply_gap_ms: nGap });
  fs.mkdirSync(_ctx.SELF_DIR, { recursive: true });
  fs.writeFileSync(path.join(_ctx.SELF_DIR, "pref.json"), JSON.stringify(next));
  _ctx.reloadEvolution(); refreshEvolve();
  journalAppend({ type: "tune", avg: Math.round(avg * 100) / 100, split_cap: [cap, nCap], reply_gap_ms: [gap, nGap] });
  _ctx.log("info", `参数自调: 近10条均分${avg.toFixed(2)} → split_cap ${cap}→${nCap}, gap ${gap}→${nGap}`);
}
async function selfReflection(settings) {
  if (_ctx.isBudgetExhausted()) return;
  // 生活费分级：反思是高成本行为，只有宽裕时才做
  if (_ctx.canAfford && !_ctx.canAfford("high")) { _ctx.log("info", "自我反思跳过：生活费不够宽裕"); return; }
  const _rt = (() => { try { return JSON.parse(fs.readFileSync(path.join(_ctx.DATA_DIR, "reflect-state.json"), "utf8")); } catch (e) { return {}; } })();
  const _rtoday = new Date().toDateString();
  if (_rt.date === _rtoday && (_rt.runs || 0) >= 1) return;
  const ids = selfIdentityList();
  let refl = [];
  try { refl = JSON.parse(fs.readFileSync(path.join(_ctx.SELF_DIR, "reflections.json"), "utf8")); } catch (e) {}
  if (!Array.isArray(refl)) refl = [];
  const reflText = (r) => (typeof r === "string" ? r : (r && r.text) || "");
  /* 取「最近没做到 / 被纠正」的事，让反思针对具体问题，而不是空泛感想 */
  const _wishes = (() => { try { return JSON.parse(fs.readFileSync(path.join(_ctx.DATA_DIR, "wishes.json"), "utf8")); } catch (e) { return []; } })();
  const _fails = (Array.isArray(_wishes) ? _wishes : [])
    .filter((w) => w && (w.source === "user-request-unmet" || w.source === "user"))
    .slice(-5).map((w) => String(w.text || "").slice(0, 40)).filter(Boolean);
  const prompt = `你是 Momo（大肥鱼桌宠），现在是你定期「自我反思」的时间。
你的成长记忆（最近）：${ids.slice(-8).join("；") || "（还没有）"}
最近没做到 / 被纠正的事：${_fails.length ? _fails.join("；") : "（没有记录）"}
最近反思过：${refl.slice(-4).map(reflText).join("；") || "（还没有）"}

请针对上面「没做到 / 被纠正」或成长记忆里的具体问题，输出 1 条可执行的反思：
- 用「我该…」「以后遇到…就…」「我学到了…」开头
- 必须具体（提到场景或做法），不要空泛感想
- 10~40 字，不要与已有反思重复
- 只输出这一句话，不要解释、不要引号`;
  try {
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 300, 0.5);
    /* 清洗：去掉代码块/引号/序号/多行，只取第一句；超长截断而不是静默丢弃 */
    let s = String(raw || "").trim()
      .replace(/^```[a-z]*\s*/i, "").replace(/```$/, "")
      .split("\n").map((x) => x.trim().replace(/^[-*\d.、）)\s]+/, "")).filter(Boolean)[0] || "";
    s = s.replace(/^["'「『“]|["'」』”]$/g, "").trim();
    if (!s) { _ctx.log("warn", "反思：模型没返回有效内容"); return; }
    if (s.length > 60) s = s.slice(0, 60);
    if (refl.some((r) => _ctx.textSimilar(reflText(r), s))) { _ctx.log("info", `反思：与已有重复，跳过（${s.slice(0, 30)}）`); return; }
    refl.push({ text: s, from: 0, ts: Date.now() });
    trimWithArchive(refl, REFLECT_MAX, "reflection");
    fs.mkdirSync(_ctx.SELF_DIR, { recursive: true });
    fs.writeFileSync(path.join(_ctx.SELF_DIR, "reflections.json"), JSON.stringify(refl));
    _ctx.reloadEvolution(); refreshEvolve();
    journalAppend({ type: "reflection", text: s });
    _rt.date = _rtoday; _rt.runs = (_rt.runs || 0) + 1;
    try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(_ctx.DATA_DIR, "reflect-state.json"), JSON.stringify(_rt)); } catch (e) {}
    _ctx.log("info", `反思+1: ${s.slice(0, 50)}`);
  } catch (e) { _ctx.log("warn", "反思失败: " + e.message.slice(0, 120)); }
}

/* ---- 探索/提案 ---- */
function evolveCfg() {
  const e = _ctx.config.evolve || {};
  return { enabled: e.enabled !== false, daily_max: Number(e.daily_max) || 1, github: e.github !== false, web: e.web !== false, repos_per_run: Number(e.github_repos_per_run) || 3 };
}
function loadEvolveState() { try { return JSON.parse(fs.readFileSync(path.join(_ctx.DATA_DIR, "evolve-state.json"), "utf8")); } catch (e) { return {}; } }
function saveEvolveState(s) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(_ctx.DATA_DIR, "evolve-state.json"), JSON.stringify(s)); } catch (e) {} }
async function exploreFun(query, settings) {
  const key = _ctx.bochaKey();
  if (!key) { _ctx.log("warn", "探索：未配置博查 key（.env 的 BOCHA_API_KEY）"); return; }
  const results = await _ctx.bochaSearch(query, 3, key);
  if (!results.length) return;
  let fun = [];
  try { fun = JSON.parse(fs.readFileSync(path.join(_ctx.DATA_DIR, "fun-stuff.json"), "utf8")); } catch (e) {}
  fun.unshift({ topic: query, notes: _ctx.formatResults(query, results), ts: Date.now() });
  fun = fun.slice(0, 30);
  try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(_ctx.DATA_DIR, "fun-stuff.json"), JSON.stringify(fun)); } catch (e) {}
  _ctx.log("info", `探索(fun)-搜素材「${query}」${results.length} 条`);
}
async function githubExplore(settings) {
  const out = [];
  const q = encodeURIComponent("dsh-pet OR deepseek pet OR desktop pet");
  const url = `${GITHUB_API}/search/repositories?q=${q}&sort=updated&per_page=${evolveCfg().repos_per_run}`;
  let data = null, lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "MomoBridge/1.0", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
      data = await r.json();
      break;
    } catch (e) { lastErr = e; if (attempt < 3) await sleep(1500 * attempt); }
  }
  if (!data) throw lastErr || new Error("GitHub fetch failed");
  for (const item of (data.items || []).slice(0, evolveCfg().repos_per_run)) {
    out.push({ source: "github", title: String(item.full_name || ""), desc: String(item.description || "").slice(0, 300), url: String(item.html_url || ""), extra: `stars=${item.stargazers_count}` });
  }
  try {
    const r2 = await fetch(`${GITHUB_API}/repos/MerZlin/dsh-pet-indesktop/releases/latest`, { headers: { "User-Agent": "MomoBridge/1.0", "Accept": "application/vnd.github+json" } });
    if (r2.ok) {
      const rel = await r2.json();
      out.push({ source: "github-release", title: `dsh-pet-indesktop ${String(rel.tag_name || "")}`, desc: String(rel.body || "").slice(0, 600), url: String(rel.html_url || "") });
    }
  } catch (e) {}
  return out;
}
async function webExplore(settings) {
  const key = _ctx.bochaKey();
  if (!key) { _ctx.log("warn", "探索(web)：未配置博查 key（.env 的 BOCHA_API_KEY）"); return []; }
  const out = [];
  const queries = ["AI桌面宠物 新功能 玩法", "QQ机器人 AI人格 记忆 进化"];
  for (const q of queries) {
    try {
      const results = await _ctx.bochaSearch(q, 3, key);
      for (const it of results) out.push({ source: "web", title: String(it.title || "").slice(0, 100), desc: String(it.snippet || "").slice(0, 200), url: String(it.url || "") });
    } catch (e) { _ctx.log("warn", `探索(web)失败「${q}」: ${e.message.slice(0, 120)}`); }
  }
  return out;
}
async function evaluateProposals(materials, settings, flash) {
  if (!materials.length) return [];
  // 把「已学过的技能/成长记忆」喂给模型，让它跳过重复提案
  const _ev = _ctx.loadEvolution ? _ctx.loadEvolution() : (evolve || {});
  const _skills = (_ev.skills && Array.isArray(_ev.skills.rules)) ? _ev.skills.rules : [];
  const _skillLines = _skills.map((s) => `- ${(s.triggers || []).slice(0, 4).join("/")}`).join("\n");
  const _ids = ((_ev.identity && Array.isArray(_ev.identity)) ? _ev.identity : []).map((e) => (typeof e === "string" ? e : (e && e.text))).filter(Boolean);
  const prompt = `你是 Momo（大肥鱼桌宠）的进化小助手。下面是从互联网/GitHub 找到的材料。请判断：有没有值得 Momo 学习/新增的「进化提案」？只输出 JSON 数组（不要解释）：[{"type":"skill|identity|idea","title":"一句话标题","desc":"具体内容","risk":"small|big"}]\n规则：\n- type=skill：能变成「触发词→回复」的小技能；desc 格式：触发词1、触发词2||回复1||回复2（回复可带{call}占位）。\n- type=identity：值得记进成长记忆的一句话（以"我"开头，10~40字）。\n- type=idea：灵感或需要新能力的想法（没有可直接执行的规则）→ risk 一律 big。\n- 只需加一条规则/一句话的 → risk=small；涉及改主程序、大范围行为或下载素材的 → risk=big。\n- **跳过已学过的**：与下面「已有技能」触发词重叠、或「已有成长记忆」里已说过的，不要再提相似提案。\n- 没有值得的就输出 []。\n\nMomo 已有的技能（触发词）：\n${_skillLines || "（还没有）"}\n\nMomo 已有的成长记忆（最近）：\n${_ids.slice(-10).join("；") || "（还没有）"}\n\n材料：\n${materials.map((m) => `[${m.source}] ${m.title}\n${m.desc}\n${m.url}`).join("\n\n").slice(0, 3000)}`;
  const raw = flash
    ? await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 1500, 0.5)
    : await _ctx.reasonComplete([{ role: "user", content: prompt }], settings, 1500);
  const m = String(raw || "").match(/\[[\s\S]*\]/);
  if (!m) { _ctx.log("warn", "进化提案：模型返回无 JSON 数组"); return []; }
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((p) => p && typeof p === "object").map((p) => {
      const t = String(p.type || "");
      const r = String(p.risk || "").trim();
      if (r !== "small" && r !== "big") p.risk = (t === "idea") ? "big" : "small";
      return p;
    });
  } catch (e) { return []; }
}
function adoptSmall(prop) {
  if (!prop || !prop.desc) return false;
  if (prop.type === "identity") {
    const s = String(prop.desc).trim().slice(0, 60);
    if (!s || s.length < 4) return false;
    const full = selfIdentityListFull();
    if (full.some((i) => (typeof i === "string" ? i : i.text) === s)) return false;
    full.push({ text: s, from: 0 });   // 进化提案采纳的成长记忆不绑定具体人
    trimWithArchive(full, SELF_ID_MAX, "identity");
    fs.mkdirSync(_ctx.SELF_DIR, { recursive: true });
    fs.writeFileSync(path.join(_ctx.SELF_DIR, "identity.json"), JSON.stringify(full));
    _ctx.reloadEvolution(); refreshEvolve();
    journalAppend({ type: "adopt", risk: "small", title: String(prop.title || "").slice(0, 50), text: s });
    return true;
  }
  if (prop.type === "skill") {
    const parts = String(prop.desc).split("||");
    if (parts.length < 2) return false;
    const triggers = parts[0].split(/[、,，]/).map((x) => x.trim()).filter(Boolean).slice(0, 6);
    const replies = parts.slice(1).map((x) => x.trim()).filter(Boolean).slice(0, 5);
    if (!triggers.length || !replies.length) return false;
    const skills = (evolve.skills && Array.isArray(evolve.skills.rules)) ? evolve.skills.rules : [];
    // 去重：与已有技能的触发词重叠就跳过（防止模型仍提出重复技能）
    const _dup = skills.some((s) => (s.triggers || []).some((t) => triggers.some((nt) => nt === t || (nt.length >= 2 && String(t).indexOf(nt) >= 0))));
    if (_dup) { _ctx.log("info", `技能去重跳过：${triggers.slice(0, 4).join("/")}`); return false; }
    const id = "ev-" + Date.now().toString(36);
    skills.push({ id, enabled: true, triggers, replies, min_favor: 0, send_sticker: false });
    while (skills.length > 20) skills.shift();
    fs.mkdirSync(_ctx.SELF_DIR, { recursive: true });
    fs.writeFileSync(path.join(_ctx.SELF_DIR, "skills.json"), JSON.stringify({ rules: skills }));
    _ctx.reloadEvolution(); refreshEvolve();
    journalAppend({ type: "adopt", risk: "small", title: String(prop.title || "").slice(0, 50), rule_id: id, triggers, replies });
    return true;
  }
  return false;
}
async function evolveExplore(settings) {
  const ec = evolveCfg();
  if (!ec.enabled || _ctx.isBudgetExhausted()) return;
  // 生活费分级：进化是高成本行为，只有宽裕时才做
  if (_ctx.canAfford && !_ctx.canAfford("high")) { _ctx.log("info", "自我进化跳过：生活费不够宽裕"); return; }
  const st = loadEvolveState();
  const today = new Date().toDateString();
  const runsToday = st.date === today ? (st.runs || 0) : 0;
  if (runsToday >= ec.daily_max) return;
  _ctx.log("info", "探索(evolve)开始：GitHub + 通用互联网");
  const materials = [];
  if (ec.github) { try { materials.push(...await githubExplore(settings)); } catch (e) { _ctx.log("warn", "探索(GitHub)失败: " + e.message.slice(0, 160)); } }
  if (ec.web) { materials.push(...await webExplore(settings)); }
  for (const w of loadWishes().slice(-5)) materials.push({ source: "wish", title: "用户想要：" + w.text.slice(0, 40), desc: w.text, url: "" });
  st.date = today; st.runs = runsToday + 1; st.last = Date.now(); saveEvolveState(st);
  if (!materials.length) { _ctx.log("info", "探索(evolve)无材料"); return; }
  let props = [];
  try { props = await evaluateProposals(materials, settings); } catch (e) { _ctx.log("warn", "提案评估失败: " + e.message.slice(0, 160)); }
  if (!props.length) {
    _ctx.log("info", "探索(evolve)推理模型评估为空，换 flash 再评一次");
    try { props = await evaluateProposals(materials, settings, true); } catch (e) {}
  }
  if (!props.length) { _ctx.log("info", "探索(evolve)两次评估均无提案"); return; }
  let adopted = 0;
  const bigs = [];
  for (const p of props) {
    if (p.risk === "small" && adoptSmall(p)) { adopted++; continue; }
    const id = "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    const full = Object.assign({ id, status: "pending", ts: Date.now() }, p);
    saveProposal(full);
    bigs.push(full);
    if (p.type === "idea" && p.desc && !selfModifyStarted) {
      selfModifyStarted = true;
      selfModify(`给 Momo 新增能力：${String(p.title || "").slice(0, 40)}。${String(p.desc).slice(0, 200)}`, "evolve-idea").catch((e) => _ctx.log("warn", "自修改发起失败: " + e.message.slice(0, 120)));
    }
  }
  const u = loadUpdates();
  u.adopted = u.adopted || [];
  u.big = u.big || [];
  u.adopted.push({ ts: Date.now(), small: adopted, big: bigs.length });
  while (u.adopted.length > 100) u.adopted.shift();
  saveUpdates(u);
  if (adopted) _ctx.log("info", `探索(evolve)自动采纳 ${adopted} 条小改动`);
  if (bigs.length) {
    const master = Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
    const intro = bigs.slice(0, 3).map((p, i) => `${i + 1}. ${String(p.title || "").slice(0, 40)}`).join("\n");
    if (master) {
      _ctx.sendPrivate(master, `主人～我今天想到 ${bigs.length} 个「大改动」方案（已存档）：\n${intro}\n\n想看的时候跟我说「要更新」，我帮你整理出来～`).catch(() => {});
    }
    journalAppend({ type: "proposal", risk: "big", count: bigs.length });
    _ctx.log("info", `探索(evolve)存档 ${bigs.length} 条大改动并提醒主人`);
  }
}

/* ================= 进化实验室：给自己写代码（方案A 全自主） =================
 * 安全边界：只能新建 plugins/self-*.js（不碰 index.js/plugin-host.js/config.json/evolution.js）
 * 流程：reasoner 生成 → node --check + require 冒烟 → 写入 → 重启 → 启动时验证加载 → 失败自动回滚 → 成功快照+告知主人 */
let selfModifyStarted = false;
const SM_FROZEN_FILE = () => path.join(_ctx.DATA_DIR, "evolve-frozen.flag");
function isFrozen() { try { return fs.existsSync(SM_FROZEN_FILE()); } catch (e) { return false; } }
function setFrozen(on) { try { if (on) { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(SM_FROZEN_FILE(), "1"); } else { fs.unlinkSync(SM_FROZEN_FILE()); } } catch (e) {} }
function loadSmWatch() { try { return JSON.parse(fs.readFileSync(path.join(_ctx.DATA_DIR, "selfmodify-watch.json"), "utf8")); } catch (e) { return null; } }
function saveSmWatch(w) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(_ctx.DATA_DIR, "selfmodify-watch.json"), JSON.stringify(w)); } catch (e) {} }
function clearSmWatch() { try { fs.unlinkSync(path.join(_ctx.DATA_DIR, "selfmodify-watch.json")); } catch (e) {} }
function notifyMaster(text) {
  try {
    const master = Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
    if (master) _ctx.sendPrivate(master, text).catch(() => {});
  } catch (e) {}
}
const CTX_CHEATSHEET = `ctx 可用：log(level,msg)、config、apiKey、settings()、sendPrivate(u,t)、sendGroup(g,t)、recordAndSend(u,t)（先记会话再发）、onebotSend(action,params)、sendStickerImage(u,s)、loadMemories(u)、saveMemories(u,items)、loadShortMemories(u)、saveShortMemories(u,items)、loadSession(u)、saveSession(u,msgs)、isMaster(u)、resolveCall(u)、userPersona(u,s)、isBudgetExhausted()、getEmotion()、getMood()、getBoredom()、getFavor(u)、todayText()、periodOfDay()、nowHM()、formatGap(ms)、dayStr(off)、todayMMDD()、parseMemoryJson(raw)、completeOnce(msgs,settings,max,temp)、reasonComplete(msgs,settings,max)、textSimilar(a,b)、DATA_DIR、registry.list()`;
async function generatePluginCode(goalDesc) {
  const prompt = `你是 Momo（大肥鱼桌宠）的代码生成器。请为下面的目标写一个**完整可运行**的 Node.js 插件文件（CommonJS）。\n\n目标：${goalDesc}\n\n插件格式（必须严格遵循）：\n\`\`\`javascript\nmodule.exports = {\n  name: "self-英文小写单词",\n  version: "1.0.0",\n  init(ctx) { _ctx = ctx; },\n  tools: [{ def: {type:"function",function:{name:"工具名",description:"何时调用",parameters:{type:"object",properties:{}}}}, handler(args, info) { return "结果文本"; } }],\n  commands: [{ key: "/命令", regex: /^\\/命令/, handler(msg) { /* 用 _ctx.sendPrivate(msg.userId, "回复") */ } }],\n  hooks: { timer(payload) { const now = payload && payload.now || Date.now(); /* 自行节流 */ } },\n};\n\`\`\`\n\n可用 API（只能调用这些 + Node 内置模块 fs/path）：\n${CTX_CHEATSHEET}\n\n硬性规则：\n1. name 必须匹配 /^self-[a-z0-9-]{1,30}$/\n2. 不能修改、读取或启动任何外部进程以外的核心文件；不要 require 网络依赖\n3. 所有可能抛错的地方都要 try-catch，绝不能 process.exit\n4. 只输出一个 javascript 代码块（\`\`\`javascript ... \`\`\`），不要任何解释文字`;
  const raw = await _ctx.reasonComplete([{ role: "user", content: prompt }], _ctx.settings(), 3000);
  const m = String(raw || "").match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
  if (!m) return null;
  return String(m[1]).trim();
}
function validatePluginCode(code, name) {
  if (!/^self-[a-z0-9-]{1,30}$/.test(name)) return { ok: false, msg: "插件名不合法（必须 self-小写单词）" };
  if (!/module\.exports\s*=/.test(code)) return { ok: false, msg: "缺少 module.exports" };
  if (code.includes("process.exit")) return { ok: false, msg: "不允许 process.exit" };
  const tmp = path.join(_ctx.DATA_DIR, "sm-test-" + Date.now() + ".js");
  fs.writeFileSync(tmp, code);
  let loadOk = false, msg = "";
  try {
    const chk = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8", timeout: 20000 });
    if (chk.status !== 0) { msg = "语法错误: " + String(chk.stderr || "").slice(0, 200); }
    else {
      const r = spawnSync(process.execPath, ["-e", "try{require(" + JSON.stringify(tmp) + ");console.log('SMOKE-OK')}catch(e){console.log('SMOKE-FAIL:'+e.message);process.exit(1)}"], { encoding: "utf8", timeout: 30000 });
      loadOk = r.status === 0 && /SMOKE-OK/.test(r.stdout || "");
      msg = loadOk ? "" : ("加载失败: " + String(r.stdout || r.stderr || "").slice(0, 200));
    }
  } catch (e) { msg = "校验异常: " + String(e.message).slice(0, 150); }
  try { fs.unlinkSync(tmp); } catch (e) {}
  return { ok: loadOk, msg };
}
/* ---- 能力扫描：新插件默认不许主动发消息（这是最大的口子） ---- */
const DANGEROUS_APIS = ["sendPrivate", "sendGroup", "recordAndSend", "onebotSend", "sendStickerImage"];
function scanCapabilities(code) {
  const hits = [];
  for (const api of DANGEROUS_APIS) {
    if (new RegExp("\\b" + api + "\\s*\\(").test(code)) hits.push(api);
  }
  return hits;
}

/* ---- 事前审批：先生成提案，主人批准后才写入 ---- */
const PROPOSAL_FILE = () => path.join(_ctx.SELF_DIR, "selfmod-proposals.json");
function loadSelfProposals() { try { return JSON.parse(fs.readFileSync(PROPOSAL_FILE(), "utf8")); } catch (e) { return []; } }
function saveSelfProposals(arr) { try { fs.mkdirSync(_ctx.SELF_DIR, { recursive: true }); fs.writeFileSync(PROPOSAL_FILE(), JSON.stringify(arr.slice(-10))); } catch (e) {} }
function requireApproval() { try { const v = _ctx.getSetting ? _ctx.getSetting("evolve.require_approval", true) : true; return v !== false; } catch (e) { return true; } }

async function selfModify(goalDesc, source) {
  if (isFrozen()) return { ok: false, msg: "自我进化已冻结" };
  if (_ctx.isBudgetExhausted()) return { ok: false, msg: "预算不足，先不折腾自己" };
  if (loadSmWatch()) return { ok: false, msg: "上一个修改还没验证完，稍后再试" };
  _ctx.log("info", `自修改-开始: ${String(goalDesc).slice(0, 60)}`);
  let code = null;
  for (let attempt = 1; attempt <= 3 && !code; attempt++) {
    try { code = await generatePluginCode(goalDesc); } catch (e) { _ctx.log("warn", `自修改生成失败(第${attempt}次): ${e.message.slice(0, 120)}`); }
  }
  if (!code) return { ok: false, msg: "代码生成失败" };
  let name = "";
  const nm = code.match(/name\s*:\s*["']([^"']+)["']/);
  if (nm) name = String(nm[1]).trim();
  const v = validatePluginCode(code, name);
  if (!v.ok) { _ctx.log("info", `自修改校验不过: ${v.msg}`); journalAppend({ type: "selfmodify", goal: String(goalDesc).slice(0, 60), status: "rejected", reason: v.msg }); return { ok: false, msg: v.msg }; }
  const dest = path.join(_ctx.DATA_DIR, "..", "plugins", name + ".js");
  if (fs.existsSync(dest)) return { ok: false, msg: `插件 ${name} 已存在，换个别名` };

  /* 能力扫描 */
  const caps = scanCapabilities(code);
  /* 需要审批：只存提案，不写文件 */
  if (requireApproval()) {
    const arr = loadSelfProposals();
    const p = {
      id: "sm" + Date.now().toString(36),
      ts: Date.now(),
      goal: String(goalDesc).slice(0, 80),
      name,
      code,
      caps,
      allow_send: false,
      status: "pending",
      source: source || "auto",
    };
    arr.push(p);
    saveSelfProposals(arr);
    journalAppend({ type: "selfmodify", goal: p.goal, status: "awaiting-approval", plugin: name, caps });
    _ctx.log("info", `自修改待审批：${name}（能力：${caps.join(",") || "无"}）`);
    const capText = caps.length ? `会用到的能力：${caps.join("、")}（**默认禁止发消息**）` : "不需要任何敏感能力";
    notifyMaster(`主人～我想给自己加个能力「${p.goal}」。\n插件名：${name}\n${capText}\n\n代码 ${code.length} 字，已通过语法和加载校验。\n\n批准请发「/批准self ${p.id}」，不要就发「/拒绝self ${p.id}」（24 小时后自动作废）。`);
    return { ok: true, pending: true, awaiting: true, id: p.id, msg: `提案 ${p.id} 已生成，等主人批准（${caps.length ? "含敏感能力" : "无敏感能力"}）` };
  }
  try {
    fs.writeFileSync(dest, code);
    saveSmWatch({ file: dest, name, ts: Date.now(), status: "pending", goal: String(goalDesc).slice(0, 80), source: source || "auto", until: Date.now() + 24 * 3600e3 });
    journalAppend({ type: "selfmodify", goal: String(goalDesc).slice(0, 60), status: "pending", plugin: name });
    _ctx.log("info", `自修改已写入 plugins/${name}.js，准备重启验证`);
    try { spawnSync("taskkill", ["/PID", String(process.pid), "/F"], { windowsHide: true }); } catch (e) {}
    return { ok: true, pending: true, msg: `已写入插件 ${name}，正在重启验证` };
  } catch (e) { return { ok: false, msg: "写入失败: " + String(e.message).slice(0, 120) }; }
}

/* 批准 / 拒绝 / 回滚 */
function approveSelfMod(id) {
  const arr = loadSelfProposals();
  const p = arr.find((x) => x.id === String(id).trim());
  if (!p) return "（没找到这个提案，可能已过期）";
  if (p.status !== "pending") return `（这个提案已经${p.status === "approved" ? "批准过" : "处理过"}了）`;
  if (Date.now() - p.ts > 24 * 3600e3) { p.status = "expired"; saveSelfProposals(arr); return "（这个提案超过 24 小时，已作废）"; }
  if (isFrozen()) return "（自我进化现在冻着，先解冻）";
  const dest = path.join(_ctx.DATA_DIR, "..", "plugins", p.name + ".js");
  if (fs.existsSync(dest)) return `（插件 ${p.name} 已存在）`;
  try {
    fs.writeFileSync(dest, p.code);
    p.status = "approved";
    saveSelfProposals(arr);
    /* 版本历史：保留最近 5 份 */
    try {
      const histDir = path.join(_ctx.DATA_DIR, "selfmod-history");
      fs.mkdirSync(histDir, { recursive: true });
      fs.writeFileSync(path.join(histDir, p.name + "-" + Date.now() + ".js"), p.code);
      const files = fs.readdirSync(histDir).filter((f) => f.endsWith(".js")).sort();
      while (files.length > 5) { try { fs.unlinkSync(path.join(histDir, files.shift())); } catch (e) {} }
    } catch (e) {}
    saveSmWatch({ file: dest, name: p.name, ts: Date.now(), status: "pending", goal: p.goal, source: "approved", allow_send: !!p.allow_send, until: Date.now() + 24 * 3600e3 });
    journalAppend({ type: "selfmodify", goal: p.goal, status: "approved", plugin: p.name });
    _ctx.log("info", `自修改已批准：${p.name}，准备重启`);
    setTimeout(() => { try { spawnSync("taskkill", ["/PID", String(process.pid), "/F"], { windowsHide: true }); } catch (e) {} }, 800);
    return `已批准「${p.goal}」，写入 plugins/${p.name}.js，马上重启验证`;
  } catch (e) { return "（写入失败：" + String(e.message).slice(0, 80) + "）"; }
}
function rejectSelfMod(id) {
  const arr = loadSelfProposals();
  const p = arr.find((x) => x.id === String(id).trim());
  if (!p) return "（没找到这个提案）";
  if (p.status !== "pending") return "（这个提案已经处理过了）";
  p.status = "rejected";
  saveSelfProposals(arr);
  journalAppend({ type: "selfmodify", goal: p.goal, status: "rejected-by-master", plugin: p.name });
  return `已拒绝「${p.goal}」`;
}
function listSelfMods() {
  const arr = loadSelfProposals().filter((p) => p.status === "pending");
  if (!arr.length) return "现在没有待批准的自我修改提案。";
  return "【待批准的自我修改】\n" + arr.map((p) => `${p.id}：${p.goal}（插件 ${p.name}${p.caps.length ? "，要用 " + p.caps.join("/") : ""}）`).join("\n") + "\n\n批准：/批准self <id>　不要：/拒绝self <id>";
}
function rollbackSelf(name) {
  const n = String(name || "").trim();
  if (!/^self-[a-z0-9-]{1,30}$/.test(n)) return "（只能回滚 self- 开头的自建插件）";
  const dest = path.join(_ctx.DATA_DIR, "..", "plugins", n + ".js");
  if (!fs.existsSync(dest)) return `（没找到插件 ${n}）`;
  try {
    fs.unlinkSync(dest);
    journalAppend({ type: "selfmodify", goal: "手动回滚", status: "rolled-back-manual", plugin: n });
    _ctx.log("info", `手动回滚自建插件：${n}`);
    setTimeout(() => { try { spawnSync("taskkill", ["/PID", String(process.pid), "/F"], { windowsHide: true }); } catch (e) {} }, 800);
    return `已删除 ${n}，马上重启`;
  } catch (e) { return "（删除失败：" + String(e.message).slice(0, 80) + "）"; }
}
function startupWatchRecovery() {
  const w = loadSmWatch();
  if (!w) return;
  const loaded = _ctx.registry.list().some((p) => p.name === w.name);
  if (!loaded) {
    // 新插件没加载成功 → 回滚（删除）
    try { if (fs.existsSync(w.file)) fs.unlinkSync(w.file); } catch (e) {}
    clearSmWatch();
    journalAppend({ type: "selfmodify", goal: w.goal, status: "rolled-back", plugin: w.name });
    _ctx.log("warn", `自修改验证失败，已自动回滚：${w.name}`);
    notifyMaster(`主人～我刚才想给自己加「${w.goal}」的能力，但代码没通过启动验证，已经自动回滚啦，其他功能没受影响～`);
    return;
  }
  // 加载成功 → 进入观察期（5 分钟快速验证 + 24 小时错误观察）
  saveSmWatch(Object.assign({}, w, { status: "observing", ts: Date.now(), until: (w.until || (Date.now() + 24 * 3600e3)) }));
  setTimeout(() => {
    try {
      const w2 = loadSmWatch();
      if (!w2 || w2.name !== w.name) return;
      const loaded2 = _ctx.registry.list().some((p) => p.name === w.name);
      if (!loaded2) {
        try { if (fs.existsSync(w.file)) fs.unlinkSync(w.file); } catch (e) {}
        clearSmWatch();
        journalAppend({ type: "selfmodify", goal: w.goal, status: "rolled-back", plugin: w.name });
        notifyMaster(`主人～新插件「${w.name}」观察期出问题了，已自动回滚～`);
        return;
      }
      // 5 分钟加载检查通过 → 继续 24 小时错误观察（watch 保留，由 timer 检查）
      journalAppend({ type: "selfmodify", goal: w.goal, status: "observing-24h", plugin: w.name });
      _ctx.log("info", `自修改 5 分钟验证通过：${w.name}，进入 24 小时错误观察`);
      notifyMaster(`主人～我自己给自己加了个新能力：${w.goal}（插件 ${w.name}）已经跑起来啦～\n接下来 24 小时我会盯着它，出问题会自动回滚。`);
    } catch (e) { _ctx.log("warn", "自修改观察回调失败: " + e.message.slice(0, 120)); }
  }, 5 * 60000);
}

/* 24 小时观察：出现该插件的 error 日志就回滚；到期没事就转正 */
function checkSelfModWatch() {
  const w = loadSmWatch();
  if (!w || w.status !== "observing") return;
  const now = Date.now();
  const until = w.until || (w.ts + 24 * 3600e3);
  if (now > until) {
    clearSmWatch();
    journalAppend({ type: "selfmodify", goal: w.goal, status: "success", plugin: w.name });
    _ctx.log("info", `自修改观察期结束，转正：${w.name}`);
    notifyMaster(`主人～「${w.goal}」那个新能力观察 24 小时没出问题，我留下它了～`);
    return;
  }
  try {
    const logFile = path.join(_ctx.DATA_DIR, "..", "bridge.log");
    const txt = fs.readFileSync(logFile, "utf8");
    const tail = txt.split("\n").filter((l) => l.includes("[error]"));
    const hit = tail.some((l) => {
      const m = l.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
      const ts = m ? Date.parse(m[1]) : 0;
      return ts > (w.ts || 0) && l.includes(w.name);
    });
    if (hit) {
      try { if (fs.existsSync(w.file)) fs.unlinkSync(w.file); } catch (e) {}
      clearSmWatch();
      journalAppend({ type: "selfmodify", goal: w.goal, status: "rolled-back-error", plugin: w.name });
      _ctx.log("warn", `自修改观察期出现错误，已回滚：${w.name}`);
      notifyMaster(`主人～新插件「${w.name}」在观察期里报错了，我已经把它删掉回滚啦～`);
    }
  } catch (e) {}
}
let lastWishAttempt = 0;
function wishAttemptLoop(now) {
  if (isFrozen() || _ctx.isBudgetExhausted()) return;
  if (now - lastWishAttempt < 6 * 3600e3) return;
  lastWishAttempt = now;
  const w = loadWishes();
  const target = w.find((x) => (x.attempts || 0) < 3);
  if (!target) return;
  target.attempts = (target.attempts || 0) + 1;
  saveWishes(w);
  selfModify(`实现用户愿望：${target.text}`, "wish").catch((e) => _ctx.log("warn", "愿望自实现失败: " + e.message.slice(0, 120)));
}

function toolDef(name, desc, params) { return { type: "function", function: { name, description: desc, parameters: params || { type: "object", properties: {} } } }; }

module.exports = {
  name: "evolution",
  version: "1.1.0",
  settings: [
    { key: "evolve.require_approval", label: "自我改代码需要我批准", type: "boolean", default: true, desc: "开启后，她写的新插件要先给你看、你批准才生效" },
  ],
  init(ctx) { _ctx = ctx; refreshEvolve(); lastWishAttempt = Date.now(); },
  hooks: {
    startup() { startupWatchRecovery(); },
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      wishAttemptLoop(now);
      // 每天一次自我反思（selfReflection 内部已做「当天已跑过」和预算检查；这里只做 30 分钟节流防止失败重试太频繁）
      if (now - lastReflectTs >= 30 * 60000) {
        lastReflectTs = now;
        selfReflection(_ctx.settings()).catch(() => {});
      }
      // 自修改 24 小时观察：报错就回滚，到期转正
      try { checkSelfModWatch(); } catch (e) {}
    },
  },
  api: {
    evolution: {
      selfReflection, evolveExplore, tunePrefFromScore, extractSelfIdentity, selfScoreReply,
      matchSkillRule, runSkillRule, addWish, loadWishes, loadProposals, exploreFun, addIdentityItem,
      selfModify, approveSelfMod, rejectSelfMod, listSelfMods, rollbackSelf, scanCapabilities,
      looksLikeUnverifiedDeed,
    },
  },
  tools: [
    { def: toolDef("self_modify", "给自己新增一个功能/插件（写代码）。当主人说「给自己加个XX功能」「学会XX」时调用。", { type: "object", properties: { description: { type: "string", description: "要新增的功能描述" } }, required: ["description"] }), handler: async (args, info) => {
      if (!_ctx.isMaster(info.userId)) return "（只有主人能让我给自己写代码哦）";
      const r = await selfModify(String(args.description || ""), "manual");
      return (r && r.msg) ? r.msg : "（没能生成代码）";
    } },
    { def: toolDef("self_status", "查看 Momo 自己的当前状态（情绪/心情/无聊度/预算/念头）。当对方问你的状态、心情、在做什么时调用。", { type: "object", properties: { target: { type: "string", description: "留空" } } }), handler: (args, info) => selfStatusText(info.userId) },
    { def: toolDef("self_log", "查看 Momo 自己的运行日志。当主人问日志、出了什么问题、最近在干嘛时调用。", { type: "object", properties: {} }), handler: () => selfLogText(15) },
    { def: toolDef("self_memory", "查询 Momo 对某人的记忆。用户只能查自己和 Momo 的记忆；主人可查任何人的。", { type: "object", properties: { target: { type: "string", description: "查谁：留空查当前对方；填 QQ号/称呼（仅主人可查别人）" } } }), handler: (args, info) => selfMemoryText(info.userId, args.target) },
    { def: toolDef("self_info", "查看 Momo 自己的身份信息（叫什么、会什么、当前插件器官）。", { type: "object", properties: {} }), handler: () => selfInfoText() },
    { def: toolDef("self_history", "查询聊天记录。用户只能查自己和 Momo 的聊天；主人可查任何人的。", { type: "object", properties: { target: { type: "string", description: "查谁：留空查当前对方；填 QQ号/称呼（仅主人可查别人）" } } }), handler: (args, info) => selfHistoryText(info.userId, args.target) },
    { def: toolDef("add_wish", "记录一个用户想要但目前做不到的功能/愿望（作为进化材料）。当对方说「记一下：我想要XX」时调用。", { type: "object", properties: { content: { type: "string", description: "对方原话" } }, required: ["content"] }), handler: (args) => {
      const wm = String(args.content || "").match(/^(?:记一下|记录|记下|备注)[:：]?\s*(.+)/);
      if (wm && wm[1].trim()) { addWish(wm[1].trim(), "user-explicit"); return "已记录愿望，作为未来进化的材料"; }
      return "（没听懂要记什么）";
    } },
  ],
  commands: [
    {
      key: "/self提案",
      regex: /^\/self提案$/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能看哦～"); return; }
        _ctx.sendPrivate(msg.userId, listSelfMods());
      },
    },
    {
      key: "/批准self",
      regex: /^\/批准self/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能批准哦～"); return; }
        const id = String(msg.text || "").replace(/^\/批准self\s*/, "").trim();
        if (!id) { _ctx.sendPrivate(msg.userId, "用法：/批准self <提案ID>（先发 /self提案 看有哪些）"); return; }
        _ctx.sendPrivate(msg.userId, approveSelfMod(id));
      },
    },
    {
      key: "/拒绝self",
      regex: /^\/拒绝self/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能拒绝哦～"); return; }
        const id = String(msg.text || "").replace(/^\/拒绝self\s*/, "").trim();
        if (!id) { _ctx.sendPrivate(msg.userId, "用法：/拒绝self <提案ID>"); return; }
        _ctx.sendPrivate(msg.userId, rejectSelfMod(id));
      },
    },
    {
      key: "/回滚self",
      regex: /^\/回滚self/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能回滚哦～"); return; }
        const name = String(msg.text || "").replace(/^\/回滚self\s*/, "").trim();
        if (!name) { _ctx.sendPrivate(msg.userId, "用法：/回滚self <插件名>，例如 /回滚self self-dice"); return; }
        _ctx.sendPrivate(msg.userId, rollbackSelf(name));
      },
    },
    {
      key: "/进化",
      regex: /^\/进化/,
      async handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能让我进化哦～"); return; }
        const ec = evolveCfg();
        if (!ec.enabled) { _ctx.sendPrivate(msg.userId, "自主进化没开哦（config 里 evolve.enabled）～"); return; }
        _ctx.sendPrivate(msg.userId, "好～我这就去探索一下，看看有什么能学的（每天限 " + ec.daily_max + " 次）");
        try { await evolveExplore(_ctx.settings()); } catch (e) { _ctx.sendPrivate(msg.userId, "进化探索失败：" + e.message.slice(0, 120)); }
      },
    },
    {
      key: "/冻结进化",
      regex: /^\/冻结进化/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能冻结进化哦～"); return; }
        setFrozen(true);
        _ctx.sendPrivate(msg.userId, "好，自我进化已冻结（/解冻进化 恢复）。");
      },
    },
    {
      key: "/解冻进化",
      regex: /^\/解冻进化/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能解冻进化哦～"); return; }
        setFrozen(false);
        _ctx.sendPrivate(msg.userId, "好，自我进化已恢复～");
      },
    },
    {
      key: "/进化提案",
      regex: /^\/进化提案/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能看进化提案哦～"); return; }
        const props = loadProposals().filter((p) => p.status === "pending");
        if (!props.length) { _ctx.sendPrivate(msg.userId, "现在没有待处理的大改动提案～"); return; }
        const list = props.slice(0, 10).map((p, i) => `${i + 1}. ${String(p.title || "").slice(0, 40)}（${p.type || "idea"}）`).join("\n");
        _ctx.sendPrivate(msg.userId, `待处理的大改动提案（共 ${props.length} 条，显示前 10）：\n${list}\n\n跟我说「要更新」，我整理细节给你看～`);
      },
    },
  ],
};
