/* 提醒插件测试：中文数字解析 / 相对与绝对时间 / 成功失败文案 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-rem-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

const plugin = require("E:/Learn/Momo/plugins/reminders.js");
plugin.init({
  DATA_DIR: DIR,
  log: () => {},
  getSetting: (k, d) => d,
  formatGap: (ms) => Math.round(ms / 60000) + " 分钟",
  recordAndSend: async () => {},
  sendPrivate: () => {},
});
const R = plugin.api.reminders;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}
function near(ms, expectMin, tolMin) {
  const gotMin = ms / 60000;
  return Math.abs(gotMin - expectMin) <= (tolMin || 1);
}

// 1. 中文数字转换
check("一 → 1", R.cnToNum("一") === 1);
check("两 → 2", R.cnToNum("两") === 2);
check("十 → 10", R.cnToNum("十") === 10);
check("十五 → 15", R.cnToNum("十五") === 15);
check("二十 → 20", R.cnToNum("二十") === 20);
check("二十五 → 25", R.cnToNum("二十五") === 25);
check("3 → 3", R.cnToNum("3") === 3);

// 2. 数量（含个/半）
check("半 → 0.5", R.parseAmount("半") === 0.5);
check("一个半 → 1.5", R.parseAmount("一个半") === 1.5);
check("两个 → 2", R.parseAmount("两个") === 2);

// 3. 相对时间（中文数字）
let r = R.parseReminder("一分钟后提醒我测试成功");
check("一分钟后 → 1 分钟", r && near(r.dueTs - Date.now(), 1), r && String(r.dueTs - Date.now()));
check("内容取对", r && r.text === "测试成功", r && r.text);

r = R.parseReminder("两分钟后提醒我喝水");
check("两分钟后 → 2 分钟", r && near(r.dueTs - Date.now(), 2), r && String(r.dueTs - Date.now()));

r = R.parseReminder("半小时后提醒我起来走走");
check("半小时后 → 30 分钟", r && near(r.dueTs - Date.now(), 30), r && String(r.dueTs - Date.now()));

r = R.parseReminder("一个半小时后提醒我关火");
check("一个半小时后 → 90 分钟", r && near(r.dueTs - Date.now(), 90), r && String(r.dueTs - Date.now()));

r = R.parseReminder("3小时后提醒我开会");
check("3小时后 → 180 分钟", r && near(r.dueTs - Date.now(), 180), r && String(r.dueTs - Date.now()));

// 4. 阿拉伯数字仍然可用
r = R.parseReminder("1分钟后提醒我测试");
check("阿拉伯数字仍然可用", r && near(r.dueTs - Date.now(), 1), r && String(r.dueTs - Date.now()));

// 5. 听不懂的时候
check("没时间 → null", R.parseReminder("提醒我喝水") === null);
check("有时间没内容 → null", R.parseReminder("一分钟后提醒我") === null);

// 6. 工具返回文案（成功/失败必须区分）
const tool = plugin.tools.find((t) => t.def.function.name === "set_reminder");
const okMsg = tool.handler({ content: "两分钟后提醒我测试" }, { userId: 1000 });
check("成功时以【成功】开头", okMsg.indexOf("【成功】") === 0, okMsg);
const badMsg = tool.handler({ content: "提醒我喝水" }, { userId: 1000 });
check("失败时以【失败】开头", badMsg.indexOf("【失败】") === 0, badMsg);
check("失败时提示不要回答已设好", badMsg.indexOf("不要回答已经设好") >= 0, badMsg);

// 7. 落盘
const saved = JSON.parse(fs.readFileSync(path.join(DIR, "reminders.json"), "utf8"));
check("成功的那条已落盘", saved.length === 1 && saved[0].text === "测试", JSON.stringify(saved));
check("失败的没落盘", saved.filter((x) => x.text === "喝水").length === 0);

// 8. 桌面通知开关存在
check("暴露桌面通知开关", (plugin.settings || []).some((s) => s.key === "reminder.desktop_toast"));
check("暴露桌宠待办同步开关", (plugin.settings || []).some((s) => s.key === "reminder.sync_pet_todo"));

// 9. 同步到桌宠待办（模拟桌宠目录）
const PET = path.join(DIR, "pet");
fs.mkdirSync(PET, { recursive: true });
const petTodo = path.join(PET, "todo_items.json");
fs.writeFileSync(petTodo, JSON.stringify({ version: 1, items: [{ id: "old", title: "旧待办", enabled: false }] }));
plugin.init({
  DATA_DIR: DIR,
  log: () => {},
  getSetting: (k, d) => d,
  formatGap: () => "3 分钟",
  recordAndSend: async () => {},
  sendPrivate: () => {},
  config: { pet: { config_path: path.join(PET, "config.json") } },
});
const tool2 = plugin.tools.find((t) => t.def.function.name === "set_reminder");
const msg2 = tool2.handler({ content: "三分钟后提醒我喝水" }, { userId: 1000 });
check("成功文案提到记进待办", msg2.indexOf("记进桌宠待办") >= 0, msg2);
const petData = JSON.parse(fs.readFileSync(petTodo, "utf8"));
check("桌宠待办保留了旧条目", petData.items.some((x) => x.id === "old"));
check("桌宠待办新增了提醒", petData.items.some((x) => x.title === "喝水" && x.enabled === true));
const added = petData.items.find((x) => x.title === "喝水");
check("新条目字段齐全", added && added.kind === "once" && /^\d{2}:\d{2}$/.test(added.time) && /^\d{4}-\d{2}-\d{2}$/.test(added.date) && added.fired_lead_slot === "" && added.fired_due_slot === "", JSON.stringify(added));

// 10. 关掉同步
const plugin2 = require("E:/Learn/Momo/plugins/reminders.js");
plugin2.init({
  DATA_DIR: DIR,
  log: () => {},
  getSetting: (k, d) => (k === "reminder.sync_pet_todo" ? false : d),
  formatGap: () => "3 分钟",
  recordAndSend: async () => {},
  sendPrivate: () => {},
  config: { pet: { config_path: path.join(PET, "config.json") } },
});
const before = JSON.parse(fs.readFileSync(petTodo, "utf8")).items.length;
plugin2.tools.find((t) => t.def.function.name === "set_reminder").handler({ content: "五分钟后提醒我站起来" }, { userId: 1000 });
const after = JSON.parse(fs.readFileSync(petTodo, "utf8")).items.length;
check("关掉同步后不写桌宠待办", after === before, before + " → " + after);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
