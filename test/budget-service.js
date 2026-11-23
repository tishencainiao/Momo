/* 框架服务 · 预算（S4）：逐字迁移 + 计费语义 + 档位 + 薄转发接线 */
const fs = require("fs");
const os = require("os");
const path = require("path");

let P = 0, F = 0;
function check(name, cond) { if (cond) { P++; } else { F++; console.log(`  ✗ ${name}`); } }

/* ---- 直接 require 服务，喂最小 ctx ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-budget-"));
const ctx = {
  DATA_DIR: tmp,
  config: { budget: { daily_cny: 1 } },
  log: () => {},
  writeJsonAtomic: (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 0)); } catch (e) {} },
  writeFileAtomic: (f, t) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); } catch (e) {} },
};
const mod = require("../plugins/budget-service.js");
mod.init(ctx);
const B = mod.api.budget;

check("system:true + 有 apiSpec", mod.system === true && mod.apiSpec && mod.apiSpec.budget);
check("api 含 15 函数", Object.keys(B).length >= 15);

/* 价格表默认值（P1 真实账本） */
const bc = B.budgetCfg();
check("flash 未命中价 0.15*7.2", Math.abs(bc.input_miss_cny_per_m - 1.08) < 1e-9);
check("flash 命中价 0.003*7.2", Math.abs(bc.input_hit_cny_per_m - 0.0216) < 1e-9);
check("pro 未命中价 0.66*7.2", Math.abs(bc.pro_input_miss_cny_per_m - 4.752) < 1e-9);
check("pro 命中价 0.022*7.2", Math.abs(bc.pro_input_hit_cny_per_m - 0.1584) < 1e-9);
check("dailyCny() 读配置", B.dailyCny() === 1);
check("peak_x2 默认开", bc.peak_x2 === true);

/* recordSpend：flash 价 vs pro 价（非高峰，mult=1）——固定时钟，避免高峰时段用例漂移 */
const RealDate = Date;
global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [1600000000000])); } static now() { return 1600000000000; } };
const b1 = B.recordSpend("chat", 1e6, 0, 0, 0, false);
const c1 = b1.spent_cny;
const b2 = B.recordSpend("reason", 0, 0, 1e6, 0, true);
const c2 = b2.spent_cny - b1.spent_cny;
global.Date = RealDate;
check("flash 1M miss ≈ 1.08", Math.abs(c1 - 1.08) < 1e-6);
check("pro 1M hit ≈ 0.1584", Math.abs(c2 - 0.1584) < 1e-6);
check("tokens_hit 累计", b2.tokens_hit === 1e6);
check("calls.reason=1", b2.calls.reason === 1);

/* budgetTier 四档阈值（写真实 budget.json 再读，budgetLevel 闭包内 loadBudget 读文件） */
const today = new Date().toDateString();
const tierAt = (ratio) => {
  fs.writeFileSync(path.join(tmp, "budget.json"), JSON.stringify({ date: today, spent_cny: 1 - ratio }));
  return B.budgetTier();
};
check("90% → full", tierAt(0.9) === "full");
check("40% → low", tierAt(0.4) === "low");
check("15% → flash", tierAt(0.15) === "flash");
check("5% → minimal", tierAt(0.05) === "minimal");

/* usageParts：字段齐读直读 / 缺 miss 用 hit 扣减 / 全缺整包估算 */
const p1 = B.usageParts({ prompt_cache_miss_tokens: 100, prompt_cache_hit_tokens: 50, completion_tokens: 20 }, null, "x");
check("usageParts 直读 miss=100/hit=50/out=20", p1.miss === 100 && p1.hit === 50 && p1.out === 20);
const p2 = B.usageParts({ prompt_tokens: 200, prompt_cache_hit_tokens: 150 }, null, "x");
check("缺 miss → prompt-hit 扣减 50", p2.miss === 50 && p2.hit === 150);
const p3 = B.usageParts({ prompt_tokens: 300 }, null, "x");
check("全缺 → miss=300/hit=0", p3.miss === 300 && p3.hit === 0);

/* usageLine 含命中率 */
const ul = B.usageLine();
check("usageLine 含命中率", ul.includes("命中率"));

/* ---- 薄转发接线（index.js） ---- */
const IDX = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
check("index.js 有 _budgetApi 薄转发", IDX.includes("function _budgetApi()") && IDX.includes('apiOf("budget")'));
check("index.js 预算真相块已迁出（无计费实现）", !/function recordSpend\(kind, inTok, outTok, hitTok, flatCny, isPro\) \{\n  const bc = budgetCfg\(\);/.test(IDX));
check("index.js 保留兜底 ACTION_COST", IDX.includes("const ACTION_COST = {"));

/* 业务插件不再手搓 daily_cny（doctor 黄牌正则清零） */
const RE = /daily_cny/;
for (const n of ["budget-report", "evolution", "fun-core", "report", "pet-body"]) {
  const src = fs.readFileSync(path.join(__dirname, "..", "plugins", n + ".js"), "utf8");
  check(`plugins/${n}.js 无 daily_cny 字面量`, !RE.test(src));
}
check("report.js requires 含 budget", /requires:\s*\[[^\]]*"budget"/.test(fs.readFileSync(path.join(__dirname, "..", "plugins", "report.js"), "utf8")));
check("evolution.js requires 含 budget", /requires:\s*\[[^\]]*"budget"/.test(fs.readFileSync(path.join(__dirname, "..", "plugins", "evolution.js"), "utf8")));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`通过 ${P} / 失败 ${F}`);
if (F) process.exit(1);
