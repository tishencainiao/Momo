/* 娱乐底座测试：活动流水 + 每日总次数上限 + 每类上限 + 娱乐子预算 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-funcore-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}
const dayStr = (off) => {
  const d = new Date(Date.now() + (off || 0) * 86400e3);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let settings = { "entertainment.daily_self_max": 2, "entertainment.daily_cny": 0.3 };
let budgetOut = false;
const plugin = require("E:/Learn/Momo/plugins/fun-core.js");
plugin.init({
  DATA_DIR: DIR,
  log: () => {},
  dayStr,
  getSetting: (k, d) => (settings[k] != null ? settings[k] : d),
  isBudgetExhausted: () => budgetOut,
});
const C = plugin.api["fun-core"];

(async () => {
  check("初始 0 次", C.todayTotal() === 0 && C.todayCount("read_article") === 0);
  C.appendActivity({ type: "read_article", ok: true, title: "a" });
  check("写流水成功", C.todayTotal() === 1 && C.todayCount("read_article") === 1);
  check("流水带当天标记", C.todayList()[0].day === dayStr(0));

  check("第 2 次允许（上限 2）", C.canPlay("read_buzz", 1, 0.004).ok === true);
  C.appendActivity({ type: "read_buzz", ok: true });
  const g1 = C.canPlay("play_puzzle", 1, 0.006);
  check("总次数到上限后拒绝", g1.ok === false && /已经 2 次/.test(g1.reason), g1.reason);

  settings["entertainment.daily_self_max"] = 5;
  check("总数没超但该类已 1 次 → 拒绝同类", C.canPlay("read_buzz", 1, 0.004).ok === false);
  check("总数没超、该类没做过 → 允许", C.canPlay("play_puzzle", 1, 0.006).ok === true);

  // 娱乐子预算
  C.addFunSpent(0.25);
  check("娱乐花费累计", Math.abs(C.funSpentToday() - 0.25) < 1e-9);
  const g2 = C.canPlay("read_article", 99, 0.06);
  check("超娱乐预算拒绝", g2.ok === false && /娱乐预算/.test(g2.reason), g2.reason);
  const g3 = C.canPlay("play_puzzle", 1, 0.006);
  check("预算内仍允许", g3.ok === true);

  // 生活费耗尽
  budgetOut = true;
  const g4 = C.canPlay("play_puzzle", 1, 0.006);
  check("生活费耗尽拒绝", g4.ok === false && /生活费/.test(g4.reason));
  budgetOut = false;

  // 失败也占次数：ok:false 的流水照样计数
  C.appendActivity({ type: "read_article", ok: false, reason: "抓取失败" });
  check("失败也占当天次数", C.todayCount("read_article") === 2, "count=" + C.todayCount("read_article"));

  // lastOfType
  check("lastOfType 取到最后一条", C.lastOfType("read_article").ok === false);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
