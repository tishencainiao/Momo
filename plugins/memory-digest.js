/* 插件：记忆消化（读取消化后的「认识」，替换流水账注入）
 * 数据：data/memory-digest/<uid>.json 与 global.json（由 digest.py 生成）
 * 设计：本人桶 → 对「这个人」的认识；global → 对自己/世界的通用认识。
 * 默认开启（mem.digest.enabled=true）：消化后的「认识」替代流水账注入。
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
let _ctx = null;
let _timer = null;

const STATE_FILE = () => path.join(_ctx.DATA_DIR, "digest-state.json");
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")); } catch (e) { return {}; } }
function saveState(st) { try { fs.writeFileSync(STATE_FILE(), JSON.stringify(st)); } catch (e) {} }
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
  if (now.getHours() < dailyHour()) return false;
  return ((st && st.lastDate) !== now.toDateString());
}
function tick() {
  const now = new Date();
  const st = loadState();
  if (!dailyDue(now, st)) return;
  runDigest([]).then((r) => {
    if (!r.ok) { try { _ctx.log("warn", "每日记忆消化失败：" + (r.err || r.msg || "")); } catch (e) {} return; }
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
function hasDigest(userId) { return !!loadBucket(String(userId)); }
function maxTopics() { try { return Math.max(3, Number(_ctx.getSetting("mem.digest.max_topics", 20)) || 20); } catch (e) { return 20; } }

function fmtTopics(bucket, limit, opts) {
  const o = opts || {};
  const topics = (bucket && Array.isArray(bucket.topics)) ? bucket.topics : [];
  return topics
    .filter((t) => !(o.dedupFor && t.duplicate_of === o.dedupFor))
    .filter((t) => !(o.hideMaster && /主人/.test(String(t.insight || "") + String(t.theme || ""))))
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

/* 给提示词用的消化文本：本人桶 + 通用桶；没开或没文件返回 null */
function digestText(userId) {
  if (!enabled()) return null;
  const limit = maxTopics();
  const admin = isAdmin(userId);
  const person = loadBucket(String(userId));
  const global = loadBucket("global");
  const parts = [];
  if (global) {
    /* 跨桶去重：只有当浏览者自己的桶里有同一条时，才跳过 global 那条（别把通用特质藏掉） */
    const lines = fmtTopics(global, limit, { dedupFor: String(userId), hideMaster: !admin });
    if (lines.length) parts.push(`【你对自己的认识（消化后，比流水账更稳定）】\n${lines.join("\n")}`);
  }
  if (person) {
    const lines = fmtTopics(person, limit, { skipDup: false });
    if (lines.length) parts.push(`【你对对方的认识（消化后）】\n${lines.join("\n")}`);
  }
  return parts.length ? parts.join("\n") : null;
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
      if (code === 0) { try { _ctx.recordAction({ action: "digest", ok: true }); } catch (e) {} }
      try { _ctx.setActivity("发呆"); } catch (e) {}
      resolve({ ok: code === 0, code, out: out.trim(), err: err.trim().slice(0, 400) });
    });
    p.on("error", (e) => { try { _ctx.setActivity("发呆"); } catch (e2) {} resolve({ ok: false, msg: e.message }); });
  });
}

module.exports = {
  name: "memory-digest",
  displayName: "记忆消化",
  description: "读消化后的「认识」，替换流水账注入（mem.digest）",
  permissions: ["DATA_DIR", "config", "getApi", "getSetting", "isMaster", "log", "recordAction", "setActivity"],
  version: "1.0.0",
  init(ctx) { _ctx = ctx; try { startTimer(); } catch (e) {} },
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
  apiSpec: {"memoryDigest":{"digestText":{"input":"","output":"","sideEffect":""},"info":{"input":"","output":"","sideEffect":""},"runDigest":{"input":"","output":"","sideEffect":""},"enabled":{"input":"","output":"","sideEffect":""},"hasDigest":{"input":"","output":"","sideEffect":"只读"},"dailyDue":{"input":"","output":"","sideEffect":""},"tick":{"input":"","output":"","sideEffect":""}}},

  api: { memoryDigest: { digestText, info, runDigest, enabled, hasDigest, dailyDue, tick } },
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
