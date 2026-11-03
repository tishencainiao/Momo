/* health 合并体检测试：优先 meta-cog 数据（含括号动作），退回 replies 扫描 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-health-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

let metaState = null;
const plugin = require("E:/Learn/Momo/plugins/health.js");
plugin.init({
  DATA_DIR: DIR,
  log: () => {},
  config: { qq: { master_user: 1000 } },
  isMaster: (u) => Number(u) === 1000,
  getApi: (n) => (n === "metaCog" ? { loadState: () => metaState } : null),
});
const H = plugin.api.health;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

// 1. 有 meta-cog 数据时用它的（含 bracket）
metaState = { stats: { total: 20, ai: 3, long: 2, bracket: 4, repeat: 1 } };
let r = H.unifiedCheck();
check("用 meta-cog 数据", r.total === 20 && r.bracket === 4, JSON.stringify(r));
let txt = H.reportText(r);
check("报告含括号动作", txt.includes("括号写动作 4"), txt);

// 2. 没有 meta-cog 时退回 replies 扫描
metaState = null;
fs.writeFileSync(path.join(DIR, "replies.jsonl"), [
  JSON.stringify({ text: "作为一个AI，我建议你休息" }),
  JSON.stringify({ text: "作为一个AI，我建议你喝水" }),
  JSON.stringify({ text: "正常的一句话" }),
].join("\n") + "\n");
r = H.unifiedCheck();
check("退回 replies 扫描", r.total === 3 && r.ai >= 2, JSON.stringify(r));
check("回退时 bracket 为 0", r.bracket === 0);

// 3. 复读检测
fs.writeFileSync(path.join(DIR, "replies.jsonl"), Array.from({ length: 5 }, () => JSON.stringify({ text: "嗯嗯好的呢" })).join("\n") + "\n");
r = H.unifiedCheck();
check("复读检测到", r.repeat >= 1, JSON.stringify(r));

// 4. 无数据
fs.writeFileSync(path.join(DIR, "replies.jsonl"), "");
r = H.unifiedCheck();
check("无数据 total=0", r.total === 0);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
