#!/usr/bin/env node
/* 测试：报告中心插件（plugins/report.js）
 * 用临时目录造数据，不联网、不碰真实 data/
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "momo-report-"));
const DATA = path.join(TMP, "data");
const SELF = path.join(TMP, "self");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(SELF, { recursive: true });
fs.mkdirSync(path.join(DATA, "reports"), { recursive: true });

const now0 = Date.now();
const today = new Date();

// ---- 造数据 ----
fs.writeFileSync(path.join(DATA, "actions.jsonl"), [
  { ts: now0 - 60000, action: "chat", detail: "x" },
  { ts: now0 - 50000, action: "chat", detail: "y" },
  { ts: now0 - 40000, action: "body_play", detail: "开心" },
  { ts: now0 - 30000, action: "body_look", detail: "看图" },
  { ts: now0 - 300000000, action: "chat", detail: "old" },   // 很久以前，不该算进日报
].map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");

fs.writeFileSync(path.join(DATA, "body-events.jsonl"), [
  { ts: now0 - 20000, event: "click", x: 1, y: 2 },
  { ts: now0 - 15000, event: "click", x: 1, y: 2 },
  { ts: now0 - 10000, event: "self_play", anim: "东张西望" },
  { ts: now0 - 5000, event: "walk", dx: 100 },
].map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");

fs.writeFileSync(path.join(SELF, "journal.json"), JSON.stringify([
  { ts: now0 - 70000, text: "学会了在主人忙的时候安静待着", from: 1 },
]), "utf8");
fs.writeFileSync(path.join(SELF, "reflections.json"), JSON.stringify([
  { ts: now0 - 80000, text: "今天话有点多，明天少说两句" },
]), "utf8");
fs.writeFileSync(path.join(SELF, "identity.json"), JSON.stringify([{ text: "我是大肥鱼" }]), "utf8");
fs.writeFileSync(path.join(SELF, "skills.json"), JSON.stringify({ rules: [{ rule: "少用感叹号" }] }), "utf8");

fs.writeFileSync(path.join(DATA, "goals.json"), JSON.stringify({
  goals: ["让主人开心"],
  plan: { date: "2026-11-06", items: ["安静陪伴", "提醒喝水"] },
}), "utf8");
fs.writeFileSync(path.join(DATA, "wishes.json"), JSON.stringify([{ text: "想要一张新的表情" }]), "utf8");
fs.writeFileSync(path.join(DATA, "mind.json"), JSON.stringify({ thought: "想被摸头" }), "utf8");
fs.writeFileSync(path.join(DATA, "headpat.json"), JSON.stringify({ total: 42 }), "utf8");
fs.writeFileSync(path.join(DATA, "budget.json"), JSON.stringify({ spent_cny: 0.66 }), "utf8");
fs.writeFileSync(path.join(DATA, "reminders.json"), JSON.stringify([
  { text: "喝水", done: false }, { text: "站起来", done: true },
]), "utf8");

// ---- ctx 桩 ----
const settingsStore = new Map();
const captured = { sent: [], files: [], actions: [] };
const ctx = {
  DATA_DIR: DATA,
  SELF_DIR: SELF,
  config: { qq: { master_user: 10001 }, budget: { daily_cny: 3 } },
  apiKey: "test-key",
  getSetting: (k, d) => (settingsStore.has(k) ? settingsStore.get(k) : d),
  setSetting: (k, v) => settingsStore.set(k, v),
  isMaster: (u) => String(u) === "10001",
  log: () => {},
  settings: () => ({}),
  todayText: () => "2026-11-06",
  completeOnce: async () => "这是测试用的心里话。",
  recordAndSend: async (u, t) => { captured.sent.push({ u, t }); },
  sendPrivate: async (u, t) => { captured.sent.push({ u, t }); },
  onebotSend: async (action, params) => { captured.files.push({ action, params }); },
  recordAction: (e) => { captured.actions.push(e); },
  getApi: () => null,
};

const plugin = require(path.join(ROOT, "plugins", "report.js"));
plugin.init(ctx);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + String(extra).slice(0, 300) : "")); }
}

(async () => {
  console.log("\n[1] 插件元数据");
  check("插件名是 report", plugin.name === "report");
  check("有 momo_report 工具", plugin.tools.some((t) => t.def.function.name === "momo_report"));
  check("有 /报告 命令", plugin.commands.some((c) => c.key === "/报告"));
  check("暴露了设置项", Array.isArray(plugin.settings) && plugin.settings.length >= 4);

  console.log("\n[2] 采集只算窗口内");
  const st = plugin.__test.collect("day", now0);
  check("聊天只算今天的 2 次", (st.byAction.chat || 0) === 2, JSON.stringify(st.byAction));
  check("身体事件：被点 2 次", st.clicks === 2, String(st.clicks));
  check("自己玩 1 次", st.selfPlay.length === 1);
  check("走动 1 次", st.walks === 1);
  check("成长记录有 1 条", st.journal.length === 1);

  // 老数据的秒级时间戳也要能算进来
  const sec = Math.round((now0 - 5000) / 1000);
  fs.appendFileSync(path.join(DATA, "body-events.jsonl"),
    JSON.stringify({ ts: sec, event: "click", x: 3, y: 4 }) + "\n", "utf8");
  const st2 = plugin.__test.collect("day", now0);
  check("秒级时间戳的点击也被算进来", st2.clicks === 3, String(st2.clicks));

  console.log("\n[3] 渲染日报");
  const r = await plugin.__test.generate("day");
  check("报告文件已写", fs.existsSync(r.file), r.file);
  check("文件名是 day-日期.md", /day-\d{4}-\d{2}-\d{2}\.md$/.test(r.name), r.name);
  const md = r.md;
  ["# Momo 日报", "## 1. 我这些时候在干嘛", "## 2. 我学到了什么", "## 3. 我想要什么",
    "## 4. 我现在的状态", "## 5. 我的自我进化", "## 6. 我想对主人说"].forEach((h) => {
    check("包含小节：" + h, md.includes(h));
  });
  check("写了她的心里话", md.includes("这是测试用的心里话"), md.slice(0, 200));
  check("带上了目标", md.includes("让主人开心"));
  check("带上了今日计划", md.includes("安静陪伴"));
  check("带上了花费", md.includes("0.660"));
  check("带上了身体统计（被摸 3 次）", md.includes("被摸 3 次"), md.match(/被摸 \d+ 次/));
  check("带上了累计摸头 42", md.includes("42"));
  check("带上了反思", md.includes("明天少说两句"));
  check("带上了规则", md.includes("少用感叹号"));

  console.log("\n[4] 空数据也能出报告");
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-report-empty-"));
  const emptyPlugin = require(path.join(ROOT, "plugins", "report.js"));   // 同一模块，切一下路径即可
  const savedData = ctx.DATA_DIR, savedSelf = ctx.SELF_DIR;
  fs.mkdirSync(path.join(emptyDir, "data"), { recursive: true });
  fs.mkdirSync(path.join(emptyDir, "self"), { recursive: true });
  ctx.DATA_DIR = path.join(emptyDir, "data");
  ctx.SELF_DIR = path.join(emptyDir, "self");
  const r2 = await emptyPlugin.__test.generate("day");
  check("没有任何数据也不崩", r2.md.includes("# Momo 日报") && r2.md.length > 100);
  check("空数据时动作写「没什么动作」", r2.md.includes("没什么动作"), r2.md.slice(0, 160));
  ctx.DATA_DIR = savedData;
  ctx.SELF_DIR = savedSelf;

  console.log("\n[5] 定时判定");
  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
  settingsStore.set("report.daily_time", "21:30");
  check("21:00 还没到点", plugin.__test.dueKind(at(21, 0), {}) === "");
  check("21:30 到点 → day", plugin.__test.dueKind(at(21, 30), {}) === "day");
  const tk = plugin.__test.dayKey(new Date(at(21, 30)));
  check("今天已发过就不再发", plugin.__test.dueKind(at(22, 0), { daily: tk }) === "");
  check("月报优先于日报（1 号且未发月报）", (() => {
    const d = new Date();
    d.setDate(1);
    const now = new Date(d.getFullYear(), d.getMonth(), 1, 22, 0, 0).getTime();
    const mk = plugin.__test.monthKey(new Date(now));
    return plugin.__test.dueKind(now, { monthly: "", daily: "" }) === "month"
      || plugin.__test.dueKind(now, { monthly: mk, daily: "" }) === "day";
  })());

  console.log("\n[6] 周报 / 月报");
  const rw = await plugin.__test.generate("week");
  check("周报文件是 week-YYYY-Www.md", /week-\d{4}-W\d{2}\.md$/.test(rw.name), rw.name);
  check("周报标题正确", rw.md.includes("# Momo 周报"));
  const rm = await plugin.__test.generate("month");
  check("月报文件是 month-YYYY-MM.md", /month-\d{4}-\d{2}\.md$/.test(rm.name), rm.name);
  check("月报标题正确", rm.md.includes("# Momo 月报"));

  console.log("\n[7] 权限");
  const denied = await plugin.tools[0].handler({ kind: "day" }, { userId: "999" });
  check("非主人调工具被拒", /不方便给别人/.test(denied), denied);
  const okMaster = await plugin.tools[0].handler({ kind: "day" }, { userId: "10001" });
  check("主人能生成", /已生成/.test(okMaster), okMaster.slice(0, 120));

  console.log("\n结果：" + pass + " 过 / " + fail + " 失败");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("测试异常:", e); process.exit(1); });
