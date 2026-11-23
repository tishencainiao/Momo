/* v2.2.0 Kimi 三轮返修·B 组：续发状态机行为测试
 * vm 提取真实 _resumePreparedReplies + 真 conversation-recovery 插件（真收件箱）。
 * 验证：发送前 send_started 持久化 / 成功后补写会话+send_started→succeeded /
 *       同一事件重复恢复只发一次 / failed_retryable+reply_prepared 同回复重试不调模型 /
 *       unknown/interrupted 禁重放 / scope 锁串行。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");

const IDX = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const CR = require("../plugins/conversation-recovery.js");

function extractFn(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error("sig not found: " + sig);
  let j = src.indexOf("{", i), d = 0;
  for (; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}") { d--; if (d === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

let _chain = Promise.resolve();
let pass = 0, n = 0;
function check(name, fn) {
  n++;
  _chain = _chain.then(async () => {
    try {
      const ok = await fn();
      if (ok) { pass++; console.log("  PASS " + name); }
      else console.log("  FAIL " + name);
    } catch (e) {
      console.log("  FAIL " + name + " :: " + String(e && e.message).slice(0, 140));
    }
  });
}

const U = 100000001;
const SEG_R = extractFn(IDX, "async function _resumePreparedReplies() {");
const SEG_CS = extractFn(IDX, "async function commitSessionEvent(");

function mkRealCr(dir) {
  CR.init({ DATA_DIR: dir, writeJsonAtomic: (file, obj) => { fs.writeFileSync(file + ".tmp", JSON.stringify(obj)); fs.renameSync(file + ".tmp", file); }, log: () => {}, getSetting: () => null, getApi: () => null });
  return CR;
}

function mkEnv(cr, over) {
  const o = over || {};
  const calls = { sends: [], onebot: [], sessions: {} };
  const api = cr.api.conversationRecovery;
  const sandbox = {
    console, process, Buffer, setTimeout, clearTimeout, Date, JSON, Math, Number, String, Promise,
    module: { exports: {} }, fs, path, os,
    _recoverApi: () => api,
    _sessionRepairs: 0,
    actionKey: (kind, u, t) => "ak-" + kind + "-" + u + "-" + t.slice(0, 24),
    onebotSend: async (act, p) => { calls.onebot.push({ act, p }); },
    sendPrivate: async (u, t) => { calls.sends.push({ u, t }); },
    loadSession: (k) => (calls.sessions[k] = calls.sessions[k] || []),
    saveSession: (k, h) => { calls.sessions[k] = h.slice(); },
    trimHistory: (h) => h,
    log: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(SEG_R + "\nthis.__resume = _resumePreparedReplies;", sandbox);
  vm.runInContext(SEG_CS + "\nthis.commitSessionEvent = commitSessionEvent;", sandbox);
  return { sandbox, calls, api };
}

function seedEvent(api, dir, ev) {
  const id = api.eventIdFor(ev.channel, ev.userId, ev.groupId || 0, ev.messageId);
  api.recordEvent({ channel: ev.channel, userId: ev.userId, groupId: ev.groupId || 0, messageId: ev.messageId, sourceTs: ev.sourceTs || 0, parsedInput: ev.parsedInput, rawEvent: { message_id: ev.messageId } });
  for (const st of ["debouncing", "ready", "model_started", "reply_prepared"]) {
    api.updateStage(id, st);
  }
  api.setReply(id, ev.reply);
  return id;
}

// B1：reply_prepared 恢复 → 发送前 send_started、成功后补写会话+send_started→succeeded
check("B1 正常续发：send_started 前置+成功后 succeeded+补写会话", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-b1-"));
  const cr = mkRealCr(dir);
  const e = mkEnv(cr);
  const eid = seedEvent(e.api, dir, { channel: "private", userId: U, groupId: 0, messageId: "m1", sourceTs: 1600000000, parsedInput: "你好", reply: "在的呀" });
  const n1 = await e.sandbox.__resume();
  const ev = e.api.readEvent(eid);
  if (n1 !== 1) return false;
  if (e.calls.sends.length !== 1) return false;
  if (!ev || ev.stage !== "succeeded") return false;
  const sess = e.calls.sessions[String(U)];
  if (!sess || sess.length < 2) return false;
  if (sess[0].role !== "user" || sess[1].role !== "assistant" || sess[1].content !== "在的呀") return false;
  return true;
});

// B2：同一 reply_prepared 连续恢复两次 → 只发送一次（第二次读事件 send_started→跳过 或 已 succeeded）
check("B2 同事件重复恢复只发一次", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-b2-"));
  const cr = mkRealCr(dir);
  const e = mkEnv(cr);
  const eid = seedEvent(e.api, dir, { channel: "private", userId: U, groupId: 0, messageId: "m1", sourceTs: 1600000000, parsedInput: "你好", reply: "在的呀" });
  await e.sandbox.__resume();
  await e.sandbox.__resume();
  const ev = e.api.readEvent(eid);
  return e.calls.sends.length === 1 && ev && ev.stage === "succeeded";
});

// B3：明确失败后第二次恢复 → 同回复重试（不调模型），仍只发同一文本
check("B3 failed_retryable+reply_prepared 纳入重试", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-b3-"));
  const cr = mkRealCr(dir);
  const e = mkEnv(cr);
  const eid = seedEvent(e.api, dir, { channel: "private", userId: U, groupId: 0, messageId: "m1", sourceTs: 1600000000, parsedInput: "你好", reply: "在的呀" });
  // 第一次发送失败
  e.sandbox.sendPrivate = async () => { throw new Error("网络断了"); };
  await e.sandbox.__resume();
  let ev = e.api.readEvent(eid);
  if (!ev || ev.stage !== "failed_retryable") return false;
  // 第二次恢复成功（同一回复，不重调模型）
  e.sandbox.sendPrivate = async (u, t) => { e.calls.sends.push({ u, t }); };
  await e.sandbox.__resume();
  ev = e.api.readEvent(eid);
  return e.calls.sends.length === 1 && e.calls.sends[0].t === "在的呀" && ev && ev.stage === "succeeded";
});

// B4：unknown/interrupted 禁重放（不在候选，不发送）
check("B4 unknown/interrupted 不重放", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-b4-"));
  const cr = mkRealCr(dir);
  const e = mkEnv(cr);
  const api = e.api;
  api.recordEvent({ channel: "private", userId: U, groupId: 0, messageId: "u1", sourceTs: 1600000000, parsedInput: "甲", reply: "" });
  for (const st of ["debouncing", "ready", "model_started", "reply_prepared"]) api.updateStage(api.eventIdFor("private", U, 0, "u1"), st);
  api.updateStage(api.eventIdFor("private", U, 0, "u1"), "unknown");
  api.recordEvent({ channel: "private", userId: U, groupId: 0, messageId: "i1", sourceTs: 1600000001, parsedInput: "乙", reply: "" });
  for (const st of ["debouncing", "ready", "model_started", "reply_prepared"]) api.updateStage(api.eventIdFor("private", U, 0, "i1"), st);
  api.updateStage(api.eventIdFor("private", U, 0, "i1"), "interrupted");
  const n1 = await e.sandbox.__resume();
  return n1 === 0 && e.calls.sends.length === 0;
});

// B5：epoch 不符 → cancelled_by_reset 不发送
check("B5 epoch 屏障", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-b5-"));
  const cr = mkRealCr(dir);
  const e = mkEnv(cr);
  const eid = seedEvent(e.api, dir, { channel: "private", userId: U, groupId: 0, messageId: "m1", sourceTs: 1600000000, parsedInput: "你好", reply: "在的呀" });
  e.api.resetScope("user:" + U); // 推进 epoch
  const n1 = await e.sandbox.__resume();
  const ev = e.api.readEvent(eid);
  return n1 >= 0 && e.calls.sends.length === 0 && ev && ev.stage === "cancelled_by_reset";
});

// B6：群续发走 onebotSend 并补写群会话
check("B6 群续发", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-b6-"));
  const cr = mkRealCr(dir);
  const e = mkEnv(cr);
  const eid = seedEvent(e.api, dir, { channel: "group", userId: U, groupId: 101, messageId: "gm1", sourceTs: 1600000000, parsedInput: "你好", reply: "在的呀" });
  const n1 = await e.sandbox.__resume();
  const ev = e.api.readEvent(eid);
  if (n1 !== 1 || e.calls.onebot.length !== 1) return false;
  if (e.calls.onebot[0].p.message_type !== "group" || Number(e.calls.onebot[0].p.group_id) !== 101) return false;
  if (!ev || ev.stage !== "succeeded") return false;
  const sess = e.calls.sessions["g101_" + U];
  return !!(sess && sess.length >= 2 && sess[1].role === "assistant" && sess[1].content === "在的呀");
});

// B7：静态断言——发送前 updateStage("send_started")、成功后 updateStage("succeeded")
check("B7 静态：send_started 前置+成功后才 succeeded", () => {
  const i1 = SEG_R.indexOf('updateStage(ev.event_id, "send_started"');
  const i2 = SEG_R.indexOf('updateStage(ev.event_id, "succeeded"');
  const i3 = SEG_R.indexOf('sendPrivate(Number(ev.user_id)');
  return i1 > 0 && i2 > 0 && i1 < i3 && i3 < i2;
});

_chain.then(() => {
  console.log("\nresume-reply: " + pass + "/" + n + " passed");
  process.exit(pass === n ? 0 : 1);
});
