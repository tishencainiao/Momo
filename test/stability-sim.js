/* 阶段0（做稳）：24h 模拟时钟稳定性测试——假时钟 + 真代码。
 * 真代码：vm 提取 recordAndSend/行动账本（index.js）+ evaluateSilenceState（proactive.js）；
 *         真插件：reminders（timer 驱动）、budget-service、pet-body（离线场景）。
 * 场景：启动对账→私聊成功→提醒失败保留重试→主动搭话门禁→崩溃重启→预算耗尽→身体离线→并发同文→期末对账→跨天恢复。
 * 断言性质（防调参脆化）：不钉死具体次数，只钉死「无重复副作用/无虚假成功/无提醒丢失/无主动风暴/无永久 pending」。 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const PR = fs.readFileSync(path.join(__dirname, "..", "plugins", "proactive.js"), "utf8");

let n = 0, pass = 0;
let _chain = Promise.resolve();
function check(name, fn) {
  n++;
  _chain = _chain.then(async () => {
    try { await fn(); pass++; console.log("  ✓ " + name); }
    catch (e) { console.log("  ✗ " + name + " -> " + (e && e.message)); }
  });
}
function slice(src, needle, tail) {
  const i = src.indexOf(needle);
  assert.ok(i >= 0, "找不到 " + needle);
  const j = src.indexOf(tail, i);
  assert.ok(j >= 0, "找不到尾部 " + tail);
  return src.slice(i, j);
}
async function until(cond, ms, why) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 3000)) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail("until 超时: " + (why || String(cond)));
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "momo-sim-"));
const RealDate = Date;
const T0 = new RealDate(2026, 10, 22, 0, 0, 0).getTime();   // 2026-11-22 00:00 本地
let NOW = T0;
const advance = (min) => { NOW += min * 60000; };
function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(NOW); }
FakeDate.now = () => NOW;
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;

const MASTER = 100000001, FRIEND = 100000002;

/* ---------- vm 世界：真 ledger + 真 recordAndSend + 真 evaluateSilenceState ---------- */
const recLoadSrc = slice(SRC, "function recordAction(entry) {", "/* ===== 阶段一");
const ledgerSrc = slice(SRC, "const ACTION_STATE_FILE = path.join(DATA_DIR, \"action-state.json\");", "const SESS_DIR = path.join(DATA_DIR, \"sessions\");");
const sendSrc = slice(SRC, "const _sendInFlight = new Map();", "async function proactiveAgentTurn");
const silenceSrc = slice(PR, "function silenceGate(", "const HOOK_RULES");

/* 发送故障门 + 调用日志（真副作用由 sendPrivate mock 全权模拟） */
let sendFail = false;
const sendCalls = [];      // {u, t, ok}
const sessions = {};       // uid -> [{role, content}]

const world = {
  DATA_DIR: TMP,
  ACTION_LOG_FILE: path.join(TMP, "actions.jsonl"),
  writeFileAtomic: (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); },
  writeJsonAtomic: (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); },
  log: () => {},
  module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout, fs, path,
  crypto: require("crypto"),
  require: (m) => (m === "crypto" ? require("crypto") : undefined),
  Date: FakeDate,
  loadSession: (u) => sessions[u] || [],
  saveSession: (u, h) => { sessions[u] = h.slice(); },
  saveMsgTime: () => {},
  trimHistory: (h) => h,
  sendPrivate: async (u, t) => {
    if (sendFail) { sendCalls.push({ u, t, ok: false }); throw new Error("QQ 挂了（模拟）"); }
    sendCalls.push({ u, t, ok: true });
    return { data: { message_id: "sim-" + sendCalls.length } };
  },
  host: { runBeforeSend: () => {} },
  undefined,
};
vm.runInNewContext(recLoadSrc + "\n" + ledgerSrc + "\n" + sendSrc + "\nthis.__send = recordAndSend;", world, { filename: "sim-ledger-send.js" });
vm.runInNewContext(silenceSrc + "\nthis.__gate = evaluateSilenceState;", world, { filename: "sim-silence.js" });
const api = {
  actionKey: world.actionKey,
  loadActions: world.loadActions,
  tryBeginAction: world.tryBeginAction,
  endAction: world.endAction,
  verifyAction: world.verifyAction,
  reconcile: world.reconcileOpenActions,
};
const __send = (u, t) => world.__send(u, t, true);

/* ---------- 真 reminders 插件（timer 驱动 fire 循环） ---------- */
const remMod = require("../plugins/reminders.js");
const remCtx = {
  DATA_DIR: TMP,
  getSetting: (k, d) => (k === "reminder.desktop_toast" ? false : d),
  writeJsonAtomic: (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); },
  writeFileAtomic: (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); },
  log: () => {},
  getApi: (name) => (name === "time" ? require("../plugins/time-service.js").api.time : name === "body" ? { announce: async () => {} } : null),
  actionKey: api.actionKey,
  tryBeginAction: api.tryBeginAction,
  endAction: api.endAction,
  recordAndSend: async (u, t) => world.__send(u, t, true),
  sendPrivate: async () => {},
  formatGap: () => "一会儿",
};
remMod.init(remCtx);
const remFile = () => path.join(TMP, "reminders.json");
const readRem = () => JSON.parse(fs.readFileSync(remFile(), "utf8"));
const fireTimer = () => remMod.hooks.timer({ now: NOW });

/* ---------- 真 budget-service ---------- */
const budMod = require("../plugins/budget-service.js");
const budCtx = {
  DATA_DIR: TMP,
  config: { budget: { daily_cny: 1 } },
  log: () => {},
  writeJsonAtomic: (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); },
  writeFileAtomic: (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); },
};
budMod.init(budCtx);
const B = budMod.api.budget;

/* ---------- 场景 1：00:00 启动对账 ---------- */
check("00:00 启动对账：open 清空、无遗留 running 重放", async () => {
  api.reconcile();
  let openCount = 0;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(TMP, "action-state.json"), "utf8"));
    openCount = Object.keys(st.open || {}).length;
  } catch (e) { /* 文件不存在 = 无遗留 open，合法 */ }
  assert.strictEqual(openCount, 0, "启动后 open 应为空");
});

/* ---------- 场景 2：00:10 私聊成功 ---------- */
check("00:10 私聊成功：succeeded+verified 回执+会话写入", async () => {
  advance(10);
  const r = await __send(MASTER, "今晚吃火锅吗");
  assert.strictEqual(r.result, "succeeded");
  assert.ok(sessions[MASTER] && sessions[MASTER].some((m) => m.content === "今晚吃火锅吗"), "成功消息应进会话");
  const rows = api.loadActions(10);
  const v = rows.find((a) => a.key === r.key && a.status === "verified");
  assert.ok(v, "应有独立「结果已验证」行");
  assert.ok(v.verification_event_id && String(v.verification_event_id).startsWith("sim-"), "回执 eventId 应落盘");
});

/* ---------- 场景 3+4：提醒 03:01 失败保留重试、03:05 恢复成功 ---------- */
const REM_DUE = T0 + 180 * 60000;
const REM_KEY = world.actionKey("reminder_fire", MASTER, "喝水", REM_DUE);
check("03:01 提醒发送失败：failed 凭据、done 不置、会话不写", async () => {
  fs.writeFileSync(remFile(), JSON.stringify([{ id: "r1", userId: MASTER, text: "喝水", dueTs: REM_DUE, done: false, actKey: REM_KEY }]));
  advance(171);                       // 03:01
  sendFail = true;
  fireTimer();
  await until(() => readRem()[0].failCount === 1, 3000, "提醒应记一次失败");
  const x = readRem()[0];
  assert.strictEqual(x.done, false, "失败不得标记完成");
  const rows = api.loadActions(10).filter((a) => a.key === REM_KEY);
  const last = rows[rows.length - 1];
  assert.strictEqual(last.status, "failed", "账本应记 failed");
  assert.ok(!rows.some((a) => a.status === "succeeded"), "失败期间不得出现成功凭据");
  assert.ok(!(sessions[MASTER] || []).some((m) => String(m.content).includes("提醒你：喝水")), "失败消息不得进会话历史");
  sendFail = false;
});

check("03:05 恢复后重试成功：done:true、succeeded 凭据", async () => {
  advance(4);
  fireTimer();
  await until(() => readRem()[0].done === true, 3000, "提醒应重试成功");
  const rows = api.loadActions(10).filter((a) => a.key === REM_KEY);
  const last = rows[rows.length - 1];
  assert.strictEqual(last.status, "succeeded", "重试成功后应记 succeeded");
  assert.ok((sessions[MASTER] || []).some((m) => String(m.content).includes("提醒你：喝水")), "成功后会话应写入提醒");
});

/* ---------- 场景 5：主动搭话门禁（03:30 起，streak 涨到 4 → 当天停） ---------- */
check("主动搭话门禁：streak 到 4 当天停、skipToday 后主动循环零发送、24h 总量不风暴", async () => {
  const lastInteraction = T0 + 10 * 60000;              // 00:10 主人消息
  let streak = 0, lastPro = 0, lastSilenceDay = 0, proSends = 0;
  const INTERVAL = 20 * 60000, SILENCE = 120 * 60000;
  let sawSkipToday = false, skipAtCount = -1;
  /* 03:30 起每 30~180 分钟一次门禁尝试，一直到 22:00；skipToday 出现后仍继续跑门禁（不手动发消息），
   * 断言「第一次 skipToday 时的发送数」在后续所有尝试里不再增加——证明是门禁挡住了，不是测试没跑。 */
  const times = [210, 240, 270, 300, 330, 360, 420, 480, 600, 780, 960, 1200];
  for (const t of times) {
    advance(t - Math.floor((NOW - T0) / 60000));        // 绝对推进到 t
    const state = { gapMs: NOW - lastInteraction, lastProactiveTs: lastPro, nowTs: NOW, intervalMs: INTERVAL, silenceMs: SILENCE, streak, lastDayTs: lastSilenceDay };
    const dec = world.__gate(state);
    if (dec.allowed) {
      assert.ok(!sawSkipToday, "skipToday 之后不允许再放行（当天停）");
      const r = await __send(MASTER, "主动搭话 " + (proSends + 1));
      assert.strictEqual(r.result, "succeeded", "放行的主动搭话应发送成功");
      proSends++; lastPro = NOW; streak = dec.streak + 1;
      if (NOW - lastInteraction > 6 * 3600e3) lastSilenceDay = new RealDate(NOW).setHours(0, 0, 0, 0);
    } else if (dec.skipToday) {
      if (!sawSkipToday) { sawSkipToday = true; skipAtCount = proSends; }   // 记录第一次 skipToday 时的主动发送数
      assert.strictEqual(proSends, skipAtCount, "skipToday 后主动循环不得再发送（发送数不增加）");
    }
    assert.ok(proSends <= 6, "24h 主动发送不得风暴（≤6）");
  }
  assert.ok(sawSkipToday, "streak≥4 后应出现 skipToday（当天停）");
  assert.ok(skipAtCount >= 4, "skipToday 出现在 streak≥4（连续 4 次无回复）之后，实际=" + skipAtCount);
});

/* ---------- 场景 6：15:30 崩溃重启（open running → unknown 不重放） ---------- */
check("15:30 崩溃重启：running→unknown 不重放、open 清空", async () => {
  advance(Math.max(0, 930 - Math.floor((NOW - T0) / 60000)));
  const key = api.actionKey("qzone_post", MASTER, "图文测试内容");
  const t = api.tryBeginAction({ key, action: "qzone_post", channel: "qzone", userId: MASTER, requestedBy: MASTER });
  assert.strictEqual(t.acquired, true);
  api.reconcile();                                       // 模拟重启对账
  const st = JSON.parse(fs.readFileSync(path.join(TMP, "action-state.json"), "utf8"));
  assert.strictEqual(Object.keys(st.open || {}).length, 0, "对账后 open 应清空");
  const rows = api.loadActions(20).filter((a) => a.key === key);
  const last = rows[rows.length - 1];
  assert.strictEqual(last.status, "unknown", "重启后 running 应转 unknown");
  assert.ok(!rows.some((a) => a.status === "succeeded"), "unknown 不得冒充成功/重放");
});

/* ---------- 场景 7：18:00 预算耗尽 ---------- */
check("18:00 预算耗尽：minimal 档、付费动作不可用", async () => {
  advance(Math.max(0, 1080 - Math.floor((NOW - T0) / 60000)));
  fs.writeFileSync(path.join(TMP, "budget.json"), JSON.stringify({ date: new RealDate().toDateString(), spent_cny: 1.5 }));
  assert.strictEqual(B.isBudgetExhausted(), true, "花超了应判定耗尽");
  assert.strictEqual(B.budgetTier(), "minimal", "耗尽应落 minimal 档");
  assert.strictEqual(B.canAfford("mid"), false, "empty 档付不起 mid");
  assert.strictEqual(B.canAfford("low"), false, "empty 档连 low 都付不起（熔断生效）");
});

/* ---------- 场景 8：19:00 身体离线 ---------- */
check("19:00 身体离线：状态工具返回离线提示、sense 事件仍可落盘", async () => {
  advance(Math.max(0, 1140 - Math.floor((NOW - T0) / 60000)));
  process.env.MOMO_BODY_EVENTS = path.join(TMP, "body-events.jsonl");
  global.fetch = async () => { throw new Error("ECONNREFUSED 模拟"); };
  const bodyMod = require("../plugins/pet-body.js");
  const bodyCtx = {
    getSetting: (k, d) => d,
    writeJsonAtomic: (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); },
    writeFileAtomic: (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); },
    log: () => {}, isMaster: () => true, recordAction: () => {}, sendPrivate: async () => {},
    addMood: () => {}, addBoredom: () => {}, getApi: () => null, describeImageFile: async () => "",
  };
  bodyMod.init(bodyCtx);
  const tool = bodyMod.tools.find((x) => x.def && x.def.function && x.def.function.name === "pet_body_status");
  assert.ok(tool, "pet_body_status 工具应存在");
  const out = await tool.handler({}, { userId: MASTER });
  assert.ok(String(out).includes("身体好像没在跑"), "离线应返回可读提示而不是报错，got: " + out);
  assert.strictEqual(bodyMod.__test.sense.connected, false, "离线时 sense.connected 应为 false");
  /* 离线不阻断感官事件落盘（事件流仍可记录，供恢复后对账） */
  bodyMod.__test.handleBodyEvent("sense", { presence: "active", idle_s: 5, locked: false, foreground: { app: "测试程序", pid: 1 } });
  assert.strictEqual(bodyMod.__test.sense.presence, "active", "事件应更新 sense");
  const evLines = fs.readFileSync(process.env.MOMO_BODY_EVENTS, "utf8").trim().split("\n");
  assert.ok(evLines.some((l) => l.includes('"event":"sense"')), "sense 事件应落盘");
});

/* ---------- 场景 9：20:00 并发同文只发一次 ---------- */
check("20:00 并发同文私聊：只产生一次真实发送", async () => {
  advance(Math.max(0, 1200 - Math.floor((NOW - T0) / 60000)));
  let release;
  const barrier = new Promise((r) => { release = r; });
  const origSend = world.sendPrivate;
  world.sendPrivate = async (u, t) => { await barrier; return origSend(u, t); };
  const p1 = __send(MASTER, "并发场景文本");
  const p2 = __send(MASTER, "并发场景文本");
  await new Promise((r) => setTimeout(r, 30));
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1.result, "succeeded");
  assert.strictEqual(r2.result, "succeeded");
  const sameText = sendCalls.filter((c) => c.t === "并发场景文本" && c.ok).length;
  assert.strictEqual(sameText, 1, "两次并发同文只真正发一次");
  world.sendPrivate = origSend;
});

/* ---------- 场景 10：23:59 期末对账 ---------- */
check("23:59 期末对账：0 遗留、无 cancelled→succeeded 矛盾", async () => {
  advance(Math.max(0, 1439 - Math.floor((NOW - T0) / 60000)));
  api.reconcile();
  const st = JSON.parse(fs.readFileSync(path.join(TMP, "action-state.json"), "utf8"));
  assert.strictEqual(Object.keys(st.open || {}).length, 0, "期末 open 应空");
  const rows = api.loadActions(500);
  const byKey = {};
  for (const a of rows) { (byKey[a.key] = byKey[a.key] || []).push(a.status); }
  for (const k of Object.keys(byKey)) {
    const seq = byKey[k];
    const ci = seq.lastIndexOf("cancelled"), si = seq.lastIndexOf("succeeded");
    assert.ok(!(ci >= 0 && si > ci), "同 key 不得先 cancelled 后 succeeded（矛盾记录）: " + k);
  }
});

/* ---------- 场景 11：次日 02:00 跨天恢复 ---------- */
check("次日 02:00 跨天恢复：streak 清零、放行一次且不风暴", async () => {
  advance(120);                                          // 24:00 + 2h
  const lastInteraction = T0 + 10 * 60000;
  const state = { gapMs: NOW - lastInteraction, lastProactiveTs: T0 + 360 * 60000, nowTs: NOW, intervalMs: 20 * 60000, silenceMs: 120 * 60000, streak: 4, lastDayTs: new RealDate(T0).setHours(0, 0, 0, 0) };
  const dec = world.__gate(state);
  assert.strictEqual(dec.allowed, true, "跨天应清零 streak 重新给机会");
  assert.strictEqual(dec.streak, 0, "返回的 streak 应已清零");
  const r = await __send(MASTER, "次日主动搭话");
  assert.strictEqual(r.result, "succeeded", "次日第一条应发送成功");
});

/* ---------- 收尾 ---------- */
_chain.then(() => {
  console.log("\n" + pass + "/" + n + " 通过" + (pass === n ? "" : "（有失败）"));
  process.exit(pass === n ? 0 : 1);
});
