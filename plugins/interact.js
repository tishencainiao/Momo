/* 插件：互动（名片点赞 / 拍一拍）
 * 接口：send_like / get_profile_like / friend_poke / group_poke
 * 另外接管「别人拍她」的事件：回一句或拍回去 */
let _ctx = null;

const lastPokeReply = new Map();   // `${gid}_${uid}` -> ts，防刷屏
const lastPokeBack = new Map();
const POKE_REPLIES = [
  "嗯？戳我干嘛~", "干嘛呀，痒", "在呢在呢", "别戳啦", "戳一下要收钱的哦",
  "唔…有事说事啦", "哎呀被戳了", "我在我在", "戳我做什么呀", "再戳就生气了哦",
];
const POKE_COOLDOWN = 60 * 1000;   // 同一个人的拍一拍，1 分钟内只回应一次
const LIKE_DAILY_MAX = 10;         // QQ 侧每人每天一般 10 次

const dayKey = () => new Date().toDateString();
let likeState = { date: "", count: 0 };
function loadLikeState() {
  if (likeState.date !== dayKey()) likeState = { date: dayKey(), count: 0 };
  return likeState;
}
/* 参数级权限：对「当前对话的人」做轻互动谁都行；对第三方必须主人 */
function isMasterUser(u) { try { return _ctx.isMaster ? !!_ctx.isMaster(u) : false; } catch (e) { return false; } }
/* 记录操作（ctx 可能没有 recordAction，兜底不报错） */
function rec(e) { try { if (_ctx.recordAction) _ctx.recordAction(e); } catch (err) {} }
/* 解析「拍谁」：支持 QQ 号 / 名字 / 留空=当前对话的人 */
function resolveWho(args, me) {
  const raw = String((args && args.target) || "").trim();
  if (!raw) return { uid: me };
  if (/^\d{5,12}$/.test(raw)) return { uid: Number(raw) };
  let id = null;
  try { id = _ctx.resolveTargetId ? _ctx.resolveTargetId(raw) : null; } catch (e) {}
  if (!id) return { err: `（我还不认识「${raw}」——先告诉我他叫什么、或者把他的 QQ 号发我）` };
  return { uid: Number(id) };
}
function checkThirdParty(targetId, requesterId) {
  const t = Number(targetId) || 0;
  const r = Number(requesterId) || 0;
  if (!t || t === r) return "";                 // 对自己，放行
  if (isMasterUser(r)) return "";               // 主人可以让我对别人做
  return "（只有主人能让我对别人做这个哦）";
}

/* ---------- 名片点赞 ---------- */
async function sendLike(userId, times, by) {
  const uid = Number(userId);
  if (!uid) return { ok: false, msg: "（不知道给谁点赞）" };
  const n = Math.max(1, Math.min(LIKE_DAILY_MAX, Number(times) || 1));
  const st = loadLikeState();
  if (st.count + n > LIKE_DAILY_MAX) {
    return { ok: false, msg: `（今天点赞已经 ${st.count} 次了，QQ 一天最多 ${LIKE_DAILY_MAX} 次）` };
  }
  try {
    await _ctx.onebotSend("send_like", { user_id: uid, times: n });
    st.count += n;
    _ctx.log("info", `名片点赞 ${uid} ×${n}（今日第 ${st.count} 次）`);
    rec({ action: "send_like", by: Number(by) || 0, target: uid, detail: `点了 ${n} 个赞`, ok: true });
    return { ok: true, msg: `给「${_ctx.resolveCall(uid)}」点了 ${n} 个赞` };
  } catch (e) {
    rec({ action: "send_like", by: Number(by) || 0, target: uid, ok: false, detail: String(e.message).slice(0, 60) });
    return { ok: false, msg: "（点赞失败：" + String(e.message).slice(0, 60) + "）" };
  }
}

/* 查自己的赞数据（今日已点/总获赞） */
async function likeStatus(userId) {
  try {
    const r = await _ctx.onebotSend("get_profile_like", { user_id: Number(userId) || 0 });
    const d = (r && r.data) ? r.data : {};
    const fi = d.favoriteInfo || {};
    return { today: Number(fi.today_count || 0), total: Number(fi.total_count || 0), mine: loadLikeState().count };
  } catch (e) { return null; }
}

/* ---------- 拍一拍 ---------- */
async function poke(userId, groupId, by) {
  const uid = Number(userId);
  if (!uid) return { ok: false, msg: "（不知道拍谁）" };
  const key = (groupId || 0) + "_" + uid;
  if (Date.now() - (lastPokeBack.get(key) || 0) < 30000) {
    return { ok: false, msg: "（刚拍过，等一会儿再拍吧）" };
  }
  try {
    if (groupId) await _ctx.onebotSend("group_poke", { group_id: Number(groupId), user_id: uid });
    else await _ctx.onebotSend("friend_poke", { user_id: uid });
    lastPokeBack.set(key, Date.now());
    _ctx.log("info", `拍了 ${uid}${groupId ? " 群" + groupId : ""}`);
    rec({ action: "poke", by: Number(by) || 0, target: uid, groupId: Number(groupId) || 0, ok: true });
    return { ok: true, msg: `拍了拍「${_ctx.resolveCall(uid)}」` };
  } catch (e) {
    rec({ action: "poke", by: Number(by) || 0, target: uid, groupId: Number(groupId) || 0, ok: false, detail: String(e.message).slice(0, 60) });
    return { ok: false, msg: "（拍一拍失败：" + String(e.message).slice(0, 60) + "）" };
  }
}

/* ---------- 别人拍她：回一句或拍回去 ---------- */
async function onPoke(obj) {
  try {
    if (!obj || String(obj.target_id) !== String(obj.self_id)) return;   // 只有戳她自己才回应
    const uid = Number(obj.user_id);
    const gid = Number(obj.group_id) || 0;
    if (!uid) return;
    const key = gid + "_" + uid;
    if (Date.now() - (lastPokeReply.get(key) || 0) < POKE_COOLDOWN) return;  // 防刷
    lastPokeReply.set(key, Date.now());
    _ctx.log("info", `被 ${uid} 拍了${gid ? " 群" + gid : ""}`);
    // 30% 概率拍回去，其余回一句
    if (Math.random() < 0.3) {
      const r = await poke(uid, gid);
      if (r.ok) return;
    }
    const text = POKE_REPLIES[Math.floor(Math.random() * POKE_REPLIES.length)];
    if (gid) {
      await _ctx.onebotSend("send_msg", { message_type: "group", group_id: gid, message: [{ type: "text", data: { text } }] });
    } else {
      await _ctx.sendPrivate(uid, text);
    }
  } catch (e) { _ctx.log("warn", "处理拍一拍失败: " + String(e.message).slice(0, 100)); }
}

module.exports = {
  name: "interact",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  settings: [
    { key: "interact.poke_cooldown", label: "被拍后多久才再回应（秒）", type: "number", default: 60, min: 5, max: 600, desc: "同一个人连续拍她时的回应间隔" },
  ],
  api: { interact: { sendLike, likeStatus, poke, onPoke, checkThirdParty } },
  tools: [
    {
      def: { type: "function", function: { name: "send_like", description: "给对方的 QQ 名片点赞（像真人互相点赞那样）。对方做了值得夸奖的事、或气氛好时可以用。点当前对话的人不需要权限；点别人只有主人可以。", parameters: { type: "object", properties: {
        times: { type: "number", description: "点几个赞，默认 1，最多 10" },
        target: { type: "string", description: "给谁点：QQ号或名字（如「老王」）；留空=当前对话的人" },
      } } } },
      handler: async (args, info) => {
        const me = Number((info && info.userId) || 0);
        const who = resolveWho(args, me);
        if (who.err) return who.err;
        const deny = checkThirdParty(who.uid, me);
        if (deny) return deny;
        const r = await sendLike(who.uid, args.times, me);
        return r.msg;
      },
    },
    {
      def: { type: "function", function: { name: "poke", description: "「拍一拍」对方（QQ 的戳一戳）。想引起注意、撒娇、催对方回话时用。可以传名字（如「老王」）或 QQ 号。拍当前对话的人不需要权限；拍别人只有主人可以。", parameters: { type: "object", properties: {
        target: { type: "string", description: "拍谁：QQ号或名字（如「老王」）；留空=当前对话的人" },
      } } } },
      handler: async (args, info) => {
        const me = Number((info && info.userId) || 0);
        const who = resolveWho(args, me);
        if (who.err) return who.err;
        const deny = checkThirdParty(who.uid, me);
        if (deny) return deny;
        const gid = (info && info.groupId) || 0;
        const r = await poke(who.uid, gid, me);
        return r.msg;
      },
    },
    {
      def: { type: "function", function: { name: "like_status", description: "查看名片点赞的数据（今日已点次数、总获赞等）。对方问「你点过几个赞」时用。", parameters: { type: "object", properties: {} } } },
      handler: async (args, info) => {
        const s = await likeStatus((info && info.userId) || 0);
        if (!s) return "（没拿到点赞数据）";
        return `今天已经点了 ${s.mine} 次赞；这个账号今日获赞 ${s.today}，累计 ${s.total}`;
      },
    },
  ],
};
