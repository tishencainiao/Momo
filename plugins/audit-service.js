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
    fs.writeFileSync(p, JSON.stringify(arr));
  } catch (e) {}
}

function auditReply(text, usedTools) {
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
    if (!res.blocked) return { text: src, blocked: false };
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
      if (!p || p.channel !== "private") return;
      const r = auditReply(p.text, p.usedTools || []);
      p.text = r.text;
    },
  },
};
