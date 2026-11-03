/* 插件：未完话头（主动问过的事，避免反复追问 / 可作为主动搭话的由头）
 * 数据：data/followups.json = [{id,userId,q,ts,status}]，最多保留 40 条 */
const fs = require("fs");
const path = require("path");
let _ctx = null;
const file = () => path.join(_ctx.DATA_DIR, "followups.json");
function load() { try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch (e) { return []; } }
function save(a) { try { fs.writeFileSync(file(), JSON.stringify(a.slice(-40))); } catch (e) {} }

function isQuestion(t) {
  const s = String(t || "").trim();
  if (!s || s.length > 150) return false;
  return /[？?]/.test(s) || /(吗|呢)[。！!~～]?$/.test(s);
}
function recordOutbound(userId, text) {
  if (!isQuestion(text)) return;
  const q = String(text).trim().slice(0, 100);
  const a = load();
  if (a.some((f) => f.userId === Number(userId) && f.q === q && f.status === "pending")) return;
  a.push({ id: "f" + Date.now().toString(36), userId: Number(userId), q, ts: Date.now(), status: "pending" });
  save(a);
}
function markAnswered(userId) {
  const a = load();
  let changed = false;
  for (const f of a) if (f.userId === Number(userId) && f.status === "pending") { f.status = "done"; f.doneAt = Date.now(); changed = true; }
  if (changed) save(a);
}
function pendingFor(userId) {
  const cutoff = Date.now() - 48 * 3600e3;
  return load().filter((f) => f.userId === Number(userId) && f.status === "pending" && f.ts >= cutoff);
}
function pendingCtx(userId) {
  const p = pendingFor(userId);
  if (!p.length) return "";
  return `你还惦记着之前问过「${p[p.length - 1].q}」，主人还没回你`;
}

module.exports = {
  name: "followup",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  api: { followup: { recordOutbound, markAnswered, pendingFor, pendingCtx } },
  hooks: {
    reply(payload) {
      const { userId, reply } = payload || {};
      if (!userId || !reply) return;
      markAnswered(userId);            // 用户开口了 → 之前的待答算揭过
      recordOutbound(userId, reply);   // 这轮若又问了问题，记成新的待答
    },
  },
};

