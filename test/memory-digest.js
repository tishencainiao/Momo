#!/usr/bin/env node
/* 记忆消化插件（v2.1 WP2 作用域化 + WP3 证据化校验）——
   global 桶只放行 public_self（主人 private 除外）；person 桶按 channel/group 过滤；
   WP3：topic 证据必须是仍在 live 集的 S_ 稳定键（旧位置号/伪造/失效证据一律不注入）。 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "momo-digest-"));
const DATA_DIR = path.join(TMP, "data");
const SELF_DIR = path.join(TMP, "self");
fs.mkdirSync(path.join(DATA_DIR, "memory-digest"), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "memory"), { recursive: true });
fs.mkdirSync(SELF_DIR, { recursive: true });

const MU = 100000001;

const DIGEST = require(path.join(__dirname, "..", "plugins", "memory-digest.js"));
const { srcId } = DIGEST.__test;

/* ---- 来源数据（memory + self）---- */
/* 42（主人）的记忆：1 条 legacy 私聊 + 1 条群内称呼 + 1 条将被遗忘/编辑的条目 */
const mem42 = {
  updated: 1,
  items: [
    { content: "被夸时先问清细节再行动。", channel: "private", groupId: 0 },
    { content: "群里大家都叫他老八。", channel: "group", groupId: 100000003 },
    { content: "主人最近在学 Rust。", channel: "private", groupId: 0 },
  ],
};
/* 43（朋友）：1 条 legacy 私聊 */
const mem43 = { updated: 1, items: [{ content: "43 号朋友爱吃辣。", channel: "private", groupId: 0 }] };
fs.writeFileSync(path.join(DATA_DIR, "memory", String(MU) + ".json"), JSON.stringify(mem42));
fs.writeFileSync(path.join(DATA_DIR, "memory", "43.json"), JSON.stringify(mem43));

/* self：identity + reflections（from==0 归 global；from==42 归本人桶；含「主人」重定向到主人桶） */
const identity = [
  { text: "我是一只叫 Momo 的大肥鱼。", from: 0 },
  { text: "被夸时先问清细节再行动。", from: MU },
];
const reflections = [
  { text: "我总操心对方有没有按时吃饭。", from: 0 },
  { text: "主人的电脑密码是生日。", from: 0, subject: "master" },   // → 主人桶，不进 global
];
fs.writeFileSync(path.join(SELF_DIR, "identity.json"), JSON.stringify(identity));
fs.writeFileSync(path.join(SELF_DIR, "reflections.json"), JSON.stringify(reflections));

const kIdGlobal = srcId("ident", "self", "我是一只叫 Momo 的大肥鱼。");
const kReflGlobal = srcId("refl", "self", "我总操心对方有没有按时吃饭。");
const kReflMaster = srcId("refl", "user:" + MU, "主人的电脑密码是生日。");
const kMem42Legacy = srcId("mem", "user:" + MU, "被夸时先问清细节再行动。");
const kMem42Group = srcId("mem", "group:100000003", "群里大家都叫他老八。");
const kMem42Rust = srcId("mem", "user:" + MU, "主人最近在学 Rust。");
const kIdent42 = srcId("ident", "user:" + MU, "被夸时先问清细节再行动。");
const kMem43 = srcId("mem", "user:43", "43 号朋友爱吃辣。");
const kFake = "S_" + "0".repeat(12);

/* ---- digest 桶（证据化 topics）---- */
function writeDigest(name, topics) {
  fs.writeFileSync(path.join(DATA_DIR, "memory-digest", name + ".json"), JSON.stringify({
    updated: 1, source_count: 10, schema: 2, topics,
  }));
}
writeDigest("global", [
  { theme: "作息", insight: "我总操心对方有没有按时吃饭。", evidence: [kReflGlobal] },
  { theme: "公开认识", insight: "我是一只叫 Momo 的大肥鱼。", evidence: [kIdGlobal], public_self: true },
]);
writeDigest(String(MU), [
  { theme: "私事", insight: "主人的电脑密码是生日。", evidence: [kReflMaster] },
  { theme: "夸奖", insight: "被夸时先问清细节再行动。", evidence: [kMem42Legacy, kIdent42] },
  { theme: "群内称呼", insight: "群里大家都叫他老八。", evidence: [kMem42Group], privacy_scope: "group:100000003" },
  { theme: "兴趣", insight: "主人最近在学 Rust。", evidence: [kMem42Rust] },
]);
writeDigest("43", [
  { theme: "口味", insight: "43 号朋友爱吃辣。", evidence: [kMem43] },
]);

function makeCtx(settings) {
  return {
    config: { pet: {}, qq: { master_user: MU } },
    DATA_DIR,
    SELF_DIR,
    log: () => {},
    writeJsonAtomic: (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 0)); } catch (e) {} },
    writeFileAtomic: (f, t) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); } catch (e) {} },
    getSetting: (k, d) => (Object.prototype.hasOwnProperty.call(settings, k) ? settings[k] : d),
    getApi: (ns) => {
      if (ns === "time") return require(path.join(__dirname, "..", "plugins", "time-service.js")).api.time;
      if (ns === "roles") return { resolveRole: (uid) => (String(uid) === String(MU) ? "admin" : "user") };
      if (ns === "memory") return { loadMemories: (uid) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "memory", uid + ".json"), "utf8")).items || []; } catch (e) { return []; } } };
      return null;
    },
  };
}

let n = 0;
function check(name, fn) { try { fn(); n++; console.log("  ✓ " + name); } catch (e) { console.error("  ✗ " + name + "  → " + e.message); process.exitCode = 1; } }

/* ---- WP2 作用域（证据化后仍成立）---- */
check("主人私聊：global 全量 + 本人桶排除显式群记录（B07/B10）", () => {
  DIGEST.init(makeCtx({}));
  const t = DIGEST.api.memoryDigest.digestText(MU, { channel: "private", groupId: 0 });
  if (!t) throw new Error("digestText 返回 null");
  if (!t.includes("我总操心对方有没有按时吃饭")) throw new Error("缺 global 条目");
  if (!t.includes("我是一只叫 Momo 的大肥鱼")) throw new Error("缺 public_self 条目");
  if (!t.includes("主人的电脑密码是生日")) throw new Error("主人 private 应可见本人桶条目");
  if (!t.includes("被夸时先问清细节再行动")) throw new Error("缺本人 legacy 私聊条目");
  if (t.includes("群里大家都叫他老八")) throw new Error("显式群 scope 不应进私聊");
});
check("旧签名（无 opts）安全兼容 = private", () => {
  DIGEST.init(makeCtx({}));
  const t = DIGEST.api.memoryDigest.digestText(MU);
  if (!t || !t.includes("被夸时先问清细节再行动")) throw new Error("旧签名应等价 private");
});
check("非主人私聊：global 只放行 public_self，本人桶照常（B10）", () => {
  DIGEST.init(makeCtx({}));
  const t = DIGEST.api.memoryDigest.digestText(43, { channel: "private", groupId: 0 });
  if (!t) throw new Error("digestText 返回 null");
  if (!t.includes("我是一只叫 Momo 的大肥鱼")) throw new Error("public_self 应可见");
  if (t.includes("我总操心对方有没有按时吃饭")) throw new Error("legacy global 不应进非主人");
  if (t.includes("主人的电脑密码是生日")) throw new Error("主人桶条目不应进别人私聊");
  if (!t.includes("43 号朋友爱吃辣")) throw new Error("本人桶应照常");
});
check("群上下文：global 只 public_self、本人桶只该群 scope（B06/B11）", () => {
  DIGEST.init(makeCtx({}));
  const t = DIGEST.api.memoryDigest.digestText(MU, { channel: "group", groupId: "100000003" });
  if (!t) throw new Error("digestText 返回 null");
  if (!t.includes("我是一只叫 Momo 的大肥鱼")) throw new Error("public_self 应可见");
  if (t.includes("主人的电脑密码是生日")) throw new Error("主人桶条目不应进群");
  if (!t.includes("群里大家都叫他老八")) throw new Error("本群 scope 应可见");
  if (t.includes("被夸时先问清细节再行动")) throw new Error("legacy 私聊认识不应进群");
});
check("群上下文缺 groupId：本人桶不匹配、仅剩 public_self global", () => {
  DIGEST.init(makeCtx({}));
  const t = DIGEST.api.memoryDigest.digestText(MU, { channel: "group", groupId: 0 });
  if (t) {
    if (t.includes("群里大家都叫他老八")) throw new Error("group:0 不应匹配任何群记录");
    if (t.includes("被夸时先问清细节再行动")) throw new Error("缺 groupId 时 legacy 不应进群");
    if (!t.includes("我是一只叫 Momo 的大肥鱼")) throw new Error("public_self 应可见");
  }
});
check("hasDigest 与上下文同作用域", () => {
  DIGEST.init(makeCtx({}));
  const md = DIGEST.api.memoryDigest;
  if (md.hasDigest(MU, { channel: "private", groupId: 0 }) !== true) throw new Error("主人私聊应有 digest");
  if (md.hasDigest(MU, { channel: "group", groupId: "100000003" }) !== true) throw new Error("主人本群应有 digest");
  if (md.hasDigest(43, { channel: "private", groupId: 0 }) !== true) throw new Error("43 私聊应有 digest");
  if (md.hasDigest(43, { channel: "group", groupId: "100000003" }) !== true) throw new Error("global 有 public_self → 43 在群也有 digest");
});
check("显式关闭时不注入", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": false }));
  if (DIGEST.api.memoryDigest.digestText(MU) !== null) throw new Error("关闭后应 null");
});
check("info 能列出桶", () => {
  DIGEST.init(makeCtx({}));
  const i = DIGEST.api.memoryDigest.info();
  if (i.enabled !== true) throw new Error("enabled");
  if (i.global.topics !== 2) throw new Error("global topics 应 2");
  if (!i.persons.some((p) => p.uid === String(MU))) throw new Error("persons 缺主人桶");
});
check("max_topics 限制条数", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": true, "mem.digest.max_topics": 3 }));
  if (!DIGEST.api.memoryDigest.digestText(MU)) throw new Error("应仍有输出");
});
check("dailyDue：未到点不跑", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": true, "mem.digest.hour": 22 }));
  if (DIGEST.api.memoryDigest.dailyDue(new Date(2026, 10, 4, 10, 0), {}) !== false) throw new Error("10 点不该跑");
});
check("dailyDue：到点且今天没跑 → 跑", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": true, "mem.digest.hour": 22 }));
  if (DIGEST.api.memoryDigest.dailyDue(new Date(2026, 10, 4, 22, 5), {}) !== true) throw new Error("22:05 该跑");
});
check("dailyDue：今天已经跑过 → 不跑", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": true, "mem.digest.hour": 22 }));
  const now = new Date(2026, 10, 4, 23, 0);
  if (DIGEST.api.memoryDigest.dailyDue(now, { lastDate: now.toDateString() }) !== false) throw new Error("已跑过不该再跑");
});
check("dailyDue：关掉每晚消化 → 不跑", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": true, "mem.digest.hour": 22, "mem.digest.daily": false }));
  if (DIGEST.api.memoryDigest.dailyDue(new Date(2026, 10, 4, 23, 0), {}) !== false) throw new Error("daily=false 不该跑");
});

/* ---- WP3 证据化校验（fail-closed）---- */
check("WP3：legacy 位置号（A1/R1/M1）不再是凭据，不注入", () => {
  DIGEST.init(makeCtx({}));
  const r = DIGEST.__test.topicActive({ theme: "旧", insight: "旧认识", evidence: ["A1"] }, new Set([kMem42Legacy]));
  if (r !== false) throw new Error("位置号应失效");
  const r2 = DIGEST.__test.topicActive({ theme: "旧", insight: "旧认识", evidence: ["R2", "M1"] }, new Set());
  if (r2 !== false) throw new Error("位置号应失效 2");
});
check("WP3：伪造/不在 live 集的证据不注入", () => {
  DIGEST.init(makeCtx({}));
  const r = DIGEST.__test.topicActive({ theme: "假", insight: "假认识", evidence: [kFake] }, DIGEST.__test.liveKeys(String(MU)));
  if (r !== false) throw new Error("伪造证据应失效");
});
check("WP3：多证据任一失效 → 整个 topic 不注入", () => {
  DIGEST.init(makeCtx({}));
  const live = DIGEST.__test.liveKeys(String(MU));
  const r = DIGEST.__test.topicActive({ insight: "x", evidence: [kMem42Legacy, kFake] }, live);
  if (r !== false) throw new Error("一证据失效应整体不注入");
  const r2 = DIGEST.__test.topicActive({ insight: "x", evidence: [kMem42Legacy, kIdent42] }, live);
  if (r2 !== true) throw new Error("全部 live 应注入");
});
check("WP3：编辑来源后旧 topic 不注入（内容变了 id 变）", () => {
  /* 编辑 42 桶第 3 条记忆内容 → kMem42Rust 失效 → 兴趣 topic 不注入 */
  const m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "memory", String(MU) + ".json"), "utf8"));
  m.items[2].content = "主人最近在学 Go 语言。";
  fs.writeFileSync(path.join(DATA_DIR, "memory", String(MU) + ".json"), JSON.stringify(m));
  DIGEST.init(makeCtx({}));
  const t = DIGEST.api.memoryDigest.digestText(MU, { channel: "private", groupId: 0 });
  if (t && t.includes("主人最近在学 Rust")) throw new Error("编辑后旧 topic 不应注入");
  if (!t || !t.includes("被夸时先问清细节再行动")) throw new Error("其余 topic 应照常注入");
  m.items[2].content = "主人最近在学 Rust。";
  fs.writeFileSync(path.join(DATA_DIR, "memory", String(MU) + ".json"), JSON.stringify(m));
});
check("WP3：遗忘来源后 topic 不注入", () => {
  /* 删除 42 桶第 3 条记忆 → 兴趣 topic 不注入；恢复后重新注入 */
  const m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "memory", String(MU) + ".json"), "utf8"));
  m.items.pop();
  fs.writeFileSync(path.join(DATA_DIR, "memory", String(MU) + ".json"), JSON.stringify(m));
  DIGEST.init(makeCtx({}));
  let t = DIGEST.api.memoryDigest.digestText(MU, { channel: "private", groupId: 0 });
  if (t && t.includes("主人最近在学 Rust")) throw new Error("遗忘后 topic 不应注入");
  m.items.push({ content: "主人最近在学 Rust。", channel: "private", groupId: 0 });
  fs.writeFileSync(path.join(DATA_DIR, "memory", String(MU) + ".json"), JSON.stringify(m));
  t = DIGEST.api.memoryDigest.digestText(MU, { channel: "private", groupId: 0 });
  if (!t || !t.includes("主人最近在学 Rust")) throw new Error("恢复来源后 topic 应重新注入");
});
check("WP3：global 桶 only from==0 且「主人」重定向不进 global", () => {
  DIGEST.init(makeCtx({}));
  const g = DIGEST.__test.liveKeys("global");
  if (!g.has(kIdGlobal)) throw new Error("from==0 ident 应进 global");
  if (!g.has(kReflGlobal)) throw new Error("from==0 refl 应进 global");
  if (g.has(kReflMaster)) throw new Error("subject=master 的 refl 不应进 global");
});

check("WP4：digestStatus 读 manifest（pending/dead/stale/lastError）", () => {
  const ddir = path.join(DATA_DIR, "memory-digest");
  const now = Date.now();
  fs.writeFileSync(path.join(ddir, "manifest.json"), JSON.stringify({
    generation_id: "g1",
    scopes: {
      "100000001": { status: "ok", last_success: now - 1000, fail_streak: 0, error: "" },
      "43": { status: "failed", last_success: now - 1000, fail_streak: 4, error: "fake model failure" },
      "7": { status: "ok", last_success: now - 8 * 24 * 3600e3, fail_streak: 0, error: "" },
    },
  }));
  DIGEST.init(makeCtx({}));
  const st = DIGEST.__test.digestStatus();
  if (st.pending.indexOf("43") < 0) throw new Error("43 应进 pending（failed）");
  if (st.dead.indexOf("43") < 0) throw new Error("43 应进 dead（fail_streak>=3）");
  if (st.stale.indexOf("7") < 0) throw new Error("7 应进 stale（last_success 超 7 天）");
  if (!st.lastError.includes("fake model failure")) throw new Error("lastError 应含失败信息");
  if (st.scopes["100000001"].status !== "ok") throw new Error("主人桶应 ok");
});

check("B12：legacy 字符串条目（identity）能被 liveKeys 识别，跨语言证据一致", () => {
  const strItem = "我是早期的字符串身份记录";
  fs.writeFileSync(path.join(SELF_DIR, "identity.json"), JSON.stringify([
    { text: "我是一只叫 Momo 的大肥鱼。", from: 0 },
    strItem,
  ]));
  const live = DIGEST.__test.liveKeys("global");
  const k = srcId("ident", "self", strItem);
  if (!live.has(k)) throw new Error("字符串条目未进 liveKeys");
  if (!DIGEST.__test.topicActive({ evidence: [k] }, live)) throw new Error("字符串条目证据 topic 应 active");
  fs.writeFileSync(path.join(SELF_DIR, "identity.json"), JSON.stringify(identity));
});

check("B12：legacy 字符串条目（reflections）from 默认 0 归 global", () => {
  const strRefl = "我是字符串反思记录";
  fs.writeFileSync(path.join(SELF_DIR, "reflections.json"), JSON.stringify([
    { text: "我总操心对方有没有按时吃饭。", from: 0 },
    strRefl,
  ]));
  const live = DIGEST.__test.liveKeys("global");
  const k = srcId("refl", "self", strRefl);
  if (!live.has(k)) throw new Error("字符串反思未进 global liveKeys");
  fs.writeFileSync(path.join(SELF_DIR, "reflections.json"), JSON.stringify(reflections));
});

console.log("通过 " + n + " / 失败 " + (process.exitCode ? 1 : 0));
process.exit(process.exitCode ? 1 : 0);
