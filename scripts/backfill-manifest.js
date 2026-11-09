#!/usr/bin/env node
/* 一次性迁移：给 41 个插件补齐 Manifest 元数据（displayName/description/permissions，缺 version 的补上）。
 * displayName/description 从头部注释提炼；permissions 从 `_ctx.xxx` 静态扫描自动推导；memory-digest 的 name 从 camelCase 修正为 kebab-case。
 * 幂等：已存在 displayName 的插件跳过。运行后请用 scripts/plugin-doctor.js 验证。 */
const fs = require("fs");
const path = require("path");

const PLUG = path.join(__dirname, "..", "plugins");

/* file -> { displayName, description, version?(缺 version 时补) } */
const META = {
  "appellations.js": { displayName: "称呼", description: "给自己和别人起称呼（/叫我、/称呼 命令）" },
  "birthdays.js": { displayName: "生日", description: "记生日、查生日、每日生日祝福检查" },
  "browse.js": { displayName: "刷视频", description: "看 B 站热门视频并「看懂」一条（browse 工具）" },
  "budget-report.js": { displayName: "账本", description: "生活费记账 + /花费 命令 + 账本 api（供报告/身体读）" },
  "buzz.js": { displayName: "吃瓜", description: "读百度实时热搜、写一句自己的看法（read_buzz）" },
  "capability-index.js": { displayName: "能力索引", description: "扫描工具/命令、按身份过滤、生成能力摘要与负清单" },
  "dsh-link.js": { displayName: "DSH 联动通知", description: "读 DSH 事件文件 → QQ 通知主人" },
  "emotion.js": { displayName: "情绪检测", description: "LLM 轻量判断情绪（状态存储/惯性/衰减在内核）" },
  "evolution.js": { displayName: "进化层", description: "自我内省、愿望、反思/探索、评分调参、技能规则、插件元认知（特权）" },
  "followup.js": { displayName: "未完话头", description: "主动问过的事避免反复追问，可作主动搭话由头" },
  "fun-core.js": { displayName: "娱乐公共底座", description: "活动流水 + 每日次数闸门 + 娱乐预算闸门" },
  "goals.js": { displayName: "目标系统", description: "定目标、看目标、今日计划、上下文注入" },
  "group-chat.js": { displayName: "群聊行为设置", description: "声明群聊可调参数（具体逻辑在内核）" },
  "group-info.js": { displayName: "群/用户信息", description: "OneBot 扩展接口：群成员/群日志/跨窗口（M8 下沉）" },
  "group-memes.js": { displayName: "群梗", description: "学群里的黑话/梗，只在对应群生效" },
  "hobby.js": { displayName: "兴趣档案", description: "爱好 + 收藏夹" },
  "interact.js": { displayName: "互动", description: "名片点赞、拍一拍" },
  "life-log.js": { displayName: "生活日志", description: "从真实活动数据汇总「我最近做过什么」" },
  "memory-digest.js": { displayName: "记忆消化", description: "读消化后的「认识」，替换流水账注入（mem.digest）" },
  "memory.js": { displayName: "记忆", description: "短期提炼 + 长期固化（数据层存取在内核）" },
  "meta-cog.js": { displayName: "元认知", description: "逐条统计 + 提醒注入 + 每日复盘" },
  "mind.js": { displayName: "心智数据层", description: "念头/未想明白的事/待办意图的存取（纯本地，M8 下沉）", version: "1.0.0" },
  "mute.js": { displayName: "屏蔽", description: "屏蔽/解除屏蔽（主人专属，数据层在内核）" },
  "pc-tools.js": { displayName: "电脑工具", description: "截图/找文件/开软件/系统信息（仅主人）" },
  "pet-body.js": { displayName: "身体联动", description: "让大脑指挥桌面上的身体（HTTP 127.0.0.1:4010）" },
  "proactive.js": { displayName: "主动行为", description: "何时能打扰 + 说什么话（状态/定时在内核 proactive 束）" },
  "puzzle.js": { displayName: "玩谜题", description: "数独，带存档、跨天、代码判定" },
  "qzone.js": { displayName: "QQ 空间", description: "发说说 / 看动态 / 评论" },
  "read-article.js": { displayName: "读文章", description: "读一篇文章并复述（read_article）" },
  "reminders.js": { displayName: "提醒", description: "设提醒 + /提醒 + 到期检查定时器" },
  "report.js": { displayName: "给主人的报告", description: "日报/周报/月报整合，每天 23:00 用 LLM 口吻写" },
  "roles.js": { displayName: "角色与权限", description: "管理员/用户/访客三级身份" },
  "search.js": { displayName: "搜索", description: "百度网页搜索 + 博查 API 搜索（M7 下沉）", version: "1.0.0" },
  "settings.js": { displayName: "可配置参数", description: "让 Momo 自己查看/修改各功能暴露的可调参数" },
  "stickers.js": { displayName: "表情包", description: "表情包语义库 + 收藏" },
  "teach.js": { displayName: "教学系统", description: "主人主动教 Momo 东西，并跟踪哪些教学真的生效" },
  "todos.js": { displayName: "待办", description: "待办增删查 + /待办 + 到期提醒" },
  "user-profile.js": { displayName: "用户画像", description: "结构化用户画像" },
  "vision.js": { displayName: "视觉", description: "图片识别/下载/MIME 嗅探（M7 下沉）", version: "1.0.0" },
  "voice.js": { displayName: "语音", description: "TTS 发音 + 语音转文字（QQ 原生转写→SAPI 兜底）" },
  "weather.js": { displayName: "天气", description: "城市天气 + 自然关心主人" },
};

/* 从源码静态扫描 _ctx.xxx / ctx.xxx 推导 permissions */
function scanPermissions(src) {
  const set = new Set();
  const re = /(?:_ctx|ctx)\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) set.add(m[1]);
  return Array.from(set).sort();
}

function jsonList(arr) {
  return "[" + arr.map((x) => JSON.stringify(x)).join(", ") + "]";
}

let changed = 0, skipped = 0;
for (const [file, meta] of Object.entries(META)) {
  const fp = path.join(PLUG, file);
  if (!fs.existsSync(fp)) { console.log("缺文件", file); continue; }
  let src = fs.readFileSync(fp, "utf8");
  if (/\bdisplayName\s*:/.test(src)) { skipped++; continue; } // 幂等

  const perms = scanPermissions(src);
  const lines = [];
  lines.push(`  displayName: ${JSON.stringify(meta.displayName)},`);
  if (meta.version) lines.push(`  version: ${JSON.stringify(meta.version)},`);
  lines.push(`  description: ${JSON.stringify(meta.description)},`);
  lines.push(`  permissions: ${jsonList(perms)},`);

  // 在 module.exports 里的 name: 行之后插入
  const nameRe = /^(  name\s*:\s*["'][^"']+["'],?)\s*$/m;
  const m = src.match(nameRe);
  if (!m) { console.log("找不到 name 行", file); continue; }
  const insertion = "\n" + lines.join("\n");
  src = src.replace(nameRe, m[1] + insertion);

  // memory-digest 的 name 从 camelCase 修正为 kebab-case
  if (file === "memory-digest.js") {
    src = src.replace(/name\s*:\s*"memoryDigest"/, 'name: "memory-digest"');
  }

  fs.writeFileSync(fp, src);
  changed++;
  console.log(`✓ ${file} → displayName=${meta.displayName} permissions=[${perms.join(",")}]`);
}

console.log(`\n完成：改 ${changed} 个，跳过 ${skipped} 个`);
