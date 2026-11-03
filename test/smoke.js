#!/usr/bin/env node
/* Momo 冒烟测试：抽核心纯函数做断言（npm test）
 * 通过 vm 从源码提取真实函数体执行，测的是真代码不是副本 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let passed = 0, failed = 0;
function assertEq(actual, expected, msg) {
  if (actual === expected) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.error("  ✗ " + msg + "\n    期望: " + JSON.stringify(expected) + "\n    实际: " + JSON.stringify(actual)); }
}

function extractFunc(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) return null;
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function loadFuncs(file, names) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const ctx = {};
  vm.createContext(ctx);
  for (const name of names) {
    const fn = extractFunc(src, name);
    if (!fn) throw new Error("未找到函数 " + name + " in " + file);
    vm.runInContext(fn, ctx);
  }
  return ctx;
}

// 1. stripStageDirections（回复防串台）
console.log("[1] stripStageDirections");
const strip = loadFuncs("index.js", ["stripStageDirections"]).stripStageDirections;
assertEq(strip("你好（微笑）呀"), "你好 呀", "删除中文括号动作");
assertEq(strip("hello (grin) world"), "hello world", "删除英文括号");
assertEq(strip("这是 <system_reminder>记住用中文</system_reminder> 提醒"), "这是 提醒", "删除成对 XML 标签");
assertEq(strip("a < b 且 <3"), "a < b 且 <3", "不误删数学/爱心符号");

// 2. fingerprint + mergeMemories（记忆去重与重要度）
console.log("[2] 记忆去重与重要度");
const mem = loadFuncs("plugins/memory.js", ["fingerprint", "mergeMemories"]);
assertEq(mem.fingerprint("喜欢猫。"), mem.fingerprint("喜欢猫"), "标点不影响指纹");
assertEq(mem.fingerprint("喜欢猫") === mem.fingerprint("喜欢狗"), false, "不同内容指纹不同");
const r1 = mem.mergeMemories([], ["喜欢猫", "喜欢猫。"], "private");
assertEq(r1.length, 1, "近重复只记一条");
assertEq(r1[0].importance, 2, "重复提及提升重要度");

console.log("\n" + (failed === 0 ? "✓ 全部 " + passed + " 个断言通过" : "✗ " + failed + " 个失败 / " + passed + " 个通过"));
process.exit(failed === 0 ? 0 : 1);
