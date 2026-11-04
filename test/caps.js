/* test/caps.js —— 工具/命令能力登记表（v1.50.0 起） */
const assert = require("assert");
const caps = require("../caps.js");

let n = 0;
function check(name, fn) { fn(); n++; console.log("✓ " + name); }

check("自助工具归 memory_self", () => {
  assert.strictEqual(caps.toolCap("memory_view"), "memory_self");
  assert.strictEqual(caps.toolCap("set_appellation"), "memory_self");
});
check("提醒/待办归 reminder_self", () => {
  assert.strictEqual(caps.toolCap("set_reminder"), "reminder_self");
  assert.strictEqual(caps.toolCap("add_todo"), "reminder_self");
});
check("搜索/表情包归类", () => {
  assert.strictEqual(caps.toolCap("web_search"), "search");
  assert.strictEqual(caps.toolCap("send_sticker"), "sticker");
});
check("未登记的工具默认拒绝（null）", () => {
  assert.strictEqual(caps.toolCap("qzone_delete"), null);
  assert.strictEqual(caps.toolCap("settings_set"), null);
  assert.strictEqual(caps.toolCap("pc_screenshot"), null);
});
check("命令归类", () => {
  assert.strictEqual(caps.cmdCap("/叫我"), "memory_self");
  assert.strictEqual(caps.cmdCap("/待办"), "reminder_self");
});
check("未登记的命令默认拒绝", () => {
  assert.strictEqual(caps.cmdCap("/进化"), null);
  assert.strictEqual(caps.cmdCap("/删说说"), null);
});
console.log(`\n✓ 全部 ${n} 个断言通过`);
