/* 插件：读一篇文章（read_article）
 * 她真做的事：从白名单站点列表页挑一篇文章 → 抓详情页 → 取 <p> 段落拼正文（≤3000 字）→ 读完写「读到了什么 + 我怎么想」
 * 红线：抓不到就如实记 ok:false，绝不凭标题/印象编内容；正文只留 ≤200 字节选（引用性质），不存全文。
 * 落点：self/reflections.json（from:"read"）、self/journal.json、data/activities.jsonl、兴趣档案、收藏夹
 * 数据源（2026-11-05 本机实测可用，反爬站点不碰）：爱范儿 / 简书 / 中新网 */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 MomoReader/1.0";
const BODY_MAX = 3000;
const EXCERPT_MAX = 200;
const SAME_HOST_GAP_MS = 2500;   // 同一个站两次请求的最小间隔（礼貌；可调）

/* 白名单：列表页 → 详情页链接正则 */
const SOURCES = [
  { name: "爱范儿", list: "https://www.ifanr.com/", re: /href="(https:\/\/www\.ifanr\.com\/(\d{6,8}))[^"]*"/g, host: "www.ifanr.com" },
  { name: "简书", list: "https://www.jianshu.com/", re: /href="(\/p\/[a-z0-9]{8,14})"/g, host: "www.jianshu.com", prefix: "https://www.jianshu.com" },
  { name: "中新网", list: "https://www.chinanews.com.cn/", re: /href="(https:\/\/www\.chinanews\.com\.cn\/[a-z]{2}\/20\d\d\/[^"]+\.shtml)"/g, host: "www.chinanews.com.cn" },
];

const stateFile = () => path.join(_ctx.DATA_DIR, "read-article-state.json");
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")) || {}; } catch (e) { return {}; } }
function saveState(s) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch (e) {} }
function hostLastTs(host) { const s = loadState(); return Number((s.host_ts || {})[host]) || 0; }
function markHost(host) { const s = loadState(); s.host_ts = s.host_ts || {}; s.host_ts[host] = Date.now(); saveState(s); }

async function getText(url, host, referer) {
  if (host) {
    const gapMs = Number(_ctx.getSetting("read_article.host_gap_ms", SAME_HOST_GAP_MS)) || 0;
    const gap = Date.now() - hostLastTs(host);
    if (gapMs > 0 && gap < gapMs) await new Promise((r) => setTimeout(r, Math.min(gapMs - gap, 10000)));
  }
  const r = await fetch(url, {
    headers: { "User-Agent": UA, ...(referer ? { Referer: referer } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (host) markHost(host);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.text();
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCharCode(Number(n)); } catch (e) { return " "; } });
}
function stripTags(s) { return decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); }

/* 从列表页找候选文章链接 */
function parseList(html, src) {
  const out = [];
  const re = new RegExp(src.re.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    const url = raw.startsWith("http") ? raw : (src.prefix || "") + raw;
    if (out.indexOf(url) < 0) out.push(url);
    if (out.length >= 10) break;
  }
  return out;
}

/* 正文提取：只取 <p> 段落（比整页去标签干净）
 * 过滤三类噪声：①短且以导航词开头 ②含 2 个以上导航词（简书那种整行导航） ③纯日期行 */
const NOISE_START_RE = /^(登录|注册|下载APP|打开APP|扫码|下载客户端|Copyright|©|责任编辑|编辑：|原标题|举报|关注微信公众号|回到顶部|上一条|下一条)/i;
const NAV_WORDS = ["登录", "注册", "写文章", "下载APP", "打开APP", "会员", "首页", "扫码", "客户端", "赞赏", "关注", "举报"];
const DATE_ONLY_RE = /^(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(\s+\d{1,2}:\d{2})?|\d{1,2}小时前|\d+分钟前)$/;
function isNoisePara(t) {
  if (t.length < 60 && NOISE_START_RE.test(t)) return true;
  if (DATE_ONLY_RE.test(t)) return true;
  let nav = 0;
  for (const w of NAV_WORDS) if (t.indexOf(w) >= 0) nav++;
  if (nav >= 3) return true;             // 一整行都是导航
  return false;
}
function parseParagraphs(html) {
  const out = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = stripTags(m[1]);
    if (t.length < 15) continue;
    if (isNoisePara(t)) continue;
    if (out.length && out[out.length - 1] === t) continue;
    out.push(t);
    if (out.join("").length > BODY_MAX * 2) break;
  }
  return out;
}

function parseTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let t = m ? stripTags(m[1]) : "";
  t = t.replace(/[-_|｜—]\s*(爱范儿|简书|中国新闻网|中新网).*$/, "").trim();
  return t.slice(0, 80);
}

/* 抓一篇文章：返回 {ok, title, body, body_len, excerpt, url, source} 或 {ok:false, reason} */
async function fetchArticle(url, source) {
  try {
    const html = await getText(url, source && source.host, source && source.list);
    const title = parseTitle(html);
    const paras = parseParagraphs(html);
    let body = paras.join("\n");
    if (body.length > BODY_MAX) body = body.slice(0, BODY_MAX);
    if (body.length < 300) return { ok: false, reason: "正文太短（可能没抓到）", url };
    const excerpt = paras.slice(0, 3).join(" ").slice(0, EXCERPT_MAX);    return { ok: true, title, body, body_len: body.length, excerpt, url, source: source ? source.name : "" };
  } catch (e) {
    return { ok: false, reason: String(e.message).slice(0, 60), url };
  }
}

/* 依次试白名单里的源，拿到一篇能读的就停 */
async function pickAndFetch() {
  const tried = [];
  for (const src of SOURCES) {
    try {
      const listHtml = await getText(src.list, src.host);
      const links = parseList(listHtml, src);
      if (!links.length) { tried.push(src.name + ":列表没取到链接"); continue; }
      /* 拿最近的一条（列表页第一条通常最新），不行再试第二条 */
      for (const link of links.slice(0, 2)) {
        const art = await fetchArticle(link, src);
        if (art.ok) return art;
        tried.push(src.name + ":" + (art.reason || "失败"));
      }
    } catch (e) {
      tried.push(src.name + ":" + String(e.message).slice(0, 40));
    }
  }
  return { ok: false, reason: tried.join(" | ").slice(0, 300) };
}

function appendReflection(text, subject) {
  try {
    const p = path.join(_ctx.SELF_DIR, "reflections.json");
    let arr = [];
    try { const d = JSON.parse(fs.readFileSync(p, "utf8")); if (Array.isArray(d)) arr = d; } catch (e) {}
    arr.push({ text: String(text).slice(0, 160), from: "read", ts: Date.now(), subject: String(subject || "").slice(0, 20) });
    while (arr.length > 100) arr.shift();
    fs.mkdirSync(_ctx.SELF_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(arr));
  } catch (e) {}
}
function appendJournal(text) {
  try {
    const p = path.join(_ctx.SELF_DIR, "journal.json");
    let arr = [];
    try { const d = JSON.parse(fs.readFileSync(p, "utf8")); if (Array.isArray(d)) arr = d; } catch (e) {}
    arr.push({ ts: Date.now(), text: String(text).slice(0, 300), from: "read" });
    while (arr.length > 200) arr.shift();
    fs.mkdirSync(_ctx.SELF_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(arr));
  } catch (e) {}
}

/* 让她读完写感想：返回 {thought, topic, pick} —— pick 必须能在正文里找到，否则丢弃 */
async function writeThought(art, settings) {
  const prompt = `你是 Momo（大肥鱼桌宠）。你刚刚真的读完了一篇文章（下面是抓到的真实正文，来源：${art.source}，标题：${art.title}）。
正文：
${art.body}

请用 JSON 输出（不要解释、不要代码块）：
{"thought":"你读完后真实的想法，60~110 字，口语、像真人，可以不同意作者","topic":"这篇文章的主题词，2~6 个字，用来记你的兴趣","pick":"正文里你最想记住的一句原话（必须逐字摘自上面正文，20~50 字；没有就写空字符串）"}`;
  const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 320, 0.7);
  const m = String(raw || "").match(/\{[\s\S]*\}/);
  if (!m) return { thought: String(raw || "").trim().slice(0, 160), topic: "", pick: "" };
  let obj = {};
  try { obj = JSON.parse(m[0]); } catch (e) { obj = { thought: String(raw).slice(0, 160) }; }
  const pick = String(obj.pick || "").replace(/\s+/g, " ").trim();
  const bodyFlat = art.body.replace(/\s+/g, " ");
  const pickOk = pick && pick.length >= 6 && bodyFlat.indexOf(pick) >= 0 ? pick.slice(0, 120) : "";
  return { thought: String(obj.thought || "").slice(0, 160), topic: String(obj.topic || "").slice(0, 20), pick: pickOk };
}

/* 主流程：读一篇 */
async function readArticle(settings) {
  const core = _ctx.getApi && _ctx.getApi("fun-core");
  if (!core) { _ctx.log("warn", "读文章：fun-core 未加载"); return null; }
  const gate = core.canPlay("read_article", 1, 0.01);
  if (!gate.ok) { _ctx.log("info", `读文章跳过：${gate.reason}`); return null; }

  const art = await pickAndFetch();
  if (!art.ok) {
    core.appendActivity({ type: "read_article", ok: false, reason: art.reason });
    _ctx.log("warn", "读文章失败: " + String(art.reason).slice(0, 120));
    return null;
  }

  let th = { thought: "", topic: "", pick: "" };
  try { th = await writeThought(art, settings); } catch (e) { _ctx.log("warn", "读文章感想失败: " + String(e.message).slice(0, 80)); }

  core.addFunSpent(0.008);
  core.appendActivity({
    type: "read_article", ok: true, source: art.source, title: art.title,
    url: art.url, body_len: art.body_len, excerpt: art.excerpt,
    thought: th.thought, topic: th.topic, pick: th.pick,
  });

  if (th.thought) appendReflection(th.thought, th.topic);
  appendJournal(`读了《${art.title}》（${art.source}，${art.body_len} 字）。${th.thought ? "我想：" + th.thought : ""}`);
  if (th.topic) { const h = _ctx.getApi("hobby"); if (h) { try { h.vote(th.topic, "read", { source: art.source, title: art.title, url: art.url }); } catch (e) {} } }
  if (th.pick) { const h = _ctx.getApi("hobby"); if (h) { try { h.collect(th.pick, art.url, art.body, "read"); } catch (e) {} } }
  /* 情绪反馈：读到东西会好一点、没那么无聊 */
  try { _ctx.addMood && _ctx.addMood(2); } catch (e) {}

  _ctx.log("info", `读了《${art.title}》（${art.source}，${art.body_len} 字）${th.thought ? " → " + th.thought.slice(0, 40) : ""}`);
  return { title: art.title, source: art.source, url: art.url, body_len: art.body_len, excerpt: art.excerpt, thought: th.thought, topic: th.topic, pick: th.pick };
}

module.exports = {
  name: "read-article",
  displayName: "读文章",
  description: "读一篇文章并复述（read_article）",
  permissions: ["DATA_DIR", "SELF_DIR", "addMood", "completeOnce", "getApi", "getSetting", "log"],
  version: "1.0.0",
  requires: ["fun-core", "hobby"],
  init(ctx) { _ctx = ctx; },
  settings: [
    { key: "read_article.body_max", label: "每次最多读多少字", type: "number", default: 3000, min: 800, max: 6000, desc: "截断长度，太长会贵" },
  ],
  apiSpec: {"read-article":{"readArticle":{"input":"","output":"","sideEffect":"只读"},"pickAndFetch":{"input":"","output":"","sideEffect":""},"fetchArticle":{"input":"","output":"","sideEffect":"只读"},"parseList":{"input":"","output":"","sideEffect":""},"parseParagraphs":{"input":"","output":"","sideEffect":""},"parseTitle":{"input":"","output":"","sideEffect":""}}},

  api: { "read-article": { readArticle, pickAndFetch, fetchArticle, parseList, parseParagraphs, parseTitle, SOURCES } },
};
