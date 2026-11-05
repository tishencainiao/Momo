/* Momo 插件宿主：加载 plugins/*.js，提供 ctx、钩子分发、agent 工具/命令注册表
 * 三层架构：基础层（内核 index.js：路由/agent/数据/预算/调度）→ 功能层（plugins/*.js）→ 进化层（evolution.js 特权插件）
 */
const fs = require("fs");
const path = require("path");

function createHost(core) {
  const plugins = [];
  const toolRegistry = new Map();      // toolName -> { def, handler }
  const commandRegistry = new Map();   // key -> { regex, handler }
  const apis = new Map();              // 插件导出的能力（供内核/其他插件调用）
  const hookLists = { startup: [], timer: [], private_message: [], group_message: [], reply: [] };
  const contextProviders = [];         // () => [{role,content}] 注入核心上下文

  /* 可配置参数（settings registry）：插件声明 settings，Momo 可查询/修改
   * 存储 data/settings.json，键形如 "weather.city" */
  const SETTINGS_FILE = path.join(core.DATA_DIR, "settings.json");
  function loadSettingsMap() { try { const d = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); return (d && typeof d === "object") ? d : {}; } catch (e) { return {}; } }
  function saveSettingsMap(d) { try { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(d)); return true; } catch (e) { return false; } }
  function getSetting(key, def) { const d = loadSettingsMap(); return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : def; }
  function setSetting(key, val) { const d = loadSettingsMap(); d[key] = val; return saveSettingsMap(d); }
  function listSettings() {
    const out = [];
    for (const m of plugins) {
      for (const s of (m.settings || [])) {
        if (s && s.key) out.push(Object.assign({}, s, { plugin: m.name, value: getSetting(s.key, s.default) }));
      }
    }
    return out;
  }

  const ctx = {
    log: (l, m) => core.log(l, m),
    get config() { return core.cfg; },
    get apiKey() { return core.apiKey; },
    settings: () => core.resolveChatSettings(),
    getApi: (name) => apis.get(name),
    getSetting: (k, d) => getSetting(k, d),
    setSetting: (k, v) => setSetting(k, v),
    recordAction: (e) => core.recordAction(e),
    loadActions: (n) => core.loadActions(n),
    getUserStatus: (u) => core.getCurrentStatus(u),
    isUserQuiet: (u) => core.userQuietState(u),
    markProbed: (u) => core.markProbed(u),
    getActivity: () => core.loadActivityState(),
    sendPrivate: (u, t) => core.sendPrivate(u, t),
    sendGroup: (g, t) => core.onebotSend("send_msg", { message_type: "group", group_id: Number(g), message: [{ type: "text", data: { text: String(t) } }] }),
    recordAndSend: (u, t) => core.recordAndSend(u, t),
    onebotSend: (a, p) => core.onebotSend(a, p),
    sendStickerImage: (u, s) => core.sendStickerImage(u, s),
    petEvent: (s) => core.petEvent(s),
    loadMemories: (u) => core.loadMemories(u),
    saveMemories: (u, i) => core.saveMemories(u, i),
    loadShortMemories: (u) => core.loadShortMemories(u),
    saveShortMemories: (u, i) => core.saveShortMemories(u, i),
    loadSession: (u) => core.loadSession(u),
    saveSession: (u, m) => core.saveSession(u, m),
    isMaster: (u) => core.isMaster(u),
    resolveCall: (u) => core.resolveCall(u),
    userPersona: (u, s) => core.userPersona(u, s),
    isBudgetExhausted: () => core.isBudgetExhausted(),
    budgetLevel: () => core.budgetLevel(),
    canAfford: (t) => core.canAfford(t),
    getFavor: (u) => core.getFavor(u),
    moodLabel: () => core.moodLabel(),
    proactive: core.proactive,
    getEmotion: () => core.getEmotion(),
    getMood: () => core.getMood(),
    addMood: (d) => core.addMood(d),
    setMood: (v) => core.setMood(v),
    getLastSentSticker: (k) => core.getLastSentSticker(k),
    stickerSessionKey: (u, g) => core.stickerSessionKey(u, g),
    getBoredom: () => core.getBoredom(),
    loadBudget: () => core.loadBudget(),
    budgetCfg: () => core.budgetCfg(),
    loadMindState: () => core.loadMindState(),
    textSimilar: (a, b) => core.textSimilar(a, b),
    loadEvolution: () => core.loadEvolution(),
    reloadEvolution: () => core.reloadEvolution(),
    pickStickerByIds: (ids) => core.pickStickerByIds(ids),
    SELF_DIR: core.SELF_DIR,
    BASE_VERSION: core.BASE_VERSION,
    todayText: () => core.todayText(),
    periodOfDay: () => core.periodOfDay(),
    nowHM: () => core.nowHM(),
    formatGap: (ms) => core.formatGap(ms),
    dayStr: (off) => core.dayStr(off),
    todayMMDD: () => core.todayMMDD(),
    parseMemoryJson: (raw) => core.parseMemoryJson(raw),
    completeOnce: (m, s, t, tmp, opts) => core.completeOnce(m, s, t, tmp, opts),
    reasonComplete: (m, s, t, opts) => core.reasonComplete(m, s, t, opts),
    mimeOf: (buf) => core.mimeOf(buf),
    qzoneHttp: (a, p) => core.qzoneHttp(a, p),
    bochaSearch: (q, n, k) => core.bochaSearch(q, n, k),
    bochaKey: () => core.bochaKey(),
    formatResults: (q, rs) => core.formatResults(q, rs),
    // 数据层（基础层）服务：内核保存状态，插件只管逻辑
    loadAppellations: () => core.loadAppellations(),
    saveAppellations: (a) => core.saveAppellations(a),
    loadMute: () => core.loadMute(),
    addMute: (u, n) => core.addMute(u, n),
    removeMute: (u) => core.removeMute(u),
    resolveTargetId: (n) => core.resolveTargetId(n),
    loadWishes: () => core.loadWishes(),
    addWish: (t, s) => core.addWish(t, s),
    get DATA_DIR() { return core.DATA_DIR; },
    registry: {
      list: () => plugins.map((p) => ({ name: p.name, version: p.version || "1.0.0", enabled: p.enabled !== false, file: p._file })),
      tools: () => Array.from(toolRegistry.keys()),
      commands: () => Array.from(commandRegistry.keys()),
      settings: () => listSettings(),
      apis: () => Array.from(apis.keys()),
    },
  };

  function runHook(kind, payload) {
    for (const fn of hookLists[kind] || []) {
      try {
        /* 与 docs/development.md 一致：钩子签名是 xxx(payload)；插件需要 ctx 用模块内 _ctx */
        const r = fn(payload || {});
        if (r && typeof r.then === "function") r.catch((e) => core.log("warn", `插件钩子 ${kind} 失败: ${e.message.slice(0, 120)}`));
      } catch (e) { core.log("warn", `插件钩子 ${kind} 失败: ${e.message.slice(0, 120)}`); }
    }
  }

  const pluginRecords = new Map();   // file -> { mod, tools:[], commands:[], hooks:{}, ctxProviders:[], apis:[] }

  /* 卸载一个插件：把它注册过的工具/命令/钩子/上下文/能力全部摘掉 */
  function unregisterPlugin(file) {
    const rec = pluginRecords.get(file);
    if (!rec) return false;
    for (const t of rec.tools) toolRegistry.delete(t);
    for (const c of rec.commands) commandRegistry.delete(c);
    for (const k of Object.keys(rec.hooks)) {
      const i = hookLists[k].indexOf(rec.hooks[k]);
      if (i >= 0) hookLists[k].splice(i, 1);
    }
    for (const cp of rec.ctxProviders) {
      const i = contextProviders.indexOf(cp);
      if (i >= 0) contextProviders.splice(i, 1);
    }
    for (const a of rec.apis) apis.delete(a);
    const pi = plugins.indexOf(rec.mod);
    if (pi >= 0) plugins.splice(pi, 1);
    pluginRecords.delete(file);
    return true;
  }

  /* 注册一个插件，并记录它注册了什么（供卸载/热重载） */
  function registerPlugin(mod, file) {
    if (!mod || !mod.name) { core.log("warn", `插件 ${file} 缺少 name，跳过`); return null; }
    if (mod.enabled === false) { core.log("info", `插件已禁用: ${mod.name}`); return null; }
    mod._file = file;
    const rec = { mod, tools: [], commands: [], hooks: {}, ctxProviders: [], apis: [] };
    plugins.push(mod);
    for (const t of (mod.tools || [])) {
      if (t && t.def && t.def.function && t.def.function.name) { toolRegistry.set(t.def.function.name, t); rec.tools.push(t.def.function.name); }
    }
    for (const c of (mod.commands || [])) {
      if (c && c.key && c.regex) { commandRegistry.set(c.key, c); rec.commands.push(c.key); }
    }
    for (const k of ["startup", "timer", "private_message", "group_message", "reply"]) {
      if (mod.hooks && typeof mod.hooks[k] === "function") {
        const fn = mod.hooks[k].bind(mod);
        hookLists[k].push(fn);
        rec.hooks[k] = fn;
      }
    }
    if (typeof mod.contextProvider === "function") {
      const cp = mod.contextProvider.bind(mod);
      contextProviders.push(cp);
      rec.ctxProviders.push(cp);
    }
    if (mod.api) for (const [k, v] of Object.entries(mod.api)) { apis.set(k, v); rec.apis.push(k); }
    if (typeof mod.init === "function") { try { mod.init(ctx); } catch (e) { core.log("warn", `插件 ${mod.name} init 失败: ${e.message.slice(0, 120)}`); } }
    pluginRecords.set(file, rec);
    return mod;
  }

  /* 插件声明的 requires 能力是否齐全（缺了就在启动时报错，而不是运行时 undefined） */
  function checkRequires() {
    let bad = 0;
    for (const [, rec] of pluginRecords) {
      const req = rec.mod.requires;
      if (!Array.isArray(req) || !req.length) continue;
      const missing = req.filter((k) => !apis.has(k));
      if (missing.length) { bad++; core.log("error", `插件 ${rec.mod.name} 缺少依赖能力: ${missing.join(", ")}（对应插件未加载或能力名写错）`); }
    }
    if (!bad) core.log("info", "插件依赖检查通过");
    return bad;
  }

  function loadPlugins() {
    const dir = path.join(__dirname, "plugins");
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((x) => x.endsWith(".js") && !x.startsWith("_")).sort();
    for (const f of files) {
      try {
        const mod = require(path.join(dir, f));
        if (registerPlugin(mod, f)) core.log("info", `插件已加载: ${mod.name} v${mod.version || "1.0.0"}`);
      } catch (e) { core.log("warn", `插件加载失败 ${f}: ${e.message.slice(0, 160)}`); }
    }
    checkRequires();
  }

  /* 热重载单个插件：摘掉旧注册 → 清 require 缓存 → 重新加载 */
  function reloadPlugin(file) {
    const dir = path.join(__dirname, "plugins");
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) {
      if (unregisterPlugin(file)) core.log("info", `插件已移除: ${file}`);
      return;
    }
    unregisterPlugin(file);
    try { delete require.cache[require.resolve(full)]; } catch (e) {}
    try {
      const mod = require(full);
      if (registerPlugin(mod, file)) core.log("info", `插件已热重载: ${mod.name} v${mod.version || "1.0.0"}（当前 ${plugins.length} 个插件 / ${toolRegistry.size} 个工具 / ${commandRegistry.size} 个命令）`);
    } catch (e) { core.log("error", `热重载失败 ${file}: ${e.message.slice(0, 200)}`); }
  }

  /* 监听 plugins/ 目录，文件变动后 400ms 防抖重载 */
  function watchPlugins() {
    const dir = path.join(__dirname, "plugins");
    if (!fs.existsSync(dir)) return;
    const pending = new Map();
    try {
      fs.watch(dir, (evt, filename) => {
        if (!filename || !/\.js$/.test(filename)) return;
        if (pending.has(filename)) clearTimeout(pending.get(filename));
        pending.set(filename, setTimeout(() => { pending.delete(filename); reloadPlugin(filename); }, 400));
      });
      core.log("info", "插件热重载已启用（监听 plugins/ 目录，改动 js 自动重载）");
    } catch (e) { core.log("warn", "插件热重载启动失败: " + e.message.slice(0, 120)); }
  }

  function allToolDefs() { return core.AGENT_TOOLS.concat(plugins.flatMap((p) => (p.tools || []).map((t) => t.def))); }

  return { plugins, toolRegistry, commandRegistry, apis, hookLists, contextProviders, loadPlugins, runHook, allToolDefs, ctx, reloadPlugin, watchPlugins, checkRequires, pluginRecords };
}

module.exports = { createHost };
