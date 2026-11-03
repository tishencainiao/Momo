/* 元认知测试：自评规则 / 提醒注入 / 每日复盘 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-metacog-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

let identityAdded = null;
const plugin = require("E:/Learn/Momo/plugins/meta-cog.js");
plugin.init({
  DATA_DIR: DIR,
  log: () => {},
  dayStr: () => "2026-11-01",
  getSetting: (k, d) => d,
  config: { qq: { master_user: 1000 } },
  getApi: (n) => (n === "evolution" ? { addIdentityItem: (t, from) => { identityAdded = t; return true; } } : null),
});
const M = plugin.api.metaCog;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

// 1. 单条分析
check("AI 套话能识别", M.analyze("作为一个AI，我认为你应该休息", []).some((x) => x.type === "ai"));
check("太长能识别", M.analyze("啊".repeat(320), []).some((x) => x.type === "long"));
check("括号动作能识别", M.analyze("（歪头）你在说什么", []).some((x) => x.type === "bracket"));
check("复读能识别", M.analyze("嗯嗯好的呢", ["嗯嗯我懂了", "嗯嗯你说"]).some((x) => x.type === "repeat"));
check("正常话不误报", M.analyze("今天累不累，早点睡吧", ["好呀", "收到"]).length === 0, JSON.stringify(M.analyze("今天累不累，早点睡吧", ["好呀", "收到"])));

// 2. observe 累计
const r1 = M.observe("作为一个AI，我建议你休息");
check("observe 返回问题", r1.length >= 1);
const s1 = M.loadState();
check("统计总数 +1", s1.stats.total === 1);
check("AI 计数 +1", s1.stats.ai === 1);

// 3. metaCtx
const ctx1 = M.metaCtx();
check("有提醒文本", ctx1.includes("你对自己刚才表现的觉察"), ctx1.slice(0, 40));
check("提醒里含具体问题", ctx1.includes("AI 客服"));
check("提醒不超 3 条", ctx1.split("\n").filter((l) => l.startsWith("- ")).length <= 3);

// 4. 过期的不提醒
const st = M.loadState();
st.issues = st.issues.map((i) => ({ ...i, ts: Date.now() - 60 * 60000 }));
fs.writeFileSync(path.join(DIR, "meta-cog.json"), JSON.stringify(st));
check("30 分钟前的提醒不出现", M.metaCtx() === "");

// 5. 每日复盘
const st2 = { days: { "2026-11-01": { total: 10, ai: 3, repeat: 4, bracket: 0, long: 0 } }, stats: { total: 10 } };
fs.writeFileSync(path.join(DIR, "meta-cog.json"), JSON.stringify(st2));
const refl = M.dailyReflect();
check("复盘有产出", !!refl, String(refl));
check("复盘写进成长记忆", !!identityAdded && identityAdded.includes("我今天发现自己"), String(identityAdded));
check("复盘提到复读", refl.includes("开头") || refl.includes("复读"), refl);
check("同一天不重复复盘", M.dailyReflect() === "");

// 6. 数据太少不复盘
fs.writeFileSync(path.join(DIR, "meta-cog.json"), JSON.stringify({ days: { "2026-11-02": { total: 2 } } }));
check("数据太少不瞎复盘", M.dailyReflect() === "");

// 7. 自检工具（先恢复一份有数据的统计）
fs.writeFileSync(path.join(DIR, "meta-cog.json"), JSON.stringify({
  stats: { total: 12, ai: 2, long: 1, bracket: 1, repeat: 3 },
  days: { "2026-11-01": { total: 12, ai: 2, long: 1, bracket: 1, repeat: 3 } },
  issues: [], lastReflect: "2026-11-01",
}));
// 7. self_check 已合并到 health.js，meta-cog 只保留统计与提醒
check("meta-cog 不再暴露 self_check 工具", !(plugin.tools || []).some((t) => t.def.function.name === "self_check"));
check("meta-cog 仍暴露 stats 数据", !!M.loadState().stats);
check("meta-cog 仍暴露提醒注入", typeof M.metaCtx === "function");

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
