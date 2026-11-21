/* audit-service（框架服务 · system:true）
 * 骨骼方案 S3：输出前「吹牛审计」的唯一真相。
 * 从 index.js auditReply + addOverclaimReflection + coreSettingBool 迁移而来，
 * 通过 before_send 钩子在所有私聊回话点统一拦截改写。
 */
const path = require("path");
const fs = require("fs");
const fabricationGuard = require("../fabrication-guard");
let _ctx = null;

function enabledFlag() {
  const v = _ctx.getSetting("safety.audit.enabled", true);
  if (v === undefined || v === null) return true;
  return v === true || v === "true" || v === 1 || v === "1";
}

function addOverclaimReflection(capability, saidText) {
  try {
    const p = path.join(_ctx.SELF_DIR, "reflections.json");
    let arr = [];
    try { const d = JSON.parse(fs.readFileSync(p, "utf8")); if (Array.isArray(d)) arr = d; } catch (e) {}
    arr.push({ text: `我想说「${String(saidText || "").slice(0, 30)}」的时候其实做不到（${capability}），以后要先如实说做不了。`, from: "overclaim", ts: Date.now(), subject: "overclaim" });
    while (arr.length > 100) arr.shift();
    fs.mkdirSync(_ctx.SELF_DIR, { recursive: true });
    _ctx.writeJsonAtomic(p, arr);
  } catch (e) {}
}

/* 阶段一：动作自述 ↔ 行动凭据 校验。
 * 声称「我刚(帮你)做了X」时，先查本轮工具台账（usedTools），再查最近行动流水（loadActions），
 * 都查不到 → 认为是虚假成功自述，附上自我纠正（不删原话，由她说人话收回）。 */
const CLAIM_RE = /(?:我刚|我已经|刚刚|刚才)(?:帮你?|给你?|替[你他她]|帮主人)?(搜|查|存|记|发|加|改|关|开|删|订)(?:了|过|好了)/;
const CLAIM_VERB_ACTIONS = {
  "搜": ["search", "web_search", "bing", "bingSearch"],
  "查": ["search", "web_search", "bing", "weather", "balance", "look"],
  "存": ["memory_edit", "memory_add", "memory_save", "save"],
  "记": ["memory_edit", "memory_add", "remember", "todo_add", "reminder_add"],
  "发": ["send", "qzone_post", "forward", "sticker_sent", "report_day", "report_week", "report_month", "proactive"],
  "加": ["todo_add", "reminder_add", "memory_add", "hobby_add"],
  "改": ["memory_edit", "settings_set", "selfmodify_approve"],
  "关": ["settings_set", "dnd_on"],
  "开": ["settings_set", "dnd_off"],
  "删": ["todo_del", "reminder_del", "memory_forget"],
  "订": ["reminder_add", "todo_add"],
};
function verifyClaim(text, usedTools, outcomes) {
  const m = String(text || "").match(CLAIM_RE);
  if (!m) return { ok: true, text };
  const verb = m[1];
  const want = CLAIM_VERB_ACTIONS[verb] || [];
  const wantL = want.map((w) => w.toLowerCase());
  const tools = (usedTools || []).map((t) => String(t).toLowerCase());
  /* 强凭据：行动流水里 60 分钟内真有 succeeded/verified 记录（proposed/cancelled/failed/unknown 不算） */
  let acts = [];
  try { acts = (_ctx.loadActions ? _ctx.loadActions(40) : []) || []; } catch (e) {}
  const cutoff = Date.now() - 60 * 60000;
  const hit = acts.find((a) => a && a.ts >= cutoff && (a.status === "succeeded" || a.status === "verified" || a.ok === true) && wantL.some((w) => String(a.action || "").toLowerCase().includes(w)));
  if (hit) return { ok: true, text };
  /* 中凭据：本轮结构化 ToolOutcome 明确 succeeded（工具真的返回了成功） */
  const oHit = (outcomes || []).find((o) => o && o.status === "succeeded" && wantL.some((w) => String(o.tool || "").toLowerCase().includes(w)));
  if (oHit) return { ok: true, text };
  /* 弱凭据：usedTools 只说明「工具被叫过」，不知道成败 → 不再单独充当成功凭据 */
  const weak = wantL.some((w) => tools.includes(w));
  const fix = "（我先翻了自己的记录——刚才这句先收回，我好像还没真正做成这件事，别算我的功劳）";
  _ctx.log("warn", `行动自述校验：声称「${m[0]}」但行动流水与 ToolOutcome 都无成功凭据（工具台账${weak ? "仅弱匹配" : "无匹配"}）→ 已附自我纠正`);
  return { ok: false, text: String(text).replace(m[0], m[0] + fix) };
}

function auditReply(text, usedTools, outcomes) {
  const src = String(text || "");
  if (!src) return { text: src, blocked: false };
  try {
    const cap = _ctx.getApi("capability");
    if (!cap || !cap.limitTriggers) return { text: src, blocked: false };
    const res = fabricationGuard.auditReply({
      text: src,
      usedTools,
      triggers: cap.limitTriggers(),
      enabled: enabledFlag(),
    });
    if (!res.blocked) {
      /* 阶段一：吹牛表没命中时，再做「动作自述 ↔ 行动凭据」校验 */
      const v = verifyClaim(src, usedTools, outcomes);
      return { text: v.text, blocked: false };
    }
    _ctx.log("warn", `审计拦截：声称「${res.hit.phrase}」（${res.hit.label}），本轮工具台账=[${(usedTools || []).join(",")}] → 已替换成如实说明`);
    try { cap.noteOverclaim(res.hit.label, res.hit.phrase); } catch (e) {}
    addOverclaimReflection(res.hit.label, src.slice(0, 60));
    return { text: res.text, blocked: true, label: res.hit.label };
  } catch (e) { return { text: src, blocked: false }; }
}

module.exports = {
  name: "audit-service",
  displayName: "审计服务（框架）",
  version: "1.0.0",
  description: "输出前吹牛审计：把「做不到的能力」说法改写成如实说明（before_send 钩子）",
  system: true,
  userScoped: false,
  engines: { kernel: ">=1.96.1" },
  requires: ["capability"],
  permissions: ["getApi", "getSetting", "log", "SELF_DIR"],
  attribution: { source: "self-authored by Momo", license: "self-generated", note: "从 index.js auditReply 迁移而来（骨骼方案 S3），未借鉴外部源码" },
  init(ctx) { _ctx = ctx; },
  api: {
    audit: { auditReply },
  },
  apiSpec: {
    audit: {
      auditReply: { input: "text, usedTools[]", output: "{text, blocked, label?}", sideEffect: "可能写反思（拦下时）" },
    },
  },
  hooks: {
    before_send: (p) => {
      /* private=私聊回话；proactive=主动搭话（也是私聊发送）；group/pet 不在审计范围 */
      if (!p || (p.channel !== "private" && p.channel !== "proactive")) return;
      const r = auditReply(p.text, p.usedTools || [], p.outcomes || []);
      p.text = r.text;
    },
  },
};
