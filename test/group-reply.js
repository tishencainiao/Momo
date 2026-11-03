#!/usr/bin/env node
/* 群聊回复判定测试：@ / 叫名字 / 对话延续窗口 / @ 了别人的三档处理 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function extractConstLine(s, name) {
  const start = s.indexOf("const " + name + " = ");
  if (start === -1) return null;
  const end = s.indexOf("\n", start);
  return s.slice(start, end).replace(/;?\s*$/, ";");
}
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

const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  extractConstLine(src, "GROUP_CONTINUE_MS") + "\n" +
  extractFunc(src, "groupShouldReply") +
  "\nthis.groupShouldReply = groupShouldReply; this.WIN = GROUP_CONTINUE_MS;",
  ctx
);
const decide = ctx.groupShouldReply;
const WIN = ctx.WIN;

check("窗口是 5 分钟", WIN === 5 * 60000, String(WIN));

const NOW = 1793600000000;
const ME = 100000001, OTHER = 3550140293;
const fresh = { userId: ME, ts: NOW - 60000 };   // 1 分钟前 @ 过她

// 1. 直接 @ / 叫名字
check("@ 了她 → 回", decide(true, false, null, ME, NOW, [], "smart").reply === true);
check("@ 了她不需要判断", decide(true, false, null, ME, NOW, [], "smart").needJudge === false);
check("叫了她名字 → 回", decide(false, true, null, OTHER, NOW, [], "smart").reply === true);

// 2. 纯闲聊
check("纯闲聊 → 不回", decide(false, false, null, OTHER, NOW, [], "smart").reply === false);

// 3. 对话延续（没 @ 别人）
const d1 = decide(false, false, fresh, ME, NOW, [], "smart");
check("延续且没@别人 → 回", d1.reply === true);
check("延续且没@别人 → 不用判断", d1.needJudge === false);

// 4. 超过窗口
check("超过窗口 → 不回", decide(false, false, { userId: ME, ts: NOW - 6 * 60000 }, ME, NOW, [], "smart").reply === false);

// 5. @ 了别人：三档
const dSmart = decide(false, false, fresh, ME, NOW, [OTHER], "smart");
check("smart：仍然回（交给模型）", dSmart.reply === true);
check("smart：标记需要判断", dSmart.needJudge === true);

const dStrict = decide(false, false, fresh, ME, NOW, [OTHER], "strict");
check("strict：@了别人就不接", dStrict.reply === false);
check("strict：不需要判断", dStrict.needJudge === false);

const dIgnore = decide(false, false, fresh, ME, NOW, [OTHER], "ignore");
check("ignore：照样回", dIgnore.reply === true);
check("ignore：不判断", dIgnore.needJudge === false);

// 6. 别人说话不算延续
check("另一个人说话 → 不回", decide(false, false, fresh, OTHER, NOW, [], "smart").reply === false);

// 7. 脏数据
check("lastAt 空对象不崩", decide(false, false, {}, ME, NOW, [], "smart").reply === false);
check("atOthers 非数组不崩", decide(false, false, fresh, ME, NOW, null, "smart").reply === true);
check("atOthers 含空值被过滤", decide(false, false, fresh, ME, NOW, [""], "smart").needJudge === false);

/* ---- parseMessage 是否解析出 ats ---- */
const ctx2 = {};
vm.createContext(ctx2);
vm.runInContext(
  "const FACE_MAP = {};\n" +
  extractFunc(src, "parseMessage") +
  "\nthis.parseMessage = parseMessage;",
  ctx2
);
const parse = ctx2.parseMessage;
const msg = [
  { type: "at", data: { qq: "100000004" } },
  { type: "text", data: { text: " 鱼来" } },
  { type: "at", data: { qq: "3550140293" } },
  { type: "text", data: { text: " 你看" } },
];
const p = parse(msg);
check("解析出 2 个 @", p.ats.length === 2, JSON.stringify(p.ats));
check("@ 的 QQ 号正确", p.ats[0] === "100000004" && p.ats[1] === "3550140293", JSON.stringify(p.ats));
check("文本仍是 [@]", p.text.indexOf("[@]") >= 0);
check("字符串消息 ats 为空数组", parse("纯文本").ats.length === 0);
check("非数组 ats 为空数组", parse(null).ats.length === 0);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
