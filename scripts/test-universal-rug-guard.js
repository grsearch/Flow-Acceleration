'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PreEntryRugRiskTracker } = require('../src/core/PreEntryRugRiskTracker');
const { evaluateUniversalRugGuard } = require('../src/core/UniversalRugGuard');
const { resolveRugGuardPolicy } = require('../src/core/RugGuardPolicy');

const config = {
  enabled: true,
  windowMs: 15_000,
  stateRetentionMs: 60_000,
  sweepIntervalMs: 5_000,
  maxEventsPerMint: 256,
  cacheMaxAgeMs: 1_000,
  minTrades: 10,
  minBuySharePct: 58,
  minConsecutiveBuys: 14,
  maxSideAlternationPct: 30,
  minUpTickSharePct: 55,
  minReturnPct: 30,
  minFlags: 5,
  verticalFragileMinReturnPct: 50,
  verticalFragileMinBuyImpactPct: 10,
  verticalFragileMinWalletTxSharePct: 8,
  sparseBreadthMinBuysPerBuyer: 2,
  chaseRepeatedMinReturnPct: 30,
  chaseRepeatedMinSizeSharePct: 15,
  beijingRiskWindowEnabled: true,
  beijingRiskStartHour: 16,
  beijingRiskEndHour: 20,
  beijingRiskMinFlags: 4,
};

const tracker = new PreEntryRugRiskTracker({ config });
const store = { preEntryRugRisk: tracker };
for (let index = 0; index < 15; index += 1) {
  tracker.observeTrade({
    mint: 'rug', side: 'BUY', timestampMs: 1_000 + index * 500, price: 1 + index * 0.04,
  });
}
const shadow = evaluateUniversalRugGuard(store, {
  strategyId: 'PRIMARY:SHADOW-A', mint: 'rug', timestampMs: 9_000, source: 'SHADOW',
  market: 'PUMP_BONDING_CURVE', lifecycleStage: 'PRE_MIGRATION',
});
assert.equal(shadow.flagged, true);
assert.equal(shadow.blocked, false);
assert.equal(shadow.reason, 'RUG_RISK_LABEL_ONLY');
assert.equal(shadow.enforcementMode, 'LABEL_ONLY');
const live = evaluateUniversalRugGuard(store, {
  strategyId: 'LIVE-A', mint: 'rug', timestampMs: 9_010, source: 'LIVE',
  market: 'PUMP_AMM', lifecycleStage: 'POST_MIGRATION', lifecycleAgeMs: 20_000,
});
assert.equal(live.blocked, true);
assert.equal(live.reason, 'PRE_ENTRY_RUG_RISK');
assert.equal(live.enforcementMode, 'HARD_BLOCK');
assert.equal(tracker.health().liveCacheHits, 1);

const earlyPolicy = resolveRugGuardPolicy({
  strategyId: 'LIVE-A', source: 'LIVE', market: 'PUMP_AMM',
  lifecycleStage: 'POST_MIGRATION', lifecycleAgeMs: 5_000,
});
assert.equal(earlyPolicy.enforcementMode, 'HARD_BLOCK');
assert.equal(earlyPolicy.policyReason, 'POST_MIGRATION_AMM_HARD_BLOCK');
const gEarlyPolicy = resolveRugGuardPolicy({
  strategyId: 'MIGRATED_DROP_REBOUND:GFR_300', source: 'SHADOW', market: 'PUMP_AMM',
  lifecycleStage: 'POST_MIGRATION', lifecycleAgeMs: 5_000,
});
assert.equal(gEarlyPolicy.enforcementMode, 'LABEL_ONLY');
assert.equal(gEarlyPolicy.requireHc2, false);
assert.equal(gEarlyPolicy.policyReason, 'AMM_EARLY_STAGE_CANDIDATE_LABEL_ONLY');
const maturePolicy = resolveRugGuardPolicy({
  strategyId: 'LIVE-A', source: 'LIVE', market: 'PUMP_AMM',
  lifecycleStage: 'POST_MIGRATION', lifecycleAgeMs: 20_000,
});
assert.equal(maturePolicy.enforcementMode, 'HARD_BLOCK');
assert.equal(maturePolicy.policyReason, 'POST_MIGRATION_AMM_HARD_BLOCK');

const launch = evaluateUniversalRugGuard(store, {
  strategyId: 'LAUNCH_PULLBACK:FO', mint: 'rug', timestampMs: 9_020, source: 'SHADOW',
  market: 'PUMP_BONDING_CURVE',
});
assert.equal(launch.blocked, false);
assert.equal(launch.reason, 'RUG_RISK_LABEL_ONLY');

const lifecycle = evaluateUniversalRugGuard(store, {
  strategyId: 'MIGRATED_DROP_REBOUND:GFR_300', mint: 'rug', timestampMs: 9_030, source: 'SHADOW',
  market: 'PUMP_AMM', lifecycleStage: 'POST_MIGRATION', lifecycleAgeMs: 30_000,
});
assert.equal(lifecycle.blocked, true);
assert.equal(lifecycle.reason, 'PRE_ENTRY_RUG_RISK');

const migrationFamilyPolicy = resolveRugGuardPolicy({
  strategyId: 'MIGRATION_CONTINUITY:M-C5', source: 'SHADOW', market: 'PUMP_AMM',
  lifecycleStage: 'AMM_EARLY', lifecycleAgeMs: 5_000,
});
assert.equal(migrationFamilyPolicy.enforcementMode, 'HARD_BLOCK');
assert.equal(migrationFamilyPolicy.policyReason, 'POST_MIGRATION_FAMILY_HARD_BLOCK');

const incomplete = evaluateUniversalRugGuard(store, {
  strategyId: 'LIVE-B', mint: 'unknown', timestampMs: 9_010, source: 'LIVE',
});
assert.equal(incomplete.blocked, false);

const health = tracker.health();
assert.equal(health.guardRiskFlagged, 4);
assert.equal(health.guardHardBlocked, 2);
assert.equal(health.guardLabelOnly, 2);
assert.equal(
  health.enforcement,
  'EXISTING_GUARDS_PLUS_LIFECYCLE_CANDIDATES_FORWARD_LABEL_ONLY',
);

assert.equal(tracker._firstCliffStageCandidate('CURVE_LATE', {
  top3RecoveryPct: 2,
}).matched, true);
assert.equal(tracker._firstCliffStageCandidate('CURVE_LATE', {
  top3RecoveryPct: 2.01,
}).matched, false);
assert.equal(tracker._firstCliffStageCandidate('CURVE_MIGRATION', {
  maxWalletBuyTxSharePct: 70,
}).matched, true);
assert.equal(tracker._firstCliffStageCandidate('AMM_EARLY', {
  top3RecoveryPct: 20,
  maxWalletBuyTxSharePct: 24.99,
}).matched, true);
assert.equal(tracker._firstCliffStageCandidate('AMM_EARLY', {
  top3RecoveryPct: 20.01,
  maxWalletBuyTxSharePct: 25,
}).matched, true);
assert.equal(tracker._firstCliffStageCandidate('AMM_EARLY', {
  top3RecoveryPct: 20.01,
  maxWalletBuyTxSharePct: 24.99,
}).matched, false);
assert.equal(tracker._firstCliffStageCandidate('LAUNCH', {
  top3RecoveryPct: 0,
  maxWalletBuyTxSharePct: 100,
}).matched, false);

const entryFiles = [
  'BigWinnerShadowSuite.js',
  'BondingCurveMomentumShadowSuite.js',
  'CyaEarlyPyramidShadowSuite.js',
  'FlowFirstShadowManager.js',
  'FlowSmartConfirmShadowManager.js',
  'GraduationAccelerationShadowSuite.js',
  'GraduationHoldShadowSuite.js',
  'HolderGrowthShadowSuite.js',
  'LaunchPullbackShadowManager.js',
  'MigratedDropReboundShadowSuite.js',
  'MigrationContinuityShadowSuite.js',
  'MigrationSecondLegShadowSuite.js',
  'PrimarySignalShadowManager.js',
  'PublicFlowLeadShadowSuite.js',
  'QualityLeaderShadowSuite.js',
  'RangeScalperShadowSuite.js',
  'SmartLikeEarlyShadowSuite.js',
  'SmartOpenShadowManager.js',
  'SmartPullbackShadowManager.js',
  'SmartResonanceRightTailShadowSuite.js',
  'LiveTradingManager.js',
];
for (const file of entryFiles) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', file), 'utf8');
  assert.match(source, /evaluateUniversalRugGuard/, `${file} must evaluate the universal guard`);
  assert.match(source, /PRE_ENTRY_RUG_RISK/, `${file} must record the universal rejection reason`);
}

console.log('universal RUG guard tests passed');
