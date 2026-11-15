/* test/proactive-facts.js：R0 对话逻辑回归——前提硬规则/发送前审计/持久化去重/心流降档/纠正覆盖 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const idx = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const prs = fs.readFileSync(path.join(ROOT, "plugins", "proactive.js"), "utf8");
const ful = fs.readFileSync(path.join(ROOT, "plugins", "followup.js"), "utf8");
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL: " + name); } }

/* A1 意图硬规则 */
check("意图文案含「只提已确认事实」硬规则", prs.includes("只提对话里实际说过、对方确认过的事"));
check("意图文案禁止陈述句断言", prs.includes("禁止用陈述句断言"));
check("硬规则覆盖输赢/去向/成败/成绩", prs.includes("输赢、去向、成败、成绩"));

/* A2a shouldSendNow 前提审计 */
check("shouldSendNow 问句含前提审计", idx.includes("对方没确认过的事说成事实"));

/* A2b proactiveAgentTurn 接吹牛审计 */
check("proactiveAgentTurn 接 auditReply", idx.includes("auditReply(reply, [])"));

/* B 持久化去重 */
check("有 proactiveLoggedDup", idx.includes("function proactiveLoggedDup"));
check("去重比最近 10 条", idx.includes("slice(-10)"));
check("跨人 6 小时冷却", idx.includes("6 * 3600e3"));
check("sha256 精确指纹", idx.includes("createHash(\"sha256\")"));
check("发送后写日志", idx.includes("appendProactiveLog(userId, reply)"));
check("share_fun 心流分享也去重", idx.includes("proactiveLoggedDup(masterUin, cap)") && idx.includes("appendProactiveLog(masterUin, cap)"));

/* C 心流降档 */
check("deliberateMind 1024 + effort low", idx.includes("1024, { effort: \"low\" }"));
check("reasonComplete 支持显式 effort", idx.includes("_extra.reasoning_effort = opts.effort"));
check("reasonComplete 空正文降级重试", idx.includes("Object.assign({}, opts, { noThink: true })"));

/* A3 纠正覆盖 */
check("index 有 notePremiseCorrection", idx.includes("function notePremiseCorrection"));
check("notePremiseCorrection 暴露给插件", idx.includes("stickerSessionKey, notePremiseCorrection"));
check("followup 有 rejectPendingFor", ful.includes("function rejectPendingFor"));
check("followup 私聊钩子检测纠正句", ful.includes("没说过|没说我|别乱说") && ful.includes("rejectPendingFor(userId)"));
check("followup 纠正后写反思", ful.includes("notePremiseCorrection(userId, t)"));

/* 旧逻辑不被破坏：proactiveDup 仍在（被 loggedDup 复用） */
check("proactiveDup 保留", idx.includes("function proactiveDup"));

console.log(`pass ${pass} / fail ${fail}`);
process.exit(fail ? 1 : 0);
