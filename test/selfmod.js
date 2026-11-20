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
  writeJsonAtomic: (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 0)); } catch (e) {} },
  writeFileAtomic: (f, t) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); } catch (e) {} },
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
for (const k of ["/self提案", "/提案", "/批准self", "/拒绝self", "/回滚self"]) {
  check("有命令 " + k, cmds.some((c) => c.key === k));
}

// 8. 能力扫描不会误报（字符串里提到但没调用）
check("只是提到不算调用", A.scanCapabilities('// sendPrivate 是敏感能力').length === 0);

// 9. P1：五段人话 summary
const sm1 = A.summaryText({ summary: { "想干什么": "记住你爱吃火锅", "为什么": "你说过想我提醒", "影响": "只存文字" } });
check("summary 有人话四行", sm1.includes("想干什么：") && sm1.includes("为什么：") && sm1.includes("影响：") && !sm1.includes("怎么改："), sm1);
check("无 summary 回退空串", A.summaryText({ goal: "x" }) === "");

// 10. P1：/提案 细节（用前文已作废的 sm_old）
const det = A.proposalDetail("sm_old");
check("提案细节含插件名与状态", det.includes("插件名：self") && det.includes("已过期"), det.slice(0, 60));
check("提案细节查无此人", A.proposalDetail("nope").includes("没找到"));

// 11. P1：同源去重
check("nearDup 近义判重", A.nearDupSelf("帮我加个提醒功能", "帮我加一个提醒功能") === true);
check("nearDup 无关不误伤", A.nearDupSelf("帮我加个提醒功能", "今天天气怎么样") === false);

// 12. P1：过期主动清理
{
  // 直接往提案文件塞一条 30 小时前的 pending
  const propFile = path.join(SELF, "selfmod-proposals.json");
  let cur = [];
  try { cur = JSON.parse(fs.readFileSync(propFile, "utf8")); } catch (e) {}
  cur.push({ id: "sm_stale", ts: Date.now() - 30 * 3600e3, status: "pending", goal: "旧提案", name: "self-stale", code: "", caps: [], source: "auto" });
  fs.writeFileSync(propFile, JSON.stringify(cur));
  const changed = A.cleanExpiredProposals(Date.now() + 3600e3);
  const after2 = JSON.parse(fs.readFileSync(propFile, "utf8"));
  const st = after2.find((p) => p.id === "sm_stale");
  check("过期提案被清理为 expired", changed === true && st.status === "expired", String(st && st.status));
  // 节流：紧接着再跑不重复写
  check("清理有节流", A.cleanExpiredProposals(Date.now() + 7200e3) === false);
}

// 13. P2：提案带 summary 的详情优先显示五段人话
writeProposal({ id: "sm_sum", goal: "带说明的提案", name: "self-sum", summary: { "想干什么": "记住火锅", "为什么": "主人提过", "影响": "只存文字" } });
const det2 = A.proposalDetail("sm_sum");
check("详情优先显示五段", det2.includes("想干什么：记住火锅") && det2.includes("影响：只存文字"), det2.slice(0, 80));

// 14. P2：批量批准（空格分隔两个 id）
{
  const two = [
    { id: "sm_b1", ts: Date.now(), goal: "批量一", name: "self-batch1", code: codeSafe, caps: [], risk: "low", allow_send: false, status: "pending" },
    { id: "sm_b2", ts: Date.now(), goal: "批量二", name: "self-batch2", code: codeSafe, caps: [], risk: "low", allow_send: false, status: "pending" },
  ];
  fs.writeFileSync(propFile, JSON.stringify(two));
  const r = A.approveSelfMod("sm_b1 sm_b2");
  check("批量批准返回两行", r.includes("已批准") && r.trim().split("\n").length === 2, r.slice(0, 80));
  const after3 = JSON.parse(fs.readFileSync(propFile, "utf8"));
  check("批量后两个都 approved", after3.every((p) => p.status === "approved"), after3.map((p) => p.status).join(","));
}

// 15. P2：月度配额计数
check("本月提案计数 ≥1", A.proposalCountThisMonth() >= 1, String(A.proposalCountThisMonth()));

// 16. P2：失败记录落盘（doctor 护栏循环的数据源）
A.recordSelfFailure("self-broken", "测试目标", "测试原因");
{
  const ff = JSON.parse(fs.readFileSync(path.join(DATA, "selfmod-failures.json"), "utf8"));
  check("失败记录写入", Array.isArray(ff) && ff.some((x) => x.name === "self-broken"), JSON.stringify(ff).slice(0, 80));
}

// 17. P2：sunset 检查不崩（30 天没用过的 self-* 会提醒）
check("sunset 检查不崩", (A.checkSelfSunset(Date.now() + 25 * 3600e3), true));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { fs.rmSync(SELF, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
