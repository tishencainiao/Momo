/* 插件：Momo 给主人的报告（整合版）
 *
 * 把原来散落各处的「日报/周报/月报/晚间播报/账单/今日小结」揉成一份，
 * 每天 23:00 由 Momo 用自己口吻写一条，直接发 QQ（不生成文件、不列专业流水账）。
 *
 * 内容：有趣的几件小事 / 一天的总结 / 生活费（花了多少、还剩多少）/
 *       进化（自己已经想通/改好的小事 + 提交等主人点头的想法）/ 想对主人说的话。
 *
 * 周报、月报延续：周日开头写「已经过去一周了…」、每月 1 号写「已经过去一月了…」，
 * 当天就不再另发日报（发周报/月报时不发日报）。
 *
 * 感知：发完把报告写进成长记忆（self/journal.json），Momo 记得自己发过、说了什么。
 *
 * 手动：主人说「给我看看你的报告 / 今天都干嘛了」会触发 momo_report 工具；
 *       也可用 /报告 命令主动拉。
 *
 * 数据源（全部只读已有文件，不做新采集）：
 *   data/actions.jsonl       动作（挑「有趣的事」的候选）
 *   self/journal.json        成长记录 + 自主实现(adopt) + 待批(selfmodify)
 *   self/selfmod-proposals.json  提交等主人确认的大想法
 *   data/budget.json         今日花费
 *   data/body-events.jsonl   被摸/自己玩/走动
 *   data/goals.json、data/wishes.json、data/mind.json  想要/想干/心里在想
 */
const fs = require("fs");
const path = require("path");

let _ctx = null;

const DATA = () => _ctx.DATA_DIR;
const SELF = () => _ctx.SELF_DIR;
const STATE = () => path.join(DATA(), "report-state.json");

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return def; }
}
function readJsonl(file, limit) {
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < (limit || 20000); i--) {
      try { out.push(JSON.parse(lines[i])); } catch (e) {}
    }
    return out.reverse();
  } catch (e) { return []; }
}
/* 老数据里混过秒级时间戳，统一成毫秒 */
function tsOf(v) { const n = Number(v) || 0; return n && n < 1e12 ? Math.round(n * 1000) : n; }
function pad2(n) { return String(n).padStart(2, "0"); }
function dayKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
}
function monthKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }
function isoWeekMonday(d) {
  // ISO 周周一（与 isoWeekKey 同口径，跨年边界一致）：用 UTC 消除本地时区偏移
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;                 // 周一=1..周日=7
  t.setUTCDate(t.getUTCDate() - (day - 1));
  return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}
function windowStart(kind, now) {
  const d = new Date(now);
  if (kind === "week") return isoWeekMonday(d).getTime();
  if (kind === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function loadState() { return readJson(STATE(), { daily: "", weekly: "", monthly: "" }); }
function saveState(s) { try { fs.mkdirSync(DATA(), { recursive: true }); fs.writeFileSync(STATE(), JSON.stringify(s)); } catch (e) {} }

/* ---------------- 采集 ---------------- */
function collect(kind, now) {
  const start = windowStart(kind, now);
  const journal = readJson(path.join(SELF(), "journal.json"), []) || [];
  const recentJournal = journal.filter((e) => tsOf(e.ts) >= start);

  // 自主实现（已落地的小改动）：journal 里 type=adopt 的条目
  const adopted = journal
    .filter((e) => e.type === "adopt" && tsOf(e.ts) >= start)
    .slice(-20)
    .map((e) => String(e.title || e.text || e.rule_id || "").slice(0, 60))
    .filter(Boolean);

  // 提交等主人确认的想法：selfmod-proposals 里 status=pending
  const proposals = (readJson(path.join(SELF(), "selfmod-proposals.json"), []) || [])
    .filter((p) => p.status === "pending")
    .slice(-5)
    .map((p) => String(p.goal || p.name || "").slice(0, 60))
    .filter(Boolean);

  const actions = readJsonl(path.join(DATA(), "actions.jsonl"), 20000).filter((a) => tsOf(a.ts) >= start);
  const budget = readJson(path.join(DATA(), "budget.json"), {}) || {};
  const daily = Number((_ctx.config.budget && _ctx.config.budget.daily_cny) || 1);
  const bodyEvents = readJsonl(path.join(DATA(), "body-events.jsonl"), 20000).filter((e) => tsOf(e.ts) >= start);
  const headpat = readJson(path.join(DATA(), "headpat.json"), {}) || {};
  const goals = readJson(path.join(DATA(), "goals.json"), { goals: [] }) || {};
  const wishes = readJson(path.join(DATA(), "wishes.json"), []) || [];
  const mind = readJson(path.join(DATA(), "mind.json"), {}) || {};

  return {
    kind, start, now,
    recentJournal, adopted, proposals, actions, budget, daily, bodyEvents, headpat, goals, wishes, mind,
  };
}

/* ---------------- 让她自己写 ---------------- */
async function buildReport(st) {
  try {
    const kindLabel = st.kind === "week" ? "一周" : st.kind === "month" ? "一个月" : "一天";
    const journalParts = st.recentJournal
      .slice(-14)
      .map((e) => `${e.type || ""}: ${String(e.text || e.title || e.rule_id || "").slice(0, 44)}`)
      .join("\n");
    const spent = Number(st.budget.spent_cny || 0);
    const remain = Math.max(0, st.daily - spent);
    const clicks = st.bodyEvents.filter((e) => e.event === "click").length;
    const selfPlay = st.bodyEvents.filter((e) => e.event === "self_play").length;
    const walks = st.bodyEvents.filter((e) => e.event === "walk").length;
    const hp = st.headpat && (st.headpat.total != null ? st.headpat.total : st.headpat.count);
    const gs = (st.goals && st.goals.goals) || [];
    const ws = Array.isArray(st.wishes) ? st.wishes : [];

    const facts = [];
    facts.push(`时间范围：${kindLabel}`);
    facts.push(`这段的成长记录（每条前面是类型，可挑有趣的）：\n${journalParts || "（没什么特别的）"}`);
    facts.push(`自己已经想通/改好的小事：${st.adopted.join("；") || "（还没有）"}`);
    facts.push(`提交了、等你点头的想法：${st.proposals.join("；") || "（还没有）"}`);
    facts.push(`生活费：花了 ¥${spent.toFixed(3)}，日预算 ¥${st.daily.toFixed(3)}，还剩 ¥${remain.toFixed(3)}`);
    facts.push(`桌宠窗口：被点 ${clicks} 次、自己找事做 ${selfPlay} 次、走动 ${walks} 次${hp != null ? `、累计被摸头 ${hp} 次` : ""}`);
    if (gs.length) facts.push(`目标：${gs.map((g) => String(g).slice(0, 30)).join("；")}`);
    if (ws.length) facts.push(`想要/想干的：${ws.slice(-3).map((w) => String(w.text || w.title || w).slice(0, 30)).join("；")}`);
    if (st.mind && (st.mind.thought || st.mind.mood)) facts.push(`心里在想：${String(st.mind.thought || st.mind.mood).slice(0, 60)}`);

    const manual = st.openKind === "manual";
    const open = manual ? "你想看啦，那我就跟你说说" : st.kind === "week" ? "已经过去一周了，这一周" : st.kind === "month" ? "已经过去一月了，这一月" : "今天";
    const scene = manual ? "主人主动想看报告了" : `是${kindLabel}的收尾`;
    const prompt = `你是 Momo（大肥鱼桌宠）。现在 ${_ctx.todayText()}，${scene}，你要给主人写一份报告。\n\n下面是这段时间的真实记录：\n${facts.join("\n")}\n\n请用 Momo 的口吻写一份报告，自然可爱、口语化、像在跟主人聊天，不要流水账、不要列专业数字（不要出现"调用几次""Token 多少"这类）。结构：\n1. 开头一句问候（${open}…）\n2. 这段时间最有趣的 2~3 件小事（从成长记录里挑，说人话，别照抄原文）\n3. 一句今天的总结\n4. 生活费：花了多少、还剩多少（可以撒娇说"我很省的"）\n5. 进化：自己已经想通/改好的小事，一句话一件、最多说 3 件、多了就写"还有几件小事也一起弄好了"；再写一件提交等你点头的想法（如果有）\n6. 最后对主人说的话：想说的话、想要的东西、或想干的事\n\n不要标题、不要 Markdown 符号、不要括号动作描写、不要编造记录里没有的事。注意：主人告诉你的偏好/习惯（比如主人爱喝什么、喜欢什么）是「主人的」，不是「你的」；写「想对你说」「我想要」「我想干」时，不要把主人的事说成你自己的事——你自己的偏好只来自你真实经历过的。`;

    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], _ctx.settings(), 500, 0.9);
    return String(raw || "").trim();
  } catch (e) {
    _ctx.log("warn", "报告生成失败: " + String(e && e.message).slice(0, 100));
    return "";
  }
}

/* 感知：把报告写进成长记忆，让她记得自己发过、说了什么 */
function rememberReport(text) {
  try {
    const f = path.join(SELF(), "journal.json");
    const arr = readJson(f, []);
    arr.push({ type: "report", ts: Date.now(), text: String(text).slice(0, 600) });
    while (arr.length > 200) arr.shift();
    fs.writeFileSync(f, JSON.stringify(arr), "utf8");
  } catch (e) {}
}

/* ---------------- 生成 + 送达 ---------------- */
async function generate(kind, openKind) {
  const st = collect(kind, Date.now());
  st.openKind = openKind || "auto";
  const text = await buildReport(st);
  return { st, text, name: kind };
}

async function deliver(kind) {
  const master = Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
  if (!master || !_ctx.apiKey) return { ok: false, error: "no master / no key" };
  const r = await generate(kind, "auto");
  if (!r.text) return { ok: false, error: "empty report" };
  try { await _ctx.recordAndSend(master, r.text); } catch (e) {}
  rememberReport(r.text);
  _ctx.recordAction({ action: "report_" + kind, ok: true });
  _ctx.log("info", `已发送 ${kind} 报告`);
  return { ok: true, text: r.text };
}

/* ---------------- 定时 ---------------- */
function hmNow(now) {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

function dueKind(now, state) {
  const at = String(_ctx.getSetting("report.daily_time", "23:00") || "23:00");
  const m = at.split(":").map((x) => Number(x) || 0);
  if (hmNow(now) < m[0] * 60 + m[1]) return "";
  const d = new Date(now);
  if (state.monthly !== monthKey(d) && d.getDate() === Number(_ctx.getSetting("report.monthly_day", 1))) return "month";
  if (state.weekly !== isoWeekKey(d) && d.getDay() === Number(_ctx.getSetting("report.weekly_dow", 0))) return "week";
  if (state.daily !== dayKey(d)) return "day";
  return "";
}

let lastCheck = 0;
let running = false;

module.exports = {
  name: "report",
  displayName: "给主人的报告",
  description: "日报/周报/月报整合，每天 23:00 用 LLM 口吻写",
  permissions: ["DATA_DIR", "SELF_DIR", "apiKey", "completeOnce", "config", "getSetting", "isMaster", "log", "recordAction", "recordAndSend", "sendPrivate", "settings", "todayText"],
  version: "2.0.0",
  init(ctx) { _ctx = ctx; },
  tools: [
    {
      def: {
        type: "function",
        function: {
          name: "momo_report",
          description: "给主人写一份报告：汇总这段时间有趣的事、一天总结、生活费（花多少剩多少）、进化（自己改好的小事 + 提交等主人确认的想法）、想对主人说的话。主人说「给我看看你的报告」「今天都干嘛了」「汇报一下」时调用。",
          parameters: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["day", "week", "month"], description: "报告周期，默认 day" },
            },
          },
        },
      },
      async handler(args, info) {
        if (!_ctx.isMaster(info && info.userId)) return "（报告是给主人看的，不方便给别人哦）";
        const kind = (args && args.kind) || "day";
        const k = kind === "week" ? "week" : kind === "month" ? "month" : "day";
        const r = await generate(k, "manual");
        if (!r.text) return "（这会儿写报告有点卡壳，等会儿再试试～）";
        rememberReport(r.text);
        _ctx.recordAction({ action: "report_" + k, ok: true });
        return r.text;
      },
    },
  ],
  commands: [
    {
      key: "/报告",
      regex: /^\/报告/,
      async handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "报告只给主人看哦～"); return; }
        const arg = String(msg.text || "").replace(/^\/报告\s*/, "").trim();
        const kind = /周/.test(arg) ? "week" : /月/.test(arg) ? "month" : "day";
        const r = await generate(kind, "manual");
        if (!r.text) { _ctx.sendPrivate(msg.userId, "这会儿写报告有点卡壳，等会儿再试试～"); return; }
        await _ctx.recordAndSend(msg.userId, r.text);
        rememberReport(r.text);
        _ctx.recordAction({ action: "report_" + kind, ok: true });
      },
    },
  ],
  settings: [
    { key: "report.enabled", label: "开启每日报告", type: "boolean", default: true, desc: "每天 23:00 给主人发一份整合报告" },
    { key: "report.daily_time", label: "报告时间", type: "string", default: "23:00", desc: "每天几点发（HH:MM）" },
    { key: "report.weekly_dow", label: "周报星期", type: "number", default: 0, min: 0, max: 6, desc: "0=周日，1=周一 …（发周报当天不发日报）" },
    { key: "report.monthly_day", label: "月报日期", type: "number", default: 1, min: 1, max: 28, desc: "每月几号发月报（发月报当天不发日报）" },
  ],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (now - lastCheck < 30000 || running) return;
      lastCheck = now;
      if (_ctx.getSetting("report.enabled", true) === false) return;
      if (!_ctx.apiKey) return;
      const state = loadState();
      const kind = dueKind(now, state);
      if (!kind) return;
      running = true;
      deliver(kind).then(() => {
        const d = new Date(now);
        const patch = {};
        if (kind === "day") patch.daily = dayKey(d);
        if (kind === "week") patch.weekly = isoWeekKey(d);
        if (kind === "month") patch.monthly = monthKey(d);
        saveState(Object.assign(loadState(), patch));
      }).catch((e) => {
        _ctx.log("warn", "报告发送失败: " + String(e && e.message).slice(0, 100));
      }).then(() => { running = false; });
    },
  },
  /* 供测试用 */
  __test: { collect, buildReport, dueKind, windowStart, dayKey, isoWeekKey, monthKey, rememberReport },
};
