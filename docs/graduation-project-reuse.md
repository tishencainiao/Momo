# 毕设复用指引：从 Momo 拆出「旅游智能体」

> 2026-11-03 整理。目的：给「旅游智能体」毕设当起点。总原则：**搬大脑，不搬手脚。**

## 一、直接复用（核心）

| 模块 | Momo 位置 | 在旅游 agent 里的角色 |
|---|---|---|
| Agent 主循环（ReAct ≤6 步 + Function Calling + 工具分发） | index.js：agentChatOnce / agentToolCall / AGENT_TOOLS | 问答、行程规划的主循环 |
| 插件平台三层架构 | plugin-host.js + plugins/*.js 的插件写法 | 功能模块化（论文架构章节可直接用） |
| 分层记忆 + 滚动摘要 | index.js 记忆段（loadMemories / retrieveMemories / rollSessionSummary）+ plugins/memory.js | 记住游客偏好、预算、去过的城市、行程 |
| 联网搜索链路 | index.js：decideAndSearch（先判断再搜）+ bochaSearch / baiduSearch | 景点开放时间、门票、天气、攻略的实时信息 |
| 用户画像 | plugins/user-profile.js | 个性化推荐依据（喜好城市 / 预算 / 同行人） |
| 生活费预算与分级降级 | index.js：budget* 段 | API 成本控制（论文「工程实践」章节素材） |
| 工程规范 | check.js、test/ 的断言式测试、版本纪律、操作留痕 recordAction | 毕设的开发流程与测试（答辩加分） |

## 二、改一改再用

| 模块 | 改什么 |
|---|---|
| 记忆检索 | 现在 2-gram 关键词 + 时间衰减；旅游 agent 可加 embedding 语义检索（这就是论文的对比实验素材） |
| 情绪 / 主动行为 | 可选；若保留，去掉 QQ 渠道部分，只留「行程提醒」类主动 |
| 提示词工程 | STYLE_DIRECTIVE（防 AI 味）、「事实点不写台词」、prompt 前缀缓存结构——直接抄模式，内容换成旅游人设 |

## 三、不要搬（QQ 的「手脚」）

QQ/OneBot 接入层（handlePrivateMessage 等）、群聊 / 表情包 / QQ 空间 / 语音 / 拍一拍、桌宠联脑接口、电脑操作（截图 / 开软件）、进化层受限自改。旅游 agent 前端换成 Web 聊天界面（简单 HTML 或 Streamlit 均可，毕设重点不在前端）。

## 四、毕设加分点建议

1. **创新点 = 记忆消化（反思合成）**：把「记忆 → 定期反思 → 合成『关于用户的新认识』」做成毕设核心（参考 Generative Agents，arXiv:2304.03442；Momo 的 docs/research-references.md 有清单）。这正好也是 Momo 下一个大功能，两边可互相借鉴。
2. **大数据元素（贴合你的专业）**：把用户偏好结构化存下来，做简单统计（热门城市、预算分布、提问意图分类），给论文加一章「数据分析」。
3. **行程规划工具**：写一个 plan_trip 工具，让模型输出结构化行程 JSON（天 / 景点 / 交通 / 预算），前端渲染成卡片。

## 五、新会话开场白（直接复制）

```
我在做一个旅游智能体的毕业设计，计划复用 Momo（E:\Learn\Momo）的一部分代码。
复用清单与改造建议在 E:\Learn\Momo\docs\graduation-project-reuse.md，请先读它。
背景：Momo 是我的 QQ 桌宠智能体（Node 零依赖、GitHub tishencainiao/Momo，公开仓库在 E:\Learn\Momo-public）；
毕设要去掉 QQ 相关、换成 Web 前端；建议的创新点是「记忆消化（反思合成）」，大数据元素是「用户偏好统计分析」。
请给我 2~3 个毕设方案（含推荐、工作量、风险），我先确认方向再动手。
```
