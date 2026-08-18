'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULTS = Object.freeze({
  hotRawHours: 48,
  batchRows: 25_000,
  maxRows: 5_000_000,
  maxRunMs: 45 * 60_000,
  pauseMs: 250,
  busyTimeoutMs: 5_000,
  gateMaxAgeMs: 6 * 60 * 60_000,
});

function parseArgs(argv) {
  const result = {};
  for (const value of argv) {
    if (value === '--dry-run') result.dryRun = true;
    else if (value.startsWith('--')) {
      const index = value.indexOf('=');
      if (index > 2) result[value.slice(2, index)] = value.slice(index + 1);
    }
  }
  return result;
}

function positiveNumber(value, fallback, { integer = false, min = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return integer ? Math.trunc(parsed) : parsed;
}

function unescapeStateValue(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"])/g, '$1');
  }
  return trimmed.replace(/\\([\\\s'"$`!&|;<>()[\]{}*?])/g, '$1');
}

function readStateFile(statePath) {
  const values = {};
  for (const line of fs.readFileSync(statePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    values[line.slice(0, index)] = unescapeStateValue(line.slice(index + 1));
  }
  return values;
}

function validateCosGate(statePath, now = Date.now(), gateMaxAgeMs = DEFAULTS.gateMaxAgeMs) {
  if (!statePath || !fs.existsSync(statePath)) {
    throw new Error('COS verification state is missing; retention cleanup is blocked');
  }
  const state = readStateFile(statePath);
  if (state.STATE !== 'CLEANING') {
    throw new Error(`COS verification state must be CLEANING, received ${state.STATE || 'empty'}`);
  }
  if (!String(state.REMOTE || '').startsWith('cos://')) {
    throw new Error('COS verification state has no verified remote object');
  }
  const updatedAt = Date.parse(state.UPDATED_AT || '');
  if (!Number.isFinite(updatedAt) || Math.abs(now - updatedAt) > gateMaxAgeMs) {
    throw new Error('COS verification state is stale; retention cleanup is blocked');
  }
  const archive = path.resolve(state.ARCHIVE || '');
  if (!archive || !archive.endsWith('.tar.gz') || !fs.existsSync(archive)) {
    throw new Error('Verified local archive is missing; retention cleanup is blocked');
  }
  const shaPath = `${archive}.sha256`;
  if (!fs.existsSync(shaPath)) {
    throw new Error('Verified archive checksum file is missing; retention cleanup is blocked');
  }
  const shaLine = fs.readFileSync(shaPath, 'utf8').trim();
  const expectedSha = String(state.DETAIL || '').match(/(?:^|\s)sha256=([a-f0-9]{64})(?:\s|$)/i)?.[1];
  if (!expectedSha || !shaLine.toLowerCase().startsWith(expectedSha.toLowerCase())) {
    throw new Error('Verified archive checksum does not match the COS verification state');
  }
  return { ...state, archive, shaPath, sha256: expectedSha.toLowerCase(), updatedAt };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPageStats(db) {
  const pageSize = Number(db.pragma('page_size', { simple: true }) || 0);
  const pageCount = Number(db.pragma('page_count', { simple: true }) || 0);
  const freePages = Number(db.pragma('freelist_count', { simple: true }) || 0);
  return {
    pageSize,
    pageCount,
    freePages,
    reusableBytes: pageSize * freePages,
  };
}

function assertRawTradesSchema(db) {
  const table = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'raw_trades'
  `).get();
  if (!table) throw new Error('raw_trades table is missing');
  const columns = new Set(db.prepare('PRAGMA table_info(raw_trades)').all().map((row) => row.name));
  if (!columns.has('id') || !columns.has('timestamp_ms')) {
    throw new Error('raw_trades must contain id and timestamp_ms');
  }
}

async function cleanupResearchRetention(options = {}) {
  const now = positiveNumber(options.now, Date.now(), { integer: true, min: 1 });
  const hotRawHours = positiveNumber(options.hotRawHours, DEFAULTS.hotRawHours, { min: 24 });
  const batchRows = positiveNumber(options.batchRows, DEFAULTS.batchRows, {
    integer: true, min: 100,
  });
  const maxRows = positiveNumber(options.maxRows, DEFAULTS.maxRows, {
    integer: true, min: batchRows,
  });
  const maxRunMs = positiveNumber(options.maxRunMs, DEFAULTS.maxRunMs, {
    integer: true, min: 1_000,
  });
  const pauseMs = positiveNumber(options.pauseMs, DEFAULTS.pauseMs, {
    integer: true, min: 0,
  });
  const busyTimeoutMs = positiveNumber(options.busyTimeoutMs, DEFAULTS.busyTimeoutMs, {
    integer: true, min: 100,
  });
  const cutoffMs = now - hotRawHours * 60 * 60_000;
  const dbPath = path.resolve(options.dbPath || process.env.FLOW_DB_PATH || './data/flow-research.db');
  const statePath = path.resolve(
    options.statePath || path.join(path.dirname(dbPath), 'exports', 'last-run.env'),
  );
  const reportPath = path.resolve(
    options.reportPath || path.join(path.dirname(dbPath), 'exports', 'retention-last-run.json'),
  );
  const dryRun = Boolean(options.dryRun);

  const gate = validateCosGate(statePath, now, positiveNumber(
    options.gateMaxAgeMs, DEFAULTS.gateMaxAgeMs, { integer: true, min: 60_000 },
  ));
  if (!fs.existsSync(dbPath)) throw new Error(`Research database not found: ${dbPath}`);

  const startedAt = Date.now();
  const db = new Database(dbPath, { fileMustExist: true });
  let deletedRows = 0;
  let batches = 0;
  let busyRetries = 0;
  let stopReason = 'NO_EXPIRED_ROWS';
  let beforePages;
  let afterPages;
  let oldestExpired = null;
  let optimizeExecuted = false;
  let optimizeError = null;
  try {
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    db.pragma('foreign_keys = ON');
    assertRawTradesSchema(db);
    beforePages = readPageStats(db);
    oldestExpired = db.prepare(`
      SELECT id, timestamp_ms FROM raw_trades
      WHERE timestamp_ms < ? ORDER BY timestamp_ms, id LIMIT 1
    `).get(cutoffMs) || null;

    if (dryRun || !oldestExpired) {
      stopReason = dryRun ? 'DRY_RUN' : 'NO_EXPIRED_ROWS';
    } else {
      const removeBatch = db.prepare(`
        DELETE FROM raw_trades
        WHERE id IN (
          SELECT id FROM raw_trades
          WHERE timestamp_ms < ?
          ORDER BY timestamp_ms, id
          LIMIT ?
        )
      `);
      while (deletedRows < maxRows && Date.now() - startedAt < maxRunMs) {
        const requested = Math.min(batchRows, maxRows - deletedRows);
        let result;
        try {
          result = removeBatch.run(cutoffMs, requested);
        } catch (error) {
          if ((error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') && busyRetries < 20) {
            busyRetries += 1;
            await sleep(Math.max(1_000, pauseMs));
            continue;
          }
          throw error;
        }
        const changes = Number(result.changes || 0);
        deletedRows += changes;
        batches += 1;
        if (changes < requested) {
          stopReason = 'NO_EXPIRED_ROWS';
          break;
        }
        stopReason = deletedRows >= maxRows ? 'MAX_ROWS' : 'MAX_RUNTIME';
        if (pauseMs > 0) await sleep(pauseMs);
      }
    }
    if (!dryRun) {
      try {
        db.pragma('analysis_limit = 400');
        db.pragma('optimize');
        optimizeExecuted = true;
      } catch (error) {
        optimizeError = error.message;
      }
    }
    afterPages = readPageStats(db);
  } finally {
    db.close();
  }

  const report = {
    formatVersion: 1,
    mode: dryRun ? 'DRY_RUN' : 'COS_GATED_RETENTION',
    dbPath,
    startedAtMs: startedAt,
    completedAtMs: Date.now(),
    cutoffMs,
    cutoffUtc: new Date(cutoffMs).toISOString(),
    hotRawHours,
    batchRows,
    maxRows,
    deletedRows,
    batches,
    busyRetries,
    stopReason,
    oldestExpired,
    optimize: {
      executed: optimizeExecuted,
      error: optimizeError,
      movedOutOfServiceStartup: true,
    },
    pages: { before: beforePages, after: afterPages },
    cosGate: {
      remote: gate.REMOTE,
      archive: gate.archive,
      sha256: gate.sha256,
      verifiedAt: gate.UPDATED_AT,
    },
    safety: {
      cosVerificationRequired: true,
      deletesOnlyRawTrades: true,
      openPositionsDeleted: false,
      signalsDeleted: false,
      shadowPositionsDeleted: false,
      walCheckpointExecuted: false,
      vacuumExecuted: false,
      optimizeExecuted,
      databaseFileShrunk: false,
      freedPagesRemainReusableBySqlite: true,
    },
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, reportPath);
  return report;
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  const result = await cleanupResearchRetention({
    dbPath: input.db,
    statePath: input.state,
    reportPath: input.report,
    hotRawHours: input['hot-raw-hours'] || process.env.FLOW_RETENTION_HOT_RAW_HOURS,
    batchRows: input['batch-rows'] || process.env.FLOW_RETENTION_BATCH_ROWS,
    maxRows: input['max-rows'] || process.env.FLOW_RETENTION_MAX_ROWS_PER_RUN,
    maxRunMs: input['max-run-ms'] || process.env.FLOW_RETENTION_MAX_RUN_MS,
    pauseMs: input['pause-ms'] || process.env.FLOW_RETENTION_BATCH_PAUSE_MS,
    busyTimeoutMs: input['busy-timeout-ms'] || process.env.FLOW_RETENTION_BUSY_TIMEOUT_MS,
    gateMaxAgeMs: input['gate-max-age-ms'] || process.env.FLOW_RETENTION_GATE_MAX_AGE_MS,
    dryRun: input.dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[RetentionCleanup] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULTS,
  cleanupResearchRetention,
  parseArgs,
  readStateFile,
  validateCosGate,
};
