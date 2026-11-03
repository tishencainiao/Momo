#!/usr/bin/env node
/* Momo 自检脚本：语法检查 + 配置校验 + 插件结构检查
 * 用法：npm run check  /  node check.js（pre-commit 钩子也会调它） */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const NODE = process.execPath;

let failed = false;
const fail = (m) => { console.error("  ✗ " + m); failed = true; };
const ok = (m) => console.log("  ✓ " + m);

// 1. 语法检查所有 JS（排除 node_modules/.git/data/versions/backups/archive/self/stickers）
console.log("[1] 语法检查");
const jsFiles = [];
const skipDirs = new Set(["node_modules", ".git", "data", "versions", "backups", "archive", "self", "stickers"]);
(function collect(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!skipDirs.has(f)) collect(p); }
    else if (f.endsWith(".js") && !f.endsWith(".bak")) jsFiles.push(p);
  }
})(ROOT);
for (const f of jsFiles) {
  const r = spawnSync(NODE, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) fail("语法错误 " + path.relative(ROOT, f) + "\n" + (r.stderr || ""));
}
ok(jsFiles.length + " 个 JS 文件语法通过");

// 2. 配置校验
console.log("[2] 配置校验");
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  for (const k of ["chat", "qq"]) if (!cfg[k]) fail("config.json 缺少字段: " + k);
  if (!cfg.qq || !cfg.qq.master_user) fail("config.json 缺 qq.master_user");
  ok("config.json 结构正常");
} catch (e) { fail("config.json 解析失败: " + e.message); }

// 3. 插件结构检查
console.log("[3] 插件结构");
const plugDir = path.join(ROOT, "plugins");
let n = 0;
for (const f of fs.readdirSync(plugDir)) {
  if (!f.endsWith(".js")) continue;
  const src = fs.readFileSync(path.join(plugDir, f), "utf8");
  if (!/name:\s*["']/.test(src)) fail("插件缺 name: " + f);
  if (!/tools:|commands:|hooks:|api:/.test(src)) fail("插件缺 tools/commands/hooks/api: " + f);
  n++;
}
ok(n + " 个插件结构正常");

console.log(failed ? "\n✗ 自检未通过" : "\n✓ 自检全部通过");
process.exit(failed ? 1 : 0);
