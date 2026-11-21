#!/usr/bin/env node
/* 返修5（Kimi 二轮）回归：silence 6h 门禁的日期维度 + silence 走 shouldSendNow */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const pro = fs.readFileSync(path.join(ROOT, "plugins", "proactive.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

/* 源码级 */
check("index.js 模块级 lastSilenceDay 声明", src.includes("const lastSilenceDay = new Map();"));
check("loadProactiveState 恢复 lastSilenceDay", src.includes("s.lastSilenceDay || {}"));
check("saveProactiveState 持久化 lastSilenceDay", src.includes("lastSilenceDay: Object.fromEntries(lastSilenceDay)"));
check("createHost proactive 束暴露 lastSilenceDay", src.includes("silenceStreak, lastSilenceDay,"));
check("silence 候选走 shouldSendNow", pro.includes('kind === "silence") && P.shouldSendNow'));
check("6h 门禁调用 silenceGate（在 evaluateSilenceState 内）", pro.includes("silenceGate(gapMs, nowTs, lastDayTs)"));
check("放行当天记录 lastSilenceDay 并落盘", pro.includes("P.lastSilenceDay.set(u, _d.getTime())") && pro.includes("P.saveProactiveState()"));
/* Kimi 三轮返修4 + 四轮：silenceStreak 跨天重置（每天重新给机会）+ 门禁顺序统一进纯函数 */
check("门禁与降频统一进 evaluateSilenceState 纯函数", pro.includes("function evaluateSilenceState("));
check("循环调用 evaluateSilenceState 并写回清零后的 streak", pro.includes("_dec.streak !== _state.streak"));
check("跨天清零先于一切判断（_lpDay.getTime() < today）", pro.includes("_lpDay.getTime() < today"));
check("暂停日志明确「今天暂停（明天恢复）」", pro.includes("今天暂停（明天恢复）"));

/* 行为级：vm 提取 silenceGate 纯函数，模拟时间（nowTs/lastDayKey 传参，无真实 Date 依赖） */
const g = pro.match(/function silenceGate\([\s\S]*?\n\}/);
if (!g) {
  check("silenceGate 纯函数存在", false, "未提取到函数体");
} else {
  const sandbox = {};
  vm.runInNewContext(g[0] + "\nthis.__gate = silenceGate;", sandbox);
  const gate = sandbox.__gate;
  const DAY = 24 * 3600e3;
  const t0 = new Date(2026, 10, 21, 12, 0, 0).getTime(); // 2026-11-21 12:00 本地
  const dayKey = (() => { const d = new Date(t0); d.setHours(0, 0, 0, 0); return d.getTime(); })();

  check("≤6h 正常放行", gate(5 * 3600e3, t0, 0).allowed === true && gate(5 * 3600e3, t0, 0).skipToday === false);
  check(">6h 且当天未放行过 → 放行一次", gate(10 * 3600e3, t0, 0).allowed === true);
  check(">6h 且今天已放行过 → 拒绝", gate(10 * 3600e3, t0, dayKey).allowed === false && gate(10 * 3600e3, t0, dayKey).skipToday === true);
  check(">6h 但 lastDayKey 是昨天 → 跨天恢复放行", gate(10 * 3600e3, t0, dayKey - DAY).allowed === true);
  check(">6h 且 lastDayKey 是未来错误值 → 拒绝（保守）", gate(10 * 3600e3, t0, dayKey + DAY).allowed === false);
  check("6h 整边界 → 放行", gate(6 * 3600e3, t0, dayKey).allowed === true);
}

/* Kimi 四轮：完整门禁顺序行为测试（evaluateSilenceState，含跨天清零顺序 Bug 回归） */
const e2 = pro.match(/function evaluateSilenceState\([\s\S]*?\n\}/);
if (!e2) {
  check("evaluateSilenceState 纯函数存在", false, "未提取到函数体");
} else {
  const sandbox2 = {};
  vm.runInNewContext(e2[0] + "\nfunction silenceGate(g,m,l){ if(m<=6*3600e3) return {allowed:true,skipToday:false}; const d=new Date(m); d.setHours(0,0,0,0); const t=d.getTime(); if(Number(l)>=t) return {allowed:false,skipToday:true}; return {allowed:true,skipToday:false}; }\nthis.__ev = evaluateSilenceState;", sandbox2);
  const ev = sandbox2.__ev;
  const DAY = 24 * 3600e3;
  const tNow = new Date(2026, 10, 21, 12, 0, 0).getTime();
  const dayKey = (() => { const d = new Date(tNow); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const st = (o) => Object.assign({ lastDayTs: 0, gapMs: 0, lastProactiveTs: 0, nowTs: tNow, intervalMs: 60 * 60000, silenceMs: 120 * 60000, streak: 0 }, o);

  /* 场景：streak=4（昨天连发 4 次未获回复），lastSilenceDay=昨天，gap>6h → 跨天清零后放行一次 */
  const r1 = ev(st({ streak: 4, lastDayTs: dayKey - DAY, lastProactiveTs: tNow - DAY - 3600e3, gapMs: 10 * 3600e3 }));
  check("跨天+streak=4+gap>6h → 放行且 streak 清零", r1.allowed === true && r1.streak === 0, JSON.stringify(r1));
  /* 同一天第二次（放行日后 lastDayTs=今天）→ 拒 */
  const r2 = ev(st({ streak: 1, lastDayTs: dayKey, lastProactiveTs: tNow - 3600e3, gapMs: 10 * 3600e3 }));
  check("同一天第二次 >6h → 拒绝（skipToday）", r2.allowed === false && r2.skipToday === true, JSON.stringify(r2));
  /* 次日恢复：lastProactiveTs 仍是昨天 → streak 再清零，lastDayTs=昨天 → 门禁放行 */
  const tNext = tNow + DAY;
  const nextKey = dayKey + DAY;
  const r3 = ev(st({ streak: 4, lastDayTs: dayKey, lastProactiveTs: tNow - 3600e3, nowTs: tNext, gapMs: 10 * 3600e3 }));
  check("次日恢复：streak 清零且门禁放行", r3.allowed === true && r3.streak === 0, JSON.stringify(r3));
  /* streak>=4 且今天已发过（2~6h 路径）→ 暂停到明天 */
  const r4 = ev(st({ streak: 4, lastProactiveTs: tNow - 3600e3, gapMs: 3 * 3600e3 }));
  check("streak>=4 且 2~6h → 当天暂停", r4.allowed === false && r4.skipToday === true, JSON.stringify(r4));
  /* streak>=2 降频间隔未到 → 拒（非 skipToday） */
  const r5 = ev(st({ streak: 2, lastProactiveTs: tNow - 60 * 60000, gapMs: 3 * 3600e3 }));
  check("streak=2 且间隔未到 → 拒（间隔类）", r5.allowed === false && r5.skipToday === false, JSON.stringify(r5));
}

console.log(`proactive-silence-clock: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
