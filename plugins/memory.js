/* 插件：记忆（短期提炼 + 长期固化；数据层存取在内核） */
let _ctx = null;

const pendingBatches = new Map();
const EXTRACT_BATCH = 3;
let lastFlush = Date.now();

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

/* 攒够 EXTRACT_BATCH 段返回整批，否则返回 null */
function bufferExchange(userId, text, reply, channel, groupId) {
  const key = String(userId);
  const arr = pendingBatches.get(key) || [];
  arr.push({ u: text, r: reply, channel: channel || "private", groupId: groupId ? String(groupId) : "" });
  pendingBatches.set(key, arr);
  if (arr.length >= EXTRACT_BATCH) {
    pendingBatches.set(key, []);
    return arr;
  }
  return null;
}
function fingerprint(s) {
  return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, "");
}
function mergeMemories(items, newOnes, channel, groupId, cap) {
  /* 纯函数：不改动传入数组（之前原地 push 导致「合并后长度恒等于原长度」，保存永远被跳过） */
  const limit = Number(cap) > 0 ? Number(cap) : 200;
  const out = Array.isArray(items) ? items.slice() : [];
  const seen = new Map();
  for (const i of out) { const f = fingerprint(i.content); if (f) seen.set(f, i); }
  for (const c of newOnes) {
    const s = String(c || "").trim();
    if (!s || s.length > 300) continue;
    const f = fingerprint(s);
    if (!f) continue;
    if (seen.has(f)) { seen.get(f).importance = (seen.get(f).importance || 1) + 1; continue; }
    const item = { content: s, created: Math.floor(Date.now() / 1000), channel: channel || "", groupId: groupId ? String(groupId) : "", importance: 1 };
    seen.set(f, item);
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

async function extractMemoriesBatch(userId, batch, settings) {
  if (!_ctx.apiKey || !batch || !batch.length) return;
  try {
    _ctx.log("info", `记忆提炼-开始 user=${userId}（${batch.length} 段对话）`);
    const items = _ctx.loadShortMemories(userId);
    const existing = items.map((i) => "- " + i.content).join("\n");
    const call = _ctx.resolveCall(userId);
    const prompt = memoryExtractPrompt(existing, batch, call);
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 800, 0.2);
    _ctx.log("info", `记忆提炼-模型返回长度=${String(raw).length}${String(raw).length ? "：" + String(raw).slice(0, 80).replace(/\n/g, " ") : "（空）"}`);
    const arr = _ctx.parseMemoryJson(raw);
    _ctx.log("info", `记忆提炼-解析条数=${arr.length}`);
    if (!arr.length) return;
    const _f = dropAgentDeeds(arr);
    if (_f.dropped) _ctx.log("warn", `记忆提炼-丢弃 ${_f.dropped} 条「Momo 自己的动作」自述（不许当关于对方的事实）`);
    if (!_f.kept.length) return;
    const before = items.length;
    const merged = mergeMemories(items, _f.kept, batch[0] && batch[0].channel, batch[0] && batch[0].groupId);
    _ctx.log("info", `记忆提炼-合并后=${merged.length}（原来 ${before}）`);
    if (merged.length === before) return;
    _ctx.saveShortMemories(userId, merged);
    _ctx.log("info", `短期记忆提炼 user=${userId}: 新增 ${merged.length - before} 条（共 ${merged.length} 条）`);
  } catch (e) { _ctx.log("warn", "记忆提炼失败: " + e.message.slice(0, 160)); }
}
async function consolidateUserMemories(userId, settings) {
  if (!_ctx.apiKey) return;
  try {
    const fresh = _ctx.loadShortMemories(userId);
    if (!fresh.length) return;
    const call = _ctx.resolveCall(userId);
    const prompt = `你是记忆固化助手。下面是 Momo 短期记住的一些关于「${call}」的零散事实。请从中挑出「值得长期记住」的稳定事实（偏好、习惯、姓名、重要约定、重要经历等），输出成 JSON 字符串数组。丢弃临时的、一次性的、没长期价值的（如"正在做某事"、"今天吃了什么"）。\n短期记忆：\n${fresh.map((m) => "- " + m.content).join("\n")}`;
    const raw = await _ctx.reasonComplete([{ role: "user", content: prompt }], settings, 800, { noThink: true });
    _ctx.log("info", `记忆固化-模型返回: ${String(raw).slice(0, 100).replace(/\n/g, " ")}`);
    const arr = _ctx.parseMemoryJson(raw);
    if (arr.length) {
      const long = _ctx.loadMemories(userId);
      const before = long.length;
      const merged = mergeMemories(long, arr, undefined, undefined, 400);
      const pruned = pruneMemories(merged, userId);
      _ctx.saveMemories(userId, pruned);
      _ctx.log("info", `记忆固化 user=${userId}: 短期 ${fresh.length} 条 → 长期新增 ${merged.length - before} 条`);
      const moved = new Set(arr.map((x) => String(x).trim()));
      _ctx.saveShortMemories(userId, fresh.filter((m) => !moved.has(String(m.content).trim())));
    }
  } catch (e) { _ctx.log("warn", "记忆固化失败 user=" + userId + ": " + e.message.slice(0, 160)); }
}
async function consolidateAllMemories() {
  const settings = _ctx.settings();
  const users = new Set((_ctx.config.qq && _ctx.config.qq.allowed_users) || []);
  for (const u of users) await consolidateUserMemories(u, settings);
}

const startTs = Date.now();
let lastConsolidate = 0;

module.exports = {
  name: "memory",
  version: "1.1.0",
  init(ctx) { _ctx = ctx; },
  api: { memory: { dropAgentDeeds, mergeMemories, pruneMemories, extractMemoriesBatch, consolidateUserMemories } },
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
      const batch = bufferExchange(userId, text, reply, channel, groupId);
      if (batch) extractMemoriesBatch(userId, batch, _ctx.settings()).catch((e) => _ctx.log("warn", "记忆提炼失败: " + e.message.slice(0, 160)));
    },
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      // 每 10 分钟把不足 3 段的残留对话 flush 掉，避免记忆丢失
      if (now - lastFlush >= 10 * 60000) {
        lastFlush = now;
        for (const [uid, arr] of pendingBatches) {
          if (arr && arr.length) {
            pendingBatches.set(uid, []);
            extractMemoriesBatch(Number(uid), arr, _ctx.settings()).catch(() => {});
          }
        }
      }
      if (lastConsolidate === 0 ? (now - startTs < 6 * 3600e3) : (now - lastConsolidate < 24 * 3600e3)) return;
      lastConsolidate = now;
      consolidateAllMemories().catch((e) => _ctx.log("warn", "记忆固化失败: " + e.message.slice(0, 160)));
    },
  },
};
