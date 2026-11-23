/* test/startup-recovery.js — v2.2.0 WP5 启动恢复清单
 * vm 提取 index.js 真实 _startupChecklist/_writeStartupRecovery，验证：
 * 清单字段齐全、混合状态逐项准确、reconcile 无真实发送、写盘失败不显示 ready。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

function sliceFn(name) {
  const i = SRC.indexOf("function " + name + "(");
  if (i < 0) throw new Error("not found: " + name);
  let j = SRC.indexOf("{", i), d = 0;
  for (; j < SRC.length; j++) { if (SRC[j] === "{") d++; else if (SRC[j] === "}") { d--; if (d === 0) break; } }
  return SRC.slice(i, j + 1);
}

const chkSrc = sliceFn("_startupChecklist");
const wrSrc = sliceFn("_writeStartupRecovery");

function mkSandbox(over) {
  const box = {
    BASE_VERSION: "2.2.0-test",
    _boot: { bootId: "boot-1", startedAt: 111, stage: "core" },
    log: () => {},
    host: null,
    _openRec: 2,
    DATA_DIR: over.DATA_DIR,
    writeJsonAtomic: (f, obj) => { if (over.failWrite) throw new Error("disk full"); fs.writeFileSync(f, JSON.stringify(obj)); },
    path,
  };
  box._recoverApi = () => (over.cr === undefined ? {
    inboxStats: () => ({ received: 5, dead: 1 }),
    cursorState: () => ({ private: { u1: { gap_suspected: true } }, groups: { g1: { gap_suspected: false } } }),
    reconcileOnBoot: () => ({ interrupted: 1, unknown: 0, resumed: 2 }),
  } : over.cr);
  box.apiOf = (ns) => (over.apis || {})[ns] || null;
  return box;
}

function loadChecklist(over) {
  const box = mkSandbox(over);
  const ctx = {};
  ctx.console = console;
  ctx.BASE_VERSION = box.BASE_VERSION; ctx._boot = box._boot; ctx.log = box.log; ctx.host = box.host;
  ctx._openRec = box._openRec; ctx.DATA_DIR = box.DATA_DIR; ctx.writeJsonAtomic = box.writeJsonAtomic; ctx.path = box.path;
  ctx._recoverApi = box._recoverApi; ctx.apiOf = box.apiOf;
  vm.createContext(ctx);
  vm.runInContext(chkSrc + "\n" + wrSrc, ctx);
  return ctx;
}

const checks = [];
function check(name, fn) { checks.push([name, fn]); }
let pass = 0, n = 0;

check("清单字段齐全（9 组）", () => {
  const ctx = loadChecklist({ DATA_DIR: "E:/Learn/Momo/data/_t_sr1" });
  const m = ctx._startupChecklist("ready");
  const keys = ["boot_id", "base_version", "started_at", "finished_at", "status", "plugins", "inbox", "actions", "memory_ingest", "digest", "cursors", "session_repairs", "errors"];
  for (const k of keys) { if (!(k in m)) throw new Error("缺字段 " + k); }
  if (m.boot_id !== "boot-1" || m.base_version !== "2.2.0-test") throw new Error("身份字段错误");
  if (m.status !== "ready") throw new Error("status 未透传");
  if (m.actions.open_reconciled !== 2) throw new Error("行动对账数未取");
});

check("混合状态逐项准确（收件箱/游标 gap/消化/摄入）", () => {
  const ctx = loadChecklist({
    DATA_DIR: "E:/Learn/Momo/data/_t_sr2",
    apis: {
      memoryDigest: { digestStatus: () => ({ pending: ["43"], stale: ["7"], dead: [] }) },
      memory: { memoryOps: { status: () => ({ pending: 3, failed: 1, dead: 1 }) } },
    },
  });
  const m = ctx._startupChecklist("ready");
  if (m.inbox.received !== 5 || m.inbox.dead !== 1) throw new Error("收件箱统计错");
  if (m.cursors.gap_suspected !== 1) throw new Error("gap 计数错（u1 是 1）");
  if (m.digest.pending.length !== 1 || m.digest.stale.length !== 1) throw new Error("消化状态错");
  if (m.memory_ingest.pending !== 3 || m.memory_ingest.failed !== 2) throw new Error("摄入状态错（failed+dead=2）");
});

check("清单写盘成功保留 ready 且文件含全部字段", () => {
  const dir = "E:/Learn/Momo/data/_t_sr3";
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(dir, { recursive: true });
  const ctx = loadChecklist({ DATA_DIR: dir });
  const m = ctx._writeStartupRecovery("ready");
  if (m.status !== "ready") throw new Error("写盘成功但 status 变了");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "startup-recovery.json"), "utf8"));
  if (!onDisk.boot_id || !onDisk.finished_at) throw new Error("落盘清单不完整");
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
});

check("清单写盘失败不显示 ready（降级 degraded+errors）", () => {
  const ctx = loadChecklist({ DATA_DIR: "E:/Learn/Momo/data/_t_sr4", failWrite: true });
  const m = ctx._writeStartupRecovery("ready");
  if (m.status !== "degraded") throw new Error("写盘失败仍显示 ready");
  if (!m.errors.some((x) => String(x).includes("manifest write failed"))) throw new Error("errors 未记录写盘失败");
});

check("D3：清单状态按收件箱推导（有 pending → degraded 不硬编码 ready）", () => {
  // 静态断言：_listStatus 按 inboxStats pending/interrupted/unknown/dead 推导
  const seg = sliceFn("_startupChecklist", "_writeStartupRecovery");
  const i = SRC.indexOf('let _listStatus = "ready"');
  if (i < 0) throw new Error("缺 _listStatus 声明");
  const j = SRC.indexOf("_writeStartupRecovery(_listStatus", i);
  if (j < 0) throw new Error("缺 _listStatus 使用");
  const mid = SRC.slice(i, j + 60);
  if (!mid.includes("inboxStats")) throw new Error("缺 inboxStats 读取");
  if (!mid.includes("_is.pending") && !mid.includes("pending")) throw new Error("缺 pending 判断");
  if (!mid.includes("degraded")) throw new Error("缺 degraded 降级");
  if (!mid.includes("_repairSessions")) { // D1 接线：先补写会话再写清单
    const k = SRC.indexOf("_repairSessions()");
    if (k < 0) throw new Error("缺 _repairSessions 接线");
  }
  return true;
});

check("静态：reconcile 无真实发送（阶段二不调 onebotSend/sendPrivate/recordAndSend）", () => {
  const i2 = SRC.indexOf("async function _bootStage2() {");
  const j2 = SRC.indexOf("_bootStage(\"ready\")", i2);
  const block = SRC.slice(i2, j2);
  if (/onebotSend|sendPrivate|recordAndSend/.test(block)) throw new Error("阶段二含真实发送调用");
});

check("静态：503 就绪门（starting 阶段拒绝桌宠请求）", () => {
  if (SRC.indexOf("starting:") < 0 || SRC.indexOf("503") < 0) throw new Error("503 就绪门缺失");
});

let chain = Promise.resolve();
for (const [name, fn] of checks) {
  chain = chain.then(async () => {
    n++;
    try { await fn(); pass++; console.log("  PASS " + name); }
    catch (e) { console.log("  FAIL " + name + "  → " + (e && e.message)); }
  });
}
chain.then(() => {
  console.log("\nstartup-recovery: " + pass + "/" + n + " passed");
  process.exit(pass === n ? 0 : 1);
});
