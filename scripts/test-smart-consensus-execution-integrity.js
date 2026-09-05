'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { SmartWalletConsensusFlowRunnerShadowSuite } = require(
  '../src/core/SmartWalletConsensusFlowRunnerShadowSuite',
);

function fixture({ exitDelayMs = 200, pool = 'pool-a' } = {}) {
  const base = 1_920_000_000_000;
  let now = base;
  let sequence = 0;
  const mint = 'ExecutionIntegrity111111111111111111111111';
  const store = new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000,
  }, { configuredTradingCostPct: 0 });
  const profile = {
    id: 'DIRECT_TEST', enabled: false, strength: 'TEST',
    postGraduationHoldingConsensus: true, directPostGraduationEntry: true,
    exitProfileIds: ['CORE_TEST'], entryDelayMs: 100, entryTimeoutMs: 1_000,
  };
  const config = {
    enabled: true, positionSizeSol: 1, stateRetentionMs: 60_000,
    entryDelayMs: 100, entryTimeoutMs: 1_000, exitDelayMs, exitTimeoutMs: 1_000,
    maxScoutWaitMs: 10_000, maxFlowWaitMs: 10_000, flowWindowMs: 1_000,
    episodeCooldownMs: 30_000,
    entryProfiles: [profile],
    exitProfiles: [{ id: 'CORE_TEST', mode: 'CORE_RUNNER',
      coreActivationPct: 30, coreFraction: 0.8, runnerTrailPct: 30,
      maxHoldMs: 60_000, hardStopPct: 20 }],
    costModel: { platformFeePct: 0, buySlippagePct: 0, sellSlippagePct: 0,
      priceImpactPct: 0, baseTxFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0,
      fixedCostSol: 0, positionSizeSol: 1 },
  };
  const registry = { monitoringSnapshot: () => null,
    activeClusterCounts: () => ({ eligible: 3, selectionA: 0 }) };
  const createSuite = () => new SmartWalletConsensusFlowRunnerShadowSuite({
    config, store, registry, now: () => now,
  });
  let suite = createSuite();
  suite._recordSignal({ mint, market: 'PUMP_AMM' }, profile, {
    votes: [], thresholds: { eligible: 3 }, required: 3, selectionA: 0,
    copyA: 0, weightedScore: 3,
  }, base, 0.001);
  const trade = (offset, quoteSol = 1_000, overrides = {}) => {
    now = base + offset;
    const value = { mint, market: 'PUMP_AMM', timestampMs: now,
      receivedAtMs: now, side: 'BUY', wallet: 'public', pool,
      signature: `integrity-${++sequence}`, eventIndex: 0,
      solAmount: 0.000001, tokenAmount: 0.001,
      price: quoteSol / 1_000_000, reservePrice: quoteSol / 1_000_000,
      poolBaseReservesRaw: '1000000000000',
      poolQuoteReservesRaw: String(Math.round(quoteSol * 1e9)),
      virtualQuoteReservesRaw: '0', ...overrides };
    suite.observeTrade(value);
    return value;
  };
  trade(100);
  const row = () => store.db.prepare(
    'SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions',
  ).get();
  assert.strictEqual(row().status, 'OPEN');
  return { store, row, trade, base,
    suite: () => suite,
    advance: (offset) => { now = base + offset; suite.advanceTime(now); },
    restart: (offset) => {
      now = base + offset;
      suite = createSuite();
      suite.start();
    } };
}

function runExecutionIntegrityTests() {
  const withFixture = (options, callback) => {
    const f = fixture(options);
    try { callback(f); } finally { f.store.close(); }
  };
  withFixture({}, (f) => {
    f.trade(500, 1_400, { signature: 'activation' });
    assert.strictEqual(f.row().core_sold_at, null);
    const pending = JSON.parse(f.row().execution_state_json).corePending;
    assert.strictEqual(pending.targetAt, f.base + 700);
    f.trade(699, 1_400);
    assert.strictEqual(f.row().core_sold_at, null, 'never execute before the configured delay');
    f.trade(700, 1_400, { signature: 'activation', eventIndex: 1 });
    assert.strictEqual(f.row().core_sold_at, null, 'a second event in the trigger signature cannot fill');
    f.trade(701, 1_400);
    assert.strictEqual(f.row().core_sold_at, f.base + 701);
    assert.strictEqual(f.row().exit_tx_count, 1);
    assert(f.row().core_proceeds_sol > 1,
      'a tiny public swap may expose deep reserves: do not cap capacity at its trade amount');
  });
  withFixture({ exitDelayMs: 0 }, (f) => {
    f.trade(500, 1_400);
    assert.strictEqual(f.row().core_sold_at, null, 'zero configured delay still needs a later event');
    f.trade(501, 1_400);
    assert.strictEqual(f.row().core_sold_at, f.base + 501);
  });
  withFixture({}, (f) => {
    // Regression for 3Ga3: the derived mark AND reserve quote spike together
    // for a microscopic SELL, then normalize in event 1 of the same signature.
    f.trade(500, 15_000, { signature: '3Ga3-multi-event', side: 'SELL',
      solAmount: 0.000106846, eventIndex: 0 });
    assert.strictEqual(f.row().core_sold_at, null);
    assert.strictEqual(JSON.parse(f.row().execution_state_json).corePending, undefined);
    assert(f.row().highest_return_pct < 1, 'unconfirmed spikes must not poison the trailing peak');
    f.trade(500, 1_000, { signature: '3Ga3-multi-event', eventIndex: 1 });
    f.trade(701, 1_000);
    assert.strictEqual(f.row().status, 'OPEN');
    assert.strictEqual(f.row().core_proceeds_sol, 0);
    assert.strictEqual(f.row().net_return_pct, null);
  });
  withFixture({}, (f) => {
    f.trade(500, 1_400);
    f.trade(700, 21_000, { signature: 'execution-spike' });
    assert.strictEqual(f.row().core_sold_at, null, 'a due core order must reject an unconfirmed jump');
    f.trade(700, 1_400, { signature: 'execution-spike', eventIndex: 1 });
    assert(f.row().core_proceeds_sol > 1 && f.row().core_proceeds_sol < 1.2);
    assert(f.row().highest_return_pct < 50);
  });
  withFixture({}, (f) => {
    f.trade(500, 15_000, { signature: 'jump' });
    f.trade(700, 15_000, { signature: 'jump', eventIndex: 1 });
    assert.strictEqual(f.row().core_sold_at, null);
    assert.strictEqual(JSON.parse(f.row().execution_state_json).corePending, undefined);
    f.trade(710, 15_000, { signature: 'independent-confirmation' });
    assert.strictEqual(f.row().core_sold_at, null,
      'even an independently confirmed rise only triggers a delayed core order');
    f.trade(910, 15_000, { signature: 'later-execution' });
    assert(f.row().core_proceeds_sol > 10, 'persistent, independently confirmed gains are not capped');
  });
  withFixture({}, (f) => {
    f.trade(500, 1_400);
    f.trade(700, 1_400, { pool: 'different-pool' });
    assert.strictEqual(f.row().core_sold_at, null);
    assert.strictEqual(JSON.parse(f.row().execution_state_json).lastRejected.reason,
      'EXIT_POOL_MISMATCH');
    f.trade(800, 1_400, { pool: null });
    assert.strictEqual(f.row().core_sold_at, null, 'known entry pool cannot be verified by a pool-less quote');
    f.trade(900, 1_400);
    assert.strictEqual(f.row().core_sold_at, f.base + 900);
  });
  withFixture({ pool: null }, (f) => {
    f.trade(500, 15_000, { signature: null });
    f.trade(800, 15_000, { signature: null });
    assert.strictEqual(f.row().core_proceeds_sol, 0,
      'missing historical signatures cannot establish an independent jump confirmation');
    assert.strictEqual(JSON.parse(f.row().execution_state_json).corePending, undefined);
  });
  withFixture({}, (f) => {
    f.trade(500, 1_400, { signature: null });
    f.trade(700, 1_400);
    assert.strictEqual(f.row().core_sold_at, null,
      'a core trigger without a signature cannot prove a later independent transaction');
    f.advance(1_701);
    assert.strictEqual(f.row().status, 'NO_EXIT');
    assert.strictEqual(f.row().net_return_pct, null);
  });
  withFixture({}, (f) => {
    const units = f.row().token_units;
    f.trade(500, 1_400);
    f.trade(700, 1_400, { poolBaseReservesRaw: null, poolQuoteReservesRaw: null });
    assert.strictEqual(f.row().status, 'OPEN');
    f.advance(1_701);
    assert.strictEqual(f.row().status, 'NO_EXIT');
    assert.strictEqual(f.row().exit_reason, 'CORE_EXIT_TIMEOUT');
    assert.strictEqual(f.row().token_units, units, 'timeout preserves unsold inventory');
    assert.strictEqual(f.row().core_proceeds_sol, 0);
    assert.strictEqual(f.row().net_return_pct, null, 'missing exits never enter PNL as zero or a win');
  });
  withFixture({}, (f) => {
    f.trade(500, 1_400, { signature: 'pending-before-restart' });
    f.trade(600, 21_000, { signature: 'unconfirmed-before-restart' });
    f.restart(650);
    f.trade(700, 21_000, { signature: 'unconfirmed-before-restart', eventIndex: 1 });
    assert.strictEqual(f.row().core_sold_at, null, 'restart preserves candidate and independent-signature rule');
    f.trade(701, 1_400);
    assert.strictEqual(f.row().core_sold_at, f.base + 701);
    assert.strictEqual(f.row().exit_tx_count, 1, 'restart cannot duplicate a pending core sale');
  });
  withFixture({}, (f) => {
    f.trade(500, 1_400);
    f.trade(600, 500);
    assert.strictEqual(f.row().status, 'EXIT_PENDING');
    assert.strictEqual(JSON.parse(f.row().execution_state_json).corePending, null);
    f.trade(800, 500);
    assert.strictEqual(f.row().status, 'CLOSED');
    assert.strictEqual(f.row().exit_reason, 'HARD_STOP');
    assert.strictEqual(f.row().core_proceeds_sol, 0);
    assert.strictEqual(f.row().exit_tx_count, 1, 'hard stop preempts the core order without double-selling');
    assert(f.row().net_return_pct < -40);
  });
  withFixture({}, (f) => {
    f.store.db.exec(`ALTER TABLE smart_wallet_consensus_flow_runner_shadow_positions
      DROP COLUMN execution_state_json`);
    f.restart(300);
    assert.strictEqual(f.row().execution_state_json, null,
      'upgrading an old schema adds metadata without inventing historical pool evidence');
    f.trade(500, 15_000);
    assert.strictEqual(f.row().core_sold_at, null,
      'a restored legacy position anchors jump validation to its existing entry price');
  });
  console.log('Smart consensus execution integrity tests: PASS');
}

module.exports = { runExecutionIntegrityTests };
if (require.main === module) runExecutionIntegrityTests();
