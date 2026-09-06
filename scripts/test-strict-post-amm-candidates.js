'use strict';

const assert = require('assert');
const { ResearchStore } = require('../src/data/ResearchStore');
const { MigratedDropReboundShadowSuite: GD } = require('../src/core/MigratedDropReboundShadowSuite');
const { SmartWalletConsensusFlowRunnerShadowSuite: Hold } = require('../src/core/SmartWalletConsensusFlowRunnerShadowSuite');
const strict = require('../src/core/StrictAmmShadowExecution');

const base = 1_910_000_000_000;
const policy = { version: strict.VERSION, maxTradeAgeMs: 3_000, entryDelayMs: 1_000, exitDelayMs: 1_000 };
const costs = { platformFeePct: 1, buySlippagePct: 0, sellSlippagePct: 0, priceImpactPct: 9,
  baseTxFeeSol: 0.00001, priorityFeeSol: 0.0001, jitoTipSol: 0, fixedCostSol: 0,
  entryFailureRatePct: 0, entryFailureCostPct: 0 };
function quote(mint, at, price = 0.000001, overrides = {}) {
  return { mint, timestampMs: at, receivedAtMs: at, chainTimestampMs: at,
    market: 'PUMP_AMM', ammQuoteState: 'POST_TRADE_V1', pool: `${mint}-pool`,
    signature: `${mint}-${at}`, eventIndex: 0, slot: at - base + 100_000,
    wallet: 'public', side: 'BUY', solAmount: 0.1, tokenAmount: 0.1 / price,
    price, reservePrice: price, poolBaseReservesRaw: '10000000000000',
    poolQuoteReservesRaw: String(Math.round(price * 10_000_000 * 1e9)),
    virtualQuoteReservesRaw: '0', ...overrides };
}
function makeStore() {
  return new ResearchStore({ dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000 }, { configuredTradingCostPct: 0 });
}
function token(store, mint) {
  store.recordCreate({ mint, symbol: mint, name: null, uri: null, bondingCurve: null, creator: null,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null, createdAt: base - 10_000 });
  store.recordComplete({ mint, timestampMs: base, completedAt: base });
  return store.recordMigration({ mint, migratedAt: base, timestampMs: base, pool: `${mint}-pool` });
}
function gdConfig() {
  return { enabled: true, lifecycleStages: [{ id: 'POST_MIGRATION', market: 'PUMP_AMM' }],
    stateRetentionMs: 60_000, trackingAgeMs: 300_000, positionSizeSol: 0.1,
    entryDelayMs: 200, entryTimeoutMs: 5_000, exitDelayMs: 200, exitTimeoutMs: 5_000,
    maxEntryPriceJumpPct: 15, costModel: costs,
    entryProfiles: [{ id: 'GD_STRICT', windowMs: 1_000, dropMinPct: 25, dropMaxPct: 35,
      reboundMinPct: 2, reboundMaxPct: 5, reboundTimeoutMs: 1_000,
      positionSols: [0.02], strictExecution: policy, capacityAware: true,
      costModel: { ...costs, platformFeePct: 2 },
      liveExitStrategies: { X8: 'must-not-emit' }, exitProfileIds: ['X8'] }],
    exitProfiles: [{ id: 'X8', entryProfileIds: ['GD_STRICT'], exitMode: 'FIXED_HOLD', fixedHoldMs: 8_000 }],
  };
}

function gdTests() {
  const store = makeStore(); let now = base; let live = 0;
  const config = gdConfig();
  let suite = new GD({ store, config, now: () => now, onLiveSignal: () => { live += 1; } });
  const emit = (mint, offset, price, overrides) => {
    now = base + offset;
    suite.observeTrade(quote(mint, now, price, overrides));
  };
  const mint = 'strict-gd'; token(store, mint);
  emit(mint, 1_000, 0.000001);
  emit(mint, 1_300, 0.0000007);
  emit(mint, 1_500, 0.000000721);
  assert.strictEqual(suite.pendingEntries.size, 1);
  let p = [...suite.pendingEntries.values()][0];
  assert.strictEqual(p.entryTargetAt, base + 2_500);
  assert.strictEqual(p.positionSol, 0.02);
  assert.strictEqual(JSON.parse(p.confirmationJson).strictExecution.costs.platformFeePct, 2);
  emit(mint, 2_400, 0.000000721); // accepted while awaiting the future fill
  emit(mint, 2_500, 0.000000721, { chainTimestampMs: base + 2_000, slot: 102_000 });
  assert.strictEqual(p.status, 'PENDING_ENTRY', 'cannot use a regressing pending quote');
  emit(mint, 2_600, 0.000000721, { chainTimestampMs: base + 2_450 });
  assert.strictEqual(p.status, 'PENDING_ENTRY', 'chain must also reach execution target');
  emit(mint, 2_700, 0.000000721, { pool: 'other-pool' });
  emit(mint, 2_800, 0.000000721, { ammQuoteState: undefined });
  assert.strictEqual(p.status, 'PENDING_ENTRY');
  emit(mint, 3_000, 0.000000721);
  assert.strictEqual(p.status, 'OPEN');
  assert.strictEqual(p.entryPrice, strict.buy(quote(mint, now, 0.000000721), 0.02, 0.000000721).price);
  assert.strictEqual(live, 0);
  const peak = p.highestPrice;
  let gdWrites = 0; const update = store.updateMigratedDropReboundShadowPosition.bind(store);
  store.updateMigratedDropReboundShadowPosition = (...args) => { gdWrites += 1; return update(...args); };
  for (let i = 1; i <= 999; i += 1) emit(mint, 3_000 + i, 0.000000721);
  assert.ok(gdWrites <= 4, `GD repeat writes must be bounded, got ${gdWrites}`);
  emit(mint, 4_000, 0.000003, { chainTimestampMs: base - 1 });
  assert.strictEqual(p.highestPrice, peak, 'stale event cannot raise a peak');
  suite.stop();
  now = base + 5_000;
  const changed = { ...config, exitDelayMs: 0, exitTimeoutMs: 1,
    entryProfiles: config.entryProfiles.map(x => ({ ...x, newEntriesEnabled: false })) };
  suite = new GD({ store, config: changed, now: () => now }); suite.start();
  p = [...suite.positions.values()][0];
  emit(mint, 5_100, 0.000003, { chainTimestampMs: base + 4_900 });
  assert.strictEqual(p.highestPrice, peak, 'restore forbids pre-restart chain events');
  now = p.entryAt + 8_000; suite.advanceTime(now);
  assert.strictEqual(p.exitTargetAt, p.entryAt + 9_000, 'frozen delay survives config changes');
  emit(mint, 12_000, 0.0000008, { chainTimestampMs: base + 11_999 });
  assert.strictEqual(suite.positions.size, 1);
  emit(mint, 12_100, 0.0000008);
  const closed = store.db.prepare('SELECT * FROM migrated_drop_rebound_shadow_positions WHERE id=?').get(p.id);
  assert.strictEqual(closed.status, 'CLOSED');
  assert.strictEqual(closed.exit_at, now);
  assert.strictEqual(JSON.parse(closed.confirmation_json).strictExecution.policy.version, strict.VERSION);

  // No stale or cross-pool detector input may become qualification evidence.
  suite = new GD({ store, config, now: () => now });
  const bad = 'stale-gd'; token(store, bad);
  emit(bad, 20_000, 0.000001, { chainTimestampMs: base + 10_000 });
  emit(bad, 20_300, 0.0000007);
  emit(bad, 20_500, 0.000000721);
  assert.strictEqual(suite.pendingEntries.size, 0);
  const noexit = 'noexit-gd'; token(store, noexit);
  emit(noexit, 30_000, 0.000001); emit(noexit, 30_300, 0.0000007); emit(noexit, 30_500, 0.000000721);
  emit(noexit, 31_500, 0.000000721);
  p = [...suite.positions.values()][0];
  now = p.entryAt + 8_000; suite.advanceTime(now);
  emit(noexit, 40_500, 0.00000001, { ammQuoteState: 'INVALID' });
  now = p.exitDeadlineAt + 1; suite.advanceTime(now);
  const unknown = store.db.prepare('SELECT * FROM migrated_drop_rebound_shadow_positions WHERE id=?').get(p.id);
  assert.strictEqual(unknown.status, 'NO_EXIT');
  assert.strictEqual(unknown.net_return_pct, null);
  store.close();
}

function holdConfig() {
  return { enabled: true, positionSizeSol: 0.1, costModel: costs,
    stateRetentionMs: 86_400_000, episodeCooldownMs: 30_000,
    entryDelayMs: 200, entryTimeoutMs: 5_000, exitDelayMs: 200, exitTimeoutMs: 5_000,
    flowWindowMs: 2_000, maxScoutWaitMs: 60_000, maxFlowWaitMs: 60_000,
    dynamicThresholds: [{ maxEligibleClusters: 100, ordinary: 2, strong: 3 }],
    entryProfiles: [{ id: 'HOLD_STRICT', strength: 'HOLDING_STRONG_DIRECT',
      postGraduationHoldingConsensus: true, directPostGraduationEntry: true,
      requiredHoldingClusters: 3, minWeightedScoreRatio: 0.5, scoutFraction: 0,
      positionSizeSol: 0.02, strictExecution: policy, exitProfileIds: ['FIX5'] }],
    exitProfiles: [{ id: 'FIX5', entryProfileIds: ['HOLD_STRICT'], mode: 'FIXED_HOLD',
      fixedHoldMs: 300_000, maxHoldMs: 300_000, hardStopPct: 100 }],
  };
}
function holdTests() {
  const store = makeStore(); let now = base; let snapshotFuture = false;
  const registry = { activeClusterCounts: () => ({ eligible: 3, selectionA: 0 }),
    cachedMonitoringSnapshot: wallet => wallet.startsWith('holder') ? {
      wallet, clusterId: wallet, holdingGrade: 'H_B', selectionGrade: 'S_B', copyGrade: 'C_B',
      ageEligible: true, pnlEligible: true, clusterKnown: true, registryVersion: 1,
      snapshotGeneratedAt: snapshotFuture ? now + 1 : base - 1_000,
      snapshotExpiresAt: base + 86_400_000,
    } : null };
  const config = holdConfig();
  let suite = new Hold({ config, store, registry, now: () => now });
  function prepare(mint) {
    const t = token(store, mint); suite.onGraduated(t);
    for (let i = 0; i < 3; i += 1) suite.onSmartWalletPositionEvent({ mint,
      wallet: `holder-${i}`, timestampMs: base - 1_000, tokenBalanceAfter: 1_000, id: i + 1 });
  }
  function emit(mint, at, overrides = {}) {
    now = at; suite.observeTrade(quote(mint, at, 0.000001, overrides));
  }
  prepare('hold-stale'); emit('hold-stale', base + 5_000, { chainTimestampMs: base });
  emit('hold-stale', base + 5_100);
  assert.strictEqual(suite.positions.size, 0, 'first-event failure is not replaced by a later cherry-picked quote');
  const evaluation = store.db.prepare('SELECT * FROM smart_wallet_post_grad_holding_evaluations WHERE mint=?').get('hold-stale');
  assert.strictEqual(evaluation.status, 'REJECTED');
  assert.strictEqual(evaluation.rejection_reason, 'STRICT_CHAIN_NOT_FRESH');
  prepare('hold-future-snapshot'); snapshotFuture = true;
  emit('hold-future-snapshot', base + 6_000); snapshotFuture = false;
  assert.strictEqual(suite.positions.size, 0, 'future eligibility snapshot cannot vote');
  prepare('hold-invalid'); emit('hold-invalid', base + 7_000, { ammQuoteState: 'INVALID', reservePrice: null, price: null });
  emit('hold-invalid', base + 7_100);
  assert.strictEqual(suite.positions.size, 0, 'invalid first POST event is recorded as rejected');

  const mint = 'hold-good'; prepare(mint); emit(mint, base + 10_000);
  let p = [...suite.positions.values()][0];
  assert.strictEqual(p.entryTargetAt, base + 11_000);
  emit(mint, base + 10_900);
  emit(mint, base + 11_000, { slot: 110_500, chainTimestampMs: base + 10_500 });
  assert.strictEqual(p.status, 'SCALE_PENDING');
  emit(mint, base + 11_100, { chainTimestampMs: base + 10_999 });
  assert.strictEqual(p.status, 'SCALE_PENDING');
  emit(mint, base + 11_200, { pool: 'other-pool' });
  emit(mint, base + 11_300);
  assert.strictEqual(p.status, 'OPEN');
  assert.strictEqual(p.positionSol, 0.02);
  assert.strictEqual(p.entryPrice, strict.buy(quote(mint, now), 0.02, 0.000001).price);
  const savedCosts = p.executionState.strictExecution.costs;
  assert.strictEqual(savedCosts.priceImpactPct, 0);
  const lastMark = p.lastPrice;
  emit(mint, base + 12_000, { price: 0.00000001, reservePrice: 0.00000001, pool: 'other-pool' });
  assert.strictEqual(p.lastPrice, lastMark);
  let writes = 0; const save = suite._save.bind(suite);
  suite._save = value => { writes += 1; return save(value); };
  for (let i = 1; i <= 1_000; i += 1) {
    emit(mint, base + 13_000 + i, { signature: `repeat-${i}`, slot: 113_000 + i });
  }
  assert.ok(writes <= 3, `repeated tick writes must be bounded, got ${writes}`);
  suite.stop(); now += 1_000;
  const changed = { ...config, costModel: { ...costs, platformFeePct: 90 },
    entryProfiles: config.entryProfiles.map(x => ({ ...x, newEntriesEnabled: false })),
    exitProfiles: config.exitProfiles.map(x => ({ ...x, fixedHoldMs: 1, maxHoldMs: 1 })) };
  suite = new Hold({ config: changed, store, registry, now: () => now }); suite.start();
  p = [...suite.positions.values()][0];
  assert.strictEqual(p.status, 'OPEN');
  emit(mint, now + 100, { chainTimestampMs: now - 1 });
  assert.strictEqual(p.executionState.strictExecution.lastRejected.reason, 'STRICT_PRE_RESTART_QUOTE');
  now = p.entryAt + 300_000; suite.advanceTime(now);
  assert.strictEqual(p.exitTriggerAt, now);
  assert.strictEqual(p.exitTargetAt, now + 1_000);
  emit(mint, p.exitTargetAt, { chainTimestampMs: p.exitTargetAt - 1 });
  assert.strictEqual(suite.positions.size, 1);
  emit(mint, p.exitTargetAt + 100);
  const row = store.db.prepare('SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions WHERE id=?').get(p.id);
  assert.strictEqual(row.status, 'CLOSED');
  assert.strictEqual(row.exit_at, now);
  assert.strictEqual(row.estimated_cost_sol, 0.02 * 0.01 + savedCosts.totalFixedCostSol);
  suite = new Hold({ config, store, registry, now: () => now });
  const missing = 'hold-noexit'; prepare(missing);
  emit(missing, now + 1_000); emit(missing, now + 1_000);
  p = [...suite.positions.values()][0];
  assert.strictEqual(p.status, 'OPEN');
  now = p.entryAt + 300_000; suite.advanceTime(now);
  emit(missing, p.exitTargetAt + 1, { chainTimestampMs: p.exitTargetAt - 10_000 });
  now = p.exitDeadlineAt + 1; suite.advanceTime(now);
  const unknown = store.db.prepare('SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions WHERE id=?').get(p.id);
  assert.strictEqual(unknown.status, 'NO_EXIT');
  assert.strictEqual(unknown.net_return_pct, null);
  assert.strictEqual(unknown.exit_price, null);
  store.close();
}

function helperTests() {
  const trade = quote('helper', base + 1_000);
  const state = { policy: strict.freezePolicy({ strictExecution: policy }, {}) };
  assert.strictEqual(strict.rejection({ ...trade, pool: undefined, bondingCurve: 'not-pool' }, state, trade.receivedAtMs), 'STRICT_POOL_MISSING');
  assert.strictEqual(strict.rejection({ ...trade, ammQuoteState: undefined }, state, trade.receivedAtMs), 'STRICT_POST_QUOTE_REQUIRED');
  assert.strictEqual(strict.rejection({ ...trade, receivedAtMs: trade.receivedAtMs - 1 }, state, trade.receivedAtMs), 'STRICT_CHAIN_NOT_FRESH');
  assert.strictEqual(strict.sell({ ...trade, poolQuoteReservesRaw: '1', virtualQuoteReservesRaw: '9999999999' }, 1_000, trade.price).available, false);
  assert.strictEqual(strict.sell({ ...trade, poolBaseReservesRaw: null }, 1_000, trade.price).available, false);

  // Interleaved transaction signatures in one slot do not erase the already
  // observed event identities or the highest event index of a signature.
  const cursorState = { policy: state.policy, pool: trade.pool,
    cursor: strict.observation({ ...trade, signature: 'A', eventIndex: 0 }) };
  const accept = (signature, eventIndex, overrides = {}) => strict.accept(
    { ...trade, signature, eventIndex, ...overrides }, cursorState, trade.receivedAtMs,
  );
  assert.strictEqual(accept('B', 0), true);
  assert.deepStrictEqual(cursorState.cursor.seenEventKeys, ['A:0', 'B:0']);
  assert.strictEqual(accept('A', 0), false, 'A0, B0, replay A0 must fail');
  assert.strictEqual(accept('A', 2), true);
  assert.strictEqual(accept('C', 0), true, 'different signatures do not share event-index order');
  const acceptedCursor = JSON.stringify(cursorState.cursor);
  assert.strictEqual(accept('A', 1), false, 'A2, C0, late A1 must fail even if A1 was never seen');
  assert.strictEqual(JSON.stringify(cursorState.cursor), acceptedCursor, 'rejected events cannot move the cursor');
  const restored = JSON.parse(JSON.stringify(cursorState));
  assert.strictEqual(strict.accept({ ...trade, signature: 'A', eventIndex: 0 }, restored, trade.receivedAtMs), false);
  assert.strictEqual(strict.accept({ ...trade, signature: 'A', eventIndex: 1 }, restored, trade.receivedAtMs), false);
  assert.strictEqual(strict.accept({ ...trade, signature: 'A', eventIndex: 3 }, restored, trade.receivedAtMs), true);

  const full = { policy: state.policy };
  for (let i = 0; i < strict.MAX_SLOT_EVENT_KEYS; i += 1) {
    assert.strictEqual(strict.accept({ ...trade, signature: `slot-event-${i}` }, full, trade.receivedAtMs), true);
  }
  assert.strictEqual(full.cursor.seenEventKeys.length, strict.MAX_SLOT_EVENT_KEYS);
  assert.strictEqual(strict.accept({ ...trade, signature: 'overflow' }, full, trade.receivedAtMs), false);
  assert.strictEqual(full.lastRejected.reason, 'STRICT_SLOT_EVENT_LIMIT');
  assert.strictEqual(full.cursor.seenEventKeys.length, strict.MAX_SLOT_EVENT_KEYS,
    'overflow must fail closed, not evict the oldest replay-protection keys');
  assert.strictEqual(strict.accept({ ...trade, signature: 'next-slot', slot: trade.slot + 1 }, full, trade.receivedAtMs), true);
  assert.deepStrictEqual(full.cursor.seenEventKeys, ['next-slot:0']);
  assert.strictEqual(strict.accept(trade, full, trade.receivedAtMs), false, 'prior slots remain fenced out');
}
helperTests(); gdTests(); holdTests();
console.log('Strict POST AMM GD X8 / HOLD3 FIX5m candidates: PASS');
