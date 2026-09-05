'use strict';

const assert = require('node:assert/strict');
// Offline, deterministic configuration: do not inspect a local .env or inherit
// operator trading switches. No signer or transport is constructed by this test.
require('dotenv').config = () => ({ parsed: {} });
for (const key of Object.keys(process.env)) if (key.startsWith('FLOW_')) delete process.env[key];
const { config } = require('../src/config');
const { ResearchStore } = require('../src/data/ResearchStore');
const { GraduationAccelerationShadowSuite, STATUS, ammBuyAveragePrice } = require('../src/core/GraduationAccelerationShadowSuite');

const OLD = 'O_C80_HO500_X60';
const SOURCE = `${OLD}_POSTV1`;
const DELAY = `${SOURCE}_D1000`;
const MODEL = 'POST_TRADE_V1';

function fixture() {
  const settings = { ...config.graduationAccelerationShadow,
    entryProfiles: config.graduationAccelerationShadow.entryProfiles.filter((profile) => (
      [OLD, SOURCE, DELAY].includes(profile.id) || profile.pairedEntryProfileId === SOURCE
    )),
  };
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.', rawShardingEnabled: false,
    rawRetentionHours: 24, flushMs: 60_000, flushMax: 100 }, { configuredTradingCostPct: 1.4 });
  let now = Date.now();
  let suite;
  const live = [];
  const f = {
    store, settings, live,
    get now() { return now; },
    get suite() { return suite; },
    rows(mint) { return store.db.prepare('SELECT * FROM graduation_acceleration_shadow_positions WHERE mint=? ORDER BY id').all(mint); },
    row(mint, id = SOURCE, size = 0.1) { return this.rows(mint).find((row) => row.entry_profile_id === id && row.position_sol === size); },
    restart() {
      suite = new GraduationAccelerationShadowSuite({ config: settings, store, now: () => now,
        onLiveSignal(signal) {
          const delayed = f.row(signal.mint, DELAY);
          assert.equal(delayed?.status, STATUS.PENDING_ENTRY, 'delayed denominator commits atomically before the callback');
          assert.equal(delayed.entry_at, null, 'live callback never waits for delayed execution');
          live.push(signal);
        },
      });
      suite.start();
    },
    advance(at) { now = at; suite.advanceTime(at); },
    tick(mint, at, price = 1e-7, overrides = {}) {
      now = at;
      const trade = { mint, timestampMs: at, receivedAtMs: at, chainTimestampMs: at,
        slot: at, signature: `sig-${mint}-${at}`, eventIndex: 0, pool: `${mint}-pool`,
        market: 'PUMP_AMM', side: 'BUY', wallet: `wallet-${at}`, solAmount: 0.2,
        price, reservePrice: price, curvePct: 100,
        virtualSolReservesRaw: '100000000000', virtualTokenReservesRaw: '1000000000000000',
        poolBaseReservesRaw: '1000000000000000', poolQuoteReservesRaw: String(Math.round(price * 1e18)),
        prePoolBaseReservesRaw: '1000000000000000', prePoolQuoteReservesRaw: '100000000000',
        preReservePrice: 1e-7, virtualQuoteReservesRaw: '0', ammQuoteState: MODEL,
        ...overrides,
      };
      suite.observeTrade(trade);
      return trade;
    },
    arm(mint) {
      const at = now;
      suite.onCreate({ mint, creator: 'creator', createdAt: at });
      this.tick(mint, at + 100, 7e-8, { market: 'PUMP_BONDING_CURVE', curvePct: 70 });
      this.tick(mint, at + 1_000, 7e-8, { market: 'PUMP_BONDING_CURVE', curvePct: 80 });
      suite.onGraduated({ mint, graduated_at: at + 2_000 });
      return at + 2_600;
    },
    enter(mint) { const at = this.arm(mint); this.tick(mint, at); return this.row(mint); },
    seedLegacy(mint, status) {
      const row = store.createGraduationAccelerationShadowPosition({
        cohortId: `${OLD}:0_1SOL`, episodeId: `${mint}-legacy`, entryProfileId: OLD,
        mint, status, positionSol: 0.1, configuredCostPct: 1.4,
        signalAt: now - 2_000, signalPrice: 1e-7, signalCurvePct: 80,
        entryTargetAt: now + 500, entryDeadlineAt: now + 2_500, coreWeightPct: 0, features: {},
      });
      if (status !== STATUS.PENDING_ENTRY) store.updateGraduationAccelerationShadowPosition(row.id, {
        entryAt: now - 1_000, entryMarket: 'PUMP_AMM', entryPrice: 1e-7, tokenUnits: 1_000_000,
        graduatedAt: now - 1_500, highestPrice: 1e-7, lowestPrice: 1e-7, runnerHighestPrice: 1e-7,
        ...(status === STATUS.CLOSED ? { exitAt: now - 500, exitMarket: 'PUMP_AMM',
          exitPrice: 2e-7, grossReturnPct: 100, netReturnPct: 98.6 } : {}),
      });
      return this.rows(mint).find((saved) => saved.id === row.id);
    },
    dispose() { suite.stop(); store.close(); },
  };
  f.restart();
  return f;
}

function testConfigIsolation() {
  const profiles = config.graduationAccelerationShadow.entryProfiles;
  const legacy = profiles.filter((profile) => profile.migrationHandoff && profile.executionModelVersion === 'PRE_TRADE_LEGACY');
  assert.ok(legacy.length > 12);
  for (const profile of legacy) {
    assert.equal(profile.newEntriesEnabled, false);
    assert.equal(profile.handoffLiveStrategyId, null);
    const post = profiles.find((p) => p.id === `${profile.id}_POSTV1`);
    assert.equal(post.executionModelVersion, MODEL);
    assert.equal(post.feeModel, 'FLAT_ESTIMATE');
  }
  const bridge = profiles.filter((profile) => profile.handoffLiveStrategyId);
  assert.deepEqual(bridge.map((p) => p.id), [SOURCE]);
  const matrix = profiles.filter((profile) => profile.pairedEntryProfileId === SOURCE);
  assert.equal(matrix.length, 12);
  assert.ok(matrix.every((profile) => profile.experimentGroup === 'HO500_LONG_EXIT_V1'));
  assert.equal(profiles.filter((profile) => profile.pairedEntryProfileId === DELAY).length, 0);
  const delay = profiles.find((profile) => profile.id === DELAY);
  assert.equal(delay.pairedSignalProfileId, SOURCE);
  assert.equal(delay.shadowExecutionDelayMs, 1_000);
  assert.equal(delay.handoffLiveStrategyId, null);
  assert.equal(config.liveTrading.enabled, false);
  const live = config.liveTrading.strategies.find((strategy) => strategy.id === 'graduation_accel_o_c80_ho500_x60_live');
  assert.equal(live.entryEnabled, false);
  assert.equal(live.sourceShadowCohortId, `${SOURCE}:0_1SOL`);
  const configPath = require.resolve('../src/config');
  process.env.FLOW_GRADUATION_ACCEL_RELAXED_ENTRY_SHADOW_ENABLED = 'false';
  process.env.FLOW_GRADUATION_ACCEL_HO500_LONG_EXIT_ENABLED = 'false';
  delete require.cache[configPath];
  const disabled = require('../src/config').config.graduationAccelerationShadow;
  assert.equal(disabled.longExitMatrixEnabled, false);
  assert.ok(disabled.entryProfiles.some((profile) => profile.id === OLD), 'disabled experiments retain legacy exit definitions');
  assert.ok(disabled.entryProfiles.filter((profile) => [SOURCE, DELAY].includes(profile.id)
    || profile.experimentGroup === 'HO500_LONG_EXIT_V1').every((profile) => profile.newEntriesEnabled === false));
  delete process.env.FLOW_GRADUATION_ACCEL_RELAXED_ENTRY_SHADOW_ENABLED;
  delete process.env.FLOW_GRADUATION_ACCEL_HO500_LONG_EXIT_ENABLED;
  delete require.cache[configPath];
}

function testIsolatedRowsAndDelayedExecution() {
  const f = fixture();
  try {
    const old = f.seedLegacy('paired', STATUS.CLOSED);
    const source = f.enter('paired');
    const at = source.entry_at;
    assert.equal(f.rows('paired').filter((row) => row.entry_profile_id === OLD).length, 1);
    assert.deepEqual(f.row('paired', OLD), old, 'historical terminal rows must remain byte-for-byte unchanged');
    const pending = f.row('paired', DELAY);
    assert.equal(pending.status, STATUS.PENDING_ENTRY);
    assert.equal(pending.entry_at, null);
    assert.equal(pending.entry_price, null);
    assert.equal(pending.token_units, null);
    assert.equal(pending.entry_target_at, at + 1_000);
    assert.equal(pending.configured_cost_pct, source.configured_cost_pct);
    assert.equal(f.live.length, 1, 'only immediate 0.1 SOL emits a bridge signal');
    assert.equal(f.live[0].timestampMs, at);
    assert.equal(f.live[0].ammQuoteState, MODEL);
    assert.equal(f.live[0].prePoolBaseReservesRaw, '1000000000000000');
    assert.equal(f.live[0].prePoolQuoteReservesRaw, '100000000000');
    assert.equal(f.live[0].preReservePrice, 1e-7);
    const longRows = f.rows('paired').filter((row) => row.entry_profile_id.includes('_LONG_'));
    assert.equal(longRows.length, 12);
    assert.ok(longRows.every((row) => row.entry_at === at && row.entry_price === source.entry_price));
    let recomputations = 0;
    f.suite._postMigrationEntryGateDecision = () => { recomputations++; throw new Error('delayed eligibility must stay frozen'); };
    f.tick('paired', at + 999);
    assert.equal(f.row('paired', DELAY).status, STATUS.PENDING_ENTRY);
    f.tick('paired', at + 1_000, 1.01e-7, { side: 'SELL', solAmount: 100 });
    const delayed = f.row('paired', DELAY);
    assert.equal(delayed.status, STATUS.RUNNER, 'a later sell does not retroactively cancel a qualified signal');
    assert.equal(delayed.entry_at, at + 1_000);
    assert.notEqual(delayed.entry_price, source.entry_price, 'delayed quote must use the later pool state');
    assert.notEqual(delayed.token_units, source.token_units);
    assert.equal(recomputations, 0);
    assert.equal(f.live.length, 1);
    assert.equal(f.rows('paired').filter((row) => row.entry_profile_id.includes('_LONG_')).length, 12);
    const metadata = JSON.parse(delayed.features_json);
    assert.equal(metadata.executionModelVersion, MODEL);
    assert.equal(metadata.qualifiedAt, at);
    assert.equal(metadata.qualification.gate.passed, true);
    assert.equal(metadata.qualification.at, at);
    assert.equal(metadata.actualExecutionDelayMs, 1_000);
    assert.equal(metadata.pairedSourcePositionId, source.id);
    assert.equal(metadata.executionFeesAppliedSeparately, false);
    f.store.updateGraduationAccelerationShadowPosition(source.id, { status: STATUS.CLOSED, netReturnPct: 10 });
    const cohorts = f.store.graduationAccelerationShadowDashboard().cohorts;
    assert.equal(cohorts.find((row) => row.cohort_id === `${OLD}:0_1SOL`).average_net_return_pct, 98.6);
    assert.equal(cohorts.find((row) => row.cohort_id === `${SOURCE}:0_1SOL`).average_net_return_pct, 10);
    assert.equal(cohorts.find((row) => row.cohort_id === `${DELAY}:0_1SOL`).resolved, 0);
  } finally { f.dispose(); }
}

function testFreshPoolSlotAndPostRequirements() {
  const f = fixture();
  try {
    const at = f.arm('fresh');
    f.tick('fresh', at, 1e-7, { ammQuoteState: undefined });
    assert.equal(f.row('fresh').status, STATUS.PENDING_ENTRY, 'a historical/ambiguous raw row cannot seed POST samples');
    f.tick('fresh', at + 1, 1e-7, { ammQuoteState: 'INVALID' });
    assert.equal(f.row('fresh').status, STATUS.PENDING_ENTRY);
    const trade = f.tick('fresh', at + 2);
    const source = f.row('fresh');
    const target = source.entry_at + 1_000;
    const invalid = ammBuyAveragePrice({ ...trade, ammQuoteState: 'INVALID' }, 0.1, 1e-7);
    assert.equal(invalid.available, false, 'invalid state cannot fall through to reserve arithmetic');
    assert.equal(invalid.price, null);
    assert.deepEqual(ammBuyAveragePrice({ ...trade, ammQuoteState: 'FUTURE_UNKNOWN' }, 0.1, 1e-7),
      { available: false, price: null, impactPct: null });
    f.tick('fresh', target, 1e-7, { pool: 'other-pool' });
    f.tick('fresh', target + 1, 1e-7, { slot: source.entry_at });
    f.tick('fresh', target + 2, 1e-7, { chainTimestampMs: target - 4_000 });
    f.tick('fresh', target + 3, 1e-7, { ammQuoteState: 'INVALID' });
    assert.equal(f.row('fresh', DELAY).status, STATUS.PENDING_ENTRY);
    f.tick('fresh', target + 4);
    assert.equal(f.row('fresh', DELAY).entry_at, target + 4);
    assert.equal(f.live.length, 1);
  } finally { f.dispose(); }
}

function testTimeoutAndRestart() {
  const f = fixture();
  try {
    const source = f.enter('restart');
    const target = source.entry_at + 1_000;
    f.advance(source.entry_at + 500);
    f.restart();
    const pending = f.row('restart', DELAY);
    f.suite.onGraduated({ mint: 'restart', graduated_at: source.entry_at + 400 });
    assert.equal(f.row('restart', DELAY).entry_target_at, target, 'a duplicate migration event cannot move a qualified deadline');
    f.tick('restart', target, 1e-7, { chainTimestampMs: source.entry_at + 400 });
    assert.equal(f.row('restart', DELAY).status, STATUS.PENDING_ENTRY, 'pre-restart chain events are rejected');
    f.suite._postMigrationEntryGateDecision = () => { throw new Error('restart must restore qualification'); };
    f.tick('restart', target + 1);
    assert.equal(f.row('restart', DELAY).status, STATUS.RUNNER);
    assert.equal(JSON.parse(f.row('restart', DELAY).features_json).qualification.at, source.entry_at);
    assert.equal(f.live.length, 1, 'restored delayed entries never emit live signals');
    assert.equal(pending.entry_price, null);
  } finally { f.dispose(); }
  const timeout = fixture();
  try {
    timeout.enter('timeout');
    const pending = timeout.row('timeout', DELAY);
    timeout.advance(pending.entry_deadline_at + 1);
    const row = timeout.row('timeout', DELAY);
    assert.equal(row.status, STATUS.NO_ENTRY);
    assert.equal(row.rejection_reason, 'NO_POST_TRADE_IN_DELAYED_ENTRY_WINDOW');
    assert.equal(row.entry_at, null);
    assert.equal(timeout.live.length, 1);
  } finally { timeout.dispose(); }
}

function testLegacyPendingRetirementAndOpenPriceView() {
  const f = fixture();
  try {
    f.seedLegacy('retired', STATUS.PENDING_ENTRY);
    const terminal = f.seedLegacy('terminal', STATUS.CLOSED);
    f.seedLegacy('open-legacy', STATUS.RUNNER);
    f.restart();
    const retired = f.row('retired', OLD);
    assert.equal(retired.status, STATUS.NO_ENTRY);
    assert.equal(retired.rejection_reason, 'LEGACY_QUOTE_MODEL_RETIRED');
    assert.deepEqual(f.row('terminal', OLD), terminal);
    f.tick('open-legacy', f.now + 100, 5e-8, { preReservePrice: 1e-7 });
    const legacy = f.row('open-legacy', OLD);
    assert.equal(legacy.status, STATUS.RUNNER, 'post mark must not trigger a historical pre-model stop');
    assert.equal(legacy.last_price, 1e-7);
    f.tick('open-legacy', f.now + 100, 1e-9, { ammQuoteState: 'FUTURE_UNKNOWN' });
    assert.equal(f.row('open-legacy', OLD).last_price, 1e-7, 'an unknown model cannot mark a legacy row');
    const triggerAt = f.now + 100;
    f.tick('open-legacy', triggerAt, 5e-8, {
      preReservePrice: 6e-8, prePoolQuoteReservesRaw: '60000000000',
    });
    assert.equal(f.row('open-legacy', OLD).status, STATUS.EXIT_PENDING);
    f.tick('open-legacy', triggerAt + f.settings.exitDelayMs, 4e-8, {
      preReservePrice: 5e-8, prePoolQuoteReservesRaw: '50000000000',
    });
    const closed = f.row('open-legacy', OLD);
    assert.equal(closed.status, STATUS.CLOSED, 'the legacy view remains accepted by the shared execution calculator');
    assert.ok(closed.exit_price > 4.9e-8 && closed.exit_price < 5e-8, 'legacy exit uses pre reserves with capacity impact');
    assert.equal(f.live.length, 0);
  } finally { f.dispose(); }
}

function testPendingCursorsBeforeTargetAndAcrossRestart() {
  for (const restart of [false, true]) {
    const f = fixture();
    try {
      const mint = `cursor-${restart}`;
      const source = f.enter(mint);
      const at = source.entry_at;
      const latest = f.tick(mint, at + 900, 1.02e-7, { eventIndex: 2 });
      const persisted = JSON.parse(f.row(mint, DELAY).features_json).postEntryTradeCursor;
      assert.equal(persisted.slot, at + 900, 'the pending cursor advances before the 1s target');
      assert.equal(persisted.chainTimestampMs, at + 900);
      assert.equal(persisted.signature, latest.signature);
      assert.equal(persisted.eventIndex, 2);
      if (restart) { f.advance(at + 950); f.restart(); }
      f.tick(mint, at + 1_000, 5e-8, {
        slot: at + 500, chainTimestampMs: restart ? at + 1_000 : at + 500,
      });
      assert.equal(f.row(mint, DELAY).status, STATUS.PENDING_ENTRY, 'a lower slot cannot fill after observing a newer pre-target event');
      f.tick(mint, at + 1_001, 5e-8, {
        slot: latest.slot, chainTimestampMs: at + 1_001, signature: latest.signature, eventIndex: 2,
      });
      f.tick(mint, at + 1_002, 5e-8, {
        slot: latest.slot, chainTimestampMs: at + 1_002, signature: latest.signature, eventIndex: 1,
      });
      assert.equal(f.row(mint, DELAY).status, STATUS.PENDING_ENTRY, 'duplicates and earlier events of one transaction cannot fill');
      f.tick(mint, at + 1_100, 1.01e-7);
      assert.equal(f.row(mint, DELAY).entry_at, at + 1_100, 'the first newer accepted event fills without self-rejecting');
      assert.equal(f.live.length, 1);
    } finally { f.dispose(); }
  }
  const f = fixture();
  try {
    const at = f.arm('immediate-cursor');
    const first = f.tick('immediate-cursor', at - 200, 1e-7, { slot: 500, eventIndex: 2 });
    const cursor = JSON.parse(f.row('immediate-cursor').features_json).postEntryTradeCursor;
    assert.equal(cursor.pool, 'immediate-cursor-pool');
    assert.equal(cursor.slot, 500);
    f.tick('immediate-cursor', at, 1e-7, { pool: 'other-pool', slot: 501 });
    f.tick('immediate-cursor', at + 1, 1e-7, { slot: 499 });
    f.tick('immediate-cursor', at + 2, 1e-7, { slot: 500, signature: first.signature, eventIndex: 2 });
    assert.equal(f.row('immediate-cursor').status, STATUS.PENDING_ENTRY, 'immediate pending also freezes its first pool and advances monotonically');
    f.tick('immediate-cursor', at + 3, 1e-7, { slot: 500, signature: first.signature, eventIndex: 3 });
    assert.equal(f.row('immediate-cursor').entry_at, at + 3);
  } finally { f.dispose(); }
}

function testInvalidWindowEvidenceCannotQualifyPostEntry() {
  for (const [label, invalid] of [
    ['stale', (at) => ({ chainTimestampMs: at - 120_000 })],
    ['missing-slot', () => ({ slot: null })],
    ['missing-chain', () => ({ chainTimestampMs: null })],
    ['invalid', () => ({ ammQuoteState: 'INVALID' })],
  ]) {
    const f = fixture();
    try {
      const at = f.arm(label);
      f.tick(label, at - 100, 1e-7, { side: 'BUY', solAmount: 2, ...invalid(at) });
      f.tick(label, at, 1e-7, { side: 'SELL', solAmount: 0.01 });
      assert.equal(f.row(label).status, STATUS.NO_ENTRY, `${label} BUY evidence must not make the fresh SELL eligible`);
      assert.equal(f.row(label, DELAY), undefined);
      assert.equal(f.live.length, 0);
    } finally { f.dispose(); }
  }
  const ordered = fixture();
  try {
    const at = ordered.arm('low-slot-window');
    ordered.tick('low-slot-window', at - 200, 1e-7, { side: 'SELL', solAmount: 0.01, slot: 500 });
    ordered.tick('low-slot-window', at - 150, 1e-7, { side: 'BUY', solAmount: 2, slot: 499 });
    ordered.tick('low-slot-window', at, 1e-7, { side: 'SELL', solAmount: 0.01, slot: 501 });
    assert.equal(ordered.row('low-slot-window').status, STATUS.NO_ENTRY,
      'a BUY below the mint cursor cannot enter the qualification window');
    assert.equal(ordered.live.length, 0);
  } finally { ordered.dispose(); }
  const f = fixture();
  try {
    const at = f.arm('replay');
    const replayTrade = { mint: 'replay', market: 'PUMP_AMM', timestampMs: at - 100,
      receivedAtMs: at - 100, chainTimestampMs: at - 100, slot: at - 100,
      pool: 'replay-pool', signature: 'replay-buy', eventIndex: 0,
      side: 'BUY', wallet: 'replay-buyer', solAmount: 2, price: 1e-7, reservePrice: 1e-7,
      ammQuoteState: MODEL,
    };
    f.store.recentAmmTrades = () => [replayTrade];
    f.advance(at - 50);
    f.restart();
    f.tick('replay', at, 1e-7, { side: 'SELL', solAmount: 0.01 });
    assert.equal(f.row('replay').status, STATUS.NO_ENTRY, 'startup replay cannot be relabeled as fresh POST window evidence');
    assert.equal(f.live.length, 0);
  } finally { f.dispose(); }
}

function testAtomicDelayedDenominator() {
  const f = fixture();
  try {
    const at = f.arm('atomic-delay');
    const original = f.store.createGraduationAccelerationShadowPosition.bind(f.store);
    f.store.createGraduationAccelerationShadowPosition = (position) => {
      if (position.entryProfileId === DELAY) throw new Error('injected delayed insert failure');
      return original(position);
    };
    assert.throws(() => f.tick('atomic-delay', at), /injected delayed insert failure/);
    assert.equal(f.rows('atomic-delay').length, 2, 'source, long pairs and delayed denominator roll back together');
    assert.ok(f.rows('atomic-delay').every((row) => row.status === STATUS.PENDING_ENTRY && row.entry_at == null));
    assert.equal(f.live.length, 0, 'an uncommitted source cannot emit the bridge');
    f.store.createGraduationAccelerationShadowPosition = original;
    f.tick('atomic-delay', at + 1);
    assert.equal(f.row('atomic-delay').status, STATUS.RUNNER);
    assert.equal(f.row('atomic-delay', DELAY).status, STATUS.PENDING_ENTRY);
    assert.equal(f.rows('atomic-delay').filter((row) => row.entry_profile_id.includes('_LONG_')).length, 12);
    assert.equal(f.live.length, 1);
  } finally { f.dispose(); }
}

testConfigIsolation();
testIsolatedRowsAndDelayedExecution();
testFreshPoolSlotAndPostRequirements();
testTimeoutAndRestart();
testLegacyPendingRetirementAndOpenPriceView();
testPendingCursorsBeforeTargetAndAcrossRestart();
testInvalidWindowEvidenceCannotQualifyPostEntry();
testAtomicDelayedDenominator();
console.log('test-ho500-post-trade-model: ok (version isolation, frozen qualification, delayed fills, freshness, restore, legacy drain, no live delay)');
