/* v2.2.0 Kimi 四轮返修：commitSessionEvent 幂等 + 渠道隔离（C15/C07）+ 命令 ACK 后置 + 群 completed 前缀
 * 用 vm 提取真实 commitSessionEvent/_repairSessions，验证：
 *  C15-1 历史已存 committed 未存 → 修复后长度不变；
 *  C15-2 saveSession 成功 markCommitted 失败 → 二次修复不重复；
 *  C07 pet 事件只写 pet<uid>、QQ 私聊不变；
 *  命令 ACK 失败 → unknown(command_delivery) 不 succeeded；
 *  C20 群 completed 前缀：中间 pending 后续不误 ACK。
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
      console.log("  FAIL " + name + " :: " + String(e && e.message).slice(0, 140) + " | " + String(e && e.stack || "").split("\n")[1]);
    }
  });
}

const U = 100000001;
const SEG_CS = extractFn(IDX, "async function commitSessionEvent(ev, opts) {");
const SEG_RS = extractFn(IDX, "async function _repairSessions() {");

/* 收件箱事件构造：直接用真插件写文件，再构造 ev 对象 */
function mkCr(dir, over) {
  const o = over || {};
  const store = {
    writeJsonAtomic(file, obj) {
      if (o.failWrite && o.failWrite.v) throw new Error("disk full");
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, file);
    },
  };
  CR.init({ DATA_DIR: dir, writeJsonAtomic: store.writeJsonAtomic, log: () => {}, getSetting: () => null, getApi: () => null });
  CR.__testControl = o;
  return CR;
}

function mkSandbox(cr, store, over) {
  const o = over || {};
  const api = cr ? cr.api.conversationRecovery : null;
  const sandbox = {
    console, process, Buffer, setTimeout, clearTimeout, Date, JSON, Math, Number, String, Promise,
    module: { exports: {} }, fs, path, os,
    log: () => {},
    _recoverApi: () => api,
    loadSession: (k) => (store.sessions[k] || []).slice(),
    saveSession: (k, h) => {
      if (o.failSave && o.failSave.v) throw new Error("save failed");
      store.sessions[k] = h.slice();
    },
    trimHistory: (h) => h,
    _sessionRepairs: 0,
  };
  vm.createContext(sandbox);
  return sandbox;
}

// 把 ev 写入收件箱（供 _repairSessions scanInbox 用）
function seedEvent(cr, ev) {
  const api = cr.api.conversationRecovery;
  const eid = api.eventIdFor(ev.channel, ev.userId, ev.groupId || 0, String(ev.messageId));
  api.recordEvent({ channel: ev.channel, userId: ev.userId, groupId: ev.groupId || 0, messageId: String(ev.messageId), parsedInput: { text: ev.text } });
  api.setReply(eid, ev.reply);
  const chain = ["ready", "model_started", "reply_prepared", "send_started", "succeeded"];
  for (const st of chain) api.updateStage(eid, st, {});
  return eid;
}

check("C15-1 历史已存 committed 未存 → 修复后长度不变", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-cs1-"));
  const cr = mkCr(dir);
  const eid = seedEvent(cr, { channel: "private", userId: U, messageId: "m1", text: "早上好", reply: "早呀" });
  const store = { sessions: { [String(U)]: [
    { role: "user", content: "早上好", ts: 1, event_id: eid },
    { role: "assistant", content: "早呀", ts: 2, event_id: eid },
  ] } };
  const sandbox = mkSandbox(cr, store);
  vm.runInContext(SEG_RS + "\nthis.__repair = _repairSessions;", sandbox);
  await sandbox.__repair();
  if (store.sessions[String(U)].length !== 2) { console.log("DBG len=", store.sessions[String(U)].length); return false; }
  return true;
});

check("C15-2 saveSession 成功 markCommitted 失败 → 二次修复不重复", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-cs2-"));
  const failCommit = { v: false };
  const cr = mkCr(dir, { failWrite: failCommit });
  const eid = seedEvent(cr, { channel: "private", userId: U, messageId: "m2", text: "在吗", reply: "在的" });
  const store = { sessions: {} };
  const sandbox = mkSandbox(cr, store);
  vm.runInContext(SEG_CS + "\n" + SEG_RS + "\nthis.__cs = commitSessionEvent; this.__repair = _repairSessions;", sandbox);
  failCommit.v = true;
  await sandbox.__cs({ event_id: eid, channel: "private", user_id: U, group_id: 0, parsed_input: { text: "在吗" }, reply_prepared: "在的" });
  failCommit.v = false;
  if (store.sessions[String(U)].length !== 2) return false;
  await sandbox.__repair();
  await sandbox.__repair();
  if (store.sessions[String(U)].length !== 2) return false;
  const ev = cr.api.conversationRecovery.readEvent(eid);
  return ev.session_user_committed === true && ev.session_assistant_committed === true;
});

check("C07 pet 事件只写 pet<uid>，QQ 私聊不变", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-cs3-"));
  const cr = mkCr(dir);
  const eid = seedEvent(cr, { channel: "pet", userId: U, messageId: "pet-e1", text: "你在干嘛", reply: "在陪你呀" });
  const store = { sessions: { [String(U)]: [{ role: "system", content: "旧私聊历史" }] } };
  const sandbox = mkSandbox(cr, store);
  vm.runInContext(SEG_CS + "\nthis.__cs = commitSessionEvent;", sandbox);
  await sandbox.__cs({ event_id: eid, channel: "pet", user_id: U, group_id: 0, parsed_input: { text: "你在干嘛" }, reply_prepared: "在陪你呀" });
  const petKey = "pet" + U;
  if (!store.sessions[petKey] || store.sessions[petKey].length !== 2) { console.log("DBG pet=", JSON.stringify(store.sessions[petKey] || null)); return false; }
  if (store.sessions[String(U)].length !== 1) { console.log("DBG qq 被污染 len=", store.sessions[String(U)].length); return false; }
  return true;
});

check("命令事件无 reply_prepared 不得混入聊天修复", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-cs-command-"));
  const cr = mkCr(dir);
  const api = cr.api.conversationRecovery;
  const eid = api.eventIdFor("private", U, 0, "cmd-history");
  api.recordEvent({ channel: "private", userId: U, groupId: 0, messageId: "cmd-history", parsedInput: "/别打扰" });
  api.updateStage(eid, "succeeded", { reason: "command" });
  const store = { sessions: {} };
  const sandbox = mkSandbox(cr, store);
  vm.runInContext(SEG_CS + "\n" + SEG_RS + "\nthis.__repair = _repairSessions;", sandbox);
  const repaired = await sandbox.__repair();
  const ev = api.readEvent(eid);
  return repaired === 0 && !store.sessions[String(U)] && !ev.session_user_committed && !ev.session_assistant_committed;
});

// 命令 ACK 失败：handlePrivateMessage 内 /别打扰 分支 sendPrivate 抛错 → unknown(command_delivery)
const SEG_H = extractFn(IDX, "async function handlePrivateMessage(event) {");
check("命令 ACK 失败 → unknown(command_delivery) 不 succeeded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-cs4-"));
  const cr = mkCr(dir);
  const api = cr.api.conversationRecovery;
  const calls = [];
  const sandbox = {
    console, process, Buffer, setTimeout, clearTimeout, Date, JSON, Math, Number, String, Promise,
    module: { exports: {} }, fs, path, os,
    apiOf: (ns) => (ns === "conversationRecovery" ? api : null),
    host: { hookLists: { private_message: [] }, apiOf: (ns) => (ns === "conversationRecovery" ? api : null) },
    cfg: { qq: { allowed_users: [U], master_user: U } },
    isMaster: (u) => Number(u) === U,
    resolveCall: () => "主人",
    isMuted: () => false,
    parseMessage: (m) => ({ text: String(m.text || ""), faces: [], records: [], images: [], ats: [] }),
    transcribeRecords: async () => "",
    wantsVoice: () => false,
    warmVoice: () => {},
    matchSkillRule: () => null,
    apiKey: "sk-test",
    log: () => {},
    logJsonl: () => {},
    lastInteractionTs: 0, lastActiveAt: new Map(), silenceStreak: new Map(), saveProactiveState: () => {},
    lastReplyAt: new Map(), busyUsers: new Set(),
    saveMsgTime: () => {}, saveSeenMsg: () => {},
    _markScanned: () => {}, _markCompleted: () => {},
    sendPrivate: async (u, t) => { calls.push({ u, t }); throw new Error("send failed"); },
    saveMute: () => {},
    addMute: () => {},
    setProactivePref: () => {},
    _finP: () => {},
  };
  vm.createContext(sandbox);
  // 只提取 _prefCmd 区段不便，直接全函数注入；需要 sandbox 提供命令区依赖：
  sandbox.sendVoice = async () => {};
  sandbox.enqueuePrivateChat = (u, t, i, v, mt, eid) => { calls.push({ enq: t, eid }); };
  vm.runInContext(SEG_H + "\nthis.__handle = handlePrivateMessage;", sandbox);
  // /别打扰 是命令区：真实分支走 sendPrivate → 抛错 → catch 标 unknown(command_delivery)
  const ev = { user_id: U, self_id: 100000004, message_id: "cmd1", time: 1600000000, raw_message: "/别打扰", message: [{ type: "text", data: { text: "/别打扰" } }] };
  let threw = false;
  try { await sandbox.__handle(ev); } catch (e) { threw = true; }
  const eid = "qq:private:" + U + ":cmd1";
  const st = api.readEvent(eid);
  if (!st) { console.log("DBG no event"); return false; }
  if (st.stage !== "unknown") { console.log("DBG stage=", st.stage); return false; }
  if (String(st.last_error || "").indexOf("send failed") < 0) { console.log("DBG last_error=", st.last_error); return false; }
  return true;
});

const SEG_RQ = extractFn(IDX, "function _resumeQueue() {");
function mkPrivateCase(api, o) {
  const calls = { sent: [], enqueued: [], saved: [], pref: 0 };
  const sandbox = {
    console, process, Buffer, setTimeout, clearTimeout, Date, JSON, Math, Number, String, Promise,
    module: { exports: {} }, fs, path, os,
    apiOf: (ns) => (ns === "conversationRecovery" ? (o.api || api) : null),
    _recoverApi: () => api,
    host: { hookLists: { private_message: [] }, commandRegistry: o.commands || new Map() },
    cfg: { qq: { allowed_users: [U], master_user: o.master ? U : U + 1 } },
    isMaster: () => !!o.master,
    resolveCall: () => "用户", isMuted: () => false,
    parseMessage: () => ({ text: o.text, faces: [], records: [], images: [], ats: [] }),
    transcribeRecords: async () => "", wantsVoice: () => false, warmVoice: () => {},
    matchSkillRule: () => null, apiKey: "sk-test", log: () => {}, logJsonl: () => {},
    lastInteractionTs: 0, lastActiveAt: new Map(), silenceStreak: new Map(), saveProactiveState: () => {},
    lastReplyAt: new Map(), busyUsers: new Set(), saveMsgTime: () => {}, saveSeenMsg: () => {},
    _markScanned: () => {}, _markCompleted: () => {}, _lastSelfId: 0,
    sendPrivate: async (u, t) => { calls.sent.push(t); if (o.sendError) throw new Error(o.sendError); },
    enqueuePrivateChat: (...a) => calls.enqueued.push(a), enqueueGroupChat: () => {},
    cmdAllowed: () => true,
    setProactivePref: () => { calls.pref++; },
    loadMemories: () => (o.memories || []).slice(),
    saveMemories: (u, items) => { calls.saved.push(items); },
  };
  vm.createContext(sandbox);
  vm.runInContext(SEG_H + "\n" + SEG_RQ + "\nthis.__handle = handlePrivateMessage; this.__resume = _resumeQueue;", sandbox);
  return { sandbox, calls };
}
function privateInput(id, text) {
  return { user_id: U, self_id: 100000004, message_id: id, time: 1600000000, raw_message: text, message: [] };
}

check("内置命令成功后不得落入普通聊天", async () => {
  const cr = mkCr(fs.mkdtempSync(path.join(os.tmpdir(), "momo-cmd-ok-")));
  const api = cr.api.conversationRecovery;
  const { sandbox, calls } = mkPrivateCase(api, { text: "/别打扰", master: true });
  await sandbox.__handle(privateInput("cmd-ok", "/别打扰"));
  const ev = api.readEvent(api.eventIdFor("private", U, 0, "cmd-ok"));
  return calls.pref === 1 && calls.sent.length === 1 && calls.enqueued.length === 0 && ev.stage === "succeeded";
});

check("非主人拒绝后不得修改记忆或继续聊天", async () => {
  const cr = mkCr(fs.mkdtempSync(path.join(os.tmpdir(), "momo-cmd-denied-")));
  const api = cr.api.conversationRecovery;
  const { sandbox, calls } = mkPrivateCase(api, {
    text: "/忘记 秘密", master: false,
    memories: [{ content: "这是秘密" }, { content: "普通记忆" }],
  });
  await sandbox.__handle(privateInput("cmd-denied", "/忘记 秘密"));
  const ev = api.readEvent(api.eventIdFor("private", U, 0, "cmd-denied"));
  return calls.sent.length === 1 && /只有主人/.test(calls.sent[0]) && calls.saved.length === 0 && calls.enqueued.length === 0 && ev.stage === "succeeded";
});

check("插件命令成功后为终态且重启不再入队", async () => {
  const cr = mkCr(fs.mkdtempSync(path.join(os.tmpdir(), "momo-plugin-ok-")));
  const api = cr.api.conversationRecovery;
  let sideEffects = 0;
  const commands = new Map([["demo", { regex: /^\/side$/, handler: () => { sideEffects++; return "done"; } }]]);
  const { sandbox, calls } = mkPrivateCase(api, { text: "/side", master: true, commands });
  await sandbox.__handle(privateInput("plugin-ok", "/side"));
  const ev = api.readEvent(api.eventIdFor("private", U, 0, "plugin-ok"));
  return sideEffects === 1 && calls.sent.length === 1 && calls.enqueued.length === 0 && ev.stage === "succeeded" && sandbox.__resume() === 0;
});

check("插件命令 ACK 失败标 unknown 且不得自动重放", async () => {
  const cr = mkCr(fs.mkdtempSync(path.join(os.tmpdir(), "momo-plugin-ack-")));
  const api = cr.api.conversationRecovery;
  let sideEffects = 0;
  const commands = new Map([["demo", { regex: /^\/side$/, handler: () => { sideEffects++; return "done"; } }]]);
  const { sandbox } = mkPrivateCase(api, { text: "/side", master: true, commands, sendError: "ack failed" });
  await sandbox.__handle(privateInput("plugin-ack", "/side"));
  const ev = api.readEvent(api.eventIdFor("private", U, 0, "plugin-ack"));
  return sideEffects === 1 && ev.stage === "unknown" && ev.reason === "command_delivery" && sandbox.__resume() === 0;
});

check("handler_started 写盘失败必须阻止插件副作用", async () => {
  const cr = mkCr(fs.mkdtempSync(path.join(os.tmpdir(), "momo-plugin-state-")));
  const api = cr.api.conversationRecovery;
  const guarded = Object.assign({}, api, {
    updateStage: (id, stage, patch) => {
      if (stage === "handler_started") throw new Error("state disk failed");
      return api.updateStage(id, stage, patch);
    },
  });
  let sideEffects = 0;
  const commands = new Map([["demo", { regex: /^\/side$/, handler: () => { sideEffects++; return "done"; } }]]);
  const { sandbox } = mkPrivateCase(api, { text: "/side", master: true, commands, api: guarded });
  await sandbox.__handle(privateInput("plugin-state", "/side"));
  return sideEffects === 0;
});

check("桌宠启动恢复不得转入 QQ，客户端可显式重试", async () => {
  const cr = mkCr(fs.mkdtempSync(path.join(os.tmpdir(), "momo-pet-resume-")));
  const api = cr.api.conversationRecovery;
  const eid = api.eventIdFor("pet", U, 0, "pet-boot");
  api.recordEvent({ channel: "pet", userId: U, messageId: "pet-boot" });
  api.updateStage(eid, "ready", {});
  let qqEnqueues = 0;
  const sandbox = { _recoverApi: () => api, enqueuePrivateChat: () => { qqEnqueues++; }, enqueueGroupChat: () => { qqEnqueues++; }, log: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(SEG_RQ + "\nthis.__resume = _resumeQueue;", sandbox);
  const resumed = sandbox.__resume();
  const interrupted = api.readEvent(eid);
  if (resumed !== 0 || qqEnqueues !== 0 || interrupted.stage !== "failed_retryable" || interrupted.reason !== "pet_client_retry_required") return false;
  api.updateStage(eid, "ready", {});
  api.updateStage(eid, "handler_started", {});
  return api.readEvent(eid).stage === "handler_started";
});

check("桌宠已备回复不得由 QQ 续发", async () => {
  const cr = mkCr(fs.mkdtempSync(path.join(os.tmpdir(), "momo-pet-reply-")));
  const api = cr.api.conversationRecovery;
  const eid = api.eventIdFor("pet", U, 0, "pet-reply");
  api.recordEvent({ channel: "pet", userId: U, messageId: "pet-reply" });
  api.setReply(eid, "桌宠回复");
  api.updateStage(eid, "ready", {});
  api.updateStage(eid, "handler_started", {});
  api.updateStage(eid, "failed_retryable", {});
  let sends = 0;
  const sandbox = { _recoverApi: () => api, sendPrivate: async () => { sends++; }, onebotSend: async () => { sends++; }, log: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(IDX, "async function _resumePreparedReplies() {") + "\nthis.__resumeReplies = _resumePreparedReplies;", sandbox);
  const resumed = await sandbox.__resumeReplies();
  return resumed === 0 && sends === 0 && api.readEvent(eid).stage === "failed_retryable";
});

// C20 群 completed 前缀：中间 pending 后续不误 ACK
check("C20 群 completed 前缀中间 pending 不误 ACK", async () => {
  const IDX2 = IDX;
  const segG = extractFn(IDX2, "async function catchUpGroup(groupId) {");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-cs5-"));
  const cr = mkCr(dir);
  const api = cr.api.conversationRecovery;
  const completed = [];
  const sandbox = {
    console, process, Buffer, setTimeout, clearTimeout, Date, JSON, Math, Number, String, Promise,
    module: { exports: {} }, fs, path, os,
    _recoverApi: () => api,
    _lastSelfId: 100000004,
    qzoneHttp: async (action, p) => ({ messages: [
      { message_id: "g1", time: 1600000000, sender: { user_id: U }, message: [{ type: "at", data: { qq: "100000004" } }, { type: "text", data: { text: "a" } }] },
      { message_id: "g2", time: 1600000001, sender: { user_id: U }, message: [{ type: "at", data: { qq: "100000004" } }, { type: "text", data: { text: "b" } }] },
      { message_id: "g3", time: 1600000002, sender: { user_id: U }, message: [{ type: "at", data: { qq: "100000004" } }, { type: "text", data: { text: "c" } }] },
    ] }),
    _sortMsgs: (a) => a.slice(),
    textOfMessage: (m) => "x",
    _markScanned: () => {},
    _markCompleted: (kind, gid, mid, ts) => { completed.push({ kind, gid, mid, ts }); },
    enqueueGroupChat: () => {},
    RECOVER_MAX_MSGS: 50,
    log: () => {},
    cfg: { qq: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(segG + "\nthis.__cg = catchUpGroup;", sandbox);
  // g1 已 succeeded、g2 pending（不终态）、g3 不存在 → completed 只推进到 g1
  const e1 = api.eventIdFor("group", U, 101, "g1");
  api.recordEvent({ channel: "group", userId: U, groupId: 101, messageId: "g1", parsedInput: { text: "a" } });
  for (const st of ["received", "debouncing", "ready", "model_started", "reply_prepared", "send_started", "succeeded"]) api.updateStage(e1, st, {});
  const e2 = api.eventIdFor("group", U, 101, "g2");
  api.recordEvent({ channel: "group", userId: U, groupId: 101, messageId: "g2", parsedInput: { text: "b" } });
  api.updateStage(e2, "debouncing", {});
  await sandbox.__cg(101);
  const mark = completed.filter((c) => c.kind === "group" && c.gid === 101);
  if (!mark.length || mark[mark.length - 1].mid !== "g1") { console.log("DBG completed=", JSON.stringify(completed)); return false; }
  return true;
});

check("C20 群 completed 没有新进展时不得回退", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-cs6-"));
  const cr = mkCr(dir);
  const api = cr.api.conversationRecovery;
  api.saveCursor("group", 101, { completed: { message_id: "g0", source_ts: 100 } });
  const sandbox = {
    console, process, Buffer, setTimeout, clearTimeout, Date, JSON, Math, Number, String, Promise,
    module: { exports: {} }, fs, path, os,
    _recoverApi: () => api, _lastSelfId: 100000004,
    qzoneHttp: async () => ({ messages: [
      { message_id: "g-new", time: 200, sender: { user_id: U }, message: [{ type: "at", data: { qq: "100000004" } }, { type: "text", data: { text: "new" } }] },
    ] }),
    _sortMsgs: (a) => a.slice(), textOfMessage: () => "new", _markScanned: () => {},
    enqueueGroupChat: () => {}, RECOVER_MAX_MSGS: 50, log: () => {}, cfg: { qq: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(IDX, "function _markCompleted(kind, key, messageId, sourceTs) {") + "\n" + extractFn(IDX, "async function catchUpGroup(groupId) {") + "\nthis.__cg = catchUpGroup;", sandbox);
  await sandbox.__cg(101);
  const cur = api.cursorState().groups["101"].completed;
  return cur.message_id === "g0" && cur.source_ts === 100;
});

check("启动必须等待会话修复后再写清单", async () => {
  const boot = extractFn(IDX, "async function _bootStage2() {");
  const repair = boot.indexOf("_nrep = await _repairSessions()");
  const checklist = boot.indexOf("_writeStartupRecovery(", repair);
  return repair > 0 && checklist > repair;
});

_chain.then(() => {
  console.log("\n" + pass + "/" + n + " 通过" + (pass === n ? "" : "（有失败）"));
  process.exit(pass === n ? 0 : 1);
});
