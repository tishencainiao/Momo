"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm"), assert = require("assert");
const root = path.join(__dirname, ".."), idx = fs.readFileSync(path.join(root, "index.js"), "utf8");
let pass = 0, fail = 0; function T(name, fn) { try { fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; console.log("FAIL " + name + " :: " + e.message); } }
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), "momo-v31-budget-")); }
T("B01 三入口共用applyBudgetChange且桌面不另写配置", () => {
  assert((idx.match(/applyBudgetChange\(/g) || []).length >= 3);
  assert(idx.includes('applyBudgetChange(p.daily_cny, _master, "desktop")'));
  assert(!idx.includes('applyBudgetChange(args.amount, userId, "natural") === false'));
});
T("B02 修改预算保持cfg对象身份并实时重算", () => {
  const dir = temp(), cfg = { qq: { master_user: 42 }, budget: { daily_cny: 3 } }, original = cfg;
  const src = idx.slice(idx.indexOf("function applyBudgetChange("), idx.indexOf("async function agentToolCall("));
  const box = { console, cfg, CFG_FILE: path.join(dir, "config.json"), DATA_DIR: dir, fs, path, isMaster: (u) => Number(u) === 42,
    writeFileAtomic: (f, s) => fs.writeFileSync(f, s), recordAction: () => {}, apiOf: () => ({ budgetLevel: () => ({ daily: cfg.budget.daily_cny, spent: 2.5, ratio: Math.max(0, 1 - 2.5 / cfg.budget.daily_cny), level: cfg.budget.daily_cny <= 2.5 ? "empty" : "normal" }) }) };
  vm.createContext(box); vm.runInContext(src + "\nthis.apply=applyBudgetChange;", box);
  const r = box.apply(2, 42, "desktop");
  assert(r.ok && box.cfg === original && original.budget.daily_cny === 2 && r.budget.level === "empty");
  assert(JSON.parse(fs.readFileSync(box.CFG_FILE, "utf8")).budget.daily_cny === 2);
  assert(fs.readFileSync(path.join(dir, "budget-adjustments.jsonl"), "utf8").includes('"previous_daily_cny":3'));
  fs.rmSync(dir, { recursive: true, force: true });
});
T("B03 非主人与非法金额失败关闭", () => {
  const dir = temp(), cfg = { qq: { master_user: 42 }, budget: { daily_cny: 3 } };
  const src = idx.slice(idx.indexOf("function applyBudgetChange("), idx.indexOf("async function agentToolCall("));
  const box = { cfg, CFG_FILE: path.join(dir, "config.json"), DATA_DIR: dir, fs, path, isMaster: (u) => Number(u) === 42, writeFileAtomic: () => { throw new Error("不应写入"); }, recordAction: () => {}, apiOf: () => ({}) };
  vm.createContext(box); vm.runInContext(src + "\nthis.apply=applyBudgetChange;", box);
  assert(!box.apply(4, 7).ok && !box.apply(0, 42).ok && !box.apply(51, 42).ok);
  fs.rmSync(dir, { recursive: true, force: true });
});
T("B04 预算服务读取调整记录且日报只走API", () => {
  const B = require("../plugins/budget-service"), dir = temp();
  B.init({ config: { budget: { daily_cny: 3 } }, DATA_DIR: dir, writeJsonAtomic: (f, o) => fs.writeFileSync(f, JSON.stringify(o)) });
  fs.writeFileSync(path.join(dir, "budget-adjustments.jsonl"), JSON.stringify({ ts: 100, previous_daily_cny: 3, daily_cny: 4, source: "desktop" }) + "\n");
  const rows = B.api.budget.budgetAdjustments(50);
  assert(rows.length === 1 && rows[0].previous === 3 && rows[0].daily === 4);
  const report = fs.readFileSync(path.join(root, "plugins", "report.js"), "utf8");
  assert(report.includes('getApi("budget").budgetAdjustments(start)') && !report.includes("budget-adjustments.jsonl"));
  fs.rmSync(dir, { recursive: true, force: true });
});
T("B05 管理接口有独立token和autonomy实时门禁", () => {
  assert(idx.includes('crypto.timingSafeEqual') && idx.includes('"/v1/app/autonomy"'));
  const life = fs.readFileSync(path.join(root, "plugins", "life-service.js"), "utf8");
  assert(life.includes("autonomyPaused()") && life.includes('reason: "autonomy_paused"'));
});
T("B06 应用外壳与隐私默认值", () => {
  const cfg = fs.readFileSync(path.join(root, "body", "cfg.py"), "utf8"), sense = fs.readFileSync(path.join(root, "body", "sense.py"), "utf8");
  assert(cfg.includes('"screenshot_enabled": False') && cfg.includes('"window_title_enabled": True'));
  assert(sense.includes("private or locked or not self.title_enabled") && sense.includes('return {"ok": False, "error": "screenshot_disabled"}'));
});
T("B07 不设置无互动日或一元硬配额", () => {
  const combined = idx + fs.readFileSync(path.join(root, "plugins", "life-service.js"), "utf8") + fs.readFileSync(path.join(root, "plugins", "companion-service.js"), "utf8");
  assert(!combined.includes("无互动日") && !combined.includes("daily_cny = 1") && !combined.includes("daily_cny: 1"));
});
T("B08 保存一轮会话时用户原话与回复都进入共享空间", () => {
  const start = idx.indexOf("function sessionPath"), end = idx.indexOf("/* ---------------- 会话摘要", start), records = [];
  const sandbox = { path, fs, SESS_DIR: temp(), writeJsonAtomic() {}, isMaster: (uid) => uid === 42, apiOf: () => ({ recordConversation: (...args) => records.push(args) }) };
  vm.runInNewContext(idx.slice(start, end) + ';saveSession("pet42", [{role:"user",content:"刚吃完饭",ts:11,event_id:"eat"},{role:"assistant",content:"吃完啦",ts:12,event_id:"eat"}]);', sandbox);
  assert(records.length === 2 && records[0][1] === "user" && records[0][2] === "刚吃完饭" && records[0][4] === 11 && records[1][1] === "assistant");
});
console.log(`v3-app-budget: ${pass}/${pass + fail} passed`); if (fail) process.exit(1);
