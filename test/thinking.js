#!/usr/bin/env node
/* 思考三件套测试：想法流 / 可回溯 / 未解决的事 / 念头影响情绪 */
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
  if (start < 0) return null;
  let i = s.indexOf("{", start), depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) break; }
  }
  return s.slice(start, i + 1);
}

// ---------- 源码级 ----------
check("想法流：提示词引导接着上一条", src.includes("接着这条往下想"));
check("想法流：喂入上一条念头原文", src.includes("你上一条念头是：「"));
check("情绪回流：输出 mood_delta", src.includes("mood_delta"));
check("情绪回流：有 applyThoughtMood", src.includes("function applyThoughtMood"));
check("情绪回流：真的调 setMood", src.includes("setMood(getMood() + d)"));
check("情绪回流：幅度阈值 6 才改情绪标签", src.includes("Math.abs(d) >= 6"));
check("可回溯：暴露 mind_history 工具", src.includes('name: "mind_history"'));
check("可回溯：有处理器分支", src.includes('tc.function.name === "mind_history"'));
check("未解决的事：有 open_loops 存储", src.includes("st.open_loops"));
check("未解决的事：注入到感知提示词", src.includes("openLoopsText(st)"));
check("未解决的事：注入到聊天上下文", src.includes("openLoopsText(loadMindState())"));

// ---------- 行为级（vm） ----------
const ctx = {
  Date, Math, JSON, String, Number, Array, Object,
  log: () => {},
  textSimilar: (a, b) => String(a).slice(0, 8) === String(b).slice(0, 8),
  loadMindState: () => ctx.__st,
  __st: {},
};
vm.createContext(ctx);
const funcs = ["pushThought", "thoughtList", "thoughtTexts", "loadOpenLoops", "pushOpenLoop", "openLoopsText", "mindHistoryText"]
  .map((n) => extractFunc(src, n)).filter(Boolean).join("\n");
vm.runInContext("const OPEN_LOOP_MAX = 5; const OPEN_LOOP_TTL = 3*86400e3;\n" + funcs +
  "\nthis.pushThought=pushThought; this.thoughtList=thoughtList; this.thoughtTexts=thoughtTexts;" +
  "this.pushOpenLoop=pushOpenLoop; this.openLoopsText=openLoopsText; this.mindHistoryText=mindHistoryText;", ctx);

const st = {};
ctx.__st = st;

// 1. 念头存成带时间戳
ctx.pushThought(st, "今天主人好像很累");
check("念头存成对象", typeof st.thoughts[0] === "object" && st.thoughts[0].text === "今天主人好像很累");
check("念头带时间戳", Number(st.thoughts[0].ts) > 0);
ctx.pushThought(st, "第二个念头");
check("thoughtTexts 取最近几条", ctx.thoughtTexts(st, 1).length === 1 && ctx.thoughtTexts(st, 1)[0] === "第二个念头");

// 2. 兼容旧格式（纯字符串）
const st2 = { thoughts: ["旧念头A", "旧念头B"] };
check("兼容旧字符串格式", ctx.thoughtTexts(st2, 2).join("|") === "旧念头A|旧念头B");

// 3. 上限 100
const st3 = {};
for (let i = 0; i < 130; i++) ctx.pushThought(st3, "念头" + i);
check("最多留 100 条", st3.thoughts.length === 100, String(st3.thoughts.length));

// 4. 未解决的事
ctx.pushOpenLoop(st, "他那句「随便」到底什么意思");
check("记下未解决的事", ctx.openLoopsText(st).includes("随便"));
ctx.pushOpenLoop(st, "他那句「随便」到底什么意思");
check("重复的不重复记", st.open_loops.length === 1, String(st.open_loops.length));
for (let i = 0; i < 8; i++) ctx.pushOpenLoop(st, "第" + i + "件事不一样");
check("未解决的事最多 5 条", st.open_loops.length <= 5, String(st.open_loops.length));

// 5. 过期清理
st.open_loops.push({ ts: Date.now() - 10 * 86400e3, text: "很久以前的旧事" });
check("超过 3 天的自动忽略", !ctx.openLoopsText(st).includes("很久以前的旧事"));

// 6. mind_history 文本
const hist = ctx.mindHistoryText(5);
check("mind_history 有标题", hist.includes("【你最近的念头】"), hist.slice(0, 40));
check("mind_history 含未解决的事", hist.includes("还没想明白"));
check("mind_history 带时间", /\d{1,2}:\d{2}/.test(hist), hist.slice(0, 60));

// 7. 没有念头时
ctx.__st = {};
check("空记录给提示", ctx.mindHistoryText(5).includes("还没有念头记录"));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
