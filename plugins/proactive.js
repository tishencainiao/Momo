/* 插件：主动行为（proactiveLoop：何时能打扰 + 说什么话；状态/定时数据在内核 proactive 束）
 * 心流 mindLoop 在内核，只负责思考与非消息行动；「主动发消息」统一放在这里
 * v1.1.0：删掉与心流重复的 shallowThink（"要不要主动做点什么"由心流判断，这里只管何时/说什么） */
let _ctx = null;

function recentQqChat(userId) {
  try {
    const msgs = _ctx.loadSession(userId);
    const cutoff = Date.now() - 4 * 3600e3;
    /* P1-a：不再把对方一律标「主人」——按 resolveCall（主人/朋友昵称）标注 */
    const call = (_ctx.resolveCall ? _ctx.resolveCall(userId) : null) || "对方";
    const parts = msgs.slice(-8).filter((m) => m.ts && m.ts >= cutoff).slice(-4)
      .map((m) => `${m.role === "user" ? call : "我"}：${String(m.content).slice(0, 30)}`);
    return parts.length ? parts.join("；") : "";
  } catch (e) { return ""; }
}
function inQuietHours(pr) {
  const T = (_ctx.getApi && _ctx.getApi("time")) || null;
  const h = T ? T.hourNow() : 23;
  const qs = pr.quiet_start != null ? pr.quiet_start : 0;
  const qe = pr.quiet_end != null ? pr.quiet_end : 7;
  if (qs === qe) return false;
  if (qs < qe) return h >= qs && h < qe;
  return h >= qs || h < qe;
}

/* 时间感知方案 P2：把主人短期记忆里「带时间词的安排」筛出来，标注时段是否已到。
 * 供主动搭话 intro（P1）与主聊天动态块共用。 */
function pendingPlanCtx(userId) {
  try {
    const mem = (_ctx.getApi && _ctx.getApi("memory")) || null;
    const T = (_ctx.getApi && _ctx.getApi("time")) || null;
    if (!mem || !T || !T.annotatePlan) return "";
    const shorts = (mem.loadShortMemories ? mem.loadShortMemories(userId) : null) || [];
    const lines = [];
    for (const m of shorts.slice(0, 12)) {
      const a = T.annotatePlan(String((m && m.content) || ""), Date.now());
      if (a) lines.push(`- ${a.content.slice(0, 60)}（${a.word}，${a.status}）`);
    }
    return lines.slice(0, 4).join("\n");
  } catch (e) { return ""; }
}
/* P1：主动搭话前的「时间条件判断」附加说明（silence/followup 用） */
function timePlanLine(userId) {
  try {
    const T = (_ctx.getApi && _ctx.getApi("time")) || null;
    const nowTxt = T ? `${T.todayText()}（${T.periodOfDay()}）` : "（未知）";
    const plans = pendingPlanCtx(userId);
    return `现在的时间是 ${nowTxt}。\n主人最近的安排：${plans || "（没有带时间词的安排）"}\n搭话前先判断：主人说的那个计划到点了没？如果还没到（比如说的是「下午」而现在是中午），就不要问进度、不要假装他已经在做了；可以问候、分享小想法、或问点别的轻松的事。`;
  } catch (e) { return ""; }
}
/* M1-A：开场白钩子三式——类型库 + 语境变量（只喂事实：时间、对方最后一句原文） */
/* 返修5：silence 6 小时门禁（日期维度）纯函数。
 * gapMs<=6h → 正常放行；gapMs>6h → 今天只放行一次（lastDayKey===今天则拒绝），跨天自动恢复。
 * 返回 { allowed, skipToday }。 */
function silenceGate(gapMs, nowTs, lastDayKey) {
  if (gapMs <= 6 * 3600e3) return { allowed: true, skipToday: false };
  const d = new Date(nowTs); d.setHours(0, 0, 0, 0);
  const today = d.getTime();
  /* 当天或未来的 key 都视为「今天已放行过」→ 拒绝（时钟回拨最坏只暂停 1~2 天，不刷屏） */
  if (Number(lastDayKey) >= today) return { allowed: false, skipToday: true };
  return { allowed: true, skipToday: false };
}

/* Kimi 四轮：完整门禁顺序纯函数（可模拟时间行为测试）。
 * 顺序：①跨天先清零 streak（每天重新给机会）②6h 门禁（silenceGate）③streak>=4 当天暂停 ④streak>=2 降频间隔。
 * state = { lastDayTs, gapMs, lastProactiveTs, nowTs, intervalMs, silenceMs, streak }
 * 返回 { allowed, skipToday, streak }（streak 为决策后应写回的值） */
function evaluateSilenceState(state) {
  const gapMs = state.gapMs, nowTs = state.nowTs, lastDayTs = Number(state.lastDayTs) || 0;
  let streak = Number(state.streak) || 0;
  if (gapMs < state.silenceMs) return { allowed: false, skipToday: false, streak };
  const d = new Date(nowTs); d.setHours(0, 0, 0, 0);
  const today = d.getTime();
  /* ①跨天清零：最后一次搭话（lastProactiveTs）在昨天或更早 → streak 归零（每天重新给机会） */
  const _lp = Number(state.lastProactiveTs) || 0;
  const _lpDay = new Date(_lp); _lpDay.setHours(0, 0, 0, 0);
  if (streak > 0 && _lp > 0 && _lpDay.getTime() < today) streak = 0;
  /* ②6h 门禁：超 6h 每天只放行一次（按 lastSilenceDay 记的放行日） */
  if (gapMs > 6 * 3600e3) {
    const g = silenceGate(gapMs, nowTs, lastDayTs);
    if (!g.allowed) return { allowed: false, skipToday: true, streak };
  }
  /* ③streak>=4 当天暂停 */
  if (streak >= 4) return { allowed: false, skipToday: true, streak };
  /* ④streak>=2 降频间隔 */
  if (streak >= 2) {
    const need = state.intervalMs * streak;
    if (nowTs - _lp < need) return { allowed: false, skipToday: false, streak };
  }
  return { allowed: true, skipToday: false, streak };
}

const HOOK_RULES = "开场必须从下面四种钩子里挑一种落地，禁止「在干嘛呀」「想我了没」这类空问候：\n①问句钩子：问一件具体的、和对方相关的小事（拿开场素材里的事实当由头）\n②分享钩子：说一件你这边刚发生/刚想到的小事（要具体）\n③邀请钩子：邀请对方一起做点什么（看屏幕/拼图/歇会儿）\n④反差钩子：先立个反差再自己圆回来（可以嘴硬）\n要像你自己的话，别像客服的关怀；可以嘴硬、可以顶嘴，别端着。";
function hookLine(userId, call) {
  try {
    const T = (_ctx.getApi && _ctx.getApi("time")) || null;
    const nowTxt = T ? `${T.todayText()}（${T.periodOfDay()}）` : "";
    const his = _ctx.loadSession ? _ctx.loadSession(userId) : [];
    let lastUser = "";
    for (let i = his.length - 1; i >= 0; i--) {
      if (his[i] && his[i].role === "user" && typeof his[i].content === "string") { lastUser = his[i].content; break; }
    }
    if (lastUser.length > 60) lastUser = lastUser.slice(0, 60) + "…";
    const parts = [];
    if (nowTxt) parts.push(`现在是 ${nowTxt}`);
    if (lastUser) parts.push(`${call} 最后说的是：「${lastUser}」`);
    return parts.length ? "\n（开场素材，都是事实）" + parts.join("；") : "";
  } catch (e) { return ""; }
}
function proactiveLoop() {
  const P = _ctx.proactive;
  const pr = _ctx.config.proactive || {};
  if (!pr.enabled) return;
  if (Date.now() - P.STARTED_AT < 5 * 60000) return;
  if (inQuietHours(pr)) return;
  const users = (_ctx.config.qq && _ctx.config.qq.allowed_users) || [];
  if (!users.length) return;
  const hm = _ctx.nowHM();
  const n = new Date();
  const dateStr = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  for (const u of users) {
    (async () => {
      try {
        if (P.isBusy(u)) return;
        if (!_ctx.apiKey) return;
        // ① 用户状态门禁：静默窗口内不打扰；窗口刚过只试探一次
        const _q = _ctx.isUserQuiet ? _ctx.isUserQuiet(u) : { quiet: false, probe: false };
        if (_q.quiet) {
          _ctx.log("info", `主动搭话[${u}] 跳过：对方${_q.label || "在忙"}（静默至 ${new Date(_q.until).toLocaleTimeString("zh-CN")}）`);
          return;
        }
        if (_q.probe) {
          const _probeTxt = _q.kind === "sleep" ? "睡醒了吗" : _q.kind === "nap" ? "午休醒了没" : "忙完了吗";
          const _p = await P.proactiveAgentTurn(u, `对方之前说要去${_q.kind === "sleep" ? "睡觉" : _q.kind === "nap" ? "午休" : "忙别的事"}，时间差不多到了，但你不确定对方醒没醒/忙没忙完。只轻轻问一句类似「${_probeTxt}」的话，不要催、别说别的。`);
          if (_ctx.markProbed) _ctx.markProbed(u);
          if (_p) {
            P.lastProactiveAt.set(u, Date.now());
            P.saveProactiveState();
            _ctx.log("info", `主动搭话[probe] → ${u}：${String(_p).slice(0, 60)}`);
          }
          return;
        }
        // ② Momo 自己在忙（发说说/上网/进化）→ 顺延
        const _act = _ctx.getActivity ? _ctx.getActivity() : null;
        if (_act && _act.since && Date.now() - _act.since < 10 * 60000 && /在发空间|在上网|在进化|在画|在搜/.test(String(_act.text || ""))) {
          _ctx.log("info", `主动搭话[${u}] 顺延：我正在${_act.text}`);
          return;
        }
        const pInt = P.proactiveIntervalMs(u);
        if (!isFinite(pInt) || Date.now() - (P.lastProactiveAt.get(u) || 0) < pInt) return;
        let kind = null, minutes = 0, planEvent = null, followQ = "";
        if (pr.morning_greet && hm === pr.morning_greet && !P.greeted.has(`${u}|${dateStr}|morning`)) {
          kind = "morning"; P.greeted.add(`${u}|${dateStr}|morning`);
        } else if (pr.night_greet && hm === pr.night_greet && !P.greeted.has(`${u}|${dateStr}|night`)) {
          kind = "night"; P.greeted.add(`${u}|${dateStr}|night`);
        } else {
          const last = P.lastActiveAt.get(u) || Date.now();
          const silenceMs = (pr.silence_minutes || 120) * 60000;
          const _gap = Date.now() - last;
          minutes = Math.max(1, Math.round(_gap / 60000));
          // 候选来源优先级：①日程刚发生的事 ②挂了很久的未完话头 ③单纯沉默
          const _plan = _ctx.getApi && _ctx.getApi("dailyPlan");
          const _fu = _ctx.getApi && _ctx.getApi("followup");
          const _ev = _plan ? _plan.recentEvent(40) : null;
          const _pend = _fu ? _fu.pendingFor(u) : [];
          if (_ev && _gap >= 30 * 60000) {
            kind = "schedule"; planEvent = _ev;
          } else if (_pend.length && Date.now() - _pend[0].ts >= 2 * 3600e3 && _gap >= 60 * 60000) {
            kind = "followup"; followQ = _pend[0].q;
          } else {
            if (_gap < silenceMs) return;
            /* 返修5+四轮：silence 门禁与降频统一进纯函数 evaluateSilenceState（跨天清零先于一切判断，可模拟时间测试） */
            const _state = {
              lastDayTs: P.lastSilenceDay ? (P.lastSilenceDay.get(u) || 0) : 0,
              gapMs: _gap,
              lastProactiveTs: P.lastProactiveAt.get(u) || 0,
              nowTs: Date.now(),
              intervalMs: pInt,
              silenceMs,
              streak: P.silenceStreak ? (P.silenceStreak.get(u) || 0) : 0,
            };
            const _dec = evaluateSilenceState(_state);
            if (!_dec.allowed) {
              _ctx.log("info", `主动搭话[silence] → ${u} ${_dec.skipToday ? "今天暂停（明天恢复）" : "降频间隔未到，跳过"}`);
              return;
            }
            if (P.silenceStreak && _dec.streak !== _state.streak) P.silenceStreak.set(u, _dec.streak);
            if (_gap > 6 * 3600e3) {
              const _d = new Date(); _d.setHours(0, 0, 0, 0);
              if (P.lastSilenceDay) P.lastSilenceDay.set(u, _d.getTime());
            }
            if (P.saveProactiveState) { try { P.saveProactiveState(); } catch (e) {} }
            kind = "silence";
          }
        }
        let _streakNote = "";
        if (kind === "silence") {
          _streakNote = "对方一直没说话不代表冷落你，只是没说话；别写「你都不理我」这类委屈或索要的话。";
        }
        /* P1-a：意图文案按人称呼（主人还是主人；朋友用昵称，不再写死「主人」） */
        const _call = (_ctx.resolveCall ? _ctx.resolveCall(u) : null) || "主人";
        const _intents = {
          morning: `给${_call}发一条早安。${HOOK_RULES}`,
          night: `夜深了，给${_call}发一条晚安。${HOOK_RULES}`,
          schedule: `你刚做完「${planEvent ? planEvent.act : ""}」，自然地跟${_call}提一句（像随口分享，不要像汇报）。${HOOK_RULES}`,
          followup: `你之前问过${_call}「${followQ || ""}」。如果有真实的话头就自然提一下；如果没有，就正常打个招呼，不要编造新话题或假经历。${HOOK_RULES}`,
          silence: `${_call}已经约 ${minutes} 分钟没和你说话了。${HOOK_RULES}`,
        };
        /* R0-A1：所有主动搭话统一加「只提已确认事实」硬规则（防「你游戏输了」式未证实前提） */
        const _intentText = (_intents[kind] || `主动和${_call}说点什么（自然、像平时聊天）`) + (_streakNote ? "（" + _streakNote + "）" : "") + "（硬规则：只提对话里实际说过、对方确认过的事；对方没确认过结果的事——输赢、去向、成败、成绩——一律用疑问句轻轻重问，禁止用陈述句断言。）"
          + ((kind === "silence" || kind === "followup") ? "\n" + timePlanLine(u) : "")
          + hookLine(u, _call);
        // ③ 日程/未完话头/沉默候选 → 先让大脑决定「该不该发」，再决定「说什么」（返修5：silence 也走这一关，无新话题允许不发）
        if ((kind === "schedule" || kind === "followup" || kind === "silence") && P.shouldSendNow) {
          const _ok = await P.shouldSendNow(u, _intentText);
          if (!_ok) { _ctx.log("info", `主动搭话[${kind}] 大脑决定不发`); return; }
        }
        const text = await P.proactiveAgentTurn(u, _intentText);
        if (!text) return;
        const _fu2 = _ctx.getApi && _ctx.getApi("followup");
        if (_fu2) _fu2.recordOutbound(u, text);
        P.lastProactiveAt.set(u, Date.now());
        if (kind === "silence" && P.silenceStreak) P.silenceStreak.set(u, (P.silenceStreak.get(u) || 0) + 1);
        P.saveProactiveState();
        try { _ctx.recordAction({ action: "proactive", ok: true }); _ctx.setActivity("发呆"); } catch (e) {}
        _ctx.log("info", `主动搭话[${kind}] → ${u}（${text.length} 字）：${String(text).slice(0, 80).replace(/\n/g, " ")}`);
      } catch (e) { _ctx.log("warn", "主动搭话失败: " + e.message.slice(0, 160)); }
    })();
  }
}

const startTs = Date.now();
let lastProactiveRun = 0;

module.exports = {
  name: "proactive",
  displayName: "主动行为",
  description: "何时能打扰 + 说什么话（状态/定时在内核 proactive 束）",
  userScoped: true,
  permissions: ["apiKey", "config", "getActivity", "getApi", "isUserQuiet", "loadSession", "log", "markProbed", "nowHM", "proactive", "recordAction", "setActivity"],
  version: "1.0.0",
  // dailyPlan 已停用（改用 life-log 的真实活动），这里只依赖 followup；
  // 日程候选在代码里本就有 null 判断，缺了不影响其他候选
  requires: ["followup", "time", "memory"],
  init(ctx) { _ctx = ctx; },
  apiSpec: {"proactive":{"recentQqChat":{"input":"无","output":"string","sideEffect":"只读"},"pendingPlanCtx":{"input":"userId","output":"主人带时间词的安排清单（含已到/未到标注）","sideEffect":"只读"}}},

  api: { proactive: { recentQqChat, pendingPlanCtx } },
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (now - startTs < 60000) return;   // 启动 1 分钟内不主动
      if (now - lastProactiveRun >= 60000) { lastProactiveRun = now; proactiveLoop(); }
    },
  },
};
