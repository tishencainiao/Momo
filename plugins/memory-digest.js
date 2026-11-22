/* 插件：记忆消化（读取消化后的「认识」，替换流水账注入）
 * 数据：data/memory-digest/<uid>.json 与 global.json（由 digest.py 生成）
 * 设计：本人桶 → 对「这个人」的认识；global → 对自己/世界的通用认识。
 * 默认开启（mem.digest.enabled=true）：消化后的「认识」替代流水账注入。
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
let _ctx = null;
let _timer = null;

const STATE_FILE = () => path.join(_ctx.DATA_DIR, "digest-state.json");
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")); } catch (e) { return {}; } }
function saveState(st) { try { _ctx.writeJsonAtomic(STATE_FILE(), st); } catch (e) {} }
function dailyEnabled() { try { return _ctx.getSetting("mem.digest.daily", true) !== false; } catch (e) { return true; } }
function dailyHour() {
  try {
    const h = Number(_ctx.getSetting("mem.digest.hour", 22));
    return Number.isFinite(h) ? Math.min(23, Math.max(0, Math.floor(h))) : 22;
  } catch (e) { return 22; }
}
/* 每天到点跑一次（错过会补跑；同一天只跑一次） */
function dailyDue(now, st) {
  if (!enabled() || !dailyEnabled()) return false;
  const _t = (_ctx.getApi && _ctx.getApi("time")) || null;
  if ((_t ? _t.hourNow(now) : -1) < dailyHour()) return false;
  return ((st && st.lastDate) !== now.toDateString());
}
function tick() {
  const now = new Date();
  const st = loadState();
  if (!dailyDue(now, st)) return;
  runDigest([]).then((r) => {
    if (!r.all) {
      try { _ctx.log("warn", "每日记忆消化未全部成功（成功 " + (r.okNames || []).length + " / 失败 " + (r.failNames || []).length + "），今天不标记完成，稍后重试"); } catch (e) {}
      return;
    }
    const st2 = loadState();
    st2.lastDate = now.toDateString();
    st2.lastTs = Date.now();
    saveState(st2);
    try { _ctx.log("info", "每日记忆消化完成：" + String(r.out || "").split("\n")[0]); } catch (e) {}
  });
}
function startTimer() {
  if (_timer) return;
  _timer = setInterval(tick, 5 * 60000);
  if (_timer.unref) _timer.unref();
  setTimeout(tick, 15000);   // 启动后补跑一次（防止 22:00 时机器没开）
}

function digestDir() { return path.join(_ctx.DATA_DIR, "memory-digest"); }
function loadBucket(name) {
  try { return JSON.parse(fs.readFileSync(path.join(digestDir(), name + ".json"), "utf8")); } catch (e) { return null; }
}
function enabled() { try { return _ctx.getSetting("mem.digest.enabled", true) === true; } catch (e) { return true; } }
/* v2.1 WP3：稳定来源键（镜像 digest.py src_id：kind|scope|text 的 sha1 前 12 位）。
 * 读侧只用它做「证据是否仍存在」的失效校验：旧位置号（A1/R1/M1）不再是凭据。 */
function srcId(kind, scope, text) {
  const h = crypto.createHash("sha1").update(kind + "|" + scope + "|" + String(text), "utf8").digest("hex").slice(0, 12);
  return "S_" + h;
}
function selfDir() {
  try { return _ctx.SELF_DIR || path.resolve(_ctx.DATA_DIR, "..", "self"); } catch (e) { return path.resolve(__dirname, "..", "self"); }
}
/* B12 返修：identity/reflection 条目两种形态——字符串条目正文=字符串本身；对象条目取 .text */
function textOf(x) { return typeof x === "string" ? x : ((x && x.text) || ""); }
function readSelfList(name) {
  try { return JSON.parse(fs.readFileSync(path.join(selfDir(), name), "utf8")); } catch (e) { return []; }
}
function masterUid() {
  try { return Number((_ctx.config && _ctx.config.qq && _ctx.config.qq.master_user) || 0); } catch (e) { return 0; }
}
function memScopeOf(m, uid) {
  const u = String(uid);
  return (String(m.channel || "") === "group" && Number(m.groupId) > 0)
    ? "group:" + Number(m.groupId)
    : "user:" + u;
}
/* 该桶现存输入换算出的「有效来源键集合」（镜像 digest.py collect 的归属规则） */
function liveKeys(bucketName) {
  const mu = masterUid();
  const keys = new Set();
  try {
    if (bucketName === "global") {
      /* global 桶=ident/refl 中 from==0 且未被重定向到主人的条目 */
      const identItems = readSelfList("identity.json");
      for (const e of identItems) {
        const f = Number((e && e.from) || 0);
        if (f !== 0) continue;
        keys.add(srcId("ident", "self", textOf(e)));
      }
      const reflItems = readSelfList("reflections.json");
      for (const r of reflItems) {
        const f = Number((r && r.from) || 0);
        if (f !== 0) continue;
        const text = textOf(r);
        if ((r && r.subject) === "master" || (mu && String(text).includes("主人"))) continue;
        keys.add(srcId("refl", "self", text));
      }
      return keys;
    }
    const uid = String(bucketName);
    /* 本人桶=该用户短期记忆 + from==该 uid 的 ident/refl + 归属主人的 refl */
    const memSvc = _ctx.getApi ? _ctx.getApi("memory") : null;
    const items = (memSvc && memSvc.loadMemories) ? (memSvc.loadMemories(uid) || []) : [];
    for (const m of items) {
      if (!m || !m.content) continue;
      keys.add(srcId("mem", memScopeOf(m, uid), m.content));
    }
    const identItems = readSelfList("identity.json");
    for (const e of identItems) {
      if (Number((e && e.from) || 0) !== Number(uid)) continue;
      keys.add(srcId("ident", "user:" + uid, textOf(e)));
    }
    const reflItems = readSelfList("reflections.json");
    for (const r of reflItems) {
      const text = textOf(r);
      const mine = Number((typeof r === "object" && r && r.from) || 0) === Number(uid);
      const toMaster = (r && r.subject) === "master" || (mu && String(text).includes("主人"));
      if (!mine && !toMaster) continue;
      keys.add(srcId("refl", "user:" + uid, text));
    }
  } catch (e) { try { _ctx.log("warn", "digest liveKeys 失败：" + e.message); } catch (e2) {} }
  return keys;
}
/* fail-closed：证据为空/不是 S_ 稳定键/有任何一个已不在 live 集 → 该 topic 不注入 */
function topicActive(t, live) {
  if (!t || !live) return false;
  const ev = t.evidence;
  if (!Array.isArray(ev) || !ev.length) return false;
  for (const k of ev) {
    if (!/^S_[0-9a-f]{12}$/.test(String(k))) return false;
    if (!live.has(String(k))) return false;
  }
  return true;
}
/* 桶的 topics 里筛出仍有效的（旧位置号/失效证据一律不注入） */
function activeTopics(bucket, live) {
  if (!bucket || !Array.isArray(bucket.topics)) return [];
  return bucket.topics.filter((t) => topicActive(t, live));
}
function hasDigest(userId, opts) {
  const c = digestCtx(opts);
  const person = loadBucket(String(userId));
  const global = loadBucket("global");
  const ptop = activeTopics(person, liveKeys(String(userId)));
  const gtop = activeTopics(global, liveKeys("global"));
  if (!ptop.length && !gtop.length) return false;
  if (c.channel === "group") {
    return ptop.some((t) => String(t.privacy_scope || "") === "group:" + c.groupId) || gtop.some((t) => t.public_self === true);
  }
  return ptop.some((t) => !/^group:/.test(String(t.privacy_scope || "")));
}
function maxTopics() { try { return Math.max(3, Number(_ctx.getSetting("mem.digest.max_topics", 20)) || 20); } catch (e) { return 20; } }

function fmtTopics(bucket, limit, opts) {
  const o = opts || {};
  const topics = (bucket && Array.isArray(bucket.topics)) ? bucket.topics : [];
  return topics
    .filter((t) => !(o.dedupFor && t.duplicate_of === o.dedupFor))
    .filter((t) => !(o.publicOnly && t.public_self !== true))
    .filter((t) => !(o.scopeOnly && String(t.privacy_scope || "") !== o.scopeOnly))
    .filter((t) => !(o.excludeGroupScoped && /^group:/.test(String(t.privacy_scope || ""))))
    .slice(0, limit)
    .map((t) => `- ${t.insight || t.theme || ""}`)
    .filter((s) => s.length > 2);
}
function isAdmin(uid) {
  try {
    const r = _ctx.getApi && _ctx.getApi("roles");
    return r ? r.resolveRole(uid) === "admin" : false;
  } catch (e) { return false; }
}

/* v2.1 WP2：digest 作用域。opts={channel,groupId}；旧签名（无 opts）按 private 安全兼容 */
function digestCtx(opts) {
  const o = opts || {};
  const channel = o.channel === "group" ? "group" : "private";
  return { channel, groupId: Number(o.groupId) || 0 };
}
/* 给提示词用的消化文本：按作用域取桶；没开或没文件返回 null */
function digestText(userId, opts) {
  if (!enabled()) return null;
  const c = digestCtx(opts);
  const limit = maxTopics();
  const admin = isAdmin(userId);
  const person = { topics: activeTopics(loadBucket(String(userId)), liveKeys(String(userId))) };
  const global = { topics: activeTopics(loadBucket("global"), liveKeys("global")) };
  const parts = [];
  /* 5.4/5.5：无作用域 global 只许主人 private/pet；其余上下文只放行 public_self */
  const masterPrivate = admin && c.channel !== "group";
  if (global) {
    const lines = masterPrivate
      ? fmtTopics(global, limit, { dedupFor: String(userId) })
      : fmtTopics(global, limit, { publicOnly: true });
    if (lines.length) parts.push(`【你对自己的认识（消化后，比流水账更稳定）】\n${lines.join("\n")}`);
  }
  if (person) {
    /* 5.1/5.2：私聊看本人桶但排除显式群 scope 记录；群上下文只看该群 scope */
    const lines = c.channel === "group"
      ? fmtTopics(person, limit, { scopeOnly: "group:" + c.groupId })
      : fmtTopics(person, limit, { excludeGroupScoped: true });
    if (lines.length) parts.push(`【你对对方的认识（消化后）】\n${lines.join("\n")}`);
  }
  return parts.length ? parts.join("\n") : null;
}

/* WP4：最小只读运行状态（读 manifest.json，不写任何文件） */
function digestStatus() {
  const out = { scopes: {}, pending: [], dead: [], lastSuccess: 0, stale: [], lastError: "" };
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(digestDir(), "manifest.json"), "utf8"));
    const scopes = (mf && mf.scopes) || {};
    const now = Date.now();
    for (const name of Object.keys(scopes)) {
      const rec = scopes[name] || {};
      out.scopes[name] = { status: rec.status || "unknown", lastSuccess: rec.last_success || 0, error: rec.error || "", sourceRevision: rec.source_revision || "", counts: rec.counts || {}, failStreak: rec.fail_streak || 0 };
      if (rec.last_success) out.lastSuccess = Math.max(out.lastSuccess, Number(rec.last_success) || 0);
      if (rec.error) out.lastError = String(rec.error).slice(0, 120);
      if (rec.status && rec.status !== "ok" && rec.status !== "pending_commit") out.pending.push(name);
      if (rec.last_success && now - Number(rec.last_success) > 7 * 24 * 3600e3) out.stale.push(name);
      if (Number(rec.fail_streak || 0) >= 3) out.dead.push(name);
    }
  } catch (e) {}
  return out;
}
function info() {
  const out = { enabled: enabled(), global: null, persons: [] };
  try {
    const g = loadBucket("global");
    if (g) out.global = { source: g.source_count, topics: (g.topics || []).length, updated: g.updated };
    for (const f of fs.readdirSync(digestDir())) {
      if (!/^\d+\.json$/.test(f)) continue;
      const d = loadBucket(f.replace(/\.json$/, ""));
      out.persons.push({ uid: f.replace(/\.json$/, ""), source: d.source_count, topics: (d.topics || []).length });
    }
  } catch (e) {}
  return out;
}

function runDigest(args) {
  try { _ctx.setActivity("在整理记忆"); } catch (e) {}
  return new Promise((resolve) => {
    const py = (_ctx.config.runtime && _ctx.config.runtime.python_path) || "python";
    const script = path.join(__dirname, "..", "digest.py");
    let out = "", err = "";
    let p;
    try {
      p = spawn(py, [script].concat(args || []), { cwd: path.join(__dirname, ".."), windowsHide: true });
    } catch (e) {
      try { _ctx.setActivity("发呆"); } catch (e2) {}
      return resolve({ ok: false, msg: "启动 digest.py 失败：" + e.message });
    }
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("close", (code) => {
      const resLine = (out.match(/RESULT (\{[\s\S]*?\})\s*$/) || [])[1];
      let parsed = null;
      if (resLine) { try { parsed = JSON.parse(resLine); } catch (e) {} }
      const all = parsed ? parsed.all === true : code === 0;
      if (all) { try { _ctx.recordAction({ action: "digest", ok: true }); } catch (e) {} }
      try { _ctx.setActivity("发呆"); } catch (e) {}
      resolve({ ok: code === 0, code, all, partial: !!(parsed && parsed.partial), okNames: (parsed && parsed.ok) || [], failNames: (parsed && parsed.failed) || [], out: out.trim(), err: err.trim().slice(0, 400) });
    });
    p.on("error", (e) => { try { _ctx.setActivity("发呆"); } catch (e2) {} resolve({ ok: false, msg: e.message }); });
  });
}

module.exports = {
  name: "memory-digest",
  displayName: "记忆消化",
  description: "读消化后的「认识」，替换流水账注入（mem.digest）",
  userScoped: true,
  requires: ["time"],
  permissions: ["DATA_DIR", "config", "getApi", "getSetting", "isMaster", "log", "recordAction", "setActivity"],
  version: "1.2.0",
  init(ctx) { _ctx = ctx; try { startTimer(); } catch (e) {} },
  dispose() { try { if (_timer) { clearInterval(_timer); _timer = null; } } catch (e) {} },
  settings: [
    { key: "mem.digest.enabled", label: "注入消化后的认识", type: "boolean", default: true, desc: "打开后用「记忆消化」产出的认识替代流水账注入（需先跑一次 memory_digest）" },
    { key: "mem.digest.max_topics", label: "最多注入几条认识", type: "number", default: 20, min: 3, max: 40, desc: "本人桶和通用桶各自的上限" },
    { key: "mem.digest.max_merge", label: "每个主题最多合并几条", type: "number", default: 2, min: 2, max: 6, desc: "越小越细（2=只合并两两相近的条目）" },
    { key: "mem.digest.prefilter", label: "消化前规则预筛", type: "boolean", default: true, desc: "先剔掉空白/纯符号/字面重复的条目，省 token" },
    { key: "mem.digest.dedup", label: "跨桶去重（规则）", type: "boolean", default: true, desc: "相同认识只保留更具体的桶（个人桶优先于通用）" },
    { key: "mem.digest.dedup_llm", label: "跨桶去重（模型复核）", type: "boolean", default: true, desc: "额外 1 次调用，找出规则漏掉的语义重复" },
    { key: "mem.digest.temperature", label: "消化温度", type: "number", default: 0, min: 0, max: 1, desc: "0 = 最稳定，越低越不飘" },
    { key: "mem.digest.seed", label: "消化随机种子", type: "number", default: 42, min: 0, max: 999999, desc: "0 = 不用；固定值可降低波动（不保证完全复现）" },
    { key: "mem.digest.daily", label: "每晚自动消化", type: "boolean", default: true, desc: "每天到点自动跑一次消化（依赖下面那个小时）" },
    { key: "mem.digest.hour", label: "每天几点消化", type: "number", default: 22, min: 0, max: 23, desc: "整点，默认 22 点" },
  ],
  apiSpec: {"memoryDigest":{"digestText":{"input":"","output":"","sideEffect":""},"info":{"input":"","output":"","sideEffect":""},"runDigest":{"input":"","output":"","sideEffect":""},"digestStatus":{"input":"","output":"","sideEffect":"只读"},"enabled":{"input":"","output":"","sideEffect":""},"hasDigest":{"input":"","output":"","sideEffect":"只读"},"dailyDue":{"input":"","output":"","sideEffect":""},"tick":{"input":"","output":"","sideEffect":""}}},

  api: { memoryDigest: { digestText, info, runDigest, enabled, hasDigest, dailyDue, tick, digestStatus } },
  __test: { srcId, topicActive, liveKeys, activeTopics, digestStatus },
  tools: [
    {
      def: {
        type: "function",
        function: {
          name: "memory_digest",
          description: "整理（消化）自己的记忆：把最近的成长记忆和反思合成稳定的「认识」，替换流水账注入。只在主人明确说「整理一下记忆」「消化记忆」时调用。",
          parameters: { type: "object", properties: { uid: { type: "number", description: "可选，只消化某个人的桶" } } },
        },
      },
      async handler(args, info2) {
        if (!_ctx.isMaster(info2.userId)) return "（只有主人能让我整理记忆哦）";
        const a = [];
        if (args && Number(args.uid)) a.push("--uid", String(Number(args.uid)));
        const r = await runDigest(a);
        if (!r.ok) return `整理没成功：${r.msg || r.err || "未知错误"}`;
        const lines = (r.out || "").split("\n").filter(Boolean);
        const detail = lines.slice(0, 6).join("；");
        _ctx.log("info", `记忆消化完成：${detail}`);
        return `整理好啦～${detail ? "结果：" + detail : "已生成新的认识"}（用 settings_set 打开 mem.digest.enabled 后生效）`;
      },
    },
  ],
};
