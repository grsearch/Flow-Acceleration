'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { MigrationSecondLegShadowSuite } = require('../src/core/MigrationSecondLegShadowSuite');
const { matchesLegacyEntry, migrationEvidence, EXECUTION_VERSION } = require('../src/core/LegacyEarlyFlowEntryTracker');
const strict = require('../src/core/StrictAmmShadowExecution');
const { PreEntryRugRiskTracker } = require('../src/core/PreEntryRugRiskTracker');

const T = 1_920_000_000_000;
const PRICE = 4e-7;
const BASE = 'LEGACY-EARLY-FLOW-BASE';
const RUGX = 'LEGACY-EARLY-FLOW-RUGX';
const costs = { platformFeePct: 1, buySlippagePct: 0, sellSlippagePct: 0,
  priceImpactPct: 9, baseTxFeeSol: 0.00001, priorityFeeSol: 0.0001,
  jitoTipSol: 0, fixedCostSol: 0, entryFailureRatePct: 0, entryFailureCostPct: 0 };
function configuration() {
  return { enabled: true, newEntriesEnabled: true, positionSizeSol: 1, costModel: costs,
    entryDelayMs: 100, exitDelayMs: 100, entryTimeoutMs: 15_000, exitTimeoutMs: 15_000,
    noExitObservationMs: 60_000,
    cohorts: [BASE, RUGX].map(id => ({ id, enabled: true, entryMode: 'LEGACY_EARLY_FLOW',
      executionVersion: EXECUTION_VERSION, strictExecution: { version: strict.VERSION },
      confirmationMode: 'IMMEDIATE', positionSizeSol: 0.02, costModel: costs,
      hardStopPct: 30, trailingActivationPct: 10, trailingStopPct: 5, maxHoldMs: 1_800_000,
      maxEntryPriceJumpPct: 15, maxNegativeEntryJumpPct: 50, maxEntryImpactPct: 15,
      rugGuardMode: id === BASE ? 'LABEL_ONLY' : 'HARD_BLOCK',
      liveBridgeEnabled: id === RUGX, liveStrategyId: id === RUGX ? 'legacy_early_flow_rugx_live' : null })) };
}
function quote(mint, at, price = PRICE, patch = {}) {
  return { mint, timestampMs: at, receivedAtMs: at, chainTimestampMs: at,
    market: 'PUMP_AMM', ammQuoteState: 'POST_TRADE_V1', pool: `${mint}-pool`,
    poolBaseReservesRaw: '1000000000000000',
    poolQuoteReservesRaw: String(Math.round(price * 1e9 * 1e9)), virtualQuoteReservesRaw: '0',
    price, reservePrice: price, signature: `${mint}:${at}`, slot: at - T + 100_000,
    eventIndex: 0, wallet: `wallet-${at % 3}`, solAmount: 0.1, tokenAmount: 0.1 / price,
    side: 'BUY', ...patch };
}
function fixture(mint = 'legacy-test', { guard = 'clear', token = true, reference = true } = {}) {
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000 }, { configuredTradingCostPct: 0 });
  let now = T; const calls = []; const guards = [];
  if (guard !== 'missing') store.preEntryRugRisk = { config: { enabled: true }, evaluateGuard(args) {
    guards.push(args);
    return { enabled: true, sampleReady: true, blocked: guard === 'blocked' && args.enforcementMode === 'HARD_BLOCK',
      flagged: guard === 'blocked', reason: guard === 'blocked' ? 'TOXIC_ACTOR' : null };
  } };
  if (token) {
    store.recordCreate({ mint, symbol: mint, name: null, uri: null, bondingCurve: null, creator: null,
      tokenTotalSupplyRaw: '1000000000000000',
      initialRealTokenReservesRaw: '1000000000000000', createdAt: T - 10_000 });
    store.recordComplete({ mint, completedAt: T - 20_000, timestampMs: T - 20_000 });
    store.recordMigration({ mint, migratedAt: T, timestampMs: T, pool: `${mint}-pool` });
  }
  let config = configuration();
  const getSolUsdReference = () => typeof reference === 'function' ? reference(now)
    : reference ? { priceUsd: 100, observedAt: now - 1_000,
      expiresAt: now + 60_000, source: 'TEST_CACHED_REFERENCE' } : null;
  let suite = new MigrationSecondLegShadowSuite({ config, store, now: () => now,
    getSolUsdReference, onLiveSignal: event => calls.push(event) });
  const api = { mint, store, calls, guards,
    get suite() { return suite; }, get now() { return now; },
    setNow(offset) { now = T + offset; },
    emit(offset, price = PRICE, patch = {}) {
      now = T + offset; const trade = quote(mint, now, price, patch);
      suite.observeTrade(trade); return trade;
    },
    seed() { for (let offset = 5_000; offset <= 15_000; offset += 1_000) api.emit(offset); },
    rows() { return store.db.prepare('SELECT * FROM migration_second_leg_shadow_positions ORDER BY id').all(); },
    restart(offset, overrides = {}) {
      now = T + offset; config = { ...configuration(), ...overrides };
      suite = new MigrationSecondLegShadowSuite({ config, store, now: () => now,
        getSolUsdReference, onLiveSignal: event => calls.push(event) });
      suite.start(); return suite;
    },
  };
  return api;
}
function done(f) { f.suite.stop(); f.store.close(); }

function thresholdTests() {
  const valid = { ageMs: 15_000, fdvUsd: 15_000, priceChange10sPct: -10,
    netFlow1sSol: 0.1, buyers5s: 3, trades5s: 4, maxSingleBuyShare5s: 0.7 };
  assert(matchesLegacyEntry(valid));
  assert(matchesLegacyEntry({ ...valid, ageMs: 25_000, fdvUsd: 100_000, priceChange10sPct: 8 }));
  for (const patch of [{ ageMs: 14_999 }, { ageMs: 25_001 }, { fdvUsd: 14_999 },
    { fdvUsd: 100_001 }, { priceChange10sPct: -10.01 }, { priceChange10sPct: 8.01 },
    { netFlow1sSol: 0 }, { buyers5s: 2 }, { trades5s: 3 }, { maxSingleBuyShare5s: 0.7001 },
    { ageMs: null }, { fdvUsd: NaN }]) assert(!matchesLegacyEntry({ ...valid, ...patch }), JSON.stringify(patch));
  assert.strictEqual(migrationEvidence({ timestampMs: T }), null, 'arbitrary timestamp is not migration');
  assert.strictEqual(migrationEvidence({ timestampMs: T }, true).migrationSource, 'EXPLICIT_GRADUATION');
  assert.strictEqual(migrationEvidence({ migrated_at: T, graduated_at: T - 10_000 }).migrationAt, T);
}

function sourceAndFillTests() {
  const f = fixture();
  // No SmartWallet API is installed on the store; the entry must work unaided.
  f.seed();
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.suite.pendingEntries.size, 2);
  assert.strictEqual(f.suite.health().legacyEarlyFlow.sourceSignals, 1);
  assert.strictEqual(f.suite.health().legacyEarlyFlow.matched, 1, 'count shared source, not its two cohort rows');
  assert.strictEqual(f.suite.health().legacyEarlyFlow.cohortSignals, 2);
  assert.strictEqual(f.suite.health().sourceDiagnostics.sourceSignals, 1);
  const event = f.calls[0];
  assert.strictEqual(event.strategyId, 'legacy_early_flow_rugx_live');
  assert.strictEqual(event.features.sourceCohortId, RUGX);
  assert.strictEqual(event.features.calibrationVersion, EXECUTION_VERSION);
  assert.strictEqual(event.features.shadowPositionSol, 0.02);
  assert.strictEqual(event.features.migrationAt, T, 'confirmed migration takes precedence over older completion');
  assert.strictEqual(event.features.fdvUsd, 40_000);
  assert.strictEqual(event.price, PRICE);
  assert.strictEqual(event.features.sourceGuard.evaluatedLifecycleAgeMs, null,
    'a stub or unavailable observed age is unknown, never zero');
  const initial = f.rows();
  assert.strictEqual(initial[0].episode_id, initial[1].episode_id);
  assert.strictEqual(initial[0].signal_at, initial[1].signal_at);
  assert.strictEqual(initial[0].entry_target_at, T + 16_000);
  assert(Math.abs(initial[0].configured_cost_pct - 1.55) < 1e-12, 'fixed cost divided by .02 SOL, no duplicate impact');
  assert.deepStrictEqual(f.guards[1].hardBlockSignatures, ['crossMintToxicWallets', 'crossMintToxicTemplate']);
  assert.strictEqual(f.guards[1].lifecycleStage, 'AMM_MATURE');
  f.emit(15_500);
  f.emit(16_000, PRICE, { chainTimestampMs: T + 15_999 });
  assert.strictEqual(f.suite.positions.size, 0, 'chain execution target is independent of received time');
  f.emit(16_100, PRICE, { pool: 'wrong-pool' });
  f.emit(16_200, PRICE, { chainTimestampMs: T + 12_000 });
  f.emit(16_300, PRICE, { ammQuoteState: undefined });
  assert.strictEqual(f.suite.positions.size, 0);
  f.emit(16_400, PRICE, { price: null, reservePrice: null });
  assert.strictEqual(f.suite.positions.size, 2, 'post reserves, not caller supplied mark, set execution');
  const rows = f.rows();
  assert.strictEqual(rows[0].entry_price, rows[1].entry_price);
  assert.strictEqual(rows[0].entry_at, rows[1].entry_at);
  const snapshot = JSON.parse(rows[0].features_json).strictExecution;
  assert(snapshot.tokenUnits > 0);
  assert.strictEqual(snapshot.policy.entryDelayMs, 1_000);
  assert.strictEqual(snapshot.costs.priceImpactPct, 0);
  const writes = [];
  const original = f.store.updateMigrationSecondLegShadowPosition.bind(f.store);
  f.store.updateMigrationSecondLegShadowPosition = (...args) => { writes.push(args); return original(...args); };
  for (let offset = 16_401; offset <= 16_999; offset++) f.emit(offset);
  assert(writes.length <= 2, `bounded cursor writes, got ${writes.length}`);
  const peak = [...f.suite.positions.values()][0].highestPrice;
  f.emit(17_000, PRICE * 100, { slot: 100_001 });
  assert.strictEqual([...f.suite.positions.values()][0].highestPrice, peak);
  f.suite.observeTrade(quote(f.mint, T + 16_999, PRICE * 100));
  assert.strictEqual([...f.suite.positions.values()][0].highestPrice, peak, 'duplicate cannot change peak');
  assert.strictEqual(f.calls.length, 1);
  done(f);
}

function guardAndUnknownTests() {
  for (const guard of ['blocked', 'missing']) {
    const f = fixture(`guard-${guard}`, { guard }); f.seed();
    assert.strictEqual(f.calls.length, 0);
    const rows = f.rows();
    assert.strictEqual(rows[0].status, 'PENDING_ENTRY');
    assert.strictEqual(rows[1].status, 'NO_ENTRY');
    assert(rows[1].rejection_reason.startsWith('PRE_ENTRY_RUG_'));
    assert.strictEqual(rows[0].signal_at, rows[1].signal_at);
    f.emit(16_100); assert.strictEqual(f.suite.positions.size, 1);
    done(f);
  }
  for (const options of [{ token: false }, { reference: false }]) {
    const f = fixture(`unknown-${Object.keys(options)[0]}`, options); f.seed();
    assert.strictEqual(f.rows().length, 0);
    assert.strictEqual(f.calls.length, 0);
    done(f);
  }
  const f = fixture('missing-supply');
  f.store.getToken(f.mint).token_total_supply_raw = null;
  f.seed(); assert.strictEqual(f.rows().length, 0); done(f);
}

function exitTests() {
  const h = fixture('hard-stop'); h.seed(); h.emit(16_000);
  h.emit(17_000, PRICE * 0.69);
  assert(h.rows().every(row => row.status === 'EXIT_PENDING' && row.exit_reason === 'HARD_STOP'));
  h.emit(17_999, PRICE * 0.68);
  assert(h.rows().every(row => row.status === 'EXIT_PENDING'));
  h.emit(18_000, PRICE * 0.68);
  assert(h.rows().every(row => row.status === 'CLOSED' && row.net_return_pct < -32));
  done(h);
  const t = fixture('trail'); t.seed(); t.emit(16_000);
  t.emit(17_000, PRICE * 1.2); t.emit(18_000, PRICE * 1.13);
  assert(t.rows().every(row => row.status === 'EXIT_PENDING' && row.exit_reason === 'TRAILING_STOP_A10_D5'));
  t.emit(19_000, PRICE * 1.12);
  assert(t.rows().every(row => row.status === 'CLOSED' && row.net_return_pct > 10));
  done(t);
  const n = fixture('timeout'); n.seed(); n.emit(16_000);
  const holdAt = 16_000 + 1_800_000;
  n.setNow(holdAt); n.suite.advanceTime(n.now);
  assert(n.rows().every(row => row.status === 'EXIT_PENDING' && row.exit_target_at === T + holdAt + 1_000));
  n.emit(holdAt + 1_000, PRICE, { chainTimestampMs: T + 16_000 });
  n.emit(holdAt + 2_000, PRICE, { poolQuoteReservesRaw: '0', virtualQuoteReservesRaw: '0' });
  n.setNow(holdAt + 16_001); n.suite.advanceTime(n.now);
  assert(n.rows().every(row => row.status === 'NO_EXIT' && row.net_return_pct === null && row.exit_price === null),
    'missing/old reserves do not fabricate a zero-proceeds loss');
  n.emit(holdAt + 17_000, PRICE * 0.99);
  assert(n.rows().every(row => row.status === 'NO_EXIT' && row.late_exit_status === 'OBSERVED_EXECUTABLE'),
    'late quote is separate from original completion stats');
  done(n);
}

function recoveryTests() {
  const f = fixture('recovery'); f.seed(); f.emit(16_000); f.emit(17_000, PRICE * 1.2);
  f.restart(18_000, { cohorts: [], newEntriesEnabled: false });
  assert.strictEqual(f.suite.positions.size, 2, 'removed cohort still restores its frozen exit');
  f.emit(18_100, PRICE * 0.5, { chainTimestampMs: T + 17_999 });
  assert(f.rows().every(row => row.status === 'OPEN'), 'pre-restart quote cannot trigger exit');
  f.emit(18_200, PRICE * 1.13); f.emit(19_200, PRICE * 1.12);
  assert(f.rows().every(row => row.status === 'CLOSED'));
  f.restart(19_300);
  // Rebuild a fresh partial window while still inside migration age. The old source row
  // wins the unique key; neither the base nor filtered can bridge again.
  for (let offset = 19_400; offset <= 24_400; offset += 1_000) f.emit(offset);
  assert(f.suite.metrics.deduplicated >= 2, 'new qualifying source reaches persisted unique-key dedup');
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.rows().length, 2);
  done(f);
  const pending = fixture('pending-restart'); pending.seed(); pending.restart(15_500);
  pending.emit(16_000);
  assert.strictEqual(pending.suite.positions.size, 2);
  assert.strictEqual(pending.calls.length, 1, 'pending restore never re-emits source');
  done(pending);
  const invalid = fixture('corrupt'); invalid.seed(); invalid.emit(16_000);
  invalid.store.db.prepare('UPDATE migration_second_leg_shadow_positions SET features_json=?').run('{}');
  invalid.restart(18_000);
  assert.strictEqual(invalid.suite.positions.size, 0);
  assert(invalid.rows().every(row => row.status === 'DATA_ERROR'));
  done(invalid);
  const peak = fixture('restart-fast-peak'); peak.seed(); peak.emit(16_000);
  peak.emit(16_200, PRICE * 1.2);
  assert(peak.rows().every(row => row.highest_price === PRICE * 1.2),
    'new watermark persists immediately even within the one-second cursor interval');
  peak.suite.stop(); peak.restart(16_500);
  peak.emit(16_700, PRICE * 1.13);
  assert(peak.rows().every(row => row.status === 'EXIT_PENDING'
    && row.exit_reason === 'TRAILING_STOP_A10_D5'));
  peak.restart(16_800);
  assert(peak.rows().every(row => row.exit_target_at === T + 17_700),
    'stop trigger and delayed exit survive another restart');
  peak.emit(17_700, PRICE * 1.12);
  assert(peak.rows().every(row => row.status === 'CLOSED'));
  done(peak);
}

function boundaryTests() {
  const partial = fixture('partial-window');
  for (let offset = 10_000; offset <= 15_000; offset += 1_000) partial.emit(offset);
  assert.strictEqual(partial.calls.length, 1, 'legacy entry permits causal partial history');
  assert.strictEqual(partial.calls[0].features.priceWindowComplete, false);
  assert.strictEqual(partial.calls[0].features.priceWindowSpanMs, 5_000);
  done(partial);
  const evidence = fixture('source-evidence');
  for (let offset = 5_000; offset < 15_000; offset += 1_000) evidence.emit(offset);
  evidence.emit(15_000, PRICE, { prePoolBaseReservesRaw: '1001', prePoolQuoteReservesRaw: '2002',
    preReservePrice: PRICE * 0.99, ammQuoteStateReason: null,
    ammExecutionFees: { lpFeeRaw: '123', lpFeeBasisPoints: 20, ixName: 'buy', unexpected: { nested: 'not copied' } } });
  assert.strictEqual(evidence.calls[0].prePoolBaseReservesRaw, '1001');
  assert.strictEqual(evidence.calls[0].prePoolQuoteReservesRaw, '2002');
  assert.deepStrictEqual(evidence.calls[0].ammExecutionFees, { lpFeeBasisPoints: 20, lpFeeRaw: '123', ixName: 'buy' });
  assert.strictEqual(JSON.parse(evidence.rows()[0].features_json).strictExecution.source.ammExecutionFees.lpFeeRaw, '123');
  done(evidence);
  for (const reference of [
    now => ({ priceUsd: 100, observedAt: now + 1, expiresAt: now + 60_000 }),
    now => ({ priceUsd: 100, observedAt: now - 300_001, expiresAt: now + 1 }),
    now => ({ priceUsd: 100, observedAt: now - 1_000, expiresAt: now - 1 }),
    now => ({ priceUsd: 0, observedAt: now - 1_000, expiresAt: now + 1 }),
  ]) {
    const f = fixture('reference-invalid', { reference }); f.seed();
    assert.strictEqual(f.calls.length, 0);
    assert.strictEqual(f.rows().length, 0);
    assert(f.suite.legacyTracker.metrics.rejectedByReason.FDV_REFERENCE_UNAVAILABLE > 0);
    done(f);
  }
  const lateReference = fixture('reference-after-source', {
    reference: now => ({ priceUsd: 100, observedAt: now, expiresAt: now + 60_000 }) });
  for (let offset = 5_000; offset <= 15_000; offset += 1_000) {
    lateReference.setNow(offset + 100);
    lateReference.suite.observeTrade(quote(lateReference.mint, T + offset));
  }
  assert.strictEqual(lateReference.calls.length, 0, 'do not apply USD observed after source ingestion');
  done(lateReference);

  const atomic = fixture('atomic-source');
  const create = atomic.store.createMigrationSecondLegShadowPosition.bind(atomic.store);
  let attempts = 0;
  atomic.store.createMigrationSecondLegShadowPosition = record => {
    attempts += 1;
    if (attempts === 2) throw new Error('SQLITE_BUSY');
    return create(record);
  };
  atomic.seed();
  assert.strictEqual(atomic.rows().length, 0, 'pair insert failure rolls baseline back');
  assert.strictEqual(atomic.calls.length, 0);
  assert.strictEqual(atomic.suite.pendingEntries.size, 0);
  atomic.emit(16_000);
  assert.strictEqual(atomic.rows().length, 2);
  assert.strictEqual(atomic.calls.length, 1);
  assert.strictEqual(atomic.rows()[0].signal_at, atomic.rows()[1].signal_at);
  done(atomic);
  const bridge = fixture('bridge-error');
  bridge.suite.onLiveSignal = () => { throw new Error('bounded callback error'); };
  bridge.seed(); bridge.emit(16_000);
  assert.strictEqual(bridge.suite.legacyMetrics.liveBridgeErrors, 1);
  assert.strictEqual(bridge.rows().length, 2, 'bridge error cannot discard valid Shadow evidence');
  assert(bridge.rows().every(row => row.status === 'OPEN'));
  done(bridge);
  const missedFill = fixture('source-no-entry'); missedFill.seed();
  missedFill.setNow(31_001); missedFill.suite.advanceTime(missedFill.now);
  assert(missedFill.rows().every(row => row.status === 'NO_ENTRY'));
  assert.strictEqual(missedFill.calls.length, 1, 'source bridge precedes any later simulated fill failure');
  done(missedFill);
  const staleAnchor = fixture('stale-anchor');
  staleAnchor.emit(0, PRICE * 100);
  for (let offset = 11_000; offset <= 15_000; offset += 1_000) staleAnchor.emit(offset);
  assert.strictEqual(staleAnchor.calls.length, 1);
  assert(staleAnchor.calls[0].features.priceWindowStartAt >= T + 11_000, 'ancient anchor is pruned');
  done(staleAnchor);
}

function entryImpactTests() {
  const f = fixture('self-impact'); f.seed();
  const poolQuoteSol = 0.1;
  const mark = PRICE * 0.9;
  const trade = quote(f.mint, T + 16_000, mark, {
    poolQuoteReservesRaw: String(poolQuoteSol * 1e9),
    poolBaseReservesRaw: String(Math.round(poolQuoteSol / mark * 1e6)),
  });
  const execution = strict.buy(trade, 0.02, mark);
  assert(execution.available && execution.impactPct > 15);
  assert((execution.price / PRICE - 1) * 100 < 15,
    'the market decline masks self-impact in the combined source-to-entry jump');
  f.setNow(16_000); f.suite.observeTrade(trade);
  assert(f.rows().every(row => row.status === 'NO_ENTRY'
    && row.rejection_reason === 'ENTRY_SELF_IMPACT' && row.entry_at === null));
  assert.strictEqual(f.calls.length, 1, 'source bridge remains distinct from later simulated rejection');
  assert(f.rows().every(row => JSON.parse(row.features_json).strictExecution.cohort.maxEntryImpactPct === 15));
  done(f);
}

function persistenceFailureTests() {
  const opening = fixture('opening-write-failure'); opening.seed();
  const update = opening.store.updateMigrationSecondLegShadowPosition.bind(opening.store);
  let failed = false;
  opening.store.updateMigrationSecondLegShadowPosition = (id, patch) => {
    if (!failed && patch.status === 'OPEN') { failed = true; throw new Error('SQLITE_BUSY'); }
    return update(id, patch);
  };
  assert.doesNotThrow(() => opening.emit(16_000));
  assert.deepStrictEqual(opening.rows().map(row => row.status), ['DATA_ERROR', 'OPEN']);
  assert.strictEqual(opening.suite.pendingEntries.size, 0);
  assert.strictEqual(opening.suite.positions.size, 1);
  assert.strictEqual(opening.rows()[0].entry_at, null, 'failed commit never claims a filled entry');
  assert.strictEqual(JSON.parse(opening.rows()[0].features_json).persistenceFailure.priorStatus, 'PENDING_ENTRY');
  assert.strictEqual(opening.suite.health().legacyEarlyFlow.pendingErrors, 0);
  opening.emit(17_000, PRICE * 0.69); opening.emit(18_000, PRICE * 0.68);
  assert.deepStrictEqual(opening.rows().map(row => row.status), ['DATA_ERROR', 'CLOSED']);
  const dashboard = opening.store.migrationSecondLegShadowDashboard({ positionLimit: 10 });
  const pair = dashboard.legacyEarlyFlow?.rugComparison
    || dashboard.legacyEarlyFlow?.rugComparisons?.[0]
    || dashboard.rugComparisons?.find(row => row.id === 'LEGACY-EARLY-FLOW-STRICT-PAIR');
  assert(pair, 'new strict pair statistics are available');
  assert.strictEqual(pair.comparableResolved, 0, 'DATA_ERROR is not an avoided RUG or profitable pair');
  assert.strictEqual(pair.averageNetReturnLiftPct, null);
  opening.restart(19_000);
  assert.strictEqual(opening.suite.pendingEntries.size, 0);
  assert.strictEqual(opening.calls.length, 1, 'recovery cannot repeat live source');
  done(opening);

  const deferred = fixture('deferred-error-record'); deferred.seed();
  const original = deferred.store.updateMigrationSecondLegShadowPosition.bind(deferred.store);
  const failedId = deferred.rows()[0].id;
  let writable = false; let tried = 0;
  deferred.store.updateMigrationSecondLegShadowPosition = (id, patch) => {
    if (id === failedId && !writable && ['OPEN', 'DATA_ERROR'].includes(patch.status)) {
      tried += 1; throw new Error('SQLITE_LOCKED');
    }
    return original(id, patch);
  };
  deferred.emit(16_000);
  assert.strictEqual(deferred.suite.health().legacyEarlyFlow.pendingErrors, 1);
  assert.strictEqual(deferred.suite.pendingEntries.size, 0, 'unknown row is isolated from ordinary timeout');
  deferred.setNow(16_999); deferred.suite.advanceTime(deferred.now);
  assert.strictEqual(tried, 2, 'no busy-loop retries before one second');
  deferred.emit(17_000, PRICE * 1.01);
  writable = true;
  deferred.setNow(32_000); deferred.suite.advanceTime(deferred.now);
  assert.strictEqual(deferred.rows()[0].status, 'DATA_ERROR');
  assert.strictEqual(deferred.rows()[0].rejection_reason, 'SHADOW_STATE_PERSISTENCE_FAILED');
  assert.strictEqual(deferred.suite.health().legacyEarlyFlow.pendingErrors, 0);
  assert.strictEqual(deferred.suite.metrics.noEntry, 0, 'not rewritten as ENTRY_TIMEOUT');
  done(deferred);

  const unsaved = fixture('unsaved-unknown-restart'); unsaved.seed();
  const save = unsaved.store.updateMigrationSecondLegShadowPosition.bind(unsaved.store);
  const unsavedId = unsaved.rows()[0].id;
  let persist = false;
  unsaved.store.updateMigrationSecondLegShadowPosition = (id, patch) => {
    if (id === unsavedId && !persist && ['OPEN', 'DATA_ERROR'].includes(patch.status)) {
      throw new Error('SQLITE_BUSY');
    }
    return save(id, patch);
  };
  unsaved.emit(16_000);
  assert.throws(() => unsaved.suite.stop(), error => error.code === 'LEGACY_SHADOW_PERSISTENCE_PENDING'
    && error.pendingErrors === 1, 'cannot report a clean shutdown after losing an unknown outcome');
  persist = true;
  unsaved.restart(16_500); unsaved.emit(16_700);
  assert.strictEqual(unsaved.rows()[0].status, 'DATA_ERROR');
  assert.strictEqual(unsaved.rows()[0].entry_at, null,
    'restart after target cannot replace a failed original fill with a later quote');
  assert.strictEqual(unsaved.rows()[1].entry_at, T + 16_000);
  done(unsaved);

  for (const mode of ['trigger', 'maxhold', 'noexit', 'stop']) {
    const f = fixture(`write-failure-${mode}`); f.seed(); f.emit(16_000);
    const write = f.store.updateMigrationSecondLegShadowPosition.bind(f.store);
    let thrown = false;
    f.store.updateMigrationSecondLegShadowPosition = (id, patch) => {
      const shouldFail = mode === 'stop' ? !patch.status
        : mode === 'noexit' ? patch.status === 'NO_EXIT' : patch.status === 'EXIT_PENDING';
      if (!thrown && shouldFail) { thrown = true; throw new Error('SQLITE_BUSY'); }
      return write(id, patch);
    };
    if (mode === 'trigger') f.emit(17_000, PRICE * 0.69);
    if (mode === 'maxhold' || mode === 'noexit') {
      f.setNow(1_816_000); f.suite.advanceTime(f.now);
      if (mode === 'noexit') { f.setNow(1_832_001); f.suite.advanceTime(f.now); }
    }
    if (mode === 'stop') f.suite.stop();
    assert(thrown);
    assert.strictEqual(f.rows()[0].status, 'DATA_ERROR', mode);
    assert.strictEqual(f.suite.health().legacyEarlyFlow.persistenceFailedRows, 1);
    if (mode !== 'noexit') assert.strictEqual(f.rows()[0].exit_trigger_at, null,
      'failed exit transition is not published as durable');
    assert.strictEqual(f.suite.health().legacyEarlyFlow.pendingErrors, 0);
    done(f);
  }
  const interrupted = fixture('interrupted-entry'); interrupted.seed(); interrupted.restart(40_000);
  assert(interrupted.rows().every(row => row.status === 'DATA_ERROR'
    && row.rejection_reason === 'LEGACY_RESTART_PENDING_OUTCOME_UNKNOWN'));
  assert.strictEqual(interrupted.suite.metrics.noEntry, 0);
  done(interrupted);
  const atTarget = fixture('restart-at-entry-target'); atTarget.seed(); atTarget.restart(16_000);
  atTarget.emit(16_000);
  assert(atTarget.rows().every(row => row.status === 'DATA_ERROR' && row.entry_at === null));
  done(atTarget);
}

function actualRugLifecycleTests() {
  const f = fixture('actual-rug-clock');
  const tracker = new PreEntryRugRiskTracker({ now: () => f.now, config: {
    enabled: true, windowMs: 15_000, stateRetentionMs: 60_000, maxEventsPerMint: 256,
    cacheMaxAgeMs: 1_000, minTrades: 10, minFlags: 5,
    firstCliffLifecycleEnabled: true, firstCliffAmmEarlyMaxAgeMs: 10_000,
    crossMintEnabled: true, templateMinLargeBuys: 4, templateMaxLargeBuys: 6,
    templateLargeBuyMinSol: 1, templateMinTotalBuySol: 40, templateMaxBurstSpanMs: 500,
  } });
  f.store.preEntryRugRisk = tracker;
  const fingerprint = tracker._templateFingerprint([10, 10, 10, 10], 30, 'AMM_EARLY', 'PUMP_AMM');
  tracker._ingestToxicMemory({ templates: [{ fingerprint, lifecycleStage: 'AMM_EARLY',
    market: 'PUMP_AMM', labeledAt: T - 1000, expiresAt: T + 100_000,
    amounts: [10, 10, 10, 10], largeBuyCount: 4, burstSpanMs: 30 }] }, T);
  for (const [offset, amount, wallet] of [[5_000, 0.1, 'first-observed'],
    [14_970, 10, 'actor-a'], [14_980, 10, 'actor-b'],
    [14_990, 10, 'actor-c'], [15_000, 10, 'actor-d']]) {
    f.setNow(offset);
    const trade = quote(f.mint, f.now, PRICE, { solAmount: amount, tokenAmount: amount / PRICE, wallet });
    tracker.observeTrade(trade); f.suite.observeTrade(trade);
  }
  assert.deepStrictEqual(f.rows().map(row => row.status), ['PENDING_ENTRY', 'NO_ENTRY']);
  assert.strictEqual(f.rows()[1].rejection_reason, 'PRE_ENTRY_RUG_CROSS_MINT_TOXIC',
    'real tracker decisions omit enabled but are not GUARD_UNAVAILABLE');
  for (const row of f.rows()) {
    const guard = JSON.parse(row.rug_guard_json);
    assert.strictEqual(guard.enabled, true);
    assert.strictEqual(guard.lifecycleStage, 'AMM_EARLY');
    assert.strictEqual(guard.evaluatedLifecycleStage, 'AMM_EARLY');
    assert.strictEqual(guard.lifecycleAgeMs, 10_000);
    assert.strictEqual(guard.evaluatedLifecycleAgeMs, 10_000);
    assert.strictEqual(guard.requestedLifecycleStage, 'AMM_MATURE');
    assert.strictEqual(guard.requestedLifecycleAgeMs, 15_000);
    assert.strictEqual(guard.lifecycleStageMismatch, true);
    assert.strictEqual(guard.lifecycleClockMismatch, true);
    assert.strictEqual(guard.toxicTemplateMatch, fingerprint);
  }
  assert.strictEqual(f.calls.length, 0, 'actual EARLY toxic template remains blocked');
  const clear = f.suite._legacyGuard(configuration().cohorts[1], quote('no-template', T + 15_000), T);
  assert.strictEqual(clear.evaluatedLifecycleAgeMs, null);
  tracker.observeTrade(quote('clean-clock', T + 5_000));
  tracker.observeTrade(quote('clean-clock', T + 15_000));
  const clean = f.suite._legacyGuard(configuration().cohorts[1], quote('clean-clock', T + 15_000), T);
  assert.strictEqual(clean.lifecycleStageMismatch, true);
  assert.strictEqual(clean.lifecycleAgeMs, 10_000);
  assert.strictEqual(clean.blocked, false, 'different clocks alone never create a new entry filter');
  done(f);
}

thresholdTests(); sourceAndFillTests(); guardAndUnknownTests(); exitTests(); recoveryTests(); boundaryTests();
entryImpactTests(); persistenceFailureTests(); actualRugLifecycleTests();
console.log('test-legacy-early-flow-shadow: ok');
