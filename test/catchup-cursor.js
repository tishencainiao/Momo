/* WP3 门禁测试：补消息游标（私聊/群聊）——vm 提取 index.js 真实 catchUp 函数 + 真 conversation-recovery 插件 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const crPlugin = require(path.join(ROOT, "plugins", "conversation-recovery.js"));

const U = 100000001;
const SELF = 100000004;

function sliceFn(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error("切片未找到: " + sig);
  let j = src.indexOf("{", i), depth = 0;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

const FNS = "const RECOVER_MAX_MSGS = 50;\nconst RECOVER_MAX_LLM = 20;\nlet _lastSelfId = 0;\n" + [
  "function _recoverApi() {",
  "function _markScanned(",
  "function _markCompleted(",
  "function _sortMsgs(msgs) {",
  "async function catchUpPrivate(userId) {",
  "async function catchUpGroup(groupId) {",
].map((sig) => sliceFn(SRC, sig)).join("\n");

let checks = 0, fails = 0;
let chain = Promise.resolve();
function check(name, fn) {
  checks++;
  chain = chain.then(async () => {
    try {
      if (await fn()) console.log("  PASS " + name);
      else { fails++; console.log("  FAIL " + name); }
    } catch (e) {
      fails++;
      console.log("  FAIL " + name + " :: " + String(e.message || e).split("\n")[0]);
    }
  });
}

function mkCtx(dir) {
  return {
    DATA_DIR: dir,
    log: () => {},
    getSetting: () => ({}),
    getApi: () => null,
    isMaster: () => false,
    writeJsonAtomic: (f, v) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const t = f + ".tmp" + Math.random().toString(36).slice(2, 8);
      fs.writeFileSync(t, JSON.stringify(v));
      fs.renameSync(t, f);
    },
    writeFileAtomic: (f, v) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const t = f + ".tmp" + Math.random().toString(36).slice(2, 8);
      fs.writeFileSync(t, v);
      fs.renameSync(t, f);
    },
  };
}

function mkEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-cursor-"));
  const ctx = mkCtx(dir);
  crPlugin.init(ctx);
  const cr = crPlugin.api.conversationRecovery;
  const enqueueCalls = [];
  let qzone = async () => ({ messages: [] });
  const sandbox = {
    host: { apiOf: (n) => (n === "conversationRecovery" ? cr : null) },
    apiOf: (n) => (n === "conversationRecovery" ? cr : null),
    qzoneHttp: (a, p) => qzone(a, p),
    enqueuePrivateChat: (...args) => enqueueCalls.push({ kind: "private", args }),
    enqueueGroupChat: (...args) => enqueueCalls.push({ kind: "group", args }),
    textOfMessage: (m) => String(m || ""),
    log: () => {},
    cfg: { qq: { allowed_users: [U], master_user: U, self_id: SELF, respond_to_groups: true } },
  };
  vm.createContext(sandbox);
  vm.runInContext(FNS, sandbox, { filename: "catchup-fns.js" });
  return {
    dir, cr, sandbox, ctx,
    calls: enqueueCalls,
    setQzone(fn) { qzone = fn; },
    privateState() { return (cr.cursorState().private || {})[String(U)] || null; },
    groupState(g) { return (cr.cursorState().groups || {})[String(g)] || null; },
  };
}

const oldSec = () => Math.floor(Date.now() / 1000) - 7200;

/* 1：正常补回两次幂等；终态后 completed 推进 */
check("T1 补回入队一次，二次不重复；终态后 completed 推进", async () => {
  const e = mkEnv();
  e.setQzone(async () => ({ messages: [
    { user_id: U, message_id: "m1", time: oldSec() - 10, message: "第一条" },
    { user_id: U, message_id: "m2", time: oldSec() - 9, message: "第二条" },
  ] }));
  await e.sandbox.catchUpPrivate(U);
  const n1 = e.calls.filter((c) => c.kind === "private").length;
  if (n1 !== 2) return false;
  const st1 = e.privateState();
  if (!st1 || !st1.scanned || st1.scanned.message_id !== "m2") return false;
  if (st1.completed) return false; // 尚未终态，completed 不得推进
  await e.sandbox.catchUpPrivate(U);
  if (e.calls.filter((c) => c.kind === "private").length !== 2) return false;
  // 标记两条走合法状态链到终态 → 再次补回只推进 completed，不再入队
  for (const id of ["m1", "m2"]) {
    for (const st of ["ready", "model_started", "reply_prepared", "send_started", "succeeded"]) {
      e.cr.updateStage(e.cr.eventIdFor("private", U, 0, id), st);
    }
  }
  await e.sandbox.catchUpPrivate(U);
  const st2 = e.privateState();
  return e.calls.filter((c) => c.kind === "private").length === 2 && st2 && st2.completed && st2.completed.message_id === "m2";
});

/* 2：入箱失败不推进游标，恢复后恰好一次 */
check("T2 入箱失败不推进任何游标，恢复后只处理一次", async () => {
  const e = mkEnv();
  const orig = e.cr.recordEvent;
  let failOnce = true;
  e.cr.recordEvent = (...a) => { if (failOnce) { failOnce = false; throw new Error("disk full"); } return orig.apply(e.cr, a); };
  e.setQzone(async () => ({ messages: [
    { user_id: U, message_id: "m9", time: oldSec() - 5, message: "要补的" },
  ] }));
  await e.sandbox.catchUpPrivate(U);
  if (e.calls.length !== 0) return false;
  const st = e.privateState();
  if (st) return false; // 失败不得写游标
  e.cr.recordEvent = orig;
  await e.sandbox.catchUpPrivate(U);
  if (e.calls.filter((c) => c.kind === "private").length !== 1) return false;
  const st2 = e.privateState();
  return !!st2 && st2.scanned && st2.scanned.message_id === "m9";
});

/* 3：同秒两条不同 message_id 各处理一次 */
check("T3 同秒两条不同 message_id 各处理一次", async () => {
  const e = mkEnv();
  const t = oldSec() - 3;
  e.setQzone(async () => ({ messages: [
    { user_id: U, message_id: "a1", time: t, message: "甲" },
    { user_id: U, message_id: "a2", time: t, message: "乙" },
  ] }));
  await e.sandbox.catchUpPrivate(U);
  return e.calls.filter((c) => c.kind === "private").length === 2;
});

/* 4：历史达上限 → gap_suspected，不谎报全恢复 */
check("T4 历史达上限标 gap_suspected", async () => {
  const e = mkEnv();
  const t0 = oldSec() - 100;
  e.setQzone(async () => ({ messages: Array.from({ length: 20 }, (_, i) => ({ user_id: U, message_id: "b" + i, time: t0 + i, message: "x" + i })) }));
  await e.sandbox.catchUpPrivate(U);
  const st = e.privateState();
  return !!(st && st.gap_suspected === true && String(st.last_error).includes("截断"));
});

/* 5：legacy_boundary 同秒边界不擅自补发，进待确认 */
check("T5 与旧 seen 同秒边界 → 不补发并记 legacy_boundary", async () => {
  const e = mkEnv();
  fs.writeFileSync(path.join(e.dir, "seen-msg.json"), JSON.stringify({ [U]: 3000 }));
  e.setQzone(async () => ({ messages: [
    { user_id: U, message_id: "c0", time: 3000, message: "边界" },
    { user_id: U, message_id: "c1", time: 3001, message: "新的" },
  ] }));
  await e.sandbox.catchUpPrivate(U);
  const priv = e.calls.filter((c) => c.kind === "private");
  if (priv.length !== 1 || String(priv[0].args[0]) !== String(U)) return false;
  const pend = e.cr.pendingList();
  return pend.some((p) => p.kind === "private" && String(p.reason).includes("legacy_boundary"));
});

/* 6：超上限溢出进待确认 */
check("T6 超过单轮上限 → 只入队 50 条并记待确认", async () => {
  const e = mkEnv();
  const t0 = oldSec() - 200;
  e.setQzone(async () => ({ messages: Array.from({ length: 55 }, (_, i) => ({ user_id: U, message_id: "d" + i, time: t0 + i, message: "y" + i })) }));
  await e.sandbox.catchUpPrivate(U);
  const n = e.calls.filter((c) => c.kind === "private").length;
  const pend = e.cr.pendingList();
  return n === 50 && pend.some((p) => p.kind === "private" && String(p.reason).includes("超过单轮恢复上限"));
});

/* 7：群只补 @self，群游标独立 */
check("T7 群只补 @self 的消息；私聊群游标互不推进", async () => {
  const e = mkEnv();
  e.setQzone(async (a, p) => {
    if (a === "get_group_msg_history") return { messages: [
      { message_id: "g1", time: oldSec() - 5, user_id: 111, sender: { user_id: 111 }, message: [{ type: "at", data: { qq: String(SELF) } }, { type: "text", data: { text: "呼叫" } }] },
      { message_id: "g2", time: oldSec() - 4, user_id: 222, sender: { user_id: 222 }, message: [{ type: "text", data: { text: "普通闲聊" } }] },
    ] };
    return { messages: [] };
  });
  await e.sandbox.catchUpGroup(101);
  const g = e.calls.filter((c) => c.kind === "group");
  if (g.length !== 1) return false;
  if (String(g[0].args[0]) !== "101" || String(g[0].args[1]) !== "111") return false;
  const st = e.groupState(101);
  if (!st || !st.scanned || st.scanned.message_id !== "g1") return false;
  // 私聊游标不受群补回影响
  return !e.privateState();
});

/* 8：群历史 API 失败 → gap_suspected */
check("T8 群历史失败标 gap_suspected", async () => {
  const e = mkEnv();
  e.setQzone(async (a) => { if (a === "get_group_msg_history") throw new Error("API 403"); return { messages: [] }; });
  await e.sandbox.catchUpGroup(102);
  const st = e.groupState(102);
  return !!(st && st.gap_suspected === true);
});

/* 3b：第一轮只出现 m1 并完成；第二轮同秒出现新 m2 → 不被复合游标吞 */
check("T3b 第一轮完成 m1，第二轮同秒新 m2 仍入队", async () => {
  const e = mkEnv();
  const t = oldSec() - 3;
  e.setQzone(async () => ({ messages: [
    { user_id: U, message_id: "a1", time: t, message: "甲" },
  ] }));
  await e.sandbox.catchUpPrivate(U);
  for (const st of ["ready", "model_started", "reply_prepared", "send_started", "succeeded"]) {
    e.cr.updateStage(e.cr.eventIdFor("private", U, 0, "a1"), st);
  }
  await e.sandbox.catchUpPrivate(U);
  const st1 = e.privateState();
  if (!st1 || !st1.completed || st1.completed.message_id !== "a1") return false;
  // 第二轮：同秒出现新 m2
  e.setQzone(async () => ({ messages: [
    { user_id: U, message_id: "a1", time: t, message: "甲" },
    { user_id: U, message_id: "a2", time: t, message: "乙" },
  ] }));
  await e.sandbox.catchUpPrivate(U);
  const got = e.calls.filter((c) => c.kind === "private").map((c) => c.args[1]);
  return got.length === 2 && got[0] === "甲" && got[1] === "乙";
});

/* 10：数字 message_id 10 完成后，同秒新 9 仍入队（字符串序反例，靠收件箱去重） */
check("T10 数字 ID 10 完成后同秒 9 仍入队", async () => {
  const e = mkEnv();
  const t = oldSec() - 3;
  e.setQzone(async () => ({ messages: [
    { user_id: U, message_id: "10", time: t, message: "十" },
  ] }));
  await e.sandbox.catchUpPrivate(U);
  for (const st of ["ready", "model_started", "reply_prepared", "send_started", "succeeded"]) {
    e.cr.updateStage(e.cr.eventIdFor("private", U, 0, "10"), st);
  }
  await e.sandbox.catchUpPrivate(U);
  const st1 = e.privateState();
  if (!st1 || !st1.completed || st1.completed.message_id !== "10") return false;
  // 同秒新消息 message_id="9"（字符串序小于 "10"）
  e.setQzone(async () => ({ messages: [
    { user_id: U, message_id: "10", time: t, message: "十" },
    { user_id: U, message_id: "9", time: t, message: "九" },
  ] }));
  await e.sandbox.catchUpPrivate(U);
  const got = e.calls.filter((c) => c.kind === "private").map((c) => c.args[1]);
  return got.length === 2 && got[0] === "十" && got[1] === "九";
});

/* 9：failed_retryable 不推进 completed；连续完成前缀在失败处截断 */
check("T9 failed_retryable 截断连续完成前缀", async () => {
  const e = mkEnv();
  e.setQzone(async () => ({ messages: [
    { user_id: U, message_id: "b1", time: oldSec() - 10, message: "一" },
    { user_id: U, message_id: "b2", time: oldSec() - 9, message: "二" },
    { user_id: U, message_id: "b3", time: oldSec() - 8, message: "三" },
  ] }));
  await e.sandbox.catchUpPrivate(U);
  for (const id of ["b1", "b3"]) {
    for (const st of ["ready", "model_started", "reply_prepared", "send_started", "succeeded"]) {
      e.cr.updateStage(e.cr.eventIdFor("private", U, 0, id), st);
    }
  }
  for (const st of ["ready", "model_started", "reply_prepared", "send_started", "failed_retryable"]) {
    e.cr.updateStage(e.cr.eventIdFor("private", U, 0, "b2"), st);
  }
  await e.sandbox.catchUpPrivate(U);
  const st = e.privateState();
  // b2 失败：completed 只能推进到 b1，不得越过到 b3
  return !!st && !!st.completed && st.completed.message_id === "b1";
});

chain.then(() => {
  console.log("catchup-cursor: " + (checks - fails) + "/" + checks + " passed");
  process.exit(fails ? 1 : 0);
});
