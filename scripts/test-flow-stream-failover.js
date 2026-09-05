'use strict';

const assert = require('assert');
const PumpFlowStream = require('../src/core/PumpFlowStream');
const { RegionConnection } = PumpFlowStream;

const LAX = 'https://laserstream-mainnet-lax.helius-rpc.com';
const SLC = 'https://laserstream-mainnet-slc.helius-rpc.com';

function testConfig(overrides = {}) {
  return {
    pump: {
      programId: 'pump-program',
      ammProgramId: 'amm-program',
    },
    stream: {
      endpoints: [LAX, SLC],
      reconnectMinMs: 5,
      reconnectMaxMs: 10,
      staleTimeoutMs: 10_000,
      staleCheckMs: 1_000,
      dedupTtlMs: 300_000,
      dedupMax: 1_000,
      ...overrides,
    },
  };
}

function fakeConnections({ connectedAtOffsetMs = 0 } = {}) {
  const instances = [];
  let activeCount = 0;
  let maxActiveCount = 0;

  function factory(options) {
    const connection = {
      ...options,
      connected: false,
      connectedAt: null,
      lastMessageAt: null,
      stopCalls: 0,
      mints: new Set(),
      async setAmmMints(mints) {
        this.mints = new Set(mints);
      },
      async start() {
        this.connected = true;
        this.connectedAt = Date.now() - (instances[0] === this ? connectedAtOffsetMs : 0);
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        options.onState(options.label, {
          state: 'connected',
          connectedAt: this.connectedAt,
        });
        return true;
      },
      async stop() {
        this.stopCalls += 1;
        if (this.connected) activeCount -= 1;
        this.connected = false;
      },
      fail(phase = 'stream') {
        if (!this.connected) return;
        this.connected = false;
        activeCount -= 1;
        const error = new Error(`${options.label} failed`);
        options.onError(error, options.label, phase);
        options.onUnavailable(this, error, phase);
      },
      markStale(staleForMs) {
        if (!this.connected) return;
        this.connected = false;
        activeCount -= 1;
        const error = new Error(`stale for ${staleForMs}ms`);
        options.onError(error, options.label, 'stale');
        options.onUnavailable(this, error, 'stale');
      },
    };
    instances.push(connection);
    return connection;
  }

  return {
    factory,
    instances,
    maxActiveCount: () => maxActiveCount,
  };
}

async function waitFor(predicate, message, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function testDisconnectFailover() {
  const fakes = fakeConnections();
  const stream = new PumpFlowStream({
    config: testConfig(),
    tokenForEndpoint: (endpoint) => `token:${endpoint}`,
    connectionFactory: fakes.factory,
  });

  await stream.start();
  assert.strictEqual(fakes.instances.length, 1);
  assert.strictEqual(fakes.instances[0].endpoint, LAX);
  assert.strictEqual(stream.health().activeEndpoint, LAX);
  assert.strictEqual(stream.health().regions.filter((region) => region.active).length, 1);

  fakes.instances[0].fail();
  await waitFor(() => fakes.instances.length === 2, 'standby endpoint was not activated');

  const health = stream.health();
  assert.strictEqual(fakes.instances[1].endpoint, SLC);
  assert.strictEqual(fakes.instances[0].stopCalls, 1);
  assert.strictEqual(fakes.maxActiveCount(), 1);
  assert.strictEqual(health.activeEndpoint, SLC);
  assert.strictEqual(health.failovers, 1);
  assert.strictEqual(health.duplicatesDropped, 0);
  assert.strictEqual(health.regions.find((region) => region.label === 'FLOW-1').state, 'standby');
  assert.strictEqual(health.regions.find((region) => region.label === 'FLOW-2').state, 'connected');

  await stream.stop();
}

async function testStaleFailover() {
  const fakes = fakeConnections();
  const stream = new PumpFlowStream({
    config: testConfig({ staleTimeoutMs: 20, staleCheckMs: 5 }),
    tokenForEndpoint: () => 'token',
    connectionFactory: fakes.factory,
  });

  try {
    await stream.start();
    // Drive watchdog time explicitly. A 5ms real timer can fire every 15–16ms
    // on Windows, correctly crossing this fixture's 10ms event-loop deferral
    // threshold and making an otherwise healthy test host defer every check.
    clearInterval(stream.watchdogTimer);
    stream.watchdogTimer = null;
    fakes.instances[0].connectedAt = 1_000;
    stream.lastWatchdogCheckAt = 1_014;
    stream._checkStale(1_019);
    assert.strictEqual(stream.health().staleFailovers, 0,
      'activity inside the stale timeout must not fail over');
    assert.strictEqual(fakes.instances[0].connected, true);

    stream._checkStale(1_024);
    assert.strictEqual(stream.health().watchdogEventLoopDeferrals, 0);
    await waitFor(() => fakes.instances.length === 2, 'stale connection did not fail over');
    assert.strictEqual(stream.health().activeEndpoint, SLC);
    assert.strictEqual(stream.health().staleFailovers, 1);
    assert.strictEqual(fakes.maxActiveCount(), 1);
  } finally {
    await stream.stop();
  }
}

function testEventLoopStallDefersOnlyOneStaleCheck() {
  const stream = new PumpFlowStream({
    config: testConfig({ staleTimeoutMs: 20, staleCheckMs: 5 }),
    tokenForEndpoint: () => 'token',
  });
  let staleCalls = 0;
  stream.running = true;
  stream.connection = {
    connected: true,
    connectedAt: 1_000,
    lastMessageAt: 1_000,
    markStale(staleForMs) {
      staleCalls += 1;
      assert.strictEqual(staleForMs, 50);
    },
  };
  stream.lastWatchdogCheckAt = 1_005;

  stream._checkStale(1_045);
  assert.strictEqual(staleCalls, 0, 'a delayed event-loop tick must allow buffered data one cycle');
  assert.strictEqual(stream.health().watchdogEventLoopDeferrals, 1);
  assert.strictEqual(stream.health().lastWatchdogLagMs, 35);

  stream._checkStale(1_050);
  assert.strictEqual(staleCalls, 1, 'a truly stale stream must fail over on the next regular tick');
  assert.strictEqual(stream.health().watchdogChecks, 2);
}

async function testAmmUpdatesAtomicallyPreservePumpFilter() {
  const states = [];
  const connection = new RegionConnection({
    endpoint: LAX,
    token: 'token',
    label: 'FLOW-1',
    programs: { pump: 'pump-program', amm: 'amm-program' },
    onTransaction: () => {},
    onState: (_label, patch) => states.push(patch),
    onError: () => {},
    onUnavailable: () => {},
  });
  connection.client = {};
  connection.connected = true;
  connection.stream = { channel: 'unified' };
  connection._subscriptionTransactions = (mints) => ({
    pumpBondingCurve: { accountInclude: ['pump-program'] },
    ...(mints.length ? { pumpAmmLabels: { accountInclude: [...mints] } } : {}),
  });
  const writes = [];
  let releaseFirstWrite;
  const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
  connection._writeSubscription = async (stream, transactions) => {
    writes.push({ stream, transactions });
    if (writes.length === 1) await firstWriteGate;
  };

  const first = connection.setAmmMints(['mint-a']);
  await waitFor(() => writes.length === 1, 'first unified subscription was not written');
  const second = connection.setAmmMints(['mint-a', 'mint-b']);
  releaseFirstWrite();
  await Promise.all([first, second]);

  assert.strictEqual(writes.length, 2);
  assert.strictEqual(writes[0].stream, connection.stream);
  assert.ok(writes.every((write) => write.transactions.pumpBondingCurve));
  assert.deepStrictEqual(
    writes[1].transactions.pumpAmmLabels.accountInclude,
    ['mint-a', 'mint-b'],
  );
  assert.strictEqual(connection.appliedSubscriptionVersion, connection.subscriptionVersion);
  assert.strictEqual(states.at(-1).appliedAmmMintCount, 2);

  await connection.setAmmMints([]);
  assert.strictEqual(writes.length, 3);
  assert.ok(writes[2].transactions.pumpBondingCurve);
  assert.strictEqual(writes[2].transactions.pumpAmmLabels, undefined);
  assert.strictEqual(states.at(-1).appliedAmmMintCount, 0);
}

function testUnifiedFilterHealthTimestamps() {
  const states = [];
  let transactions = 0;
  const connection = new RegionConnection({
    endpoint: LAX,
    token: 'token',
    label: 'FLOW-1',
    programs: { pump: 'pump-program', amm: 'amm-program' },
    onTransaction: () => { transactions += 1; },
    onState: (_label, patch) => states.push(patch),
    onError: () => {},
    onUnavailable: () => {},
  });
  connection._handleMessage({ transaction: {}, filters: ['pumpBondingCurve'] });
  connection._handleMessage({ transaction: {}, filters: ['pumpAmmLabels'] });
  assert.strictEqual(transactions, 2);
  assert.ok(Number.isFinite(states[0].lastPumpMessageAt));
  assert.ok(Number.isFinite(states[1].lastAmmMessageAt));
}

async function main() {
  await testDisconnectFailover();
  await testStaleFailover();
  testEventLoopStallDefersOnlyOneStaleCheck();
  await testAmmUpdatesAtomicallyPreservePumpFilter();
  testUnifiedFilterHealthTimestamps();
  console.log('test-flow-stream-failover: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
