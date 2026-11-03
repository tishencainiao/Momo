/* 能力索引回归测试：身份过滤 / 摘要生成 / 按需查询 */
const path = require("path");
const os = require("os");
const plugin = require("E:/Learn/Momo/plugins/capability-index.js");

const ALL_TOOLS = ["take_screenshot", "find_files", "open_app", "system_info", "budget_view", "memory_view", "teach", "send_sticker", "add_todo", "list_todo", "set_reminder", "birthday_view", "set_goal", "goals_view", "set_appellation", "set_other_appellation", "mute_user", "unmute_user", "dsh_notify", "health_check", "check_balance", "self_modify", "self_status", "self_log", "self_memory", "self_info", "self_history", "add_wish"];
const ALL_CMDS = ["/叫我", "/称呼", "/生日", "/花费", "/dsh通知", "/命令", "/进化", "/冻结进化", "/解冻进化", "/进化提案", "/目标", "/体检", "/记忆", "/提醒", "/做表情包", "/教", "/教的清单", "/忘掉", "/待办"];

plugin.init({
  config: { qq: { master_user: 100000001, allowed_users: [100000001, 100000002] } },
  registry: { tools: () => ALL_TOOLS.slice(), commands: () => ALL_CMDS.slice() },
  log: () => {},
});

const C = plugin.api.capability;
const ME = 100000001, FRIEND = 100000002, GUEST = 999999999;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

// ---------- 身份判定 ----------
check("主人判定", C.tierOf(ME) === "master");
check("熟人判定", C.tierOf(FRIEND) === "friend");
check("陌生人判定", C.tierOf(GUEST) === "guest");

// ---------- 身份过滤 ----------
const m = C.scan(ME);
const f = C.scan(FRIEND);
const g = C.scan(GUEST);
check("主人能看到截图", m.tools.indexOf("take_screenshot") >= 0);
check("熟人看不到截图", f.tools.indexOf("take_screenshot") < 0);
check("熟人看不到自我改代码", f.tools.indexOf("self_modify") < 0);
check("熟人看不到账本", f.tools.indexOf("budget_view") < 0);
check("熟人仍能看到记忆/教学", f.tools.indexOf("memory_view") >= 0 && f.tools.indexOf("teach") >= 0);
check("陌生人只看到最小集合", g.tools.every((t) => ["send_sticker", "memory_view", "add_todo", "list_todo", "set_reminder", "birthday_view", "self_status", "self_info", "capability_view"].indexOf(t) >= 0), g.tools.join(","));
check("陌生人看不到命令", g.cmds.length === 0);
check("主人命令比熟人多", m.cmds.length > f.cmds.length);

// ---------- 摘要 ----------
const ctxM = C.capabilityCtx(ME);
const ctxF = C.capabilityCtx(FRIEND);
const ctxG = C.capabilityCtx(GUEST);
check("主人摘要含「对主人」", ctxM.indexOf("对主人") >= 0);
check("熟人摘要含「对熟人」", ctxF.indexOf("对熟人") >= 0);
check("陌生人摘要含「对陌生人」", ctxG.indexOf("对陌生人") >= 0);
check("摘要含内部能力段", ctxM.indexOf("内部能力") >= 0);
check("摘要含命令段", ctxM.indexOf("命令：") >= 0);
check("摘要不含原始工具名（噪音纪律）", ctxM.indexOf("take_screenshot") < 0);
check("摘要提到按需查询", ctxM.indexOf("capability_view") >= 0);

// ---------- 按需查询 ----------
const v1 = C.capabilityView(ME, "截图");
check("主人查「截图」能查到", v1.indexOf("截图") >= 0, v1);
const v2 = C.capabilityView(FRIEND, "截图");
check("熟人查「截图」查不到", v2.indexOf("没找到") >= 0, v2);
const v3 = C.capabilityView(ME, "记忆");
check("查「记忆」命中记忆相关", v3.indexOf("记忆") >= 0);
const v4 = C.capabilityView(ME, "空间");
check("查「空间」能命中内部能力", v4.indexOf("空间") >= 0, v4);
const v5 = C.capabilityView(ME, "");
check("空关键词返回完整详情清单", v5.indexOf("能力详情") >= 0 && v5.indexOf("截图") >= 0, v5.slice(0, 60));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
