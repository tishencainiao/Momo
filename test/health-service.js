/* 框架服务 · 健康快照 health：classify 纯函数 + 探活快照 + /体检 + 异常才注入 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");

let n = 0, pass = 0;
let _chain = Promise.resolve();
function check(name, fn) {
  n++;
  _chain = _chain.then(async () => {
    try { await fn(); pass++; console.log("  ✓ " + name); }
    catch (e) { console.log("  ✗ " + name + " -> " + (e && e.message)); }
  });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "momo-health-"));

function mkCtx(over) {
  const base = {
    DATA_DIR: TMP,
    log: () => {},
    writeJsonAtomic: (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); },
    writeFileAtomic: (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); },
    isMaster: (u) => u === 1,
    sendPrivate: () => {},
    getApi: () => null,
    wsStatus: () => ({ state: "open", since: Date.now(), lastError: "" }),
    loadToolOutcomes: () => [],
  };
  return Object.assign(base, over || {});
}

const mod = require("../plugins/health-service.js");
let ctx = mkCtx();
mod.init(ctx);
const H = mod.__test;

check("system:true + apiSpec.health 两函数", () => {
  assert.strictEqual(mod.system, true);
  assert.ok(mod.apiSpec && mod.apiSpec.health && mod.apiSpec.health.snapshot && mod.apiSpec.health.problems);
});

check("classify：五态判定（fresh/offline/degraded/stale/unknown）", () => {
  const now = 1e12, ttl = 300000;
  assert.strictEqual(H.classify("x", { lastOkAt: now - 1000 }, now, ttl).status, "fresh");
  assert.strictEqual(H.classify("x", { lastErrAt: now - 1000 }, now, ttl).status, "offline");
  assert.strictEqual(H.classify("x", { lastOkAt: now - 1000, lastErrAt: now - 2000 }, now, ttl).status, "degraded");
  assert.strictEqual(H.classify("x", { lastOkAt: now - ttl - 1 }, now, ttl).status, "stale");
  assert.strictEqual(H.classify("x", {}, now, ttl).status, "unknown");
});

check("探活：ws 断开→onebot offline；body 探活失败→offline；预算耗尽→degraded", async () => {
  let fetchCount = 0;
  const bodyApi = { status: async () => { fetchCount++; throw new Error("ECONNREFUSED"); } };
  const c2 = mkCtx({
    wsStatus: () => ({ state: "closed", since: Date.now(), lastError: "ECONNREFUSED" }),
    getApi: (ns) => (ns === "body" ? bodyApi : ns === "budget" ? { isBudgetExhausted: () => true, budgetTier: () => "minimal" } : null),
  });
  mod.init(c2);
  await mod.__test.probe();
  const s = mod.__test.allSnapshot();
  const byName = (k) => s.find((x) => x.name === k);
  assert.strictEqual(byName("onebot").status, "offline");
  assert.strictEqual(byName("body").status, "offline");
  assert.strictEqual(byName("budget").status, "degraded");
  assert.ok(byName("budget").evidence.includes("minimal"));
  assert.ok(fetchCount > 0, "身体探活应真实发起");
});

check("探活：ws open→onebot fresh；body 在线→fresh；工具失败→degraded", async () => {
  const bodyApi = { status: async () => ({ data: { ok: true, pid: 123, visible: true } }) };
  const c2 = mkCtx({
    getApi: (ns) => (ns === "body" ? bodyApi : ns === "budget" ? { isBudgetExhausted: () => false, budgetTier: () => "full" } : null),
    loadToolOutcomes: () => [{ ts: Date.now(), tool: "web_search", status: "failed" }],
  });
  mod.init(c2);
  await mod.__test.probe();
  const s = mod.__test.allSnapshot();
  const byName = (k) => s.find((x) => x.name === k);
  assert.strictEqual(byName("onebot").status, "fresh");
  assert.strictEqual(byName("body").status, "fresh");
  assert.ok(byName("body").evidence.includes("pid 123"));
  assert.strictEqual(byName("tools").status, "degraded");
});

check("账本遗留：open>0 → ledger stale", async () => {
  fs.writeFileSync(path.join(TMP, "action-state.json"), JSON.stringify({ open: { k1: { status: "running" } } }));
  const c2 = mkCtx();
  mod.init(c2);
  await mod.__test.probe();
  const led = mod.__test.allSnapshot().find((x) => x.name === "ledger");
  assert.strictEqual(led.status, "stale");
  fs.writeFileSync(path.join(TMP, "action-state.json"), JSON.stringify({ open: {} }));
});

check("/体检 命令：只有主人能看，输出含状态词", async () => {
  let sent = "";
  const c2 = mkCtx({
    sendPrivate: (u, t) => { sent = t; },
    isMaster: (u) => u === 7,
  });
  mod.init(c2);
  mod.commands[0].handler({ userId: 7 });
  await new Promise((r) => setTimeout(r, 120));     // handler 内异步 probe
  assert.ok(sent.includes("体检报告"), "主人应收到报告，got: " + sent);
  assert.ok(sent.includes("onebot") && sent.includes("body"), "报告应含各能力行");
  sent = "";
  mod.commands[0].handler({ userId: 2 });
  assert.ok(sent.includes("只有主人"), "非主人应被拒");
});

check("返修：embed available()=false → 不得显示 fresh", async () => {
  const c2 = mkCtx({
    getApi: (ns) => (ns === "embed" ? { available: () => false } : ns === "budget" ? { isBudgetExhausted: () => false, budgetTier: () => "full" } : null),
  });
  mod.init(c2);
  await mod.__test.probe();
  const emb = mod.__test.allSnapshot().find((x) => x.name === "embed");
  assert.strictEqual(emb.status, "offline", "模型不可用必须判 offline，got: " + JSON.stringify(emb));
});

check("返修：账本损坏 → ledger unknown，不得显示「无遗留」", async () => {
  fs.writeFileSync(path.join(TMP, "action-state.json"), "{ 这不是 JSON");
  const c2 = mkCtx();
  mod.init(c2);
  await mod.__test.probe();
  const led = mod.__test.allSnapshot().find((x) => x.name === "ledger");
  assert.strictEqual(led.status, "unknown", "账本不可读必须判 unknown，got: " + JSON.stringify(led));
  assert.ok((led.evidence || "").includes("不可读"), "证据应说明不可读：" + JSON.stringify(led));
  assert.ok(!(led.evidence || "").includes("无遗留"), "不可读时不得宣称无遗留");
  fs.writeFileSync(path.join(TMP, "action-state.json"), JSON.stringify({ open: {} }));
});

check("返修：工具流水全 unknown → tools stale，不得显示正常", async () => {
  const c2 = mkCtx({
    loadToolOutcomes: () => [{ ts: Date.now(), tool: "legacy_tool", status: "unknown" }],
  });
  mod.init(c2);
  await mod.__test.probe();
  const tools = mod.__test.allSnapshot().find((x) => x.name === "tools");
  assert.strictEqual(tools.status, "stale", "全 unknown 必须判 stale（需人工确认），got: " + JSON.stringify(tools));
  assert.ok((tools.evidence || "").includes("结果不明"), "证据应提示结果不明：" + JSON.stringify(tools));
});

check("WP4：感知健康信号 → perception fresh / offline / unknown", async () => {
  const freshCtx = mkCtx({
    getApi: (ns) => (ns === "perception" ? { health: () => ({ lastOkAt: Date.now() - 1000, lastErrAt: 0, lastError: "" }) } : null),
  });
  mod.init(freshCtx);
  await mod.__test.probe();
  assert.strictEqual(mod.__test.allSnapshot().find((x) => x.name === "perception").status, "fresh");
  const offCtx = mkCtx({
    getApi: (ns) => (ns === "perception" ? { health: () => ({ lastOkAt: 0, lastErrAt: Date.now() - 1000, lastError: "messages.jsonl 读取失败" }) } : null),
  });
  mod.init(offCtx);
  await mod.__test.probe();
  const p = mod.__test.allSnapshot().find((x) => x.name === "perception");
  assert.strictEqual(p.status, "offline", "感知报错必须判 offline，got: " + JSON.stringify(p));
  assert.ok((p.evidence || "").includes("读取失败"), "应带错误信息：" + JSON.stringify(p));
  mod.init(mkCtx());
  await mod.__test.probe();
  assert.strictEqual(mod.__test.allSnapshot().find((x) => x.name === "perception").status, "unknown");
});

check("WP4：fresh 快照过期 → 降级 stale（不保留过期 fresh）", async () => {
  mod.init(mkCtx());
  await mod.__test.probe();
  let one = mod.__test.allSnapshot().find((x) => x.name === "onebot");
  assert.strictEqual(one.status, "fresh");
  mod.__test._snap.onebot.updatedAt = Date.now() - mod.__test.SNAP_STALE_MS - 60000;
  one = mod.__test.allSnapshot().find((x) => x.name === "onebot");
  assert.strictEqual(one.status, "stale", "过期 fresh 必须降级 stale，got: " + JSON.stringify(one));
  assert.ok((one.evidence || "").includes("快照过期"), "应注明快照过期：" + JSON.stringify(one));
});

check("A20：工具健康按每工具最新结果判断恢复", async () => {
  /* 同一工具先失败后成功：保留 [failed, succeeded] 两条记录 → 该工具已恢复 → fresh */
  const outcomes = [
    { ts: Date.now() - 300000, tool: "web_search", status: "failed" },
    { ts: Date.now() - 60000, tool: "web_search", status: "succeeded" },
  ];
  mod.init(mkCtx({ loadToolOutcomes: () => outcomes }));
  await mod.__test.probe();
  let t = mod.__test.allSnapshot().find((x) => x.name === "tools");
  assert.strictEqual(t.status, "fresh", "同工具最新 succeeded 应判 fresh（保留失败记录），got: " + JSON.stringify(t));
  /* A 工具失败、B 工具成功：不能把 A 算恢复 */
  const mixed = [
    { ts: Date.now() - 300000, tool: "web_search", status: "failed" },
    { ts: Date.now() - 60000, tool: "weather", status: "succeeded" },
  ];
  mod.init(mkCtx({ loadToolOutcomes: () => mixed }));
  await mod.__test.probe();
  t = mod.__test.allSnapshot().find((x) => x.name === "tools");
  assert.strictEqual(t.status, "degraded", "A 失败 B 成功不能算 A 恢复，got: " + JSON.stringify(t));
  /* 最新结果 unknown：仍不得显示 fresh */
  const unk = [
    { ts: Date.now() - 300000, tool: "web_search", status: "succeeded" },
    { ts: Date.now() - 60000, tool: "web_search", status: "unknown" },
  ];
  mod.init(mkCtx({ loadToolOutcomes: () => unk }));
  await mod.__test.probe();
  t = mod.__test.allSnapshot().find((x) => x.name === "tools");
  assert.strictEqual(t.status, "stale", "最新 unknown 不得显示 fresh，got: " + JSON.stringify(t));
  assert.ok(!(t.evidence || "").includes("全部成功"), "文案不得称全部成功：" + JSON.stringify(t));
});

check("WP4：消化健康 digestStatus → fresh/degraded/stale/unknown", async () => {
  const mk = (dg) => mkCtx({ getApi: (ns) => (ns === "memoryDigest" ? { digestStatus: () => dg } : null) });
  const c1 = mk(null);
  mod.init(c1); await mod.__test.probe();
  assert.strictEqual(mod.__test.allSnapshot().find((s) => s.name === "digest").status, "unknown", "未加载→unknown");
  const c2 = mk({ scopes: { "100000001": { status: "ok" }, "43": { status: "ok" } }, dead: ["43"], pending: [], stale: [], lastError: "" });
  mod.init(c2); await mod.__test.probe();
  const d2 = mod.__test.allSnapshot().find((s) => s.name === "digest");
  assert.strictEqual(d2.status, "degraded", "dead 非空→degraded");
  assert.ok(d2.evidence.includes("死任务"), "证据含死任务：" + d2.evidence);
  const c3 = mk({ scopes: { "43": { status: "failed" } }, dead: [], pending: ["43"], stale: [], lastError: "fake" });
  mod.init(c3); await mod.__test.probe();
  const d3 = mod.__test.allSnapshot().find((s) => s.name === "digest");
  assert.strictEqual(d3.status, "degraded", "pending 非空→degraded");
  assert.ok(d3.evidence.includes("失败/挂起") && d3.evidence.includes("fake"), "证据含失败文案与 lastError");
  const c4 = mk({ scopes: { "100000001": { status: "ok", last_success: 1 }, "43": { status: "ok", last_success: 1 } }, dead: [], pending: [], stale: ["43"], lastError: "" });
  mod.init(c4); await mod.__test.probe();
  assert.strictEqual(mod.__test.allSnapshot().find((s) => s.name === "digest").status, "stale", "仅 stale→stale");
  const c5 = mk({ scopes: { "100000001": { status: "ok" } }, dead: [], pending: [], stale: [], lastError: "" });
  mod.init(c5); await mod.__test.probe();
  assert.strictEqual(mod.__test.allSnapshot().find((s) => s.name === "digest").status, "fresh", "全 ok→fresh");
  mod.init(ctx); // 恢复主 ctx
});

check("contextProvider：全 fresh/unknown 不注入；有异常才注入", async () => {
  const bodyApi = { status: async () => ({ data: { ok: true, pid: 1, visible: true } }) };
  const c2 = mkCtx({
    getApi: (ns) => (ns === "body" ? bodyApi : ns === "budget" ? { isBudgetExhausted: () => false, budgetTier: () => "full" } : null),
  });
  mod.init(c2);
  await mod.__test.probe();
  const clean = mod.contextProvider({ userId: 1 });
  assert.strictEqual(clean, "", "无异常不应注入");
  mod.__test._setSnap("onebot", { status: "offline", since: Date.now(), evidence: "WS 断开" });
  const dirty = mod.contextProvider({ userId: 1 });
  assert.ok(dirty.includes("【健康】") && dirty.includes("onebot:offline"), "有异常应注入：" + dirty);
});

_chain.then(() => {
  console.log("\n" + pass + "/" + n + " 通过" + (pass === n ? "" : "（有失败）"));
  process.exit(pass === n ? 0 : 1);
});
