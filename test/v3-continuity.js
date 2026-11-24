/* v3.0.0：认识沉淀与分层自我行为矩阵 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
const C = require("../plugins/continuity-service.js");
let pass = 0, total = 0, chain = Promise.resolve();
function check(name, fn) { total++; chain = chain.then(async () => { try { await fn(); pass++; console.log("✓ " + name); } catch (e) { console.log("✗ " + name + " -> " + e.message); } }); }
function setup(name, digest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const md = path.join(dir, "memory-digest"); fs.mkdirSync(md, { recursive: true });
  if (digest) fs.writeFileSync(path.join(md, "user_1.json"), JSON.stringify(digest));
  const ctx = { DATA_DIR: dir, isMaster: (u) => Number(u) === 1, writeJsonAtomic(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); } };
  C.init(ctx);
  return { dir, ctx, api: C.api.continuity };
}
function dg(groups) { return { scope: "user:1", day: "2026-01-02", groups }; }

check("C01 只有 stable 证据组能形成认识", () => {
  const { api } = setup("momo-v3-c01-", dg([
    { status: "stable", summary: "主人喜欢喝茶", evidence_ids: ["e1", "e2"] },
    { status: "pending", summary: "未确认猜测", evidence_ids: ["e3"] },
  ]));
  const rows = api.beliefs();
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].statement, "主人喜欢喝茶");
  assert.ok(!api.contextFor({ channel: "private", userId: 1 }).includes("未确认猜测"));
});

check("C02/C03 重复消化幂等，新证据只增加确认", () => {
  const { dir, api } = setup("momo-v3-c02-", dg([{ status: "stable", summary: "主人喜欢喝茶", evidence_ids: ["e1"] }]));
  const file = path.join(dir, "memory-digest", "user_1.json");
  api.ingestDigest("user:1"); assert.strictEqual(api.beliefs().length, 1);
  fs.writeFileSync(file, JSON.stringify(dg([{ status: "stable", summary: "主人喜欢喝茶", evidence_ids: ["e1", "e2", "e3"] }])));
  api.ingestDigest("user:1");
  const rows = api.beliefs(); assert.strictEqual(rows.length, 1); assert.deepStrictEqual(rows[0].evidence_ids.sort(), ["e1", "e2", "e3"]);
});

check("C04 私聊、他人与群上下文严格隔离", () => {
  const { api } = setup("momo-v3-c04-");
  api.upsert({ scope: "user:1", statement: "只给主人看的认识", evidence_ids: ["u1-e1"] });
  api.upsert({ scope: "group:9", statement: "只给九群看的认识", evidence_ids: ["g9-e1"] });
  assert.ok(api.contextFor({ channel: "private", userId: 1 }).includes("只给主人"));
  assert.ok(!api.contextFor({ channel: "private", userId: 2 }).includes("只给主人"));
  assert.ok(!api.contextFor({ channel: "group", groupId: 9, userId: 1 }).includes("只给主人"));
  assert.ok(api.contextFor({ channel: "group", groupId: 9, userId: 1 }).includes("只给九群"));
  assert.strictEqual(api.contextFor({ channel: "group", userId: 1 }), "");
});

check("C05 冲突未解决标 contested 且不注入", () => {
  const { api } = setup("momo-v3-c05-");
  const r = api.upsert({ scope: "user:1", statement: "主人现在住北京", evidence_ids: ["e1"] });
  assert.strictEqual(api.contest(r.belief.belief_id, ["counter-e1"]).ok, true);
  assert.strictEqual(api.beliefs()[0].status, "contested");
  assert.ok(!api.contextFor({ channel: "private", userId: 1 }).includes("北京"));
});

check("C06 修订保留 supersedes 链，旧认识退出上下文", () => {
  const { api, dir } = setup("momo-v3-c06-");
  const old = api.upsert({ scope: "user:1", statement: "主人喜欢咖啡", evidence_ids: ["e1"] }).belief;
  const made = api.revise(old.belief_id, "主人现在喜欢茶", ["e2"]);
  assert.strictEqual(made.ok, true); assert.strictEqual(made.belief.supersedes, old.belief_id);
  const ctx = api.contextFor({ channel: "private", userId: 1 });
  assert.ok(ctx.includes("现在喜欢茶")); assert.ok(!ctx.includes("喜欢咖啡"));
  const log = fs.readFileSync(path.join(dir, "continuity", "revisions.jsonl"), "utf8");
  assert.ok(log.includes("belief_revised"));
});

check("C07 过期认识不注入", () => {
  const { api } = setup("momo-v3-c07-");
  const now = Date.now();
  api.upsert({ scope: "user:1", statement: "今天临时安排", evidence_ids: ["e1"], valid_until: now + 1000, now });
  assert.ok(api.contextFor({ channel: "private", userId: 1 }, now + 500).includes("临时安排"));
  assert.ok(!api.contextFor({ channel: "private", userId: 1 }, now + 1500).includes("临时安排"));
});

check("C08 core 自我不可自改", () => {
  const { api } = setup("momo-v3-c08-");
  const before = api.identity().core.slice();
  const r = api.reviseCore("honesty", false);
  assert.strictEqual(r.ok, false); assert.deepStrictEqual(api.identity().core, before);
});

check("C09 slow 必须两条已知证据，重启后修订保留", () => {
  const { api } = setup("momo-v3-c09-");
  api.upsert({ scope: "user:1", statement: "证据一", evidence_ids: ["e1", "e2"] });
  assert.strictEqual(api.reviseSlow("style", "温柔", ["e1"]).ok, false);
  assert.strictEqual(api.reviseSlow("style", "温柔", ["e1", "unknown"]).ok, false);
  assert.strictEqual(api.reviseSlow("style", "温柔", ["e1", "e2"]).ok, true);
  const again = C.api.continuity.identity();
  assert.strictEqual(again.slow.style.value, "温柔");
});

check("C10 fast 到期失效，不改 slow/core", () => {
  const { api } = setup("momo-v3-c10-");
  const now = Date.now();
  api.setFast("current_activity", "读书", 1000, now);
  assert.ok(api.contextFor({ channel: "private", userId: 1 }, now + 500).includes("读书"));
  const later = api.contextFor({ channel: "private", userId: 1 }, now + 1500);
  assert.ok(!later.includes("读书")); assert.strictEqual(api.identity().fast.current_activity.valid_until, now + 1000);
});

check("S03 新数据损坏时上下文降级而不崩溃", () => {
  const { api, dir } = setup("momo-v3-s03-");
  fs.mkdirSync(path.join(dir, "continuity"), { recursive: true });
  fs.writeFileSync(path.join(dir, "continuity", "beliefs.json"), "{broken");
  let text = "";
  assert.doesNotThrow(() => { text = api.contextFor({ channel: "private", userId: 1 }); });
  assert.strictEqual(text, ""); assert.ok(api.health().degraded);
});

check("认识写盘失败返回失败而不伪报", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-v3-cwrite-"));
  C.init({ DATA_DIR: dir, isMaster: () => true, writeJsonAtomic() { throw new Error("disk full"); } });
  const r = C.api.continuity.upsert({ scope: "user:1", statement: "不能假装保存", evidence_ids: ["e1"] });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, "write_failed");
});

chain.then(() => { console.log(`v3-continuity: ${pass}/${total} passed`); process.exit(pass === total ? 0 : 1); }).catch((e) => { console.error(e); process.exit(1); });
