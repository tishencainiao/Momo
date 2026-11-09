/* 插件：能力索引（借鉴 ToolCatalogIndex「索引常驻 + 按需装载」）
 * 发现层：启动后从 registry 自动扫描工具/命令，按身份过滤，生成精简摘要常驻注入
 * 按需层：capability_view 工具，按关键词查能力细节
 * 噪音纪律：常驻摘要只放「友好名」，完整参数不常驻 */
let _ctx = null;

/* 友好名称映射（未收录的用原始工具名） */
const TOOL_LABELS = {
  take_screenshot: "截图看屏幕", find_files: "找文件", open_app: "打开应用", system_info: "看电脑配置",
  budget_view: "查花费", memory_view: "查记忆", memory_forget: "忘掉记忆", memory_edit: "改记忆",
  teach: "教我东西", send_sticker: "发表情包",
  add_todo: "加待办", list_todo: "看待办", complete_todo: "完成待办", remove_todo: "删待办",
  set_reminder: "设提醒", set_birthday: "记生日", birthday_view: "看生日",
  set_goal: "定目标", goals_view: "看目标",
  set_appellation: "给自己起称呼", set_other_appellation: "给别人起称呼",
  mute_user: "屏蔽人", unmute_user: "解除屏蔽", dsh_notify: "设DSH通知",
  check_balance: "查账户余额",
  self_modify: "给自己写代码", self_status: "查自己状态", self_log: "看运行日志",
  self_memory: "查对某人的记忆", self_info: "看自己身份", self_history: "查聊天记录",
  add_wish: "记愿望", capability_view: "查能力详情", momo_report: "给我写报告",
};
const CMD_LABELS = {
  "/叫我": "让人怎么称呼我", "/称呼": "查/设称呼", "/生日": "查生日", "/花费": "查账本",
  "/dsh通知": "设DSH通知", "/命令": "列出所有命令", "/进化": "触发一次自我进化",
  "/冻结进化": "冻结进化", "/解冻进化": "解冻进化", "/进化提案": "看进化提案",
  "/目标": "看长期目标", "/记忆": "看/改/删记忆",
  "/提醒": "设提醒", "/做表情包": "生成新表情包", "/教": "教我东西",
  "/教的清单": "看教过我什么", "/忘掉": "删掉某条教学", "/待办": "看待办", "/报告": "给我写报告",
};

/* 主人专属（其他人看不到） */
const MASTER_ONLY_TOOLS = new Set([
  "take_screenshot", "find_files", "open_app", "system_info",
  "self_modify", "dsh_notify", "set_other_appellation",
  "mute_user", "unmute_user", "set_goal", "goals_view",
  "budget_view", "self_log", "momo_report",
]);
const MASTER_ONLY_CMDS = new Set([
  "/花费", "/进化", "/冻结进化", "/解冻进化", "/进化提案",
  "/命令", "/dsh通知", "/教的清单", "/忘掉", "/目标", "/报告",
]);
/* 陌生人可用的最小集合 */
const GUEST_TOOLS = new Set([
  "send_sticker", "memory_view", "add_todo", "list_todo", "set_reminder",
  "birthday_view", "self_status", "self_info", "capability_view",
]);

/* 内部能力（不在工具/命令里，但确实能做） */
const INTERNAL = [
  { name: "主动找你说话", desc: "想你了会主动发消息（早安晚安、分享趣事、日程话题）" },
  { name: "发QQ空间", desc: "发说说、看好友动态、评论（每天上限 5 条）" },
  { name: "语音消息", desc: "你让它发语音时会用 TTS 发语音" },
  { name: "看图", desc: "你发图片时我能看懂内容" },
  { name: "联网搜索", desc: "查资料、找热梗（受每日生活费限制）" },
  { name: "定时提醒", desc: "到点提醒你做事" },
  { name: "日程生活", desc: "我有一份自己的日程（吃饭/收拾/看剧），会拿它找话题" },
  { name: "记账", desc: "管每日生活费，花超了会停掉部分花钱功能" },
  { name: "表情包库", desc: "收到的小图/表情包会自动收进库（待整理→收藏→回收站）；主人说「存下来」时通常已经存好了，可以直接确认" },
  { name: "自己找乐子", desc: "读文章 / 玩数独 / 刷热搜（每天最多 1~2 次，花自己的娱乐预算，产物进日记和记忆）" },
];

function tierOf(userId) {
  const qq = (_ctx && _ctx.config && _ctx.config.qq) || {};
  if (Number(userId) === Number(qq.master_user || 0)) return "master";
  if ((qq.allowed_users || []).map(Number).indexOf(Number(userId)) >= 0) return "friend";
  return "guest";
}

function scan(userId) {
  const tier = tierOf(userId);
  let tools = [], cmds = [];
  try { tools = (_ctx.registry && _ctx.registry.tools) ? _ctx.registry.tools() : []; } catch (e) {}
  try { cmds = (_ctx.registry && _ctx.registry.commands) ? _ctx.registry.commands() : []; } catch (e) {}
  if (tier !== "master") {
    tools = tools.filter((t) => !MASTER_ONLY_TOOLS.has(t));
    cmds = cmds.filter((c) => !MASTER_ONLY_CMDS.has(c));
  }
  if (tier === "guest") {
    tools = tools.filter((t) => GUEST_TOOLS.has(t));
    cmds = [];
  }
  return { tier, tools, cmds };
}

const TIER_LABEL = { master: "对主人", friend: "对熟人", guest: "对陌生人" };

/* ---------------- 负清单：她做不到的事（防"能发语音"外溢成"能放音乐"）----------------
 * triggers 是"输出后审计"用的触发短语（确定性匹配，特意不含单字「放」，
 * 因为她常说「先放一边/放过自己」，会被误伤）。
 * 主人确认后可写进 data/capability-limits.json 追加自定义条目。 */
const LIMITS = [
  {
    id: "audio-play", label: "播放音乐/音频",
    triggers: ["放歌", "放音乐", "放首", "放点轻的", "放给你听", "放首歌", "点歌", "播放音乐", "播放歌曲", "控制播放器", "外放", "调大音量", "音乐软件"],
    /* 这些句子只有和"歌/音乐/这首"等上下文同句（或紧邻下一句）时才算"我在放歌"，否则会误伤"把钥匙放好了" */
    contextTriggers: ["放啦", "开始放了", "正在放", "放给你了", "放好了", "那我开始了", "我开始了"],
    desc: "你没有音频播放能力，不能给别人放歌、点歌、控制播放器或调音量。",
  },
  { id: "sing", label: "真的唱歌", triggers: ["唱给你听", "唱首歌给你", "我给你唱"], desc: "你不能真正演唱；你能发语音消息（TTS 合成），但发语音不等于唱歌，也不等于放音乐。" },
  { id: "see-video", label: "看视频画面", triggers: ["看了这个视频", "视频里那个画面"], desc: "你看不到视频画面，只能读标题、简介、评论里的文字。" },
];

function limitsFile() { return _ctx && _ctx.DATA_DIR ? require("path").join(_ctx.DATA_DIR, "capability-limits.json") : ""; }
/* 主人确认后追加的条目（存在则与内置合并） */
function loadExtraLimits() {
  try { const fs = require("fs"); const arr = JSON.parse(fs.readFileSync(limitsFile(), "utf8")); return Array.isArray(arr) ? arr : []; } catch (e) { return []; }
}
function allLimits() {
  const extra = loadExtraLimits().filter((x) => x && x.id && Array.isArray(x.triggers) && x.triggers.length);
  return LIMITS.concat(extra);
}
function limitsText() {
  const list = allLimits();
  if (!list.length) return "";
  const names = list.map((x) => x.label).join("、");
  return `【你做不到的（别答应，也别演）】${names}。其中"发语音消息"你能做，但发语音 ≠ 放音乐/唱歌。`;
}
/* 输出后审计用的触发短语表（contextOnly=true 的必须配合音频上下文才算数） */
function limitTriggers() {
  const out = [];
  for (const l of allLimits()) {
    for (const t of (l.triggers || [])) out.push({ phrase: String(t), id: l.id, label: l.label, contextOnly: false });
    for (const t of (l.contextTriggers || [])) out.push({ phrase: String(t), id: l.id, label: l.label, contextOnly: true });
  }
  return out;
}

/* 命中计数：同一能力被拦/被纠正 2 次 → 生成一条"建议写进负清单"的提案（主人确认才生效） */
function proposalsFile() { return require("path").join(_ctx.DATA_DIR, "capability-proposals.json"); }
function loadHits() { try { return JSON.parse(require("fs").readFileSync(require("path").join(_ctx.DATA_DIR, "capability-hits.json"), "utf8")) || {}; } catch (e) { return {}; } }
function saveHits(h) { try { require("fs").mkdirSync(_ctx.DATA_DIR, { recursive: true }); require("fs").writeFileSync(require("path").join(_ctx.DATA_DIR, "capability-hits.json"), JSON.stringify(h)); } catch (e) {} }
function loadProposals() { try { const a = JSON.parse(require("fs").readFileSync(proposalsFile(), "utf8")); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function saveProposals(a) { try { require("fs").mkdirSync(_ctx.DATA_DIR, { recursive: true }); require("fs").writeFileSync(proposalsFile(), JSON.stringify(a.slice(-20))); } catch (e) {} }
/* 记一次"超出能力的声称"（审计拦截或主人纠正时调） */
function noteOverclaim(capabilityLabel, sample) {
  const key = String(capabilityLabel || "unknown").slice(0, 40);
  const hits = loadHits();
  hits[key] = (Number(hits[key]) || 0) + 1;
  saveHits(hits);
  if (hits[key] >= 2) {
    const props = loadProposals();
    if (!props.some((p) => p.label === key && p.status === "pending")) {
      props.push({ label: key, count: hits[key], sample: String(sample || "").slice(0, 60), ts: Date.now(), status: "pending" });
      saveProposals(props);
      if (_ctx && _ctx.log) _ctx.log("info", `能力负清单提案：${key}（已 ${hits[key]} 次）等待主人确认`);
    }
  }
  return hits[key];
}

/* 常驻精简摘要（只放能力名，不放细节） */
function capabilityCtx(userId) {
  const { tier, tools, cmds } = scan(userId);
  const tl = tools.map((t) => TOOL_LABELS[t] || t).join("、");
  const cl = cmds.map((c) => CMD_LABELS[c] || c).join(" ");
  const il = INTERNAL.map((x) => x.name).join("、");
  const lines = [`【我能做什么（${TIER_LABEL[tier] || tier}）】`];
  if (tl) lines.push("工具：" + tl);
  if (cl) lines.push("命令：" + cl);
  if (il) lines.push("内部能力：" + il);
  const lt = limitsText();
  if (lt) lines.push(lt);
  lines.push("（不确定某项能力时，调 capability_view 查详情）");
  return lines.join("\n");
}

/* 按需查询：关键词匹配能力名/描述 */
function capabilityView(userId, keyword) {
  const { tier, tools, cmds } = scan(userId);
  const k = String(keyword || "").trim();
  const out = [];
  const match = (s) => !k || String(s).indexOf(k) >= 0;
  for (const t of tools) {
    const label = TOOL_LABELS[t] || t;
    if (match(t) || match(label)) out.push(`- ${label}（工具 ${t}）`);
  }
  for (const c of cmds) {
    const label = CMD_LABELS[c] || c;
    if (match(c) || match(label)) out.push(`- ${label}（命令 ${c}）`);
  }
  for (const it of INTERNAL) {
    if (match(it.name) || match(it.desc)) out.push(`- ${it.name}：${it.desc}`);
  }
  const limits = allLimits().filter((l) => match(l.label) || match(l.desc) || (l.triggers || []).some(match));
  if (limits.length) {
    out.push("【我做不到的】");
    for (const l of limits) out.push(`- ${l.label}：${l.desc}`);
  }
  if (!out.length) {
    return k ? `（我没找到和「${k}」相关的能力，也不在"做不到"清单里。不确定的事别答应，先说实话）` : capabilityCtx(userId);
  }
  return `【能力详情${k ? "（" + k + "）" : ""}】\n` + out.slice(0, 24).join("\n");
}

/* 从各插件 apiSpec 自动派生「内部能力自描述」（⑨：让大脑/面板/体检知道每个插件能干嘛）
 * 返回人类可读文本：一行一个插件，列出它的 api 命名空间 → 函数(入参/出/副作用) */
function describeApis() {
  let specs = [];
  try { specs = (_ctx && _ctx.registry && _ctx.registry.apiSpecs) ? _ctx.registry.apiSpecs() : []; } catch (e) {}
  const lines = [];
  for (const p of specs) {
    const nsTexts = [];
    for (const ns of Object.keys(p.apiSpec || {})) {
      const fns = p.apiSpec[ns] || {};
      const fnTexts = Object.keys(fns).map((fn) => {
        const s = fns[fn] || {};
        const bits = [];
        if (s.input) bits.push("入" + s.input);
        if (s.output) bits.push("出" + s.output);
        if (s.sideEffect) bits.push(s.sideEffect);
        return fn + (bits.length ? "(" + bits.join("，") + ")" : "");
      });
      if (fnTexts.length) nsTexts.push(ns + "：" + fnTexts.join("、"));
    }
    if (nsTexts.length) lines.push((p.displayName || p.name) + "：" + nsTexts.join("；"));
  }
  return lines.length ? lines.join("\n") : "（暂无插件 api 自描述）";
}

module.exports = {
  name: "capability-index",
  displayName: "能力索引",
  description: "扫描工具/命令、按身份过滤、生成能力摘要与负清单",
  permissions: ["DATA_DIR", "config", "log", "registry"],
  version: "1.0.0",
  attribution: {
    source: "DeepSeek Harness ToolCatalogIndex",
    license: "思路借鉴（未复用代码）",
    note: "「索引常驻 + 按需装载」组织思路，实现自写",
    importedAt: "2026-11-09",
  },
  init(ctx) { _ctx = ctx; },
  apiSpec: {"capability":{"capabilityCtx":{"input":"","output":"","sideEffect":""},"capabilityView":{"input":"","output":"","sideEffect":""},"scan":{"input":"","output":"","sideEffect":"只读"},"tierOf":{"input":"","output":"","sideEffect":"只读"},"allLimits":{"input":"","output":"","sideEffect":""},"limitsText":{"input":"","output":"","sideEffect":""},"limitTriggers":{"input":"","output":"","sideEffect":""},"noteOverclaim":{"input":"","output":"","sideEffect":"写盘"},"loadProposals":{"input":"","output":"","sideEffect":"只读"},"saveProposals":{"input":"","output":"","sideEffect":"写盘"},"loadHits":{"input":"","output":"","sideEffect":"只读"},"describeApis":{"input":"无","output":"自描述文本","sideEffect":"只读"}}},

  api: { capability: { capabilityCtx, capabilityView, scan, tierOf, allLimits, limitsText, limitTriggers, noteOverclaim, loadProposals, saveProposals, loadHits, describeApis } },
  tools: [{
    def: {
      type: "function",
      function: {
        name: "capability_view",
        description: "查询自己有哪些能力（工具/命令/内部能力）的细节。当对方问「你会什么」「你能不能X」「你有什么功能」时调用。",
        parameters: {
          type: "object",
          properties: { keyword: { type: "string", description: "关键词（如「截图」「记忆」「空间」），留空则返回完整能力清单" } },
        },
      },
    },
    handler(args, info) {
      // 只读工具，不限制身份；返回内容本身已按身份过滤
      return capabilityView(info.userId, args.keyword);
    },
  }, {
    def: {
      type: "function",
      function: {
        name: "where_am_i",
        description: "查你现在正在哪个渠道跟对方说话（QQ 私聊 / QQ 群 / 电脑屏幕上的桌宠窗口）。当被问「你现在在哪」「我们是在QQ还是桌面」「你还记得我们怎么聊的吗」时调用，别猜。",
        parameters: { type: "object", properties: {} },
      },
    },
    handler(args, info) {
      const i = info || {};
      if (i.petMode) return "你现在在主人电脑屏幕上的桌宠窗口里。主人就坐在电脑前，能看见你；你们的对话是在桌宠的聊天框里打字的（不是 QQ，也不是当面开口）。";
      if (i.groupId) return `你现在在 QQ 群 ${i.groupId} 里，隔着屏幕跟群里的人聊天，群里有好几个人在看。`;
      return "你现在在 QQ 私聊里，隔着屏幕跟对方聊天——对方在手机或电脑的另一头，你们不在同一个物理空间。";
    },
  }],
};
