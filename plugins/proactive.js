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
  const h = new Date().getHours();
  const qs = pr.quiet_start != null ? pr.quiet_start : 0;
  const qe = pr.quiet_end != null ? pr.quiet_end : 7;
  if (qs === qe) return false;
  if (qs < qe) return h >= qs && h < qe;
  return h >= qs || h < qe;
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
            P.lastActiveAt.set(u, Date.now());
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
            if (_gap > 6 * 3600e3) { _ctx.log("info", `主动搭话[${u}] 沉默超6小时视为隔天，跳过`); return; }
            kind = "silence";
          }
        }
        /* P1-a：意图文案按人称呼（主人还是主人；朋友用昵称，不再写死「主人」） */
        const _call = (_ctx.resolveCall ? _ctx.resolveCall(u) : null) || "主人";
        const _intents = {
          morning: `给${_call}发一条早安问候，可爱一点，可顺带提一句今天的日期或一句俏皮话`,
          night: `夜深了，给${_call}发一条晚安问候，温柔提醒早点休息`,
          schedule: `你刚做完「${planEvent ? planEvent.act : ""}」，自然地跟${_call}提一句（像随口分享，不要像汇报）`,
          followup: `你之前问过${_call}「${followQ || ""}」。如果有真实的话头就自然提一下；如果没有，就正常打个招呼，不要编造新话题或假经历。`,
          silence: `${_call}已经约 ${minutes} 分钟没和你说话了，自然搭话（问候、分享一个可爱的小想法、或问一个轻松的小问题）`,
        };
        // ③ 日程/未完话头候选 → 先让大脑决定「该不该发」，再决定「说什么」
        if ((kind === "schedule" || kind === "followup") && P.shouldSendNow) {
          const _ok = await P.shouldSendNow(u, _intents[kind]);
          if (!_ok) { _ctx.log("info", `主动搭话[${kind}] 大脑决定不发`); return; }
        }
        const text = await P.proactiveAgentTurn(u, _intents[kind] || `主动和${_call}说点什么（自然、像平时聊天）`);
        if (!text) return;
        const _fu2 = _ctx.getApi && _ctx.getApi("followup");
        if (_fu2) _fu2.recordOutbound(u, text);
        P.lastProactiveAt.set(u, Date.now());
        P.lastActiveAt.set(u, Date.now());
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
  permissions: ["apiKey", "config", "getActivity", "getApi", "isUserQuiet", "loadSession", "log", "markProbed", "nowHM", "proactive", "recordAction", "setActivity"],
  version: "1.0.0",
  // dailyPlan 已停用（改用 life-log 的真实活动），这里只依赖 followup；
  // 日程候选在代码里本就有 null 判断，缺了不影响其他候选
  requires: ["followup"],
  init(ctx) { _ctx = ctx; },
  apiSpec: {"proactive":{"recentQqChat":{"input":"无","output":"string","sideEffect":"只读"}}},

  api: { proactive: { recentQqChat } },
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (now - startTs < 60000) return;   // 启动 1 分钟内不主动
      if (now - lastProactiveRun >= 60000) { lastProactiveRun = now; proactiveLoop(); }
    },
  },
};
