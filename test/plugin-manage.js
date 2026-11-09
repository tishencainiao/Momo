/* test/plugin-manage.js —— 插件启用/禁用管理（P3：data/plugins.json 持久化 + 运行时启停） */
const assert = require("assert");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { createHost } = require(path.join(__dirname, "..", "plugin-host.js"));

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "momoplugin-"));
const core = {
  DATA_DIR,
  SELF_DIR: DATA_DIR,
  BASE_VERSION: "1.0.0",
  cfg: { qq: { master_user: 100000001 } },
  apiKey: "x",
  UA: "test",
  log: () => {},
  recordAction: () => {},
  resolveChatSettings: () => ({}),
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
  bochaKey: () => "",
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

const host = createHost(core);
host.loadPlugins();

let n = 0;
function check(name, fn) { fn(); n++; console.log("✓ " + name); }

const pluginsFile = path.join(DATA_DIR, "plugins.json");
const byName = (nm) => host.ctx.registry.list().find((p) => p.name === nm);

check("加载后全部插件启用（42 个）", () => {
  const list = host.ctx.registry.list();
  assert.ok(list.length >= 40, `插件数 ${list.length} 应 >=40`);
  assert.ok(list.every((p) => p.enabled === true), "初始应全部 enabled=true");
});

check("listAllPlugins 含 name/version/enabled/displayName", () => {
  const w = byName("weather");
  assert.ok(w, "weather 应存在");
  assert.strictEqual(w.enabled, true);
  assert.ok(typeof w.displayName === "string");
  assert.ok(w.version);
});

check("禁用 weather → 状态翻转为 enabled=false", () => {
  host.setPluginEnabled("weather", false);
  const w = byName("weather");
  assert.strictEqual(w.enabled, false, "禁用后 enabled 应为 false");
  assert.ok(host.pluginState().disabled.includes("weather"));
});

check("禁用后落盘 data/plugins.json", () => {
  const d = JSON.parse(fs.readFileSync(pluginsFile, "utf8"));
  assert.ok(Array.isArray(d.disabled) && d.disabled.includes("weather"));
});

check("registry.pluginState 反映禁用集", () => {
  assert.deepStrictEqual(host.ctx.registry.pluginState(), { disabled: ["weather"] });
});

check("重新启用 weather → 恢复 enabled=true", () => {
  host.setPluginEnabled("weather", true);
  const w = byName("weather");
  assert.strictEqual(w.enabled, true);
  assert.ok(!host.pluginState().disabled.includes("weather"));
});

check("未知名插件启用返回 true 但不崩溃", () => {
  const r = host.setPluginEnabled("no-such-plugin", false);
  assert.strictEqual(r, true);
});

/* 清理：删临时 data 目录（避免残留） */
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}

console.log(`\n✓ 全部 ${n} 个断言通过`);
process.exit(0);
