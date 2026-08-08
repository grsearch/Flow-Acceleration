# Pump.fun Flow Acceleration Research V1

这是一个严格限定在 **Pump.fun Bonding Curve（毕业前）** 的研究项目。它只验证一个假设：

> 短时间内净买入资金、独立买家数量和买入成交速度同时加速时，未来数秒是否存在扣除真实成本后仍可交易的价格惯性。

V1 不加载钱包私钥，不提交 BUY/SELL，不使用 RSI、EMA、MACD、社交数据、Holder 变化、KOL、AI 评分或聪明钱包跟单。

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

- `raw_trades`：毕业前逐笔成交，以及仅用于完成标签的毕业后 PumpSwap 成交。
- `flow_signals`：三个窗口的买卖流、净流入、独立买家、买单数、绝对增量和 ratio。
- `signal_returns`：1/2/3/5/8/10/15/20/30/60 秒 Raw Return、确定性成本后的 Net Return、每个 horizon 的观测 lag、`COMPLETE/RIGHT_CENSORED` 标签状态，以及 5/10/30 秒 MFE/MAE。某个 horizon 后首笔成交超过 `FLOW_LABEL_MAX_OBSERVATION_LAG_MS`，或 MFE/MAE 时间窗没有完整观测覆盖时，不会用旧价格或 0% 补值。
- `smart_wallet_events`：两个研究钱包的成交、Curve、AGE、最近 Flow Signal 与时间差。
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

五个页面：

1. **Overview**：今日 Raw Trades、活跃 Token、Candidate、Flow Signal、Smart Wallet 事件。
2. **Signal Monitor**：Symbol、CA、AGE、Curve、三窗口 NetFlow、Buyers、Buy TX 与未来收益。
3. **Backtest**：选择 Hold Time、Execution Delay，并拆分平台费、滑点、价格冲击、优先费、Jito 小费和失败成本。
4. **Smart Wallet**：两地址的交易次数、买入币种、持仓、Curve、AGE 与 Signal 重合率。
5. **System Health**：数据流、解析量、Buffer、标签、数据库写入和错误。

## 回测

Dashboard 可直接运行常用组合。命令行支持更细的成本拆分：

```bash
pnpm run backtest -- \
  --hold-ms=5000 \
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
  --exit-delay-ms=200 \
  --exit-retry-count=1 \
  --exit-retry-delay-ms=500 \
  --split-ratio=0.7 \
  --bootstrap-samples=500 \
  --signal-variant=primary_3w \
  --first-signal-only=false \
  --signal-cooldown-ms=30000 \
  --max-curve-pct=60 \
  --max-buy-tx-w3=3 \
  --max-buyers-w3=3 \
  --max-net-w3=3 \
  --min-net-w3=1 \
  --min-accel=1.2
```

Dashboard、命令行回测和批量分析默认使用 200ms 买入延迟及 200ms 卖出延迟。`exit-delay-ms=0` 只代表理想化成交价格；结果会返回 `IDEALIZED_ZERO_DELAY_EXIT` 警告，不能作为可执行策略结论。

每 Mint 首信号与冷却只在回测选择阶段应用，不会从采集库删除原始信号。`first-signal-only` 保留分析窗口内每个 Mint 的首个合格信号；`signal-cooldown-ms` 按上一个已接受信号执行状态化冷却。

程序并行保存三个研究版本：

- `primary_3w`：现有三窗口 Flow Acceleration 主信号。
- `shadow_2w`：仅使用最近两个窗口的提前确认信号。
- `shadow_netflow_breakout`：不要求加速度 ratio 的净流入突破影子信号。

影子信号只用于 Future Label 和回测研究，不会触发链上交易；Signal Monitor 和 Smart Wallet 重合默认仍以 `primary_3w` 为准。

入场只接受 `Signal Time + Execution Delay` 之后、入场等待上限以内且毕业之前的 Bonding Curve 成交，绝不会用 PumpSwap 反推买入。持仓时间从实际模拟入场开始计算；出场可使用 Bonding Curve 或毕业后的 PumpSwap 成交。没有入场、毕业前未成交、没有出场、历史数据缺口和数据右删失会分别统计，不再静默丢弃。没有出场的已入场样本默认按 `-100%` 再扣确定性成本。

平台费、双边滑点、价格冲击和固定链上费用构成成功成交的确定性成本。Future Label 只扣除这些确定性成本，不再把随机执行失败混入市场收益标签。买入失败表示没有建仓，只损失失败尝试成本；卖出失败使用 `exit-retry-count`、重试间隔和失败费用沿真实逐笔价格路径重新执行。若正常策略本身为负，买入失败可能在数学上改善每信号收益，因此输出同时提供条件于已执行交易的收益并给出警告，不能把它误读成策略改善。

止盈、止损和移动止损按逐笔路径判断谁先触发；触发以后再应用卖出延迟与失败重试。默认这些动态条件为关闭，保持固定持仓回测兼容。`Actual Delay` 已改名为 `Observed Entry Gap`，它是信号到下一笔可观察市场成交的间隔，不代表机器人真实上链延迟。

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
