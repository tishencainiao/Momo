/* 框架服务 · 感知事件 perception：统一 PerceptionEvent 归一入口（v1.5.0 · WP1 作用域闭环 + WP2 消费完整性 + A02/A19 返修）。
 * source_type ∈ { user_report, system_observation, tool_result, model_inference }。
 * 统一作用域规则（v2.0.0 口径）：
 *   - 私聊消息 → actor user:<qq> / privacy user:<qq>（仅同用户 private/proactive 可见）
 *   - 群消息   → actor user:<qq> / privacy group:<groupId>（仅同群可见；缺 groupId 直接拒绝）
 *   - 工具结果 → 私聊 user:<qq> / 群 group:<groupId> / 桌宠 local（不得把群工具结果当私聊事实）
 *   - 身体与本机观察 → local（仅桌宠与主人私聊可见；不再默认 system 全局公开）
 *   - system_public → 确需全局公开的非敏感系统事件专用，必须显式声明，不与身体事件混用
 *   - 缺少有效作用域的新事件一律拒绝（return null），绝不默认成 system
 *   - 群上下文缺 groupId：visibleScopes 返回空作用域（失败关闭，不注入任何事件，A02）
 *   - 旧数据：读取时先从 payload 推导（userId/groupId/source_type 可靠证据），无法推导的标
 *     legacy_unscoped —— 仅主人 /感知 全局视图可见（带标记），禁止注入任何上下文。
 * 真实性口径：user_report 一律 verification:"reported"（只能证明「对方说过」，不证明内容真实）；
 *   system_observation 是本地传感器直读 → verified；tool_result 成败按工具自身返回 self_reported/failed。
 * 消费完整性（WP2+A19）：tail 只消费到最后一个完整换行；末尾半行保留到下轮（offset 不推进）；
 *   完整但非法的 JSON 行计数跳过（不重试）并经 health 上报；每事件带稳定 event_id + observed_at，
 *   可选 valid_until；过期只标 stale 不删除历史。
 *   事件成功落盘后才提交 offset/seen；写入失败抛出并反映到 health()，恢复后靠 event_id 去重恰好补回一次。
 * 已接线生产者：user_report ← messages.jsonl、tool_result ← tool-outcomes.jsonl、system_observation ← body-events.jsonl。
 * 未接线（诚实声明）：model_inference —— 模型推理事件暂未产生统一事件，schema 已预留。 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let _ctx = null;
let _dir = "";
const EVENTS_FILE = () => path.join(_dir, "perception-events.jsonl");
const STATE_FILE = () => path.join(_dir, "perception-state.json");
const MAX_BYTES = 256 * 1024, KEEP_LINES = 300;
const TAIL_EVERY_MS = 30000;
const SEEN_CAP = 800;                  // 每源文件行哈希防重上限
let _lastTail = 0;
/* WP4：健康信号——供 health-service 探活（进程活着 ≠ 感知在消费） */
const _health = { lastOkAt: 0, lastErrAt: 0, lastError: "" };

/* 各来源事件的「新鲜」窗口：过期标 stale（避免拿昨天的事当现在的事实） */
const STALE_MS = { user_report: 10 * 60000, tool_result: 10 * 60000, system_observation: 2 * 60000, model_inference: 30 * 60000 };
const SOURCE_TYPES = new Set(["user_report", "system_observation", "tool_result", "model_inference"]);
const LEGACY_UNSCOPED = "legacy_unscoped";

function sha16(s) { try { return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16); } catch (e) { return "h" + Date.now().toString(36); } }

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")); } catch (e) { return { offsets: {}, seen: {} }; } }
/* A19：状态写入失败必须抛出（不能静默吞掉），让消费位置停留在上一轮成功点 */
function saveState(st) {
  try {
    fs.mkdirSync(_dir, { recursive: true });
    _ctx.writeJsonAtomic(STATE_FILE(), st);
  } catch (e) {
    throw new Error("感知状态写入失败: " + String((e && e.message) || e).slice(0, 60));
  }
}

/* A19：事件写入失败必须抛出；写入前按 event_id 对现有文件去重——
 * 恢复后重消费同一批源行时，已落盘的事件不会重复入盘（恰好一次）。 */
function appendEvents(list) {
  if (!list || !list.length) return;
  const existing = new Set();
  try {
    existing = new Set(
      fs.readFileSync(EVENTS_FILE(), "utf8").trim().split("\n").filter(Boolean).slice(-KEEP_LINES)
        .map((l) => { try { return JSON.parse(l).event_id; } catch (e) { return null; } }).filter(Boolean)
    );
  } catch (e) { /* 事件文件还不存在：无可去重对象 */ }
  const toWrite = list.filter((e) => !existing.has(e.event_id));
  if (!toWrite.length) return;
  try {
    fs.mkdirSync(_dir, { recursive: true });
    fs.appendFileSync(EVENTS_FILE(), toWrite.map((e) => JSON.stringify(e)).join("\n") + "\n");
  } catch (e) {
    throw new Error("感知事件写入失败: " + String((e && e.message) || e).slice(0, 60));
  }
  try {
    if (fs.statSync(EVENTS_FILE()).size > MAX_BYTES) {
      const keep = fs.readFileSync(EVENTS_FILE(), "utf8").trim().split("\n").slice(-KEEP_LINES).join("\n") + "\n";
      _ctx.writeFileAtomic(EVENTS_FILE(), keep);
    }
  } catch (e) {
    throw new Error("感知事件截断失败: " + String((e && e.message) || e).slice(0, 60));
  }
}

/* 归一入口：外部直接喂事件。缺少有效作用域的新事件一律拒绝（不落盘、不默认 system）。
 * event_id = 内容指纹（同一事件重复 observe 得到同一 id）；observed_at = 记录时刻；valid_until 可选。 */
function observe(sourceType, opts) {
  const o = opts || {};
  if (!SOURCE_TYPES.has(sourceType)) return null;
  const scope = deriveObserveScope(sourceType, o);
  if (!scope) return null;
  const ts = o.ts || Date.now();
  const observedAt = o.observed_at || Date.now();
  const e = {
    ts: ts,
    event_id: o.event_id || ("obs-" + sha16(ts + "|" + sourceType + "|" + (o.event_type || "raw") + "|" + JSON.stringify(o.payload || {}))),
    observed_at: observedAt,
    source_type: sourceType,
    source: String(o.source || sourceType),
    event_type: String(o.event_type || "raw"),
    verification: String(o.verification || "unverified"),
    actor_scope: scope.actor,
    privacy_scope: scope.privacy,
    payload: o.payload || {},
  };
  if (o.valid_until) e.valid_until = Number(o.valid_until);
  appendEvents([e]);
  return e;
}

/* 新事件的默认作用域推导；推导不出 → null（拒绝） */
function deriveObserveScope(sourceType, o) {
  const channel = o.channel || (o.payload && o.payload.channel);
  const userId = o.userId || (o.payload && o.payload.userId);
  const groupId = o.groupId || (o.payload && o.payload.groupId);
  const petMode = !!(o.petMode || (o.payload && o.payload.petMode));
  if (sourceType === "user_report") {
    if (!userId) return null;
    if (channel === "group") return groupId ? { actor: "user:" + userId, privacy: "group:" + groupId } : null;
    return { actor: "user:" + userId, privacy: "user:" + userId };
  }
  if (sourceType === "tool_result") {
    if (petMode) return { actor: "local", privacy: "local" };
    if (!userId) return null;
    if (channel === "group") return groupId ? { actor: "user:" + userId, privacy: "group:" + groupId } : null;
    return { actor: "user:" + userId, privacy: "user:" + userId };
  }
  if (sourceType === "system_observation") {
    if (o.public === true || o.privacy === "system_public") return { actor: "system", privacy: "system_public" };
    return { actor: "local", privacy: "local" };
  }
  if (sourceType === "model_inference") {
    return userId ? { actor: "user:" + userId, privacy: "user:" + userId } : null;
  }
  return null;
}

/* 当前对话作用域可见的 privacy_scope 集合。
 * isMaster（主人私聊）与 petMode（桌宠）可额外看见 local 本机观察；
 * 群聊只看本群 + system_public，不看任何人的私聊（包括发言者本人，防止在群里转述私聊内容）。 */
function visibleScopes(ctx, isMaster) {
  const c = ctx || {};
  if (c.channel === "group") {
    if (!c.groupId) return new Set();   // A02：群上下文缺群号 → 失败关闭，返回空作用域，绝不落入 user:<id>/local
    const set = new Set(["system_public", "group:" + c.groupId]);
    return set;
  }
  const set = new Set(["system_public"]);
  if (c.userId) set.add("user:" + c.userId);
  if (c.petMode || isMaster) set.add("local");
  return set;
}

/* 读取旧事件行的作用域：先认新字段，缺失时从 payload 推导；
 * 推导不出 → legacy_unscoped（只进主人全局视图，绝不进上下文）。 */
function deriveScope(e) {
  if (e && e.privacy_scope) return e.privacy_scope;
  const p = (e && e.payload) || {};
  const st = e && e.source_type;
  if (st === "system_observation") return "local";                    // 旧 system_observation 只由身体感官产生
  if (p.channel === "group" && p.groupId) return "group:" + p.groupId;
  if (p.userId) return "user:" + p.userId;
  if (st === "tool_result" && p.petMode) return "local";
  return LEGACY_UNSCOPED;
}

/* 最近事件（默认 20 条 / 2h 内）。stale 判定：先尊重 valid_until（显式失效时刻），再按来源默认窗口。
 * ctx = {userId, channel, groupId} 时按隐私作用域过滤（旧事件走 deriveScope，绝不默认 system）；
 * 不传 = 全局（仅主人命令用，legacy_unscoped 事件带 legacy 标记返回）。 */
function recentEvents(opts) {
  const o = opts || {};
  const limit = Number(o.limit) || 20;
  const maxAge = Number(o.maxAgeMs) || 2 * 3600e3;
  const types = o.sourceTypes || null;
  const now = Date.now();
  let lines = [];
  try {
    lines = fs.readFileSync(EVENTS_FILE(), "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) {}
  let scopes = null;
  if (o.userId || o.channel) scopes = visibleScopes({ userId: o.userId, channel: o.channel, groupId: o.groupId }, o.isMaster);
  return lines.filter((e) => !types || types.includes(e.source_type))
    .filter((e) => now - (e.ts || 0) < maxAge)
    .filter((e) => !scopes || scopes.has(deriveScope(e)))
    .slice(-limit)
    .map((e) => {
      const defaultWindow = STALE_MS[e.source_type] || 10 * 60000;
      const out = Object.assign({}, e, { stale: (e.valid_until && now > e.valid_until) || (now - (e.ts || 0) >= defaultWindow) });
      if (!scopes && deriveScope(e) === LEGACY_UNSCOPED) out.legacy = true;   // 仅全局视图标记
      return out;
    });
}

/* tail 消费：把既有 JSONL 流水转成归一感知事件。
 * WP2 消费完整性：
 *   - 只消费到最后一个完整换行符；末尾半行保留到下轮，offset 不推进；
 *   - 完整但非法的 JSON 行计数跳过（hash 仍入 seen，避免每轮重试；坏行数上报 tailAll 进 health），不影响后续完整行；
 *   - 防重 = 字节偏移（省重读）+ 行内容哈希（截断重建/同毫秒不同事件都不会误杀）；
 *   - 每事件 event_id = "<file>:<行哈希>"（同一原始行永远同一 id，不同内容不会撞 id）+ observed_at。 */
function consumeTail(file, mapper) {
  const st = loadState();
  const p = path.join(_dir, file);
  let text = "";
  try { text = fs.readFileSync(p, "utf8"); } catch (e) {
    if (e && e.code === "ENOENT") return;      // 源文件尚未生成：正常，不算故障
    throw e;                                   // 其他读取错误：上报（WP4 健康信号）
  }
  const lastNl = text.lastIndexOf("\n");
  const completeEnd = lastNl >= 0 ? lastNl + 1 : 0;      // 末尾半行（无换行）不消费
  let start = Number(st.offsets[file]) || 0;
  if (start > completeEnd) start = 0;                     // 截断重建：全量重读，靠哈希防重
  if (start >= completeEnd) {                             // 无新完整行（含纯半行）→ 不推进
    if (!st.offsets[file] && completeEnd > 0) { st.offsets[file] = completeEnd; saveState(st); }
    return;
  }
  const fresh = text.slice(start, completeEnd);
  const seen = new Set((st.seen && st.seen[file]) || []);
  const out = [];
  let bad = 0;                                     // 完整但非法的行计数（A19：解析故障进健康信号）
  for (const line of fresh.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let h = sha16(t);
    if (seen.has(h)) continue;
    seen.add(h);
    try {
      const o = JSON.parse(t);
      const e = mapper(o);
      if (e) {
        e.event_id = (e.event_id || "") || (file + ":" + h);
        e.observed_at = Date.now();
        if (e.valid_until === undefined && o.valid_until !== undefined) e.valid_until = Number(o.valid_until);
        out.push(e);
      }
    } catch (e) {
      /* 完整但非法的 JSON 行：计数跳过（hash 已入 seen 不重试），不影响后续完整行 */
      bad += 1;
    }
  }
  if (bad > 0) {
    try { _ctx.log("warn", "感知消费坏行 " + file + "：" + bad + " 条（完整但非法，已跳过不重试）"); } catch (e) {}
  }
  /* A19：先落事件（失败则抛出，状态不推进，下一轮重试）；事件成功落盘后才提交 offset/seen。
   * 状态提交失败同样抛出（事件已在盘上，下一轮重读靠 event_id 去重 → 恰好一次）。
   * 坏行不算失败（不阻止 offset/seen 提交），但通过返回值上报 tailAll 记入健康信号。 */
  appendEvents(out);
  let arr = Array.from(seen);
  if (arr.length > SEEN_CAP) arr = arr.slice(-SEEN_CAP);
  st.seen = st.seen || {};
  st.seen[file] = arr;
  st.offsets[file] = completeEnd;
  saveState(st);
  return { bad };
}

function mapperMessage(o) {
  if (!o || !o.userId) return null;
  const group = o.channel === "group";
  if (group && !o.groupId) return null;                            // 缺 groupId 的群消息拒绝，禁止生成 group:0
  const privacy = group ? ("group:" + o.groupId) : ("user:" + o.userId);
  return {
    ts: o.ts || Date.now(), source_type: "user_report", source: "messages.jsonl", event_type: "message",
    verification: "reported",                                      // 只能证明「对方说过」，不证明内容真实
    actor_scope: "user:" + o.userId, privacy_scope: privacy,
    payload: { userId: o.userId, channel: o.channel || "private", groupId: group ? Number(o.groupId) : undefined, text: String(o.text || "").slice(0, 120) },
    _src: "messages.jsonl",
  };
}
function mapperTool(o) {
  if (!o || !o.tool) return null;
  const group = o.channel === "group";
  if (group && !o.groupId) return null;
  let actor = "system", privacy = LEGACY_UNSCOPED;
  if (o.petMode) { actor = "local"; privacy = "local"; }
  else if (o.userId) { actor = "user:" + o.userId; privacy = group ? ("group:" + o.groupId) : ("user:" + o.userId); }
  else return null;                                                // 无主工具结果拒绝，不默认 system
  return {
    ts: o.ts || Date.now(), source_type: "tool_result", source: "tool-outcomes.jsonl", event_type: "tool",
    verification: o.status === "succeeded" ? "self_reported" : (o.status === "failed" ? "failed" : "unverified"),
    actor_scope: actor, privacy_scope: privacy,
    payload: { tool: o.tool, status: o.status || "unknown", summary: String(o.summary || "").slice(0, 80), userId: o.userId, channel: o.channel, groupId: group ? Number(o.groupId) : undefined, petMode: !!o.petMode, action_key: o.action_key || null, verification_event_id: o.verification_event_id || null },
    _src: "tool-outcomes.jsonl",
  };
}
function mapperBody(o) {
  if (!o || !o.event) return null;
  return {
    ts: o.ts || Date.now(), source_type: "system_observation", source: "body-events.jsonl", event_type: String(o.event),
    verification: "verified",                                      // 本地传感器直读的环境事实
    actor_scope: "local", privacy_scope: "local",                  // 本机观察：仅桌宠与主人私聊可见
    payload: { app: o.app || "", pid: Number(o.pid) || 0, presence: o.presence || undefined, idle_s: o.idle_s, locked: o.locked, files: o.files, state: o.state, anim: o.anim, file: o.file, detail: o.detail, action: o.action },
    _src: "body-events.jsonl",
  };
}

function tailAll() {
  let errAll = "";
  const bads = [];
  for (const [f, m] of [["messages.jsonl", mapperMessage], ["tool-outcomes.jsonl", mapperTool], ["body-events.jsonl", mapperBody]]) {
    let r = null;
    try { r = consumeTail(f, m); }
    catch (e) { errAll = errAll || String((e && e.message) || e).slice(0, 80); }
    if (r && r.bad > 0) bads.push(f + " " + r.bad + " 条坏行");
  }
  if (errAll) { _health.lastErrAt = Date.now(); _health.lastError = errAll; }
  else if (bads.length) {
    /* A19：解析故障也要进健康信号——运行本身成功（lastOkAt 推进），坏行单独记 lastError（不含消息正文）。
     * classify 语义：ok/err 双 fresh → degraded（降级可观测），ttl 过后自动恢复 fresh。 */
    _health.lastOkAt = Date.now();
    _health.lastErrAt = Date.now();
    _health.lastError = ("感知解析失败：" + bads.join("；") + "（已跳过，不重试）").slice(0, 80);
  }
  else { _health.lastOkAt = Date.now(); }
}

module.exports = {
  name: "perception",
  displayName: "感知事件",
  description: "统一感知事件流（user_report/system_observation/tool_result 已接线；model_inference 仅声明未接线）；v1.5.1 作用域闭环+消费完整性+健康信号（WP1/WP2/WP4+A02/A19，解析故障进健康信号）",
  system: true,
  userScoped: false,   // 纯系统级：只读汇聚，不按人处理数据/发消息
  requires: [],
  version: "1.5.0",
  apiSpec: {
    perception: {
      observe: { input: "来源类型+负载", output: "归一事件", sideEffect: "落盘" },
      recentEvents: { input: "过滤条件（含作用域）", output: "带 stale 标记的事件", sideEffect: "只读" },
      health: { input: "无", output: "{lastOkAt,lastErrAt,lastError}", sideEffect: "只读" },
    },
  },
  api: {
    perception: {
      observe: (sourceType, opts) => observe(sourceType, opts),
      recentEvents: (opts) => recentEvents(opts),
      health: () => Object.assign({}, _health),
    },
  },
  init(ctx) {
    _ctx = ctx;
    _dir = ctx.DATA_DIR;
    fs.mkdirSync(_dir, { recursive: true });
    /* 重新加载时健康信号从零基线开始（避免旧进程的故障残留） */
    _health.lastOkAt = 0; _health.lastErrAt = 0; _health.lastError = "";
    tailAll();                       // 首跑：把已有流水补成事件
  },
  commands: [{
    key: "/感知",
    regex: /^\/感知/,
    handler(msg) {
      if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "（感知记录只有主人能看哦）"); return; }
      const evs = recentEvents({ limit: 10, maxAgeMs: 24 * 3600e3 });   // 主人 = 全局视图
      if (!evs.length) { _ctx.sendPrivate(msg.userId, "最近没有感知事件哦"); return; }
      const fmt = (e) => {
        const t = new Date(e.ts);
        const hh = String(t.getHours()).padStart(2, "0"), mm = String(t.getMinutes()).padStart(2, "0");
        let body = "";
        if (e.source_type === "user_report") body = (e.payload.channel === "group" ? "群" + e.payload.groupId + " " : "") + "报告：" + e.payload.text;
        else if (e.source_type === "tool_result") body = "工具 " + e.payload.tool + "：" + e.payload.status;
        else if (e.source_type === "system_observation") body = "身体感官：" + e.event_type + (e.payload.app ? "（" + e.payload.app + "）" : "");
        else body = e.event_type;
        const tag = e.legacy ? "【旧数据·未定域】" : "";
        return `${hh}:${mm} [${e.source_type}${e.stale ? "·过期" : ""}]${tag} ${body}`;
      };
      _ctx.sendPrivate(msg.userId, "最近感知：\n" + evs.map(fmt).join("\n"));
    },
  }],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (now - _lastTail < TAIL_EVERY_MS) return;
      _lastTail = now;
      tailAll();
    },
  },
  contextProvider(payload) {
    const p = payload || {};
    const isMaster = !!(p.petMode || (_ctx && _ctx.isMaster(p.userId)));
    const evs = recentEvents({ limit: 3, maxAgeMs: 3600e3, userId: p.userId, channel: p.channel, groupId: p.groupId, isMaster })
      .filter((e) => !e.stale);
    if (!evs.length) return "";
    const lines = evs.map((e) => {
      if (e.source_type === "user_report") return (e.payload.channel === "group" ? "群里有人报告「" + e.payload.text + "」" : "对方报告「" + e.payload.text + "」");
      if (e.source_type === "tool_result") return "刚用过工具 " + e.payload.tool + "（" + e.payload.status + "）";
      if (e.source_type === "system_observation") return "身体感官：" + e.event_type;
      return null;
    }).filter(Boolean);
    return lines.length ? "【感知】" + lines.join("；") : "";
  },
  __test: { observe, recentEvents, tailAll, consumeTail, mapperMessage, mapperTool, mapperBody, visibleScopes, deriveScope, deriveObserveScope, STALE_MS, SOURCE_TYPES, LEGACY_UNSCOPED, loadState, saveState, _health: () => Object.assign({}, _health) },
};
