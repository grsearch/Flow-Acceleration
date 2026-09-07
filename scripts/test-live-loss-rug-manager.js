'use strict';

// All chain actions are local fakes. This checks the real manager boundaries,
// not profitability or live RPC access.
const assert = require('node:assert/strict');
const { ResearchStore } = require('../src/data/ResearchStore');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const { config } = require('../src/config');
const { LEGACY_LIVE_ID, LEGACY_RUGX, LEGACY_VERSION } = require('../src/core/ResearchCalibrationPolicy');

async function main() {
  let now = 1_788_660_000_000;
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.', flushMs: 60_000,
    flushMax: 100 }, { configuredTradingCostPct: 0 });
  // Production policy deliberately keeps every live entry fail-closed. This
  // isolated fake-chain test opts the one fixture back in so it can exercise
  // post-entry evidence and settlement boundaries without weakening config.
  const strategy = { ...config.liveTrading.strategies.find(s => s.id === LEGACY_LIVE_ID),
    entryEnabled: true };
  store.preEntryRugRisk = { config: { enabled: true }, evaluateGuard() { return { blocked: false }; } };
  const sequence = [], settlements = [];
  let receiptReady = false;
  const executor = {
    async buyAmm() {
      sequence.push('BUY');
      assert(sequence.includes('CAPTURE'), 'entry evidence must be frozen before execution');
      return { signature: 'offline-buy', venue: 'PUMP_AMM', tokenAmountRaw: '50000000000',
        expectedPrice: 4e-7, execution: { entrySlot: 101, pool: 'pool',
          settlement: { transactionSlot: 101, walletSolDelta: -0.0202, networkFeeSol: 0.0001 } } };
    },
    async transactionSettlement(signature) {
      assert.equal(signature, 'offline-sell');
      return receiptReady ? { walletSolDelta: 0.008, networkFeeSol: 0.0001 } : null;
    },
  };
  const manager = new LiveTradingManager({ config: { ...config.liveTrading,
    enabled: true, requestedEnabled: true, safetyLock: false, dryRun: false,
    lossRugFeedback: { enabled: false }, strategies: [strategy], killSwitchFile: null },
    store, executor, now: () => now });
  manager.lossRugFeedback = {
    start() { sequence.push('START'); },
    captureEntry(p) { assert.equal(p.mode, 'LIVE'); sequence.push('CAPTURE'); },
    observePosition() { sequence.push('OBSERVE'); },
    onSettlement(id, totals) { settlements.push({ id, ...totals }); },
    advanceTime() { sequence.push('ADVANCE'); },
    health() { return { pending: 0 }; },
    async stop() { sequence.push('STOP'); },
  };
  const event = {
    mint: 'offline-mint', pool: 'pool', market: 'PUMP_AMM', strategyId: LEGACY_LIVE_ID,
    episodeId: `offline:${LEGACY_VERSION}`, timestampMs: now, receivedAtMs: now,
    chainTimestampMs: now, slot: 100, signature: 'offline-source', eventIndex: 0,
    price: 4e-7, reservePrice: 4e-7, ammQuoteState: 'POST_TRADE_V1',
    poolBaseReservesRaw: '100000000000000', poolQuoteReservesRaw: '40000000000',
    virtualQuoteReservesRaw: '0', lifecycleStage: 'AMM_MATURE', lifecycleAgeMs: 20_000,
    features: { sourceCohortId: LEGACY_RUGX, calibrationVersion: LEGACY_VERSION,
      shadowPositionSol: 0.02 },
  };
  try {
    manager.start();
    manager.onExternalStrategySignal(event);
    await manager.entryQueue;
    await Promise.allSettled([...manager.pending]);
    const position = [...manager.positions.values()][0];
    assert(position && position.mode === 'LIVE');
    assert.equal(settlements.at(-1).complete, false, 'entry receipt is not a realized loss');
    assert.deepEqual(manager.health().lossRugFeedback, { pending: 0 });
    // Invalid, old and wrong-pool ticks cannot trigger feedback or exits.
    manager._requestExit = () => sequence.push('EXIT');
    const low = { ...event, price: 1.6e-7, reservePrice: 1.6e-7, slot: 102,
      timestampMs: ++now, receivedAtMs: now, chainTimestampMs: now };
    for (const patch of [{ ammQuoteState: 'INVALID' }, { slot: 100 }, { pool: 'wrong-pool' }]) {
      manager._observePositionTrade(position, { ...low, ...patch });
    }
    assert(!sequence.includes('OBSERVE'));
    manager._observePositionTrade(position, low);
    assert(sequence.indexOf('OBSERVE') >= 0);
    assert(sequence.indexOf('OBSERVE') < sequence.indexOf('EXIT'), 'hard-stop return must not skip capture');
    const orderId = store.recordLiveOrder({ positionId: position.id, strategyId: strategy.id,
      mint: position.mint, side: 'SELL', venue: 'PUMP_AMM', status: 'CONFIRMED',
      signature: 'offline-sell', attempt: 1, submittedAt: now, confirmedAt: now });
    store.updateLivePosition(position.id, { status: 'CLOSED', closedAt: now });
    assert.equal(manager._refreshPositionSettlement(position.id).complete, false);
    receiptReady = true;
    await manager._reconcileOrderSettlement({ orderId, positionId: position.id,
      signature: 'offline-sell', attempts: 1 });
    assert.equal(settlements.at(-1).complete, true);
    assert(settlements.at(-1).realizedReturnPct < -50, 'late receipt must reach feedback');
    manager.lossRugFeedback.onSettlement = () => { throw new Error('offline feedback fault'); };
    assert.equal(manager._refreshPositionSettlement(position.id).complete, true,
      'research failure cannot undo settlement or cause a duplicate sell');
    assert.equal(manager.metrics.lossRugFeedbackErrors, 1);
    let firstStop = true;
    manager.lossRugFeedback.stop = async () => {
      if (firstStop) { firstStop = false; throw Object.assign(new Error('pending'), { code: 'LIVE_LOSS_FEEDBACK_PENDING' }); }
      sequence.push('STOP');
    };
    await assert.rejects(manager.stop(), { code: 'LIVE_LOSS_FEEDBACK_PENDING' });
    await manager.stop();
    assert.equal(sequence.at(-1), 'STOP');
  } finally { await manager.stop(); store.close(); }
  console.log('test-live-loss-rug-manager: ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
