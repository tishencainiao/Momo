/* 插件：兴趣档案（爱好）+ 收藏夹
 * 目标：让"反复做过的事"慢慢变成"她真的喜欢什么"，而不是模型一次嘴硬。
 * 规则（主人拍板）：
 *   - 每次娱乐活动投一个主题标签（topic）
 *   - 同一主题 ≥3 次证据 且 跨 ≥2 天 → 从 pending 升为 hobby
 *   - 30 天无新证据开始降信心，60 天降回 pending 归档
 *   - 只把 hobby 前 2 个注入上下文（避免注意力稀释）
 * 文件：self/interests.json、self/collection.json */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const DECAY_AFTER_DAYS = 30;
const DEMOTE_AFTER_DAYS = 60;
const DAY = 86400e3;

const interestsFile = () => path.join(_ctx.SELF_DIR, "interests.json");
const collectionFile = () => path.join(_ctx.SELF_DIR, "collection.json");

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(interestsFile(), "utf8"));
    if (d && typeof d === "object") { d.interests = Array.isArray(d.interests) ? d.interests : []; d.pending = Array.isArray(d.pending) ? d.pending : []; return d; }
  } catch (e) {}
  return { interests: [], pending: [] };
}
function save(d) { try { fs.mkdirSync(_ctx.SELF_DIR, { recursive: true }); fs.writeFileSync(interestsFile(), JSON.stringify(d)); } catch (e) {} }

function minEvidence() { return Number(_ctx.getSetting("interest.min_evidence", 3)) || 3; }
function minDays() { return Number(_ctx.getSetting("interest.min_days", 2)) || 2; }
function dayKey(ts) { const d = new Date(ts || Date.now()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

/* 投一票：key=主题词，type=read|play|buzz，evidence=凭据对象（可空） */
function vote(key, type, evidence) {
  const k = String(key || "").trim().slice(0, 20);
  if (!k) return null;
  const now = Date.now();
  const day = dayKey(now);
  const d = load();
  let item = d.pending.find((x) => x.key === k && x.type === type) || d.interests.find((x) => x.key === k && x.type === type);
  if (!item) { item = { key: k, type, count: 0, days: [], evidence: [], level: "pending", confidence: 0.2, first_seen: now }; d.pending.push(item); }
  item.count = (Number(item.count) || 0) + 1;
  item.days = Array.isArray(item.days) ? item.days : [];
  if (item.days.indexOf(day) < 0) item.days.push(day);
  item.days = item.days.slice(-30);
  item.last_seen = now;
  if (evidence) { item.evidence = (item.evidence || []).concat([Object.assign({ ts: now, day }, evidence)]).slice(-12); }
  item.confidence = Math.min(1, 0.2 + 0.15 * item.count);
  /* 升级：证据够 + 跨天够 */
  if (item.level !== "hobby" && item.count >= minEvidence() && item.days.length >= minDays()) {
    item.level = "hobby";
    item.confidence = Math.max(item.confidence, 0.7);
    item.hobby_since = now;
    const i = d.pending.indexOf(item);
    if (i >= 0) d.pending.splice(i, 1);
    if (!d.interests.some((x) => x.key === item.key && x.type === item.type)) d.interests.push(item);
  }
  save(d);
  return item;
}

/* 衰减：30 天没新证据降信心；60 天降回 pending 归档 */
function decay() {
  const d = load();
  const now = Date.now();
  let changed = false;
  for (const item of d.interests) {
    const ageDays = (now - (Number(item.last_seen) || now)) / DAY;
    if (ageDays >= DEMOTE_AFTER_DAYS) {
      item.level = "pending";
      item.confidence = 0.2;
      d.pending.push(item);
      changed = true;
    } else if (ageDays >= DECAY_AFTER_DAYS) {
      item.confidence = Math.max(0.2, (Number(item.confidence) || 0.5) * 0.98);
      changed = true;
    }
  }
  if (changed) {
    d.interests = d.interests.filter((x) => x.level === "hobby");
    save(d);
  }
  return d;
}

/* 注入上下文：只给 hobby 前 2 个（按信心×次数排序） */
function hobbyText(limit) {
  const d = decay();
  const list = (d.interests || []).filter((x) => x.level === "hobby")
    .sort((a, b) => ((b.confidence || 0) * Math.log((b.count || 1) + 1)) - ((a.confidence || 0) * Math.log((a.count || 1) + 1)))
    .slice(0, limit || 2);
  if (!list.length) return "";
  const names = list.map((x) => (x.type === "play" ? x.key : x.key)).join("、");
  const detail = list.map((x) => `${x.key}（${x.count} 次）`).join("、");
  return `【你最近的爱好】${names}。它们的来历：${detail}——这些是你真的反复做过的，不是别人告诉你的。`;
}

/* ---------------- 收藏夹：只收她真的从接口拿到过的句子 ---------------- */
function loadCollection() { try { const d = JSON.parse(fs.readFileSync(collectionFile(), "utf8")); return Array.isArray(d) ? d : []; } catch (e) { return []; } }
function saveCollection(list) { try { fs.mkdirSync(_ctx.SELF_DIR, { recursive: true }); fs.writeFileSync(collectionFile(), JSON.stringify(list.slice(-300))); } catch (e) {} }
/* quote 必须能在 sourceText 里找到（防编造）；找不到直接丢 */
function collect(quote, sourceUrl, sourceText, kind) {
  const q = String(quote || "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (!q || q.length < 6) return null;
  const src = String(sourceText || "").replace(/\s+/g, " ");
  if (src && src.indexOf(q) < 0) { _ctx.log("warn", "收藏丢弃：引文在原文里找不到"); return null; }
  const list = loadCollection();
  if (list.some((x) => x.quote === q)) return null;
  const rec = { ts: Date.now(), quote: q, from: String(kind || "read"), url: String(sourceUrl || "").slice(0, 300) };
  list.push(rec);
  saveCollection(list);
  return rec;
}

module.exports = {
  name: "hobby",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  settings: [
    { key: "interest.min_evidence", label: "升为「爱好」需要的证据次数", type: "number", default: 3, min: 2, max: 10, desc: "同一主题累积几次才算喜欢" },
    { key: "interest.min_days", label: "升为「爱好」需要跨几天", type: "number", default: 2, min: 2, max: 14, desc: "防止听了一次就永远喜欢" },
  ],
  api: { hobby: { load, save, vote, decay, hobbyText, loadCollection, collect } },
};
