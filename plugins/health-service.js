/* 框架服务 · 健康快照 health（阶段1）：进程活着 ≠ 能力可用。
 * 把「进程在跑」翻译成「能力状态」：fresh / stale / degraded / offline / unknown。
 * 数据源：OneBot WS 状态（core.wsStatus）、身体 HTTP 探活（body api）、嵌入服务（embed.available）、
 *        预算档位（budget）、行动账本遗留（action-state.json open 集）、工具结果流水（tool-outcomes.jsonl）。
 * 消费：/体检 命令（主人）+ contextProvider（仅在异常时注入，避免正常时刷提示词）。 */
"use strict";
const fs = require("fs");
const path = require("path");

let _ctx = null;
const TTL_OK_MS = 5 * 60000;          // 5 分钟内见过成功信号 → fresh
const PROBE_EVERY_MS = 60000;          // timer 刷新节流
let _lastProbe = 0;
const snap = {};                        // name -> { status, since, evidence, extra }

/* classify 纯函数：把「最近成败信号」翻译成状态。signal = { lastOkAt, lastErrAt }，now 为当前时间 */
function classify(name, signal, now, ttlMs) {
  const ttl = ttlMs || TTL_OK_MS;
  const ok = Number(signal && signal.lastOkAt) || 0;
  const err = Number(signal && signal.lastErrAt) || 0;
  if (!ok && !err) return { status: "unknown", since: 0, evidence: name + " 尚无信号" };
  const okFresh = now - ok < ttl, errFresh = now - err < ttl;
  if (okFresh && !errFresh) return { status: "fresh", since: ok, evidence: name + " 最近正常" };
  if (!okFresh && errFresh) return { status: "offline", since: err, evidence: name + " 最近报错且无成功信号" };
  if (okFresh && errFresh) return { status: "degraded", since: err, evidence: name + " 时好时坏" };
  return { status: "stale", since: Math.max(ok, err), evidence: name + " 信号过期" };
}

function setSnap(name, s) { snap[name] = Object.assign({}, s, { updatedAt: Date.now() }); }
function getSnap(name) { return snap[name] || { status: "unknown", since: 0, evidence: name + " 尚无信号" }; }

/* 探活：异步收集各能力信号（不阻塞调用方，出错静默） */
async function probe() {
  const now = Date.now();
  try {
    const ws = (_ctx && typeof _ctx.wsStatus === "function") ? _ctx.wsStatus() : { state: "unknown" };
    if (ws.state === "open") setSnap("onebot", { status: "fresh", since: ws.since || now, evidence: "OneBot WS 已连接" });
    else if (ws.state === "connecting" || ws.state === "init") setSnap("onebot", { status: "unknown", since: ws.since || now, evidence: "OneBot WS " + ws.state + (ws.lastError ? "（" + String(ws.lastError).slice(0, 60) + "）" : "") });
    else setSnap("onebot", { status: "offline", since: ws.since || now, evidence: "OneBot WS 断开" + (ws.lastError ? "：" + String(ws.lastError).slice(0, 60) : "") });
  } catch (e) {}
  try {
    const body = _ctx.getApi("body");
    if (body && typeof body.status === "function") {
      const t0 = Date.now();
      const r = await body.status().catch(() => null);
      const online = !!(r && r.data && r.data.ok);
      setSnap("body", { status: online ? "fresh" : "offline", since: Date.now(), evidence: online ? ("身体在跑（pid " + (r.data.pid || "?") + "，" + (r.data.visible ? "显示中" : "已隐藏") + "）") : "身体没响应 http://127.0.0.1:4010（" + (Date.now() - t0) + "ms）" });
    } else setSnap("body", { status: "unknown", since: 0, evidence: "身体插件未加载" });
  } catch (e) { setSnap("body", { status: "offline", since: now, evidence: "身体探活异常：" + String(e && e.message).slice(0, 60) }); }
  try {
    const emb = _ctx.getApi("embed");
    if (emb) {
      const avail = typeof emb.available === "function" ? emb.available() : !!emb.available;
      setSnap("embed", { status: avail ? "fresh" : "offline", since: now, evidence: avail ? "语义检索可用" : "语义检索不可用（模型未加载，回退关键词）" });
    } else setSnap("embed", { status: "unknown", since: 0, evidence: "嵌入服务未加载" });
  } catch (e) {}
  try {
    const b = _ctx.getApi("budget");
    if (b) {
      const exhausted = b.isBudgetExhausted(), tier = b.budgetTier();
      setSnap("budget", { status: exhausted ? "degraded" : "fresh", since: now, evidence: "预算档位 " + tier + (exhausted ? "（已耗尽，只留本地只读工具）" : "") });
    } else setSnap("budget", { status: "unknown", since: 0, evidence: "预算服务未加载" });
  } catch (e) {}
  try {
    const ores = openCount();
    if (ores.error) setSnap("ledger", { status: "unknown", since: now, evidence: "行动账本不可读：" + String(ores.error).slice(0, 60) });
    else setSnap("ledger", { status: ores.count > 0 ? "stale" : "fresh", since: now, evidence: ores.count > 0 ? ("行动账本有 " + ores.count + " 条未闭环（下次重启会转 unknown）") : "行动账本无遗留 open" });
  } catch (e) {}
  try {
    const outs = typeof _ctx.loadToolOutcomes === "function" ? _ctx.loadToolOutcomes(60) : [];
    const recent = outs.filter((o) => o && now - (o.ts || 0) < 3600e3);
    const fails = recent.filter((o) => o.status === "failed").length;
    const unks = recent.filter((o) => o.status !== "failed" && o.status !== "succeeded").length;
    let ts = "unknown", ev = "近 1h 无工具调用记录";
    if (recent.length) {
      if (fails > 0) { ts = "degraded"; ev = "近 1h 工具调用 " + recent.length + " 次，失败 " + fails + " 次"; }
      else if (unks > 0) { ts = "stale"; ev = "近 1h 工具调用 " + recent.length + " 次，其中 " + unks + " 次结果不明（需人工确认，不算正常）"; }
      else { ts = "fresh"; ev = "近 1h 工具调用 " + recent.length + " 次，全部成功"; }
    }
    setSnap("tools", { status: ts, since: now, evidence: ev });
  } catch (e) {}
}

function openCount() {
  try {
    const p = path.join(_ctx.DATA_DIR, "action-state.json");
    if (!fs.existsSync(p)) return { count: 0 };
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!d || typeof d !== "object" || d.open === undefined) return { count: 0, error: "结构异常" };
    return { count: Object.keys(d.open || {}).length };
  } catch (e) { return { count: 0, error: String((e && e.message) || e).slice(0, 60) }; }
}

function allSnapshot() {
  return ["onebot", "body", "embed", "budget", "ledger", "tools"].map((k) => Object.assign({ name: k }, getSnap(k)));
}
function problems() { return allSnapshot().filter((s) => s.status !== "fresh" && s.status !== "unknown"); }

module.exports = {
  name: "health",
  displayName: "健康快照",
  description: "进程活着 ≠ 能力可用：把 OneBot/身体/嵌入/预算/账本/工具流水翻译成 fresh/stale/degraded/offline/unknown，/体检 可查",
  system: true,
  userScoped: false,   // 纯系统级：只读探活，不按人处理数据/发消息
  requires: [],
  version: "1.0.0",
  apiSpec: {
    health: {
      snapshot: { input: "无", output: "能力状态数组", sideEffect: "只读" },
      problems: { input: "无", output: "非 fresh 能力列表", sideEffect: "只读" },
      probe: { input: "无", output: "主动探活并刷新快照", sideEffect: "刷新内存快照" },
    },
  },
  api: {
    health: {
      snapshot: () => allSnapshot(),
      problems: () => problems(),
      probe: () => probe(),
    },
  },
  init(ctx) {
    _ctx = ctx;
    /* 启动后先探一轮，让 /体检 不是全 unknown */
    probe().catch(() => {});
  },
  commands: [{
    key: "/体检",
    regex: /^\/体检/,
    handler(msg) {
      if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "（体检报告只有主人能看哦）"); return; }
      probe().then(() => {
        const lines = allSnapshot().map((s) => `· ${s.name}: ${s.status} — ${s.evidence}`);
        _ctx.sendPrivate(msg.userId, "体检报告：\n" + lines.join("\n"));
      }).catch(() => {});
    },
  }],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (now - _lastProbe < PROBE_EVERY_MS) return;
      _lastProbe = now;
      probe().catch(() => {});
    },
  },
  contextProvider(payload) {
    const bad = problems();
    if (!bad.length) return "";
    return "【健康】" + bad.map((s) => s.name + ":" + s.status).join("，");
  },
  __test: { classify, probe, openCount, allSnapshot, problems, _setSnap: setSnap, _snap: snap },
};
