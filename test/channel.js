#!/usr/bin/env node
/* 渠道感知测试：处境描述按渠道切换 + where_am_i 工具 */
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
function extractBlock(s, name) {
  // 提取 const NAME = "...";（兼容 \r\n）
  let m = s.match(new RegExp("const " + name + "\\s*=\\s*\"([\\s\\S]*?)\";\\r?\\n"));
  if (m) return m[1];
  return null;
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

const QQ = extractBlock(src, "SITUATION_QQ");
const DESKTOP = extractBlock(src, "SITUATION_DESKTOP");
check("源码里有 SITUATION_QQ", !!QQ);
check("源码里有 SITUATION_DESKTOP", !!DESKTOP);

// 1. QQ 版
check("QQ版提到「通过 QQ」", QQ && QQ.includes("通过 QQ"));
check("QQ版提到「不在同一个物理空间」", QQ && QQ.includes("不在同一个物理空间"));
check("QQ版提到「隔着屏幕」", QQ && QQ.includes("隔着屏幕"));

// 2. 桌面版（用户明确要求：不能说「面对面」，不能说「直接就能听到」）
const DESK_MAIN = String(DESKTOP || "").split("【重要】")[0];   // 主体描述部分
check("桌面版说「电脑屏幕上」", DESKTOP && DESKTOP.includes("电脑屏幕上"));
check("桌面版不提「面对面」", DESKTOP && !DESKTOP.includes("面对面"));
check("桌面版主体不涉手机/隔屏", !DESK_MAIN.includes("手机") && !DESK_MAIN.includes("隔着屏幕"), DESK_MAIN.slice(0, 60));
check("桌面版说明是打字交流", DESKTOP && DESKTOP.includes("打字"));
check("桌面版点明「能看见≠能听见」", DESKTOP && DESKTOP.includes("不等于"));
check("桌面版说明看不见主人", DESKTOP && DESKTOP.includes("你看不见主人本人"));
check("桌面版不再写「他在你面前」", DESKTOP && !DESKTOP.includes("他在你面前"));

// 3. situationDirective 分派
const ctx = { SITUATION_QQ: QQ, SITUATION_DESKTOP: DESKTOP };
vm.createContext(ctx);
vm.runInContext(extractFunc(src, "situationDirective") + "\nthis.f = situationDirective;", ctx);
check("desktop 模式返回桌面版", ctx.f("desktop") === DESKTOP);
check("qq 模式返回 QQ 版", ctx.f("qq") === QQ);
check("未知模式默认 QQ 版", ctx.f() === QQ);

// 4. where_am_i 工具
const cap = require("E:/Learn/Momo/plugins/capability-index.js");
cap.init({ log: () => {}, config: { qq: { master_user: 1 } }, DATA_DIR: require("os").tmpdir() });
const tool = (cap.tools || []).find((t) => t.def.function.name === "where_am_i");
check("暴露 where_am_i 工具", !!tool);
const rPet = tool.handler({}, { userId: 1, petMode: true });
check("桌宠场景→说桌宠窗口", rPet.includes("桌宠窗口") && rPet.includes("打字"), rPet);
const rGroup = tool.handler({}, { userId: 1, groupId: 100000003 });
check("群聊场景→说群号", rGroup.includes("100000003") && rGroup.includes("群"), rGroup);
const rPrivate = tool.handler({}, { userId: 1 });
check("私聊场景→说QQ私聊", rPrivate.includes("QQ 私聊") && rPrivate.includes("隔着屏幕"), rPrivate);
check("桌宠场景不误报QQ", !rPet.includes("QQ 私聊"));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
