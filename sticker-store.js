/* 表情包语义库（v1.46.0 起为唯一数据源）
 *
 * 用 Node 内置 node:sqlite（Node 22+ 自带，无需装任何依赖）存表情包的「语义与状态」：
 *   描述 / 情绪标签 / 场景标签 / 风险等级 / 能否主动发 / 生命周期状态 / 教学来源 / 使用统计
 *
 * 图片文件本身仍在 stickers/ 各目录里（磁盘是「有多少张图」的唯一真相），
 * 本库只负责「这张图是什么意思、能不能主动发」。
 *
 * 设计参照：
 *   - meme-pilot：每张图有稳定公开 ID，所有操作都用 ID 指代
 *   - nonebot-plugin-personification：受控标签词表 + 7 态生命周期 + 手动锁定最高优先级
 */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

/* ---------- 受控词表 ---------- */
/* 情绪：与项目既有 getEmotion() 的 14 个情绪 + 无聊 保持一致，避免两套词表 */
const MOOD_TAGS = [
  "开心", "满足", "期待", "害羞", "傲娇", "撒娇", "难过",
  "生气", "委屈", "吃醋", "紧张", "平静", "无聊", "好奇", "惊讶",
];
/* 场景：一个表情包「用在什么场合」，参照人格化 bot 的场景词表收敛到 20 个 */
const SCENE_TAGS = [
  "回应笑点", "接梗", "表达赞同", "化解尴尬", "自嘲", "反驳",
  "表达惊讶", "安慰对方", "撒娇", "表示无奈", "冷场时", "表达期待",
  "庆祝", "拒绝请求", "结束对话", "打招呼", "表达关心", "吐槽",
  "卖萌", "表达疑惑",
];
const MOOD_SET = new Set(MOOD_TAGS);
const SCENE_SET = new Set(SCENE_TAGS);

/* ---------- 生命周期状态 ---------- */
/* observed      刚收集到，只记录，不敢用
 * understand_only 有 2 个来源，允许「理解 / 被点名」，但不主动发
 * verified      3 个来源，可以主动发
 * disputed      被反驳过，降级不用
 * stale         太久没复核，待重验
 * rejected      判否，永不再用
 * manual_locked 主人手动教，最高优先级，自动流程永不覆盖
 */
const STATUSES = ["observed", "understand_only", "verified", "disputed", "stale", "rejected", "manual_locked"];
const STATUS_SET = new Set(STATUSES);
/* 允许「主动发」的状态 */
const PROACTIVE_STATUSES = new Set(["verified", "manual_locked"]);

const RISKS = ["low", "high"];
const TIERS = ["builtin", "collected", "curated", "trash"];
const SOURCES = ["builtin", "manual", "auto"];

const DEFAULT_ROW = {
  tier: "collected",
  desc: "",
  mood_tag: "平静",
  scene_tag: "表达疑惑",
  risk: "low",
  allow_proactive: 0,
  source: "auto",
  status: "observed",
  confidence: 0,
  source_count: 1,
  manual_locked: 0,
  scope: "public",
  group_id: "",
  /* 语义标注（v1.54.0 表情包理解）：画面/图上文字/梗/适用场景/标签/置信度 */
  what: "",
  text_in_image: "",
  meaning: "",
  usage: "",
  tags: "",
  annotate_confidence: 0,
  annotated_at: 0,
  annotate_model: "",
  annotate_status: "",
  img_hash: "",
  used: 0,
  matched: 0,
  last_used: 0,
  added_at: 0,
  reverify_after: 0,
};

let db = null;
let dbPath = null;

/* ---------- 初始化 ---------- */
function init(file) {
  dbPath = file;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS stickers (
    fname TEXT PRIMARY KEY,
    public_id TEXT,
    tier TEXT,
    desc_ TEXT,
    mood_tag TEXT,
    scene_tag TEXT,
    risk TEXT,
    allow_proactive INTEGER,
    source TEXT,
    status TEXT,
    confidence REAL,
    source_count INTEGER,
    manual_locked INTEGER,
    scope TEXT,
    group_id TEXT,
    used INTEGER,
    matched INTEGER,
    last_used INTEGER,
    added_at INTEGER,
    reverify_after INTEGER,
    updated_at INTEGER
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fname TEXT,
    session_key TEXT,
    ts INTEGER
  );`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_sends ON sends(session_key, ts);");
  db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);");
  migrateStickerSchema();
  return db;
}

/* 幂等迁移：给已有的 stickers 表补语义标注列（旧库/旧行为零影响） */
const EXTRA_COLUMNS = [
  ["what", "TEXT"], ["text_in_image", "TEXT"], ["meaning", "TEXT"], ["usage", "TEXT"],
  ["tags", "TEXT"], ["annotate_confidence", "REAL"], ["annotated_at", "INTEGER"],
  ["annotate_model", "TEXT"], ["annotate_status", "TEXT"], ["img_hash", "TEXT"],
];
function migrateStickerSchema() {
  try {
    const cols = new Set(db.prepare("PRAGMA table_info(stickers)").all().map((c) => c.name));
    let added = 0;
    for (const [n, t] of EXTRA_COLUMNS) {
      if (!cols.has(n)) { db.exec(`ALTER TABLE stickers ADD COLUMN ${n} ${t}`); added++; }
    }
    return added;
  } catch (e) { return 0; }
}
function ready() { return !!db; }
function close() { try { if (db) db.close(); } catch (e) {} db = null; }

function getKV(k, d) {
  try {
    const r = db.prepare("SELECT v FROM kv WHERE k = ?").get(String(k));
    return r ? r.v : d;
  } catch (e) { return d; }
}
function setKV(k, v) {
  try {
    db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(String(k), String(v));
  } catch (e) {}
}

/* ---------- 公开 ID：b.003 / c.abc123def456 / k.001 / g.xxxx ---------- */
function publicIdOf(fname, tier) {
  const base = path.basename(String(fname || ""), path.extname(String(fname || "")));
  const num = base.match(/^(\d+)[_\-]/);
  if (tier === "builtin") return "b." + (num ? num[1] : base.slice(0, 8));
  if (tier === "curated") return "k." + (num ? num[1] : base.slice(0, 8));
  if (/^g[a-z0-9]+$/i.test(base)) return "g." + base.slice(1, 9);
  const hashOnly = base.replace(/^c/, "");
  return "c." + hashOnly.slice(0, 8);
}

/* ---------- 行 <-> 对象 ---------- */
function rowToSticker(r) {
  if (!r) return null;
  return {
    fname: r.fname,
    publicId: r.public_id || "",
    tier: r.tier || "collected",
    desc: r.desc_ || "",
    mood_tag: r.mood_tag || DEFAULT_ROW.mood_tag,
    scene_tag: r.scene_tag || DEFAULT_ROW.scene_tag,
    risk: r.risk || "low",
    allowProactive: !!r.allow_proactive,
    source: r.source || "auto",
    status: r.status || "observed",
    confidence: Number(r.confidence || 0),
    sourceCount: Number(r.source_count || 0),
    manualLocked: !!r.manual_locked,
    scope: r.scope || "public",
    groupId: r.group_id || "",
    used: Number(r.used || 0),
    matched: Number(r.matched || 0),
    lastUsed: Number(r.last_used || 0),
    addedAt: Number(r.added_at || 0),
    reverifyAfter: Number(r.reverify_after || 0),
    updatedAt: Number(r.updated_at || 0),
    what: r.what || "",
    textInImage: r.text_in_image || "",
    meaning: r.meaning || "",
    usage: r.usage || "",
    tags: r.tags || "",
    annotateConfidence: Number(r.annotate_confidence || 0),
    annotatedAt: Number(r.annotated_at || 0),
    annotateModel: r.annotate_model || "",
    annotateStatus: r.annotate_status || "",
    imgHash: r.img_hash || "",
  };
}

function get(fname) {
  try { return rowToSticker(db.prepare("SELECT * FROM stickers WHERE fname = ?").get(String(fname))); }
  catch (e) { return null; }
}
function getByPublicId(pid) {
  try { return rowToSticker(db.prepare("SELECT * FROM stickers WHERE public_id = ?").get(String(pid))); }
  catch (e) { return null; }
}
/* 按图片内容 hash 反查（对方发来的表情包是否在库里） */
function findByImgHash(hash) {
  const h = String(hash || "");
  if (!h) return null;
  try { return rowToSticker(db.prepare("SELECT * FROM stickers WHERE img_hash = ? LIMIT 1").get(h)); }
  catch (e) { return null; }
}
function all() {
  try { return db.prepare("SELECT * FROM stickers").all().map(rowToSticker); }
  catch (e) { return []; }
}

/* 写一行（部分字段）。row 里没给的字段保持原值；不存在的行用 DEFAULT_ROW 补齐。 */
function upsert(fname, patch) {
  const fn = String(fname || "");
  if (!fn) return null;
  const cur = get(fn) || Object.assign({}, DEFAULT_ROW, { fname: fn, publicId: publicIdOf(fn, patch && patch.tier) });
  const next = Object.assign({}, cur, patch || {});
  /* 调用方传了 undefined 字段时不要覆盖（sqlite 不接受 undefined） */
  for (const k of Object.keys(patch || {})) {
    if (patch[k] === undefined) next[k] = cur[k];
  }
  next.updatedAt = Date.now();
  if (!next.publicId) next.publicId = publicIdOf(fn, next.tier);
  try {
    db.prepare(`INSERT INTO stickers (
        fname, public_id, tier, desc_, mood_tag, scene_tag, risk, allow_proactive,
        source, status, confidence, source_count, manual_locked, scope, group_id,
        used, matched, last_used, added_at, reverify_after, updated_at,
        what, text_in_image, meaning, usage, tags, annotate_confidence, annotated_at,
        annotate_model, annotate_status, img_hash
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(fname) DO UPDATE SET
        public_id=excluded.public_id, tier=excluded.tier, desc_=excluded.desc_,
        mood_tag=excluded.mood_tag, scene_tag=excluded.scene_tag, risk=excluded.risk,
        allow_proactive=excluded.allow_proactive, source=excluded.source, status=excluded.status,
        confidence=excluded.confidence, source_count=excluded.source_count,
        manual_locked=excluded.manual_locked, scope=excluded.scope, group_id=excluded.group_id,
        used=excluded.used, matched=excluded.matched, last_used=excluded.last_used,
        added_at=excluded.added_at, reverify_after=excluded.reverify_after,
        updated_at=excluded.updated_at,
        what=excluded.what, text_in_image=excluded.text_in_image, meaning=excluded.meaning,
        usage=excluded.usage, tags=excluded.tags, annotate_confidence=excluded.annotate_confidence,
        annotated_at=excluded.annotated_at, annotate_model=excluded.annotate_model,
        annotate_status=excluded.annotate_status, img_hash=excluded.img_hash`)
      .run(
        fn, next.publicId, next.tier, next.desc, next.mood_tag, next.scene_tag, next.risk,
        next.allowProactive ? 1 : 0, next.source, next.status, Number(next.confidence) || 0,
        Number(next.sourceCount) || 0, next.manualLocked ? 1 : 0, next.scope, next.groupId || "",
        Number(next.used) || 0, Number(next.matched) || 0, Number(next.lastUsed) || 0,
        Number(next.addedAt) || 0, Number(next.reverifyAfter) || 0, next.updatedAt,
        next.what || "", next.textInImage || "", next.meaning || "", next.usage || "",
        next.tags || "", Number(next.annotateConfidence) || 0, Number(next.annotatedAt) || 0,
        next.annotateModel || "", next.annotateStatus || "", next.imgHash || ""
      );
    return get(fn);
  } catch (e) { return null; }
}

function del(fname) {
  try { db.prepare("DELETE FROM stickers WHERE fname = ?").run(String(fname)); } catch (e) {}
}

/* ---------- 发送记录（去重 + 冷却）---------- */
function recordSend(fname, sessionKey, ts) {
  try {
    db.prepare("INSERT INTO sends (fname, session_key, ts) VALUES (?,?,?)")
      .run(String(fname), String(sessionKey || ""), Number(ts) || Date.now());
    // 只保留最近 500 条
    db.prepare("DELETE FROM sends WHERE id <= (SELECT MAX(id) - 500 FROM sends)").run();
  } catch (e) {}
}
function recentSends(sessionKey, n) {
  try {
    const rows = db.prepare("SELECT fname, ts FROM sends WHERE session_key = ? ORDER BY id DESC LIMIT ?")
      .all(String(sessionKey || ""), Number(n) || 5);
    return rows.map((r) => ({ fname: r.fname, ts: Number(r.ts || 0) }));
  } catch (e) { return []; }
}
function lastSendTs(sessionKey) {
  try {
    const r = db.prepare("SELECT MAX(ts) AS t FROM sends WHERE session_key = ?").get(String(sessionKey || ""));
    return Number((r && r.t) || 0);
  } catch (e) { return 0; }
}

/* ---------- 生命周期：按门槛推进 ---------- */
const THRESHOLDS = {
  understandMinSources: 2,   // 2 个来源才敢「理解」
  useMinSources: 3,          // 3 个来源才敢「主动用」
  reverifyDays: 30,
  staleDays: 90,
};

/* 根据来源数 / 手动锁定，推导该走哪个状态 */
function nextStatus(st) {
  if (st.manualLocked) return "manual_locked";
  if (st.status === "rejected" || st.status === "disputed") return st.status;
  const sc = Number(st.sourceCount || 0);
  if (sc >= THRESHOLDS.useMinSources) return "verified";
  if (sc >= THRESHOLDS.understandMinSources) return "understand_only";
  return "observed";
}

/* 收集到一张新图：自动来源，进 observed，默认不能主动发 */
function addAuto(fname, opts) {
  const o = opts || {};
  const cur = get(fname);
  if (cur && cur.manualLocked) return cur;   // 主人定过的不动
  const base = cur || Object.assign({}, DEFAULT_ROW, {
    fname, tier: o.tier || "collected", desc: o.desc || "",
    addedAt: Date.now(), sourceCount: 1,
  });
  const patch = {
    desc: o.desc !== undefined ? o.desc : base.desc,
    tier: o.tier || base.tier,
    source: "auto",
    sourceCount: Math.max(1, Number(base.sourceCount || 1)),
    allowProactive: false,
  };
  patch.status = cur ? nextStatus(Object.assign({}, base, patch)) : "observed";
  return upsert(fname, patch);
}

/* 主人手动教：manual_locked，永远最高优先级 */
function applyManual(fname, patch) {
  const cur = get(fname) || Object.assign({}, DEFAULT_ROW, { fname, addedAt: Date.now() });
  const p = Object.assign({}, patch || {}, {
    source: "manual",
    manualLocked: true,
    status: "manual_locked",
    confidence: 1,
    reverifyAfter: Date.now() + THRESHOLDS.reverifyDays * 86400e3,
  });
  if (p.allowProactive === undefined) p.allowProactive = cur.allowProactive;
  if (p.risk === "high") p.allowProactive = false;
  return upsert(fname, p);
}

/* ---------- 迁移：meta.json + desc.json + taught.json → sqlite ---------- */
/* 幂等：已迁移过就直接返回；每次都只补缺失的 fname。 */
/* 文件名 → 人能读的含义（内置图的文件名本身就是人写的标签） */
function labelFromFname(fname) {
  const base = path.basename(String(fname || ""), path.extname(String(fname || "")));
  return base.replace(/^\d+[_\-]/, "").replace(/_/g, " ").trim();
}

function migrate(opts) {
  const o = opts || {};
  const flag = getKV("migrated_v146", "");
  let imported = 0, skipped = 0;

  /* 1) 语义：desc.json 与 meta.json */
  let descs = {};
  try { descs = JSON.parse(fs.readFileSync(o.descFile, "utf8")) || {}; } catch (e) { descs = {}; }
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(o.metaFile, "utf8")) || {}; } catch (e) { meta = {}; }

  /* 目录是「这张图属于哪一层」的唯一真相：用扫描结果，不信 meta 里的旧 tier */
  const files = Array.isArray(o.files) ? o.files : [];
  const tierByFname = {};
  for (const it of files) if (it && it.fname) tierByFname[it.fname] = it.tier || "collected";

  const names = new Set([...files.map((x) => x && x.fname).filter(Boolean), ...Object.keys(descs), ...Object.keys(meta)]);

  for (const f of names) {
    const m = meta[f] || {};
    const tier = tierByFname[f] || m.tier || "collected";
    const cur = get(f);
    if (cur && flag) { skipped++; continue; }
    const desc = String(m.desc || descs[f] || (tier === "builtin" ? labelFromFname(f) : ""));
    const isBuiltin = tier === "builtin";
    const isCurated = tier === "curated";
    /* 内置图/收藏图：文件名本身是人写的含义，视为可信 → verified + 可主动发 */
    const trusted = isBuiltin || isCurated;
    upsert(f, {
      tier,
      desc,
      mood_tag: inferMoodFromText(desc) || DEFAULT_ROW.mood_tag,
      scene_tag: inferSceneFromText(desc) || DEFAULT_ROW.scene_tag,
      risk: "low",
      allowProactive: trusted,
      source: trusted ? "builtin" : "auto",
      status: trusted ? "verified" : "observed",
      confidence: trusted ? 0.9 : 0.3,
      sourceCount: trusted ? 3 : 1,
      manualLocked: false,
      used: Number(m.used || 0),
      matched: Number(m.matched || 0),
      lastUsed: Number(m.lastUsed || 0),
      addedAt: Number(m.addedAt || 0) || Date.now(),
    });
    imported++;
  }

  /* 2) 主人的教学：taught.json 里 kind=sticker 的条目 → manual_locked */
  let taught = { items: [] };
  try { taught = JSON.parse(fs.readFileSync(o.taughtFile, "utf8")) || { items: [] }; } catch (e) { taught = { items: [] }; }
  const stickerTaught = (taught.items || []).filter((x) => x && x.kind === "sticker" && x.status === "active");
  /* 这些条目只有文本、没有绑定到具体文件；按内容模糊匹配已迁移的 desc，
   * 匹配上就升级成 manual_locked（能救回一部分历史教学）。 */
  for (const t of stickerTaught) {
    const content = String(t.content || "");
    if (!content) continue;
    const hit = all().find((s) => s.desc && (s.desc.includes(content.slice(0, 12)) || content.includes(s.desc.slice(0, 12))));
    if (!hit) continue;
    if (hit.manualLocked) continue;
    applyManual(hit.fname, { desc: content, risk: riskFromText(content), allowProactive: !/别乱发|不要发|少发|敏感|色/.test(content) });
    imported++;
  }

  setKV("migrated_v146", String(Date.now()));
  return { imported, skipped, taught: stickerTaught.length };
}

/* ---------- 从文字猜标签（迁移用；猜不到返回空）---------- */
const MOOD_KW = {
  "开心": ["开心", "笑", "元气", "点赞", "得意", "乐"],
  "满足": ["满足", "吃饱", "舒服"],
  "期待": ["期待", "盼"],
  "害羞": ["害羞", "脸红", "羞涩"],
  "傲娇": ["傲娇", "嘴硬", "气鼓"],
  "撒娇": ["撒娇", "卖萌", "蹭"],
  "难过": ["难过", "伤心", "落泪", "哭"],
  "生气": ["生气", "怒", "生气"],
  "委屈": ["委屈", "瘪嘴", "可怜"],
  "吃醋": ["吃醋", "醋"],
  "紧张": ["紧张", "心虚", "慌"],
  "平静": ["平静", "发呆", "淡定", "无奈", "摆烂"],
  "无聊": ["无聊", "敷衍", "摊手"],
  "好奇": ["好奇", "疑惑", "看看", "吃瓜"],
  "惊讶": ["惊讶", "震惊", "吓"],
};
const SCENE_KW = {
  "回应笑点": ["笑点", "逗笑"], "接梗": ["梗", "调侃", "吐槽"],
  "表达赞同": ["赞", "认可", "赞同", "竖大拇指"],
  "化解尴尬": ["尴尬", "冷场"], "自嘲": ["自嘲", "惭愧"],
  "反驳": ["反驳", "不认同"], "表达惊讶": ["震惊", "惊讶"],
  "安慰对方": ["安慰", "抱抱", "摸摸"], "撒娇": ["撒娇", "黏人"],
  "表示无奈": ["无奈", "无语", "摆烂", "摊手"], "冷场时": ["冷场"],
  "表达期待": ["期待", "等"], "庆祝": ["庆祝", "恭喜"],
  "拒绝请求": ["拒绝", "不行", "不要"], "结束对话": ["再见", "晚安", "拜拜"],
  "打招呼": ["你好", "早上好", "早上", "打招呼"],
  "表达关心": ["关心", "喝水", "休息", "早点睡"],
  "吐槽": ["吐槽", "嫌", "嫌弃", "敷衍"],
  "卖萌": ["卖萌", "可爱", "萌"], "表达疑惑": ["疑惑", "奇怪", "疑问", "不理解"],
};
function pickTagFrom(text, table, allowed) {
  const t = String(text || "");
  if (!t) return "";
  let best = "", bestScore = 0;
  for (const tag of Object.keys(table)) {
    if (!allowed.has(tag)) continue;
    let sc = 0;
    for (const k of table[tag]) if (t.includes(k)) sc++;
    if (sc > bestScore) { bestScore = sc; best = tag; }
  }
  return best;
}
function inferMoodFromText(text) { return pickTagFrom(text, MOOD_KW, MOOD_SET); }
function inferSceneFromText(text) { return pickTagFrom(text, SCENE_KW, SCENE_SET); }

/* 风险：主人说「别乱发 / 色 / 敏感」→ high */
const RISK_RE = /色|涩|黄|裸|性|敏感|别乱发|不要发|不能发|少发|慎发|不要主动|别主动|私密/;
function riskFromText(text) { return RISK_RE.test(String(text || "")) ? "high" : "low"; }

module.exports = {
  init, ready, close,
  get, getByPublicId, findByImgHash, all, upsert, del,
  addAuto, applyManual, nextStatus,
  recordSend, recentSends, lastSendTs,
  getKV, setKV,
  migrate, migrateStickerSchema, EXTRA_COLUMNS,
  publicIdOf, riskFromText, inferMoodFromText, inferSceneFromText, labelFromFname,
  MOOD_TAGS, SCENE_TAGS, STATUSES, PROACTIVE_STATUSES, RISKS, TIERS, SOURCES, THRESHOLDS,
  _peek: () => db,
};
