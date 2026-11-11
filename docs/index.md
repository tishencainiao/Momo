# Momo 文档地图（先读这里）

> 版本：v1.90.2 · 2026-11-11
> 这份文件是**所有文档的索引**：改代码前，先在这里 30 秒内定位「该读哪几份」。
> 规则：`docs/` 下每份 `.md` 都必须在这张表里登记（`scripts/doc-check.js` 会校验，漏登记=红（拦提交））。

## 一、怎么用这张表

- **「给谁看」**：🤖=给 AI 编码时读（事实/规范）· 👤=给主人读（通俗）· 🤖👤=都要读。
- **「状态」**：现状态=以代码为准的当前事实 · 目标态=愿景/还没做的 · 历史=已落地的方案（只读不改）。
- **「何时更新」**：改了什么代码，就同步哪份（对应 `development.md` 第十二节纪律第 8 条「改动即更新」）。

## 二、文档索引

### 参考（现状态 · 代码里是什么）

| 文档 | 回答什么 | 给谁看 | 何时更新 |
|---|---|---|---|
| [architecture.md](architecture.md) | 整体架构、三层、核心模块、插件清单、配置、数据、运维、已知限制 | 🤖👤 | 改架构/模块时 |
| [prompt-map.md](prompt-map.md) | 每一轮请求拼进提示词的层与动态块（system0-7 + 18 动态块） | 🤖👤 | 改提示词常量/动态块时 |
| [plugin-guide.md](plugin-guide.md) | 插件平台唯一规范入口：命名、Manifest 字段、apiSpec | 🤖 | 改插件规范时 |
| [body-architecture.md](body-architecture.md) | 身体（PySide6 进程）架构、运行、感官 | 🤖 | 改 body/ 时 |
| [body-api.md](body-api.md) | 身体本地 HTTP/SSE 接口端点表 | 🤖 | 改 body/netapi 端点时 |
| [body-roadmap.md](body-roadmap.md) | 身体分批计划 + 未实现功能清单（防「还没做」当「做到了」） | 🤖 | 每批落地时 |
| [report-center.md](report-center.md) | 「给主人的报告」怎么生成、发什么、何时发 | 🤖 | 改 report.js 时 |
| [roles-and-permissions.md](roles-and-permissions.md) | 角色/权限/参数级权限约定 | 🤖 | 改权限判断时 |

### 指南（怎么做 · 流程/规范）

| 文档 | 回答什么 | 给谁看 | 何时更新 |
|---|---|---|---|
| [development.md](development.md) | 开发规范：提交/改动流程/版本纪律/调用链必查/回写上下文/发布闭环/文档纪律 | 🤖 | 改流程规范时 |
| [remote-backup-gitee.md](remote-backup-gitee.md) | 可选：把代码备份到 Gitee 私有库 | 👤 | 很少 |

### 解释（为什么 · 目标/取舍/决策）

| 文档 | 回答什么 | 给谁看 | 状态 | 何时更新 |
|---|---|---|---|---|
| [vision.md](vision.md) | 定位与期望：短期智能体/中期连续存在/长期电子生命 + 现状诊断 | 🤖👤 | **目标态** | 定位讨论时 |
| [roadmap.md](roadmap.md) | 想过但暂缓的方案和原因 | 👤 | 目标态 | 动手前读 |
| [decisions/](decisions/) | 关键决策记录（0001-0007，为什么这么做） | 🤖 | 现状态 | 新决策时 |

### 历史（已落地 / 一次性 · 只读不改）

| 文档 | 是什么 | 状态 |
|---|---|---|
| [entertainment-plan.md](entertainment-plan.md) | 娱乐活动方案 v2 | 已落地 v1.62.0 |
| [fabrication-guard-plan.md](fabrication-guard-plan.md) | 防捏造能力方案 | 已落地 v1.63.0 |
| [voice-clone-plan.md](voice-clone-plan.md) | 本地语音克隆方案 | 已落地 v1.47.0 |
| [graduation-project-reuse.md](graduation-project-reuse.md) | 毕设复用指引（拆旅游智能体） | 参考 |
| [research-references.md](research-references.md) | 前沿论文参考（改记忆/进化前读） | 参考 |
| [article-momo.md](article-momo.md) | 对外文章《我养了一只住在 QQ 里的电子生命》 | 对外文章 |

### 归因与致谢

| 文档 | 回答什么 | 给谁看 |
|---|---|---|
| [attribution.md](attribution.md) | 身体+插件「借鉴了什么、按什么授权」的登记（合规） | 🤖 |
| [credits.md](credits.md) | 第三方软件/模型/借鉴的致谢（人读） | 👤 |

### 子目录

| 目录 | 内容 |
|---|---|
| [changelog/](changelog/) | 按月份拆的完整变更记录（`2026-10.md`、`2026-11.md`） |
| [licenses/](licenses/) | 第三方许可文本（GPT-SoVITS / LLM-live2d / dsh-qqbot-muu） |

## 三、给 AI 的快速入口

改代码前**先看根目录 `AGENTS.md`**（「改 X 必读 Y」映射 + 三步速查），再回来这里定位具体文档。
