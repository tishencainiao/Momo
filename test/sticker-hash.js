/* test/sticker-hash.js —— 收图反查（sha256 → 表情包标注）（v1.56.0） */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDb = path.join(os.tmpdir(), "momo-sticker-hash-" + process.pid + ".db");
const plugin = require(path.join(__dirname, "..", "plugins", "stickers.js"));
plugin.init({
  log: () => {},
  STICKER_DB: tmpDb,
  DATA_DIR: path.dirname(tmpDb),
  config: {},
  settings: () => ({}),
  canAfford: () => true,
  completeOnce: async () => "1",
});
const api = plugin.api.stickers;
const store = api.store();

let n = 0;
function check(name, fn) { fn(); n++; console.log("✓ " + name); }

const BUF = Buffer.from("fake-image-bytes-for-hash-test");

check("findByHash 未标注时返回 null", () => {
  assert.strictEqual(api.findByHash(BUF), null);
});
check("写入 hash 后能反查", () => {
  const crypto = require("crypto");
  const hash = crypto.createHash("sha256").update(BUF).digest("hex");
  store.upsert("t1.webp", {
    tier: "builtin", imgHash: hash,
    what: "一只气鼓鼓的小猫", meaning: "不服气", textInImage: "真当我是便宜货啊",
  });
  const s = api.findByHash(BUF);
  assert.ok(s, "应该查到");
  assert.strictEqual(s.fname, "t1.webp");
  assert.strictEqual(s.meaning, "不服气");
});
check("meaningText 拼画面/文字/含义", () => {
  const s = api.findByHash(BUF);
  const t = api.meaningText(s);
  assert.ok(t.includes("画面：一只气鼓鼓的小猫"));
  assert.ok(t.includes("图上文字：真当我是便宜货啊"));
  assert.ok(t.includes("含义：不服气"));
});
check("不同内容不误命中", () => {
  assert.strictEqual(api.findByHash(Buffer.from("another-image")), null);
});
console.log(`\n✓ 全部 ${n} 个断言通过`);
try { store.close(); fs.unlinkSync(tmpDb); } catch (e) {}
