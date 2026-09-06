# 2026-09-06：钱包账本、异常事件与性能取证修复

## 本次边界

本次修复测量与恢复链路，不改入场/出场参数，不降低 AGE、投票、行情鲜度门槛，不启用实盘，不删除历史数据，不自动退休 Shadow。

代码通过本地测试不等于已部署，也不证明生产环境中曾出现的 109 秒阻塞已经完全消失。新诊断用于把阻塞精确归因到阶段；不可把 Dashboard 返回 streaming 当成完整验收。

## 改动

1. 已在采集范围内的 LIVE 智能钱包事件，与其 PnL 待办在同一数据库事务中保存。记账不再由 AGE、评级或共识投票决定；投票仍使用原有资格快照。
2. 维护阶段持续读取持久化待办，即使之前队列为空也不永久停工。记账结果和移除待办原子提交，失败重试，同一钱包/币不越过失败的前序事件。
3. 历史修复按事件 ID 游标与固定高水位分批推进，不在每轮使用全历史反连接。遇到已记后续事件或余额矛盾，保留 `REPLAY_REQUIRED`，不盲目补旧买入或全量重算。
4. Parser 检查事件程序归属、结构、时间和储备一致性。不用任意交易金额上限代替结构校验。合法历史回放、完整尾部扩展和大额交易保持兼容。
5. 异常不进入行情/信号；限长诊断缓冲在维护时落 `parser_event_quarantine`。该缓冲不是行情账本，过载和无效记录丢弃有显式计数，数据库失败保留重试。退出时只作有时限的尽力刷新。
6. 增加同步任务起止时间、耗时、失败和有界慢任务列表。资格快照、旧事件修复、队列记账、Worker 结果应用可分别检查。计时范围是同步回调，不把异步 Worker 全耗时当主线程阻塞。
7. 日常导出包括窗口内已处理事件（包括无 position_id 的忽略记录）、待办/修复状态、异常事件和新增代码哈希。运行摘要不包含钱包明细、凭据、URL、错误文本或运行路径。

## 部署后只读验收

使用现有安全更新流程和实际 `flow-acceleration.service`；不要另启 nohup、强杀占位 Dashboard 或创建第二个写库进程。本次未执行这些操作。

### A. 版本和采集

- 核验运行源码完整性、工作目录、数据库身份，确认只有一个生产主进程。
- 三个已暂停实盘策略仍为 `entryEnabled=false`。不得为验证链路而自动开仓。
- 以两次快照比较交易落库与数据延迟；旧错误累计值不等于当前新增错误。
- `/api/health.runtimeDiagnostics.parser` 区分 accepted、ignored、rejected。未知 discriminator 的 ignored 不是解码失败。
- rejected 增长时，核查隔离原因。若已知合法协议升级被拒，应保留样本调查，不能关闭校验或把所有异常重新送入交易流。

### B. 账本

- `/api/health.smartWalletMaintenance.actualLedger` 为内存快照，`generatedAt` 必须推进。
- 首轮 `REPAIRING` 期间检查 repair 游标是否向固定高水位推进，不要求升级后一刻就归零。
- `pendingSampleCount` 最多 100，是样本数，不是全队列总数；结合 truncated 标志解释。
- `CAUGHT_UP` 表示持久化修复完成且当前待办为空，不表示链上所有历史已收集。
- `REPLAY_REQUIRED` 必须按钱包/币逐组核查，不当成成功，也不清空表隐藏问题。其它不冲突的币应继续记账。
- 对既有疑似漏账的 4vw、ardin、Bi4rd 各抽 BUY 与 SELL，按事件 ID 对照原事件、pending 和 processed。IGNORED 必须有原因，不能仅因没有 position 就称漏账。
- 不用尚在修复或受历史余额冲突影响的收益评估新投票资格优劣；其既有资格政策本轮未更改。

### C. 性能与导出

- 比较 `runtimeDiagnostics.taskTimings` 的 maxMs、lastStartedAt/FinishedAt 与行情接收时间，不只看平均耗时。
- 检查 `smartWallet:eligibilitySnapshot`、`legacyLedgerRepair`、`ledgerQueueConsume`、`workerApply:*` 及外层 `shadow:smartWalletRegistryAdvance`。
- 新背景写操作有短锁等待与分批时间预算；同步 SQLite 单条语句不能被 JavaScript 时间预算抢占，因此不能承诺任何生产查询永远低于 20/25ms。
- parserQuarantine 的 pending 应能回落，writeErrors 后应能重试；dropped/invalidRecords 非零要明确记录缺失，不能声称全量取证。
- 导出检查 smart_wallet_pnl_processed_events 中窗口内 NULL position_id 行仍在；quarantine 按正常 received/created 时间选取，不使用损坏的链时间过滤。
- runtime-before/after 的钱包记账、Parser、慢任务摘要和关键源文件哈希应存在。它们是导出时状态，不是窗口结束时的历史状态。

## 验证命令

`npm run test:ledger-audit` 运行新的账本/隔离/诊断/窗口导出测试；`npm test` 包含原策略、实盘暂停、行情执行、Dashboard 子进程、恢复、关闭和部署保护回归。测试只使用临时数据库及本机测试服务，不访问生产库或发真实交易。

## 下一轮研究约束

先冻结执行模型、金额、费用、延迟与未知退出口径，再对少量候选前向验证。0.02 SOL 实盘仅在另行明确授权、限制笔数/并发/总损失后用于执行校准；研究正收益不能直接赋予实盘开仓权。
