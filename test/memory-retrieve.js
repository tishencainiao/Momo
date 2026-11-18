#!/usr/bin/env node
/* 记忆检索测试：C1 语义检索增强——Levenshtein 错别字容忍（A 方案落地）
 * 说明：B 方案（transformers.js 本地 embedding）因网络被阻断（HF 主站与 hf-mirror 的 xet CDN 均不可达），
 * 回退到 A 方案（CJK n-gram + 同义词 + Levenshtein）；前两者 index.js 已有，本次补齐 Levenshtein 错别字容忍。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "plugins", "memory-service.js"), "utf8"); // S5：真相在 memory-service

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

// ---------- 源码级 ----------
check("有 Levenshtein 距离函数 lev", src.includes("function lev("));
check("retrieveMemories 里有 fuzzy 错别字容忍", src.includes("fuzzy") && src.includes("错别字容忍"));
check("评分里 fuzzy 加权", src.includes("overlap * 2 + fuzzy * 1"));

// ---------- 行为级：从 index.js 抽取 lev 函数做真值测试 ----------
function extractFunc(s, name) {
  const start = s.indexOf("function " + name + "(");
  if (start === -1) return null;
  let i = s.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}") { depth--; if (depth === 0) return s.slice(start, j + 1); }
  }
  return null;
}
const levSrc = extractFunc(src, "lev");
const sandbox = {};
vm.createContext(sandbox);
if (levSrc) {
  vm.runInContext(levSrc + "\nthis.lev = lev;", sandbox);
  const lev = sandbox.lev;
  check("lev 同串=0", lev("咖啡", "咖啡") === 0);
  check("lev 错一字=1（咖啡→咖非）", lev("咖啡", "咖非") === 1, String(lev("咖啡", "咖非")));
  check("lev 错一字=1（奶茶→奶荼）", lev("奶茶", "奶荼") === 1, String(lev("奶茶", "奶荼")));
  check("lev 空串=长度", lev("", "咖啡") === 2, String(lev("", "咖啡")));
  check("lev 完全不同=长度", lev("咖啡", "牛奶") === 2, String(lev("咖啡", "牛奶")));
} else {
  check("能从 memory-service.js 抽取 lev 函数", false, "extractFunc 返回 null");
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
// ---------- E4 混合检索（RRF）源码级 + 行为级 ----------
check("有 _mergeRrf RRF 融合", src.includes("function _mergeRrf"));
check("机会式调用 embed（无硬依赖）", src.includes('getApi("embed")'));
check("RRF K=60 常数", src.includes("const K = 60"));
check("向量未就绪退化纯关键词（vec=null）", src.includes("vec = null"));

const mergeSrc = extractFunc(src, "_mergeRrf");
const synMapMatch = src.match(/const SYNONYM_MAP = \{[\s\S]*?\n\};/);
const kwSrc = extractFunc(src, "simpleKeywords");
const sandbox2 = {};
vm.createContext(sandbox2);
if (mergeSrc && kwSrc && levSrc) {
  vm.runInContext((synMapMatch ? synMapMatch[0] : "") + levSrc + "\n" + kwSrc + "\n" + mergeSrc + "\nthis.merge = _mergeRrf;", sandbox2);
  const cands = [
    { content: "咖啡美式加冰", time: new Date().toISOString() },
    { content: "咖啡", time: new Date().toISOString() },
  ];
  const vec = [{ m: cands[0] }, { m: cands[1] }];
  const out = sandbox2.merge(cands, "咖啡", vec, 2);
  check("RRF 把语义更近的「美式」排第一", out.length >= 1 && out[0] === cands[0], JSON.stringify((out[0] && out[0].content)));
  const out2 = sandbox2.merge(cands, "咖啡", null, 2);
  check("vec=null 退化纯关键词不抛", Array.isArray(out2) && out2.length === 2);
} else {
  check("能抽取 _mergeRrf/simpleKeywords", false, "extractFunc 返回 null");
}

process.exit(fail ? 1 : 0);
