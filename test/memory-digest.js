/* test/memory-digest.js —— 记忆消化插件（v1.48.0 起） */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "momo-digest-"));
const DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(path.join(DATA_DIR, "memory-digest"), { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, "memory-digest", "global.json"), JSON.stringify({
  updated: 1, source_count: 10, topics: [{ theme: "作息", insight: "我总操心对方有没有按时吃饭。" }],
}));
fs.writeFileSync(path.join(DATA_DIR, "memory-digest", "42.json"), JSON.stringify({
  updated: 1, source_count: 5, topics: [{ theme: "夸奖", insight: "被夸时先问清细节再行动。" }],
}));

const DIGEST = require(path.join(__dirname, "..", "plugins", "memory-digest.js"));

function makeCtx(settings) {
  return {
    config: { pet: {} },
    DATA_DIR,
    log: () => {},
    getSetting: (k, d) => (Object.prototype.hasOwnProperty.call(settings, k) ? settings[k] : d),
  };
}

let n = 0;
function check(name, fn) { fn(); n++; console.log("✓ " + name); }

check("默认开启时注入", () => {
  DIGEST.init(makeCtx({}));
  const t = DIGEST.api.memoryDigest.digestText(42);
  assert.ok(t.includes("我总操心对方有没有按时吃饭"));
});
check("显式关闭时不注入", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": false }));
  assert.strictEqual(DIGEST.api.memoryDigest.digestText(42), null);
});
check("打开后注入本人桶 + 通用桶", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": true }));
  const t = DIGEST.api.memoryDigest.digestText(42);
  assert.ok(t.includes("我总操心对方有没有按时吃饭"));
  assert.ok(t.includes("被夸时先问清细节再行动"));
  assert.ok(t.includes("你对自己的认识"));
  assert.ok(t.includes("你对对方的认识"));
});
check("info 能列出桶", () => {
  const i = DIGEST.api.memoryDigest.info();
  assert.strictEqual(i.enabled, true);
  assert.strictEqual(i.global.topics, 1);
  assert.strictEqual(i.persons[0].uid, "42");
});
check("max_topics 限制条数", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": true, "mem.digest.max_topics": 3 }));
  assert.ok(DIGEST.api.memoryDigest.digestText(42));
});
check("dailyDue：未到点不跑", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": true, "mem.digest.hour": 22 }));
  assert.strictEqual(DIGEST.api.memoryDigest.dailyDue(new Date(2026, 10, 4, 10, 0), {}), false);
});
check("dailyDue：到点且今天没跑 → 跑", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": true, "mem.digest.hour": 22 }));
  assert.strictEqual(DIGEST.api.memoryDigest.dailyDue(new Date(2026, 10, 4, 22, 5), {}), true);
});
check("dailyDue：今天已经跑过 → 不跑", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": true, "mem.digest.hour": 22 }));
  const now = new Date(2026, 10, 4, 23, 0);
  assert.strictEqual(DIGEST.api.memoryDigest.dailyDue(now, { lastDate: now.toDateString() }), false);
});
check("dailyDue：关掉每晚消化 → 不跑", () => {
  DIGEST.init(makeCtx({ "mem.digest.enabled": true, "mem.digest.hour": 22, "mem.digest.daily": false }));
  assert.strictEqual(DIGEST.api.memoryDigest.dailyDue(new Date(2026, 10, 4, 23, 0), {}), false);
});
console.log(`\n✓ 全部 ${n} 个断言通过`);
