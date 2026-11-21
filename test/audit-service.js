/* 框架服务 audit-service 测试（骨骼方案 S3） */
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}
const DIR = path.join(os.tmpdir(), "momo-audit-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

const TRIGGERS = [{ phrase: "放歌", id: "audio-play", label: "播放音乐/音频" }, { phrase: "放给你听", id: "audio-play", label: "播放音乐/音频" }];
const calls = { overclaim: [] };
const mod = require("../plugins/audit-service.js");
mod.init({
  DATA_DIR: DIR,
  SELF_DIR: DIR,
  log: () => {},
  writeJsonAtomic: (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 0)); } catch (e) {} },
  writeFileAtomic: (f, t) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); } catch (e) {} },
  getSetting: (k, d) => d,
  getApi: () => ({
    limitTriggers: () => TRIGGERS,
    noteOverclaim: (label, phrase) => calls.overclaim.push(label + "/" + phrase),
  }),
});
const a = mod.api.audit;

check("manifest system:true", mod.system === true);
check("manifest userScoped:false", mod.userScoped === false);

const r0 = a.auditReply("你先歇会儿吧。", []);
check("普通聊天放行", r0.blocked === false && r0.text === "你先歇会儿吧。");

const r1 = a.auditReply("好，我这就放给你听。", []);
check("编造「放给你听」被拦", r1.blocked === true && r1.text !== "好，我这就放给你听。", r1.text);
check("拦下时带回 label", r1.label === "播放音乐/音频");
check("noteOverclaim 被调用", calls.overclaim.length === 1);
check("写反思落盘", fs.existsSync(path.join(DIR, "reflections.json")));

const r2 = a.auditReply("好，我这就放给你听。", ["send_voice"]);
check("真有 send_voice 成功时放行", r2.blocked === false);

/* before_send 钩子 */
const p1 = { text: "好，我这就放给你听。", channel: "private", usedTools: [] };
mod.hooks.before_send(p1);
check("before_send 私聊改写文本", p1.text !== "好，我这就放给你听。");
const p2 = { text: "好，我这就放给你听。", channel: "group", usedTools: [] };
mod.hooks.before_send(p2);
check("before_send 群聊不动", p2.text === "好，我这就放给你听。");

/* 开关关掉 */
mod.init({
  DATA_DIR: DIR, SELF_DIR: DIR, log: () => {},
  getSetting: (k, d) => "false",
  getApi: () => ({ limitTriggers: () => TRIGGERS, noteOverclaim: () => {} }),
});
const r3 = mod.api.audit.auditReply("好，我这就放给你听。", []);
check("safety.audit.enabled=false 时不拦", r3.blocked === false);

/* 阶段一：动作自述 ↔ 行动凭据校验（Kimi 远期路线第一项） */
const ledgerActs = [];
mod.init({
  DATA_DIR: DIR, SELF_DIR: DIR, log: () => {},
  writeJsonAtomic: (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 0)); } catch (e) {} },
  getSetting: (k, d) => d,
  getApi: () => ({ limitTriggers: () => TRIGGERS, noteOverclaim: () => {} }),
  loadActions: () => ledgerActs,
});
const c0 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", []);
check("无凭据的「我刚查了」被附纠正", c0.blocked === false && c0.text.includes("先收回"), c0.text);
const c1 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", ["weather"]);
check("usedTools 有 weather 但无成功凭据 → 附纠正（弱匹配不再放行）", c1.text.includes("先收回"), c1.text);
const c1b = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", ["weather"], [{ tool: "weather", status: "succeeded" }]);
check("本轮 ToolOutcome succeeded → 中凭据放行", c1b.text === "我刚帮你查了天气，20 度。");
const c1c = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", ["weather"], [{ tool: "weather", status: "failed" }]);
check("本轮 ToolOutcome failed → 不构成凭据，附纠正", c1c.text.includes("先收回"), c1c.text);
ledgerActs.push({ action: "bing", ts: Date.now(), status: "succeeded" });
const c2 = mod.api.audit.auditReply("我刚帮你搜了一下。", []);
check("行动流水有 bing 时不动", c2.text === "我刚帮你搜了一下。");
ledgerActs.length = 0;
ledgerActs.push({ action: "memory_edit", ts: Date.now() - 2 * 3600e3 });
const c3 = mod.api.audit.auditReply("我已经记好了，你喜欢吃火锅。", []);
check("行动流水过期（>1h）不算凭据", c3.text.includes("先收回"), c3.text);
ledgerActs.length = 0;
ledgerActs.push({ action: "weather", ts: Date.now(), status: "proposed" });
const c4 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", []);
check("proposed 流水不算凭据（没做成不算做过）", c4.text.includes("先收回"), c4.text);
ledgerActs.length = 0;
ledgerActs.push({ action: "weather", ts: Date.now(), ok: true });
const c5 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", []);
check("旧格式 ok:true 流水仍算凭据", c5.text === "我刚帮你查了天气，20 度。");

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
