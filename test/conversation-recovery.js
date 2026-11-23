/* test/conversation-recovery.js — WP1：事件身份、收件箱、状态机、scope 串行、epoch、重启对账 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const mod = require("../plugins/conversation-recovery.js");
const T = mod.__test;

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
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "conv-rec-"));
function mkCtx(dir) {
  return {
    DATA_DIR: dir,
    writeJsonAtomic: (f, v) => {
      const tmp = f + ".tmp-" + Math.random().toString(36).slice(2, 8);
      fs.writeFileSync(tmp, JSON.stringify(v));
      fs.renameSync(tmp, f);
    },
    writeFileAtomic: (f, v) => fs.writeFileSync(f, v),
    log: () => {},
    getSetting: () => undefined,
  };
}

const U = 100000001, U2 = 100000002;
const dir = mkTmp();
const ctx = mkCtx(dir);
mod.init(ctx);

/* 1. 事件身份 */
check("事件键：私聊/群聊/桌宠 三种形态", (() => {
  return T.eventIdFor("private", U, 0, "m1") === "qq:private:" + U + ":m1"
    && T.eventIdFor("group", U, 123, "m2") === "qq:group:123:" + U + ":m2"
    && T.eventIdFor("pet", U, 0, "e1") === "pet:" + U + ":e1";
})());
check("scope：私聊 user:<uid> / 群 group:<gid> / 桌宠 pet:<uid>", (() => {
  return T.scopeFor("private", U, 0) === "user:" + U
    && T.scopeFor("group", U, 123) === "group:123"
    && T.scopeFor("pet", U, 0) === "pet:" + U;
})());
check("不同用户/群复用相同外部 message_id 是不同事件", (() => {
  const a = T.eventIdFor("private", U, 0, "same");
  const b = T.eventIdFor("private", U2, 0, "same");
  const c = T.eventIdFor("group", 1, U, "same");
  const d = T.eventIdFor("group", 2, U, "same");
  return a !== b && a !== c && c !== d;
})());
check("缺 message_id 标 legacy_unidentified 且每次唯一", (() => {
  const r1 = T.recordEvent({ channel: "private", userId: U, messageId: "", sourceTs: 1, rawEvent: { raw_message: "hi" } });
  const r2 = T.recordEvent({ channel: "private", userId: U, messageId: "", sourceTs: 2, rawEvent: { raw_message: "hi" } });
  return r1.event.event_id.startsWith("legacy:unidentified:") && r1.event.legacy === true && r1.event.event_id !== r2.event.event_id;
})());

/* 2. 收件箱基本读写与去重 */
check("recordEvent 重复 event_id 不新增第二条、不重置状态", () => {
  const r1 = T.recordEvent({ channel: "private", userId: U, messageId: "dup1", sourceTs: 10, rawEvent: { raw_message: "a" } });
  T.updateStage(r1.event.event_id, "ready");
  const r2 = T.recordEvent({ channel: "private", userId: U, messageId: "dup1", sourceTs: 10, rawEvent: { raw_message: "a" } });
  const all = T.scanInbox({ scope: "user:" + U });
  return r2.isNew === false && r2.event.stage === "ready" && all.filter(e => e.event_id === r1.event.event_id).length === 1;
});
check("事件文件落盘在收件箱目录（不依赖内存数组）", () => {
  const f = T.safeFile("qq:private:" + U + ":dup1");
  return fs.existsSync(path.join(dir, "conversation-inbox", f));
});
check("写盘失败抛错不吞（DATA_DIR 只读模拟）", () => {
  const dir2 = mkTmp();
  const ctx2 = mkCtx(dir2);
  ctx2.writeJsonAtomic = () => { throw new Error("disk full"); };
  mod.init(ctx2);
  let threw = false;
  try { T.recordEvent({ channel: "private", userId: U, messageId: "wf1", sourceTs: 1 }); }
  catch (e) { threw = String(e.message).includes("写盘失败"); }
  mod.init(ctx); // 恢复共享 ctx，避免污染后续用例
  return threw;
  return threw;
});

/* 3. 状态机 */
check("合法迁移链 received→debouncing→ready→model_started→reply_prepared→send_started→succeeded", () => {
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "sm1", sourceTs: 20 });
  const id = r.event.event_id;
  T.updateStage(id, "debouncing"); T.updateStage(id, "ready");
  T.updateStage(id, "model_started"); T.updateStage(id, "reply_prepared");
  T.updateStage(id, "send_started"); T.updateStage(id, "succeeded");
  return T.readEvent(id).stage === "succeeded";
});
check("终态不可再迁移（succeeded→received 抛错）", () => {
  let threw = false;
  try { T.updateStage("qq:private:" + U + ":sm1", "received"); } catch (e) { threw = true; }
  return threw;
});
check("非法迁移（received→send_started 跳级）抛错", () => {
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "sm2", sourceTs: 21 });
  let threw = false;
  try { T.updateStage(r.event.event_id, "send_started"); } catch (e) { threw = true; }
  return threw;
});
check("intentional_no_reply 是合法终态", () => {
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "sm3", sourceTs: 22 });
  T.updateStage(r.event.event_id, "intentional_no_reply");
  return T.readEvent(r.event.event_id).stage === "intentional_no_reply";
});
check("failed_retryable 可重启重试（→ready）", () => {
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "sm4", sourceTs: 23 });
  T.updateStage(r.event.event_id, "ready");
  T.updateStage(r.event.event_id, "model_started");
  T.updateStage(r.event.event_id, "failed_retryable", { last_error: "模型 429" });
  T.updateStage(r.event.event_id, "ready");
  return T.readEvent(r.event.event_id).stage === "ready";
});

/* 4. reply_prepared 持久化 + 会话提交标记 */
check("setReply 持久化回复文本", () => {
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "sm5", sourceTs: 24 });
  for (const st of ["debouncing", "ready", "model_started", "reply_prepared"]) T.updateStage(r.event.event_id, st);
  T.setReply(r.event.event_id, "在的呀");
  return T.readEvent(r.event.event_id).reply_prepared === "在的呀";
});
check("markCommitted 分别标记 user/assistant 会话提交", () => {
  const id = "qq:private:" + U + ":sm5";
  T.markCommitted(id, "user");
  T.markCommitted(id, "assistant");
  const ev = T.readEvent(id);
  return ev.session_user_committed === true && ev.session_assistant_committed === true;
});

/* 5. scope 串行 + 互不影响 */
check("同 scope 串行提交（顺序一致）", async () => {
  const order = [];
  const p1 = T.withScopeLock("user:" + U, async () => { order.push("a"); await new Promise(r => setTimeout(r, 30)); order.push("a2"); });
  const p2 = T.withScopeLock("user:" + U, async () => { order.push("b"); });
  await Promise.all([p1, p2]);
  return order.join(",") === "a,a2,b";
});
check("不同 scope 互不阻塞（一个失败不影响另一个）", async () => {
  let ok = false;
  const p1 = T.withScopeLock("user:" + U2, async () => { throw new Error("boom"); }).catch(() => {});
  const p2 = T.withScopeLock("group:9", async () => { ok = true; });
  await Promise.all([p1, p2]);
  return ok === true;
});

/* 6. epoch 重置屏障 */
check("resetScope 推进 epoch 并取消旧 pending", () => {
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "ep1", sourceTs: 30 });
  T.updateStage(r.event.event_id, "ready");
  const before = T.scopeEpoch("user:" + U);
  const res = T.resetScope("user:" + U);
  const ev = T.readEvent(r.event.event_id);
  return res.epoch === before + 1 && ev.stage === "cancelled_by_reset" && res.cancelled >= 1;
});
check("重置后同 message_id 重投不复活（isNew=false，沿用旧事件）", () => {
  /* 同一外部 message_id 重投（无论 reset 前后）都不得变成新事件：isNew=false、stage 保持 cancelled_by_reset */
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "ep1", sourceTs: 31, rawEvent: { raw_message: "新消息" } });
  const ev = r.event;
  return r.isNew === false && ev.stage === "cancelled_by_reset";
});
check("cancelled_by_reset 事件不可再迁移", () => {
  /* 找一条已取消事件验证保护 */
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "ep2", sourceTs: 32 });
  T.updateStage(r.event.event_id, "ready");
  T.resetScope("user:" + U);
  let threw = false;
  try { T.updateStage(r.event.event_id, "model_started"); } catch (e) { threw = true; }
  return threw;
});

/* 7. 重启对账 */
check("reconcileOnBoot：model_started→interrupted 不自动重跑", () => {
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "rb1", sourceTs: 40 });
  T.updateStage(r.event.event_id, "debouncing"); T.updateStage(r.event.event_id, "ready"); T.updateStage(r.event.event_id, "model_started");
  const res = T.reconcileOnBoot();
  return res.interrupted >= 1 && T.readEvent(r.event.event_id).stage === "interrupted";
});
check("reconcileOnBoot：send_started→unknown 不自动重发", () => {
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "rb2", sourceTs: 41 });
  T.updateStage(r.event.event_id, "debouncing"); T.updateStage(r.event.event_id, "ready"); T.updateStage(r.event.event_id, "model_started");
  T.updateStage(r.event.event_id, "reply_prepared");
  T.setReply(r.event.event_id, "回一下");
  T.updateStage(r.event.event_id, "send_started");
  const res = T.reconcileOnBoot();
  return res.unknown >= 1 && T.readEvent(r.event.event_id).stage === "unknown";
});
check("reconcileOnBoot：received/debouncing/ready 保留供 safe resume", () => {
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "rb3", sourceTs: 42 });
  T.updateStage(r.event.event_id, "debouncing");
  const res = T.reconcileOnBoot();
  return res.resumed >= 1 && T.readEvent(r.event.event_id).stage === "debouncing";
});
check("reconcileOnBoot：reply_prepared 保留可重试同一回复", () => {
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "rb4", sourceTs: 43 });
  T.updateStage(r.event.event_id, "debouncing"); T.updateStage(r.event.event_id, "ready"); T.updateStage(r.event.event_id, "model_started");
  T.updateStage(r.event.event_id, "reply_prepared");
  T.setReply(r.event.event_id, "这条回复没发出去");
  T.reconcileOnBoot();
  const ev = T.readEvent(r.event.event_id);
  return ev.stage === "reply_prepared" && ev.reply_prepared === "这条回复没发出去";
});

/* 8. 防抖恢复批次 */
check("recoverDebounced 只取 received/debouncing 且按 scope", () => {
  const r1 = T.recordEvent({ channel: "private", userId: U, messageId: "db1", sourceTs: 50 });
  T.updateStage(r1.event.event_id, "debouncing");
  const r2 = T.recordEvent({ channel: "private", userId: U, messageId: "db2", sourceTs: 51 });
  const r3 = T.recordEvent({ channel: "private", userId: U2, messageId: "db3", sourceTs: 52 });
  T.updateStage(r3.event.event_id, "debouncing");
  const r4 = T.recordEvent({ channel: "private", userId: U, messageId: "db4", sourceTs: 53 });
  T.updateStage(r4.event.event_id, "debouncing"); T.updateStage(r4.event.event_id, "ready"); T.updateStage(r4.event.event_id, "model_started");
  const got = T.recoverDebounced("user:" + U);
  const ids = got.map(e => e.event_id).sort();
  return ids.includes(r1.event.event_id) && ids.includes(r2.event.event_id) && !ids.includes(r3.event.event_id) && !ids.includes(r4.event.event_id);
});

/* 9. 收件箱统计与健康 */
check("inboxStats 阶段计数 + inboxHealth 有 pending 时 hasAttention", () => {
  const s = T.inboxStats();
  const h = T.inboxHealth();
  return typeof s.pending === "number" && typeof h.hasAttention === "boolean" && (s.pending > 0 ? h.hasAttention === true : true);
});
check("cleanupInbox 只清成功终态，不清 pending", () => {
  const r = T.recordEvent({ channel: "private", userId: U, messageId: "cl1", sourceTs: 60 });
  for (const st of ["debouncing", "ready", "model_started", "reply_prepared", "send_started", "succeeded"]) T.updateStage(r.event.event_id, st);
  const r2 = T.recordEvent({ channel: "private", userId: U, messageId: "cl2", sourceTs: 61 });
  T.updateStage(r2.event.event_id, "debouncing"); T.updateStage(r2.event.event_id, "ready");
  // 把 cl1 事件文件 updated_at 改旧 8 天 → 超出保留窗，cleanup 应删除；cl2（pending）必须保留
  const f = path.join(dir, "conversation-inbox", T.safeFile(r.event.event_id));
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  raw.updated_at = Date.now() - 8 * 24 * 3600e3;
  fs.writeFileSync(f, JSON.stringify(raw));
  const before = T.readEvent(r2.event.event_id) !== null;
  const n = T.cleanupInbox();
  return before && n >= 1 && T.readEvent(r2.event.event_id) !== null && T.readEvent(r.event.event_id) === null;
});

_chain.then(() => {
  console.log("conversation-recovery: " + pass + "/" + (pass + fail) + " passed");
  process.exit(fail ? 1 : 0);
});
