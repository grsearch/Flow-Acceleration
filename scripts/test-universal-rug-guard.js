'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PreEntryRugRiskTracker } = require('../src/core/PreEntryRugRiskTracker');
const { evaluateUniversalRugGuard } = require('../src/core/UniversalRugGuard');

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
  strategyId: 'SHADOW-A', mint: 'rug', timestampMs: 9_000, source: 'SHADOW',
});
assert.equal(shadow.blocked, true);
const live = evaluateUniversalRugGuard(store, {
  strategyId: 'LIVE-A', mint: 'rug', timestampMs: 9_010, source: 'LIVE',
});
assert.equal(live.blocked, true);
assert.equal(tracker.health().liveCacheHits, 1);

const incomplete = evaluateUniversalRugGuard(store, {
  strategyId: 'LIVE-B', mint: 'unknown', timestampMs: 9_010, source: 'LIVE',
});
assert.equal(incomplete.blocked, false);

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
