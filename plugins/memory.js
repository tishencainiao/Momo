/* 插件：记忆（短期提炼 + 长期固化；数据层存取在内核）
 * v2.1.0/WP1 连续存在加固：exchange 入队即持久化（data/ingest/queue-<uid>.json），
 * 批 key=userId+channel+groupId 绝不混批；job 状态机 pending→extracting→result_ready→done / dead_letter；
 * LLM 成功后先落盘结果再合并（崩溃可幂等重放，条目带 src.job）；调度时间落盘 data/ingest/schedule.json。
 * 思路借鉴（docs/attribution.md 已登记）：transactional outbox / write-ahead log / SQS 可见性超时重投。 */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const EXTRACT_BATCH = 3;
const INGEST_DIR = "ingest";
const MAX_ATTEMPTS = Number(process.env.MOMO_INGEST_MAX_ATTEMPTS) || 5;
const RETRY_BASE_MS = 60 * 1000;
const CONSOLIDATE_FIRST_MS = 6 * 3600e3;
const CONSOLIDATE_EVERY_MS = 24 * 3600e3;
const FLUSH_EVERY_MS = 10 * 60000;

/* 内存缓存只是队列文件的镜像，文件是唯一真相 */
const _queues = new Map(); /* uid -> { exchanges:[], jobs:[] } */
let _sched = null;        /* { firstBootTs, lastFlush, lastConsolidate } */
/* ---------- 持久化队列（WP1） ---------- */
function _ingestDir() { const d = path.join(_ctx.DATA_DIR, INGEST_DIR); fs.mkdirSync(d, { recursive: true }); return d; }
function _qPath(uid) { return path.join(_ingestDir(), "queue-" + String(uid).replace(/[^\w-]/g, "_") + ".json"); }
function _sPath() { return path.join(_ingestDir(), "schedule.json"); }
function _newId(p) { return p + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6); }
function _san(e) { return String((e && e.message) || e || "").replace(/[\r\n]+/g, " ").slice(0, 120); }
function _loadQueue(uid) {
  if (_queues.has(uid)) return _queues.get(uid);
  let q = { exchanges: [], jobs: [] };
  try { const d = JSON.parse(fs.readFileSync(_qPath(uid), "utf8")); q = { exchanges: Array.isArray(d.exchanges) ? d.exchanges : [], jobs: Array.isArray(d.jobs) ? d.jobs : [] }; } catch (e) {}
  _queues.set(uid, q);
  return q;
}
function _persistQueue(uid, q) { _ctx.writeJsonAtomic(_qPath(uid), q); _queues.set(uid, q); }
function _loadSched() {
  if (_sched) return _sched;
  let s = { firstBootTs: Date.now(), lastFlush: Date.now(), lastConsolidate: 0 };
  try { const d = JSON.parse(fs.readFileSync(_sPath(), "utf8")); s = { firstBootTs: Number(d.firstBootTs) || s.firstBootTs, lastFlush: Number(d.lastFlush) || s.lastFlush, lastConsolidate: Number(d.lastConsolidate) || 0 }; } catch (e) {}
  _sched = s;
  try { _ctx.writeJsonAtomic(_sPath(), s); } catch (e) {}
  return _sched;
}
function _persistSched() { try { _ctx.writeJsonAtomic(_sPath(), _sched); } catch (e) { _ctx.log("warn", "记忆调度时间落盘失败: " + _san(e)); } }
function _listQueuedUids() {
  try { return fs.readdirSync(_ingestDir()).filter((f) => f.startsWith("queue-") && f.endsWith(".json")).map((f) => f.replace(/^queue-/, "").replace(/\.json$/, "")); } catch (e) { return []; }
}
function memoryExtractPrompt(existing, batch, call) {
  const c = call || "主人";
  const convo = batch.map((b) => `${c}：${b.u}\n大肥鱼：${b.r}`).join("\n");
  return `你是记忆管理助手。请从下面「${c}与大肥鱼」的这几段对话里，提取值得长期记住的、关于${c}的事实。
规则：
- 只提取明确、稳定、有长期价值的事实（姓名/昵称、喜好、厌恶、习惯、职业、重要经历、人际关系、约定等）。
- 偏好、习惯、约定、重要信息都尽量提取，宁多勿漏，哪怕是一条小事实也要记。
- **不记临时情绪和一次性事件**：如"今天心情不好""刚吃了饭""正在打游戏""今天加班"这类只对当下成立、没有长期价值的话，一律跳过。
- 只跳过纯问候、纯表情、一次性寒暄。
- 与「已有记忆」重复或已被覆盖的不要输出；若新事实与某条旧记忆冲突，输出新事实即可。
- 没有值得记的就返回空数组。
- 只输出 JSON，不要任何解释。
已有记忆：
${existing || "（暂无）"}
对话：
${convo}
输出格式：{"memories":[{"content":"一句话事实"}]}`;
}

/* 入队：立即落盘（失败报错不清内存）；同 userId+channel+groupId 攒够 EXTRACT_BATCH 段成 job（绝不混批） */
async function bufferExchange(userId, text, reply, channel, groupId) {
  const uid = String(userId);
  const q = _loadQueue(uid);
  const ch = channel || "private";
  const gid = groupId ? String(groupId) : "";
  const ex = { id: _newId("ex-"), u: String(text || "").slice(0, 2000), r: String(reply || "").slice(0, 4000), channel: ch, groupId: gid, ts: Date.now() };
  try { _persistQueue(uid, { exchanges: q.exchanges.concat([ex]), jobs: q.jobs }); } catch (e) { _ctx.log("warn", "记忆 exchange 落盘失败（本段不入账，下轮消息重试）: " + _san(e)); return null; }
  const same = q.exchanges.concat([ex]).filter((x) => x.channel === ch && x.groupId === gid);
  if (same.length < EXTRACT_BATCH) return null;
  const batch = same.slice(0, EXTRACT_BATCH);
  const job = { id: _newId("job-"), scope: { channel: ch, groupId: gid }, exs: batch, status: "pending", attempts: 0, lastError: "", nextRetryAt: 0, result: null, updatedAt: Date.now() };
  try { _persistQueue(uid, { exchanges: q.exchanges.concat([ex]).filter((x) => !batch.some((b) => b.id === x.id)), jobs: q.jobs.concat([job]) }); } catch (e) { _ctx.log("warn", "记忆 job 创建落盘失败: " + _san(e)); return null; }
  return job;
}
function fingerprint(s) {
  return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, "");
}
/* 作用域归一：历史条目无 channel 按 private 处理，避免旧 "" 与新 "private" 撞车或漏判 */
function normChannel(c) { return c === "group" ? "group" : "private"; }
function mergeMemories(items, newOnes, channel, groupId, cap, jobId) {
  /* 纯函数：不改动传入数组。去重 key=fingerprint|归一channel|groupId：相同文本来自不同作用域各自独立；
   * jobId 传入时新条目带 src.job，同 job 重放不重复计数（幂等） */
  const limit = Number(cap) > 0 ? Number(cap) : 200;
  const out = Array.isArray(items) ? items.slice() : [];
  const seen = new Map();
  const nc = (c) => (c === "group" ? "group" : "private");
  for (const i of out) { const f = fingerprint(i.content); if (f) seen.set(f + "|" + nc(i.channel) + "|" + (i.groupId ? String(i.groupId) : ""), i); }
  const ch = channel || "";
  const gid = groupId ? String(groupId) : "";
  for (const c of newOnes) {
    const s = String(c || "").trim();
    if (!s || s.length > 300) continue;
    const f = fingerprint(s);
    if (!f) continue;
    const k = f + "|" + nc(ch) + "|" + gid;
    if (seen.has(k)) {
      const old = seen.get(k);
      if (!(jobId && old.src && old.src.job === jobId)) old.importance = (old.importance || 1) + 1;
      continue;
    }
    const item = { content: s, created: Math.floor(Date.now() / 1000), channel: ch, groupId: gid, importance: 1 };
    if (jobId) item.src = { job: jobId };
    seen.set(k, item);
    out.push(item);
  }
  if (out.length > limit) return out.slice(-limit);
  return out;
}
/* 遗忘机制：超 60 天且从未被访问的低价值记忆自动清除（主人教的 source=taught 永不遗忘）
 * 清除前先把原文归档到 data/archive/memory-<uid>-YYYY-MM.jsonl，细节不物理消失 */
function pruneMemories(items, uid) {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - 60 * 86400;
  const before = items.length;
  const kept = items.filter((m) => {
    if (m.source === "taught") return true;
    if (!m.created) return true;
    if (m.created > cutoff) return true;
    return (m.hits || 0) > 0;
  });
  const removed = items.filter((m) => !kept.includes(m));
  if (removed.length) {
    try { require("../self-archive").appendArchive(_ctx.DATA_DIR, "memory-" + (uid || "all"), removed); } catch (e) {}
    _ctx.log("info", `记忆遗忘：归档 ${removed.length} 条（超 60 天且从未被访问，已存 data/archive/）`);
  }
  return kept;
}
/* 防捏造：Momo 第一人称的"动作/能力"自述不许变成"关于对方的事实"
 * （2026-11-05 事故：提炼出「主人…接受大肥鱼放轻音乐助眠」，把她的表演写成了关于主人的长期记忆） */
const AGENT_DEED_RE = /(大肥鱼|Momo)[^。；]{0,12}(放|唱|播|给|发|送|下载)|接受[^。；]{0,8}(放|听)|我能(放|唱|播)|我(已经)?(放|唱|播)了/;
function dropAgentDeeds(arr) {
  const kept = [];
  let dropped = 0;
  for (const it of arr) {
    const c = String((it && it.content) || it || "");
    if (AGENT_DEED_RE.test(c)) { dropped++; continue; }
    kept.push(it);
  }
  return { kept, dropped };
}

/* 应用结果：合并入短期记忆并标 done；带 src.job 幂等（重放不重复写、不重复 importance） */
async function applyResult(uid, job) {
  const q = _loadQueue(uid);
  const j = q.jobs.find((x) => x.id === job.id);
  if (!j || j.status === "done") return;
  const items = _ctx.loadShortMemories(uid);
  const applied = items.some((m) => m.src && m.src.job === j.id);
  if (!applied && Array.isArray(j.result) && j.result.length) {
    const before = items.length;
    const merged = mergeMemories(items, j.result, j.scope.channel, j.scope.groupId, 400, j.id);
    if (merged.length !== before) {
      try {
        _ctx.saveShortMemories(uid, merged);
      } catch (e) {
        /* B02 返修：写盘失败不得标 done；保留 result_ready（LLM 结果已在 j.result 落盘），
           恢复后直接重试应用，不重复调用 LLM。 */
        j.status = "result_ready";
        j.lastError = "短期记忆写盘失败: " + _san(e);
        j.updatedAt = Date.now();
        try { _persistQueue(uid, q); } catch (e2) { _ctx.log("warn", "记忆 job 失败状态落盘失败: " + _san(e2)); }
        _ctx.log("warn", "记忆应用写盘失败 user=" + uid + " job=" + j.id + ": " + j.lastError);
        return;
      }
      _ctx.log("info", "短期记忆提炼 user=" + uid + " job=" + j.id + ": 新增 " + (merged.length - before) + " 条（共 " + merged.length + " 条）");
    }
  }
  j.status = "done";
  j.updatedAt = Date.now();
  try { _persistQueue(uid, q); } catch (e) { _ctx.log("warn", "记忆 job 完成状态落盘失败: " + _san(e)); }
}
/* 处理一个 job：状态机推进 + 崩溃恢复 + 有限重试退避（日志只含 ID/计数/脱敏错误，不含对话正文） */
async function processJob(uid, job, nowMs) {
  const q = _loadQueue(uid);
  const now = Number(nowMs) || Date.now();
  const j = q.jobs.find((x) => x.id === job.id);
  if (!j || j.status === "done" || j.status === "dead_letter") return;
  if (j.status === "result_ready" || j.status === "applying") { await applyResult(uid, j); return; }
  /* 重启恢复：crash 在 LLM 调用途中的 extracting/applying 回到 pending 重试（合并侧有 src.job 幂等保护） */
  if (j.status !== "pending") { j.status = "pending"; j.updatedAt = Date.now(); }
  if (j.attempts >= MAX_ATTEMPTS) {
    j.status = "dead_letter";
    j.updatedAt = Date.now();
    try { _persistQueue(uid, q); } catch (e) {}
    _ctx.log("warn", "记忆 job " + j.id + " 达最大重试次数（" + MAX_ATTEMPTS + "），进入 dead_letter；scope=" + j.scope.channel + "/" + j.scope.groupId + "，exchanges=" + j.exs.length + " 段已保留");
    return;
  }
  if (j.attempts > 0 && now < (j.nextRetryAt || 0)) return; /* 退避未到 */
  if (!_ctx.apiKey) return;
  if (!Array.isArray(j.exs) || !j.exs.length) { j.status = "done"; try { _persistQueue(uid, q); } catch (e) {} return; }
  j.status = "extracting";
  j.updatedAt = Date.now();
  try { _persistQueue(uid, q); } catch (e) { _ctx.log("warn", "记忆 job 状态落盘失败: " + _san(e)); }
  try {
    const items = _ctx.loadShortMemories(uid);
    const existing = items.map((i) => "- " + i.content).join("\\n");
    const call = _ctx.resolveCall(uid);
    const prompt = memoryExtractPrompt(existing, j.exs.map((x) => ({ u: x.u, r: x.r })), call);
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], _ctx.settings(), 800, 0.2);
    const arr = _ctx.parseMemoryJson(raw);
    _ctx.log("info", "记忆提炼 user=" + uid + " job=" + j.id + ": 模型返回长度=" + String(raw).length + "，解析 " + arr.length + " 条");
    const _f = dropAgentDeeds(arr);
    if (_f.dropped) _ctx.log("warn", "记忆提炼-丢弃 " + _f.dropped + " 条「Momo 自己的动作」自述");
    j.result = _f.kept;
    j.status = "result_ready"; /* LLM 成功先落盘结果，再合并（此间崩溃重启可幂等完成） */
    j.updatedAt = Date.now();
    try { _persistQueue(uid, q); } catch (e) { _ctx.log("warn", "记忆提炼结果落盘失败: " + _san(e)); }
    await applyResult(uid, j);
  } catch (e) {
    j.status = "pending";
    j.attempts += 1;
    j.lastError = _san(e);
    j.nextRetryAt = now + RETRY_BASE_MS * Math.pow(2, Math.min(j.attempts, 6));
    j.updatedAt = Date.now();
    try { _persistQueue(uid, q); } catch (e2) { _ctx.log("warn", "记忆 job 失败状态落盘失败: " + _san(e2)); }
    _ctx.log("warn", "记忆提炼失败 user=" + uid + " job=" + j.id + " 第 " + j.attempts + " 次: " + j.lastError);
  }
}
async function consolidateUserMemories(userId, settings) {
  if (!_ctx.apiKey) return;
  try {
    const fresh = _ctx.loadShortMemories(userId);
    if (!fresh.length) return;
    const call = _ctx.resolveCall(userId);
    /* B07 返修：按 channel+groupId 分组，分别固化、分别传真实 scope；不得合并后统一写成 private */
    const groups = new Map();
    for (const m of fresh) {
      const isG = String(m.channel || "") === "group" && Number(m.groupId) > 0;
      const key = isG ? "group:" + Number(m.groupId) : "private";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const doneGroups = [];
    for (const [key, items] of groups) {
      const isG = key !== "private";
      const gid = isG ? Number(key.slice(6)) : 0;
      const scopeNote = isG ? "群里（群号 " + gid + "）" : "私聊";
      const prompt = "你是记忆固化助手。下面是 Momo 短期记住的一些关于「" + call + "」在" + scopeNote + "的零散事实。请从中挑出「值得长期记住」的稳定事实（偏好、习惯、姓名、重要约定、重要经历等），输出成 JSON 字符串数组。丢弃临时的、一次性的、没长期价值的（如\"正在做某事\"、\"今天吃了什么\"）。\n短期记忆：\n" + items.map((m) => "- " + m.content).join("\n");
      const raw = await _ctx.reasonComplete([{ role: "user", content: prompt }], settings, 800, { noThink: true });
      _ctx.log("info", "记忆固化-模型返回(" + key + "): " + String(raw).slice(0, 100).replace(/\n/g, " "));
      const arr = _ctx.parseMemoryJson(raw);
      if (!arr.length) continue;
      const long = _ctx.loadMemories(userId);
      const before = long.length;
      const merged = mergeMemories(long, arr, isG ? "group" : "private", isG ? gid : undefined, 400);
      const pruned = pruneMemories(merged, userId);
      try {
        _ctx.saveMemories(userId, pruned);
      } catch (e) {
        /* B02 返修：长期写盘失败不删对应短期记忆，下轮再试 */
        _ctx.log("warn", "记忆固化长期写盘失败 user=" + userId + " scope=" + key + ": " + _san(e));
        continue;
      }
      _ctx.log("info", "记忆固化 user=" + userId + " scope=" + key + ": 短期 " + items.length + " 条 → 长期新增 " + (merged.length - before) + " 条");
      doneGroups.push(key);
    }
    /* 只删「固化成功组」的短期条目；写盘失败组保留（下轮再试） */
    if (doneGroups.length) {
      const ok = new Set(doneGroups);
      _ctx.saveShortMemories(userId, fresh.filter((m) => {
        const isG = String(m.channel || "") === "group" && Number(m.groupId) > 0;
        const key = isG ? "group:" + Number(m.groupId) : "private";
        return !ok.has(key);
      }));
    }
  } catch (e) { _ctx.log("warn", "记忆固化失败 user=" + userId + ": " + _san(e)); }
}
async function consolidateAllMemories() {
  const settings = _ctx.settings();
  const users = new Set((_ctx.config.qq && _ctx.config.qq.allowed_users) || []);
  for (const u of users) await consolidateUserMemories(u, settings);
}


/* WP5：只读状态（启动恢复清单用，绝不改变 v2.1 提交流程） */
function status() {
  const out = { pending: 0, failed: 0, dead: 0, exchanges: 0 };
  try {
    for (const uid of _listQueuedUids()) {
      const q = _loadQueue(uid);
      if (q) {
        out.exchanges += (q.exchanges || []).length;
        for (const j of q.jobs || []) {
          if (j.status === "dead_letter") out.dead++;
          else if (j.status === "failed") out.failed++;
          else out.pending++;
        }
      }
    }
  } catch (e) { out.error = String((e && e.message) || e).slice(0, 80); }
  return out;
}

module.exports = {
  name: "memory",
  displayName: "记忆",
  description: "短期提炼 + 长期固化（数据层存取在内核；摄入队列持久化+幂等恢复）",
  userScoped: true,
  permissions: ["DATA_DIR", "apiKey", "completeOnce", "config", "loadMemories", "loadShortMemories", "log", "parseMemoryJson", "reasonComplete", "recordAction", "resolveCall", "saveMemories", "saveShortMemories", "sendPrivate", "settings"],
  version: "1.2.0",
  init(ctx) { _ctx = ctx; _queues.clear(); _sched = null; },
  apiSpec: {"memoryOps":{"dropAgentDeeds":{"input":"","output":"","sideEffect":""},"mergeMemories":{"input":"","output":"","sideEffect":""},"pruneMemories":{"input":"","output":"","sideEffect":""},"consolidateUserMemories":{"input":"","output":"","sideEffect":""},"status":{"input":"","output":"","sideEffect":""}}},

  api: { memoryOps: { dropAgentDeeds, mergeMemories, pruneMemories, consolidateUserMemories, status } },
  __test: { bufferExchange, processJob, applyResult, mergeMemories, fingerprint, dropAgentDeeds, normChannel, consolidateUserMemories, _loadQueue, _persistQueue, _loadSched, _san, MAX_ATTEMPTS },
  tools: [
    {
      def: { type: "function", function: { name: "memory_view", description: "查看记住的关于某人的长期记忆。当对方说「你记得我什么」「看看你记得我啥」「我的记忆」时调用。", parameters: { type: "object", properties: {} } } },
      handler(args, info) {
        const long = _ctx.loadMemories(info.userId);
        if (!long.length) return "（我暂时还没记住关于你的事）";
        const list = long.map((m, i) => `${i + 1}. ${m.content}`).join("\n");
        return `我记住的关于你的事：\n${list}\n\n（想改/删就说「改第N条记忆为…」或「忘掉第N条记忆」）`;
      },
    },
    {
      def: { type: "function", function: { name: "memory_forget", description: "删除一条记忆。当对方说「忘掉XX」「别记这个」「删掉第N条记忆」时调用。", parameters: { type: "object", properties: { index: { type: "number", description: "记忆序号（1 开始）" } }, required: ["index"] } } },
      handler(args, info) {
        const long = _ctx.loadMemories(info.userId);
        const idx = Number(args.index);
        if (isNaN(idx) || idx < 1 || idx > long.length) return "（没找到这条记忆，说「记忆」看清单）";
        const removed = long[idx - 1].content;
        long.splice(idx - 1, 1);
        _ctx.saveMemories(info.userId, long);
        _ctx.log("info", `删除记忆 user=${info.userId}: ${removed.slice(0, 40)}`);
        try { _ctx.recordAction({ action: "memory_forget", by: info.userId, detail: String(removed).slice(0, 60), ok: true }); } catch (e) {}
        return `已忘掉：${removed}`;
      },
    },
    {
      def: { type: "function", function: { name: "memory_edit", description: "更正一条记忆。当对方说「这个记错了」「改一下第N条记忆」时调用。", parameters: { type: "object", properties: { index: { type: "number", description: "记忆序号（1 开始）" }, content: { type: "string", description: "更正后的正确内容" } }, required: ["index", "content"] } } },
      handler(args, info) {
        const long = _ctx.loadMemories(info.userId);
        const idx = Number(args.index);
        if (isNaN(idx) || idx < 1 || idx > long.length) return "（没找到这条记忆）";
        const nv = String(args.content || "").trim().slice(0, 300);
        if (!nv) return "（更正内容为空）";
        long[idx - 1].content = nv;
        _ctx.saveMemories(info.userId, long);
        _ctx.log("info", `更正记忆 user=${info.userId}: ${nv.slice(0, 40)}`);
        try { _ctx.recordAction({ action: "memory_edit", by: info.userId, detail: String(nv).slice(0, 60), ok: true }); } catch (e) {}
        return `已更正为：${nv}`;
      },
    },
  ],
  commands: [
    {
      key: "/记忆",
      regex: /^\/记忆/,
      handler(msg) {
        const arg = msg.text.replace(/^\/记忆\s*/, "").trim();
        const long = _ctx.loadMemories(msg.userId);
        if (/^(删|忘|forget)/.test(arg)) {
          const n = Number((arg.match(/(\d+)/) || [])[1]);
          if (!n || n < 1 || n > long.length) { _ctx.sendPrivate(msg.userId, "要说「记忆 删除 N」哦"); return; }
          const removed = long[n - 1].content;
          long.splice(n - 1, 1);
          _ctx.saveMemories(msg.userId, long);
          _ctx.sendPrivate(msg.userId, `已忘掉：${removed}`);
          return;
        }
        if (/^(改|更正)/.test(arg)) {
          const n = Number((arg.match(/(\d+)/) || [])[1]);
          const rest = arg.replace(/^(改|更正)\s*\d+\s*/, "").trim();
          if (!n || !rest || n < 1 || n > long.length) { _ctx.sendPrivate(msg.userId, "要说「记忆 改 N 新内容」哦"); return; }
          long[n - 1].content = rest.slice(0, 300);
          _ctx.saveMemories(msg.userId, long);
          _ctx.sendPrivate(msg.userId, `已更正为：${rest.slice(0, 300)}`);
          return;
        }
        if (!long.length) { _ctx.sendPrivate(msg.userId, "我暂时还没记住关于你的事～"); return; }
        const list = long.map((m, i) => `${i + 1}. ${m.content}`).join("\n");
        _ctx.sendPrivate(msg.userId, `我记住的关于你的事：\n${list}`);
      },
    },
  ],
  hooks: {
    reply(payload) {
      const { userId, text, reply, channel, groupId } = payload || {};
      if (!userId || !text || !reply) return;
      const uid = String(userId);
      bufferExchange(userId, text, reply, channel, groupId).then((job) => {
        if (job) processJob(uid, job).catch((e) => _ctx.log("warn", "记忆 job 处理异常 user=" + uid + " job=" + job.id + ": " + _san(e)));
      }).catch((e) => _ctx.log("warn", "记忆 exchange 入队异常: " + _san(e)));
    },
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      const s = _loadSched();
      let dirty = false;
      /* 每 10 分钟把残留不足一批的 exchange 按作用域组批（持久化），并推进所有可推进的 job */
      if (now - s.lastFlush >= FLUSH_EVERY_MS) {
        s.lastFlush = now;
        dirty = true;
        const uids = _listQueuedUids();
        for (const uid of uids) {
          const q = _loadQueue(uid);
          const byScope = new Map();
          for (const x of q.exchanges) { const k = x.channel + "|" + x.groupId; if (!byScope.has(k)) byScope.set(k, []); byScope.get(k).push(x); }
          let nextEx = q.exchanges;
          let nextJobs = q.jobs;
          for (const arr of byScope.values()) {
            if (!arr.length) continue;
            const job = { id: _newId("job-"), scope: { channel: arr[0].channel, groupId: arr[0].groupId }, exs: arr, status: "pending", attempts: 0, lastError: "", nextRetryAt: 0, result: null, updatedAt: Date.now() };
            nextEx = nextEx.filter((x) => !arr.some((b) => b.id === x.id));
            nextJobs = nextJobs.concat([job]);
          }
          if (nextEx.length !== q.exchanges.length || nextJobs.length !== q.jobs.length) {
            try { _persistQueue(uid, { exchanges: nextEx, jobs: nextJobs }); } catch (e) { _ctx.log("warn", "记忆 flush 组批落盘失败 user=" + uid + ": " + _san(e)); continue; }
          }
        }
        for (const uid of uids) {
          const q = _loadQueue(uid);
          for (const j of q.jobs.slice()) processJob(uid, j, now).catch((e) => _ctx.log("warn", "记忆 job 处理异常 user=" + uid + " job=" + j.id + ": " + _san(e)));
        }
      }
      if (dirty) _persistSched();
      const due = s.lastConsolidate === 0 ? (now - s.firstBootTs >= CONSOLIDATE_FIRST_MS) : (now - s.lastConsolidate >= CONSOLIDATE_EVERY_MS);
      if (!due) return;
      s.lastConsolidate = now;
      _persistSched();
      consolidateAllMemories().catch((e) => _ctx.log("warn", "记忆固化失败: " + _san(e)));
    },
  },
};
