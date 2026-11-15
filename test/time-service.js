#!/usr/bin/env node
/* 测试：框架服务 time（plugins/time-service.js，骨骼方案 S2）
 * 纯函数、不联网、不碰真实 data/；传固定时间参数保证确定性 */
const svc = require("E:/Learn/Momo/plugins/time-service.js");
const T = svc.api.time;
const init = svc.init;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}
const ts = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm).getTime();

// 1. 服务元数据（system 插件规矩：有 api + apiSpec）
check("system 插件", svc.system === true);
check("有 api.time 命名空间", !!(svc.api && svc.api.time));
check("apiSpec 覆盖全部函数", Object.keys(svc.api.time).every((k) => svc.apiSpec && svc.apiSpec.time && svc.apiSpec.time[k]));
check("init 不炸", (init({}), true));

// 2. 基础格式化（固定时间 2026-11-08 星期日 15:05）
const t0 = ts(2026, 11, 8, 15, 5);
check("todayText 格式", T.todayText(t0) === "2026-11-08 星期日 15:05");
check("dateText 无时分", T.dateText(t0) === "2026-11-08 星期日");
check("hourNow", T.hourNow(t0) === 15);
check("hmNow", T.hmNow(t0) === 15 * 60 + 5);
check("dayStr(0) 当天", T.dayStr(0, t0) === "2026-11-08");
check("dayStr(1) 前一天", T.dayStr(1, t0) === "2026-11-07");

// 3. 时段边界（periodOfDay）
const cases = [[3, "深夜"], [6, "凌晨"], [8, "早上"], [10, "上午"], [12, "中午"], [16, "下午"], [18, "傍晚"], [22, "晚上"], [0, "深夜"]];
for (const [h, want] of cases) check(`periodOfDay ${h} 点=${want}`, T.periodOfDay(ts(2026, 11, 8, h, 0)) === want);

// 4. formatGap
check("gap 刚刚", T.formatGap(0) === "刚刚");
check("gap 5 分钟", T.formatGap(5 * 60000) === "5 分钟");
check("gap 2 小时", T.formatGap(2 * 3600e3) === "2 小时");
check("gap 3 天 2 小时", T.formatGap(3 * 86400e3 + 2 * 3600e3) === "3 天 2 小时");

// 5. 时间指令/感知块（v1.86.2 被动口径）
check("timeDirective 含钟点", T.timeDirective(t0).includes("15:05") && T.timeDirective(t0).includes("下午"));
check("timeDirective 被动引导", T.timeDirective(t0).includes("时间仅作背景参考"));
check("timeAwarenessCtx 1 小时内不提间隔", !T.timeAwarenessCtx(60000, t0).includes("距上次聊天"));
check("timeAwarenessCtx >1h 提间隔", T.timeAwarenessCtx(2 * 3600e3, t0).includes("距上次聊天 2 小时"));

// 6. ISO 周（2026-11-08 是周日 → ISO 周一 11-02；2026-11-09 周一 → 11-09）
check("isoWeekKey 周日", T.isoWeekKey(new Date(2026, 10, 8)) === "2026-W45");
check("isoWeekMonday 周日→上周一", T.isoWeekMonday(new Date(2026, 10, 8)).getDate() === 2);
check("isoWeekMonday 周一→当天", T.isoWeekMonday(new Date(2026, 10, 9)).getDate() === 9);

// 7. 中文时间词（从 reminders 迁移，行为必须一致）
check("cnToNum 一", T.cnToNum("一") === 1);
check("cnToNum 二十五", T.cnToNum("二十五") === 25);
check("parseAmount 一个半", T.parseAmount("一个半") === 1.5);
let r = T.parseReminder("一分钟后提醒我测试成功");
check("相对 1 分钟", r && Math.abs(r.dueTs - Date.now() - 60000) < 5000 && r.text === "测试成功");
r = T.parseReminder("3小时后提醒我开会");
check("相对 3 小时", r && Math.abs(r.dueTs - Date.now() - 3 * 3600e3) < 5000 && r.text === "开会");
r = T.parseReminder("明天下午3点提醒我交作业");
check("绝对 明天下午3点", r && r.text === "交作业" && new Date(r.dueTs).getHours() === 15);
check("没时间 → null", T.parseReminder("提醒我喝水") === null);

// 8. 时间感知方案 P1：时段词解析（固定基准 2026-11-15 12:00 北京时间）
const NOON = ts(2026, 11, 15, 12, 0);
let rg = T.resolveTimeRange("下午", NOON);
check("下午 13-18", rg && new Date(rg.from).getHours() === 13 && new Date(rg.to).getHours() === 18);
rg = T.resolveTimeRange("晚上", NOON);
check("晚上 18-23", rg && new Date(rg.from).getHours() === 18 && new Date(rg.to).getHours() === 23);
rg = T.resolveTimeRange("明天早上", NOON);
check("明天早上=次日 5-9", rg && new Date(rg.from).getDate() === 16 && new Date(rg.from).getHours() === 5 && new Date(rg.to).getHours() === 9);
check("无时段词 → null", T.resolveTimeRange("随便聊聊", NOON) === null);

// 9. 时间感知方案 P1：annotatePlan 状态判断
let pl = T.annotatePlan("下午去自习室", NOON);
check("下午·现在中午→还没到", !!(pl && pl.status === "还没到"));
pl = T.annotatePlan("下午去自习室", ts(2026, 11, 15, 14, 30));
check("下午·现在下午→进行中", !!(pl && pl.status === "进行中"));
pl = T.annotatePlan("早上出去跑步", ts(2026, 11, 15, 21, 0));
check("早上·现在晚上→已过", !!(pl && pl.status === "已过"));
check("无时间词 → null", T.annotatePlan("今天心情不错", NOON) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
