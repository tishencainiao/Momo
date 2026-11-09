/* 插件：元认知（metacognition）
 * 每轮回复后自评（纯规则、不花钱）→ 超标就提醒下一次
 * 每天一次自我复盘 → 写进成长记忆
 * 参考 Agentic Metacognition（arXiv:2509.19783）的「次级监控层」思路，但只用规则，不加 LLM 开销 */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const STATE = () => path.join(_ctx.DATA_DIR, "meta-cog.json");
const REPLIES = () => path.join(_ctx.DATA_DIR, "replies.jsonl");
const FRESH_MS = 30 * 60000;      // 提醒有效期
const MAX_ISSUES = 3;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE(), "utf8")); } catch (e) { return {}; }
}
function saveState(s) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(STATE(), JSON.stringify(s)); } catch (e) {} }

const CLICHE = /作为(一个)?(AI|人工智能|语言模型|助手)|我是(AI|人工智能|语言模型)|综上所述|让我来为你|以下是[我你]?为|当然可以[，,]?让我/;

function readReplies(n) {
  try {
    const lines = fs.readFileSync(REPLIES(), "utf8").split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

/* 对一条回复做自评，返回问题列表 */
function analyze(reply, prevTexts) {
  const t = String(reply || "");
  const out = [];
  if (!t) return out;
  if (CLICHE.test(t)) out.push({ type: "ai", text: "刚才那句有点像 AI 客服，别用套话，直接说人话" });
  if (t.length > 300) out.push({ type: "long", text: "刚才回得太长了，下次短一点" });
  if (/[（(][^）)]{1,20}[）)]/.test(t)) out.push({ type: "bracket", text: "刚才用括号写动作了，情绪直接说出来" });
  const head = t.replace(/^[\s，。,.\u3000]+/, "").slice(0, 2);
  if (head.length >= 2) {
    const same = (prevTexts || []).slice(-3).filter((p) => String(p || "").replace(/^[\s，。,.\u3000]+/, "").startsWith(head));
    if (same.length >= 2) out.push({ type: "repeat", text: `最近老用「${head}」开头，换个说法` });
  }
  return out;
}

/* 记录一轮回复 */
function observe(reply) {
  const s = loadState();
  s.stats = s.stats || { total: 0, ai: 0, long: 0, bracket: 0, repeat: 0 };
  s.issues = Array.isArray(s.issues) ? s.issues : [];
  const prev = readReplies(6).map((r) => r.text).slice(0, -1);   // 排除刚写入的这条
  const found = analyze(reply, prev);
  s.stats.total++;
  for (const f of found) {
    s.stats[f.type] = (s.stats[f.type] || 0) + 1;
    s.issues.push({ ts: Date.now(), type: f.type, text: f.text });
  }
  if (s.issues.length > 20) s.issues = s.issues.slice(-20);
  const day = _ctx.dayStr(0);
  s.days = s.days || {};
  s.days[day] = s.days[day] || { total: 0, ai: 0, long: 0, bracket: 0, repeat: 0 };
  s.days[day].total++;
  for (const f of found) s.days[day][f.type] = (s.days[day][f.type] || 0) + 1;
  saveState(s);
  return found;
}

/* 注入用：最近没处理的问题（30 分钟内，最多 3 条） */
function metaCtx() {
  const s = loadState();
  const now = Date.now();
  const fresh = (s.issues || []).filter((i) => now - (i.ts || 0) < FRESH_MS);
  if (!fresh.length) return "";
  const seen = new Set();
  const picked = [];
  for (const i of fresh.slice(-6)) {
    if (seen.has(i.text)) continue;
    seen.add(i.text);
    picked.push(i.text);
    if (picked.length >= MAX_ISSUES) break;
  }
  if (!picked.length) return "";
  return `【你对自己刚才表现的觉察（不是别人说你，是你自己发现的；自然地改，别说出来）】\n` + picked.map((t) => "- " + t).join("\n");
}

/* 每天一次自我复盘：写入成长记忆 */
function dailyReflect() {
  const s = loadState();
  const day = _ctx.dayStr(0);
  if (s.lastReflect === day) return "";
  const d = (s.days && s.days[day]) || null;
  s.lastReflect = day;
  saveState(s);
  if (!d || d.total < 5) return "";
  const parts = [];
  if (d.repeat >= 3) parts.push(`老用同一个开头（${d.repeat} 次）`);
  if (d.ai >= 2) parts.push(`说套话（${d.ai} 次）`);
  if (d.bracket >= 2) parts.push(`用括号写动作（${d.bracket} 次）`);
  if (d.long >= 2) parts.push(`回太长（${d.long} 次）`);
  if (!parts.length) return "";
  const text = `我今天发现自己${parts.join("、")}，明天要注意`;
  try {
    const ev = _ctx.getApi && _ctx.getApi("evolution");
    const master = Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
    if (ev && ev.addIdentityItem) ev.addIdentityItem(text, master);
  } catch (e) {}
  _ctx.log("info", `元认知复盘：${text}`);
  return text;
}

module.exports = {
  name: "meta-cog",
  displayName: "元认知",
  description: "逐条统计 + 提醒注入 + 每日复盘",
  permissions: ["DATA_DIR", "config", "dayStr", "getApi", "getSetting", "log"],
  version: "1.1.0",
  attribution: {
    source: "Agentic Metacognition (arXiv:2509.19783)",
    license: "论文（无源码，仅参考思路）",
    note: "「次级监控层」思路，只用规则不加 LLM 开销",
    importedAt: "2026-11-09",
  },
  init(ctx) { _ctx = ctx; },
  settings: [
    { key: "metacog.enabled", label: "自我觉察提醒", type: "boolean", default: true, desc: "发现自己说套话/复读/太长时，下一轮自己改" },
  ],
  apiSpec: {"metaCog":{"metaCtx":{"input":"","output":"","sideEffect":""},"observe":{"input":"","output":"","sideEffect":""},"analyze":{"input":"","output":"","sideEffect":""},"dailyReflect":{"input":"","output":"","sideEffect":""},"loadState":{"input":"","output":"","sideEffect":"只读"}}},

  api: { metaCog: { metaCtx, observe, analyze, dailyReflect, loadState } },
  /* 本插件只做逐条统计 + 提醒注入 + 每日复盘（自我体检已删除，报告整合进 report.js） */
  hooks: {
    reply(payload) {
      try {
        if (!_ctx.getSetting || _ctx.getSetting("metacog.enabled", true) !== false) observe((payload && payload.reply) || "");
      } catch (e) {}
    },
    timer() {
      try { dailyReflect(); } catch (e) {}
    },
  },
};
