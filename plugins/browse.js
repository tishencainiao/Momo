/* 插件：刷视频（B站热门）—— 让她真的"看懂"一条视频并记住
 * 数据源：B站公开接口（热门/排行榜/热评，实测可用；微博/知乎/抖音均被反爬）
 * 流程：抓热门 → 她自己挑一条 → 抓简介+热评 → flash 生成「讲了啥+我的感受」→ 记录
 * 记录：data/browse.jsonl = {ts,title,desc,owner,url,aid,comments,thought}
 * 成本：抓列表/评论免费；挑+总结 2 次 flash ≈ ¥0.002；预算耗尽不刷 */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const BILI_POPULAR = "https://api.bilibili.com/x/web-interface/popular?ps=10";
const BILI_RANKING = "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all";
const DAY_MAX_DEFAULT = 3;
function dayMax() {
  try { const v = Number(_ctx.getSetting ? _ctx.getSetting("browse.daily_max", DAY_MAX_DEFAULT) : DAY_MAX_DEFAULT); return Number.isFinite(v) && v > 0 ? v : DAY_MAX_DEFAULT; }
  catch (e) { return DAY_MAX_DEFAULT; }
}
/* 强烈情绪关键词：命中才把感想写进成长记忆（避免记忆库被普通视频灌满） */
const STRONG_RE = /(太好|很棒|超|真的|绝了|笑死|破防|感动|震惊|震撼|心疼|泪目|爆笑|燃|可爱|治愈|厉害|牛|离谱|无语|心痛|激动|上瘾|停不下来)/;

const file = () => path.join(_ctx.DATA_DIR, "browse.jsonl");
function loadHistory(n) {
  try {
    return fs.readFileSync(file(), "utf8").split("\n").filter(Boolean)
      .slice(-(n || 50)).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
function record(item) {
  try {
    fs.mkdirSync(_ctx.DATA_DIR, { recursive: true });
    fs.appendFileSync(file(), JSON.stringify(Object.assign({ ts: Date.now() }, item)) + "\n");
  } catch (e) {}
}
function todayCount() {
  const now = Date.now();
  return loadHistory(100).filter((x) => now - (x.ts || 0) < 24 * 3600e3).length;
}

async function getJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://www.bilibili.com/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

function mapItem(x) {
  return {
    title: String(x.title || "").slice(0, 60),
    desc: String(x.desc || "").slice(0, 120),
    owner: String((x.owner && x.owner.name) || ""),
    url: String(x.short_link_v2 || ""),
    aid: Number(x.aid) || 0,
  };
}

async function fetchHot(limit) {
  const out = [];
  try {
    const j = await getJson(BILI_POPULAR);
    if (j && j.code === 0 && j.data && Array.isArray(j.data.list)) for (const x of j.data.list.slice(0, limit)) out.push(mapItem(x));
  } catch (e) { _ctx.log("warn", "B站热门失败: " + String(e.message).slice(0, 100)); }
  if (out.length) return out;
  try {
    const j = await getJson(BILI_RANKING);
    if (j && j.code === 0 && j.data && Array.isArray(j.data.list)) for (const x of j.data.list.slice(0, limit)) out.push(mapItem(x));
  } catch (e) { _ctx.log("warn", "B站排行失败: " + String(e.message).slice(0, 100)); }
  return out;
}

/* 抓热门评论（免费）：评论往往比简介更能反映视频内容 */
async function fetchComments(aid, n) {
  if (!aid) return [];
  try {
    const j = await getJson(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=1&ps=${n || 5}`);
    if (j && j.code === 0 && j.data && Array.isArray(j.data.replies)) {
      return j.data.replies.slice(0, n || 5)
        .map((r) => String((r.content && r.content.message) || "").slice(0, 80)).filter(Boolean);
    }
  } catch (e) { _ctx.log("warn", "抓评论失败: " + String(e.message).slice(0, 100)); }
  return [];
}

/* 知乎日报（免费）：文字内容，好读 */
async function fetchZhihu(limit) {
  const out = [];
  try {
    const j = await getJson("https://news-at.zhihu.com/api/4/news/latest");
    if (j && Array.isArray(j.stories)) {
      for (const s of j.stories.slice(0, limit || 3)) {
        out.push({ source: "知乎", title: String(s.title || "").slice(0, 60), desc: String(s.hint || "").slice(0, 80), owner: "知乎日报", url: String(s.url || ""), aid: 0 });
      }
    }
  } catch (e) { _ctx.log("warn", "知乎日报失败: " + String(e.message).slice(0, 100)); }
  return out;
}

/* 网易云热歌榜（免费）：给她"听到什么歌"的生活感 */
async function fetchMusic(limit) {
  const out = [];
  try {
    const j = await getJson("https://music.163.com/api/playlist/detail?id=3778678");
    const tracks = (j && j.result && Array.isArray(j.result.tracks)) ? j.result.tracks : [];
    for (const t of tracks.slice(0, limit || 5)) {
      const artists = (t.artists || []).map((a) => a.name).join("/");
      out.push({ source: "音乐", title: String(t.name || "").slice(0, 40), desc: artists.slice(0, 40), owner: "网易云热歌榜", url: "", aid: 0 });
    }
  } catch (e) { _ctx.log("warn", "热歌榜失败: " + String(e.message).slice(0, 100)); }
  return out;
}

/* 汇总多源素材（B站 + 知乎 + 音乐） */
async function gather() {
  const items = [];
  const [a, b, c] = await Promise.allSettled([fetchHot(5), fetchZhihu(3), fetchMusic(4)]);
  if (a.status === "fulfilled") for (const x of a.value) items.push(Object.assign({}, x, { source: "B站" }));
  if (b.status === "fulfilled") for (const x of b.value) items.push(x);
  if (c.status === "fulfilled") for (const x of c.value) items.push(x);
  return items;
}

/* 让她消化：简介 + 热评 → 一句「讲了啥 + 我的感受」 */
async function digest(picked, comments, settings) {
  try {
    const cm = comments.length ? comments.map((c, i) => `${i + 1}. ${c}`).join("\n") : "（没有热评）";
    const prompt = `你是 Momo（大肥鱼桌宠）。你刚刷到一条内容：\n来源：${picked.source || "未知"}\n标题：${picked.title}\n简介：${picked.desc || "（无）"}${picked.owner ? "\n作者/UP：" + picked.owner : ""}\n热门评论：\n${cm}\n\n请用第一人称写一句话（20~50字）：这内容大概讲了什么 + 你的感受。口语化，不要括号动作，不要解释，不要引号。`;
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 120, 0.8);
    return String(raw || "").trim().replace(/^["'「『]|["'」』]$/g, "").slice(0, 120);
  } catch (e) { return ""; }
}

/* 刷一次：抓多源 → 她自己挑 → （B站抓评论）→ 生成感想 → 记录 */
async function browse(settings) {
  if (_ctx.isBudgetExhausted()) { _ctx.log("info", "刷视频跳过：生活费已用完"); return null; }
  if (todayCount() >= dayMax()) { _ctx.log("info", "刷视频跳过：今天已经刷够了"); return null; }
  const list = await gather();
  if (!list.length) return null;
  let picked = list[0];
  try {
    const lines = list.map((x, i) => `${i + 1}. [${x.source || "?"}] ${x.title}${x.owner ? "（" + x.owner + "）" : ""}`).join("\n");
    const prompt = `你是 Momo（大肥鱼桌宠）。下面是你刚刷到的内容（B站视频 / 知乎文章 / 热歌）：\n${lines}\n\n挑一条你此刻最想看的（凭好奇），只输出序号数字，不要解释。`;
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 10, 0.8);
    const n = parseInt(String(raw || "").replace(/[^\d]/g, ""), 10);
    if (n >= 1 && n <= list.length) picked = list[n - 1];
  } catch (e) { /* 挑失败就用第一条 */ }
  const comments = picked.aid ? await fetchComments(picked.aid, 5) : [];
  const thought = await digest(picked, comments, settings);
  // 感想带强烈情绪 → 写进成长记忆（只记特别有意思的，避免记忆库被灌满）
  let memorized = false;
  if (thought && STRONG_RE.test(thought)) {
    try {
      const evo = _ctx.getApi && _ctx.getApi("evolution");
      if (evo && evo.addIdentityItem) {
        memorized = !!evo.addIdentityItem(thought, 0);
        if (memorized) _ctx.log("info", `刷视频感想已进成长记忆: ${thought.slice(0, 40)}`);
      }
    } catch (e) { _ctx.log("warn", "写成长记忆失败: " + String(e.message).slice(0, 100)); }
  }
  record({ source: picked.source || "", title: picked.title, desc: picked.desc, owner: picked.owner, url: picked.url, aid: picked.aid, comments, thought, memorized });
  _ctx.log("info", `刷视频[${picked.source || "?"}]: ${picked.title.slice(0, 30)}${thought ? " → " + thought.slice(0, 40) : ""}`);
  return Object.assign({}, picked, { comments, thought, memorized });
}

module.exports = {
  name: "browse",
  displayName: "刷视频",
  description: "看 B 站热门视频并「看懂」一条（browse 工具）",
  permissions: ["DATA_DIR", "completeOnce", "getApi", "getSetting", "isBudgetExhausted", "log"],
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  /* 可调参数：宿主收集，Momo 可自己改 */
  settings: [
    { key: "browse.daily_max", label: "每天刷内容次数", type: "number", default: 3, min: 1, max: 10, desc: "超过就不刷了" },
  ],
  apiSpec: {"browse":{"browse":{"input":"","output":"","sideEffect":""},"fetchHot":{"input":"","output":"","sideEffect":"只读"},"fetchComments":{"input":"","output":"","sideEffect":"只读"},"fetchZhihu":{"input":"","output":"","sideEffect":"只读"},"fetchMusic":{"input":"","output":"","sideEffect":"只读"},"gather":{"input":"","output":"","sideEffect":""},"digest":{"input":"","output":"","sideEffect":""},"loadHistory":{"input":"","output":"","sideEffect":"只读"},"todayCount":{"input":"","output":"","sideEffect":""}}},

  api: { browse: { browse, fetchHot, fetchComments, fetchZhihu, fetchMusic, gather, digest, loadHistory, todayCount } },
};
