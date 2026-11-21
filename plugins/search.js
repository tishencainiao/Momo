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
  let results = parseBingHtml(await httpsGet(qs(query), 15000), limit);
  /* 兜底：必应对「王洋律师 离谱 案件」这类多词查询偶尔退化成单字字典页（结果全是「拼音/汉字」词条）。
     检测到字典结果过半时，改用查询里最长的一段重试一次（多词查询里最长段通常是核心词）。 */
  if (isDictDominated(results)) {
    const parts = String(query).split(/\s+/).filter(Boolean);
    const best = parts.reduce((a, b) => (b.length > a.length ? b : a), "");
    if (best && best !== query) {
      const r2 = parseBingHtml(await httpsGet(qs(best), 15000), limit);
      if (r2.length) results = r2;
    }
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
  version: "1.2.0",
  description: "必应国内版网页搜索（cn.bing.com 抓取，零 key 零成本）+ 百度解析（备用）",
  userScoped: false,
  permissions: ["UA", "cleanText", "sleep"],
  init(ctx) { _ctx = ctx; },
  apiSpec: {"search":{"parseBaiduHtml":{"input":"html","output":"[{title,url,snippet}]","sideEffect":"无"},"parseBingHtml":{"input":"html","output":"[{title,url,snippet}]","sideEffect":"无"},"formatResults":{"input":"results, n","output":"string","sideEffect":"无"},"isDictDominated":{"input":"results","output":"bool","sideEffect":"无"},"baiduSearch":{"input":"q, n","output":"[result]","sideEffect":"联网"},"bingSearch":{"input":"q, n","output":"[result]","sideEffect":"联网(免费)"},"httpsGet":{"input":"url, opt","output":"text","sideEffect":"联网"}}},

  api: { search: { parseBaiduHtml, parseBingHtml, formatResults, isDictDominated, baiduSearch, bingSearch, httpsGet } },
};
