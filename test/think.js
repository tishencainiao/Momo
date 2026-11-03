#!/usr/bin/env node
/* 聊天思考开关测试：闲聊关、复杂判断开（从源码提取真实函数执行） */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.error("  ✗ " + msg); }
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

const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const fnSrc = extractFunc(src, "shouldThinkChat");
if (!fnSrc) { console.error("✗ 没找到 shouldThinkChat"); process.exit(1); }
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fnSrc + "\nthis.shouldThinkChat = shouldThinkChat;", ctx);
const think = ctx.shouldThinkChat;

check(think("在干嘛", false) === false, "短闲聊「在干嘛」→ 不思考");
check(think("哈哈", false) === false, "短叹词 → 不思考");
check(think("", false) === false, "空消息 → 不思考");
check(think("你在干嘛呀？", false) === false, "短问句（<15字）→ 不思考");
check(think("今天天气怎么样啊，适合出门吗？", false) === true, "较长问句 → 思考");
check(think("帮我分析一下这个方案的优缺点", false) === true, "含「帮我/分析」→ 思考");
check(think("为什么天空是蓝色的？", false) === true, "含「为什么」→ 思考");
check(think("这两个有什么区别", false) === true, "含「区别」→ 思考");
check(think("x".repeat(80), false) === true, "长文本（≥60字）→ 思考");
check(think("看图", true) === true, "带图片 → 思考");
check(think("嗯", true) === true, "哪怕带图短句也思考");

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed ? 1 : 0);
