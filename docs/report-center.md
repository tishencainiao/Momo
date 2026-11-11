# Momo 报告中心（v1.89.3）

> 版本：v1.89.4
> 目的：**让主人看得懂 Momo**——她一天里干了什么、花了多少、学到了什么、想要什么、想对你说什么。
> 不是对外公告，不是日报模板，是她整理给自己主人看的一份记录。

## 1. 一份报告

v1.81.0 起，把原来的「日报 / 周报 / 月报 / 晚间播报 / 账单 / 今日小结」整合成**一份「给主人的报告」**：
每天 23:00 用 LLM 整段、以 Momo 自己的口吻写，**直接发到 QQ**（不落盘、不传文件）。

| 周期 | 触发时间 | 开场白 |
|---|---|---|
| 日报 | 每天 23:00 | 当天小结 |
| 周报 | 每周日 23:00 | 「已经过去一周了…」 |
| 月报 | 每月 1 日 23:00 | 「已经过去一月了…」 |

发周报 / 月报的当天**不发**日报（优先级：月报 > 周报 > 日报）。去重靠 `data/report-state.json`，重启不重发。

## 2. 报告里写什么

LLM 按下面这些事实整理成**一整段话**（不是模板拼接）：

| 内容 | 数据来源 |
|---|---|
| 开场（手动 / 自动两种语气） | `openKind`：手动=「你想看啦，那我就跟你说说」；自动=「今天 / 已经过去一周 / 一月」 |
| 2~3 件有趣的事 | `data/actions.jsonl` 动作流水 |
| 一天总结 | `self/journal.json`、`self/identity.json` |
| 生活费（花了 + 还剩） | `data/budget.json`（`budgetReport.dailyBill`） |
| 进化（自主实现 + 待批） | journal `type:"adopt"` + `self/selfmod-proposals.json` `status:"pending"` |
| 想对你说的话 / 想要的 / 想干的 | 以上事实 + LLM 自己写 |

自主实现最多说 3 件，其余「还有 N 件小事」一句带过；待批愿望单独列。

## 3. 怎么送到主人手上

1. 每天 23:00 定时发（`report.enabled` 开）。
2. 手动：主人说「给我看看你的报告」或发 `/报告` → `momo_report` 工具（主人专属）。
3. 只发 QQ 消息，**不生成 md 文件**（历史报告要靠 QQ 聊天记录留存）。

## 4. 设置项

| 键 | 默认 | 说明 |
|---|---|---|
| `report.enabled` | `true` | 总开关 |
| `report.daily_time` | `23:00` | 日报时间（HH:MM） |
| `report.weekly_dow` | `0` | 周报星期（0=周日） |
| `report.monthly_day` | `1` | 月报日期 |

## 5. 怎么扩展

- **加内容**：在 `plugins/report.js` 的 `collect()` 里读新数据源 → `buildReport()` 的 prompt 里加一句 → 测试补一条断言（`test/report.js`）。
- **换触发**：改 `dueKind()`（周期判定，month>week>day）+ `windowStart()`（时间窗）。

## 6. 注意（踩过的坑）

1. **时间戳单位**：身体早期发的是秒级时间戳，`data/body-events.jsonl` 里混过 `1793...`（毫秒）和 `1793969412.97`（秒）。三处归一：`body/netapi.py` 发毫秒、`plugins/pet-body.js` `normTs()`、`plugins/report.js` `tsOf()`。
2. **`self/skills.json` 的规则是对象**（`{id, triggers, replies}`），渲染时取 `triggers` 拼人话，否则会印出 `[object Object]`。
3. **报告是 LLM 整段写**：质量取决于喂进去的事实（journal 越勤，报告越好看）；它不落盘，所以没有历史报告文件可回溯。
