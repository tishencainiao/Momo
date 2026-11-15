/* 框架服务 · 记忆（S5，骨骼方案最后一期）
 * 长期/短期记忆的「存取 + 检索 + 注入配方」唯一真相。
 * 与 plugins/memory.js 分工：memory.js=事实抽取/固化（EXTRACT_BATCH→长期），本服务=注入/检索。
 * 旧 index.js 函数已降级薄转发（绞杀者模式，两版提交可回滚）。
 */
const fs = require("fs");
const path = require("path");

let _ctx = null;

const MEM_DIR = () => path.join(_ctx.DATA_DIR, "memory");
const SHORT_MEM_DIR = () => path.join(_ctx.DATA_DIR, "short-memory");
const SHORT_MEM_TTL_SEC = 7 * 86400;

function memPath(userId) { return path.join(MEM_DIR(), String(userId) + ".json"); }
function shortMemFile(userId) { return path.join(SHORT_MEM_DIR(), String(userId) + ".json"); }

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
    fs.mkdirSync(MEM_DIR(), { recursive: true });
    let outItems = items || [];
    outItems = outItems.map((it) => Object.assign({}, it, { from: Number(it.from) || Number(userId) || 0 }));
    try {
      const _ra = _ctx.getApi ? _ctx.getApi("roles") : null;
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
  const ordered = items.slice().sort((a, b) => (a.source === "taught" ? 1 : 0) - (b.source === "taught" ? 1 : 0));
  const lines = ordered.slice(-20).map((m) => {
    let tsMs = 0;
    if (m.time) { try { tsMs = new Date(m.time).getTime(); } catch (e) {} }
    else if (m.created) tsMs = Number(m.created) * 1000;
    else if (m.created_at) { try { tsMs = new Date(m.created_at).getTime(); } catch (e) {} }
    const gap = (tsMs && _ctx.formatGap) ? `（${_ctx.formatGap(Date.now() - tsMs)}前）` : "";
    const tag = m.source === "taught" ? "【主人亲自教的】" : "";
    return "- " + tag + String(m.content).slice(0, 200) + gap;
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
  for (let i = 0; i + 1 < cn.length; i++) out.add(cn.slice(i, i + 2));
  for (let i = 0; i + 2 < cn.length; i++) out.add(cn.slice(i, i + 3));
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

/* ---- 短期记忆 ---- */
function loadShortMemories(userId) {
  try { const d = JSON.parse(fs.readFileSync(shortMemFile(userId), "utf8")); if (Array.isArray(d.items)) return d.items.filter((i) => i && i.content); } catch (e) {}
  return [];
}
function saveShortMemories(userId, items) {
  try { fs.mkdirSync(SHORT_MEM_DIR(), { recursive: true }); fs.writeFileSync(shortMemFile(userId), JSON.stringify({ updated: Date.now(), items })); }
  catch (e) { try { _ctx.log("warn", "短期记忆保存失败: " + e.message.slice(0, 160)); } catch (e2) {} }
}
function pruneShortMemories(userId) {
  const items = loadShortMemories(userId);
  const nowSec = Date.now() / 1000;
  const fresh = items.filter((m) => nowSec - (Number(m.created) || nowSec) < SHORT_MEM_TTL_SEC);
  if (fresh.length !== items.length) saveShortMemories(userId, fresh);
  return fresh;
}

module.exports = {
  name: "memory-service",
  displayName: "框架服务 · 记忆",
  description: "长期/短期记忆的存取+检索+注入配方唯一真相（S5 收口）。memory.js 管抽取固化，本服务管注入检索。",
  version: "1.0.0",
  engines: { kernel: ">=1.97.1" },
  requires: ["time"],
  permissions: ["config", "DATA_DIR", "formatGap", "getApi", "log"],
  userScoped: true,
  system: true,
  attribution: { source: "self", license: "self-generated", note: "从 index.js 记忆块逐字迁出（S5 骨骼方案）" },
  init(ctx) { _ctx = ctx; },
  api: {
    memory: {
      memPath, loadMemories, topMemories, saveMemories, memoryPrompt, memoryIndexPrompt,
      shortMemoryPrompt, simpleKeywords, lev, retrieveMemories, parseMemoryJson,
      shortMemFile, loadShortMemories, saveShortMemories, pruneShortMemories, SYNONYM_MAP,
    },
  },
  apiSpec: {
    memory: {
      memPath: { input: "userId", output: "记忆文件路径", sideEffect: "只读" },
      loadMemories: { input: "userId", output: "长期记忆数组", sideEffect: "只读" },
      topMemories: { input: "items,n", output: "重要度前 n 条", sideEffect: "只读" },
      saveMemories: { input: "userId,items", output: "无", sideEffect: "写盘" },
      memoryPrompt: { input: "items,call", output: "长期记忆注入文案", sideEffect: "只读" },
      memoryIndexPrompt: { input: "items,call", output: "记忆索引注入文案", sideEffect: "只读" },
      shortMemoryPrompt: { input: "items,call", output: "短期记忆注入文案", sideEffect: "只读" },
      simpleKeywords: { input: "文本", output: "关键词数组", sideEffect: "只读" },
      lev: { input: "a,b", output: "编辑距离", sideEffect: "只读" },
      retrieveMemories: { input: "memories,userText,limit", output: "相关记忆数组", sideEffect: "只读" },
      parseMemoryJson: { input: "raw", output: "记忆文本数组", sideEffect: "只读" },
      shortMemFile: { input: "userId", output: "短期记忆路径", sideEffect: "只读" },
      loadShortMemories: { input: "userId", output: "短期记忆数组", sideEffect: "只读" },
      saveShortMemories: { input: "userId,items", output: "无", sideEffect: "写盘" },
      pruneShortMemories: { input: "userId", output: "未过期短期记忆", sideEffect: "写盘" },
      SYNONYM_MAP: { input: "无", output: "同义词表", sideEffect: "只读" },
    },
  },
};
