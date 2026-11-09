/* 插件：教学系统 —— 主人主动教 Momo 东西，并跟踪哪些教学真的起了作用
 * 五类：sticker 表情包 / word 词汇 / preference 偏好 / fact 事实 / behavior 行为规则
 * 数据：data/taught.json = { items: [{id,kind,content,key,source,ts,used,matched,lastUsed,status}] }
 * 反馈闭环：used=被注入次数，matched=回复中真命中次数；连续注入 20 次且 0 命中 → decayed；再 30 天 → archived */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const file = () => path.join(_ctx.DATA_DIR, "taught.json");
function load() {
  try { const d = JSON.parse(fs.readFileSync(file(), "utf8")); return Array.isArray(d.items) ? d : { items: [] }; }
  catch (e) { return { items: [] }; }
}
function save(d) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(file(), JSON.stringify(d)); } catch (e) {} }

const KINDS = ["sticker", "word", "preference", "fact", "behavior"];
const LABEL = { sticker: "表情包", word: "词汇", preference: "偏好", fact: "事实", behavior: "行为规则" };
const CAP = { behavior: 10, preference: 10, fact: 15 };

/* 教学等级：master（主人，全部类型）> friend（熟人，只能表情包/词汇）> guest（不能教） */
const TIER_ORDER = { master: 3, friend: 2, guest: 1 };
const FRIEND_KINDS = new Set(["sticker", "word"]);
function tierOf(userId) {
  const qq = (_ctx && _ctx.config && _ctx.config.qq) || {};
  if (Number(userId) === Number(qq.master_user || 0)) return "master";
  const allowed = (qq.allowed_users || []).map(Number);
  if (allowed.indexOf(Number(userId)) >= 0) return "friend";
  return "guest";
}
function canTeach(tier, kind) {
  if (tier === "master") return true;
  if (tier === "friend") return FRIEND_KINDS.has(kind);
  return false;
}

function genId() { return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

/* fact / preference 直接写进记忆（单一来源），并打上 source=taught 标记 */
function syncToMemory(userId, kind, content) {
  if (!userId) return false;
  if (kind !== "fact" && kind !== "preference") return false;
  try {
    const items = _ctx.loadMemories(userId) || [];
    const dup = items.find((x) => {
      const a = String(x.content || ""), b = String(content || "");
      return a && b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
    });
    if (dup) { dup.source = "taught"; dup.hits = 999; }
    else items.push({ content, created: Math.floor(Date.now() / 1000), hits: 999, source: "taught", layer: "fact" });
    _ctx.saveMemories(userId, items);
    return true;
  } catch (e) { _ctx.log("warn", "教学写记忆失败: " + String(e.message).slice(0, 120)); return false; }
}

function addItem(kind, content, key, userId) {
  const k = KINDS.indexOf(String(kind)) >= 0 ? String(kind) : "fact";
  const c = String(content || "").trim().slice(0, 200);
  if (!c) return { ok: false, msg: "（要教的内容是空的）" };
  const tier = tierOf(userId);
  if (!canTeach(tier, k)) {
    return { ok: false, msg: tier === "guest" ? "（这个只有主人和熟人才教得动哦）" : `（「${LABEL[k] || k}」只能由主人教）` };
  }
  const kk = String(key || c).trim().slice(0, 40);
  const d = load();
  const exist = d.items.find((x) => x.kind === k && x.key === kk);
  if (exist) {
    // 覆盖规则：低优先级不能覆盖高优先级（旧数据无 tier 视为 master）
    if ((TIER_ORDER[exist.tier || "master"] || 3) > (TIER_ORDER[tier] || 1)) {
      return { ok: false, msg: "（这条是主人定的，我改不了哦）" };
    }
    exist.content = c; exist.ts = Date.now(); exist.used = 0; exist.matched = 0; exist.status = "active";
    exist.tier = tier; exist.from = Number(userId) || 0;
    delete exist.decayedAt;
    save(d);
    const synced = syncToMemory(userId, k, c);
    return { ok: true, msg: `已更新「${LABEL[k]}」：${c}${synced ? "（已写入长期记忆）" : ""}`, id: exist.id };
  }
  const item = { id: genId(), kind: k, content: c, key: kk, source: "user", tier, from: Number(userId) || 0, ts: Date.now(), used: 0, matched: 0, lastUsed: 0, status: "active" };
  d.items.push(item);
  while (d.items.length > 100) d.items.shift();
  save(d);
  const synced = syncToMemory(userId, k, c);
  return { ok: true, msg: `已经学会「${LABEL[k]}」：${c}${synced ? "（已写入长期记忆）" : ""}`, id: item.id };
}

function removeByKeyword(kw) {
  const k = String(kw || "").trim();
  if (!k) return 0;
  const d = load();
  const before = d.items.length;
  d.items = d.items.filter((x) => !(String(x.content).indexOf(k) >= 0 || String(x.key).indexOf(k) >= 0));
  save(d);
  return before - d.items.length;
}

function activeItems() { return load().items.filter((x) => x.status === "active"); }

function bump(id, field) {
  const d = load();
  const x = d.items.find((i) => i.id === id);
  if (!x) return;
  x[field] = (x[field] || 0) + 1;
  if (field === "used") x.lastUsed = Date.now();
  save(d);
}

/* 注入上下文：行为规则常驻 + 词汇按需。
 * fact/preference 已写入长期记忆（由 memoryPrompt 注入），这里不再重复，避免两份内容占上下文。 */
function teachCtx(text) {
  const items = activeItems();
  if (!items.length) return "";
  const tierRank = (x) => TIER_ORDER[x.tier || "master"] || 3;
  const byTier = (arr) => arr.slice().sort((a, b) => tierRank(b) - tierRank(a));
  const parts = [];
  const beh = byTier(items.filter((x) => x.kind === "behavior")).slice(-(CAP.behavior || 10));
  if (beh.length) {
    parts.push(`【行为规则（主人教我的，优先遵守）】\n${beh.map((x) => "- " + x.content).join("\n")}`);
    for (const x of beh) bump(x.id, "used");
  }
  if (text) {
    const words = byTier(items.filter((x) => x.kind === "word" && x.key.length >= 2 && String(text).indexOf(x.key) >= 0)).slice(0, 5);
    if (words.length) {
      const masterW = words.filter((x) => (x.tier || "master") === "master");
      const otherW = words.filter((x) => (x.tier || "master") !== "master");
      if (masterW.length) parts.push(`【主人教过的词】\n${masterW.map((x) => "- " + x.content).join("\n")}`);
      if (otherW.length) parts.push(`【朋友教过的词（仅供参考）】\n${otherW.map((x) => "- " + x.content).join("\n")}`);
      for (const x of words) bump(x.id, "used");
    }
  }
  return parts.join("\n");
}

/* 只有「有明确关键词」的类型才做命中判断与降权；常驻类（行为/偏好/事实）不自动降权 */
const DECAYABLE = new Set(["word", "sticker"]);

/* 回复后判断是否真用上：教学关键词出现在回复里 */
function markMatched(reply) {
  const txt = String(reply || "");
  if (!txt) return;
  const d = load();
  let changed = false;
  for (const x of d.items) {
    if (x.status !== "active" || !DECAYABLE.has(x.kind)) continue;
    const core = String(x.key || x.content);
    if (core.length >= 2 && core.length <= 20 && txt.indexOf(core) >= 0) { x.matched = (x.matched || 0) + 1; changed = true; }
  }
  if (changed) save(d);
}

/* 降权/归档（只针对可衰减类型） */
function evaluate() {
  const d = load();
  const now = Date.now();
  let changed = 0;
  for (const x of d.items) {
    if (!DECAYABLE.has(x.kind)) continue;
    if (x.status === "active" && (x.used || 0) >= 20 && (x.matched || 0) === 0) { x.status = "decayed"; x.decayedAt = now; changed++; }
    else if (x.status === "decayed" && x.decayedAt && now - x.decayedAt > 30 * 86400e3) { x.status = "archived"; changed++; }
  }
  if (changed) { save(d); _ctx.log("info", `教学反馈：${changed} 条降权/归档`); }
  return changed;
}

/* 汇总（给 /教的清单） */
function summary() {
  const d = load();
  const groups = {};
  for (const x of d.items) { (groups[x.status] = groups[x.status] || []).push(x); }
  const lines = [];
  for (const st of ["active", "decayed", "archived"]) {
    const arr = groups[st] || [];
    if (!arr.length) continue;
    lines.push(`【${st}】${arr.length} 条`);
    for (const x of arr.slice(-12)) lines.push(`  · [${LABEL[x.kind] || x.kind}${(x.tier || "master") === "friend" ? "·朋友" : ""}] ${x.content}（用 ${x.used || 0}/中 ${x.matched || 0}）`);
  }
  return lines.length ? lines.join("\n") : "（还没有教过我东西）";
}

module.exports = {
  name: "teach",
  displayName: "教学系统",
  description: "主人主动教 Momo 东西，并跟踪哪些教学真的生效",
  permissions: ["DATA_DIR", "config", "getApi", "isMaster", "loadMemories", "log", "saveMemories", "sendPrivate", "stickerSessionKey"],
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  apiSpec: {"teach":{"addItem":{"input":"","output":"","sideEffect":"写盘"},"removeByKeyword":{"input":"","output":"","sideEffect":"写盘"},"teachCtx":{"input":"","output":"","sideEffect":""},"markMatched":{"input":"","output":"","sideEffect":""},"evaluate":{"input":"","output":"","sideEffect":""},"summary":{"input":"","output":"","sideEffect":"只读"},"activeItems":{"input":"","output":"","sideEffect":""}}},

  api: { teach: { addItem, removeByKeyword, teachCtx, markMatched, evaluate, summary, activeItems } },
  tools: [{
    def: {
      type: "function",
      function: {
        name: "teach",
        description: "主人主动教你新东西时调用。比如发图说「这个表情是生气」、说「X 的意思是 Y」、「记住：X」、「以后别催我」、或者纠正你的错误认知。",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", description: "教学类型：sticker(表情包含义)/word(词汇)/preference(偏好)/fact(事实)/behavior(行为规则)" },
            content: { type: "string", description: "要教的内容，用主人原话或提炼后的一句话" },
            key: { type: "string", description: "可选：检索用的关键词（默认用 content）" },
          },
          required: ["kind", "content"],
        },
      },
    },
    async handler(args, info) {
      const kind = String(args.kind || "fact");
      const content = String(args.content || "").trim();
      if (!content) return "（要教的内容是空的）";
      const tier = tierOf(info.userId);
      if (!canTeach(tier, kind)) {
        return tier === "guest" ? "（这个只有主人和熟人才教得动哦）" : `（「${LABEL[kind] || kind}」只能由主人教）`;
      }
      if (kind === "sticker") {
        const s = _ctx.getApi && _ctx.getApi("stickers");
        if (!s || !s.teachSticker) return "（表情包模块不可用）";
        const r = await s.teachSticker({
          desc: content,
          userId: info.userId,
          sessionKey: _ctx.stickerSessionKey ? _ctx.stickerSessionKey(info.userId, info.groupId) : "",
        });
        /* 只有真的落到某一张图上，才记进教学清单 */
        if (r.ok) addItem("sticker", content, content.slice(0, 20), info.userId);
        return r.msg;
      }
      const r = addItem(kind, content, args.key, info.userId);
      return r.msg;
    },
  }],
  commands: [
    {
      key: "/教",
      regex: /^\/教(?!的)/,
      handler(msg) {
        const tier = tierOf(msg.userId);
        if (tier === "guest") { _ctx.sendPrivate(msg.userId, "这个只有主人和熟人才教得动哦～"); return; }
        const raw = msg.text.replace(/^\/教\s*/, "").trim();
        if (!raw) {
          _ctx.sendPrivate(msg.userId, tier === "master"
            ? "用法：\n/教 记住：我喜欢喝冰美式\n/教 词：X 的意思是 Y\n/教 行为：以后别催我\n/教 表情：无语"
            : "用法（熟人只能教表情包和词）：\n/教 词：X 的意思是 Y\n/教 表情：无语");
          return;
        }
        let kind = "fact";
        let body = raw;
        const m = raw.match(/^(表情|词|词汇|偏好|事实|行为|规则)\s*[:：]\s*([\s\S]+)$/);
        if (m) {
          const map = { 表情: "sticker", 词: "word", 词汇: "word", 偏好: "preference", 事实: "fact", 行为: "behavior", 规则: "behavior" };
          kind = map[m[1]] || "fact";
          body = m[2].trim();
        }
        if (!canTeach(tier, kind)) {
          _ctx.sendPrivate(msg.userId, `（「${LABEL[kind] || kind}」只能由主人教哦）`);
          return;
        }
        if (kind === "sticker") {
          const s = _ctx.getApi && _ctx.getApi("stickers");
          if (!s || !s.teachSticker) { _ctx.sendPrivate(msg.userId, "表情包模块不可用"); return; }
          s.teachSticker({
            desc: body,
            userId: msg.userId,
            sessionKey: _ctx.stickerSessionKey ? _ctx.stickerSessionKey(msg.userId, msg.groupId) : "",
          }).then((r) => {
            if (r.ok) addItem("sticker", body, body.slice(0, 20), msg.userId);
            _ctx.sendPrivate(msg.userId, r.msg);
          }).catch((e) => _ctx.sendPrivate(msg.userId, "【失败】" + String(e.message).slice(0, 80)));
          return;
        }
        const r = addItem(kind, body, null, msg.userId);
        _ctx.sendPrivate(msg.userId, r.msg);
      },
    },
    {
      key: "/教的清单",
      regex: /^\/教的清单/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能看哦～"); return; }
        _ctx.sendPrivate(msg.userId, summary());
      },
    },
    {
      key: "/忘掉",
      regex: /^\/忘掉/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能让我忘东西哦～"); return; }
        const kw = msg.text.replace(/^\/忘掉\s*/, "").trim();
        if (!kw) { _ctx.sendPrivate(msg.userId, "用法：/忘掉 <关键词>"); return; }
        const n = removeByKeyword(kw);
        _ctx.sendPrivate(msg.userId, n ? `忘掉了 ${n} 条关于「${kw}」的教学` : `没有找到关于「${kw}」的教学`);
      },
    },
  ],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      const d = load();
      if (now - (d.lastEval || 0) < 6 * 3600e3) return;   // 每 6 小时评估一次
      d.lastEval = now; save(d);
      evaluate();
    },
  },
};
