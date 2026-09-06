'use strict';
const assert = require('assert');
const { config } = require('../src/config');
const { applyResearchCalibrationPolicy, CALIBRATION_ID, LEGACY_LIVE_ID, LEGACY_RUGX, LEGACY_BASE } = require('../src/core/ResearchCalibrationPolicy');
const { costBreakdown } = require('../src/core/CostModel');
const { collectSafeConfigSummary } = require('../src/runtime/RuntimeIntegrity');
const { PumpTradeExecutor } = require('../src/core/PumpTradeExecutor');

const active = config.liveTrading.strategies.filter((p) => p.enabled !== false && p.entryEnabled !== false);
assert.deepStrictEqual(active.map((p) => p.id), [LEGACY_LIVE_ID]);
const live = active[0];
assert.strictEqual(live.positionSizeSol, 0.02);
assert.strictEqual(live.maxConcurrentPositions, 3);
assert.strictEqual(live.maxTotalConcurrentPositions, 3);
assert.strictEqual(config.liveTrading.maxConcurrentPositions, 3);
assert.strictEqual(config.liveTrading.priorityFeeSol, 0.0001);
assert.strictEqual(config.liveTrading.emergencyPriorityFeeSol, 0.0001);
assert.strictEqual(config.liveTrading.priorityFeeMicroLamports, 400_000);
assert.strictEqual(config.liveTrading.emergencyPriorityFeeMicroLamports, 400_000);
// Decode the actual offline compute-budget instructions used by send(). No
// executor constructor, connection, signer, or transaction submission is used.
const offlineExecutor = Object.create(PumpTradeExecutor.prototype);
offlineExecutor.config = config.liveTrading;
for (const override of [undefined, config.liveTrading.emergencyPriorityFeeMicroLamports]) {
  const budget = offlineExecutor._budgetInstructions(override);
  assert.strictEqual(budget.length, 2);
  assert.strictEqual(budget[0].data.readUInt32LE(1), 250_000);
  assert.strictEqual(budget[1].data.readBigUInt64LE(1), 400_000n);
}
assert.strictEqual(live.maxHoldMs, 1_800_000);
assert.strictEqual(live.exitMode, 'TRAILING');
assert.strictEqual(live.trailingActivationPct, 10);
assert.strictEqual(live.trailingStopPct, 5);
assert.strictEqual(live.hardStopPct, 30);
for (const key of ['cumulativeAmountLimitSol', 'cumulativeLossLimitSol', 'cumulativeTradeLimit']) assert.strictEqual(live[key], null);
assert.strictEqual(live.sourceShadowCohortId, LEGACY_RUGX);
assert.strictEqual(config.liveTrading.strategies.find((p) => p.id === CALIBRATION_ID).entryEnabled, false);
for (const id of ['migrated_ge30_r23_f2_only_g2_xleg_live',
  'migrated_grt_r23_f3_v2_xleg_live', 'graduation_accel_o_c80_ho500_x60_live']) {
  assert.strictEqual(config.liveTrading.strategies.find((p) => p.id === id).entryEnabled, false);
}
const eb = config.earlyPureBuyBurstShadow;
const baseline = eb.entryProfiles.find((p) => p.id === 'EB_A_EXEC_V1');
const rugx = eb.entryProfiles.find((p) => p.id === 'EB_A_EXEC_V1_RUGX');
assert.strictEqual(baseline.positionSizeSol, 0.02);
assert.strictEqual(baseline.entryDelayMs, 1_000);
assert.strictEqual(rugx.pairedBaselineProfileId, baseline.id);
assert.strictEqual(rugx.liveBridgeEnabled, false);
assert.strictEqual(baseline.liveBridgeEnabled, false);
const legacySource = config.migrationSecondLegShadow.cohorts.find((p) => p.id === LEGACY_RUGX);
const legacyBase = config.migrationSecondLegShadow.cohorts.find((p) => p.id === LEGACY_BASE);
assert.strictEqual(legacySource.liveBridgeEnabled, true);
assert.strictEqual(legacyBase.liveBridgeEnabled, false);
for (const key of ['thresholds', 'positionSizeSol', 'costModel', 'strictExecution',
  'hardStopPct', 'trailingActivationPct', 'trailingStopPct', 'maxHoldMs']) {
  assert.deepStrictEqual(legacyBase[key], legacySource[key], `strict pair shares ${key}`);
}
assert.strictEqual(baseline.costModel.priorityFeeSol, 2 * config.liveTrading.priorityFeeSol);
assert.strictEqual(costBreakdown(baseline.costModel).positionSizeSol, 0.02);
assert.ok(Math.abs(costBreakdown(baseline.costModel).deterministicCostPct - 3.05) < 1e-12);
const safeSummary = collectSafeConfigSummary(config);
assert.strictEqual(safeSummary.priorityFeeSol, 0.0001);
assert.strictEqual(safeSummary.emergencyPriorityFeeSol, 0.0001);
assert(!safeSummary.warnings.includes('LIVE_PRIORITY_FEE_POLICY_MISMATCH'));
assert(!safeSummary.warnings.includes('LIVE_PRIORITY_FEE_DERIVATION_MISMATCH'));
assert(!safeSummary.warnings.includes('CALIBRATION_SAFETY_CONFIG_MISMATCH'));
const staleFeeConfig = structuredClone(config);
staleFeeConfig.liveTrading.emergencyPriorityFeeSol = 0.002;
staleFeeConfig.liveTrading.emergencyPriorityFeeMicroLamports = 8_000_000;
assert(collectSafeConfigSummary(staleFeeConfig).warnings.includes('LIVE_PRIORITY_FEE_POLICY_MISMATCH'));
assert(collectSafeConfigSummary(staleFeeConfig).warnings.includes('LIVE_PRIORITY_FEE_DERIVATION_MISMATCH'));
staleFeeConfig.liveTrading.strategies.find((p) => p.id === LEGACY_LIVE_ID).maxTotalConcurrentPositions = 1;
assert(collectSafeConfigSummary(staleFeeConfig).warnings.includes('CALIBRATION_SAFETY_CONFIG_MISMATCH'));
// Fresh-module load proves old env priority values cannot survive, and CU
// conversion happens after the policy even with a nondefault compute limit.
const staleEnvironment = { FLOW_LIVE_PRIORITY_FEE_SOL: '0.0005',
  FLOW_LIVE_EMERGENCY_PRIORITY_FEE_SOL: '0.002', FLOW_LIVE_MAX_POSITIONS: '1',
  FLOW_LIVE_COMPUTE_UNIT_LIMIT: '500000', FLOW_LIVE_EBA_CAL02_ENTRY_ENABLED: 'true',
  FLOW_LIVE_LEGACY_EARLY_FLOW_RUGX_ENTRY_ENABLED: 'false' };
const savedEnvironment = new Map(Object.keys(staleEnvironment).map((key) => [key, process.env[key]]));
const configModulePath = require.resolve('../src/config');
const savedModule = require.cache[configModulePath];
let envOverride;
try {
  Object.assign(process.env, staleEnvironment);
  delete require.cache[configModulePath];
  const reloaded = require('../src/config').config;
  const p = reloaded.liveTrading;
  assert.deepStrictEqual(p.strategies.filter((row) => row.entryEnabled).map((row) => row.id), [],
    'turning off the new strategy must not restore an old entry flag');
  assert.strictEqual(reloaded.migrationSecondLegShadow.cohorts
    .find((row) => row.id === LEGACY_RUGX).liveBridgeEnabled, false);
  envOverride = { normal: p.priorityFeeSol, emergency: p.emergencyPriorityFeeSol,
    normalCu: p.priorityFeeMicroLamports, emergencyCu: p.emergencyPriorityFeeMicroLamports,
    max: p.maxConcurrentPositions, cost: reloaded.researchCalibration.costModel.priorityFeeSol };
} finally {
  require.cache[configModulePath] = savedModule;
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
assert.deepStrictEqual(envOverride, { normal: 0.0001, emergency: 0.0001,
  normalCu: 200_000, emergencyCu: 200_000, max: 3, cost: 0.0002 });
for (const id of ['EB_B', 'EB_C', 'EB_A_SWC_R2_W300']) {
  const profile = eb.entryProfiles.find((p) => p.id === id);
  if (profile) assert.strictEqual(profile.newEntriesEnabled, false);
}
assert(eb.exitProfiles.some((p) => p.id === 'FIX30'), 'retired exit definition must remain for recovery');
for (const cohort of config.migrationSecondLegShadow.cohorts.filter((p) => p.id.startsWith('PMO-FLOW-'))) {
  assert.notStrictEqual(cohort.enabled, false, 'do not remove recoverable cohort');
  if (!cohort.id.startsWith('PMO-FLOW-H15-A30-D15-X120')) assert.strictEqual(cohort.newEntriesEnabled, false);
}
const gd = config.migratedDropReboundShadow.entryProfiles.find((p) => p.id === 'GD25_35_POST_EXEC1_V1');
assert.deepStrictEqual(gd.positionSols, [0.02]);
assert.deepStrictEqual(gd.liveExitStrategies, {});
const hold = config.smartWalletConsensusFlowRunnerShadow.entryProfiles.find((p) => p.id === 'POST_GRAD_HOLD3_DIRECT_POST_EXEC1_V1');
assert.strictEqual(hold.positionSizeSol, 0.02);
assert.strictEqual(hold.strictExecution.entryDelayMs, 1_000);
const originalGlobalMode = [config.liveTrading.enabled, config.liveTrading.dryRun, config.liveTrading.safetyLock];
const counts = [config.liveTrading.strategies.length, eb.entryProfiles.length, eb.exitProfiles.length];
applyResearchCalibrationPolicy(config, { calibrationEntryEnabled: false });
assert.deepStrictEqual([config.liveTrading.strategies.length, eb.entryProfiles.length, eb.exitProfiles.length], counts);
assert.deepStrictEqual([config.liveTrading.enabled, config.liveTrading.dryRun, config.liveTrading.safetyLock], originalGlobalMode);
assert.strictEqual(config.liveTrading.strategies.filter((p) => p.entryEnabled).length, 0);
assert.strictEqual(eb.entryProfiles.find((p) => p.id === baseline.id).liveBridgeEnabled, false);
console.log('test-research-calibration-policy: ok');
