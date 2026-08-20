Warning: truncated output (original token count: 6700)
Total output lines: 350

# Pump.fun Flow Acceleration Research + Multi-Strategy Executor

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

The same exit hypothesis is tested without changing entry rules in two other promising
families. Smart-Like Early adds BASE-only `FIX60_H20` / `FIX120_H20` exits (no pyramiding,
partial profit, flow-decay exit, or trailing stop). Launch First Pullback adds
`F2_NF30_H20_60S`, `F2_NF30_H20_120S`, `FO_RB10_H20_60S`, and
`FO_RB10_H20_120S`. These four cohorts apply a -20% hard stop before their fixed horizon.
They reuse existing streams and references, add no Helius subscriptions or RPC calls, and
never sign or send transactions. Proven-negative entry families remain disabled.

这是一个同时采集 Pump.fun 毕业前 Bonding Curve 与所需毕业后 PumpSwap 成交的研究项目，并带有默认关闭、按策略隔离的实盘执行模块。研究主线验证：

> 短时间内净买入资金、独立买家数量和买入成交速度同时加速时，未来数秒是否存在扣除真实成本后仍可交易的价格惯性。

全量 Raw Trade、Flow Signals、Future Labels 和 Smart Wallet 事件始终继续采集。当前仅 `QL-STRICT-PR` 允许产生新实盘仓位；`F-FO-RB10-X30` 与其余实盘定义只保留历史展示和存量退出。实盘规则不使用 Smart Wallet 跟单、RSI、EMA、MACD、社交数据、KOL 或 AI 评分；全局默认 `DISABLED`，不会读取私钥或提交交易。

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

**毕业加速 · O** 是全新的前向 Shadow，不修改 I 组。主组在 Token 第10秒检查 `Curve≥80%、Buyers≥20、SellSol/BuySol≤0.7`；补充组只…700 tokens truncated…按 Token 余额保存 `OPEN / ADD / REDUCE / CLOSE / SELL` 生命周期。真实 OPEN 会写入 `smart_signal_confirmations`，记录最近 30 秒 Primary 信号、确认延迟与开仓 SOL；这些仍是离线监督标签，不会用未来信息反推更早的 Flow Signal 买点。Dashboard 原来的“Signal 重合率”已改为明确的 OPEN / ADD 时间窗口覆盖率，避免把连续加仓误读成重复信号。

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

## Shadow 可执行价格与 Pre-entry RUG Guard

关键 Shadow 新样本同时区分“图表价格路径”和“仓位可执行路径”。QL、Migration
Continuity、Launch Pullback、Smart Resonance，以及容量感知 G/Big Winner 分组会从
Bonding Curve 或 PumpSwap 的同笔池储备估算实际买卖均价；`net_return_pct` 使用仓位
规模对应的退出价并扣成本。直接 RUG 且缺少可执行退出储备时，保守记为无法回收，
避免出现 Shadow 只亏 20%、实盘却亏 80% 的系统性高估。

`PreEntryRugRiskTracker` 仅消费现有公共成交，不增加 RPC。它在入场前15秒记录买入
占比、最大连续买单、买卖方向交替率、上涨成交比例与短时涨幅。原策略组完全不变；
新增 `QL_STRICT_GUARD`、`GD25_35_RUG_GUARD_*`、`SR_R3_GUARD` 独立前向组，便于
直接比较过滤前后胜率、RUG率、可执行净收益和交易频率。

升级前已经关闭的历史 Shadow 行仍保留其原始价格口径，不会被后台静默改写。由于
旧行未必保存当时完整池储备，不能可靠重算真实可卖回的 SOL；研究时应把新增 GUARD
组及升级后的前向样本作为可执行口径，不要与旧的 mark-price 历史均值直接合并。

## Public Flow Lead Shadow PFL

`public_flow_lead_shadow_positions` 把 Smart Wallet 改为纯离线监督标签：入场只读取
非监控钱包的公开 Bonding Curve 成交，不等待任何 Smart Wallet 交易，也不使用
Smart Wallet 的成交金额或价格。后续首次 `OPEN` 只记录为5秒/15秒命中标签；所有
`ADD` 明确忽略，既不触发入场，也不构成确认。

PFL 已默认停止产生新样本，历史行仍完整保留。最后的前向组 `PFL-B2` 使用：
AGE 8–12秒、Curve 60%–75%、最近1秒买家9–12、最近5秒买家至少45、
5秒公共买入26–35 SOL、最大单一买家不超过15%、5秒涨幅10%–25%，且资金加速
比处于1–2.5。每次信号统一等待200ms后的下一笔
同市场成交；同 Mint/同组30秒内只模拟一次。退出交叉测试20%/30%硬止损与
120/180/240秒固定持有，不设固定止盈或移动止盈，以观察 Big50/Big100 右尾。
Dashboard 同时显示未来 Smart OPEN 5秒/15秒覆盖率、PF、Top5利润贡献和
MFE/MAE。接口为 `GET /api/public-flow-lead-shadow`，新策略代码为 `PFL-B2`。
只有同时设置 `FLOW_PROVEN_NEGATIVE_SHADOWS_ENABLED=true` 与
`FLOW_PUBLIC_FLOW_LEAD_SHADOW_ENABLED=true` 才会有意恢复；旧四组还需额外设置
`FLOW_PUBLIC_FLOW_LEAD_LEGACY_PROFILES_ENABLED=true`。

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