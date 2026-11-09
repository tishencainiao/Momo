#!/usr/bin/env node
/* 空闲认知心跳测试：节奏描述 / 变化检测 / 唤醒节流 */
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
check("有心跳文件常量", src.includes("mind-pulse.json"));
check("心跳注入到聊天上下文", src.includes("pulseCtx()"));
check("心跳并入主时钟（heartbeat 每 60 tick 记一次）", src.includes("mindPulseTick();"));
check("唤醒有每小时上限", src.includes("maxPerHour"));
check("参数可配置（云服务器可调）", src.includes('mindCfg("min_wake_gap_min"') && src.includes('mindCfg("max_per_hour"'));

// ---------- 行为级 ----------
let woke = 0;
let mood = 10;
const mindApi = {
  loadMindState: () => ({ last_think: Date.now() - 20 * 60000 }),
  loadOpenLoops: () => [{ text: "a" }, { text: "b" }],
};
const ctx = {
  Date, Math, JSON, String, Number, Array, Object,
  cfg: { mind: {} },
  lastInteractionTs: Date.now() - 45 * 60000,
  host: { apis: { get: (ns) => (ns === "mind" ? mindApi : {}) } },
  getMood: () => mood,
  savePulse: () => {},
  log: () => {},
  mindLoop: () => { woke++; return Promise.resolve(); },
};
vm.createContext(ctx);
const code = ["pulseLine", "buildPulse", "mindPulseTick"].map((n) => extractFunc(src, n)).filter(Boolean).join("\n");
vm.runInContext(
  "var PULSE_MAX = 60; var pulseWakeAt = 0; var pulseState = { last: null, ring: [] };\n" +
  "function mindCfg(k, d) { try { const v = Number(cfg.mind && cfg.mind[k]); return Number.isFinite(v) && v > 0 ? v : d; } catch (e) { return d; } }\n" +
  code + "\nthis.tick = function () { mindPulseTick(); };",
  ctx
);

// 1. 节奏描述
const line = ctx.pulseLine({ ts: Date.now(), idleMin: 45, thinkMin: 20, loops: 2, mood: 10 });
check("含静默时长", line.includes("静默 45 分钟"), line);
check("含上次想事", line.includes("20 分钟前"), line);
check("含未解决的事", line.includes("2 件没想明白"), line);
check("空数据不报错", ctx.pulseLine(null) === "");
check("刚说完话的说法", ctx.pulseLine({ idleMin: 0 }).includes("刚说完话"));

// 2. 首次心跳不唤醒（省调用，启动后的思考交给常规定时）
ctx.tick();
check("首次心跳不唤醒", woke === 0, String(woke));

// 3. 无变化不唤醒
ctx.tick();
check("无变化不唤醒", woke === 0, String(woke));

// 4. 时间推进但未跨档 → 仍不唤醒
ctx.tick();
check("未跨档不唤醒", woke === 0, String(woke));

// 5. 情绪跳变（冷却期已过）→ 唤醒
ctx.pulseState.ring = [];
vm.runInContext("pulseWakeAt = 0;", ctx);
ctx.pulseState.last = Object.assign({}, ctx.pulseState.last, { ts: Date.now() - 1000, mood: 0 });
mood = 40;
ctx.tick();
check("情绪跳变会唤醒", woke === 1, String(woke));

// 6. 每小时上限
woke = 0;
vm.runInContext("pulseWakeAt = 0; pulseState.ring = []; cfg.mind.max_per_hour = 2;", ctx);
for (let i = 0; i < 6; i++) {
  vm.runInContext("pulseWakeAt = 0;", ctx);
  ctx.pulseState.last = Object.assign({}, ctx.pulseState.last, { ts: Date.now() - 1000, mood: mood > 0 ? -mood : 40 });
  mood = -mood;
  ctx.tick();
}
check("每小时唤醒不超上限", woke <= 2, String(woke));

// 7. 状态没变时不唤醒（用真实 buildPulse 保证 idleMin 档位一致）
woke = 0;
mood = 0;
vm.runInContext("pulseWakeAt = 0; pulseState.ring = []; cfg.mind.max_per_hour = 99;", ctx);
const realNow = ctx.buildPulse();
ctx.pulseState.last = Object.assign({}, realNow, { mood: 0 });
ctx.tick();
check("状态没变不唤醒", woke === 0, String(woke));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
