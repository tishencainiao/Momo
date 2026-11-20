/* 世界书（lorebook）框架服务：关键词触发的背景注入（SillyTavern World Info 借鉴）
   - 条目自包含：content 必须是一段能独立读懂的背景
   - 关键词子串匹配（中文不适用 whole-word，直接子串命中）
   - 预算：最多 3 条、合计 ≤600 字，超限按 priority 低者先丢
   - 数据：data/lore.json（writeJsonAtomic 落盘）
*/
module.exports = {
  name: "lore-service",
  displayName: "世界书（话题背景）",
  version: "1.0.0",
  description: "关键词触发的话题背景注入：聊到某个话题时自动补上相关背景（朋友/群/毕设/喜好等）。",
  userScoped: false,
  system: true,
  requires: [],
  permissions: ["DATA_DIR", "writeJsonAtomic", "log"],
  attribution: { source: "self-written", license: "self-written", note: "机制借鉴 SillyTavern World Info（关键词触发+priority+预算丢弃），实现为 Momo 自写" },
  apiSpec: {
    lore: {
      entries: { input: "无", output: "数组", sideEffect: "只读" },
      match: { input: "text:string", output: "命中条目数组", sideEffect: "只读" },
      loreCtx: { input: "text:string", output: "注入块字符串", sideEffect: "只读" },
      addLore: { input: "entry:{id?,keys,content,priority,order}", output: "布尔", sideEffect: "写盘" },
      removeLore: { input: "id:string", output: "布尔", sideEffect: "写盘" },
      listLore: { input: "无", output: "列表文本", sideEffect: "只读" },
    },
  },
  init(ctx) {
    _ctx = ctx;
    /* 首次启动自播种子（data/ 不进 git，种子写在代码里） */
    try {
      const f = loreFile();
      if (!require("fs").existsSync(f)) saveLore(DEFAULT_SEED);
    } catch (e) {}
  },
  hooks: {},
  commands: [
    {
      key: "/lore",
      regex: /^\/lore\s*$/,
      handler(msg) {
        const isMaster = _ctx.isMaster ? _ctx.isMaster(msg.user_id) : false;
        if (!isMaster) return "这是主人的世界书，我不能给别人看。";
        return listLore() + "\n\n用法：主人说「记一下：以后聊到 XX 的时候，想起 YY」可加条目；「删掉世界书 <id>」可删。";
      },
    },
  ],
  tools: [
    {
      def: {
        type: "function",
        function: {
          name: "lore_add",
          description: "主人说「记一下：以后聊到X的时候，想起Y」「世界书记一条…」时调用：把一条话题背景写进世界书（以后聊到关键词会自动想起来）。keys 是触发关键词（逗号分隔），content 是一段自包含的背景描述。",
          parameters: { type: "object", properties: { keys: { type: "string", description: "触发关键词，多个用逗号分隔" }, content: { type: "string", description: "背景内容，必须是一段能独立读懂的话" }, priority: { type: "number", description: "优先级，越高越优先注入，默认 0" } }, required: ["keys", "content"] },
        },
      },
      handler(args, info) {
        if (!_ctx.isMaster || !_ctx.isMaster(info && info.userId)) return "只有主人能改世界书。";
        const ok = addLore({ keys: args.keys, content: args.content, priority: args.priority });
        return ok ? "记下啦，以后聊到相关话题我会想起来的。" : "没记成，检查一下关键词和内容。";
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "lore_list",
          description: "主人问「世界书里有什么」「你记了哪些话题背景」时调用：列出世界书全部条目。",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      handler(args, info) {
        if (!_ctx.isMaster || !_ctx.isMaster(info && info.userId)) return "这是主人的世界书，我不能给别人看。";
        return listLore();
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "lore_del",
          description: "主人说「删掉世界书 <id>」「世界书删一条」时调用：删除指定 id 的条目。",
          parameters: { type: "object", properties: { id: { type: "string", description: "条目 id（lore_list 里显示的）" } }, required: ["id"] },
        },
      },
      handler(args, info) {
        if (!_ctx.isMaster || !_ctx.isMaster(info && info.userId)) return "只有主人能改世界书。";
        return removeLore(String((args && args.id) || "")) ? "删掉了。" : "没找到这条。";
      },
    },
  ],
  api: {
    lore: {
      entries,
      match,
      loreCtx,
      addLore,
      removeLore,
      listLore,
    },
  },
};

let _ctx = null;

/* 首批种子条目（data/lore.json 不存在时自播；内容须自包含且为真） */
const DEFAULT_SEED = [
  { id: "l-group", keys: ["群聊", "群里"], content: "你在主人的一个 QQ 小群里，群里主要是主人和几个朋友，气氛轻松，常聊日常。", priority: 3, order: 1 },
  { id: "l-friend", keys: ["小", "渔", "小渔", "朋友"], content: "小渔（QQ 100000002，昵称小渔）是主人的朋友，也常和你聊天。对他保持朋友的分寸，别把主人的私事讲给他。", priority: 5, order: 2 },
  { id: "l-tuyi", keys: ["毕设", "途忆", "旅游攻略"], content: "主人的毕设是「途忆」——一个旅游攻略智能体（React 前端 + Node 后端）。聊到毕设可以问进展、帮他记重点。", priority: 4, order: 3 },
  { id: "l-otter", keys: ["海獭", "水獭", "拼图"], content: "主人喜欢海獭（水獭），也玩拼图。聊到这些他会开心。", priority: 2, order: 4 },
  { id: "l-coffee", keys: ["咖啡", "美式"], content: "主人爱喝冰美式，口味偏酸。", priority: 2, order: 5 },
  { id: "l-milktea", keys: ["奶茶", "杨枝甘露"], content: "主人爱喝奶茶，喜欢杨枝甘露。", priority: 2, order: 6 },
  { id: "l-study", keys: ["自习", "学习", "Java", "大数据"], content: "主人是 2027 届大数据专业大学生，主技能 Java，正往 AI 应用方向准备；常去自习室学习。", priority: 4, order: 7 },
  { id: "l-hotpot", keys: ["火锅"], content: "主人爱吃火锅。", priority: 2, order: 8 },
];

function loreFile() { return require("path").join(_ctx.DATA_DIR, "lore.json"); }
function loadLore() {
  try {
    const d = JSON.parse(require("fs").readFileSync(loreFile(), "utf8"));
    if (Array.isArray(d.entries)) return d.entries;
  } catch (e) {}
  return [];
}
function saveLore(entries) {
  try {
    if (_ctx.writeJsonAtomic) _ctx.writeJsonAtomic(loreFile(), { entries });
    else require("fs").writeFileSync(loreFile(), JSON.stringify({ entries }, null, 2));
    return true;
  } catch (e) {
    _ctx.log && _ctx.log("warn", "lore 写盘失败: " + String(e && e.message).slice(0, 80));
    return false;
  }
}

function entries() { return loadLore(); }

/* 关键词子串匹配（中文无分词，直接 includes；英文不区分大小写） */
function match(text) {
  const t = String(text || "");
  if (!t) return [];
  const tl = t.toLowerCase();
  const out = [];
  for (const e of loadLore()) {
    const keys = Array.isArray(e.keys) ? e.keys : [];
    for (const k of keys) {
      const kk = String(k);
      if (!kk) continue;
      if (tl.includes(kk.toLowerCase())) { out.push(e); break; }
    }
  }
  out.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  return out;
}

/* 注入块：命中条目按 priority 高者优先，最多 3 条、合计 ≤600 字 */
function loreCtx(text) {
  const hit = match(text);
  if (!hit.length) return "";
  const byPri = hit.slice().sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
  const picked = [];
  let total = 0;
  for (const e of byPri) {
    const c = String(e.content || "").trim();
    if (!c) continue;
    if (picked.length >= 3 || total + c.length > 600) continue;
    picked.push(c);
    total += c.length;
  }
  if (!picked.length) return "";
  return "【背景（聊到这个想起来的）】\n" + picked.map((c) => "- " + c).join("\n");
}

function addLore(entry) {
  if (!entry || typeof entry !== "object") return false;
  const content = String(entry.content || "").trim();
  if (!content) return false;
  const keys = (Array.isArray(entry.keys) ? entry.keys : String(entry.keys || "").split(/[,，]/)).map((k) => String(k).trim()).filter(Boolean);
  if (!keys.length) return false;
  const list = loadLore();
  const id = entry.id || ("l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const idx = list.findIndex((e) => e.id === id);
  const item = { id, keys, content, priority: Number(entry.priority) || 0, order: Number(entry.order) || 0 };
  if (idx >= 0) list[idx] = item; else list.push(item);
  return saveLore(list);
}

function removeLore(id) {
  const list = loadLore();
  const next = list.filter((e) => e.id !== id);
  if (next.length === list.length) return false;
  return saveLore(next);
}

function listLore() {
  const list = loadLore();
  if (!list.length) return "世界书是空的。主人可以说「记一下：以后聊到 XXX 的时候，想起 YYY」来加条目。";
  return "世界书条目（" + list.length + " 条）：\n" + list.map((e) => `- ${e.id}｜关键词[${(e.keys || []).join("/")}]｜优先级 ${e.priority || 0}｜${String(e.content).slice(0, 40)}`).join("\n");
}
