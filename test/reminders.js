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
  writeJsonAtomic: (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 0)); } catch (e) {} },
  writeFileAtomic: (f, t) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); } catch (e) {} },
  getSetting: (k, d) => d,
  getApi: (ns) => (ns === "time" ? require("E:/Learn/Momo/plugins/time-service.js").api.time : null),
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
check("桌宠待办同步开关已移除", !(plugin.settings || []).some((s) => s.key === "reminder.sync_pet_todo"));

// 9. 旧桌宠已废弃（M2）：提醒不再写桌宠待办，成功文案也不再提「记进桌宠待办」
const PET = path.join(DIR, "pet");
fs.mkdirSync(PET, { recursive: true });
const petTodo = path.join(PET, "todo_items.json");
fs.writeFileSync(petTodo, JSON.stringify({ version: 1, items: [{ id: "old", title: "旧待办", enabled: false }] }));
plugin.init({
  DATA_DIR: DIR,
  log: () => {},
  getSetting: (k, d) => d,
  getApi: (ns) => (ns === "time" ? require("E:/Learn/Momo/plugins/time-service.js").api.time : null),
  formatGap: () => "3 分钟",
  recordAndSend: async () => {},
  sendPrivate: () => {},
  config: { runtime: { python_path: "python" } },
});
const tool2 = plugin.tools.find((t) => t.def.function.name === "set_reminder");
const msg2 = tool2.handler({ content: "三分钟后提醒我喝水" }, { userId: 1000 });
check("提醒仍设置成功", msg2.indexOf("【成功】") === 0, msg2);
check("成功文案不再提桌宠待办", msg2.indexOf("记进桌宠待办") < 0, msg2);
const petData = JSON.parse(fs.readFileSync(petTodo, "utf8"));
check("桌宠待办文件未被改动", petData.items.length === 1 && petData.items[0].id === "old", JSON.stringify(petData));

(async () => {
  /* ---- Kimi 二轮 P0-2/P0-3 行为测试：失败不写成功凭据 + 重启语义 ---- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(cond, ms = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(25); }
    return cond();
  }
  function makeLedgerCtx(sub, sendRef) {
    const D = path.join(DIR, sub);
    fs.mkdirSync(D, { recursive: true });
    const ledger = { open: {}, lines: [] };
    const ctx = {
      DATA_DIR: D,
      log: () => {},
      writeJsonAtomic: (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 0)); } catch (e) {} },
      writeFileAtomic: (f, t) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); } catch (e) {} },
      getSetting: (k, d) => (k === "reminder.desktop_toast" ? false : d),
      getApi: (ns) => (ns === "time" ? require("E:/Learn/Momo/plugins/time-service.js").api.time : null),
      formatGap: (ms) => Math.round(ms / 60000) + " 分钟",
      actionKey: (...parts) => "ak-" + parts.map((p) => String(p)).join("|"),
      tryBeginAction: (m) => {
        if (ledger.open[m.key]) return { key: m.key, acquired: false, duplicateOf: ledger.open[m.key].status || "running" };
        ledger.open[m.key] = { status: "running" };
        return { key: m.key, acquired: true, duplicateOf: "" };
      },
      endAction: (k, r) => {
        delete ledger.open[k];
        ledger.lines.push({ key: k, status: r && r.ok === true ? "succeeded" : (r && r.ok === false ? "failed" : "unknown"), summary: r && r.summary });
      },
      recordAndSend: async () => ({ result: sendRef.v ? "succeeded" : "failed" }),
      sendPrivate: () => {},
      config: {},
    };
    return { ctx, ledger, D };
  }

  // A. QQ 发送失败：账本只有 failed，提醒保留（done:false）供重试
  {
    const sendRef = { v: false };
    const { ctx, ledger } = makeLedgerCtx("kimi-fail", sendRef);
    plugin.init(ctx);
    const due = 1700000000000;
    ctx.writeJsonAtomic(path.join(ctx.DATA_DIR, "reminders.json"), [{ id: "r1", userId: 1000, text: "喝水", dueTs: due, done: false }]);
    plugin.hooks.timer({ now: due + 31000 });
    await until(() => ledger.lines.length > 0);
    check("发送失败：账本只有 failed，不写成功凭据", ledger.lines.length > 0 && ledger.lines.every((l) => l.status === "failed"), JSON.stringify(ledger.lines));
    const rf = JSON.parse(fs.readFileSync(path.join(ctx.DATA_DIR, "reminders.json"), "utf8"));
    check("失败后提醒保留（done:false + failCount）供重试", rf[0].done === false && rf[0].failCount === 1, JSON.stringify(rf[0]));
    // 重试成功 → done:true + succeeded
    sendRef.v = true;
    plugin.hooks.timer({ now: due + 62000 });
    await until(() => ledger.lines.some((l) => l.status === "succeeded"));
    const rf2 = JSON.parse(fs.readFileSync(path.join(ctx.DATA_DIR, "reminders.json"), "utf8"));
    check("重试成功后 done:true 且补 succeeded", rf2[0].done === true && ledger.lines.some((l) => l.status === "succeeded"), JSON.stringify(rf2[0]));
  }

  // B. 重启语义：未来提醒不进 open（不被对账误取消），到期仍执行且账本无「先取消后成功」
  {
    const sendRef = { v: true };
    const a = makeLedgerCtx("kimi-restart", sendRef);
    plugin.init(a.ctx);
    const tool = plugin.tools.find((t) => t.def.function.name === "set_reminder");
    const msg = tool.handler({ content: "1分钟后提醒我喝水" }, { userId: 1000 });
    check("提醒创建成功", String(msg).indexOf("【成功】") === 0, String(msg));
    check("创建提醒不写 open（未到期不进行动表）", Object.keys(a.ledger.open).length === 0, JSON.stringify(a.ledger.open));
    check("创建提醒不记 proposed 流水", a.ledger.lines.length === 0, JSON.stringify(a.ledger.lines));
    // 模拟重启：同一数据目录、全新账本（open 空 → 对账无可取消项）
    const b = makeLedgerCtx("kimi-restart", sendRef);
    plugin.init(b.ctx);
    const rf0 = JSON.parse(fs.readFileSync(path.join(a.D, "reminders.json"), "utf8"));
    check("重启后未来提醒仍在（done:false）", rf0.length === 1 && rf0[0].done === false, JSON.stringify(rf0));
    const dueTs = rf0[0].dueTs;
    plugin.hooks.timer({ now: dueTs + 31000 });
    await until(() => b.ledger.lines.length > 0);
    check("到期后仍执行成功（succeeded）", b.ledger.lines.some((l) => l.status === "succeeded"), JSON.stringify(b.ledger.lines));
    check("账本无 cancelled（不会先取消后成功）", b.ledger.lines.every((l) => l.status !== "cancelled"), JSON.stringify(b.ledger.lines));
    const rf2 = JSON.parse(fs.readFileSync(path.join(a.D, "reminders.json"), "utf8"));
    check("执行后 done:true", rf2[0].done === true, JSON.stringify(rf2[0]));
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("用例异常:", e); process.exit(1); });
