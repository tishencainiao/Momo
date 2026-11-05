/* test/voice-rate.js —— send_voice 频率限制（v1.59.0） */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-voice-rate-"));
const plugin = require(path.join(__dirname, "..", "plugins", "voice.js"));
plugin.init({ log: () => {}, DATA_DIR: tmp, config: { pet: {} } });
const api = plugin.api.voice;

let n = 0;
async function check(name, fn) { await fn(); n++; console.log("✓ " + name); }

const NOW = Date.now();
const run = async () => {
  await check("每会话每小时 3 条", () => {
    assert.strictEqual(api.voiceRateOk(111, NOW).ok, true);
    assert.strictEqual(api.voiceRateOk(111, NOW + 1000).ok, true);
    assert.strictEqual(api.voiceRateOk(111, NOW + 2000).ok, true);
    const r = api.voiceRateOk(111, NOW + 3000);
    assert.strictEqual(r.ok, false);
    assert.ok(/3 条上限/.test(r.reason));
  });
  await check("全局每小时 5 条", () => {
    assert.strictEqual(api.voiceRateOk(222, NOW + 4000).ok, true);   // 第 4 条（全局）
    assert.strictEqual(api.voiceRateOk(333, NOW + 5000).ok, true);   // 第 5 条（全局）
    const r = api.voiceRateOk(444, NOW + 6000);
    assert.strictEqual(r.ok, false);
    assert.ok(/5 条上限/.test(r.reason));
  });
  await check("窗口滑过 1 小时后恢复", () => {
    const later = NOW + 2 * 3600e3;
    assert.strictEqual(api.voiceRateOk(111, later).ok, true);
  });
  await check("send_voice 工具在群里拒绝", async () => {
    const tool = plugin.tools.find((t) => t.def.function.name === "send_voice");
    assert.ok(tool);
    const ret = await tool.handler({ text: "晚安" }, { userId: 111, groupId: 100000003 });
    assert.ok(String(ret).includes("私聊"));
  });
  await check("caps 表把 send_voice 归到 voice", () => {
    const caps = require("../caps.js");
    assert.strictEqual(caps.toolCap("send_voice"), "voice");
  });
  console.log(`\n✓ 全部 ${n} 个断言通过`);
};
run().catch((e) => { console.error(e); process.exit(1); });
