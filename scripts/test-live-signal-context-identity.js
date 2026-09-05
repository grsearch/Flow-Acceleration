'use strict';

const assert = require('node:assert/strict');
const LiveTradingManager = require('../src/core/LiveTradingManager');

const decisions = [];
const strategy = { id: 'context-identity', enabled: true, entryEnabled: false,
  signalSource: 'EXTERNAL', market: 'PUMP_AMM' };
const store = {
  getToken: () => null,
  recordLiveStrategyDecision: (row) => { decisions.push(row); return { id: decisions.length, inserted: true }; },
};
const manager = new LiveTradingManager({ config: { enabled: false, strategies: [strategy] },
  store, now: () => 10_000 });
const source = { mint: 'mint', market: 'PUMP_AMM', pool: 'pool',
  timestampMs: 10_000, receivedAtMs: 10_000, chainTimestampMs: 9_500,
  slot: 100, signature: 'transaction-a', eventIndex: 0,
  price: 1.1, reservePrice: 1, ammQuoteState: 'POST_TRADE_V1',
  preReservePrice: 1.2, prePoolBaseReservesRaw: '1000000000', prePoolQuoteReservesRaw: '1200000000000',
  poolBaseReservesRaw: '1000000000', poolQuoteReservesRaw: '1000000000000', virtualQuoteReservesRaw: '0',
  ammExecutionFees: { ixName: 'sell', poolQuoteAmountRaw: '200000000000' } };
manager.observeTrade(source);

function signal(overrides = {}) {
  manager.onExternalStrategySignal({ strategyId: strategy.id, episodeId: `signal-${decisions.length}`,
    mint: source.mint, market: source.market, timestampMs: source.timestampMs,
    slot: source.slot, signature: source.signature, eventIndex: source.eventIndex,
    price: 0.1, ...overrides });
  return decisions.at(-1).features.signalTiming;
}

// A callback for event 1 can arrive before observeTrade replaces cached event 0.
for (const overrides of [
  { eventIndex: 1 },
  { signature: 'transaction-b' },
  { eventIndex: null },
  { signature: null },
  { slot: null },
]) {
  const evidence = signal(overrides);
  assert.equal(evidence.ammQuoteState, null, 'an unrelated/unidentified event must not inherit POST');
  assert.equal(evidence.poolBaseReservesRaw, null);
  assert.equal(evidence.prePoolBaseReservesRaw, null);
  assert.equal(evidence.ammExecutionFees, null);
  assert.equal(evidence.chainTimestampMs, null);
}

const same = signal();
assert.equal(same.ammQuoteState, 'POST_TRADE_V1');
assert.equal(same.poolBaseReservesRaw, source.poolBaseReservesRaw);
assert.equal(same.prePoolQuoteReservesRaw, source.prePoolQuoteReservesRaw);
assert.deepEqual(same.ammExecutionFees, source.ammExecutionFees);
assert.equal(same.chainTimestampMs, source.chainTimestampMs);

for (const state of ['INVALID', 'POST_TRADE_V99', '']) {
  for (const eventIndex of [0, 1]) {
    const evidence = signal({ eventIndex, ammQuoteState: state,
      ammQuoteStateReason: 'EVENT_SPECIFIC_REASON',
      ammExecutionFees: { ixName: 'buy', poolQuoteAmountRaw: '123' } });
    assert.equal(evidence.ammQuoteState, state, 'explicit signal state wins even over an exact cached POST');
    assert.equal(evidence.ammQuoteStateReason, 'EVENT_SPECIFIC_REASON');
    assert.deepEqual(evidence.ammExecutionFees, { ixName: 'buy', poolQuoteAmountRaw: '123' });
  }
}

manager.observeTrade({ ...source, ammQuoteState: 'INVALID', ammQuoteStateReason: 'POST_RESERVE_UNDERFLOW' });
const invalid = signal();
assert.equal(invalid.ammQuoteState, 'INVALID');
assert.equal(invalid.ammQuoteStateReason, 'POST_RESERVE_UNDERFLOW', 'cache diagnostics must preserve parser reason');
const explicit = signal({ ammQuoteState: 'POST_TRADE_V1' });
assert.equal(explicit.ammQuoteState, 'POST_TRADE_V1');
assert.equal(explicit.ammQuoteStateReason, null, 'do not attach another state\'s diagnostic reason');

console.log('test-live-signal-context-identity: ok (same timestamp/slot siblings, explicit state, exact-event repair)');
