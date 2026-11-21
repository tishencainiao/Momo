/* 框架服务 · 感知事件 perception 测试：归一/防重/过期/命令/上下文 + 隐私隔离（返修版） */
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

const mod = require("../plugins/perception-service.js");
const P = mod.__test;

function mkCtx(dir, over) {
  const base = {
    DATA_DIR: dir,
    log: () => {},
    writeJsonAtomic: (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); },
    writeFileAtomic: (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); },
    isMaster: (u) => u === 1,
    sendPrivate: () => {},
  };
  return Object.assign(base, over || {});
}

function evLines(dir) {
  try { return fs.readFileSync(path.join(dir, "perception-events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; }
}
function w(dir, file, objs) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), objs.map((o) => JSON.stringify(o)).join("\n") + "\n");
}

const now = Date.now();   // 插件内部用真实 Date.now()，测试基准必须用真时钟

check("observe 归一：字段完整、未知来源拒绝、落盘有界", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-pc1-"));
  mod.init(mkCtx(dir));
  const e = P.observe("user_report", { ts: now, event_type: "message", verification: "reported", payload: { userId: 3, text: "hi" } });
  assert.strictEqual(e.source_type, "user_report");
  assert.strictEqual(e.event_type, "message");
  assert.strictEqual(e.verification, "reported");
  assert.strictEqual(e.payload.userId, 3);
  assert.strictEqual(P.observe("weird_type", {}), null);
  assert.strictEqual(evLines(dir).length, 1);
});

check("recentEvents：过期标 stale、新鲜不标、按 limit/maxAge 过滤", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-pc2-"));
  mod.init(mkCtx(dir));
  const old = now - 20 * 60000;                     // user_report 10min 过期
  P.observe("user_report", { ts: old, payload: { userId: 1, text: "old" } });
  P.observe("user_report", { ts: now - 60000, payload: { userId: 1, text: "fresh" } });
  const evs = P.recentEvents({ limit: 10, maxAgeMs: 3600e3, sourceTypes: ["user_report"] });
  assert.strictEqual(evs.length, 2);
  const byText = (t) => evs.find((e) => e.payload.text === t);
  assert.strictEqual(byText("old").stale, true);
  assert.strictEqual(byText("fresh").stale, false);
  const outside = P.recentEvents({ limit: 10, maxAgeMs: 30000 });
  assert.strictEqual(outside.length, 0, "maxAge 过滤旧事件");
});

check("mapperMessage：私聊 user 域 + reported 口径；群聊保留 groupId", () => {
  const priv = P.mapperMessage({ ts: now, userId: 9, channel: "private", text: "我中了一百万" });
  assert.strictEqual(priv.verification, "reported", "用户陈述只能标 reported，不能当已验证事实");
  assert.strictEqual(priv.actor_scope, "user:9");
  assert.strictEqual(priv.privacy_scope, "user:9");
  assert.ok(priv.payload.text.includes("我中了一百万"));
  const grp = P.mapperMessage({ ts: now, userId: 8, channel: "group", groupId: 555, text: "群里说" });
  assert.strictEqual(grp.privacy_scope, "group:555");
  assert.strictEqual(grp.payload.groupId, 555, "groupId 不得丢弃");
});

check("consumeTail：哈希防重——重复消费不重复、同毫秒不同事件都保留、截断重建不重复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-pc3-"));
  mod.init(mkCtx(dir));
  w(dir, "messages.jsonl", [{ ts: now, userId: 9, channel: "private", text: "一条" }]);
  P.consumeTail("messages.jsonl", P.mapperMessage);
  P.consumeTail("messages.jsonl", P.mapperMessage);
  assert.strictEqual(evLines(dir).length, 1, "同偏移二次消费不重复");
  /* 同一毫秒两条不同消息：老版 ts<=lastTs 会误杀一条，哈希防重必须都保留 */
  w(dir, "messages.jsonl", [
    { ts: now + 1000, userId: 9, channel: "private", text: "同毫秒A" },
    { ts: now + 1000, userId: 9, channel: "private", text: "同毫秒B" },
  ]);
  P.consumeTail("messages.jsonl", P.mapperMessage);
  assert.strictEqual(evLines(dir).length, 3, "同毫秒不同事件都保留");
  /* 模拟截断重建：offset 超过文件大小 → 全量重读，哈希防重 */
  const st = P.loadState();
  st.offsets["messages.jsonl"] = 999999;
  fs.writeFileSync(path.join(dir, "perception-state.json"), JSON.stringify(st));
  P.consumeTail("messages.jsonl", P.mapperMessage);
  assert.strictEqual(evLines(dir).length, 3, "截断重建后哈希防重");
});

check("tailAll：三源各入一类，timer 节流 30s", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-pc4-"));
  mod.init(mkCtx(dir));
  w(dir, "messages.jsonl", [{ ts: now, userId: 5, channel: "private", text: "m" }]);
  w(dir, "tool-outcomes.jsonl", [{ ts: now, tool: "web_search", status: "succeeded", summary: "ok", userId: 5, channel: "private" }]);
  w(dir, "body-events.jsonl", [{ ts: now, event: "foreground", app: "x.exe" }]);
  mod.hooks.timer({ now });
  let evs = evLines(dir);
  const kinds = new Set(evs.map((e) => e.source_type));
  assert.ok(kinds.has("user_report") && kinds.has("tool_result") && kinds.has("system_observation"), "三源齐全");
  assert.strictEqual(evs.find((e) => e.source_type === "tool_result").verification, "self_reported");
  assert.strictEqual(evs.find((e) => e.source_type === "system_observation").privacy_scope, "system", "身体感官=系统域");
  w(dir, "body-events.jsonl", [{ ts: now + 1, event: "presence", presence: "active" }]);
  mod.hooks.timer({ now: now + 10000 });           // 30s 内 → 节流跳过
  assert.strictEqual(evLines(dir).length, evs.length, "节流期间不消费");
  mod.hooks.timer({ now: now + 31000 });
  evs = evLines(dir);
  assert.strictEqual(evs.length, 4, "节流窗口过后消费新行");
});

check("mapper 三件套：坏行返回 null", () => {
  assert.strictEqual(P.mapperMessage({}), null);
  assert.strictEqual(P.mapperTool({}), null);
  assert.strictEqual(P.mapperBody({}), null);
  assert.strictEqual(P.mapperTool({ ts: 1, tool: "x", status: "failed", summary: "" }).verification, "failed");
});

check("/感知 命令：主人看到全局清单，非主人被拒", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-pc5-"));
  let sent = "";
  mod.init(mkCtx(dir, { sendPrivate: (u, t) => { sent = t; } }));
  P.observe("user_report", { ts: now, event_type: "message", verification: "reported", actor_scope: "user:1", privacy_scope: "user:1", payload: { userId: 1, channel: "private", text: "看看感知" } });
  mod.commands[0].handler({ userId: 1 });
  assert.ok(sent.includes("最近感知") && sent.includes("报告"), "主人看到清单（含「报告」口径）");
  sent = "";
  mod.commands[0].handler({ userId: 2 });
  assert.ok(sent.includes("只有主人"), "非主人被拒");
});

check("contextProvider 隐私隔离：两用户两群互不可见，system 全局可见", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-pc6-"));
  mod.init(mkCtx(dir));
  const U1 = 101, U2 = 202, GA = 777, GB = 888;
  P.observe("user_report", { ts: now, actor_scope: "user:" + U1, privacy_scope: "user:" + U1, payload: { userId: U1, channel: "private", text: "小A的私房话" } });
  P.observe("user_report", { ts: now, actor_scope: "user:" + U2, privacy_scope: "user:" + U2, payload: { userId: U2, channel: "private", text: "小B的私房话" } });
  P.observe("user_report", { ts: now, actor_scope: "group:" + GA, privacy_scope: "group:" + GA, payload: { userId: U2, channel: "group", groupId: GA, text: "A群聊天" } });
  P.observe("user_report", { ts: now, actor_scope: "group:" + GB, privacy_scope: "group:" + GB, payload: { userId: U2, channel: "group", groupId: GB, text: "B群聊天" } });
  P.observe("system_observation", { ts: now, actor_scope: "system", privacy_scope: "system", payload: { app: "x.exe" } });

  const t1 = mod.contextProvider({ userId: U1, channel: "private" });
  assert.ok(t1.includes("小A的私房话"), "本人私聊事件可见");
  assert.ok(!t1.includes("小B的私房话"), "他人私聊正文不得泄露给 U1");
  assert.ok(!t1.includes("A群聊天") && !t1.includes("B群聊天"), "群消息不得进私聊上下文");
  assert.ok(t1.includes("身体感官"), "system 事件全局可见");

  const t2 = mod.contextProvider({ userId: U2, channel: "group", groupId: GA });
  assert.ok(t2.includes("A群聊天"), "本群消息可见");
  assert.ok(!t2.includes("B群聊天"), "他群消息不得泄露");
  assert.ok(!t2.includes("小A的私房话"), "他人私聊正文不得泄露给 U2");
  assert.ok(t2.includes("小B的私房话"), "本人私聊事件在群聊上下文也可见（同一用户作用域）");
});

check("contextProvider 口径：用户陈述说「报告」不说「事实」，无事件/全过期为空", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-pc7-"));
  mod.init(mkCtx(dir));
  assert.strictEqual(mod.contextProvider({ userId: 1, channel: "private" }), "", "无事件为空");
  P.observe("user_report", { ts: now, actor_scope: "user:1", privacy_scope: "user:1", payload: { userId: 1, channel: "private", text: "我中了一百万" } });
  const txt = mod.contextProvider({ userId: 1, channel: "private" });
  assert.ok(txt.includes("对方报告") && txt.includes("我中了一百万"), "用户陈述用「对方报告」口径：" + txt);
  assert.ok(!txt.includes("verified") && !txt.includes("事实"), "不把用户陈述当已验证事实");
  const dirOld = fs.mkdtempSync(path.join(os.tmpdir(), "momo-pc8-"));
  mod.init(mkCtx(dirOld));
  P.observe("user_report", { ts: now - 3600e3, actor_scope: "user:1", privacy_scope: "user:1", payload: { userId: 1, text: "很久以前" } });
  assert.strictEqual(mod.contextProvider({ userId: 1, channel: "private" }), "", "过期事件不注入");
});

_chain.then(() => {
  console.log("\n" + pass + "/" + n + " 通过" + (pass === n ? "" : "（有失败）"));
  process.exit(pass === n ? 0 : 1);
});
