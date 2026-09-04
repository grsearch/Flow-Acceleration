'use strict';

const assert = require('node:assert/strict');
const {
  executableBuy,
  executableSell,
  reservesForTrade,
  rugClassification,
  simulateSellSequence,
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
  const inconsistent = executableSell(
    ammTrade(),
    10_000,
    0.000001,
    { rugMarkReturnPct: 0, maxQuoteToMarketRatio: 5 },
  );
  assert.equal(inconsistent.available, false);
  assert.equal(inconsistent.reason, 'EXIT_CAPACITY_QUOTE_MARK_PRICE_MISMATCH');
  assert.ok(inconsistent.quoteToMarketRatio > 5);
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

{
  const cliffTrade = {
    market: 'PUMP_AMM',
    rugPath: { kind: 'CLIFF_DROP_50', confirmed: true },
  };
  const missing = executableSell(cliffTrade, 10_000, 0.00001, { rugMarkReturnPct: -10 });
  assert.equal(missing.conservative, true);
  assert.equal(missing.rugLike, true);
  assert.equal(missing.price, 0);
  assert.equal(missing.rugClassification, 'CLIFF_DROP_50');
  assert.equal(rugClassification(cliffTrade, -82), 'CLIFF_RUG_80');
}

{
  const trade = ammTrade();
  const direct = simulateSellSequence(trade, [100_000]);
  const afterLargeWallet = simulateSellSequence(trade, [400_000, 100_000]);
  assert.equal(direct.available, true);
  assert.equal(afterLargeWallet.available, true);
  assert.ok(
    afterLargeWallet.legs[1].proceedsSol < direct.legs[0].proceedsSol,
    'our exit must recover less SOL after an observed large wallet dumps first',
  );
}

console.log('shadow execution model tests passed');
