'use strict';

const assert = require('assert');
const { FlowSmartConfirmShadowSuite } = require('../src/core/FlowSmartConfirmShadowSuite');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 1.4 });
}

function config() {
  return {
    enabled: true,
    positionSizeSol: 1,
    minSmartOpenSol: 0.1,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 10,
    cohorts: [
      { id: 'L5_F5', label: '5s confirm fixed', maxConfirmationDelayMs: 5_000, exitPolicy: 'FIXED_HOLD', fixedHoldMs: 5_000 },
      { id: 'L15_F5', label: '15s confirm fixed', maxConfirmationDelayMs: 15_000, exitPolicy: 'FIXED_HOLD', fixedHoldMs: 5_000 },
    ],
    costModel: {
      platformFeePct: 1.4, buySlippagePct: 0.3, sellSlippagePct: 0.3,
      priceImpactPct: 0.2, baseTxFeeSol: 0.00001, priorityFeeSol: 0.0005,
      positionSizeSol: 1,
    },
  };
}

function signal(store, mint, timestampMs) {
  return store.recordSignal({
    timestampMs, slot: 1, signature: `${mint}-signal`, mint, symbol: mint,
    ageMs: 15_000, curvePct: 45, price: 1,
    buyFlowW1: 1, buyFlowW2: 2, buyFlowW3: 4,
    sellFlowW1: 0, sellFlowW2: 0, sellFlowW3: 0,
    netFlowW1: 1, netFlowW2: 2, netFlowW3: 4,
    deltaNetFlow12: 1, deltaNetFlow23: 2,
    uniqueBuyersW1: 2, uniqueBuyersW2: 4, uniqueBuyersW3: 7,
    buyTxW1: 2, buyTxW2: 4, buyTxW3: 7,
    flowAccel1: 2, flowAccel2: 2, flowAccel: 2,
    signalVariant: 'primary_3w', isPrimary: true,
  });
}

function trade(mint, timestampMs, price, wallet = 'regular', solAmount = 1) {
  return {
    mint, symbol: mint, timestampMs, receivedAtMs: timestampMs, slot: timestampMs,
    signature: `${mint}-${timestampMs}-${wallet}`, eventIndex: 0,
    price, reservePrice: price, side: 'BUY', wallet, solAmount, tokenAmount: 1_000,
    curvePct: 45, ageMs: 20_000, market: 'PUMP_BONDING_CURVE',
  };
}

function main() {
  const store = makeStore();
  let now = 100_000;
  const suite = new FlowSmartConfirmShadowSuite({ config: config(), store, now: () => now });
  suite.start();
  const savedSignal = signal(store, 'causal-mint', now);
  assert.strictEqual(savedSignal.signalRankInMint, 1);

  const smartTrade = trade('causal-mint', now + 4_000, 1.2, 'smart-wallet', 0.5);
  const smartEvent = store.recordSmartWalletEvent(smartTrade);
  assert.strictEqual(smartEvent.positionPhase, 'OPEN');
  assert.strictEqual(smartEvent.nearestFlowSignal, savedSignal.signalId);
  suite.onSmartWalletOpen({ ...smartTrade, ...smartEvent, id: smartEvent.id });
  let rows = store.db.prepare(`SELECT * FROM flow_smart_confirm_shadow_positions ORDER BY cohort_id`).all();
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every((row) => row.status === 'PENDING_ENTRY'));
  assert.ok(rows.every((row) => row.entry_at == null), 'Smart OPEN trade itself must never be backfilled as entry');

  suite.observeTrade(trade('causal-mint', now + 4_100, 1.21));
  assert.strictEqual(suite.health().pendingEntries, 2, 'entry delay is causal');
  suite.observeTrade(trade('causal-mint', now + 4_200, 1.22));
  rows = store.db.prepare(`SELECT * FROM flow_smart_confirm_shadow_positions`).all();
  assert.ok(rows.every((row) => row.entry_at === now + 4_200));
  assert.ok(rows.every((row) => row.entry_price === 1.22));

  suite.advanceTime(now + 9_200);
  suite.observeTrade(trade('causal-mint', now + 9_400, 1.34));
  rows = store.db.prepare(`SELECT * FROM flow_smart_confirm_shadow_positions`).all();
  assert.ok(rows.every((row) => row.status === 'CLOSED'));
  assert.ok(rows.every((row) => row.net_return_pct > 0));
  assert.strictEqual(suite.health().sendsTransactions, false);

  now = 200_000;
  signal(store, 'late-mint', now);
  const lateTrade = trade('late-mint', now + 8_000, 1.1, 'smart-wallet-2', 0.5);
  const lateEvent = store.recordSmartWalletEvent(lateTrade);
  suite.onSmartWalletOpen({ ...lateTrade, ...lateEvent, id: lateEvent.id });
  const lateRows = store.db.prepare(`
    SELECT cohort_id, status, rejection_reason FROM flow_smart_confirm_shadow_positions
    WHERE mint = 'late-mint' ORDER BY cohort_id
  `).all();
  assert.deepStrictEqual(lateRows.map((row) => row.status), ['PENDING_ENTRY', 'RULE_REJECTED']);
  assert.match(lateRows.find((row) => row.status === 'RULE_REJECTED').rejection_reason, /CONFIRMATION_OUTSIDE_WINDOW/);

  const dashboard = store.flowSmartConfirmShadowDashboard();
  assert.strictEqual(dashboard.cohorts.length, 2);
  store.close();
  console.log('test-flow-smart-confirm-shadow: ok');
}

main();
