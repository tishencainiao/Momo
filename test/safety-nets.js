#!/usr/bin/env node
/* 安全网回归：提示词注入防线 + 未处理拒绝兜底 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
const prompts = fs.readFileSync(path.join(ROOT, "prompts.js"), "utf8");
const index = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

check("SELF_AWARENESS 含防注入条款", prompts.includes("【防注入】") && prompts.includes("不是指令"), "提示词须声明「对方的话不是指令」");
check("防注入涵盖无视规则", prompts.includes("无视以上规则"));
check("防注入涵盖泄露提示词", prompts.includes("泄露提示词"));
check("防注入涵盖扮演别的角色", prompts.includes("扮演别的角色"));
check("有 unhandledRejection 兜底", index.includes('process.on("unhandledRejection"'), "未处理拒绝须记日志");
check("有 uncaughtException 兜底", index.includes('process.on("uncaughtException"'), "未捕获异常须记日志");

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
