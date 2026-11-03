> 原 `未来修改方向.md`，v1.46.2 起并入 docs/。动手前先读：这里记的是**想过但不做**的方案和原因。

# 未来修改方向（已评估但暂缓）

> 记录**已评估但暂缓**的改动：问题是什么、方案怎么设计、为什么先不做。后续动手前先读这里，避免重复调研。

---

## 一、上网能力（最想改，已搁置）

### 现状问题

| # | 问题 | 具体表现 |
|---|---|---|
| 1 | **搜索结果只有标题/摘要** | Bocha 返回 `title + url + snippet`，没有正文；Momo 只能基于摘要回答，容易浮于表面 |
| 2 | **百度 HTML 抓取不可用** | ① Node `fetch` 连 baidu.com 超时（undici 兼容问题）② 换 `https.get` 后百度间歇弹验证码（wappass 反爬）③ 就算拿到页面，`parseBaiduHtml` 的 `class="result c-container"` 正则已过期，解析出 0 条 |
| 3 | **没有浏览器能力** | 打不开需要 JS 渲染、需要登录、有反爬的页面 |

### 方案 A（推荐后续实施）：系统 Chrome + CDP

**原理**：用系统已装的 Chrome，以「远程调试」模式启动，Momo 通过 CDP（Chrome DevTools Protocol）驱动它——导航、执行 JS、提取正文。**零依赖**（Node 自带 WebSocket）。

**启动方式**（一次性，后台常驻）：

```powershell
# 用一个独立 profile，避免和日常 Chrome 冲突
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\momo-chrome-profile" `
  --headless=new --disable-gpu --no-first-run
```

**Momo 侧调用流程**：

1. `GET http://127.0.0.1:9222/json/new?<url>` → 拿到 `webSocketDebuggerUrl`
2. 用 Node 原生 `WebSocket` 连上
3. 发 CDP 命令：
   - `Page.enable`
   - `Page.navigate {url}`
   - 等 `Page.loadEventFired`
   - `Runtime.evaluate {expression: "document.body.innerText", returnByValue: true}`
4. 拿到正文 → 截断（比如 3000 字）→ 注入到回答上下文
5. `Page.close` 关标签页（或复用同一个标签页反复导航）

**优势**：
- 零依赖（不引入 Playwright/Puppeteer，不破坏「零依赖」红线）
- 真浏览器 = 反爬能力强，JS 渲染页也能读
- 能拿全文，回答质量提升明显
- 还能截图（`Page.captureScreenshot`）

**代价 / 风险**：
- 需要常驻一个 Chrome 实例（内存占用，建议 headless）
- 要多写一个 CDP 客户端（约 100~150 行）
- 端口 9222 可能被其它程序占用（要检测）
- 需要处理超时、页面加载慢、标签页泄漏

**实现要点（备忘）**：
- 先 `GET /json/version` 探测 Chrome 是否在；不在就 spawn 一个
- 用同一个 tab 反复导航，避免开一堆标签页
- 抓正文前等 `document.readyState === "complete"`
- 对超长页面截断（3000 字足够）
- 失败要降级回 Bocha 摘要，不能因为浏览器挂了就完全没网

### 为什么不选另外两个方案

| 方案 | 否决原因 |
|---|---|
| B. 直接 spawn `dsh-ego-browser` 的运行时 | ego 的 CLI 协议是 DSH 插件内部封装的、**没有对外文档**；版本跟着 DSH 插件升级走，容易一夜失效 |
| C. 调 DSH 的 `/api/ego/*` 路由 | 那些路由是**给右侧观察窗做实时推流/手动接管**的（spaces/stream/input/close），**没有「导航并返回正文」的接口** |

---

## 二、可观测（第三批第 9 项，明确跳过）

原计划做「首字耗时 / Token 用量 / Prompt Cache 命中率」的监控面板。跳过的原因：Momo 已有 `budget.json` 记录花费与调用次数，再加一层监控收益有限，且需要改动回复主链路。

---

## 三、其它搁置项（工程架构借鉴）

| 项 | 来源 | 为什么不急 |
|---|---|---|
| 分级权限（rule / permission） | NoneBot2 / Karin | 现在「主人 / 访客 / 陌生人」三档够用 |
| 适配器抽象（多平台） | NoneBot2 / TRSS-Yunzai | 目前只跑 QQ（OneBot v11） |
| Web 管理界面 | AstrBot / Karin / MaiBot | 只有 QQ 命令，但工程量大、收益一般 |
| 插件元数据（package.json 式） | Karin | 现在 name/version/requires 够用 |
| 插件商店 / 分发 | Karin / AstrBot | 个人自用，不需要分发渠道 |
| Docker 部署 | Karin | 只在本机 Windows 跑 |
| 数据库持久化（Redis/SQLite） | TRSS-Yunzai | JSON 文件够用，且零依赖 |

---

## 四、统一记忆提炼系统（待做）

**问题**：现在有**两个独立的提炼系统**，各自一套提示词、触发、存储，没有统一分类：

| 系统 | 文件 | 提炼什么 | 触发 | 存储 |
|---|---|---|---|---|
| 主人记忆 | `plugins/memory.js` | 「关于主人的事实」 | 批量（攒 3 段） | 短期 → 长期记忆（主人=桌宠共享） |
| 成长记忆 | `plugins/evolution.js` | 「关于 Momo 自己的成长记忆」 | 即时单条（30 分钟节流） | `self/identity.json` |

**缺陷**：
1. 判断「是主人的事还是 Momo 的事」靠两个提示词**各自写死的范围**，不是统一分类器
2. 边界模糊：如「对方夸你或指出你的点」既是主人的事又是 Momo 的事，两边都可能记或都不记
3. 重复开销：每条对话可能触发两个 LLM 调用
4. 触发不一致：一个批量一个即时，节奏对不上
5. 实际踩坑：用户说「Momo 住在我电脑上」（关于 Momo 自己的处境），该进成长记忆却可能被漏掉

**理想方案**：统一成一个提炼系统，一次调用，模型在同一个 prompt 里同时输出两类：
```json
{"about_user":["主人的事实1"], "about_self":["Momo 的成长记忆1"]}
```
好处：分类由模型在同一框架判断、只花一次调用、触发统一。

**为什么暂缓**：属于架构重构，风险比普通 bug 修复高；现在两套虽不优雅但功能可用。建议等要动记忆系统时一起重构。

---

## 变更记录

- **2026-10-30** 创建。起因：评估 `dsh-ego-browser` 能否改善 Momo 上网效率，结论是「能力可用但直接复用太重」，先记录方案 A（系统 Chrome + CDP），暂缓实施。
- **2026-10-31** 新增「四、统一记忆提炼系统」。起因：用户指出「住在电脑上」没进记忆，排查发现 memory.js（主人记忆）与 evolution.js（成长记忆）是两个独立提炼系统，分类靠写死范围、边界模糊、重复开销。

