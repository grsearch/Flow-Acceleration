'use strict';
const assert = require('assert/strict');
const { SolUsdReference, ENDPOINT } = require('../src/core/SolUsdReference');

async function legacyCacheChecks() {
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
}

// Deterministic timers keep these regressions completely offline and instant.
// In particular, no real timeout should be needed to test a stuck transport.
const PRIVATE_ERROR = 'secret-token=must-never-leak wallet=private-wallet';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const response = (amount = '100.50', extra = {}) => ({ ok: true, status: 200,
  json: async () => ({ data: { base: 'SOL', currency: 'USD', amount } }), ...extra });
function fakeClock() {
  let time = 1_788_660_000_000, sequence = 0;
  const jobs = new Map();
  const schedule = (fn, ms, interval) => {
    const handle = { id: ++sequence, unref() {} };
    jobs.set(handle.id, { fn, at: time + ms, interval, handle });
    return handle;
  };
  const clear = handle => { jobs.delete(handle?.id); };
  return { now: () => time, jobCount: () => jobs.size,
    timers: { setTimeout: (fn, ms) => schedule(fn, ms, 0), clearTimeout: clear,
      setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: clear },
    jump(ms) { time += ms; },
    async tick(ms) {
      const target = time + ms;
      for (;;) {
        const next = [...jobs.values()].filter(job => job.at <= target)
          .sort((a, b) => a.at - b.at || a.handle.id - b.handle.id)[0];
        if (!next) break;
        time = next.at;
        if (next.interval) next.at += next.interval;
        else jobs.delete(next.handle.id);
        next.fn(); await flush();
      }
      time = target; await flush();
    } };
}
async function withFeed(fetchImpl, run, config = {}) {
  const clock = fakeClock();
  const feed = new SolUsdReference({ config, fetchImpl, now: clock.now, timers: clock.timers });
  try { await run(feed, clock); } finally { await feed.stop(); }
  assert.equal(clock.jobCount(), 0, 'stop removes retry and deadline timers');
}
async function cadenceAndExpiry() {
  let calls = 0, fail = false;
  await withFeed(() => { calls++; if (fail) throw new Error(PRIVATE_ERROR); return response(); },
    async (feed, clock) => {
      feed.start(); feed.start();
      const pending = feed.refresh();
      assert.equal(feed.refresh(), pending, 'callers share the in-flight Promise');
      await pending;
      assert.equal(feed.pending, null, 'ownership is released before callers resume');
      const original = feed.snapshot();
      for (let i = 0; i < 1000; i++) { feed.snapshot(); feed.health(); }
      assert.equal(calls, 1, 'cache reads and health never perform network IO');
      fail = true;
      await clock.tick(59_999); assert.equal(calls, 1);
      await clock.tick(1); assert.equal(calls, 2, 'automatic refresh is once per minute');
      assert.deepEqual(feed.snapshot(), original, 'failure cannot extend cached lifetime');
      assert.equal(feed.health().status, 'READY');
      assert.ok(!JSON.stringify(feed.health()).includes(PRIVATE_ERROR));
      await clock.tick(240_000);
      assert.equal(feed.snapshot(), null, 'cache expires at original deadline');
      assert.equal(feed.health().status, 'STALE');
      fail = false; await clock.tick(60_000);
      assert.equal(feed.health().status, 'READY');
      assert.equal(feed.health().lastErrorCode, null);
      assert.equal(feed.health().consecutiveFailures, 0);
      assert.equal(feed.health().successes, 2);
    });
}
async function syncFailureAndUnavailableFetch() {
  let calls = 0;
  await withFeed(() => { if (++calls <= 2) throw new Error(PRIVATE_ERROR); return response('101'); },
    async (feed, clock) => {
      feed.start(); await feed.refresh();
      assert.equal(feed.pending, null, 'sync throw must not strand a resolved pending Promise');
      assert.equal(feed.health().refreshing, false);
      assert.equal(feed.health().lastErrorCode, 'SOL_USD_REQUEST_FAILED');
      await clock.tick(60_000);
      assert.equal(calls, 2, 'sync failure retries automatically');
      assert.equal(feed.health().consecutiveFailures, 2);
      await clock.tick(60_000);
      assert.equal(calls, 3); assert.equal(feed.snapshot().priceUsd, 101);
      assert.equal(feed.health().attempts, 3); assert.equal(feed.health().failures, 2);
      assert.equal(feed.health().successes, 1); assert.equal(feed.health().consecutiveFailures, 0);
    });
  await withFeed(null, async (feed, clock) => {
    feed.start(); await feed.refresh();
    assert.equal(feed.health().lastErrorCode, 'SOL_USD_FETCH_UNAVAILABLE');
    assert.equal(feed.health().refreshing, false);
    feed.fetch = () => response(); await clock.tick(60_000);
    assert.equal(feed.health().ready, true); assert.equal(feed.health().attempts, 2);
  });
}
async function hardDeadlineEvenWithoutAbortSupport() {
  let calls = 0, signal;
  await withFeed((_url, options) => {
    calls++; signal = options.signal;
    return calls === 1 ? new Promise(() => {}) : response('103');
  }, async (feed, clock) => {
    feed.start(); let settled = false;
    assert.equal(feed.health().requestTimeoutMs, 3_000, 'default hard deadline is three seconds');
    assert.equal(feed.health().refreshIntervalMs, 60_000, 'default refresh is one minute');
    feed.refresh().then(() => { settled = true; });
    await clock.tick(2_999); assert.equal(settled, false);
    assert.equal(feed.health().pendingAgeMs, 2_999);
    await clock.tick(1);
    assert.equal(settled, true, 'hard deadline settles refresh even when fetch ignores abort');
    assert.equal(signal.aborted, true); assert.equal(feed.pending, null);
    assert.equal(feed.health().pendingSince, null);
    assert.equal(feed.health().lastErrorCode, 'SOL_USD_REQUEST_TIMEOUT');
    assert.equal(feed.health().timeouts, 1); assert.equal(feed.health().failures, 1);
    await clock.tick(57_000);
    assert.equal(calls, 2, 'abandoned transport does not block the next scheduled request');
    assert.equal(feed.snapshot().priceUsd, 103);
  });
}
async function bodyTimeoutAndLateCompletion(rejectBody) {
  const body = deferred(); let calls = 0;
  const unhandled = [];
  const onUnhandled = error => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
  await withFeed(() => ++calls === 1 ? response('1', { json: () => body.promise }) : response('105'),
    async (feed, clock) => {
      feed.start(); let settled = false;
      feed.refresh().then(() => { settled = true; }); await flush();
      await clock.tick(3_000);
      assert.equal(settled, true, 'deadline covers body parsing, not only HTTP headers');
      assert.equal(feed.health().lastErrorCode, 'SOL_USD_REQUEST_TIMEOUT');
      await feed.refresh(); const saved = feed.snapshot(); assert.equal(saved.priceUsd, 105);
      if (rejectBody) body.reject(new Error(PRIVATE_ERROR));
      else body.resolve({ data: { base: 'SOL', currency: 'USD', amount: '999' } });
      await flush(); await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(feed.snapshot(), saved, 'late body cannot overwrite newer cache');
      assert.equal(feed.health().successes, 1); assert.equal(feed.health().timeouts, 1);
      assert.deepEqual(unhandled, [], 'abandoned response body cannot produce unhandled rejection');
    });
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
}
async function oldResultCannotClearNewRequest(rejectOld) {
  const old = deferred(), fresh = deferred(); let calls = 0;
  await withFeed(() => ++calls === 1 ? old.promise : fresh.promise, async (feed, clock) => {
    feed.start(); await clock.tick(3_000);
    const pending = feed.refresh(), pendingSince = feed.health().pendingSince;
    if (rejectOld) old.reject(new Error(PRIVATE_ERROR)); else old.resolve(response('999'));
    await flush();
    assert.equal(feed.pending, pending, 'old finalizer cannot clear new request ownership');
    assert.equal(feed.health().refreshing, true); assert.equal(feed.health().pendingSince, pendingSince);
    assert.equal(feed.snapshot(), null); assert.equal(feed.health().attempts, 2);
    assert.equal(feed.health().failures, 1, 'late rejection cannot double-count failure');
    fresh.resolve(response('106')); await pending;
    assert.equal(feed.pending, null); assert.equal(feed.snapshot().priceUsd, 106);
    assert.equal(feed.health().lastError, null);
  });
}
async function stopAndRestartOwnership() {
  const old = deferred(), fresh = deferred(); let calls = 0, signal;
  await withFeed((_url, options) => {
    if (++calls === 1) { signal = options.signal; return old.promise; }
    return fresh.promise;
  }, async (feed, clock) => {
    feed.start(); let settled = false;
    feed.refresh().then(() => { settled = true; }); await feed.stop(); await flush();
    assert.equal(settled, true, 'stop cannot wait for an uncooperative transport');
    assert.equal(signal.aborted, true); assert.equal(feed.pending, null);
    assert.equal(feed.health().status, 'STOPPED'); assert.equal(clock.jobCount(), 0);
    await clock.tick(180_000); assert.equal(calls, 1, 'stopped interval cannot restart requests');
    feed.start(); const pending = feed.refresh(); old.resolve(response('999')); await flush();
    assert.equal(feed.pending, pending, 'stopped generation cannot release restarted generation');
    assert.equal(feed.snapshot(), null); fresh.resolve(response('107')); await pending;
    assert.equal(feed.snapshot().priceUsd, 107);
  });
}
async function invalidResponsesAndRedaction() {
  const cases = [
    { value: response('1', { ok: false, status: 429, statusText: PRIVATE_ERROR }),
      code: 'SOL_USD_HTTP_ERROR', status: 429 },
    { value: response('1', { ok: false, status: PRIVATE_ERROR }), code: 'SOL_USD_HTTP_ERROR', status: null },
    { value: response('1', { json: () => { throw new Error(PRIVATE_ERROR); } }),
      code: 'SOL_USD_RESPONSE_INVALID', status: 200 },
    ...[['BTC', 'USD'], ['SOL', 'EUR']].map(([base, currency]) => ({
      value: response('1', { json: async () => ({ data: { base, currency, amount: '100' } }) }),
      code: 'SOL_USD_RESPONSE_INVALID', status: 200 })),
    ...['NaN', 'Infinity', '0', '-100', null, '', true, [100], { value: 100 }].map(amount => ({ value: response(amount),
      code: 'SOL_USD_RESPONSE_INVALID', status: 200 })),
  ];
  for (const item of cases) await withFeed(() => item.value, async feed => {
    feed.start(); await feed.refresh(); const health = feed.health();
    assert.equal(feed.snapshot(), null); assert.equal(health.lastError, 'SOL_USD_REFERENCE_REFRESH_FAILED');
    assert.equal(health.lastErrorCode, item.code); assert.equal(health.lastHttpStatus, item.status);
    assert.equal(health.status, 'UNAVAILABLE'); assert.equal(health.refreshing, false);
    assert.equal(health.failures, 1); assert.ok(!JSON.stringify(health).includes(PRIVATE_ERROR));
  });
}
async function overdueResultAndConfigBounds() {
  const request = deferred();
  await withFeed(() => request.promise, async (feed, clock) => {
    feed.start(); const pending = feed.refresh();
    clock.jump(3_001); // Deadline callback delayed by a blocked event loop.
    request.resolve(response('999')); await pending;
    assert.equal(feed.snapshot(), null, 'late success refused even before delayed timeout callback runs');
    assert.equal(feed.health().lastErrorCode, 'SOL_USD_REQUEST_TIMEOUT'); assert.equal(feed.health().timeouts, 1);
  });
  let calls = 0;
  await withFeed(() => { calls++; return response(); }, async (feed, clock) => {
    feed.start(); await feed.refresh(); await clock.tick(180_000);
    assert.equal(calls, 0); assert.equal(feed.health().status, 'DISABLED');
    assert.equal(feed.health().attempts, 0);
  }, { enabled: false });
  await withFeed(() => response(), async feed => {
    assert.equal(feed.health().refreshIntervalMs, 60_000, 'configuration cannot enable high-frequency scanning');
    assert.equal(feed.health().requestTimeoutMs, 1_000);
  }, { refreshMs: 1, requestTimeoutMs: 1 });
  await withFeed(() => response(), async feed => {
    assert.equal(feed.health().requestTimeoutMs, 30_000, 'configuration cannot disable bounded deadlines');
  }, { requestTimeoutMs: 999_999 });
}
async function main() {
  await legacyCacheChecks();
  await cadenceAndExpiry();
  await syncFailureAndUnavailableFetch();
  await hardDeadlineEvenWithoutAbortSupport();
  await bodyTimeoutAndLateCompletion(false);
  await bodyTimeoutAndLateCompletion(true);
  await oldResultCannotClearNewRequest(false);
  await oldResultCannotClearNewRequest(true);
  await stopAndRestartOwnership();
  await invalidResponsesAndRedaction();
  await overdueResultAndConfigBounds();
  console.log('test-sol-usd-reference: ok (offline cache, retry, deadline, shutdown and ownership regressions)');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
