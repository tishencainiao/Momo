#!/usr/bin/env node
/* 受限自改测试：能力扫描 / 审批流 / 拒绝 / 回滚 / 版本历史 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const SELF = path.join(os.tmpdir(), "momo-selfmod-test-" + Date.now());
const DATA = path.join(SELF, "data");
const PLUGINS = path.join(SELF, "plugins");
fs.mkdirSync(SELF, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(PLUGINS, { recursive: true });
fs.writeFileSync(path.join(SELF, "bridge.log"), "");

let killed = 0;
const plugin = require("E:/Learn/Momo/plugins/evolution.js");

// 直接测导出的函数（init 会触发 refreshEvolve，需要 SELF_DIR 可用）
plugin.init({
  SELF_DIR: SELF,
  DATA_DIR: DATA,
  BASE_VERSION: "test",
  log: () => {},
  config: { qq: { master_user: 1000 } },
  sendPrivate: async () => {},
  getSetting: (k, d) => d,
  settings: () => ({}),
  isBudgetExhausted: () => false,
  registry: { list: () => [] },
  getFavor: () => 50,
  resolveCall: (u) => String(u),
  isMaster: (u) => Number(u) === 1000,
  sendStickerImage: async () => {},
  petEvent: () => {},
  recordAndSend: async () => {},
  pickStickerByIds: () => null,
  loadMemories: () => [],
  saveMemories: () => {},
  loadSession: () => [],
  saveSession: () => {},
  completeOnce: async () => "",
  reasonComplete: async () => "",
  todayText: () => "11月1日",
  formatGap: () => "",
  dayStr: () => "2026-11-01",
  textSimilar: (a, b) => String(a) === String(b),
});

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

const A = plugin.api.evolution;

// 1. 能力扫描
const codeSend = `module.exports={name:"self-dice",version:"1.0.0",init(c){},tools:[],hooks:{timer(){ _ctx.sendPrivate(1,"hi"); }}};`;
const codeSafe = `module.exports={name:"self-dice",version:"1.0.0",init(c){},tools:[],hooks:{}};`;
check("扫到 sendPrivate", A.scanCapabilities(codeSend).includes("sendPrivate"));
check("安全代码扫不到", A.scanCapabilities(codeSafe).length === 0);
check("扫到 onebotSend", A.scanCapabilities('_ctx.onebotSend("send_msg",{})').includes("onebotSend"));

// 2. 提案字段
const propFile = path.join(SELF, "selfmod-proposals.json");
function writeProposal(over) {
  const p = Object.assign({ id: "sm_test1", ts: Date.now(), goal: "加个掷骰子", name: "self-dice", code: codeSafe, caps: [], allow_send: false, status: "pending" }, over || {});
  fs.writeFileSync(propFile, JSON.stringify([p]));
  return p;
}
writeProposal();
const list = A.listSelfMods();
check("列表能列出待批准提案", list.includes("sm_test1"), list.slice(0, 60));
check("列表含操作提示", list.includes("/批准self"));

// 3. 拒绝
const rj = A.rejectSelfMod("sm_test1");
check("拒绝返回成功文案", rj.includes("已拒绝"), rj);
const after = JSON.parse(fs.readFileSync(propFile, "utf8"));
check("拒绝后状态变了", after[0].status === "rejected", after[0].status);
check("拒绝后再拒绝会提示", A.rejectSelfMod("sm_test1").includes("已经处理过"));

// 4. 过期提案
writeProposal({ id: "sm_old", ts: Date.now() - 30 * 3600e3 });
check("超过 24 小时作废", A.approveSelfMod("sm_old").includes("已作废"));
check("不存在的提案", A.approveSelfMod("nope").includes("没找到"));

// 5. 回滚（只允许 self- 前缀）
fs.writeFileSync(path.join(PLUGINS, "self-dice.js"), codeSafe);
check("回滚要求 self- 前缀", A.rollbackSelf("index").includes("self- 开头"));
check("回滚不存在的插件", A.rollbackSelf("self-nope").includes("没找到"));
// 真的删（会尝试 taskkill，这里用不到）
const rb = A.rollbackSelf("self-dice");
check("回滚成功提示", rb.includes("已删除"), rb);
check("文件真被删了", !fs.existsSync(path.join(PLUGINS, "self-dice.js")));

// 6. 设置项
check("暴露审批开关", (plugin.settings || []).some((s) => s.key === "evolve.require_approval"));

// 7. 命令
const cmds = plugin.commands || [];
for (const k of ["/self提案", "/批准self", "/拒绝self", "/回滚self"]) {
  check("有命令 " + k, cmds.some((c) => c.key === k));
}

// 8. 能力扫描不会误报（字符串里提到但没调用）
check("只是提到不算调用", A.scanCapabilities('// sendPrivate 是敏感能力').length === 0);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { fs.rmSync(SELF, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
