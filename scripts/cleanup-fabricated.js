/* 一次性清理：把"捏造能力/经历"污染的数据归档掉（不硬删，可回滚）
 * 用法：
 *   node scripts/cleanup-fabricated.js --dry-run     # 只列出会动哪些条目（默认）
 *   node scripts/cleanup-fabricated.js --apply       # 真正执行归档
 * 背景：2026-11-05 Momo 声称"攒了几首轻音乐，我这就放给你听"，并演了两分钟；
 *       这段表演被写进 identity/journal/short-memory，必须清掉，否则修复后仍会被回灌。
 * 归档走 self-archive.js（data/archive/<kind>-YYYY-MM.jsonl，带 reason），不硬删。 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { appendArchive } = require(path.join(ROOT, "self-archive.js"));

const DATA = path.join(ROOT, "data");
const SELF = path.join(ROOT, "self");
const APPLY = process.argv.indexOf("--apply") >= 0;

/* 命中规则：她的"放音乐/唱歌"类表演 */
const CLAIM_RE = /(轻音乐|放歌|放音乐|放给你听|放着听|放点轻的|唱给你听|音乐软件)/;
const DEED_RE = /(我攒了|我放了|我能|我这就|接受|放给|放着|放点)/;

function hit(text) {
  const s = String(text || "");
  return CLAIM_RE.test(s) && DEED_RE.test(s);
}

function loadJson(p, def) {
  try { const d = JSON.parse(fs.readFileSync(p, "utf8")); return d == null ? def : d; } catch (e) { return def; }
}
function saveJson(p, v) {
  if (!APPLY) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v));
}

const report = { identity: [], journal: [], shortMemory: [], pendingNudges: [], profile: [] };

/* 1) self/identity.json（成长记忆） */
(function cleanIdentity() {
  const p = path.join(SELF, "identity.json");
  const arr = loadJson(p, null);
  if (!Array.isArray(arr)) return;
  const keep = [];
  for (const it of arr) {
    const text = (typeof it === "string") ? it : (it && it.text);
    if (text && hit(text)) { report.identity.push(text); continue; }
    keep.push(it);
  }
  if (report.identity.length) {
    if (APPLY) appendArchive(DATA, "identity", report.identity.map((t) => ({ ts: Date.now(), text: t, reason: "fabricated-capability-claim" })));
    saveJson(p, keep);
  }
})();

/* 2) self/journal.json（日记里的同一条） */
(function cleanJournal() {
  const p = path.join(SELF, "journal.json");
  const arr = loadJson(p, null);
  if (!Array.isArray(arr)) return;
  const keep = [];
  for (const it of arr) {
    const text = it && it.text;
    if (text && hit(text)) { report.journal.push(text); continue; }
    keep.push(it);
  }
  if (report.journal.length) {
    if (APPLY) appendArchive(DATA, "journal", report.journal.map((t) => ({ ts: Date.now(), text: t, reason: "fabricated-capability-claim" })));
    saveJson(p, keep);
  }
})();

/* 3) data/short-memory/<uid>.json（关于对方的事实里混进了她的表演） */
(function cleanShortMemory() {
  const dir = path.join(DATA, "short-memory");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch (e) { return; }
  for (const f of files) {
    const p = path.join(dir, f);
    const d = loadJson(p, null);
    const items = (d && Array.isArray(d.items)) ? d.items : (Array.isArray(d) ? d : null);
    if (!items) continue;
    const keep = [];
    const removed = [];
    for (const it of items) {
      if (it && it.content && hit(it.content)) { removed.push(it.content); continue; }
      keep.push(it);
    }
    if (!removed.length) continue;
    report.shortMemory.push({ file: f, items: removed });
    if (APPLY) appendArchive(DATA, "short-memory", removed.map((t) => ({ ts: Date.now(), text: t, reason: "fabricated-capability-claim" })));
    const out = Array.isArray(d) ? keep : Object.assign({}, d, { items: keep });
    saveJson(p, out);
  }
})();

/* 4) data/pending-nudges.json（自写意图补 fact:false，不删——它是"想做"不是"做过"） */
(function cleanNudges() {
  const p = path.join(DATA, "pending-nudges.json");
  const arr = loadJson(p, null);
  if (!Array.isArray(arr)) return;
  let changed = false;
  for (const it of arr) {
    if (it && it.content && CLAIM_RE.test(String(it.content))) {
      if (it.fact !== false) { it.fact = false; it.source = it.source || "model-intent"; changed = true; }
      report.pendingNudges.push(it.content);
    }
  }
  if (changed) saveJson(p, arr);
})();

/* 5) data/user-profile.json（对方画像里被写进的"接受大肥鱼放…"） */
(function cleanProfile() {
  const p = path.join(DATA, "user-profile.json");
  const all = loadJson(p, null);
  if (!all || typeof all !== "object") return;
  let changed = false;
  for (const uid of Object.keys(all)) {
    const prof = all[uid];
    if (!prof || typeof prof !== "object") continue;
    for (const k of ["interests", "preferences", "personality"]) {
      if (!Array.isArray(prof[k])) continue;
      const keep = prof[k].filter((x) => {
        const bad = hit(x);
        if (bad) report.profile.push(String(x));
        return !bad;
      });
      if (keep.length !== prof[k].length) { prof[k] = keep; changed = true; }
    }
  }
  if (changed) saveJson(p, all);
})();

const total = report.identity.length + report.journal.length + report.shortMemory.reduce((n, x) => n + x.items.length, 0) + report.profile.length;
console.log(`【${APPLY ? "执行" : "预演"}】发现需清理条目 ${total} 条${APPLY ? "，已归档到 data/archive/" : "（加 --apply 才会真的动文件）"}`);
for (const k of ["identity", "journal"]) if (report[k].length) report[k].forEach((t) => console.log(`  ${k}: ${t}`));
for (const x of report.shortMemory) x.items.forEach((t) => console.log(`  short-memory/${x.file}: ${t}`));
for (const t of report.profile) console.log(`  user-profile: ${t}`);
if (report.pendingNudges.length) console.log(`  pending-nudges: ${report.pendingNudges.length} 条已标记 fact:false（保留为"想做"）`);
if (!total && !report.pendingNudges.length) console.log("  没有发现需要清理的内容");
