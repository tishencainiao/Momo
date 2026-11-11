# 开发规范与插件指南

给 Momo 改代码 / 加功能时，遵守这几条，能让项目长期健康。

## 一、提交规范（Conventional Commits）

commit message（提交信息）用「类型: 说明」格式，类型固定这几个：

| 类型 | 含义 | 例子 |
|---|---|---|
| `feat` | 新功能（feature） | `feat: 新增待办插件` |
| `fix` | 修 bug（fix） | `fix: 修复回复串台` |
| `chore` | 杂项/工程（chore） | `chore: 密钥移出 git` |
| `docs` | 文档 | `docs: 更新 README` |
| `refactor` | 重构（不改行为） | `refactor: 拆分 index.js` |

> 好处：`git log --oneline` 一眼能看出每次改了什么、是加功能还是修 bug。

## 二、改动流程（每次改代码都走）

```bash
# 1. 改完代码后，先自检（语法 + 配置 + 插件结构）
node check.js          # 或 npm run check

# 2. 跑冒烟测试（核心函数断言）
node test/smoke.js     # 或 npm test

# 3. 提交（pre-commit 钩子会自动再跑一遍 check.js，不过就提交不进去）
git add -A
git commit -m "feat: 描述"

# 4. 重启让改动生效
#    taskkill 杀掉 node 进程，supervise.ps1 会自动拉起

# 5. 发布：升版本 + CHANGELOG + tag + 公开镜像 + 双平台推送
#    统一走 release.ps1（详见「十一、发布闭环」）
powershell -NoProfile -ExecutionPolicy Bypass -File .\release.ps1 -Bump patch -Message "改了什么"
```

## 三、版本纪律（摘要，详见 [CHANGELOG.md](../CHANGELOG.md) 文件头）

1. 改 `index.js` 或插件 → `BASE_VERSION` +1
2. `CHANGELOG.md` 记一条
3. 提交 + 打标签：`git commit -am "..."` → `git tag v<版本号>`
4. 回滚：`git checkout v<旧版本> -- index.js plugins/`（或 `-- .`）→ 重启

> v1.46.0 起不再做 `versions/` 快照，版本全走 git 标签；`data/` 不进版本库。

## 四、怎么加一个新插件

1. 在 `plugins/` 新建 `你的插件.js`，结构：
   ```js
   module.exports = {
     name: "插件名",
     version: "1.0.0",
     init(ctx) { _ctx = ctx; },
     tools: [ { def: {...}, handler(args, info) {...} } ],   // agent 工具
     commands: [ { key: "/命令", regex: /^\/命令/, handler(msg) {...} } ],  // 斜杠命令
     hooks: { startup() {}, timer(payload) {}, reply(payload) {}, private_message(payload) {} },
   };
   ```
2. `ctx` 提供：`log(level,msg)`、`DATA_DIR`、`config`、`sendPrivate`、`recordAndSend`、`isMaster`、`loadMemories/saveMemories`、`getSetting/setSetting`、`recordAction`、`settings` 等（见 `plugin-host.js`）。
3. 保存后重启即自动加载（`plugin-host.js` 扫描 `plugins/` 目录）。
4. 在 `check.js` 通过后（插件结构检查）再提交。
5. **新功能必须把「可调参数」暴露出来**（见第八节），让 Momo 能自己改，而不是写死在代码里。
6. **有副作用的工具必须调 `_ctx.recordAction`**（见第九节），记录「谁要求的」——否则事后说不清是谁让做的。
7. **工具参数带 `user_id`/`group_id` 时要判参数级权限**（见第六节）——对别人做必须主人。

## 五、密钥 / 敏感信息（红线）

- **密钥一律放 `.env`**（已 gitignore），`config.json` 里只留空值。
- 不要往 `config.json`、代码、日志里写明文 key。
- 将来推远程前，去服务商后台**换新 key**（旧 key 已在本地 git 历史里）。

## 六、权限约定（必查，加新功能时逐条对照）

判断依据是**数据范围 + 副作用**，不是"感觉重要不重要"：

| 情况 | 是否要 `isMaster` | 例子 |
|---|---|---|
| **全局数据**（一个文件/一份状态所有人共享） | ✅ 必须 | `goals.json`、预算账本、DSH 通知开关、表情包库、自改代码 |
| **会对外产生副作用** | ✅ 必须 | 发 QQ 空间、替人发消息、花钱调 API、改配置 |
| **改别人的东西** | ✅ 必须 | 给别人设称呼、屏蔽别人 |
| **按 `userId` 隔离的自助功能** | ⚪ 可不加 | 自己的记忆、自己的待办、自己的生日、自己的提醒 |

实现方式：

```js
// 工具
handler(args, info) {
  if (!_ctx.isMaster(info.userId)) return "（只有主人能……哦）";
  ...
}
// 命令
handler(msg) {
  if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能……哦～"); return; }
  ...
}
```

### 参数级权限（工具带「指定对象」参数时必查）

有时候工具本身该对所有人开放，但**参数不同权限也不同**。这时候光加 `isMaster` 会误伤，得看**目标是不是调用者自己**。

```js
// 拍一拍：拍自己可以，拍别人只有主人
handler(args, info) {
  const me = Number(info.userId) || 0;
  const target = Number(args.user_id) || me;
  if (target !== me && !_ctx.isMaster(me)) return "（只有主人能让我对别人做这个哦）";
  ...
}
```

**判断口诀**：工具参数里有没有 `user_id` / `group_id` 这类「指定对象」的字段？
- 有 → 必须判断**目标 == 调用者**，否则要求主人
- 没有 → 按上面那张表加 `isMaster` 即可

> 权限管住「**能不能做**」，但不管「**事后说不说得清是谁让做的**」。所以有副作用的动作，除了权限，还要按**第九节**调 `_ctx.recordAction` 记下 `by`。

### 踩过的坑（真实案例）

- `goals` 是**全局** `goals.json`，`set_goal` 没加校验 → 访客能改 Momo 的长期目标，还会注入到所有人的对话里（v1.10.13 修复）
- `/做表情包` 没加校验 → 访客能触发生成（一旦接了付费图像 API 就是花钱漏洞）
- 密钥迁到 `.env` 后，插件仍直读 `config.bocha_api_key` → 进化探索/空间发文**静默失效**（v1.10.8 修复）。**改全局配置时，要搜一遍有没有插件绕过统一入口直读。**
- **`plugins/interact.js` 的 `poke` / `send_like` 漏了权限**（v1.28.1 修复）：当时只想到「拍正在聊天的人」是正常互动，忽略了工具带 `user_id` 参数意味着**能拍第三方**——群里任何人说「拍拍老王」都会真的拍过去。这就是「参数级权限」的典型漏法。

### 每次改动后的自查

1. 新加的工具/命令，有没有 `isMaster`？
2. **工具参数里有没有 `user_id` / `group_id` 这类「指定对象」？有的话目标 != 调用者时是否要求主人？**
3. 它读写的数据是全局的还是按人的？
4. 它会不会花钱、发消息、改配置、动别人的东西？
5. 改全局配置/密钥后，有没有插件还在旧入口读？

## 七、改动前必查：调用链与影响面

**改任何函数、数据结构、返回类型之前，先查清「谁在用」**，别改完才发现别的插件崩了。

### 三步确认

| 步骤 | 要查什么 | 怎么查 |
|---|---|---|
| 1. 谁调用它 | 所有调用点 | `Select-String -Pattern '函数名\('` 搜 `index.js` + `plugins/*.js` |
| 2. 数据谁在读 | 共享的 `data/*.json` 有几个插件在读 | 搜文件名，看读的地方是否依赖某个字段 |
| 3. 改动影响 | 返回类型变了？字段没了？语义变了？ | 逐个调用点核对是否还成立 |

### 常用命令

```powershell
$m='E:\Learn\Momo'
# 查函数被谁调用
Select-String -Path "$m\index.js","$m\plugins\*.js" -Pattern '函数名\('
# 查数据文件被谁读写
Select-String -Path "$m\index.js","$m\plugins\*.js" -Pattern 'xxx\.json'
# 查某能力被谁取用（插件间调用）
Select-String -Path "$m\index.js","$m\plugins\*.js" -Pattern 'getApi\("(\w+)"\)'
```

### 真实踩坑记录（都是「没查调用链」导致的）

| 版本 | 问题 |
|---|---|
| v1.10.8 | 密钥从 `config.json` 迁到 `.env`，但 `evolution.js` / `qzone.js` 还直读旧字段 → 静默失效 |
| v1.10.10 | `agentChatOnce()` 返回 `{reply, stickers}`，`proactiveAgentTurn()` 却当字符串用 → 发出 `[object Object]` |
| v1.10.13 | `goals` 是全局数据但没加 `isMaster` → 访客能改 Momo 的长期目标 |
| v1.14.1 | `teachCtx` 和 `memoryPrompt` 注入同一条内容 → 重复占上下文 |

### 改动后自查

- [ ] 这个函数/字段还有谁在用？全部调用点都适配了吗？
- [ ] 返回类型/字段名改了，前端（调用方）跟着改了吗？
- [ ] 共享数据文件（`data/*.json`）有几个插件在读？新增字段会不会破坏它们的解析？
- [ ] 权限（`isMaster`）有没有漏？
- [ ] 新增能力是否需要登记到 `requires`？
- [ ] **新功能里那些「以后可能想调」的数字/开关/城市/频率，有没有暴露成 `settings`？**

## 八、可配置参数（让 Momo 能自己调）

**原则：凡是「以后可能想改」的值，都不要写死在代码里，而是声明成 `settings`。**

这样 Momo 能通过 `settings_view` / `settings_set` 自己调整，不用改代码、不用重启。

### 怎么声明

在插件的 `module.exports` 里加 `settings` 数组：

```js
module.exports = {
  name: "weather",
  version: "1.1.0",
  init(ctx) { _ctx = ctx; },
  /* 宿主自动收集，Momo 能看到并修改 */
  settings: [
    { key: "weather.city", label: "天气城市", type: "string", default: "", desc: "留空=按IP定位" },
  ],
  // ...
};
```

**字段说明**

| 字段 | 必填 | 说明 |
|---|---|---|
| `key` | ✅ | 全局唯一，建议 `插件名.参数名`（如 `browse.daily_max`） |
| `label` | ✅ | 中文名，会显示给 Momo/主人 |
| `type` | ✅ | `string` / `number` / `boolean` |
| `default` | ✅ | 没设置时的默认值 |
| `desc` | | 补充说明 |
| `min` / `max` | | `number` 类型的范围校验 |
| `options` | | `string` 类型的枚举可选值 |
| `maxLength` | | `string` 类型的最长长度 |

### 怎么读

```js
const v = _ctx.getSetting("browse.daily_max", 3);   // 第二个参数是默认值
```

**不要**自己读写 `data/settings.json`，统一走 `getSetting` / `setSetting`。

### 校验规则（`plugins/settings.js` 自动做）

- `number`：转数字，越界拒绝
- `boolean`：支持 `开/关`、`true/false`、`1/0`
- `string`：去空格、截断、枚举校验

### 权限

`settings_view` 和 `settings_set` **仅主人可用**（避免被人乱调）。

### 已验证的示例

| 参数 | 插件 | 说明 |
|---|---|---|
| `weather.city` | `plugins/weather.js` | 天气城市 |
| `browse.daily_max` | `plugins/browse.js` | 每天刷内容次数（1~10） |

## 九、自动动作必须回写上下文（否则她会说假话）

**规则：任何「系统替她自动完成」的动作，如果改变了事实状态，就必须把结果写进模型上下文。**

### 为什么

模型只能根据上下文说话。如果一件事**在后台真的发生了**但上下文里没有，模型就会按旧印象回答——**说出来的假话并不是它在编，而是它真的不知道**。

两个真实案例：

| 事故 | 后台实际发生了什么 | 她说了什么 |
|---|---|---|
| 「我在晒太阳」 | `daily-plan.js` 生成了虚构日程并注入 | 把假日程当成真事，还写进了成长记忆 |
| 「这个图我存不下来」 | `maybeCollect()` 已成功写入图片（16:47:50） | 不知道自己存了，凭「我只会生成表情包」回答 |

第二次排查后，系统里还有这些同类隐患被一并修掉：说说发布失败不告知、聊天时看不到生活费、表情包升降级不告知。

### 加新功能时怎么自查

**问自己一句：这个功能有没有在用户看不见的地方改了什么？**

有的话，逐条对照：

- [ ] **结果状态**：成功/失败/重复，模型知道吗？（例：收图后拼一句「已自动收进表情包库」）
- [ ] **失败情况**：失败时模型会不会以为成功了？（例：说说发布失败 → 写进念头「没发出去，别当已经发了」）
- [ ] **数量/余额**：会不会被问「还有多少」却答不上？（例：每轮注入【生活费】）
- [ ] **层级变化**：数据被移动/升级/删除，模型知道当前状态吗？（例：图库维护写 `maintain-log.json`，24 小时内提示）
- [ ] **能力边界**：模型知不知道自己**能**做这件事？（例：能力清单里加「表情包库：收到的小图会自动收进库」）
- [ ] **谁要求的**：有副作用的动作，`recordAction` 里 `by` 填了吗？（见本节下文；例：拍一拍记 `by: info.userId`）

### 三种回写方式

| 方式 | 适用 | 例子 |
|---|---|---|
| **拼进现有内容** | 和某条信息强相关 | 图片描述后加「（这张已自动收进表情包库）」 |
| **动态块注入** | 每轮都该知道的状态 | `_dyn.push(【生活费】…)` |
| **写成念头/待办** | 一次性事件，以后可能提起 | `pushThought("刚才想发的说说没发出去")` |

### 反例（不要这么做）

```js
// ❌ 后台做了，但什么都不返回
function maybeCollect(buf, desc) {
  fs.writeFileSync(path, buf);   // 存了
  return;                        // 但没告诉任何人
}
```

```js
// ✅ 返回状态，调用方拼进上下文
function maybeCollect(buf, desc) {
  fs.writeFileSync(path, buf);
  return { ok: true, fname };    // 调用方据此写「（已自动收进表情包库）」
}
```

### 有副作用的动作必须记录「谁要求的」

除了「做了什么」，还要记「**是谁让做的**」。否则事后别人问「你刚才为什么拍他」，她只能猜。

**统一入口**：`_ctx.recordAction({ action, by, target, groupId, detail, ok })`

```js
// 有第三方对象时
_ctx.recordAction({ action: "poke", by: info.userId, target: uid, groupId, ok: true });
// 改全局配置时
_ctx.recordAction({ action: "settings_set", by: info.userId, detail: `${k} = ${v}`, ok: true });
```

写入 `data/actions.jsonl`，自动保留最近 500 条。`plugins/life-log.js` 会：
- 在生活日志里显示「今天做过：拍了拍朋友（主人让的）」
- 提供 `action_log` 工具，让她被问到时能查

**已经接入的**：`poke` / `send_like` / `mute_user` / `unmute_user` / `set_other_appellation` / `set_goal` / `settings_set` / `set_weather_city` / `memory_forget` / `memory_edit` / `emoji_like` / `forward_msg` / `set_self_profile` / `dsh_notify`

**新加有副作用的功能时**，问自己：*别人问「这事谁让你做的」，她答得出来吗？* 答不出来就补一条 `recordAction`。

### 已核对的清单（v1.24.2）

| 自动动作 | 是否回写 |
|---|---|
| 图片自动收藏 | ✅ |
| 语音转文字 | ✅ |
| 图片识别失败 | ✅ |
| 自我改代码回滚 | ✅（私聊通知主人） |
| 静默准备池 | ✅ |
| 生活日志 / 天气 | ✅ |
| 记忆 / 情绪 / 好感 | ✅ |
| 教学条目 | ✅ |
| 说说发布失败 | ✅（v1.24.2） |
| 聊天时生活费 | ✅（v1.24.2） |
| 表情包维护变化 | ✅（v1.24.2） |
| **有副作用动作的「谁要求的」** | ✅（v1.28.2，`recordAction`） |
| 记忆剪枝 | 🟡 未回写（她只会说「不记得」，诚实但不完全准确） |
| 会话摘要压缩 | 🟡 有摘要但没说明「更早的细节被压缩了」 |

**新加自动功能时，先在这张表里补一行，再写代码。**

---

## 十、代码复用原则：什么时候直接抄现成的

网上有大量成熟实现，不必什么都自己写。但「抄」和「抄」不一样，按下面的线切。

### 直接抄（省时间，注释里写来源）

| 类型 | 例子 |
|---|---|
| 纯算法 | LCS / 编辑距离 / 相似度打分、模糊匹配、排序 |
| 解析类 | 中文数字转阿拉伯数字、相对时间（「三小时后」）、命令行参数切分 |
| 边界处理 | 图片格式与尺寸判定、GIF 帧判断、编码探测、路径规范化 |
| 文本切分 | 按标点断句但跳过引号/括号内部（`splitSafe` 这类） |

- 抄完在函数上方写一行：`// 来源：<仓库或文章 URL>（许可证）`，作者与许可证要留。
- 若会引入新依赖：**先问用户**（本项目是零 npm 依赖，加依赖要单独批准）。
- **整段 / 大段移植**（超过一段函数、或移植了对方的数据结构）：除了文件头注释，还要在 `docs/credits.md` 登记，并把对方的许可证全文放进 `docs/licenses/`。
- **只借鉴设计或思路**：在 `docs/credits.md` 登记「借鉴了什么 / 我们怎么做」，公开发布时保留原作者署名。
- **直接运行别人的软件 / 模型**（如 GPT-SoVITS）：在 `docs/credits.md` 登记来源与许可证，许可证随仓库分发。

### 不要抄（自己写，哪怕慢一点）

| 类型 | 原因 |
|---|---|
| 业务逻辑 | 「什么时候发、发哪张、能不能删」——需求一直在变，抄来的抽象会挡路 |
| 数据结构 / 状态机 | 抄别人的字段设计等于继承它的假设（比如只有多来源采集才需要 `platform_count`） |
| 跨语言代码 | 逐行翻译比重写慢，而且出 bug 时不知道自己抄的是哪一段 |
| 核心人设 / 提示词 | 每句话都会被模型复读，必须按本项目的坑调过 |

### 抄「决策」比抄「代码」收益更高

参考开源项目时，先看它**为什么这么设计**，再看实现：

- 表情包系统只抄了两条决策：**每张图有稳定 ID**（来自 `meme-pilot`）、**受控标签 + 生命周期 + 主动发门禁**（来自 `nonebot-plugin-personification`）。实现全部重写。
- 判断标准：这段代码离开它原来的语境界还成立吗？成立 → 可以抄代码；必须配合它整套数据流 → 抄的是思路。

---

# 附录：插件平台（三层架构）

> 下文是原来 `PLUGIN-DEV.md` 的内容，已合并到这里，避免两处维护。

## 架构总览（三层）
```
┌───────────────────────────────────────────────┐
│ 进化层（特权插件）plugins/evolution.js          │
│  自我内省5工具 + 愿望 + 反思/探索/评分调参       │
│  + 技能规则 + 提案分级 + registry 元认知        │
├───────────────────────────────────────────────┤
│ 功能层 plugins/*.js（42 个插件，以 check.js 为准）│
│  reminders birthdays goals appellations mute   │
│  pc-tools stickers voice qzone memory emotion  │
│  proactive                                    │
├───────────────────────────────────────────────┤
│ 基础层（内核）index.js + plugin-host.js         │
│  消息路由 / agent循环 / 数据存取 / 预算 / 调度   │
└───────────────────────────────────────────────┘
```

## 插件怎么写（模板）

> 模板、Manifest 字段、apiSpec、避坑、体检规则、归因 → 一律见 [plugin-guide.md](plugin-guide.md)（插件平台**唯一规范入口**，`plugin-doctor.js` 按它校验）。这里不再重复，避免两处维护。

## ctx 提供什么

> ctx 能力清单以 `plugin-host.js` 的 `createHost` 返回值为准（改插件能力时改那里），不再手抄一张表、避免过期。常用分类速查：发送 / 记忆 / 状态 / 进化 / 工具 / 服务 / 其他（见 plugin-host.js）。

## 内核保留什么（基础层）
- 消息路由（handlePrivateMessage/handleGroupMessage + 防抖）
- agent 循环（agentChatOnce/agentToolCall + 内核工具：web_search/send_sticker/check_balance/check_usage）
- 数据存取（记忆文件、情绪/心情/无聊/好感、会话、预算、self/ 文件 IO）
- 插件调度（plugin-host.js：加载/钩子分发/工具命令注册表/apis/contextProvider）
- 代理函数（同名转发到插件，内核旧调用点零改动）
- 心流 mindLoop（心智循环，暂留内核，后续可迁）

## 已迁移对照
| 功能 | 插件文件 | 内核剩余 |
|---|---|---|
| 提醒/生日/目标/称呼/屏蔽 | reminders/birthdays/goals/appellations/mute | 数据层文件 IO |
| 电脑工具 | pc-tools | onebotSend 服务 |
| 表情包 | stickers | sendStickerImage + 代理 |
| 语音 | voice | 代理 |
| QQ空间 | qzone | qzoneHttp + 代理 |
| 记忆提炼/固化 | memory | 记忆存取 + 索引检索 |
| 情绪检测 | emotion | 情绪状态存储 |
| 主动搭话/浅心跳 | proactive | 主动状态 + proactiveAgentTurn |
| 进化/反思/愿望/技能 | evolution | self IO + mindLoop 调用 |

## 公开同步（镜像仓库 Momo-public）

公开仓库：Gitee panMou666/momo + GitHub tishencainiao/Momo（双远程），历史 = 每版本一个提交 + 一个 tag。

- 发布流程：大功能完成、升 BASE_VERSION、提交本地后，在 E:\Learn\Momo 下跑 `powershell -File sync-to-public.ps1`（脚本自动：复制干净文件集 → 脱敏替换 → 提交 → 打 tag → 推双平台）
- 永不进公开仓库：data/、.env、config.json（只放 config.example.json）、stickers/*.db*、*.bak、versions/、archive/、self/ 个人数据（只放模板 + skills.json）、docs/remote-backup-gitee.md；README 用公开版（本地 README 不同步）
- 脱敏靠脚本统一替换：真实 QQ 号/机器人 QQ → 假号、用户名路径 → 占位符、文档里的求职相关段落 → 项目版措辞（见 sync-to-public.ps1 第 3 步，新增敏感类型时在脚本里补一条）
- 红线：公开仓库永远不回拉覆盖本地；推送永远只从 Momo-public 出，本地 master 的完整历史绝不外推

---

## 十一、发布闭环（强制）

> 2026-11-07 起：所有会话改完代码统一走 `release.ps1`，禁止手搓 commit+tag+push。升版串行；tag 与对外发布由总控（「Momo 项目总控」会话）统一收口，避免并行撞版本号/tag。

一条命令（在 E:\Learn\Momo 下）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File E:\Learn\Momo\release.ps1 -Bump patch -Message "改了什么"
```

七个阶段（脚本按顺序执行，任一步失败即停下并给退出码）：

| 阶段 | 做什么 | 涉及命令 |
|---|---|---|
| 0 | 前置检查：node 定位（DSH runtime 优先，要求 ≥22）、git、当前版本、脏文件警告 | — |
| 1 | 自检：node --check index.js → node check.js → test/*.js 全量（退出码+输出双判定）→ python body/main.py --selftest | node / python |
| 2 | 版本 + CHANGELOG 门禁：版本合法性、BASE_VERSION 回写（-Bump）、CHANGELOG 必须已有 vX.Y.Z 条目；docs 版本头需先升到新号（否则阶段 6 对账报警） | — |
| 3 | 本地提交：git add（排除 self/ stickers/ watchdog.log 运行时数据）→ commit → tag vX.Y.Z（撞号会停） | git |
| 4 | 公开镜像：调 sync-to-public.ps1（复制干净文件集 → 脱敏 → 镜像内 commit+tag） | sync-to-public.ps1 |
| 5 | 双平台推送：核对远端 hash 只补推不一致的（幂等，扛 443 抖动）；单个 push 重试≤5次，凭据类错误立即失败 | git push |
| 6 | docs 收口：调 `scripts/doc-check.js` 自动对账（版本头/数字口径/行号引用），提示刷新 docs/HANDOVER | node |
| 7 | 发布清单：版本 / commit / tag / 镜像 / push 四路 / 剩余事项 | — |

参数：

- `-Version vX.Y.Z` 显式版本（不升号、不触发回写）
- `-Bump patch|minor|major` 自动升版本号并回写 index.js（补丁=bug/调参、次=新功能、主=架构级）
- `-Message "..."` 一句话改动摘要（进 commit 消息；CHANGELOG 条目仍需先写）
- `-SkipTests` / `-SkipSync` / `-SkipPush` / `-NoDocs` 跳过对应阶段（演练用）
- `-DryRun` 只打印计划，零写入（先看再发）
- `-Force` 跳过 tag 撞号确认（覆盖已存在 tag）

退出码（统一 Fail exit）：10 找不到 node；11 node<22；20 语法冒烟失败；21 疑似沙箱 EPERM（换完整权限会话重跑）；22 check.js 真实失败；23 测试失败；24 body selftest 失败；30 CHANGELOG 缺条目；31 版本号非法；32 tag 撞号；40 commit/tag 失败；50 sync 失败；52 push 超上限。

前置条件：

- 在完整权限会话里跑（受限沙箱里 check.js 依赖 spawnSync 会 EPERM，出现「全部 JS 语法错误」误报；脚本识别为 exit 21）
- body 素材需已转换（缺 assets/frameseq 时 selftest 返回 2，脚本报 24）；selftest 已内置 offscreen，不需要桌面
- GitHub/Gitee 凭据存 Windows 凭据管理器（脚本设 GIT_TERMINAL_PROMPT=0，凭据缺失快速失败而不是挂起）

中断续跑：每阶段完成写 `data/.release-state.json`（stage=committed / mirrored / pushed）；中断后重跑同一命令会跳过已完成阶段，成功后自动清理。

回滚：

- 本地：`git tag -d vX.Y.Z` 删错建 tag；`git reset --soft HEAD~1` 撤提交保留工作区；整体回退 `git checkout v<旧版本> -- .` → 重启（supervise 自动拉起）
- 镜像：`git -C E:\Learn\Momo-public reset --soft HEAD~1` 撤镜像提交；已推远端 tag 需人工 `git -C E:\Learn\Momo-public tag -d vX.Y.Z` + 推空引用删远端 tag（留痕）
- 红线不变：本地完整历史永不外推、公开仓库永不回拉

总控收口清单（会话发布后把发布清单报总控，总控四查）：

1. BASE_VERSION = CHANGELOG 最新版本行 = git tag 最新号（三处一致）
2. 脱敏已执行（公开镜像里搜不到真实 QQ 号 / 用户名 / 本地路径）
3. push 四路全绿（github/gitee 分支+tag、github main 强推）
4. docs/HANDOVER 已刷新（按「Momo 每次升版后刷新工作区 HANDOVER.md」执行）

## 十二、文档纪律章程

> 2026-11-07 起生效。目标：文档不再滞后于代码——宁可少写，不写旧值。

1. **版本头**：每个文档必须带「适用版本 + 日期」头（如 architecture.md 第 3 行）；改了架构/流程就同步更新对应文档并升版本头。
2. **数字口径**：插件数/工具数/命令数一律引用运行输出（node check.js 结果或运行日志的 `host.plugins.length`），正文不写死数字；需要举例就写「以 check.js 输出为准」。
3. **引用代码**：用常量名/函数名（BASE_VERSION、agentChatOnce、isMaster、senseText），禁止行号（行号会漂移）。
4. **文档变更随版本提交**：docs/ 随版本提交并登记 CHANGELOG 索引表；纯文档小修可以不升版，但 CHANGELOG 索引表补一行或并入下个版本。
5. **公开同步**：docs/ 经 sync-to-public.ps1 进公开镜像（唯一排除 remote-backup-gitee.md），发布前核对脱敏清单（真实 QQ/用户名/路径不外泄）。
6. **HANDOVER 例行**：Momo 每次升版后，由总控刷新工作区 HANDOVER.md（时点版本、口径、下一步、已知坑）。
7. **自动对账三件**：版本头 vs BASE_VERSION、数字口径、行号引用——由 `scripts/doc-check.js` 自动完成，挂在三个关口：pre-commit 钩子（有偏差 exit 1 拦提交）、sync-to-public.ps1（发布前）、release.ps1 阶段 6。
8. **改动即更新**：增删/改名插件 → 同步 docs/architecture.md 插件清单 + docs/prompt-map.md 插件数；改功能行为 → 同步对应功能文档（如 report-center.md）；改提示词常量（prompts.js）→ 同步 docs/prompt-map.md §4 全文。
9. **文档地图**：新增/删除 `docs/` 下的 `.md` 必须同步登记 `docs/index.md` 的对应分区（参考/指南/解释/历史/归因），并标注「给谁看（🤖/👤/🤖👤）+ 状态（现状态/目标态/历史）」。索引完整性由 `doc-check.js` 校验，漏登记=红（拦提交）。

