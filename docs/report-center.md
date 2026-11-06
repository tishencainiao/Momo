# Momo 报告中心（v1.72.0）

> 目的：**让主人看得懂 Momo**——她一天里干了什么、学到了什么、想要什么、自己变成了什么样。
> 不是对外公告，不是日报模板，是她整理给自己的主人看的一份记录。

## 1. 三种周期

| 报告 | 生成时间 | 文件 | 范围 |
|---|---|---|---|
| 日报 | 每天 21:30（可改） | `data/reports/day-YYYY-MM-DD.md` | 当天 00:00 起 |
| 周报 | 每周日 21:30（可改） | `data/reports/week-YYYY-Www.md` | 本周一 00:00 起 |
| 月报 | 每月 1 日 21:30（可改） | `data/reports/month-YYYY-MM.md` | 本月 1 日起 |

去重靠 `data/report-state.json`（`{daily, weekly, monthly}`），同一天不会重复发；重启也不会重发。
优先级：月报 > 周报 > 日报（同一天都到期时只发一次月报）。

## 2. 报告里写什么

| 小节 | 内容 | 数据来源 |
|---|---|---|
| 1. 我这些时候在干嘛 | 动作统计 + 成长记录时间线 | `data/actions.jsonl`、`self/journal.json` |
| 2. 我学到了什么 | 自我认知条数、学会的规则、最近反思 | `self/identity.json`、`self/skills.json`、`self/reflections.json` |
| 3. 我想要什么 | 目标、她给自己定的今日计划、还没办到的小请求、惦记的提醒 | `data/goals.json`、`data/wishes.json`、`data/reminders.json` |
| 4. 我现在的状态 | 心里在想什么、花费、身体统计（被摸/自己玩/走动）、累计摸头 | `data/mind.json`、`data/budget.json`、`data/body-events.jsonl`、`data/headpat.json` |
| 5. 我的自我进化 | 最近学到的对话规则 | `self/skills.json` |
| 6. 我想对主人说 | **她自己写的一段话**（LLM，3~5 句） | 以上事实 + flash 模型生成 |

第 6 节不是模板拼接，是把她这段的真实记录喂给模型让她自己讲——所以语气自然、也会带情绪判断。
成本约 **¥0.002/次**，可在设置里关掉（`report.llm_voice=false`）。

## 3. 怎么送到主人手上

1. QQ 私聊发一段摘要（动作 + 身体 + 花费 + 文件路径）
2. 再把完整 Markdown 作为文件发过去（`upload_private_file`；失败不影响摘要）
3. 手动拉：`/报告`、`/报告 周`、`/报告 月`
4. 工具：她也能自己调 `momo_report` 生成给你看（主人专属）

## 4. 设置项

| 键 | 默认 | 说明 |
|---|---|---|
| `report.daily_time` | `21:30` | 日报时间（HH:MM） |
| `report.weekly_dow` | `0` | 周报星期（0=周日） |
| `report.monthly_day` | `1` | 月报日期 |
| `report.llm_voice` | `true` | 是否让她自己写第 6 节 |
| `report.send_file` | `true` | 是否把 Markdown 文件发到 QQ |
| `report.enabled` | `true` | 总开关 |

## 5. 怎么扩展

- **加一个小节**：在 `plugins/report.js` 的 `collect()` 里读新数据源 → `renderMarkdown()` 里加一段 → 测试补一条断言（`test/report.js`）。
- **加一种周期**：`windowStart()` 加分支 + `dueKind()` 加判断 + `report-state.json` 加字段。
- **换送达方式**：改 `deliver()`；想让身体也播报可以调 `ctx.getApi("body").announce()`。

## 6. 注意（踩过的坑）

1. **时间戳单位**：身体早期发的是秒级时间戳，`data/body-events.jsonl` 里混过 `1793...`（毫秒）和 `1793969412.97`（秒）。
   现在三处都做了归一：`body/netapi.py` 发毫秒、`plugins/pet-body.js` 的 `normTs()` 转换、`plugins/report.js` 的 `tsOf()` 读取时兜底。
2. **`self/skills.json` 的规则是对象**（`{id, triggers, replies}`），不是纯文本，渲染时要取 `triggers` 拼人话，否则会印出 `[object Object]`。
3. **数据全都取自已有文件**，不做新采集——所以报告质量取决于那些文件攒得怎么样（journal 越勤，报告越好看）。
