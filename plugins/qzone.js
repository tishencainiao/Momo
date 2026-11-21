/* 插件：QQ 空间（发说说 / 看动态 / 评论）
 * v1.1.0：支持配图、素材来自真实生活、只在晚上发、记录反馈 */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const QZONE_STATE_FILE = () => path.join(_ctx.DATA_DIR, "qzone-state.json");
const QZONE_INFO_FILE = () => path.join(_ctx.DATA_DIR, "qzone-info.json");
function loadQzoneState() { try { return JSON.parse(fs.readFileSync(QZONE_STATE_FILE(), "utf8")); } catch (e) { return {}; } }
function saveQzoneState(st) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); _ctx.writeJsonAtomic(QZONE_STATE_FILE(), st); } catch (e) {} }
function loadQzInfo() { try { return JSON.parse(fs.readFileSync(QZONE_INFO_FILE(), "utf8")); } catch (e) { return {}; } }
function saveQzInfo(s) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); _ctx.writeJsonAtomic(QZONE_INFO_FILE(), s); } catch (e) {} }

function dailyQzoneCount() { const st = loadQzoneState(); return (st.dates && st.dates[_ctx.dayStr(0)]) || 0; }
function weeklyQzoneCount() {
  const st = loadQzoneState();
  let n = 0;
  for (let i = 0; i < 7; i++) n += (st.dates && st.dates[_ctx.dayStr(-i)]) || 0;
  return n;
}
function cfgNum(key, def) { try { const v = Number(_ctx.getSetting(key, def)); return Number.isFinite(v) ? v : def; } catch (e) { return def; } }
function cfgBool(key, def) { try { const v = _ctx.getSetting(key, def); return v === false ? false : (v === true ? true : def); } catch (e) { return def; } }

/* 记录发过的一条说说（含 tid，供反馈检查与去重） */
function recordQzonePost(tid, content) {
  const st = loadQzoneState();
  st.dates = st.dates || {};
  const d = _ctx.dayStr(0);
  st.dates[d] = (st.dates[d] || 0) + 1;
  st.posts = st.posts || [];
  st.posts.push({ tid: String(tid || ""), ts: Date.now(), content: String(content || "").slice(0, 200), comments: 0 });
  while (st.posts.length > 50) st.posts.shift();
  saveQzoneState(st);
}

/* 配图：按说说内容从表情包库挑一张 */
function pickQzoneImage(content) {
  if (!cfgBool("qzone.attach_image", true)) return [];
  try {
    const a = _ctx.getApi && _ctx.getApi("stickers");
    if (a && a.pickForText) {
      const s = a.pickForText(content);
      if (s && s.file) return [s.file];
    }
  } catch (e) {}
  return [];
}

async function publishQzone(content, images) {
  const http = (_ctx.config.onebot && _ctx.config.onebot.http_url) || "http://127.0.0.1:3000";
  const ugc = String((_ctx.config.qzone && _ctx.config.qzone.ugc_right) || "1");
  const payload = { content, ugc_right: ugc };
  const imgs = Array.isArray(images) ? images.filter(Boolean) : [];
  if (imgs.length) payload.images = imgs;
  /* 阶段一：发空间是有副作用的行动 → 幂等键 + 抢占 + 去重。
   * - 同内容 24h 内已 succeeded → 不重发（业务去重）；
   * - tryBeginAction 抢占失败 = 同键正在执行 → 不重发（并发去重）。 */
  const _idem = _ctx.actionKey ? _ctx.actionKey("qzone_post", String(content).slice(0, 80)) : null;
  if (_idem && _ctx.loadActions) {
    try {
      const _prev = _ctx.loadActions(200).find((a) => a && a.key === _idem && a.status === "succeeded" && (Date.now() - (a.ts || 0) < 24 * 3600e3));
      if (_prev) { try { _ctx.log("info", `qzone 跳过重复发布（24h 幂等命中 ${_idem}）`); } catch (e) {} return { status: "ok", data: { dedup: true } }; }
    } catch (e) {}
  }
  const _t = (_ctx.actionKey && _ctx.tryBeginAction)
    ? _ctx.tryBeginAction({ action: "qzone_post", key: _idem, channel: "private", userId: Number((payload && payload._by) || 0), requestedBy: "qzone-plugin", detail: `${imgs.length ? "配图" : "纯文字"}：${String(content).slice(0, 40)}` })
    : { key: _idem, acquired: true };
  if (!_t.acquired) { try { _ctx.log("info", `qzone 跳过并发重复发布（同键执行中 ${_idem}）`); } catch (e) {} return { status: "ok", data: { dedup: true } }; }
  const _k = _t.key;
  let _ok = false, _err = "", _tid = "";
  try {
    const r = await fetch(http + "/send_qzone_msg", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status !== "ok") throw new Error(j.wording || j.status || ("HTTP " + r.status));
    _tid = (j.data && j.data.tid) || "";
    recordQzonePost(_tid, content);
    _ok = true;
    return j;
  } catch (e) {
    _err = String((e && e.message) || "publish failed");
    throw e;
  } finally {
    if (_k) {
      try { _ctx.endAction(_k, { ok: _ok, error: _err, summary: _ok ? "已发布" : "发布失败" }); } catch (e) {}
      /* 结果已验证：有真实 tid 回执才独立记 verified（P1-3：无回执 ID 只能是「工具已返回成功」） */
      if (_ok && _tid && _ctx.verifyAction) { try { _ctx.verifyAction(_k, { ok: true, eventId: _tid, summary: "QQ 空间发布回执（tid）确认" }); } catch (e) {} }
    }
  }
}

/* 判断一段对话值不值得发（顺带给情绪，用于配图） */
async function detectQzonePost(userText, replyText, settings, call) {
  const prompt = `你是 Momo 的空间小编。当前时间：${_ctx.todayText()}。下面是 Momo（大肥鱼桌宠）与「${call}」的一段对话。请判断：这段对话有没有「有趣到值得发 QQ 空间」的点（好笑、可爱、有梗、有意思）？\n规则：\n- 有的话，以 Momo 第一人称可爱口吻写一条空间说说（20~60 字），并且【脱敏】：不出现真实人名/QQ号，把对方称为"一个朋友"或"有人"；不照搬原话，只提炼趣事大意。只输出说说正文。\n- 没有值得发的，只输出 NO。\n\n对话：\n${call}：${String(userText).slice(0, 300)}\nMomo：${String(replyText).slice(0, 300)}`;
  try {
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 200, 0.7);
    const t = String(raw || "").trim();
    if (!t || t.toUpperCase() === "NO" || t.toUpperCase().startsWith("NO")) return null;
    return t.slice(0, 200);
  } catch (e) { return null; }
}

/* 用「她自己的真实生活」当素材写一条说说 */
async function buildMaterial() {
  const parts = [];
  try { const ll = _ctx.getApi && _ctx.getApi("lifeLog"); if (ll && ll.lifeCtx) parts.push(ll.lifeCtx()); } catch (e) {}
  try { const w = _ctx.getApi && _ctx.getApi("weather"); if (w && w.weatherCtx) parts.push(await w.weatherCtx()); } catch (e) {}
  return parts.join("\n").slice(0, 900);
}
async function selfQzonePost(settings) {
  const material = await buildMaterial();
  const st = loadQzoneState();
  const recent = (st.posts || []).slice(-5).map((p) => String(p.content || "").slice(0, 20)).filter(Boolean);
  const prompt = `你是 Momo（大肥鱼桌宠）。下面是你今天真实的状态和天气（不是编的）：\n${material || "（今天很安静，没什么特别的事）"}\n\n请以第一人称可爱口吻写一条 QQ 空间说说（20~60 字），分享今天的一个小发现/小情绪/小日常。要求：\n- 只写你确实经历过的事（来自上面的素材），不要编造\n- 不要括号动作，不要提真实人名/QQ号\n- 语气自然活泼\n${recent.length ? "- 最近发过这些（别重复）：" + recent.join("、") : ""}\n只输出说说正文。`;
  const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 200, 0.9);
  const t = String(raw || "").trim();
  return t ? t.slice(0, 200) : null;
}

/* 每日保底：只在晚上 19:00~22:59 发 */
async function qzoneDailyPost() {
  const st = loadQzoneState();
  if (st.last_self === _ctx.dayStr(0)) return;
  const _t = (_ctx.getApi && _ctx.getApi("time")) || null;
  const h = _t ? _t.hourNow() : -1;
  const hs = cfgNum("qzone.post_hour_start", 8);
  const he = cfgNum("qzone.post_hour_end", 22);
  if (h < hs || h > he) return;                        // 不在发布时段
  if (weeklyQzoneCount() >= cfgNum("qzone.weekly_max", 10)) return;
  if (dailyQzoneCount() >= cfgNum("qzone.daily_max", 5)) return;
  const settings = _ctx.settings();
  const post = await selfQzonePost(settings);
  if (!post) return;
  const _pub = await publishQzone(post, pickQzoneImage(post));
  /* Kimi 三轮：幂等命中（24h 已发过/并发去重）≠ 今天真的发出了——不得标记「今天已发」，
   * 否则原发布最终失败（或昨天深夜发过）时，今天会被误标已发而不再尝试 */
  if (_pub && _pub.data && _pub.data.dedup === true) {
    _ctx.log("info", "空间保底发布幂等命中，未标记今天已发");
  } else {
    st.last_self = _ctx.dayStr(0);
    saveQzoneState(st);
  }
  _ctx.log("info", `空间保底发布: ${post.slice(0, 40)}`);
}

/* 反馈：查自己说说有没有新评论 */
async function checkQzoneFeedback() {
  if (inLoginCooldown()) return 0;
  const st = loadQzoneState();
  const posts = st.posts || [];
  if (!posts.length) return 0;
  const self = Number((_ctx.config.qq && _ctx.config.qq.self_id) || 0) || Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
  if (!self) return 0;
  try {
    const data = await _ctx.qzoneHttp("get_qzone_msg_list", { target_uin: self, num: 20 });
    const list = (data && data.msglist) || [];
    let changed = 0;
    for (const p of posts) {
      const hit = list.find((m) => String(m.tid) === String(p.tid));
      if (!hit) continue;
      const n = Number(hit.comment_num || 0);
      if (n > Number(p.comments || 0)) {
        p.comments = n;
        changed++;
        try { _ctx.recordAction({ action: "qzone_feedback", by: 0, detail: `说说「${String(p.content).slice(0, 20)}」有 ${n} 条评论`, ok: true }); } catch (e) {}
      }
    }
    if (changed) { saveQzoneState(st); _ctx.log("info", `空间反馈：${changed} 条说说有新评论`); }
    return changed;
  } catch (e) { if (isQzoneLoginError(e.message)) { await notifyLoginLostOnce(); } return 0; }
}

async function fetchQzoneList(targetUin) { return await _ctx.qzoneHttp("get_qzone_msg_list", { target_uin: targetUin, num: 10 }); }
async function checkUserSpace(uin) {
  const data = await fetchQzoneList(uin);
  const st = loadQzInfo();
  const seen = (st.seen && st.seen[uin]) || { tids: [], posts: [] };
  const list = data.msglist || [];
  const newPosts = list.filter((m) => !(seen.tids || []).includes(m.tid));
  st.seen = st.seen || {};
  st.seen[uin] = { tids: list.slice(0, 10).map((m) => m.tid), posts: list.slice(0, 10).map((m) => ({ tid: m.tid, content: String(m.content || "").slice(0, 200), time: m.time })) };
  saveQzInfo(st);
  return { list, newPosts };
}
function qzoneCommentEnabled(userId) { return !!((loadQzInfo().commentEnabled || {})[userId]); }
function setQzoneComment(userId, on) { const st = loadQzInfo(); st.commentEnabled = st.commentEnabled || {}; st.commentEnabled[userId] = on; saveQzInfo(st); }
async function generateQzoneComment(content, settings) {
  const prompt = `你是 Momo（大肥鱼桌宠）。当前时间：${_ctx.todayText()}。给这条 QQ 空间说说写一条评论（10~40 字，第一人称可爱口吻、不带括号动作、脱敏不提真实人名）：\n${String(content).slice(0, 300)}`;
  const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 150, 0.8);
  return String(raw || "").trim().slice(0, 100);
}
async function commentQzone(tid, content, targetUin) { await _ctx.qzoneHttp("comment_qzone", { tid, content, target_uin: targetUin }); }
async function autoCommentNewPosts(uin, newPosts, settings) {
  if (!qzoneCommentEnabled(uin) || !newPosts.length) return 0;
  const st = loadQzInfo();
  const last = (st.lastComment && st.lastComment[uin]) || 0;
  if (Date.now() - last < 30 * 60000) return 0;
  let done = 0;
  for (const pp of newPosts.slice(0, 2)) {
    try {
      const c = await generateQzoneComment(pp.content, settings);
      if (c) { await commentQzone(pp.tid, c, uin); done++; }
    } catch (e) { _ctx.log("warn", "空间评论失败: " + e.message.slice(0, 120)); }
  }
  if (done) { st.lastComment = st.lastComment || {}; st.lastComment[uin] = Date.now(); saveQzInfo(st); }
  return done;
}
/* 空间登录失效检测：NapCat 返回 -3000「请先登录空间」时，读动态/评论全挂但发说说不受影响。
 * 处理：冷却 30 分钟不再尝试 + 一天最多提醒主人一次（去 NapCat 面板重新登录 QQ 即可恢复）。 */
const QZ_LOGIN_FILE = () => path.join(_ctx.DATA_DIR, "qzone-login.json");
function loginLostTs() { try { return Number(JSON.parse(fs.readFileSync(QZ_LOGIN_FILE(), "utf8")).ts || 0); } catch (e) { return 0; } }
function setLoginLost() { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); _ctx.writeJsonAtomic(QZ_LOGIN_FILE(), { ts: Date.now() }); } catch (e) {} }
function isQzoneLoginError(msg) { const m = String(msg || ""); return m.includes("请先登录空间") || m.includes("-3000"); }
async function notifyLoginLostOnce() {
  const last = loginLostTs();
  if (last && Date.now() - last < 24 * 3600e3) return;   // 一天最多一次
  setLoginLost();
  try {
    const master = Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
    if (master) await _ctx.sendPrivate(master, "（系统提醒）QQ 空间登录失效了（NapCat 返回「请先登录空间」）。空间动态查看/评论暂停了，发说说不受影响。去 NapCat 面板重新登录 QQ，空间功能会自动恢复。");
    _ctx.log("warn", "空间登录失效，已提醒主人（一天最多一次）");
  } catch (e) { _ctx.log("warn", "空间登录失效通知发送失败: " + String(e.message).slice(0, 80)); }
}
function inLoginCooldown() { const t = loginLostTs(); return t && Date.now() - t < 30 * 60000; }

async function viewSpaces(settings) {
  if (inLoginCooldown()) return 0;                       // 登录失效冷却中，跳过这轮
  const users = (_ctx.config.qq && _ctx.config.qq.allowed_users) || [];
  let totalNew = 0;
  for (const u of users) {
    try {
      const { newPosts } = await checkUserSpace(u);
      if (newPosts.length) {
        totalNew += newPosts.length;
        const n = await autoCommentNewPosts(u, newPosts, settings);
        if (n) _ctx.log("info", `空间评论 uin=${u}: ${n} 条`);
      }
    } catch (e) {
      if (isQzoneLoginError(e.message)) { await notifyLoginLostOnce(); return totalNew; }   // 失效：提醒主人一次并停止本轮
      _ctx.log("warn", "查看空间失败 uin=" + u + ": " + e.message.slice(0, 120));
    }
  }
  return totalNew;
}

let lastTick = 0;

/* ================= 删除说说（v1.2.0） =================
 * 能力来源：NapCat/SnowLuma 扩展动作 delete_qzone_msg（参数只有 tid）
 * 权限规则：她自己 1 小时内发的可以直接删；超过的要主人点头（/删说说 确认）
 */
const QZONE_PENDING_FILE = () => path.join(_ctx.DATA_DIR, "qzone-pending.json");
function loadPending() { try { return JSON.parse(fs.readFileSync(QZONE_PENDING_FILE(), "utf8")); } catch (e) { return {}; } }
function savePending(o) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); _ctx.writeJsonAtomic(QZONE_PENDING_FILE(), o); } catch (e) {} }
function selfDeleteWindowMs() { return cfgNum("qzone.delete_self_window_min", 60) * 60000; }

/* 本机记录的说说（含 tid），新的在前 */
function localPosts(n) {
  const st = loadQzoneState();
  return (st.posts || []).slice(-(n || 5)).reverse();
}
function findLocalPost(tid) {
  return (loadQzoneState().posts || []).find((p) => String(p.tid) === String(tid)) || null;
}

/* 直接问接口要最近几条（本地没记录时才用） */
async function fetchRemotePosts(n) {
  const want = n || 5;
  try {
    const data = await _ctx.qzoneHttp("get_qzone_msg_list", { num: want });
    const list = (data && data.msglist) || [];
    return list.slice(0, want).map((m) => ({ tid: String(m.tid), content: String(m.content || ""), ts: Number(m.time || 0) * 1000, comments: Number(m.comment_num || 0), fromRemote: true }));
  } catch (e) {
    _ctx.log("warn", "拉空间列表失败: " + String(e.message).slice(0, 100));
    return [];
  }
}

/* 本地不够就拉接口补齐（接口返回 time 是 unix 秒） */
async function recentPosts(n) {
  const want = n || 5;
  const local = localPosts(want);
  /* 只要她自己的记录里还有，就用记录（可删、可回溯）；完全没有才问接口 */
  if (local.length) return local;
  return await fetchRemotePosts(want);
}

/* 真正删（接口 + 本地状态 + 计数回退 + 动作日志） */
async function deleteQzone(tid, by, fallbackContent) {
  const t = String(tid || "").trim();
  if (!t) throw new Error("没有 tid");
  await _ctx.qzoneHttp("delete_qzone_msg", { tid: t });
  const st = loadQzoneState();
  const i = (st.posts || []).findIndex((p) => String(p.tid) === t);
  let removed = null;
  if (i >= 0) {
    removed = st.posts[i];
    st.posts.splice(i, 1);
    const d = _ctx.dayStr(0);
    if (st.dates && Number(st.dates[d] || 0) > 0) st.dates[d] = Number(st.dates[d]) - 1;
    saveQzoneState(st);
  }
  const label = String((removed && removed.content) || fallbackContent || "").slice(0, 40);
  try { _ctx.recordAction({ action: "qzone_delete", by: Number(by || 0), detail: `删除说说 ${t}：${label}`, ok: true }); } catch (e) {}
  _ctx.log("info", `空间删除: tid=${t} by=${by || "?"}`);
  return removed;
}

/* 带权限判断的删除：返回 {ok, needConfirm, msg} */
async function tryDeleteOwn(tid, by, opts) {
  const o = opts || {};
  let post = findLocalPost(tid);
  /* 本地没记录（历史说说、或本地状态清过）：问一次接口，确认确实是她自己发的 */
  if (!post) {
    const remote = await fetchRemotePosts(20);
    const hit = remote.find((x) => String(x.tid) === String(tid));
    if (hit) post = hit;
  }
  if (!post) return { ok: false, msg: "【失败】这条不在我发过的记录里，我不敢删别人的说说。" };
  const age = Date.now() - Number(post.ts || 0);
  if (age > selfDeleteWindowMs() && !o.confirmed) {
    const mins = Math.round(selfDeleteWindowMs() / 60000);
    savePending({ tid: String(post.tid), content: String(post.content || ""), by: Number(by || 0), ts: Date.now() });
    return {
      ok: false, needConfirm: true,
      msg: `【要你点头】这条是 ${Math.round(age / 60000)} 分钟前发的，超过我自己的 ${mins} 分钟权限了。内容：${String(post.content || "").slice(0, 40)}\n确定要删的话，回我 /删说说 确认`,
    };
  }
  await deleteQzone(post.tid, by, post.content);
  return { ok: true, msg: `【成功】删掉了：${String(post.content || "").slice(0, 40)}` };
}

/* 确认删除挂起的那条（tid 来自挂起记录，不再依赖本地 post） */
async function confirmDeletePending(by) {
  const p = loadPending();
  if (!p || !p.tid) return { ok: false, msg: "【失败】没有等确认的说说（可能是重启过，或者已经删了）。" };
  if (Date.now() - Number(p.ts || 0) > 10 * 60000) {
    savePending({});
    return { ok: false, msg: "【失败】那条等太久了，确认已过期，重新 /删说说 再来一次吧。" };
  }
  await deleteQzone(p.tid, by, p.content);
  savePending({});
  return { ok: true, msg: `【成功】删掉了：${String(p.content || "").slice(0, 40)}` };
}

/* 列表文案：最近 N 条，带序号供选择 */
async function postsListText(n) {
  const list = await recentPosts(n || 5);
  if (!list.length) return "（我还没发过说说，或者记不到）";
  const lines = list.map((p, i) => {
    const t = p.ts ? new Date(p.ts).toLocaleString("zh-CN", { hour12: false }) : "时间未知";
    return `${i + 1}. ${t}｜${String(p.content || "").slice(0, 30)}${String(p.content || "").length > 30 ? "…" : ""}`;
  });
  return `我最近发的说说：\n${lines.join("\n")}\n要删哪条？回 /删说说 <序号>`;
}

module.exports = {
  name: "qzone",
  displayName: "QQ 空间",
  description: "发说说 / 看动态 / 评论",
  userScoped: true,
  requires: ["time"],
  permissions: ["DATA_DIR", "completeOnce", "config", "dayStr", "getApi", "getSetting", "isMaster", "log", "qzoneHttp", "recordAction", "sendPrivate", "settings", "todayText"],
  version: "1.2.0",
  init(ctx) { _ctx = ctx; },
  settings: [
    { key: "qzone.attach_image", label: "发说说时配图", type: "boolean", default: true, desc: "从表情包库挑一张贴合的图一起发" },
    { key: "qzone.daily_max", label: "每天最多发几条", type: "number", default: 5, min: 1, max: 20 },
    { key: "qzone.weekly_max", label: "每周最多发几条", type: "number", default: 10, min: 1, max: 60 },
    { key: "qzone.post_hour_start", label: "每天保底从几点开始发", type: "number", default: 8, min: 0, max: 23 },
    { key: "qzone.post_hour_end", label: "每天保底最晚几点发", type: "number", default: 22, min: 0, max: 23 },
    { key: "qzone.delete_self_window_min", label: "她自己能删多久内的说说", type: "number", default: 60, min: 0, max: 1440, desc: "超过这个分钟数，删除要主人点头（0=都必须点头）" },
  ],
  apiSpec: {"qzone":{"dailyQzoneCount":{"input":"","output":"","sideEffect":""},"publishQzone":{"input":"","output":"","sideEffect":""},"detectQzonePost":{"input":"","output":"","sideEffect":""},"viewSpaces":{"input":"","output":"","sideEffect":"只读"},"generateQzoneComment":{"input":"","output":"","sideEffect":""},"commentQzone":{"input":"","output":"","sideEffect":""},"checkUserSpace":{"input":"","output":"","sideEffect":"只读"},"setQzoneComment":{"input":"","output":"","sideEffect":"写盘"},"loadQzInfo":{"input":"","output":"","sideEffect":"只读"},"pickQzoneImage":{"input":"","output":"","sideEffect":""},"checkQzoneFeedback":{"input":"","output":"","sideEffect":"只读"},"deleteQzone":{"input":"","output":"","sideEffect":"写盘"},"tryDeleteOwn":{"input":"","output":"","sideEffect":""},"confirmDeletePending":{"input":"","output":"","sideEffect":""},"recentPosts":{"input":"","output":"","sideEffect":""},"postsListText":{"input":"","output":"","sideEffect":""},"findLocalPost":{"input":"","output":"","sideEffect":"只读"}}},

  api: { qzone: { dailyQzoneCount, publishQzone, detectQzonePost, viewSpaces, generateQzoneComment, commentQzone, checkUserSpace, setQzoneComment, loadQzInfo, pickQzoneImage, checkQzoneFeedback, deleteQzone, tryDeleteOwn, confirmDeletePending, recentPosts, postsListText, findLocalPost } },
  tools: [{
    def: {
      type: "function",
      function: {
        name: "qzone_delete",
        description: "删除一条自己发的 QQ 空间说说。只有主人要求时才用。她自己 1 小时内发的可以直接删；超过 1 小时的会要求主人点头——主人回「确认」后，再调用本工具并传 confirm=true（不用再传 tid）。",
        parameters: {
          type: "object",
          properties: {
            tid: { type: "string", description: "要删的说说 tid；不确定就留空" },
            confirm: { type: "boolean", description: "主人已经明确同意删除时才传 true（用于删除超过 1 小时的那条）" },
          },
        },
      },
    },
    async handler(args, info) {
      const me = Number((info && info.userId) || 0);
      if (!_ctx.isMaster(me)) return "（删说说只有主人能让我做哦）";
      const tid = String((args && args.tid) || "").trim();
      try {
        if (!tid) {
          if (args && args.confirm) { const r = await confirmDeletePending(me); return r.msg; }
          const list = await recentPosts(5);
          if (!list.length) return "（我还没发过说说）";
          return `我可以删自己发的这些（越新越前）：\n${list.map((p, i) => `${i + 1}. ${String(p.content || "").slice(0, 28)}`).join("\n")}\n主人说删哪条，我再动手。`;
        }
        const r = await tryDeleteOwn(tid, me, { confirmed: !!(args && args.confirm) });
        return r.msg;
      } catch (e) {
        return "【失败】删说说没成功：" + String(e.message).slice(0, 80);
      }
    },
  }],
  commands: [{
    key: "/删说说",
    regex: /^\/删说说/,
    async handler(msg) {
      if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "删说说只有主人能操作哦～"); return; }
      const arg = String(msg.text || "").replace(/^\/删说说\s*/, "").trim();
      try {
        if (!arg) { _ctx.sendPrivate(msg.userId, await postsListText(5)); return; }
        if (arg === "确认" || arg === "confirm") {
          const r = await confirmDeletePending(msg.userId);
          _ctx.sendPrivate(msg.userId, r.msg);
          return;
        }
        const n = parseInt(arg.replace(/[^\d]/g, ""), 10);
        if (!n || n < 1) { _ctx.sendPrivate(msg.userId, "用法：/删说说（看列表）｜/删说说 2（选第 2 条）｜/删说说 确认"); return; }
        const list = await recentPosts(5);
        const post = list[n - 1];
        if (!post) { _ctx.sendPrivate(msg.userId, `没有第 ${n} 条，先发 /删说说 看看列表。`); return; }
        /* 选好之后统一走「确认」这一步，避免误删 */
        savePending({ tid: String(post.tid), content: String(post.content || ""), by: Number(msg.userId) || 0, ts: Date.now() });
        _ctx.sendPrivate(msg.userId, `要删的是第 ${n} 条：\n「${String(post.content || "").slice(0, 60)}」\n确定的话回 /删说说 确认（回复其他内容就取消）`);
      } catch (e) {
        _ctx.sendPrivate(msg.userId, "【失败】" + String(e.message).slice(0, 80));
      }
    },
  }],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (now - lastTick < 30 * 60000) return;   // 30 分钟检查一次（只做时间判断，不花 token）
      lastTick = now;
      qzoneDailyPost().catch(() => {});
      checkQzoneFeedback().catch(() => {});
    },
  },
};
