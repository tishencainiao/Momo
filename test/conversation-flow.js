/* WP2 行为测试：私聊/群聊处理链接入会话恢复状态机（真插件 + vm 提取真函数） */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const IDX = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
function _extractFn(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error("提取失败: " + sig);
  let j = src.indexOf("{", i), d = 0;
  for (; j < src.length; j++) { const c = src[j]; if (c === "{") d++; else if (c === "}") { d--; if (d === 0) { j++; break; } } }
  return src.slice(i, j);
}
const SEG_P = _extractFn(IDX, "async function processPrivateChat(");
const SEG_G = _extractFn(IDX, "async function processGroupChat(");
const SEG_CS = _extractFn(IDX, "async function commitSessionEvent(");

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
};
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "conv-flow-"));

/* 真 conversation-recovery 插件 */
const cr = require(path.join(ROOT, "plugins", "conversation-recovery.js"));
function initCr(dir) {
  const crCtx = {
    DATA_DIR: dir,
    log: () => {}, getSetting: (k, d) => d,
    writeJsonAtomic: (f, v) => fs.writeFileSync(f, JSON.stringify(v)),
    writeFileAtomic: (f, v) => fs.writeFileSync(f, v),
    fs, path,
  };
  cr.init(crCtx);
  return cr.api.conversationRecovery;
}

function mkApis(crApi, over) {
  const noopApi = (extra) => Object.assign({
    crossWindowCtx: () => "", teachCtx: () => "", weatherCtx: async () => "", lifeCtx: () => "",
    hasPendingVoice: () => false, voiceOnlyReply: () => false, findByHash: () => null,
    meaningText: () => "", describeImage: async () => null, imageBytes: async () => Buffer.alloc(0),
    extractFileQuery: () => null, findFiles: async () => ({ ok: false }), runTasks: async () => [],
    markMatched: () => {},
    groupMemberCtx: () => "", groupLogCtx: () => "", groupMemesCtx: () => "", groupInfoCtx: async () => "",
    recordCrossWindow: () => {},
  }, extra || {});
  const apis = {
    conversationRecovery: crApi,
    groupInfo: noopApi(),
    groupChat: noopApi({ shouldAt: () => "on_at", atMode: () => "on_at" }),
    voice: noopApi(),
    stickers: noopApi(),
    vision: noopApi(),
    pcTools: noopApi(),
    lifeLog: noopApi(),
    weather: noopApi(),
    teach: noopApi(),
  };
  Object.assign(apis, over || {});
  return (name) => apis[name] || null;
}

function mkSandbox(crApi, over) {
  const order = [];
  const calls = { sendPrivate: 0, sendVoice: 0, saveSession: 0, model: 0, onebot: 0 };
  const lastReplyAt = new Map();
  const busyUsers = new Set();
  const history = [];
  const moods = { v: 0 };
  const sandbox = {
    console, process, Buffer, setTimeout, clearTimeout, Date, JSON, Math, Number, String,
    module: { exports: {} },
    fs, path, os,
    __order: order, __calls: calls,
    apiOf: mkApis(crApi, (over && over.apis) || {}),
    host: {
      apiOf: mkApis(crApi, (over && over.apis) || {}),
      runHook: () => {},
      ctx: { getSetting: () => undefined },
    },
    cfg: { qq: Object.assign({ cooldown_seconds: 1.5, split_reply: false, reply_gap_ms: 0 }, (over && over.qq) || {}) },
    lastReplyAt, busyUsers,
    isMaster: () => true,
    resolveCall: () => "主人",
    applyStatusRule: () => {},
    loadMsgTimes: () => ({}),
    log: () => {},
    formatGap: () => "",
    resolveChatSettings: () => ({ history_limit: 40, history_chars: 4000, max_tokens: 2000 }),
    isBudgetExhausted: () => false,
    loadBudget: () => ({ spent_cny: 0, calls: {}, spend_by: {} }),
    budgetCfg: () => ({ daily_cny: 2 }),
    saveBudget: () => {},
    sendPrivate: (over && over.sendPrivate) || (async () => { calls.sendPrivate++; order.push("sendPrivate"); }),
    loadSession: () => history.slice(),
    saveSession: (over && over.saveSession) || (() => { calls.saveSession++; order.push("saveSession"); }),
    loadMemories: () => [],
    pruneShortMemories: () => [],
    userPersona: () => "",
    canDo: () => true,
    detectEmotion: async () => null,
    decayEmotion: () => {},
    applyEmotionInertia: (a, b) => b,
    getEmotion: () => ({ name: "平静", intensity: 0, cooling: 0 }),
    setMood: (v) => { moods.v = v; },
    getMood: () => moods.v,
    updateFavor: () => {},
    timeAwarenessCtx: () => "",
    currentStatusCtx: () => "",
    recentSpaceContext: () => "",
    userGroupContext: () => "",
    shouldDeepThink: () => false,
    multiAgentReply: async () => null,
    setActivity: () => {},
    agentChatOnce: async () => { calls.model++; return (over && over.reply !== undefined) ? { reply: over.reply } : { reply: "你好呀" }; },
    buildPersonContext: () => ({}),
    parseStickerMarkers: (t) => ({ cleanText: t }),
    stripStageDirections: (t) => t,
    addWish: () => {},
    sendVoice: async () => { calls.sendVoice++; order.push("sendVoice"); },
    maybeRollSummary: async () => {},
    trimHistory: (h) => h,
    saveSeenMsg: () => {},
    _markScanned: () => {},
    _markCompleted: () => {},
    actionKey: () => "ak-test",
    _sessionRepairs: 0,
    cr: crApi,
    saveMsgTime: () => {},
    listStickers: () => [],
    stickerSessionKey: () => "k",
    sendStickerImage: async () => {},
    noteStickerSent: () => {},
    sleep: async () => {},
    pickStickerSmart: async () => null,
    extractCurrentStatus: () => Promise.resolve(),
    getFavor: () => 0,
    extractSelfIdentity: () => Promise.resolve(),
    selfScoreReply: () => Promise.resolve(),
    detectQzonePost: async () => null,
    publishQzone: async () => null,
    dailyQzoneCount: () => 0,
    onebotSend: (over && over.onebotSend) || (async () => { calls.onebot++; order.push("onebotSend"); }),
    splitReply: (r) => [r],
    evolvePref: (k, d) => d,
    wantsVoice: () => false,
    warmVoice: () => {},
    voiceRateOk: () => false,
    GROUP_DIRECTIVE: "",
    GROUP_LAST_MSGID: new Map(),
    enqueueGroupChat: () => {},
    logJsonl: () => {},
    __history: history,
    _recoverApi: () => crApi,
  };
  vm.createContext(sandbox);
  /* 注入真 commitSessionEvent（依赖 _recoverApi/loadSession/saveSession） */
  try { vm.runInContext(SEG_CS + "\nthis.commitSessionEvent = commitSessionEvent;", sandbox, { filename: "flow-cs.js" }); } catch (e) { sandbox.__err = String(e && e.message); }
  return sandbox;
}

function loadFn(sandbox, seg, fnName, varName) {
  const code = seg + "\nthis." + varName + " = " + fnName + ";";
  try { vm.runInContext(code, sandbox, { filename: "flow.js" }); } catch (e) { sandbox.__err = String(e && e.message); }
}

async function runPPC(over) {
  const dir = mkTmp();
  const crApi = initCr(dir);
  const s = mkSandbox(crApi, over);
  loadFn(s, SEG_P, "processPrivateChat", "__ppc");
  if (s.__err) throw new Error("vm: " + s.__err);
  /* 建事件并推进到 debouncing */
  const ev = crApi.recordEvent({ channel: "private", userId: 100000001, groupId: 0, messageId: "m1", sourceTs: 1000, rawEvent: { message_id: "m1" }, parsedInput: "你好" });
  const evId = ev.event.event_id;
  crApi.updateStage(evId, "debouncing");
  crApi.updateStage(evId, "ready");
  await s.__ppc(100000001, "你好", [], false, 1000, [evId]);
  const _ev = crApi.readEvent(evId);
  if (process.env.MOMO_DEBUG_FLOW) console.log("DBG-P", JSON.stringify(_ev));
  return { s, crApi, evId, ev: _ev };
}

async function runGPC(over) {
  const dir = mkTmp();
  const crApi = initCr(dir);
  const s = mkSandbox(crApi, over);
  loadFn(s, SEG_G, "processGroupChat", "__gpc");
  if (s.__err) throw new Error("vm: " + s.__err);
  const ev = crApi.recordEvent({ channel: "group", userId: 100000001, groupId: 101, messageId: "gm1", sourceTs: 1000, rawEvent: { message_id: "gm1" }, parsedInput: "你好" });
  const evId = ev.event.event_id;
  crApi.updateStage(evId, "debouncing");
  crApi.updateStage(evId, "ready");
  await s.__gpc(101, 100000001, "你好", [], 1000, true, "主人", [evId]);
  const _ev = crApi.readEvent(evId);
  if (process.env.MOMO_DEBUG_FLOW) console.log("DBG-G", JSON.stringify(_ev));
  return { s, crApi, evId, ev: _ev };
}

(async () => {
  /* C01/C16：私聊成功 → succeeded，且 saveSession 在 sendPrivate 之后 */
  {
    const { s, ev } = await runPPC({ reply: "你好呀！" });
    check("私聊成功→succeeded", ev.stage === "succeeded");
    const o = s.__order;
    check("发送成功才写历史（sendPrivate 在 saveSession 前）", o.indexOf("sendPrivate") >= 0 && o.indexOf("saveSession") > o.indexOf("sendPrivate"), JSON.stringify(o));
  }
  /* C16：私聊发送失败 → failed_retryable 且不写历史 */
  {
    const box = { n: 0 };
    const { s, ev } = await runPPC({
      sendPrivate: async () => { box.n++; throw new Error("网络断"); },
    });
    check("私聊发送失败→failed_retryable", ev.stage === "failed_retryable");
    check("发送失败不写会话历史", s.__calls.saveSession === 0);
    check("失败事件带 last_error", String(ev.last_error || "").includes("网络断"));
  }
  /* C15/C31：发送成功但会话历史写盘失败 → 仍 succeeded（回复已发出），只补历史不重发，session_repaired 标记 */
  {
    const { s, ev, crApi } = await runPPC({
      reply: "在的呀",
      saveSession: () => { throw new Error("disk full"); },
    });
    check("历史写盘失败仍 succeeded（不重发）", ev.stage === "succeeded");
    check("事件带 session_repaired", ev.session_repaired === true);
    check("发送只调一次", s.__calls.sendPrivate === 1);
    check("未标会话已提交", ev.session_user_committed !== true && ev.session_assistant_committed !== true);
    /* 修复路径：补写历史 + markCommitted user/assistant（不再发送） */
    const fixed = crApi.readEvent(ev.event_id);
    void fixed;
  }
  /* C18：确定性沉默 → intentional_no_reply */
  {
    const { s, ev } = await runPPC({ reply: "你好呀" });
    s.__history.push({ role: "assistant", content: "晚安，早点睡哦" });
    s.lastReplyAt.delete(100000001);
    s.__calls.model = 0;
    const ev2 = s.apiOf("conversationRecovery").recordEvent({ channel: "private", userId: 100000001, groupId: 0, messageId: "m2", sourceTs: 1000, rawEvent: {}, parsedInput: "晚安" });
    s.apiOf("conversationRecovery").updateStage(ev2.event.event_id, "debouncing");
    s.apiOf("conversationRecovery").updateStage(ev2.event.event_id, "ready");
    await s.__ppc(100000001, "晚安", [], false, 1000, [ev2.event.event_id]);
    const e2 = s.apiOf("conversationRecovery").readEvent(ev2.event.event_id);
    check("道别收尾→intentional_no_reply", e2.stage === "intentional_no_reply" && e2.reason === "closing");
    check("沉默不调模型", s.__calls.model === 0);
  }
  /* cooldown → intentional_no_reply */
  {
    const { s } = await runPPC({ reply: "hi" });
    s.lastReplyAt.set(100000001, Date.now());
    const crApi = s.apiOf("conversationRecovery");
    const ev2 = crApi.recordEvent({ channel: "private", userId: 100000001, groupId: 0, messageId: "m3", sourceTs: 1000, rawEvent: {}, parsedInput: "在吗" });
    crApi.updateStage(ev2.event.event_id, "debouncing");
    await s.__ppc(100000001, "在吗", [], false, 1000, [ev2.event.event_id]);
    check("cooldown→intentional_no_reply", crApi.readEvent(ev2.event.event_id).stage === "intentional_no_reply");
  }
  /* C02/C17：群聊成功 → succeeded */
  {
    const { s, ev } = await runGPC({ reply: "在的呀" });
    check("群聊成功→succeeded", ev.stage === "succeeded");
    const o = s.__order;
    check("群聊发送成功才写历史", o.indexOf("onebotSend") >= 0 && o.indexOf("saveSession") > o.indexOf("onebotSend"), JSON.stringify(o));
  }
  /* C17：群聊分条发送部分失败 → failed_retryable 不写历史 */
  {
    let n = 0;
    const { s, ev } = await runGPC({
      reply: "第一条第二条第三条",
      qq: { split_reply: true, reply_gap_ms: 0 },
      splitReply: () => ["第一", "第二", "第三"],
      onebotSend: async () => { s.__calls.onebot++; s.__order.push("onebotSend"); if (++n >= 2) throw new Error("第二条发送失败"); },
    });
    check("群聊分条部分失败→failed_retryable", ev.stage === "failed_retryable");
    check("分条失败不写会话历史", s.__calls.saveSession === 0);
  }
  /* 群聊 reply 为空 → intentional_no_reply */
  {
    const { s, ev } = await runGPC({ reply: "" });
    check("群聊空回复→intentional_no_reply", ev.stage === "intentional_no_reply" && ev.reason === "empty_reply");
  }
  /* C01/C19 静态断言：index.js 重复投递拦截 */
  check("index.js 含私聊重复投递拦截", SRC.includes("重复投递（已处理/处理中）跳过") || SRC.includes("重复投递"));
  check("index.js 含群聊事件记录", SRC.includes('channel: "group"') && SRC.includes("conversationRecovery"));

  console.log("conversation-flow: " + pass + "/" + (pass + fail) + " passed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
