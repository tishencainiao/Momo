/* 框架服务 · 连续存在：认识沉淀、修订链与分层自我（v3.0.0）
 * 只消费 memory-digest stable 证据组；core 不可自改，slow 需多证据，fast 有有效期。 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let _ctx = null;
const DIR = () => path.join(_ctx.DATA_DIR, "continuity");
const BELIEFS = () => path.join(DIR(), "beliefs.json");
const IDENTITY = () => path.join(DIR(), "identity.json");
const REVISIONS = () => path.join(DIR(), "revisions.jsonl");
const CORE = Object.freeze([
  "我是 Momo；我可以成长，但不假装成人类",
  "诚实区分事实、报告、推测与结果不明",
  "不跨越用户、群聊、本机与权限边界",
]);
let _degraded = "";
let _lastIngest = 0;
function hash(s) { return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 20); }
function norm(s) { return String(s || "").trim().replace(/\s+/g, " ").toLowerCase(); }
function validScope(s) { return s === "local" || s === "system_public" || /^user:\d+$/.test(s) || /^group:\d+$/.test(s); }
function readJson(file, def) { try { const d = JSON.parse(fs.readFileSync(file, "utf8")); return d && typeof d === "object" ? d : def; } catch (e) { if (e.code !== "ENOENT") _degraded = path.basename(file) + " 不可读"; return def; } }
function writeJson(file, obj) { fs.mkdirSync(DIR(), { recursive: true }); _ctx.writeJsonAtomic(file, obj); }
function beliefs() { const d = readJson(BELIEFS(), { version: 1, items: [] }); return Array.isArray(d.items) ? d : { version: 1, items: [] }; }
function identity() {
  const d = readJson(IDENTITY(), { version: 1, slow: {}, fast: {} });
  return { version: 1, core: CORE.slice(), slow: d.slow && typeof d.slow === "object" ? d.slow : {}, fast: d.fast && typeof d.fast === "object" ? d.fast : {} };
}
function revision(entry) {
  try { fs.mkdirSync(DIR(), { recursive: true }); fs.appendFileSync(REVISIONS(), JSON.stringify(Object.assign({ ts: Date.now() }, entry)) + "\n"); }
  catch (e) { _degraded = "修订日志写入失败"; return false; }
  return true;
}
function evidenceIds(x) { return Array.from(new Set((Array.isArray(x) ? x : []).map((v) => String(v || "")).filter(Boolean))).slice(0, 30); }
function upsert(spec) {
  const s = spec || {};
  const scope = String(s.scope || "");
  const statement = String(s.statement || "").trim().slice(0, 300);
  const ev = evidenceIds(s.evidence_ids || s.evidenceIds);
  if (!validScope(scope) || !statement || !ev.length) return { ok: false, reason: "invalid_belief" };
  const st = beliefs();
  const id = s.belief_id || ("bel-" + hash(scope + "|" + norm(statement)));
  const now = Number(s.now) || Date.now();
  let b = st.items.find((x) => x.belief_id === id);
  const oldEvidence = b ? b.evidence_ids.length : 0;
  if (!b) {
    b = { belief_id: id, scope, statement, evidence_ids: [], confidence: 0, status: "active", valid_until: Number(s.valid_until) || 0, supersedes: s.supersedes || "", created_at: now, confirmed_at: now, topic_key: s.topic_key || "" };
    st.items.push(b);
  }
  b.evidence_ids = evidenceIds(b.evidence_ids.concat(ev));
  b.confidence = Math.max(Number(b.confidence) || 0, Math.min(0.95, Number(s.confidence) || (0.4 + b.evidence_ids.length * 0.1)));
  b.confirmed_at = now;
  if (s.valid_until !== undefined) b.valid_until = Number(s.valid_until) || 0;
  if (s.resolve === true && b.status === "contested") b.status = "active";
  try { writeJson(BELIEFS(), st); } catch (e) { return { ok: false, reason: "write_failed", error: String(e.message).slice(0, 100) }; }
  if (b.evidence_ids.length !== oldEvidence || oldEvidence === 0) revision({ type: "belief_confirmed", belief_id: id, scope, evidence_ids: ev });
  return { ok: true, belief: b, duplicate: oldEvidence === b.evidence_ids.length };
}
function revise(id, statement, ev, opts) {
  const st = beliefs();
  const old = st.items.find((x) => x.belief_id === id);
  const evidence = evidenceIds(ev);
  if (!old || !evidence.length || !statement) return { ok: false, reason: "invalid_revision" };
  if (norm(old.statement) === norm(statement)) return upsert({ scope: old.scope, statement, evidence_ids: evidence, now: opts && opts.now, resolve: true });
  old.status = "superseded";
  old.superseded_at = Number(opts && opts.now) || Date.now();
  try { writeJson(BELIEFS(), st); } catch (e) { return { ok: false, reason: "write_failed" }; }
  const made = upsert({ scope: old.scope, statement, evidence_ids: evidence, supersedes: id, confidence: opts && opts.confidence, valid_until: opts && opts.valid_until, now: opts && opts.now });
  if (!made.ok) return made;
  revision({ type: "belief_revised", from: id, to: made.belief.belief_id, scope: old.scope, evidence_ids: evidence });
  return { ok: true, old, belief: made.belief };
}
function contest(id, ev) {
  const st = beliefs(), b = st.items.find((x) => x.belief_id === id);
  const evidence = evidenceIds(ev);
  if (!b || !evidence.length) return { ok: false, reason: "invalid_contest" };
  b.status = "contested";
  b.confidence = Math.max(0.05, (Number(b.confidence) || 0.5) * 0.5);
  b.evidence_ids = evidenceIds(b.evidence_ids.concat(evidence));
  try { writeJson(BELIEFS(), st); } catch (e) { return { ok: false, reason: "write_failed" }; }
  revision({ type: "belief_contested", belief_id: id, scope: b.scope, evidence_ids: evidence });
  return { ok: true, belief: b };
}
function ingestDigest(scope) {
  const sc = String(scope || "");
  if (!validScope(sc)) return { ok: false, reason: "invalid_scope" };
  const name = sc.replace(/:/g, "_") + ".json";
  const file = path.join(_ctx.DATA_DIR, "memory-digest", name);
  const d = readJson(file, null);
  if (!d || !Array.isArray(d.groups)) return { ok: true, count: 0 };
  let count = 0;
  for (const g of d.groups) {
    if (!g || g.status !== "stable" || !g.summary) continue;
    const ev = evidenceIds(g.evidence_ids);
    if (!ev.length) continue;
    const r = upsert({ scope: sc, statement: g.summary, evidence_ids: ev, topic_key: hash((g.top_keywords || []).slice().sort().join("|")), confidence: Math.min(0.9, 0.45 + ev.length * 0.08) });
    if (r.ok) count++;
  }
  return { ok: true, count };
}
function ingestAll() {
  const dir = path.join(_ctx.DATA_DIR, "memory-digest");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch (e) {}
  let count = 0;
  for (const f of files) {
    const d = readJson(path.join(dir, f), null);
    const scope = d && d.scope;
    if (scope && validScope(scope)) { const r = ingestDigest(scope); if (r.ok) count += r.count; }
  }
  return count;
}
function reviseSlow(key, value, ev) {
  const k = String(key || "").trim();
  const v = String(value || "").trim().slice(0, 200);
  const evidence = evidenceIds(ev);
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(k) || !v || evidence.length < 2) return { ok: false, reason: "slow_requires_two_evidence" };
  const known = new Set(beliefs().items.flatMap((b) => b.evidence_ids));
  if (!evidence.every((e) => known.has(e))) return { ok: false, reason: "unknown_evidence" };
  const id = identity();
  const previous = id.slow[k] || null;
  id.slow[k] = { value: v, evidence_ids: evidence, updated_at: Date.now() };
  try { writeJson(IDENTITY(), id); } catch (e) { return { ok: false, reason: "write_failed" }; }
  revision({ type: "self_slow_revised", key: k, previous, value: v, evidence_ids: evidence });
  return { ok: true, value: id.slow[k], previous };
}
function reviseCore() { return { ok: false, reason: "core_immutable" }; }
function setFast(key, value, ttlMs, now) {
  if (!["mood", "current_activity", "current_goal"].includes(key)) return { ok: false, reason: "invalid_fast_key" };
  const ts = Number(now) || Date.now();
  const ttl = Math.max(1000, Math.min(24 * 3600e3, Number(ttlMs) || 3600e3));
  const id = identity();
  id.fast[key] = { value: String(value || "").slice(0, 200), valid_until: ts + ttl, updated_at: ts };
  try { writeJson(IDENTITY(), id); return { ok: true, value: id.fast[key] }; } catch (e) { return { ok: false, reason: "write_failed" }; }
}
function scopesFor(c) {
  const x = c || {};
  if (x.channel === "group") return x.groupId ? new Set(["system_public", "group:" + x.groupId]) : new Set();
  const set = new Set(["system_public"]);
  if (x.userId) set.add("user:" + x.userId);
  if (x.petMode || (x.userId && _ctx.isMaster(x.userId))) set.add("local");
  return set;
}
function contextFor(c, now) {
  const visible = scopesFor(c);
  if (!visible.size) return "";
  const ts = Number(now) || Date.now();
  const bs = beliefs().items.filter((b) => b.status === "active" && visible.has(b.scope) && (!b.valid_until || b.valid_until > ts)).sort((a, b) => b.confidence - a.confidence).slice(0, 3);
  const id = identity();
  const slow = Object.entries(id.slow || {}).map(([k, v]) => k + "=" + v.value).slice(0, 4);
  const fast = Object.entries(id.fast || {}).filter(([, v]) => v && v.valid_until > ts).map(([k, v]) => k + "=" + v.value);
  const lines = [];
  if (bs.length) lines.push("已形成的认识（有证据，不是永久事实）：" + bs.map((b) => b.statement).join("；"));
  if (slow.length) lines.push("慢变自我：" + slow.join("；"));
  if (fast.length) lines.push("当前状态：" + fast.join("；"));
  return lines.length ? "【连续存在】\n" + lines.join("\n") : "";
}
function health() {
  const bs = beliefs().items;
  return { degraded: _degraded, beliefs: bs.length, contested: bs.filter((b) => b.status === "contested").length, superseded: bs.filter((b) => b.status === "superseded").length, slow_traits: Object.keys(identity().slow).length };
}
module.exports = {
  name: "continuity", displayName: "连续存在", description: "stable 证据形成认识，保留修订链，core/slow/fast 分层自我", system: true, userScoped: false, requires: [], version: "1.0.0",
  apiSpec: { continuity: {
    upsert: { input: "scope,statement,evidence_ids", output: "认识", sideEffect: "写认识与证据" },
    revise: { input: "belief_id,new statement,evidence", output: "修订链", sideEffect: "supersede 旧认识" },
    contest: { input: "belief_id,evidence", output: "contested", sideEffect: "标记冲突" },
    ingestDigest: { input: "scope", output: "消化数量", sideEffect: "只消费 stable 组" },
    reviseSlow: { input: "key,value,两条以上证据", output: "慢变自我", sideEffect: "写修订" },
    reviseCore: { input: "任意", output: "永远拒绝", sideEffect: "无" },
    setFast: { input: "key,value,ttl", output: "短期状态", sideEffect: "写 fast" },
    contextFor: { input: "scope context", output: "可见认识与自我", sideEffect: "只读" },
    beliefs: { input: "无", output: "认识副本列表", sideEffect: "只读" },
    identity: { input: "无", output: "core/slow/fast 分层自我", sideEffect: "只读" },
    health: { input: "无", output: "健康状态", sideEffect: "只读" },
  } },
  api: { continuity: { upsert, revise, contest, ingestDigest, reviseSlow, reviseCore, setFast, contextFor, health, beliefs: () => beliefs().items.map((b) => Object.assign({}, b)), identity } },
  init(ctx) { _ctx = ctx; ingestAll(); },
  hooks: { timer(p) { const now = p && p.now || Date.now(); if (now - _lastIngest < 10 * 60000) return; _lastIngest = now; ingestAll(); } },
  contextProvider(p) { try { return contextFor(p || {}); } catch (e) { return ""; } },
  commands: [{ key: "/认识", regex: /^\/认识$/, handler(msg) {
    if (!_ctx.isMaster(msg.userId)) return "（认识修订记录只有主人能看哦～）";
    const rows = beliefs().items.filter((b) => b.scope === "user:" + msg.userId || b.scope === "local").slice(-8);
    if (!rows.length) return "现在还没有形成带 stable 证据的认识。";
    return "当前认识（含状态）：\n" + rows.map((b) => `· [${b.status}/${b.confidence.toFixed(2)}] ${b.statement}`).join("\n");
  } }],
  __test: { upsert, revise, contest, ingestDigest, reviseSlow, reviseCore, setFast, contextFor, beliefs, identity, health, scopesFor, CORE },
};
