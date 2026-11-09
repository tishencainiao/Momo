#!/usr/bin/env node
/* 一次性脚本：给所有「有 api 却没有 apiSpec」的插件补 apiSpec（能力自描述契约）。
 * 策略：
 *   1) require 每个插件（init 不会被调用，安全）拿到 api 命名空间 + 函数名；
 *   2) 函数名启发式推 sideEffect（save/set/push/record/learn → "写盘"，load/get/read/fetch/list/scan → "只读"，其余留空）；
 *   3) 命中 ENRICH 手工表的关键函数，用真实的 input/output/sideEffect 覆盖；
 *   4) 在 module.exports 的 `api:` 之前插入 `apiSpec: <对象>`（JSON 文本，键带引号也是合法 JS）。
 * 幂等：已有 apiSpec 的插件跳过。
 */
const fs = require("fs");
const path = require("path");

const PLUGINS_DIR = path.join(__dirname, "..", "plugins");

/* 手工富化的关键函数（跨插件被调用的 api，写真实契约） */
const ENRICH = {
  mind: {
    loadMindState:   { input: "无", output: "心智状态 {thoughts,last_think,...}", sideEffect: "只读" },
    saveMindState:   { input: "state", output: "boolean", sideEffect: "写 data/mind.json" },
    pushThought:     { input: "state, text", output: "state(原地改)", sideEffect: "改内存对象不落盘" },
    thoughtList:     { input: "state", output: "[thought]", sideEffect: "只读" },
    thoughtTexts:    { input: "state", output: "string", sideEffect: "只读" },
    loadOpenLoops:   { input: "无", output: "[loop]", sideEffect: "只读" },
    pushOpenLoop:    { input: "text", output: "无", sideEffect: "写 open-loops" },
    openLoopsText:   { input: "无", output: "string", sideEffect: "只读" },
    mindHistoryText: { input: "无", output: "string", sideEffect: "只读" },
    loadPending:     { input: "无", output: "[pending]", sideEffect: "只读" },
    savePending:     { input: "arr", output: "无", sideEffect: "写盘" },
    addPendingNudge: { input: "text", output: "无", sideEffect: "写盘" },
    pendingNudgesText:{ input: "无", output: "string", sideEffect: "只读" },
    consumePendingNudge: { input: "idx", output: "无", sideEffect: "写盘" },
    scoreIntent:     { input: "text", output: "0~1 分数", sideEffect: "无" },
  },
  search: {
    parseBaiduHtml:  { input: "html", output: "[{title,url,snippet}]", sideEffect: "无" },
    formatResults:   { input: "results, n", output: "string", sideEffect: "无" },
    baiduSearch:     { input: "q, n", output: "[result]", sideEffect: "联网" },
    httpsGet:        { input: "url, opt", output: "text", sideEffect: "联网" },
    bochaSearch:     { input: "q, n", output: "[result]", sideEffect: "联网(花钱)" },
  },
  vision: {
    visionModel:     { input: "无", output: "模型名", sideEffect: "只读" },
    mimeOf:          { input: "bytes", output: "mime", sideEffect: "只读" },
    httpGetBytes:    { input: "url", output: "buffer", sideEffect: "联网" },
    imageBytes:      { input: "path", output: "buffer", sideEffect: "读文件" },
    describeImage:   { input: "url, prompt", output: "描述", sideEffect: "联网+花钱" },
    describeImageFile:{ input: "path, prompt", output: "描述", sideEffect: "花钱" },
  },
  budgetReport: {
    dailyBill:       { input: "无", output: "string", sideEffect: "只读" },
    weeklyReport:    { input: "无", output: "string", sideEffect: "只读" },
    loadBudget:      { input: "无", output: "budget 对象", sideEffect: "只读" },
  },
  groupMemes: {
    learn:           { input: "text, key", output: "无", sideEffect: "写盘" },
    detectAndLearn:  { input: "text, ctx", output: "无", sideEffect: "写盘" },
    ctx:             { input: "无", output: "string", sideEffect: "只读" },
    list:            { input: "无", output: "[meme]", sideEffect: "只读" },
  },
  proactive: {
    recentQqChat:    { input: "无", output: "string", sideEffect: "只读" },
  },
  pluginDoctor: {
    check:           { input: "无", output: "report", sideEffect: "写 data/plugin-health.json" },
    issueBrief:      { input: "无", output: "string", sideEffect: "只读" },
  },
};

function inferSideEffect(fnName) {
  const n = String(fnName);
  if (/^(save|set|update|add|push|record|write|learn|consume|remove|delete|clear|note)/i.test(n)) return "写盘";
  if (/^(load|get|read|fetch|list|scan|view|count|has|check|find|text|ctx|tierOf|of$|state|brief|report|summary|bill|budget|key)/i.test(n)) return "只读";
  return "";
}

function apiSpecOf(mod) {
  const spec = {};
  for (const ns of Object.keys(mod.api || {})) {
    const fns = mod.api[ns];
    if (!fns || typeof fns !== "object") continue;
    const o = {};
    for (const fn of Object.keys(fns)) {
      if (typeof fns[fn] !== "function") continue;
      const enriched = ENRICH[ns] && ENRICH[ns][fn];
      o[fn] = enriched || { input: "", output: "", sideEffect: inferSideEffect(fn) };
    }
    if (Object.keys(o).length) spec[ns] = o;
  }
  return spec;
}

function main() {
  const files = fs.readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".js") && !f.startsWith("_")).sort();
  let done = 0, skipped = 0;
  for (const f of files) {
    const full = path.join(PLUGINS_DIR, f);
    let src = fs.readFileSync(full, "utf8");
    if (/\bapiSpec\s*:/.test(src)) { skipped++; continue; }
    let mod = null;
    try { mod = require(full); } catch (e) { continue; }
    if (!mod || !mod.api || typeof mod.api !== "object") continue;
    const spec = apiSpecOf(mod);
    if (!Object.keys(spec).length) continue;
    const text = "apiSpec: " + JSON.stringify(spec);
    // 在 `api:` 之前插入（保持键序稳定）
    const m = src.match(/(\n\s*)api\s*:/);
    if (!m) { continue; }
    const indent = m[1];
    src = src.replace(m[0], `${indent}${text},\n${indent}api:`);
    fs.writeFileSync(full, src, "utf8");
    done++;
  }
  console.log(`backfill-apiSpec 完成：写入 ${done} 个插件，跳过 ${skipped} 个已有 apiSpec`);
}

main();
