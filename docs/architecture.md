# Momo 架构说明

> 版本：v1.92.1 · 更新：2026-11-13
> 路径：`E:\Learn\Momo\`
> 这份文档必须和代码同步。改了架构就改这里，别让它比代码旧。

---

## 1. 这是什么

「桌面宠物 + QQ 机器人」的桥接系统：把桌宠的人设、记忆、情绪带到 QQ 上，同时给 QQ 聊天接入 LLM 智能体能力（工具调用、记忆检索、主动行为、受限自改）。

| 组件 | 作用 | 位置 |
|---|---|---|
| 桌宠（PySide6，自建身体） | 桌面形象、看屏幕、自己的聊天窗口 | `E:\Learn\Momo\body\` |
| **桥接（本仓库）** | 大脑：对话、记忆、情绪、工具、主动循环 | `E:\Learn\Momo\index.js` |
| SnowLuma | QQ 协议端（OneBot v11），由 NapCatQQ Desktop 提供 | `C:\ProgramData\NapCatQQ Desktop\components\SnowLuma` |
| DeepSeek API | 语言与推理 | `https://api.deepseek.com` |

```
QQ ──WS──> SnowLuma ──WS(3001)──> 桥接 index.js
                                   ├─ 插件平台（42 个插件 / 72 个工具 / 27 个命令，以 check.js/运行日志为准）
                                   ├─ Agent 循环（最多 6 步 工具调用）
                                   ├─ 本地状态（data/ JSON + stickers.db）
                                   └─ DeepSeek API
桥接 ──HTTP(3000)──> SnowLuma ──> QQ 回复 / 空间说说
桌宠 ──HTTP(3999)──> 桥接「联脑」接口（桌宠聊天也走同一套大脑）
```

## 2. 运行环境

- **Node.js 22+**（当前用 24）。**零 npm 依赖**，只用内置模块 + `node:sqlite`
- Windows（截图 / Toast / 找文件 / 开软件 等能力依赖 PowerShell）
- SnowLuma 在 `127.0.0.1:3000`（HTTP）/ `3001`（WS）暴露 OneBot v11
- API Key 从 `.env` 读 `DEEPSEEK_API_KEY`（`.env` 已 gitignore，不进版本库）

## 3. 目录结构

```
E:\Learn\Momo\
├── index.js                 # 主程序（~3800 行）：消息路由 / agent 循环 / 数据层 / 预算
├── plugin-host.js           # 插件宿主：加载器 / ctx / 钩子 / 工具与命令注册表
├── sticker-store.js         # 表情包语义库（node:sqlite，非插件）
├── config.json              # 配置
├── plugins/                 # 42 个功能插件
├── body/                    # 自建身体（Python/PySide6，v0.1 起；见 body-architecture.md）
├── self/                    # 自我进化层（identity / reflections / skills / journal / pref）
├── data/                    # 运行时数据（不进版本库）
├── stickers/                # 表情包文件 + stickers.db 语义库
├── test/                    # 59 个测试文件，纯 node 断言
├── docs/                    # 文档（本文件、development.md、changelog/、decisions/）
├── archive/                 # 历史补丁脚本与旧文档
├── supervise.ps1            # 守护进程（崩溃自动重启）
└── bridge.log               # 运行日志（UTC 时间戳）
```

## 4. 三层架构

| 层 | 在哪 | 职责 |
|---|---|---|
| **基础层（内核）** | `index.js` | 消息接入、agent 循环、数据存储、预算、权限判定、插件分发 |
| **插件层** | `plugins/*.js` | 所有具体功能；通过 `ctx` 拿内核能力，通过 `api` 给别的插件用 |
| **进化层** | `plugins/evolution.js` + `self/` | 自我内省、反思、技能规则、受限自改代码 |

进程内三个全局：`host`（插件宿主）、`apiKey`、`cfg`。
插件之间**不直接 require**，一律走 `ctx.getApi("<名字>")`。

### 4.1 身体层（独立进程，v1.64.0 起）

`body/`（Python + PySide6）是 Momo 的**新身体**，与大脑（Node 进程）分离：透明置顶窗、101 段帧序列动画、拖拽/点击回应/右键点播，v0.2 起通过本地 HTTP+SSE 接受大脑指令。旧第三方桌宠**不卸载、不改动**，两者可并行。

- 架构与运行：`docs/body-architecture.md`
- 分批计划与「还没实现的功能」：`docs/body-roadmap.md`
- 借鉴署名（素材来自 dsh-pet，非商用）：`docs/attribution.md`

## 5. 核心模块（index.js）

### 5.1 消息接入
- `handlePrivateMessage` / `handleGroupMessage`：解析文本、图片、表情、语音
- **防抖合并**：私聊 6 秒、群聊 3 秒（按「群+人」），上限 8 秒
- **漏消息补回**：`catchUpMissedMessages` 每 5 分钟，按 `seen-msg.json` 比对
- **屏蔽**：`mute.json`，入口硬拦截（主人例外）

### 5.2 Agent 对话
`agentChatOnce()`：一次回复最多 6 步 ReAct（思考 → 工具 → 结果回喂 → …）。

- 工具注册在插件里，`host.allToolDefs()` 汇总；桌宠场景会过滤掉只对 QQ 有意义的工具
- 预算耗尽时只保留不花钱的只读工具（`CHEAP_TOOLS`）
- 上下文结构：`system(人设+风格+情境) → 历史 → 动态块(实时上下文) → user`

### 5.3 记忆
| 层 | 存储 | 生命周期 |
|---|---|---|
| 会话历史 | `data/sessions/<key>.json` | 私聊 `QQ号`；群 `g<群号>_<QQ号>` |
| 短期记忆 | `data/short-memory/<qq>.json` | 7 天 |
| 长期记忆 | `data/memory/<qq>.json`（主人/访客统一，2026-11-08 起不再与旧桌宠互通） | 持久 |
| 自我记忆 | `self/identity.json` 等 | 持久 |

- 检索：关键词 2-gram + 命中次数 + 时间衰减（轻量 RAG，**无 embedding**）
- 私聊群聊互通：同一 QQ 号记忆共用，带 `channel` 标签

### 5.4 情绪与心情
- 15 种离散情绪 + 强度（`emotion.json`），有惯性与跳变限制
- 心情 `mood`（-100~100，`mood.json`）会随时间衰减
- 好感度 `favor`：**主人恒为 100**，访客 0~90 浮动
- 三者都会注入提示词，实际影响语气

### 5.5 主动行为（现在只有两层 + 心跳）
| 名称 | 频率 | 成本 | 作用 |
|---|---|---|---|
| 心跳 `heartbeat` | 1 秒 | 0（纯本地） | 状态更新、屏幕变化、无聊度 |
| 空闲心跳 `mindPulseTick` | 默认 60 秒 | 0（只记本地快照） | 记「节奏」，明显变化才唤醒思考；每小时最多唤醒 3 次 |
| 心流 `mindLoop` | 10 分钟 | 中 | `perceiveMind` 产生念头 → 冲动够高才 `deliberateMind` 决策 → `runMindAction` |
| 主动搭话 `proactiveLoop` | 60 秒检查 | 低 | 早安晚安 / 沉默搭话 / 跟进 / 试探 |

> v1.43 起删掉了「浅思考 shallowThink」和心流里的 `chat_master`：心流只管思考，主动发消息只管「何时打扰 + 说什么」，两边不重复。

### 5.6 表情包语义库（v1.46.0 起）
- 文件在 `stickers/`，语义在 `sticker-store.js` 的 sqlite（`stickers/stickers.db`）
- 受控词表：情绪 15 个 + 场景 20 个
- 7 态生命周期：`observed / understand_only / verified / disputed / stale / rejected / manual_locked`
- 只有 `verified` 或 `manual_locked`、`risk=low`、`allow_proactive=1` 的才能主动发
- 发图后回写上下文（`noteStickerSent`），下一轮注入「你上一条发的是 X（编号 b.003）」

### 5.7 自我进化
- 心流动作 `reflect`（每天 ≤1）/ `evolve`（探索，每天 ≤1）
- 采纳：`small` 自动写入 `self/`；`big` 存 `self/proposals/` 并提醒主人
- **受限自改**（`evolution.js`）：只能改 `plugins/self-*.js`，`node --check` + 冒烟，失败自动回滚；默认需要主人批准

### 5.8 拟人化
- `STYLE_DIRECTIVE`：防 AI 味 + few-shot（只学语气，不照抄字句）
- `SELF_AWARENESS`：自我认知写成「事实点」而不是完整句子——完整句子会被逐字复读
- 「当前活动」`current-activity.json`：被问「在干嘛」答案一致

### 5.9 近期新增（v1.65–v1.72）

- 身体 v0.4–v0.8：感官回流（键鼠空闲/前台窗口/锁屏/截图/投喂）、物理走路+甩抛、陪伴外挂（报时/天气/节日/待办播报/抽签/余额动画）、设置页+全局快捷键+免打扰、日志轮转+打包 exe+守护脚本
- 隐私加固（v1.71.1–v1.71.3）：身体感官只给主人 + 只桌面渠道注入 + 落盘脱敏（清掉 body-events 历史窗口标题 191 条）
- 报告中心（v1.72.0→v1.81.0）：原日报/周报/月报 + 晚间播报 + 账单 + 今日小结整合成一份「给主人的报告」（`plugins/report.js`），每天 23:00 她自己写一段发 QQ，发完写进成长记忆
- 提示词地图（`docs/prompt-map.md`，v1.72.0）：一轮请求的提示词分层与动态块清单
- 主动性调参（v1.72.0）：沉默 60 分钟主动搭话、身体自娱概率 ×2、每日生活费上限 3 元

## 6. 插件清单（42 个）

`appellations` `birthdays` `browse` `budget-report` `buzz` `capability-index` `dsh-link` `emotion`
`evolution` `followup` `fun-core` `goals` `group-chat` `group-info` `group-memes` `hobby`
`interact` `life-log` `memory` `memory-digest` `meta-cog` `mind` `mute` `pc-tools` `pet-body`
`proactive` `puzzle` `qzone` `read-article` `reminders` `report` `roles` `search` `settings`
`stickers` `teach` `todos` `user-profile` `vision` `voice` `weather`

## 7. 配置（config.json 主要项）

| 键 | 说明 | 当前值 |
|---|---|---|
| `chat.model` / `chat.reasoner_model` | 日常 / 推理模型 | `deepseek-v4-flash` / `deepseek-v4-pro` |
| `chat.base_url` | **必须指向 DeepSeek**，别指向桌宠接口（会自环） | `https://api.deepseek.com` |
| `budget.daily_cny` | 每日生活费上限 | `3` |
| `qq.master_user` | 主人 QQ | `100000001` |
| `qq.allowed_users` | 白名单 | 主人 + 1 位朋友 |
| `qq.group_mention_words` | 群里触发词 | momo / 大肥鱼 / 肥鱼 … |
| `runtime.python_path` | 跑 tts.py / digest.py / 标注脚本的 Python | runtime 的 python.exe |

**运行时参数**（可被她自己调、也可在 QQ 里设）：一律走插件 `settings` 注册表，不是写死在代码里。

## 8. 运行时数据（data/，不进版本库）

`sessions/` 会话 · `short-memory/` 短期记忆 · `memory/` 访客长期记忆 ·
`emotion/mood/boredom/favor.json` 情绪四件套 · `current-activity.json` 她在干嘛 ·
`current-status.json` 对方状态 · `mind.json` 念头 · `mind-pulse.json` 心跳节奏 ·
`reminders/birthdays/goals/wishes.json` 日程与愿望 · `mute/appellations.json` 屏蔽与称呼 ·
`budget*.json` 预算 · `taught.json` 教学 · `user-profile.json` 用户画像 ·
`meta-cog.json` 元认知统计 · `actions.jsonl` 动作日志 · `qzone-state.json` 说说记录 ·
`headpat.json` 摸头 · `sticker`-相关在 `stickers/`

## 9. 运维

- 启动：`supervise.ps1`（循环 `node index.js`，崩溃几秒后拉起）
- 重启：`taskkill /PID <node> /F` → supervisor 自动拉起（约 15 秒）
- 自检：`node check.js`（语法 + 配置 + 插件结构）
- 测试：`node test/<名字>.js`，全部跑一遍约 10 秒
- 健康：日志出现 `插件平台就绪：42 个插件（工具 71 / 命令 26）` + `Bot 上线`

## 10. 已知限制

- 截图 / SAPI / 开软件 / Toast 依赖 Windows
- 桌宠联动仅本机有效
- QQ 协议端受腾讯风控约束
- **没有 embedding**，记忆与表情包检索都是关键词近似
- 表情包语义靠文件名 + 人工教学，内置图有 60+ 张落在默认「平静」，分类偏粗
- 桌宠里的 `todo_items.json` 只在启动时读，外部写入不会立即生效（用 Windows Toast 兜底）
