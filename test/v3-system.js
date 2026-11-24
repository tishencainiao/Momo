/* v3.0.0：系统接线与故障矩阵；只加载模块，不启动真实外部连接。 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm"), assert = require("assert");
const ROOT = path.join(__dirname, "..");
const H = require("../plugins/health-service.js");
const AI = require("../plugins/action-intents.js");
const C = require("../plugins/continuity-service.js");
const AU = require("../plugins/autonomy-service.js");
const L = require("../plugins/life-service.js");
let pass = 0, total = 0, chain = Promise.resolve();
function check(name, fn) { total++; chain = chain.then(async () => { try { await fn(); pass++; console.log("✓ " + name); } catch (e) { console.log("✗ " + name + " -> " + e.message); } }); }
function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function atomic(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); }
function sliceFn(src, name) { const i = src.indexOf("function " + name + "("); if (i < 0) throw new Error("not found " + name); let j = src.indexOf("{", i), d = 0; for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}") { d--; if (!d) break; } } return src.slice(i, j + 1); }

check("S02/S07 全部插件模块真实 require 且 manifest 可读取", () => {
  const files = fs.readdirSync(path.join(ROOT, "plugins")).filter((f) => f.endsWith(".js"));
  const names = [];
  for (const f of files) {
    const m = require(path.join(ROOT, "plugins", f));
    assert.ok(m && m.name, f + " 缺 name"); assert.ok(m.api || m.tools || m.commands || m.hooks, f + " 无能力声明");
    names.push(m.name);
  }
  assert.strictEqual(new Set(names).size, files.length);
  assert.ok(files.length >= 56);
  console.log("  实际模块加载 " + files.length + "/" + files.length);
});

check("S05 健康快照报告四个新增服务及其降级", async () => {
  const dir = tmp("momo-v3-health-");
  const apis = {
    actionIntents: { health: () => ({ pending: 1, unknown: 0 }) },
    continuity: { health: () => ({ degraded: "beliefs 损坏" }) },
    autonomy: { status: () => ({ level: 2, degraded: "" }) },
    life: { status: () => ({ day: "2026-01-02", phase: "day", goals: 3, degraded: "" }) },
  };
  H.init({ DATA_DIR: dir, getApi: (ns) => apis[ns] || null, wsStatus: () => ({ state: "unknown" }), loadToolOutcomes: () => [] });
  await H.api.health.probe();
  const rows = H.api.health.snapshot(), by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.strictEqual(by.actionIntents.status, "stale"); assert.strictEqual(by.continuity.status, "degraded");
  assert.strictEqual(by.autonomy.status, "fresh"); assert.strictEqual(by.life.status, "fresh");
});

check("S04 启动清单包含 pending/unknown/degraded 并自动降级", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const box = { BASE_VERSION: "3.0.0-test", _boot: { bootId: "b", startedAt: 1 }, host: null, _openRec: 0,
    _recoverApi: () => null,
    apiOf(ns) {
      if (ns === "actionIntents") return { health: () => ({ pending: 2, unknown: 1, total: 3 }) };
      if (ns === "continuity") return { health: () => ({ degraded: "bad", beliefs: 0, contested: 0 }) };
      if (ns === "autonomy") return { status: () => ({ level: 1, degraded: "" }) };
      if (ns === "life") return { status: () => ({ day: "d", phase: "night", goals: 3, degraded: "" }) };
      return null;
    }, Date, console };
  vm.createContext(box); vm.runInContext(sliceFn(src, "_startupChecklist"), box);
  const m = box._startupChecklist("ready");
  assert.strictEqual(m.status, "degraded"); assert.deepStrictEqual(JSON.parse(JSON.stringify(m.action_intents)), { pending: 2, unknown: 1, total: 3 });
  for (const k of ["action_intents", "continuity", "autonomy", "life"]) assert.ok(k in m);
});

check("S03 多份新数据损坏时上下文与状态读取不崩溃", () => {
  const dir = tmp("momo-v3-corrupt-");
  fs.mkdirSync(path.join(dir, "continuity"), { recursive: true });
  fs.writeFileSync(path.join(dir, "action-intents.json"), "{bad");
  fs.writeFileSync(path.join(dir, "autonomy.json"), "{bad");
  fs.writeFileSync(path.join(dir, "life-state.json"), "{bad");
  fs.writeFileSync(path.join(dir, "continuity", "beliefs.json"), "{bad");
  const getApi = (ns) => ns === "health" ? { snapshot: () => [] } : null;
  AI.init({ DATA_DIR: dir, writeJsonAtomic: atomic });
  C.init({ DATA_DIR: dir, writeJsonAtomic: atomic, isMaster: () => true });
  AU.init({ DATA_DIR: dir, writeJsonAtomic: atomic, isMaster: () => true, getApi });
  L.init({ DATA_DIR: dir, writeJsonAtomic: atomic, isMaster: () => true, getApi, isBudgetExhausted: () => false });
  assert.doesNotThrow(() => { C.contextProvider({ channel: "private", userId: 1 }); L.api.life.status(); AU.api.autonomy.status(); AI.api.actionIntents.health(); });
  assert.strictEqual(AU.api.autonomy.status().level, 1); assert.ok(C.api.continuity.health().degraded);
});

check("A01 旧行动账本写状态失败也必须失败关闭", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const begin = sliceFn(src, "tryBeginAction"), legacy = sliceFn(src, "beginAction"), save = sliceFn(src, "saveActionState");
  assert.ok(begin.includes("state_write_failed")); assert.ok(begin.includes("acquired: false"));
  assert.ok(!begin.includes("可用性优先放行")); assert.ok(legacy.includes("已阻止副作用")); assert.ok(save.includes("return false"));
});

check("L01/L08 内部动作日上限/同类上限生效，未新增群主动权限", () => {
  const dir = tmp("momo-v3-internal-cap-");
  AU.init({ DATA_DIR: dir, writeJsonAtomic: atomic, isMaster: () => true, getApi: () => ({ snapshot: () => [] }) });
  AU.api.autonomy.setLevel(1, 2);
  L.init({ DATA_DIR: dir, writeJsonAtomic: atomic, isMaster: () => true, isBudgetExhausted: () => false,
    getApi: (ns) => ns === "autonomy" ? AU.api.autonomy : (ns === "health" ? { snapshot: () => [] } : null) });
  const now = new Date(2026, 0, 2, 12, 0, 0).getTime();
  for (let i = 0; i < 2; i++) { assert.strictEqual(L.api.life.authorizeInternal("search", now).ok, true); L.api.life.recordInternalOutcome(L.__test.dayKey(now), "search", true, "done", now); }
  assert.strictEqual(L.api.life.authorizeInternal("search", now).reason, "kind_action_cap");
  const kinds = ["browse", "read_article"];
  for (const k of kinds) { assert.strictEqual(L.api.life.authorizeInternal(k, now).ok, true); L.api.life.recordInternalOutcome(L.__test.dayKey(now), k, true, "done", now); }
  assert.strictEqual(L.api.life.authorizeInternal("reflect", now).reason, "daily_action_cap");
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const begin = sliceFn(src, "beginAutonomousMessage"); assert.ok(begin.includes('_channel = channel === "pet" ? "pet" : "private"')); assert.ok(!begin.includes('channel: "group"'));
});

check("A05/A08/A10 主动与心智动作共享幂等键且失败不记成功", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  assert.ok(src.includes('actionKey("qzone_post", String(content || "").slice(0, 80))'));
  const finish = sliceFn(src, "finishAutonomousMessage");
  assert.ok(finish.includes('result: ok ? "succeeded"')); assert.ok(src.indexOf("appendProactiveLog(masterUin, cap)") > src.indexOf("finishAutonomousMessage(_mindAutoTx"));
});

check("G04/G09 核心策略和自修改服务不能成为自修改目标", () => {
  const dir = tmp("momo-v3-hard-boundary-");
  AU.init({ DATA_DIR: dir, writeJsonAtomic: atomic, isMaster: () => true, getApi: () => ({ snapshot: () => [] }) });
  for (const target of ["index.js", "autonomy-service.js", "config.json", "docs/v3.0.0-master-plan.md", "../self-x.js"])
    assert.strictEqual(AU.api.autonomy.targetAllowed(target), false, target);
  assert.strictEqual(AU.api.autonomy.targetAllowed("self-new-ability.js"), true);
});

chain.then(() => { console.log(`v3-system: ${pass}/${total} passed`); process.exit(pass === total ? 0 : 1); }).catch((e) => { console.error(e); process.exit(1); });
