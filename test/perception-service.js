/* 框架服务 · 感知事件 perception 测试 v1.3.0（WP1 作用域闭环 + WP2 消费完整性）
 * 行为测试：归一拒绝 / stale / mapper 作用域 / 哈希防重 / 三源与节流 /
 * 缺 groupId 群消息拒绝 / 主人全局+legacy 标记 / contextProvider 作用域隔离（含旧断言反转） /
 * 口径与过期 / 半行保留消费 / 坏行跳过 / valid_until 优先 / event_id 稳定 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const crypto = require("crypto");

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
    isMaster: (u) => u === 1,          // 主人 = userId 1
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
function lineHash(t) {
  return crypto.createHash("sha1").update(t.trim()).digest("hex").slice(0, 16);
}

const now = Date.now();   // 插件内部用真实 Date.now()，测试基准必须用真时钟

check("observe 归一与拒绝：缺作用域一律拒绝，system_observation 默认 local", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p1-"));
  mod.init(mkCtx(dir));
  assert.strictEqual(P.observe("weird_type", {}), null, "未知来源拒绝");
  assert.strictEqual(P.observe("user_report", { ts: now, payload: { text: "无主" } }), null, "user_report 缺 userId 拒绝（不默认 system）");
  assert.strictEqual(P.observe("tool_result", { ts: now, tool: "web_search", status: "ok" }), null, "tool_result 非 pet 缺 userId 拒绝");
  assert.strictEqual(P.observe("model_inference", { ts: now, payload: {} }), null, "model_inference 缺 userId 拒绝");
  const sys = P.observe("system_observation", { ts: now, event_type: "foreground", payload: { app: "x.exe" } });
  assert.strictEqual(sys.actor_scope, "local");
  assert.strictEqual(sys.privacy_scope, "local", "身体观察默认 local（不再 system 全局）");
  const pub = P.observe("system_observation", { ts: now, public: true, event_type: "x", payload: {} });
  assert.strictEqual(pub.privacy_scope, "system_public", "显式 public 才进 system_public");
  assert.strictEqual(evLines(dir).length, 2);
});

check("observe 事件身份：event_id 稳定（同内容同 id）、observed_at 有值、valid_until 透传", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p1b-"));
  mod.init(mkCtx(dir));
  const a = P.observe("user_report", { ts: now, payload: { userId: 1, text: "同一条" } });
  const b = P.observe("user_report", { ts: now, payload: { userId: 1, text: "同一条" } });
  assert.strictEqual(a.event_id, b.event_id, "同一事件重复 observe 得同一 event_id");
  assert.ok(typeof a.observed_at === "number" && a.observed_at > 0, "observed_at 必须存在");
  const c = P.observe("user_report", { ts: now, valid_until: now + 3600e3, payload: { userId: 1, text: "有时效" } });
  assert.strictEqual(c.valid_until, now + 3600e3, "valid_until 透传");
});

check("recentEvents：过期标 stale、新鲜不标、按 limit/maxAge 过滤", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p2-"));
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

check("recentEvents：valid_until 优先于默认窗口", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p2b-"));
  mod.init(mkCtx(dir));
  P.observe("user_report", { ts: now - 1000, valid_until: now - 500, payload: { userId: 1, text: "显式失效" } });   // ts 很新但 valid_until 已过
  P.observe("user_report", { ts: now - 1000, valid_until: now + 3600e3, payload: { userId: 1, text: "显式未失效" } });
  const evs = P.recentEvents({ limit: 10, maxAgeMs: 3600e3, sourceTypes: ["user_report"] });
  assert.strictEqual(evs.find((e) => e.payload.text === "显式失效").stale, true, "valid_until 已过 → stale 即使仍在默认窗口内");
  assert.strictEqual(evs.find((e) => e.payload.text === "显式未失效").stale, false, "valid_until 未到 → 不 stale");
});

check("mapperMessage：私聊 user 域+reported；群保留 groupId；缺 groupId 群消息拒绝", () => {
  const priv = P.mapperMessage({ ts: now, userId: 9, channel: "private", text: "我中了一百万" });
  assert.strictEqual(priv.verification, "reported", "用户陈述只能标 reported，不能当已验证事实");
  assert.strictEqual(priv.actor_scope, "user:9");
  assert.strictEqual(priv.privacy_scope, "user:9");
  assert.ok(priv.payload.text.includes("我中了一百万"));
  const grp = P.mapperMessage({ ts: now, userId: 8, channel: "group", groupId: 555, text: "群里说" });
  assert.strictEqual(grp.privacy_scope, "group:555");
  assert.strictEqual(grp.payload.groupId, 555, "groupId 不得丢弃");
  assert.strictEqual(P.mapperMessage({ ts: now, userId: 8, channel: "group", text: "无群号" }), null, "缺 groupId 群消息拒绝，禁止 group:0");
});

check("mapperTool：私聊 user / 群 group / pet local；缺 userId 拒绝", () => {
  const priv = P.mapperTool({ ts: now, tool: "web_search", status: "succeeded", userId: 5, channel: "private" });
  assert.strictEqual(priv.privacy_scope, "user:5");
  assert.strictEqual(priv.verification, "self_reported");
  const grp = P.mapperTool({ ts: now, tool: "weather", status: "failed", userId: 5, channel: "group", groupId: 999 });
  assert.strictEqual(grp.privacy_scope, "group:999");
  assert.strictEqual(grp.payload.groupId, 999);
  assert.strictEqual(grp.verification, "failed");
  const pet = P.mapperTool({ ts: now, tool: "pet_play", status: "succeeded", petMode: true });
  assert.strictEqual(pet.privacy_scope, "local");
  assert.strictEqual(P.mapperTool({ ts: now, tool: "x", status: "succeeded" }), null, "无主工具结果拒绝");
  assert.strictEqual(P.mapperTool({}), null);
  assert.strictEqual(P.mapperMessage({}), null);
  assert.strictEqual(P.mapperBody({}), null);
});

check("mapperBody：身体感官 = local（旧 system 全局断言已反转）", () => {
  const b = P.mapperBody({ ts: now, event: "foreground", app: "x.exe" });
  assert.strictEqual(b.actor_scope, "local");
  assert.strictEqual(b.privacy_scope, "local");
  assert.strictEqual(b.verification, "verified");
  assert.strictEqual(b.payload.app, "x.exe");
});

check("consumeTail：哈希防重——重复消费不重复、同毫秒都保留、截断重建不重复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p3-"));
  mod.init(mkCtx(dir));
  w(dir, "messages.jsonl", [{ ts: now, userId: 9, channel: "private", text: "一条" }]);
  P.consumeTail("messages.jsonl", P.mapperMessage);
  P.consumeTail("messages.jsonl", P.mapperMessage);
  assert.strictEqual(evLines(dir).length, 1, "同偏移二次消费不重复");
  w(dir, "messages.jsonl", [
    { ts: now + 1000, userId: 9, channel: "private", text: "同毫秒A" },
    { ts: now + 1000, userId: 9, channel: "private", text: "同毫秒B" },
  ]);
  P.consumeTail("messages.jsonl", P.mapperMessage);
  assert.strictEqual(evLines(dir).length, 3, "同毫秒不同事件都保留");
  const st = P.loadState();
  st.offsets["messages.jsonl"] = 999999;
  fs.writeFileSync(path.join(dir, "perception-state.json"), JSON.stringify(st));
  P.consumeTail("messages.jsonl", P.mapperMessage);
  assert.strictEqual(evLines(dir).length, 3, "截断重建后哈希防重");
});

check("consumeTail：末尾半行保留到下一轮，补全后恰好消费一次", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p3b-"));
  mod.init(mkCtx(dir));
  const l1 = JSON.stringify({ ts: now, userId: 9, channel: "private", text: "完整A" });
  fs.appendFileSync(path.join(dir, "messages.jsonl"), l1 + "\n" + '{"ts":' + now + ',"userId":9,"channel":"private","text":"半行');   // 无换行的半条
  P.consumeTail("messages.jsonl", P.mapperMessage);
  assert.strictEqual(evLines(dir).length, 1, "首轮只消费完整行，半行保留");
  P.consumeTail("messages.jsonl", P.mapperMessage);
  assert.strictEqual(evLines(dir).length, 1, "半行未补全前不推进 offset、不消费");
  fs.appendFileSync(path.join(dir, "messages.jsonl"), 'B"} \n');   // 补全剩余半行
  P.consumeTail("messages.jsonl", P.mapperMessage);
  assert.strictEqual(evLines(dir).length, 2, "补全后半行被消费");
  P.consumeTail("messages.jsonl", P.mapperMessage);
  assert.strictEqual(evLines(dir).length, 2, "补全行只消费一次");
});

check("consumeTail：完整但非法 JSON 行跳过，不影响后续完整行", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p3c-"));
  mod.init(mkCtx(dir));
  const ok1 = JSON.stringify({ ts: now, userId: 9, channel: "private", text: "合法1" });
  const ok2 = JSON.stringify({ ts: now, userId: 9, channel: "private", text: "合法2" });
  fs.appendFileSync(path.join(dir, "messages.jsonl"), ok1 + "\n" + '{"ts": ' + now + ', "userId": 9, "text": 坏行\n' + ok2 + "\n");
  P.consumeTail("messages.jsonl", P.mapperMessage);
  const evs = evLines(dir);
  assert.strictEqual(evs.length, 2, "坏行跳过，前后完整行都消费");
  assert.ok(evs.every((e) => e.payload.text !== undefined), "无坏行事件入账");
  P.consumeTail("messages.jsonl", P.mapperMessage);
  assert.strictEqual(evLines(dir).length, 2, "坏行不重试（hash 已记 seen）");
});

check("A19：解析失败进健康信号——lastErrAt>0 且错误不含正文，合法行照常入账，重复 tail 不重复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p3c2-"));
  mod.init(mkCtx(dir));
  const ok = JSON.stringify({ ts: now, userId: 9, channel: "private", text: "合法" });
  const badBody = "绝密正文内容XYZ";
  fs.appendFileSync(path.join(dir, "messages.jsonl"), '{"ts": ' + now + ', "userId": 9, "text": ' + badBody + '\n' + ok + "\n");
  P.tailAll();
  const h = P._health();
  assert.ok(h.lastErrAt > 0, "解析失败必须反映到 health.lastErrAt");
  assert.ok(String(h.lastError).includes("感知解析失败"), "错误信息注明解析失败");
  assert.ok(!String(h.lastError).includes(badBody), "错误信息不得包含消息正文");
  assert.strictEqual(evLines(dir).length, 1, "合法行照常入账，坏行不入账");
  P.tailAll();
  assert.strictEqual(evLines(dir).length, 1, "重复 tail 不重复入账");
});

check("consumeTail：event_id 稳定——同一原始行同一 id，同 ts 不同内容不同 id", () => {
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p3d-"));
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p3e-"));
  mod.init(mkCtx(d1));
  const lA = JSON.stringify({ ts: now, userId: 9, channel: "private", text: "身份A" });
  const lB = JSON.stringify({ ts: now, userId: 9, channel: "private", text: "身份B" });   // 同 ts 不同内容
  fs.appendFileSync(path.join(d1, "messages.jsonl"), lA + "\n" + lB + "\n");
  P.consumeTail("messages.jsonl", P.mapperMessage);
  const evs1 = evLines(d1);
  assert.strictEqual(evs1.length, 2);
  assert.strictEqual(evs1[0].event_id, "messages.jsonl:" + lineHash(lA), "event_id = 文件+行指纹");
  assert.notStrictEqual(evs1[0].event_id, evs1[1].event_id, "同 ts 不同内容不得共用 event_id");
  mod.init(mkCtx(d2));
  fs.appendFileSync(path.join(d2, "messages.jsonl"), lA + "\n");
  P.consumeTail("messages.jsonl", P.mapperMessage);
  const evs2 = evLines(d2);
  assert.strictEqual(evs2[0].event_id, evs1[0].event_id, "同一原始行在不同目录 event_id 稳定一致");
  assert.ok(evs2[0].observed_at > 0, "tail 消费事件也带 observed_at");
});

check("tailAll：三源各入一类（身体=local），timer 节流 30s", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p4-"));
  mod.init(mkCtx(dir));
  w(dir, "messages.jsonl", [{ ts: now, userId: 5, channel: "private", text: "m" }]);
  w(dir, "tool-outcomes.jsonl", [{ ts: now, tool: "web_search", status: "succeeded", summary: "ok", userId: 5, channel: "private" }]);
  w(dir, "body-events.jsonl", [{ ts: now, event: "foreground", app: "x.exe" }]);
  mod.hooks.timer({ now });
  let evs = evLines(dir);
  const kinds = new Set(evs.map((e) => e.source_type));
  assert.ok(kinds.has("user_report") && kinds.has("tool_result") && kinds.has("system_observation"), "三源齐全");
  assert.strictEqual(evs.find((e) => e.source_type === "tool_result").verification, "self_reported");
  assert.strictEqual(evs.find((e) => e.source_type === "system_observation").privacy_scope, "local", "身体感官=local 域");
  w(dir, "body-events.jsonl", [{ ts: now + 1, event: "presence", presence: "active" }]);
  mod.hooks.timer({ now: now + 10000 });           // 30s 内 → 节流跳过
  assert.strictEqual(evLines(dir).length, evs.length, "节流期间不消费");
  mod.hooks.timer({ now: now + 31000 });
  evs = evLines(dir);
  assert.strictEqual(evs.length, 4, "节流窗口过后消费新行");
});

check("/感知 命令：主人全局 + legacy_unscoped 明确标记，非主人被拒", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p5-"));
  let sent = "";
  mod.init(mkCtx(dir, { sendPrivate: (u, t) => { sent = t; } }));
  P.observe("user_report", { ts: now, event_type: "message", verification: "reported", actor_scope: "user:1", privacy_scope: "user:1", payload: { userId: 1, channel: "private", text: "看看感知" } });
  w(dir, "perception-events.jsonl", [{ ts: now - 60000, source_type: "user_report", source: "旧", event_type: "message", verification: "reported", payload: { text: "无主旧事件" } }]);
  mod.commands[0].handler({ userId: 1 });
  assert.ok(sent.includes("最近感知") && sent.includes("报告"), "主人看到清单（含「报告」口径）");
  assert.ok(sent.includes("旧数据·未定域"), "legacy_unscoped 全局视图必须明确标记：" + sent);
  sent = "";
  mod.commands[0].handler({ userId: 2 });
  assert.ok(sent.includes("只有主人"), "非主人被拒");
});

check("contextProvider 作用域隔离：私聊不串人、任何私聊不进群（含本人）、群不串、身体只进主人/pet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p6-"));
  mod.init(mkCtx(dir));
  const U1 = 101, U2 = 202, GA = 777, GB = 888;
  P.observe("user_report", { ts: now, actor_scope: "user:" + U1, privacy_scope: "user:" + U1, payload: { userId: U1, channel: "private", text: "小A的私房话" } });
  P.observe("user_report", { ts: now, actor_scope: "user:" + U2, privacy_scope: "user:" + U2, payload: { userId: U2, channel: "private", text: "小B的私房话" } });
  P.observe("user_report", { ts: now, actor_scope: "user:" + U2, privacy_scope: "group:" + GA, payload: { userId: U2, channel: "group", groupId: GA, text: "A群聊天" } });
  P.observe("user_report", { ts: now, actor_scope: "user:" + U2, privacy_scope: "group:" + GB, payload: { userId: U2, channel: "group", groupId: GB, text: "B群聊天" } });
  P.observe("tool_result", { ts: now, actor_scope: "user:" + U2, privacy_scope: "group:" + GA, payload: { tool: "weather", status: "succeeded", userId: U2, channel: "group", groupId: GA } });
  P.observe("system_observation", { ts: now, actor_scope: "local", privacy_scope: "local", payload: { app: "x.exe" } });
  w(dir, "perception-events.jsonl", [{ ts: now - 60000, source_type: "user_report", source: "旧", event_type: "message", verification: "reported", payload: { text: "旧无主事件" } }]);

  const t1 = mod.contextProvider({ userId: U1, channel: "private" });
  assert.ok(t1.includes("小A的私房话"), "本人私聊事件可见");
  assert.ok(!t1.includes("小B的私房话"), "他人私聊正文不得泄露给 U1");
  assert.ok(!t1.includes("A群聊天") && !t1.includes("B群聊天"), "群消息不得进私聊上下文");
  assert.ok(!t1.includes("weather"), "群工具结果不得进私聊上下文");
  assert.ok(!t1.includes("身体感官"), "非主人私聊不得见本机观察（旧断言反转）");
  assert.ok(!t1.includes("旧无主事件"), "legacy_unscoped 不得注入上下文");

  const tM = mod.contextProvider({ userId: 1, channel: "private" });   // 主人
  assert.ok(tM.includes("身体感官"), "主人私聊可见本机观察");

  const tPet = mod.contextProvider({ userId: 1, channel: "private", petMode: true });
  assert.ok(tPet.includes("身体感官"), "桌宠上下文可见本机观察");

  const t2 = mod.contextProvider({ userId: U2, channel: "group", groupId: GA });
  assert.ok(t2.includes("A群聊天"), "本群消息可见");
  assert.ok(!t2.includes("B群聊天"), "他群消息不得泄露");
  assert.ok(!t2.includes("小A的私房话"), "他人私聊正文不得泄露给 U2");
  assert.ok(!t2.includes("小B的私房话"), "本人私聊事件也不得进群聊上下文（P0-2 反转旧断言）");
  assert.ok(t2.includes("weather"), "本群工具结果可见");
  assert.ok(!t2.includes("身体感官"), "群聊不得见本机观察");
});

check("contextProvider 口径：说「报告」不说「事实」，无事件/全过期为空", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p7-"));
  mod.init(mkCtx(dir));
  assert.strictEqual(mod.contextProvider({ userId: 1, channel: "private" }), "", "无事件为空");
  P.observe("user_report", { ts: now, actor_scope: "user:1", privacy_scope: "user:1", payload: { userId: 1, channel: "private", text: "我中了一百万" } });
  const txt = mod.contextProvider({ userId: 1, channel: "private" });
  assert.ok(txt.includes("对方报告") && txt.includes("我中了一百万"), "用户陈述用「对方报告」口径：" + txt);
  assert.ok(!txt.includes("verified") && !txt.includes("事实"), "不把用户陈述当已验证事实");
  const dirOld = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p8-"));
  mod.init(mkCtx(dirOld));
  P.observe("user_report", { ts: now - 3600e3, actor_scope: "user:1", privacy_scope: "user:1", payload: { userId: 1, text: "很久以前" } });
  assert.strictEqual(mod.contextProvider({ userId: 1, channel: "private" }), "", "过期事件不注入");
});

check("A02：群上下文缺 groupId → 失败关闭（空作用域），私聊/主人本机事件均不注入", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-pA02-"));
  mod.init(mkCtx(dir));
  assert.strictEqual(P.visibleScopes({ channel: "group" }, false).size, 0, "群上下文缺 groupId 必须返回空作用域");
  assert.strictEqual(P.visibleScopes({ channel: "group" }, true).size, 0, "即使主人上下文也失败关闭");
  P.observe("user_report", { ts: now, actor_scope: "user:101", privacy_scope: "user:101", payload: { userId: 101, channel: "private", text: "PRIVATE_LEAK_MARKER" } });
  P.observe("system_observation", { ts: now, actor_scope: "local", privacy_scope: "local", payload: { app: "x.exe" } });
  const evs = P.recentEvents({ limit: 10, maxAgeMs: 3600e3, userId: 101, channel: "group" });
  assert.strictEqual(evs.length, 0, "缺群号的群上下文不得看到任何事件（含本人私聊）");
  const ctxTxt = mod.contextProvider({ userId: 101, channel: "group" });
  assert.strictEqual(ctxTxt, "", "缺群号的群上下文 contextProvider 必须为空：" + ctxTxt);
  const masterTxt = mod.contextProvider({ userId: 1, channel: "group" });
  assert.strictEqual(masterTxt, "", "主人本机事件也不得注入缺群号的群上下文：" + masterTxt);
});

check("A19：事件写入失败 → 健康异常且 offset 不推进；恢复后补回且只入一次", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-pA19-"));
  mod.init(mkCtx(dir));
  const l1 = JSON.stringify({ ts: now, userId: 9, channel: "private", text: "补回A" });
  const l2 = JSON.stringify({ ts: now + 1, userId: 9, channel: "private", text: "补回B" });
  fs.appendFileSync(path.join(dir, "messages.jsonl"), l1 + "\n" + l2 + "\n");
  fs.mkdirSync(path.join(dir, "perception-events.jsonl"));   // 目录冒充事件文件 → 写入必失败
  P.tailAll();
  assert.ok(P._health().lastErrAt > 0, "写入失败必须反映到健康信号");
  assert.ok((P._health().lastError || "").includes("写入失败"), "错误信息应注明写入失败：" + JSON.stringify(P._health()));
  assert.strictEqual(P.loadState().offsets["messages.jsonl"] || 0, 0, "写入失败时 offset 不得推进");
  fs.rmdirSync(path.join(dir, "perception-events.jsonl"));   // 恢复可写
  P.tailAll();
  const evs = evLines(dir);
  assert.strictEqual(evs.length, 2, "恢复后此前未落盘事件必须补回：" + JSON.stringify(evs.map((e) => e.payload.text)));
  const ids = evs.map((e) => e.event_id);
  assert.strictEqual(new Set(ids).size, 2, "补回事件各只入一次");
  assert.ok(P._health().lastOkAt >= P._health().lastErrAt, "恢复后健康信号转好");
  P.consumeTail("messages.jsonl", P.mapperMessage);
  assert.strictEqual(evLines(dir).length, 2, "补回后再消费不重复入盘");
});

check("WP4：健康信号——正常消费置 lastOkAt，读取故障置 lastErrAt 且可恢复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-p9-"));
  mod.init(mkCtx(dir));   // init 首跑 tailAll（源文件 ENOENT=正常，不算故障）
  assert.ok(P._health().lastOkAt > 0, "正常消费应置 lastOkAt");
  assert.ok(P._health().lastErrAt === 0, "无故障时 lastErrAt 保持 0");
  fs.mkdirSync(path.join(dir, "tool-outcomes.jsonl"));   // 用目录冒充文件 → EISDIR 读取故障
  P.tailAll();
  const errAt = P._health().lastErrAt;
  assert.ok(errAt > 0, "读取故障应置 lastErrAt");
  assert.ok(P._health().lastError.length > 0, "应带错误信息");
  fs.rmdirSync(path.join(dir, "tool-outcomes.jsonl"));
  P.tailAll();
  assert.ok(P._health().lastOkAt >= errAt, "故障消除后恢复 lastOkAt");
  const h = mod.api.perception.health();
  assert.strictEqual(typeof h.lastOkAt, "number", "health().lastOkAt 应为数字");
  assert.strictEqual(typeof h.lastErrAt, "number", "health().lastErrAt 应为数字");
  assert.strictEqual(typeof h.lastError, "string", "health().lastError 应为字符串");
});

_chain.then(() => {
  console.log("\n" + pass + "/" + n + " 通过" + (pass === n ? "" : "（有失败）"));
  process.exit(pass === n ? 0 : 1);
});
