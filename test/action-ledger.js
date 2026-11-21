/* 阶段一（做稳）：行动凭据测试——状态机（begin/end/reconcile）+ 幂等键 + 重启对账。
 * 全部用临时目录 vm 提取真函数，不污染真实 data/。 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

let n = 0, pass = 0;
/* 串行执行链：check 注册的用例按顺序逐个 await 完成（async 用例才能真正跑完） */
let _chain = Promise.resolve();
function check(name, fn) {
  n++;
  _chain = _chain.then(async () => {
    try { await fn(); pass++; console.log("  ✓ " + name); }
    catch (e) { console.log("  ✗ " + name + " -> " + e.message); }
  });
}

function slice(needle, tail) {
  const i = SRC.indexOf(needle);
  assert.ok(i >= 0, "找不到 " + needle);
  const j = SRC.indexOf(tail, i);
  assert.ok(j >= 0, "找不到尾部 " + tail);
  return SRC.slice(i, j);
}

/* 提取 recordAction + loadActions + 行动凭据块 */
const recLoadSrc = slice("function recordAction(entry) {", "/* ===== 阶段一");
const ledgerSrc = slice("const ACTION_STATE_FILE = path.join(DATA_DIR, \"action-state.json\");", "const SESS_DIR = path.join(DATA_DIR, \"sessions\");");
const sendSrc = slice("const _sendInFlight = new Map();", "async function proactiveAgentTurn");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "momo-ledger-"));

function mkCtx(dir) {
  const D = dir || TMP;
  return {
    DATA_DIR: D,
    ACTION_LOG_FILE: path.join(D, "actions.jsonl"),
    writeFileAtomic: (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); },
    writeJsonAtomic: (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); },
    log: () => {},
  };
}

function makeVm() {
  const sandbox = Object.assign(mkCtx(), { module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout, fs, path, crypto: require("crypto"), require: (m) => (m === "crypto" ? require("crypto") : undefined), undefined });
  vm.runInNewContext(recLoadSrc + "\n" + ledgerSrc + "\nthis.__api = { recordAction, loadActions, actionKey, loadActionState, saveActionState, beginAction, tryBeginAction, endAction, reconcileOpenActions, proposeAction, cancelAction, verifyAction };", sandbox, { filename: "ledger.js" });
  return sandbox;
}

/* ---------- 状态机 ---------- */
check("begin→end(succeeded) 完整闭环", () => {
  const s = makeVm();
  const k = s.__api.beginAction({ action: "send", userId: 1, channel: "private", requestedBy: "test", detail: "hi" });
  assert.ok(typeof k === "string" && k.length === 20, "幂等键 20 位");
  s.__api.endAction(k, { ok: true, summary: "已发送" });
  const acts = s.__api.loadActions(10);
  const line = acts[acts.length - 1];
  assert.strictEqual(line.status, "succeeded");
  assert.strictEqual(line.ok, true);
  assert.strictEqual(line.key, k);
  assert.strictEqual(line.result_summary, "已发送");
  const st = s.__api.loadActionState();
  assert.strictEqual(Object.keys(st.open || {}).length, 0, "open 应清空");
});

check("endAction(ok:false) → failed；缺 ok → unknown（不假装成功）", () => {
  const s = makeVm();
  const k1 = s.__api.beginAction({ action: "qzone_post", userId: 1 });
  s.__api.endAction(k1, { ok: false, error: "NapCat 报错" });
  const k2 = s.__api.beginAction({ action: "send", userId: 2 });
  s.__api.endAction(k2, {});
  const acts = s.__api.loadActions(10);
  const f = acts.find((a) => a.key === k1), u = acts.find((a) => a.key === k2);
  assert.strictEqual(f.status, "failed");
  assert.strictEqual(u.status, "unknown");
  assert.strictEqual(u.ok, false);
});

/* ---------- 重启对账 ---------- */
check("重启对账：running → unknown，绝不写成功、open 清空", () => {
  const s = makeVm();
  const k1 = s.__api.beginAction({ action: "send", userId: 1 });
  const k2 = s.__api.beginAction({ action: "selfmodify_approve", userId: 1 });
  /* 模拟重启：新 vm 实例（同一 tmp 目录），open 状态在盘上 */
  const s2 = makeVm();
  const rec = s2.__api.reconcileOpenActions();
  assert.strictEqual(rec, 2, "应回收 2 条");
  const acts = s2.__api.loadActions(10);
  const u1 = acts.find((a) => a.key === k1), u2 = acts.find((a) => a.key === k2);
  assert.strictEqual(u1.status, "unknown");
  assert.strictEqual(u1.ok, false);
  assert.ok(String(u1.error).includes("unknown"), "错误注明 unknown 不重放");
  assert.strictEqual(u2.status, "unknown");
  assert.strictEqual(Object.keys(s2.__api.loadActionState().open || {}).length, 0, "open 已清空");
  /* 再次对账 → 0（幂等，不重复记账） */
  assert.strictEqual(s2.__api.reconcileOpenActions(), 0);
});

/* ---------- 幂等键 ---------- */
check("actionKey 同参同键、异参异键", () => {
  const s = makeVm();
  assert.strictEqual(s.__api.actionKey("send", 1, "hi"), s.__api.actionKey("send", 1, "hi"));
  assert.notStrictEqual(s.__api.actionKey("send", 1, "hi"), s.__api.actionKey("send", 1, "hi2"));
  assert.notStrictEqual(s.__api.actionKey("send", 1, "hi"), s.__api.actionKey("send", 2, "hi"));
});

/* ---------- recordAndSend 幂等（同文 10 分钟内不重发） ---------- */
check("recordAndSend 幂等：同文 10 分钟内只发一次（重启后也不重发）", async () => {
  const calls = [];
  const sandbox = Object.assign(mkCtx(fs.mkdtempSync(path.join(os.tmpdir(), "momo-send1-"))), {
    module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout, fs, path, crypto: require("crypto"),
    require: (m) => (m === "crypto" ? require("crypto") : undefined),
    loadSession: () => [], saveSession: () => {}, saveMsgTime: () => {}, trimHistory: (h) => h,
    sendPrivate: async (u, t) => { calls.push(t); },
    host: { runBeforeSend: () => {} },
    undefined,
  });
  vm.runInNewContext(recLoadSrc + "\n" + ledgerSrc + "\n" + sendSrc + "\nthis.__send = recordAndSend;", sandbox, { filename: "send.js" });
  const ok1 = await sandbox.__send(1, "今晚吃火锅吗", true);
  assert.strictEqual(ok1.result, "succeeded");
  assert.strictEqual(calls.length, 1, "第一次真发");
  const ok2 = await sandbox.__send(1, "今晚吃火锅吗", true);
  assert.strictEqual(ok2.result, "duplicate_succeeded");
  assert.strictEqual(calls.length, 1, "同文 10 分钟内不重发（幂等键命中）");
  await sandbox.__send(1, "换个话题吧", true);
  assert.strictEqual(calls.length, 2, "不同文正常发");
  const acts = sandbox.loadActions(20);
  const sends = acts.filter((a) => a.action === "send" && a.status === "succeeded");
  assert.strictEqual(sends.length, 2, "凭据只记 2 条 succeeded");
});

/* ---------- 第二阶段：proposed/cancelled 与 工具已返回/结果已验证 分开 ---------- */
check("proposed→running→succeeded 全生命周期（proposed 只记一次）", () => {
  const s = makeVm();
  const k = s.__api.proposeAction({ action: "reminder_fire", userId: 1, detail: "提醒「喝水」" });
  assert.ok(typeof k === "string" && k.length === 20, "propose 也返回幂等键");
  s.__api.beginAction({ key: k, action: "reminder_fire", userId: 1 });
  s.__api.endAction(k, { ok: true, summary: "提醒已触发" });
  const acts = s.__api.loadActions(10);
  const props = acts.filter((a) => a.key === k && a.status === "proposed");
  assert.strictEqual(props.length, 1, "proposed 行只记一次（begin 不再重复记）");
  assert.ok(props[0].detail.includes("喝水"), "proposed 行带 detail 可追溯");
  const fin = acts.find((a) => a.key === k && a.status === "succeeded");
  assert.ok(fin, "终态 succeeded 行存在");
  assert.strictEqual(fin.result_summary, "提醒已触发");
  assert.strictEqual(Object.keys(s.__api.loadActionState().open || {}).length, 0, "闭环后 open 清空");
});

check("beginAction 对 running 幂等（不重置 started_at）", () => {
  const s = makeVm();
  const k = s.__api.beginAction({ action: "send", userId: 1 });
  const t1 = s.__api.loadActionState().open[k].started_at;
  s.__api.beginAction({ key: k, action: "send", userId: 1 });
  const st = s.__api.loadActionState();
  assert.strictEqual(st.open[k].started_at, t1, "running 幂等不重置");
  assert.strictEqual(st.open[k].status, "running");
  s.__api.endAction(k, { ok: true });
});

/* ---------- Kimi 二轮：tryBeginAction 抢占式幂等 ---------- */
check("tryBeginAction 空闲 → acquired:true 且带 attempt_id", () => {
  const s = makeVm();
  const t = s.__api.tryBeginAction({ action: "send", userId: 1, detail: "hi" });
  assert.strictEqual(t.acquired, true);
  assert.ok(typeof t.key === "string" && t.key.length === 20);
  const st = s.__api.loadActionState();
  assert.strictEqual(st.open[t.key].status, "running");
  assert.ok(String(st.open[t.key].attempt_id).startsWith(t.key + "-"), "每次尝试 attempt_id 唯一");
  s.__api.endAction(t.key, { ok: true });
});

check("tryBeginAction 被 running 占用 → acquired:false + duplicateOf（调用方必须停止执行）", () => {
  const s = makeVm();
  const t1 = s.__api.tryBeginAction({ action: "send", userId: 1 });
  assert.strictEqual(t1.acquired, true);
  const t2 = s.__api.tryBeginAction({ key: t1.key, action: "send", userId: 1 });
  assert.strictEqual(t2.acquired, false);
  assert.strictEqual(t2.duplicateOf, "running");
  /* 重复调用不能把 open 里已有的 attempt_id 重置（动作连续性） */
  const st = s.__api.loadActionState();
  assert.strictEqual(st.open[t1.key].status, "running");
  s.__api.endAction(t1.key, { ok: true });
});

check("tryBeginAction 对 proposed 键也拒绝抢占（先取消/先转 running 才执行）", () => {
  const s = makeVm();
  const k = s.__api.proposeAction({ action: "reminder_fire", userId: 1 });
  const t = s.__api.tryBeginAction({ key: k, action: "reminder_fire", userId: 1 });
  assert.strictEqual(t.acquired, false);
  assert.strictEqual(t.duplicateOf, "proposed");
  s.__api.cancelAction(k, "测试清理");
});

check("tryBeginAction 在 begin→end 后同 key 可再次抢占（_busyActions 已释放，失败后可重试）", () => {
  const s = makeVm();
  const t1 = s.__api.tryBeginAction({ action: "send", userId: 1 });
  assert.strictEqual(t1.acquired, true);
  s.__api.endAction(t1.key, { ok: true });
  const t2 = s.__api.tryBeginAction({ key: t1.key, action: "send", userId: 1 });
  assert.strictEqual(t2.acquired, true, "锁已随 endAction 释放，同键可重新抢占");
  s.__api.endAction(t2.key, { ok: true });
  const t3 = s.__api.tryBeginAction({ key: t1.key, action: "send", userId: 1 });
  assert.strictEqual(t3.acquired, true, "连续第二次闭环后仍可抢占");
  s.__api.endAction(t3.key, { ok: true });
});

check("两个并发相同私聊：只实际发送一次（抢占失败方不执行副作用）", async () => {
  const calls = [];
  let release;
  const barrier = new Promise((r) => { release = r; });
  const sandbox = Object.assign(mkCtx(fs.mkdtempSync(path.join(os.tmpdir(), "momo-cc-"))), {
    module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout, fs, path, crypto: require("crypto"),
    require: (m) => (m === "crypto" ? require("crypto") : undefined),
    loadSession: () => [], saveSession: () => {}, saveMsgTime: () => {}, trimHistory: (h) => h,
    sendPrivate: async (u, t) => { await barrier; calls.push(t); return { data: { message_id: "cc-1" } }; },
    host: { runBeforeSend: () => {} },
    undefined,
  });
  vm.runInNewContext(recLoadSrc + "\n" + ledgerSrc + "\n" + sendSrc + "\nthis.__send = recordAndSend;", sandbox, { filename: "cc.js" });
  const p1 = sandbox.__send(1, "并发同文测试", true);
  const p2 = sandbox.__send(1, "并发同文测试", true);
  await new Promise((r) => setTimeout(r, 30));   // 让两次都先走到抢占
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1.result, "succeeded", "首次发送成功");
  assert.strictEqual(r2.result, "succeeded", "并发方共享同一真实结果（running 不冒充成功）");
  assert.strictEqual(calls.length, 1, "两次并发同文只真正发了一次");
});

/* ---------- Kimi 三轮：发送失败共享真实结果、失败不写会话历史 ---------- */
check("发送失败：并发双方共享 failed，账本只一条 failed，失败消息不进会话历史", async () => {
  const calls = [];
  let release;
  const barrier = new Promise((r) => { release = r; });
  const sess = [];
  const sandbox = Object.assign(mkCtx(fs.mkdtempSync(path.join(os.tmpdir(), "momo-fail3-"))), {
    module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout, fs, path, crypto: require("crypto"),
    require: (m) => (m === "crypto" ? require("crypto") : undefined),
    loadSession: () => sess, saveSession: (u, h) => { sess.length = 0; sess.push(...h); }, saveMsgTime: () => {}, trimHistory: (h) => h,
    sendPrivate: async (u, t) => { await barrier; calls.push(t); throw new Error("QQ 发送失败"); },
    host: { runBeforeSend: () => {} },
    undefined,
  });
  vm.runInNewContext(recLoadSrc + "\n" + ledgerSrc + "\n" + sendSrc + "\nthis.__send = recordAndSend;", sandbox, { filename: "fail3.js" });
  const p1 = sandbox.__send(1, "这条会失败", true);
  const p2 = sandbox.__send(1, "这条会失败", true);
  await new Promise((r) => setTimeout(r, 30));
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1.result, "failed");
  assert.strictEqual(r2.result, "failed", "并发方等待同一 Promise，共享真实失败结果");
  assert.strictEqual(calls.length, 1, "只真发一次");
  assert.strictEqual(sess.filter((m) => String(m.content).indexOf("这条会失败") >= 0).length, 0, "失败消息不得进会话历史");
  const acts = sandbox.loadActions(20);
  assert.strictEqual(acts.filter((a) => a.status === "succeeded").length, 0, "无成功凭据");
  assert.strictEqual(acts.filter((a) => a.status === "failed").length, 1, "只一条 failed 凭据");
});

check("发送成功才写会话历史（只追加一次）+ verified 回执", async () => {
  const calls = [];
  const sess = [];
  const sandbox = Object.assign(mkCtx(fs.mkdtempSync(path.join(os.tmpdir(), "momo-ok2-"))), {
    module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout, fs, path, crypto: require("crypto"),
    require: (m) => (m === "crypto" ? require("crypto") : undefined),
    loadSession: () => sess.slice(), saveSession: (u, h) => { sess.length = 0; sess.push(...h); }, saveMsgTime: () => {}, trimHistory: (h) => h,
    sendPrivate: async (u, t) => { calls.push(t); return { data: { message_id: "ok-77" } }; },
    host: { runBeforeSend: () => {} },
    undefined,
  });
  vm.runInNewContext(recLoadSrc + "\n" + ledgerSrc + "\n" + sendSrc + "\nthis.__send = recordAndSend;", sandbox, { filename: "ok2.js" });
  const r = await sandbox.__send(1, "成功进历史", true);
  assert.strictEqual(r.result, "succeeded");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(sess.filter((m) => String(m.content) === "成功进历史").length, 1, "发送成功才写会话，且只写一次");
  const acts = sandbox.loadActions(10);
  assert.ok(acts.some((a) => a.status === "succeeded" && a.key === r.key));
  assert.ok(acts.some((a) => a.status === "verified" && a.verification_event_id === "ok-77"));
});

check("cancelAction：open 中的计划可取消并记 cancelled，不存在返回 false", () => {
  const s = makeVm();
  const k = s.__api.proposeAction({ action: "reminder_fire", userId: 1 });
  const ok = s.__api.cancelAction(k, "主人撤销了");
  assert.strictEqual(ok, true);
  const acts = s.__api.loadActions(5);
  const c = acts.find((a) => a.key === k && a.status === "cancelled");
  assert.ok(c, "记 cancelled 终态行");
  assert.ok(String(c.error).includes("主人撤销了"));
  assert.strictEqual(Object.keys(s.__api.loadActionState().open || {}).length, 0, "取消后 open 清空");
  assert.strictEqual(s.__api.cancelAction("nokey-xyz", "x"), false, "对不存在的键返回 false");
});

check("重启对账：proposed → cancelled（安全取消），running → unknown", () => {
  const s = makeVm();
  const kp = s.__api.proposeAction({ action: "reminder_fire", userId: 1 });
  const kr = s.__api.beginAction({ action: "send", userId: 2 });
  const s2 = makeVm();
  const rec = s2.__api.reconcileOpenActions();
  assert.strictEqual(rec, 2, "应回收 2 条");
  const acts = s2.__api.loadActions(10);
  const c = acts.find((a) => a.key === kp && a.status === "cancelled");
  assert.ok(c, "proposed 重启 → cancelled");
  assert.ok(String(c.error).includes("安全取消"), "注明计划未执行");
  const u = acts.find((a) => a.key === kr && a.status === "unknown");
  assert.ok(u && String(u.error).includes("不重放"), "running 重启 → unknown");
});

check("verifyAction：独立「结果已验证」行带 event_id，不与终态混淆", () => {
  const s = makeVm();
  const k = s.__api.beginAction({ action: "send", userId: 1 });
  s.__api.endAction(k, { ok: true, summary: "已发送" });
  s.__api.verifyAction(k, { ok: true, eventId: "m-12345", summary: "OneBot 回执确认" });
  const acts = s.__api.loadActions(10);
  const v = acts.find((a) => a.key === k && a.status === "verified");
  assert.ok(v, "独立 verified 行");
  assert.strictEqual(v.verification_event_id, "m-12345");
  assert.ok(v.verified_at > 0, "带验证时间");
  const term = acts.find((a) => a.key === k && a.status === "succeeded");
  assert.ok(term && term.verified !== true, "终态行不冒充已验证");
});

check("endAction verified:true 内联再补一条 verified 行", () => {
  const s = makeVm();
  const k = s.__api.beginAction({ action: "send", userId: 1 });
  s.__api.endAction(k, { ok: true, verified: true, verification_event_id: "m-9", summary: "已发送" });
  const acts = s.__api.loadActions(10);
  const v = acts.find((a) => a.key === k && a.status === "verified");
  assert.ok(v && v.verification_event_id === "m-9", "内联补 verified 行");
  const term = acts.find((a) => a.key === k && a.status === "succeeded");
  assert.strictEqual(term.verified, true, "终态行带 verified 标记");
});

check("recordAndSend 拿到 OneBot 回执后补 verified 凭据行", async () => {
  const calls = [];
  const sandbox = Object.assign(mkCtx(fs.mkdtempSync(path.join(os.tmpdir(), "momo-send2-"))), {
    module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout, fs, path, crypto: require("crypto"),
    require: (m) => (m === "crypto" ? require("crypto") : undefined),
    loadSession: () => [], saveSession: () => {}, saveMsgTime: () => {}, trimHistory: (h) => h,
    sendPrivate: async (u, t) => { calls.push(t); return { data: { message_id: "ack-42" } }; },
    host: { runBeforeSend: () => {} },
    undefined,
  });
  vm.runInNewContext(recLoadSrc + "\n" + ledgerSrc + "\n" + sendSrc + "\nthis.__send = recordAndSend;", sandbox, { filename: "send2.js" });
  await sandbox.__send(1, "回执测试", true);
  assert.strictEqual(calls.length, 1);
  const acts = sandbox.loadActions(20);
  const v = acts.find((a) => a.action === "send" && a.status === "verified");
  assert.ok(v, "有独立 verified 行");
  assert.strictEqual(v.verification_event_id, "ack-42");
  assert.ok(String(v.result_summary).includes("回执"), "注明凭据来源");
  const term = acts.find((a) => a.action === "send" && a.status === "succeeded");
  assert.ok(term, "终态 succeeded 行仍在");
});

/* ---------- 旧格式兼容 ---------- */
check("旧格式 {ts,action,ok} 行仍可读", () => {
  const s = makeVm();
  fs.appendFileSync(path.join(TMP, "actions.jsonl"), JSON.stringify({ ts: 1, action: "legacy", ok: true }) + "\n");
  const acts = s.__api.loadActions(10);
  const leg = acts.find((a) => a.action === "legacy");
  assert.ok(leg && leg.ok === true, "旧行解析成功");
});

/* ---------- 静态接线 ---------- */
check("qzone.js 用 tryBeginAction 抢占 + endAction 闭环 + 24h 去重", () => {
  const q = fs.readFileSync(path.join(__dirname, "..", "plugins", "qzone.js"), "utf8");
  assert.ok(q.includes("tryBeginAction({ action: \"qzone_post\""));
  assert.ok(q.includes("_ctx.endAction(_k, { ok: _ok"));
  assert.ok(q.includes("24 * 3600e3"), "同内容 24h 去重");
  assert.ok(!q.includes("recordAction({ action: \"qzone_post\""), "P1-2：不再写旧版重复流水");
  assert.ok(q.includes("_ok && _tid && _ctx.verifyAction"), "P1-3：有 tid 回执才写 verified");
});
check("audit-service 含动作自述校验", () => {
  const a = fs.readFileSync(path.join(__dirname, "..", "plugins", "audit-service.js"), "utf8");
  assert.ok(a.includes("verifyClaim"));
  assert.ok(a.includes("loadActions(40)"));
});
check("qzone.js 成功后 verifyAction（tid 回执，与终态分开）", () => {
  const q = fs.readFileSync(path.join(__dirname, "..", "plugins", "qzone.js"), "utf8");
  assert.ok(q.includes("verifyAction(_k, { ok: true, eventId: _tid"));
  assert.ok(q.includes("summary: \"QQ 空间发布回执（tid）确认\""));
});
check("audit-service 凭据：isSuccessRow 状态优先级 + validActionKey 查账本（Kimi 六缺口 A13/A14）", () => {
  const a = fs.readFileSync(path.join(__dirname, "..", "plugins", "audit-service.js"), "utf8");
  assert.ok(a.includes("isSuccessRow"), "成功判定收敛为 isSuccessRow（A13）");
  assert.ok(a.includes("validActionKey"), "副作用 action_key 必须查账本（A14）");
  assert.ok(a.includes("!isSideEffect || validActionKey(o.action_key, s)"), "副作用凭据必须能在账本闭环");
});
check("reminders.js 接线：未到期不 propose，到期 tryBegin→await 发送→成功才 endAction", () => {
  const r = fs.readFileSync(path.join(__dirname, "..", "plugins", "reminders.js"), "utf8");
  assert.ok(!r.includes("proposeAction"), "P0-3 方案 b：创建提醒不进 open，不 propose");
  assert.ok(r.includes("tryBeginAction({ key, action: \"reminder_fire\""));
  assert.ok(r.includes("await _ctx.recordAndSend"), "P0-2：等待发送结果");
  assert.ok(r.includes("endAction(key, { ok: true, summary: \"提醒已触发并发出\" })"), "发送成功才写成功凭据");
  assert.ok(r.includes("ok: false, error: \"QQ 发送失败\""), "失败写 failed 凭据");
  assert.ok(r.includes("failCount"), "失败保留下轮重试（上限后放弃）");
});
check("plugin-host 透传 propose/cancel/verify/tryBegin", () => {
  const p = fs.readFileSync(path.join(__dirname, "..", "plugin-host.js"), "utf8");
  assert.ok(p.includes("proposeAction: (m) => core.proposeAction(m)"));
  assert.ok(p.includes("cancelAction: (k, reason) => core.cancelAction(k, reason)"));
  assert.ok(p.includes("verifyAction: (k, r) => core.verifyAction(k, r)"));
  assert.ok(p.includes("tryBeginAction: (m) => core.tryBeginAction(m)"));
});

check("Kimi 三轮：proactive/share_fun 消费发送结果，失败不记已发送", () => {
  const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.ok(idx.includes('_sr.result !== "succeeded" && _sr.result !== "duplicate_succeeded"'), "消费真实结果");
  assert.ok(idx.includes("主动搭话发送未成功"));
  assert.ok(idx.includes("心智分享趣图发送未成功，不记已分享"));
  assert.ok(idx.includes("const _sendInFlight = new Map();"), "并发同键共享同一发送 Promise");
});
check("Kimi 三轮：usedTools 结构化 ok，审计只认明确成功", () => {
  const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.ok(idx.includes("_toolOk = r.ok !== false"), "插件工具支持 {text,ok} 结构化结果");
  assert.ok(idx.includes("_toolOk = false"), "搜索不可用/无表情包/异常 按失败计");
  assert.ok(idx.includes("if (_toolOk === true) _usedTools.push"), "只推明确成功");
});
check("Kimi 六缺口 A12：recordAndSend 直发审计载荷带真实 userId（旧无主凭据不背书）", () => {
  const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.ok(idx.includes('channel: "private", userId: userId || 0, usedTools: []'), "直发载荷补 userId，scope 缺 userId 时审计不背书");
});
check("Kimi 三轮：qzone 日报幂等命中不标记「今天已发」", () => {
  const q = fs.readFileSync(path.join(__dirname, "..", "plugins", "qzone.js"), "utf8");
  assert.ok(q.includes("_pub.data.dedup === true"), "幂等命中字段路径必须是 data.dedup");
  assert.ok(q.includes("未标记今天已发"));
});

check("Kimi 阶段0/1 返修：ToolOutcome 进 before_send + 行动关联字段 + 感知作用域传参", () => {
  const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.ok(idx.includes("const _outcomes = []"), "收集本轮结构化工具结果");
  assert.ok(idx.includes("outcomes: _outcomes"), "ToolOutcome 传入 before_send payload");
  assert.ok(idx.includes("action_key") && idx.includes("verification_event_id"), "ToolOutcome 带行动关联字段");
  assert.ok(idx.includes("_cp({ userId, petMode"), "contextProvider 调用存在");
  assert.ok(idx.includes("channel") && idx.includes("groupId"), "contextProvider 传 channel/groupId（感知作用域过滤）");
  const a = fs.readFileSync(path.join(__dirname, "..", "plugins", "audit-service.js"), "utf8");
  assert.ok(a.includes("p.outcomes || []"), "before_send 把本轮 outcomes 交给审计");
});

_chain.then(() => {
  console.log(`action-ledger: ${pass}/${n} passed`);
  process.exit(pass === n ? 0 : 1);
}).catch((e) => { console.error("用例链异常:", e); process.exit(1); });
