/* 框架服务 · 感知事件 perception（阶段1 轻量首片）：统一 PerceptionEvent 归一入口。
 * source_type ∈ { user_report, system_observation, tool_result, model_inference }。
 * 隐私隔离：每个事件带 actor_scope（谁产生的）+ privacy_scope（谁可见）：
 *   - 私聊消息 → user:<qq>；群消息 → group:<groupId>；工具结果 → user:<qq>（无主则 system）；身体感官 → system（环境事实，全局可见）。
 *   - contextProvider 按当前对话作用域过滤（私聊只看自己+system；群聊只看本群+本人+system），/感知 主人可看全局。
 * 真实性口径：user_report 一律 verification:"reported"（只能证明「对方说过」，不证明内容真实）；
 *   system_observation 是本地传感器直读 → verified；tool_result 成败按工具自身返回 self_reported/failed。
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

/* 各来源事件的「新鲜」窗口：过期标 stale（避免拿昨天的事当现在的事实） */
const STALE_MS = { user_report: 10 * 60000, tool_result: 10 * 60000, system_observation: 2 * 60000, model_inference: 30 * 60000 };
const SOURCE_TYPES = new Set(["user_report", "system_observation", "tool_result", "model_inference"]);

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")); } catch (e) { return { offsets: {}, seen: {} }; } }
function saveState(st) { try { fs.mkdirSync(_dir, { recursive: true }); _ctx.writeJsonAtomic(STATE_FILE(), st); } catch (e) {} }

function appendEvents(list) {
  if (!list || !list.length) return;
  try {
    fs.mkdirSync(_dir, { recursive: true });
    let buf = "";
    for (const e of list) buf += JSON.stringify(e) + "\n";
    fs.appendFileSync(EVENTS_FILE(), buf);
    try {
      if (fs.statSync(EVENTS_FILE()).size > MAX_BYTES) {
        const keep = fs.readFileSync(EVENTS_FILE(), "utf8").trim().split("\n").slice(-KEEP_LINES).join("\n") + "\n";
        _ctx.writeFileAtomic(EVENTS_FILE(), keep);
      }
    } catch (e) {}
  } catch (e) {}
}

/* 归一入口：外部直接喂事件。opts 需带 actor_scope/privacy_scope 或由默认规则推导 */
function observe(sourceType, opts) {
  const o = opts || {};
  if (!SOURCE_TYPES.has(sourceType)) return null;
  const e = {
    ts: o.ts || Date.now(),
    source_type: sourceType,
    source: String(o.source || sourceType),
    event_type: String(o.event_type || "raw"),
    verification: String(o.verification || "unverified"),
    actor_scope: String(o.actor_scope || "system"),
    privacy_scope: String(o.privacy_scope || "system"),
    payload: o.payload || {},
  };
  appendEvents([e]);
  return e;
}

/* 当前对话作用域可见的 privacy_scope 集合 */
function visibleScopes(ctx) {
  const c = ctx || {};
  const set = new Set(["system", "user:" + c.userId]);
  if (c.channel === "group" && c.groupId) set.add("group:" + c.groupId);
  return set;
}

/* 最近事件（默认 20 条 / 2h 内），过期标 stale=true。
 * ctx = {userId, channel, groupId} 时按隐私作用域过滤；不传 = 全局（仅主人命令用）。 */
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
  if (o.userId || o.channel) scopes = visibleScopes({ userId: o.userId, channel: o.channel, groupId: o.groupId });
  return lines.filter((e) => !types || types.includes(e.source_type))
    .filter((e) => now - (e.ts || 0) < maxAge)
    .filter((e) => !scopes || scopes.has(e.privacy_scope || "system"))
    .slice(-limit)
    .map((e) => Object.assign({}, e, { stale: now - (e.ts || 0) >= (STALE_MS[e.source_type] || 10 * 60000) }));
}

/* tail 消费：把既有 JSONL 流水转成归一感知事件。
 * 防重 = 字节偏移（省重读）+ 行内容哈希（截断重建/同毫秒不同事件都不会误杀）。 */
function consumeTail(file, mapper) {
  const st = loadState();
  const p = path.join(_dir, file);
  let text = "";
  try { text = fs.readFileSync(p, "utf8"); } catch (e) { return; }
  const offset = Number(st.offsets[file]) || 0;
  const seen = new Set((st.seen && st.seen[file]) || []);
  const freshText = text.length >= offset ? text.slice(offset) : text;
  const out = [];
  for (const line of freshText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let h = "";
    try { h = crypto.createHash("sha1").update(t).digest("hex").slice(0, 20); } catch (e) { h = t; }
    if (seen.has(h)) continue;
    seen.add(h);
    try {
      const o = JSON.parse(t);
      const e = mapper(o);
      if (e) out.push(e);
    } catch (e) {}
  }
  let arr = Array.from(seen);
  if (arr.length > SEEN_CAP) arr = arr.slice(-SEEN_CAP);
  st.seen = st.seen || {};
  st.seen[file] = arr;
  st.offsets[file] = text.length;
  saveState(st);
  appendEvents(out);
}

function mapperMessage(o) {
  if (!o || !o.userId) return null;
  const group = o.channel === "group";
  const scope = group ? ("group:" + (o.groupId || 0)) : ("user:" + o.userId);
  return {
    ts: o.ts || Date.now(), source_type: "user_report", source: "messages.jsonl", event_type: "message",
    verification: "reported",                                    // 只能证明「对方说过」，不证明内容真实
    actor_scope: scope, privacy_scope: scope,
    payload: { userId: o.userId, channel: o.channel || "private", groupId: group ? Number(o.groupId) || 0 : undefined, text: String(o.text || "").slice(0, 120) },
    _src: "messages.jsonl",
  };
}
function mapperTool(o) {
  if (!o || !o.tool) return null;
  const scope = o.userId ? ("user:" + o.userId) : "system";
  return {
    ts: o.ts || Date.now(), source_type: "tool_result", source: "tool-outcomes.jsonl", event_type: "tool",
    verification: o.status === "succeeded" ? "self_reported" : (o.status === "failed" ? "failed" : "unverified"),
    actor_scope: scope, privacy_scope: scope,
    payload: { tool: o.tool, status: o.status || "unknown", summary: String(o.summary || "").slice(0, 80), userId: o.userId, channel: o.channel, action_key: o.action_key || null, verification_event_id: o.verification_event_id || null },
    _src: "tool-outcomes.jsonl",
  };
}
function mapperBody(o) {
  if (!o || !o.event) return null;
  return {
    ts: o.ts || Date.now(), source_type: "system_observation", source: "body-events.jsonl", event_type: String(o.event),
    verification: "verified",                                    // 本地传感器直读的环境事实
    actor_scope: "system", privacy_scope: "system",              // 环境事实全局可见；不含 chat（对话内容不混入系统级事件）
    payload: { app: o.app || "", pid: Number(o.pid) || 0, presence: o.presence || undefined, idle_s: o.idle_s, locked: o.locked, files: o.files, state: o.state, anim: o.anim, file: o.file, detail: o.detail, action: o.action },
    _src: "body-events.jsonl",
  };
}

function tailAll() {
  consumeTail("messages.jsonl", mapperMessage);
  consumeTail("tool-outcomes.jsonl", mapperTool);
  consumeTail("body-events.jsonl", mapperBody);
}

module.exports = {
  name: "perception",
  displayName: "感知事件",
  description: "统一感知事件流（user_report/system_observation/tool_result 已接线；model_inference 仅声明未接线）",
  system: true,
  userScoped: false,   // 纯系统级：只读汇聚，不按人处理数据/发消息
  requires: [],
  version: "1.1.0",
  apiSpec: {
    perception: {
      observe: { input: "来源类型+负载", output: "归一事件", sideEffect: "落盘" },
      recentEvents: { input: "过滤条件（含作用域）", output: "带 stale 标记的事件", sideEffect: "只读" },
    },
  },
  api: {
    perception: {
      observe: (sourceType, opts) => observe(sourceType, opts),
      recentEvents: (opts) => recentEvents(opts),
    },
  },
  init(ctx) {
    _ctx = ctx;
    _dir = ctx.DATA_DIR;
    fs.mkdirSync(_dir, { recursive: true });
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
        return `${hh}:${mm} [${e.source_type}${e.stale ? "·过期" : ""}] ${body}`;
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
    const evs = recentEvents({ limit: 3, maxAgeMs: 3600e3, userId: p.userId, channel: p.channel, groupId: p.groupId })
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
  __test: { observe, recentEvents, tailAll, consumeTail, mapperMessage, mapperTool, mapperBody, visibleScopes, STALE_MS, SOURCE_TYPES, loadState, saveState },
};
