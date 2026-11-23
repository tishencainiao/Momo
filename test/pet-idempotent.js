/* test/pet-idempotent.js — v2.2.0 WP4：桌宠幂等（momo_event_id 同 ID 不重调模型、缓存取回、处理中 202、会话不重复追加） */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
function extractFunc(s, name) {
  const start = s.indexOf("async function " + name + "(");
  if (start < 0) return null;
  let i = s.indexOf("{", start), depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) break; }
  }
  return s.slice(start, i + 1);
}
const petChatSrc = extractFunc(SRC, "petChat");
const petCompletionSrc = extractFunc(SRC, "petCompletion");

let n = 0, failed = 0;
function check(name, ok, extra) {
  n++;
  if (ok) console.log("  PASS " + name);
  else { failed++; console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
const must = (v, m) => { if (!v) throw new Error(m); return v; };

/* ---------------- 共享 vm 装配 ---------------- */
/* 真实 conversation-recovery 插件（生产签名：eventIdFor(channel,userId,groupId,messageId) 四参） */
let _crTmpSeq = 0;
function mkRealCr(over) {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "pet-idem-"));
  const plug = require("../plugins/conversation-recovery.js");
  const ctx = {
    DATA_DIR: dir,
    log: () => {},
    getSetting: () => null,
    writeJsonAtomic: (p, obj) => { fs.writeFileSync(p, JSON.stringify(obj)); },
    writeFileAtomic: (p, txt) => { fs.writeFileSync(p, txt); },
  };
  if (over && over.failWriteJsonAtomic) {
    ctx.writeJsonAtomic = (p, obj) => { throw new Error("模拟收件箱写盘失败"); };
  }
  plug.init(ctx);
  const api = plug.api.conversationRecovery;
  const dirRef = { dir };
  return { api, dirRef };
}
function mkCompletionVm(over) {
  const m = mkRealCr(over);
  const modelCalls = { n: 0 };
  const ctx = {
    _recoverApi: () => m.api,
    withTimeout: (p) => p,
    petChat: over.petChat || (async () => { modelCalls.n++; return "模型回复"; }),
    log: () => {},
    cfg: { qq: { master_user: 100000001 } },
  };
  vm.createContext(ctx);
  vm.runInContext(petCompletionSrc, ctx);
  return { ctx, m, modelCalls };
}

/* T1 已有 succeeded+reply → 缓存取回，不调模型 */
(async () => {
  const { ctx, m, modelCalls } = mkCompletionVm({});
  m.api.recordEvent({ channel: "pet", userId: 100000001, messageId: "e1" });
  m.api.updateStage("pet:100000001:e1", "ready");
  m.api.updateStage("pet:100000001:e1", "handler_started");
  m.api.setReply("pet:100000001:e1", "缓存回复");
  m.api.updateStage("pet:100000001:e1", "succeeded");
  const r = await ctx.petCompletion([{ role: "user", content: "在吗" }], "e1");
  check("T1 同 ID 已成功 → 返回缓存文本", r.text === "缓存回复" && r.cached === true, JSON.stringify(r));
  check("T1 不重调模型", modelCalls.n === 0);
})().then(() => {
  /* T2 处理中 → processing:true */
  return (async () => {
    const { ctx, m } = mkCompletionVm({});
    m.api.recordEvent({ channel: "pet", userId: 100000001, messageId: "e2" });
    m.api.updateStage("pet:100000001:e2", "ready");
    m.api.updateStage("pet:100000001:e2", "handler_started");
    const r = await ctx.petCompletion([{ role: "user", content: "在吗" }], "e2");
    check("T2 处理中 → processing", r.processing === true, JSON.stringify(r));
  })();
}).then(() => {
  /* T3 首次成功 → 二次同 ID 缓存，模型只调一次 */
  return (async () => {
    const { ctx, m, modelCalls } = mkCompletionVm({});
    const r1 = await ctx.petCompletion([{ role: "user", content: "在吗" }], "e3");
    check("T3 首次调模型返回文本", r1.text === "模型回复" && modelCalls.n === 1, JSON.stringify(r1));
    check("T3 状态链 handler_started→succeeded", (m.api.readEvent("pet:100000001:e3") || {}).stage === "succeeded");
    const r2 = await ctx.petCompletion([{ role: "user", content: "在吗" }], "e3");
    check("T3 二次同 ID 缓存不重调模型", r2.text === "模型回复" && r2.cached === true && modelCalls.n === 1, JSON.stringify(r2));
  })();
}).then(() => {
  /* T4 无 ID → legacy 正常回复，不承诺幂等 */
  return (async () => {
    const { ctx, m, modelCalls } = mkCompletionVm({});
    const r = await ctx.petCompletion([{ role: "user", content: "在吗" }], null);
    check("T4 无 ID 正常回复", r.text === "模型回复" && modelCalls.n === 1);
    check("T4 无 ID 不写收件箱", m.api.readEvent("pet:100000001:legacy-unid") === null);
  })();
}).then(() => {
  /* T5 模型抛错 → failed_retryable + last_error，向上抛 */
  return (async () => {
    const { ctx, m } = mkCompletionVm({ petChat: async () => { throw new Error("模型挂了"); } });
    let threw = null;
    try { await ctx.petCompletion([{ role: "user", content: "在吗" }], "e5"); } catch (e) { threw = e; }
    check("T5 模型错误向上抛", !!threw);
    const ev = m.api.readEvent("pet:100000001:e5");
    check("T5 事件标 failed_retryable+last_error", ev && ev.stage === "failed_retryable" && String(ev.last_error).includes("模型挂了"), JSON.stringify(ev));
  })();
}).then(() => {
  /* T5b 收件箱写盘失败 → 不得调用模型，抛错 */
(async () => {
  const { ctx, modelCalls } = mkCompletionVm({ failWriteJsonAtomic: true });
  let threw = "";
  try { await ctx.petCompletion([{ role: "user", content: "hi" }], "e6"); } catch (e) { threw = String((e && e.message) || e); }
  check("T5b 写盘失败不调模型", modelCalls.n === 0, "modelCalls=" + modelCalls.n);
  check("T5b 写盘失败抛错", threw.includes("写盘失败"), threw);
})();
/* T6 petChat 会话追加守卫：同 event_id 只 push 一次 */
  return (async () => {
    const store = [];
    const ctx = {
      cfg: { qq: { master_user: 100000001 } },
      agentChatOnce: async () => ({ reply: "好呀" }),
      buildPersonContext: () => ({}),
      loadSession: () => store.slice(),
      saveSession: (k, arr) => { store.length = 0; store.push(...arr.slice()); },
      trimHistory: (h) => h,
      log: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(petChatSrc, ctx);
    const msgs = [{ role: "user", content: "在吗" }];
    await ctx.petChat(msgs, "pet:100000001:e6");
    await ctx.petChat(msgs, "pet:100000001:e6");
    const withEv = store.filter((x) => x.event_id === "pet:100000001:e6");
    check("T6 同事件会话只 push 一对", withEv.length === 2, JSON.stringify(withEv.length));
    check("T6 会话条目带 channel:pet", withEv.every((x) => x.channel === "pet"));
  })();
}).then(() => {
  /* T7 静态断言 */
  check("T7 源码含 momo_event_id 解析", SRC.includes("payload.momo_event_id") && SRC.includes('req.headers["x-momo-event-id"]'));
  check("T7 源码含 202 processing 分支", SRC.includes('status: "processing"'));
  check("T7 petChat 会话带 event_id 守卫", SRC.includes("_dupEv") && SRC.includes("event_id: eventId || undefined"));
  console.log("pet-idempotent: " + (n - failed) + "/" + n + " passed");
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error("测试异常:", e && e.stack || e);
  process.exit(1);
});
