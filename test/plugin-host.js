/* test/plugin-host.js —— 钩子分发契约（v1.53.1 修复回归） */
const assert = require("assert");
const path = require("path");
const { createHost } = require(path.join(__dirname, "..", "plugin-host.js"));

const core = {
  DATA_DIR: path.join(__dirname, "..", "data"),
  cfg: {},
  apiKey: "x",
  log: () => {},
  recordAction: () => {},
  resolveChatSettings: () => ({}),
};
const host = createHost(core);

let n = 0;
function check(name, fn) { fn(); n++; console.log("✓ " + name); }

check("reply 钩子收到的是 payload（不是 ctx）", () => {
  let got = null;
  host.hookLists.reply.push((payload) => { got = payload; });
  host.runHook("reply", { userId: 42, text: "你好", reply: "嗯", channel: "private" });
  assert.strictEqual(got.userId, 42);
  assert.strictEqual(got.text, "你好");
  assert.strictEqual(got.reply, "嗯");
  host.hookLists.reply.pop();
});
check("timer 钩子收到 payload.now", () => {
  let got = null;
  host.hookLists.timer.push((payload) => { got = payload; });
  host.runHook("timer", { now: 12345 });
  assert.strictEqual(got.now, 12345);
  host.hookLists.timer.pop();
});
check("无 payload 时传空对象，不抛错", () => {
  let got = undefined;
  host.hookLists.startup.push((payload) => { got = payload; });
  host.runHook("startup");
  assert.deepStrictEqual(got, {});
  host.hookLists.startup.pop();
});
console.log(`\n✓ 全部 ${n} 个断言通过`);
