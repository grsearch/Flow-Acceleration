'use strict';
const assert = require('assert/strict');
const { SolUsdReference, ENDPOINT } = require('../src/core/SolUsdReference');

async function main() {
  let now = 1_788_660_000_000, calls = 0, fail = false;
  let invalid = false;
  const feed = new SolUsdReference({ now: () => now,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, ENDPOINT);
      assert.equal(options.redirect, 'error');
      if (fail) throw new Error('private error must never escape');
      return { ok: true, json: async () => ({ data: {
        base: invalid ? 'BTC' : 'SOL', currency: 'USD', amount: '100.50',
      } }) };
    } });
  try {
    assert.equal(feed.snapshot(), null);
    feed.start(); feed.start();
    await feed.refresh();
    assert.equal(calls, 1, 'start is idempotent and in-flight refresh shared');
    assert.equal(feed.snapshot().priceUsd, 100.5);
    const original = feed.snapshot();
    assert.equal(feed.snapshot(now - 1), null, 'no future-known reference');
    for (let i = 0; i < 1000; i++) feed.snapshot();
    assert.equal(calls, 1, 'reading cache never performs network IO');
    fail = true; now += 60_000;
    await feed.refresh();
    assert.deepEqual(feed.snapshot(), original, 'failed refresh cannot extend reference lifetime');
    assert.equal(feed.health().lastError, 'SOL_USD_REFERENCE_REFRESH_FAILED');
    now = original.expiresAt;
    assert.equal(feed.snapshot(), null);
    fail = false; invalid = true;
    await feed.refresh();
    assert.equal(feed.snapshot(), null, 'wrong trading pair never provides FDV');
  } finally { await feed.stop(); }
  await feed.refresh();
  assert.equal(calls, 3, 'stopped feed cannot restart via refresh');
  console.log('test-sol-usd-reference: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
