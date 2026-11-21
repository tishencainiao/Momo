/* 框架服务 audit-service 测试（骨骼方案 S3 + WP3 作用域凭据） */
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
const p1 = { text: "好，我这就放给你听。", channel: "private", usedTools: [], userId: 77 };
mod.hooks.before_send(p1);
check("before_send 私聊改写文本", p1.text !== "好，我这就放给你听。");
const p2 = { text: "好，我这就放给你听。", channel: "group", usedTools: [], userId: 77 };
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

/* 阶段一 + WP3：动作自述 ↔ 行动凭据（按作用域）校验 */
const U_A = { userId: 77, channel: "private", groupId: 0 };
const U_B = { userId: 88, channel: "private", groupId: 0 };
const G77 = { userId: 77, channel: "group", groupId: 123 };
const ledgerActs = [];
mod.init({
  DATA_DIR: DIR, SELF_DIR: DIR, log: () => {},
  writeJsonAtomic: (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 0)); } catch (e) {} },
  getSetting: (k, d) => d,
  getApi: () => ({ limitTriggers: () => TRIGGERS, noteOverclaim: () => {} }),
  loadActions: () => ledgerActs,
});

const c0 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], U_A);
check("无凭据的「我刚查了」被附纠正", c0.blocked === false && c0.text.includes("先收回"), c0.text);
const c1 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", ["weather"], [], U_A);
check("usedTools 有 weather 但无成功凭据 → 附纠正（弱匹配不再放行）", c1.text.includes("先收回"), c1.text);
const c1c = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", ["weather"], [{ tool: "weather", status: "failed", userId: 77, channel: "private" }], U_A);
check("本轮 ToolOutcome failed → 不构成凭据，附纠正", c1c.text.includes("先收回"), c1c.text);
ledgerActs.length = 0;
ledgerActs.push({ action: "memory_edit", ts: Date.now() - 2 * 3600e3, status: "succeeded", userId: 77, channel: "private" });
const c3 = mod.api.audit.auditReply("我已经记好了，你喜欢吃火锅。", [], [], U_A);
check("行动流水过期（>1h）不算凭据", c3.text.includes("先收回"), c3.text);
ledgerActs.length = 0;
for (const st of ["failed", "unknown", "proposed", "cancelled"]) {
  ledgerActs.push({ action: "weather", ts: Date.now(), status: st, userId: 77, channel: "private" });
  const t5 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], U_A);
  check("流水 status=" + st + " 不构成凭据", t5.text.includes("先收回"), t5.text);
  ledgerActs.length = 0;
}

/* WP3 作用域九条 */
ledgerActs.length = 0;
ledgerActs.push({ action: "weather", ts: Date.now(), status: "succeeded", userId: 77, channel: "private" });
const t1 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], U_B);
check("A 的成功 action 不为 B 的自述背书 → 纠正", t1.text.includes("先收回"), t1.text);
const t2 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], U_A);
check("同用户+同上下文成功流水 → 放行", t2.text === "我刚帮你查了天气，20 度。", t2.text);
const t3 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], G77);
check("私聊流水不为群自述背书 → 纠正", t3.text.includes("先收回"), t3.text);
ledgerActs.length = 0;
ledgerActs.push({ action: "weather", ts: Date.now(), status: "succeeded", userId: 77, channel: "group", groupId: 123 });
const t3b = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], U_A);
check("群内流水不为私聊自述背书 → 纠正", t3b.text.includes("先收回"), t3b.text);
const tG = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], G77);
check("同群流水为群自述背书 → 放行", tG.text === "我刚帮你查了天气，20 度。", tG.text);
ledgerActs.length = 0;
ledgerActs.push({ action: "weather", ts: Date.now(), ok: true });
const t4 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], U_A);
check("无 userId 的旧格式 ok:true 不能背书具体用户 → 纠正", t4.text.includes("先收回"), t4.text);
/* A12：直发载荷漏 userId 时（scope.userId=0），旧无主行动不得背书 */
const t4b = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], { userId: 0, channel: "private", groupId: 0 });
check("A12 scope 缺 userId 时旧无主 ok:true 不得背书 → 纠正", t4b.text.includes("先收回"), t4b.text);
/* A13：status 优先——failed 即使 ok:true 也拒绝；只有无 status 的旧格式才认 ok:true */
ledgerActs.length = 0;
ledgerActs.push({ action: "weather", ts: Date.now(), status: "failed", ok: true, userId: 77, channel: "private" });
const t4c = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], U_A);
check("A13 {status:failed, ok:true} 不构成凭据 → 纠正", t4c.text.includes("先收回"), t4c.text);
ledgerActs.length = 0;
ledgerActs.push({ action: "weather", ts: Date.now(), ok: true, userId: 77, channel: "private" });
const t4d = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], U_A);
check("A13 无 status 旧格式 ok:true（同用户）→ 放行", t4d.text === "我刚帮你查了天气，20 度。", t4d.text);
ledgerActs.length = 0;
ledgerActs.push({ action: "weather", ts: Date.now(), status: "verified", ok: false, userId: 77, channel: "private" });
const t6 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], U_A);
check("verified 但 ok:false 不构成凭据 → 纠正", t6.text.includes("先收回"), t6.text);
ledgerActs.length = 0;
ledgerActs.push({ action: "weather", ts: Date.now(), status: "verified", ok: true, userId: 77, channel: "private" });
const t6b = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", [], [], U_A);
check("verified+ok:true 构成凭据 → 放行", t6b.text === "我刚帮你查了天气，20 度。", t6b.text);
ledgerActs.length = 0;
const t7 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", ["weather"], [{ tool: "weather", status: "succeeded", userId: 77, channel: "private" }], U_A);
check("只读 outcome succeeded（作用域匹配）→ 放行", t7.text === "我刚帮你查了天气，20 度。", t7.text);
const t10 = mod.api.audit.auditReply("我刚帮你查了天气，20 度。", ["weather"], [{ tool: "weather", status: "succeeded", userId: 88, channel: "private" }], U_A);
check("outcome 作用域不匹配（别的用户）→ 纠正", t10.text.includes("先收回"), t10.text);
const t8 = mod.api.audit.auditReply("我已经记好了，你喜欢吃火锅。", ["memory_edit"], [{ tool: "memory_edit", status: "succeeded", userId: 77, channel: "private" }], U_A);
check("副作用 outcome 无 action_key → 纠正", t8.text.includes("先收回"), t8.text);
/* A14：action_key 必须在行动流水中闭环（同 key+同作用域+成功状态），随机非空串不得放行 */
const t9x = mod.api.audit.auditReply("我已经记好了，你喜欢吃火锅。", ["memory_edit"], [{ tool: "memory_edit", status: "succeeded", userId: 77, channel: "private", action_key: "definitely-not-in-ledger" }], U_A);
check("A14 action_key 不在账本 → 纠正", t9x.text.includes("先收回"), t9x.text);
ledgerActs.length = 0;
ledgerActs.push({ action: "memory_edit", key: "ak-123", ts: Date.now(), status: "succeeded", userId: 77, channel: "private", groupId: 0 });
const t9 = mod.api.audit.auditReply("我已经记好了，你喜欢吃火锅。", ["memory_edit"], [{ tool: "memory_edit", status: "succeeded", userId: 77, channel: "private", action_key: "ak-123" }], U_A);
check("A14 action_key 在账本闭环（同 key+成功+作用域）→ 放行", t9.text === "我已经记好了，你喜欢吃火锅。", t9.text);
ledgerActs.length = 0;
ledgerActs.push({ action: "memory_edit", key: "ak-123", ts: Date.now(), status: "failed", userId: 77, channel: "private", groupId: 0 });
const t9b = mod.api.audit.auditReply("我已经记好了，你喜欢吃火锅。", ["memory_edit"], [{ tool: "memory_edit", status: "succeeded", userId: 77, channel: "private", action_key: "ak-123" }], U_A);
check("A14 同 key 但账本状态非成功 → 纠正", t9b.text.includes("先收回"), t9b.text);

console.log(pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
