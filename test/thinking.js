#!/usr/bin/env node
/* 思考三件套测试：想法流 / 可回溯 / 未解决的事 / 念头影响情绪
 * 念头存取函数已下沉到 plugins/mind.js（M8）；想法流/情绪回流仍在 index.js。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

// ---------- 源码级（想法流/情绪回流仍在 index.js；未解决的事在 mind.js） ----------
const mindSrc = fs.readFileSync(path.join(ROOT, "plugins", "mind.js"), "utf8");
check("想法流：提示词引导顺着想且卡壳就换话题", src.includes("主动换个新想法"));
check("想法流：喂入上一条念头原文", src.includes("你上一条念头是：「"));
check("情绪回流：输出 mood_delta", src.includes("mood_delta"));
check("情绪回流：有 applyThoughtMood", src.includes("function applyThoughtMood"));
check("情绪回流：真的调 setMood", src.includes("setMood(getMood() + d)"));
check("情绪回流：幅度阈值 6 才改情绪标签", src.includes("Math.abs(d) >= 6"));
check("可回溯：暴露 mind_history 工具", src.includes('name: "mind_history"'));
check("可回溯：有处理器分支", src.includes('tc.function.name === "mind_history"'));
check("未解决的事：有 open_loops 存储", mindSrc.includes("st.open_loops"));
check("未解决的事：注入到感知提示词", src.includes('host.apis.get("mind").openLoopsText(st)'));
check("未解决的事：注入到聊天上下文", src.includes('host.apis.get("mind").openLoopsText(host.apis.get("mind").loadMindState())'));

// ---------- 行为级（mind.js 插件） ----------
const DIR = path.join(os.tmpdir(), "momo-thinking-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });
const mind = require("../plugins/mind.js");
mind.init({ DATA_DIR: DIR, textSimilar: (a, b) => String(a).slice(0, 8) === String(b).slice(0, 8) });
const M = mind.api.mind;

const st = {};

// 1. 念头存成带时间戳
M.pushThought(st, "今天主人好像很累");
check("念头存成对象", typeof st.thoughts[0] === "object" && st.thoughts[0].text === "今天主人好像很累");
check("念头带时间戳", Number(st.thoughts[0].ts) > 0);
M.pushThought(st, "第二个念头");
check("thoughtTexts 取最近几条", M.thoughtTexts(st, 1).length === 1 && M.thoughtTexts(st, 1)[0] === "第二个念头");

// 2. 兼容旧格式（纯字符串）
const st2 = { thoughts: ["旧念头A", "旧念头B"] };
check("兼容旧字符串格式", M.thoughtTexts(st2, 2).join("|") === "旧念头A|旧念头B");

// 3. 上限 100
const st3 = {};
for (let i = 0; i < 130; i++) M.pushThought(st3, "念头" + i);
check("最多留 100 条", st3.thoughts.length === 100, String(st3.thoughts.length));

// 4. 未解决的事
M.pushOpenLoop(st, "他那句「随便」到底什么意思");
check("记下未解决的事", M.openLoopsText(st).includes("随便"));
M.pushOpenLoop(st, "他那句「随便」到底什么意思");
check("重复的不重复记", st.open_loops.length === 1, String(st.open_loops.length));
for (let i = 0; i < 8; i++) M.pushOpenLoop(st, "第" + i + "件事不一样");
check("未解决的事最多 5 条", st.open_loops.length <= 5, String(st.open_loops.length));

// 5. 过期清理
st.open_loops.push({ ts: Date.now() - 10 * 86400e3, text: "很久以前的旧事" });
check("超过 3 天的自动忽略", !M.openLoopsText(st).includes("很久以前的旧事"));

// 6. mind_history 文本（先 saveMindState 持久化，再读回）
M.saveMindState(st);
const hist = M.mindHistoryText(5);
check("mind_history 有标题", hist.includes("【你最近的念头】"), hist.slice(0, 40));
check("mind_history 含未解决的事", hist.includes("还没想明白"));
check("mind_history 带时间", /\d{1,2}:\d{2}/.test(hist), hist.slice(0, 60));

// 7. 没有念头时
M.saveMindState({});
check("空记录给提示", M.mindHistoryText(5).includes("还没有念头记录"));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
