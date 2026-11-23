/* v2.2.0 Kimi 三轮返修·A 组：实时入口 event ID 贯穿 + 提前 return 终态（端到端）
 * 用 vm 提取真实 handlePrivateMessage/enqueuePrivateChat/firePrivateChat 函数 + 真 conversation-recovery 插件，
 * 验证：入口 recordEvent → enqueue 传 eventId → fire 传 eventIds → 提前 return 分支写终态 → 重启重复投递不复活。
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
const SEG_H = extractFn(IDX, "async function handlePrivateMessage(event) {");
const SEG_E = extractFn(IDX, "function enqueuePrivateChat(userId, text, images, voiceRequested, msgTime, eventId) {");
const SEG_F = extractFn(IDX, "function firePrivateChat(userId) {");

function mkRealCr(dir, failWrite) {
  const store = {
    writeJsonAtomic(file, obj) {
      if (failWrite && failWrite.v) throw new Error("disk full");
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, file);
    },
  };
  CR.init({ DATA_DIR: dir, writeJsonAtomic: store.writeJsonAtomic, log: () => {}, getSetting: () => null, getApi: () => null });
  return CR;
}

function mkSandbox(cr, over) {
  const o = over || {};
  const calls = { sent: [], proc: [], hooks: [], cfgWrites: [], actions: [] };
  const api = cr.api.conversationRecovery;
  const sandbox = {
    console, process, Buffer, setTimeout, clearTimeout, Date, JSON, Math, Number, String, Promise,
    module: { exports: {} }, fs, path, os,
    apiOf: (ns) => (ns === "conversationRecovery" ? api : null),
    host: {
      hookLists: { private_message: o.hooks || [] },
      commandRegistry: { size: 0 },
      apiOf: (ns) => (ns === "conversationRecovery" ? api : null),
    },
    cfg: { qq: { allowed_users: o.allowed || [U], master_user: U } },
    CFG_FILE: path.join(os.tmpdir(), "momo-rt-cfg-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".json"),
    writeFileAtomic: (f, c) => { calls.cfgWrites.push({ f, c }); fs.writeFileSync(f, c); },
    recordAction: (e) => { calls.actions.push(e); },
    isMaster: (u) => Number(u) === U,
    resolveCall: () => "主人",
    isMuted: o.isMuted || (() => false),
    parseMessage: (m) => ({ text: String(m.text || ""), faces: [], records: [], images: [], ats: [] }),
    transcribeRecords: async () => "",
    wantsVoice: () => false,
    warmVoice: () => {},
    matchSkillRule: () => null,
    qqSettingNum: (k, d) => d,
    apiKey: o.apiKey === undefined ? "sk-test" : o.apiKey,
    log: () => {},
    logJsonl: () => {},
    lastInteractionTs: 0,
    lastActiveAt: new Map(),
    silenceStreak: new Map(),
    saveProactiveState: () => {},
    lastReplyAt: new Map(),
    busyUsers: new Set(),
    saveMsgTime: () => {},
    saveSeenMsg: () => {},
    _markScanned: () => {},
    _markCompleted: () => {},
    sendPrivate: async (u, t) => { calls.sent.push({ u, t }); },
    setProactivePref: () => {},
    processPrivateChat: async (u, t, imgs, v, mt, eids) => { calls.proc.push({ u, t, eids: eids || [] }); },
    pendingChat: new Map(),
    DEBOUNCE_MS: 20000,
    MAX_WAIT_MS: 40000,
  };
  vm.createContext(sandbox);
  vm.runInContext(SEG_E + "\n" + SEG_F + "\nthis.__enq = enqueuePrivateChat; this.__fire = firePrivateChat;", sandbox);
  return { sandbox, calls, api };
}

// E1：正常消息 → 事件入箱 + enqueue 带 eventId + fire 传 eventIds
check("E1 入口 eventId 贯穿 enqueue→fire", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-re1-"));
  const cr = mkRealCr(dir);
  const { sandbox, calls } = mkSandbox(cr);
  vm.runInContext(SEG_H + "\nthis.__handle = handlePrivateMessage;", sandbox);
  const ev = { user_id: U, self_id: 100000004, message_id: "m1", time: 1600000000, raw_message: "你好", message: [{ type: "text", data: { text: "你好" } }] };
  await sandbox.__handle(ev);
  const eid = "qq:private:" + U + ":m1";
  const st = sandbox.apiOf("conversationRecovery").readEvent(eid);
  if (!st) { console.log("DBG E1: no event, inbox=", fs.readdirSync(dir)); return false; }
  const p = sandbox.pendingChat.get(U);
  if (!p || !p.eventIds || p.eventIds[0] !== eid) { console.log("DBG E1: pending=", JSON.stringify(p || null)); return false; }
  sandbox.__fire(U);
  await new Promise((r) => setTimeout(r, 50));
  if (calls.proc.length !== 1) return false;
  if (!calls.proc[0].eids.length || calls.proc[0].eids[0] !== eid) return false;
  return true;
});

// E2：muted → 事件终态 intentional_no_reply(reason muted)
check("E2 muted 写终态", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-re2-"));
  const cr = mkRealCr(dir);
  const U2 = 100000002;
  const { sandbox, calls } = mkSandbox(cr, { isMuted: () => true, allowed: [U, U2] });
  vm.runInContext(SEG_H + "\nthis.__handle = handlePrivateMessage;", sandbox);
  const ev = { user_id: U2, self_id: 100000004, message_id: "m2", time: 1600000000, raw_message: "你好", message: [{ type: "text", data: { text: "你好" } }] };
  await sandbox.__handle(ev);
  const eid = "qq:private:" + U2 + ":m2";
  const st = sandbox.apiOf("conversationRecovery").readEvent(eid);
  return !!(st && st.stage === "intentional_no_reply" && calls.proc.length === 0);
});

// E3：插件 hook 处理 → succeeded(reason plugin_hook_handled)
check("E3 hook true 写终态", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-re3-"));
  const cr = mkRealCr(dir);
  const { sandbox, calls } = mkSandbox(cr, { hooks: [() => true] });
  vm.runInContext(SEG_H + "\nthis.__handle = handlePrivateMessage;", sandbox);
  const ev = { user_id: U, self_id: 100000004, message_id: "m3", time: 1600000000, raw_message: "你好", message: [{ type: "text", data: { text: "你好" } }] };
  await sandbox.__handle(ev);
  const st = sandbox.apiOf("conversationRecovery").readEvent("qq:private:" + U + ":m3");
  return !!(st && st.stage === "succeeded" && calls.proc.length === 0);
});

// E4：命令 /help → succeeded(reason command)+已回复
check("E4 命令写终态", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-re4-"));
  const cr = mkRealCr(dir);
  const { sandbox, calls } = mkSandbox(cr);
  vm.runInContext(SEG_H + "\nthis.__handle = handlePrivateMessage;", sandbox);
  const ev = { user_id: U, self_id: 100000004, message_id: "m4", time: 1600000000, raw_message: "/help", message: [{ type: "text", data: { text: "/help" } }] };
  await sandbox.__handle(ev);
  const st = sandbox.apiOf("conversationRecovery").readEvent("qq:private:" + U + ":m4");
  return !!(st && st.stage === "succeeded" && calls.sent.length >= 1);
});

// E5：重启后同 message_id 重投 → 不复活不重处理（事件保持终态，process 不再调）
check("E5 重启重复投递不复活", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-re5-"));
  const cr = mkRealCr(dir);
  const { sandbox, calls } = mkSandbox(cr);
  vm.runInContext(SEG_H + "\nthis.__handle = handlePrivateMessage;", sandbox);
  const ev = { user_id: U, self_id: 100000004, message_id: "m5", time: 1600000000, raw_message: "/help", message: [{ type: "text", data: { text: "/help" } }] };
  await sandbox.__handle(ev);
  const before = sandbox.apiOf("conversationRecovery").readEvent("qq:private:" + U + ":m5");
  const sentBefore = calls.sent.length;
  /* 模拟重启：新 vm 上下文（模块级状态清零），同插件目录（收件箱持久） */
  const sandbox2 = (() => { const s2 = mkSandbox(cr); vm.runInContext(SEG_H + "\nthis.__handle = handlePrivateMessage;", s2.sandbox); return s2; })();
  await sandbox2.sandbox.__handle(ev);
  const after = sandbox2.sandbox.apiOf("conversationRecovery").readEvent("qq:private:" + U + ":m5");
  return !!(before && before.stage === "succeeded" && after && after.stage === "succeeded" && sandbox2.calls.sent.length === 0 && sentBefore >= 1);
});

// E6：静态断言——两入口 enqueue 传 eventId
// E7：/预算 命令 → 写盘+内存 cfg 同步更新+留痕+终态（主人）
check("E7 /预算 命令双写立即生效", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-re7-"));
  const cr = mkRealCr(dir);
  const { sandbox, calls } = mkSandbox(cr);
  vm.runInContext(SEG_H + "\nthis.__handle = handlePrivateMessage;", sandbox);
  const ev = { user_id: U, self_id: 100000004, message_id: "m7", time: 1600000000, raw_message: "/预算 2.5", message: [{ type: "text", data: { text: "/预算 2.5" } }] };
  await sandbox.__handle(ev);
  const wrote = calls.cfgWrites.length === 1 && JSON.parse(calls.cfgWrites[0].c).budget.daily_cny === 2.5;
  const mem = Number(sandbox.cfg.budget && sandbox.cfg.budget.daily_cny) === 2.5;
  const ack = calls.sent.some((s) => s.t.includes("2.5"));
  const logged = calls.actions.some((a) => a.action === "set_budget" && a.ok === true);
  const st = sandbox.apiOf("conversationRecovery").readEvent("qq:private:" + U + ":m7");
  return wrote && mem && ack && logged && !!(st && st.stage === "succeeded");
});

// E8：/预算 非主人 → 拒绝且不写盘不改 cfg
check("E8 /预算 非主人拒绝", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-re8-"));
  const cr = mkRealCr(dir);
  const U2 = 100000002;
  const { sandbox, calls } = mkSandbox(cr, { allowed: [U, U2] });
  vm.runInContext(SEG_H + "\nthis.__handle = handlePrivateMessage;", sandbox);
  const ev = { user_id: U2, self_id: 100000004, message_id: "m8", time: 1600000000, raw_message: "/预算 9", message: [{ type: "text", data: { text: "/预算 9" } }] };
  await sandbox.__handle(ev);
  return calls.cfgWrites.length === 0 && !sandbox.cfg.budget && calls.sent.some((s) => s.t.includes("只有主人"));
});

check("E6 静态：私聊/群入口 enqueue 传 eventId", () => {
  return IDX.includes("enqueuePrivateChat(userId, text, parsed.images, voiceRequested, msgTime, _eidP)")
    && IDX.includes("enqueueGroupChat(Number(event.group_id), userId, text, parsed.images, Number(event.time) || 0, !!(atSelf || mentioned), _sn, _eidG)");
});

_chain.then(() => {
  console.log("\nrealtime-entry: " + pass + "/" + n + " passed");
  process.exit(pass === n ? 0 : 1);
});
