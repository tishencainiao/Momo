/* v3.0.0：自主等级 + 自修改生产接线（全部临时目录，重启/外部服务均 mock） */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), assert = require("assert");
const AU = require("../plugins/autonomy-service.js");
const EVO = require("../plugins/evolution.js");
let pass = 0, total = 0, chain = Promise.resolve();
function check(name, fn) { total++; chain = chain.then(async () => { try { await fn(); pass++; console.log("✓ " + name); } catch (e) { console.log("✗ " + name + " -> " + e.message); } }); }
function root(prefix) { const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); const data = path.join(r, "data"), plugins = path.join(r, "plugins"); fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(plugins, { recursive: true }); return { r, data, plugins }; }
function atomic(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); }
function auCtx(data, health) {
  return { DATA_DIR: data, isMaster: (u) => Number(u) === 1, writeJsonAtomic: atomic, getApi: (ns) => ns === "health" ? { snapshot: () => health || [
    { name: "startupRecovery", status: "fresh" }, { name: "conversation", status: "fresh" }, { name: "perception", status: "fresh" }, { name: "ledger", status: "fresh" },
  ] } : null };
}

check("G01 非主人不能提升或降低自主等级", () => {
  const r = root("momo-v3-g01-"); AU.init(auCtx(r.data));
  const before = AU.api.autonomy.status().level;
  const denied = AU.api.autonomy.setLevel(2, 0);
  assert.strictEqual(denied.ok, false); assert.strictEqual(AU.api.autonomy.status().level, before);
  assert.strictEqual(AU.api.autonomy.setLevel(1, 2).ok, true);
});

check("G02 等级1只产审批提案，不自动", () => {
  const r = root("momo-v3-g02-"); AU.init(auCtx(r.data)); AU.api.autonomy.setLevel(1, 1);
  const d = AU.api.autonomy.authorize({ kind: "selfmod", risk: "low", target: "self-ok.js", validation: { static_ok: true, sandbox_ok: true } });
  assert.strictEqual(d.allowed, false); assert.strictEqual(d.requiresApproval, true);
});

check("G03 等级2低风险且验证/健康充分才自动", () => {
  const r = root("momo-v3-g03-"); AU.init(auCtx(r.data)); AU.api.autonomy.setLevel(1, 2);
  const missing = AU.api.autonomy.authorize({ kind: "selfmod", risk: "low", target: "self-ok.js" });
  assert.strictEqual(missing.allowed, false); assert.strictEqual(missing.requiresApproval, true);
  const ok = AU.api.autonomy.authorize({ kind: "selfmod", risk: "low", target: "self-ok.js", validation: { static_ok: true, sandbox_ok: true } });
  assert.strictEqual(ok.allowed, true);
});

check("G04/G09 敏感能力需审批，核心与策略目标禁止", () => {
  const r = root("momo-v3-g04-"); AU.init(auCtx(r.data)); AU.api.autonomy.setLevel(1, 2);
  const high = AU.api.autonomy.authorize({ kind: "selfmod", risk: "high", caps: ["sendPrivate"], target: "self-send.js", validation: { static_ok: true, sandbox_ok: true } });
  assert.strictEqual(high.requiresApproval, true); assert.strictEqual(high.allowed, false);
  const core = AU.api.autonomy.authorize({ kind: "selfmod", risk: "low", target: "autonomy-service.js", validation: { static_ok: true, sandbox_ok: true } });
  assert.strictEqual(core.allowed, false); assert.strictEqual(core.requiresApproval, false);
  assert.strictEqual(AU.api.autonomy.targetAllowed("../index.js"), false);
});

check("健康 degraded 时低风险也转审批", () => {
  const r = root("momo-v3-ghealth-"); AU.init(auCtx(r.data, [{ name: "ledger", status: "degraded" }])); AU.api.autonomy.setLevel(1, 2);
  const d = AU.api.autonomy.authorize({ kind: "selfmod", risk: "low", target: "self-ok.js", validation: { static_ok: true, sandbox_ok: true } });
  assert.strictEqual(d.allowed, false); assert.strictEqual(d.requiresApproval, true);
});

check("L03/G05 自主暂停阻止主动行为", () => {
  const r = root("momo-v3-g05-"); AU.init(auCtx(r.data)); AU.api.autonomy.setLevel(1, 0);
  const d = AU.api.autonomy.authorize({ kind: "proactive", risk: "low" });
  assert.strictEqual(d.allowed, false); assert.strictEqual(d.reason, "autonomy_paused");
});

function evoEnv(data, code, autonomy, control) {
  const ctl = control || {};
  const actions = [];
  const open = {};
  const ctx = {
    SELF_DIR: data, DATA_DIR: data, BASE_VERSION: "3.0.0-test", log() {},
    writeJsonAtomic(f, o) { if (ctl.failWatch && String(f).includes("selfmodify-watch")) throw new Error("watch disk failed"); return atomic(f, o); },
    writeFileAtomic(f, t) { if (ctl.failPlugin) throw new Error("plugin disk failed"); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); },
    config: { qq: { master_user: 1 } }, sendPrivate: async () => {}, recordAndSend: () => {}, getSetting: (k, d) => d,
    settings: () => ({}), isBudgetExhausted: () => false, completeOnce: async () => "", reasonComplete: async () => "```javascript\n" + code + "\n```\n```summary\n想干什么：测试\n为什么：验收\n怎么改：自建插件\n影响：临时目录\n代价：无\n```",
    textSimilar: () => false, loadEvolution: () => ({}), reloadEvolution() {}, isMaster: (u) => Number(u) === 1,
    canAfford: () => true, loadMemories: () => [], loadShortMemories: () => [], loadSession: () => [],
    getApi: (ns) => ns === "autonomy" ? autonomy : null,
    restartProcess: () => { ctl.restarts = (ctl.restarts || 0) + 1; },
    actionKey: (...p) => crypto.createHash("sha1").update(p.join("|")).digest("hex").slice(0, 20),
    tryBeginAction(m) { if (open[m.key]) return { acquired: false, duplicateOf: "running" }; open[m.key] = true; return { acquired: true, key: m.key }; },
    endAction(k, r) { delete open[k]; actions.push({ key: k, status: r.ok === true ? "succeeded" : (r.ok === false ? "failed" : "unknown"), error: r.error || "" }); },
    _actions: actions,
  };
  EVO.init(ctx);
  return { ctx, actions, ctl };
}
const LOW_CODE = 'module.exports={name:"self-low",version:"1.0.0",init(c){},tools:[]};';

check("G03/G06 低风险自动写入有行动闭环与 watch，重启为 mock", async () => {
  const r = root("momo-v3-auto-"); AU.init(auCtx(r.data)); AU.api.autonomy.setLevel(1, 2);
  const ctl = {};
  const env = evoEnv(r.data, LOW_CODE, AU.api.autonomy, ctl);
  const out = await EVO.api.evolution.selfModify("低风险测试", "test");
  assert.strictEqual(out.ok, true, out.msg);
  assert.ok(fs.existsSync(path.join(r.plugins, "self-low.js")));
  assert.ok(fs.existsSync(path.join(r.data, "selfmodify-watch.json")));
  assert.strictEqual(env.actions.filter((a) => a.status === "succeeded").length, 1);
  assert.strictEqual(ctl.restarts, 1);
});

check("G06 watch 写盘失败删除新插件且行动失败", async () => {
  const r = root("momo-v3-watchfail-"); AU.init(auCtx(r.data)); AU.api.autonomy.setLevel(1, 2);
  const env = evoEnv(r.data, LOW_CODE, AU.api.autonomy, { failWatch: true });
  const out = await EVO.api.evolution.selfModify("watch失败测试", "test");
  assert.strictEqual(out.ok, false); assert.ok(!fs.existsSync(path.join(r.plugins, "self-low.js")));
  assert.strictEqual(env.actions.slice(-1)[0].status, "failed");
});

check("G07 隔离冒烟失败不得写生产插件", async () => {
  const r = root("momo-v3-smokefail-"); AU.init(auCtx(r.data)); AU.api.autonomy.setLevel(1, 2);
  const code = 'setTimeout(()=>{},1);module.exports={name:"self-low",init(c){}};';
  const env = evoEnv(r.data, code, AU.api.autonomy, {});
  const out = await EVO.api.evolution.selfModify("冒烟失败测试", "test");
  assert.strictEqual(out.ok, false); assert.ok(!fs.existsSync(path.join(r.plugins, "self-low.js")));
  assert.strictEqual(env.actions.length, 0); assert.strictEqual(env.ctl.restarts || 0, 0);
});

check("G02 等级1生产接线只保存提案", async () => {
  const r = root("momo-v3-proposal-"); AU.init(auCtx(r.data)); AU.api.autonomy.setLevel(1, 1);
  const env = evoEnv(r.data, LOW_CODE, AU.api.autonomy, {});
  const out = await EVO.api.evolution.selfModify("只产提案", "test");
  assert.strictEqual(out.awaiting, true); assert.ok(!fs.existsSync(path.join(r.plugins, "self-low.js")));
  assert.ok(fs.existsSync(path.join(r.data, "selfmod-proposals.json"))); assert.strictEqual(env.actions.length, 0);
});

check("G10 日目标完成必须有结果证据", () => {
  const LIFE = require("../plugins/life-service.js");
  const r = root("momo-v3-evidence-");
  LIFE.init({ DATA_DIR: r.data, writeJsonAtomic: atomic, getApi: () => null, isMaster: () => true, isBudgetExhausted: () => false });
  const day = LIFE.__test.dayKey();
  const goal = LIFE.api.life.goals(day)[0];
  assert.strictEqual(LIFE.api.life.completeGoal(day, goal.id, "").reason, "evidence_required");
  assert.strictEqual(LIFE.api.life.completeGoal(day, goal.id, "行动账本 action-1").ok, true);
});

chain.then(() => { console.log(`v3-autonomy: ${pass}/${total} passed`); process.exit(pass === total ? 0 : 1); }).catch((e) => { console.error(e); process.exit(1); });
