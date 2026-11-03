#!/usr/bin/env node
/* 心流三层测试：价值评分权重 / 静默准备池（增删/去重/过期）/ 阈值常量 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const DIR = path.join(os.tmpdir(), "momo-mind-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

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
function extractConstLine(s, name) {
  const start = s.indexOf("const " + name + " = ");
  if (start === -1) return null;
  const end = s.indexOf("\n", start);
  return s.slice(start, end).replace(/;?\s*$/, ";");
}

const sandbox = { fs, path, DATA_DIR: DIR, textSimilar: (a, b) => String(a) === String(b) };
vm.createContext(sandbox);
const code = [
  extractConstLine(src, "MIND_TICK_MS"),
  extractConstLine(src, "MIND_DELIBERATE_GAP"),
  extractConstLine(src, "MIND_URGE_THRESHOLD"),
  extractConstLine(src, "SCORE_PUSH"),
  extractConstLine(src, "SCORE_QUEUE"),
  extractConstLine(src, "PENDING_FILE"),
  extractFunc(src, "loadPending"),
  extractFunc(src, "savePending"),
  extractFunc(src, "addPendingNudge"),
  extractFunc(src, "pendingNudgesText"),
  extractFunc(src, "consumePendingNudge"),
  extractFunc(src, "scoreIntent"),
  "this.MIND_TICK_MS = MIND_TICK_MS; this.SCORE_PUSH = SCORE_PUSH; this.SCORE_QUEUE = SCORE_QUEUE;",
  "this.MIND_URGE_THRESHOLD = MIND_URGE_THRESHOLD; this.addPendingNudge = addPendingNudge;",
  "this.pendingNudgesText = pendingNudgesText; this.consumePendingNudge = consumePendingNudge;",
  "this.scoreIntent = scoreIntent; this.loadPending = loadPending;",
].filter(Boolean).join("\n");
vm.runInContext(code, sandbox);

const S = sandbox;

// 1. 常量
check("感知节奏 10 分钟", S.MIND_TICK_MS === 10 * 60000, String(S.MIND_TICK_MS));
check("想做事阈值 60", S.MIND_URGE_THRESHOLD === 60);
check("push 阈值 0.62", S.SCORE_PUSH === 0.62);
check("queue 阈值 0.40", S.SCORE_QUEUE === 0.40);
check("push 阈值 > queue 阈值", S.SCORE_PUSH > S.SCORE_QUEUE);

// 2. 评分权重：0.35 相关 + 0.20 缺口 + 0.25 价值 + 0.20 时效
check("全 1 分 = 1.0", Math.abs(S.scoreIntent({ relevance: 1, gap: 1, value: 1, timeliness: 1 }) - 1) < 1e-9);
check("全 0 分 = 0", S.scoreIntent({ relevance: 0, gap: 0, value: 0, timeliness: 0 }) === 0);
check("只相关=1 → 0.35", Math.abs(S.scoreIntent({ relevance: 1 }) - 0.35) < 1e-9, String(S.scoreIntent({ relevance: 1 })));
check("只价值=1 → 0.25", Math.abs(S.scoreIntent({ value: 1 }) - 0.25) < 1e-9);
check("越界值被夹到 0~1", Math.abs(S.scoreIntent({ relevance: 5, gap: 5, value: 5, timeliness: 5 }) - 1) < 1e-9);
check("负数被夹到 0", S.scoreIntent({ relevance: -5 }) === 0);
check("缺字段按 0 算", S.scoreIntent({}) === 0);

// 3. 静默池：新增
check("新增一条", S.addPendingNudge({ kind: "chat_master", content: "想问问主人今天面试怎么样", score: 0.5 }) === true);
check("池里有 1 条", S.loadPending().length === 1);
check("内容正确", S.loadPending()[0].content.indexOf("面试") >= 0);
check("带过期时间", S.loadPending()[0].expireAt > Date.now());

// 4. 去重
check("重复内容不重复加", S.addPendingNudge({ kind: "chat_master", content: "想问问主人今天面试怎么样" }) === false);
check("池里仍 1 条", S.loadPending().length === 1);

// 5. 注入文字
const txt = S.pendingNudgesText(3);
check("注入文字含内容", txt.indexOf("面试") >= 0, txt);
check("注入格式是列表", txt.indexOf("- ") === 0);

// 6. 消费后删除
const id = S.loadPending()[0].id;
S.consumePendingNudge(id);
check("消费后池为空", S.loadPending().length === 0);
check("消费后注入为空", S.pendingNudgesText(3) === "");

// 7. 过期清理
S.addPendingNudge({ kind: "talk", content: "这条会过期" });
const arr = S.loadPending();
arr[0].expireAt = Date.now() - 1000;
fs.writeFileSync(path.join(DIR, "pending-nudges.json"), JSON.stringify(arr));
check("过期条目不出现在注入里", S.pendingNudgesText(3) === "", S.pendingNudgesText(3));
check("过期条目被清理掉", S.loadPending().length === 0);

// 8. 空内容拒绝
check("空内容被拒", S.addPendingNudge({ content: "   " }) === false);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
