'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GracefulShutdown, createSignalShutdown } = require('../src/runtime/GracefulShutdown');
const { SmartWalletRegistry } = require('../src/core/SmartWalletRegistry');

async function main() {
  const calls = [];
  let finish;
  let failDrain = true;
  const gate = new Promise((resolve) => { finish = resolve; });
  const coordinator = new GracefulShutdown([
    ['PRODUCERS', async () => { calls.push('producers'); await gate; }],
    ['DRAIN', () => { calls.push('drain'); if (failDrain) throw Object.assign(new Error('locked'), { code: 'FLOW_DB_DRAIN_TIMEOUT' }); }],
    ['CLOSE', () => { calls.push('close'); }],
  ]);
  const first = coordinator.stop('SIGTERM');
  assert.strictEqual(coordinator.stop('SIGINT'), first);
  finish();
  await assert.rejects(first, { code: 'FLOW_DB_DRAIN_TIMEOUT' });
  assert.deepEqual(calls, ['producers', 'drain']);
  assert.equal(coordinator.state.status, 'STOP_FAILED');
  assert.equal(coordinator.state.stage, 'DRAIN');
  failDrain = false;
  await coordinator.stop('SIGTERM');
  await coordinator.stop('SIGTERM');
  assert.deepEqual(calls, ['producers', 'drain', 'drain', 'close']);
  assert.equal(coordinator.state.status, 'STOPPED');

  let attempts = 0;
  let held = 0;
  let released = 0;
  let exits = [];
  const request = createSignalShutdown({
    stop: async () => { attempts++; if (attempts === 1) throw new Error('pending writes'); },
    exit: (code) => exits.push(code), hold: () => { held++; return 123; }, release: () => released++,
  });
  const one = request('SIGTERM');
  assert.strictEqual(request('SIGINT'), one);
  await one;
  assert.deepEqual(exits, [], 'failed drain must not exit into automatic supervisor restart');
  assert.equal(held, 1);
  assert.equal(released, 0, 'failed shutdown must keep a live handle even if all producers stopped');
  await request('SIGTERM');
  await request('SIGTERM');
  assert.equal(attempts, 2);
  assert.deepEqual(exits, [0]);
  assert.equal(released, 1);

  let finishWorker;
  let finishAge;
  let walletStopped = false;
  const registry = Object.create(SmartWalletRegistry.prototype);
  Object.assign(registry, {
    maintenanceWorker: { worker: { terminate: () => new Promise((resolve) => { finishWorker = resolve; }) } },
    maintenanceQueue: [], maintenancePendingTypes: new Set(), ageAbortControllers: new Set(),
    historyAbortControllers: new Set(), labels: new Map(), labelsByMint: new Map(),
    pnlSnapshotCache: new Map(), lastSeenWrites: new Map(), historyBackfills: new Map(),
    ageChecks: new Map([['wallet', new Promise((resolve) => { finishAge = resolve; })]]),
  });
  const walletStop = registry.stop().then(() => { walletStopped = true; });
  await Promise.resolve();
  finishWorker();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(walletStopped, false, 'wait for in-flight age/history continuations before closing DB');
  finishAge();
  await walletStop;
  registry.store = { db: { prepare: () => { throw new Error('late DB access'); } } };
  assert.equal(registry._recordAgeResult('wallet', {}, Date.now()), null);

  let terminations = 0;
  registry.stopPromise = null;
  registry.maintenanceWorker = { worker: { terminate: async () => {
    terminations++;
    if (terminations === 1) throw new Error('termination failed');
  } } };
  await assert.rejects(registry.stop());
  assert.ok(registry.maintenanceWorker, 'retain worker ownership after failed termination');
  await registry.stop();
  assert.equal(terminations, 2);
  assert.equal(registry.maintenanceWorker, null);

  const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.ok(source.indexOf("process.on('SIGTERM'") < source.indexOf('runtime = createRuntime(config)'));
  assert.ok(source.includes('await startupFinished;'), 'signal during startup must not race start/stop');
  assert.ok(source.indexOf("['DRAIN_DATABASE'") < source.indexOf("['CLOSE_DATABASE'"));
  assert.ok(source.includes('if (!stopRequested) await runtime.start();'));
  assert.ok(!source.includes('process.exit(1)'), 'failed graceful stop must not force process exit');

  const { createRuntime } = require('../src/index');
  const { config } = require('../src/config');
  const runtimeConfig = { ...config, storage: { ...config.storage, dbPath: ':memory:' },
    liveTrading: { ...config.liveTrading, enabled: false, dryRun: true },
    server: { ...config.server, host: '127.0.0.1', port: 0 } };
  for (const [key, value] of Object.entries(runtimeConfig)) {
    if (/Shadow|Registry|Observer|Audit|Overlay|preEntryRugRisk/.test(key) && value && typeof value === 'object') {
      runtimeConfig[key] = { ...value, enabled: false };
    }
  }
  // No socket or RPC is opened: only the real runtime lifecycle is exercised.
  const originalLog = console.log;
  console.log = () => {};
  try {
    const app = createRuntime(runtimeConfig);
    assert.equal(app.trader.health({ includeDatabase: false }).pendingActions, 0);
    let finishDashboard;
    app.server.start = () => new Promise((resolve) => { finishDashboard = resolve; });
    app.server.stop = async () => {};
    app.stream.start = () => { throw new Error('stream started after stop'); };
    const starting = app.start();
    const stopping = app.stop();
    finishDashboard();
    await Promise.all([starting, stopping]);
    assert.equal(app.store.db.open, false);

    const app2 = createRuntime(runtimeConfig);
    let finishStream;
    let streamCancelled = false;
    app2.server.start = async () => {};
    app2.server.stop = async () => {};
    app2.stream.start = () => new Promise((resolve) => { finishStream = resolve; });
    app2.stream.stop = async () => { streamCancelled = true; };
    app2.store.startHealthSampler = () => { throw new Error('sampler restarted after close'); };
    const starting2 = app2.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof finishStream, 'function');
    await app2.stop();
    assert.equal(streamCancelled, true, 'cancel pending network startup without waiting for connect');
    assert.equal(app2.store.db.open, false);
    finishStream();
    await starting2;
  } finally { console.log = originalLog; }
  console.log('Graceful shutdown tests passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
