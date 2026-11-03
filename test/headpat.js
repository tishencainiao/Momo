#!/usr/bin/env node
/* 摸头情感测试（v1.45.0）：多句回复 / 心情+2且5分钟冷却 / 动作日志 / 下次聊天余韵注入 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const srcIndex = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const srcEvo = fs.readFileSync(path.join(ROOT, "plugins/evolution.js"), "utf8");
const srcHost = fs.readFileSync(path.join(ROOT, "plugin-host.js"), "utf8");
const skills = JSON.parse(fs.readFileSync(path.join(ROOT, "self/skills.json"), "utf8"));

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
const momo = skills.rules.find((r) => r.id === "ev-momo");
check("ev-momo 标记 touch_feel", !!(momo && momo.touch_feel === true));
check("摸头回复至少 8 句（更丰富）", !!(momo && Array.isArray(momo.replies) && momo.replies.length >= 8), momo && momo.replies.length);
check("还有句子保留 {call} 称呼占位符", !!(momo && momo.replies.some((x) => x.includes("{call}"))));
check("保留了原有那句「呜哇被摸头」", !!(momo && momo.replies.some((x) => x.includes("呜哇被摸头"))));
check("进化层有摸头情感副作用", srcEvo.includes("applyHeadpatFeel"));
check("摸头按 touch_feel 触发", srcEvo.includes("rule.touch_feel"));
check("心情冷却 5 分钟", srcEvo.includes("HEADPAT_MOOD_GAP_MS = 5 * 60000"));
check("摸头会记动作日志", srcEvo.includes('recordAction({ type: "headpat"'));
check("内核有 headpatCtx 注入", srcIndex.includes("function headpatCtx"));
check("headpatCtx 已接进动态块", srcIndex.includes("const _hp = headpatCtx()"));
check("内核有 addMood", srcIndex.includes("function addMood("));
check("插件层暴露 addMood", srcHost.includes("addMood: (d) => core.addMood(d)"));

// ---------- 行为级：applyHeadpatFeel ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-headpat-"));
let moodCalls = [];
let actionCalls = [];
const evoCtx = {
  fs, path, Date, Number, JSON, Object, Math, String, Array,
  _ctx: {
    DATA_DIR: tmp,
    addMood: (d) => moodCalls.push(d),
    recordAction: (e) => actionCalls.push(e),
  },
};
vm.createContext(evoCtx);
const evoCode = ["loadHeadpat", "saveHeadpat", "applyHeadpatFeel"].map((n) => extractFunc(srcEvo, n)).filter(Boolean).join("\n");
vm.runInContext(
  'const HEADPAT_FILE = () => path.join(_ctx.DATA_DIR, "headpat.json");\n' +
  "const HEADPAT_MOOD_GAP_MS = 5 * 60000;\n" +
  evoCode + "\nthis.act = function (uid) { applyHeadpatFeel(uid); };",
  evoCtx
);

evoCtx.act(100000001);
check("第一次摸头：心情 +2", JSON.stringify(moodCalls) === "[2]", JSON.stringify(moodCalls));
check("第一次摸头：记了动作日志", actionCalls.length === 1 && actionCalls[0].type === "headpat");
check("动作日志带 by（谁摸的）", actionCalls[0] && actionCalls[0].by === 100000001);
const st1 = JSON.parse(fs.readFileSync(path.join(tmp, "headpat.json"), "utf8"));
check("落盘：次数 1", st1.count === 1, String(st1.count));
check("落盘：新摸头允许下次提起（consumed_ts=0）", st1.consumed_ts === 0);

evoCtx.act(100000001);
check("5 分钟内重复摸：心情不再叠加", JSON.stringify(moodCalls) === "[2]", JSON.stringify(moodCalls));
check("5 分钟内重复摸：次数照记", (JSON.parse(fs.readFileSync(path.join(tmp, "headpat.json"), "utf8")).count) === 2);
check("5 分钟内重复摸：动作日志照记", actionCalls.length === 2);

// 冷却过后应再涨一次：把 mood_ts 拨回 6 分钟前
const st2 = JSON.parse(fs.readFileSync(path.join(tmp, "headpat.json"), "utf8"));
st2.mood_ts = Date.now() - 6 * 60000;
fs.writeFileSync(path.join(tmp, "headpat.json"), JSON.stringify(st2));
evoCtx.act(100000001);
check("冷却过后再摸：心情再 +2", JSON.stringify(moodCalls) === "[2,2]", JSON.stringify(moodCalls));

// ---------- 行为级：headpatCtx ----------
const hCtx = {
  fs, path, Date, Number, JSON, Object, String,
  DATA_DIR: tmp,
};
vm.createContext(hCtx);
vm.runInContext(extractFunc(srcIndex, "headpatCtx") + "\nthis.hp = function () { return headpatCtx(); };", hCtx);
const first = hCtx.hp();
check("摸头后下一次聊天会注入余韵", typeof first === "string" && first.includes("摸过你的头"), first);
check("注入语气是「可提可不提」，不强求", first.includes("不提也完全没关系"));
const second = hCtx.hp();
check("同一次摸头只提一次（consumed 生效）", second === "", second);

// 超过 15 分钟不提
const stale = { ts: Date.now() - 20 * 60000, mood_ts: Date.now() - 20 * 60000, count: 1, consumed_ts: 0 };
fs.writeFileSync(path.join(tmp, "headpat.json"), JSON.stringify(stale));
check("超过 15 分钟不再提", hCtx.hp() === "");

// 文件不存在不报错
fs.unlinkSync(path.join(tmp, "headpat.json"));
check("没有摸头文件时返回空", hCtx.hp() === "");

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
