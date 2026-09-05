'use strict';

// Only fixture SQLite databases and a loopback HTTP child are used. No runtime,
// stream, executor, wallet signing, remote network, or service control is started.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');
const { Worker } = require('worker_threads');
const { once, EventEmitter } = require('events');
const Database = require('better-sqlite3');
const { config } = require('../src/config');
const { ResearchStore } = require('../src/data/ResearchStore');
const { DashboardProcessServer, collectRuntime, childEnvironment } = require('../src/server/DashboardProcessServer');

function request(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: route,
      headers: { 'accept-encoding': 'identity', connection: 'close' }, timeout: 5_000 }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text,
        json: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('loopback request timed out')));
  });
}

async function waitFor(check, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < end);
  throw new Error('fixture condition timed out');
}

function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

async function testUnresponsiveChildStop() {
  // No OS process is killed here. Simulate a native worker/HTTP connection that
  // ignores graceful STOP and SIGTERM, using an accelerated shutdown timer.
  for (const connected of [true, false]) {
    const child = new EventEmitter();
    const signals = [];
    child.connected = connected;
    child.send = () => {};
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL') {
        queueMicrotask(() => {
          child.signalCode = signal;
          child.emit('exit', null, signal);
        });
      }
      return true;
    };
    const wrapper = new DashboardProcessServer({ config: {} });
    wrapper.child = child;
    const originalTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, Math.min(ms, 15), ...args);
    try { await wrapper.stop(); } finally { global.setTimeout = originalTimeout; }
    assert(signals.includes('SIGKILL'), 'unresponsive or disconnected child must be forcibly reaped, not forgotten');
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(wrapper.child, null);
  }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-dashboard-process-'));
  const dbPath = path.join(directory, 'source.db');
  const settings = { dbPath, archiveDir: directory, flushMs: 60_000, flushMax: 100,
    rawShardingEnabled: false, busyTimeoutMs: 50 };
  const fixture = new ResearchStore(settings, { configuredTradingCostPct: 0 });
  fixture.ensureToken('process-fixture-mint');
  fixture.queueRawTrade({ timestampMs: Date.now(), receivedAtMs: Date.now(), signature: 'fixture-signature',
    market: 'PUMP_AMM', mint: 'process-fixture-mint', side: 'BUY', solAmount: 0.1, tokenAmount: 10, price: 0.01 });
  fixture.flushRawTrades();
  fixture.close();

  const secret = 'DO_NOT_SEND_DASHBOARD_TEST_SECRET';
  const previousSecret = process.env.FLOW_LIVE_PRIVATE_KEY;
  process.env.FLOW_LIVE_PRIVATE_KEY = secret;
  let locker;
  let wrapper;
  let probe;
  try {
    assert.equal(childEnvironment().FLOW_LIVE_PRIVATE_KEY, undefined);
    const copiedConfig = { ...config, storage: { ...config.storage, ...settings },
      dashboardCache: { ...config.dashboardCache, enabled: true, dbPath: path.join(directory, 'dashboard.db'),
        runtimeRefreshMs: 60_000, fastRefreshMs: 60_000, shadowRefreshMs: 60_000, slowRefreshMs: 60_000 },
      server: { host: '127.0.0.1', port: 0 },
      liveTrading: { ...config.liveTrading, enabled: false, privateKey: secret, rpcUrl: `http://127.0.0.1/?api-key=${secret}` },
      stream: { ...config.stream, heliusToken: secret, allenHarkToken: secret },
    };
    const pending = Object.freeze([{ signature: 'must-remain-queued' }]);
    const options = { config: copiedConfig,
      runtimeIdentity: { headCommit: 'a'.repeat(40), configurationIntegrity: { status: 'MATCH' } },
      store: { rawBuffer: pending, healthSnapshot: () => ({ writeStatus: 'HEALTHY', pendingWrites: 1,
        queuedTradeLagMs: 0, lastWriteSuccessAt: Date.now() }),
      flushRawTrades: () => { throw new Error('Dashboard may not flush the parent queue'); } },
      engine: { stats: () => ({ lastTradeAt: Date.now(), trades: 1 }) },
      stream: { health: () => ({ regions: [{ state: 'connected' }], transactionsReceived: 1 }) },
      labeler: { stats: () => ({ labels: 0 }) },
    };
    let initPacket;
    wrapper = new DashboardProcessServer(options, { forkFactory(file, args, childOptions) {
      assert.equal(childOptions.env.FLOW_LIVE_PRIVATE_KEY, undefined);
      assert.equal(childOptions.windowsHide, true);
      const child = fork(file, args, childOptions);
      const send = child.send.bind(child);
      child.send = (packet, ...rest) => {
        if (packet.type === 'INIT') initPacket = packet;
        return send(packet, ...rest);
      };
      return child;
    } });

    // Hold the main database's write reservation: a second ResearchStore writer
    // must not be necessary for child startup, health, assets or cache reads.
    locker = new Database(dbPath);
    locker.exec('BEGIN IMMEDIATE');
    const sourceHash = digest(dbPath);
    const sourceVersion = locker.pragma('data_version', { simple: true });
    await wrapper.start();
    assert(wrapper.child.pid && wrapper.child.pid !== process.pid, 'must run in a distinct OS process');
    assert(!JSON.stringify(initPacket).includes(secret), 'only sanitized config may cross IPC');
    assert.equal(initPacket.config.stream, undefined, 'child has no need for provider configuration');
    assert.equal(initPacket.config.liveTrading.rpcUrl, undefined);
    assert.equal(initPacket.config.liveTrading.privateKey, undefined);
    assert.equal(initPacket.snapshot.database.pendingWrites, 1);
    assert.strictEqual(options.store.rawBuffer, pending);
    assert.equal(wrapper.health().mode, 'INDEPENDENT_HTTP_PROCESS');
    const page = await request(wrapper.port, '/');
    assert.equal(page.status, 200);
    assert.equal(page.text, fs.readFileSync(path.join(__dirname, '../src/server/public/index.html'), 'utf8'),
      'child must serve the actual deployed public directory');
    const health = await request(wrapper.port, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.ready, true);
    assert.equal(health.json.runtimeSnapshot.mode, 'INDEPENDENT_HTTP_PROCESS');
    assert.equal(health.json.runtimeSnapshot.dashboardPid, wrapper.child.pid);
    const detailed = await request(wrapper.port, '/api/health');
    assert.equal(detailed.json.status, 'streaming');
    assert.equal(detailed.json.database.pendingWrites, 1);
    assert.equal(detailed.json.dashboardReadModel.mode, 'INDEPENDENT_READ_MODEL');
    const missing = await request(wrapper.port, '/api/not-a-real-test-route');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'api route not found');
    await waitFor(async () => (await request(wrapper.port, '/api/health')).json.dashboardReadModel.snapshots > 0);
    assert(fs.existsSync(path.join(directory, 'dashboard.db')), 'only the distinct cache database may be written');

    // A separate requester records completion while this test/parent event loop
    // is deliberately blocked. Receipt after unblock alone would prove nothing.
    probe = new Worker(`
      const { parentPort, workerData } = require('worker_threads');
      const http = require('http');
      parentPort.postMessage({ type: 'ARMED' });
      setTimeout(() => {
        const startedAt = Date.now();
        const req = http.get({ hostname: '127.0.0.1', port: workerData.port, path: '/health',
          headers: { connection: 'close' }, timeout: 1200 }, (res) => {
          let text = ''; res.on('data', chunk => { text += chunk; });
          res.on('end', () => parentPort.postMessage({ type: 'RESULT', startedAt, finishedAt: Date.now(),
            status: res.statusCode, ready: JSON.parse(text).ready }));
        });
        req.on('error', error => parentPort.postMessage({ type: 'RESULT', error: error.message }));
        req.on('timeout', () => req.destroy(new Error('child blocked with parent')));
      }, 150);
    `, { eval: true, workerData: { port: wrapper.port } });
    const [armed] = await once(probe, 'message');
    assert.equal(armed.type, 'ARMED');
    const responseDuringBlock = once(probe, 'message');
    const blockStart = Date.now();
    while (Date.now() - blockStart < 2_000) { /* Deliberate parent-only starvation. */ }
    const blockEnd = Date.now();
    const [during] = await responseDuringBlock;
    assert(!during.error, during.error);
    assert.equal(during.status, 200);
    assert.equal(during.ready, true);
    assert(during.startedAt >= blockStart && during.finishedAt < blockEnd,
      'HTTP response must actually complete while the parent event loop is blocked');
    await probe.terminate();
    probe = null;

    const stale = collectRuntime(options);
    stale.at = Date.now() - 30_000;
    wrapper.child.send({ type: 'RUNTIME', snapshot: stale });
    await waitFor(async () => (await request(wrapper.port, '/health')).json.runtimeSnapshot.status === 'STALE');
    const staleHealth = await request(wrapper.port, '/health');
    assert.equal(staleHealth.json.ready, false, 'old streaming snapshot must not imply readiness');
    assert.equal((await request(wrapper.port, '/api/health')).json.status, 'stale');
    assert.strictEqual(options.store.rawBuffer, pending);

    const incomplete = collectRuntime(options);
    delete incomplete.sections.stream;
    incomplete.errors = ['stream'];
    wrapper.child.send({ type: 'RUNTIME', snapshot: incomplete });
    await waitFor(async () => (await request(wrapper.port, '/health')).json.runtimeSnapshot.errors.includes('stream'));
    const incompleteHealth = await request(wrapper.port, '/api/health');
    assert.equal(incompleteHealth.status, 200, 'missing runtime section must not turn health into a 500');
    assert.equal(incompleteHealth.json.status, 'stale');
    assert.equal((await request(wrapper.port, '/health')).json.ready, false);

    assert.equal(digest(dbPath), sourceHash, 'child must not mutate source SQLite bytes');
    assert.equal(locker.pragma('data_version', { simple: true }), sourceVersion);
    assert.equal(locker.prepare('SELECT COUNT(*) n FROM raw_trades').get().n, 1);
    const child = wrapper.child;
    await wrapper.stop();
    assert.equal(wrapper.child, null);
    assert(child.exitCode !== null || child.signalCode !== null, 'stop must reap the HTTP child');
    wrapper = null;
    await testUnresponsiveChildStop();
    console.log('test-dashboard-process-server: ok (real child, read-only source, secret isolation, static assets, parent starvation, stale readiness, clean stop)');
  } finally {
    if (probe) await probe.terminate();
    if (wrapper) await wrapper.stop();
    if (locker) { locker.exec('ROLLBACK'); locker.close(); }
    if (previousSecret === undefined) delete process.env.FLOW_LIVE_PRIVATE_KEY;
    else process.env.FLOW_LIVE_PRIVATE_KEY = previousSecret;
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('flow-dashboard-process-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
