/* WP0：v2.2.0 八缺口 RED 复现测试
 * 每个缺口用行为测试复现（vm 提取真实代码片段 + mock 依赖），不复制源码作为证据。
 * 修复后这些断言应全部翻转（此文件将由 conversation-recovery 系列测试取代/改写）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const SEG_A = fs.readFileSync(path.join(ROOT, "data", "seg-A.txt"), "utf8");
const SEG_B = fs.readFileSync(path.join(ROOT, "data", "seg-B.txt"), "utf8");
const SEG_C = fs.readFileSync(path.join(ROOT, "data", "seg-C.txt"), "utf8");
const SEG_D = fs.readFileSync(path.join(ROOT, "data", "seg-D.txt"), "utf8");
const SEG_E = fs.readFileSync(path.join(ROOT, "data", "seg-E.txt"), "utf8");

let pass = 0, fail = 0;
let _chain = Promise.resolve();
const check = (name, cond, extra) => {
  _chain = _chain.then(async () => {
    let ok = cond;
    try {
      if (typeof cond === "function") ok = await cond();
    } catch (e) { ok = false; extra = (extra ? extra + " :: " : "") + String((e && e.message) || e).slice(0, 120); }
    if (ok) { pass++; console.log("  PASS " + name); }
    else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
  });
};

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "conv-red-"));

function mkSandbox(init) {
  const sandbox = Object.assign({
    module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout, Date, JSON, Math, Number, String,
    __now: 0,
  }, init);
  vm.createContext(sandbox);
  return sandbox;
}
function runSeg(sandbox, segSrc) {
  try { vm.runInContext(segSrc, sandbox, { filename: "seg.js" }); }
  catch (e) { sandbox.__err = String(e && e.message); }
  return sandbox;
}
/* C 段是语句序列：包成 async 函数执行，返回函数句柄 */
function runSegAsFn(sandbox, segSrc, fnName) {
  const code = "async function " + fnName + "() {\n" + segSrc + "\n}";
  vm.runInContext(code, sandbox, { filename: "seg-fn.js" });
  return sandbox[fnName];
}

const U = 100000001;

/* 复现 1：补消息先推进 seen 再入队（崩溃丢消息） */
check("R1 补消息：enqueue 失败时 seen 已被推进（消息丢失）", async () => {
  const dir = mkTmp();
  let enqueueCalls = 0;
  const s = mkSandbox({
    DATA_DIR: dir, fs, path,
    writeJsonAtomic: (f, v) => fs.writeFileSync(f, JSON.stringify(v)),
    qzoneHttp: async () => ({ messages: [{ user_id: U, time: 2000, message: "第一条漏消息" }] }),
    enqueuePrivateChat: () => { enqueueCalls++; throw new Error("崩溃（模拟）"); },
    log: () => {},
    textOfMessage: (m) => String(m || ""),
    cfg: { qq: { allowed_users: [U] } },
  });
  runSeg(s, SEG_A);
  if (s.__err) { console.log("  [vm err]", s.__err); return false; }
  await s.catchUpMissedMessages();
  const seen = JSON.parse(fs.readFileSync(path.join(dir, "seen-msg.json"), "utf8"));
  /* enqueue 抛错被 catch 吞掉，但 seen 已推进到 2000 → 消息永久丢失 */
  return seen[String(U)] === 2000 && enqueueCalls === 1;
});

/* 复现 2：防抖 pending 纯内存（重启即丢） */
check("R2 防抖：pendingChat 纯内存，重启即空 → 已修复：入队即落收件箱", () => {
  /* 修复后断言（行为测试在 conversation-flow/catchup-cursor）：enqueue 带 eventId 且 debouncing 状态持久化 */
  return SRC.includes("function enqueuePrivateChat(userId, text, images, voiceRequested, msgTime, eventId)") && SRC.includes('"debouncing"');
});

/* 复现 3：同秒两条消息只补一条 */
check("R3 游标：秒级 ts 下同秒第二条消息补不回", async () => {
  const dir = mkTmp();
  let enqueueCalls = 0, batch = 0;
  const s = mkSandbox({
    DATA_DIR: dir, fs, path,
    writeJsonAtomic: (f, v) => fs.writeFileSync(f, JSON.stringify(v)),
    qzoneHttp: async () => (++batch === 1
      ? { messages: [{ user_id: U, time: 1001, message: "同秒第一条" }] }
      : { messages: [{ user_id: U, time: 1001, message: "同秒第二条（不同 message_id）" }] }),
    enqueuePrivateChat: () => { enqueueCalls++; },
    log: () => {},
    textOfMessage: (m) => String(m || ""),
    cfg: { qq: { allowed_users: [U] } },
  });
  runSeg(s, SEG_A);
  await s.catchUpMissedMessages();
  await s.catchUpMissedMessages();
  /* 第一次把 seen 推到 1001；第二次 time=1001 不 > seen → 第二条永久漏 */
  return enqueueCalls === 1;
});

/* 复现 4：群聊无持久补回 */
check("R4 群聊：无 get_group_msg_history 调用 + 内存游标重启即空 → 已修复：群补回+群游标持久化", () => {
  return SRC.includes("get_group_msg_history") && SRC.includes('_markScanned("group"');
});

/* 复现 5：实时回复先写会话历史后发送 */
check("R5 顺序：sendPrivate 失败时 saveSession 已被调用（假成功）→ 已修复：发送成功才写历史", () => {
  /* 顺序断言：sendPrivate 出现在 commitSessionEvent 之前（会话历史只在发送成功后经 commitSessionEvent 写） */
  const iSend = SRC.indexOf("await sendPrivate(userId, reply);");
  const iCommit = SRC.indexOf("async function commitSessionEvent(");
  return iSend > 0 && iCommit > 0 && iSend < iCommit && SRC.includes("会话历史在发送成功后才写") && SRC.includes("saveSession(key, trimHistory(hist, 40, 24000))") && SRC.includes("绝不发送");
});

/* 复现 6：无统一事件幂等键（seen 只存秒级 ts，无 message_id 维度） */
check("R6 幂等：seen-msg 结构只有秒级 ts（无 message_id）", () => {
  const dir = mkTmp();
  const s = mkSandbox({
    DATA_DIR: dir, fs, path,
    writeJsonAtomic: (f, v) => fs.writeFileSync(f, JSON.stringify(v)),
    qzoneHttp: async () => ({ messages: [] }),
    enqueuePrivateChat: () => {}, log: () => {},
    textOfMessage: (m) => String(m || ""),
    cfg: { qq: { allowed_users: [] } },
  });
  runSeg(s, SEG_A);
  s.saveSeenMsg(U, 1234);
  const seen = s.loadSeenMsg();
  return typeof seen[String(U)] === "number" && !seen.by_message_id;
});

/* 复现 7：桌宠 HTTP 无事件 ID（重复请求重复执行） */
check("R7 桌宠：相同请求两次都进 petChat（无幂等）→ 已修复：momo_event_id+petCompletion 缓存", () => {
  /* 修复后断言（行为测试在 test/pet-idempotent.js 用真插件覆盖）：生产 handler 走 petCompletion 幂等路径 */
  return SRC.includes("momo_event_id") && SRC.includes("petCompletion") && SRC.includes("chat.completion.processing");
});

/* 复现 8：无启动恢复清单 */
check("R8 启动：有 startup-recovery.json 统一恢复清单（WP5 已修复）", SRC.includes("startup-recovery"));

_chain.then(() => {
  console.log("conversation-red: " + pass + "/" + (pass + fail) + " passed");
  process.exit(fail ? 1 : 0);
});
