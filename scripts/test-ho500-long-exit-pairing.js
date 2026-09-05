'use strict';

const assert = require('node:assert/strict');
const { ResearchStore } = require('../src/data/ResearchStore');
const { GraduationAccelerationShadowSuite, STATUS } = require('../src/core/GraduationAccelerationShadowSuite');

const SOURCE = 'O_C80_HO500_X60';
const GROUP = 'HO500_LONG_EXIT_V1';

function settings() {
  const baseline = {
    id: SOURCE, mode: 'CURVE_MILESTONE', thresholdPct: 80, recentWindowMs: 5_000,
    minCurveDeltaPct: 5, minBuyers: 2, maxSellTx: 0, requireNoCreatorSell: true,
    migrationHandoff: true, capacityAwareExit: true, capacitySols: [0.1, 1], coreExitPct: 0,
    handoffLiveStrategyId: 'baseline-live-only', liveBridgeCapacitySol: 0.1,
    postMigrationEntryGate: {
      windowMs: 500, evaluateAtFill: true, captureWindowMs: 10_000,
      minBuyers: 1, minNetFlowSol: 0, maxSellBuyRatio: 1, maxDrawdownPct: 20,
      maxMarketMovePct: 15, maxSelfImpactPct: 10,
    },
    runnerExitMode: 'FIXED_HOLD', runnerMaxHoldMs: 60_000,
  };
  const paired = [1_800_000, 3_600_000].flatMap((hold) => [[30, 20], [100, 30]].flatMap(([activation, drawdown]) => (
    [20, 30, 0].map((hardStopPct) => ({
      ...baseline, id: `LONG_${hold}_${activation}_${hardStopPct}`,
      // Different qualification fields must be irrelevant: these are entered
      // pairs, not twelve independent attempts to rediscover the entry.
      thresholdPct: 999, capacitySols: [0.1], pairedEntryProfileId: SOURCE,
      experimentGroup: GROUP, handoffLiveStrategyId: null, liveBridgeCapacitySol: null,
      runnerExitMode: 'TRAILING', runnerMaxHoldMs: hold,
      trailingActivationPct: activation, trailingStopPct: drawdown, hardStopPct,
    }))
  )));
  return {
    enabled: true, entryDelayMs: 200, entryTimeoutMs: 2_000, exitDelayMs: 200,
    exitTimeoutMs: 15_000, noExitObservationMs: 600_000, maxEntryPriceJumpPct: 15,
    hardStopPct: 30, maxPreGraduationHoldMs: 300_000, maxPostGraduationHoldMs: 300_000,
    coreExitPct: 50, capacitySols: [1], longExitObservationGraceMs: 300_000,
    longExitObservationMaxMints: 2_000, trailingTiers: [{ activationPct: 20, drawdownPct: 10 }],
    entryProfiles: [...paired.reverse(), baseline],
    costModel: { platformFeePct: 1.4, buySlippagePct: 0.3, sellSlippagePct: 0.3,
      priceImpactPct: 0.2, baseTxFeeSol: 0.00001, priorityFeeSol: 0.0005, positionSizeSol: 1 },
  };
}

function fixture() {
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 100 }, { configuredTradingCostPct: 1.4 });
  const config = settings();
  let now = Date.now();
  const live = [];
  let suite;
  const context = {
    store, config, live,
    get suite() { return suite; },
    restart(nextConfig = config) {
      suite = new GraduationAccelerationShadowSuite({ config: nextConfig, store,
        now: () => now, onLiveSignal: (event) => live.push(event) });
      suite.start();
    },
    advance(at) { now = at; suite.advanceTime(at); },
    tick(mint, at, price, { market = 'PUMP_AMM', curvePct = 100, reserves = true, side = 'BUY', ...overrides } = {}) {
      now = at;
      const trade = {
        mint, timestampMs: at, receivedAtMs: at, chainTimestampMs: at, slot: at,
        signature: `sig-${mint}-${at}`, eventIndex: 0, pool: `${mint}-pool`,
        market, side, wallet: `wallet-${at}`, solAmount: 0.2, price, reservePrice: price, curvePct,
        virtualSolReservesRaw: '100000000000', virtualTokenReservesRaw: '1000000000000000',
        poolBaseReservesRaw: reserves ? '1000000000000000' : null,
        poolQuoteReservesRaw: reserves ? String(Math.round(price * 1e18)) : null,
        virtualQuoteReservesRaw: reserves ? '0' : null,
        ...overrides,
      };
      suite.observeTrade(trade);
      return trade;
    },
    arm(mint, at = now) {
      suite.onCreate({ mint, creator: 'creator', createdAt: at });
      this.tick(mint, at + 100, 7e-8, { market: 'PUMP_BONDING_CURVE', curvePct: 70 });
      this.tick(mint, at + 1_000, 7e-8, { market: 'PUMP_BONDING_CURVE', curvePct: 80 });
      suite.onGraduated({ mint, graduated_at: at + 2_000 });
      return at + 2_600;
    },
    enter(mint, at = now) {
      const entryAt = this.arm(mint, at);
      this.tick(mint, entryAt, 1e-7);
      return this.rows(mint).find((row) => row.entry_profile_id === SOURCE && row.position_sol === 0.1);
    },
    rows(mint) { return store.db.prepare('SELECT * FROM graduation_acceleration_shadow_positions WHERE mint=? ORDER BY id').all(mint); },
    pairs(mint) { return this.rows(mint).filter((row) => row.entry_profile_id !== SOURCE); },
    dispose() { store.close(); },
  };
  context.restart();
  return context;
}

function testAtomicIdenticalEntry() {
  const f = fixture();
  try {
    const at = f.arm('atomic');
    assert.equal(f.rows('atomic').length, 2, 'only baseline capacities await qualification');
    const originalCreate = f.store.createGraduationAccelerationShadowPosition.bind(f.store);
    let clones = 0;
    f.store.createGraduationAccelerationShadowPosition = (row) => {
      if (row.entryProfileId !== SOURCE && ++clones === 6) throw new Error('injected paired insert failure');
      return originalCreate(row);
    };
    assert.throws(() => f.tick('atomic', at, 1e-7), /injected paired insert failure/);
    assert.equal(f.rows('atomic').length, 2, 'partial twelve-row fanout must roll back');
    assert.ok(f.rows('atomic').every((row) => row.entry_at == null));
    assert.ok([...f.suite.pendingEntries.values()].every((row) => row.status === STATUS.PENDING_ENTRY));
    assert.equal(f.live.length, 0, 'failed atomic pairing must not send a live bridge signal');
    f.store.createGraduationAccelerationShadowPosition = originalCreate;
    f.tick('atomic', at, 1e-7);
    const source = f.rows('atomic').find((row) => row.entry_profile_id === SOURCE && row.position_sol === 0.1);
    const pairs = f.pairs('atomic');
    assert.equal(pairs.length, 12);
    for (const row of pairs) {
      for (const field of ['entry_at', 'entry_price', 'entry_market', 'entry_jump_pct', 'entry_impact_pct',
        'entry_target_at', 'entry_deadline_at', 'token_units', 'configured_cost_pct', 'position_sol', 'signal_at', 'episode_id']) {
        assert.equal(row[field], source[field], field);
      }
      const metadata = JSON.parse(row.features_json);
      assert.equal(metadata.pairedSourcePositionId, source.id);
      assert.equal(metadata.pairedEntryProfileId, SOURCE);
      assert.equal(metadata.entryPool, 'atomic-pool');
      assert.equal(metadata.entryGate.passed, true);
      assert.equal(row.core_weight_pct, 0);
    }
    assert.equal(f.live.length, 1, 'only original 0.1 SOL baseline reaches live bridge');
    f.tick('atomic', at + 1, 1e-7);
    assert.equal(f.rows('atomic').length, 14, 'repeated arrival must not duplicate a paired entry');
    const rejectedAt = f.arm('rejected', at + 10_000);
    f.tick('rejected', rejectedAt, 1e-7, { side: 'SELL' });
    assert.equal(f.pairs('rejected').length, 0, 'a rejected baseline does not create entered pairs');
  } finally { f.dispose(); }
}

function testHardStopOffAndMissingQuote() {
  const f = fixture();
  try {
    const source = f.enter('stops');
    const at = source.entry_at, p = source.entry_price;
    f.tick('stops', at + 1_000, p * 0.75);
    for (const row of f.pairs('stops')) {
      const hs = JSON.parse(row.features_json).exitPolicy.hardStopPct;
      assert.equal(row.status, hs === 20 ? STATUS.EXIT_PENDING : STATUS.RUNNER);
    }
    f.tick('stops', at + 1_200, p * 0.75);
    assert.equal(f.pairs('stops').filter((row) => row.status === STATUS.CLOSED).length, 4);
    f.tick('stops', at + 2_000, p * 0.1, { reserves: false });
    f.tick('stops', at + 2_200, p * 0.1, { reserves: false });
    const baseline = f.rows('stops').find((row) => row.id === source.id);
    assert.equal(baseline.status, STATUS.CLOSED, 'baseline conservative missing-quote policy is unchanged');
    for (const row of f.pairs('stops')) {
      const hs = JSON.parse(row.features_json).exitPolicy.hardStopPct;
      if (hs === 30) assert.equal(row.status, STATUS.EXIT_PENDING, 'missing reserves cannot prove a zero-value exit');
      if (hs === 0) assert.equal(row.status, STATUS.RUNNER, 'OFF must not inherit the global hard stop');
    }
    f.advance(at + 17_201);
    for (const row of f.pairs('stops').filter((row) => JSON.parse(row.features_json).exitPolicy.hardStopPct === 30)) {
      assert.equal(row.status, STATUS.NO_EXIT);
      assert.equal(row.net_return_pct, null);
      assert.equal(row.gross_return_pct, null);
    }
    assert.ok(f.suite.trackedMints().includes('stops'));
  } finally { f.dispose(); }
}

function testTrailingRecoveryAndObservationBudget() {
  const f = fixture();
  try {
    f.config.longExitObservationMaxMints = 1;
    const first = f.enter('first');
    const second = f.enter('second', first.entry_at + 100);
    assert.equal(f.suite.longExitObservations.size, 1);
    assert.ok(f.suite.trackedMints().includes('first'), 'observation capacity must never evict active positions');
    const at = second.entry_at, p = second.entry_price;
    f.tick('second', at + 1_000, p * 1.5);
    f.tick('second', at + 1_200, p * 1.19);
    assert.equal(f.pairs('second').filter((row) => row.status === STATUS.EXIT_PENDING).length, 6);
    f.tick('second', at + 1_400, p * 1.19);
    assert.equal(f.rows('second').find((row) => row.id === second.id).status, STATUS.RUNNER,
      'X60 baseline must not acquire the new trailing policy');
    f.tick('second', at + 2_000, p * 2.2);
    const baselineOnly = { ...f.config, entryProfiles: f.config.entryProfiles.filter((row) => row.id === SOURCE) };
    f.restart(baselineOnly);
    f.tick('second', at + 2_200, p * 1.5);
    assert.equal(f.pairs('second').filter((row) => row.status === STATUS.EXIT_PENDING).length, 6,
      'persisted peak and exit policy must survive removal of new-entry profile definitions');
    f.tick('second', at + 2_400, p * 1.5);
    assert.ok(f.pairs('second').every((row) => row.status === STATUS.CLOSED));
    f.tick('second', at + 60_200, p * 1.5);
    assert.equal(f.rows('second').find((row) => row.id === second.id).status, STATUS.CLOSED);
    f.restart(baselineOnly);
    assert.equal(f.suite.longExitObservations.size, 1);
    assert.ok(f.suite.trackedMints().includes('second'), 'closed pairs retain observation through the planned horizon');
    f.advance(at + 65 * 60_000 + 1);
    assert.ok(!f.suite.trackedMints().includes('second'), 'extra observation expires after hold plus five minutes');
  } finally { f.dispose(); }
}

function testIndependentHoldDeadlines() {
  const f = fixture();
  try {
    const source = f.enter('deadlines'), at = source.entry_at, p = source.entry_price;
    f.advance(at + 1_800_000);
    for (const row of f.pairs('deadlines')) {
      const hold = JSON.parse(row.features_json).exitPolicy.runnerMaxHoldMs;
      assert.equal(row.status, hold === 1_800_000 ? STATUS.EXIT_PENDING : STATUS.RUNNER);
    }
    f.tick('deadlines', at + 1_800_200, p);
    assert.equal(f.pairs('deadlines').filter((row) => row.status === STATUS.CLOSED).length, 6);
    f.tick('deadlines', at + 3_600_200, p);
    assert.ok(f.pairs('deadlines').every((row) => row.status === STATUS.CLOSED));
    assert.ok(f.suite.trackedMints().includes('deadlines'));
    f.advance(at + 3_900_001);
    assert.ok(!f.suite.trackedMints().includes('deadlines'));
  } finally { f.dispose(); }
}

function testRepeatedTickWriteBudgetAndFinalSnapshot() {
  const f = fixture();
  try {
    const source = f.enter('write-budget'), at = source.entry_at, p = source.entry_price;
    f.tick('write-budget', at + 1_000, p * 2.2);
    const ids = new Set(f.pairs('write-budget').map((row) => row.id));
    const original = f.store.updateGraduationAccelerationShadowPosition.bind(f.store);
    let writes = 0;
    f.store.updateGraduationAccelerationShadowPosition = (id, patch) => {
      if (ids.has(id)) writes += 1;
      return original(id, patch);
    };
    for (let index = 1; index <= 1_000; index += 1) f.tick('write-budget', at + 1_000 + index, p * 2.2);
    assert.ok(writes <= 12, `1000 unchanged ticks must use at most one heartbeat per pair, got ${writes}`);
    f.tick('write-budget', at + 2_001, p * 2.3);
    assert.ok(f.pairs('write-budget').every((row) => row.runner_highest_price === p * 2.3),
      'new runner highs must persist immediately, including between heartbeats');
    f.restart();
    f.tick('write-budget', at + 2_002, p * 1.6);
    assert.ok(f.pairs('write-budget').every((row) => row.status === STATUS.EXIT_PENDING),
      'all twelve must evaluate their stop on the immediate next tick, without waiting for heartbeat');
    assert.ok(f.pairs('write-budget').every((row) => row.last_price === p * 1.6
      && row.last_observed_at === at + 2_002), 'transition must persist the final in-memory snapshot');
    f.tick('write-budget', at + 2_202, p * 1.62);
    assert.ok(f.pairs('write-budget').every((row) => row.status === STATUS.CLOSED
      && row.last_price === p * 1.62 && row.last_observed_at === at + 2_202));
  } finally { f.dispose(); }
}

function testPersistedExitExecutionPolicy() {
  for (const [delay, timeout] of [[200, 15_000], [0, 0]]) {
    const f = fixture();
    try {
      f.config.exitDelayMs = delay;
      f.config.exitTimeoutMs = timeout;
      const source = f.enter('execution-policy'), at = source.entry_at, p = source.entry_price;
      const changed = { ...f.config, exitDelayMs: 9_000, exitTimeoutMs: 40_000 };
      f.restart(changed);
      f.tick('execution-policy', at + 1_000, p * 0.75);
      const stopped = f.pairs('execution-policy').filter((row) => JSON.parse(row.features_json).exitPolicy.hardStopPct === 20);
      assert.equal(stopped.length, 4);
      for (const row of stopped) {
        assert.equal(row.exit_target_at, at + 1_000 + delay);
        assert.equal(row.exit_deadline_at, at + 1_000 + delay + timeout);
      }
      f.restart(changed);
      for (const row of f.pairs('execution-policy').filter((row) => row.status === STATUS.EXIT_PENDING)) {
        assert.equal(row.exit_deadline_at, at + 1_000 + delay + timeout);
      }
    } finally { f.dispose(); }
  }
}

function testInvalidTradesCannotMarkTriggerOrFill() {
  const f = fixture();
  try {
    const source = f.enter('invalid-quotes'), at = source.entry_at, p = source.entry_price;
    f.tick('invalid-quotes', at + 1_000, p * 1.1);
    const snapshots = f.pairs('invalid-quotes').map((row) => [row.status, row.highest_price, row.lowest_price, row.last_observed_at]);
    const invalid = [
      { pool: 'different-pool' }, { pool: null, bondingCurve: 'invalid-quotes-pool' },
      { slot: null }, { slot: at }, { slot: at + 900 },
      { chainTimestampMs: null }, { chainTimestampMs: at - 120_000 },
      { chainTimestampMs: at + 10_000 }, { chainTimestampMs: at + 900 },
    ];
    for (let index = 0; index < invalid.length; index += 1) {
      f.tick('invalid-quotes', at + 1_100 + index, index % 2 ? p * 10 : p * 0.1, invalid[index]);
      assert.deepEqual(f.pairs('invalid-quotes').map((row) => [row.status, row.highest_price, row.lowest_price, row.last_observed_at]), snapshots);
    }
    f.tick('invalid-quotes', at + 900, p * 0.1, { slot: at + 1_500, chainTimestampMs: at + 1_300 });
    assert.deepEqual(f.pairs('invalid-quotes').map((row) => [row.status, row.highest_price, row.lowest_price, row.last_observed_at]), snapshots);
    assert.equal(Object.keys(f.suite.health().longExitTradeRejections).length, 9);
    f.restart();
    f.tick('invalid-quotes', at + 1_500, p * 0.1, { pool: 'wrong-after-restart' });
    assert.ok(f.pairs('invalid-quotes').every((row) => row.status === STATUS.RUNNER));
    f.tick('invalid-quotes', at + 2_000, p * 0.75);
    assert.equal(f.pairs('invalid-quotes').filter((row) => row.status === STATUS.EXIT_PENDING).length, 4,
      'a valid fresh trade must resume normal hard-stop evaluation');
    f.tick('invalid-quotes', at + 2_200, p * 0.7, { pool: 'different-pool' });
    f.tick('invalid-quotes', at + 2_210, p * 0.7, { chainTimestampMs: at - 120_000 });
    assert.equal(f.pairs('invalid-quotes').filter((row) => row.status === STATUS.CLOSED).length, 0,
      'EXIT_PENDING must validate the executable tick, too');
    f.tick('invalid-quotes', at + 2_300, p * 0.75);
    assert.equal(f.pairs('invalid-quotes').filter((row) => row.status === STATUS.CLOSED).length, 4);
  } finally { f.dispose(); }
}

function testBoundedObservationRestoreReads() {
  const f = fixture();
  try {
    const source = f.enter('restore-budget'), at = source.entry_at;
    // Populate unrelated CLOSED rows in the indexed window. Restoration must
    // limit raw rows before parsing/grouping, not scan every historical cohort.
    f.store.db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<12005)
      INSERT INTO graduation_acceleration_shadow_positions
      (cohort_id,episode_id,entry_profile_id,mint,status,position_sol,configured_cost_pct,signal_at,
       signal_price,features_json,entry_target_at,entry_deadline_at,core_weight_pct,created_at,updated_at)
      SELECT 'unrelated', 'restore-'||x, 'unrelated', 'other-'||x, 'CLOSED', 0.1, 1, ?, 1, '{}', 1, 1, 0, ?, ? FROM n
    `).run(at, at, at);
    f.restart();
    assert.equal(f.suite.health().longExitRestoreRowsRead, 12_001);
    assert.equal(f.suite.health().longExitRestoreTruncatedStatuses, 1);
    assert.ok(f.suite.trackedMints().includes('restore-budget'), 'read cap must not truncate active positions');
  } finally { f.dispose(); }
}

function testRestartTradeCursorAndStopFlush() {
  const f = fixture();
  try {
    const source = f.enter('restart-cursor'), at = source.entry_at, p = source.entry_price;
    f.tick('restart-cursor', at + 1_000, p * 1.1);
    f.tick('restart-cursor', at + 1_001, p * 1.1);
    assert.equal(JSON.parse(f.pairs('restart-cursor')[0].features_json).longExitTradeCursor.slot, at + 1_000,
      'unchanged ticks may keep a one-second dirty cursor in memory');
    f.suite.stop();
    for (const row of f.pairs('restart-cursor')) {
      const metadata = JSON.parse(row.features_json);
      assert.equal(metadata.longExitTradeCursor.slot, at + 1_001);
      assert.equal(metadata.pairedSourcePositionId, source.id, 'cursor persistence must preserve entry metadata');
      assert.equal(row.last_observed_at, at + 1_001);
    }
    // Crash-style restart without stop flushing a later unchanged tick.
    f.tick('restart-cursor', at + 1_002, p * 1.1);
    f.advance(at + 1_500);
    f.restart();
    f.tick('restart-cursor', at + 1_600, p * 0.1, { chainTimestampMs: at + 1_400 });
    assert.ok(f.pairs('restart-cursor').every((row) => row.status === STATUS.RUNNER),
      'a pre-restart chain event must not exploit the unflushed cursor interval');
    f.tick('restart-cursor', at + 1_700, p * 0.1, { slot: at + 1_000 });
    assert.ok(f.pairs('restart-cursor').every((row) => row.status === STATUS.RUNNER),
      'the persisted latest slot must reject a lower post-restart slot');
    f.tick('restart-cursor', at + 2_000, p * 0.75);
    assert.equal(f.pairs('restart-cursor').filter((row) => row.status === STATUS.EXIT_PENDING).length, 4);
    f.advance(at + 2_300);
    f.restart();
    f.tick('restart-cursor', at + 2_400, p * 0.75, { chainTimestampMs: at + 2_250 });
    assert.equal(f.pairs('restart-cursor').filter((row) => row.status === STATUS.CLOSED).length, 0,
      'EXIT_PENDING restoration must also reject pre-restart chain events');
    f.tick('restart-cursor', at + 2_500, p * 0.75);
    assert.equal(f.pairs('restart-cursor').filter((row) => row.status === STATUS.CLOSED).length, 4);
  } finally { f.dispose(); }
}

testAtomicIdenticalEntry();
testHardStopOffAndMissingQuote();
testTrailingRecoveryAndObservationBudget();
testIndependentHoldDeadlines();
testRepeatedTickWriteBudgetAndFinalSnapshot();
testPersistedExitExecutionPolicy();
testInvalidTradesCannotMarkTriggerOrFill();
testBoundedObservationRestoreReads();
testRestartTradeCursorAndStopFlush();
console.log('test-ho500-long-exit-pairing: ok');
