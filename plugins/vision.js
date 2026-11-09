/* 插件：视觉 —— 图片识别 / 下载 / MIME 嗅探（从内核下沉的能力，M7/B1阶段2）
 * 供表情包/图片消息识别、桌面识屏（pet-body 经 ctx.describeImageFile）等调用。
 * 依赖（经 ctx 注入）：config、apiKey、settings、sleep、recordSpend、estimateTokens、maybeCollect、log、UA。 */
const fs = require("fs");
let _ctx = null;

function visionModel(settings) {
  const v = (_ctx.config.chat && _ctx.config.chat.vision) || {};
  return String(v.model || "").trim() || settings.model;
}
function mimeOf(buf) {
  if (buf.length >= 3 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return "image/png";
  if (buf.length >= 6) { const h = buf.slice(0, 6).toString("latin1"); if (h === "GIF87a" || h === "GIF89a") return "image/gif"; }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length >= 12 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "image/png";
}
async function httpGetBytes(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": _ctx.UA } });
      if (resp.ok) return Buffer.from(await resp.arrayBuffer());
      if (resp.status === 403 || resp.status === 404) throw new Error(`HTTP ${resp.status}`);
    } catch (e) { lastErr = e; if (attempt < 3) { await _ctx.sleep(1200 * attempt); continue; } }
  }
  throw lastErr || new Error("下载失败");
}
async function imageBytes(image) {
  // 1) 本地文件
  if (image.file) { try { if (fs.existsSync(image.file)) return fs.readFileSync(image.file); } catch (e) {} }
  // 2) OneBot get_image 接口（用机器人会话取图，最可靠）
  if (image.file) {
    try {
      const http = (_ctx.config.onebot && _ctx.config.onebot.http_url) || "http://127.0.0.1:3000";
      const r = await fetch(http + "/get_image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: image.file }) });
      if (r.ok) {
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("json")) {
          const j = await r.json().catch(() => ({}));
          const d = (j && j.data) || {};
          if (d.file && fs.existsSync(d.file)) return fs.readFileSync(d.file);
          if (d.path && fs.existsSync(d.path)) return fs.readFileSync(d.path);
          if (d.base64) return Buffer.from(d.base64, "base64");
          if (d.url) { try { return await httpGetBytes(d.url); } catch (e) {} }
          _ctx.log("info", "get_image JSON 响应: " + JSON.stringify(j).slice(0, 300));
        } else {
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 32) return buf;
        }
      } else {
        _ctx.log("info", "get_image HTTP " + r.status);
      }
    } catch (e) { _ctx.log("info", "get_image 失败: " + e.message.slice(0, 120)); }
  }
  // 3) 直连 url
  if (image.url) { try { return await httpGetBytes(image.url); } catch (e) { _ctx.log("info", "直连图片 url 失败: " + e.message.slice(0, 120)); } }
  throw new Error("无法获取图片数据");
}
async function describeImage(image, settings) {
  const vcfg = (_ctx.config.chat && _ctx.config.chat.vision) || {};
  if (vcfg.enabled === false) return null;
  const buf = await imageBytes(image);
  if (buf.length < 32) throw new Error("图片数据异常");
  if (buf.length > 8 * 1024 * 1024) throw new Error("图片过大(>8MB)");
  const dataUrl = "data:" + mimeOf(buf) + ";base64," + buf.toString("base64");
  const endpoint = (vcfg.base_url || settings.base_url).replace(/\/+$/, "") + "/v1/chat/completions";
  const body = JSON.stringify({
    model: visionModel(settings),
    messages: [{ role: "user", content: [
      { type: "text", text: "请用简洁中文描述这张图：1) 内容（画面里是什么、图中文字）；2) 它想表达的情绪/态度（如开心、委屈、撒娇、安慰、嘲讽、赞同、生气等）。合成一句不超过 80 字的话，重点说清情绪。" },
      { type: "image_url", image_url: { url: dataUrl } },
    ] }],
    stream: false, max_tokens: 1000, temperature: 0.2,
    thinking: { type: "disabled" },
  });
  let resp = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + _ctx.apiKey },
        body,
        signal: AbortSignal.timeout(25000),
      });
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      await _ctx.sleep(1500);
    }
  }
  if (!resp.ok) { let d = ""; try { d = (await resp.text()).slice(0, 200); } catch (e) {} throw new Error(`视觉 HTTP ${resp.status}: ${d}`); }
  const data = await resp.json();
  let desc = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  const u = data.usage || null;
  _ctx.recordSpend("vision", u ? (u.prompt_cache_miss_tokens || (u.prompt_tokens || 0)) : _ctx.estimateTokens(JSON.stringify(body)), u ? (u.completion_tokens || 0) : _ctx.estimateTokens(desc), u ? (u.prompt_cache_hit_tokens || 0) : 0);
  if (desc) {
    // 收图状态要告诉她，否则她会以为自己存不下来
    const r = _ctx.maybeCollect(buf, desc);
    if (r && r.ok) desc = desc + (r.duplicate ? "（这张之前就收过，已在表情包库里）" : "（这张已自动收进表情包库）");
    else if (r && r.reason) desc = desc + `（这次没收进库：${r.reason}）`;
  }
  return desc;
}
async function describeImageFile(filePath, prompt) {
  const vcfg = (_ctx.config.chat && _ctx.config.chat.vision) || {};
  if (vcfg.enabled === false) throw new Error("视觉功能被关掉了（config.chat.vision.enabled=false）");
  const p = String(filePath || "");
  if (!p || !fs.existsSync(p)) throw new Error("图片文件不存在");
  const buf = fs.readFileSync(p);
  if (buf.length < 32) throw new Error("图片数据异常");
  if (buf.length > 8 * 1024 * 1024) throw new Error("图片过大(>8MB)");
  const settings = _ctx.settings();
  const dataUrl = "data:" + mimeOf(buf) + ";base64," + buf.toString("base64");
  const endpoint = ((vcfg.base_url || settings.base_url) || "https://api.deepseek.com").replace(/\/+$/, "") + "/v1/chat/completions";
  const body = JSON.stringify({
    model: visionModel(settings),
    messages: [{ role: "user", content: [
      { type: "text", text: String(prompt || "用简洁中文描述画面内容，重点说清主人在做什么。").slice(0, 600) },
      { type: "image_url", image_url: { url: dataUrl } },
    ] }],
    stream: false, max_tokens: 500, temperature: 0.3,
    thinking: { type: "disabled" },
  });
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + _ctx.apiKey },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    let d = "";
    try { d = (await resp.text()).slice(0, 200); } catch (e) {}
    throw new Error("视觉 HTTP " + resp.status + ": " + d);
  }
  const data = await resp.json();
  const desc = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  const u = data.usage || null;
  _ctx.recordSpend("vision", u ? (u.prompt_cache_miss_tokens || (u.prompt_tokens || 0)) : _ctx.estimateTokens(JSON.stringify(body)),
    u ? (u.completion_tokens || 0) : _ctx.estimateTokens(desc), u ? (u.prompt_cache_hit_tokens || 0) : 0);
  return String(desc).trim();
}

module.exports = {
  name: "vision",
  displayName: "视觉",
  version: "1.0.0",
  description: "图片识别/下载/MIME 嗅探（M7 下沉）",
  permissions: ["UA", "apiKey", "config", "describeImageFile", "estimateTokens", "log", "maybeCollect", "recordSpend", "settings", "sleep"],
  init(ctx) { _ctx = ctx; },
  apiSpec: {"vision":{"visionModel":{"input":"无","output":"模型名","sideEffect":"只读"},"mimeOf":{"input":"bytes","output":"mime","sideEffect":"只读"},"httpGetBytes":{"input":"url","output":"buffer","sideEffect":"联网"},"imageBytes":{"input":"path","output":"buffer","sideEffect":"读文件"},"describeImage":{"input":"url, prompt","output":"描述","sideEffect":"联网+花钱"},"describeImageFile":{"input":"path, prompt","output":"描述","sideEffect":"花钱"}}},

  api: { vision: { visionModel, mimeOf, httpGetBytes, imageBytes, describeImage, describeImageFile } },
};
