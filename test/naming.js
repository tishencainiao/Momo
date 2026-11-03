#!/usr/bin/env node
/* 称呼层级测试：主人 / 朋友 / 陌生人（从源码提取真实函数） */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

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

const MASTER = 100000001;
const FRIEND = 100000002;
const STRANGER = 999999;

let apps = {};
const ctx = {
  cfg: { qq: { master_user: MASTER, allowed_users: [MASTER, FRIEND] } },
  isMaster: (u) => Number(u) === MASTER,
  loadAppellations: () => apps,
};
vm.createContext(ctx);
vm.runInContext(extractFunc(src, "resolveCall") + "\nthis.resolveCall = resolveCall;", ctx);
const call = ctx.resolveCall;

// 1. 主人
check("主人 → 主人", call(MASTER) === "主人", call(MASTER));

// 2. 好友（allowed_users 里，但没设称呼）
check("好友没设称呼 → 朋友", call(FRIEND) === "朋友", call(FRIEND));

// 3. 陌生人
check("不在名单 → 陌生人", call(STRANGER) === "陌生人", call(STRANGER));

// 4. 设了称呼优先用称呼
apps = { [String(FRIEND)]: "老王" };
check("设了称呼就用称呼", call(FRIEND) === "老王", call(FRIEND));
apps = { [String(STRANGER)]: "路人甲" };
check("陌生人有称呼也用称呼", call(STRANGER) === "路人甲", call(STRANGER));

// 5. 称呼为空字符串时回退
apps = { [String(FRIEND)]: "   " };
check("称呼是空白 → 回退到朋友", call(FRIEND) === "朋友", call(FRIEND));

// 6. 主人即使被设了称呼也叫主人
apps = { [String(MASTER)]: "老大" };
check("主人称呼不被覆盖", call(MASTER) === "主人", call(MASTER));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
