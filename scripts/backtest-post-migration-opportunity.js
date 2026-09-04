'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { config } = require('../src/config');
const { PreEntryRugRiskTracker } = require('../src/core/PreEntryRugRiskTracker');
const {
  LIVE_CURVE_HARD_BLOCK_SIGNATURES,
  RUG_GUARD_ENFORCEMENT,
} = require('../src/core/RugGuardPolicy');

const DEFAULT_DB = path.resolve(process.env.FLOW_DB_PATH || './data/flow-research.db');
const ROUND_TRIP_COST_PCT = Number(
  config.labels?.configuredTradingCostPct ?? 2.5,
);

const ENTRY_PROFILES = Object.freeze([
  {
    id: 'MOM-EARLY', label: '毕业后早期延续',
    minAgeMs: 5_000, maxAgeMs: 45_000,
    minCurrentImpulsePct: 0, maxCurrentImpulsePct: 200,
    minPeakImpulsePct: 5, minPullbackPct: 0, maxPullbackPct: 12,
    minReboundPct: 0, maxReboundPct: 100,
    minNetFlow10sSol: 1, minNetFlow3sSol: 0,
    minBuyers10s: 4, minBuyers3s: 1, maxLargestBuyerSharePct: 60,
  },
  {
    id: 'PB-LIGHT', label: '首次浅回调反弹',
    minAgeMs: 10_000, maxAgeMs: 90_000,
    minCurrentImpulsePct: -15, maxCurrentImpulsePct: 250,
    minPeakImpulsePct: 10, minPullbackPct: 5, maxPullbackPct: 25,
    minReboundPct: 2, maxReboundPct: 20,
    minNetFlow10sSol: 0, minNetFlow3sSol: 0,
    minBuyers10s: 4, minBuyers3s: 1, maxLargestBuyerSharePct: 60,
  },
  {
    id: 'PB-STRONG', label: '首次深回调强反弹',
    minAgeMs: 10_000, maxAgeMs: 120_000,
    minCurrentImpulsePct: -20, maxCurrentImpulsePct: 300,
    minPeakImpulsePct: 20, minPullbackPct: 10, maxPullbackPct: 35,
    minReboundPct: 3, maxReboundPct: 20,
    minNetFlow10sSol: 0, minNetFlow3sSol: 0.25,
    minBuyers10s: 5, minBuyers3s: 1, maxLargestBuyerSharePct: 55,
  },
  {
    id: 'FLOW-CONT', label: '公开资金流延续',
    minAgeMs: 10_000, maxAgeMs: 120_000,
    minCurrentImpulsePct: -20, maxCurrentImpulsePct: 300,
    minPeakImpulsePct: 0, minPullbackPct: 0, maxPullbackPct: 35,
    minReboundPct: 0, maxReboundPct: 100,
    minNetFlow10sSol: 3, minNetFlow3sSol: 0.5,
    minBuyers10s: 6, minBuyers3s: 2, maxLargestBuyerSharePct: 50,
  },
]);

const EXIT_PROFILES = Object.freeze([
  { id: 'H15-A30-D15-X120', hardStopPct: 15, trailingActivationPct: 30, trailingStopPct: 15, maxHoldMs: 120_000 },
  { id: 'H20-A50-D20-X300', hardStopPct: 20, trailingActivationPct: 50, trailingStopPct: 20, maxHoldMs: 300_000 },
  { id: 'H20-A75-D25-X300', hardStopPct: 20, trailingActivationPct: 75, trailingStopPct: 25, maxHoldMs: 300_000 },
  { id: 'H25-A100-D30-X600', hardStopPct: 25, trailingActivationPct: 100, trailingStopPct: 30, maxHoldMs: 600_000 },
]);

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percent(count, total) {
  return total ? count / total * 100 : null;
}

function performance(values) {
  const returns = values.filter(Number.isFinite);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const profit = wins.reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    resolved: returns.length,
    winRatePct: percent(wins.length, returns.length),
    averageNetReturnPct: returns.length
      ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    medianNetReturnPct: median(returns),
    profitFactor: loss > 0 ? profit / loss : null,
    rug50RatePct: percent(returns.filter((value) => value <= -50).length, returns.length),
    rug80RatePct: percent(returns.filter((value) => value <= -80).length, returns.length),
    big50RatePct: percent(returns.filter((value) => value >= 50).length, returns.length),
    big100RatePct: percent(returns.filter((value) => value >= 100).length, returns.length),
    maximumWinnerPct: returns.length ? Math.max(...returns) : null,
  };
}

function tradeFromRow(row) {
  const market = String(row.market || '');
  return {
    id: row.id,
    timestampMs: Number(row.timestamp_ms),
    receivedAtMs: Number(row.received_at_ms),
    slot: row.slot,
    signature: row.signature,
    eventIndex: row.event_index,
    market,
    mint: row.mint,
    wallet: row.wallet || '',
    side: row.side,
    solAmount: finite(row.sol_amount, 0),
    tokenAmount: finite(row.token_amount, 0),
    price: finite(row.reserve_price) > 0
      ? finite(row.reserve_price) : finite(row.price),
    reservePrice: finite(row.reserve_price) > 0
      ? finite(row.reserve_price) : finite(row.price),
    curvePct: finite(row.curve_pct),
    virtualSolReservesRaw: row.virtual_sol_reserves_raw,
    virtualTokenReservesRaw: row.virtual_token_reserves_raw,
    realSolReservesRaw: row.real_sol_reserves_raw,
    realTokenReservesRaw: row.real_token_reserves_raw,
    // The portable raw schema predates dedicated PumpSwap reserve columns.
    // Do not invent them: this report is mark-price + configured-cost screening.
    poolBaseReservesRaw: null,
    poolQuoteReservesRaw: null,
    virtualQuoteReservesRaw: null,
  };
}

function windowStats(events, startAt, endAt) {
  let buySol = 0;
  let sellSol = 0;
  const buyers = new Map();
  for (const event of events) {
    if (event.timestampMs < startAt || event.timestampMs >= endAt) continue;
    if (event.side === 'BUY') {
      buySol += event.solAmount;
      if (event.solAmount >= 0.02 && event.wallet) {
        buyers.set(event.wallet, (buyers.get(event.wallet) || 0) + event.solAmount);
      }
    } else if (event.side === 'SELL') sellSol += event.solAmount;
  }
  const flows = [...buyers.values()].sort((left, right) => right - left);
  return {
    netFlow: buySol - sellSol,
    buyers: buyers.size,
    largestBuyerSharePct: buySol > 0 ? (flows[0] || 0) / buySol * 100 : null,
  };
}

function makeState(trade) {
  return {
    mint: trade.mint,
    migrationAt: trade.timestampMs,
    baselinePrice: trade.price,
    peakPrice: trade.price,
    lowPrice: trade.price,
    firstPullbackAt: null,
    events: [],
    triggered: new Set(),
  };
}

function snapshot(state, trade) {
  state.peakPrice = Math.max(state.peakPrice, trade.price);
  state.lowPrice = Math.min(state.lowPrice, trade.price);
  const pullbackPct = (1 - trade.price / state.peakPrice) * 100;
  if (!state.firstPullbackAt && pullbackPct >= 5) state.firstPullbackAt = trade.timestampMs;
  const floor = trade.timestampMs - 35_000;
  while (state.events.length && state.events[0].timestampMs < floor) state.events.shift();
  const current3 = windowStats(state.events, trade.timestampMs - 3_000, trade.timestampMs + 1);
  const current10 = windowStats(state.events, trade.timestampMs - 10_000, trade.timestampMs + 1);
  return {
    ageMs: trade.timestampMs - state.migrationAt,
    openingImpulsePct: (trade.price / state.baselinePrice - 1) * 100,
    peakImpulsePct: (state.peakPrice / state.baselinePrice - 1) * 100,
    pullbackPct,
    reboundPct: state.lowPrice > 0 ? (trade.price / state.lowPrice - 1) * 100 : 0,
    netFlow3s: current3.netFlow,
    netFlow10s: current10.netFlow,
    buyers3s: current3.buyers,
    buyers10s: current10.buyers,
    largestBuyerShare10sPct: current10.largestBuyerSharePct,
  };
}

function matches(candidate, profile) {
  return candidate.ageMs >= profile.minAgeMs && candidate.ageMs <= profile.maxAgeMs
    && candidate.openingImpulsePct >= profile.minCurrentImpulsePct
    && candidate.openingImpulsePct <= profile.maxCurrentImpulsePct
    && candidate.peakImpulsePct >= profile.minPeakImpulsePct
    && candidate.pullbackPct >= profile.minPullbackPct
    && candidate.pullbackPct <= profile.maxPullbackPct
    && candidate.reboundPct >= profile.minReboundPct
    && candidate.reboundPct <= profile.maxReboundPct
    && candidate.netFlow10s >= profile.minNetFlow10sSol
    && candidate.netFlow3s >= profile.minNetFlow3sSol
    && candidate.buyers10s >= profile.minBuyers10s
    && candidate.buyers3s >= profile.minBuyers3s
    && finite(candidate.largestBuyerShare10sPct, 100) <= profile.maxLargestBuyerSharePct;
}

function firstAtOrAfter(trades, targetAt, deadlineAt, startIndex = 0) {
  for (let index = startIndex; index < trades.length; index += 1) {
    const trade = trades[index];
    if (trade.timestampMs < targetAt) continue;
    if (trade.timestampMs > deadlineAt) return null;
    return { trade, index };
  }
  return null;
}

function simulateExit(trades, signal, exitProfile) {
  const entry = firstAtOrAfter(trades, signal.signalAt + 200, signal.signalAt + 2_200);
  if (!entry) return { status: 'NO_ENTRY', netReturnPct: null, exitReason: 'ENTRY_TIMEOUT' };
  const entryPrice = entry.trade.price;
  if (!(entryPrice > 0)) return { status: 'NO_ENTRY', netReturnPct: null, exitReason: 'ENTRY_PRICE' };
  const entryJumpPct = (entryPrice / signal.signalPrice - 1) * 100;
  if (entryJumpPct > 15 || entryJumpPct < -30) {
    return { status: 'PRICE_JUMP', netReturnPct: null, exitReason: 'ENTRY_PRICE_JUMP' };
  }
  let highestPrice = entryPrice;
  let triggerAt = null;
  let reason = null;
  const maxHoldAt = entry.trade.timestampMs + exitProfile.maxHoldMs;
  for (let index = entry.index; index < trades.length; index += 1) {
    const trade = trades[index];
    if (!(trade.price > 0)) continue;
    if (trade.price / highestPrice > 100 || highestPrice / trade.price > 100) {
      return { status: 'DATA_ERROR', netReturnPct: null, exitReason: 'PRICE_SCALE' };
    }
    highestPrice = Math.max(highestPrice, trade.price);
    const gross = (trade.price / entryPrice - 1) * 100;
    const highReturn = (highestPrice / entryPrice - 1) * 100;
    const drawdown = (1 - trade.price / highestPrice) * 100;
    if (!triggerAt && gross <= -exitProfile.hardStopPct) {
      triggerAt = trade.timestampMs;
      reason = 'HARD_STOP';
    } else if (!triggerAt && highReturn >= exitProfile.trailingActivationPct
      && drawdown >= exitProfile.trailingStopPct) {
      triggerAt = trade.timestampMs;
      reason = 'TRAILING_STOP';
    } else if (!triggerAt && trade.timestampMs >= maxHoldAt) {
      triggerAt = maxHoldAt;
      reason = 'MAX_HOLD';
    }
    if (!triggerAt) continue;
    if (trade.timestampMs < triggerAt + 200) continue;
    if (trade.timestampMs > triggerAt + 2_200) {
      return { status: 'NO_EXIT', netReturnPct: null, exitReason: reason };
    }
    return {
      status: 'CLOSED',
      netReturnPct: (trade.price / entryPrice - 1) * 100 - ROUND_TRIP_COST_PCT,
      grossReturnPct: (trade.price / entryPrice - 1) * 100,
      exitReason: reason,
      entryAt: entry.trade.timestampMs,
      exitAt: trade.timestampMs,
      maxFavorableReturnPct: highReturn,
    };
  }
  return { status: 'NO_EXIT', netReturnPct: null, exitReason: reason || 'NO_FUTURE_TRADE' };
}

function round(value) {
  return value == null || !Number.isFinite(Number(value))
    ? value : Math.round(Number(value) * 1000) / 1000;
}

function roundedPerformance(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, round(item)]));
}

function main() {
  const dbPath = path.resolve(process.argv[2] || process.env.FLOW_ANALYSIS_DB || DEFAULT_DB);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  const tracker = new PreEntryRugRiskTracker({
    config: { ...config.preEntryRugRisk, firstCliffCounterfactualEnabled: false },
    store: null,
  });
  const states = new Map();
  const ammTrades = new Map();
  const signals = [];
  const query = db.prepare(`
    SELECT id, timestamp_ms, received_at_ms, slot, signature, event_index,
      market, mint, wallet, side, sol_amount, token_amount, price,
      reserve_price, curve_pct, virtual_sol_reserves_raw,
      virtual_token_reserves_raw, real_sol_reserves_raw, real_token_reserves_raw
    FROM raw_trades
    ORDER BY timestamp_ms, id
  `);
  let rawTrades = 0;
  for (const row of query.iterate()) {
    const trade = tradeFromRow(row);
    if (!(trade.timestampMs > 0) || !(trade.price > 0)) continue;
    rawTrades += 1;
    tracker.observeTrade(trade);
    if (trade.market !== 'PUMP_AMM') continue;
    let trades = ammTrades.get(trade.mint);
    if (!trades) {
      trades = [];
      ammTrades.set(trade.mint, trades);
    }
    trades.push(trade);
    let state = states.get(trade.mint);
    if (!state) {
      state = makeState(trade);
      states.set(trade.mint, state);
    }
    state.events.push({
      timestampMs: trade.timestampMs,
      side: trade.side,
      solAmount: trade.solAmount,
      wallet: trade.wallet,
    });
    const candidate = snapshot(state, trade);
    for (const profile of ENTRY_PROFILES) {
      if (state.triggered.has(profile.id) || !matches(candidate, profile)) continue;
      state.triggered.add(profile.id);
      const guard = tracker.evaluateGuard({
        strategyId: `MIGRATION_SECOND_LEG:PMO:${profile.id}:RUGX`,
        mint: trade.mint,
        timestampMs: trade.timestampMs,
        source: 'SHADOW',
        market: 'PUMP_AMM',
        lifecycleStage: 'POST_MIGRATION',
        lifecycleAgeMs: candidate.ageMs,
        enforcementMode: RUG_GUARD_ENFORCEMENT.HARD_BLOCK,
        policyReason: 'PMO_STRICT_PAIR_RUGX',
        hardBlockSignatures: [...LIVE_CURVE_HARD_BLOCK_SIGNATURES],
      });
      signals.push({
        mint: trade.mint,
        entryProfileId: profile.id,
        signalAt: trade.timestampMs,
        signalPrice: trade.price,
        guardBlocked: guard.blocked,
        guardReason: guard.reason,
        guardSignatures: guard.matchedHardBlockSignatures,
      });
    }
  }
  db.close();

  const matrix = [];
  for (const entryProfile of ENTRY_PROFILES) {
    const entrySignals = signals.filter((signal) => signal.entryProfileId === entryProfile.id);
    for (const exitProfile of EXIT_PROFILES) {
      const outcomes = entrySignals.map((signal) => ({
        signal,
        outcome: simulateExit(ammTrades.get(signal.mint) || [], signal, exitProfile),
      }));
      const closed = outcomes.filter((row) => row.outcome.status === 'CLOSED');
      const blocked = outcomes.filter((row) => row.signal.guardBlocked);
      const resolvedBlocked = blocked.filter((row) => row.outcome.status === 'CLOSED');
      const baselineReturns = closed.map((row) => row.outcome.netReturnPct);
      const filteredReturns = closed.map((row) => (
        row.signal.guardBlocked ? 0 : row.outcome.netReturnPct
      ));
      matrix.push({
        entryProfileId: entryProfile.id,
        entryLabel: entryProfile.label,
        exitProfileId: exitProfile.id,
        signals: outcomes.length,
        entered: outcomes.filter((row) => !['NO_ENTRY', 'PRICE_JUMP'].includes(row.outcome.status)).length,
        closed: closed.length,
        noExit: outcomes.filter((row) => row.outcome.status === 'NO_EXIT').length,
        hardStops: closed.filter((row) => row.outcome.exitReason === 'HARD_STOP').length,
        trailingExits: closed.filter((row) => row.outcome.exitReason === 'TRAILING_STOP').length,
        maxHoldExits: closed.filter((row) => row.outcome.exitReason === 'MAX_HOLD').length,
        rugBlocked: blocked.length,
        avoidedRug50: resolvedBlocked.filter((row) => row.outcome.netReturnPct <= -50).length,
        avoidedRug80: resolvedBlocked.filter((row) => row.outcome.netReturnPct <= -80).length,
        blockedWinners: resolvedBlocked.filter((row) => row.outcome.netReturnPct > 0).length,
        baseline: roundedPerformance(performance(baselineReturns)),
        rugxComparable: roundedPerformance(performance(filteredReturns)),
      });
    }
  }
  matrix.sort((left, right) => (
    (right.baseline.averageNetReturnPct ?? -Infinity)
      - (left.baseline.averageNetReturnPct ?? -Infinity)
  ));
  const output = {
    analysisMode: 'CAUSAL_PUBLIC_FLOW_MARK_PRICE_SCREENING',
    dbPath,
    rawTrades,
    ammMints: ammTrades.size,
    signals: signals.length,
    configuredRoundTripCostPct: round(ROUND_TRIP_COST_PCT),
    warnings: [
      '归档未保存 PumpSwap 专用池储备；离线矩阵使用因果 mark price 减配置成本，不代表可执行成交价。',
      '单日样本只用于参数筛选；上线的 Shadow 会用实时池储备、200ms 入/退场延迟及容量模拟做前向验证。',
      'RUGX 仅硬拦截今日开发的三个高置信特征，其余 RUG 标签不改变入场。',
    ],
    entryProfiles: ENTRY_PROFILES,
    exitProfiles: EXIT_PROFILES,
    matrix,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
