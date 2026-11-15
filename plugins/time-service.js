/* 插件：框架服务 time（system，v1.96.1 骨骼方案 S2）
 *
 * 所有「时间/日期/时段/中文时间词」的唯一真相在本服务。
 * 业务插件经 _ctx.getApi("time")（或 host.apis.get("time")）使用，requires: ["time"]。
 * index.js 里的同名函数（todayText/dateText/periodOfDay/timeDirective/formatGap/
 * timeAwarenessCtx/dayStr）已降级为薄转发，转发目标就是这里。
 *
 * 迁移来源（均为逐字搬入，未重写）：
 *   index.js:1421-1470   今天/日期/时段/指令/间隔/时间感知
 *   index.js:1630        dayStr（qzone 等「按天」状态键）
 *   plugins/report.js     isoWeekKey / isoWeekMonday / hmNow
 *   plugins/reminders.js  中文时间词解析（cnToNum/parseAmount/parseReminder）
 *
 * 只搬不重写：每个函数都加了一个可选时间参数（d/nowMs），仅为可测试性，
 * 不传参时行为与原来完全一致。
 */
"use strict";

const pad2 = (n) => String(n).padStart(2, "0");
const weekCN = "日一二三四五六";

/* ---------------- 当前时刻（可选 d：毫秒/Date，默认 now） ---------------- */
function _asDate(v) { return v == null ? new Date() : (v instanceof Date ? v : new Date(v)); }

function todayText(d) {
  const n = _asDate(d);
  return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())} 星期${weekCN[n.getDay()]} ${pad2(n.getHours())}:${pad2(n.getMinutes())}`;
}
/* 只到「日期 + 星期」，不含具体分钟——避免每分钟变化打断 prompt 缓存 */
function dateText(d) {
  const n = _asDate(d);
  return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())} 星期${weekCN[n.getDay()]}`;
}
function periodOfDay(d) {
  const h = _asDate(d).getHours();
  if (h < 5) return "深夜";
  if (h < 7) return "凌晨";
  if (h < 9) return "早上";
  if (h < 11) return "上午";
  if (h < 13) return "中午";
  if (h < 17) return "下午";
  if (h < 19) return "傍晚";
  if (h < 23) return "晚上";
  return "深夜";
}
function hourNow(d) { return _asDate(d).getHours(); }
function hmNow(d) { const n = _asDate(d); return n.getHours() * 60 + n.getMinutes(); }
function timeDirective(d) {
  return `【当前时间】现在是北京时间 ${todayText(d)}（${periodOfDay(d)}）。所有涉及时间、日期、时段的表述都以这个为准，绝对不要自己编造或猜测时间；时间仅作背景参考，除非对话自然需要（比如久别重逢、深夜、饭点），否则不要主动报时间。`;
}
function formatGap(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d} 天 ${hh} 小时` : `${d} 天`;
}
function timeAwarenessCtx(gapMs, d) {
  let s = `【当前时间】现在是 ${todayText(d)}（${periodOfDay(d)}）`;
  if (gapMs > 3600e3) {
    s += `（距上次聊天 ${formatGap(gapMs)}）`;
  }
  s += `。时间仅作背景参考：除非对话自然需要（比如久别重逢、深夜、饭点），否则不要主动报时间、也不要主动提时间间隔。`;
  return s;
}
/* qzone 等插件「按天」状态键：off 为往前推几天 */
function dayStr(off, d) {
  const dd = new Date((d == null ? Date.now() : (d instanceof Date ? d.getTime() : d)) - (off || 0) * 86400000);
  return `${dd.getFullYear()}-${pad2(dd.getMonth() + 1)}-${pad2(dd.getDate())}`;
}

/* ---------------- ISO 周（原 report.js，逐字搬入） ---------------- */
function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
}
function isoWeekMonday(d) {
  // ISO 周周一（与 isoWeekKey 同口径，跨年边界一致）：用 UTC 消除本地时区偏移
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;                 // 周一=1..周日=7
  t.setUTCDate(t.getUTCDate() - (day - 1));
  return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

/* ---------------- 中文时间词（原 reminders.js，逐字搬入） ---------------- */
/* 中文数字 → 数值（支持 一~九十九、半、两、一个半、二十） */
function cnToNum(s) {
  const t = String(s || "").trim();
  if (!t) return NaN;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const map = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (t === "十") return 10;
  if (t.indexOf("十") >= 0) {
    const parts = t.split("十");
    const hi = parts[0] === "" ? 1 : (map[parts[0]] || 0);
    const lo = parts[1] === "" ? 0 : (map[parts[1]] || 0);
    return hi * 10 + lo;
  }
  if (map[t] != null) return map[t];
  return NaN;
}
/* 数量：含「个」「半」（如 一个半、半小时、两） */
function parseAmount(s) {
  let t = String(s || "").trim().replace(/个/g, "");
  if (!t) return NaN;
  if (t === "半") return 0.5;
  if (t.endsWith("半")) {
    const base = t.slice(0, -1);
    const n = base === "" ? 1 : cnToNum(base);
    return Number.isFinite(n) ? n + 0.5 : NaN;
  }
  return cnToNum(t);
}
const AMOUNT = "([\\d零一二两三四五六七八九十百半个]+)";
const UNIT = "(分钟|分|小时|钟头|时|天)";
function cleanContent(s) {
  let c = String(s || "").trim();
  c = c.replace(/^(一下|一句|下)/, "").trim();
  c = c.replace(/^[，。！？!?,.\s]+/, "").trim();
  if (!c || c.length < 2) return "";
  if (/^[我你他她它啊呀哦]$/.test(c)) return "";
  return c.slice(0, 60);
}
function parseReminder(text) {
  const s = String(text || "").replace(/\s+/g, "");
  // 1. 相对时间：「X分钟/小时后提醒我YY」「半小时后」「一个半小时后」
  let m = s.match(new RegExp(AMOUNT + UNIT + "(?:后|之后|以后)(?:提醒我|叫我|提醒一下|提醒|喊我)?[:：]?(.+)"));
  if (m) {
    const n = parseAmount(m[1]);
    if (Number.isFinite(n)) {
      const unit = String(m[2]);
      const ms = unit.startsWith("分") ? n * 60000 : (unit === "天" ? n * 86400e3 : n * 3600e3);
      const content = cleanContent(m[3]);
      if (content) return { dueTs: Date.now() + ms, text: content };
    }
  }
  // 2. 绝对时间：「明天/今晚/后天 X点Y分 提醒我ZZ」
  m = s.match(/(明天|明早|今晚|后天|今天)?(上午|下午|晚上|中午)?(\d{1,2}|[一二两三四五六七八九十]{1,3})[:：点时](\d{1,2}|[一二三四五六七八九十]{1,3})?分?(?:提醒我|叫我|提醒一下|提醒|喊我)?[:：]?(.+)/);
  if (m) {
    const dayWord = String(m[1] || "");
    const period = String(m[2] || "");
    let hour = parseAmount(m[3]);
    const min = m[4] ? parseAmount(m[4]) : 0;
    const content = cleanContent(m[5]);
    if (Number.isFinite(hour) && Number.isFinite(min) && content) {
      if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
      const now = new Date();
      let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, min, 0, 0);
      if (dayWord === "明天" || dayWord === "明早") target = new Date(target.getTime() + 86400e3);
      if (dayWord === "后天") target = new Date(target.getTime() + 2 * 86400e3);
      if (dayWord !== "明天" && dayWord !== "后天" && target.getTime() <= now.getTime()) target = new Date(target.getTime() + 86400e3);
      return { dueTs: target.getTime(), text: content };
    }
  }
  return null;
}

module.exports = {
  name: "time-service",
  displayName: "框架服务·时间",
  description: "时间/日期/时段/中文时间词解析的唯一真相（system）。所有业务插件按需取用，禁止自带钟表逻辑。",
  version: "1.0.0",
  system: true,
  userScoped: false,
  engines: { kernel: ">=1.96.0" },
  requires: [],
  permissions: [],
  attribution: { source: "self", license: "self", note: "自研框架服务（从 index.js/report.js/reminders.js 逐字迁移）" },
  init() {},
  apiSpec: {
    time: {
      todayText: { input: "d?毫秒", output: "YYYY-MM-DD 星期X HH:MM", sideEffect: "只读" },
      dateText: { input: "d?毫秒", output: "YYYY-MM-DD 星期X", sideEffect: "只读" },
      periodOfDay: { input: "d?毫秒", output: "深夜/凌晨/早上/上午/中午/下午/傍晚/晚上", sideEffect: "只读" },
      hourNow: { input: "d?毫秒", output: "0-23", sideEffect: "只读" },
      hmNow: { input: "d?毫秒", output: "0-1439（小时*60+分钟）", sideEffect: "只读" },
      timeDirective: { input: "d?毫秒", output: "提示词时间块", sideEffect: "只读" },
      formatGap: { input: "ms", output: "「X 分钟/X 小时/X 天」人话", sideEffect: "只读" },
      timeAwarenessCtx: { input: "gapMs,d?", output: "时间感知块", sideEffect: "只读" },
      dayStr: { input: "off,d?", output: "YYYY-MM-DD", sideEffect: "只读" },
      isoWeekKey: { input: "Date", output: "YYYY-Www", sideEffect: "只读" },
      isoWeekMonday: { input: "Date", output: "ISO 周一的本地零点 Date", sideEffect: "只读" },
      parseReminder: { input: "中文时间词文本", output: "{dueTs,text}|null", sideEffect: "只读" },
      parseAmount: { input: "中文数量", output: "number", sideEffect: "只读" },
      cnToNum: { input: "中文数字", output: "number", sideEffect: "只读" },
    },
  },
  api: {
    time: { todayText, dateText, periodOfDay, hourNow, hmNow, timeDirective, formatGap, timeAwarenessCtx, dayStr, isoWeekKey, isoWeekMonday, parseReminder, parseAmount, cnToNum },
  },
};
