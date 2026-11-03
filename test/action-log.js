/* 操作记录测试：lifeCtx 展示「谁要求的」/ action_log 查询 / 文案正确 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-action-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

const now = Date.now();
const lines = [
  { ts: now - 5000, action: "poke", by: 100000001, target: 3550140293, groupId: 100000003, ok: true },
  { ts: now - 4000, action: "send_like", by: 100000001, target: 3550140293, ok: true, detail: "点了 1 个赞" },
  { ts: now - 3000, action: "mute_user", by: 100000001, target: 999, ok: true, detail: "广告号" },
  { ts: now - 2000, action: "mute_user", by: 100000001, target: 888, ok: false, detail: "失败测试" },
  { ts: now - 1000, action: "set_weather_city", by: 0, detail: "大庆", ok: true },
];
fs.writeFileSync(path.join(DIR, "actions.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const plugin = require("E:/Learn/Momo/plugins/life-log.js");
plugin.init({
  DATA_DIR: DIR,
  SELF_DIR: DIR,
  log: () => {},
  formatGap: (ms) => Math.round(ms / 60000) + " 分钟",
  dayStr: () => new Date().toISOString().slice(0, 10),
  resolveCall: (u) => (String(u) === "100000001" ? "主人" : String(u) === "3550140293" ? "朋友" : "路人" + u),
});
const L = plugin.api.lifeLog;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

// 1. 生活日志里带上「替谁做过什么」
const ctx = L.lifeCtx();
check("生活日志含「今天做过」", ctx.indexOf("今天做过") >= 0, ctx);
check("显示动作", ctx.indexOf("拍了拍") >= 0, ctx);
check("显示对象", ctx.indexOf("朋友") >= 0, ctx);
check("显示是谁要求的", ctx.indexOf("主人让的") >= 0, ctx);
check("自己想的也能区分", ctx.indexOf("我自己想的") >= 0, ctx);

// 2. action_log 详细查询
const log = L.actionLogText(10);
check("含时间", /\d{4}\/\d{1,2}\/\d{1,2}/.test(log), log.slice(0, 60));
check("含动作", log.indexOf("拍了拍") >= 0);
check("含「主人让的」", log.indexOf("主人让的") >= 0);
check("失败标记", log.indexOf("（失败）") >= 0);
check("最新的在最前", log.indexOf("改了天气城市") < log.indexOf("拍了拍"), log.slice(0, 120));

// 3. 空记录
const DIR2 = path.join(os.tmpdir(), "momo-action-empty-" + Date.now());
fs.mkdirSync(DIR2, { recursive: true });
const p2 = require("E:/Learn/Momo/plugins/life-log.js");
// 重新 init 会覆盖 _ctx，所以用一个独立的空目录再测
p2.init({ DATA_DIR: DIR2, SELF_DIR: DIR2, log: () => {}, formatGap: () => "", dayStr: () => "x", resolveCall: (u) => u });
check("没有记录时给提示", p2.api.lifeLog.actionLogText(5).indexOf("还没做过") >= 0);

// 4. 工具存在
check("life-log 暴露 action_log 工具", Array.isArray(plugin.tools) && plugin.tools.some((t) => t.def.function.name === "action_log"));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { fs.rmSync(DIR, { recursive: true, force: true }); fs.rmSync(DIR2, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
