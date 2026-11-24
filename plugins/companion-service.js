/* 框架服务 · 双端陪伴（v3.1.0）
 * 只连接主人 QQ 私聊与本机桌宠；群聊/访客没有主人共享空间。
 * 活动只有一份记录，乐观版本号防止旧写覆盖新写；本服务不直接发送消息或调用模型。 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let _ctx = null;
const FILE = () => path.join(_ctx.DATA_DIR, "companion-owner.json");
const TYPES = new Set(["story", "word_puzzle", "sudoku", "reading", "watchlist"]);
const SUDOKU_PUZZLE = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
const SUDOKU_SOLUTION = "534678912672195348198342567859761423426853791713924856961537284287419635345286179";
function blank() { return { version: 1, scope: "owner", conversations: [], activities: [], current_activity_id: "", do_not_mention: [], updated_at: 0 }; }
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    if (!d || d.scope !== "owner" || !Array.isArray(d.activities) || !Array.isArray(d.conversations)) throw new Error("结构异常");
    return Object.assign(blank(), d);
  } catch (e) { return blank(); }
}
function save(st) {
  fs.mkdirSync(_ctx.DATA_DIR, { recursive: true });
  st.conversations = (st.conversations || []).slice(-30);
  st.activities = (st.activities || []).slice(-20);
  st.do_not_mention = (st.do_not_mention || []).slice(-30);
  st.updated_at = Date.now();
  _ctx.writeJsonAtomic(FILE(), st);
}
function clean(s, n) { return String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n || 1000); }
function hash(s) { return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16); }
function channelOf(info) { const c = String(info && info.channel || "private"); return c === "pet" || c === "local" ? "pet" : c; }
function authorize(info) {
  const i = info || {}, uid = Number(i.userId) || 0, ch = channelOf(i);
  if (!uid || !_ctx.isMaster(uid)) return { ok: false, reason: "not_master" };
  if (!(ch === "private" || ch === "pet")) return { ok: false, reason: "channel_scope" };
  if (Number(i.groupId) || ch === "group") return { ok: false, reason: "group_isolated" };
  return { ok: true, userId: uid, channel: ch };
}
function activity(st, id) { return (st.activities || []).find((a) => a.activity_id === id) || null; }
function current(st) { return activity(st, st.current_activity_id); }
function publicActivity(a) {
  if (!a) return null;
  return { activity_id: a.activity_id, type: a.type, title: a.title, topic: a.topic, state: a.state, version: a.version,
    turn: a.turn, progress: a.progress, channel: a.channel, updated_at: a.updated_at, turns: (a.turns || []).slice(-12),
    board: a.type === "sudoku" ? a.board : undefined, };
}
function recordConversation(info, role, text, eventId, sourceTs) {
  const a = authorize(info); if (!a.ok) return a;
  const content = clean(text, 2000); if (!content) return { ok: false, reason: "empty" };
  const st = load();
  if (eventId && st.conversations.some((m) => m.event_id === eventId && m.channel === a.channel && m.role === (role === "assistant" ? "assistant" : "user"))) return { ok: true, duplicate: true };
  const ts = Number(sourceTs) || Date.now();
  if (sourceTs && st.conversations.some((m) => m.channel === a.channel && m.role === (role === "assistant" ? "assistant" : "user") && m.content === content && Number(m.ts) === ts)) return { ok: true, duplicate: true };
  const last = st.conversations[st.conversations.length - 1];
  if (last && last.channel === a.channel && last.role === (role === "assistant" ? "assistant" : "user") && last.content === content && Date.now() - Number(last.ts || 0) < 5000) return { ok: true, duplicate: true };
  st.conversations.push({ role: role === "assistant" ? "assistant" : "user", content, channel: a.channel, ts, event_id: clean(eventId, 100) || undefined });
  /* 工具推进后，模型的最终回复就是 Momo 的共同活动回合；会话成功落盘时同步交还轮次，避免卡在“等Momo”。 */
  if (role === "assistant") {
    const cur = current(st);
    if (cur && cur.state === "active" && cur.turn === "momo" && cur.channel === a.channel) {
      cur.turns = (cur.turns || []).concat([{ by: "momo", text: content, ts: Date.now() }]).slice(-30);
      if (cur.type !== "sudoku") cur.progress = (Number(cur.progress) || 0) + 1;
      cur.turn = "owner"; cur.version = (Number(cur.version) || 0) + 1; cur.updated_at = Date.now();
    }
  }
  save(st); return { ok: true };
}
function syncSessions() {
  const st = load(), dir = path.join(_ctx.DATA_DIR, "sessions");
  let added = 0;
  try {
    for (const file of fs.readdirSync(dir)) {
      const m = file.match(/^(pet)?(\d+)\.json$/); if (!m) continue;
      const uid = Number(m[2]); if (!_ctx.isMaster(uid)) continue;
      const channel = m[1] ? "pet" : "private";
      let doc = {}; try { doc = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch (e) { continue; }
      for (const msg of (doc.messages || []).slice(-40)) {
        if (!msg || !["user", "assistant"].includes(msg.role)) continue;
        const content = clean(msg.content, 2000); if (!content) continue;
        const eventId = clean(msg.event_id, 100) || undefined, ts = Number(msg.ts) || Number(doc.updated) || Date.now();
        if (eventId && st.conversations.some((x) => x.channel === channel && x.role === msg.role && x.event_id === eventId)) continue;
        if (st.conversations.some((x) => x.channel === channel && x.role === msg.role && x.content === content && Number(x.ts) === ts)) continue;
        st.conversations.push({ role: msg.role, content, channel, ts, event_id: eventId }); added++;
      }
    }
    if (added) { st.conversations.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)); save(st); }
    return { ok: true, added };
  } catch (e) { return { ok: false, added, reason: "sync_failed" }; }
}
function sharedContext(info, limit) {
  const a = authorize(info); if (!a.ok) return "";
  const st = load(), n = Math.max(2, Math.min(12, Number(limit) || 6));
  const lines = st.conversations.slice(-n).map((m) => `${m.channel === "pet" ? "桌宠" : "QQ"}·${m.role === "assistant" ? "Momo" : "主人"}：${m.content}`);
  const cur = current(st);
  if (cur) {
    lines.push(`共同活动：${cur.title}（${cur.state}，轮到${cur.turn === "owner" ? "主人" : "Momo"}，进度${cur.progress}）`);
    if (cur.type === "sudoku" && cur.board) lines.push("数独棋盘（0为空，按9个一行）：\n" + cur.board.match(/.{9}/g).join("\n"));
  }
  if (st.do_not_mention.length) lines.push("主人要求不再提起：" + st.do_not_mention.map((x) => x.topic).join("；"));
  return lines.join("\n");
}
function start(info, spec) {
  const a = authorize(info); if (!a.ok) return a;
  const s = spec || {}, type = TYPES.has(s.type) ? s.type : "story", topic = clean(s.topic || s.title, 120);
  const title = clean(s.title, 120) || ({ story: "轮流编故事", word_puzzle: "文字解谜", sudoku: "共同数独", reading: "共同阅读", watchlist: "共同观看清单" }[type]);
  const st = load(), now = Date.now();
  const rec = { activity_id: "act-" + hash(a.userId + "|" + now + "|" + Math.random()), type, title, topic, state: "active", version: 1,
    turn: "owner", progress: 0, channel: a.channel, created_at: now, updated_at: now, turns: [] };
  if (topic) rec.turns.push({ by: "system", text: "主题：" + topic, ts: now });
  if (type === "sudoku") { rec.board = SUDOKU_PUZZLE; rec.turns.push({ by: "system", text: "数独落子格式：行、列、数字（例如 1,3,4）", ts: now }); }
  st.activities.push(rec); st.current_activity_id = rec.activity_id;
  try { save(st); return { ok: true, activity: publicActivity(rec) }; } catch (e) { return { ok: false, reason: "write_failed" }; }
}
function mutate(info, id, expectedVersion, fn) {
  const a = authorize(info); if (!a.ok) return a;
  const st = load(), rec = activity(st, id || st.current_activity_id);
  if (!rec) return { ok: false, reason: "not_found" };
  if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== Number(rec.version)) return { ok: false, reason: "version_conflict", activity: publicActivity(rec) };
  const err = fn(rec, st);
  if (err) return { ok: false, reason: err, activity: publicActivity(rec) };
  rec.version = (Number(rec.version) || 0) + 1; rec.updated_at = Date.now(); rec.channel = a.channel;
  try { save(st); return { ok: true, activity: publicActivity(rec) }; } catch (e) { return { ok: false, reason: "write_failed" }; }
}
function sudokuMove(rec, input) {
  const m = String(input || "").trim().match(/^(\d)\D*(\d)\D*(\d)$/);
  if (!m) return "sudoku_format";
  const row = Number(m[1]), col = Number(m[2]), val = Number(m[3]);
  if (row < 1 || row > 9 || col < 1 || col > 9 || val < 1 || val > 9) return "sudoku_range";
  const at = (row - 1) * 9 + col - 1;
  if (SUDOKU_PUZZLE[at] !== "0") return "sudoku_given";
  if (rec.board[at] !== "0") return "sudoku_occupied";
  if (SUDOKU_SOLUTION[at] !== String(val)) return "sudoku_wrong";
  rec.board = rec.board.slice(0, at) + String(val) + rec.board.slice(at + 1);
  rec.turns = (rec.turns || []).concat([{ by: "owner", text: `第${row}行第${col}列填${val}`, ts: Date.now() }]).slice(-30);
  rec.progress = (rec.board.match(/[1-9]/g) || []).length - (SUDOKU_PUZZLE.match(/[1-9]/g) || []).length;
  if (!rec.board.includes("0")) { rec.state = "ended"; rec.turn = "none"; }
  else rec.turn = "momo";
  return "";
}
function advance(info, id, expectedVersion, input) {
  return mutate(info, id, expectedVersion, (rec, st) => {
    if (rec.state !== "active") return "not_active";
    if (rec.turn !== "owner") return "not_owner_turn";
    const text = clean(input, 2000); if (!text) return "empty";
    if (rec.type === "sudoku") return sudokuMove(rec, text);
    rec.turns = (rec.turns || []).concat([{ by: "owner", text, ts: Date.now(), channel: authorize(info).channel }]).slice(-30);
    rec.progress = (Number(rec.progress) || 0) + 1; rec.turn = "momo"; st.current_activity_id = rec.activity_id;
    return "";
  });
}
function completeTurn(info, id, expectedVersion, output) {
  return mutate(info, id, expectedVersion, (rec) => {
    if (rec.state !== "active" || rec.turn !== "momo") return "not_momo_turn";
    const text = clean(output, 2000); if (!text) return "empty";
    rec.turns = (rec.turns || []).concat([{ by: "momo", text, ts: Date.now() }]).slice(-30);
    if (rec.type !== "sudoku") rec.progress = (Number(rec.progress) || 0) + 1;
    rec.turn = "owner";
    return "";
  });
}
function setState(info, id, expectedVersion, state) {
  return mutate(info, id, expectedVersion, (rec) => {
    if (!["active", "paused", "ended"].includes(state)) return "invalid_state";
    if (state === "active" && rec.state === "ended") return "ended_immutable";
    rec.state = state;
    if (state === "ended") rec.turn = "none";
    return "";
  });
}
function changeTheme(info, id, expectedVersion, topic) {
  return mutate(info, id, expectedVersion, (rec) => {
    if (rec.state === "ended") return "ended_immutable";
    const t = clean(topic, 120); if (!t) return "empty";
    rec.topic = t; rec.turns = (rec.turns || []).concat([{ by: "system", text: "换主题：" + t, ts: Date.now() }]).slice(-30);
    rec.turn = "owner"; return "";
  });
}
function list(info) { const a = authorize(info); if (!a.ok) return a; const st = load(); return { ok: true, current_activity_id: st.current_activity_id, activities: st.activities.map(publicActivity) }; }
function dontMention(info, topic) {
  const a = authorize(info); if (!a.ok) return a; const t = clean(topic, 120); if (!t) return { ok: false, reason: "empty" };
  const st = load(); if (!st.do_not_mention.some((x) => x.topic === t)) st.do_not_mention.push({ topic: t, ts: Date.now() });
  save(st); return { ok: true };
}
function chooseRoute(info, desktop) {
  const a = authorize(info); if (!a.ok) return a;
  const d = desktop || {};
  if (d.locked || d.dnd) return { ok: true, channel: "private", fallback: false, reason: d.locked ? "locked" : "dnd" };
  const usable = d.visible !== false && d.connected === true && (d.presence === "active" || d.presence === "unknown");
  return { ok: true, channel: usable ? "pet" : "private", fallback: false, reason: usable ? "desktop_available" : "desktop_unavailable" };
}
function intentOf(text) {
  const t = String(text || "").trim();
  if (/一起玩|编故事|解谜|数独|共同阅读|一起看|接着玩|继续玩/.test(t)) return "play";
  if (/安静|别说话|陪我待会|不用回|不用说话/.test(t)) return "quiet";
  if (/怎么办|怎么做|帮我|报错|问题|解决|查一下|分析一下/.test(t)) return "solve";
  if (/难过|委屈|焦虑|累|烦|不开心|失眠|压力/.test(t)) return "listen";
  return "chat";
}
function promptFor(info) {
  const a = authorize(info); if (!a.ok) return "";
  const ctx = sharedContext(info, 6), cur = current(load());
  return `【小屋里】当前是${a.channel === "pet" ? "桌宠" : "主人 QQ 私聊"}。围绕真实共同经历自然交流，不查户口，不连续追问；对方想安静就短回应，不制造回复义务。回复只回当前渠道。另一端的“主人”原话就是已发生事实；回答近期经历时先依据这些原话，不得与猜测混为一谈，不知道就直说，不能凭空猜成相反答案。\n${ctx}${cur ? `\n当前活动 ${cur.activity_id} v${cur.version}：${cur.title}/${cur.state}，轮到${cur.turn}。` : ""}`;
}
function formatActivity(r) {
  if (!r || !r.ok) {
    const reason = String(r && r.reason || "未知");
    const msg = { sudoku_format: "数独落子请写：行、列、数字，例如 1,3,4", sudoku_given: "这个格子是题目给定的，不能改", sudoku_occupied: "这个格子已经填过了", sudoku_wrong: "这个数字与这局解不一致，未推进", version_conflict: "另一端已经先推进了，请按最新版本继续" }[reason];
    return "（没能打开共同活动：" + (msg || reason) + "）";
  }
  const a = r.activity; return `【${a.title}】${a.state === "active" ? "进行中" : a.state === "paused" ? "已暂停" : "已结束"}\n活动 ${a.activity_id} · v${a.version} · 进度 ${a.progress}\n${a.type === "sudoku" && a.board ? "棋盘（0为空）：\n" + a.board.match(/.{9}/g).join("\n") + "\n" : ""}${a.turns.slice(-4).map((t) => `${t.by === "owner" ? "主人" : t.by === "momo" ? "Momo" : "提示"}：${t.text}`).join("\n") || "还没有内容"}\n轮到：${a.turn === "owner" ? "主人" : a.turn === "momo" ? "Momo" : "无"}`;
}
module.exports = {
  name: "companion-service", displayName: "框架服务 · 双端陪伴", version: "1.0.0",
  description: "主人双端共享上下文、共同活动状态机与主动单渠道路由。",
  requires: [], permissions: ["DATA_DIR", "isMaster", "writeJsonAtomic", "recordAction"], userScoped: true,
  init(ctx) { _ctx = ctx; try { syncSessions(); } catch (e) {} },
  api: { companion: { recordConversation, syncSessions, sharedContext, start, advance, completeTurn, setState, changeTheme, list, dontMention, chooseRoute, intentOf, promptFor } },
  apiSpec: { companion: {
    recordConversation: { input: "主人渠道信息,role,text,eventId,sourceTs", output: "写入/去重结果", sideEffect: "写主人共享空间" },
    syncSessions: { input: "无", output: "从主人会话恢复的条数", sideEffect: "幂等补写共享空间" },
    sharedContext: { input: "主人渠道信息,limit", output: "必要双端上下文", sideEffect: "只读" },
    start: { input: "主人渠道信息,活动规格", output: "统一活动记录", sideEffect: "写活动" },
    advance: { input: "主人渠道信息,id,version,input", output: "新活动版本/冲突", sideEffect: "乐观锁写活动" },
    completeTurn: { input: "主人渠道信息,id,version,output", output: "新活动版本", sideEffect: "写Momo回合" },
    setState: { input: "主人渠道信息,id,version,state", output: "活动状态", sideEffect: "暂停/续接/结束" },
    changeTheme: { input: "主人渠道信息,id,version,topic", output: "新活动版本", sideEffect: "写主题" },
    list: { input: "主人渠道信息", output: "活动列表", sideEffect: "只读" },
    dontMention: { input: "主人渠道信息,topic", output: "边界保存结果", sideEffect: "写不再提起" },
    chooseRoute: { input: "主人渠道信息,桌面瞬时状态", output: "唯一渠道且无fallback", sideEffect: "只读" },
    intentOf: { input: "用户文本", output: "chat/listen/quiet/play/solve", sideEffect: "只读" },
    promptFor: { input: "主人渠道信息", output: "陪伴与共享上下文提示", sideEffect: "只读" },
  } },
  tools: [{ def: { type: "function", function: { name: "momo_together", description: "主人想一起玩、编故事、文字解谜、共同阅读/观看、暂停或继续共同活动时使用。只用于主人私聊或桌宠。",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["start", "advance", "pause", "resume", "theme", "end", "list"] }, type: { type: "string", enum: ["story", "word_puzzle", "sudoku", "reading", "watchlist"] }, activity_id: { type: "string" }, version: { type: "number" }, topic: { type: "string" }, input: { type: "string" } }, required: ["action"] } } },
    async handler(args, info) {
      const x = args || {}, id = x.activity_id, v = x.version; let r;
      if (x.action === "start") r = start(info, x);
      else if (x.action === "advance") r = advance(info, id, v, x.input || x.topic);
      else if (x.action === "pause" || x.action === "resume" || x.action === "end") r = setState(info, id, v, x.action === "pause" ? "paused" : x.action === "resume" ? "active" : "ended");
      else if (x.action === "theme") r = changeTheme(info, id, v, x.topic);
      else if (x.action === "list") { r = list(info); return r.ok ? (r.activities.length ? r.activities.map((a) => `${a.activity_id} ${a.title} ${a.state} v${a.version}`).join("\n") : "我们还没有共同活动，想玩什么？") : "（现在打不开共同活动）"; }
      else r = { ok: false, reason: "invalid_action" };
      return formatActivity(r);
    } }],
  __test: { blank, intentOf, clean },
};
