/* 一次性脚本：记忆质量治理（M4/A3）
 * 1) 清污染：删除 journal.json 里把系统提示词原文存进 reflection 的条目
 * 2) 补 ts：reflections.json 里 ts=0 的老反思，按 text 匹配 journal 补回时间戳
 * 用法：node scripts/clean-reflections.js  （幂等，可重复跑）
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SELF = path.join(ROOT, "self");
const ARCH = path.join(ROOT, "data", "archive");

const jp = path.join(SELF, "journal.json");
const rp = path.join(SELF, "reflections.json");

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } }
function toArr(x) { return Array.isArray(x) ? x : (x && (x.entries || x.items)) || []; }
function backup(p) {
  fs.mkdirSync(ARCH, { recursive: true });
  const base = path.basename(p).replace(/\.json$/, "");
  const dst = path.join(ARCH, `${base}-pre-m4-${Date.now()}.json`);
  fs.copyFileSync(p, dst);
  console.log(`备份 → ${path.relative(ROOT, dst)}`);
}
const isPromptLeak = (s) => /我们需要回答中文|输出1条可执行反思|用户要求：针对上面/.test(String(s || ""));

/* ---- 1) 清污染 journal ---- */
const j = readJSON(jp);
let journalRemoved = 0;
if (j) {
  backup(jp);
  const arr = toArr(j);
  const kept = arr.filter((e) => !(e && e.type === "reflection" && isPromptLeak(e.text)));
  journalRemoved = arr.length - kept.length;
  fs.writeFileSync(jp, JSON.stringify(kept));
  console.log(`journal：${arr.length} → ${kept.length} 条（删 ${journalRemoved} 条污染）`);
} else {
  console.log("journal.json 读取失败，跳过");
}

/* ---- 2) 补 ts reflections ---- */
const r = readJSON(rp);
let tsBackfilled = 0;
if (r) {
  backup(rp);
  const arr = toArr(r);
  // 从 journal 建 text→ts 映射（用清理后的 journal）
  const j2 = readJSON(jp) || j;
  const textToTs = new Map();
  toArr(j2).forEach((e) => {
    if (e && e.type === "reflection" && e.text && e.ts) textToTs.set(e.text, e.ts);
  });
  // 最早时间戳作为兜底（老数据比最早的 journal 还早一点）
  const fallbackTs = Math.min(...Array.from(textToTs.values())) || Date.now();
  let prev = fallbackTs;
  for (const e of arr) {
    const txt = (e && e.text) || (typeof e === "string" ? e : "");
    if (!txt) continue;
    if (e && typeof e === "object" && e.ts) continue; // 已有真实 ts
    const matched = textToTs.get(txt);
    if (matched) {
      if (typeof e === "object") { e.ts = matched; }
      tsBackfilled++;
    } else {
      // 没匹配到：给一个单调递减的旧时间戳，保证按时间排序仍靠前
      prev -= 1;
      if (typeof e === "object") { e.ts = prev; }
      tsBackfilled++;
    }
  }
  fs.writeFileSync(rp, JSON.stringify(arr));
  const stillZero = arr.filter((e) => !(e && e.ts)).length;
  console.log(`reflections：${arr.length} 条，补 ts ${tsBackfilled} 条，仍缺 ${stillZero} 条`);
} else {
  console.log("reflections.json 读取失败，跳过");
}

console.log("完成。journal 删污染", journalRemoved, "条；reflections 补 ts", tsBackfilled, "条。");
