# HO500 交易后报价修复（POST V1）

## 修复边界

PumpSwap Buy/Sell 事件的 `pool_*_token_reserves` 是该事件发生前的池子储备。
收到事件以后，不能把这些储备当成当下可成交的池状态。

用整数计算每个事件自己的交易后状态，不能把整笔交易最终余额覆盖到其中每个事件：

- BUY：base 减 `base_amount_out`；real quote 加 `quote_amount_in_with_lp_fee`。
- SELL：base 加 `base_amount_in`；real quote 减 `quote_amount_out_without_lp_fee`。
- 报价使用 real quote 加有符号的 virtual quote；真实储备不能为负或超过 u64，有效报价储备必须为正。
- `buy_exact_quote_in` 和普通 `buy` 的用户金额字段语义不同，不能用同一个用户金额代替池子变化。
- buyback 是协议费分配的一部分，不再额外从池 delta 扣一次。

14 个真实链上事件的测试逐整数核对了储备和费用字段，包括 buy_exact_quote_in、普通 buy、sell、buyback burn。
这验证的是已保存的事件样本，不保证今后协议变更仍兼容；无法解释的状态拒绝报价。

新事件标记 `ammQuoteState=POST_TRADE_V1`；保留 `prePoolBaseReservesRaw`、
`prePoolQuoteReservesRaw`、`preReservePrice` 和 `ammExecutionFees`。
显式 INVALID/未知状态不用于成交、止损或旧缓存回退。未标记历史保持未知，不冒充 POST。
主库、日分片、固定窗口导出、快照与启动回放用 `amm_execution_context_json` 保留这些证据。
不对历史 raw 数据做全表回填或重写。

## 新 HO500 对照

| profile | 含义 |
| --- | --- |
| `O_C80_HO500_X60_POSTV1` | 原 HO500 资格，触发交易后池状态即时模拟入场 |
| `O_C80_HO500_X60_POSTV1_D1000` | 同一个 0.1 SOL 已合格即时样本，额外等待 1 秒后取新行情模拟入场 |
| `O_C80_HO500_LONG_…_POSTV1` | 12 个新长持退出对照，共享即时 POST 入场，不共享延迟入场 |

延迟组冻结原资格，不在一秒后延长资格窗口重新筛币；随后仍检查报价鲜度、同池、事件顺序、
价格变化和自身冲击。无合格行情/跳价保留失败记录，不从分母删除。配对资格与样本创建必须保持事务一致。
1 秒是最低研究延迟，不是承诺链上成交延迟，也不是使用未来已知价格回填订单。
入场后 60 秒退出窗口从各自实际模拟成交时刻计时；两组完成样本不一定相同，应一并检查未完成率。

旧 migration-handoff profiles 只用于历史展示和旧持仓退出，停止新入场；旧待入场行在恢复时记为
`NO_ENTRY / LEGACY_QUOTE_MODEL_RETIRED`。旧已开仓只在局部 Shadow 视图保留 PRE 口径，不能送到实盘。
其他 AMM 策略的跨版本历史分析仍应按部署时点及原始事件版本分段，不能把全历史平均值直接看作本版本收益。

## 费用和实盘

此次没有调整硬止损或卖出阈值。模拟池容量冲击与原 `configuredCostPct` 继续沿用，标记
`feeModel=FLAT_ESTIMATE`、`executionFeesAppliedSeparately=false`，事件费率只留证，不再叠加扣费。
因此 Shadow 净收益仍是成本估算，不是钱包链上实际净收支；不能据此宣称已消除全部实盘收益差异。

实盘估值使用新 POST 状态；信号缓存补全必须匹配同一 signature/eventIndex/slot/接收时间，不能串用同交易的其他事件。
HO500 的 bridge 只指向新即时 profile，延迟组和长持组不发送实盘信号。
现有三个实盘新入场开关保持关闭；本修复不授权重新开仓。

## 查看和验证

Dashboard 的 Graduation Acceleration Shadow O 页面新增“HO500 执行口径对照”；
长持表分开显示 POSTV1 与旧 PRE 历史，RUGX 配对按对应版本独立比较，复用已有缓存数据。

运行 `npm run test:amm-post` 和 `npm test`。测试仅用已保存的公开链上事件及临时/内存数据库，不发送交易。
部署后应确认版本完整性、三个实盘开关仍关闭、新 raw 行有 POST/INVALID 标记、新 HO500 行只写 POSTV1 IDs，
即时与延迟样本存在配对来源。旧库没有标记本身不是错误。
