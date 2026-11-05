/* test/voice-warm.js —— 语音预热（v1.57.0） */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const plugin = require(path.join(__dirname, "..", "plugins", "voice.js"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-voice-"));
plugin.init({ log: () => {}, DATA_DIR: tmp, config: { pet: {} } });
const api = plugin.api.voice;

let n = 0;
function check(name, fn) { fn(); n++; console.log("✓ " + name); }

check("没有 python_path 时安全返回", () => {
  const r = api.warmVoice();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no python_path");
});
check("预热有节流（5 分钟内不重复）", () => {
  const r = api.warmVoice();
  assert.strictEqual(r.skipped, true);
});
check("wantsVoice 关键词仍生效", () => {
  assert.strictEqual(api.wantsVoice("说句话给我听"), true);
  assert.strictEqual(api.wantsVoice("今天天气不错"), false);
});
console.log(`\n✓ 全部 ${n} 个断言通过`);
