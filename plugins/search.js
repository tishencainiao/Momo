/* 插件：搜索 —— 百度网页搜索 + 博查 API 搜索（从内核下沉的能力，M7/B1阶段2）
 * 供 web_search 工具、进化探索等经 ctx/api 调用。
 * 依赖（经 ctx 注入）：cleanText、UA、sleep、recordSpend、budgetCfg、log、bochaKey（调用方传 key）。 */
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
function httpsGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent": _ctx.UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "zh-CN,zh;q=0.9" },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`百度 HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("timeout", () => req.destroy(new Error("百度连接超时")));
    req.on("error", reject);
  });
}
async function bochaSearch(query, limit, key) {
  const url = "https://api.bochaai.com/v1/web-search";
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({ query, summary: true, count: limit, freshness: "noLimit" }),
        signal: controller.signal,
      });
      if (!resp.ok) { let d = ""; try { d = (await resp.text()).slice(0, 200); } catch (e) {} throw new Error(`博查 HTTP ${resp.status}: ${d}`); }
      const data = await resp.json();
      const pages = ((((data || {}).data || {}).webPages || {}).value || []);
      _ctx.recordSpend("search", 0, 0, 0, _ctx.budgetCfg().search_cny);
      return pages
        .filter((p) => p && typeof p === "object")
        .map((p) => ({ title: String(p.name || ""), url: String(p.url || ""), snippet: String(p.summary || p.snippet || "").slice(0, 600) }))
        .slice(0, limit);
    } catch (e) {
      lastErr = e;
      if (attempt < 3) { await _ctx.sleep(1500 * attempt); continue; }
    } finally { clearTimeout(timer); }
  }
  throw lastErr || new Error("fetch failed");
}

module.exports = {
  name: "search",
  init(ctx) { _ctx = ctx; },
  api: { search: { parseBaiduHtml, formatResults, baiduSearch, httpsGet, bochaSearch } },
};
