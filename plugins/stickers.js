/* 插件：表情包（v2.0.0，v1.46.0 起接入语义库）
 *
 * 职责分层：
 *   - 磁盘：stickers/ 四个目录决定「有哪些图、属于哪一层」
 *   - 语义库：sticker-store.js（sqlite）决定「这张图什么意思、能不能主动发、教过没有」
 *
 * 参照开源实现：
 *   - meme-pilot：稳定公开 ID（b.003 / c.xxxx / k.001），所有指代都用 ID
 *   - nonebot-plugin-personification：受控标签词表 + 生命周期 + 手动锁定最高优先级
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("../sticker-store");

let _ctx = null;

const STICKER_DIR = path.join(__dirname, "..", "stickers");
const STICKER_COLLECT_DIR = path.join(STICKER_DIR, "collected");
const STICKER_CURATED_DIR = path.join(STICKER_DIR, "curated");
const STICKER_TRASH_DIR = path.join(STICKER_DIR, "trash");
const LAST_COLLECTED_FILE = path.join(STICKER_DIR, "last-collected.json");
const MAINTAIN_LOG_FILE = path.join(STICKER_DIR, "maintain-log.json");
const DB_FILE = path.join(STICKER_DIR, "stickers.db");
const IMG_RE = /\.(webp|jpg|jpeg|png|gif)$/i;
const STICKER_MAX_COLLECT = 200;

/* ---------- 设置（带默认值）---------- */
function cfgNum(key, dflt) {
  try {
    const v = Number(_ctx && _ctx.getSetting ? _ctx.getSetting(key, dflt) : dflt);
    return Number.isFinite(v) ? v : dflt;
  } catch (e) { return dflt; }
}

/* ---------- 初始化 + 迁移 ---------- */
function scanFiles() {
  const dirs = [
    [STICKER_DIR, "builtin"],
    [STICKER_COLLECT_DIR, "collected"],
    [STICKER_CURATED_DIR, "curated"],
    [STICKER_TRASH_DIR, "trash"],
  ];
  const out = [];
  for (const [d, t] of dirs) {
    let es = [];
    try { es = fs.readdirSync(d); } catch (e) { continue; }
    for (const f of es) if (IMG_RE.test(f)) out.push({ fname: f, tier: t });
  }
  return out;
}

function initStore() {
  if (store.ready()) return;
  /* 允许宿主/测试覆盖库文件位置 */
  const dbFile = (_ctx && _ctx.STICKER_DB) || DB_FILE;
  store.init(dbFile);
  const files = scanFiles();
  /* 首次迁移：把 meta.json / desc.json / taught.json 里的语义灌进来，JSON 备份后转只读 */
  const metaFile = path.join(STICKER_DIR, "meta.json");
  const backup = path.join(STICKER_DIR, "meta.pre-v146.json");
  const firstTime = !store.getKV("migrated_v146", "");
  const taughtFile = (_ctx && _ctx.DATA_DIR) ? path.join(_ctx.DATA_DIR, "taught.json") : "";
  try {
    const r = store.migrate({
      files,
      metaFile,
      descFile: path.join(STICKER_COLLECT_DIR, "desc.json"),
      taughtFile,
    });
    if (r && (r.imported || r.skipped)) _ctx.log("info", `表情包语义库就绪：${store.all().length} 条（迁移新增 ${r.imported}）`);
    if (firstTime && fs.existsSync(metaFile) && !fs.existsSync(backup)) {
      try { fs.copyFileSync(metaFile, backup); _ctx.log("info", `已备份旧 meta.json → ${path.basename(backup)}`); } catch (e) {}
    }
  } catch (e) { _ctx.log("warn", "表情包语义库迁移失败: " + String(e.message).slice(0, 120)); }
}

/* 磁盘上的文件与库内条目对齐（新增/删除都会补齐） */
function syncRows() {
  try {
    const files = scanFiles();
    const seen = new Set();
    for (const { fname, tier } of files) {
      seen.add(fname);
      const cur = store.get(fname);
      if (!cur) {
        /* 新出现的文件：内置/收藏是人写过的，直接可信；收集来的先只记录 */
        const trusted = tier === "builtin" || tier === "curated";
        store.upsert(fname, {
          tier,
          desc: store.labelFromFname(fname),
          source: trusted ? "builtin" : "auto",
          status: trusted ? "verified" : "observed",
          allowProactive: trusted,
          confidence: trusted ? 0.9 : 0.3,
          sourceCount: trusted ? 3 : 1,
          addedAt: Date.now(),
        });
      } else if (cur.tier !== tier) store.upsert(fname, { tier });
    }
  } catch (e) {}
}

/* ---------- 读取 ---------- */
function rowFor(fname) { return store.get(fname); }

/* 库还没初始化时的兜底行：只靠文件名，保证提示词/统计不会空白 */
function synthRow(fname, tier) {
  const label = store.labelFromFname(fname);
  const trusted = tier === "builtin" || tier === "curated";
  return {
    fname, publicId: store.publicIdOf(fname, tier), desc: label, tier,
    used: 0, matched: 0, lastUsed: 0,
    mood: store.inferMoodFromText(label) || "平静",
    scene: store.inferSceneFromText(label) || "表达疑惑",
    risk: "low", allowProactive: trusted,
    status: trusted ? "verified" : "observed",
    source: trusted ? "builtin" : "auto", manualLocked: false,
    what: "", textInImage: "", meaning: "", usage: "", tags: [],
    annotateStatus: "", annotateConfidence: 0,
  };
}

function scanDir(dir, tier) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => IMG_RE.test(f)); } catch (e) { return []; }
  const ok = store.ready();
  const out = [];
  for (const f of files) {
    const s = ok ? store.get(f) : null;
    if (!s) { if (!ok) out.push(Object.assign({ file: path.join(dir, f) }, synthRow(f, tier))); continue; }
    out.push({
      file: path.join(dir, f),
      fname: f,
      publicId: s.publicId,
      label: s.desc || store.labelFromFname(f),
      tier,
      used: s.used,
      matched: s.matched,
      lastUsed: s.lastUsed,
      mood: s.mood_tag,
      scene: s.scene_tag,
      risk: s.risk,
      allowProactive: s.allowProactive,
      status: s.status,
      source: s.source,
      manualLocked: s.manualLocked,
      what: s.what || "",
      textInImage: s.textInImage || "",
      meaning: s.meaning || "",
      usage: s.usage || "",
      tags: (() => { try { const t = JSON.parse(s.tags || "[]"); return Array.isArray(t) ? t : []; } catch (e) { return []; } })(),
      annotateStatus: s.annotateStatus || "",
      annotateConfidence: Number(s.annotateConfidence || 0),
    });
  }
  return out;
}
function listStickers() {
  if (store.ready()) syncRows();
  const out = [
    ...scanDir(STICKER_DIR, "builtin"),
    ...scanDir(STICKER_COLLECT_DIR, "collected"),
    ...scanDir(STICKER_CURATED_DIR, "curated"),
  ];
  out.sort((a, b) => String(a.label).localeCompare(String(b.label), "zh"));
  return out;
}
function listAll() {
  if (store.ready()) syncRows();
  return [...listStickers(), ...scanDir(STICKER_TRASH_DIR, "trash")];
}

/* ---------- 可发性判断 ---------- */
function blockedStatus(s) { return s.status === "rejected" || s.status === "disputed"; }

/* 主动发（她自己想发）的资格：状态达标 + 允许主动 + 非高风险 */
function canProactive(s) {
  if (!s) return false;
  if (blockedStatus(s)) return false;
  if (s.risk === "high") return false;
  if (!s.allowProactive) return false;
  if (!store.PROACTIVE_STATUSES.has(s.status)) return false;
  return true;
}
/* 被点名时（用户明确要这张/点了编号）：只拦回收站和 rejected */
function canExplicit(s) {
  if (!s) return false;
  if (s.status === "rejected") return false;
  return true;
}

/* ---------- 情绪候选 ---------- */
const EMOTION_STICKER_KW = {
  "开心": ["开心", "笑", "眉开眼笑", "元气", "夸赞", "得意", "热情", "点赞", "认可"],
  "满足": ["满足", "开心", "得意", "点赞", "认可", "心满意足"],
  "期待": ["期待", "元气", "开心"],
  "害羞": ["害羞", "羞涩", "脸红", "紧张", "瘪嘴"],
  "傲娇": ["傲娇", "得意", "嚣张", "气鼓"],
  "撒娇": ["撒娇", "委屈", "卖萌", "瘪嘴", "软萌"],
  "难过": ["难过", "哭", "落泪", "伤心", "委屈", "崩溃"],
  "生气": ["气鼓", "怒", "暴怒", "生气"],
  "委屈": ["委屈", "落泪", "难过", "瘪嘴"],
  "吃醋": ["吃醋", "气鼓", "委屈"],
  "紧张": ["紧张", "心虚", "尴尬"],
  "平静": ["发呆", "平静"],
  "无聊": ["无聊", "发呆", "敷衍", "摊手"],
  "好奇": ["疑惑", "吃瓜", "窥屏", "好奇"],
  "惊讶": ["惊讶", "震惊", "疑惑"],
};
const BAD_LABEL = /早上好|早安|晚安|中午好|下午好|晚上好|早/;

/* 语义文本：给召回/精排用的一句话「画面+图上字+含义+场景」 */
function semanticHaystack(s) {
  const tags = Array.isArray(s.tags) ? s.tags.join(" ") : String(s.tags || "");
  return [s.label, s.what, s.textInImage, s.meaning, s.usage, tags].filter(Boolean).join(" ");
}
function semanticLine(s) {
  const parts = [];
  if (s.what) parts.push("画面：" + s.what);
  if (s.textInImage) parts.push("图上字：" + s.textInImage);
  if (s.meaning) parts.push("含义：" + s.meaning);
  if (s.usage) parts.push("场景：" + s.usage);
  const line = parts.join("；");
  return line || String(s.label || "").slice(0, 60);
}

/* 按情绪取候选：先按语义库的 mood_tag 精确命中，再退回语义/文本关键词 */
function candidatesByEmotion(emotionName) {
  const kw = EMOTION_STICKER_KW[emotionName] || [emotionName];
  return listStickers().filter((s) => {
    if (BAD_LABEL.test(String(s.label || ""))) return false;
    if (s.mood === emotionName) return true;
    const hay = semanticHaystack(s);
    return kw.some((k) => hay.includes(k));
  });
}

/* ---------- 去重 ---------- */
function recentFnames(sessionKey) {
  const n = cfgNum("stickers.recent_window", 5);
  return store.recentSends(sessionKey, n).map((x) => x.fname);
}

/* 打分：情绪/场景命中 + 使用热度 - 刚发过的惩罚 */
function scoreSticker(s, ctxInfo) {
  let sc = 0;
  if (ctxInfo.emotion && s.mood === ctxInfo.emotion) sc += 3;
  if (ctxInfo.scene && s.scene === ctxInfo.scene) sc += 2;
  sc += Math.min(3, Number(s.matched || 0) * 2 + Number(s.used || 0));
  if (s.manualLocked) sc += 2;
  const age = Date.now() - Number(s.lastUsed || 0);
  if (!s.lastUsed) sc += 2;                       // 从没发过的优先露个脸
  else if (age > 30 * 86400e3) sc += 1;           // 很久没发过的也给点分
  return sc;
}

/* 同步版：不需要上下文的随机（保留给旧调用点） */
function pickStickerByEmotion(emotionName, opts) {
  const o = opts || {};
  const pool = candidatesByEmotion(emotionName).filter((s) => (o.explicit ? canExplicit(s) : canProactive(s)));
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* 智能版：门禁 → 去重 → 打分 → 让模型从 top6 里挑一张 */
async function pickStickerSmart(emotionName, contextText, opts) {
  const o = opts || {};
  const sessionKey = String(o.sessionKey || "");
  const explicit = !!o.explicit;
  let pool = candidatesByEmotion(emotionName);
  if (explicit) pool = pool.filter(canExplicit);
  else pool = pool.filter(canProactive);
  /* 语义标注低置信的：不主动发（被点名时仍可发） */
  if (!explicit) pool = pool.filter((s) => s.annotateStatus !== "low_conf");

  const recent = sessionKey ? recentFnames(sessionKey) : [];
  let deduped = pool.filter((s) => !recent.includes(s.fname));
  /* 池子被去重抽干了：退一步只用「全部合法候选」，绝不放宽门禁 */
  if (!deduped.length) deduped = pool;
  if (!deduped.length) return null;

  const info = { emotion: emotionName, scene: o.scene || "" };
  const ranked = deduped.slice().sort((a, b) => scoreSticker(b, info) - scoreSticker(a, info));
  const poolN = Math.max(4, cfgNum("stickers.rank_pool", 8));
  const top = ranked.slice(0, poolN);
  if (top.length === 1) return top[0];

  const affordable = !_ctx.canAfford || _ctx.canAfford("low");
  if (!affordable) return top[Math.floor(Math.random() * top.length)];
  try {
    const lines = top.map((s, i) => `${i + 1}. [${s.publicId}] ${semanticLine(s)}`).join("\n");
    const prompt = `你刚要回应：「${String(contextText || "").slice(0, 100)}」\n此刻情绪是「${emotionName}」。\n下面每张表情包都标了「画面 / 图上字 / 含义 / 场景」。请挑一张最贴切这句话和情绪的，只输出序号数字，不要解释：\n${lines}`;
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], _ctx.settings(), 10, 0.3);
    const n = parseInt(String(raw || "").replace(/[^\d]/g, ""), 10);
    if (n >= 1 && n <= top.length) return top[n - 1];
  } catch (e) { _ctx.log("warn", "表情包智能挑选失败: " + String(e.message).slice(0, 100)); }
  return top[0];
}

/* 按一段文字挑一张（QQ 空间配图用）：先按情绪关键词匹配，匹配不到就随机 */
function pickForText(text) {
  const t = String(text || "");
  let best = "", bestScore = 0;
  for (const emo of Object.keys(EMOTION_STICKER_KW)) {
    const kw = EMOTION_STICKER_KW[emo] || [];
    let sc = 0;
    for (const k of kw) if (t.indexOf(k) >= 0) sc++;
    if (sc > bestScore) { bestScore = sc; best = emo; }
  }
  const cands = best ? candidatesByEmotion(best).filter(canProactive) : [];
  if (cands.length) return cands[Math.floor(Math.random() * cands.length)];
  const all = listStickers().filter(canProactive);
  return all.length ? all[Math.floor(Math.random() * all.length)] : null;
}

/* 收图反查：对方发来的图是不是库里的表情包（按 sha256 内容 hash） */
function hashBuf(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function findByHash(buf) {
  try {
    if (!store.ready() || !buf || !buf.length) return null;
    return store.findByImgHash(hashBuf(buf));
  } catch (e) { return null; }
}
function meaningText(s) {
  if (!s) return "";
  const parts = [];
  if (s.what) parts.push("画面：" + s.what);
  if (s.textInImage) parts.push("图上文字：" + s.textInImage);
  if (s.meaning) parts.push("含义：" + s.meaning);
  return parts.join("；");
}

/* ---------- 发送记账 ---------- */
function recordSent(sticker, sessionKey) {
  if (!sticker || !sticker.fname) return;
  try {
    const s = store.get(sticker.fname);
    if (s) store.upsert(sticker.fname, { used: s.used + 1, lastUsed: Date.now() });
    if (sessionKey) store.recordSend(sticker.fname, sessionKey, Date.now());
  } catch (e) {}
}

/* ---------- 收集 ---------- */
function isStickerLike(buf) {
  if (buf.length >= 6) { const h = buf.slice(0, 6).toString("latin1"); if (h === "GIF87a" || h === "GIF89a") return true; }
  return buf.length < 200 * 1024;
}
function saveLastCollected(fname) { try { fs.writeFileSync(LAST_COLLECTED_FILE, JSON.stringify({ fname, ts: Date.now() })); } catch (e) {} }
function getLastCollected() { try { const d = JSON.parse(fs.readFileSync(LAST_COLLECTED_FILE, "utf8")); return d && d.fname ? d.fname : ""; } catch (e) { return ""; } }

function maybeCollect(buf, desc) {
  try {
    if (!isStickerLike(buf)) return { ok: false, reason: "不是表情包尺寸/格式" };
    const md5 = crypto.createHash("md5").update(buf).digest("hex");
    const mime = _ctx.mimeOf(buf);
    const ext = mime === "image/gif" ? "gif" : (mime === "image/jpeg" ? "jpg" : (mime === "image/webp" ? "webp" : "png"));
    const fname = "c" + md5.slice(0, 12) + "." + ext;
    if (fs.existsSync(path.join(STICKER_COLLECT_DIR, fname)) || fs.existsSync(path.join(STICKER_CURATED_DIR, fname)) || fs.existsSync(path.join(STICKER_TRASH_DIR, fname))) {
      saveLastCollected(fname);
      if (!store.get(fname)) store.addAuto(fname, { tier: "collected", desc: String(desc || "") });
      return { ok: true, fname, duplicate: true };
    }
    fs.mkdirSync(STICKER_COLLECT_DIR, { recursive: true });
    const existing = fs.readdirSync(STICKER_COLLECT_DIR).filter((f) => IMG_RE.test(f));
    if (existing.length >= STICKER_MAX_COLLECT) return { ok: false, reason: "图库满了" };
    fs.writeFileSync(path.join(STICKER_COLLECT_DIR, fname), buf);
    store.addAuto(fname, { tier: "collected", desc: String(desc || "").slice(0, 100) });
    saveLastCollected(fname);
    _ctx.log("info", `已收藏表情包（待整理）${fname}`);
    return { ok: true, fname };
  } catch (e) { _ctx.log("warn", "收藏表情包失败: " + e.message.slice(0, 120)); return { ok: false, reason: "写入失败" }; }
}

/* ---------- 教学：绑定到具体某一张 ---------- */
/* 解析「这张」到底指哪张。顺序：显式编号 → 最近发出去的那张 → 最近收到的图 */
function resolveStickerTarget(opts) {
  const o = opts || {};
  const text = String(o.text || "");
  /* 1) 显式编号：b.003 / c.abcdef12 / k.001 */
  const m = text.match(/\b([bckg])\.[A-Za-z0-9_-]{2,20}\b/);
  if (m) {
    const s = store.getByPublicId(m[0]);
    if (s) return { fname: s.fname, how: "编号 " + m[0] };
  }
  /* 2) 她最近发出去的那张（core 提供） */
  if (o.sessionKey && typeof _ctx.getLastSentSticker === "function") {
    const last = _ctx.getLastSentSticker(o.sessionKey);
    if (last && last.fname && store.get(last.fname)) return { fname: last.fname, how: "你刚发的那张" };
  }
  /* 3) 最近收到的图 */
  const lc = getLastCollected();
  if (lc && store.get(lc)) return { fname: lc, how: "最近收到的图" };
  return null;
}

/* 判断这张该不该「别乱发」：让模型看一眼教学原话 */
async function judgeRisk(desc) {
  const text = String(desc || "");
  const quick = store.riskFromText(text);
  if (quick === "high") return { risk: "high", allowProactive: false, by: "规则" };
  try {
    if (_ctx.isBudgetExhausted && _ctx.isBudgetExhausted()) return { risk: "low", allowProactive: true, by: "规则(预算紧)" };
    const prompt = `有人在教 AI 一张表情包的含义：「${text.slice(0, 200)}」。\n请判断这张表情包能不能让 AI 自己主动发出去。只输出 JSON：{"risk":"low或high","allow_proactive":true或false}\n风险 high 指：色情/擦边/冒犯/隐私/会引起误会的内容。`;
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], _ctx.settings(), 40, 0);
    const mm = String(raw).match(/\{[\s\S]*\}/);
    if (mm) {
      const o = JSON.parse(mm[0]);
      const risk = String(o.risk || "").trim() === "high" ? "high" : "low";
      const allow = risk === "high" ? false : o.allow_proactive !== false;
      return { risk, allowProactive: allow, by: "模型" };
    }
  } catch (e) { _ctx.log("warn", "表情包风险判断失败，按规则处理: " + String(e.message).slice(0, 80)); }
  return { risk: "low", allowProactive: true, by: "降级" };
}

/* 教学入口：绑定 → 判风险 → 写入 → 如实返回 */
async function teachSticker(opts) {
  const o = opts || {};
  const desc = String(o.desc || "").trim().slice(0, 100);
  if (!desc) return { ok: false, msg: "【失败】要教的内容是空的" };
  const target = resolveStickerTarget(o);
  if (!target) {
    return {
      ok: false,
      msg: "【失败】我没法确定你说的「这张」是哪张。你可以：把图发给我、或者告诉我是哪张（编号像 b.003 / c.abcdef12）、或者先让我发一张再说。",
    };
  }
  const before = store.get(target.fname);
  const risk = await judgeRisk(desc);
  const mood = store.inferMoodFromText(desc) || (before && before.mood_tag) || "";
  const scene = store.inferSceneFromText(desc) || (before && before.scene_tag) || "";
  const row = store.applyManual(target.fname, {
    desc,
    risk: risk.risk,
    allowProactive: risk.allowProactive,
    mood_tag: mood || undefined,
    scene_tag: scene || undefined,
  });
  const isNew = !before;
  const changed = before && (before.desc !== desc || before.risk !== risk.risk || before.allowProactive !== risk.allowProactive);
  const tail = risk.risk === "high"
    ? "（这张我标成「高风险」，以后不会自己主动发）"
    : "（以后可以自己挑着发）";
  return {
    ok: true,
    action: isNew ? "新增" : (changed ? "更新" : "无变化"),
    fname: target.fname,
    publicId: row ? row.publicId : "",
    how: target.how,
    risk: risk.risk,
    allowProactive: risk.allowProactive,
    msg: `【成功】${target.how}（${row ? row.publicId : target.fname}）我记住了：${desc}${tail}`,
  };
}

/* 兼容旧调用：只给 desc，按上面的规则定位 */
async function setLastMeaning(desc) {
  const r = await teachSticker({ desc });
  return { ok: r.ok, msg: r.msg };
}

/* 被点名：按公开 ID 或序号取一张（严格模式，允许高风险） */
function pickStickerByIds(ids) {
  const want = new Set((ids || []).map((x) => String(x)));
  const pool = listStickers().filter((s) => {
    const num = s.fname.match(/^(\d+)[_\-]/);
    return want.has(s.publicId) || (num && want.has(num[1]));
  }).filter(canExplicit);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ---------- 生图 ---------- */
async function generateStickerImage(prompt, outName) {
  const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) + "?width=512&height=512&nologo=true";
  const resp = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(90000) });
  if (!resp.ok) throw new Error("生图 HTTP " + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length || buf.length < 500) throw new Error("生图返回为空");
  fs.mkdirSync(STICKER_COLLECT_DIR, { recursive: true });
  const fp = path.join(STICKER_COLLECT_DIR, outName + ".jpg");
  fs.writeFileSync(fp, buf);
  store.addAuto(outName + ".jpg", { tier: "collected", desc: "" });
  return fp;
}

/* ---------- 图库维护 ---------- */
const PROMOTE_USED = 3;
const PENDING_STALE_MS = 30 * 86400e3;
const TRASH_TTL_MS = 60 * 86400e3;

function moveFile(from, to) {
  try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); return true; } catch (e) { return false; }
}
function maintain(opts) {
  const o = opts || {};
  const pendingDir = o.pendingDir || STICKER_COLLECT_DIR;
  const curatedDir = o.curatedDir || STICKER_CURATED_DIR;
  const trashDir = o.trashDir || STICKER_TRASH_DIR;
  const now = o.now || Date.now();
  /* 兜底：库还没建好或老数据没迁过来时，回退读旧 meta.json */
  let legacy = {};
  try { legacy = JSON.parse(fs.readFileSync(o.metaFile || path.join(STICKER_DIR, "meta.json"), "utf8")) || {}; } catch (e) { legacy = {}; }
  const rowOf = (f) => store.get(f) || legacy[f] || {};
  let promoted = 0, demoted = 0, purged = 0;
  let pend = [];
  try { pend = fs.readdirSync(pendingDir).filter((f) => IMG_RE.test(f)); } catch (e) {}
  for (const f of pend) {
    const s = rowOf(f);
    if ((s.used || 0) >= PROMOTE_USED) {
      if (moveFile(path.join(pendingDir, f), path.join(curatedDir, f))) { if (store.ready()) store.upsert(f, { tier: "curated" }); promoted++; }
    } else if (!s.used && s.addedAt && now - s.addedAt > PENDING_STALE_MS) {
      if (moveFile(path.join(pendingDir, f), path.join(trashDir, f))) { if (store.ready()) store.upsert(f, { tier: "trash" }); demoted++; }
    }
  }
  let trash = [];
  try { trash = fs.readdirSync(trashDir).filter((f) => IMG_RE.test(f)); } catch (e) {}
  for (const f of trash) {
    const s = rowOf(f);
    const ts = s.lastUsed || s.addedAt || 0;
    if (ts && now - ts > TRASH_TTL_MS) {
      try { fs.unlinkSync(path.join(trashDir, f)); if (store.ready()) store.del(f); purged++; } catch (e) {}
    }
  }
  if (promoted || demoted || purged) {
    try { fs.writeFileSync(o.maintainFile || MAINTAIN_LOG_FILE, JSON.stringify({ ts: now, promoted, demoted, purged })); } catch (e) {}
    if (_ctx && _ctx.log) _ctx.log("info", `表情包维护：升级 ${promoted} / 下沉 ${demoted} / 清理 ${purged}`);
  }
  return { promoted, demoted, purged };
}

function recentMaintain() {
  try {
    const d = JSON.parse(fs.readFileSync(MAINTAIN_LOG_FILE, "utf8"));
    if (!d || !d.ts || Date.now() - d.ts > 86400e3) return "";
    const parts = [];
    if (d.promoted) parts.push(`${d.promoted} 张升为收藏`);
    if (d.demoted) parts.push(`${d.demoted} 张沉到回收站`);
    if (d.purged) parts.push(`清掉 ${d.purged} 张旧图`);
    return parts.length ? `（今天整理过图库：${parts.join("、")}）` : "";
  } catch (e) { return ""; }
}

function stickerStats() {
  const all = listStickers();
  const by = { builtin: 0, collected: 0, curated: 0 };
  for (const s of all) by[s.tier] = (by[s.tier] || 0) + 1;
  const proactive = all.filter(canProactive).length;
  const locked = all.filter((s) => s.manualLocked).length;
  const highRisk = all.filter((s) => s.risk === "high").length;
  return `表情包：内置 ${by.builtin || 0} / 待整理 ${by.collected || 0} / 收藏 ${by.curated || 0}`
    + `\n能主动发的 ${proactive} 张（其中你亲口教过 ${locked} 张，高风险 ${highRisk} 张）`
    + `\n语义库：stickers.db（${all.length} 条）`;
}

/* ---------- 提示词 ---------- */
function stickerPrompt() {
  const stickers = listStickers();
  if (!stickers.length) return "";
  const usable = stickers.filter(canProactive);
  const emos = Object.keys(EMOTION_STICKER_KW);
  const counts = [];
  for (const e of emos) {
    const n = usable.filter((s) => s.mood === e || (EMOTION_STICKER_KW[e] || []).some((k) => String(s.label || "").indexOf(k) >= 0)).length;
    if (n) counts.push(`${e}(${n})`);
  }
  const summary = counts.length ? counts.join("、") : `${usable.length} 张`;
  const mint = recentMaintain();
  return `【表情包】库里有 ${stickers.length} 张，现在能主动发的 ${usable.length} 张，可用情绪：${summary}。${mint ? mint + "。" : ""}想发就调 send_sticker 传一个情绪名；一次最多一张，严肃回答和纯信息查询时不要发。有人说「这张」时指的是你最近发出去的那张。`;
}
function parseStickerMarkers(text) {
  const indices = [];
  const cleanText = String(text || "").replace(/\[\[贴图[:：](\d+)\]\]/g, (m, n) => { indices.push(parseInt(n, 10)); return ""; }).trim();
  return { cleanText, indices };
}

module.exports = {
  name: "stickers",
  version: "2.0.0",
  settings: [
    { key: "stickers.promote_used", label: "用几次后收为常用", type: "number", default: 3, min: 1, max: 20, desc: "待整理的表情包用过这么多次就升为收藏" },
    { key: "stickers.auto_send_chance", label: "自动发表情包概率", type: "number", default: 0.25, min: 0, max: 1, desc: "情绪强烈时自动配图的机会（0=从不）" },
    { key: "stickers.proactive_probability", label: "主动发梗概率", type: "number", default: 0.18, min: 0, max: 1, desc: "她主动挑一张表情包发出来的概率" },
    { key: "stickers.group_cooldown_min", label: "表情包冷却分钟", type: "number", default: 10, min: 0, max: 240, desc: "同一个聊天里两次发表情包至少隔多久" },
    { key: "stickers.recent_window", label: "避免重复最近几张", type: "number", default: 5, min: 0, max: 30, desc: "最近发过的这几张不再挑" },
  ],
  init(ctx) {
    _ctx = ctx;
    try { initStore(); } catch (e) { _ctx.log("warn", "表情包库初始化失败: " + String(e.message).slice(0, 120)); }
  },
  api: {
    stickers: {
      stickerPrompt, parseStickerMarkers, pickStickerByEmotion, pickStickerSmart, candidatesByEmotion,
      pickForText, maybeCollect, pickStickerByIds, generateStickerImage, listStickers, listAll,
      semanticLine, semanticHaystack, findByHash, meaningText,
    setLastMeaning, teachSticker, resolveStickerTarget, recordSent, recentFnames,
      canProactive, canExplicit, getLastCollected, maintain, stickerStats,
      store: () => store,
    },
  },
  tools: [{
    def: {
      type: "function",
      function: {
        name: "make_sticker",
        description: "自己画一张新的表情包（主人专属）。当主人说「做个表情包」「画一张XX的表情」「给我画个XX」时调用。画完会直接发到当前聊天里。",
        parameters: {
          type: "object",
          properties: { description: { type: "string", description: "要画什么，比如「一只气鼓鼓的胖鱼」「生无可恋的表情」" } },
          required: ["description"],
        },
      },
    },
    async handler(args, info) {
      const me = Number((info && info.userId) || 0);
      if (!_ctx.isMaster(me)) return "（只有主人能让我做表情包哦）";
      const d = String((args && args.description) || "").trim();
      if (!d) return "【失败】要画什么呀？说说看（比如「一只气鼓鼓的胖鱼」）";
      const fname = "g" + Date.now().toString(36);
      let fp;
      try {
        fp = await generateStickerImage(d + "，sticker style，chibi cute fish pet，high quality", fname);
      } catch (e) {
        return `【失败】这次没画出来（${String(e.message).slice(0, 60)}），等会儿再试试？`;
      }
      store.addAuto(fname + ".jpg", { tier: "collected", desc: d.slice(0, 60) });
      const petMode = !!(info && info.petMode);
      try {
        const gid = Number((info && info.groupId) || 0);
        const body = gid
          ? { message_type: "group", group_id: gid, message: [{ type: "image", data: { file: "file:///" + fp.replace(/\\/g, "/") } }] }
          : { message_type: "private", user_id: me, message: [{ type: "image", data: { file: "file:///" + fp.replace(/\\/g, "/") } }] };
        await _ctx.onebotSend("send_msg", body);
      } catch (e) {
        return `【部分成功】画好了，但图片没发出去（${String(e.message).slice(0, 50)}）。描述：${d.slice(0, 30)}`;
      }
      return petMode
        ? `【成功】画好了，已经发到你 QQ 上了，也收进表情包库了（${d.slice(0, 30)}）`
        : `【成功】画好了，已经发给你，也收进表情包库了（${d.slice(0, 30)}）`;
    },
  }],
  hooks: {
    timer() {
      const now = Date.now();
      if (now - (module.exports._lastMaintain || 0) < 6 * 3600e3) return;
      module.exports._lastMaintain = now;
      try { maintain(); } catch (e) { _ctx.log("warn", "表情包维护失败: " + String(e.message).slice(0, 100)); }
      /* 增量标注：新收的表情包每 10 分钟最多跑一次，一次 5 张 */
      if (now - (module.exports._lastAnnotate || 0) > 10 * 60000) {
        module.exports._lastAnnotate = now;
        try {
          const pending = store.all().filter((r) => r.tier !== "trash" && !r.annotatedAt && !r.manualLocked);
          if (pending.length && (!_ctx.canAfford || _ctx.canAfford("low"))) {
            const { spawn } = require("child_process");
            const py = (_ctx.config.pet && _ctx.config.pet.python_path) || "python";
            const script = path.join(__dirname, "..", "scripts", "annotate-stickers.js");
            const child = spawn(process.execPath, [script, "--limit", "5"], {
              cwd: path.join(__dirname, ".."), windowsHide: true,
              env: Object.assign({}, process.env, { PYTHON: py }),
            });
            child.stdout.on("data", () => {});
            child.stderr.on("data", (d) => _ctx.log("warn", "表情包增量标注: " + String(d).slice(0, 120)));
            child.on("close", (code) => _ctx.log("info", `表情包增量标注完成（待标 ${pending.length} 张，code=${code}）`));
          }
        } catch (e) {}
      }
    },
  },
  commands: [{
    key: "/做表情包",
    regex: /^\/(做表情包|生成表情包)/,
    async handler(msg) {
      if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能让我做表情包哦～"); return; }
      const arg = msg.text.replace(/^\/(做表情包|生成表情包)\s*/, "").trim();
      if (!arg) { _ctx.sendPrivate(msg.userId, "用法：/做表情包 <描述>，例如 /做表情包 一只气鼓鼓的胖鱼"); return; }
      try {
        const fname = "g" + Date.now().toString(36);
        const fp = await generateStickerImage(arg + "，sticker style，chibi cute fish pet，high quality", fname);
        store.addAuto(fname + ".jpg", { tier: "collected", desc: arg.slice(0, 60) });
        await _ctx.recordAndSend(msg.userId, "画好啦～这只表情包我已经收进库啦！");
        await _ctx.onebotSend("send_msg", { message_type: "private", user_id: Number(msg.userId), message: [{ type: "image", data: { file: "file:///" + fp.replace(/\\/g, "/") } }] });
      } catch (e) { _ctx.sendPrivate(msg.userId, "生成失败啦：" + String(e.message).slice(0, 120)); }
    },
  }, {
    key: "/表情包",
    regex: /^\/表情包(\s+[\s\S]*)?$/,
    handler(msg) {
      if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能看表情包统计哦～"); return; }
      const arg = String(msg.text || "").replace(/^\/表情包\s*/, "").trim();
      if (!arg) { _ctx.sendPrivate(msg.userId, stickerStats()); return; }
      const sub = arg.split(/\s+/)[0];
      if (sub === "review") {
        const rows = store.all()
          .filter((r) => r.tier !== "trash" && (r.annotateStatus === "low_conf"))
          .slice(0, 10);
        if (!rows.length) { _ctx.sendPrivate(msg.userId, "没有待复核的标注～"); return; }
        const lines = rows.map((r) => `${r.publicId}：${String(r.desc || r.fname).slice(0, 16)} → ${String(r.meaning || "（无含义）").slice(0, 28)}`).join("\n");
        _ctx.sendPrivate(msg.userId, `待复核（${rows.length}）：\n${lines}\n改：/表情包 fix 编号 含义=xxx\n锁：/表情包 lock 编号`);
        return;
      }
      if (sub === "fix") {
        const m = arg.match(/^fix\s+(\S+)\s+(\S+?)=([\s\S]+)$/);
        if (!m) { _ctx.sendPrivate(msg.userId, "用法：/表情包 fix 编号 含义=xxx（字段：画面/图上字/含义/场景）"); return; }
        const st = store.getByPublicId(m[1]) || store.get(m[1]);
        if (!st) { _ctx.sendPrivate(msg.userId, "没找到这个编号"); return; }
        const fieldMap = { 画面: "what", 图上字: "textInImage", 含义: "meaning", 场景: "usage" };
        const f = fieldMap[m[2]] || m[2];
        if (!["what", "textInImage", "meaning", "usage"].includes(f)) {
          _ctx.sendPrivate(msg.userId, "字段只能是：画面 / 图上字 / 含义 / 场景");
          return;
        }
        store.upsert(st.fname, { [f]: m[3].trim().slice(0, 120), annotateStatus: "ok", annotatedAt: Date.now() });
        _ctx.log("info", `表情包标注修正 ${m[1]} ${m[2]}=${m[3].slice(0, 30)}`);
        _ctx.sendPrivate(msg.userId, `已更新 ${m[1]} 的「${m[2]}」：${m[3].trim().slice(0, 40)}`);
        return;
      }
      if (sub === "lock") {
        const pid = arg.replace(/^lock\s*/, "").trim();
        const st = store.getByPublicId(pid) || store.get(pid);
        if (!st) { _ctx.sendPrivate(msg.userId, "没找到这个编号"); return; }
        store.upsert(st.fname, { manualLocked: true, status: "manual_locked", annotateStatus: "ok" });
        _ctx.sendPrivate(msg.userId, `已锁定 ${pid}（以后自动流程不会覆盖它）`);
        return;
      }
      _ctx.sendPrivate(msg.userId, "用法：/表情包 [review | fix 编号 含义=xxx | lock 编号]");
    },
  }],
};
