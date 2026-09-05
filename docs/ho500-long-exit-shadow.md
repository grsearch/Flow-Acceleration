# HO500 同入场长持退出对照（2026-09-05）

本次只新增纯 Shadow 退出实验，并暂停三项实盘的新开仓。不会清仓、删除历史记录或把新实验转实盘。

## 实盘暂停范围

下列策略的 `entryEnabled` 在源码中固定为 `false`，旧 `.env` 中的同名 `ENTRY_ENABLED=true` 无法重新打开它们：

- `migrated_ge30_r23_f2_only_g2_xleg_live`（POST-GE30-R23-F2-G2-XLEG）
- `migrated_grt_r23_f3_v2_xleg_live`（GRT-R23-F3-V2-XLEG）
- `graduation_accel_o_c80_ho500_x60_live`（O-C80-HO500-X60）

保留各策略定义、原止损/止盈/最长持仓、历史仓位及 Shadow 信号来源。正常运行下原有持仓继续退出，新信号记为 `MATCHED_ENTRY_DISABLED`，不进入买入队列。不要用关闭整个交易管理器、杀进程或设 `FLOW_LIVE_ENABLED=false` 来替代此变更，这可能影响存量仓位管理。

本地改动不是生产已停买：需要部署并从当前运行服务核验这三个开关。若部署前需立即暂停所有新单，可由服务器运维核实当前服务配置后创建其 `killSwitchFile` 指向的停开新仓文件，并确认 `killSwitchActive=true`；不要停止持仓管理进程。未经明确重新开仓授权，不删除该停开新仓文件。

## 实验矩阵

所有组复制 `O_C80_HO500_X60:0_1SOL` 的实际 Shadow 入场，不重新筛选币，也不单独竞争入场窗口。

| 维度 | 值 |
|---|---|
| 最长持仓（从实际入场计时） | 30 / 60 分钟 |
| 单档移动止盈 | 盈利30%启动、最高价回撤20%；盈利100%启动、最高价回撤30% |
| 硬止损 | 20% / 30% / 真正关闭（0） |
| 仓位 | 每组0.1 SOL，独立的模拟对照，不代表同时买12笔 |

共12组。原60秒基线不变。最大持仓是上限，不是必须先持满30分钟才允许止盈。移动回撤相对最高价格，不是相对浮盈金额。

组ID格式：`O_C80_HO500_LONG_A30_D20_HOFF_X1800`，分别表示激活收益、最高价回撤、硬止损（OFF关闭）、最长持仓秒数。

以同一数据库事务保存基线成交与对应12组：入场时刻、价格、Token数量、成本及已通过的入场/RUG口径一致；入场失败不会制造12个虚假成交。新组的 live bridge 均为空。

`features_json` 保存配对来源仓位/episode/cohort、真实池和slot、入场确认、实验版本、固定退出政策及观察期限。退出政策随仓位持久化；仅关闭新实验入口不会改变已开仓实验的原定退出规则。

## 数据采集与性能

- 活跃仓位/等待退出继续订阅AMM，不能因原60秒基线结束而提前撤销。
- 提前止盈/止损后，额外观察保留至该入场的最长实验持仓＋5分钟，默认覆盖至65分钟。
- 额外观察名单默认上限2000个mint；容量限制不逐出仍活跃的仓位。通过 health 的观察名单/裁剪计数检查是否触及上限。
- 新增的已结束仓位观察恢复按状态最多读取12001行（含一行截断探针）；`longExitRestoreRowsRead`、`longExitRestoreTruncatedStatuses` 报告实际读取和截断。此限制只作用于额外观察，不缩减活跃仓位管理；原有活跃/迟到退出恢复路径未在本次重构。
- 原始主库、按日分片、固定窗口导出的池身份、真实base/quote储备、有符号virtual quote及交易时间/slot已有完整写入链路。本次补端到端回归，不对旧数据做全表回填；旧行缺字段仍为NULL，不能伪造成可执行报价。
- 新组对同一mint逐笔评估退出，但避免重复写入未改变的状态；最高/最低价等关键变化仍保存，普通行情心跳限频。无额外钱包扫描或RPC查询。
- Dashboard复用既有缓存聚合与接口，不因为新增矩阵增加页面请求。

## 退出与统计口径

退出必须使用有效AMM事件及池储备计算可执行报价。止损比例只是触发门槛，并不保证能在该亏损比例成交。缺少报价时保持等待，超窗保持 `NO_EXIT`/未知，不把标价当成真实成交，也不自动记成0%或−100%。

新组在更新峰谷、触发退出和确认成交前检查入场池、slot与链时间；过期超过3秒、异池及倒序事件不能作为退出行情。正常停机保存最新游标，重启后的恢复仓位不使用重启前链时间的回放事件。因行情延迟或缺字段被拒绝的次数保留在 `longExitTradeRejections`，分析未知退出时应一并检查。

Dashboard路径：**Live Trading / Shadow策略 → Graduation Acceleration Shadow O →「HO500 长持：同入场硬止损对照」**。没有样本时仍显示配置；暂停实验后历史组仍可查看。

该表展示入场数、有效已完成、活动、NO_EXIT/异常、两种覆盖率、收益/胜率及大亏/大赢。完成覆盖率不是行情连续覆盖率。不同退出条件可能留下不同的未知样本，不能只比较已完成均值就认定哪一组更好。

## 配置与验证

父开关 `FLOW_GRADUATION_ACCEL_SHADOW_ENABLED`、`FLOW_GRADUATION_ACCEL_RELAXED_ENTRY_SHADOW_ENABLED` 需保持开启。新开关及默认值：

```dotenv
FLOW_GRADUATION_ACCEL_HO500_LONG_EXIT_ENABLED=true
FLOW_GRADUATION_ACCEL_LONG_EXIT_OBSERVATION_GRACE_MS=300000
FLOW_GRADUATION_ACCEL_LONG_EXIT_OBSERVATION_MAX_MINTS=2000
```

部署后核对当前API的三项实盘 `entryEnabled=false`，并确认退出管理仍启用；Graduation O 的 `entryProfiles` 应有12个 `experimentGroup=HO500_LONG_EXIT_V1`，各组只允许0.1 SOL且没有live bridge。部署验收按目标配置比对实际允许开仓集合，允许零开仓，不再把“存在三项定义”误解为“必须启用三项”。

测试入口：`npm run test:ho500-exits`（亦支持pnpm）；已纳入全套测试。测试使用内存数据库、假行情与dry-run，不连接生产、不发送交易。
