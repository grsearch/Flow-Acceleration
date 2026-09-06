'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Deliberately bounded: never enumerate data, archives, .env, credentials or
// arbitrary caller-provided filenames. Capture once at startup, not per request.
const CRITICAL_FILES = Object.freeze([
  'src/config.js',
  'src/index.js',
  'src/server/server.js',
  'src/server/DashboardProcessServer.js',
  'src/server/dashboard-child.js',
  'src/server/DashboardQueryRunner.js',
  'src/server/dashboard-ad-hoc-worker.js',
  'src/server/DashboardHttpAssets.js',
  'src/server/public/index.html',
  'src/server/public/dashboard-runtime.js',
  'src/data/ResearchStore.js',
  'src/data/LiveAccountRecoveryStore.js',
  'src/data/RawTradeShardManager.js',
  'src/data/RawExecutionContext.js',
  'src/data/DashboardReadModel.js',
  'src/data/dashboard-preaggregate-worker.js',
  'src/data/dashboard-snapshot-tasks.js',
  'src/core/LiveTradingManager.js',
  'src/core/LiveAccountRecovery.js',
  'src/core/TokenAccountFunding.js',
  'src/core/LiveLossRugFeedback.js',
  'src/core/ResearchCalibrationPolicy.js',
  'src/core/LegacyEarlyFlowEntryTracker.js',
  'src/core/MigrationSecondLegShadowSuite.js',
  'src/core/SolUsdReference.js',
  'src/core/RugGuardPolicy.js',
  'src/core/UniversalRugGuard.js',
  'src/core/EarlyPureBuyBurstShadowSuite.js',
  'src/core/StrictAmmShadowExecution.js',
  'src/core/MigratedDropReboundShadowSuite.js',
  'src/core/PumpFlowStream.js',
  'src/core/SmartWalletConsensusFlowRunnerShadowSuite.js',
  'src/core/GraduationAccelerationShadowSuite.js',
  'src/core/ShadowExecutionModel.js',
  'src/core/ShadowPoolQuote.js',
  'src/core/PumpEventParser.js',
  'src/core/PumpTradeExecutor.js',
  'src/core/PreEntryRugRiskTracker.js',
  'src/core/SmartWalletRegistry.js',
  'src/core/SmartWalletConsensusOverlayObserver.js',
  'src/runtime/RuntimeIntegrity.js',
  'src/runtime/GracefulShutdown.js',
]);
const HO500_ID = 'graduation_accel_o_c80_ho500_x60_live';
const HO500_PROFILE = 'O_C80_HO500_X60_POSTV1';
const HO500_SOURCE = 'O_C80_HO500_X60_POSTV1:0_1SOL';
const POST_IDS = Object.freeze([
  'migrated_ge30_r23_f2_only_g2_xleg_live',
  'migrated_grt_r23_f3_v2_xleg_live',
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizedHash(bytes) {
  // Git checkouts can legitimately use CRLF. Retain the raw file hash as
  // evidence, and use only line-ending normalization for source comparison.
  return sha256(bytes.toString('utf8').replace(/\r\n/g, '\n'));
}

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_:.-]{1,160}$/.test(value) ? value : null;
}

function finite(value) { return Number.isFinite(value) ? value : null; }
function bool(value) { return typeof value === 'boolean' ? value : null; }

function strategySummary(strategy, id) {
  return {
    id, present: Boolean(strategy), enabled: bool(strategy?.enabled),
    entryEnabled: bool(strategy?.entryEnabled),
    sourceShadowCohortId: safeId(strategy?.sourceShadowCohortId),
    positionSizeSol: finite(strategy?.positionSizeSol),
    maxSignalAgeMs: finite(strategy?.maxSignalAgeMs),
    requireChainTimestamp: bool(strategy?.requireChainTimestamp),
    requireEntrySlot: bool(strategy?.requireEntrySlot),
    requireSignalPool: bool(strategy?.requireSignalPool),
    exitMode: safeId(strategy?.exitMode), fixedHoldMs: finite(strategy?.fixedHoldMs),
    hardStopPct: finite(strategy?.hardStopPct), maxHoldMs: finite(strategy?.maxHoldMs),
    trailingActivationPct: finite(strategy?.trailingActivationPct),
    trailingStopPct: finite(strategy?.trailingStopPct),
    requireRugGuard: bool(strategy?.requireRugGuard),
    requirePostTradeQuote: bool(strategy?.requirePostTradeQuote),
    maxConcurrentPositions: finite(strategy?.maxConcurrentPositions),
    maxTotalConcurrentPositions: finite(strategy?.maxTotalConcurrentPositions),
    calibrationOnly: bool(strategy?.calibrationOnly),
    stopOnExecutionAnomaly: bool(strategy?.stopOnExecutionAnomaly),
  };
}

function collectSafeConfigSummary(runtimeConfig) {
  if (!runtimeConfig) return { available: false, warnings: ['CONFIG_UNAVAILABLE'] };
  const live = runtimeConfig.liveTrading || {};
  const strategies = Array.isArray(live.strategies) ? live.strategies : [];
  const shadow = runtimeConfig.graduationAccelerationShadow || {};
  const profiles = Array.isArray(shadow.entryProfiles) ? shadow.entryProfiles : [];
  const profile = profiles.find((candidate) => candidate.id === HO500_PROFILE);
  const ho500 = strategySummary(strategies.find((candidate) => candidate.id === HO500_ID), HO500_ID);
  const post = POST_IDS.map((id) => strategySummary(strategies.find((candidate) => candidate.id === id), id));
  const bridge = {
    profileId: HO500_PROFILE, present: Boolean(profile), shadowEnabled: bool(shadow.enabled),
    handoffLiveStrategyId: safeId(profile?.handoffLiveStrategyId),
    liveBridgeCapacitySol: finite(profile?.liveBridgeCapacitySol),
    capacitySols: Array.isArray(profile?.capacitySols)
      ? profile.capacitySols.filter((value) => Number.isFinite(value)).slice(0, 16) : [],
    gateWindowMs: finite(profile?.postMigrationEntryGate?.windowMs),
    evaluateAtFill: bool(profile?.postMigrationEntryGate?.evaluateAtFill),
  };
  const warnings = [];
  if (!ho500.present) warnings.push('HO500_STRATEGY_MISSING');
  if (!bridge.present) warnings.push('HO500_SHADOW_PROFILE_MISSING');
  if (ho500.present && ho500.sourceShadowCohortId !== HO500_SOURCE) warnings.push('HO500_SOURCE_MISMATCH');
  if (ho500.present && ho500.positionSizeSol !== 0.1) warnings.push('HO500_LIVE_SIZE_NOT_0_1_SOL');
  if (bridge.present && bridge.handoffLiveStrategyId !== HO500_ID) warnings.push('HO500_BRIDGE_STRATEGY_MISMATCH');
  if (bridge.present && (bridge.liveBridgeCapacitySol !== 0.1 || !bridge.capacitySols.includes(0.1))) {
    warnings.push('HO500_BRIDGE_CAPACITY_NOT_0_1_SOL');
  }
  for (const strategy of [ho500, ...post]) {
    if (!strategy.present) {
      if (strategy.id !== HO500_ID) warnings.push(`STRATEGY_MISSING:${strategy.id}`);
      continue;
    }
    if (strategy.requireChainTimestamp !== true) warnings.push(`CHAIN_TIMESTAMP_GATE_MISSING:${strategy.id}`);
    if (strategy.requireEntrySlot !== true) warnings.push(`ENTRY_SLOT_GATE_MISSING:${strategy.id}`);
  }
  if (ho500.present && ho500.requireSignalPool !== true) warnings.push('HO500_SIGNAL_POOL_GATE_MISSING');
  if (runtimeConfig.researchCalibration) {
    const calibrationId = 'legacy_early_flow_rugx_live';
    const cal = strategies.find((row) => row.id === calibrationId);
    const calSource = runtimeConfig.migrationSecondLegShadow?.cohorts
      ?.find((row) => row.id === 'LEGACY-EARLY-FLOW-RUGX');
    const calBase = runtimeConfig.migrationSecondLegShadow?.cohorts
      ?.find((row) => row.id === 'LEGACY-EARLY-FLOW-BASE');
    if (!cal || cal.positionSizeSol !== 0.02 || cal.maxConcurrentPositions !== 3
      || cal.maxTotalConcurrentPositions !== 3 || live.maxConcurrentPositions !== 3 || cal.hardStopPct !== 30
      || cal.maxHoldMs !== 1_800_000 || cal.stopOnExecutionAnomaly !== true
      || cal.exitMode !== 'TRAILING' || cal.trailingActivationPct !== 10 || cal.trailingStopPct !== 5
      || cal.requirePostTradeQuote !== true || cal.requireRugGuard !== true
      || cal.rugGuardMode !== 'HARD_BLOCK' || cal.market !== 'PUMP_AMM'
      || JSON.stringify(cal.hardBlockSignatures) !== JSON.stringify(['crossMintToxicWallets', 'crossMintToxicTemplate'])
      || cal.sourceShadowCohortId !== 'LEGACY-EARLY-FLOW-RUGX'
      || cal.requireChainTimestamp !== true || cal.requireEntrySlot !== true
      || !['cumulativeAmountLimitSol', 'cumulativeLossLimitSol', 'cumulativeTradeLimit']
        .every((key) => cal[key] === null)) warnings.push('CALIBRATION_SAFETY_CONFIG_MISMATCH');
    if (!calSource || !calBase || calBase.positionSizeSol !== 0.02
      || calSource.positionSizeSol !== 0.02 || calSource.rugGuardMode !== 'HARD_BLOCK'
      || JSON.stringify(calSource.hardBlockSignatures) !== JSON.stringify(cal?.hardBlockSignatures)
      || calSource.strictExecution?.version !== 'POST_POOL_EXEC1_V1'
      || calBase.strictExecution?.version !== 'POST_POOL_EXEC1_V1'
      || calBase.rugGuardMode !== 'LABEL_ONLY' || calBase.liveBridgeEnabled !== false
      || runtimeConfig.migrationSecondLegShadow?.enabled !== true
      || calSource.liveStrategyId !== calibrationId
      || calSource.liveBridgeEnabled !== cal?.entryEnabled) warnings.push('CALIBRATION_BRIDGE_MISMATCH');
    if (runtimeConfig.earlyPureBuyBurstShadow?.entryProfiles
      ?.some((row) => row.liveBridgeEnabled)) warnings.push('RETIRED_CAL02_BRIDGE_ENABLED');
    if (strategies.some((row) => row.id !== calibrationId && row.enabled !== false
      && row.entryEnabled !== false)) warnings.push('CALIBRATION_OTHER_LIVE_ENTRY_ENABLED');
    if (live.priorityFeeSol !== 0.0001 || live.emergencyPriorityFeeSol !== 0.0001) {
      warnings.push('LIVE_PRIORITY_FEE_POLICY_MISMATCH');
    }
    const expectedMicroLamports = live.computeUnitLimit > 0
      ? Math.ceil(0.0001 * 1e15 / live.computeUnitLimit) : null;
    if (expectedMicroLamports == null || live.priorityFeeMicroLamports !== expectedMicroLamports
      || live.emergencyPriorityFeeMicroLamports !== expectedMicroLamports) {
      warnings.push('LIVE_PRIORITY_FEE_DERIVATION_MISMATCH');
    }
  }
  const summary = {
    available: true, liveEnabled: bool(live.enabled), maxSignalAgeMs: finite(live.maxSignalAgeMs),
    maxPositionTradeAgeMs: finite(live.maxPositionTradeAgeMs), ho500, bridge, post,
    maxConcurrentPositions: finite(live.maxConcurrentPositions),
    priorityFeeSol: finite(live.priorityFeeSol),
    emergencyPriorityFeeSol: finite(live.emergencyPriorityFeeSol),
    priorityFeeMicroLamports: finite(live.priorityFeeMicroLamports),
    emergencyPriorityFeeMicroLamports: finite(live.emergencyPriorityFeeMicroLamports),
    calibration: runtimeConfig.researchCalibration ? {
      version: safeId(runtimeConfig.researchCalibration.version),
      focusEnabled: bool(runtimeConfig.researchCalibration.focusEnabled),
      liveEntryEnabled: bool(runtimeConfig.researchCalibration.liveEntryEnabled),
      strategy: strategySummary(strategies.find((row) => row.id
        === runtimeConfig.researchCalibration.liveStrategyId), runtimeConfig.researchCalibration.liveStrategyId),
      costModel: runtimeConfig.researchCalibration.costModel,
    } : null,
    legacyRecovery: strategySummary(strategies.find((candidate) => candidate.id
      === 'graduation_accel_o_c80_ho500_x60_recovery_live'), 'graduation_accel_o_c80_ho500_x60_recovery_live'),
  };
  return { ...summary, fingerprint: sha256(JSON.stringify(summary)), warnings };
}

function readHeadBlobs(runGit, headCommit) {
  const refs = CRITICAL_FILES.map((file) => `${headCommit}:${file}`);
  const output = Buffer.from(runGit(['cat-file', '--batch'], `${refs.join('\n')}\n`));
  const blobs = new Map();
  let cursor = 0;
  for (let index = 0; index < refs.length; index += 1) {
    const end = output.indexOf(10, cursor);
    if (end < 0) throw new Error('INVALID_GIT_BATCH');
    const header = output.subarray(cursor, end).toString('utf8');
    cursor = end + 1;
    if (header === `${refs[index]} missing`) continue;
    const match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(header);
    if (!match) throw new Error('INVALID_GIT_BATCH');
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > 2 * 1024 * 1024
      || cursor + size >= output.length || output[cursor + size] !== 10) throw new Error('INVALID_GIT_BATCH');
    blobs.set(CRITICAL_FILES[index], output.subarray(cursor, cursor + size));
    cursor += size + 1;
  }
  return blobs;
}

function collectRuntimeIntegrity({
  projectDir = path.resolve(__dirname, '../..'), runtimeConfig = null,
  expectedCommit = null, gitBinary = 'git', runGit: suppliedRunGit = null,
} = {}) {
  if (expectedCommit != null && !/^[a-f0-9]{7,64}$/i.test(expectedCommit)) {
    throw new Error('expectedCommit must be a hexadecimal commit hash');
  }
  const root = path.resolve(projectDir);
  const runGit = suppliedRunGit || ((args, input) => execFileSync(gitBinary, args, {
    cwd: root, input, timeout: 2_000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }));
  let headCommit = null;
  let blobs = new Map();
  let gitStatus = 'AVAILABLE';
  try {
    const resolvedHead = Buffer.from(runGit(['rev-parse', '--verify', 'HEAD'])).toString('utf8').trim();
    if (!/^[a-f0-9]{40,64}$/.test(resolvedHead)) throw new Error('INVALID_HEAD');
    headCommit = resolvedHead;
    blobs = readHeadBlobs(runGit, headCommit);
  } catch (_) {
    // Do not publish stderr (it can contain paths, remote URLs or credentials).
    gitStatus = 'UNAVAILABLE';
  }
  const files = CRITICAL_FILES.map((file) => {
    let bytes = null;
    try {
      const filePath = path.join(root, file);
      const stat = fs.lstatSync(filePath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024) bytes = fs.readFileSync(filePath);
    } catch (_) { /* Report a fixed filename, never the error or file content. */ }
    const head = blobs.get(file);
    return {
      file, actualSha256: bytes ? sha256(bytes) : null, headSha256: head ? sha256(head) : null,
      normalizedSha256: bytes ? normalizedHash(bytes) : null,
      headNormalizedSha256: head ? normalizedHash(head) : null,
      status: !bytes || !head ? 'UNVERIFIED'
        : normalizedHash(bytes) === normalizedHash(head) ? 'MATCH' : 'MISMATCH',
    };
  });
  const mismatchedFiles = files.filter((file) => file.status === 'MISMATCH').map((file) => file.file);
  const unverifiedFiles = files.filter((file) => file.status === 'UNVERIFIED').map((file) => file.file);
  const expectedCommitMatches = expectedCommit && headCommit
    ? headCommit.startsWith(expectedCommit.toLowerCase()) : null;
  const configSummary = collectSafeConfigSummary(runtimeConfig);
  return {
    capturedAt: new Date().toISOString(), scope: 'STARTUP_DISK_SNAPSHOT',
    comparison: 'LF_NORMALIZED_SHA256', headCommit, gitStatus,
    expectedCommit: expectedCommit?.toLowerCase() || null, expectedCommitMatches,
    status: mismatchedFiles.length > 0 || expectedCommitMatches === false ? 'MISMATCH'
      : unverifiedFiles.length > 0 || gitStatus !== 'AVAILABLE' ? 'UNKNOWN' : 'MATCH',
    files, mismatchedFiles, unverifiedFiles, configSummary,
    warnings: [
      ...(mismatchedFiles.length ? ['SOURCE_FILES_DIFFER_FROM_HEAD'] : []),
      ...(unverifiedFiles.length ? ['SOURCE_FILES_UNVERIFIED'] : []),
      ...(expectedCommitMatches === false ? ['UNEXPECTED_HEAD_COMMIT'] : []),
      ...configSummary.warnings,
    ],
  };
}

module.exports = { CRITICAL_FILES, collectRuntimeIntegrity, collectSafeConfigSummary };
