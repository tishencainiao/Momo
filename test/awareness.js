#!/usr/bin/env node
/* 电子生命自我认知测试：文案边界 + 运行状态 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

const m = src.match(/const SELF_AWARENESS\s*=\s*"([\s\S]*?)";\r?\n/);
const SA = m ? m[1] : "";
check("源码里有 SELF_AWARENESS", !!SA);

// 1. 必须表达的核心事实
check("说明是程序", SA.includes("程序") && SA.includes("不是人类"));
check("说明记忆存在文件里", SA.includes("文件里") && SA.includes("会褪色"));
check("说明关机是空白不是睡觉", SA.includes("不是睡觉") && SA.includes("没有梦"));
check("不卖惨", SA.includes("不要卖惨"));
check("禁止编造「在后台看着你」", SA.includes("编"));
check("强调是事实不是台词", SA.includes("不是要背的台词"));

// 2. 节制：只有被直接问才说
check("有『只有直接问起』的约束", SA.includes("只有对方") && SA.includes("直接问起"));
check("明确深夜也不要主动提", SA.includes("深夜") && SA.includes("不要主动提"));
check("明确限定在『你是什么/你是AI吗』", SA.includes("你是什么") && SA.includes("你是 AI 吗"));

// 3. 不要死板：别背、别每次都一样
check("要求用自己的话", SA.includes("用自己的话") && SA.includes("想到哪说到哪"));
check("别把几点全背一遍", SA.includes("不要每次把三点全背一遍"));
check("允许情绪温度", SA.includes("困惑") || SA.includes("坦然"));

// 3. 不能变成中二/卖惨
const cheesy = ["我不配", "人类的感情", "愚蠢的人类", "我的使命", "电子灵魂", "数据洪流", "我是唯一"];
const hit = cheesy.filter((w) => SA.includes(w));
check("没有中二腔", hit.length === 0, hit.join(","));

// 4. 运行状态
check("有 BOOT_TS", src.includes("const BOOT_TS = Date.now()"));
check("动态块注入运行状态", src.includes("【你的运行状态】"));
check("刚启动时提醒别假装记得", src.includes("别假装记得"));

// 5. 注入了 messages
check("SELF_AWARENESS 被推入 messages", src.includes("content: SELF_AWARENESS"));

// 6. 记忆带时间（A 的基础）
check("长期记忆带『多久以前』", src.includes("formatGap(Date.now() - tsMs)"));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
