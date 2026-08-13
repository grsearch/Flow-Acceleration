# Pump.fun Flow Acceleration Research + Multi-Strategy Executor

这是一个同时采集 Pump.fun 毕业前 Bonding Curve 与所需毕业后 PumpSwap 成交的研究项目，并带有默认关闭、按策略隔离的实盘执行模块。研究主线验证：

> 短时间内净买入资金、独立买家数量和买入成交速度同时加速时，未来数秒是否存在扣除真实成本后仍可交易的价格惯性。

全量 Raw Trade、Flow Signals、Future Labels 和 Smart Wallet 事件始终继续采集。当前实盘只使用毕业后 PumpSwap 深跌反弹规则，不使用 Smart Wallet 跟单、RSI、EMA、MACD、社交数据、Holder 变化、KOL 或 AI 评分；默认 `DISABLED`，不会读取私钥或提交交易。

## 数据链路

```text
Pump.fun 全市场链上交易
        ↓
Yellowstone / Helius 全局轻量扫描
        ↓
每个 Mint 最近 10 分钟 Raw Trade Buffer
        ↓
5 秒 Activity Wake-Up
        ↓
Candidate Pool
        ↓
W1 / W2 / W3（三段 2 秒窗口）
        ↓
Net Flow + Unique Buyers + Buy TX 同时加速
        ↓
FLOW_ACCEL_SIGNAL
        ↓
1s～60s Future Return + MFE / MAE + 成本/延迟回测
```

链上事件解析基于 Pump.fun 官方 IDL 的 `CreateEvent`、`TradeEvent`、`CompleteEvent` 和 `CompletePumpAmmMigrationEvent`。毕业后立即停止产生新信号；如果毕业时仍有未完成的未来收益标签，程序会临时订阅该 Mint 的 PumpSwap 交易，完成标签后自动退出订阅。

官方 IDL：<https://github.com/pump-fun/pump-public-docs/tree/main/idl>

## 信号定义

全市场第一层只做 5 秒活动唤醒，满足任意一项即进入 Candidate：

- SOL 成交量 `>= 3 SOL`
- 成交笔数 `>= 12`
- 独立钱包 `>= 8`

Candidate 使用三段连续 2 秒窗口：

```text
W1 = T-6s ~ T-4s
W2 = T-4s ~ T-2s
W3 = T-2s ~ T
```

信号要求：

- `NetFlow_W1 < NetFlow_W2 < NetFlow_W3`
- `NetFlow_W3 >= FLOW_MIN_NET_W3_SOL`
- 两段净流入绝对增量均达到 `FLOW_MIN_NET_DELTA_SOL`
- 当分母大于安全下限时，Flow Acceleration Ratio 达到配置阈值
- `UniqueBuyers_W1 <= W2 < W3`
- `BuyTX_W1 <= W2 < W3`

`NetFlow <= 0` 时不会强行做除法。系统同时保存绝对增量与可安全计算的 ratio，避免接近 0 时比例失真。AGE 与 Curve 只记录，不参与 V1 过滤。

信号按条件的 `false → true` 边沿发出；条件持续成立时不会重复发信号。`FLOW_SIGNAL_COOLDOWN_MS` 只是可选的额外保护，默认关闭，因此不会暗中改变研究样本。

## 数据库

默认数据库为 `data/flow-research.db`，核心表为：

- `raw_trades`：完整的毕业前 Bonding Curve 逐笔成交、标签所需 PumpSwap 成交，以及 Shadow G 对每个新毕业 Mint 前5分钟的完整 PumpSwap 成交；两类生命周期数据都可用于离线穷举超跌/反弹阈值。
- `flow_signals`：三个窗口的买卖流、净流入、独立买家、买单数、绝对增量和 ratio。
- `signal_returns`：1/2/3/5/8/10/15/20/30/60 秒 Raw Return、确定性成本后的 Net Return、每个 horizon 的观测 lag、`COMPLETE/RIGHT_CENSORED` 标签状态，以及 5/10/30 秒 MFE/MAE。某个 horizon 后首笔成交超过 `FLOW_LABEL_MAX_OBSERVATION_LAG_MS`，或 MFE/MAE 时间窗没有完整观测覆盖时，不会用旧价格或 0% 补值。
- `smart_wallet_events`：两个研究钱包的成交、Curve、AGE、最近 Flow Signal 与时间差。
- `smart_wallet_positions`：按实际 Token 数量维护的 Smart Wallet 仓位；买卖被区分为 `OPEN / ADD / REDUCE / CLOSE / SELL`。
- `live_strategy_decisions`：按 `strategy_id` 保存每个实盘策略的 Episode、特征、规则结果、风控拒绝和执行状态。
- `primary_live_decisions`：仅保留旧 Primary 实盘判定的历史兼容数据；新策略不再写入。
- `smart_open_decisions`：仅用于兼容旧版 Smart OPEN 历史数据；新策略不再写入。
- `live_positions` / `live_orders`：按 `strategy_id` 保存模拟或实盘仓位、每次买卖尝试、签名、失败原因与退出原因。
- `smart_open_shadow_positions`：独立的真实 Smart Wallet OPEN Shadow D0/D1/D2 样本；不与旧回踩或 Primary Shadow 混表。
- `flow_smart_confirm_shadow_positions`：Primary Rank 1 后 Smart OPEN 确认、再按后续成交入场的严格前向 Shadow L 样本。
- `launch_quality_observations` / `launch_quality_snapshots`：Launch 前60秒结构、首次回踩参考点和未来收益标签。
- `launch_pullback_shadow_positions`：独立的 Launch 首次回踩 Shadow F1/F2/F3 仓位；不与 Observer E 或任何旧 Shadow 混表。
- `migrated_drop_rebound_shadow_positions`：独立的生命周期超跌反弹 Shadow G 参数组；用 `lifecycle_stage` 严格区分毕业前与毕业后模拟入场、MFE/MAE和退出结果。
- `graduation_hold_shadow_positions`：独立的毕业概率持仓 Shadow I0/I1/I2；共享早期 Primary 模拟入场，但分别保存移动止盈对照、97%毕业前退出和严格门槛穿越毕业结果。
- `range_scalper_shadow_positions`：独立的 PumpSwap 区间波段 Shadow J；保存区间质量、重复 Episode、三组回踩入场与四组退出结果。
- `cya_early_pyramid_shadow_positions`：独立的 CYA Early Pyramid Shadow K；保存早期 Curve 订单流入场、分批加仓、两次减仓、尾仓退出及逐仓估算成本。
- `flow_tokens`：创建时间、毕业时间、Bonding Curve、迁移池和 Curve 进度所需状态。

SQLite 使用 WAL 和批量写入。默认保留 168 小时热数据；超过 `FLOW_RAW_RETENTION_HOURS` 的 Raw Trade 会先压缩为 `data/archive/*.ndjson.gz`，成功写入归档后才从热库删除；Signals 与 Future Labels 不删除。

## 运行

需要 Node.js 22+。`better-sqlite3` 直接使用包内自带的 Windows/Linux 预编译文件，不需要额外安装 C++ 编译工具链。

Yellowstone gRPC v5 当前随包提供 Linux/macOS 原生客户端，实时采集请部署到 Linux（本项目已提供 systemd 模板）或在 Windows 上使用 WSL2。原生 Windows 可运行解析测试、SQLite、历史回测和 Dashboard，但不能直接连接实时流。

```bash
pnpm install
cp .env.example .env
# 填写 FLOW_GRPC_TOKEN；硅谷部署默认使用 LAX 主端点、SLC 备用端点
pnpm test
pnpm start
```

Dashboard 默认地址：<http://127.0.0.1:3001>

六个页面：

1. **Overview**：今日 Raw Trades、活跃 Token、Candidate、Flow Signal、Smart Wallet 事件。
2. **Signal Monitor**：Symbol、CA、AGE、Curve、三窗口 NetFlow、Buyers、Buy TX 与未来收益。
3. **Backtest**：按“禁止开单过滤、买入信号条件、动态卖出策略”三层回测，并拆分执行延迟与全部成本。
4. **Smart Wallet**：分别显示 OPEN / ADD、OPEN 5/10/30 秒 Primary 覆盖率、ADD 覆盖率与同 Mint 信号再触发率。
5. **Live Trading**：左侧选择实盘或任一 Shadow 策略，右侧只加载该策略的参数、统计和交易记录，避免一次刷新全部长表。
6. **System Health**：数据流、解析量、Buffer、标签、数据库写入和错误。

Live Trading 中的 **Bonding Curve 动量 · H** 是完全独立的毕业前订单流实验：H0 生命周期基线、H1 买单速度、H2 新买家分散、H3 卖压衰减，分别配合固定3秒、订单流反转和大赢家移动止盈三种退出。它只写入 `bonding_curve_momentum_shadow_positions` 与 `bonding_curve_momentum_shadow_snapshots`，不会签名或发送交易，也不会修改旧 Shadow 的历史数据。

**毕业概率持仓 · I** 不把高 Curve 概率当成追涨信号。它只复用 Curve≤70% 的早期 `primary_3w` Episode：I0 保留7.5%移动止盈作为对照，I1 要求 Curve 连续通过70/80/85/90/95/97%因果检查点并在毕业前退出，I2 在90/95%使用更严格的买家和成交数门槛，通过后才等待迁移并模拟 PumpSwap 退出。三组只写独立表，永不签名或发送交易。

## 回测

Dashboard 可直接运行常用组合。命令行支持更细的成本拆分：

```bash
pnpm run backtest -- \
  --hold-ms=60000 \
  --delay-ms=200 \
  --entry-timeout-ms=2000 \
  --exit-timeout-ms=5000 \
  --no-exit-loss-pct=100 \
  --platform-fee-pct=0.8 \
  --buy-slippage-pct=0.3 \
  --sell-slippage-pct=0.3 \
  --impact-pct=0.2 \
  --base-tx-fee-sol=0.00001 \
  --priority-fee-sol=0.0005 \
  --jito-tip-sol=0.001 \
  --position-sol=0.2 \
  --entry-failure-rate-pct=2 \
  --entry-failure-cost-pct=1 \
  --take-profit-pct=10 \
  --stop-loss-pct=8 \
  --trailing-stop-pct=4 \
  --trailing-activation-pct=6 \
  --flow-exit-window-ms=2000 \
  --flow-exit-netflow-sol=0 \
  --flow-exit-min-hold-ms=1000 \
  --flow-exit-confirmations=2 \
  --exit-on-smart-wallet-sell=false \
  --exit-delay-ms=200 \
  --exit-retry-count=1 \
  --exit-retry-delay-ms=500 \
  --split-ratio=0.7 \
  --bootstrap-samples=500 \
  --signal-variant=primary_3w \
  --first-signal-only=false \
  --signal-cooldown-ms=5000 \
  --single-position-per-mint=true \
  --max-age-ms=120000 \
  --max-entry-price-jump-pct=20 \
  --max-curve-pct=60 \
  --max-buy-tx-w3=3 \
  --max-buyers-w3=3 \
  --max-net-w3=3 \
  --min-net-w3=1 \
  --min-delta-12=1 \
  --min-delta-23=1 \
  --min-buy-tx-w3=5 \
  --min-buyers-w3=5 \
  --min-accel=1.2
```

Dashboard、命令行回测和批量分析默认使用 200ms 买入延迟及 200ms 卖出延迟。`exit-delay-ms=0` 只代表理想化成交价格；结果会返回 `IDEALIZED_ZERO_DELAY_EXIT` 警告，不能作为可执行策略结论。

每 Mint 首信号与冷却只在回测选择阶段应用，不会从采集库删除原始信号。信号表保存 `signal_episode_id`、`signal_rank_in_mint` 和 `previous_signal_gap_ms`。默认回测使用 5 秒冷却并限制同一 Mint 同时只有一个开放仓位；`first-signal-only` 仅作为激进过滤的诊断选项。

程序并行保存三个研究版本：

- `primary_3w`：现有三窗口 Flow Acceleration 主信号。
- `shadow_2w`：仅使用最近两个窗口的提前确认信号。
- `shadow_netflow_breakout`：不要求加速度 ratio 的净流入突破影子信号。

影子信号只用于 Future Label 和回测研究，不会触发链上交易；Signal Monitor 和 Smart Wallet 重合默认仍以 `primary_3w` 为准。

Smart Wallet 事件按 Token 余额保存 `OPEN / ADD / REDUCE / CLOSE / SELL` 生命周期。真实 OPEN 会写入 `smart_signal_confirmations`，记录最近 30 秒 Primary 信号、确认延迟与开仓 SOL；这些仍是离线监督标签，不会用未来信息反推更早的 Flow Signal 买点。Dashboard 原来的“Signal 重合率”已改为明确的 OPEN / ADD 时间窗口覆盖率，避免把连续加仓误读成重复信号。

入场只接受 `Signal Time + Execution Delay` 之后、入场等待上限以内且毕业之前的 Bonding Curve 成交，绝不会用 PumpSwap 反推买入。持仓时间从实际模拟入场开始计算；出场可使用 Bonding Curve 或毕业后的 PumpSwap 成交。没有入场、毕业前未成交、没有出场、历史数据缺口和数据右删失会分别统计，不再静默丢弃。没有出场的已入场样本默认按 `-100%` 再扣确定性成本。

平台费、双边滑点、价格冲击和固定链上费用构成成功成交的确定性成本。Future Label 只扣除这些确定性成本，不再把随机执行失败混入市场收益标签。买入失败表示没有建仓，只损失失败尝试成本；卖出失败使用 `exit-retry-count`、重试间隔和失败费用沿真实逐笔价格路径重新执行。若正常策略本身为负，买入失败可能在数学上改善每信号收益，因此输出同时提供条件于已执行交易的收益并给出警告，不能把它误读成策略改善。

止盈、止损、移动止损、滚动 NetFlow 衰减和 Smart Wallet SELL 按逐笔路径判断谁先触发；触发以后再应用卖出延迟与失败重试。`hold-ms` 现在表示动态条件都未触发时的最大持仓兜底。若全部动态退出均关闭，结果会返回 `FIXED_TIME_EXIT_ONLY` 警告。`Observed Entry Gap` 是信号到下一笔可观察市场成交的间隔，不代表机器人真实上链延迟。

## Flow -> Smart Confirmation Shadow L

该路径把 Smart Wallet 确认改成严格的前向实验：只接受 `primary_3w Rank 1`
后 5 秒或 15 秒内出现的 Smart Wallet `OPEN`，并在 OPEN 后 200ms 开始等待
下一笔 Bonding Curve 成交作为模拟入场。L5/L15 分别测试固定 5 秒与较宽移动
止盈，仓位写入 `flow_smart_confirm_shadow_positions`，不会签名或发送交易。

Launch First Pullback 的 F/FQ/FT/FD 历史组保持不变。新增 `FO_*` 独立优化组测试
Top3 持仓集中度不高于 70% 的 10 秒持有/移动止盈，以及 Creator 不高于 5%、
最近买家不少于 10 的 30 秒右尾与 12.5% 深回踩长持有。所有新组使用新 cohort
ID，不会与历史结果混算。

### 可复现分析

不要在持续写入的实时数据库上顺序运行多组参数。先创建 SQLite 一致性快照：

```bash
pnpm snapshot
```

也可以一条命令创建快照，并让持仓、延迟和 W3 扫描共用完全相同的信号区间与数据截止时间：

```bash
pnpm analyze -- --out=reports/strategy-analysis.json
```

分析输出包括前 70% / 后 30% 时间外验证、按 Mint 等权收益、收益分位数、最大赢家贡献、去掉最大 1/3/5 笔后的平均收益，以及按 Mint 重采样的 Bootstrap 95% 置信区间。低于实时采集门槛的参数无法从已有数据库恢复；研究阶段应保持 `FLOW_MIN_NET_W3_SOL=1` 的宽口径采集，在回测参数中筛选 W3≥8/10，而不是提前丢弃低门槛信号。

## Primary Early 多组 Shadow 策略

程序保留低门槛 `primary_3w` 研究信号，同时在同一个三窗口加速周期内记录三组独立的首次门槛穿越：`primary_early_3_3`、`primary_early_5_4`、`primary_early_7_5`。三条模拟路径固定为 `SHADOW`，没有交易执行器，也不会读取私钥、签名或发送链上交易。

默认对照组分别为激进 `3 SOL / 3 Buyers`、均衡 `5 SOL / 4 Buyers` 和保守 `7 SOL / 5 Buyers`。每组在候选周期内只记录第一次穿越；信号后200ms开始寻找 Bonding Curve 模拟成交，2秒内没有成交或追价超过10%则不入场。入场后立即启用峰值价格回撤7.5%退出，所有仓位最长60秒。

模拟仓位、所属门槛版本、净收益和退出原因保存在 `primary_signal_shadow_positions` 及对应的 `flow_signals`。Dashboard 的“实盘交易”页面会按三组分别统计，并与真实 Primary 仓位分开显示，接口为 `GET /api/primary-signal-shadow`。所有 Shadow 新样本的公共默认仓位为1 SOL，并按该仓位扣除固定链上成本；策略专属环境变量仍可覆盖。历史记录保留各自行内的 `position_sol/configured_cost_pct`，不会被回写。公共执行参数使用 `FLOW_SIGNAL_SHADOW_*` 环境变量，均衡组直接复用实盘 `FLOW_LIVE_MIN_*` 门槛。

## Smart Wallet 回踩 Shadow A/B

当前 Smart Wallet 研究路径只运行模拟A/B，不读取私钥、不创建交易执行器，也永不签名或发送链上交易。≥0.1 SOL 的 Bonding Curve Smart BUY 按同 Mint 30秒聚合为一个 Episode；触发后最多观察15秒：价格需从触发后的局部峰值回撤至少2.5%，再从低点反弹至少7.5%，反弹阶段至少出现1个独立买家，且200ms执行延迟后的模拟入场价不得高于 Smart BUY 价格2%。

两组共享完全相同的 Episode、确认时点与模拟入场，唯一差异是退出阈值：

- A组：入场即激活，峰值回撤7.5%退出，60秒兜底。
- B组：入场即激活，峰值回撤12.5%退出，60秒兜底。

模拟路径保存在 `smart_pullback_shadow_positions`，接口为 `GET /api/smart-pullback-shadow`。Dashboard 除平均收益、中位数、胜率和PF外，还统计最大赢家、Top5赢家对总盈利的贡献、MFE≥50%的大赢家机会、实际兑现的大赢家数量以及退出收益对MFE的兑现比例，用来验证“较低胜率 + 右尾大赢家”是否能覆盖全部亏损和成本。

## Smart Wallet OPEN Shadow D

这是一条全新的独立研究路径，不修改 A/B、C 或 Primary Early 的规则，也不复用它们的结果表。只有被监控钱包在 Bonding Curve 上从零仓位首次买入形成的真实 `OPEN` 才可能入场；`ADD` 会保留为规则拒绝样本，不能混入 OPEN 统计。公共入场条件为 Smart OPEN 金额至少1 SOL、OPEN 前2秒已有至少2个其他独立买家，200ms后按首个 Bonding Curve 成交模拟入场，追价超过10%或2秒无成交则拒绝。

三个D组共享同一个 OPEN 和模拟入场，只比较退出方式：

- D0：固定持有5秒。
- D1：硬止损12.5%；盈利达到20%后才激活峰值回撤15%；60秒兜底。
- D2：硬止损12.5%；跟随触发 OPEN 的同一 Smart Wallet 首次 `REDUCE / CLOSE`；180秒兜底。

所有样本只写入 `smart_open_shadow_positions`，接口为 `GET /api/smart-open-shadow`。该路径没有执行器、不读取私钥，永不签名或发送交易。Dashboard 额外按实际入场跳价分层，显示大赢家机会、兑现率和MFE捕获，便于判断问题来自 Smart OPEN 本身、跟随延迟还是退出过早。

## Launch First Pullback Shadow F

Observer E 继续完整记录所有 Launch。新 F 路径只在实时检测到“首波上涨25% → 从峰值回踩7.5% → 从低点反弹3%”的第一个参考点时建立独立模拟样本；服务启动时的历史回放不会补发交易参考点。完成、右截尾或无参考的 Observer 标签为终态，重启回放不能再覆盖它们。

F 路径保留三个质量过滤档位，每档分别固定持有3秒和8秒，共六个原始 cohort：

- F1：参考点 NetFlow ≥15 SOL，Creator 买入占比 ≤5%。
- F2：参考点 NetFlow ≥20 SOL，Creator 买入占比 ≤10%。
- F3 对照：参考点 NetFlow ≥20 SOL，Creator 买入占比 ≤20%。

在不修改上述六组及其历史的前提下，额外运行四个独立的延长持仓 cohort。它们复用相应F档位的原入场点，只改变退出：

- FT-A：F2入场；最短持有3秒，入场即激活峰值回撤20%，120秒兜底，无硬止损。
- FT-B：F1入场；盈利10%激活峰值回撤20%，最短持有3秒，硬止损30%，120秒兜底。
- FT-C：F2入场；盈利30%激活峰值回撤20%，硬止损30%，120秒兜底。
- FT-D敏感性对照：F1入场；盈利30%激活峰值回撤15%，最短持有3秒，硬止损30%，120秒兜底。

FT-A/B/C/D使用全新的 `cohort_id`，Dashboard 会分别统计，不会把新结果并入原F1/F2/F3固定持仓历史。这些组仍是右尾依赖型研究实验，仅用于前向Shadow验证。

在旧组不变的前提下，另设四个深回踩前向 cohort：`FD10_R3_5S`、`FD12_5_R3_5S`、`FD12_5_R5_5S` 与 `FD15_R5_5S`。它们分别测试10%～15%的首波回踩和3%/5%低点反弹，要求低点至少稳定0.5～1秒、低点之后至少出现2个新买家、最近1秒净流入重新为正；若回踩超过25%则只记录规则拒绝，不模拟接飞刀。四组共用 F1 的 NetFlow/Creator 质量门槛和固定5秒退出，因此统计差异主要来自入场深度与确认强度。深回踩参考点由 Observer E 独立跟踪，具有独立 `reference_profile_id`，不会改写或混入原7.5%参考点。

模拟入场使用参考点后200ms的首个 Bonding Curve 价格，2秒内无成交记为 `NO_ENTRY`，入场跳价超过10%记为 `PRICE_JUMP`；退出触发后同样加入200ms执行延迟和5秒超时。新样本收益扣除默认1 SOL仓位对应的完整确定性成本模型。所有样本只写入 `launch_pullback_shadow_positions`，接口为 `GET /api/launch-pullback-shadow`；该路径没有执行器、不读取私钥，永不签名或发送交易。

## PumpSwap Range Scalper Shadow J

Shadow J 对每个新毕业 Mint 先订阅 PumpSwap 成交120秒，用滚动60秒成交构建因果区间状态：成交笔数、SOL成交量、独立钱包、买卖占比、振幅、价格路径效率、均值穿越次数、最大钱包集中度和短期趋势。只有高成交量、低趋势、持续来回穿越均值的市场才延长订阅，最长20分钟；区间连续失效30秒且没有活动仓位时自动退订，避免无边界增加 Helius 消耗。

每个合格区间并行测试三组入场：`JA` 为偏离中轴1σ后反弹2%，`JB` 为偏离1.5σ且最近1秒净流入转正，`JC` 为下轨反弹并要求新买家与卖压衰减。每次价格回到中轴后重新武装，因此同一 Mint 可产生多个独立 Episode。每个入场同时模拟中轴退出、固定+6%、上轨退出和中轴资金流反转四组卖法，统一使用200ms执行延迟、8%硬止损与20–30秒兜底，并扣除默认1 SOL仓位的确定性成本。该策略只有 Shadow 路径、独立表与 Dashboard 页面，永不签名或发送链上交易。

## CYA Early Pyramid Shadow K

Shadow K 把钱包分析结论转成独立的公开订单流实验，不读取目标钱包动作作为信号。`K5_30` 测试 AGE 5–30秒、Curve 20–60%的较严格窗口；`K3_30` 放宽到 AGE 3–30秒。两组都限制5秒买家数、净流入和2秒涨幅，避免在订单流已经拥挤时追入。信号后使用200ms后的真实 Bonding Curve 成交模拟入场。

初始仓位默认1 SOL。价格每继续上涨15%且订单流仍未拥挤时，按初始仓位的1/12模拟加仓，最多6次；+50%和+100%分别减仓，剩余尾仓独立测试峰值回撤20%和30%。未出现强度时25秒退出，未减仓前硬止损30%，最长持有3分钟。每笔仓位单独记录累计投入、加仓/减仓次数及多次执行产生的估算费用，接口为 `GET /api/cya-early-pyramid-shadow`；该路径没有执行器、不读取私钥，永不签名或发送链上交易。

从本版本开始，`FLOW_SHADOW_DEFAULT_POSITION_SOL=1` 是所有 Shadow 的公共仓位默认值。为了让旧服务器直接升级生效，策略专属 `*_POSITION_SOL=0.05` 会被识别为历史默认并继承新的1 SOL公共值；其它自定义数值仍是显式覆盖项。若确实要让全部 Shadow 回到0.05 SOL，应把公共默认本身设为0.05。历史记录不会重算或混入新策略，实盘仓位配置也不受影响。

## Lifecycle Drop/Rebound Shadow G

Shadow G 先按生命周期分成两个完全独立的研究层：`PRE_MIGRATION` 只用毕业前 `PUMP_BONDING_CURVE` 成交触发信号和入场，AGE 从 Token 创建时间计算；`POST_MIGRATION` 只用毕业后的 `PUMP_AMM` 成交触发信号和入场，AGE 从毕业时间计算。两层拥有独立检测状态、Episode 与 cohort，统计时不会把两种市场结构混在一起。此前已经积累的毕业后记录会通过数据库默认值保留为 `POST_MIGRATION`。

完整的毕业前 Curve 成交本来就持续写入 `raw_trades`；新毕业 Mint 另外默认持续订阅5分钟 PumpSwap 并保存逐笔成交。因此样本积累后可以分别离线穷举窗口、跌幅、反弹幅度和确认时限。毕业前建立的模拟仓位如果跨过毕业时点，可以继续使用迁移后的 PumpSwap 成交退出，但不会把该仓位改记成毕业后入场。

两个生命周期层都使用同一组可比参数。基准入场为“1秒滚动高点下跌15%–35%，随后从运行低点反弹2%–5%，且反弹在候选开始后1秒内出现”。同一跌势只触发一次，必须先恢复到未达到15%跌幅才会重新武装。每层同时跑八个正交入场组：0.5/1/2秒窗口、15%–25%与25%–35%跌幅分层、2%与3%反弹下限、0.5/1/2秒反弹时限；每组只改变一个核心变量。

每个入场组同时模拟四种退出：固定3秒、固定8秒、旧版“+8%激活/峰值回撤3%/快速+18%/6秒亏损检查/15秒兜底”，以及保留大赢家的“硬止损20%/+20%激活/峰值回撤10%/60秒兜底”。因此总矩阵是 `2 生命周期 × 8 入场 × 4 退出 = 64` 个独立组合。模拟入场和退出均使用200ms执行延迟后的对应市场真实成交，新样本收益扣除默认1 SOL仓位的确定性成本；MFE、MAE和实际入场跳价一并保存。兼容接口仍为 `GET /api/migrated-drop-rebound-shadow`。该策略没有执行器、不读取私钥，永不签名或发送交易。

## Flow-First Shadow C

`Flow-First Shadow C` 直接消费 Signal Monitor 对应的 `primary_3w` 主信号，不等待 Smart Wallet。它按数据库中的 `signal_episode_id` 去重：同一 Mint、同一30秒信号周期内即使 Rank 连续增长，也只建立一次模拟入场；原始信号行和 Future Label 仍全部保存，不会因去重而丢失。

三个C组共享完全相同的信号、200ms执行延迟和延迟后的首个 Bonding Curve 模拟成交，唯一差异是退出方式：

- C5：从实际模拟入场开始固定持有5秒，再等待200ms后的首个可退出成交。
- C7.5：入场即激活移动止盈，峰值回撤7.5%退出，60秒兜底。
- C12.5：入场即激活移动止盈，峰值回撤12.5%退出，60秒兜底。

模拟仓位保存在 `flow_first_shadow_positions`，接口为 `GET /api/flow-first-shadow`。Dashboard 按独立 Episode/Mint 显示扣除默认1 SOL完整成本模型后的平均与中位净收益、胜率、PF、实际入场跳价、MFE、最大赢家、Top5盈利贡献、去掉Top5后的平均收益以及大赢家兑现率。该路径没有执行器、不读取私钥，也永不签名或发送链上交易。

## 多策略实盘框架

旧的 Primary Early 实盘入口已经移除，Primary 信号只继续用于研究和历史 Shadow。当前唯一实盘候选来自最近24小时样本中表现相对稳定的毕业后深跌反弹组合：

```text
毕业后 120 秒内的 PumpSwap 成交
AND 1 秒窗口从局部高点下跌 25%～35%
AND 低点在 1 秒内反弹 2%～5%
AND 每个 Mint 只取第一个 Episode
```

实盘决策统一写入 `live_strategy_decisions`，仓位和订单同时保存 `strategy_id`。接口和 Dashboard 可按策略筛选，因此后续增加多个实盘策略时，可以分别设置开关与单笔 SOL 数额，历史数据不会混在一起。当前策略的单笔金额为 `FLOW_LIVE_POST_GD25_35_XLEG_POSITION_SOL=1`，全局最大并发默认为 `FLOW_LIVE_MAX_POSITIONS=3`（最多同时占用 `3 SOL`，不含费用）；没有每日笔数上限，也没有当日累计亏损自动停机，但安全锁、钱包最低 SOL 保留额、单 Mint 单仓和全局并发限制仍然有效。

执行模块有三种模式：

- `DISABLED`：当前强制模式，只保存规则判定。
- `DRY_RUN`：只有先显式解除 `FLOW_LIVE_TRADING_SAFETY_LOCK`，再设置 `FLOW_LIVE_TRADING_ENABLED=true` 并保留 `FLOW_LIVE_DRY_RUN=true` 才能启用。
- `LIVE`：除解除安全锁外，还需设置 `FLOW_LIVE_DRY_RUN=false`、`FLOW_RPC_URL`、`FLOW_LIVE_PRIVATE_KEY`，并显式填写当前策略的 `FLOW_LIVE_POST_GD25_35_XLEG_POSITION_SOL`。

`FLOW_LIVE_TRADING_SAFETY_LOCK` 默认为 `true`，优先级高于旧服务器 `.env` 中的 `FLOW_LIVE_TRADING_ENABLED=true`。因此升级并重启后，旧配置不会意外恢复签名或链上发单；Dashboard 会明确显示安全锁已开启。

当前实盘策略直接使用官方 PumpSwap SDK 买卖。买入使用固定 SOL 输入，`1 SOL` 是硬上限；滑点只降低最少可接受 Token 数，不允许超额花费。程序限制单 Mint 单仓、并发仓位、钱包 SOL 保留额、信号新鲜度、追价幅度、Mint 冷却和滑点；买入不会在已持有该 Mint 时继续加仓。买入和卖出滑点分别由 `FLOW_LIVE_BUY_SLIPPAGE_PCT`（默认10%）与 `FLOW_LIVE_SELL_SLIPPAGE_PCT`（默认15%）控制。买入和卖出的总优先费目标都由 `FLOW_LIVE_PRIORITY_FEE_SOL` 控制，默认每笔 `0.0005 SOL`，程序会根据 Compute Unit 上限自动换算成链上要求的 micro-lamports/CU。

当前卖出策略为 `XLEG`：前5秒达到 `+18%` 立即止盈；否则在盈利 `+8%` 后激活移动止盈，峰值回撤 `3%` 卖出；持有6秒仍为亏损则退出，15秒强制兜底。退出失败会按配置重试并保留 `EXIT_FAILED` 仓位，防止同 Mint 再次开仓。创建 `FLOW_LIVE_KILL_SWITCH_FILE` 指定的文件会立即禁止新开仓，但不会阻止已有仓位退出。

买入交易如果已经获得签名，程序会区分“链上明确失败”和“RPC确认状态未知”。链上明确失败直接记录为 `ENTRY_FAILED`，不会尝试卖出；状态未知时同时查询签名历史、确认交易的 `pre/postTokenBalances` 和交易钱包的Token余额。即使Token-2022 ATA尚未被RPC账户索引，只要交易回执显示钱包实际收到Token，也会按真实raw数量恢复仓位。单次余额为0或账户暂不可见只保持 `ENTRY_CONFIRMATION_UNKNOWN`，不会再误写 `ENTRY_CONFIRMED_EMPTY`，也不会盲目发送卖出。服务重启时会自动重新核对未知仓位，以及旧版本曾误关的 `ENTRY_CONFIRMED_EMPTY` 仓位；恢复成功且已超过持仓兜底时间时会立即进入正常卖出流程。

先至少运行一段时间 DRY RUN 并核对 `GET /api/live-trading`、`live_strategy_decisions`、`live_positions` 和 `live_orders`，再启用真实签名。私钥只从环境变量读取，不写数据库、不通过 Dashboard 返回、也不会打印到日志。

## 部署

`deploy/flow-acceleration.service` 提供 systemd 模板。服务重启后会继续使用同一个 SQLite 数据库；最近 120 秒内尚未完成的 Signal Labels 会恢复跟踪。

Helius LaserStream 端点必须使用 HTTP(S) URI。配置中省略协议时程序会自动补成 `https://`。多个端点按顺序配置为单活主备；程序只订阅当前端点，断线或连续 15 秒没有交易时切到下一个端点，避免双路订阅产生接近 1:1 的重复数据和额外用量。硅谷部署默认使用：

```text
FLOW_GRPC_ENDPOINTS=https://laserstream-mainnet-lax.helius-rpc.com,https://laserstream-mainnet-slc.helius-rpc.com
```

切换后不会仅因为首选端点恢复就立即切回，避免连接抖动；当前备用端点失效时才会按列表继续轮转。Dashboard 的“重复副本已丢弃”通常应接近 0，只会在切换边界或上游重放时增加。

Linux 一键安装会保留已有 `.env`、检查服务用户、Node.js 22+ 与 pnpm，生成缺失的 `.env`，校验 systemd 单元并设置开机自启：

```bash
sudo bash deploy/install.sh /opt/flow-acceleration
sudo nano /opt/flow-acceleration/.env
sudo systemctl restart flow-acceleration
sudo systemctl --no-pager --full status flow-acceleration
```

也可以在已经配置好 `.env` 时使用 `START_SERVICE=1 sudo -E bash deploy/install.sh`，让安装脚本完成后立即启动并显示服务状态。

### 每日 08:00 自动导出最近 24 小时并上传腾讯 COS

每日归档不再调用 `better-sqlite3 backup()` 复制整个历史库，也不会执行任何 WAL checkpoint。`scripts/export-research-window.js` 会在一个一致性读事务内只查询源库，把最近 24 小时数据直接写入小型归档库；历史元数据表完整保留，源服务无需停止或重启。导出包包含 SQLite、schema、时间边界与逐表行数、服务状态、最近日志和版本信息，并在上传前执行 `quick_check`、tar 完整性检查及 SHA-256。

先安装腾讯官方 COSCLI，然后安装 timer：

```bash
sudo bash deploy/install-daily-export.sh /opt/flow-acceleration
sudoedit /etc/flow-acceleration/backup-cos.env
```

新服务器也可以在主安装时直接加 `INSTALL_DAILY_EXPORT=1`，一次安装程序服务和每日 timer（仍需预先安装 COSCLI）：

```bash
INSTALL_DAILY_EXPORT=1 sudo -E bash deploy/install.sh /opt/flow-acceleration
```

如果程序实际位于 `/home/ubuntu/Flow-Acceleration`，把上面安装命令的最后一个参数换成该路径即可。

服务器凭据文件由服务用户持有、权限为 `0600`，只在服务器填写，绝不能提交。模板已经预填：

- Bucket：`guigu-1403019446`
- Region：`na-siliconvalley`
- Endpoint：`cos.na-siliconvalley.myqcloud.com`
- COS 路径：`flow-acceleration/daily/YYYY/MM/DD/`
- 本地保留：7 天

填写 `FLOW_BACKUP_COS_SECRET_ID` 与 `FLOW_BACKUP_COS_SECRET_KEY` 后，先手动验证一次，再查看下一次计划时间：

```bash
sudo systemctl start flow-acceleration-backup.service
sudo journalctl -u flow-acceleration-backup.service -n 100 --no-pager
systemctl list-timers flow-acceleration-backup.timer --all
```

Timer 使用显式 `Asia/Shanghai` 时区，每天北京时间 08:00 运行，即使服务器位于硅谷也不会按当地时间偏移。`flock` 会阻止任务重叠；导出进程使用低 CPU/IO 优先级。COSCLI 配置在运行时写入私有临时文件并在结束时删除，SecretId/SecretKey 不进入压缩包和命令行参数。永久密钥应遵循最小权限原则，只授予该 Bucket 前缀所需的上传和查询权限。

安装程序会删除旧版本遗留的 `cos-auto-upload-export.sh`、`export-last10h.sh` 或 `export-last24h-cos.sh` cron 项，防止旧任务每6小时重复上传过期文件；其它 cron 项不会受影响。导出、上传和验证均有独立超时与重试，最近一次状态写入 `data/exports/last-run.env`（`EXPORTING`、`UPLOADING`、`VERIFYING`、`DONE` 或 `FAILED`），COSCLI 卡住时不会无限占用下一次任务。
