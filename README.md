# Pump.fun Flow Acceleration Research + Multi-Strategy Executor

## 2026-08-31 当前生效口径（优先于下方历史记录）

本节是当前代码的权威状态说明；下方各章节保留历次实验背景，不代表相关策略仍在
产生新仓位。

- **极速 RUG 按生命周期分层。** Bonding Curve 早期、迁移前、迁移窗口、
  PumpSwap 早期及成熟期分别记录不同风险标签。当前只有 Lifecycle G 的
  `AMM_EARLY` 样本在满足 HC2（两个相互独立的高风险证据）时硬拦截；Graduation O、
  COB 及其他策略先记录标签，不直接阻断，以免未经验证的统一阈值误杀不同阶段机会。
- **收益只有一个口径。** 仅 `CLOSED` 且入口、出口来自同一市场的仓位计入已实现
  收益；`NO_EXIT`、失败退出和未完成结算均是未决/删失样本，收益保持 `NULL`，不得
  按 -100% 计入；跨市场价格只作诊断，不能混算收益。COB-D/F 面板也遵守这一规则。
- **已退休研究由总闸保护。** PFL、CAF、PM-SURV、M2F/LPS、Launch First Pullback、
  Launch Quality E、Migration Continuity M、Quality Leader QL、Big Winner/PP
  停止产生新样本，但历史数据仍可查询。旧服务器即使残留对应 `...ENABLED=true`，
  也不能重新开启；只有显式设置 `FLOW_RETIRED_RESEARCH_REOPEN_ENABLED=true` 才能
  进行人工复核后的重启。
- **继续前向验证。** Lifecycle G 继续测试分阶段极速 RUG 硬拦截；Graduation O
  继续记录阶段标签但暂不硬拦截；FEA 的 `FEA-BNH-120` 作为独立 Shadow 继续验证
  “买家广度 + 自然资金流 + 120秒退出”，不进入实盘。现有
  `GE30_R23_F2_G2_XLEG` 实盘路径保持不变。编号
  `G-V2-EXEC01-R2-H15` 的0.1 SOL实盘复测因胜率偏低且未能捕获大赢单，已于
  2026-09-01 在代码层停止新开仓；历史样本和存量仓位退出继续保留。

当前样本中，Lifecycle G 的极速 RUG 标记组平均约 -33.79%，未标记组约 +17.75%；
13 个标记样本覆盖了全部 7 个 `≤-50%` 大亏样本，且没有拦掉 3 个 `≥+50%` 大赢家，
样本内差异约 51.5 个百分点（仍需前向样本确认）。Graduation O 当前 23/23 个样本
均被标记，尚无选择性，因此只能记录标签，不能直接硬拦截。FEA 已有 7,231 个完整
标签，但另有 20,093 个右删失样本（约 73.3%）；其中候选子集的高收益可能包含明显
选择偏差，所以只建立 Shadow，不能据此直接实盘。

## Big Winner Pullback + Flow Shadow (BW)

`BigWinnerShadowSuite` is an isolated, post-graduation PumpSwap research path. It crosses
four causal entry profiles (`PBR_A`, `PBR_B`, `PBR_C`, `FLOW_R`) with the original four
Core/Runner exits (`X50_15`, `X50_12`, `X50_RATCHET`, `X40_RATCHET`) plus two new
right-tail controls: `XFIX60_H15` and `XFIX120_H15`. The controls use only a -15% hard
stop and a fixed 60/120-second maximum; they never take partial profit or trail a peak.
All 24 cohorts have independent IDs, so the original 16-cohort history is unchanged.
Every fill uses a 200 ms delay, a 1 SOL position model, configured costs, and an entry
impact guard when live pool reserves are present. It never signs or submits a transaction.
Rows are stored only in `big_winner_shadow_positions`; `NO_EXIT` remains censored with a
null return and cannot be aggregated as a -100% loss. Daily research exports include the
new table automatically.

2026-08-18 起新增三组完全独立的参与度持续 cohort：`PP_DIRECT_10` 要求毕业后
10–30秒的最近10秒至少40笔成交、20名独立买家和3 SOL净流入，同时最近5秒买家与
资金流不能明显衰减；`PP_PULLBACK_8_20` 在同一质量确认后等待首次8%–20%回踩和
2%–8%反弹，并要求3秒资金流重新加速；`PP_PULLBACK_8_30` 是更宽的频率对照。
三组分别模拟0.05/0.1/0.25 SOL，买卖均按已采集的PumpSwap储备估算自身冲击，
只交叉固定120秒、固定240秒和25% Core + 75% Runner三种新退出。旧PBR/FLOW cohort
的ID、规则和历史统计不变，也不会因为新增退出而产生混合样本。

2026-08-20 的18小时导出复核发现，旧 PBR/PP 的若干账面大赢家来自单笔、数毫秒后
即恢复的异常上冲价格。当前实现不再让这种单笔尖峰直接更新 MFE、核心止盈或移动
止盈：上涨达到前价2倍时，必须由第二个独立钱包确认，或在同一价格区域持续至少
150ms；下跌仍立即进入执行模型，避免美化 RUG 损失。旧 `PBR_A/B/C`、`FLOW_R`、
`PP_DIRECT_10`、`PP_PULLBACK_8_20/8_30` 只保留历史与存量退出，不再生成新仓位。
新增的 `PP20_B45`、`PP20_EARLY_BREADTH`、`PP20_QUALITY` 分别验证 Buyers10≥45、
AGE≤25s+双窗口买家广度，以及再叠加 Sell3≤2.5 SOL；只交叉
`X25_RATCHET_PP`，继续按0.05/0.1/0.25 SOL独立测试，绝不发送链上交易。
当前仅 `PP20_B45` 与 `PP20_QUALITY` 继续产生前向样本，Early-Breadth 保留历史。

2026-08-21 起新增两个前向、独立编号的验证组，旧行绝不重算：
`PP_PULLBACK_8_30_NF8_3` 复用宽回踩结构，但在入场时额外要求最近8秒净流入
至少3 SOL，只交叉 `X25_RATCHET_PP`，并按0.1/0.25 SOL分别计数；
`PBR_A_B10_PB20` 把 PBR-A 收紧为 Buyers3≥10、回踩12%–20%，只使用
`X50_15` 作为严格对照。两组均为 Shadow，不会触发任何实盘交易。

`PBR-A-X50-15` 的 V2 实盘复测已于 2026-08-22 停止新开仓；定义仍加载以保留
历史展示和存量退出，旧服务器 `.env` 也不能将其误开启。`PP8-30-NF8-3` 与
`PBR-A-B10-PB20` 继续只做 Shadow。

2026-08-23 复核新样本后，`PBR_C` 再次停止产生新仓位；历史和存量退出保留。
前向研究恢复 `PP20_B45` 与 `PP20_QUALITY`，分别验证广度和广度+卖压质量，
不会触发任何实盘交易。

The same exit hypothesis is tested without changing entry rules in two other promising
families. Smart-Like Early adds BASE-only `FIX60_H20` / `FIX120_H20` exits (no pyramiding,
partial profit, flow-decay exit, or trailing stop). Launch First Pullback adds
`F2_NF30_H20_60S`, `F2_NF30_H20_120S`, `FO_RB10_H20_60S`, and
`FO_RB10_H20_120S`. These four cohorts apply a -20% hard stop before their fixed horizon.
The independent `F2_NF30_H20_120S_EXEC1` cohort preserves the same signal and exit
hypothesis but requires reserve-backed executable entry and exit quotes for a 1 SOL
position; missing capacity data becomes `NO_ENTRY` instead of a mark-price fill.
They reuse existing streams and references, add no Helius subscriptions or RPC calls, and
never sign or send transactions. Proven-negative entry families remain disabled.

这是一个同时采集 Pump.fun 毕业前 Bonding Curve 与所需毕业后 PumpSwap 成交的研究项目，并带有默认关闭、按策略隔离的实盘执行模块。研究主线验证：

> 短时间内净买入资金、独立买家数量和买入成交速度同时加速时，未来数秒是否存在扣除真实成本后仍可交易的价格惯性。

全量 Raw Trade、Flow Signals、Future Labels 和 Smart Wallet 事件始终继续采集。当前只有 `O-C80-D5-B2-S0-NC` 允许产生新实盘仓位，单笔0.1 SOL；对应 Shadow 仍按1 SOL建模。`O90-M5-STAIR120`、`M-C5-T12.5`、`PBR-A-X50-15`、`GFR-300-HS20-H30`、`F-FO-RB10-X30` 等停用定义只保留历史展示和存量退出。实盘规则不使用 Smart Wallet 跟单、RSI、EMA、MACD、社交数据、KOL 或 AI 评分；全局默认 `DISABLED`，不会读取私钥或提交交易。

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
- `holder_growth_shadow_positions`：独立的 Observed Holder Growth Shadow N 仓位；使用成交流中可观测独立买家、新增买家、早期留存、Top3集中度与资金流，不冒充链上权威 Holder 数。
- `migrated_drop_rebound_shadow_positions`：独立的生命周期超跌反弹 Shadow G 参数组；用 `lifecycle_stage` 严格区分毕业前与毕业后模拟入场、MFE/MAE和退出结果。
- `graduation_hold_shadow_positions`：独立的毕业概率持仓 Shadow I0/I1/I2；共享早期 Primary 模拟入场，但分别保存移动止盈对照、97%毕业前退出和严格门槛穿越毕业结果。
- `graduation_acceleration_shadow_positions`：独立的毕业加速 Shadow O；分别记录 FAST10 与 Curve80 订单流入场、0.05/0.5/1 SOL 容量冲击、毕业后 50% Core 退出和阶梯尾仓。`NO_EXIT` 不按 -100% 计入真实盈亏。
- `range_scalper_shadow_positions`：独立的 PumpSwap 区间波段 Shadow J；保存区间质量、重复 Episode、三组回踩入场与四组退出结果。
- `cya_early_pyramid_shadow_positions`：独立的 CYA Early Pyramid Shadow K；保存早期 Curve 订单流入场、分批加仓、两次减仓、尾仓退出及逐仓估算成本。
- `flow_tokens`：创建时间、毕业时间、Bonding Curve、迁移池和 Curve 进度所需状态。

SQLite 使用 WAL 和批量写入。Raw Trade 默认保留最近 48 小时热数据；主交易进程不再同步压缩、删除或执行 `PRAGMA optimize`，避免阻塞 gRPC、策略计算与 Dashboard。每日 COS 导出完成、SHA256 上传且远端对象验证成功后，独立低优先级维护进程才会分批删除超过 `FLOW_RETENTION_HOT_RAW_HOURS` 的 Raw Trade，并执行受限的数据库优化。Signals、Future Labels、Shadow 仓位和实盘仓位不会被该任务删除。启动期间由独立轻量进程显示“系统正在启动”页面；各 Shadow 共用一次近期交易回放，避免重复读取大型数据库。

Dashboard 的详细数据库行数不再由 `/api/health` 在主线程即时扫描。独立只读 Worker 在启动稳定30秒后按 `FLOW_DB_HEALTH_REFRESH_MS`（默认15分钟）生成统计快照，HTTP 只读取缓存；部署与 systemd 存活检查统一使用 O(1) 的 `/health`。Shadow 定时维护拆成四组、每250ms错开一组，但每个策略仍保持每秒推进一次；AMM订阅集合每5秒刷新，并对超过100ms的运行任务及超过250ms的HTTP接口输出节流后的慢日志，便于准确定位剩余阻塞而不影响交易主循环。

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

**毕业加速 · O** 是全新的前向 Shadow，不修改 I 组。主组在 Token 第10秒检查 `Curve≥80%、Buyers≥20、SellSol/BuySol≤0.7`；补充组只观察首次 Curve80 前5秒 `ΔCurve≥5、Buyers≥2、无卖单、Creator未卖`。每个信号同时模拟0.05/0.5/1 SOL并估算自己的 Bonding Curve 买入冲击；毕业后首笔可执行 PumpSwap 成交退出50%，余仓按20/40/80/150/300%分层移动止盈，毕业前后最长各持有5分钟。`NO_EXIT` 单列且收益保持空值，接口为 `GET /api/graduation-acceleration-shadow`。

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

## Smart-Like Early Entry Shadow

`smart_like_early_shadow_positions` 是独立的前向研究表，不修改任何旧 Shadow，也没有签名或发链路径。它同时运行 18 个组合：

- 入场：优质 Smart OPEN 直接确认、`AGE<=10s + 最近5秒 Primary Flow` 严格确认、Primary Rank 1 预测式提前入场。
- 共同过滤：`Curve<=40%`、入场前5秒涨幅不超过10%、5秒净流入非负；所有成交均使用信号后200ms的下一笔真实 Bonding Curve 成交。
- 加仓：不加仓基线；或平均成本上方 `+50%/+80%/+120%` 各增加初始仓位的8%，只在5秒净流入仍非负时执行。
- 退出：`+50%` 卖40%后12%尾仓回撤、`+75%` 卖50%后15%尾仓回撤、`+100%` 卖40%后订单流衰减或20%回撤；最长均为180秒。

F9/FAic 被标记为同一操作集群，短时间重复 OPEN 不会重复触发。预测式入场的后续 Smart OPEN 只写入确认标签，不会回填历史入场价。缺少可执行退出成交时记录为 `NO_EXIT`，收益字段保持空值，不按 -100% 污染统计。Dashboard 接口为 `GET /api/smart-like-early-shadow`。

## Smart Wallet Resonance Right-Tail Shadow SR

`smart_resonance_shadow_positions` 是独立的多钱包共振前向实验表，不修改任何旧
Smart Wallet 或 Shadow 结果。只有第二个或第三个**不同**监控钱包的 BUY 已经到达后
才产生信号；信号前5秒公共订单流会排除全部监控钱包，避免把跟踪对象自己的买单误当成
市场确认。信号价只作参考，模拟入场统一使用200ms后的第一笔同市场真实成交。

五组入场彼此独立：

- `SR-R0`：5秒内2个不同 Smart Wallet，作为无公共流过滤的基线。
- `SR-R1`：R0 + 公共 Buyers≥20、Buy Flow≥15 SOL、最大单一买家占比≤25%。
- `SR-R2`：60秒内3个不同 Smart Wallet + 公共 Buyers≥20、最大单一买家占比≤20%。
- `SR-R3`：60秒内2个不同 Smart Wallet，且尚未毕业、AGE≤25秒、Curve 60–80%、公共 Buyers≥20。
- `SR-R3-GUARD`：保持 R3 原规则不变，额外要求入场前公共成交不命中 RUG 风险标签。

每个入场同时运行8个右尾退出：20%/30%硬止损分别交叉固定60/120/180/240秒
最长持有；没有固定止盈或移动止盈。Dashboard 重点显示 Big50、Big100、Top5赢家
贡献、MFE/MAE 和 NO_EXIT。新样本以池储备计算仓位规模对应的可执行卖价；RUG
期间缺少可用储备时按无法回收处理，不再拿图表最后价冒充成交价。接口为
`GET /api/smart-resonance-shadow`，策略代码为 `SR-R0/R1/R2/R3/R3-GUARD`。

## Smart Wallet 首次 OPEN 右尾 Shadow SWFO-S/B-RT

该组已停止新增样本，仅保留历史对照。实测确认等待 Smart Wallet 首次 OPEN 才触发会
系统性晚于公共订单流，不能作为当前前向买入优势。旧表
`smart_wallet_first_open_right_tail_shadow_positions` 曾把监控钱包降级为一次性触发器：
每个 Smart Wallet Episode 只接受首次 `OPEN`，后续 `ADD` 永久忽略。入场判断只读取
OPEN 到达前已经形成的内存 RUG 快照，不等待未来成交、不访问数据库或 RPC，也不进入
任何实盘路径。风险快照缺失关键字段时记录 `INCOMPLETE_PRE_ENTRY_RISK`，不会误放行。

两组入场独立计数：

- `S50_R8`：入场前涨幅不超过50%，最大连续买单不超过8笔；优先验证快速RUG过滤
  与样本纯度。
- `B70_R10`：入场前涨幅不超过70%，最大连续买单不超过10笔；保留更多右尾候选，
  用于验证较宽条件是否仍能稳定捕获 Big50/Big100。

每组同时交叉固定20/60/120秒、15秒保护后的3秒公共资金衰减退出，以及
`25% Core + 75% Runner`。所有仓位按1 SOL池储备冲击、200ms入场/退出延迟与完整成本
建模；`NO_EXIT` 收益保持空值，不按 -100% 污染统计。Dashboard 显示 PF、Big50、
Big100、Top5贡献和去Top5收益；接口为
`GET /api/smart-first-open-right-tail-shadow`，策略代码为 `SWFO-S/B-RT`。只有同时显式开启
`FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_TRIGGER_V2_ENABLED` 与
`FLOW_SMART_FIRST_OPEN_RIGHT_TAIL_SHADOW_ENABLED` 才会恢复新样本，默认均关闭。

## Shadow 可执行价格与 Pre-entry RUG Guard

关键 Shadow 新样本同时区分“图表价格路径”和“仓位可执行路径”。QL、Migration
Continuity、Launch Pullback、Smart Resonance，以及容量感知 G/Big Winner 分组会从
Bonding Curve 或 PumpSwap 的同笔池储备估算实际买卖均价；`net_return_pct` 使用仓位
规模对应的退出价并扣成本。直接 RUG 且缺少可执行退出储备时，保守记为无法回收，
避免出现 Shadow 只亏 20%、实盘却亏 80% 的系统性高估。

`PreEntryRugRiskTracker` 仅消费现有公共成交，不增加 RPC。它在入场前15秒记录买入
占比、最大连续买单、买卖方向交替率、上涨成交比例与短时涨幅，并增加三项全局硬过滤：

- 15秒涨幅至少50%、单笔最大买入冲击至少10%、单钱包买单次数占比至少8%的
  “垂直薄池 + 钱包复用”；
- 买单数除以独立买家数至少2的“买家广度不足”；
- 15秒涨幅至少30%、最常见三位小数买入金额占买单至少15%的“追涨同额买单”。

北京时间16:00–20:00的历史严重RUG比例较高，因此该窗口内原五项阶梯从5项全中
收紧为命中4项即拒绝；窗口外仍使用5/5。除此以外，Guard 会在内存中记录“4～6笔
大额买单、总额至少40 SOL、500ms内完成”的跨 Mint 发射模板。模板若在30秒内从峰值
崩跌至少60%，其大额买家与金额/时序指纹保留24小时；后续 Mint 即使不足10笔成交，
只要重合至少2个已标毒钱包，或命中同一/保守近似的金额与时序模板，就直接拒绝。
24小时、3天、7天和永久窗口在现有历史回测中拦截结果相同，因此默认不扩大过期窗口；
毒模板会异步保存到独立小文件并在重启时恢复，避免服务重启后失忆。这样可拦截轮换
钱包但复用约20 SOL×4买单的脚本族，同时不会因一次大亏暂停整个低频策略。

所有实盘策略和所有会创建模拟仓位的
Shadow 策略都在真正开仓前执行同一项强制检查；任一硬过滤命中即拒绝，样本不足则
放行并单独计数。纯观察器继续采集完整数据，不受开仓风控影响。

实盘买入热路径只读取内存；缓存命中时完成布尔判断，缓存缺失或过期时最多扫描该 Mint
最近256笔内存成交并立即刷新，不查询 RPC、不扫描数据库、不等待网络。刷新次数记录为
`liveCacheMisses`，既避免 RUG 检测拖慢下单，也避免新成交使旧缓存失效后漏拦。
`QL_STRICT_GUARD`、`GD25_35_RUG_GUARD_*`、`SR_R3_GUARD` 等独立前向组仍保留，
用于比较专门过滤组的历史结果，但不再代表 RUG Guard 的唯一适用范围。

RUG 结果现在按路径拆开统计：`CLIFF_DROP_50` 表示1～3笔卖单在2秒内造成至少50%
垂直下跌并被下一笔独立成交确认；相对入场价跌幅达到70%/80%时分别升级为
`CLIFF_RUG_70` / `CLIFF_RUG_80`。持续至少10秒才从峰值下跌30%的路径标记为
`SLOW_RUG_30`。同钱包在100ms内方向相反的成对事件会被视为解析/路由伪影，不用于
确认极速RUG。CLIFF 标签会让 Shadow 在缺少退出储备时按无法回收处理，避免图表止损
把真实 -80% 误记成 -20%；慢跌仍保留正常的容量感知止损路径。

系统还会从同一有界内存成交环估算各钱包“已观察净代币库存”，显示 Top1/Top3 库存
相对池储备的比例，并模拟这些钱包先砸后1 SOL仓位还能回收多少。该指标明确标为
`RESEARCH_ONLY_NO_ENTRY_BLOCK`：样本不完整时不会假装成真实 holder 余额，也不直接
拒绝实盘入场。它不增加 RPC、数据库查询或等待，后续只有在前向样本证明有效后才考虑
转成硬过滤。

Graduation Acceleration O 的所有新仓都启用1 SOL容量报价；即使是旧入口组，只要
图表价已下跌35%以上，也强制按池储备计算可执行卖价。储备缺失时按无法回收处理，
不再把 -30% 图表止损冒充实盘可实现止损。升级前已经关闭的历史 Shadow 行仍保留其
原始价格口径，不会被后台静默改写。由于
旧行未必保存当时完整池储备，不能可靠重算真实可卖回的 SOL；研究时应把新增 GUARD
组及升级后的前向样本作为可执行口径，不要与旧的 mark-price 历史均值直接合并。

## Public Flow Lead Observer PFL

`public_flow_lead_shadow_positions` 把 Smart Wallet 改为纯离线监督标签：入场只读取
非监控钱包的公开 Bonding Curve 成交，不等待任何 Smart Wallet 交易，也不使用
Smart Wallet 的成交金额或价格。后续首次 `OPEN` 只记录为5秒/15秒命中标签；所有
`ADD` 明确忽略，既不触发入场，也不构成确认。

V2 默认保留两个公共流前置观察组：

- `PFL-S50-R8`：AGE 3–45秒、Curve 20%–85%、1秒/5秒公共买家至少2/6、
  1秒/5秒买入至少0.5/2 SOL、5秒净流入至少1 SOL、Top1不超过35%；同时要求
  入场前 RUG 样本完整、涨幅不超过50%、最大连续买单不超过8笔。
- `PFL-B70-R10`：AGE 3–60秒、Curve 20%–90%、1秒/5秒公共买家至少1/4、
  1秒/5秒买入至少0.25/1 SOL、5秒净流入至少0.5 SOL、Top1不超过45%；入场前
  涨幅不超过70%、最大连续买单不超过10笔，以保留较多右尾候选。

两组都先用公开订单流完成基础筛选，只有候选通过后才读取一次现有内存 RUG 快照；
不会为普通成交增加 RPC、数据库扫描或网络等待。前向样本表明这些组的实际胜率和
收益显著低于早期离线估计，因此默认只写一条 `OBSERVED` 信号并继续标注未来 Smart
OPEN，不再建立模拟仓位。历史模拟仓位和退出组仍保留查询，不与新增观察样本混合统计。
如需复现实验，必须显式设置 `FLOW_PUBLIC_FLOW_LEAD_SIMULATED_ENTRIES_ENABLED=true`。
Dashboard 显示观察信号数、未来 Smart OPEN 5秒/15秒覆盖率及历史模拟表现。
接口为 `GET /api/public-flow-lead-shadow`，
新策略代码为 `PFL-S50-R8/B70-R10`。旧 `PFL-B2` 需显式开启
`FLOW_PUBLIC_FLOW_LEAD_B2_ENABLED`；旧四组还需额外开启
`FLOW_PUBLIC_FLOW_LEAD_LEGACY_PROFILES_ENABLED`。

## Creator Affinity + Public Flow Observer CAF-OBS

早期 CAF 把“监控 Smart Wallet 曾经交易过的 Creator 子样本”展示成了 Creator 历史质量，
容易被误读为该 Creator 的全部发行记录。现在两套数据严格拆开：`flow_tokens` 提供当前
数据库已经观察到、且早于信号时刻的全部发币数、迁移数和迁移率；`smart_wallet_events`
只提供被监控钱包选中过的已闭合交易抽样、抽样胜率和资金回报。两者都不包含当前 Mint
的未来结果，也不会用信号之后发生的事件回填入场特征。

CAF 已切换为纯观察模式，不再新增模拟仓位。停用前仓位及60/120/240秒退出结果仍保留，
但和新 `OBSERVED` 标签分开统计。观察组包括公共流基线 `CAF-ALL-E15`，以及同时要求
Smart 抽样质量和当前数据库全发行质量的 `CAF-W50-E10`、`CAF-P0-E10`、
`CAF-W50-B5-E15`。默认把历史发币至少20个且迁移率不高于2%的 Creator 标记为
“批量低迁移”，供前向验证和后续过滤研究。

Dashboard 分栏显示当前数据库全部发行历史与 Smart Wallet 抽样历史，并显示独立 Mint、
独立 Creator 和未来 Smart OPEN 5秒/15秒标签。当前数据库统计不是全链永久历史；缺失于
本地保留窗口的发币不会凭空补齐，因此不得把 CAF-OBS 直接晋升为实盘。接口为
`GET /api/creator-affinity-shadow`，策略代码为 `CAF-OBS`。

## CYA Completed-Slot Public Flow Shadow CSF

CSF 是独立于已停用 CYA Early Pyramid K 的前向实验。历史样本显示目标钱包的早期
OPEN 并不是靠“等待它买入”获得优势：多数发射后5秒内的买入，在目标交易同一 Slot
之前没有可见公共买单，但前一个完整 Slot 已经出现分散买家与正净流入。因此 CSF
只在新的 Solana Slot 第一笔非监控钱包成交到达时，使用已经完成的上一 Slot 和最近
5秒公共订单流作判定。目标钱包及所有监控 Smart Wallet 的成交从因果特征中排除；
目标钱包之后的首次 OPEN 仅作为5/15秒监督标签，ADD 永久忽略。

入场组分别保留0–3秒对照、3–5秒、5–10秒与 Creator 未卖的严格组：
`CSF_C03`、`CSF_E35`、`CSF_E510`、`CSF_S310`。每个信号等待200ms后的下一笔
Bonding Curve 成交，并按1 SOL与同笔虚拟储备计算可执行均价和自身冲击。管理组
交叉测试20秒无加仓对照，以及达到+50%/+60%后且最近1秒公共流仍延续时的小额阶梯
加仓与120秒右尾；目标钱包本身的加仓不构成任何确认。

仓位写入独立表 `cya_slot_flow_shadow_positions`，接口为
`GET /api/cya-slot-flow-shadow`，Dashboard 编号为 `CSF-C03/E35/E510/S310`。
所有退出继续使用容量感知报价和全局 Pre-entry RUG Guard；直接 RUG 或储备枯竭不会
用图表价伪造成小亏。该路径每个 Mint 最多保留256笔、5秒的内存队列，不增加 RPC、
不扫描历史数据库、不读取私钥，也永不签名或发送链上交易。

## CYA Organic Burst Shadow COB

`COB` 是由目标钱包 `CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o`
的历史首次 OPEN 反推后重新前向验证的独立公共流实验。入场不读取该钱包或任何监控
Smart Wallet 的成交；目标钱包之后的首次 OPEN 只保存为未来5秒标签。原 `COB-A/B/C`
宽松组保留历史数据和活动仓位恢复，但停止新增。新的 `COB-D/F` 只接受发射后2–10秒、
最近5秒至少10名独立买家、净流入至少5/7 SOL、买单占比70%–95%、最近2秒涨幅0%–40%，
且相对15秒峰值已健康回撤至少2%的公共流。两组对同一 Mint 互斥：净流入达到7 SOL时
优先计入F，否则5–7 SOL计入D，避免重复开仓和重复统计。

每个信号等待200ms后的下一笔非监控钱包 Bonding Curve 成交，按1 SOL与同笔储备计算
真实容量、成交均价和自身冲击。`COB-D/F` 保留固定30秒基准，并独立测试三种新退出：
5秒保护后的2/3资金衰减、`+30%` 激活且峰值回撤 `10%`、以及 `+20%` 卖25%后
75%阶梯Runner。INV10/FIX20及原来的多重交叉只用于旧 `COB-A/B/C` 历史与活动仓位管理。仓位写入独立表
`cya_organic_burst_shadow_positions`，接口为 `GET /api/cya-organic-burst-shadow`，
Dashboard 编号为 `COB-D/F`。`COB-F:CORE25_R75_X120` 的实盘定义和历史记录
继续保留，但 `COB-F-C25-R75-X120` 已停止新开仓；若仍有活动实盘仓位，原25% Core、
75% Runner与120秒兜底规则仍负责退出。Shadow继续按1 SOL独立统计。
COB Dashboard 与专项导出的收益口径会把 `CLOSED`、`NO_EXIT`、`NO_ENTRY` 和
`PRICE_JUMP` 分开：原始平均收益、胜率和 PF 只描述有真实退出价的样本，同时显示
入场覆盖率、退出价覆盖率，以及将未取得退出价的已入场样本分别按 `-30%`、`-50%`、
`-80%` 计入后的 S30/S50/S80 压力平均收益。系统不会修改旧仓位，也不会把
`NO_EXIT` 写成伪造的链上亏损。
新增 `COB-F-LR01` 前向执行对照：它与 `COB-F` 使用同一公共流信号，但只建立
`CORE25_R75_X120` 一条独立 Shadow，按已停实盘的 `0.1 SOL`、200ms延迟、
1.5秒时效、15%最大追价与10%最大自身冲击模拟。原 `COB-F` 仍按1 SOL统计，
两者不混合、不改写历史，且 LR01 永不发出实盘信号。Dashboard 还会按“已定价退出
不少于200笔、退出覆盖率≥90%、NO_EXIT≤5%、S30>0、PF>1.2”显示是否达到
实盘晋级门槛；任一不满足都会列出阻断原因。
该路径每个 Mint 最多保留256笔、15秒有界队列，复用
现有 Universal RUG Guard，不增加 RPC，不签名，也不发送交易。

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

`FO_F2_J2_3S` 是基于34小时样本新增的前向验证组：复用旧 F2 信号（NetFlow≥20 SOL、Creator≤10%），但把200ms模拟成交相对参考价的最大跳价收紧为2%，并固定持有3秒。旧 F2 仍保留10%跳价上限，两者使用独立 cohort，专门验证“低追价”是否能把去除头部赢家后的期望转正。

模拟入场使用参考点后200ms的首个 Bonding Curve 价格，2秒内无成交记为 `NO_ENTRY`，入场跳价超过10%记为 `PRICE_JUMP`；退出触发后同样加入200ms执行延迟和5秒超时。新样本收益扣除默认1 SOL仓位对应的完整确定性成本模型。所有样本只写入 `launch_pullback_shadow_positions`，接口为 `GET /api/launch-pullback-shadow`；该路径没有执行器、不读取私钥，永不签名或发送交易。

## Migration Continuity Shadow M

Shadow M 把迁移后前5秒质量延续作为独立入场：`Buyers≥20、NetFlow≥5 SOL、价格涨幅≥5%、Sell/Buy≤0.6`，信号后200ms使用下一笔真实 PumpSwap 成交模拟入场。每个 Mint 只评估一次；所有毕业 Mint 最多订阅10秒，只有活动仓位继续保留订阅，避免为长持仓组合无边界消耗 Helius。

## Observed Holder Growth Shadow N

Shadow N 复用 Launch Quality Observer 已有的10/20/30/60秒因果快照，不增加链上订阅或额外 RPC 请求。这里的“Holder”严格指当前 gRPC 成交流中已经观察到的独立买家及前20名买家的留存，不是 RPC 拉取的全量链上 Holder 数。

- `HG10_OPEN`：10秒早期开放组，Buyers≥5、5–10秒新增买家≥3、留存≥30%、NetFlow≥1.5 SOL、Top3≤90%。
- `HG10_FLOW10_J2` / `HG10_FLOW15_J2`：保留10秒早期结构，但分别要求 NetFlow≥10/15 SOL，并只接受信号后200ms真实成交跳价在0%～2%的前瞻样本。
- `HG20_BAL`：20秒早期均衡组，Buyers≥8、10–20秒新增买家≥5、留存≥40%、NetFlow≥3 SOL、Top3≤85%。
- `HG20_FAST`：20秒早期加速组，Buyers≥10、10–20秒新增买家≥8、留存≥50%、NetFlow≥5 SOL、Top3≤80%。
- `HG20_QUALITY_J2`：20秒质量组，Buyers≥40、留存≥60%、NetFlow≥5 SOL、Top3≤80%，并只接受0%～2%的入场跳价。
- `HG30_BAL × X15_FIXED`：保留原条件和原 cohort ID，作为固定15秒控制组；旧5秒组、Strong A/B/C 和完整历史矩阵停止新增，但历史结果不删除。
- `HG30_NQ_A_R75_C40_75`：留存≥75%、Curve 40%–75%，固定持有15秒。
- `HG30_NQ_B_R80_C45_70`：留存≥80%、Curve 45%–70%，固定持有15秒。
- `HG30_NQ_C_POST_PEAK`：在 NQ-A 上增加“峰值后买入 SOL≥卖出 SOL”，独立测试固定12/15/18秒。

新组都使用30秒因果快照，并在快照后200ms的首笔 Bonding Curve 成交模拟入场。Curve 上限采用排他边界，峰值后资金流只读取快照时已经发生的交易；新 cohort ID 与历史行完全隔离，不重算旧数据。

阶梯组会随着峰值从20%/40%/80%/150%/300%等档位逐步放宽允许回撤，以争取保留大赢家；但实际止损价使用 `max(旧止损价, 新档位候选止损价)`，只能上移、绝不因切换到更宽档位而下移。Dashboard 同时比较平均/中位净收益、去Top5收益、PF、大赢家兑现率与MFE兑现率，避免只靠胜率或单个极端赢家判断。

该策略只写入独立表 `holder_growth_shadow_positions`，默认按1 SOL仓位扣除确定性成本；分批减仓组额外扣除一次链上执行的固定成本。仓位在毕业前触发退出但尚未取得成交时会自动改到 PumpSwap 等待下一笔真实成交。退出观察窗口默认30秒；窗口内仍没有可定价成交时保留 `NO_EXIT`，但不再把它直接当作已经确认的 `-100%`。Dashboard 的主收益、胜率和 PF 只统计真正取得出场价格的 `CLOSED`，同时单列 `NO_EXIT` 数量、比例以及把它们全部视为归零的“最坏均值”。不会修改现有实盘策略，也不会签名或发送交易。

历史 `NO_EXIT` 可以使用原始逐笔成交重新定价。先运行 `npm run reprice:holder-growth -- --db=/path/to/flow-research.db` 做只读预演；确认结果后追加 `--apply`。脚本会在卖出目标时间后30秒内寻找同生命周期市场的首笔合理成交，能够恢复的记录改为 `CLOSED` 并写入真实模拟出场价；其余记录保留为未定价 `NO_EXIT`。每次应用都会写入 `holder_growth_no_exit_recovery_audit` 审计表，不删除原始成交、不执行 WAL checkpoint。只有数据库或 COS 归档仍保留相应时间段 `raw_trades` 的记录才能恢复。

专项导出使用 `npm run export:holder-growth -- --db=... --out=...`。它会实际复制 Shadow N 仓位、相关 Mint、Launch Quality 观察/快照及每笔仓位信号前5秒至退出后至少30秒的原始成交，并逐表核对源行数与导出行数；不执行 WAL checkpoint，也不重启采集服务。

同一入场并行建立六个独立退出 cohort：固定60秒、固定120秒、5秒保护后`+10%激活/峰值回撤10%`、10秒保护后`+15%激活/峰值回撤12.5%`、10秒保护后的3秒订单流转弱，以及最长300秒的分层自适应尾仓。全部组合使用1 SOL成本模型、200ms退出延迟和独立表 `migration_continuity_shadow_positions`；历史策略和实盘规则都不变，该路径永不签名或发送交易。

## Quality Leader Shadow QL

QL 是基于非重叠历史日样本筛选出的两阶段强势质量实验，不修改任何旧 Shadow 或实盘策略。它复用 Launch Quality Observer 已有的 10 秒与 20 秒快照，不增加 Helius 订阅或 RPC 请求：10 秒涨幅至少 140%，到 20 秒时从峰值回撤不超过 12%，10→20 秒独立买家增加至少 8、净流入增加至少 3 SOL；同时要求 Creator 占比不超过 3%、Curve 55%–90%、卖/买笔数比不超过 0.55、virtual SOL reserves 至少 30。

每个命中建立三组完全独立的前瞻仓位：`QL_STRICT:QL_BARBELL`（Retention≥80%，+20% 卖 33%、+100% 再卖 17%、剩余 50% 跑长尾）、`QL_STRICT:QL_PROTECTED`（Retention≥80%，不分批、全仓跑长尾）以及 `QL_BROAD:QL_BARBELL`（Retention≥60%的宽松样本）。三组在 +20% 前都使用 -20% 硬止损；30 秒仍未达到 +20% 则退出；达到强度后按峰值区间逐级保护，最长持有 5 分钟。分批组按实际额外执行次数扣除固定链上成本。

入场使用信号后 200ms 的首笔 Bonding Curve 成交，并按 1 SOL 对虚拟储备的冲击计算平均成交价。迁移后的 PumpSwap 价格以最后 Curve 价格作边界锚定，避免跨市场价格尺度制造虚假大赢家。所有记录仅写入独立表 `quality_leader_shadow_positions`，接口为 `GET /api/quality-leader-shadow`；该路径没有执行器、不会读取私钥，也不会签名或发送交易。

`QL_STRICT:QL_PROTECTED` 另有独立实盘提升策略 `quality_leader_ql_strict_protected_live`。它只在 Strict + Protected 的200ms可执行入场通过跳价检查后发出一次实盘信号，不会因 Barbell/Protected 两条 Shadow 记录重复下单；Shadow QL 仍按原三组继续写入。实盘默认0.1 SOL，并额外拒绝1 SOL Shadow 模拟成交冲击超过12%的低流动性样本；市场跳价上限收紧到10%。卖出不分批：+20%前硬止损20%，30秒未达到+20%退出；走强后按峰值20/50/100/200%分层保护，最长5分钟，并可跨毕业阶段卖出当前全部链上余额。

## PumpSwap Range Scalper Shadow J

Shadow J 对每个新毕业 Mint 先订阅 PumpSwap 成交120秒，用滚动60秒成交构建因果区间状态：成交笔数、SOL成交量、独立钱包、买卖占比、振幅、价格路径效率、均值穿越次数、最大钱包集中度和短期趋势。只有高成交量、低趋势、持续来回穿越均值的市场才延长订阅，最长20分钟；区间连续失效30秒且没有活动仓位时自动退订，避免无边界增加 Helius 消耗。

每个合格区间保留原三组入场：`JA` 为偏离中轴1σ后反弹2%，`JB` 为偏离1.5σ且最近1秒净流入转正，`JC` 为下轨反弹并要求新买家与卖压衰减。每次价格回到中轴后重新武装，因此同一 Mint 可产生多个独立 Episode。新增 `JW_X6` 不改变旧组：它复用 JB 条件，第1次机会只预热，仅在同一 Mint 的第2/3次机会模拟入场，并只测试固定+6%退出（8%硬止损、20秒兜底）。机会序号会从 JB 历史恢复，服务重启不会把第2波误判成第1波。全部组合扣除默认1 SOL仓位的确定性成本；该策略只有 Shadow 路径、独立表与 Dashboard 页面，永不签名或发送链上交易。

## CYA Early Pyramid Shadow K

Shadow K 已由大样本证明为负期望，默认停止产生新仓位，历史数据仍完整保留。只有显式设置 `FLOW_PROVEN_NEGATIVE_SHADOWS_ENABLED=true` 且同时开启 K 自身开关时才会复现旧实验。Smart Pullback A/B、Smart-Like Early、Smart Resonance 与 Holder Growth 也已默认停止新开仓；原始成交、标签和历史策略行不会因此删除。

K 原实验把钱包分析结论转成独立的公开订单流实验，不读取目标钱包动作作为信号。`K5_30` 测试 AGE 5–30秒、Curve 20–60%的较严格窗口；`K3_30` 放宽到 AGE 3–30秒。两组都限制5秒买家数、净流入和2秒涨幅，避免在订单流已经拥挤时追入。信号后使用200ms后的真实 Bonding Curve 成交模拟入场。

初始仓位默认1 SOL。价格每继续上涨15%且订单流仍未拥挤时，按初始仓位的1/12模拟加仓，最多6次；+50%和+100%分别减仓，剩余尾仓独立测试峰值回撤20%和30%。未出现强度时25秒退出，未减仓前硬止损30%，最长持有3分钟。每笔仓位单独记录累计投入、加仓/减仓次数及多次执行产生的估算费用，接口为 `GET /api/cya-early-pyramid-shadow`；该路径没有执行器、不读取私钥，永不签名或发送链上交易。

从本版本开始，`FLOW_SHADOW_DEFAULT_POSITION_SOL=1` 是所有 Shadow 的公共仓位默认值。为了让旧服务器直接升级生效，策略专属 `*_POSITION_SOL=0.05` 会被识别为历史默认并继承新的1 SOL公共值；其它自定义数值仍是显式覆盖项。若确实要让全部 Shadow 回到0.05 SOL，应把公共默认本身设为0.05。历史记录不会重算或混入新策略，实盘仓位配置也不受影响。

## Lifecycle Drop/Rebound Shadow G

Forward-only optimization cohorts preserve every historical G cohort unchanged. For the
post-migration `GD25_35` entry only, `XB50` keeps 50% in the existing XLEG exit and holds
50% to a fixed 8-second runner; `XB25` keeps 25% in XLEG and 75% in the runner. Their
weighted return includes the additional simulated sell transaction cost. Four independent
risk cohorts (`XR3_H12`, `XR3_H15`, `XR4_H12`, `XR4_H15`) combine a 3/4-second weak-state
check with a -12%/-15% hard stop. A weak-state exit requires the position to remain below
entry and recover no more than 1% from its running low, so an active rebound is not cut only
because the clock expired. These cohorts are Shadow-only and never alter the live XLEG rule.

Launch First Pullback also adds two forward-only high-flow cohorts without changing F2 or
FT-C history: `F2_8S_NF30` uses the existing F2 reference and fixed 8-second exit, while
`FT_C_NF30` uses the existing FT-C right-tail exit. Both require reference NetFlow >= 30 SOL
and store results under new cohort IDs.

Three additional forward-only causal-quality cohorts preserve every existing F/FT/FD/FO/NF30
definition and row. `F_ABSORB3_8S` requires the F2 reference, at least 3 SOL of sell pressure
since the running peak and buy refill of at least 50% of that pressure, then holds for 8 seconds.
`F_ABSORB5_RUNNER` raises the sell-pressure threshold to 5 SOL and uses the existing FT-C
right-tail exit (+30% activation, 20% peak drawdown, -30% hard stop, 120-second maximum).
`F_REACCEL0_8S` requires current one-second net flow and its change from the previous second
to both be non-negative, then holds for 8 seconds. The signal-time evidence is frozen in
`launch_pullback_shadow_positions`; none of these cohorts signs or sends a transaction.

Each new Launch pullback row also records an observational 30-minute market-breadth snapshot:
independent first-Primary mints, average 5-second net return, 5-second win rate and the share
returning at least 20%. Only already-settled signals older than the configured lag contribute.
These fields are labels for later segmentation and never participate in entry qualification.

The 2026-08-15 forward screen adds three isolated deep-pullback quality cohorts without
changing `FO_D12_R3_10S`. `FO_D12_R3_Q_10S` requires the D12.5/R3 reference, NetFlow
between 15 and 50 SOL, first-20 buyer retention at least 70%, Top3 share below 50%, and
Creator share at most 5%, then holds for 10 seconds. `FO_D12_R3_QC_10S` tightens only the
Creator ceiling to 3%. `FO_D12_R3_Q_T10_H30` reuses Q entry and independently tests +20%
activation, 10% peak drawdown, -20% hard stop and a 30-second maximum. All three use new
cohort IDs, the 1 SOL cost model and 200ms causal fills; none signs or sends a transaction.

Range Scalper J is behind the proven-negative override and therefore stops creating new
positions by default while all historical rows remain queryable. Holder Growth N also stops
all new entries by default after the forward quality cohorts remained negative; its complete
history, including `HG30_BAL × X15_FIXED`, remains queryable.

The retained forward-only quality definitions are `HG30_NQ_A_R75_C40_75`
requires retention >=75% and Curve 40-75%; `HG30_NQ_B_R80_C45_70` requires retention >=80%
and Curve 45-70%. Both use the fixed 15-second exit. `HG30_NQ_C_POST_PEAK` adds the causal
requirement that buy SOL since the observed peak is at least sell SOL since that peak, and
independently tests fixed 12/15/18-second exits. These filters were positive after the 1 SOL
cost model in two non-overlapping 24-hour windows. Entry profiles explicitly list their exit
IDs, so historical cohorts remain isolated. Intentionally resuming N requires
`FLOW_HOLDER_GROWTH_SHADOW_ENABLED=true`; the full historical matrix additionally requires
`FLOW_HOLDER_GROWTH_FULL_MATRIX_ENABLED=true`.


Shadow G 先按生命周期分成两个完全独立的研究层：`PRE_MIGRATION` 只用毕业前 `PUMP_BONDING_CURVE` 成交触发信号和入场，AGE 从 Token 创建时间计算；`POST_MIGRATION` 只用毕业后的 `PUMP_AMM` 成交触发信号和入场，AGE 从毕业时间计算。两层拥有独立检测状态、Episode 与 cohort，统计时不会把两种市场结构混在一起。此前已经积累的毕业后记录会通过数据库默认值保留为 `POST_MIGRATION`。

完整的毕业前 Curve 成交本来就持续写入 `raw_trades`；新毕业 Mint 另外默认持续订阅5分钟 PumpSwap 并保存逐笔成交。因此样本积累后可以分别离线穷举窗口、跌幅、反弹幅度和确认时限。毕业前建立的模拟仓位如果跨过毕业时点，可以继续使用迁移后的 PumpSwap 成交退出，但不会把该仓位改记成毕业后入场。

两个生命周期层都使用同一组可比参数。基准入场为“1秒滚动高点下跌15%–35%，随后从运行低点反弹2%–5%，且反弹在候选开始后1秒内出现”。同一跌势只触发一次，必须先恢复到未达到15%跌幅才会重新武装。每层同时跑八个正交入场组：0.5/1/2秒窗口、15%–25%与25%–35%跌幅分层、2%与3%反弹下限、0.5/1/2秒反弹时限；每组只改变一个核心变量。

新增前向组 `GE30_DUMP5_NB2_M2 × G_DUMP_NB_X8` 不再要求先看到低点反弹：仅在毕业后30秒内，由单笔至少5 SOL的真实卖单造成1秒滚动跌幅15%～55%时武装，随后2秒内出现的下一笔真实买单作为因果确认；信号后仍等待200ms真实 PumpSwap 成交模拟1 SOL入场，并固定持有8秒。每个 Mint 最多记录两次顺序机会，同一 profile 的上一仓未结束时不会重叠开仓。毕业 Mint 会继续轻量观察30分钟，以保留后续路径标签，但30分钟观察不会放宽该组30秒入场门槛。生命周期分层 RUG Guard 只冻结为 `preEntryUniversalRugGuard` 对照标签，不阻止本组入场、不查询额外 RPC，也不增加买入路径延迟。

旧矩阵保持原 ID 与规则不变。毕业后专用前向 profile `GE30_R23_F1` 与 `GE30_R23_F3` 继续积累原样数据。另增完全独立的 `GE30_D25_32_R24_F1`：只取毕业后30秒内、1秒跌25%～32%、低点反弹2%～4%的首次机会，并要求200ms模拟成交相对信号价上跳不超过3%。`GE30_D25_32_R24_F1_04_24` 只在北京时间04:00～24:00生成独立 Shadow 样本，并同时按0.1/0.5/1 SOL容量模型记录；它不接入实盘。新 ID 不回填、不覆盖旧 cohort。

新 V2 入场除继续与 X3、X8、XLEG 对照外，还独立测试 `V2_R2_H10/H15`（2秒弱势确认、10%/15%硬止损）和 `V2_B75_H20/H60`（25%按XLEG退出，75% runner固定持有20/60秒）。`GE30_D25_32_R24_F1_EXEC1` 继续保留0.1/1 SOL容量 Shadow 对照；原来由0.1 SOL的 `V2_R2_H15` 行发出的 `G-V2-EXEC01-R2-H15` 实盘信号，自2026-09-01起只记录禁用决策，不再下买单。`GE30_R23_F2_ONLY` 另增 `G2_XLEG_H20_FWD`，将20%硬止损作为独立前向 Shadow 持续记录，不回填离线回测结果。模拟入场和退出均使用200ms执行延迟后的对应市场真实成交，新样本收益扣除确定性成本；MFE、MAE和实际入场跳价一并保存。兼容接口仍为 `GET /api/migrated-drop-rebound-shadow`。

2026-08-16 起新增的 G 组优化全部使用新 ID，不回填旧数据。`GE30_R23_F1_EXEC` 对同一首次机会并行模拟 0.05/0.1/0.25/0.5/1 SOL，利用已经随 PumpSwap 成交保存的真实储备计算各仓位买入和卖出的 AMM 曲线平均成交价与自身冲击；它不增加 RPC/API 请求。`GE30_R23_F2_ONLY` 只记录同 Mint 第二次独立跌落反弹，`GE30_R23_F1_NIGHT/DAY` 分别冻结北京时间18:00–08:00和08:00–18:00样本，避免事后切时段。2026-08-18 又增加 `GE30_R23_F3_EXEC` 与 `GE30_R23_F2_ONLY_EXEC`，在不改变原 F3/F2 记录的前提下，分别对前三次机会和第二次机会按0.05/0.1/0.25 SOL做容量感知的XLEG对照。

同一 F1 入场还新增三类独立退出：`G1_E2_H6/G1_E2_H8/G1_E3_H8` 对照2/3秒弱势检查与6%/8%硬止损；`G1_B75_H30/G1_B50_H60` 让75%/50%核心按XLEG退出、其余尾仓持有30/60秒，并在整体跌15%时强制清仓；`G1_STAIR_H60/H120` 在峰值达到20%/40%/80%后分别使用8%/12%/18%回撤，测试更长时间捕获大赢家。容量、时段、入场序号和退出方式均编码进 cohort，不会混入 `GE30_R23_F1/F3` 历史。

## Flow-First Shadow C

`Flow-First Shadow C` 直接消费 Signal Monitor 对应的 `primary_3w` 主信号，不等待 Smart Wallet。它按数据库中的 `signal_episode_id` 去重：同一 Mint、同一30秒信号周期内即使 Rank 连续增长，也只建立一次模拟入场；原始信号行和 Future Label 仍全部保存，不会因去重而丢失。

三个C组共享完全相同的信号、200ms执行延迟和延迟后的首个 Bonding Curve 模拟成交，唯一差异是退出方式：

- C5：从实际模拟入场开始固定持有5秒，再等待200ms后的首个可退出成交。
- C7.5：入场即激活移动止盈，峰值回撤7.5%退出，60秒兜底。
- C12.5：入场即激活移动止盈，峰值回撤12.5%退出，60秒兜底。

模拟仓位保存在 `flow_first_shadow_positions`，接口为 `GET /api/flow-first-shadow`。Dashboard 按独立 Episode/Mint 显示扣除默认1 SOL完整成本模型后的平均与中位净收益、胜率、PF、实际入场跳价、MFE、最大赢家、Top5盈利贡献、去掉Top5后的平均收益以及大赢家兑现率。该路径没有执行器、不读取私钥，也永不签名或发送链上交易。

## 多策略实盘框架

当前仅 `O-C80-D5-B2-S0-NC` 允许产生新实盘仓位，单笔为 `0.1 SOL`；对应
Shadow 仍保持 `1 SOL`，且实盘入场统一经过内存态跨 Mint RUG Guard。
`O-C80-HO500-X60-R` 已停止新开仓，但 HO0 / HO200 / HO500 Shadow 恢复组继续采样。
`COB-F-C25-R75-X120` 与 `COB-D-T30-D10-X60` 已停止新开仓，但保留历史展示、
存量仓位退出和各自1 SOL Shadow研究。
`PBR-A-X50-15` 与 `GFR-300-HS20-H30` 已于 2026-08-22 在代码层
锁死新开仓；旧服务器 `.env` 无法误开启，但历史记录和存量仓位退出继续保留。
`G-V2-EXEC01-R2-H15` 已于 2026-09-01 同样在代码层锁死新开仓；对应
`V2_R2_H15` Shadow 容量对照继续记录。
其余旧实盘定义同样只用于历史展示与存量退出：

```text
COB-F-C25-R75-X120 / cya_organic_burst_cob_f_core25_runner_live（停止新开仓）
发射后2–10秒、Buyers5≥10、NetFlow5≥7 SOL、买入占比70%–95%
→ 最近2秒涨幅0%–40%、距15秒峰值回撤≥2% → Bonding Curve买入0.1 SOL
→ +20%卖25% Core；75% Runner按峰值20/50/100%启用15/20/25%回撤；120秒退出
→ 同信号Shadow继续按1 SOL运行 CORE25_R75_X120 及其他独立退出对照

COB-D-T30-D10-X60 / cya_organic_burst_cob_d_fix30_live（停止新开仓；ID兼容历史）
发射后2–10秒、Buyers5≥10、NetFlow5≥5 SOL、买入占比70%–95%
→ 最近2秒涨幅0%–40%、距15秒峰值回撤≥2% → Bonding Curve买入0.1 SOL
→ 买入后前2秒内达到+10%立即全额止盈
→ 否则按-20%硬止损；+30%激活移动止盈、峰值回撤10%退出；60秒强制退出
→ 同信号Shadow仍按1 SOL交叉测试 FIX30 / FlowFade / T30-D10 / 25-75 Runner

M-C5-E120 / migration_continuity_mc_c5_e120_live（停止新开仓）
毕业后5秒 Buyers≥20、净流入≥5 SOL、涨幅≥5%、Sell/Buy≤0.6
→ PumpSwap买入0.1 SOL → 20%硬止损或固定120秒卖出

QL-STRICT-PR / quality_leader_ql_strict_protected_live
10秒涨幅≥140%、20秒回撤≤12%、Retention≥80%，且买家/净流入继续增长
→ 1 SOL Shadow冲击≤12%，市场跳价≤10% → Bonding Curve买入0.1 SOL
→ 不分批的阶梯保护Runner，30秒未走强退出、5分钟兜底

F-FO-RB10-X30 / launch_pullback_fo_rb10_30s_live（停止新开仓）
首轮回踩参考，Creator≤5%、最近买家≥10、NetFlow≥5 SOL
→ 只在 FO_RB10_30S 的200ms模拟入场真正成立时发出一次实盘信号
→ Bonding Curve买入0.1 SOL → 无固定止盈/移动止盈/硬止损，固定30秒退出
→ 启动历史回放只恢复 Shadow 状态，永不补发实盘订单

GD25-35-F1-XLEG / post_gd25_35_f1_xleg_live_v1（停止新开仓）
毕业后120秒内，1秒跌25%–35%，低点1秒内反弹2%–5%
→ 每Mint只消费首次合格机会 → PumpSwap买入0.1 SOL
→ 5秒内+18%快速止盈；否则+8%激活、峰值回撤3%；6秒仍亏损退出；15秒兜底

O-C80-D5-B2-S0-NC / graduation_accel_o_c80_d5_b2_s0_nc_live（开启）
Curve≥80%、最近5秒ΔCurve≥5、Buyers5≥2、0卖单、Creator未卖
→ Bonding Curve买入0.1 SOL；对应 Graduation Acceleration Shadow O 继续按1 SOL独立观察
→ 实盘暂保留30%硬止损；新增 H15 / H20 独立 Shadow 对照。历史回放显示完全取消止损
会把快速 RUG 尾部重新放大到 -80%~-100%，因此不直接修改实盘退出。

M-C5-T12.5 / migration_continuity_mc_c5_t12_5_live（停止新开仓）
Migration Continuity MC_C5 历史定义 → PumpSwap买入0.5 SOL
→ 10秒保护，+15%激活、峰值回撤12.5%，最长3分钟

O90-M5-STAIR120 / graduation_accel_o90_m5_stair120_live（停止新开仓）
Curve90毕业概率入场 → Bonding Curve买入0.1 SOL
→ 首次PumpSwap 5秒门控，50%核心退出，剩余仓位按阶梯移动止盈
```

M/O 及 GD25 的 Shadow 记录仍照常生成，实盘决策另行写入 `live_strategy_decisions`，仓位和订单保存各自 `strategy_id`，不会混入原 Shadow 统计。M 与 GD25 F1 的实盘定义继续加载，以便历史展示和存量仓位退出，但 `entryEnabled` 在代码中固定为 `false`，旧服务器 `.env` 无法意外重新开启。Dashboard 左侧列表与右侧详情统一显示策略编号，方便按编号核对实盘和 Shadow 样本。

执行模块有三种模式：

- `DISABLED`：全局安全锁模式，不签名；各实盘策略的独立 `entryEnabled=false` 还会进一步阻止其产生新仓。
- `DRY_RUN`：只有先显式解除 `FLOW_LIVE_TRADING_SAFETY_LOCK`，再设置 `FLOW_LIVE_TRADING_ENABLED=true` 并保留 `FLOW_LIVE_DRY_RUN=true` 才能启用。
- `LIVE`：除解除安全锁外，还需设置 `FLOW_LIVE_DRY_RUN=false`、`FLOW_RPC_URL`、`FLOW_LIVE_PRIVATE_KEY`，并显式填写至少一个启用策略的 `POSITION_SOL`。O-C80 使用其独 V3 仓位变量（0.1 SOL）；O90 的仓位变量只供历史兼容和存量退出。

`FLOW_LIVE_TRADING_SAFETY_LOCK` 默认为 `true`，优先级高于旧服务器 `.env` 中的 `FLOW_LIVE_TRADING_ENABLED=true`。因此升级并重启后，旧配置不会意外恢复签名或链上发单；Dashboard 会明确显示安全锁已开启。

O-C80 使用 Bonding Curve 固定 SOL 输入；O90 与 M-C5-T12.5 仅保留历史和存量退出。滑点只降低最少可接受 Token 数，不允许超额花费。程序默认最多同时持有10个实盘仓位（`FLOW_LIVE_MAX_POSITIONS`），同一 Mint 最多持有3个独立仓位批次（`FLOW_LIVE_MAX_CONCURRENT_POSITIONS_PER_MINT`），并继续保留钱包 SOL 余额和信号新鲜度保护。每个仓位按自己实际买到的 Token 数量退出，避免同 Mint 的某个策略卖掉其他策略仓位。买卖滑点分别由 `FLOW_LIVE_BUY_SLIPPAGE_PCT`（默认10%）与 `FLOW_LIVE_SELL_SLIPPAGE_PCT`（默认15%）控制；买卖总优先费目标由 `FLOW_LIVE_PRIORITY_FEE_SOL` 控制，默认每笔 `0.0005 SOL`。

实盘硬止损同时检查边际价格与数据流携带的储备状态。只要按整仓代币计算的可执行回收额先跌破硬止损，系统就以 `EXECUTABLE_HARD_STOP` 退出；Bonding Curve 报价还会受真实 SOL 储备上限约束。紧急退出遇到滑点或旧报价失败后按 `FLOW_LIVE_EMERGENCY_EXIT_RETRY_DELAY_MS`（默认100ms）刷新状态重试，不增加买入路径的 RPC 或延迟。

已停止策略的存量仓位继续沿用各自原退出规则。O90/O-C80 在毕业后首笔可执行 PumpSwap 行情卖出50%核心仓位，剩余50%按 `+20/40/80/150/300%` 对应 `10/15/20/25/30%` 峰值回撤退出；毕业前后保留兜底与30%硬止损。最终卖出失败会按配置重试并保留 `EXIT_FAILED`，防止同 Mint 再开仓；紧急开关和单策略停开都只阻止新开仓，不阻止存量退出。

买入交易如果已经获得签名，程序会区分“链上明确失败”和“RPC确认状态未知”。链上明确失败直接记录为 `ENTRY_FAILED`，不会尝试卖出；状态未知时同时查询签名历史、确认交易的 `pre/postTokenBalances` 和交易钱包的Token余额。即使Token-2022 ATA尚未被RPC账户索引，只要交易回执显示钱包实际收到Token，也会按真实raw数量恢复仓位。单次余额为0或账户暂不可见只保持 `ENTRY_CONFIRMATION_UNKNOWN`，不会再误写 `ENTRY_CONFIRMED_EMPTY`，也不会盲目发送卖出。若签名明确因区块高度过期，并且等待 `FLOW_LIVE_EXPIRED_ENTRY_RELEASE_MS`（默认10分钟）后签名历史、交易回执与Token收款仍全部不可见，程序才会将其标记为 `ENTRY_EXPIRED_UNOBSERVED` 并释放并发槽；其余任何歧义状态继续保留等待人工/重启复核。服务重启时也会自动重新核对未知仓位，以及旧版本曾误关的 `ENTRY_CONFIRMED_EMPTY` 仓位；恢复成功且已超过持仓兜底时间时会立即进入正常卖出流程。

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

### 每日 07:00 自动导出最近 24 小时并上传腾讯 COS

每日归档不再调用 `better-sqlite3 backup()` 复制整个历史库，也不会执行任何 WAL checkpoint。`scripts/export-research-window.js` 会在一个一致性读事务内只查询源库，把最近 24 小时数据直接写入小型归档库；历史元数据表完整保留，源服务无需停止或重启。导出包包含 SQLite、schema、时间边界与逐表行数、服务状态、最近日志和版本信息，并在上传前执行 `quick_check`、tar 完整性检查及 SHA-256。

先安装腾讯官方 COSCLI，然后安装标准 timer：

```bash
sudo bash deploy/install-daily-export.sh /opt/flow-acceleration
sudoedit /etc/flow-acceleration/backup-cos.env
```

主安装程序现在默认使用 `INSTALL_DAILY_EXPORT=auto`：检测到 COSCLI 后会自动安装每日 timer；没有 COSCLI 时只提示安装方法，不会创建一个必然失败的任务。也可以用 `INSTALL_DAILY_EXPORT=1` 强制要求安装，或用 `INSTALL_DAILY_EXPORT=0` 明确关闭：

```bash
INSTALL_DAILY_EXPORT=1 sudo -E bash deploy/install.sh /opt/flow-acceleration
```

安装器会分别检查 `/etc/flow-acceleration/backup-cos.env` 与项目 `.env`。优先使用完整的 root 私有配置；若 `/etc` 仍是空模板而项目 `.env` 已有完整的 `FLOW_BACKUP_COS_*` 配置，则直接沿用项目 `.env`，空模板不会覆盖有效凭据。两处都不完整时只安装 unit 文件但不启用 Timer，修好配置后重新运行安装器即可。

如果程序不在示例目录，请把安装命令的最后一个参数替换为服务器上的实际项目路径，例如 `/path/to/Flow-Acceleration`。不要在公开文档中记录真实服务器目录。

服务器凭据文件由服务用户持有、权限为 `0600`，只在服务器填写，绝不能提交。请在服务器私有配置中填写以下占位项：

- Bucket：`<your-cos-bucket>`
- Region：`<your-cos-region>`
- Endpoint：`<your-cos-endpoint>`
- COS 路径：`<private-backup-prefix>/YYYY/MM/DD/`
- 本地保留：2 天（COS 远端验证成功后清理更旧的本地归档）

填写 `FLOW_BACKUP_COS_SECRET_ID` 与 `FLOW_BACKUP_COS_SECRET_KEY` 后，先手动验证一次，再查看下一次计划时间：

```bash
sudo systemctl start flow-acceleration-backup.service
sudo journalctl -u flow-acceleration-backup.service -n 100 --no-pager
systemctl list-timers flow-acceleration-backup.timer --all
```

Timer 使用显式 `Asia/Shanghai` 时区，每天北京时间 07:00 运行，即使服务器位于其他时区也不会按当地时间偏移。`flock` 会阻止任务重叠；成功后还会写入按北京时间日期命名的完成标记，同一天再次误触发时直接退出，不会重新导出或上传。只有确需人工覆盖当天归档时才可临时设置 `FLOW_BACKUP_FORCE_RUN=1`。导出进程使用低 CPU/IO 优先级。COSCLI 配置在运行时写入私有临时文件并在结束时删除，SecretId/SecretKey 不进入压缩包和命令行参数。永久密钥应遵循最小权限原则，只授予私有 Bucket 前缀所需的上传和查询权限。

远端验证通过后，每日导出任务直接进入 `DONE`，不会再从外部进程清理在线 SQLite 主库。`scripts/cleanup-research-retention.js` 仅保留为停服维护工具；必须在明确停止实时服务后手动执行。这样可避免大型 `DELETE` 持有写锁时，主服务恰好重启并因 `SQLITE_BUSY` 陷入崩溃循环。维护过程仍禁止 `wal_checkpoint` 或 `VACUUM`；已有大型数据库如需真正缩小，应另安排停服离线重建，不能在实时服务上直接压缩。

为避免大库维护长时间停机，同一份已验证 COS 归档在 24 小时内只允许完成一轮清理，且单轮硬上限为 5,000,000 行；即使传入更大的 `--max-rows` 也不会突破该上限。`--dry-run` 不覆盖最近一次正式维护记录。只有在明确批准的故障恢复场景下才能使用 `--force` 绕过同归档保护。System Health 会显示最近维护时间、实际删除行数和 SQLite 可复用空间。

安装程序会删除旧版本遗留的 `cos-auto-upload-export.sh`、`export-last10h.sh` 或 `export-last24h-cos.sh` cron 项，防止旧任务每6小时重复上传过期文件；其它 cron 项不会受影响。导出、上传和验证均有独立超时与失败保护，最近一次状态写入 `data/exports/last-run.env`（`EXPORTING`、`UPLOADING`、`VERIFYING`、`DONE` 或 `FAILED`），COSCLI 卡住时不会无限占用下一次任务。

部分服务器曾由 OpenClaw 临时创建 `flow-daily-export.service/timer`，其中某些旧 service 与主采集服务绑定并带有自动重启，可能在主服务重启时反复导出。标准安装器只会在 `flow-acceleration-backup.timer` 已通过校验并成功启用后，立即停止并禁用旧 service 与 timer。正式备份 service 不依赖 `flow-acceleration.service` 的生命周期，主服务重启不会再次触发导出；配置不完整时旧调度保持不变，避免迁移过程造成备份空窗。

## 前向组合 Shadow（2026-08-17）

以下组合只对部署后的新数据生效，使用全新 cohort ID，不回填、不改写旧策略历史，也没有签名或发送交易的路径：

- `FC_BASE_X12` / `FC_STRICT_NF20_X12`：Launch 首次回踩必须得到参考点之前 5 秒内已经存在的 Flow 信号确认（`BuyersW3 >= 3`），固定持有 12 秒。严格组另要求 Launch NetFlow `>= 20 SOL`。
- `FC_BASE_STAIR60`：相同 FC 入场，测试 `+20%/10%`、`+40%/15%`、`+80%/20%` 的阶梯移动止盈，最长 60 秒。
- `FC_BASE_WEAK3_X12` / `FC_BASE_WEAK5_X12`：相同 FC 入场，分别在 3 秒 MFE `<5%`、5 秒 MFE `<10%` 时提前退出，最长 12 秒。
- `GE30_D25_32_R23_F1_FAST200 + GQ_XLEG`：毕业后 30 秒内，1 秒跌 25%～32%，从低点 200ms 内反弹 2%～3%，每 Mint 只取首次机会；分别模拟 0.05、0.25、0.5、1 SOL 容量冲击。
- `GFR_300/GFR_600/GFR_1000`：旧 G 组之外的快速反转延续研究。急跌首次反弹后分别等待 300/600/1000ms，只在价格继续上涨、独立 Buyers 与净流入增加、后半窗资金流不衰减、Sell/Buy 与 Top1 集中度受控、Creator 未卖且 0.05/0.1 SOL 往返 AMM 冲击不超过门槛时模拟入场；每组独立测试固定 8 秒、固定 15 秒及 20% 硬止损/最长 30 秒。确认快照和具体拒绝原因写入新 cohort，不改变旧 G 历史。
- `O90_M5_X60` / `O90_M5_X120` / `O90_M5_STAIR120`：首次 Curve `>=90%` 且 5 秒推进 `>=5%`、买家 `>=1`、卖单 `<=1`、Creator 未卖。毕业时退出 50% Core；只有首个 PumpSwap 5 秒买家 `>=25` 且净流入非负才保留 Runner，再分别测试固定 60 秒、固定 120 秒与阶梯 120 秒。
- `O90_Q70_D30_X60` / `O90_Q70_D30_STAIR120`：全新、仅向前的强质量组；首次 Curve `>=90%` 时同时要求 5 秒独立买家 `>=3`、净流入 `>=70 SOL`、Curve 推进 `>=30%`。分别测试固定 60 秒和阶梯 120 秒，均使用 1 SOL 容量感知退出，不接实盘。
- `O90_DAY0818_STAIR120` / `O_C80_DAY1218_STAIR240` / `O_C80_NIGHT0004_STAIR240` / `O_C80_EVENING2024_STAIR240`：不叠加强质量阈值，只把旧 O90/O-C80 入场规则限制在指定北京时段，用于检验时段效果能否向前复现；同样不接实盘。
- `O_C75_D5_B2_S0_NC_EARLY` / `O_C78_D5_B2_S0_NC_EARLY`：保留 O-C80 的5秒资金流、买家、零卖单和 Creator 未卖条件，只把首次 Curve 阈值提前到75%/78%，用于检验能否减少“提交前已经毕业”而不显著增加 RUG；全新 cohort、1 SOL Shadow，不接实盘。
- `O_C80_M5_HANDOFF_X60`：Curve80 信号只作为迁移观察起点，不在 Bonding Curve 模拟买入。毕业后观察首个 PumpSwap 5秒，要求独立买家 `>=5`、净流非负、Sell/Buy `<=0.7`、窗口回撤 `<=20%`，并在模拟成交时限制市场涨价 `<=15%` 与1 SOL自身冲击 `<=10%`，合格后固定持有60秒；该跨市场衔接仍是 Shadow-only。
- `O_C80_LIVE_MIG_X20` / `O_C80_LIVE_MIG_X30`：仅在真实 O-C80 实盘订单因 `ENTRY_MIGRATED_BEFORE_SUBMIT` 被安全拒绝后建立独立 Shadow。不会强行追买已毕业币；先等待至少3笔真实 PumpSwap 成交、2笔买入、2个独立买家、净流入与卖压/大卖单约束，再按1 SOL池容量模拟成交，分别固定持有20秒和30秒。普通 `ENTRY_REJECTED` 不进入该组，既有实盘规则、价格跳变保护及成功订单路径均不改变。

FC 的 Flow 证据使用“信号时间不晚于回踩参考时间”的因果约束，未来信号不能反向使历史参考点合格。O90→M5 的 PumpSwap 门槛只决定毕业后的 Runner，失败时不会把未成交或不可定价样本伪记为盈利。

Live Trading Dashboard 将入场未成交流程拆为三类：`提交前已毕业`（没有签名、没有花费 SOL）、`提交前保护拒绝`（追价、余额或自身冲击保护）以及`真实入场失败`（已经进入交易执行/确认阶段）。历史通用 `ENTRY_REJECTED` 仍归入提交前保护；升级后的新记录会进一步写明 `ENTRY_PRICE_JUMP` 与 `ENTRY_WALLET_RESERVE_REJECTED`，不再把速度错失混同为链上失败。

## M2F-OBS 迁移后二段资金扩散观察器（2026-08-19）

`M2F-OBS` 是独立的观察型 Shadow，不创建模拟仓位，也没有签名、RPC
补数或链上发送路径。它在每次毕业/迁移后继续订阅最多 480 秒的现有
PumpSwap 数据流，以真实成交驱动 1 秒快照，记录首波价格、首次回撤、
反弹、3/10/前20秒资金流、买家扩散、单钱包集中度、买速变化和可观测
钱包留存。每日 07:00 导出会自动包含两张独立表：

- `migration_second_leg_observations`
- `migration_second_leg_snapshots`

更新后的 PumpSwap 事件已经能直接提供 pool quote reserve 与 virtual quote
reserve；M2F 会据此保存有效 Quote Reserve、0.05/0.1/0.25 SOL 的恒定乘积
容量冲击，并在本地校验 canonical pool，不增加 RPC。10 秒资金流也会保存为
`Gross-NFI10` 临时值，但它尚未剔除 BOOST、洗量和关联实体，因此不会冒充
文章定义的 organic ONFI10。`canBoost` 与成交 cashback 只作为事件提示保存。

目前仍不能可靠证明的精确 BOOST 交易分类、Mayhem 权威标记及实体/资金/
机器人聚类字段，会明确保存为 `UNKNOWN` 或 `UNAVAILABLE`。历史快照不会
伪造回填；上述新增字段只从升级后真实收到的 PumpSwap 成交开始生效。积累
至少 3～5 天后再根据这些观察数据决定是否建立正式的交易型 Shadow cohort。

为避免大型历史库冷启动阻塞，`M2F-OBS` 启动时不回放历史 AMM 成交：
上次进程中断的 `OBSERVING` 记录会标记为 `RIGHT_CENSORED`，新一轮只从
当前进程真实收到的毕业事件开始记录，保证数据因果完整且不增加启动扫描。

### M2F 二段资金扩散 Research Matrix（2026-08-21，已停止新仓）

该交易型 Shadow matrix 在负向前向样本后已停止产生新模拟仓位；
历史表和 Dashboard 保留。独立 `M2F-OBS` 仍继续采集因果快照，
不建立仓位、不请求额外 RPC、不签名或发送交易。

### LPS 迁移后稳定化延迟矩阵（2026-08-27）

旧 `M2F-*` 交易型分组继续停止新仓，历史结果不改写。新的 `LPS-*` 分组只
复用 `M2F-OBS` 已采集的最长 8 分钟 PumpSwap 因果快照，不增加 RPC：

- 主组 `LPS-D150-X30/X60/X120`：迁移后约 150 秒入场，分别固定持有
  30/60/120 秒；
- 对照 `LPS-D180-X30`、`LPS-D240-X30`、`LPS-D300-X30`：延迟至
  180/240/300 秒入场，统一固定持有 30 秒。

所有分组要求最近 10 秒买家不少于 7、净流不低于 8 SOL、Top1 买家占比不高于
50%、净流仍在加速、观测延迟不超过 3 秒，并以 1 SOL 容量冲击模拟成交。
入场仍须通过共享 RUG Guard；结果继续写入独立
`migration_second_leg_shadow_positions` 表，永不进入实盘或签名发链。
旧 `M2F-*` 交易型分组的历史信号要求迁移后 60～240 秒、当前相对迁移价 `+10%～+150%`、首波峰值至少
`+25%`、距峰回撤 `5%～15%` 且低点反弹至少 `3%`；同时要求 3/10 秒净流、
独立买家、买速、资金加速、卖压衰减、买家留存和 1 SOL 容量冲击共同合格。

通过信号后等待 200ms 的下一笔真实 PumpSwap 成交，再以 1 SOL 恒定乘积容量
模拟入场；填单时必须通过共享的 `Pre-entry RUG Guard`。控制组固定 10 秒退出
并保留 15% mark-price 硬止损；新增 `M2F-HOLD-120/240`，对同一模拟入场只
延长退出窗口，另设 `M2F-HOLD-240-H20` 观察 20% mark 止损；
`M2F-CF2-H10` 要求连续两次快照的 3 秒净流和 10 秒买家不衰减、卖压不恶化，
再使用原 10 秒退出。

这些分组分别保存 cohort 编号，不覆盖原 B 组历史；只复用现有 PumpSwap
成交流，不增加 RPC，也不会转入任何实盘策略或下单路径。退出继续以真实储备
估计容量冲击、费用和 RUG 场景；相邻 PumpSwap 价格若发生超过100倍的尺度跳变，
会标记为 `DATA_ERROR`，不再污染 MFE/PnL。所有结果写入独立表
`migration_second_leg_shadow_positions`，永不签名或发链。

新增卖压恢复研究组 `M2F-SSR-*`：先出现迁移后首波上涨和 10%～30% 回撤，
再要求卖压衰减、公共净流重新转强和独立买家继续进入。`M2F-SSR-CTRL-X60`
是不看市场状态的对照组；其余 SSR 组仅在跨 Mint 市场标签为 `GREEN` 时模拟
入场，并独立比较 60/120/240 秒退出。市场标签只统计最近 10 分钟已经成熟的
独立 Mint，包括正收益比例、正净流比例、RUG 崩塌率和 1 SOL 中位容量冲击。

市场状态过滤严格限定为 **Shadow-only**：`LiveTradingManager` 不导入、不读取
该标签，当前 O-C80 实盘策略的入场、仓位和退出不受影响。
另新增的 Curve80
持续确认、G 组 1 SOL 可执行容量筛选，以及 MC 30 秒订单流自适应 60/180 秒
持仓，也都使用新的 cohort 编号，不与旧历史混合，不存在实盘桥接。

## SDBR 同 Slot 大砸单回补观察（2026-08-20）

`SDBR` 是独立的 Same-Slot Dump Backrun Shadow，只跟踪毕业后最初15分钟的
PumpSwap 成交。默认对照 `Sell≥10 SOL/跌幅≥15%` 与
`Sell≥20 SOL/跌幅≥20%` 两组，按砸单事件的真实 post-trade reserves 计算
0.1 SOL 理论即时买入容量，再分别测试250ms、500ms、1秒、2秒固定退出以及
`+8%或2秒`退出。

该测试同时保存第一笔非砸单钱包 BUY 的 Slot 与到达延迟，因此会把“信号本身
有收益”和“没有 Leader 基础设施是否来得及成交”分开统计。它不签名、不发链、
不增加 RPC；热路径只做有界内存判断，SQLite 写入延迟到维护周期批量完成。
全局 Pre-entry RUG Guard 与0.1 SOL买卖储备冲击都会计入，`NO_EXIT` 单独右删失，
不会伪造为 -100%。结果保存在独立表
`same_slot_dump_backrun_shadow_positions`，不会混入或更改任何旧策略数据。

## FEA-OBS V2 信号特征有效性审计与 FEA-BNH-120（2026-08-30）

`FEA-OBS V2` 把已有公开链上信号拆成资金流、参与者过热、买卖平衡、价格结构
与可执行容量五类特征。`W1/W2/W3` 仍按三个相邻独立窗口计算资金流加速；历史
数据已经否定“参与者越多越好”，因此参与者扩散现在是过热惩罚项，而不是正向
加分项。每个符合最低公共样本门槛的信号只记录一次 5/30/120/300 秒前向观察。

标签只允许在同一市场连续计算：Bonding Curve 进入 PumpSwap 后不会把两个不同
价格尺度直接相除。跨市场、缺少及时退出报价或观察中断均单独右删失，不会伪造
为 -100%，也不会污染收益。新版数据写入
`feature_edge_audit_observations_v2`；旧表 `feature_edge_audit_observations`
只保留历史，不再参与新版统计。Dashboard 的主审计窗口固定为 120 秒，并展示
完成率、删失率、报价覆盖率和跨市场删失率，避免用 300 秒幸存样本挑选结论。

`FEA-BNH-120` 是唯一由审计结果派生的独立 Shadow：要求资金流继续加速、买卖
平衡成立、参与者未过热、AGE 30～120 秒、Curve 60%～90%，在同一 Bonding Curve 市场模拟
1 SOL 入场并固定持有 120 秒，计入 3.2% 往返成本。没有同市场退出容量记为
`NO_EXIT`。它写入 `feature_edge_audit_bnh_shadow_positions`，不与旧策略混表，
不签名、不发链、不读取私钥，也不增加 RPC。

进入实盘的最低审计门槛为：至少两个独立 24 小时窗口、可定价完成样本不少于
1,000、PF≥1.3、中位收益>0、RUG50≤12%。FEA 总分本身只用于审计，不直接触发
实盘交易。

## PM-SURV 迁移后分层存活观察（2026-08-27）

`PM-SURV` 用于回答“是否值得把毕业后观察窗口从 300 秒延长到 30～60 分钟”。
它先请求观察所有新迁移 Mint 5 分钟；仍有双向成交、独立买家、价格结构和
1 SOL 可执行容量的 Mint 才进入 30 分钟层，30 分钟再次通过资金流、活跃度、
回撤恢复和容量门槛后，才进入最长 60 分钟层。硬 RUG、容量坍塌、长期无成交
或低分样本会尽早从本观察器的请求集合移除。

为防止筛选规则只是在历史样本上看起来有效，确定性的 10% 退订样本会继续
作为审计对照，单独统计退订后是否出现**可执行** `Big50/Big100/Big200`，从而
估算大赢家漏检率。成交方向在入口统一兼容 `BUY/SELL` 与小写格式，避免回放
数据被错误统计为零买卖；极端向上价格会先隔离确认，向下价格仍立即生效，
不会掩盖 RUG。Dashboard 同时展示各层活跃数、退订原因、5/30/60 分钟收益、
标记与可执行 MFE/MAE、1 SOL 可执行回收率。实际 gRPC 订阅仍是所有模块请求 Mint 的并集；
如果其他策略仍在跟踪同一 Mint，本观察器退订不会强制终止其他策略的数据。

通过 5 分钟门槛后，该模块会在下一笔真实 PumpSwap 成交上，以 1 SOL 储备容量
模拟独立的 30/60/120 秒固定持有 Shadow。每组都要求可执行买入和可执行卖出，
计入 3.2% 往返成本，缺少卖出容量记为 `NO_EXIT`，不会用标记价格假设成交。
这些 Shadow 使用独立表，不进入实盘管理器。

该模块只保存迁移、阶段门槛、里程碑和稀疏 Shadow 结果，不保存长期逐笔流水；
每个 Mint 的内存事件有固定上限。它不建立实盘仓位、不增加 RPC、不读取私钥，
也不会签名或发送交易，因此不会改变当前实盘策略。
