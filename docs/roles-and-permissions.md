# 角色与权限设计（三级：管理员 / 用户 / 访客）

> 2026-11-04 设计（pro 产出，后按主人拍板补充运行时开关）
> 目标：把散在 7 处的「识人」收敛成一个角色解析器 + 一张能力矩阵 + 一个统一 API；
> 新功能（如记忆消化）只走 `ctx.person(uid)` / `ctx.can(uid, cap)`，不再各自读多处。

## 1. 角色模型

| 角色 | 对应旧身份 | 定义 | 判定 |
|---|---|---|---|
| 管理员 admin | 原主人 `master_user` | 全部功能 | `uid ∈ roles.admins`（为空时回退 `master_user`） |
| 用户 user | 原朋友 `allowed_users` | 自助 + 只读的部分功能 | `uid ∈ roles.users`（回退 `allowed_users`） |
| 访客 visitor | 原陌生人 | 只能聊天（限速） | 不在上两名单，且 `roles.visitors.enabled = true` |

- 判定顺序：admin → user → visitor → `ignored`（即旧行为：非白名单直接忽略）。
- **群成员默认 = visitor**；群聊里主人仍是 admin、朋友仍是 user（只认 uid，不看「在群里」）。
- **支持多管理员**：`roles.admins` 是数组；`master_user` 保留为兜底锁，防止配错把自己锁死。
- **访客入口默认关**：`visitors.enabled = false`，保持旧行为；开了才聊。

## 2. 能力矩阵

15 类能力；工具/命令/插件注册处标 `capability` 字符串，**未标注默认 admin（拒绝优先于放行）**。

| # | 能力类 | 管理员 | 用户 | 访客 |
|---|---|---|---|---|
| 1 | 聊天（纯对话） | ✅ | ✅ | ✅ 限速 |
| 2 | 记忆读写·本人（画像/称呼/好感/本人记忆） | ✅ | ✅ 仅本人 | ❌ |
| 3 | 记忆消化 / 反思 | ✅ | ❌ | ❌ |
| 4 | 搜索 / 联网读 | ✅ | ✅ 限速（**可运行时关**） | ❌ |
| 5 | 看图 / 视觉 | ✅ | ✅ | ❌ |
| 6 | 语音 TTS | ✅ | ✅ | ❌ |
| 7 | 表情包 / 发图 | ✅ | ✅ | ❌ |
| 8 | 提醒 / 待办（本人） | ✅ | ✅ | ❌ |
| 9 | 群主动插话 | ✅ | ❌（**可运行时开**） | ❌ |
| 10 | QQ 空间 / 对外发布 | ✅ | ❌ | ❌ |
| 11 | 预算 / 统计查看 | ✅ | ❌ | ❌ |
| 12 | 自改 / 进化 | ✅ | ❌ | ❌ |
| 13 | 电脑操作 | ✅ | ❌ | ❌ |
| 14 | 改配置 | ✅ | ❌ | ❌ |
| 15 | 管别人 | ✅ | ❌ | ❌ |

**主人拍板（2026-11-04）**：
- 「用户」开放第 1/2/4/5/6/7/8 类；其中**搜索默认开，但主人可以在 QQ 上让 Momo 随时关**。
- 「用户」**默认不能群主动插话**，后续主人也可以在 QQ 上让 Momo 打开。

## 3. 运行时权限开关（admin 通过聊天调整）

权限开关走现有 settings 机制（`plugins/settings.js`，存 `data/settings.json`，仅管理员可改）：

| 设置键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `perm.user.search` | 开关 | 开 | 用户能否用联网搜索（关掉省 API） |
| `perm.user.group_proactive` | 开关 | 关 | 用户触发时，Momo 能否在群里主动插话 |
| `perm.visitor.enabled` | 开关 | 关 | 访客能不能聊天（关 = 旧行为：忽略） |
| `perm.visitor.window_sec` | 数字 | 60 | 访客限速窗口（秒） |
| `perm.visitor.max_per_window` | 数字 | 6 | 窗口内最多几条 |
| `perm.visitor.daily_cap` | 数字 | 50 | 访客每日上限 |
| `perm.visitor.memory_cap` | 数字 | 200 | 访客本人记忆封顶（防刷存储） |

用法示例（主人在 QQ 说）：「Momo，把朋友的搜索关掉」「把访客聊天打开，每分钟最多 3 条」→ Momo 调 `settings_set`，并回一句确认。admin 之外的任何角色都改不了。

## 4. 数据域模型

| scope | 键 | 包含 | 写 | 读 |
|---|---|---|---|---|
| self | — | identity / reflections / skills / 通用知识桶 | admin（代 Momo 写） | 所有角色（只读注入） |
| person | uid | user-profile[uid]、appellations[uid]、favor[uid]、memories/<uid>.json、本人桶「认识」 | 本人或 admin | 本人或 admin |
| group | groupId | 群成员缓存、群记忆桶 | admin | 该群上下文 + admin |
| global | — | config、预算、插件全局状态 | admin only | admin（少量统计可给 user） |

- **记忆消化分桶**：`from=uid` 的流水合成进「本人桶」；`from=0` 合成进「通用桶」。一条流水可按语义拆进两桶。
- **反思补 from**：新反思必须带 `from`（uid 或 0）；旧反思迁移时统一补 `from=0`。
- **群/私聊互不串**：私聊只取 `person(uid)` + 私聊记忆，禁取群记忆；群聊只取 `group(G)` + 参与者 `person(uid)` 的身份认识，禁取任何人的私聊内容。

## 5. 统一 API

```js
ctx.person(uid) → { uid, role, name, appellation, profile, favor, memoryCount, isMaster, isFriend, isStranger }
// 轻量字段，记忆全文仍按需 loadMemories

ctx.can(uid, capability, { targetUid = uid } = {}) → boolean
// role = resolveRole(uid)
// allow = ROLE_MATRIX[capability]?.[role] ?? false
// 本人自助类能力且 targetUid !== uid → 需 admin
// 运行时开关（settings）在矩阵之上再叠一层
```

- `isMaster(userId)` 改成薄包装：`resolveRole(userId) === 'admin'`，签名不变，31 个插件零改动。
- `resolveCall()` 改读 `ctx.person(uid)`，返回格式不变。
- `ctx.can` 是新增能力；旧插件继续用 `isMaster` 也没问题。

## 6. 配置形状（只增不删）

```jsonc
"qq": {
  "master_user": 100000001,          // 保留；roles.admins 为空时的兜底
  "allowed_users": [100000002],      // 保留；映射为 roles.users
  "roles": {
    "admins": [100000001],
    "users": [100000002],
    "visitors": { "enabled": false, "rateLimit": { "windowSec": 60, "maxPerWindow": 6, "dailyCap": 50 }, "memoryCap": 200 },
    "groups": { "defaultRole": "visitor", "proactiveChat": "admin" }
  }
}
```

启动时若 `roles` 缺失 → 自动生成（admins=[master_user]、users=allowed_users、visitors 关）。

## 7. 迁移阶段

1. **聚合视图 + 兼容层**：新建 `plugins/roles.js`（resolveRole / ctx.person / ctx.can / ROLE_MATRIX / 设置项）；`isMaster` 改薄包装；`resolveCall` 走新解析器；配置自动映射。风险极低，行为逐位不变。
2. **开访客聊天**：index.js 非白名单分支改为「visitor 开且未超限 → 进聊天」；加内存限速器。
3. **能力矩阵接入**：工具/命令/插件注册处标 capability；分发处统一 `ctx.can`；未标注默认 admin。
4. **数据域落地**：记忆读写带 from；消化按人分桶；反思补 from；检索落群/私聊门禁。

## 8. 风险与测试

- 陌生人刷屏：开关 + 限速 + 记忆封顶三保险。
- 群成员冒用：只认 uid；群主动/发布只给 admin。
- 隐私串人：群/私聊检索门禁；person scope 只存身份，不存上下文。
- 参数级权限：`.can(uid, cap, {targetUid})` 统一校验。
- 老插件兼容：isMaster 薄包装、只增不删、分阶段。

测试清单：身份解析 4 场景；多管理员；访客开关/限速/越权；用户越权与自助；参数级；隐私门禁；消化分桶；反思 from；31 插件回归；admins 为空时兜底。

## 9. 不做（本次边界）

- 不做单工具 × 单用户白名单 UI；不做角色自动晋升；不做多租户；不重构 31 插件；不引数据库；不做审计日志；不改老配置字段语义。

## 10. 实现状态（2026-11-04）

| 阶段 | 版本 | 状态 |
|---|---|---|
| 1 聚合视图 + 兼容层 | v1.47.4 | ✅ |
| 2 访客聊天 + 限速 | v1.49.0 | ✅ 默认关，开关打开才生效 |
| 3 工具 / 命令鉴权 | v1.50.0 | ✅ `caps.js` 默认拒绝 |
| 4 数据域落地 | v1.51.0 | ✅ 群聊不再注入私聊原文；记忆条目带 `from`；访客记忆封顶；反思统一按通用（`from=0`）处理 |

阶段 4 说明：群聊上下文移除了「对方最近私聊说了什么」的原文片段，只保留群信息与身份认识；长期记忆条目写入时带 `from`（谁的数据）；访客记忆超过 `perm.visitor.memory_cap` 时只保留最近部分。
