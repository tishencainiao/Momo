#!/usr/bin/env node
/* Momo 插件体检（plugin-doctor）：校验每个插件的清单（Manifest）是否合规。
 * 单一职责：check.js（pre-commit）、/插件体检 命令、身体面板、每日巡检 四处都调它，避免体检逻辑分散。
 *
 * 用法：
 *   1) CLI：node scripts/plugin-doctor.js          （从 index.js 读 BASE_VERSION，打印报告，非零退出=有红项）
 *   2) 程序：const { diagnose } = require("./scripts/plugin-doctor")
 *      diagnose({ kernelVersion, pluginsDir }) → 结构化报告 { plugins, summary, ok }
 *
 * 判定口径（与 Momo插件平台巩固优化方案.md 第三节一致）：
 *   red   = 硬不满足（缺 name / 版本不满足 / requires 缺依赖 / api 命名空间冲突 / 工具 schema 非法）
 *   yellow= 软不满足（缺 displayName/description/version/permissions 等元数据、attribution 缺 license）
 *   green = 全部合规
 */
const fs = require("fs");
const path = require("path");

/* ---------------- 版本比较（支持 ">=1.2.3" / "^1.2.0" / "1.2.3" 精确） ---------------- */
function parseVer(v) {
  const m = String(v || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}
/* engine 形如 ">=1.80.1" / "^1.80.0" / "1.81.0"；返回 kernel 是否满足 */
function satisfies(engine, kernel) {
  if (!engine) return true; // 未声明 = 不限制
  const s = String(engine).trim();
  const kv = parseVer(kernel);
  let op = ">=", ev = s;
  if (s.startsWith(">=")) { op = ">="; ev = s.slice(2); }
  else if (s.startsWith("^")) { op = ">="; ev = s.slice(1); }
  else if (s.startsWith("~")) { op = ">="; ev = s.slice(1); }
  else if (s.startsWith(">")) { op = ">"; ev = s.slice(1); }
  else if (s.startsWith("<=")) { op = "<="; ev = s.slice(2); }
  else if (s.startsWith("<")) { op = "<"; ev = s.slice(1); }
  else if (s.startsWith("=")) { op = "="; ev = s.slice(1); }
  const evv = parseVer(ev);
  if (!kv || !evv) return true; // 解析不了就放行，避免误伤
  const c = cmpVer(kv, evv);
  if (op === ">=") return c >= 0;
  if (op === ">") return c > 0;
  if (op === "<=") return c <= 0;
  if (op === "<") return c < 0;
  return c === 0;
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/* ---------------- 主诊断 ---------------- */
function diagnose(opts) {
  const pluginsDir = opts.pluginsDir || path.join(__dirname, "..", "plugins");
  const kernel = opts.kernelVersion || "0.0.0";
  const report = { kernelVersion: kernel, plugins: [], summary: { total: 0, green: 0, yellow: 0, red: 0, redList: [], yellowList: [] } };

  let files = [];
  try { files = fs.readdirSync(pluginsDir).filter((f) => f.endsWith(".js") && !f.startsWith("_")).sort(); }
  catch (e) { return report; }

  const mods = [];   // {file, mod}
  for (const f of files) {
    let mod = null;
    try { mod = require(path.join(pluginsDir, f)); } catch (e) { mod = { __loadError: e.message }; }
    mods.push({ file: f, mod });
  }

  /* 收集所有 api 命名空间（跨插件）用于 requires 交叉校验 + 冲突检测 */
  const nsProvider = new Map(); // ns -> [file]
  for (const { file, mod } of mods) {
    if (mod && mod.api && typeof mod.api === "object") {
      for (const ns of Object.keys(mod.api)) {
        if (!nsProvider.has(ns)) nsProvider.set(ns, []);
        nsProvider.get(ns).push(file);
      }
    }
  }
  const seenName = new Map();

  for (const { file, mod } of mods) {
    const issues = [];
    const red = (m) => issues.push({ level: "red", msg: m });
    const yellow = (m) => issues.push({ level: "yellow", msg: m });
    const name = mod && mod.name;

    if (mod && mod.__loadError) { red("加载失败: " + String(mod.__loadError).slice(0, 120)); }
    else {
      if (!name) red("缺 name");
      else {
        if (!KEBAB.test(name)) red(`name "${name}" 非 kebab-case（领域-用途 两段式）`);
        if (seenName.has(name)) red(`name "${name}" 与其他插件重复`);
        seenName.set(name, file);
      }
      if (!mod.version) yellow("缺 version");
      else if (!SEMVER.test(String(mod.version))) yellow(`version "${mod.version}" 非 semver`);
      if (!mod.displayName) yellow("缺 displayName（友好中文名）");
      if (!mod.description || !String(mod.description).trim()) yellow("缺 description（用途介绍）");
      if (mod.engines && mod.engines.kernel && !satisfies(mod.engines.kernel, kernel)) {
        red(`engines.kernel "${mod.engines.kernel}" 不满足当前内核 ${kernel}`);
      }
      if (Array.isArray(mod.requires)) {
        for (const r of mod.requires) {
          if (!nsProvider.has(r)) red(`requires 依赖的命名空间 "${r}" 无插件提供`);
        }
      }
      if (mod.api && typeof mod.api === "object") {
        for (const ns of Object.keys(mod.api)) {
          const providers = nsProvider.get(ns) || [];
          if (providers.length > 1) red(`api 命名空间 "${ns}" 被 ${providers.join(", ")} 重复导出`);
        }
        // apiSpec（能力自描述契约）：有 api 就要有 apiSpec，且命名空间/函数要对得上
        const spec = mod.apiSpec || {};
        for (const ns of Object.keys(spec)) {
          if (!mod.api[ns]) red(`apiSpec 描述了不存在的命名空间 "${ns}"`);
        }
        for (const ns of Object.keys(mod.api)) {
          if (!spec[ns]) { yellow(`api 命名空间 "${ns}" 缺 apiSpec 契约`); continue; }
          const fns = mod.api[ns] || {};
          const specFns = spec[ns] || {};
          for (const fn of Object.keys(fns)) {
            if (typeof fns[fn] !== "function") continue;
            if (!specFns[fn]) yellow(`api "${ns}.${fn}" 缺 apiSpec`);
          }
        }
      }
      for (const t of (mod.tools || [])) {
        const fn = t && t.def && t.def.function;
        if (!fn || !fn.name) { red("工具缺 def.function.name"); continue; }
        if (!fn.description) yellow(`工具 ${fn.name} 缺 description`);
        if (!fn.parameters || typeof fn.parameters !== "object") yellow(`工具 ${fn.name} 缺 parameters（JSON schema）`);
      }
      for (const c of (mod.commands || [])) {
        if (!c || !c.key || !c.regex) red("命令缺 key 或 regex");
      }
      for (const s of (mod.settings || [])) {
        if (!s || !s.key) { red("settings 项缺 key"); continue; }
        if (!Object.prototype.hasOwnProperty.call(s, "default")) yellow(`settings "${s.key}" 缺 default`);
        if (!s.label) yellow(`settings "${s.key}" 缺 label`);
      }
      if (!Array.isArray(mod.permissions) || !mod.permissions.length) yellow("缺 permissions（用到的 ctx 能力清单）");
      if (mod.attribution) {
        if (!mod.attribution.source) yellow("attribution 缺 source");
        if (!mod.attribution.license) yellow("attribution 缺 license");
      }
    }

    const level = issues.some((i) => i.level === "red") ? "red" : (issues.length ? "yellow" : "green");
    report.plugins.push({
      file, name: name || "(未命名)", version: mod && mod.version, displayName: mod && mod.displayName,
      enabled: !(mod && mod.enabled === false), level, issues,
    });
    report.summary.total++;
    report.summary[level]++;
    if (level === "red") report.summary.redList.push(name || file);
    if (level === "yellow") report.summary.yellowList.push(name || file);
  }

  report.ok = report.summary.red === 0;
  return report;
}

/* ---------------- 文本报告（/插件体检 命令 / CLI 输出用） ---------------- */
function formatText(report) {
  const s = report.summary;
  const lines = [`插件体检：${s.total} 个插件，绿 ${s.green} / 黄 ${s.yellow} / 红 ${s.red}（内核 ${report.kernelVersion}）`];
  for (const p of report.plugins) {
    if (p.level === "green") continue;
    const tag = p.level === "red" ? "🔴" : "🟡";
    const meta = [p.version && `v${p.version}`, p.displayName].filter(Boolean).join(" ");
    lines.push(`${tag} ${p.name}${meta ? "（" + meta + "）" : ""}`);
    for (const i of p.issues) lines.push(`   - ${i.msg}`);
  }
  if (s.red === 0 && s.yellow === 0) lines.push("✅ 全部插件合规");
  else if (s.red === 0) lines.push("⚠️ 无硬伤，但有 " + s.yellow + " 个插件缺元数据");
  else lines.push("❌ 有 " + s.red + " 个插件硬不满足，建议尽快处理");
  return lines.join("\n");
}

/* ---------------- CLI 入口 ---------------- */
function readKernelVersion() {
  try {
    const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    const m = src.match(/const BASE_VERSION\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : "0.0.0";
  } catch (e) { return "0.0.0"; }
}

if (require.main === module) {
  const report = diagnose({ kernelVersion: readKernelVersion() });
  console.log(formatText(report));
  process.exit(report.ok ? 0 : 1);
}

module.exports = { diagnose, formatText, satisfies };
