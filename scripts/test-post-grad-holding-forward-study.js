'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ResearchStore } = require('../src/data/ResearchStore');
const { SmartWalletConsensusFlowRunnerShadowSuite: Suite } = require('../src/core/SmartWalletConsensusFlowRunnerShadowSuite');
const { applyPostGradHoldingStudyPolicy, STUDY_VERSION, ENTRY_IDS, EXIT_IDS } = require('../src/core/PostGradHoldingStudyPolicy');
const { costBreakdown } = require('../src/core/CostModel');

const base = 1_920_000_000_000;
function makeConfig() {
  return applyPostGradHoldingStudyPolicy({ liveTrading: { enabled: false, strategies: [] },
    smartWalletConsensusFlowRunnerShadow: {
      enabled: true, positionSizeSol: 1, entryDelayMs: 0, exitDelayMs: 0,
      entryTimeoutMs: 1, exitTimeoutMs: 1, stateRetentionMs: 86_400_000,
      episodeCooldownMs: 30_000, maxScoutWaitMs: 60_000, maxFlowWaitMs: 1,
      flowWindowMs: 1_000, minFlowNetSol: 10, minFlowBuyers: 99, minFlowBuyTx: 99,
      dynamicThresholds: [{ maxEligibleClusters: 100, ordinary: 2, strong: 3 }],
      costModel: { platformFeePct: 90, priorityFeeSol: 0.01 },
      entryProfiles: [{ id: 'POST_GRAD_HOLD3_DIRECT', postGraduationHoldingConsensus: true }],
      exitProfiles: [],
    } });
}
function fixture() {
  let now = base; let seq = 0;
  const config = makeConfig();
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 1_000 }, { configuredTradingCostPct: 0 });
  const registry = {
    activeClusterCounts: () => ({ eligible: 3, selectionA: 0 }),
    cachedMonitoringSnapshot: wallet => wallet.startsWith('holder') ? {
      wallet, clusterId: wallet, holdingGrade: 'H_B', selectionGrade: 'S_B', copyGrade: 'C_B',
      ageEligible: true, pnlEligible: true, clusterKnown: true, registryVersion: 1,
      snapshotGeneratedAt: base - 2_000, snapshotExpiresAt: base + 86_400_000,
    } : null,
  };
  let suite = new Suite({ config: config.smartWalletConsensusFlowRunnerShadow, store, registry, now: () => now });
  const rows = mint => store.db.prepare('SELECT * FROM smart_wallet_consensus_flow_runner_shadow_positions WHERE mint=? ORDER BY id').all(mint);
  return {
    config, store, rows, get suite() { return suite; }, get now() { return now; },
    prepare(mint, offset = 0) {
      now = base + offset;
      store.recordCreate({ mint, symbol: mint, name: null, uri: null, creator: null, bondingCurve: null,
        initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null, createdAt: now - 10_000 });
      store.recordComplete({ mint, timestampMs: now, completedAt: now });
      const migration = store.recordMigration({ mint, migratedAt: now, timestampMs: now, pool: `${mint}-pool` });
      suite.onGraduated(migration);
      for (let i = 0; i < 3; i += 1) suite.onSmartWalletPositionEvent({ id: ++seq,
        mint, wallet: `holder-${i}`, timestampMs: now - 1_000, tokenBalanceAfter: 1_000 });
    },
    emit(mint, offset, ratio = 1, overrides = {}) {
      now = base + offset;
      const price = ratio * 0.000001;
      const trade = { mint, timestampMs: now, receivedAtMs: now, chainTimestampMs: now,
        market: 'PUMP_AMM', ammQuoteState: 'POST_TRADE_V1', pool: `${mint}-pool`,
        slot: 100_000 + offset, signature: `sig-${++seq}`, eventIndex: 0,
        wallet: 'public-a', side: 'BUY', solAmount: 0.2, tokenAmount: 0.2 / price,
        price, reservePrice: price, poolBaseReservesRaw: '100000000000000',
        poolQuoteReservesRaw: String(Math.round(price * 100_000_000 * 1e9)),
        virtualQuoteReservesRaw: '0', ...overrides };
      suite.observeTrade(trade);
      return trade;
    },
    tick(offset) { now = base + offset; suite.advanceTime(now); },
    restart(offset, mutate = () => {}) {
      suite.stop(); now = base + offset; mutate(config.smartWalletConsensusFlowRunnerShadow);
      suite = new Suite({ config: config.smartWalletConsensusFlowRunnerShadow, store, registry, now: () => now });
      suite.start();
    },
    close() { suite.stop(); store.close(); },
  };
}

function policyTest() {
  const config = makeConfig();
  const live = JSON.stringify(config.liveTrading);
  const first = JSON.stringify(config.smartWalletConsensusFlowRunnerShadow);
  applyPostGradHoldingStudyPolicy(config);
  assert.strictEqual(JSON.stringify(config.smartWalletConsensusFlowRunnerShadow), first, 'idempotent fixed matrix');
  assert.strictEqual(JSON.stringify(config.liveTrading), live, 'study never changes live switches');
  const suite = config.smartWalletConsensusFlowRunnerShadow;
  assert.strictEqual(suite.forwardHoldingStudy.arms, 8);
  assert.strictEqual(suite.entryProfiles.find(x => x.id === 'POST_GRAD_HOLD3_DIRECT').newEntriesEnabled, false);
  for (const id of ENTRY_IDS) {
    const p = suite.entryProfiles.find(x => x.id === id);
    assert.strictEqual(p.positionSizeSol, 0.02);
    assert.strictEqual(p.liveBridgeEnabled, false);
    assert.deepStrictEqual(p.exitProfileIds, EXIT_IDS);
    assert.ok(Math.abs(costBreakdown(p.costModel).deterministicCostPct - 3.05) < 1e-12);
  }
  assert.strictEqual(suite.exitProfiles.filter(x => x.hardStopEnabled === false).length, 2);
  const dashboardHtml = fs.readFileSync(path.join(
    __dirname, '..', 'src', 'server', 'public', 'index.html',
  ), 'utf8');
  assert.match(dashboardHtml, /HOLD3完整配对/);
  assert.match(dashboardHtml, /pairAudit\.comparableOpportunities/);
}

function causalFlowAndPairTest() {
  const f = fixture(); const mint = 'flow-pair'; f.prepare(mint);
  const first = f.emit(mint, 1_000);
  let rows = f.rows(mint);
  assert.strictEqual(rows.length, 8);
  assert.strictEqual(new Set(rows.map(r => JSON.parse(r.execution_state_json).forwardStudy.pairedOpportunityId)).size, 1);
  assert.strictEqual(new Set(rows.map(r => r.signal_at)).size, 1);
  assert(rows.every(r => r.position_sol === 0.02 && r.configured_cost_pct === 3.05));
  const flowRows = () => f.rows(mint).filter(r => r.entry_profile_id === ENTRY_IDS[1]);
  f.emit(mint, 1_200, 1, { wallet: 'public-b', chainTimestampMs: base - 5_000 });
  f.emit(mint, 1_300, 1, { wallet: 'public-b', pool: 'wrong-pool' });
  f.emit(mint, 1_400, 1, { wallet: 'public-b', signature: first.signature, slot: first.slot });
  f.emit(mint, 1_500, 1, { wallet: 'public-a' });
  assert(flowRows().every(r => r.status === 'WAITING_FLOW'), 'bad history cannot supply a second public buyer');
  f.emit(mint, 1_600, 1, { wallet: 'public-b', chainTimestampMs: base + 1_500, timestampMs: base + 1_500 });
  assert(flowRows().every(r => r.status === 'SCALE_PENDING' && r.entry_target_at === base + 2_600),
    'FLOW confirmation waits a full second after receipt, not old chain time');
  f.emit(mint, 2_100);
  assert.strictEqual(f.rows(mint).filter(r => r.status === 'OPEN').length, 4);
  f.emit(mint, 2_600, 1, { chainTimestampMs: base + 2_500 });
  assert(flowRows().every(r => r.status === 'SCALE_PENDING'), 'chain must reach the delayed target');
  f.emit(mint, 2_700);
  rows = f.rows(mint);
  assert(rows.every(r => r.status === 'OPEN'));
  for (const id of ENTRY_IDS) assert.strictEqual(new Set(rows.filter(r => r.entry_profile_id === id).map(r => r.entry_price)).size, 1);
  assert.strictEqual(f.store.db.prepare('SELECT COUNT(*) n FROM live_positions').get().n, 0);
  assert.strictEqual(f.suite.health().forwardHoldingStudy.version, STUDY_VERSION);
  f.close();
}

function trailingAndStopsTest() {
  const f = fixture(); const mint = 'trail-pair'; f.prepare(mint);
  f.emit(mint, 1_000); f.emit(mint, 1_200, 1, { wallet: 'public-b' });
  f.emit(mint, 2_200);
  assert(f.rows(mint).every(r => r.status === 'OPEN'));
  f.emit(mint, 3_000, 1.6);
  f.emit(mint, 3_500, 1.31); // 18.125% off peak, NOT a 29-point return drawdown stop.
  assert(f.rows(mint).every(r => r.status === 'OPEN'));
  f.emit(mint, 4_000, 1.27);
  const trails = f.rows(mint).filter(r => r.exit_profile_id.includes('TRAIL'));
  assert(trails.every(r => r.status === 'EXIT_PENDING' && r.exit_target_at === base + 5_000));
  f.emit(mint, 4_999, 1.27);
  assert.strictEqual(f.rows(mint).filter(r => r.status === 'CLOSED').length, 0);
  f.emit(mint, 5_000, 1.27);
  const closed = f.rows(mint).filter(r => r.status === 'CLOSED');
  assert.strictEqual(closed.length, 4);
  assert(closed.every(r => r.exit_reason === 'TRAILING_STOP' && r.entry_tx_count === 1 && r.exit_tx_count === 1));
  assert(closed.every(r => Math.abs(r.estimated_cost_sol - 0.00061) < 1e-12), 'round-trip fees deducted once');
  f.emit(mint, 6_000, 0.64);
  assert.strictEqual(f.rows(mint).filter(r => r.status === 'EXIT_PENDING' && r.exit_reason === 'HARD_STOP').length, 2);
  f.emit(mint, 7_000, 0.63);
  assert.strictEqual(f.rows(mint).filter(r => r.status === 'CLOSED').length, 6);
  f.emit(mint, 8_000, 0.001);
  assert(f.rows(mint).filter(r => r.status === 'OPEN').every(r => r.exit_profile_id.includes('NOHS')),
    'no-hard-stop arm is explicit, including a catastrophic mark');
  f.tick(302_200);
  assert.strictEqual(f.rows(mint).filter(r => r.status === 'EXIT_PENDING').length, 2);
  f.emit(mint, 303_200, 0.001);
  assert(f.rows(mint).every(r => r.status === 'CLOSED'));
  f.close();
}

function frozenParametersTest() {
  const f = fixture(); const mint = 'frozen-flow'; f.prepare(mint);
  f.emit(mint, 1_000);
  for (const entry of f.config.smartWalletConsensusFlowRunnerShadow.entryProfiles) {
    entry.newEntriesEnabled = false; entry.entryDelayMs = 0; entry.minFlowBuyers = 99;
    entry.minFlowBuyTx = 99; entry.maxFlowWaitMs = 1;
    entry.costModel = { platformFeePct: 90 };
  }
  for (const exit of f.config.smartWalletConsensusFlowRunnerShadow.exitProfiles) {
    exit.fixedHoldMs = 1; exit.maxHoldMs = 1; exit.hardStopEnabled = true;
    exit.hardStopPct = 1; exit.trailingActivationPct = 0; exit.trailingStopPct = 0;
    exit.exitDelayMs = 0; exit.exitTimeoutMs = 1;
  }
  f.emit(mint, 1_500, 1, { wallet: 'public-b' });
  const flow = f.rows(mint).filter(r => r.entry_profile_id === ENTRY_IDS[1]);
  assert(flow.every(r => r.status === 'SCALE_PENDING' && r.entry_target_at === base + 2_500),
    'flow gate and one-second delay come from the frozen entry');
  f.emit(mint, 2_500);
  f.emit(mint, 3_000, 0.98);
  const rows = f.rows(mint);
  assert(rows.every(r => r.status === 'OPEN'), 'live config edits cannot rewrite frozen exits');
  for (const row of rows) {
    const strict = JSON.parse(row.execution_state_json).strictExecution;
    assert.strictEqual(strict.costs.platformFeePct, 1.4);
    assert.strictEqual(strict.policy.entryDelayMs, 1_000);
    assert.strictEqual(strict.policy.exitDelayMs, 1_000);
    if (row.exit_profile_id.includes('FIX5M')) {
      assert.strictEqual(strict.exit.fixedHoldMs, 300_000);
      assert.strictEqual(strict.exit.maxHoldMs, 300_000);
    } else {
      assert.strictEqual(strict.exit.trailingActivationPct, 30);
      assert.strictEqual(strict.exit.trailingStopPct, 20);
      assert.strictEqual(strict.exit.maxHoldMs, 1_800_000);
    }
    assert.strictEqual(strict.exit.hardStopEnabled, row.exit_profile_id.includes('_H30_'));
  }
  f.close();
}

function atomicMatrixRetryTest() {
  const f = fixture(); const mint = 'atomic-matrix'; f.prepare(mint);
  const originalRun = f.suite.insert.run.bind(f.suite.insert);
  let calls = 0;
  f.suite.insert.run = (...args) => {
    calls += 1;
    if (calls === 3) throw new Error('injected paired insert failure');
    return originalRun(...args);
  };
  const source = { signature: 'atomic-source', slot: 123_456, eventIndex: 0 };
  assert.throws(() => f.emit(mint, 1_000, 1, source), /injected paired insert failure/);
  assert.strictEqual(f.rows(mint).length, 0, 'partial arms must roll back');
  assert.strictEqual(f.store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_post_grad_holding_evaluations WHERE mint=?
  `).get(mint).n, 0, 'evaluation must roll back with its arms');
  f.suite.insert.run = originalRun;
  f.emit(mint, 1_000, 1, source);
  const rows = f.rows(mint);
  assert.strictEqual(rows.length, 8, 'the identical first event can safely retry all eight arms');
  assert.strictEqual(new Set(rows.map(r => JSON.parse(r.execution_state_json)
    .forwardStudy.pairedOpportunityId)).size, 1);
  assert.strictEqual(f.store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_post_grad_holding_evaluations WHERE mint=?
  `).get(mint).n, 2);
  const audit = f.suite.dashboard().forwardPairAudit;
  assert.deepStrictEqual({
    totalRows: audit.totalRows,
    totalOpportunities: audit.totalOpportunities,
    completeOpportunities: audit.completeOpportunities,
    incompleteOpportunities: audit.incompleteOpportunities,
    comparableOpportunities: audit.comparableOpportunities,
  }, {
    totalRows: 8, totalOpportunities: 1, completeOpportunities: 1,
    incompleteOpportunities: 0, comparableOpportunities: 1,
  }, 'Dashboard only calls an exact, source-consistent 2x4 matrix comparable');
  const corrupt = JSON.parse(rows[0].execution_state_json);
  corrupt.forwardStudy.signalReceivedAtMs += 1;
  corrupt.strictExecution.feeConvention = 'BROKEN';
  f.store.db.prepare(`
    UPDATE smart_wallet_consensus_flow_runner_shadow_positions
    SET execution_state_json=? WHERE id=?
  `).run(JSON.stringify(corrupt), rows[0].id);
  f.store.db.prepare(`
    DELETE FROM smart_wallet_consensus_flow_runner_shadow_positions WHERE id=?
  `).run(rows.at(-1).id);
  const corruptedAudit = f.suite.dashboard().forwardPairAudit;
  assert.strictEqual(corruptedAudit.incompleteOpportunities, 1);
  assert.strictEqual(corruptedAudit.sourceMismatchOpportunities, 1);
  assert.strictEqual(corruptedAudit.protocolMismatchOpportunities, 1);
  assert.strictEqual(corruptedAudit.comparableOpportunities, 0);
  f.close();
}

function migrationPoolAndClockTest() {
  const f = fixture(); const mint = 'migration-anchor'; f.prepare(mint);
  f.emit(mint, 1_000, 1, { pool: 'wrong-pool' });
  f.emit(mint, 1_100, 1, { chainTimestampMs: base - 1 });
  f.emit(mint, 1_150, 1, { receivedAtMs: undefined });
  f.emit(mint, 1_175, 1, { chainTimestampMs: undefined });
  assert.strictEqual(f.rows(mint).length, 0,
    'cross-pool and pre-migration events cannot consume the canonical first AMM');
  assert.strictEqual(f.store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_post_grad_holding_evaluations WHERE mint=?
  `).get(mint).n, 0);
  assert.strictEqual(f.suite.states.get(mint).strictFlowState, undefined,
    'a wrong pool cannot pin the strict flow cursor');
  f.emit(mint, 1_200);
  const rows = f.rows(mint);
  assert.strictEqual(rows.length, 8);
  assert(rows.every(row => JSON.parse(row.execution_state_json).strictExecution.pool === `${mint}-pool`));
  assert.strictEqual(f.suite.states.get(mint).strictFlowState.pool, `${mint}-pool`);
  f.close();
}

function historicPartialMatrixFailClosedTest() {
  const f = fixture(); const mint = 'historic-partial'; f.prepare(mint);
  f.suite.insertHoldingEvaluation.run({
    entryProfileId: ENTRY_IDS[0], mint, evaluatedAt: base, migratedAt: base,
    firstAmmAt: base, status: 'QUALIFIED', rejectionReason: null,
    requiredClusters: 3, distinctClusters: 3, eligibleWallets: 3,
    selectionAClusters: 0, weightedScore: 3, clusterVotesJson: '[]',
    registryVersion: 1, createdAt: base,
  });
  f.emit(mint, 1_000);
  assert.strictEqual(f.rows(mint).length, 0,
    'a later event cannot fill missing arms beside a historic evaluation');
  assert.strictEqual(f.store.db.prepare(`
    SELECT COUNT(*) n FROM smart_wallet_post_grad_holding_evaluations WHERE mint=?
  `).get(mint).n, 1, 'the newer paired evaluation is not partially committed');
  f.emit(mint, 1_200);
  assert.strictEqual(f.rows(mint).length, 0);
  f.close();
}

function strictClockAndTransactionDedupTest() {
  {
    const f = fixture(); const mint = 'timestamp-clock'; f.prepare(mint);
    f.emit(mint, 1_000);
    f.emit(mint, 1_200, 1, { wallet: 'public-b', timestampMs: base + 999_999_999 });
    const flow = f.rows(mint).filter(r => r.entry_profile_id === ENTRY_IDS[1]);
    assert(flow.every(r => r.status === 'SCALE_PENDING' && r.entry_target_at === base + 2_200),
      'unvalidated timestampMs cannot drive timeout or the strict flow window');
    f.close();
  }
  {
    const f = fixture(); const mint = 'tx-dedup'; f.prepare(mint);
    const first = f.emit(mint, 1_000);
    f.emit(mint, 1_200, 1, { wallet: 'public-b', signature: first.signature,
      slot: first.slot, eventIndex: 1, timestampMs: base + 1_000,
      receivedAtMs: base + 1_000, chainTimestampMs: base + 1_000 });
    let flow = f.rows(mint).filter(r => r.entry_profile_id === ENTRY_IDS[1]);
    assert(flow.every(r => r.status === 'WAITING_FLOW'),
      'two events in one signature are still one buy transaction');
    f.emit(mint, 1_400, 1, { wallet: 'public-c' });
    flow = f.rows(mint).filter(r => r.entry_profile_id === ENTRY_IDS[1]);
    assert(flow.every(r => r.status === 'SCALE_PENDING'));
    assert(flow.every(r => JSON.parse(r.flow_features_json).current.buyTx === 2));
    f.close();
  }
}

function restartCensorTest() {
  const f = fixture(); const mint = 'restart-censor'; f.prepare(mint);
  f.emit(mint, 1_000); f.emit(mint, 1_200, 1, { wallet: 'public-b' });
  f.emit(mint, 2_200);
  assert(f.rows(mint).every(r => r.status === 'OPEN'));
  f.restart(3_000, cfg => {
    for (const entry of cfg.entryProfiles) entry.newEntriesEnabled = false;
  });
  const rows = f.rows(mint);
  assert(rows.every(r => r.status === 'RIGHT_CENSORED'
    && r.exit_reason === 'RESTART_CENSORED'
    && r.gross_return_pct === null && r.net_return_pct === null));
  assert(rows.every(r => JSON.parse(r.execution_state_json).censoring?.rightCensored === true));
  assert.strictEqual(f.suite.positions.size, 0);
  assert.strictEqual(f.suite.health().restartCensored, 8);
  const dashboard = f.suite.dashboard();
  assert(dashboard.capitalSummary.every(row => row.censored === 1
    && row.right_censored === 1), 'Dashboard counts restart censoring outside return outcomes');
  assert.strictEqual(dashboard.forwardPairAudit.completeOpportunities, 1);
  assert.strictEqual(dashboard.forwardPairAudit.comparableOpportunities, 1);
  f.emit(mint, 4_000, 10); f.emit(mint, 5_000, 0.01);
  assert.strictEqual(f.rows(mint).length, 8, 'restart cannot reopen or normally resolve censored arms');
  f.close();
}

function noEntryNoExitTest() {
  {
    const f = fixture(); const mint = 'no-entry'; f.prepare(mint);
    f.emit(mint, 1_000); f.tick(61_001);
    const rows = f.rows(mint);
    assert(rows.every(r => r.status === 'NO_ENTRY' && r.capital_in_sol === 0
      && r.estimated_cost_sol === 0 && r.net_return_pct === null));
    f.close();
  }
  {
    const f = fixture(); const mint = 'no-exit'; f.prepare(mint);
    f.emit(mint, 1_000); f.emit(mint, 1_200, 1, { wallet: 'public-b' });
    f.emit(mint, 2_200); f.tick(302_200); f.tick(333_201);
    const rows = f.rows(mint).filter(r => r.status === 'NO_EXIT');
    assert.strictEqual(rows.length, 4);
    assert(rows.every(r => r.net_return_pct === null
      && Math.abs(r.estimated_cost_sol - 0.00061) < 1e-12));
    f.close();
  }
}

policyTest(); causalFlowAndPairTest(); trailingAndStopsTest(); frozenParametersTest();
atomicMatrixRetryTest(); migrationPoolAndClockTest(); strictClockAndTransactionDedupTest();
historicPartialMatrixFailClosedTest(); restartCensorTest(); noEntryNoExitTest();
console.log('Post-graduation HOLD3 forward matrix tests: PASS');
