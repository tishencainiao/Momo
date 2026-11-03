/* 真实生活日志测试：只反映有记录的真实活动，不编造 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA = path.join(os.tmpdir(), "momo-lifelog-data-" + Date.now());
const SELF = path.join(os.tmpdir(), "momo-lifelog-self-" + Date.now());
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(SELF, { recursive: true });

const now = Date.now();
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

fs.writeFileSync(path.join(DATA, "current-activity.json"), JSON.stringify({ text: "在陪主人聊天", since: now - 10 * 60000 }));
fs.writeFileSync(path.join(DATA, "fun-stuff.json"), JSON.stringify([{ topic: "沙雕动物冷知识" }, { topic: "今日热梗" }]));
fs.writeFileSync(path.join(DATA, "mind.json"), JSON.stringify({ thoughts: ["无聊到冒泡，再找点乐子"], last_think: now }));
fs.writeFileSync(path.join(DATA, "qzone-state.json"), JSON.stringify({ dates: { [today]: 2 } }));
fs.writeFileSync(path.join(DATA, "replies.jsonl"), [JSON.stringify({ ts: now - 5 * 60000, userId: 100000001, text: "在呢在呢" })].join("\n"));
fs.writeFileSync(path.join(SELF, "journal.json"), JSON.stringify([{ ts: now - 3600e3, type: "reflection", text: "以后先看懂表情包再回应" }]));

const plugin = require("E:/Learn/Momo/plugins/life-log.js");
plugin.init({
  DATA_DIR: DATA,
  SELF_DIR: SELF,
  formatGap: (ms) => Math.round(ms / 60000) + " 分钟",
  dayStr: () => today,
  resolveCall: (u) => (Number(u) === 100000001 ? "主人" : "朋友"),
  log: () => {},
});

const ctx = plugin.api.lifeLog.lifeCtx();

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

check("含当前活动", ctx.indexOf("在陪主人聊天") >= 0, ctx);
check("含今天想到的", ctx.indexOf("先看懂表情包") >= 0 || ctx.indexOf("今天想到") >= 0);
check("含真实搜索主题", ctx.indexOf("沙雕动物冷知识") >= 0);
check("含真实念头", ctx.indexOf("无聊到冒泡") >= 0);
check("含说说条数", ctx.indexOf("2 条空间说说") >= 0);
check("含聊天统计", ctx.indexOf("主人 1 条") >= 0);
check("不编造晒太阳", ctx.indexOf("晒太阳") < 0);
check("标注据实记录", ctx.indexOf("据实记录") >= 0);

console.log("\n--- 实际输出 ---\n" + ctx);
console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(SELF, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
