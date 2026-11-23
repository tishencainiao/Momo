/* conversation-recovery.js — v2.2.0 连续存在底座 II：会话与跨渠道恢复
 * 职责：统一事件身份 / 持久收件箱 / 状态机 / scope 串行 / 重启对账 / 重置屏障
 * 不承担：真实发送、模型调用（这些由 index.js 在事件边界内执行）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VERSION = "1.0.0";

const STAGE_TERMINAL = new Set(["succeeded", "intentional_no_reply", "dead", "cancelled_by_reset"]);
const STAGE_RUNNING = new Set(["model_started", "handler_started", "send_started"]);
const STAGE_ALL = new Set([
  "received", "debouncing", "ready", "model_started", "handler_started",
  "reply_prepared", "send_started", "succeeded", "intentional_no_reply",
  "failed_retryable", "interrupted", "unknown", "dead", "cancelled_by_reset",
]);
/* 允许迁移表：从 -> 可到 */
const STAGE_MOVE = {
  received: ["debouncing", "ready", "handler_started", "succeeded", "intentional_no_reply", "failed_retryable", "interrupted", "unknown", "dead", "cancelled_by_reset"],
  debouncing: ["received", "ready", "succeeded", "intentional_no_reply", "failed_retryable", "interrupted", "unknown", "dead", "cancelled_by_reset"],
  ready: ["received", "model_started", "handler_started", "intentional_no_reply", "failed_retryable", "interrupted", "unknown", "dead", "cancelled_by_reset"],
  model_started: ["reply_prepared", "intentional_no_reply", "failed_retryable", "interrupted", "unknown", "dead", "cancelled_by_reset"],
  handler_started: ["succeeded", "intentional_no_reply", "failed_retryable", "interrupted", "unknown", "dead", "cancelled_by_reset"],
  reply_prepared: ["send_started", "intentional_no_reply", "failed_retryable", "interrupted", "unknown", "dead", "cancelled_by_reset"],
  send_started: ["succeeded", "failed_retryable", "unknown", "dead", "cancelled_by_reset"],
  succeeded: [], intentional_no_reply: [], dead: [], cancelled_by_reset: [],
  failed_retryable: ["received", "ready", "model_started", "reply_prepared", "send_started", "interrupted", "unknown", "dead", "cancelled_by_reset"],
  interrupted: ["unknown", "dead", "cancelled_by_reset"],
  unknown: ["dead", "cancelled_by_reset"],
};

let _ctx = null;
let _inboxDir = null;
let _cursorsFile = null;
let _epochsFile = null;
const _scopeLocks = new Map();   // scope -> Promise 链（同 scope 串行提交）
const _inflight = new Map();     // event_id -> Promise（同事件处理中共享）

/* ---------------- 基础 ---------------- */
function init(ctx) {
  _ctx = ctx;
  _inboxDir = path.join(ctx.DATA_DIR, "conversation-inbox");
  _cursorsFile = path.join(ctx.DATA_DIR, "conversation-cursors.json");
  _epochsFile = path.join(ctx.DATA_DIR, "session-epochs.json");
  try { fs.mkdirSync(_inboxDir, { recursive: true }); } catch (e) { /* 目录已存在或暂无权限，首次写盘时会再报 */ }
  _scopeLocks.clear();
  _inflight.clear();
}

function eventIdFor(channel, userId, groupId, messageId) {
  if (channel === "group") return "qq:group:" + groupId + ":" + userId + ":" + messageId;
  if (channel === "pet") return "pet:" + userId + ":" + messageId;
  return "qq:private:" + userId + ":" + messageId;
}
function scopeFor(channel, userId, groupId) {
  if (channel === "group") return "group:" + groupId;
  if (channel === "pet") return "pet:" + userId;
  return "user:" + userId;
}
function _sha1(s) { return crypto.createHash("sha1").update(String(s)).digest("hex"); }
function safeFile(eventId) { return _sha1(eventId) + ".json"; }
function evPath(eventId) { return path.join(_inboxDir, safeFile(eventId)); }

/* ---------------- epoch（重置屏障） ---------------- */
function loadEpochs() { try { return JSON.parse(fs.readFileSync(_epochsFile, "utf8")); } catch (e) { return {}; } }
function saveEpochs(v) {
  try { fs.mkdirSync(path.dirname(_epochsFile), { recursive: true }); _ctx.writeJsonAtomic(_epochsFile, v); } catch (e) { throw new Error("会话重置屏障写盘失败: " + e.message); }
}
function scopeEpoch(scope) {
  const e = loadEpochs();
  const n = Number(e[scope]);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
/* 重置：epoch+1，旧非终态事件标 cancelled_by_reset。返回新 epoch */
function resetScope(scope) {
  const e = loadEpochs();
  const next = scopeEpoch(scope) + 1;
  e[scope] = next;
  saveEpochs(e);
  let n = 0;
  for (const ev of scanInbox({ scope })) {
    if (!STAGE_TERMINAL.has(ev.stage)) { try { updateStage(ev.event_id, "cancelled_by_reset", { reason: "session reset" }); n++; } catch (err) { /* 单事件失败不阻断重置 */ } }
  }
  return { epoch: next, cancelled: n };
}

/* ---------------- 事件读写（每事件独立原子写） ---------------- */
function readEvent(eventId) {
  try { return JSON.parse(fs.readFileSync(evPath(eventId), "utf8")); } catch (e) { return null; }
}
function writeEvent(ev) {
  const p = evPath(ev.event_id);
  const body = JSON.stringify(Object.assign({}, ev, { updated_at: Date.now() }));
  try {
    fs.mkdirSync(_inboxDir, { recursive: true });
    _ctx.writeJsonAtomic(p, JSON.parse(body));
  } catch (e) {
    throw new Error("收件箱写盘失败: " + e.message);
  }
}
/* 建事件：重复 event_id 不新增不重置；cancelled_by_reset 的旧事件遇新投递才重建 */
function recordEvent(opts) {
  const channel = opts.channel;
  const userId = Number(opts.userId) || 0;
  const groupId = Number(opts.groupId) || 0;
  const messageId = String(opts.messageId || "");
  const scope = opts.scope || scopeFor(channel, userId, groupId);
  const epoch = opts.epoch || scopeEpoch(scope);
  const legacy = !messageId;
  const eventId = legacy
    ? ("legacy:unidentified:" + scope + ":" + Date.now() + ":" + _sha1(JSON.stringify(opts.rawEvent || {})).slice(0, 8))
    : opts.eventId || eventIdFor(channel, userId, groupId, messageId);
  const old = readEvent(eventId);
  if (old) {
    /* 重置屏障：cancelled_by_reset 是终态，同 message_id 重投（无论 reset 前后）都不重建为全新事件；真正的新消息必须用新的外部 event ID */
    return { event: old, isNew: false };
  }
  const ev = {
    schema: 1, event_id: eventId, scope, channel, user_id: userId, group_id: groupId,
    message_id: messageId || null, source_ts: Number(opts.sourceTs) || 0,
    received_at: Date.now(), session_epoch: epoch, stage: "received",
    raw_event: _limit(opts.rawEvent || null, 4000), parsed_input: _limit(opts.parsedInput || null, 4000),
    attempts: 0, reply_prepared: null, send_action_key: null, send_message_id: null,
    tool_outcome_ids: [], session_user_committed: false, session_assistant_committed: false,
    last_error: null, updated_at: Date.now(), legacy,
  };
  writeEvent(ev);
  return { event: ev, isNew: true };
}

/* 状态迁移：终态不可再迁（除 failed_retryable 重启），写盘失败抛错不吞 */
function updateStage(eventId, stage, patch) {
  if (!STAGE_ALL.has(stage)) throw new Error("未知阶段: " + stage);
  const ev = readEvent(eventId);
  if (!ev) throw new Error("事件不存在: " + eventId);
  if (ev.stage === stage) { if (patch) writeEvent(Object.assign(ev, patch || {})); return ev; }
  const allowed = STAGE_MOVE[ev.stage] || [];
  if (ev.stage !== "cancelled_by_reset" && !allowed.includes(stage)) {
    throw new Error("非法状态迁移: " + ev.stage + " -> " + stage);
  }
  if (ev.stage === "cancelled_by_reset") {
    /* 重置屏障：旧事件不允许复活到任何非终态 */
    throw new Error("事件已被重置屏障取消，不可迁移: " + eventId);
  }
  const next = Object.assign({}, ev, patch || {}, { stage, updated_at: Date.now() });
  writeEvent(next);
  return next;
}
function setReply(eventId, replyText, extra) {
  const ev = readEvent(eventId);
  if (!ev) throw new Error("事件不存在: " + eventId);
  const next = Object.assign({}, ev, { reply_prepared: replyText, updated_at: Date.now() }, extra || {});
  writeEvent(next);
  return next;
}
function markCommitted(eventId, which) {
  const ev = readEvent(eventId);
  if (!ev) throw new Error("事件不存在: " + eventId);
  const next = Object.assign({}, ev, { updated_at: Date.now() });
  if (which === "user") next.session_user_committed = true;
  if (which === "assistant") next.session_assistant_committed = true;
  writeEvent(next);
  return next;
}

/* 扫描收件箱：不依赖单一 index，坏文件跳过并计数 */
function scanInbox(opts) {
  const o = opts || {};
  let files = [];
  try { files = fs.readdirSync(_inboxDir); } catch (e) { return []; }
  const out = [];
  let corrupt = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const ev = JSON.parse(fs.readFileSync(path.join(_inboxDir, f), "utf8"));
      if (!ev || !ev.event_id) { corrupt++; continue; }
      if (o.scope && ev.scope !== o.scope) continue;
      if (o.stage && ev.stage !== o.stage) continue;
      if (o.channel && ev.channel !== o.channel) continue;
      out.push(ev);
    } catch (e) { corrupt++; }
  }
  out.sort((a, b) => (a.source_ts || 0) - (b.source_ts || 0) || (a.received_at || 0) - (b.received_at || 0));
  return Object.assign(out, { corrupt });
}
function inboxStats() {
  const all = scanInbox({});
  const s = { received: 0, debouncing: 0, ready: 0, model_started: 0, reply_prepared: 0, send_started: 0, interrupted: 0, unknown: 0, dead: 0, pending: 0, corrupt: all.corrupt };
  for (const ev of all) {
    const k = ev.stage;
    if (Object.prototype.hasOwnProperty.call(s, k)) s[k]++;
    if (!STAGE_TERMINAL.has(k)) s.pending++;
  }
  return s;
}

/* ---------------- scope 串行 ---------------- */
function withScopeLock(scope, fn) {
  const prev = _scopeLocks.get(scope) || Promise.resolve();
  const run = prev.then(fn, fn);
  _scopeLocks.set(scope, run.catch(() => {}));
  return run;
}
function withInflight(eventId, fn) {
  const prev = _inflight.get(eventId);
  if (prev) return prev;
  const run = Promise.resolve().then(fn).finally(() => { if (_inflight.get(eventId) === run) _inflight.delete(eventId); });
  _inflight.set(eventId, run);
  return run;
}

/* ---------------- 重启对账（只读修复，不发外部消息） ---------------- */
function reconcileOnBoot() {
  const res = { resumed: 0, interrupted: 0, unknown: 0, dead: 0, repaired: 0, errors: [] };
  for (const ev of scanInbox({})) {
    try {
      if (ev.stage === "model_started" || ev.stage === "handler_started") {
        updateStage(ev.event_id, "interrupted", { last_error: "进程重启，无完成检查点" });
        res.interrupted++;
      } else if (ev.stage === "send_started") {
        /* 发送结果交给账本判定：这里保守标 unknown，不自动重发 */
        updateStage(ev.event_id, "unknown", { last_error: "进程重启，发送结果不明（见行动账本）" });
        res.unknown++;
      } else if (ev.stage === "reply_prepared" || ev.stage === "ready" || ev.stage === "debouncing" || ev.stage === "received") {
        res.resumed++;
      } else if (ev.stage === "dead" || ev.stage === "cancelled_by_reset" || ev.stage === "succeeded" || ev.stage === "intentional_no_reply") {
        /* 终态不动 */
      } else if (ev.stage === "failed_retryable") {
        res.repaired++;
      }
    } catch (e) { res.errors.push(String(e.message).slice(0, 120)); }
  }
  return res;
}

/* 防抖批次恢复：从 received/debouncing 事件按 scope 重建批次（不含 ready 之后的） */
function recoverDebounced(scope) {
  return scanInbox({ scope }).filter((ev) => ev.stage === "received" || ev.stage === "debouncing");
}

/* ---------------- 清理（成功事件保留上限） ---------------- */
const KEEP_SUCCEEDED = 800;
const KEEP_SUCCEEDED_MS = 7 * 24 * 3600e3;
function cleanupInbox() {
  const done = scanInbox({}).filter((ev) => ev.stage === "succeeded" || ev.stage === "intentional_no_reply");
  const now = Date.now();
  const toDrop = done
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .filter((ev, i) => i >= KEEP_SUCCEEDED || now - (ev.updated_at || 0) > KEEP_SUCCEEDED_MS);
  let n = 0;
  for (const ev of toDrop) {
    try { fs.unlinkSync(evPath(ev.event_id)); n++; } catch (e) { /* 忽略 */ }
  }
  return n;
}

function inboxHealth() {
  const s = inboxStats();
  return {
    inbox: s,
    hasAttention: !!(s.pending || s.interrupted || s.unknown || s.corrupt),
    detail: (s.pending ? ("待恢复 " + s.pending) : "") + (s.interrupted ? " 中断 " + s.interrupted : "") + (s.unknown ? " 结果不明 " + s.unknown : "") + (s.corrupt ? " 损坏 " + s.corrupt : ""),
  };
}

function _limit(v, n) {
  if (v == null) return v;
  let s;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch (e) { return null; }
  return s.length > n ? s.slice(0, n) + "…" : v;
}


/* ---------------- WP3 补消息游标 ---------------- */
const RECOVER_MAX_MSGS = 50;
const RECOVER_MAX_LLM = 20;

function cursorFile() { return path.join(_ctx.DATA_DIR, "recovery-cursors.json"); }
function pendingFile() { return path.join(_ctx.DATA_DIR, "recovery-pending.json"); }

function loadCursors() {
  try { return JSON.parse(fs.readFileSync(cursorFile(), "utf8")); }
  catch (e) { return { updated_at: 0, private: {}, groups: {} }; }
}

/* kind: "private" | "group"；key: userId 或 groupId。patch 合并进该 scope 游标并原子写盘（失败抛错，不静默）。 */
function saveCursor(kind, key, patch) {
  const c = loadCursors();
  const bucket = kind === "group" ? (c.groups || (c.groups = {})) : (c.private || (c.private = {}));
  const cur = bucket[String(key)] || { scanned: null, completed: null, gap_suspected: false, last_error: "", updated_at: 0 };
  Object.assign(cur, patch, { updated_at: Date.now() });
  bucket[String(key)] = cur;
  c.updated_at = Date.now();
  _ctx.writeJsonAtomic(cursorFile(), c);
  return cur;
}

function cursorState() { return loadCursors(); }

function markGap(kind, key, reason) {
  return saveCursor(kind, key, { gap_suspected: true, last_error: String(reason || "").slice(0, 200) });
}

function recordPending(kind, key, count, reason) {
  let p = [];
  try { p = JSON.parse(fs.readFileSync(pendingFile(), "utf8")); } catch (e) { p = []; }
  p.push({ kind, key: String(key), count: Number(count) || 0, reason: String(reason || "").slice(0, 200), ts: Date.now() });
  if (p.length > 200) p = p.slice(-200);
  _ctx.writeJsonAtomic(pendingFile(), p);
  return p.length;
}

function pendingList() {
  try { return JSON.parse(fs.readFileSync(pendingFile(), "utf8")); } catch (e) { return []; }
}

/* 旧 seen-msg.json 只读迁移为 legacy_floor（不提供 message_id 完成证据） */
function legacyFloor() {
  try { return JSON.parse(fs.readFileSync(path.join(_ctx.DATA_DIR, "seen-msg.json"), "utf8")); }
  catch (e) { return {}; }
}

/* ---------------- 插件外壳 ---------------- */
const api = {
  conversationRecovery: {
    eventIdFor, scopeFor, recordEvent, readEvent, updateStage, setReply, markCommitted,
    scanInbox, inboxStats, reconcileOnBoot, recoverDebounced, resetScope, scopeEpoch,
    withScopeLock, withInflight, cleanupInbox, inboxHealth,
    loadCursors, saveCursor, cursorState, markGap, recordPending, pendingList, legacyFloor,
  },
};

const plugin = {
  name: "conversation-recovery",
  displayName: "会话恢复服务",
  version: VERSION,
  description: "v2.2.0 会话与跨渠道恢复：统一事件身份、持久收件箱、状态机、scope 串行、重启对账、重置屏障",
  system: true,
  userScoped: false,
  init,
  api,
  apiSpec: {
    conversationRecovery: {
      eventIdFor: { desc: "生成事件键（channel/userId/groupId/messageId）" },
      scopeFor: { desc: "生成 scope（user/group/pet）" },
      recordEvent: { desc: "收件箱记录事件（幂等）" },
      readEvent: { desc: "读事件" },
      updateStage: { desc: "状态机迁移" },
      setReply: { desc: "记回复文本" },
      markCommitted: { desc: "标记已提交" },
      scanInbox: { desc: "扫收件箱" },
      inboxStats: { desc: "收件箱统计" },
      reconcileOnBoot: { desc: "重启对账" },
      recoverDebounced: { desc: "列出可续跑防抖事件" },
      resetScope: { desc: "重置屏障" },
      scopeEpoch: { desc: "读 epoch" },
      withScopeLock: { desc: "scope 串行" },
      withInflight: { desc: "同事件共享" },
      cleanupInbox: { desc: "收件箱清理" },
      inboxHealth: { desc: "健康摘要" },
      loadCursors: { desc: "读游标" },
      saveCursor: { desc: "写游标" },
      cursorState: { desc: "游标状态" },
      markGap: { desc: "标 gap" },
      recordPending: { desc: "记待确认" },
      pendingList: { desc: "列待确认" },
      legacyFloor: { desc: "旧 seen 兜底" },
    },
  },
  commands: [],
  hooks: {
    timer: async ({ now }) => { try { cleanupInbox(); } catch (e) { /* 定时清理失败不阻断 */ } },
  },
  __test: {
    eventIdFor, scopeFor, recordEvent, readEvent, updateStage, setReply, markCommitted,
    scanInbox, inboxStats, reconcileOnBoot, recoverDebounced, resetScope, scopeEpoch,
    withScopeLock, withInflight, cleanupInbox, inboxHealth, safeFile, VERSION, STAGE_ALL, STAGE_TERMINAL, STAGE_RUNNING,
    loadCursors, saveCursor, cursorState, markGap, recordPending, pendingList, legacyFloor, RECOVER_MAX_MSGS, RECOVER_MAX_LLM,
  },
};

module.exports = plugin;
