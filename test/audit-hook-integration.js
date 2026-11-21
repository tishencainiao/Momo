/* before_send 宿主级集成测试（Kimi 审查·阶段一回归）
 * 证明审计不是"单元测试直调通过"，而是 createHost → 插件注册 → runBeforeSend 真实链路生效。
 * 全部使用临时目录，不污染真实运行数据。 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { createHost } = require(path.join(__dirname, "..", "plugin-host.js"));

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "momo-audit-int-"));
let auditEnabled = true;

const core = {
  DATA_DIR,
  SELF_DIR: DATA_DIR,
  BASE_VERSION: "1.99.6",
  cfg: { qq: { master_user: 100000001 } },
  apiKey: "x",
  UA: "test",
  log: () => {},
  recordAction: () => {},
  resolveChatSettings: () => ({}),
  writeJsonAtomic: (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); },
  writeFileAtomic: (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); },
  getSetting: (k, d) => (k === "safety.audit.enabled" ? auditEnabled : d),
  recordAndSend: () => {},
  onebotSend: () => {},
  sendPrivate: () => {},
  sendGroup: () => {},
  sendStickerImage: () => {},
  loadMemories: () => [],
  saveMemories: () => {},
  loadShortMemories: () => [],
  saveShortMemories: () => {},
  loadSession: () => [],
  saveSession: () => {},
  isMaster: () => true,
  resolveCall: () => 100000001,
  userPersona: () => "",
  isBudgetExhausted: () => false,
  budgetLevel: () => 0,
  canAfford: () => true,
  getFavor: () => 100,
  moodLabel: () => "平静",
  proactive: {},
  getEmotion: () => ({}),
  getMood: () => 0,
  addMood: () => {},
  setMood: () => {},
  getLastSentSticker: () => null,
  stickerSessionKey: () => "",
  getBoredom: () => 0,
  addBoredom: () => {},
  loadBudget: () => ({}),
  budgetCfg: () => ({}),
  loadMindState: () => ({}),
  textSimilar: () => false,
  loadEvolution: () => ({}),
  reloadEvolution: () => {},
  pickStickerByIds: () => null,
  todayText: () => "",
  periodOfDay: () => "",
  nowHM: () => "0000",
  formatGap: () => "",
  dayStr: () => "",
  todayMMDD: () => "",
  parseMemoryJson: () => ({ updated: 0, items: [] }),
  completeOnce: async () => "",
  reasonComplete: async () => "",
  cleanText: (s) => s,
  sleep: () => Promise.resolve(),
  recordSpend: () => {},
  estimateTokens: () => 0,
  maybeCollect: () => {},
  qzoneHttp: async () => ({}),
  loadAppellations: () => ({}),
  saveAppellations: () => {},
  loadMute: () => ({}),
  addMute: () => {},
  removeMute: () => {},
  resolveTargetId: () => 0,
  loadWishes: () => [],
  addWish: () => {},
  AGENT_TOOLS: [],
};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log("✗ " + name + (extra ? " :: " + extra : "")); }
}

const host = createHost(core);
host.loadPlugins();

/* 1. 钩子真实注册进宿主列表 */
const nBefore = (host.hookLists.before_send || []).length;
check("audit-service 的 before_send 已注册进宿主", nBefore >= 1, "len=" + nBefore);

/* 2. 虚假能力承诺被拦截 */
const fake = "好呀，我这就唱首歌给你听！";
const p1 = { text: fake, channel: "private", usedTools: [] };
host.runBeforeSend(p1);
check("私聊虚假能力承诺被拦截改写", p1.text !== fake, "text=" + p1.text.slice(0, 40));

/* 3. 正常聊天文本不变 */
const normal = "今天天气不错呀，你在干嘛";
const p2 = { text: normal, channel: "private", usedTools: [] };
host.runBeforeSend(p2);
check("正常聊天文本不变", p2.text === normal, "text=" + p2.text);

/* 4. 群聊保持原行为 */
const p3 = { text: fake, channel: "group", usedTools: [] };
host.runBeforeSend(p3);
check("群聊渠道不被审计", p3.text === fake, "text=" + p3.text.slice(0, 40));

/* 4b. 主动搭话（proactive）也是私聊发送，应审计 */
const p3b = { text: fake, channel: "proactive", usedTools: [] };
host.runBeforeSend(p3b);
check("主动搭话渠道被审计", p3b.text !== fake, "text=" + p3b.text.slice(0, 40));

/* 5. safety.audit.enabled=false 时不拦截（settings 存 data/settings.json） */
fs.writeFileSync(path.join(DATA_DIR, "settings.json"), JSON.stringify({ "safety.audit.enabled": false }));
const p4 = { text: fake, channel: "private", usedTools: [] };
host.runBeforeSend(p4);
check("safety.audit.enabled=false 时不拦", p4.text === fake);
try { fs.unlinkSync(path.join(DATA_DIR, "settings.json")); } catch (e) {}

/* 6. 热重载不残留重复钩子 */
host.reloadPlugin("plugins/audit-service.js");
host.reloadPlugin("plugins/audit-service.js");
const nAfter = (host.hookLists.before_send || []).length;
check("热重载后钩子不重复（=1）", nAfter === 1, "len=" + nAfter);
const p5 = { text: fake, channel: "private", usedTools: [] };
host.runBeforeSend(p5);
check("热重载后审计仍生效", p5.text !== fake);

/* 7. 卸载后钩子移除（用 setPluginEnabled 会因 system 保护被拒——这里通过 reload 前卸载计数验证） */
/* system 插件禁用被 R1-3 护栏拒绝，属预期：直接断言 */
const refuse = host.setPluginEnabled("audit-service", false);
check("system 框架服务禁用被拒绝（R1-3 护栏）", refuse === false);
check("禁用拒绝后钩子仍在", (host.hookLists.before_send || []).length >= 1);

console.log(`audit-hook-integration: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
