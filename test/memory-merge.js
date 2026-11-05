/* test/memory-merge.js —— mergeMemories 纯函数契约（v1.53.2 回归）
 * 背景：mergeMemories 曾经原地 push 传入数组，导致 extractMemoriesBatch 的
 * 「合并后长度 === 原长度」恒成立，短期记忆永远不落盘。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "plugins", "memory.js"), "utf8");
function extractFunc(s, name) {
  const i = s.indexOf("function " + name + "(");
  if (i < 0) return "";
  let depth = 0, started = false;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") { depth++; started = true; }
    else if (s[j] === "}") { depth--; if (started && depth === 0) return s.slice(i, j + 1); }
  }
  return "";
}
const fpSrc = extractFunc(src, "fingerprint");
const mmSrc = extractFunc(src, "mergeMemories");
if (!fpSrc || !mmSrc) { console.error("✗ 没找到 fingerprint 或 mergeMemories"); process.exit(1); }
const vm = require("vm");
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fpSrc + "\n" + mmSrc + "\nthis.mergeMemories = mergeMemories;", ctx);
const merge = ctx.mergeMemories;

let n = 0;
function check(name, fn) { fn(); n++; console.log("✓ " + name); }

check("不改动传入的数组（纯函数）", () => {
  const arr = [{ content: "旧记忆" }];
  const out = merge(arr, ["新记忆"], "private", "");
  assert.strictEqual(arr.length, 1, "原数组被改了");
  assert.strictEqual(out.length, 2);
  assert.notStrictEqual(out, arr);
});
check("能识别新增（长度判断可用）", () => {
  const arr = [];
  const before = arr.length;
  const out = merge(arr, ["喜欢橙C美式"], "private", "");
  assert.strictEqual(out.length - before, 1);
});
check("重复内容只累加 importance", () => {
  const arr = [{ content: "喜欢冰美式", importance: 1 }];
  const out = merge(arr, ["喜欢冰美式"], "private", "");
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].importance, 2);
});
check("标点差异视为同一条", () => {
  const out = merge([{ content: "喜欢猫" }], ["喜欢猫。"], "private", "");
  assert.strictEqual(out.length, 1);
});
check("200 条上限", () => {
  const many = [];
  for (let i = 0; i < 205; i++) many.push({ content: "记忆" + i });
  const out = merge(many, ["新的一条"], "private", "");
  assert.strictEqual(out.length, 200);
});
console.log(`\n✓ 全部 ${n} 个断言通过`);
