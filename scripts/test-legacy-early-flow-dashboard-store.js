'use strict';

const assert = require('node:assert/strict');
const { ResearchStore } = require('../src/data/ResearchStore');
const { MigrationSecondLegShadowSuite } = require('../src/core/MigrationSecondLegShadowSuite');
const { EXECUTION_VERSION } = require('../src/core/LegacyEarlyFlowEntryTracker');
const strict = require('../src/core/StrictAmmShadowExecution');

const T = 1_920_000_000_000;
const PRICE = 4e-7;
const BASE = 'LEGACY-EARLY-FLOW-BASE';
const RUGX = 'LEGACY-EARLY-FLOW-RUGX';
const costs = { platformFeePct: 1, buySlippagePct: 0, sellSlippagePct: 0,
  priceImpactPct: 0, baseTxFeeSol: 0.00001, priorityFeeSol: 0.0002,
  jitoTipSol: 0, fixedCostSol: 0, entryFailureRatePct: 0, entryFailureCostPct: 0 };
const config = { enabled: true, newEntriesEnabled: true, positionSizeSol: 1, costModel: costs,
  entryTimeoutMs: 15_000, exitTimeoutMs: 15_000, noExitObservationMs: 60_000,
  cohorts: [BASE, RUGX].map(id => ({ id, enabled: true, newEntriesEnabled: true,
    entryMode: 'LEGACY_EARLY_FLOW', executionVersion: EXECUTION_VERSION,
    strictExecution: { version: strict.VERSION }, confirmationMode: 'IMMEDIATE',
    positionSizeSol: 0.02, costModel: costs, hardStopPct: 30,
    trailingActivationPct: 10, trailingStopPct: 5, maxHoldMs: 1_800_000,
    maxEntryPriceJumpPct: 15, maxNegativeEntryJumpPct: 50, maxEntryImpactPct: 15,
    rugGuardMode: id === BASE ? 'LABEL_ONLY' : 'HARD_BLOCK', liveBridgeEnabled: false,
  })),
};
const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
  flushMs: 60_000, flushMax: 1_000 }, { configuredTradingCostPct: 0 });
const rowsFor = mint => store.db.prepare('SELECT * FROM migration_second_leg_shadow_positions WHERE mint=? ORDER BY id').all(mint);
let index = 0;
function makePair(mint, outcome = 'closed') {
  const t = T + index++ * 2_000_000;
  let now = t;
  store.preEntryRugRisk = { config: { enabled: true }, evaluateGuard({ enforcementMode }) {
    if (outcome === 'guard-unknown') return { enabled: false, blocked: false };
    const blocked = outcome === 'rug-blocked' && enforcementMode === 'HARD_BLOCK';
    return { enabled: true, sampleReady: true, blocked, flagged: blocked,
      reason: blocked ? 'TOXIC_ACTOR' : null };
  } };
  store.recordCreate({ mint, symbol: mint, name: null, uri: null, bondingCurve: null,
    creator: null, createdAt: t - 10_000,
    tokenTotalSupplyRaw: '1000000000000000', initialRealTokenReservesRaw: '1000000000000000' });
  store.recordMigration({ mint, migratedAt: t, timestampMs: t, pool: `${mint}-pool` });
  const suite = new MigrationSecondLegShadowSuite({ config, store, now: () => now,
    getSolUsdReference: () => ({ priceUsd: 100, observedAt: now - 1000,
      expiresAt: now + 60_000, source: 'TEST_CACHED_REFERENCE' }) });
  const emit = (offset, price = PRICE) => {
    now = t + offset;
    suite.observeTrade({ mint, timestampMs: now, receivedAtMs: now, chainTimestampMs: now,
      market: 'PUMP_AMM', ammQuoteState: 'POST_TRADE_V1', pool: `${mint}-pool`,
      poolBaseReservesRaw: '1000000000000000', poolQuoteReservesRaw: String(Math.round(price * 1e18)),
      virtualQuoteReservesRaw: '0', price, reservePrice: price, signature: `${mint}:${now}`,
      slot: 100_000 + offset, eventIndex: 0, wallet: `wallet-${offset % 3}`,
      solAmount: 0.1, tokenAmount: 0.1 / price, side: 'BUY' });
  };
  for (let offset = 5_000; offset <= 15_000; offset += 1_000) emit(offset);
  assert.equal(rowsFor(mint).length, 2, 'real Suite creates a same-source baseline / filtered pair');
  emit(16_000);
  if (outcome === 'no-exit') {
    now = t + 16_000 + 1_800_000;
    suite.advanceTime(now);
    now += 16_001;
    suite.advanceTime(now);
    assert(rowsFor(mint).every(row => row.status === 'NO_EXIT'));
  } else if (outcome === 'rug-blocked' || outcome === 'guard-unknown') {
    emit(17_000, PRICE * 0.1);
    emit(18_000, PRICE * 0.1);
    assert.equal(rowsFor(mint)[0].status, 'CLOSED');
    assert.equal(rowsFor(mint)[1].status, 'NO_ENTRY');
  } else {
    emit(17_000, PRICE * 1.2);
    emit(18_000, PRICE * 1.13);
    emit(19_000, PRICE * 1.12);
    assert(rowsFor(mint).every(row => row.status === 'CLOSED'));
  }
  suite.stop();
}
const updateFiltered = (mint, patch) => {
  const keys = Object.keys(patch);
  store.db.prepare(`UPDATE migration_second_leg_shadow_positions SET ${keys.map(key => `${key}=?`).join(',')} WHERE mint=? AND cohort_id=?`)
    .run(...Object.values(patch), mint, RUGX);
};
const mutateFeatures = (mint, change) => {
  const f = JSON.parse(rowsFor(mint)[1].features_json);
  change(f);
  updateFiltered(mint, { features_json: JSON.stringify(f) });
};
try {
  makePair('good');
  makePair('rug', 'rug-blocked');
  makePair('no-exit', 'no-exit');
  makePair('unknown-guard', 'guard-unknown');
  makePair('data-error');
  updateFiltered('data-error', { status: 'DATA_ERROR', rejection_reason: 'STRICT_DB_WRITE_FAILED' });
  makePair('closed-null');
  updateFiltered('closed-null', { net_return_pct: null });
  makePair('entry-mismatch');
  updateFiltered('entry-mismatch', { entry_price: PRICE * 2 });
  makePair('source-mismatch');
  mutateFeatures('source-mismatch', f => { f.strictExecution.source.signature = 'different-source'; });
  makePair('protocol-mismatch');
  mutateFeatures('protocol-mismatch', f => { f.strictExecution.cohort.maxEntryImpactPct = 14; });
  makePair('data-error-rug-prefix');
  updateFiltered('data-error-rug-prefix', { status: 'DATA_ERROR', rejection_reason: 'PRE_ENTRY_RUG_WRITE_FAILED' });
  makePair('not-rug-rejection');
  updateFiltered('not-rug-rejection', { status: 'NO_ENTRY', rejection_reason: 'ENTRY_SELF_IMPACT' });

  // Newer unrelated positions must not evict every Legacy position from its dedicated page.
  const seed = rowsFor('good')[0];
  const columns = Object.keys(seed).filter(key => key !== 'id');
  const insert = store.db.prepare(`INSERT INTO migration_second_leg_shadow_positions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  for (let n = 0; n < 6; n++) {
    const pmo = { ...seed, cohort_id: 'PMO-FLOW-H15-A30-D15-X120', episode_id: `pmo-${n}`,
      mint: `pmo-${n}`, position_sol: 1, updated_at: T + 99_000_000 + n };
    insert.run(...columns.map(key => pmo[key]));
  }
  const result = store.migrationSecondLegShadowDashboard({ positionLimit: 2 });
  assert.equal(result.rugComparisons.length, 5, 'four unchanged PMO pairs plus one new Legacy pair');
  assert(result.positions.every(row => row.cohort_id.startsWith('PMO-')));
  assert.equal(result.legacyPositions.length, 4, 'bounded two positions from each Legacy cohort');
  assert(result.legacyPositions.every(row => [BASE, RUGX].includes(row.cohort_id)));
  assert(result.legacyPositions.every(row => row.features?.executionVersion === EXECUTION_VERSION));
  assert.equal(result.legacyCohorts.length, 2);
  assert(result.legacyCohorts.every(row => row.position_sol === 0.02 && row.execution_version === EXECUTION_VERSION));
  const filteredStats = result.legacyCohorts.find(row => row.cohort_id === RUGX);
  assert.equal(filteredStats.no_exit, 1);
  assert.equal(filteredStats.data_error, 2);
  assert.equal(filteredStats.rug_rejected, 2, 'unknown guard is a rejection, not a validated avoided RUG');
  assert.equal(filteredStats.resolved, 4, 'CLOSED null return is not resolved');
  const pair = result.rugComparisons.find(row => row.baselineProfileId === BASE);
  assert.equal(pair.filteredProfileId, RUGX);
  assert.equal(pair.pairAudit.candidatePairs, 11);
  assert.equal(pair.pairAudit.sourceMismatch, 1);
  assert.equal(pair.pairAudit.protocolMismatch, 1);
  assert.equal(pair.pairAudit.entryMismatch, 1);
  assert.equal(pair.pairAudit.guardUnavailable, 1);
  assert.equal(pair.pairedSignals, 9);
  assert.equal(pair.comparableResolved, 2, 'only same-entry closed pair and verified blocked pair are comparable');
  assert.equal(pair.blocked, 1);
  assert.equal(pair.resolvedBlocked, 1);
  assert.equal(pair.avoidedRug80, 1);
  const win = rowsFor('good')[0].net_return_pct;
  const loss = rowsFor('rug')[0].net_return_pct;
  assert(Math.abs(pair.comparableBaseline.averageNetReturnPct - (win + loss) / 2) < 1e-10);
  assert(Math.abs(pair.comparableFiltered.averageNetReturnPct - win / 2) < 1e-10);
  assert(Math.abs(pair.averageNetReturnLiftPct - (-loss / 2)) < 1e-10);
  assert(result.pmoStats.signals === 6, 'legacy changes do not leak into PMO aggregate');
  console.log('PASS Legacy Dashboard Store: actual Suite sources/fills, strict source/protocol/entry pairing, unknown exclusions and indexed dedicated positions');
} finally {
  store.close();
}
