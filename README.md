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
- `signal_returns`：1/2/3/5/8/10/15/20/30/60 秒 Raw Return、默认成本后的 Net Return，以及 5/10/30 秒 MFE/MAE。
- `smart_wallet_events`：两个研究钱包的成交、Curve、AGE、最近 Flow Signal 与时间差。
- `flow_tokens`：创建时间、毕业时间、Bonding Curve、迁移池和 Curve 进度所需状态。

SQLite 使用 WAL 和批量写入。超过 `FLOW_RAW_RETENTION_HOURS` 的 Raw Trade 会先压缩为 `data/archive/*.ndjson.gz`，成功写入归档后才从热库删除；Signals 与 Future Labels 不删除。

## 运行

需要 Node.js 22+。`better-sqlite3` 直接使用包内自带的 Windows/Linux 预编译文件，不需要额外安装 C++ 编译工具链。

Yellowstone gRPC v5 当前随包提供 Linux/macOS 原生客户端，实时采集请部署到 Linux（本项目已提供 systemd 模板）或在 Windows 上使用 WSL2。原生 Windows 可运行解析测试、SQLite、历史回测和 Dashboard，但不能直接连接实时流。

```bash
pnpm install
cp .env.example .env
# 填写 FLOW_GRPC_TOKEN；端点默认使用新加坡官方 LaserStream 区域
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
  --failure-rate-pct=2 \
  --failure-loss-pct=1 \
  --min-net-w3=1 \
  --min-accel=1.2
```

入场只接受 `Signal Time + Execution Delay` 之后、入场等待上限以内且毕业之前的 Bonding Curve 成交，绝不会用 PumpSwap 反推买入。持仓时间从实际模拟入场开始计算；出场可使用 Bonding Curve 或毕业后的 PumpSwap 成交。没有入场、毕业前未成交、没有出场、历史数据缺口和数据右删失会分别统计，不再静默丢弃。没有出场的已入场样本默认按 `-100%` 再扣确定性成本。

平台费、双边滑点、价格冲击和固定链上费用构成成功成交的确定性成本；失败率会把每个已完成样本拆成成功/失败两个加权结果，并真实影响胜率、收益中位数、Profit Factor 与 Expectancy。Future Label 与回测保存并使用同一套成本模型。

## 部署

`deploy/flow-acceleration.service` 提供 systemd 模板。服务重启后会继续使用同一个 SQLite 数据库；最近 120 秒内尚未完成的 Signal Labels 会恢复跟踪。

Helius LaserStream 端点必须使用 HTTP(S) URI。配置中省略协议时程序会自动补成 `https://`。推荐使用离服务器最近的官方区域端点，例如：

```text
https://laserstream-mainnet-ewr.helius-rpc.com
https://laserstream-mainnet-tyo.helius-rpc.com
https://laserstream-mainnet-sgp.helius-rpc.com
```

Linux 一键安装会保留已有 `.env`、检查服务用户、Node.js 22+ 与 pnpm，生成缺失的 `.env`，校验 systemd 单元并设置开机自启：

```bash
sudo bash deploy/install.sh /opt/flow-acceleration
sudo nano /opt/flow-acceleration/.env
sudo systemctl restart flow-acceleration
sudo systemctl --no-pager --full status flow-acceleration
```

也可以在已经配置好 `.env` 时使用 `START_SERVICE=1 sudo -E bash deploy/install.sh`，让安装脚本完成后立即启动并显示服务状态。
