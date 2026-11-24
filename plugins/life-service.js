/* 框架服务 · 生活节律（v3.0.0）
 * 有限的日计划 + 本地时段 + 主动反馈冷却；不直接执行工具或发送消息。
 * 日目标不无限滚存；群聊权限不因本服务扩大。 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let _ctx = null;
const FILE = () => path.join(_ctx.DATA_DIR, "life-state.json");
const MAX_GOALS = 3;
let _degraded = "";
let _lastTick = 0;

function dayKey(ts) { const d = new Date(Number(ts) || Date.now()); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function phaseForHour(h) { h = Number(h); if (h < 7 || h >= 23) return "night"; if (h < 11) return "morning"; if (h < 18) return "day"; return "evening"; }
function blank() { return { version: 1, days: {}, users: {}, updated_at: 0 }; }
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    if (!d || typeof d !== "object" || !d.days || !d.users) throw new Error("结构异常");
    _degraded = "";
    return Object.assign(blank(), d);
  } catch (e) {
    if (e.code !== "ENOENT") _degraded = "生活节律数据不可读：" + String(e.message).slice(0, 80);
    return blank();
  }
}
function save(st) {
  try {
    fs.mkdirSync(_ctx.DATA_DIR, { recursive: true });
    st.updated_at = Date.now();
    const days = Object.keys(st.days || {}).sort().slice(-10);
    st.days = Object.fromEntries(days.map((k) => [k, st.days[k]]));
    _ctx.writeJsonAtomic(FILE(), st);
    _degraded = "";
    return true;
  } catch (e) { _degraded = "生活节律写入失败：" + String(e.message).slice(0, 80); return false; }
}
function hash(s) { return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16); }
function ensureDay(now) {
  const ts = Number(now) || Date.now();
  const st = load();
  const day = dayKey(ts);
  if (st.days[day]) return { st, day, rec: st.days[day], created: false };
  const goals = [];
  try {
    const mind = _ctx.getApi("mind");
    const ms = mind && mind.loadMindState ? mind.loadMindState() : null;
    const loops = mind && mind.loadOpenLoops && ms ? mind.loadOpenLoops(ms) : [];
    for (const l of loops.slice(0, MAX_GOALS)) {
      const text = String((l && (l.text || l.content)) || "").trim().slice(0, 100);
      if (text) goals.push({ id: "goal-" + hash(day + "|" + text), kind: "reflect", text, status: "ready", created_at: ts });
    }
  } catch (e) {}
  if (!goals.length) goals.push({ id: "goal-" + hash(day + "|review"), kind: "review", text: "整理最近的经历，看看有没有值得继续的事", status: "ready", created_at: ts });
  st.days[day] = { day, phase: phaseForHour(new Date(ts).getHours()), goals: goals.slice(0, MAX_GOALS), created_at: ts, phase_history: [], resting: false };
  save(st);
  return { st, day, rec: st.days[day], created: true };
}
function tick(now) {
  const ts = Number(now) || Date.now();
  const cur = ensureDay(ts);
  const phase = phaseForHour(new Date(ts).getHours());
  let changed = false;
  if (cur.rec.phase !== phase) {
    cur.rec.phase_history = (cur.rec.phase_history || []).concat([{ from: cur.rec.phase, to: phase, ts }]).slice(-12);
    cur.rec.phase = phase;
    changed = true;
  }
  const resting = phase === "night";
  if (cur.rec.resting !== resting) { cur.rec.resting = resting; changed = true; }
  if (changed || cur.created) save(cur.st);
  return { day: cur.day, phase, goals: cur.rec.goals.slice(), created: cur.created };
}
function healthAllows() {
  try {
    const h = _ctx.getApi("health");
    if (!h || !h.snapshot) return true;
    const bad = h.snapshot().filter((s) => ["perception", "conversation", "startupRecovery", "actionIntents", "autonomy"].includes(s.name) && ["degraded", "offline"].includes(s.status));
    return bad.length ? { ok: false, reason: "health_" + bad[0].name + "_" + bad[0].status } : { ok: true };
  } catch (e) { return { ok: false, reason: "health_unknown" }; }
}
function autonomyPaused() { return !!(_ctx.config && _ctx.config.life && _ctx.config.life.autonomy_paused); }
function authorizeInternal(kind, now) {
  if (autonomyPaused()) return { ok: false, reason: "autonomy_paused" };
  const ts = Number(now) || Date.now();
  const cur = tick(ts);
  if (cur.phase === "night") return { ok: false, reason: "night" };
  const au = _ctx.getApi("autonomy");
  if (!au || !au.authorize) return { ok: false, reason: "autonomy_unavailable" };
  const d = au.authorize({ kind: "internal_action", risk: "low" });
  if (!d.allowed) return { ok: false, reason: d.reason || "autonomy_denied" };
  if (_ctx.isBudgetExhausted && _ctx.isBudgetExhausted()) return { ok: false, reason: "budget" };
  const hg = healthAllows();
  if (!hg.ok) return hg;
  const rec = cur.rec || load().days[cur.day];
  const usage = rec.internal_actions || { attempts: 0, by_kind: {} };
  const k = String(kind || "unknown");
  if ((Number(usage.attempts) || 0) >= 4) return { ok: false, reason: "daily_action_cap" };
  if (Number(usage.by_kind && usage.by_kind[k]) >= 2) return { ok: false, reason: "kind_action_cap" };
  return { ok: true, day: cur.day, phase: cur.phase };
}
function recordInternalOutcome(day, kind, result, evidence, now) {
  const st = load(), rec = st.days[String(day || dayKey())];
  if (!rec) return false;
  const k = String(kind || "unknown");
  const usage = rec.internal_actions || { attempts: 0, succeeded: 0, by_kind: {} };
  usage.attempts = (Number(usage.attempts) || 0) + 1;
  usage.by_kind = usage.by_kind || {};
  usage.by_kind[k] = (Number(usage.by_kind[k]) || 0) + 1;
  const ok = result === true || result === "succeeded" || (result && result.ok === true);
  if (ok) usage.succeeded = (Number(usage.succeeded) || 0) + 1;
  usage.last = { kind: k, ok, evidence: String(evidence || "").slice(0, 200), ts: Number(now) || Date.now() };
  rec.internal_actions = usage;
  return save(st);
}
function canProactive(userId, opts) {
  if (autonomyPaused()) return { ok: false, reason: "autonomy_paused" };
  const uid = Number(userId) || 0;
  if (!uid) return { ok: false, reason: "missing_user" };
  if (_degraded) return { ok: false, reason: "life_degraded" };
  const now = Number(opts && opts.now) || Date.now();
  const cur = tick(now);
  if (cur.phase === "night") return { ok: false, reason: "night" };
  const au = _ctx.getApi("autonomy");
  if (!au || !au.authorize) return { ok: false, reason: "autonomy_unavailable" };
  const d = au.authorize({ kind: "proactive", risk: "low", channel: "private", userId: uid });
  if (!d.allowed) return { ok: false, reason: d.reason || "autonomy_denied" };
  if (_ctx.isBudgetExhausted && _ctx.isBudgetExhausted()) return { ok: false, reason: "budget" };
  try { if (_ctx.isUserQuiet && _ctx.isUserQuiet(uid)) return { ok: false, reason: "user_quiet" }; } catch (e) {}
  const hg = healthAllows();
  if (!hg.ok) return hg;
  const u = load().users[String(uid)] || {};
  if (Number(u.cooldown_until) > now) return { ok: false, reason: "feedback_cooldown", until: Number(u.cooldown_until) };
  return { ok: true, day: cur.day, phase: cur.phase, awaiting_reply: !!u.awaiting_reply, ignored_streak: Number(u.ignored_streak) || 0 };
}
function recordProactiveOutcome(userId, result, now) {
  const uid = Number(userId) || 0;
  if (!uid) return false;
  const ts = Number(now) || Date.now();
  const cur = ensureDay(ts);
  const key = String(uid);
  const u = cur.st.users[key] || { awaiting_reply: false, ignored_streak: 0, cooldown_until: 0 };
  const status = typeof result === "string" ? result : String(result && (result.result || result.status) || "unknown");
  const ok = result === true || status === "succeeded" || status === "duplicate_succeeded";
  u.last_outcome = ok ? "succeeded" : status;
  u.last_outcome_at = ts;
  if (ok) {
    if (u.awaiting_reply) u.ignored_streak = Math.min(6, (Number(u.ignored_streak) || 0) + 1);
    u.awaiting_reply = true;
    const extra = u.ignored_streak > 0 ? Math.min(6 * 3600e3, 3600e3 * Math.pow(2, Math.min(3, u.ignored_streak - 1))) : 0;
    u.cooldown_until = extra ? ts + extra : 0;
  }
  cur.st.users[key] = u;
  return save(cur.st);
}
function noteUserReply(userId, now) {
  const uid = Number(userId) || 0;
  if (!uid) return;
  const cur = ensureDay(Number(now) || Date.now());
  cur.st.users[String(uid)] = Object.assign(cur.st.users[String(uid)] || {}, { awaiting_reply: false, ignored_streak: 0, cooldown_until: 0, last_reply_at: Number(now) || Date.now() });
  save(cur.st);
}
function completeGoal(day, id, evidence) {
  const st = load(), rec = st.days[String(day || dayKey())];
  if (!rec) return { ok: false, reason: "day_not_found" };
  const g = (rec.goals || []).find((x) => x.id === id);
  if (!g) return { ok: false, reason: "goal_not_found" };
  if (!String(evidence || "").trim()) return { ok: false, reason: "evidence_required" };
  if (g.status === "succeeded") return { ok: true, duplicate: true, goal: g };
  g.status = "succeeded";
  g.completed_at = Date.now();
  g.evidence = String(evidence || "").slice(0, 200);
  return save(st) ? { ok: true, goal: g } : { ok: false, reason: "write_failed" };
}
function status() {
  const st = load();
  const day = dayKey();
  const rec = st.days[day];
  const users = Object.values(st.users || {});
  const ia = (rec && rec.internal_actions) || { attempts: 0, succeeded: 0, by_kind: {} };
  return { degraded: _degraded, day, phase: rec ? rec.phase : "unknown", goals: rec ? rec.goals.length : 0, awaiting_reply: users.filter((u) => u.awaiting_reply).length, internal_actions: { attempts: Number(ia.attempts) || 0, succeeded: Number(ia.succeeded) || 0, by_kind: ia.by_kind || {} } };
}
module.exports = {
  name: "life", displayName: "生活节律", description: "有限日计划、昼夜阶段、主动反馈冷却与夜间收尾", system: true, userScoped: false, requires: [], version: "1.0.0",
  apiSpec: { life: {
    canProactive: { input: "userId", output: "是否允许及原因", sideEffect: "只读+确保当日状态" },
    authorizeInternal: { input: "kind,now", output: "内部行动门禁", sideEffect: "只读+当日状态" },
    recordInternalOutcome: { input: "day,kind,result,evidence", output: "是否落盘", sideEffect: "写每日行动计数" },
    recordProactiveOutcome: { input: "userId,result", output: "是否落盘", sideEffect: "写反馈冷却" },
    noteUserReply: { input: "userId", output: "无", sideEffect: "清除等待反馈" },
    tick: { input: "now", output: "当日阶段与目标", sideEffect: "写日节律" },
    completeGoal: { input: "day,goal_id,evidence", output: "完成结果", sideEffect: "写目标终态" },
    goals: { input: "day", output: "当日目标", sideEffect: "只读" },
    status: { input: "无", output: "健康状态", sideEffect: "只读" },
  } },
  api: { life: {
    canProactive, recordProactiveOutcome, noteUserReply, tick, completeGoal, authorizeInternal, recordInternalOutcome,
    goals: (day) => { const st = load(); return ((st.days[String(day || dayKey())] || {}).goals || []).map((g) => Object.assign({}, g)); },
    status,
  } },
  init(ctx) { _ctx = ctx; tick(); },
  hooks: {
    timer(p) { const now = p && p.now || Date.now(); if (now - _lastTick < 60000) return; _lastTick = now; tick(now); },
    private_message(m) { if (m && m.userId) noteUserReply(m.userId); },
  },
  commands: [{ key: "/生活", regex: /^\/生活$/, handler(msg) {
    if (!_ctx.isMaster(msg.userId)) return "（这个只有主人能看哦～）";
    const cur = tick();
    const lines = cur.goals.map((g, i) => `${i + 1}. [${g.status}] ${g.text}`);
    return `今天 ${cur.day}，现在处于 ${cur.phase}。\n今日有限目标：\n${lines.join("\n")}\n（旧目标不会无限滚存，夜间只收尾不主动打扰。）`;
  } }],
  __test: { dayKey, phaseForHour, ensureDay, tick, canProactive, recordProactiveOutcome, noteUserReply, load, save, MAX_GOALS },
};
