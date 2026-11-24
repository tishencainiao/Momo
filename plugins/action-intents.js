/* 框架服务 · 持久行动意图（v3.0.0）
 * 意图先落盘，再执行；过期不补发；非幂等结果不明不自动重放。
 * 已有 action ledger 继续负责真实副作用，本服务负责意图生命周期与恢复决策。 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let _ctx = null;
const FILE = () => path.join(_ctx.DATA_DIR, "action-intents.json");
const MAX = 200;
let _lastRecover = 0;
function hash(s) { return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 20); }
function blank() { return { version: 1, intents: [] }; }
function load() {
  try { const d = JSON.parse(fs.readFileSync(FILE(), "utf8")); return d && Array.isArray(d.intents) ? Object.assign(blank(), d) : blank(); }
  catch (e) { return blank(); }
}
function save(st) {
  fs.mkdirSync(_ctx.DATA_DIR, { recursive: true });
  st.intents = (st.intents || []).slice(-MAX);
  _ctx.writeJsonAtomic(FILE(), st);
}
function scopeOf(s) {
  const channel = s.channel || "private";
  const uid = Number(s.userId) || 0;
  const gid = Number(s.groupId) || 0;
  if (channel === "group") return uid && gid ? { actor: "user:" + uid, privacy: "group:" + gid } : null;
  if (channel === "pet" || channel === "local") return { actor: "local", privacy: "local" };
  return uid ? { actor: "user:" + uid, privacy: "user:" + uid } : null;
}
function get(key, st) { const d = st || load(); return (d.intents || []).find((x) => x.action_key === key || x.intent_id === key) || null; }
function track(spec) {
  const s = spec || {};
  const scope = scopeOf(s);
  const kind = String(s.kind || "").trim();
  if (!scope || !kind) return { ok: false, reason: "invalid_scope_or_kind" };
  const now = Number(s.now) || Date.now();
  const valid = Number(s.valid_until) || (now + 10 * 60000);
  if (valid <= now) return { ok: false, reason: "expired" };
  let key = String(s.key || "");
  if (!key) {
    const raw = [kind, scope.privacy, s.payload_summary || "", s.reason || ""].join("|");
    key = _ctx.actionKey ? _ctx.actionKey(kind, scope.privacy, s.payload_summary || "", s.reason || "") : "act-" + hash(raw);
  }
  const st = load();
  const old = get(key, st);
  if (old) return { ok: true, duplicate: true, key, intent: old };
  const intent = {
    intent_id: "intent-" + hash(key), action_key: key, kind,
    risk: s.risk === "high" ? "high" : "low",
    action_class: ["read", "idempotent", "non_idempotent", "async"].includes(s.action_class) ? s.action_class : "non_idempotent",
    actor_scope: scope.actor, privacy_scope: scope.privacy,
    user_id: Number(s.userId) || 0, group_id: Number(s.groupId) || 0,
    channel: s.channel || "private", reason: String(s.reason || "").slice(0, 200),
    payload_summary: String(s.payload_summary || "").slice(0, 300),
    created_at: now, valid_until: valid, status: "ready", attempts: 0,
    retry_safe: s.retry_safe === true && (s.action_class === "read" || s.action_class === "idempotent"),
    last_error: "", result_evidence: null,
  };
  st.intents.push(intent);
  try { save(st); return { ok: true, duplicate: false, key, intent }; }
  catch (e) { return { ok: false, reason: "intent_write_failed", error: String(e.message).slice(0, 120) }; }
}
function markRunning(key, now) {
  const st = load(), it = get(key, st);
  if (!it) return { ok: false, reason: "not_found" };
  const ts = Number(now) || Date.now();
  if (it.status !== "ready") return { ok: false, reason: "invalid_stage", intent: it };
  if (Number(it.valid_until) <= ts) {
    it.status = "expired"; it.last_error = "意图已过期";
    try { save(st); } catch (e) {}
    return { ok: false, reason: "expired", intent: it };
  }
  it.status = "running"; it.started_at = ts; it.attempts = (Number(it.attempts) || 0) + 1;
  try { save(st); return { ok: true, intent: it }; }
  catch (e) { return { ok: false, reason: "running_write_failed", error: String(e.message).slice(0, 120) }; }
}
function settle(key, result) {
  const st = load(), it = get(key, st);
  if (!it) return { ok: false, reason: "not_found" };
  const r = result || {};
  let status = String(r.result || r.status || "");
  if (!status) status = r.ok === true ? "succeeded" : (r.ok === false ? "failed" : "unknown");
  if (status === "duplicate_succeeded") status = "succeeded";
  if (!["succeeded", "failed", "unknown", "cancelled", "expired"].includes(status)) status = "unknown";
  it.status = status;
  it.finished_at = Number(r.now) || Date.now();
  it.last_error = String(r.error || "").slice(0, 160);
  it.result_evidence = {
    action_key: r.action_key || key,
    summary: String(r.summary || r.evidence || "").slice(0, 200),
    verification_event_id: r.verification_event_id || "",
  };
  try { save(st); return { ok: true, intent: it }; }
  catch (e) { return { ok: false, reason: "settle_write_failed", error: String(e.message).slice(0, 120) }; }
}
function latestAction(key) {
  try { const rows = _ctx.loadActions ? _ctx.loadActions(200) : []; return rows.filter((a) => a && a.key === key && ["succeeded", "failed", "unknown", "cancelled"].includes(a.status)).slice(-1)[0] || null; }
  catch (e) { return null; }
}
function recover(now) {
  const ts = Number(now) || Date.now();
  const st = load();
  const counts = { expired: 0, ready: 0, unknown: 0, settled: 0 };
  for (const it of st.intents) {
    if (["succeeded", "failed", "unknown", "cancelled", "expired"].includes(it.status)) continue;
    if (Number(it.valid_until) <= ts) { it.status = "expired"; it.last_error = "重启/巡检时意图已过期"; counts.expired++; continue; }
    if (it.status === "ready") { counts.ready++; continue; }
    if (it.status !== "running") continue;
    const terminal = latestAction(it.action_key);
    if (terminal) {
      it.status = terminal.status;
      it.last_error = String(terminal.error || "").slice(0, 160);
      it.result_evidence = { action_key: it.action_key, summary: String(terminal.result_summary || "行动账本终态").slice(0, 200), verification_event_id: terminal.verification_event_id || "" };
      counts.settled++;
    } else if (it.retry_safe) {
      it.status = "ready"; it.last_error = "上次执行中断，策略允许安全重试"; counts.ready++;
    } else {
      it.status = "unknown"; it.last_error = "非幂等执行结果不明，不自动重放"; counts.unknown++;
    }
  }
  try { save(st); } catch (e) { counts.write_error = String(e.message).slice(0, 100); }
  return counts;
}
async function run(spec, executor, verifier) {
  const tracked = track(spec);
  if (!tracked.ok) return { result: "blocked", reason: tracked.reason };
  if (tracked.duplicate && !(tracked.intent.status === "ready" && tracked.intent.retry_safe)) return { result: tracked.intent.status === "succeeded" ? "duplicate_succeeded" : "duplicate_" + tracked.intent.status, key: tracked.key };
  const started = markRunning(tracked.key);
  if (!started.ok) return { result: "blocked", reason: started.reason, key: tracked.key };
  const acquired = _ctx.tryBeginAction({ key: tracked.key, action: spec.kind, userId: spec.userId, groupId: spec.groupId, channel: spec.channel, risk: tracked.intent.risk, action_class: tracked.intent.action_class, detail: tracked.intent.reason });
  if (!acquired.acquired) return { result: "duplicate_running", key: tracked.key, duplicateOf: acquired.duplicateOf };
  let out;
  try {
    const raw = await executor(tracked.intent);
    out = raw && typeof raw === "object" ? raw : { ok: raw !== false, summary: String(raw || "") };
    if (out.ok === true && verifier) {
      const v = await verifier(out, tracked.intent);
      if (v && v.ok === true) { out.verified = true; out.verification_event_id = v.eventId || v.verification_event_id || ""; }
      else if (v && v.unknown === true) out.ok = undefined;
      else if (v && v.ok === false) out.ok = false;
    }
  } catch (e) { out = { ok: e && e.code === "UNKNOWN" ? undefined : false, error: String((e && e.message) || e) }; }
  const end = { ok: out.ok, summary: out.summary || "", error: out.error || "", verified: !!out.verified, verification_event_id: out.verification_event_id || "" };
  _ctx.endAction(tracked.key, end);
  settle(tracked.key, Object.assign({}, out, end, { action_key: tracked.key }));
  return Object.assign({}, out, { key: tracked.key, result: out.ok === true ? "succeeded" : (out.ok === false ? "failed" : "unknown") });
}
function health() {
  const rows = load().intents.filter((x) => ["ready", "running", "unknown"].includes(x.status));
  return { pending: rows.filter((x) => x.status !== "unknown").length, unknown: rows.filter((x) => x.status === "unknown").length, total: load().intents.length };
}
module.exports = {
  name: "action-intents", displayName: "行动意图", description: "意图先落盘、过期不补发、结果不明不乱重试", system: true, userScoped: false, requires: [], version: "1.0.0",
  apiSpec: { actionIntents: {
    track: { input: "行动意图", output: "{ok,key,intent}", sideEffect: "先写意图" },
    markRunning: { input: "action_key", output: "执行前状态", sideEffect: "写 running" },
    settle: { input: "action_key,result", output: "终态", sideEffect: "写结果" },
    recover: { input: "now", output: "恢复计数", sideEffect: "过期/unknown/安全重试" },
    run: { input: "spec,executor,verifier", output: "行动结果", sideEffect: "按类型执行并记账" },
    list: { input: "无", output: "意图列表", sideEffect: "只读" },
    get: { input: "action_key", output: "单条意图或 null", sideEffect: "只读" },
    health: { input: "无", output: "健康计数", sideEffect: "只读" },
  } },
  api: { actionIntents: { track, markRunning, settle, recover, run, health, get: (key) => get(key), list: () => load().intents.map((x) => Object.assign({}, x)) } },
  init(ctx) { _ctx = ctx; recover(); },
  hooks: { timer(p) { const now = p && p.now || Date.now(); if (now - _lastRecover < 60000) return; _lastRecover = now; recover(now); } },
  __test: { load, save, track, markRunning, settle, recover, run, scopeOf, get },
};
