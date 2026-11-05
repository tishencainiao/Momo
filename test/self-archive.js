/* test/self-archive.js —— 原始记忆归档（v1.58.0） */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { appendArchive, readArchive } = require("../self-archive.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "momo-archive-"));
let n = 0;
function check(name, fn) { fn(); n++; console.log("✓ " + name); }

check("追加并读到归档", () => {
  const cnt = appendArchive(TMP, "identity", ["旧记忆一", { text: "旧记忆二", from: 7 }]);
  assert.strictEqual(cnt, 2);
  const back = readArchive(TMP, "identity", 10);
  assert.strictEqual(back.length, 2);
  const texts = back.map((x) => x.text);
  assert.ok(texts.includes("旧记忆一"));
  assert.ok(texts.includes("旧记忆二"));
});
check("字符串条目自动包成对象", () => {
  const back = readArchive(TMP, "identity", 1);
  assert.ok(typeof back[0] === "object");
  assert.ok(typeof back[0].text === "string");
  assert.ok(back[0].archived_at > 0);
});
check("不同 kind 不串", () => {
  appendArchive(TMP, "reflection", ["反思一"]);
  assert.strictEqual(readArchive(TMP, "identity", 10).length, 2);
  assert.strictEqual(readArchive(TMP, "reflection", 10).length, 1);
});
check("空数组不写文件", () => {
  assert.strictEqual(appendArchive(TMP, "empty", []), 0);
  assert.strictEqual(readArchive(TMP, "empty", 5).length, 0);
});
check("按月分文件命名", () => {
  const files = fs.readdirSync(path.join(TMP, "archive"));
  assert.ok(files.some((f) => /^identity-\d{4}-\d{2}\.jsonl$/.test(f)));
});
console.log(`\n✓ 全部 ${n} 个断言通过`);
