#!/usr/bin/env node
/* 生活费分级测试：剩余越少，能做的高成本行为越少（从源码提取真实函数） */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

function extractFunc(s, name) {
  const start = s.indexOf("function " + name + "(");
  if (start === -1) return null;
  let i = s.indexOf("{", start), depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) break; }
  }
  return s.slice(start, i + 1);
}
function extractConst(s, name) {
  const start = s.indexOf("const " + name + " = {");
  if (start === -1) return null;
  let i = s.indexOf("{", start), depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) break; }
  }
  return s.slice(start, i + 1) + ";";
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext(`
  let _spent = 0;
  const _daily = 2;
  function loadBudget() { return { spent_cny: _spent }; }
  function budgetCfg() { return { daily_cny: _daily }; }
  ${extractFunc(src, "budgetLevel")}
  ${extractConst(src, "ACTION_COST")}
  ${extractFunc(src, "canAfford")}
  this.setSpent = (v) => { _spent = v; };
  this.budgetLevel = budgetLevel;
  this.canAfford = canAfford;
  this.ACTION_COST = ACTION_COST;
`, ctx);

const { setSpent, budgetLevel, canAfford, ACTION_COST } = ctx;

// 1. 宽裕（花了 0 / 2 = 剩 100%）
setSpent(0);
check("剩 100% → rich", budgetLevel().level === "rich", budgetLevel().level);
check("rich 能做 high（反思/进化）", canAfford("high") === true);
check("rich 能做 mid（搜索）", canAfford("mid") === true);
check("rich 能做 low（聊天）", canAfford("low") === true);

// 2. 够用（花 1.0 = 剩 50%）
setSpent(1.0);
check("剩 50% → normal", budgetLevel().level === "normal", budgetLevel().level);
check("normal 不能做 high", canAfford("high") === false);
check("normal 仍能做 mid", canAfford("mid") === true);
check("normal 仍能做 low", canAfford("low") === true);

// 3. 紧张（花 1.6 = 剩 20%）
setSpent(1.6);
check("剩 20% → tight", budgetLevel().level === "tight", budgetLevel().level);
check("tight 不能做 high", canAfford("high") === false);
check("tight 仍能做 low（便宜的）", canAfford("low") === true);

// 4. 快没了（花 1.95 = 剩 2.5%）
setSpent(1.95);
check("剩 2.5% → empty", budgetLevel().level === "empty", budgetLevel().level);
check("empty 不能做 high", canAfford("high") === false);
check("empty 不能做 mid", canAfford("mid") === false);
check("empty 不能做 low", canAfford("low") === false);
check("empty 仍可 free（啥也不做）", canAfford("free") === true);

// 5. 花超了（剩 0）
setSpent(2.5);
check("超支时 ratio 不为负", budgetLevel().ratio === 0, String(budgetLevel().ratio));
check("超支仍 empty", budgetLevel().level === "empty");

// 6. 动作成本映射
check("browse 是 low", ACTION_COST.browse === "low");
check("search 是 mid", ACTION_COST.search === "mid");
check("reflect 是 high", ACTION_COST.reflect === "high");
check("evolve 是 high", ACTION_COST.evolve === "high");
check("nothing 是 free", ACTION_COST.nothing === "free");

// 7. 边界：剩 60% 仍是 rich（>0.6 才 rich，=0.6 是 normal）
setSpent(0.8);   // 剩 60%
check("剩 60% → normal（边界）", budgetLevel().level === "normal", budgetLevel().level);
setSpent(0.79);  // 剩 60.5%
check("剩 60.5% → rich（边界）", budgetLevel().level === "rich", budgetLevel().level);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
