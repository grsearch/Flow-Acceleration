'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const ResearchServer = require('../src/server/server');
const { DashboardQueryRunner } = require('../src/server/DashboardQueryRunner');

function get(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: route, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(3000, () => request.destroy(new Error('HTTP test timeout')));
    request.on('error', reject);
  });
}

async function main() {
  let workerCount = 0;
  const workers = [];
  const runner = new DashboardQueryRunner({ dbPath: 'not-opened-by-test' }, {
    maxEntries: 2, timeoutMs: 40, workerFactory: () => {
      workerCount += 1;
      const worker = new EventEmitter();
      worker.terminate = async () => { worker.terminated = true; };
      workers.push(worker);
      return worker;
    },
  });
  assert.equal((await runner.query('backtest', { id: 1 }, { firstWaitMs: 1 })).dashboardQuery.status, 'PREPARING');
  assert.equal((await runner.query('backtest', { id: 2 }, { firstWaitMs: 1 })).dashboardQuery.status, 'BUSY');
  const same = runner.query('backtest', { id: 1 }, { firstWaitMs: 20 });
  workers[0].emit('message', { ok: true, value: { trades: 25 } });
  assert.equal((await same).trades, 25);
  assert.equal(workerCount, 1, 'identical requests share a job; other arguments do not add workers');
  assert.equal((await runner.query('backtest', { id: 1 })).dashboardQuery.status, 'READY');
  for (const id of [2, 3]) {
    const pending = runner.query('backtest', { id });
    workers.at(-1).emit('message', { ok: true, value: { trades: id } });
    await pending;
  }
  assert.equal(runner.cache.size, 2);
  const timed = await runner.query('backtest', { id: 4 }, { firstWaitMs: 100 });
  assert.equal(timed.dashboardQuery.status, 'ERROR');
  assert.equal(workers.at(-1).terminated, true);
  await runner.stop();

  let terminateFinished;
  let delayedCount = 0;
  const delayed = new DashboardQueryRunner({ dbPath: 'fixture' }, { timeoutMs: 5,
    workerFactory: () => {
      delayedCount += 1;
      const worker = new EventEmitter();
      worker.terminate = () => new Promise((resolve) => { terminateFinished = resolve; });
      return worker;
    } });
  assert.equal((await delayed.query('backtest', { id: 1 })).dashboardQuery.status, 'ERROR');
  assert.equal((await delayed.query('backtest', { id: 2 })).dashboardQuery.status, 'BUSY');
  assert.equal(delayedCount, 1, 'native work still terminating must occupy its lane');
  terminateFinished();
  await delayed.stop();

  const snapshot = { value: { marker: 'persisted-only', stats: { positions: 999 },
    cohorts: [{ count: 999 }], positions: Array.from({ length: 50 }, (_, id) => ({ id })) },
  generatedAt: Date.now() - 60_000, durationMs: 22, status: 'STALE', ageMs: 60_000 };
  const noDatabase = new Proxy({ config: { dbPath: ':memory:' },
    healthSnapshot: () => ({ writeStatus: 'OK' }) }, {
    get(target, key) { if (key in target) return target[key]; throw new Error(`Forbidden HTTP DB access: ${String(key)}`); },
  });
  const server = new ResearchServer({
    config: { storage: { dbPath: ':memory:' }, dashboardCache: { enabled: false }, smartWallets: [],
      server: { host: '127.0.0.1', port: 0 }, liveTrading: { strategies: [
        { id: 'ho500', code: 'HO500-X60', enabled: true, entryEnabled: true, positionSizeSol: 0.1 },
        { id: 'disabled', enabled: false, entryEnabled: false },
      ] } },
    runtimeIdentity: { gitCommit: 'fixture', configurationIntegrity: { status: 'MISMATCH', mismatchedFiles: ['src/config.js'] } },
    runtimeSnapshotState: () => ({ status: 'STALE', ageMs: 30000 }),
    store: noDatabase, engine: { stats: () => ({}) }, labeler: { stats: () => ({}) },
    stream: { health: () => ({ regions: [{ state: 'connected' }] }) },
  });
  server.dashboardReadModel = { enabled: true, read: () => snapshot,
    start() {}, async stop() {}, health: () => ({ mode: 'MEMORY_TEST' }) };
  await server.start();
  try {
    const port = server.httpServer.address().port;
    const catalog = JSON.parse((await get(port, '/api/strategy-status')).body);
    assert.equal(catalog.live[0].code, 'HO500-X60');
    assert.equal(catalog.live[0].positionSizeSol, 0.1);
    assert.equal(catalog.live[1].enabled, false);
    assert.equal(catalog.configurationIntegrity.status, 'MISMATCH');
    const routes = ['big-winner-shadow', 'smart-like-early-shadow', 'smart-resonance-shadow',
      'smart-consensus-v2-shadow', 'smart-wallet-rug-escape-shadow', 'smart-first-open-right-tail-shadow',
      'individual-smart-wallet-shadows', 'public-flow-lead-shadow', 'cya-slot-flow-shadow',
      'public-flow-recovery-shadow', 'creator-affinity-shadow', 'feature-edge-audit',
      'post-migration-survivor', 'cya-organic-burst-shadow', 'early-pure-buy-burst-shadow',
      'same-slot-dump-backrun-shadow', 'launch-pullback-shadow', 'migration-second-leg-observer',
      'primary-signal-shadow', 'flow-first-shadow', 'smart-pullback-shadow', 'smart-open-shadow',
      'launch-quality-observer', 'migrated-drop-rebound-shadow', 'holder-growth-shadow',
      'quality-leader-shadow', 'migration-continuity-shadow', 'bonding-curve-momentum-shadow',
      'range-scalper-shadow', 'flow-smart-confirm-shadow', 'cya-early-pyramid-shadow',
      'graduation-hold-shadow', 'graduation-acceleration-shadow', 'live-trading?strategyId=ho500&'];
    for (const route of routes) {
      const url = `/api/${route}${route.includes('?') ? '' : '?'}positionLimit=2`;
      const response = await get(port, url);
      assert.equal(response.status, 200, `${url}: ${response.body}`);
      const value = JSON.parse(response.body);
      assert.equal(value.marker, 'persisted-only', url);
      assert.equal(value.positions.length, 2, url);
      assert.equal(value.stats.positions, 999, 'transport trimming must never alter accounting');
      assert.equal(value.dashboardSnapshot.status, 'STALE', url);
    }
    assert.equal(snapshot.value.positions.length, 50, 'cache remains immutable');
    const health = JSON.parse((await get(port, '/api/health')).body);
    assert.equal(health.status, 'stale');
    assert.equal(JSON.parse((await get(port, '/health')).body).ready, false);
    const plain = await get(port, '/');
    const compressed = await get(port, '/', { 'Accept-Encoding': 'gzip' });
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.ok(compressed.body.length < plain.body.length / 2, 'compress the large HTML transport');
    assert.deepEqual(zlib.gunzipSync(compressed.body), plain.body);
    assert.equal((await get(port, '/', { 'If-None-Match': plain.headers.etag })).status, 304);
    assert.equal((await get(port, '/dashboard-runtime.js')).status, 200);
    const jsonGzip = await get(port, '/api/strategy-status', { 'Accept-Encoding': 'gzip' });
    assert.equal(JSON.parse(zlib.gunzipSync(jsonGzip.body)).live[0].id, 'ho500');
  } finally { await server.stop(); }
  console.log('Dashboard HTTP isolation, freshness, catalog, compression and bounded query tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
