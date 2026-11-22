/* 插件：搜索 —— 必应国内版网页搜索（cn.bing.com 抓取，零 key 零成本）+ 百度解析（备用，M7/B1阶段2）
 * 供 web_search 工具、进化探索等经 ctx/api 调用。
 * 依赖（经 ctx 注入）：cleanText、UA、sleep、log。 */
const https = require("https");
let _ctx = null;

function parseBaiduHtml(html, limit) {
  const results = [];
  const seen = new Set();
  const chunks = html.split(/(?=<div[^>]*class="result(?:-op)? c-container")/).slice(1);
  for (const chunk of chunks) {
    const mu = chunk.slice(0, 2000).match(/\bmu="([^"]*)"/);
    const h3 = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!mu || !h3) continue;
    let url = mu[1].replace(/&amp;/g, "&").trim();
    let host = ""; try { host = new URL(url).hostname; } catch (e) {}
    if (!url.startsWith("http") || url.includes("nourl") || seen.has(url) || (host.endsWith("baidu.com") && (url.includes("/s?") || host.includes("recommend")))) continue;
    const title = _ctx.cleanText(h3[1]);
    let snippet = _ctx.cleanText(chunk.slice(h3.index + h3[0].length, h3.index + h3[0].length + 8000));
    snippet = snippet.split(/"\}|"clamp"|\{"/)[0].trim().slice(0, 300);
    if (!title) continue;
    seen.add(url);
    results.push({ title, url, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

/* 必应国内版（cn.bing.com）结果块：<li class="b_algo"> 内 <h2><a href>标题</a></h2> + <p>摘要</p> */
function parseBingHtml(html, limit) {
  const results = [];
  const seen = new Set();
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const a = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, "&").trim();
    if (!url.startsWith("http") || seen.has(url)) continue;
    const title = _ctx.cleanText(a[2]);
    if (!title) continue;
    let snippet = "";
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (p) snippet = _ctx.cleanText(p[1]).trim().slice(0, 300);
    seen.add(url);
    results.push({ title, url, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

function formatResults(query, results) {
  if (!results.length) return `搜索「${query}」没有找到结果。`;
  const lines = [`搜索「${query}」的结果：`];
  results.forEach((r, i) => lines.push(`[${i + 1}] ${r.title}\n链接：${r.url}\n摘要：${r.snippet || "（无）"}`));
  return lines.join("\n\n");
}
async function baiduSearch(query, limit) {
  const url = "https://www.baidu.com/s?ie=utf-8&wd=" + encodeURIComponent(query);
  const html = await httpsGet(url, 15000);
  if (html.includes("wappass.baidu.com") || html.includes("百度安全验证")) throw new Error("百度要求人机验证，请稍后重试");
  return parseBaiduHtml(html, limit);
}
/* 字典退化特征：必应对多词中文查询偶发退化成单字字典页（拼音/汉字释义/姓氏/汉典词条）。
   判定=命中特征的结果过半（宽于旧的「全含拼音」——退化页常混有「王姓/王者荣耀」等未命中项导致兜底失效）。
   标题与摘要分别取前 60 字窗口——摘要往往很长，拼接后会把标题里的特征挤出窗口。 */
const DICT_FEATURES = ["拼音", "（汉语文字）", "姓（中华姓氏）", "的意思与解释", "汉典", "字典"];
function isStubDominated(results, query) {
  /* 砍词退化：必应偶发把长查询砍成头两字（「猫咪翻车现场」→「猫咪」），返回百科 stub 页+垃圾站群。
     判定=查询去空格取 2 字滑窗，过半结果命中滑窗 < 1/3 即退化（正常结果至少吃到核心词）。
     查询 < 4 字或无结果/单条不判。 */
  const q = String(query || "").replace(/\s+/g, "");
  if (q.length < 4) return false;
  if (!Array.isArray(results) || results.length < 2) return false;
  const grams = [];
  for (let i = 0; i + 2 <= q.length; i++) {
    const g = q.slice(i, i + 2);
    if (grams.indexOf(g) < 0) grams.push(g);
  }
  if (!grams.length) return false;
  let bad = 0;
  for (const r of results) {
    const text = String(r.title || "") + " " + String(r.snippet || "").slice(0, 40);
    let hit = 0;
    for (const g of grams) if (text.indexOf(g) >= 0) hit++;
    if (hit / grams.length < 1 / 3) bad++;
  }
  return bad * 2 >= results.length;
}
function isDictDominated(results) {
  if (!Array.isArray(results) || results.length === 0) return false;
  let hit = 0;
  for (const r of results) {
    const ts = String(r.title || "").slice(0, 60);
    const ss = String(r.snippet || "").slice(0, 60);
    if (DICT_FEATURES.some((f) => ts.includes(f) || ss.includes(f))) hit++;
  }
  return hit * 2 >= results.length;
}
async function bingSearch(query, limit) {
  const qs = (q) => "https://cn.bing.com/search?q=" + encodeURIComponent(q) + "&setlang=zh-CN&count=" + (limit || 10);
  const degraded = (r, q) => isDictDominated(r) || isStubDominated(r, q);
  let results = parseBingHtml(await httpsGet(qs(query), 15000), limit);
  /* 兜底一：字典退化（多词查询被拆成单字字典页）→ 用最长空格段重试。
     兜底二：砍词退化（长查询被砍成头两字、返回百科 stub/垃圾站群）→ 无空格查询切掉头 2 字重试（「猫咪翻车现场」→「翻车现场」），
     至多再切一次（去头 4 字）。重试仍退化 → 返回空数组（web_search 显示「没有搜到结果」，不把垃圾喂给模型）。 */
  if (degraded(results, query)) {
    const cands = [];
    const parts = String(query).split(/\s+/).filter(Boolean);
    const best = parts.reduce((a, b) => (b.length > a.length ? b : a), "");
    if (best && best !== query) cands.push(best);
    const q0 = String(query).replace(/\s+/g, "");
    if (parts.length <= 1) {
      if (q0.length > 4) cands.push(q0.slice(2));
      if (q0.length > 6) cands.push(q0.slice(4));
    }
    let usedQ = query;
    for (const c of cands) {
      try {
        const r2 = parseBingHtml(await httpsGet(qs(c), 15000), limit);
        if (r2.length && !degraded(r2, c)) { results = r2; usedQ = c; break; }
      } catch (e) { /* 单个候选失败继续下一个 */ }
    }
    /* 注意：替换后必须用 usedQ 复判（重试成功的「翻车现场」结果对原始查询仍会误判退化） */
    if (degraded(results, usedQ)) results = [];
  }
  return results;
}
function httpsGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent": _ctx.UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "zh-CN,zh;q=0.9" },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("timeout", () => req.destroy(new Error("搜索连接超时")));
    req.on("error", reject);
  });
}

module.exports = {
  name: "search",
  displayName: "搜索",
  version: "1.3.0",
  description: "必应国内版网页搜索（cn.bing.com 抓取，零 key 零成本）+ 百度解析（备用）",
  userScoped: false,
  permissions: ["UA", "cleanText", "sleep"],
  init(ctx) { _ctx = ctx; },
  apiSpec: {"search":{"parseBaiduHtml":{"input":"html","output":"[{title,url,snippet}]","sideEffect":"无"},"parseBingHtml":{"input":"html","output":"[{title,url,snippet}]","sideEffect":"无"},"formatResults":{"input":"results, n","output":"string","sideEffect":"无"},"isDictDominated":{"input":"results","output":"bool","sideEffect":"无"},"isStubDominated":{"input":"results, query","output":"bool","sideEffect":"无"},"baiduSearch":{"input":"q, n","output":"[result]","sideEffect":"联网"},"bingSearch":{"input":"q, n","output":"[result]","sideEffect":"联网(免费)"},"httpsGet":{"input":"url, opt","output":"text","sideEffect":"联网"}}},

  api: { search: { parseBaiduHtml, parseBingHtml, formatResults, isDictDominated, isStubDominated, baiduSearch, bingSearch, httpsGet } },
};
