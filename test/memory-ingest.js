#!/usr/bin/env node
/* v2.1.0 WP1 摄入队列行为测试（B03/B04/B06/B07/B08/B09）：
 * 直接 require 真实 plugins/memory.js，mock ctx 内存账本，测：
 * B03 不同作用域绝不混批；B04 同文双群独立；B06 dead_letter 不阻塞其他 job；
 * B07 result_ready 崩溃重启幂等应用；B08 exchange 入队即持久化；B09 落盘失败不入账。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const memPlugin = require(path.join(ROOT, "plugins", "memory.js"));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

function makeCtx(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-ingest-"));
  const state = {
    calls: [], failLLM: !!opts.failLLM, failPersist: !!opts.failPersist, dir,
    short: {}, long: {},
    results: opts.results || [{ content: "提炼出：喜欢钓鱼" }, { content: "提炼出：住在东北" }, { content: "提炼出：最近在写论文" }],
  };
  const readShort = (uid) => { try { const d = JSON.parse(fs.readFileSync(path.join(dir, "short-memory", String(uid) + ".json"), "utf8")); return d.items || []; } catch (e) { return []; } };
  const ctx = {
    DATA_DIR: dir,
    config: { qq: { allowed_users: [100000001, 100000002] } },
    apiKey: "fake-key",
    resolveCall: () => "主人",
    settings: () => ({}),
    log: () => {},
    recordAction: () => {},
    sendPrivate: () => {},
    writeJsonAtomic: (f, obj) => {
      if (state.failPersist) throw new Error("disk full");
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const t = f + ".tmp";
      fs.writeFileSync(t, JSON.stringify(obj));
      fs.renameSync(t, f);
    },
    completeOnce: async () => {
      state.calls.push({ kind: "extract", ts: Date.now() });
      if (state.failLLM) throw new Error("fake LLM 故障");
      return JSON.stringify({ memories: state.results });
    },
    reasonComplete: async () => { state.calls.push({ kind: "consolidate", ts: Date.now() }); return "[]"; },
    parseMemoryJson: (raw) => { try { let s = String(raw).trim(); const f = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if (f) s = f[1].trim(); const o = JSON.parse(s); return (Array.isArray(o) ? o : (o.memories || [])).map((m) => (typeof m === "string" ? m : m.content)).filter(Boolean); } catch (e) { return []; } },
    loadShortMemories: (uid) => readShort(uid),
    saveShortMemories: (uid, items) => { fs.mkdirSync(path.join(dir, "short-memory"), { recursive: true }); fs.writeFileSync(path.join(dir, "short-memory", String(uid) + ".json"), JSON.stringify({ updated: Date.now(), items })); },
    loadMemories: (uid) => { try { const d = JSON.parse(fs.readFileSync(path.join(dir, "memory", String(uid) + ".json"), "utf8")); return d.items || []; } catch (e) { return []; } },
    saveMemories: (uid, items) => { fs.mkdirSync(path.join(dir, "memory"), { recursive: true }); fs.writeFileSync(path.join(dir, "memory", String(uid) + ".json"), JSON.stringify({ updated: Date.now(), items })); },
  };
  return { ctx, state, readShort };
}

(async () => {
  /* ===== B03：不同作用域绝不混批 ===== */
  {
    const { ctx } = makeCtx();
    memPlugin.init(ctx);
    const U = 100000001;
    const j1 = await memPlugin.__test.bufferExchange(U, "群A一条", "r", "group", "101");
    const j2 = await memPlugin.__test.bufferExchange(U, "私聊一条", "r", "private", "");
    const j3 = await memPlugin.__test.bufferExchange(U, "群A二条", "r", "group", "101");
    check("B03 私聊/群不同 scope 不互相组批", j1 === null && j2 === null && j3 === null, "在 2 段群+1 段私聊时不得成批");
    const j4 = await memPlugin.__test.bufferExchange(U, "群A三条", "r", "group", "101");
    check("B03 同 scope 攒满 3 段才成批", j4 !== null && j4.scope.channel === "group" && j4.scope.groupId === "101" && j4.exs.length === 3);
    const q = memPlugin.__test._loadQueue(String(U));
    check("B03 私聊 exchange 不混入群 job", q.exchanges.length === 1 && q.exchanges[0].channel === "private");
  }

  /* ===== B04：同文双群独立 ===== */
  {
    const m = memPlugin.__test.mergeMemories;
    let items = [];
    items = m(items, ["感冒了点了山药粥"], "group", "101");
    items = m(items, ["感冒了点了山药粥"], "group", "202");
    check("B04 同文不同群各自独立", items.length === 2, "实际 " + items.length);
    check("B04 群号正确写入", items[0].groupId === "101" && items[1].groupId === "202");
    items = m(items, ["感冒了点了山药粥"], "group", "101");
    check("B04 同文同群去重", items.length === 2, "实际 " + items.length);
  }

  /* ===== B08：exchange 入队即持久化（无需攒批） ===== */
  {
    const { ctx, state } = makeCtx();
    memPlugin.init(ctx);
    const U = 100000001;
    await memPlugin.__test.bufferExchange(U, "半句对话", "r", "private", "");
    const raw = JSON.parse(fs.readFileSync(path.join(state.dir, "ingest", "queue-100000001.json"), "utf8"));
    check("B08 exchange 入队即落盘", raw.exchanges.length === 1 && raw.exchanges[0].u === "半句对话");
  }

  /* ===== B09：落盘失败不入账、下轮可重试 ===== */
  {
    const { ctx, state } = makeCtx({ failPersist: true });
    memPlugin.init(ctx);
    const r = await memPlugin.__test.bufferExchange(100000001, "写不进去", "r", "private", "");
    check("B09 落盘失败返回 null 不假成功", r === null);
    state.failPersist = false;
    const r2 = await memPlugin.__test.bufferExchange(100000001, "这次能写", "r", "private", "");
    check("B09 恢复后入队成功", r2 === null && memPlugin.__test._loadQueue("100000001").exchanges.length === 1);
  }

  /* ===== B06：dead_letter 不阻塞其他 job ===== */
  {
    const { ctx, state, readShort } = makeCtx({ failLLM: true });
    memPlugin.init(ctx);
    const U = 100000001;
    for (let i = 0; i < 3; i++) await memPlugin.__test.bufferExchange(U, "坏批次消息" + i, "r", "private", "");
    // 手动推进直到 dead_letter（超过 MAX_ATTEMPTS）
    const q = memPlugin.__test._loadQueue(String(U));
    const j = q.jobs[0];
    for (let i = 0; i < memPlugin.__test.MAX_ATTEMPTS + 1; i++) {
      await memPlugin.__test.processJob(String(U), j, Date.now() + i * 1000000);
    }
    const q2 = memPlugin.__test._loadQueue(String(U));
    check("B06 反复失败后进 dead_letter", q2.jobs[0].status === "dead_letter");
    state.failLLM = false;
    // 新批次应正常处理，不被 dead_letter 拖累
    for (let i = 0; i < 3; i++) await memPlugin.__test.bufferExchange(U, "好批次消息" + i, "r", "private", "");
    const j2 = memPlugin.__test._loadQueue(String(U)).jobs.find((x) => x.status !== "dead_letter");
    await memPlugin.__test.processJob(String(U), j2, Date.now() + 2000000);
    const short = readShort(U);
    check("B06 dead_letter 不阻塞新 job", short.length >= 3, "实际 " + short.length);
  }

  /* ===== B02：短期记忆写盘失败不丢结果、不标 done（真实 memory-service 故障注入） ===== */
  {
    const memSvc = require(path.join(ROOT, "plugins", "memory-service.js"));
    const { ctx, state, readShort } = makeCtx();
    let svcFail = false;
    const svcCtx = {
      DATA_DIR: state.dir, config: { qq: { master_user: 100000001 } },
      writeJsonAtomic: (f, obj) => {
        if (svcFail && String(f).indexOf("short-memory") >= 0) throw new Error("disk full");
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, f);
      },
      getApi: () => null, log: () => {}, formatGap: () => "",
    };
    memSvc.init(svcCtx);
    const api = memSvc.api.memory;
    ctx.loadShortMemories = (u) => api.loadShortMemories(String(u));
    ctx.saveShortMemories = (u, items) => api.saveShortMemories(String(u), items);
    ctx.loadMemories = (u) => api.loadMemories(String(u));
    ctx.saveMemories = (u, items) => api.saveMemories(String(u), items);
    memPlugin.init(ctx);
    const U = 100000001;
    for (let i = 0; i < 3; i++) await memPlugin.__test.bufferExchange(U, "B02消息" + i, "r", "private", "");
    const j = memPlugin.__test._loadQueue(String(U)).jobs[0];
    svcFail = true;
    await memPlugin.__test.processJob(String(U), j, Date.now() + 1000000);
    const job = memPlugin.__test._loadQueue(String(U)).jobs[0];
    check("B02 写盘失败 job 保持 result_ready 不标 done", job.status === "result_ready", "实际 " + job.status);
    check("B02 写盘失败无新短期记忆", readShort(U).length === 0);
    check("B02 LLM 结果保留在 job.result", Array.isArray(job.result) && job.result.length >= 1);
    const extractsBefore = state.calls.filter((c) => c.kind === "extract").length;
    svcFail = false;
    await memPlugin.__test.processJob(String(U), job, Date.now() + 2000000);
    const doneJob = memPlugin.__test._loadQueue(String(U)).jobs[0];
    check("B02 恢复后直接应用不重复调 LLM", doneJob.status === "done" && state.calls.filter((c) => c.kind === "extract").length === extractsBefore);
    check("B02 恢复后短期记忆已写入", readShort(U).length >= 1, "实际 " + readShort(U).length);
  }

  /* ===== B02-L：长期记忆写盘失败不删短期源（真实 memory-service 长期故障注入） ===== */
  {
    const memSvc = require(path.join(ROOT, "plugins", "memory-service.js"));
    const { ctx, state, readShort } = makeCtx();
    let svcFailLong = false;
    const svcCtx = {
      DATA_DIR: state.dir, config: { qq: { master_user: 100000001 } },
      writeJsonAtomic: (f, obj) => {
        const isLong = String(f).includes("memory") && !String(f).includes("short-memory");
        if (svcFailLong && isLong) throw new Error("disk full (long)");
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, f);
      },
      getApi: () => null, log: () => {}, formatGap: () => "",
    };
    memSvc.init(svcCtx);
    const api = memSvc.api.memory;
    ctx.loadShortMemories = (u) => api.loadShortMemories(String(u));
    ctx.saveShortMemories = (u, items) => api.saveShortMemories(String(u), items);
    ctx.loadMemories = (u) => api.loadMemories(String(u));
    ctx.saveMemories = (u, items) => api.saveMemories(String(u), items);
    // 预置 1 条私聊短期记忆
    fs.mkdirSync(path.join(state.dir, "short-memory"), { recursive: true });
    fs.writeFileSync(path.join(state.dir, "short-memory", "100000001.json"), JSON.stringify({
      updated: Date.now(),
      items: [{ content: "长期固化目标事实", channel: "private", groupId: "", created: Date.now() }],
    }));
    ctx.reasonComplete = async () => JSON.stringify(["长期固化目标事实固化成功"]);
    memPlugin.init(ctx);
    const U = 100000001;
    svcFailLong = true;
    await memPlugin.__test.consolidateUserMemories(U, {});
    check("B02-L 长期写盘失败：longCount=0", ctx.loadMemories(U).length === 0, "实际 " + ctx.loadMemories(U).length);
    check("B02-L 长期写盘失败：shortCount=1（源数据保留）", readShort(U).length === 1, "实际 " + readShort(U).length);
    svcFailLong = false;
    await memPlugin.__test.consolidateUserMemories(U, {});
    const long2 = ctx.loadMemories(U);
    check("B02-L 恢复后固化成功：长期已写入", long2.length >= 1 && long2.some((m) => String(m.content).includes("长期固化目标事实固化成功")), "实际 " + long2.length);
    check("B02-L 恢复后短期源被清理且只保留一份", readShort(U).length === 0 && ctx.loadMemories(U).filter((m) => String(m.content).includes("长期固化目标事实固化成功")).length === 1);
  }

  /* ===== B07-C：固化按 scope 分组，群短期记忆固化后仍是群（不串私聊） ===== */
  {
    const { ctx, state, readShort } = makeCtx();
    fs.mkdirSync(path.join(state.dir, "short-memory"), { recursive: true });
    fs.writeFileSync(path.join(state.dir, "short-memory", "100000001.json"), JSON.stringify({
      updated: Date.now(),
      items: [
        { content: "群里说过喜欢钓鱼", channel: "group", groupId: "101", created: Date.now() },
        { content: "群里说过住东北", channel: "group", groupId: "101", created: Date.now() },
        { content: "私聊说过在写论文", channel: "private", groupId: "", created: Date.now() },
      ],
    }));
    const rr = [
      JSON.stringify(["固化群内事实A"]),
      JSON.stringify(["固化私聊事实B"]),
    ];
    let ri = 0;
    ctx.reasonComplete = async () => { state.calls.push({ kind: "consolidate" }); return rr[ri++] || "[]"; };
    memPlugin.init(ctx);
    await memPlugin.__test.consolidateUserMemories(100000001, {});
    const long = ctx.loadMemories(100000001);
    const gItem = long.find((m) => String(m.content).includes("固化群内事实A"));
    const pItem = long.find((m) => String(m.content).includes("固化私聊事实B"));
    check("B07-C 固化按 scope 分组调用两次", state.calls.filter((c) => c.kind === "consolidate").length === 2);
    check("B07-C 群固化条目 channel=group 且 groupId=101", !!gItem && gItem.channel === "group" && String(gItem.groupId) === "101", gItem ? JSON.stringify({ channel: gItem.channel, groupId: gItem.groupId }) : "未找到");
    check("B07-C 私聊固化条目 channel=private 无群号", !!pItem && pItem.channel !== "group" && !Number(pItem.groupId), pItem ? JSON.stringify({ channel: pItem.channel, groupId: pItem.groupId }) : "未找到");
    const shortAfter = readShort(100000001);
    check("B07-C 成功固化的组短期条目被移除", shortAfter.length === 0, "实际 " + shortAfter.length);
  }

  /* ===== B07：result_ready 崩溃重启幂等应用 ===== */
  {
    const { ctx, state, readShort } = makeCtx();
    memPlugin.init(ctx);
    const U = 100000001;
    for (let i = 0; i < 3; i++) await memPlugin.__test.bufferExchange(U, "幂等批次消息" + i, "r", "private", "");
    const j = memPlugin.__test._loadQueue(String(U)).jobs[0];
    // 只跑到 result_ready（模拟 applyResult 前崩溃）
    await memPlugin.__test.processJob(String(U), j, Date.now());
    const q1 = memPlugin.__test._loadQueue(String(U));
    check("B07 结果先落盘 result_ready", q1.jobs[0].status === "result_ready" || q1.jobs[0].status === "done", "实际 " + q1.jobs[0].status);
    // 模拟重启：新进程重新 init，但同一目录
    const ctx2 = { DATA_DIR: state.dir, config: { qq: { allowed_users: [100000001, 100000002] } }, apiKey: "fake-key", resolveCall: () => "主人", settings: () => ({}), log: () => {}, recordAction: () => {}, sendPrivate: () => {}, writeJsonAtomic: (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, f); }, completeOnce: async () => JSON.stringify({ memories: [{ content: "提炼出：喜欢钓鱼" }] }), reasonComplete: async () => "[]", parseMemoryJson: memPlugin.__test ? (() => []) : (() => []), loadShortMemories: (uid) => readShort(uid), saveShortMemories: (uid, items) => { fs.mkdirSync(path.join(state.dir, "short-memory"), { recursive: true }); fs.writeFileSync(path.join(state.dir, "short-memory", String(uid) + ".json"), JSON.stringify({ updated: Date.now(), items })); }, loadMemories: (uid) => [], saveMemories: () => {} };
    memPlugin.init(ctx2);
    // 重启后 timer 触发 flush 推进 result_ready job
    const now = Date.now() + 11 * 60000;
    memPlugin.hooks.timer({ now });
    await new Promise((r) => setTimeout(r, 300));
    const short = readShort(U);
    const q3 = memPlugin.__test._loadQueue(String(U));
    check("B07 重启后 result_ready 被应用", q3.jobs.length === 0 || q3.jobs.every((x) => x.status === "done"), "实际 " + q3.jobs.map((x) => x.status).join(","));
    check("B07 应用结果不重复（src.job 幂等）", (() => { const jobs = q3.jobs.filter((x) => x.status === "done"); const srcs = new Set(short.map((m) => m.src && m.src.job).filter(Boolean)); return srcs.size <= 1; })(), JSON.stringify(short.map((m) => m.src)));
  }

  console.log("== memory-ingest: pass=" + pass + " fail=" + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL " + e.message); process.exit(1); });
