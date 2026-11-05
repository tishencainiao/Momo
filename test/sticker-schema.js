/* test/sticker-schema.js —— 表情包语义标注列迁移（v1.54.0） */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require("../sticker-store");

const TMP = path.join(os.tmpdir(), "momo-sticker-" + process.pid + ".db");
try { fs.unlinkSync(TMP); } catch (e) {}

let n = 0;
function check(name, fn) { fn(); n++; console.log("✓ " + name); }

check("init 自动补齐语义标注列", () => {
  store.init(TMP);
  const cols = store._peek().prepare("PRAGMA table_info(stickers)").all().map((c) => c.name);
  for (const c of ["what", "text_in_image", "meaning", "usage", "tags", "annotate_confidence", "annotated_at", "annotate_model", "annotate_status"]) {
    assert.ok(cols.includes(c), "缺列 " + c);
  }
});
check("迁移幂等（第二次返回 0）", () => {
  assert.strictEqual(store.migrateStickerSchema(), 0);
});
check("标注字段可写入读出", () => {
  const saved = store.upsert("t1.webp", {
    tier: "builtin",
    what: "一只气鼓鼓的小猫",
    textInImage: "真当我是便宜货啊",
    meaning: "不服气，撒娇式反驳",
    usage: "被低估时回怼",
    tags: '["气鼓鼓","反驳"]',
    annotateConfidence: 0.9,
    annotatedAt: 123,
    annotateModel: "test-model",
    annotateStatus: "ok",
  });
  assert.ok(saved);
  const r = store.get("t1.webp");
  assert.strictEqual(r.what, "一只气鼓鼓的小猫");
  assert.strictEqual(r.textInImage, "真当我是便宜货啊");
  assert.strictEqual(r.meaning, "不服气，撒娇式反驳");
  assert.strictEqual(r.usage, "被低估时回怼");
  assert.strictEqual(r.tags, '["气鼓鼓","反驳"]');
  assert.strictEqual(r.annotateConfidence, 0.9);
  assert.strictEqual(r.annotateStatus, "ok");
});
check("旧字段不受影响", () => {
  const r = store.get("t1.webp");
  assert.strictEqual(r.desc, "");
  assert.strictEqual(r.risk, "low");
  assert.strictEqual(r.status, "observed");
});
console.log(`\n✓ 全部 ${n} 个断言通过`);
try { store.close(); fs.unlinkSync(TMP); } catch (e) {}
