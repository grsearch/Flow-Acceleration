'use strict';

const assert = require('assert');
const EventEmitter = require('events');
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
  connection.running = true;
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
  connection.running = true;
  connection.connected = true;
  connection._handleMessage({ transaction: {}, filters: ['pumpBondingCurve'] });
  connection._handleMessage({ transaction: {}, filters: ['pumpAmmLabels'] });
  assert.strictEqual(transactions, 2);
  assert.ok(Number.isFinite(states[0].lastPumpMessageAt));
  assert.ok(Number.isFinite(states[1].lastAmmMessageAt));
}

async function testStopDuringConnectionStages() {
  for (const phase of ['close', 'connect', 'subscribe', 'update']) {
    let release;
    let entered = false;
    let transactions = 0;
    let subscribeCalls = 0;
    let createCalls = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    const pause = async () => { entered = true; await gate; };
    const states = [];
    const wire = new EventEmitter();
    wire.destroy = () => { wire.destroyed = true; };
    const client = {
      async connect() { if (phase === 'connect') await pause(); },
      async subscribe() { subscribeCalls += 1; if (phase === 'subscribe') await pause(); return wire; },
      close() { this.closed = true; },
    };
    const connection = new RegionConnection({
      endpoint: LAX, token: 'token', label: 'FLOW-1', programs: {},
      onTransaction: () => { transactions += 1; },
      onState: (_label, state) => states.push(state),
      onError: () => {}, onUnavailable: () => {},
    });
    connection._createClient = () => { createCalls += 1; return client; };
    connection._subscriptionTransactions = () => ({});
    connection._writeSubscription = async () => { if (phase === 'update') await pause(); };
    if (phase === 'close') {
      const originalClose = connection._close.bind(connection);
      let closeCalls = 0;
      connection._close = async () => {
        await originalClose();
        if (++closeCalls === 1) await pause();
      };
    }
    const starting = connection.start();
    try {
      await waitFor(() => entered, `${phase} startup boundary was not reached`);
      await connection.stop();
      const stateCount = states.length;
      release();
      assert.strictEqual(await starting, false, `${phase} late completion must stay stopped`);
      wire.emit('data', { transaction: {} });
      connection._handleMessage({ transaction: {} });
      assert.strictEqual(transactions, 0, `${phase} must ignore late data`);
      assert.strictEqual(states.length, stateCount, `${phase} must not report a late connected state`);
      assert.strictEqual(connection.running, false);
      assert.strictEqual(connection.connected, false);
      assert.strictEqual(connection.client, null);
      assert.strictEqual(connection.stream, null);
      if (phase === 'close') assert.strictEqual(createCalls, 0);
      if (phase === 'connect') assert.strictEqual(subscribeCalls, 0);
      if (['subscribe', 'update'].includes(phase)) assert.ok(wire.destroyed);
      if (phase !== 'close') assert.ok(client.closed);
    } finally {
      release();
      await starting;
      await connection.stop();
    }
  }
}

async function testStopDuringAmmSetup() {
  const fakes = fakeConnections();
  let release;
  let entered = false;
  let starts = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const stream = new PumpFlowStream({
    config: testConfig(), tokenForEndpoint: () => 'token',
    connectionFactory: (options) => {
      const connection = fakes.factory(options);
      connection.setAmmMints = async () => { entered = true; await gate; };
      connection.start = async () => { starts += 1; return true; };
      return connection;
    },
  });
  const starting = stream.start();
  try {
    await waitFor(() => entered, 'AMM setup was not reached');
    await stream.stop();
    release();
    await starting;
    assert.strictEqual(starts, 0, 'late AMM setup must not start a stopped connection');
    assert.strictEqual(stream.connection, null);
    assert.strictEqual(stream.running, false);
    assert.strictEqual(stream.activeEndpointIndex, -1);
  } finally {
    release();
    await starting;
    await stream.stop();
  }
}

async function testLateSubscriptionDoesNotReplaceRestartedConnection() {
  let release;
  let oldSubscribeEntered = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const clients = [];
  const wires = [];
  const connection = new RegionConnection({
    endpoint: LAX, token: 'token', label: 'FLOW-1', programs: {},
    onTransaction: () => {}, onState: () => {}, onError: () => {}, onUnavailable: () => {},
  });
  connection._createClient = () => {
    const first = clients.length === 0;
    const wire = new EventEmitter();
    wire.destroy = () => { wire.destroyed = true; };
    wires.push(wire);
    const client = {
      async connect() {},
      async subscribe() {
        if (first) { oldSubscribeEntered = true; await gate; }
        return wire;
      },
      close() { this.closed = true; },
    };
    clients.push(client);
    return client;
  };
  connection._subscriptionTransactions = () => ({});
  connection._writeSubscription = async () => {};
  const oldStart = connection.start();
  try {
    await waitFor(() => oldSubscribeEntered, 'old subscription was not requested');
    await connection.stop();
    assert.strictEqual(await connection.start(), true);
    release();
    assert.strictEqual(await oldStart, false);
    assert.strictEqual(connection.client, clients[1]);
    assert.strictEqual(connection.stream, wires[1]);
    assert.strictEqual(connection.connected, true);
    assert.ok(wires[0].destroyed, 'old late stream must be disposed');
    assert.ok(!wires[1].destroyed, 'current stream must remain open');
    assert.ok(!clients[1].closed, 'current client must remain open');
  } finally {
    release();
    await oldStart;
    await connection.stop();
  }
}

async function main() {
  await testDisconnectFailover();
  await testStaleFailover();
  testEventLoopStallDefersOnlyOneStaleCheck();
  await testAmmUpdatesAtomicallyPreservePumpFilter();
  testUnifiedFilterHealthTimestamps();
  await testStopDuringConnectionStages();
  await testStopDuringAmmSetup();
  await testLateSubscriptionDoesNotReplaceRestartedConnection();
  console.log('test-flow-stream-failover: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
