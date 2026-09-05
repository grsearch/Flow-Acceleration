'use strict';

const assert = require('assert');
const { config } = require('../src/config');
const { ResearchStore } = require('../src/data/ResearchStore');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const { GraduationAccelerationShadowSuite } = require('../src/core/GraduationAccelerationShadowSuite');

async function main() {
  let now = Date.now();
  const strategy = config.liveTrading.strategies.find((row) => row.id === 'graduation_accel_o_c80_ho500_x60_live');
  const profile = config.graduationAccelerationShadow.entryProfiles.find((row) => row.id === 'O_C80_HO500_X60');
  assert.equal(strategy.positionSizeSol, 0.1);
  assert.equal(profile.liveBridgeCapacitySol, 0.1);
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.',
    flushMs: 60_000, flushMax: 100 }, { configuredTradingCostPct: 0 });
  // Offline integration only: every signing/transport path is explicitly disabled.
  const trader = new LiveTradingManager({ config: {
    ...config.liveTrading, enabled: true, dryRun: true, safetyLock: false,
    killSwitchFile: null, privateKey: '', strategies: [strategy], mintCooldownMs: 0,
  }, store, now: () => now });
  const signals = [];
  const suite = new GraduationAccelerationShadowSuite({ config: {
    ...config.graduationAccelerationShadow, enabled: true, entryProfiles: [profile],
  }, store, now: () => now, onLiveSignal(event) {
    signals.push(event);
    trader.onExternalStrategySignal(event);
  } });
  suite.start();
  function observation(mint, at, market, extra = {}) {
    return { mint, timestampMs: at, receivedAtMs: at, chainTimestampMs: at - 500,
      slot: 100, signature: `${mint}-${at}`, eventIndex: 0, market, side: 'BUY',
      price: 1e-7, reservePrice: 1e-7, solAmount: 1, tokenAmount: 1e7,
      wallet: `buyer-${at}`, virtualSolReservesRaw: '100000000000',
      virtualTokenReservesRaw: '1000000000000000', pool: market === 'PUMP_AMM' ? 'test-pool' : null,
      poolBaseReservesRaw: '1000000000000000', poolQuoteReservesRaw: '100000000000',
      virtualQuoteReservesRaw: '0', ...extra };
  }
  async function enter(mint) {
    const createdAt = now;
    store.recordCreate({ mint, createdAt, symbol: 'HO500', name: null, uri: null,
      creator: 'creator', bondingCurve: null, initialRealTokenReservesRaw: null,
      tokenTotalSupplyRaw: null });
    suite.onCreate({ mint, createdAt, creator: 'creator' });
    now = createdAt + 100;
    suite.observeTrade(observation(mint, now, 'PUMP_BONDING_CURVE', { curvePct: 70 }));
    now = createdAt + 1_000;
    suite.observeTrade(observation(mint, now, 'PUMP_BONDING_CURVE', { curvePct: 80 }));
    now = createdAt + 2_000;
    store.recordComplete({ mint, completedAt: now });
    suite.onGraduated({ mint, graduated_at: now });
    now += 600;
    suite.observeTrade(observation(mint, now, 'PUMP_AMM'));
    await trader.entryQueue;
    const position = [...trader.positions.values()].find((row) => row.mint === mint);
    assert(position, 'HO500 Shadow must reach the configured live manager');
    assert.equal(position.status, 'OPEN');
    assert.equal(position.mode, 'DRY_RUN');
    assert.equal(position.positionSol, 0.1);
    assert.equal(position.entrySlot, 100);
    assert(trader.timers.has(position.id), 'fixed 60s exit must be armed even if no later trades');
    const signal = signals.find((row) => row.mint === mint);
    assert.equal(signal.features.sourceShadowCohortId, 'O_C80_HO500_X60:0_1SOL');
    trader.onExternalStrategySignal(signal);
    await trader.entryQueue;
    assert.equal([...trader.positions.values()].filter((row) => row.mint === mint).length, 1);
    return position;
  }
  try {
    const timed = await enter('ho500-fixed');
    now = timed.openedAt + 60_001;
    trader.observeTrade(observation(timed.mint, now, 'PUMP_AMM', { slot: 110 }));
    await Promise.allSettled([...trader.pending]);
    let row = store.db.prepare('SELECT * FROM live_positions WHERE id=?').get(timed.id);
    assert.equal(row.status, 'CLOSED');
    assert.match(row.exit_reason, /FIXED_HOLD/);
    const stopped = await enter('ho500-stop');
    now += 100;
    trader.observeTrade(observation(stopped.mint, now, 'PUMP_AMM', {
      slot: 101, price: 5e-8, reservePrice: 5e-8, poolQuoteReservesRaw: '50000000000',
    }));
    await Promise.allSettled([...trader.pending]);
    row = store.db.prepare('SELECT * FROM live_positions WHERE id=?').get(stopped.id);
    assert.equal(row.status, 'CLOSED');
    assert.match(row.exit_reason, /HARD_STOP/);
    assert.equal(signals.length, 2, '1 SOL shadow capacity must not duplicate live signals');
    console.log('test-ho500-live-promotion: ok (bridge, 0.1 SOL, deduplication, 60s, hard stop)');
  } finally { await trader.stop(); store.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
