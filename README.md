# Momo（大肥鱼 QQ 桥接）

把桌面宠物 Momo 的人设、记忆、情绪带到 QQ 上，并给她接入 LLM 智能体能力：工具调用、记忆检索、主动行为、受限自改代码。

- **底座**：Node.js 22+（当前 24），**主体零 npm 依赖**，只用内置模块 + `node:sqlite`；唯一可选依赖 `@huggingface/transformers`（语义嵌入，npmmirror 安装）
- **协议端**：SnowLuma（NapCatQQ Desktop 组件），OneBot v11
- **规模**：52 个插件 / 75 个工具 / 32 个命令
- **版本**：当前 **v2.2.1**（详见 [CHANGELOG.md](CHANGELOG.md) 顶部索引）

## 文件都在哪

| 路径 | 说明 |
|---|---|
| `index.js` | 基座：消息路由、agent 循环、数据层、预算、插件分发 |
| `plugin-host.js` | 插件宿主：加载器、ctx、钩子、工具/命令注册 |
| `sticker-store.js` | 表情包语义库（node:sqlite，非插件） |
| `plugins/` | 52 个插件 |
| `self/` | 进化层状态（identity / reflections / skills / journal / pref） |
| `data/` | 运行时数据：会话、记忆、待办、预算（**不进版本库，要备份请单独拷**） |
| `stickers/` | 表情包文件 + `stickers.db` 语义库 |
| `test/` | 94 个测试文件（纯 node 断言） |
| `docs/` | 文档，见下表 |
| `archive/` | 历史补丁脚本与旧文档 |

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 架构、模块、数据、运维、已知限制（**改了架构要同步这里**） |
| [docs/development.md](docs/development.md) | 开发规范：提交、改动流程、权限约定、调用链必查、settings、回写上下文 + 插件怎么写 |
| [docs/roadmap.md](docs/roadmap.md) | 想过但暂缓的方案和原因，动手前先读 |
| [docs/changelog/](docs/changelog/) | 按月份拆的完整变更记录 |
| [docs/decisions/](docs/decisions/) | 关键决策记录（为什么这么做） |
| [docs/remote-backup-gitee.md](docs/remote-backup-gitee.md) | 可选：把代码备份到 Gitee 私有库 |

## 运行

- 守护进程：`supervise.ps1`（崩溃自动重启）
- 开机自启：启动文件夹 `dsh-pet-qq-autostart.vbs`（先起 NapCatQQ，20 秒后起 supervise）
- 配置：`config.json`（模型 / QQ 白名单 / 预算 / 搜索等）
- 自检：`node check.js`
- 测试：`node test/<名字>.js`

## 版本纪律

1. 改代码 → `BASE_VERSION` +1（`index.js` 顶部）
2. 写 [CHANGELOG.md](CHANGELOG.md) / `docs/changelog/<年>-<月>.md`
3. `git commit` → `git tag v<版本号>`
4. 回滚：`git checkout v<旧版本> -- index.js plugins/` → 重启

> v1.46.0 起不再做 `versions/` 快照，历史版本全靠 git tag；`data/` 与 `versions/` 都在 `.gitignore` 里。
