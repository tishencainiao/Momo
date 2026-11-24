/* 框架服务 · 自主等级与硬边界（v3.0.0）
 * 0=暂停自主行动；1=只产提案；2=低风险自动。
 * 核心、权限、凭据、回滚、验收与本服务永远不属于 Momo 可自改目标。 */
"use strict";
const fs = require("fs");
const path = require("path");
let _ctx = null;
const FILE = () => path.join(_ctx.DATA_DIR, "autonomy.json");
let _degraded = "";
const CORE_TARGETS = new Set(["index.js", "plugin-host.js", "autonomy-service.js", "config.json", "package.json", "v3.0.0-master-plan.md"]);
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    const level = Number(d && d.level);
    if (![0, 1, 2].includes(level)) throw new Error("自主等级非法");
    _degraded = "";
    return { level, updated_at: Number(d.updated_at) || 0, updated_by: d.updated_by || "master" };
  } catch (e) {
    if (e.code !== "ENOENT") _degraded = "自主策略不可读：" + String(e.message).slice(0, 80);
    return { level: e.code === "ENOENT" ? 2 : 1, updated_at: 0, updated_by: "default" };
  }
}
function save(st) {
  try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); _ctx.writeJsonAtomic(FILE(), st); _degraded = ""; return true; }
  catch (e) { _degraded = "自主策略写入失败：" + String(e.message).slice(0, 80); return false; }
}
function baseName(t) { return path.basename(String(t || "")).replace(/\\/g, "/"); }
function targetAllowed(target) {
  const raw = String(target || "").trim();
  const b = baseName(raw);
  /* 只接受插件目录内的纯文件名；basename 后再检查会误接受 ../self-x.js。 */
  if (!raw || raw !== b || /[\\/]/.test(raw) || raw.includes("..")) return false;
  if (!b || CORE_TARGETS.has(b)) return false;
  return /^self-[a-z0-9-]{1,30}\.js$/.test(b);
}
function healthForAuto() {
  try {
    const h = _ctx.getApi("health");
    if (!h || !h.snapshot) return { ok: false, reason: "health_unavailable" };
    const rows = h.snapshot();
    const bad = rows.filter((s) => ["startupRecovery", "conversation", "perception", "ledger"].includes(s.name) && s.status !== "fresh");
    return bad.length ? { ok: false, reason: "health_" + bad[0].name + "_" + bad[0].status } : { ok: true };
  } catch (e) { return { ok: false, reason: "health_error" }; }
}
function authorize(spec) {
  const s = spec || {};
  const level = load().level;
  const kind = String(s.kind || "action");
  const caps = Array.isArray(s.caps) ? s.caps.filter(Boolean) : [];
  const core = kind === "selfmod" && s.target && !targetAllowed(s.target);
  if (core) return { allowed: false, requiresApproval: false, level, risk: "forbidden", reason: "core_or_policy_forbidden" };
  const high = s.risk === "high" || caps.length > 0 || kind === "permission_change" || kind === "credential_change";
  if (level === 0) return { allowed: false, requiresApproval: false, level, risk: high ? "high" : "low", reason: "autonomy_paused" };
  if (kind === "selfmod") {
    if (level === 1 || high) return { allowed: false, requiresApproval: true, level, risk: high ? "high" : "low", reason: high ? "high_risk_approval" : "proposal_only" };
    const v = s.validation || {};
    if (!(v.static_ok === true && v.sandbox_ok === true)) return { allowed: false, requiresApproval: true, level, risk: "low", reason: "validation_insufficient" };
    const hg = healthForAuto();
    if (!hg.ok) return { allowed: false, requiresApproval: true, level, risk: "low", reason: hg.reason };
    return { allowed: true, requiresApproval: false, level, risk: "low", reason: "low_risk_validated" };
  }
  if (level < 2) return { allowed: false, requiresApproval: false, level, risk: high ? "high" : "low", reason: "proposal_only" };
  if (high) return { allowed: false, requiresApproval: true, level, risk: "high", reason: "high_risk_approval" };
  return { allowed: true, requiresApproval: false, level, risk: "low", reason: "low_risk_allowed" };
}
function setLevel(requesterId, level) {
  const n = Number(level);
  if (!_ctx.isMaster(Number(requesterId) || 0)) return { ok: false, reason: "master_only", state: load() };
  if (![0, 1, 2].includes(n)) return { ok: false, reason: "invalid_level", state: load() };
  const st = { level: n, updated_at: Date.now(), updated_by: Number(requesterId) };
  if (!save(st)) return { ok: false, reason: "write_failed", state: load() };
  return { ok: true, state: st };
}
function status() { const st = load(); return Object.assign({}, st, { degraded: _degraded, core_targets: Array.from(CORE_TARGETS) }); }
module.exports = {
  name: "autonomy", displayName: "自主等级", description: "低风险可自主，高风险审批；核心/权限/验收不可自改", system: true, userScoped: false, requires: [], version: "1.0.0",
  apiSpec: { autonomy: {
    authorize: { input: "kind,risk,caps,target,validation", output: "自动/审批/拒绝", sideEffect: "只读决策" },
    setLevel: { input: "master userId,0/1/2", output: "新等级", sideEffect: "主人写自主等级" },
    status: { input: "无", output: "当前等级与降级", sideEffect: "只读" },
    targetAllowed: { input: "target", output: "是否 self-* 非核心", sideEffect: "只读" },
    healthForAuto: { input: "无", output: "自动行动健康门", sideEffect: "只读" },
  } },
  api: { autonomy: { authorize, setLevel, status, targetAllowed, healthForAuto } },
  init(ctx) { _ctx = ctx; load(); },
  commands: [{ key: "/自主", regex: /^\/自主(?:\s+([012]))?$/, handler(msg) {
    const text = String(msg.text || "").trim();
    const m = text.match(/^\/自主(?:\s+([012]))?$/);
    if (!_ctx.isMaster(msg.userId)) return "（自主等级只有主人能调整哦～）";
    if (m && m[1] !== undefined) {
      const r = setLevel(msg.userId, Number(m[1]));
      return r.ok ? `自主等级已设为 ${r.state.level}。0=暂停，1=只产提案，2=低风险自动。` : `调整失败：${r.reason}`;
    }
    const st = status();
    return `当前自主等级：${st.level}\n0=暂停自主行动\n1=只产提案\n2=低风险自动，高风险仍需批准${st.degraded ? "\n降级：" + st.degraded : ""}`;
  } }],
  __test: { load, save, authorize, setLevel, targetAllowed, healthForAuto, CORE_TARGETS },
};
