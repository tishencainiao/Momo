/* R1 可靠性测试：原子写 + apiOf 判空 + 热重载先建后拆（静态） */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const PHSRC = fs.readFileSync(path.join(__dirname, "..", "plugin-host.js"), "utf8");

let n = 0, pass = 0;
function check(name, fn) {
  n++;
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { console.log("  ✗ " + name + " -> " + e.message); }
}

/* ---------- 提取 index.js 的原子写 + apiOf 工具 ---------- */
function extract(needle, tailNeedle) {
  const i = SRC.indexOf(needle);
  assert.ok(i >= 0, "找不到 " + needle);
  const j = SRC.indexOf(tailNeedle, i);
  assert.ok(j >= 0, "找不到尾部 " + tailNeedle);
  return SRC.slice(i, j);
}
const atomicSrc = extract("function writeFileAtomic(file, text) {", "function writeJsonAtomic");
const jsonAtomicSrc = extract("function writeJsonAtomic(file, obj) {", "/* R1-3");
const nsDefaultSrc = /const NS_DEFAULT = \{[\s\S]*?\n\};/.exec(SRC)[0];
const apiOfSrc = /function apiOf\(ns\) \{[\s\S]*?\n\}/.exec(SRC)[0];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "momo-r1-"));

function mkSandbox(extra) {
  /* 注意：不能把宿主 Proxy 传进 vm sandbox（contextify 会爆栈）；
     vm 上下文自带原生 Proxy，apiOf 直接用它 */
  return Object.assign({
    module: { exports: {} }, console, process, Buffer, setTimeout, clearTimeout,
    fs, path, undefined,
  }, extra || {});
}

check("writeJsonAtomic 正常写且无 tmp 残留", () => {
  const f = path.join(TMP, "a.json");
  const sandbox = mkSandbox();
  vm.runInNewContext(atomicSrc + jsonAtomicSrc + `writeJsonAtomic(${JSON.stringify(f)}, {x:1});`, sandbox, { filename: "atomic.js" });
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepStrictEqual(d, { x: 1 });
  assert.ok(!fs.readdirSync(TMP).some((x) => x.includes(".tmp-")), "不应留 tmp");
});

check("writeJsonAtomic 写失败时旧文件完好且抛错", () => {
  const f2 = path.join(TMP, "c.json");
  fs.writeFileSync(f2, JSON.stringify({ old: 1 }));
  /* 注入 fs 假件：renameSync 对该目标连抛 3 次（writeFileAtomic 重试 2 次后必须抛错） */
  const fakeFs = Object.create(fs);
  fakeFs.renameSync = function (from, to) {
    if (String(to).endsWith("c.json")) throw new Error("EACCES: simulated rename failure");
    return fs.renameSync(from, to);
  };
  const sb2 = mkSandbox({ fs: fakeFs, path });
  const code2 = atomicSrc + jsonAtomicSrc + `
    let threw = false;
    try { writeJsonAtomic(${JSON.stringify(f2)}, {x:1}); } catch (e) { threw = true; }
    threw;
  `;
  const threw = vm.runInNewContext(code2, sb2, { filename: "atomic3.js" });
  assert.strictEqual(threw, true, "写失败应抛错");
  const d = JSON.parse(fs.readFileSync(f2, "utf8"));
  assert.deepStrictEqual(d, { old: 1 }, "旧文件必须完好");
  assert.ok(!fs.readdirSync(TMP).some((x) => x.includes(".tmp-")), "失败后 tmp 应被清理");
});

check("apiOf：有插件返回真 API，缺插件返回默认", () => {
  const real = { pendingNudgesText: () => "hi" };
  const sandbox = mkSandbox({
    real,
    host: { apis: { get: (ns) => (ns === "mind" ? real : null) } },
  });
  const code = nsDefaultSrc + "\nconst _noopFn = () => undefined;\n" + apiOfSrc + `
    const r1 = apiOf("mind");
    const r2 = apiOf("groupInfo");
    const r3 = apiOf("no-such");
    module.exports = {
      same: r1 === real,
      pend: r1.pendingNudgesText(3),
      gmFilter: r2.filterMemoriesForGroup([1,2], "g"),
      noThrow: (() => { try { r3.whatever(); return true; } catch (e) { return false; } })(),
    };
  `;
  const out = vm.runInNewContext(code, sandbox, { filename: "apiof.js" });
  assert.strictEqual(out.same, true);
  assert.strictEqual(out.pend, "hi");
  assert.deepStrictEqual(Array.from(out.gmFilter), [1, 2], "缺 groupInfo 时 filterMemoriesForGroup 应回原数组");
  assert.strictEqual(out.noThrow, true, "未知命名空间调任意函数不应抛");
});

check("apiOf 源码里 host 判空（缺 host 也不崩）", () => {
  assert.ok(apiOfSrc.includes("host && host.apis"), "apiOf 应有 host 判空");
});

check("reloadPlugin 先建后拆（静态）", () => {
  assert.ok(PHSRC.includes("先建后拆"), "应有先建后拆注释");
  assert.ok(PHSRC.includes("保留旧版本"), "失败应保留旧版本");
  assert.ok(PHSRC.indexOf("unregisterPlugin(file);\n    if (registerPlugin") > 0, "应 register 前才 unregister");
  assert.ok(PHSRC.includes("notifyReloadFailure"), "应有失败通知");
  assert.ok(PHSRC.includes("KERNEL_REQUIRED = new Set([\"mind\", \"group-info\", \"roles\"])"), "应有内核保护名单");
});

check("dispose 生命周期（R2 静态）", () => {
  assert.ok(PHSRC.includes("typeof rec.mod.dispose === \"function\""), "unregisterPlugin 应调用插件 dispose");
  const md = fs.readFileSync(path.join(__dirname, "..", "plugins", "memory-digest.js"), "utf8");
  assert.ok(md.includes("dispose() {") && md.includes("clearInterval(_timer)"), "memory-digest 应清理定时器");
});

check("崩溃退出 + WS 退避（R2 静态）", () => {
  assert.ok(SRC.includes("未捕获异常（进程将退出") && SRC.includes("process.exit(1)"), "uncaughtException 应退出");
  assert.ok(SRC.includes("function nextWsDelay()") && SRC.includes("resetWsDelay()"), "WS 应有指数退避");
  assert.ok(!SRC.includes("OneBot WS 断开，5 秒后重连"), "不应再是固定 5 秒");
});


// ---- check 8：openApp 命令注入消毒（行为级） ----
const PCTOOLS = fs.readFileSync(path.join(__dirname, "..", "plugins", "pc-tools.js"), "utf8");
check("openApp 注入消毒（行为级）", () => {
  const m = /function openApp\(name\) \{[\s\S]*?\n\}/.exec(PCTOOLS);
  assert.ok(m, "找不到 openApp 函数");
  const box = mkSandbox();
  let argsOut = null;
  box.spawn = (cmd, args) => { argsOut = args; return { unref() {} }; };
  box.findLnk = () => null;
  box.path = path;
  vm.runInNewContext(
    "const module={exports:{}}; const __src = " + JSON.stringify(m[0]) + "; eval(__src); globalThis.__openApp = openApp;",
    box
  );
  const r = box.__openApp("calc & del C:\\x | whoami");
  assert.ok(r && r.ok, "openApp 应返回 ok：" + JSON.stringify(r));
  const joined = (argsOut || []).join(" ");
  assert.ok(!/[&|<>^%!]/.test(joined), "cmd 元字符未被清除：" + joined);
  assert.ok(joined.includes("calc"), "消毒后仍应包含安全词");
});


// ---- check 9：v1.98.9 回归——原子写进 createHost + 报时状态不自我覆盖 ----
check("原子写回归（createHost 传参 + pet-body 报时状态）", () => {
  const IDX = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const cHost = IDX.slice(IDX.indexOf("host = createHost("));
  assert.ok(/writeFileAtomic,\s*writeJsonAtomic,/.test(cHost), "createHost 传参必须含 writeFileAtomic/writeJsonAtomic");
  const PB = fs.readFileSync(path.join(__dirname, "..", "plugins", "pet-body.js"), "utf8");
  assert.ok(PB.includes("function loadChimeStateRaw()"), "pet-body 应有无副作用 loadChimeStateRaw");
  assert.ok(!/Object\.assign\(\s*loadChimeState\(\)/.test(PB), "saveChimeState 不得调用有副作用的 loadChimeState()（会重置内存守卫导致每秒重复报时）");
  assert.ok(PB.includes("Object.assign(loadChimeStateRaw()"), "saveChimeState 应用 loadChimeStateRaw 合并");
});


console.log(`\n✓ ${pass}/${n} 个断言通过`);
process.exit(pass === n ? 0 : 1);
