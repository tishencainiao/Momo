#!/usr/bin/env node
/* 阶段五（Kimi 审查）回归：主动搭话降焦虑 + 暂停无效自调参 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const pro = fs.readFileSync(path.join(ROOT, "plugins", "proactive.js"), "utf8");
const evoSrc = fs.readFileSync(path.join(ROOT, "plugins", "evolution.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

/* 源码级 */
check("自己发言不再记入 lastActiveAt（proactive.js 无此句）", !pro.includes("P.lastActiveAt.set"));
check("分享趣图不再记入 lastActiveAt", !src.includes("lastActiveAt.set(masterUin"));
check("silenceStreak 持久化进 proactive-state", src.includes("silenceStreak: Object.fromEntries(silenceStreak)"));
check("收到私聊清零 silenceStreak", src.includes("silenceStreak.delete(userId)"));
check("连发 4 次未获回复暂停 silence", pro.includes("streak >= 4"));
check("streak≥2 间隔成倍降频", pro.includes("state.intervalMs * streak"));
check("silence 文案带「不冷落/别委屈」中性句", pro.includes("不代表冷落你"));
check("auto_tune 默认关闭", evoSrc.includes("evolution.auto_tune", ) && /default:\s*false/.test(evoSrc.match(/"evolution\.auto_tune"[\s\S]{0,200}?default:\s*(true|false)/) ? evoSrc.match(/"evolution\.auto_tune"[\s\S]{0,200}?default:\s*(true|false)/)[0] : ""));
check("关闭时只记录不调参", evoSrc.includes("auto_tune 关闭，仅记录不调参"));

/* 行为级：auto_tune 关闭时 tunePrefFromScore 只写 journal、不动 pref.json */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "momo-autotune-"));
const SELF = path.join(DIR, "self");
fs.mkdirSync(SELF, { recursive: true });
const written = [];
const evo = require("../plugins/evolution.js");
evo.init({
  SELF_DIR: SELF, DATA_DIR: DIR, BASE_VERSION: "1.0.0",
  log: () => {}, config: { qq: { master_user: 1000, reply_gap_ms: 1200 } }, sendPrivate: async () => {},
  isBudgetExhausted: () => false, completeOnce: async () => "", reasonComplete: async () => "",
  writeJsonAtomic: (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); written.push(f); },
  writeFileAtomic: (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); },
  reloadEvolution: () => {}, textSimilar: () => false, getSetting: (k, d) => d, settings: () => ({}),
  isMaster: () => true, loadEvolution: () => ({}), canAfford: () => true, recordAndSend: () => {},
});
(async () => {
  await evo.api.evolution.tunePrefFromScore({ count: 10, sum: 20 });
  const journal = JSON.parse(fs.readFileSync(path.join(SELF, "journal.json"), "utf8"));
  check("关闭时写入 score 记录", journal.some((j) => j.type === "score"), JSON.stringify(journal.slice(0, 3)));
  check("关闭时不写 pref.json", !fs.existsSync(path.join(SELF, "pref.json")), written.join(","));
  console.log(`proactive-calm: ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("异常:", e.message); process.exit(1); });
