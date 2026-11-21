#!/usr/bin/env node
/* 成长记忆审查脚本（阶段三）：默认 dry-run 只报告，--apply 才动手。
 * 检查项：①近重复条目 ②主题聚集 ③物理经历待核实 ④verified:false 待核实清单 ⑤历史遗留的 self-report 却 verified:true。
 * 用法：node scripts/audit-identity.js [--apply]
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SELF = path.join(ROOT, "self");
const APPLY = process.argv.includes("--apply");
const DOWNGRADE = process.argv.includes("--downgrade");

function load(f) {
  const p = path.join(SELF, f);
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return []; }
}
function norm(s) { return String(s || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ""); }
function bigrams(s) {
  const t = norm(s); const set = new Set();
  for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
  return set;
}
function nearDup(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  const cap = Math.min(na.length, nb.length);
  let pref = 0; while (pref < cap && na[pref] === nb[pref]) pref++;
  if (pref >= 12) return true;
  const A = new Set(na), B = new Set(nb);
  let hit = 0; for (const c of A) if (B.has(c)) hit++;
  const charRatio = hit / Math.max(A.size, 1);
  if (charRatio > 0.75 && Math.min(na.length, nb.length) >= 4) return true;
  const ga = bigrams(na), gb = bigrams(nb);
  let c = 0; for (const g of ga) if (gb.has(g)) c++;
  return c / Math.max(1, Math.min(ga.size, gb.size)) > 0.5;
}
const items = load("identity.json");
const list = Array.isArray(items) ? items : (items && items.items) || [];
const rep = [];
for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
  const a = typeof list[i] === "string" ? list[i] : list[i].text;
  const b = typeof list[j] === "string" ? list[j] : list[j].text;
  if (a === b) continue;
  if (nearDup(a, b)) rep.push([i, j, String(a).slice(0, 24), String(b).slice(0, 24)]);
}
const topics = {};
for (const e of list) {
  const t = typeof e === "string" ? e : (e && e.text) || "";
  const key = norm(t).slice(0, 6) || "misc";
  (topics[key] = topics[key] || []).push(t);
}
const hotTopics = Object.entries(topics).filter(([, v]) => v.length >= 4).sort((x, y) => y[1].length - x[1].length);
const physical = list.filter((e) => typeof e !== "string" && e.kind === "physical-claim");
const unverified = list.filter((e) => typeof e !== "string" && (e.verified === false || e.kind === "self-claim"));
const legacyFact = list.filter((e) => typeof e !== "string" && e.verified === true && (e.kind === "self-report" || e.kind === "physical-claim"));

console.log(`=== 成长记忆审查（${APPLY ? "APPLY" : "DRY-RUN"}）===`);
console.log(`条目总数: ${list.length}`);
console.log(`① 近重复对: ${rep.length}`); rep.slice(0, 10).forEach(([i, j, a, b]) => console.log(`   #${i} 「${a}」 ~ #${j} 「${b}」`));
console.log(`② 主题聚集(≥4条): ${hotTopics.length}`); hotTopics.slice(0, 8).forEach(([k, v]) => console.log(`   [${k}] ${v.length} 条, 例: ${v[0].slice(0, 30)}`));
console.log(`③ 物理经历待核实: ${physical.length}`); physical.slice(0, 8).forEach((e) => console.log(`   「${String(e.text).slice(0, 40)}」`));
console.log(`④ 未证实条目: ${unverified.length}`);
console.log(`⑤ 历史遗留 self-report 却 verified:true: ${legacyFact.length}`); legacyFact.slice(0, 8).forEach((e) => console.log(`   「${String(e.text).slice(0, 40)}」`));

if (APPLY && rep.length) {
  const skip = new Set(rep.map(([, j]) => j));
  const merged = list.filter((e, i) => !skip.has(i));
  rep.forEach(([i, j]) => { const a = merged.findIndex((x) => x === list[i]); if (a >= 0) merged[a] = { ...(typeof merged[a] === "object" ? merged[a] : { text: merged[a] }), evidences: (Number(merged[a].evidences) || 1) + 1 }; });
  const target = path.join(SELF, "identity.json");
  /* 先备份再原子写（临时文件 + rename），防运行中的大脑写盘竞争时截断 */
  const bak = path.join(SELF, `identity-before-audit-apply-${Date.now()}.json`);
  fs.copyFileSync(target, bak);
  const tmp = target + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, target);
  console.log(`--apply：已合并 ${rep.length} 组近重复（条目 ${list.length}→${merged.length}），备份 ${path.basename(bak)}`);
} else if (APPLY) {
  console.log("--apply：没有需要合并的近重复。");
}
if (DOWNGRADE) {
  /* --downgrade：把历史遗留的「模型自述却标成事实」批量降为待核实（verified:false）。
   * 旧机制（v1.99.3 前）所有成长记忆默认 verified:true，本质都是自述。 */
  const target = path.join(SELF, "identity.json");
  const cur = JSON.parse(fs.readFileSync(target, "utf8"));
  const arr = Array.isArray(cur) ? cur : (cur && cur.items) || [];
  let n = 0;
  const next = arr.map((e) => {
    if (typeof e === "string") return { text: e, kind: "self-report", verified: false, evidences: 1 };
    /* Kimi 返修2：verified 缺失的旧格式条目同样标待核实（默认不可信） */
    if (e.verified === true || e.verified === undefined) { n++; return { ...e, verified: false, kind: e.kind || "self-report" }; }
    return e;
  });
  const bak = path.join(SELF, `identity-before-downgrade-${Date.now()}.json`);
  fs.copyFileSync(target, bak);
  const tmp = target + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, target);
  console.log(`--downgrade：已降级 ${n} 条 verified:true → verified:false（待核实层），备份 ${path.basename(bak)}`);
}
process.exit(0);
