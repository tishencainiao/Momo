/* test/sticker-semantic.js —— 语义召回/精排文本（v1.55.0） */
const assert = require("assert");
const os = require("os");
const path = require("path");

const plugin = require(path.join(__dirname, "..", "plugins", "stickers.js"));
const tmpDb = path.join(os.tmpdir(), "momo-sticker-plugin-" + process.pid + ".db");
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
let n = 0;
function check(name, fn) { fn(); n++; console.log("✓ " + name); }

check("semanticLine 拼四行语义", () => {
  const line = api.semanticLine({
    what: "蓝发女孩气鼓鼓", textInImage: "真当我是便宜货啊",
    meaning: "被低估不服气", usage: "被质疑时回怼", label: "便宜货",
  });
  assert.ok(line.includes("画面：蓝发女孩气鼓鼓"));
  assert.ok(line.includes("图上字：真当我是便宜货啊"));
  assert.ok(line.includes("含义：被低估不服气"));
  assert.ok(line.includes("场景：被质疑时回怼"));
});
check("没有标注时退回 label", () => {
  assert.strictEqual(api.semanticLine({ label: "气鼓鼓表情" }), "气鼓鼓表情");
});
check("semanticHaystack 含 tags 和含义", () => {
  const hay = api.semanticHaystack({
    label: "001", what: "货架", meaning: "不服气", tags: ["傲娇", "涨价"], textInImage: "便宜货",
  });
  assert.ok(hay.includes("傲娇"));
  assert.ok(hay.includes("涨价"));
  assert.ok(hay.includes("不服气"));
  assert.ok(hay.includes("便宜货"));
});
check("空对象不抛错", () => {
  assert.strictEqual(api.semanticLine({}), "");
  assert.strictEqual(api.semanticHaystack({}), "");
});
console.log(`\n✓ 全部 ${n} 个断言通过`);
