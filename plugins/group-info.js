/* 插件：群/用户信息（OneBot 扩展接口）—— 让 Momo 用上 NapCat 开放但之前没用的能力
 * 覆盖：get_group_info / get_group_member_list / get_group_honor_info / get_stranger_info
 *       set_msg_emoji_like（贴表情回应）/ send_group_forward_msg（合并转发）
 * 缓存：data/group-info.json，群信息 30 分钟、成员 10 分钟 */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const INFO_TTL = 30 * 60000;
const MEMBER_TTL = 10 * 60000;
const file = () => path.join(_ctx.DATA_DIR, "group-info.json");
function load() { try { const d = JSON.parse(fs.readFileSync(file(), "utf8")); return (d && typeof d === "object") ? d : {}; } catch (e) { return {}; } }
function save(d) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(file(), JSON.stringify(d)); } catch (e) {} }

/* ---------- 拉取 + 缓存 ---------- */
async function fetchGroupInfo(groupId, force) {
  const g = String(groupId || "");
  if (!g) return null;
  const all = load();
  const c = all[g] || {};
  if (!force && c.info && Date.now() - (c.infoTs || 0) < INFO_TTL) return c.info;
  try {
    const r = await _ctx.onebotSend("get_group_info", { group_id: Number(g) });
    const d = r && r.data ? r.data : r;
    if (!d || (!d.group_name && !d.group_id)) return c.info || null;
    const info = {
      group_id: Number(d.group_id || g),
      name: String(d.group_name || "").slice(0, 40),
      memberCount: Number(d.member_count || 0),
      maxMember: Number(d.max_member_count || 0),
    };
    all[g] = all[g] || {};
    all[g].info = info; all[g].infoTs = Date.now();
    save(all);
    return info;
  } catch (e) { _ctx.log("warn", "拿群信息失败: " + String(e.message).slice(0, 80)); return c.info || null; }
}

async function fetchMembers(groupId, force) {
  const g = String(groupId || "");
  if (!g) return [];
  const all = load();
  const c = all[g] || {};
  if (!force && Array.isArray(c.members) && Date.now() - (c.membersTs || 0) < MEMBER_TTL) return c.members;
  try {
    const r = await _ctx.onebotSend("get_group_member_list", { group_id: Number(g) });
    const arr = (r && r.data) ? r.data : (Array.isArray(r) ? r : []);
    const list = (arr || []).map((m) => ({
      userId: Number(m.user_id || 0),
      nickname: String(m.nickname || "").slice(0, 20),
      card: String(m.card || "").slice(0, 20),
      role: String(m.role || "member"),
    })).filter((m) => m.userId);
    all[g] = all[g] || {};
    all[g].members = list; all[g].membersTs = Date.now();
    save(all);
    return list;
  } catch (e) { _ctx.log("warn", "拿群成员失败: " + String(e.message).slice(0, 80)); return c.members || []; }
}

async function fetchHonor(groupId) {
  const g = String(groupId || "");
  if (!g) return [];
  try {
    const r = await _ctx.onebotSend("get_group_honor_info", { group_id: Number(g), type: "all" });
    const d = (r && r.data) ? r.data : {};
    const out = [];
    const push = (arr, label) => { for (const x of (arr || []).slice(0, 3)) out.push(`${label}：${x.nickname || x.user_id}（${x.description || ""}）`); };
    if (d.current_talkative) push([d.current_talkative], "龙王");
    if (Array.isArray(d.talkative_list)) push(d.talkative_list, "龙王");
    if (Array.isArray(d.performer_list)) push(d.performer_list, "群聊之火");
    if (Array.isArray(d.legend_list)) push(d.legend_list, "群聊炽焰");
    if (Array.isArray(d.emotion_list)) push(d.emotion_list, "快乐源泉");
    return out;
  } catch (e) { return []; }
}

async function fetchStranger(userId) {
  try {
    const r = await _ctx.onebotSend("get_stranger_info", { user_id: Number(userId) });
    const d = (r && r.data) ? r.data : r;
    if (!d || !d.user_id) return null;
    return { userId: Number(d.user_id), nickname: String(d.nickname || ""), sex: String(d.sex || ""), age: Number(d.age || 0) };
  } catch (e) { return null; }
}

/* ---------- 上下文注入 ---------- */
async function groupInfoCtx(groupId) {
  const info = await fetchGroupInfo(groupId);
  if (!info) return "";
  const parts = [`【当前群】「${info.name || info.group_id}」`];
  if (info.memberCount) parts.push(`${info.memberCount} 人`);
  const honor = await fetchHonor(groupId);
  if (honor.length) parts.push("荣誉：" + honor.slice(0, 3).join("；"));
  return parts.join("，");
}

/* ---------- 工具用文本 ---------- */
async function groupInfoText(groupId) {
  if (!groupId) return "（只有群里才能查群信息）";
  const info = await fetchGroupInfo(groupId, true);
  if (!info) return "（没拿到群信息）";
  const lines = [`群名：${info.name}`, `群号：${info.group_id}`];
  if (info.memberCount) lines.push(`人数：${info.memberCount}${info.maxMember ? "/" + info.maxMember : ""}`);
  return lines.join("\n");
}

async function membersText(groupId, limit) {
  if (!groupId) return "（只有群里才能看成员）";
  const list = await fetchMembers(groupId, true);
  if (!list.length) return "（没拿到成员列表）";
  const top = list.slice(0, limit || 20).map((m, i) => `${i + 1}. ${m.card || m.nickname}${m.role === "owner" ? "（群主）" : m.role === "admin" ? "（管理员）" : ""}`);
  return `群里共 ${list.length} 人：\n${top.join("\n")}${list.length > (limit || 20) ? "\n…" : ""}`;
}

async function honorText(groupId) {
  if (!groupId) return "（只有群里才能看群荣誉）";
  const h = await fetchHonor(groupId);
  return h.length ? "本群荣誉：\n" + h.slice(0, 8).map((x) => "- " + x).join("\n") : "（本群暂时没有荣誉数据）";
}

async function userText(userId) {
  const u = await fetchStranger(userId);
  if (!u) return "（没查到这个人）";
  return `${u.nickname}（QQ ${u.userId}）${u.sex ? "，" + u.sex : ""}${u.age ? "，" + u.age + " 岁" : ""}`;
}

/* ---------- 动作 ---------- */
const EMOJI_MAP = { "赞": "128077", "点赞": "128077", "👍": "128077", "笑": "128514", "笑哭": "128514", "心": "128149", "爱心": "128149", "强": "128077", "棒": "128077" };
async function emojiLike(messageId, emoji, by) {
  if (!messageId) return { ok: false, msg: "（没有消息 id）" };
  const e = String(emoji || "").trim();
  const id = /^\d+$/.test(e) ? e : (EMOJI_MAP[e] || "128077");
  try {
    await _ctx.onebotSend("set_msg_emoji_like", { message_id: messageId, emoji_id: id });
    try { _ctx.recordAction({ action: "emoji_like", by: Number(by) || 0, detail: `消息 ${messageId} 贴「${e || "赞"}」`, ok: true }); } catch (e2) {}
    return { ok: true, msg: `给这条消息贴了个「${e || "赞"}」` };
  } catch (err) { return { ok: false, msg: "（贴表情失败：" + String(err.message).slice(0, 60) + "）" }; }
}

async function forwardToGroup(groupId, paragraphs, name, by) {
  if (!groupId) return { ok: false, msg: "（只有群里能合并转发）" };
  const lines = (Array.isArray(paragraphs) ? paragraphs : String(paragraphs || "").split("\n")).map((s) => String(s || "").trim()).filter(Boolean);
  if (!lines.length) return { ok: false, msg: "（没有内容可转发）" };
  const nodes = lines.slice(0, 20).map((t) => ({ type: "node", data: { name: String(name || "Momo"), uin: String((_ctx.config.qq && _ctx.config.qq.self_id) || ""), content: [{ type: "text", data: { text: t } }] } }));
  try {
    await _ctx.onebotSend("send_group_forward_msg", { group_id: Number(groupId), messages: nodes });
    try { _ctx.recordAction({ action: "forward_msg", by: Number(by) || 0, groupId: Number(groupId) || 0, detail: `${lines.length} 段`, ok: true }); } catch (e2) {}
    return { ok: true, msg: "（已合并转发）" };
  } catch (e) { return { ok: false, msg: "（合并转发失败：" + String(e.message).slice(0, 60) + "）" }; }
}

/* ---------- 群文件（注意：SnowLuma 用 get_group_files_by_folder，不是 get_group_file_list） ---------- */
async function fetchGroupFiles(groupId, keyword) {
  if (!groupId) return { ok: false, msg: "（只有群里才能看群文件）", files: [] };
  try {
    const r = await _ctx.onebotSend("get_group_files_by_folder", { group_id: Number(groupId) });
    const d = (r && r.data) ? r.data : {};
    let files = Array.isArray(d.files) ? d.files : [];
    const k = String(keyword || "").trim();
    if (k) files = files.filter((f) => String(f.file_name || "").indexOf(k) >= 0);
    return { ok: true, files: files.map((f) => ({ name: String(f.file_name || ""), size: Number(f.file_size || 0) })) };
  } catch (e) { return { ok: false, msg: "（拿群文件失败：" + String(e.message).slice(0, 60) + "）", files: [] }; }
}
async function filesText(groupId, keyword) {
  const r = await fetchGroupFiles(groupId, keyword);
  if (!r.ok) return r.msg;
  if (!r.files.length) return keyword ? `（没找到名字含「${keyword}」的群文件）` : "（这个群还没有群文件）";
  const top = r.files.slice(0, 15).map((f, i) => `${i + 1}. ${f.name}（${(f.size / 1024).toFixed(0)}KB）`);
  return `群文件共 ${r.files.length} 个：\n${top.join("\n")}${r.files.length > 15 ? "\n…" : ""}`;
}

/* ---------- 按 id 查消息 ---------- */
async function fetchMsg(messageId) {
  if (!messageId) return null;
  try {
    const r = await _ctx.onebotSend("get_msg", { message_id: Number(messageId) || messageId });
    const d = (r && r.data) ? r.data : r;
    if (!d || !d.message_id) return null;
    const segs = Array.isArray(d.message) ? d.message : [];
    const text = segs.map((s) => {
      if (!s || !s.data) return "";
      if (s.type === "text") return s.data.text || "";
      if (s.type === "at") return "[@]";
      if (s.type === "image") return "[图片]";
      if (s.type === "face") return "[表情]";
      if (s.type === "record") return "[语音]";
      return "";
    }).join("").trim();
    return {
      messageId: String(d.message_id),
      userId: Number((d.sender && d.sender.user_id) || d.user_id || 0),
      nickname: String((d.sender && (d.sender.card || d.sender.nickname)) || ""),
      time: Number(d.time || 0),
      text: text.slice(0, 200),
    };
  } catch (e) { return null; }
}
async function msgText(messageId) {
  const m = await fetchMsg(messageId);
  if (!m) return "（没查到这条消息，可能 id 不对或太久了）";
  const t = m.time ? new Date(m.time * 1000).toLocaleString("zh-CN") : "";
  return `${m.nickname || m.userId}（${t}）：${m.text || "（非文本内容）"}`;
}

/* ---------- 改自己的资料（仅主人） ---------- */
async function setSelfProfile(nickname, note, by) {
  const body = {};
  if (nickname) body.nickname = String(nickname).slice(0, 20);
  if (note) body.personal_note = String(note).slice(0, 60);
  if (!Object.keys(body).length) return { ok: false, msg: "（没说要改什么）" };
  try {
    await _ctx.onebotSend("set_qq_profile", body);
    try { _ctx.recordAction({ action: "set_self_profile", by: Number(by) || 0, detail: body.nickname || body.personal_note, ok: true }); } catch (e2) {}
    return { ok: true, msg: `改好了：${Object.entries(body).map(([k, v]) => k + "=" + v).join("，")}` };
  } catch (e) { return { ok: false, msg: "（改资料失败：" + String(e.message).slice(0, 60) + "）" }; }
}

/* ---------- 群成员/群日志/跨窗口（从 index.js 迁入 M8） ---------- */
const groupMemFile = () => path.join(_ctx.DATA_DIR, "group-members.json");
function loadGroupMembers() { try { return JSON.parse(fs.readFileSync(groupMemFile(), "utf8")); } catch (e) { return {}; } }
function saveGroupMembers(m) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(groupMemFile(), JSON.stringify(m)); } catch (e) {} }
function rememberGroupMember(groupId, userId, name, extra) {
  const m = loadGroupMembers();
  const g = m[String(groupId)] = m[String(groupId)] || {};
  const e = g[String(userId)] = g[String(userId)] || { name: "", seen: 0 };
  if (name) e.name = String(name).slice(0, 20);
  e.seen = (e.seen || 0) + 1;
  e.lastSeen = Date.now();
  if (!e.firstSeen) e.firstSeen = Date.now();
  if (extra) {
    if (extra.images) e.images = (e.images || 0) + Number(extra.images);
    if (extra.ats) e.ats = (e.ats || 0) + Number(extra.ats);
    if (extra.role) e.role = String(extra.role).slice(0, 10);
  }
  saveGroupMembers(m);
}
/* 群内角色标签：按这个群的相对活跃度算，不是绝对值 */
function memberTags(g, uid) {
  const me = g[String(uid)] || {};
  const counts = Object.values(g).map((x) => x.seen || 0);
  const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  const tags = [];
  if (me.role === "owner") tags.push("群主");
  else if (me.role === "admin") tags.push("管理员");
  if ((me.seen || 0) >= Math.max(10, avg * 2)) tags.push("话痨");
  else if (avg > 0 && (me.seen || 0) < avg * 0.5) tags.push("潜水");
  if ((me.images || 0) >= 3 && (me.images || 0) / Math.max(1, me.seen || 1) >= 0.25) tags.push("爱发图");
  if ((me.ats || 0) >= 3) tags.push("爱@人");
  return tags;
}
function groupMemberCtx(groupId, userId) {
  const m = loadGroupMembers();
  const g = m[String(groupId)] || {};
  const e = g[String(userId)];
  if (!e || !e.name) return "";
  const tags = memberTags(g, userId);
  const tagStr = tags.length ? `，标签：${tags.join("、")}` : "";
  const first = e.firstSeen ? `，第一次见是 ${Math.round((Date.now() - e.firstSeen) / 86400e3)} 天前` : "";
  return `对方是群友「${e.name}」（你们聊过 ${e.seen} 次${tagStr}${first}）。`;
}
/* 群梗代理（实现见 plugins/group-memes.js） */
function groupMemesCtx(groupId) { try { const a = _ctx.getApi("groupMemes"); return a ? a.ctx(groupId) : ""; } catch (e) { return ""; } }
function detectGroupMeme(groupId, text, userId) { try { const a = _ctx.getApi("groupMemes"); if (a) return a.detectAndLearn(groupId, text, userId); } catch (e) {} return null; }
/* 群聊记忆隔离：别的群得来的记忆不在本群展示（私聊和未标群的照常） */
function filterMemoriesForGroup(items, groupId) {
  const g = String(groupId || "");
  return (items || []).filter((m) => !m.groupId || String(m.groupId) === g);
}

/* ---------------- 群聊日志（发言人归因）+ 跨窗口连续性 ---------------- */
const groupLogFile = () => path.join(_ctx.DATA_DIR, "group-log.json");
const crossFile = () => path.join(_ctx.DATA_DIR, "cross-window.json");
function _loadJ(f, def) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return def; } }
function _saveJ(f, v) { try { fs.writeFileSync(f, JSON.stringify(v)); } catch (e) {} }
function recordGroupLog(groupId, userId, name, text) {
  if (!text) return;
  const all = _loadJ(groupLogFile(), {});
  const g = all[String(groupId)] = all[String(groupId)] || [];
  g.push({ u: Number(userId), n: String(name || "").slice(0, 20), t: String(text).slice(0, 120), ts: Date.now() });
  while (g.length > 20) g.shift();
  _saveJ(groupLogFile(), all);
}
function groupLogCtx(groupId) {
  const all = _loadJ(groupLogFile(), {});
  const g = (all[String(groupId)] || []).slice(-8);
  if (!g.length) return "";
  const lines = g.map((m) => `${m.n || ("群友" + m.u)}：${m.t}`).join("\n");
  return `【最近群聊记录（已按发言人区分，别把 A 说的话安到 B 头上）】\n${lines}`;
}
function recordCrossWindow(userId, groupId, userText, myReply) {
  const c = _loadJ(crossFile(), {});
  c[String(userId)] = { gid: String(groupId), t: String(userText || "").slice(0, 100), r: String(myReply || "").slice(0, 100), ts: Date.now() };
  const keys = Object.keys(c);
  if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete c[k];
  _saveJ(crossFile(), c);
}
function crossWindowCtx(userId) {
  const c = _loadJ(crossFile(), {});
  const e = c[String(userId)];
  if (!e || Date.now() - e.ts > 30 * 60000) return "";
  const mins = Math.max(1, Math.round((Date.now() - e.ts) / 60000));
  return `【跨窗口连续性】${mins} 分钟前，对方在 QQ 群里说过「${e.t}」，你当时回了「${e.r}」。现在转私聊了，可以自然承接刚才的话头，别假装第一次听说，也别整段重复。`;
}

module.exports = {
  name: "group-info",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  api: { groupInfo: { fetchGroupInfo, fetchMembers, fetchHonor, fetchStranger, groupInfoCtx, emojiLike, forwardToGroup, fetchGroupFiles, fetchMsg, setSelfProfile, loadGroupMembers, saveGroupMembers, rememberGroupMember, memberTags, groupMemberCtx, groupMemesCtx, detectGroupMeme, filterMemoriesForGroup, recordGroupLog, groupLogCtx, recordCrossWindow, crossWindowCtx } },
  tools: [
    {
      def: { type: "function", function: { name: "group_info", description: "查看当前群的名称、人数。群友问「这是什么群」「群里有多少人」时调用。", parameters: { type: "object", properties: {} } } },
      handler: (args, info) => groupInfoText(info && info.groupId),
    },
    {
      def: { type: "function", function: { name: "group_member_view", description: "查看当前群的成员名单（含群主/管理员标记）。群友问「群里都有谁」时调用。", parameters: { type: "object", properties: { limit: { type: "number", description: "最多列几个人，默认 20" } } } } },
      handler: (args, info) => membersText(info && info.groupId, Number(args.limit) || 20),
    },
    {
      def: { type: "function", function: { name: "group_honor", description: "查看当前群的群荣誉（龙王、群聊之火等）。群友问「谁是龙王」时调用。", parameters: { type: "object", properties: {} } } },
      handler: (args, info) => honorText(info && info.groupId),
    },
    {
      def: { type: "function", function: { name: "user_info", description: "查看某个 QQ 用户的昵称/性别/年龄。需要了解某个不熟的人时调用。", parameters: { type: "object", properties: { user_id: { type: "number", description: "QQ 号，留空则查当前对话的人" } } } } },
      handler: (args, info) => userText(Number(args.user_id) || (info && info.userId) || 0),
    },
    {
      def: { type: "function", function: { name: "emoji_like", description: "给刚收到的那条消息贴一个表情回应（比再发一条消息更轻）。觉得对方说的话值得点个赞/笑一下时用。", parameters: { type: "object", properties: { emoji: { type: "string", description: "表情名或数字 id，如 赞/笑/心" } } } } },
      handler: (args, info) => emojiLike(info && info.messageId, args.emoji, info && info.userId).msg,
    },
    {
      def: { type: "function", function: { name: "forward_msg", description: "把一段较长的内容合并转发到当前群（一条卡片，不刷屏）。内容超过三四行时优先用它。", parameters: { type: "object", properties: { content: { type: "string", description: "要转发的内容，换行分段" } } } } },
      handler: (args, info) => forwardToGroup(info && info.groupId, args.content, "Momo", info && info.userId).msg,
    },
    {
      def: { type: "function", function: { name: "group_files", description: "查看当前群的群文件（可按关键词过滤）。群友问「群文件里有啥」「找一下 XX 文件」时调用。", parameters: { type: "object", properties: { keyword: { type: "string", description: "文件名关键词，可留空" } } } } },
      handler: (args, info) => filesText(info && info.groupId, args.keyword),
    },
    {
      def: { type: "function", function: { name: "msg_by_id", description: "按消息 id 查一条历史消息的内容和发送者。需要确认某条被引用的消息说了什么时调用。", parameters: { type: "object", properties: { message_id: { type: "string", description: "消息 id" } }, required: ["message_id"] } } },
      handler: (args) => msgText(args.message_id),
    },
    {
      def: { type: "function", function: { name: "set_self_profile", description: "改 Momo 自己的昵称或个人签名。只在主人明确要求「你改个名字/签名」时调用。", parameters: { type: "object", properties: {
        nickname: { type: "string", description: "新昵称（不改就留空）" },
        note: { type: "string", description: "个人签名（不改就留空）" },
      } } } },
      handler: async (args, info) => {
        if (!_ctx.isMaster(info && info.userId)) return "（只有主人能改我的资料哦）";
        const r = await setSelfProfile(args.nickname, args.note, info && info.userId);
        return r.msg;
      },
    },
  ],
};
