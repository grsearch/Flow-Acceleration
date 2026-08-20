'use strict';

const assert = require('node:assert/strict');
const {
  executableBuy,
  executableSell,
  reservesForTrade,
} = require('../src/core/ShadowExecutionModel');

function ammTrade(overrides = {}) {
  return {
    market: 'PUMP_AMM',
    poolBaseReservesRaw: '1000000000000',
    poolQuoteReservesRaw: '100000000000',
    virtualQuoteReservesRaw: '0',
    ...overrides,
  };
}

{
  const reserves = reservesForTrade(ammTrade());
  assert.equal(reserves.baseRaw, 1_000_000_000_000n);
  assert.equal(reserves.quoteRaw, 100_000_000_000n);
  const adjusted = reservesForTrade(ammTrade({
    poolQuoteReservesRaw: '2000000000',
    virtualQuoteReservesRaw: '-500000000',
  }));
  assert.equal(adjusted.quoteRaw, 1_500_000_000n);
}

{
  const trade = ammTrade();
  const buy = executableBuy(trade, 1, 0.0001);
  assert.equal(buy.available, true);
  assert.ok(buy.price > 0.0001, 'a one-SOL buy must include positive self impact');
  const sell = executableSell(trade, 10_000_000, 0.0001, { rugMarkReturnPct: 0 });
  assert.equal(sell.available, true);
  assert.ok(sell.price < 0.0001, 'a size-aware sell must be below the spot price');
}

{
  const missing = executableSell(
    { market: 'PUMP_AMM' },
    10_000,
    0.00001,
    { rugMarkReturnPct: -60 },
  );
  assert.equal(missing.available, false);
  assert.equal(missing.conservative, true);
  assert.equal(missing.price, 0, 'a RUG with no capacity quote must not use the chart price');
}

{
  const ordinaryMissing = executableSell(
    { market: 'PUMP_AMM' },
    10_000,
    0.00001,
    { rugMarkReturnPct: 5 },
  );
  assert.equal(ordinaryMissing.conservative, false);
  assert.equal(ordinaryMissing.price, 0.00001);
}

console.log('shadow execution model tests passed');
