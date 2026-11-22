#!/usr/bin/env node
/* v2.1.0 WP1 恢复行为测试（B01/B02/B05）：
 * 用子进程做真实重启，断言持久化摄入队列在重启/失败后的行为（WP0 时是 RED 反例，WP1 起必须全绿）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const ROOT = path.join(__dirname, "..");
const NODE = process.execPath;
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function checkRed(name, cond, extra) { check(name, cond, extra); }

/* 子进程 runner：加载真实 plugins/memory.js，mock ctx，按阶段做操作，输出 JSON 结果 */
const RUNNER = `
const fs = require("fs");
const path = require("path");
const tmp = process.env.MOMO_TMP;
const phase = process.env.MOMO_PHASE;
const failLLM = process.env.MOMO_FAIL_LLM === "1";
const shortDir = path.join(tmp, "short-memory");
const memDir = path.join(tmp, "memory");
const callsLog = path.join(tmp, "calls.jsonl");
const memPlugin = require(${JSON.stringify(ROOT.replace(/\\\\/g, "/"))} + "/plugins/memory.js");
function logCall(kind, extra) { fs.appendFileSync(callsLog, JSON.stringify({ kind, extra: extra || "", ts: Date.now() }) + "\\n"); }
function parseJson(raw) { try { let s = String(raw).trim(); const f = s.match(/\`\`\`(?:json)?\\s*([\\s\\S]*?)\`\`\`/i); if (f) s = f[1].trim(); const o = JSON.parse(s); return (Array.isArray(o) ? o : (o.memories || [])).map((m) => (typeof m === "string" ? m : m.content)).filter(Boolean); } catch (e) { return []; } }
function readShort(uid) { try { const d = JSON.parse(fs.readFileSync(path.join(shortDir, uid + ".json"), "utf8")); return d.items || []; } catch (e) { return []; } }
const ctx = {
  DATA_DIR: tmp,
  config: { qq: { allowed_users: [100000001, 100000002] } },
  apiKey: "fake-key",
  resolveCall: (uid) => "主人",
  settings: () => ({}),
  log: () => {},
  recordAction: () => {},
  sendPrivate: () => {},
  writeJsonAtomic: (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, f); },
  completeOnce: async () => {
    if (failLLM) throw new Error("fake LLM 故障");
    logCall("extract");
    return JSON.stringify({ memories: [{ content: "提炼出：喜欢钓鱼" }, { content: "提炼出：住在东北" }, { content: "提炼出：最近在写论文" }] });
  },
  reasonComplete: async () => { logCall("consolidate"); return "[]"; },
  parseMemoryJson: parseJson,
  loadShortMemories: (uid) => readShort(uid),
  saveShortMemories: (uid, items) => { fs.mkdirSync(shortDir, { recursive: true }); fs.writeFileSync(path.join(shortDir, uid + ".json"), JSON.stringify({ updated: Date.now(), items })); },
  loadMemories: (uid) => { try { const d = JSON.parse(fs.readFileSync(path.join(memDir, uid + ".json"), "utf8")); return d.items || []; } catch (e) { return []; } },
  saveMemories: (uid, items) => { fs.mkdirSync(memDir, { recursive: true }); fs.writeFileSync(path.join(memDir, uid + ".json"), JSON.stringify({ updated: Date.now(), items })); },
};
memPlugin.init(ctx);
(async () => {
  const U = 100000001;
  if (phase === "p1_below_batch") {
    memPlugin.hooks.reply({ userId: U, text: "我喜欢钓鱼", reply: "好呀", channel: "private", groupId: "" });
    memPlugin.hooks.reply({ userId: U, text: "我住东北", reply: "记下了", channel: "private", groupId: "" });
    await new Promise((r) => setTimeout(r, 120));
    const out = { short: readShort(U).length };
    fs.writeFileSync(path.join(tmp, "p1.json"), JSON.stringify(out));
    console.log(JSON.stringify(out));
  } else if (phase === "p2_flush") {
    const now = Date.now() + 11 * 60000;
    memPlugin.hooks.timer({ now });
    await new Promise((r) => setTimeout(r, 400));
    const short = readShort(U);
    const out = { shortLen: short.length, contents: short.map((m) => m.content) };
    fs.writeFileSync(path.join(tmp, "p2.json"), JSON.stringify(out));
    console.log(JSON.stringify(out));
  } else if (phase === "p1_fail") {
    memPlugin.hooks.reply({ userId: U, text: "一号消息", reply: "r1", channel: "private", groupId: "" });
    memPlugin.hooks.reply({ userId: U, text: "二号消息", reply: "r2", channel: "private", groupId: "" });
    memPlugin.hooks.reply({ userId: U, text: "三号消息", reply: "r3", channel: "private", groupId: "" });
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(tmp, "p1.json"), JSON.stringify({ short: readShort(U).length }));
    console.log("done");
  } else if (phase === "p2_recover") {
    const now = Date.now() + 11 * 60000;
    memPlugin.hooks.timer({ now });
    await new Promise((r) => setTimeout(r, 400));
    const short = readShort(U);
    fs.writeFileSync(path.join(tmp, "p2.json"), JSON.stringify({ shortLen: short.length }));
    console.log(JSON.stringify({ shortLen: short.length }));
  } else if (phase === "p1_consolidate") {
    ctx.saveShortMemories(U, [{ content: "计划类短记忆一条", created: Math.floor(Date.now() / 1000) }]);
    const now = Date.now() + 6 * 3600e3 + 60000;
    memPlugin.hooks.timer({ now });
    await new Promise((r) => setTimeout(r, 300));
    console.log("done");
  } else if (phase === "p2_consolidate_check") {
    const before = (() => { try { return fs.readFileSync(callsLog, "utf8").split("\\n").filter(Boolean).filter((l) => l.indexOf("consolidate") >= 0).length; } catch (e) { return 0; } })();
    const now = Date.now() + 6 * 3600e3 + 23 * 3600e3 + 120000;
    memPlugin.hooks.timer({ now });
    await new Promise((r) => setTimeout(r, 300));
    const after = (() => { try { return fs.readFileSync(callsLog, "utf8").split("\\n").filter(Boolean).filter((l) => l.indexOf("consolidate") >= 0).length; } catch (e) { return 0; } })();
    console.log(JSON.stringify({ consolidateCalls: after - before }));
  }
  process.exit(0);
})().catch((e) => { console.log("ERR " + e.message); process.exit(1); });
`;

function runPhase(tmp, phase, failLLM) {
  const runner = path.join(tmp, "runner.js");
  fs.writeFileSync(runner, RUNNER);
  return cp.spawnSync(NODE, [runner], { env: Object.assign({}, process.env, { MOMO_TMP: tmp, MOMO_PHASE: phase, MOMO_FAIL_LLM: failLLM ? "1" : "0" }), encoding: "utf8", timeout: 30000 });
}

/* ===== RED-1（B01）：不足一批的对话重启后仍在 ===== */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-red1-"));
  const a = runPhase(tmp, "p1_below_batch", false);
  const b = runPhase(tmp, "p2_flush", false);
  const r = JSON.parse(b.stdout.trim().split("\n").pop());
  checkRed("RED-1/B01 不足一批的对话重启后仍可提炼", r.shortLen >= 2, "当前重启后 short=" + r.shortLen + "（期望≥2，RED）");
}

/* ===== RED-2（B02）：提炼失败后原批次保留、恢复后只成功一次 ===== */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-red2-"));
  runPhase(tmp, "p1_fail", true);
  const b = runPhase(tmp, "p2_recover", false);
  const r = JSON.parse(b.stdout.trim().split("\n").pop());
  checkRed("RED-2/B02 提炼失败后批次未丢、重启恢复可继续", r.shortLen >= 3, "当前恢复后 short=" + r.shortLen + "（期望≥3，RED）");
}

/* ===== RED-3（B05）：固化调度不被重启无限推迟 ===== */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-red3-"));
  runPhase(tmp, "p1_consolidate", false);
  const b = runPhase(tmp, "p2_consolidate_check", false);
  const r = JSON.parse(b.stdout.trim().split("\n").pop());
  checkRed("RED-3/B05 重启后固化调度延续（23h 内不重复固化）", r.consolidateCalls === 0, "当前重启后 23h 时又固化了 " + r.consolidateCalls + " 次（期望 0，RED）");
}

console.log("== memory-recovery: pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
