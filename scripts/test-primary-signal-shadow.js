'use strict';

const assert = require('assert');
const { PrimarySignalShadowManager, STATUS } = require('../src/core/PrimarySignalShadowManager');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 1.4 });
}

function config(overrides = {}) {
  return {
    enabled: true,
    positionSizeSol: 0.05,
    minNetFlowW3Sol: 10,
    minUniqueBuyersW3: 7,
    maxSignalAgeMs: 1_500,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 10,
    trailingStopPct: 7.5,
    maxHoldMs: 60_000,
    costModel: {
      platformFeePct: 1.4,
      buySlippagePct: 0.3,
      sellSlippagePct: 0.3,
      priceImpactPct: 0.2,
      baseTxFeeSol: 0.00001,
      priorityFeeSol: 0.0005,
      positionSizeSol: 0.05,
    },
    ...overrides,
  };
}

function primarySignal(store, {
  mint, timestampMs, price = 1, netFlowW3 = 10, uniqueBuyersW3 = 7,
}) {
  return store.recordSignal({
    timestampMs,
    slot: 1,
    signature: `${mint}-${timestampMs}`,
    mint,
    symbol: mint,
    ageMs: 10_000,
    curvePct: 50,
    price,
    buyFlowW1: 1,
    buyFlowW2: 5,
    buyFlowW3: Math.max(10, netFlowW3),
    sellFlowW1: 0,
    sellFlowW2: 0,
    sellFlowW3: 0,
    netFlowW1: 1,
    netFlowW2: 5,
    netFlowW3,
    deltaNetFlow12: 4,
    deltaNetFlow23: 5,
    uniqueBuyersW1: 2,
    uniqueBuyersW2: 5,
    uniqueBuyersW3,
    buyTxW1: 2,
    buyTxW2: 6,
    buyTxW3: 15,
    flowAccel1: 5,
    flowAccel2: 2,
    flowAccel: 2,
    signalVariant: 'primary_3w',
    isPrimary: true,
  });
}

function trade({ mint, timestampMs, price, side = 'BUY', wallet = 'regular', solAmount = 1 }) {
  return {
    mint,
    timestampMs,
    price,
    side,
    wallet,
    solAmount,
    market: 'PUMP_BONDING_CURVE',
  };
}

function main() {
  const store = makeStore();
  let now = 90_000;
  const manager = new PrimarySignalShadowManager({ config: config(), store, now: () => now });
  manager.start();

  const trailingSignal = primarySignal(store, { mint: 'trailing-mint', timestampMs: 100_000 });
  const trailingDecision = manager.onSignal(trailingSignal);
  assert.strictEqual(trailingDecision.status, STATUS.PENDING_ENTRY);
  manager.observeTrade(trade({ mint: 'trailing-mint', timestampMs: 100_100, price: 1 }));
  assert.strictEqual(manager.health().pendingEntries, 1, 'entry must respect 200ms delay');
  manager.observeTrade(trade({ mint: 'trailing-mint', timestampMs: 100_200, price: 1 }));
  manager.observeTrade(trade({ mint: 'trailing-mint', timestampMs: 100_300, price: 1.2 }));
  manager.observeTrade(trade({ mint: 'trailing-mint', timestampMs: 100_400, price: 1.1 }));
  assert.strictEqual(manager.health().activePositions, 1, '7.5% peak drawdown must request exit');
  manager.observeTrade(trade({ mint: 'trailing-mint', timestampMs: 100_500, price: 1.09 }));
  assert.strictEqual(manager.health().activePositions, 1, 'exit must respect 200ms delay');
  manager.observeTrade(trade({ mint: 'trailing-mint', timestampMs: 100_600, price: 1.09 }));
  let dashboard = store.primarySignalShadowDashboard();
  const trailing = dashboard.positions.find((row) => row.mint === 'trailing-mint');
  assert.strictEqual(trailing.status, STATUS.CLOSED);
  assert.strictEqual(trailing.exit_reason, 'TRAILING_IMMEDIATE');
  assert.ok(Math.abs(trailing.net_return_pct - 5.78) < 1e-9);

  const maxHoldSignal = primarySignal(store, { mint: 'max-hold-mint', timestampMs: 200_000 });
  manager.onSignal(maxHoldSignal);
  manager.observeTrade(trade({ mint: 'max-hold-mint', timestampMs: 200_200, price: 1 }));
  now = 260_200;
  manager.advanceTime(now);
  manager.observeTrade(trade({ mint: 'max-hold-mint', timestampMs: 260_400, price: 1.05 }));
  dashboard = store.primarySignalShadowDashboard();
  const maxHold = dashboard.positions.find((row) => row.mint === 'max-hold-mint');
  assert.strictEqual(maxHold.status, STATUS.CLOSED);
  assert.strictEqual(maxHold.exit_reason, 'MAX_HOLD_60S');

  manager.observeTrade(trade({
    mint: 'prior-smart-mint', timestampMs: 300_000, price: 1,
    wallet: 'early-smart', solAmount: 0.2,
  }), { isSmartWallet: true });
  const independentSignal = primarySignal(store, { mint: 'prior-smart-mint', timestampMs: 300_000 });
  manager.onSignal(independentSignal);
  dashboard = store.primarySignalShadowDashboard();
  const independent = dashboard.positions.find((row) => row.mint === 'prior-smart-mint');
  assert.strictEqual(independent.status, STATUS.PENDING_ENTRY,
    'Smart Wallet activity must not be a hidden Primary entry filter');

  const weakSignal = primarySignal(store, {
    mint: 'weak-mint', timestampMs: 500_000, netFlowW3: 9.9, uniqueBuyersW3: 6,
  });
  manager.onSignal(weakSignal);
  dashboard = store.primarySignalShadowDashboard();
  const weak = dashboard.positions.find((row) => row.mint === 'weak-mint');
  assert.strictEqual(weak.status, STATUS.RULE_REJECTED);
  assert.match(weak.rejection_reason, /NETFLOW_W3_BELOW_MIN/);
  assert.match(weak.rejection_reason, /BUYERS_W3_BELOW_MIN/);

  const jumpSignal = primarySignal(store, { mint: 'jump-mint', timestampMs: 600_000 });
  manager.onSignal(jumpSignal);
  manager.observeTrade(trade({ mint: 'jump-mint', timestampMs: 600_200, price: 1.11 }));
  const noEntrySignal = primarySignal(store, { mint: 'no-entry-mint', timestampMs: 700_000 });
  manager.onSignal(noEntrySignal);
  manager.advanceTime(702_201);
  dashboard = store.primarySignalShadowDashboard();
  assert.strictEqual(
    dashboard.positions.find((row) => row.mint === 'jump-mint').status,
    STATUS.PRICE_JUMP,
  );
  assert.strictEqual(
    dashboard.positions.find((row) => row.mint === 'no-entry-mint').status,
    STATUS.NO_ENTRY,
  );

  const health = manager.health();
  assert.strictEqual(health.mode, 'SHADOW');
  assert.strictEqual(health.strategy.ruleVersion, 'primary-flow-w3-buyers-v1');
  assert.strictEqual(health.strategy.exit.trailingActivationPct, 0);
  assert.strictEqual(health.strategy.exit.trailingStopPct, 7.5);
  assert.strictEqual(health.strategy.risk.sendsTransactions, false);
  assert.strictEqual(dashboard.stats.closed_positions, 2);

  store.close();
  console.log('primary signal shadow tests passed');
}

main();
