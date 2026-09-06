'use strict';

// Bounded diagnostic capture only: no SQLite access, RPC, credentials, wallet
// lists, recent trade payloads, error text, or absolute runtime paths are saved.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const STAGES = ['LEGACY_GLOBAL', 'LAUNCH', 'CURVE_EARLY', 'CURVE_LATE',
  'CURVE_MIGRATION', 'AMM_EARLY', 'AMM_MATURE'];
const MARKETS = ['UNKNOWN', 'PUMP_BONDING_CURVE', 'PUMP_AMM'];
const ROLES = ['COORDINATED_BUYER', 'DUMP_SELLER'];
const RUG_COUNTERS = `enabled sendsTransactions trackedMints toxicWallets toxicTemplates
  observedTrades evaluations sampleReady flagged toxicTemplateCandidates toxicCollapseChecks
  toxicCollapsesLabeled toxicLastTemplateAt toxicLastCollapseAt toxicWalletsLearned
  toxicTemplatesLearned toxicMemoryLoaded toxicMemorySaved toxicMemoryLoadErrors
  toxicMemorySaveErrors toxicMemoryJsonLoaded toxicMemoryDbLoaded toxicLegacyQuarantined
  toxicHistoryPersisted toxicHistoryErrors toxicFuzzyMatches flaggedCrossMintWallets
  flaggedCrossMintTemplates flaggedExtremeDumpability cliffCandidates cliffConfirmed
  cliffPairedArtifactsIgnored cliffRecoveredBeforeConfirm cliffRug70 cliffRug80 slowRug30
  firstCliffPending firstCliffCandidates firstCliffHc1Matched firstCliffHc2Matched
  firstCliffStageCandidateMatched firstCliffResolved firstCliffCaught firstCliffNoCliff30s
  firstCliffCensored firstCliffAuditsPersisted firstCliffAuditErrors guardEvaluations
  guardPassed guardRejected guardRiskFlagged guardHardBlocked guardLabelOnly
  guardSampleInsufficient guardCrossMintRejected guardExtremeDumpabilityRejected
  liveCacheHits liveCacheMisses lastActionAt toxicMemoryDirty toxicMemorySaveInFlight`.split(/\s+/);
const RUG_THRESHOLDS = `crossMintEnabled templateWindowMs templateMinLargeBuys
  templateMinTotalBuySol templateMaxBurstSpanMs toxicCollapsePct toxicCollapseWindowMs
  toxicRetentionMs toxicWalletRetentionMs toxicTemplateRetentionMs toxicAmountTolerancePct
  toxicBurstToleranceMs toxicWalletOverlapMin firstCliffCounterfactualEnabled
  firstCliffHorizonMs firstCliffEffectiveBuyersMax firstCliffLifecycleEnabled
  firstCliffLaunchMaxAgeMs firstCliffCurveEarlyMaxAgeMs firstCliffCurveMigrationMinPct
  firstCliffAmmEarlyMaxAgeMs firstCliffCurveLateCandidateRecoveryMaxPct
  firstCliffCurveMigrationCandidateWalletBuyTxSharePct firstCliffAmmEarlyCandidateRecoveryMaxPct
  firstCliffAmmEarlyCandidateWalletBuyTxSharePct extremeDumpabilityEnabled`.split(/\s+/);
const SOURCE_FILES = ['src/index.js', 'src/config.js', 'src/core/PreEntryRugRiskTracker.js',
  'src/core/ResearchCalibrationPolicy.js', 'src/core/EarlyPureBuyBurstShadowSuite.js',
  'src/core/StrictAmmShadowExecution.js', 'src/core/MigratedDropReboundShadowSuite.js',
  'src/core/UniversalRugGuard.js', 'src/core/RugGuardPolicy.js',
  'src/core/GraduationAccelerationShadowSuite.js', 'src/core/LiveTradingManager.js',
  'src/core/ShadowExecutionModel.js', 'src/core/PumpEventParser.js',
  'src/core/SmartWalletRegistry.js', 'src/core/SmartWalletRegistryMaintenanceWorker.js',
  'src/core/PumpFlowStream.js', 'src/data/ResearchStore.js',
  'src/runtime/RuntimeTaskMetrics.js', 'src/runtime/ParserRejectionAudit.js',
  'scripts/export-research-window.js', 'scripts/export-runtime-diagnostics.js'];
const PARSER_REASONS = `TRUNCATED_EVENT INVALID_BORSH_BOOL INVALID_STRING_LENGTH
  PROGRAM_MISMATCH INVALID_RECEIVED_TIMESTAMP INVALID_CHAIN_TIMESTAMP
  CHAIN_TIMESTAMP_IN_FUTURE INVALID_TRADE_AMOUNT INVALID_AMM_RESERVES
  INVALID_FEE_BASIS_POINTS INVALID_CURVE_RESERVES INVALID_CREATE_RESERVES
  INVALID_MIGRATION_AMOUNT MALFORMED_EVENT`.split(/\s+/);
// These are fixed implementation names, never arbitrary keys from API payloads.
const TIMED_TASKS = ['parser:transaction', 'maintenance:parserQuarantineFlush',
  'maintenance:engineCleanup', 'maintenance:labelAdvance', 'maintenance:traderAdvance',
  'maintenance:refreshAmmSubscriptions',
  ...['smartWalletRegistry', 'smartWalletRegistryAdvance', 'smartWalletRegistryGraduate',
    'smartWalletRegistryEvent', 'smartWalletLedgerWake', 'smartVotingSnapshot',
    'smartConsensusV2', 'smartConsensusV2Event', 'smartConsensusV2Advance',
    'graduationAcceleration', 'graduationAccelerationAdvance', 'migratedDropRebound',
    'migratedDropReboundAdvance'].map((name) => `shadow:${name}`),
  ...['eligibilitySnapshot', 'eligibilitySnapshotForced', 'legacyLedgerRepair',
    'ledgerQueueConsume', 'workerApply:GRADES', 'workerApply:CLUSTERS']
    .map((name) => `smartWallet:${name}`)];
const TASK_FIELDS = `calls failures slowCalls totalMs maxMs lastMs lastStartedAt
  lastFinishedAt lastLoggedAt`.split(/\s+/);

function numbers(source, keys) {
  const result = {};
  for (const key of keys) {
    const value = source?.[key];
    if (value === null || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
  }
  return result;
}

function scopeCounts(source, scopes) {
  const result = {};
  for (const scope of scopes) {
    if (!source?.[scope]) continue;
    result[scope] = { ...numbers(source[scope], ['wallets', 'templates']),
      roles: numbers(source[scope].roles, ROLES) };
  }
  return result;
}

function runtimeDiagnostics(source) {
  const timings = source?.taskTimings;
  return {
    parser: { ...numbers(source?.parser, ['acceptedEvents', 'ignoredEvents', 'rejectedEvents',
      'rejectionCallbackErrors']),
    rejectedByReason: numbers(source?.parser?.rejectedByReason, PARSER_REASONS),
    rejectedByProgram: numbers(source?.parser?.rejectedByProgram,
      ['PUMP', 'PUMP_AMM', 'OTHER', 'UNATTRIBUTED']) },
    parserQuarantine: numbers(source?.parserQuarantine, ['observed', 'persisted',
      'duplicatePending', 'dropped', 'invalidRecords', 'writeErrors', 'lastRejectedAt', 'lastPersistedAt',
      'lastErrorAt', 'pending', 'oldestPendingAt', 'nextAttemptAt', 'capacity']),
    taskTimings: {
      scope: 'SYNCHRONOUS_CALLBACK_ONLY',
      ...numbers(timings, ['untrackedNames', 'logErrors']),
      tasks: Object.fromEntries(TIMED_TASKS.filter((name) => timings?.tasks?.[name])
        .map((name) => [name, numbers(timings.tasks[name], TASK_FIELDS)])),
      recentSlow: (Array.isArray(timings?.recentSlow) ? timings.recentSlow : []).slice(-32)
        .filter((row) => TIMED_TASKS.includes(row?.name))
        .map((row) => ({ name: row.name,
          ...numbers(row, ['startedAt', 'finishedAt', 'durationMs', 'failed']) })),
    },
  };
}

function walletMaintenance(source) {
  const ledger = source?.actualLedger;
  return {
    ...numbers(source, ['enabled', 'workerEnabled', 'eligibilitySnapshotGeneratedAt',
      'eligibilitySnapshotExpiresAt', 'eligibilitySnapshotDirty', 'eligibilitySnapshotWallets',
      'eligibilitySnapshotMonitored', 'eligibilitySnapshotVoting', 'actualEventBackfillPending',
      'actualEventBackfillBatchSize', 'actualEventBackfillIntervalMs', 'maintenanceRunsStarted',
      'maintenanceRunsCompleted', 'maintenanceRunsFailed', 'maintenanceTimeouts',
      'lastMaintenanceStartedAt', 'lastMaintenanceCompletedAt', 'lastMaintenanceDurationMs']),
    actualLedger: {
      status: ['UNINITIALIZED', 'REPAIRING', 'REPLAY_REQUIRED', 'PENDING', 'CAUGHT_UP']
        .includes(ledger?.status) ? ledger.status : 'UNKNOWN',
      ...numbers(ledger, ['generatedAt', 'pendingSampleCount', 'pendingSampleTruncated',
        'replayRequiredTruncated']),
      repair: numbers(ledger?.repair, ['high_water_event_id', 'last_scanned_event_id',
        'scanned_events', 'queued_events', 'started_at', 'updated_at']),
      // No wallet/mint identifiers, error text, or SQL are copied to the summary.
      oldestPending: numbers(ledger?.oldestPendingSample,
        ['smart_event_id', 'event_timestamp_ms', 'attempts']),
      replayRequiredSampleCount: Array.isArray(ledger?.replayRequired)
        ? Math.min(10, ledger.replayRequired.length) : 0,
    },
  };
}

function sanitizeHealth(source) {
  const rug = source?.preEntryRugRisk;
  return {
    ...numbers(source, ['uptimeMs', 'dataLatencyMs', 'ready', 'databaseQueuedTradeLagMs']),
    status: ['streaming', 'degraded', 'waiting', 'starting'].includes(source?.status)
      ? source.status : 'unknown',
    runtime: {
      ...numbers(source?.runtime, ['pid', 'startedAt']),
      gitCommit: /^[a-f0-9]{40,64}$/i.test(source?.runtime?.gitCommit || '')
        ? source.runtime.gitCommit : null,
    },
    stream: numbers(source?.stream, ['transactionsReceived', 'lastTransactionAt', 'errors',
      'failovers', 'staleFailovers', 'watchdogEventLoopDeferrals', 'lastWatchdogLagMs',
      'requestedAmmMintCount', 'appliedAmmMintCount', 'requestedSubscriptionVersion',
      'appliedSubscriptionVersion']),
    database: numbers(source?.database, ['queuedTradeLagMs', 'pendingTrades', 'writeErrors',
      'writeRetries', 'lastWriteAt']),
    liveTrading: numbers(source?.liveTrading, ['enabled', 'dryRun', 'safetyLock',
      'evaluated', 'signals', 'entries', 'exits', 'riskRejected', 'entryFailures',
      'rejectedPositionTrades', 'takeProfitQuoteRejected', 'activePositions', 'lastActionAt']),
    runtimeDiagnostics: runtimeDiagnostics(source?.runtimeDiagnostics),
    smartWalletMaintenance: walletMaintenance(source?.smartWalletMaintenance),
    preEntryRugRisk: rug ? {
      ...numbers(rug, RUG_COUNTERS),
      thresholds: numbers(rug.thresholds, RUG_THRESHOLDS),
      toxicMemoryByStage: scopeCounts(rug.toxicMemoryByStage, STAGES),
      toxicMemoryByScope: scopeCounts(rug.toxicMemoryByScope,
        STAGES.flatMap((stage) => MARKETS.map((market) => `${stage}|${market}`))),
    } : null,
  };
}

function readHealth({ port, timeoutMs = 3_000, maxBytes = 8 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health' }, (response) => {
      if (response.statusCode !== 200) {
        finish({ status: 'UNAVAILABLE', reason: 'HTTP_STATUS', httpStatus: response.statusCode });
        response.destroy();
        return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          finish({ status: 'UNAVAILABLE', reason: 'RESPONSE_TOO_LARGE' });
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on('error', () => finish({ status: 'UNAVAILABLE', reason: 'RESPONSE_ERROR' }));
      response.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish({ status: 'CAPTURED', health: sanitizeHealth(parsed) });
        } catch (_) { finish({ status: 'UNAVAILABLE', reason: 'INVALID_JSON' }); }
      });
    });
    const timer = setTimeout(() => {
      finish({ status: 'UNAVAILABLE', reason: 'TIMEOUT' });
      request.destroy();
    }, timeoutMs);
    request.on('error', () => finish({ status: 'UNAVAILABLE', reason: 'CONNECTION_ERROR' }));
  });
}

function cacheDiagnostics(file, now) {
  if (!file || file === ':memory:') return { status: 'NOT_CONFIGURED' };
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return { status: 'TOO_LARGE_OR_NOT_FILE' };
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const counts = {};
    let active = 0; let expired = 0; let unknownScope = 0;
    for (const [kind, rows] of [['templates', payload.templates], ['wallets', payload.wallets]]) {
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!(row?.expiresAt > now)) { expired += 1; continue; }
        active += 1;
        const stage = row.lifecycleStage || 'LEGACY_GLOBAL';
        const market = row.market || 'UNKNOWN';
        if (!STAGES.includes(stage) || !MARKETS.includes(market)) { unknownScope += 1; continue; }
        const scope = `${stage}|${market}`;
        const entry = counts[scope] || { wallets: 0, templates: 0, roles: {} };
        entry[kind] += 1;
        if (kind === 'wallets' && ROLES.includes(row.walletRole)) {
          entry.roles[row.walletRole] = (entry.roles[row.walletRole] || 0) + 1;
        }
        counts[scope] = entry;
      }
    }
    return { status: 'CAPTURED', ...numbers(payload, ['version', 'savedAt']),
      ageMs: Number.isFinite(payload.savedAt) ? Math.max(0, now - payload.savedAt) : null,
      active, expired, unknownScope, counts };
  } catch (error) { return { status: error.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE' }; }
}

function sourceDiagnostics(projectDir) {
  const hashes = {};
  for (const name of SOURCE_FILES) {
    try {
      const file = path.join(projectDir, name);
      if (fs.statSync(file).size > 2 * 1024 * 1024) { hashes[name] = null; continue; }
      hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch (_) { hashes[name] = null; }
  }
  const git = (args) => {
    try { return execFileSync('git', ['-C', projectDir, ...args], {
      encoding: 'utf8', timeout: 1_000, maxBuffer: 1024 * 1024,
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(); } catch (_) { return null; }
  };
  const commit = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  return { gitCommit: /^[a-f0-9]{40,64}$/i.test(commit || '') ? commit : null,
    trackedWorkingTreeDirty: dirty == null ? null : Boolean(dirty), sourceFilesAtCapture: hashes };
}

async function captureDiagnostics({ projectDir, memoryPath, port, timeoutMs = 3_000, now = Date.now() }) {
  const api = await readHealth({ port, timeoutMs });
  const source = sourceDiagnostics(projectDir);
  const toxicCache = cacheDiagnostics(memoryPath, now);
  return { formatVersion: 1, capturedAt: now, captureFinishedAt: Date.now(),
    clock: 'CAPTURE_TIME_NOT_EXPORT_WINDOW_END',
    source, api, toxicCache };
}

async function main() {
  const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const index = arg.indexOf('=');
    return [arg.slice(2, index), arg.slice(index + 1)];
  }));
  if (!options.out) throw new Error('--out is required');
  const projectDir = path.resolve(__dirname, '..');
  require('dotenv').config({ path: path.join(projectDir, '.env'), quiet: true });
  const { config } = require('../src/config');
  const port = Number(options.port || config.server.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port');
  const memoryPath = config.preEntryRugRisk.toxicMemoryPath;
  const result = await captureDiagnostics({ projectDir,
    memoryPath: memoryPath && memoryPath !== ':memory:' ? path.resolve(projectDir, memoryPath) : null,
    port });
  fs.writeFileSync(path.resolve(options.out), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}

if (require.main === module) main().catch(() => {
  process.stderr.write('Runtime diagnostic capture failed\n');
  process.exitCode = 1;
});

module.exports = { sanitizeHealth, readHealth, cacheDiagnostics, captureDiagnostics };
