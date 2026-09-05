'use strict';

const assert = require('node:assert/strict');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const { executableBuy, executableSell, reservesForTrade, ammQuoteStateRejection } = require('../src/core/ShadowExecutionModel');
const { PumpTradeExecutor, ammReservePrice, ammQuotePriceDiagnostics } = require('../src/core/PumpTradeExecutor');

function quoteTrade(overrides = {}) {
  return { mint: 'post-state-mint', market: 'PUMP_AMM', pool: 'post-state-pool',
    ammQuoteState: 'POST_TRADE_V1', price: 1.5, reservePrice: 1,
    preReservePrice: 1.1, prePoolBaseReservesRaw: '999000000', prePoolQuoteReservesRaw: '1100000000000',
    poolBaseReservesRaw: '1000000000', poolQuoteReservesRaw: '1000000000000',
    virtualQuoteReservesRaw: '0', ammExecutionFees: { ixName: 'sell', poolQuoteAmountRaw: '100000000000' },
    timestampMs: 10_000, receivedAtMs: 10_000, chainTimestampMs: 10_000, slot: 101,
    signature: 'post-state-signature', eventIndex: 0,
    ...overrides };
}

function testHelpersRejectExplicitInvalidOrUnknown() {
  for (const ammQuoteState of ['INVALID', 'POST_TRADE_V99', '']) {
    const trade = quoteTrade({ ammQuoteState });
    assert.ok(ammQuoteStateRejection(trade));
    assert.equal(reservesForTrade(trade), null, 'even positive stale reserves cannot bypass an explicit rejected state');
    const buy = executableBuy(trade, 0.1, trade.price);
    assert.equal(buy.available, false);
    assert.equal(buy.price, null);
    const sell = executableSell(trade, 0.1, trade.price, { rugMarkReturnPct: -90 });
    assert.equal(sell.available, false);
    assert.equal(sell.price, null);
    assert.equal(sell.proceedsSol, null);
    assert.equal(sell.conservative, false, 'invalid state is unknown, not a conservative zero-value fill');
  }
  const legacy = quoteTrade();
  delete legacy.ammQuoteState;
  assert.equal(executableBuy(legacy, 0.1, legacy.price).available, true);
  assert.equal(legacy.ammQuoteState, undefined, 'legacy compatibility must not relabel data as POST');
  const malformed = quoteTrade({ virtualQuoteReservesRaw: 'not-an-integer' });
  assert.equal(executableBuy(malformed, 0.1, 1).available, false);
}

function testSignedVirtualQuoteAndExecutorDiagnostics() {
  const price = ammReservePrice({ baseReserveRaw: '1000000000', quoteReserveRaw: '1000000000000',
    virtualQuoteReservesRaw: '-400000000000', baseDecimals: 6 });
  assert.equal(price, 0.6);
  const trade = quoteTrade({ virtualQuoteReservesRaw: '-400000000000', reservePrice: 0.6 });
  assert.equal(reservesForTrade(trade).quoteRaw, 600000000000n);
  assert.equal(executableBuy(trade, 0.1, 0.6).available, true);
  assert.equal(executableSell(trade, 0.1, 0.6).available, true);
  for (const virtual of ['-1000000000000', '-1000000000001', 'bad']) {
    assert.equal(ammReservePrice({ baseReserveRaw: trade.poolBaseReservesRaw,
      quoteReserveRaw: trade.poolQuoteReservesRaw, virtualQuoteReservesRaw: virtual }), null);
    assert.equal(executableSell({ ...trade, virtualQuoteReservesRaw: virtual }, 0.1, 1).available, false);
  }
  const diagnostics = ammQuotePriceDiagnostics({ signalAmmQuoteState: 'INVALID',
    signalBaseReserveRaw: trade.poolBaseReservesRaw, signalQuoteReserveRaw: trade.poolQuoteReservesRaw,
    freshBaseReserveRaw: trade.poolBaseReservesRaw, freshQuoteReserveRaw: trade.poolQuoteReservesRaw,
    virtualQuoteReservesRaw: '0', baseDecimals: 6, positionSol: 0.1,
    quotedBaseRaw: '100000', internalQuoteWithoutFeesRaw: '99000000', legacyReferencePrice: 7 });
  assert.equal(diagnostics.marketReferencePrice, null, 'invalid signal cannot use legacy reference fallback');
  assert.equal(diagnostics.marketMovePct, null);
}

function testInvalidObservationDoesNotTriggerOrReuseCache() {
  let now = 10_000;
  const writes = [], decisions = [];
  const strategy = { id: 'test-post', enabled: true, entryEnabled: false, signalSource: 'EXTERNAL',
    market: 'PUMP_AMM', exitMode: 'FIXED_HOLD', fixedHoldMs: 60_000, hardStopPct: 30 };
  const store = { getToken: () => ({ mint: 'post-state-mint', graduated_at: 1_000 }),
    updateLivePosition: (id, patch) => writes.push({ id, patch }),
    recordLiveStrategyDecision: (row) => { decisions.push(row); return { id: 1, inserted: true }; } };
  const manager = new LiveTradingManager({ config: { enabled: false, strategies: [strategy] }, store, now: () => now });
  manager._scheduleSettlementReconciliation = () => {};
  manager._scheduleMintLockRecheck = () => {};
  const position = { id: 1, mint: 'post-state-mint', status: 'OPEN', mode: 'DRY_RUN',
    strategy, strategyId: strategy.id, entryMarket: 'PUMP_AMM', entryPool: 'post-state-pool', entrySlot: 100,
    entryPrice: 1, highestPrice: 1, lowestPrice: 1, positionSol: 0.1, tokenAmountRaw: '100000', openedAt: 9_000 };
  manager._addPosition(position);
  const exits = [];
  manager._requestExit = (lot, reason, price) => exits.push({ reason, price });
  let evaluations = 0;
  const evaluate = manager._evaluatePositionExit.bind(manager);
  manager._evaluatePositionExit = (...args) => { evaluations += 1; return evaluate(...args); };
  manager.observeTrade(quoteTrade());
  assert.equal(position.lastObservedPrice, 1, 'POST mark, not trade average, drives observation');
  const oldTrade = position.lastAcceptedTrade, oldObservedAt = position.lastObservedAt;
  for (const state of ['INVALID', 'POST_TRADE_V99']) {
    now += 1;
    manager.observeTrade(quoteTrade({ ammQuoteState: state, timestampMs: now, chainTimestampMs: now,
      reservePrice: 0.01, price: 100, slot: 102 }));
    assert.equal(position.lastAcceptedTrade, oldTrade);
    assert.equal(position.lastObservedAt, oldObservedAt);
    assert.equal(position.lastObservedPrice, 1);
    assert.equal(position.highestPrice, 1);
    assert.equal(exits.length, 0);
    assert.equal(manager.ammPriceStates.has(position.mint), false);
    const before = evaluations;
    manager.advanceTime(now + 1);
    assert.equal(evaluations, before, 'an invalid observation cannot fall back to the older cached mark');
  }
  assert.equal(manager.metrics.rejectedAmmQuoteStates, 2);
  assert.equal(position.lastRejectedTrade.ammQuoteState, 'POST_TRADE_V99');
  assert.equal(manager.signalTradeContexts.get(position.mint).ammQuoteState, 'POST_TRADE_V99');
  manager.onExternalStrategySignal({ strategyId: strategy.id, episodeId: 'same-invalid-tick',
    mint: position.mint, market: 'PUMP_AMM', timestampMs: now, slot: 102, price: 100,
    signature: 'post-state-signature', eventIndex: 0 });
  assert.equal(decisions[0].features.signalTiming.ammQuoteState, 'POST_TRADE_V99');
  assert.deepEqual(decisions[0].features.signalTiming.ammExecutionFees, oldTrade.ammExecutionFees);
  assert.equal(decisions[0].features.signalTiming.prePoolBaseReservesRaw, oldTrade.prePoolBaseReservesRaw);
  now += 2;
  manager.observeTrade(quoteTrade({ timestampMs: now, chainTimestampMs: now, slot: 103,
    reservePrice: 0.6, price: 1.5, poolQuoteReservesRaw: '600000000000' }));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].reason, 'EXECUTABLE_HARD_STOP');
  assert.equal(exits[0].price, 0.6, 'valid POST decline must trigger the original hard-stop threshold');
  assert.equal(position.lastAmmQuoteRejectedAt, null);
  assert.equal(manager.signalTradeContexts.get(position.mint).ammQuoteState, 'POST_TRADE_V1');
  assert.equal(writes.length, 0, 'invalid highs must not leak into persisted position extrema');
}

async function testExecutorRejectsBeforeNetwork() {
  const executor = Object.create(PumpTradeExecutor.prototype);
  executor.config = { buySlippagePct: 10 };
  executor._assertSignalPool = () => { throw new Error('network/preparation must not be reached'); };
  for (const state of ['INVALID', 'UNKNOWN_STATE']) {
    await assert.rejects(executor.buyAmm({ mint: 'unused', solAmount: 0.1,
      signalAmmQuoteState: state, signalPoolBaseReservesRaw: '1000', signalPoolQuoteReservesRaw: '1000' }),
    (error) => /AMM_QUOTE_STATE_/.test(error.code));
  }
}

async function main() {
  testHelpersRejectExplicitInvalidOrUnknown();
  testSignedVirtualQuoteAndExecutorDiagnostics();
  testInvalidObservationDoesNotTriggerOrReuseCache();
  await testExecutorRejectsBeforeNetwork();
  console.log('test-live-amm-post-state: ok (fail-closed states, no stale-cache fallback, POST hard stop, signed virtual)');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
