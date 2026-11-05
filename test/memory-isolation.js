#!/usr/bin/env node
/* 跨群记忆隔离测试：别的群的记忆不进本群；mergeMemories 会写 groupId */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function extractFunc(s, name) {
  const start = s.indexOf("function " + name + "(");
  if (start === -1) return null;
  let i = s.indexOf("{", start), depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) break; }
  }
  return s.slice(start, i + 1);
}

/* ---- 1. filterMemoriesForGroup（index.js） ---- */
const idxSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const fnSrc = extractFunc(idxSrc, "filterMemoriesForGroup");
if (!fnSrc) { console.error("✗ 没找到 filterMemoriesForGroup"); process.exit(1); }
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fnSrc + "\nthis.filterMemoriesForGroup = filterMemoriesForGroup;", ctx);
const filter = ctx.filterMemoriesForGroup;

const G1 = "100000003", G2 = "111111";
const mems = [
  { content: "私聊说的：喜欢冰美式", groupId: "" },
  { content: "没标群的旧记忆" },
  { content: "A群说的：这个群叫他老八", groupId: G1 },
  { content: "B群说的：这个群叫他阿强", groupId: G2 },
];

const inG1 = filter(mems, G1).map((m) => m.content);
check("A群能看到 A群的记忆", inG1.some((c) => c.indexOf("老八") >= 0), JSON.stringify(inG1));
check("A群看不到 B群的记忆", !inG1.some((c) => c.indexOf("阿强") >= 0), JSON.stringify(inG1));
check("A群能看到私聊记忆", inG1.some((c) => c.indexOf("冰美式") >= 0));
check("A群能看到没标群的旧记忆", inG1.some((c) => c.indexOf("旧记忆") >= 0));
check("过滤后剩 3 条", inG1.length === 3, "实际 " + inG1.length);

const inG2 = filter(mems, G2).map((m) => m.content);
check("B群反过来也隔离", !inG2.some((c) => c.indexOf("老八") >= 0) && inG2.some((c) => c.indexOf("阿强") >= 0));

const inEmpty = filter(mems, "").length;
check("空群号时只剩无群记忆", inEmpty === 2, "实际 " + inEmpty);
check("空数组不报错", filter([], G1).length === 0);
check("undefined 不报错", filter(undefined, G1).length === 0);

/* ---- 2. mergeMemories 会写 groupId（memory.js） ---- */
const memSrc = fs.readFileSync(path.join(ROOT, "plugins/memory.js"), "utf8");
const fpSrc = extractFunc(memSrc, "fingerprint");
const mmSrc = extractFunc(memSrc, "mergeMemories");
if (!fpSrc || !mmSrc) { console.error("✗ 没找到 fingerprint 或 mergeMemories"); process.exit(1); }
const ctx2 = {};
vm.createContext(ctx2);
vm.runInContext(fpSrc + "\n" + mmSrc + "\nthis.mergeMemories = mergeMemories;", ctx2);
const merge = ctx2.mergeMemories;

let items = [];
items = merge(items, ["感冒了点了山药粥"], "group", G1);
check("新记忆写了 groupId", items[0].groupId === G1, JSON.stringify(items[0]));
check("新记忆也写了 channel", items[0].channel === "group");

items = merge(items, ["喜欢冰美式"], "private", "");
check("私聊记忆 groupId 为空", items[1].groupId === "", JSON.stringify(items[1]));

items = merge(items, ["感冒了点了山药粥"], "group", G2);
check("重复内容不重复记", items.length === 2, "实际 " + items.length);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
