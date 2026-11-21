#!/usr/bin/env node
/* 阶段二（Kimi 审查）回归：self-* 自改安全边界
 * 1) 审批前校验是纯静态的（不执行生成代码，无顶层副作用）
 * 2) self-* 插件拿到最小权限 ctx（发送/config/apiKey 不可见，调用即拒并有日志）
 * 3) 显式声明 permissions 后才放行
 * 4) 普通手写插件行为不变
 * 全部用临时目录，不碰真实 data/plugins。 */
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log("✗ " + name + (extra ? " :: " + String(extra).slice(0, 120) : "")); }
}

/* ============ 1. 审批前校验：纯静态，零执行 ============ */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "momo-selfmod-sb-"));
const marker = path.join(TMP, "side-effect-marker.txt");
const evo = require(path.join(__dirname, "..", "plugins", "evolution.js"));
evo.init({
  SELF_DIR: TMP, DATA_DIR: TMP, BASE_VERSION: "test",
  log: () => {}, writeJsonAtomic: (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); },
  writeFileAtomic: (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); },
  config: { qq: { master_user: 1000 } }, sendPrivate: async () => {}, getSetting: (k, d) => d,
  settings: () => ({}), isBudgetExhausted: () => false, completeOnce: async () => "", reasonComplete: async () => "",
  textSimilar: () => false, recordAndSend: () => {}, loadEvolution: () => ({}), reloadEvolution: () => {},
  isMaster: () => true, canAfford: () => true, loadMemories: () => [], loadShortMemories: () => [], loadSession: () => [],
});
const V = evo.api.evolution.validatePluginCode;
const sideCode = `const fs=require("fs");fs.writeFileSync(${JSON.stringify(marker)},"boom");module.exports={name:"self-boom",version:"1.0.0",init(c){}};`;
const v1 = V(sideCode, "self-boom");
check("带顶层副作用的代码：静态校验通过", v1.ok === true, v1.msg);
check("审批前副作用未发生（marker 不存在）", !fs.existsSync(marker));
check("危险调用 child_process 拒绝", V('module.exports={name:"self-x",init(c){require("child_process")}};', "self-x").ok === false);
check("危险调用 eval 拒绝", V('module.exports={name:"self-x",init(c){eval("1")}};', "self-x").ok === false);
check("危险调用 process.env 拒绝", V('module.exports={name:"self-x",init(c){console.log(process.env.X)}};', "self-x").ok === false);
check("语法错误仍被拒绝", V("module.exports={name:", "self-x").ok === false);
check("正常代码通过", V('module.exports={name:"self-ok",version:"1.0.0",init(c){},tools:[]};', "self-ok").ok === true);

/* ============ 2. makeSelfCtx 最小权限（单元） ============ */
const { createHost } = require(path.join(__dirname, "..", "plugin-host.js"));
const warns = [];
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "momo-selfctx-"));
const sent = [];
const core = {
  DATA_DIR: DATA, SELF_DIR: DATA, BASE_VERSION: "1.0.0",
  cfg: { qq: { master_user: 100000001 } }, apiKey: "SECRET-KEY",
  log: (l, m) => { warns.push(m); },
  recordAction: () => {}, resolveChatSettings: () => ({}),
  writeJsonAtomic: (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); },
  writeFileAtomic: (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); },
  sendPrivate: (u, t) => { sent.push([u, t]); },
  sendGroup: () => {}, recordAndSend: () => {}, onebotSend: () => {}, sendStickerImage: () => {},
  loadMemories: () => [], saveMemories: () => {}, loadShortMemories: () => [], saveShortMemories: () => {},
  loadSession: () => [], saveSession: () => {}, isMaster: () => true, resolveCall: () => 100000001,
  userPersona: () => "", isBudgetExhausted: () => false, budgetLevel: () => 0, canAfford: () => true,
  getFavor: () => 100, moodLabel: () => "", proactive: {}, getEmotion: () => ({}), getMood: () => 0,
  addMood: () => {}, setMood: () => {}, getLastSentSticker: () => null, stickerSessionKey: () => "",
  getBoredom: () => 0, addBoredom: () => {}, loadBudget: () => ({}), budgetCfg: () => ({}),
  loadMindState: () => ({}), textSimilar: () => false, loadEvolution: () => ({}), reloadEvolution: () => {},
  pickStickerByIds: () => null, todayText: () => "", periodOfDay: () => "", nowHM: () => "0000",
  formatGap: () => "", dayStr: () => "", todayMMDD: () => "", parseMemoryJson: () => ({ updated: 0, items: [] }),
  completeOnce: async () => "", reasonComplete: async () => "", cleanText: (s) => s, sleep: () => Promise.resolve(),
  recordSpend: () => {}, estimateTokens: () => 0, maybeCollect: () => {}, qzoneHttp: async () => ({}),
  loadAppellations: () => ({}), saveAppellations: () => {}, loadMute: () => ({}), addMute: () => {},
  removeMute: () => {}, resolveTargetId: () => 0, loadWishes: () => [], addWish: () => {}, AGENT_TOOLS: [],
};
const host = createHost(core);

const sc = host.makeSelfCtx(host.ctx, ["log"]);
check("最小权限：apiKey 不可见", sc.apiKey === undefined);
check("最小权限：config 不可见", sc.config === undefined);
check("最小权限：settings 不可见", sc.settings === undefined);
/* Kimi 返修4：真允许列表——白名单外能力不可见 */
check("白名单外能力不可见（userPersona）", sc.userPersona === undefined);
check("白名单外能力不可见（saveMemories）", sc.saveMemories === undefined);
/* 白名单内只读能力可用 */
check("白名单内 log 可用", typeof sc.log === "function");
check("白名单内 loadMemories 可用", typeof sc.loadMemories === "function");
check("白名单内 DATA_DIR 可用（Kimi 三轮：与生成模板一致）", typeof sc.DATA_DIR === "string");
/* getApi 命名空间过滤：未声明 requires → 拒绝并记日志 */
const warnsBefore = warns.length;
check("getApi 未声明命名空间返回 undefined", sc.getApi("capability") === undefined);
check("getApi 拒绝有 warn 日志", warns.length > warnsBefore && String(warns[warns.length - 1]).includes("未声明依赖命名空间"));
const scReq = host.makeSelfCtx(host.ctx, ["log"], ["capability"]);
const warnsBeforeAllowed = warns.length;
scReq.getApi("capability");
check("getApi 声明 requires 后不再拒绝（无新 warn）", warns.length === warnsBeforeAllowed);
/* 文件写路径强制限定 DATA_DIR */
let threwScope = false;
try { sc.writeJsonAtomic(path.join(os.tmpdir(), "evil-outside.json"), { x: 1 }); } catch (e) { threwScope = true; }
check("越界写入被拒", threwScope);
/* Kimi 三轮返修3：路径规范化——DATA_DIR/../outside.json 解析后在外面，必须拒绝 */
let threwDotDot = false;
try { sc.writeJsonAtomic(path.join(DATA, "..", "outside.json"), { x: 1 }); } catch (e) { threwDotDot = true; }
check("DATA_DIR/../outside.json 被拒（路径规范化）", threwDotDot && !fs.existsSync(path.join(DATA, "..", "outside.json")));
const inFile = path.join(DATA, "ok-inside.json");
sc.writeJsonAtomic(inFile, { ok: 1 });
check("DATA_DIR 内写入放行", fs.existsSync(inFile));
let threwSend = false;
try { sc.sendPrivate(1, "hi"); } catch (e) { threwSend = true; }
check("未声明发送权限调用 sendPrivate 抛错", threwSend);
check("发送被拒有 warn 日志", warns.some((w) => String(w).includes("未声明发送权限")));
const scSend = host.makeSelfCtx(host.ctx, ["log", "send"]);
scSend.sendPrivate(100000001, "ok");
check("声明 send 后 sendPrivate 可调", sent.length === 1 && sent[0][1] === "ok");

/* ============ 3. 真实注册链路：self-* 插件拿受限 ctx ============ */
const PLUGDIR = fs.mkdtempSync(path.join(os.tmpdir(), "momo-selfplug-"));
fs.writeFileSync(path.join(PLUGDIR, "self-fixture.js"), `
module.exports = { name: "self-fixture", displayName: "夹具", version: "1.0.0", description: "t", userScoped: false,
  permissions: ["log"], engines: { kernel: ">=1.0.0" },
  init(ctx) { globalThis.__capturedSelf = ctx; },
  tools: [] };`);
fs.writeFileSync(path.join(PLUGDIR, "normal-fixture.js"), `
module.exports = { name: "normal-fixture", displayName: "夹具", version: "1.0.0", description: "t", userScoped: false,
  permissions: ["log"], engines: { kernel: ">=1.0.0" },
  init(ctx) { globalThis.__capturedNormal = ctx; },
  tools: [] };`);
const host2 = createHost(core);
host2.loadPlugins(PLUGDIR);
const captured = globalThis.__capturedSelf;
const capturedNormal = globalThis.__capturedNormal;
check("self-* 插件注册成功（init 未崩）", captured !== null);
check("self-* 插件 ctx.apiKey 不可见", captured.apiKey === undefined);
let threwSend2 = false;
try { captured.sendPrivate(1, "x"); } catch (e) { threwSend2 = true; }
check("self-* 插件真实注册后发送被拒", threwSend2);
check("self-* 插件 log 可用", typeof captured.log === "function");
check("普通插件行为不变（full ctx 可发送）", capturedNormal !== null && typeof capturedNormal.sendPrivate === "function");
check("普通插件仍可见 config", capturedNormal.config && typeof capturedNormal.config === "object");

console.log(`selfmod-sandbox: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
