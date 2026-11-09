# 借鉴与署名（身体 + 插件）

> 本文件统一记录 `body/`（身体）与 `plugins/`（插件）里哪些东西是**借鉴/复用**别人的，分别为谁、按什么授权。
> 规则：**凡是借鉴，必须在这里留一行**；不能只在代码注释里提一句。
> 插件侧：借鉴项还需在各自 `module.exports` 里写 `attribution` 字段（`{source, license, note, importedAt}`），体检（plugin-doctor）校验 `source` + `license` 齐全。

## 1. 上游项目

| 项目 | 地址 | 用在哪儿 | 授权 |
|---|---|---|---|
| dsh-pet | https://github.com/PC2005-cloud/dsh-pet | 动画素材（形象）、frameseq 目录组织方式、move_strides 位移标定思路 | 代码 MIT；**素材允许开源使用，禁止商用** |
| dsh-pet-indesktop | https://github.com/MerZlin/dsh-pet-indesktop | 本机现用桌宠（PySide6 桌面移植版），身体要复刻它的行为手感；部分桌面端做法（透明窗/多屏/双击等）作为参照 | MIT |

**二创约定**：上游要求「基于本项目的衍生/改版/换皮作品，在任何介绍、展示、分发处须附上原作者地址」。因此：

- 本项目 README / `docs/body-architecture.md` / 公开镜像的说明里，都保留 `PC2005-cloud/dsh-pet` 的链接；
- 素材**不用于商业用途**；公开仓库不收录素材本身（只给复制/转换脚本）。

## 2. 素材清单（复制自旧桌宠，运行时读取）

| 目录/文件 | 内容 | 来源 |
|---|---|---|
| `body/assets/frameseq/` | 101 段动画的**已解码逐帧**（webp，24fps，640×360 画布） | `dsh-pet-indesktop` 安装目录 `_internal/assets/characters/shenshen/frameseq` |
| `body/assets/sounds/` | click / done / error / start 音效 | 同上（`assets/sounds`，其中 duck 音效上游声明来自 MeteorNOX/DeepSeek-Balance-Whale-Widget，MIT） |
| `body/assets/move_strides.json` | 3 个移动动画的「每圈位移 px + 逐帧曲线」标定 | 同上（`videos/move_strides.json`） |
| `body/assets/text_clips.json` | 6 个含文字的动画（不能水平镜像） | 同上（`videos/text_clips.json`） |
| `body/assets/manifest.json` | body_box / head_box 参考框 | 同上（`videos/manifest.json`） |

素材不进版本库（`.gitignore` 排除 `body/assets/`），复制方法见 `scripts/convert-assets.ps1`。

## 3. 代码：借鉴思路，自写实现

| 模块 | 借鉴了什么 | 说明 |
|---|---|---|
| `body/anim.py` | frameseq 的「一段一目录 + meta.json(fps/frames)」组织；按 fps 索引进帧 | 未复制上游源码；数据结构是公开的素材格式 |
| `body/pet_app.py` | 交互行为：点击回应、拖拽跟手、右键「动作→分类→点播」、位置记忆 | 行为参照上游产品设计，实现自写 |
| `body/sound.py` | 音效播放 | **自研**：用 Qt 的 `QSoundEffect`（PySide6-Addons）+ winsound 降级。虽然方案讨论时参考过上游 `sound_winmm.py` 的「常驻播放器」思路，最终**没有采用/复制**它的代码 |
| `docs/body-roadmap.md` | 缺失功能清单的划分维度（余额/碎碎念/工作状态等） | 只列功能名，不搬代码 |

## 4. 未借鉴 / 明确自研

- 进程与通讯模型（身体独立 Python 进程 + 本地 HTTP/SSE + token）——上游没有这套接口，是本项目为「大脑控制身体」自定的。
- 与 Momo 大脑的接线（`plugins/pet-body.js`、`data/body-events.jsonl`）——自研。
- 感官采集方案（`GetLastInputInfo` 判空闲、`WM_WTSSESSION_CHANGE` 判锁屏、截图交大脑做视觉）——v0.4 落地，自研。

## 5. 核对方式

```powershell
# 列出身体目录里所有「借鉴」标注
Select-String -Path body\*.py,scripts\*.ps1 -Pattern "借鉴|upstream|dsh-pet" -SimpleMatch
```

## 6. 插件（plugins/）借鉴

| 插件 | 借鉴来源 | 说明 |
|---|---|---|
| `capability-index.js` | DeepSeek Harness ToolCatalogIndex | 「索引常驻 + 按需装载」组织思路，实现自写 |
| `meta-cog.js` | Agentic Metacognition（arXiv:2509.19783） | 「次级监控层」思路，只用规则不加 LLM 开销 |
| `todos.js` | DSH dsh-memory-evolve（dtodo） | 待办数据结构 + 到期提醒思路 |
| `user-profile.js` | 角色扮演提示词指南（用户画像抽取） | 从聊天提炼稳定画像的字段维度 |

> 以上均为「思路借鉴」，未复制源码；`attribution` 字段已写在各自 `module.exports` 里。
