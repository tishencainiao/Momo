#!/usr/bin/env node
/* 表情包语义标注：用现有云端视觉模型给表情包生成结构化语义（v1.54.0）
 * 输出字段：what 画面 / text_in_image 图上文字 / meaning 梗与语气 / usage 适用场景 /
 *          tags 语义标签 / annotate_confidence 置信度
 * 用法：
 *   node scripts/annotate-stickers.js --limit 5 --dry    # 只标 5 张，打印不写库
 *   node scripts/annotate-stickers.js --limit 5          # 标 5 张并写库
 *   node scripts/annotate-stickers.js                    # 标全部未标注的（跳过 manual_locked）
 *   node scripts/annotate-stickers.js --force            # 重标（仍跳过 manual_locked）
 *   node scripts/annotate-stickers.js --model xxx        # 指定视觉模型
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const store = require("../sticker-store");

const ROOT = path.join(__dirname, "..");
const DB_FILE = path.join(ROOT, "stickers", "stickers.db");
const TIER_DIRS = {
  builtin: path.join(ROOT, "stickers"),
  collected: path.join(ROOT, "stickers", "collected"),
  curated: path.join(ROOT, "stickers", "curated"),
};

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf("--" + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const LIMIT = Number(arg("limit", 0)) || 0;
const DRY = !!arg("dry", false);
const FORCE = !!arg("force", false);
const MODEL_OVERRIDE = arg("model", "");
const HASH_ONLY = !!arg("hash-only", false);

const PROMPT = `你是表情包（梗图）理解器。看这张图，输出严格 JSON（不要解释、不要代码块）：
{"what":"画面里画的是什么（≤40字）","text_in_image":"图上文字原样抄录，没有就空字符串","meaning":"这个表情包的梗/语气/潜台词（≤40字，第一人称视角更好）","usage":"适合在什么场景发（≤30字）","tags":["3~6个语义关键词，含情绪和场景"],"confidence":0.0~1.0（你对含义判断的把握）}
要求：
- text_in_image 必须忠实抄录，不要翻译不要编造
- meaning 说不准就写"不确定"，confidence 给低分，不要硬编
- tags 用中文，简短`;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")); } catch (e) { return {}; }
}
function apiKey() {
  try {
    const out = execFileSync(process.env.PYTHON || "python", [path.join(ROOT, "read_pet_key.py"), "--emit"], { encoding: "utf8", timeout: 20000 });
    const m = out.match(/SECRET=(.+)/);
    if (m) return m[1].trim();
  } catch (e) {}
  return process.env.DEEPSEEK_API_KEY || "";
}
function mimeOf(buf) {
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";              // RIFF
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  return "image/webp";
}
function imagePath(row) {
  const dir = TIER_DIRS[row.tier] || TIER_DIRS.builtin;
  const p = path.join(dir, row.fname);
  if (fs.existsSync(p)) return p;
  /* 兜底：全库搜索同名文件 */
  for (const d of Object.values(TIER_DIRS)) {
    const q = path.join(d, row.fname);
    if (fs.existsSync(q)) return q;
  }
  return null;
}

async function annotateOne(row, cfg, key) {
  const p = imagePath(row);
  if (!p) return { error: "找不到图片文件" };
  const buf = fs.readFileSync(p);
  if (buf.length > 8 * 1024 * 1024) return { error: "图片过大" };
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const vision = (cfg.chat && cfg.chat.vision) || {};
  const base = String(vision.base_url || (cfg.chat && cfg.chat.base_url) || "https://api.deepseek.com").replace(/\/+$/, "");
  const model = MODEL_OVERRIDE || vision.model || (cfg.chat && cfg.chat.model) || "deepseek-v4-flash";
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: [
      { type: "text", text: PROMPT },
      { type: "image_url", image_url: { url: "data:" + mimeOf(buf) + ";base64," + buf.toString("base64") } },
    ] }],
    stream: false, max_tokens: 800, temperature: 0.1, thinking: { type: "disabled" },
  });
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(base + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body,
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status + " " + (await resp.text()).slice(0, 160));
      const data = await resp.json();
      const text = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "");
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("模型没返回 JSON：" + text.slice(0, 100));
      const obj = JSON.parse(m[0]);
      const u = data.usage || {};
      return { obj, model, raw: text, hash, usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0, cached: u.prompt_cache_hit_tokens || 0 } };
    } catch (e) { lastErr = e; if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt)); }
  }
  return { error: lastErr ? lastErr.message : "未知错误" };
}

(async () => {
  const cfg = loadConfig();
  store.init(DB_FILE);
  const added = store.migrateStickerSchema();
  if (added) console.log(`✓ schema 已补 ${added} 列`);
  let rows = store.all().filter((r) => r.tier !== "trash");

  /* 只补图片 hash（本地计算，不调模型）：用于「对方发的表情包是否在库里」反查 */
  if (HASH_ONLY) {
    let n = 0;
    for (const row of rows) {
      const p = imagePath(row);
      if (!p) continue;
      const hash = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      if (row.imgHash === hash) continue;
      store.upsert(row.fname, { imgHash: hash });
      n++;
    }
    console.log(`✓ hash 补齐 ${n} 张（共 ${rows.length}）`);
    return;
  }

  const key = apiKey();
  if (!key) { console.error("✗ 没有读到 API Key"); process.exit(1); }
  if (!FORCE) rows = rows.filter((r) => !r.annotatedAt);
  rows = rows.filter((r) => !r.manualLocked);
  rows.sort((a, b) => String(a.fname).localeCompare(String(b.fname)));
  if (LIMIT) rows = rows.slice(0, LIMIT);
  if (!rows.length) { console.log("没有需要标注的条目"); return; }
  console.log(`开始标注 ${rows.length} 张（dry=${DRY}，模型=${MODEL_OVERRIDE || (cfg.chat && cfg.chat.vision && cfg.chat.vision.model) || "默认"}）`);
  let ok = 0, fail = 0;
  const usage = { in: 0, out: 0, cached: 0 };
  for (const row of rows) {
    const r = await annotateOne(row, cfg, key);
    if (r.error) { fail++; console.log(`✗ ${row.fname}：${r.error}`); continue; }
    if (r.usage) { usage.in += r.usage.in; usage.out += r.usage.out; usage.cached += r.usage.cached; }
    const o = r.obj || {};
    const tags = Array.isArray(o.tags) ? o.tags.map((t) => String(t).slice(0, 20)).slice(0, 8) : [];
    const patch = {
      what: String(o.what || "").slice(0, 120),
      textInImage: String(o.text_in_image || "").slice(0, 120),
      meaning: String(o.meaning || "").slice(0, 120),
      usage: String(o.usage || "").slice(0, 80),
      tags: JSON.stringify(tags),
      annotateConfidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)),
      annotatedAt: Date.now(),
      annotateModel: r.model,
      annotateStatus: (Number(o.confidence) || 0) < 0.6 || !o.meaning || o.meaning === "不确定" ? "low_conf" : "ok",
      imgHash: r.hash || "",
    };
    if (DRY) {
      console.log(`\n${row.fname}\n  画面：${patch.what}\n  图上字：${patch.textInImage || "（无）"}\n  含义：${patch.meaning}\n  场景：${patch.usage}\n  标签：${tags.join("、")}\n  置信：${patch.annotateConfidence} → ${patch.annotateStatus}`);
    } else {
      const saved = store.upsert(row.fname, patch);
      console.log(`${saved ? "✓" : "✗"} ${row.fname} → ${patch.annotateStatus}（置信 ${patch.annotateConfidence}，含义：${patch.meaning.slice(0, 24)}）`);
      if (saved) ok++;
    }
  }
  if (!DRY) {
    store.setKV("stickerAnnotate.lastRun", JSON.stringify({ ts: Date.now(), ok, fail, total: rows.length, usage }));
    console.log(`\n完成：成功 ${ok} / 失败 ${fail}（共 ${rows.length}）`);
  }
  console.log(`Token 用量：入 ${usage.in} / 出 ${usage.out}（缓存命中 ${usage.cached}）`);
})().catch((e) => { console.error("✗ 标注脚本异常：" + e.message); process.exit(1); });
