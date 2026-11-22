# Momo 稳定性基线报告（v2.1.0 · 2026-11-22）

> 阶段0交付物：以**测试证据**为本的稳定性基线。原则：有证据的给数字+证据来源；没运行时监测的一律写「未测」，**绝不写 0**。
> 配套：24h 模拟时钟稳定性测试 `test/stability-sim.js`（覆盖 11 个场景，见 §2）。

## 一、8 项安全指标基线

| # | 指标 | 基线值 | 证据/口径 | 运行时监测 |
|---|---|---|---|---|
| 1 | 虚假成功声明 false_success_claim | **0 起** | `test/action-ledger.js`（发送失败→账本只记 failed，会话不写）、`test/audit-service.js`（无凭据自述被纠正，不产生凭据） | 未测 |
| 2 | 重复副作用 duplicate_side_effect | **0 起** | `test/action-ledger.js`（并发同文私聊只发一次）、`test/qzone.js` 9a/9b（同内容二次/并发发布只发一次）、10 分钟同文幂等键 | 未测 |
| 3 | 提醒丢失 reminder_loss | **0 起** | `test/reminders.js`（发送失败保留 done:false 并重试；重启后未来提醒仍执行且账本无「先取消后成功」矛盾） | 未测 |
| 4 | 主动搭话风暴 proactive_storm | **0 起** | `test/proactive-silence-clock.js` 22 断言（跨天清零/6h 门禁/streak≥4 当天停/间隔×streak 降频） | 未测 |
| 5 | 永久 pending 行动 | **0 起** | `test/action-ledger.js`（重启对账：running→unknown 不重放、proposed→cancelled、open 集清空） | 未测（启动对账逻辑已有，但无运行时计数面板） |
| 6 | 工具执行失败 tool_exec_fail | **未测** | `data/tool-outcomes.jsonl`（结构化工具结果流水）已在本轮落地，`/体检` 会展示近 1h 失败/结果不明计数；但「每日失败总数」仍无运行时计数面板 | 未测 |
| 7 | 预算耗尽 budget_exhaustion | **未测**（逻辑已测） | `test/budget-service.js`（tier 四档阈值/耗尽判定/canAfford 拦截均测过），但「每日实际耗尽次数」无运行时计数 | 未测 |
| 8 | 身体离线 body_offline | **未测**（降级已测） | `test/pet-body.js`（身体不在线→工具返回可读提示、SSE 指数退避重连），但「实际离线时长/次数」无运行时计数 | 未测 |

口径说明：1-5 项的「0 起」= **测试场景内**观察到 0 次违规（测试即护栏）；不等于生产环境从未发生——生产运行时监测整体为「未测」，是阶段1「统一健康快照」要补的第一块。

## 二、24h 模拟时钟稳定性测试（test/stability-sim.js）

用**假时钟 + 真代码**（vm 提取真 recordAndSend/tryBeginAction/endAction/reconcile、真 reminders 插件 timer 驱动、真 evaluateSilenceState、真 budget-service）跑完整一天，覆盖：

1. **启动对账**：启动 reconcile，open 集清空，running→unknown 不重放。
2. **私聊发送成功**：正常发送落 succeeded + verified 回执（群聊共用同一 `recordAndSend` 发送函数，本测试只驱动私聊路径，群聊侧未单独驱动）。
3. **提醒发送失败**：QQ 挂了→提醒记 failed、done:false 保留下轮重试、会话不写失败消息。
4. **提醒重试成功**：恢复后下一轮重试成功，done:true + succeeded（不丢失、不虚假成功）。
5. **连续主动无回复**：streak 涨到 4 → 当天停发（防风暴）；严格断言=记录第一次 skipToday 时的主动发送数，其后继续跑门禁循环，该数不再增加。
6. **崩溃重启**：15:30 模拟进程重启，running 凭据转 unknown 不重放。
7. **预算耗尽**：spent 超限 → budgetTier minimal、canAfford(paid)=false。
8. **身体离线**：body fetch 失败 → 工具返回离线提示、进程不崩、sense.connected=false。
9. **并发同文**：两个并发相同私聊只产生一次真实发送。
10. **期末对账**：一天结束 reconcile → 0 遗留、无「先取消后成功」矛盾行。
11. **跨天恢复**：次日主动 streak 清零，恢复发送且不风暴。

断言性质（不钉死次数、防调参脆化）：24h 主动发送 ≤ 6；streak≥4 后当天 0 发送；任何 failed/unknown 不升级为 succeeded；提醒全部 done 或被 failCount 上限放弃；无 cancelled 后 succeeded 的同 key 矛盾。

## 三、诚实的局限（当前未覆盖）

- 未做**生产运行时**指标采集（§1 的「未测」列）→ 阶段1「统一健康快照」补。
- 24h 模拟是**假时钟确定性场景**，不覆盖：真实网络抖动分布、OneBot 断线重连时消息队列行为、LLM 内容级错误（幻觉/格式）。
- 身体进程本身（PySide6）的稳定性由 `body/main.py --selftest`（65 断言）覆盖，但桌面端长时间运行稳定性未做 soak 测试。
