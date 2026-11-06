/* 插件：Momo 报告中心 —— 日报 / 周报 / 月报，汇总成一份「给主人的报告」
 *
 * 目的：让主人看得懂 Momo —— 一天里干了什么、学到了什么、想要什么、自己变成了什么样。
 * 数据全部取自已有文件，不做新采集：
 *   data/actions.jsonl      她做过的动作（说话/搜索/看图/身体动作/贴表情…）
 *   self/journal.json       成长记录（自我认知、技能、被教的东西）
 *   self/reflections.json   反思
 *   self/identity.json      自我认知条目
 *   self/skills.json        学会的对话规则
 *   data/goals.json         目标 + 当天的自我计划
 *   data/wishes.json        愿望
 *   data/headpat.json       被摸头次数
 *   data/mind.json          心思/念头
 *   data/budget.json        今日花费
 *   data/body-events.jsonl  身体事件（被点、自己玩、走动）
 *   data/reminders.json     提醒完成情况
 *
 * 送达：QQ 发摘要 + Markdown 文件；也可 /报告 手动拉。
 */
const fs = require("fs");
const path = require("path");

let _ctx = null;

/* ---------------- 小工具 ---------------- */
const DATA = () => _ctx.DATA_DIR;
const SELF = () => _ctx.SELF_DIR;
const REPORTS = () => path.join(DATA(), "reports");
const STATE = () => path.join(DATA(), "report-state.json");

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return def; }
}
/* 老数据里混过秒级时间戳，统一成毫秒（v1.72.0 修正） */
function tsOf(v) {
  const n = Number(v) || 0;
  return n && n < 1e12 ? Math.round(n * 1000) : n;
}
function readJsonl(file, limit) {
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < (limit || 5000); i--) {
      try { out.push(JSON.parse(lines[i])); } catch (e) {}
    }
    return out.reverse();
  } catch (e) { return []; }
}
function loadState() { return readJson(STATE(), { daily: "", weekly: "", monthly: "" }); }
function saveState(s) { try { fs.mkdirSync(DATA(), { recursive: true }); fs.writeFileSync(STATE(), JSON.stringify(s)); } catch (e) {} }

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

function windowStart(kind, now) {
  const d = new Date(now);
  if (kind === "week") {
    const wd = (d.getDay() + 6) % 7;              // 周一为一周开始
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd).getTime();
  }
  if (kind === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const ACTION_LABEL = {
  chat: "聊天", search: "联网搜索", vision: "看图", body_say: "在桌面上说话",
  body_speak: "用语音说话", body_play: "播动画", body_look: "看屏幕",
  body_walk: "走路", body_balance: "看余额", body_fortune: "抽签",
  body_dnd: "开关免打扰", sticker_sent: "贴表情", dsh_notify: "通知",
  qzone_post: "发空间", voice_sent: "发语音",
};

/* ---------------- 采集 ---------------- */
function collect(kind, now) {
  const start = windowStart(kind, now);
  const actions = readJsonl(path.join(DATA(), "actions.jsonl"), 20000).filter((a) => tsOf(a.ts) >= start);
  const byAction = {};
  for (const a of actions) {
    const k = a.action || "other";
    byAction[k] = (byAction[k] || 0) + 1;
  }

  const journal = (readJson(path.join(SELF(), "journal.json"), []) || [])
    .filter((e) => tsOf(e.ts) >= start);
  const reflections = (readJson(path.join(SELF(), "reflections.json"), []) || [])
    .filter((e) => tsOf(e.ts) >= start);
  const identity = readJson(path.join(SELF(), "identity.json"), []) || [];
  const skills = readJson(path.join(SELF(), "skills.json"), { rules: [] }) || { rules: [] };
  const goals = readJson(path.join(DATA(), "goals.json"), { goals: [], plan: null }) || { goals: [], plan: null };
  const wishes = readJson(path.join(DATA(), "wishes.json"), []) || [];
  const headpat = readJson(path.join(DATA(), "headpat.json"), {}) || {};
  const mind = readJson(path.join(DATA(), "mind.json"), {}) || {};
  const budget = readJson(path.join(DATA(), "budget.json"), {}) || {};
  const reminders = readJson(path.join(DATA(), "reminders.json"), []) || [];

  const bodyEvents = readJsonl(path.join(DATA(), "body-events.jsonl"), 20000).filter((e) => tsOf(e.ts) >= start);
  const clicks = bodyEvents.filter((e) => e.event === "click").length;
  const selfPlay = bodyEvents.filter((e) => e.event === "self_play");
  const walks = bodyEvents.filter((e) => e.event === "walk").length;

  const pendingReminders = (Array.isArray(reminders) ? reminders : []).filter((r) => !r.done);

  return {
    kind, start, now,
    actions, byAction,
    journal, reflections, identity, skills, goals, wishes, headpat, mind, budget,
    clicks, selfPlay, walks, pendingReminders,
  };
}

/* ---------------- 渲染 ---------------- */
function fmtActionSummary(byAction) {
  const items = Object.entries(byAction)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${ACTION_LABEL[k] || k} ${v} 次`);
  return items.length ? items.join("、") : "（这段时间没什么动作）";
}

function renderMarkdown(st, opts) {
  const o = opts || {};
  const d = new Date(st.now);
  const title = st.kind === "week" ? "Momo 周报" : st.kind === "month" ? "Momo 月报" : "Momo 日报";
  const range = st.kind === "day"
    ? dayKey(d)
    : st.kind === "week" ? `${isoWeekKey(d)}（近 7 天）` : `${monthKey(d)}`;
  const L = [];
  L.push(`# ${title} · ${range}`);
  L.push("");
  L.push(`> 生成时间：${d.toLocaleString("zh-CN")}　|　这是 Momo 写给主人的报告，不是对外的公告。`);
  L.push("");

  L.push("## 1. 我这些时候在干嘛");
  L.push("");
  L.push(fmtActionSummary(st.byAction));
  if (st.journal.length) {
    L.push("");
    L.push("做过的事（成长记录）：");
    for (const e of st.journal.slice(-12)) {
      const t = new Date(e.ts || 0).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      L.push(`- ${t} ${String(e.text || e.title || e.rule_id || "").slice(0, 80)}`);
    }
  }
  L.push("");

  L.push("## 2. 我学到了什么");
  L.push("");
  L.push(`- 自我认知条目：${(st.identity || []).length} 条`);
  L.push(`- 学会的对话规则：${((st.skills && st.skills.rules) || []).length} 条`);
  if (st.reflections.length) {
    L.push("");
    L.push("最近的自我反思：");
    for (const r of st.reflections.slice(-5)) {
      L.push(`- ${String(r.text || r.summary || r.title || "").slice(0, 100)}`);
    }
  }
  L.push("");

  L.push("## 3. 我想要什么");
  L.push("");
  const gs = (st.goals && st.goals.goals) || [];
  if (gs.length) L.push(`- 目标：${gs.map((g) => String(g).slice(0, 40)).join("；")}`);
  const plan = st.goals && st.goals.plan;
  if (plan && Array.isArray(plan.items) && plan.items.length) {
    L.push(`- 我给自己定的今日计划（${plan.date || ""}）：`);
    for (const it of plan.items) L.push(`  - ${String(it).slice(0, 90)}`);
  }
  const ws = Array.isArray(st.wishes) ? st.wishes : [];
  if (ws.length) L.push(`- 还没办到的小请求：${ws.slice(-3).map((w) => String(w.text || w.title || w).slice(0, 40)).join("；")}`);
  if (st.pendingReminders.length) {
    L.push(`- 还惦记着的提醒：${st.pendingReminders.slice(0, 5).map((r) => String(r.text || "").slice(0, 30)).join("；")}`);
  }
  L.push("");

  L.push("## 4. 我现在的状态");
  L.push("");
  const m = st.mind || {};
  if (m.thought || m.mood) L.push(`- 心里在想：${String(m.thought || m.mood).slice(0, 100)}`);
  if (st.budget && st.budget.spent_cny != null) {
    const daily = Number((_ctx.config.budget && _ctx.config.budget.daily_cny) || 1);
    L.push(`- 今天花了 ¥${Number(st.budget.spent_cny).toFixed(3)}（生活费 ¥${daily}）`);
  }
  L.push(`- 身体：被摸 ${st.clicks} 次、自己找事做 ${st.selfPlay.length} 次、走动 ${st.walks} 次`);
  const hp = st.headpat && (st.headpat.total != null ? st.headpat.total : st.headpat.count);
  if (hp != null) L.push(`- 累计被摸头：${hp} 次`);
  L.push("");

  L.push("## 5. 我的自我进化");
  L.push("");
  const rules = ((st.skills && st.skills.rules) || []).slice(-5);
  if (rules.length) {
    L.push("最近学到的规则：");
    for (const r of rules) {
      let label = r.rule || r.text;
      if (!label && Array.isArray(r.triggers) && r.triggers.length) {
        label = "被叫「" + r.triggers.slice(0, 3).join("／") + "」时的专属回应";
      }
      if (!label) label = r.id || "";
      if (label) L.push(`- ${String(label).slice(0, 90)}`);
    }
  } else {
    L.push("- 这段时间还没有新规则入账，还在学。");
  }
  L.push("");

  if (o.voice) {
    L.push("## 6. 我想对主人说");
    L.push("");
    L.push(o.voice);
    L.push("");
  }
  L.push("---");
  L.push("*由 Momo 自己整理 · 数据来自本地记录，仅主人可见*");
  return L.join("\n");
}

/* ---------------- 让她自己写一段话 ---------------- */
async function buildVoice(st) {
  try {
    const facts = [];
    facts.push(`这段时间的动作：${fmtActionSummary(st.byAction)}`);
    if (st.journal.length) facts.push("成长记录：" + st.journal.slice(-8).map((e) => String(e.text || "").slice(0, 40)).join("；"));
    if (st.goals && st.goals.goals && st.goals.goals.length) facts.push("目标：" + st.goals.goals.join("；"));
    if (st.budget && st.budget.spent_cny != null) facts.push(`花费：¥${Number(st.budget.spent_cny).toFixed(3)}`);
    facts.push(`身体：被摸 ${st.clicks} 次、自己玩 ${st.selfPlay.length} 次`);
    const prompt = `你是 Momo（大肥鱼桌宠）。现在是${st.kind === "week" ? "一周" : st.kind === "month" ? "一个月" : "一天"}的收尾，你要给主人写几句心里话。\n下面是这段时间的真实记录：\n${facts.join("\n")}\n请用 Momo 的口吻写 3~5 句：说一件你印象最深的事、你学到/想明白的一点、以及你现在最想对主人说的话。不要括号动作描写、不要标题、不要编造记录里没有的事。`;
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], _ctx.settings(), 320, 0.8);
    return String(raw || "").trim();
  } catch (e) {
    return "";
  }
}

/* ---------------- 生成 + 送达 ---------------- */
async function generate(kind, opts) {
  const o = opts || {};
  const now = Date.now();
  const st = collect(kind, now);
  let voice = "";
  if (o.withVoice !== false && _ctx.getSetting("report.llm_voice", true) !== false) {
    voice = await buildVoice(st);
  }
  const md = renderMarkdown(st, { voice });
  fs.mkdirSync(REPORTS(), { recursive: true });
  const d = new Date(now);
  const name = kind === "week" ? `week-${isoWeekKey(d)}.md` : kind === "month" ? `month-${monthKey(d)}.md` : `day-${dayKey(d)}.md`;
  const file = path.join(REPORTS(), name);
  try { fs.writeFileSync(file, md, "utf8"); } catch (e) { _ctx.log("warn", "报告写盘失败: " + e.message); }
  return { file, md, st, voice, name };
}

function summaryText(kind, st, file) {
  const label = kind === "week" ? "周报" : kind === "month" ? "月报" : "日报";
  const lines = [];
  lines.push(`主人～我的${label}写好啦 📄`);
  lines.push(`· 动作：${fmtActionSummary(st.byAction)}`);
  lines.push(`· 身体：被摸 ${st.clicks} 次、自己玩了 ${st.selfPlay.length} 次`);
  if (st.budget && st.budget.spent_cny != null) {
    lines.push(`· 花费：¥${Number(st.budget.spent_cny).toFixed(3)}`);
  }
  lines.push(`· 完整报告：${file}`);
  return lines.join("\n");
}

async function deliver(kind) {
  const master = Number((_ctx.config.qq && _ctx.config.qq.master_user) || 0);
  if (!master) return { ok: false, error: "no master" };
  const r = await generate(kind);
  const text = summaryText(kind, r.st, r.file);
  try { await _ctx.recordAndSend(master, text); } catch (e) {}
  // 再把 Markdown 文件发过去（NapCat 私聊文件上传；失败不影响摘要）
  if (_ctx.getSetting("report.send_file", true) !== false) {
    try {
      await _ctx.onebotSend("upload_private_file", { user_id: master, file: r.file, name: r.name });
    } catch (e) {
      _ctx.log("warn", "报告文件发送失败（摘要已发）: " + String(e && e.message).slice(0, 80));
    }
  }
  _ctx.recordAction({ action: "report_" + kind, detail: r.name, ok: true });
  _ctx.log("info", `已生成并发送 ${kind} 报告：${r.name}`);
  return { ok: true, file: r.file, md: r.md };
}

/* ---------------- 定时 ---------------- */
function hmNow(now) {
  const d = new Date(now);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function dueKind(now, state) {
  const cfg = _ctx.config || {};
  const at = String(_ctx.getSetting("report.daily_time", "21:30") || "21:30");
  if (hmNow(now) < at) return "";
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
  init(ctx) {
    _ctx = ctx;
  },
  tools: [
    {
      def: {
        type: "function",
        function: {
          name: "momo_report",
          description: "生成一份给主人的报告（日报/周报/月报）：汇总这段时间做了什么、学到什么、想要什么、自己的状态与进化，写到 data/reports/ 并返回摘要。主人说「给我看看你的报告」「今天都干嘛了」时调用。",
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
        const r = await generate(kind === "week" ? "week" : kind === "month" ? "month" : "day");
        return `${r.name} 已生成（${r.file}）：\n${r.md.split("\n").slice(0, 24).join("\n")}`;
      },
    },
  ],
  commands: [
    {
      key: "/报告",
      regex: /^\/报告/,
      async handler(msg) {
        if (!_ctx.isMaster(msg.userId)) {
          _ctx.sendPrivate(msg.userId, "报告只给主人看哦～");
          return;
        }
        const arg = String(msg.text || "").replace(/^\/报告\s*/, "").trim();
        const kind = /周/.test(arg) ? "week" : /月/.test(arg) ? "month" : "day";
        const r = await generate(kind);
        await _ctx.recordAndSend(msg.userId, summaryText(kind, r.st, r.file));
      },
    },
  ],
  settings: [
    { key: "report.daily_time", label: "日报时间", type: "string", default: "21:30", desc: "每天几点生成日报（HH:MM）" },
    { key: "report.weekly_dow", label: "周报星期", type: "number", default: 0, min: 0, max: 6, desc: "0=周日，1=周一 …" },
    { key: "report.monthly_day", label: "月报日期", type: "number", default: 1, min: 1, max: 28, desc: "每月几号生成月报" },
    { key: "report.llm_voice", label: "让她自己写一段话", type: "boolean", default: true, desc: "用 LLM 生成「我想对主人说」（约 ¥0.002/次）" },
    { key: "report.send_file", label: "发 Markdown 文件", type: "boolean", default: true, desc: "除了摘要，把完整报告作为文件发到 QQ" },
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
        _ctx.log("warn", "报告生成失败: " + String(e && e.message).slice(0, 100));
      }).then(() => { running = false; });
    },
  },
  /* 供测试用 */
  __test: { collect, renderMarkdown, dueKind, windowStart, dayKey, isoWeekKey, monthKey, generate },
};
