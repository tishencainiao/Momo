/* 插件：mind —— 心智数据层（念头 / 未想明白的事 / 待办意图 的存取）。
 * 纯辅助函数，无网络无模型调用；编排（perceiveMind/mindLoop/runMindAction 等）仍在 index.js。
 * 依赖经 ctx 注入：_ctx.DATA_DIR（数据目录）、_ctx.textSimilar（相似度去重）。
 * 注意：文件路径用懒加载 getter，模块加载时 _ctx 未就绪（M8 踩坑）。 */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const mindFile = () => path.join(_ctx.DATA_DIR, "mind.json");
const pendingFile = () => path.join(_ctx.DATA_DIR, "pending-nudges.json");

function loadMindState() { try { return JSON.parse(fs.readFileSync(mindFile(), "utf8")); } catch (e) { return { thoughts: [], last_think: 0 }; } }
function saveMindState(st) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(mindFile(), JSON.stringify(st)); } catch (e) {} }
/* 念头统一存成 {ts, text}（兼容旧的纯字符串），并最多留 100 条 */
function pushThought(st, t) {
  const txt = String(t || "").slice(0, 120);
  if (!txt) return;
  st.thoughts = st.thoughts || [];
  st.thoughts.push({ ts: Date.now(), text: txt });
  if (st.thoughts.length > 100) st.thoughts = st.thoughts.slice(-100);
}
function thoughtList(st) {
  return (st && st.thoughts ? st.thoughts : []).map((x) => (typeof x === "string" ? { ts: 0, text: x } : { ts: Number(x && x.ts) || 0, text: String((x && x.text) || "") }));
}
function thoughtTexts(st, n) { return thoughtList(st).slice(-(n || 6)).map((x) => x.text).filter(Boolean); }

/* ---- 可回溯（B）+ 未解决的事（C）：她想过的、还没想明白的，都留得住 ---- */
const OPEN_LOOP_MAX = 5;
const OPEN_LOOP_TTL = 3 * 86400e3;
function loadOpenLoops(st) {
  const arr = (st && Array.isArray(st.open_loops)) ? st.open_loops : [];
  const now = Date.now();
  return arr.filter((x) => x && x.text && (now - (Number(x.ts) || 0) < OPEN_LOOP_TTL)).slice(-OPEN_LOOP_MAX);
}
function pushOpenLoop(st, text) {
  const t = String(text || "").trim().slice(0, 80);
  if (!t) return;
  st.open_loops = loadOpenLoops(st);
  if (st.open_loops.some((x) => _ctx.textSimilar(x.text, t))) return;
  st.open_loops.push({ ts: Date.now(), text: t });
  if (st.open_loops.length > OPEN_LOOP_MAX) st.open_loops = st.open_loops.slice(-OPEN_LOOP_MAX);
}
function openLoopsText(st) {
  const arr = loadOpenLoops(st);
  if (!arr.length) return "";
  return "【你还有这些没想明白的事（可以接着想，也可以先放着）】\n" + arr.map((x, i) => `${i + 1}. ${x.text}`).join("\n");
}
function mindHistoryText(limit) {
  const st = loadMindState();
  const items = thoughtList(st).slice(-Math.max(1, Math.min(50, Number(limit) || 10)));
  const lines = items.map((x) => {
    const t = x.ts ? new Date(x.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "（早先）";
    return `${t} ${x.text}`;
  });
  let out = lines.length ? `【你最近的念头】\n${lines.join("\n")}` : "（最近还没有念头记录）";
  const loopLines = loadOpenLoops(st).map((x, i) => `${i + 1}. ${x.text}`);
  if (loopLines.length) out += `\n\n【还没想明白的事】\n${loopLines.join("\n")}`;
  return out;
}

/* ---- 待办意图（pending nudges） ---- */
function loadPending() { try { const a = JSON.parse(fs.readFileSync(pendingFile(), "utf8")); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function savePending(a) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(pendingFile(), JSON.stringify(a.slice(-40))); } catch (e) {} }
function addPendingNudge(item) {
  const arr = loadPending();
  const c = String(item.content || "").trim().slice(0, 160);
  if (!c) return false;
  if (arr.some((x) => _ctx.textSimilar(String(x.content || ""), c))) return false;
  arr.push({
    id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    ts: Date.now(),
    kind: String(item.kind || "talk"),
    content: c,
    score: Number(item.score) || 0,
    fact: false,                       // 这是"想法/待办"，不是"已经做成的事"
    source: "model-intent",
    expireAt: Date.now() + 3 * 86400e3,
  });
  savePending(arr);
  return true;
}
/* 取未过期的准备条目（顺手清理过期） */
function pendingNudgesText(limit) {
  const now = Date.now();
  const arr = loadPending().filter((x) => !x.expireAt || x.expireAt > now);
  savePending(arr);
  if (!arr.length) return "";
  return arr.slice(-(limit || 3)).map((x) => "- " + x.content).join("\n");
}
/* 用完一条就删掉（聊天时用掉） */
function consumePendingNudge(id) {
  const arr = loadPending().filter((x) => x.id !== id);
  savePending(arr);
}

/* ---- 价值评分：相关 + 信息缺口 + 新增价值 + 时效 ---- */
function scoreIntent(i) {
  const num = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  return 0.35 * num(i.relevance) + 0.20 * num(i.gap) + 0.25 * num(i.value) + 0.20 * num(i.timeliness);
}

module.exports = {
  name: "mind",
  init(ctx) { _ctx = ctx; },
  api: { mind: { loadMindState, saveMindState, pushThought, thoughtList, thoughtTexts, loadOpenLoops, pushOpenLoop, openLoopsText, mindHistoryText, loadPending, savePending, addPendingNudge, pendingNudgesText, consumePendingNudge, scoreIntent } },
};
