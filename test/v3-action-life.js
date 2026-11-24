/* v3.0.0：行动意图 + 生活节律行为矩阵（临时目录，无真实外部服务） */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm"), crypto = require("crypto");
const assert = require("assert");
const AI = require("../plugins/action-intents.js");
const LIFE = require("../plugins/life-service.js");
let pass = 0, total = 0, chain = Promise.resolve();
function check(name, fn) { total++; chain = chain.then(async () => { try { await fn(); pass++; console.log("✓ " + name); } catch (e) { console.log("✗ " + name + " -> " + e.message); } }); }
function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function ctx(dir, over) {
  const c = {
    DATA_DIR: dir, log() {}, isBudgetExhausted: () => false, isMaster: () => true,
    writeJsonAtomic(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); },
    actionKey(...p) { return crypto.createHash("sha1").update(p.join("|")).digest("hex").slice(0, 20); },
    _open: {}, _actions: [],
    tryBeginAction(m) { if (this._open[m.key]) return { acquired: false, duplicateOf: "running" }; this._open[m.key] = { status: "running" }; return { acquired: true, key: m.key }; },
    endAction(k, r) { delete this._open[k]; this._actions.push({ key: k, status: r.ok === true ? "succeeded" : (r.ok === false ? "failed" : "unknown"), error: r.error || "", result_summary: r.summary || "" }); },
    loadActions() { return this._actions.slice(); },
    getApi: () => null,
  };
  return Object.assign(c, over || {});
}
function spec(key, more) { return Object.assign({ key, kind: "test_action", channel: "private", userId: 1, reason: "测试", payload_summary: key, action_class: "non_idempotent", valid_until: Date.now() + 60000 }, more || {}); }

check("A01 意图写盘失败不得执行副作用", async () => {
  const dir = tmp("momo-v3-a01-");
  const c = ctx(dir, { writeJsonAtomic() { throw new Error("disk failed"); } });
  AI.init(c);
  let runs = 0;
  const r = await AI.api.actionIntents.run(spec("a01"), async () => { runs++; return { ok: true }; });
  assert.strictEqual(r.result, "blocked"); assert.strictEqual(runs, 0);
});

check("A02 同一 action_key 并发只执行一次", async () => {
  const c = ctx(tmp("momo-v3-a02-")); AI.init(c);
  let runs = 0, release;
  const gate = new Promise((r) => { release = r; });
  const exec = async () => { runs++; await gate; return { ok: true }; };
  const p1 = AI.api.actionIntents.run(spec("a02"), exec);
  const p2 = AI.api.actionIntents.run(spec("a02"), exec);
  release();
  const rs = await Promise.all([p1, p2]);
  assert.strictEqual(runs, 1); assert.strictEqual(rs[0].result, "succeeded"); assert.ok(String(rs[1].result).startsWith("duplicate"));
});

check("A03 非幂等 running 重启标 unknown 且不重放", async () => {
  const c = ctx(tmp("momo-v3-a03-")); AI.init(c);
  AI.api.actionIntents.track(spec("a03")); AI.api.actionIntents.markRunning("a03");
  const rec = AI.api.actionIntents.recover(Date.now() + 1000);
  assert.strictEqual(rec.unknown, 1);
  let runs = 0;
  const r = await AI.api.actionIntents.run(spec("a03"), async () => { runs++; return { ok: true }; });
  assert.strictEqual(runs, 0); assert.strictEqual(r.result, "duplicate_unknown");
});

check("A04 仅 retry_safe 只读任务可恢复重试", async () => {
  const c = ctx(tmp("momo-v3-a04-")); AI.init(c);
  AI.api.actionIntents.track(spec("a04", { action_class: "read", retry_safe: true }));
  AI.api.actionIntents.markRunning("a04");
  AI.api.actionIntents.recover(Date.now() + 1000);
  assert.strictEqual(AI.api.actionIntents.get("a04").status, "ready");
  const r = await AI.api.actionIntents.run(spec("a04", { action_class: "read", retry_safe: true }), async () => ({ ok: true }));
  assert.strictEqual(r.result, "succeeded");
});

check("A05 过期意图恢复后不执行", async () => {
  const c = ctx(tmp("momo-v3-a05-")); AI.init(c);
  const now = Date.now();
  AI.api.actionIntents.track(spec("a05", { now: now - 2000, valid_until: now - 1000 }));
  // 已过期创建会拒绝；另造一个短时效后到期恢复。
  AI.api.actionIntents.track(spec("a05b", { valid_until: now + 20 }));
  AI.api.actionIntents.recover(now + 30);
  assert.strictEqual(AI.api.actionIntents.get("a05b").status, "expired");
  let runs = 0;
  await AI.api.actionIntents.run(spec("a05b", { valid_until: now + 40 }), async () => { runs++; return { ok: true }; });
  assert.strictEqual(runs, 0);
});

check("A06 成功结果与 verified 证据分开", async () => {
  const c = ctx(tmp("momo-v3-a06-")); AI.init(c);
  const r = await AI.api.actionIntents.run(spec("a06"), async () => ({ ok: true, summary: "done" }), async () => ({ ok: true, eventId: "proof-1" }));
  assert.strictEqual(r.result, "succeeded"); assert.strictEqual(r.verified, true);
  assert.strictEqual(AI.api.actionIntents.get("a06").status, "succeeded");
});

check("A09 工具失败后其他行动仍可继续", async () => {
  const c = ctx(tmp("momo-v3-a09-")); AI.init(c);
  const bad = await AI.api.actionIntents.run(spec("a09bad"), async () => { throw new Error("bad"); });
  const good = await AI.api.actionIntents.run(spec("a09good"), async () => ({ ok: true }));
  assert.strictEqual(bad.result, "failed"); assert.strictEqual(good.result, "succeeded");
});

function lifeCtx(dir, opt) {
  const o = opt || {};
  const loops = o.loops || [];
  const c = ctx(dir, {
    isUserQuiet: () => !!o.quiet,
    getApi(ns) {
      if (ns === "autonomy") return { authorize: () => o.auth || { allowed: true } };
      if (ns === "health") return { snapshot: () => o.health || [{ name: "perception", status: "fresh" }] };
      if (ns === "mind") return { loadMindState: () => ({}), loadOpenLoops: () => loops };
      return null;
    },
  });
  return c;
}
const NOON = new Date(2026, 0, 2, 12, 0, 0).getTime();
const NIGHT = new Date(2026, 0, 2, 23, 30, 0).getTime();

check("L01 每日目标最多三件", () => {
  const c = lifeCtx(tmp("momo-v3-l01-"), { loops: Array.from({ length: 6 }, (_, i) => ({ text: "目标" + i })) });
  LIFE.init(c);
  const r = LIFE.api.life.tick(NOON);
  assert.strictEqual(r.goals.length, 3);
});

check("L02 夜间与安静状态不主动", () => {
  const c = lifeCtx(tmp("momo-v3-l02-"), { quiet: true }); LIFE.init(c);
  assert.strictEqual(LIFE.api.life.canProactive(1, { now: NIGHT }).reason, "night");
  assert.strictEqual(LIFE.api.life.canProactive(1, { now: NOON }).reason, "user_quiet");
});

check("L03 自主暂停时主动行为停止", () => {
  const c = lifeCtx(tmp("momo-v3-l03-"), { auth: { allowed: false, reason: "autonomy_paused" } }); LIFE.init(c);
  assert.strictEqual(LIFE.api.life.canProactive(1, { now: NOON }).reason, "autonomy_paused");
});

check("L04/L05 连续未回复冷却，回复后复位", () => {
  const c = lifeCtx(tmp("momo-v3-l04-")); LIFE.init(c); LIFE.api.life.tick(NOON);
  LIFE.api.life.recordProactiveOutcome(1, { result: "succeeded" }, NOON);
  assert.strictEqual(LIFE.api.life.canProactive(1, { now: NOON + 1000 }).ok, true);
  LIFE.api.life.recordProactiveOutcome(1, { result: "succeeded" }, NOON + 2000);
  assert.strictEqual(LIFE.api.life.canProactive(1, { now: NOON + 3000 }).reason, "feedback_cooldown");
  LIFE.api.life.noteUserReply(1, NOON + 4000);
  const gate = LIFE.api.life.canProactive(1, { now: NOON + 5000 });
  assert.strictEqual(gate.ok, true); assert.strictEqual(gate.ignored_streak, 0);
});

check("L06/L07 重启续当天，跨天不滚存旧目标", () => {
  const loops = [{ text: "旧目标" }];
  const c = lifeCtx(tmp("momo-v3-l06-"), { loops }); LIFE.init(c);
  const a = LIFE.api.life.tick(NOON);
  const b = LIFE.api.life.tick(NOON + 60000);
  assert.strictEqual(b.created, false); assert.deepStrictEqual(b.goals, a.goals);
  loops.length = 0;
  const next = LIFE.api.life.tick(NOON + 24 * 3600e3);
  assert.strictEqual(next.created, true); assert.ok(next.goals.every((g) => !String(g.text).includes("旧目标")));
});

check("S05 健康 degraded 阻止主动外发", () => {
  const c = lifeCtx(tmp("momo-v3-s05-"), { health: [{ name: "actionIntents", status: "degraded" }] }); LIFE.init(c);
  assert.strictEqual(LIFE.api.life.canProactive(1, { now: NOON }).ok, false);
});

function extract(name, asyncFlag) {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const sig = (asyncFlag ? "async " : "") + "function " + name + "(";
  const a = src.indexOf(sig); let i = src.indexOf("{", a), d = 0;
  for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) return src.slice(a, i + 1); }
  throw new Error(name);
}
check("A08 主动发送失败不得写已发日志", async () => {
  const calls = { logs: 0, settled: [], outcomes: [] };
  const intents = {
    track: (s) => ({ ok: true, key: s.key }), markRunning: () => ({ ok: true }),
    settle: (k, r) => { calls.settled.push(r); return { ok: true }; },
  };
  const life = { canProactive: () => ({ ok: true }), recordProactiveOutcome: (u, r) => calls.outcomes.push(r) };
  const box = {
    console, Date, JSON, Number, String, Promise, Map, Set,
    host: {}, apiOf: (ns) => ns === "life" ? life : (ns === "actionIntents" ? intents : null),
    actionKey: () => "send-key", log() {}, apiKey: "mock", isBudgetExhausted: () => false,
    loadSession: () => [], resolveCall: () => "主人", agentChatOnce: async () => ({ reply: "主动你好", stickers: [] }),
    buildPersonContext: () => ({}), proactiveLoggedDup: () => false, lastProactiveMsg: new Map(),
    appendProactiveLog: () => { calls.logs++; }, recordAndSend: async () => ({ result: "failed", key: "send-key", error: "send failed" }),
    sendStickerImage: async () => {}, noteStickerSent() {}, stickerSessionKey: () => "", sleep: async () => {},
  };
  vm.createContext(box);
  vm.runInContext(extract("beginAutonomousMessage") + "\n" + extract("finishAutonomousMessage") + "\n" + extract("proactiveAgentTurn", true) + "\nthis.go=proactiveAgentTurn", box);
  const r = await box.go(1, "测试主动");
  assert.strictEqual(r, null); assert.strictEqual(calls.logs, 0); assert.strictEqual(calls.settled[0].result, "failed");
});

chain.then(() => { console.log(`v3-action-life: ${pass}/${total} passed`); process.exit(pass === total ? 0 : 1); }).catch((e) => { console.error(e); process.exit(1); });
