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
  const fakes = fakeConnections({ connectedAtOffsetMs: 50 });
  const stream = new PumpFlowStream({
    config: testConfig({ staleTimeoutMs: 20, staleCheckMs: 5 }),
    tokenForEndpoint: () => 'token',
    connectionFactory: fakes.factory,
  });

  await stream.start();
  await waitFor(() => fakes.instances.length === 2, 'stale connection did not fail over');
  assert.strictEqual(stream.health().activeEndpoint, SLC);
  assert.strictEqual(stream.health().staleFailovers, 1);
  assert.strictEqual(fakes.maxActiveCount(), 1);

  await stream.stop();
}

async function testAmmUpdatesDoNotRewritePumpStream() {
  const pumpStream = { channel: 'pump' };
  let ammStreamDestroyed = false;
  const connection = new RegionConnection({
    endpoint: LAX,
    token: 'token',
    label: 'FLOW-1',
    programs: { pump: 'pump-program', amm: 'amm-program' },
    onTransaction: () => {},
    onState: () => {},
    onError: () => {},
    onUnavailable: () => {},
  });
  connection.client = {};
  connection.connected = true;
  connection.pumpStream = pumpStream;
  connection._openStream = async (channel) => ({
    channel,
    removeAllListeners() {},
    destroy() { ammStreamDestroyed = true; },
  });
  let ammWrites = 0;
  connection._sendAmmSubscription = async () => { ammWrites += 1; };

  await connection.setAmmMints(['mint-a']);
  assert.strictEqual(connection.pumpStream, pumpStream);
  assert.strictEqual(connection.ammStream.channel, 'amm');
  assert.strictEqual(ammWrites, 1);

  await connection.setAmmMints(['mint-a', 'mint-b']);
  assert.strictEqual(connection.pumpStream, pumpStream);
  assert.strictEqual(ammWrites, 2);

  await connection.setAmmMints([]);
  assert.strictEqual(connection.pumpStream, pumpStream);
  assert.strictEqual(connection.ammStream, null);
  assert.strictEqual(ammStreamDestroyed, true);
}

async function main() {
  await testDisconnectFailover();
  await testStaleFailover();
  await testAmmUpdatesDoNotRewritePumpStream();
  console.log('test-flow-stream-failover: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
