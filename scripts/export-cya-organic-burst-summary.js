'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const TABLE = 'cya_organic_burst_shadow_positions';

function parseArgs(argv) {
  const values = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const separator = item.indexOf('=');
    const key = item.slice(2, separator < 0 ? undefined : separator);
    values[key] = separator < 0 ? 'true' : item.slice(separator + 1);
  }
  return values;
}

function csvValue(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows, columns = null) {
  const fields = columns || Object.keys(rows[0] || {});
  const lines = [fields.map(csvValue).join(',')];
  for (const row of rows) lines.push(fields.map((field) => csvValue(row[field])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value, digits = 4) {
  return value == null ? null : Number(value.toFixed(digits));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildCohortSummary(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.entry_profile_id}\u0000${row.exit_profile_id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        entry_profile_id: row.entry_profile_id,
        exit_profile_id: row.exit_profile_id,
        signals: 0,
        mints: new Set(),
        closed: 0,
        no_exit: 0,
        no_entry: 0,
        price_jump: 0,
        returns: [],
      };
      groups.set(key, group);
    }
    group.signals += 1;
    group.mints.add(row.mint);
    if (row.status === 'CLOSED') group.closed += 1;
    if (row.status === 'NO_EXIT') group.no_exit += 1;
    if (row.status === 'NO_ENTRY') group.no_entry += 1;
    if (row.status === 'PRICE_JUMP') group.price_jump += 1;
    const value = finite(row.net_return_pct);
    if (row.status === 'CLOSED' && value != null) group.returns.push(value);
  }

  return [...groups.values()].map((group) => {
    const wins = group.returns.filter((value) => value > 0);
    const positive = wins.reduce((sum, value) => sum + value, 0);
    const negative = Math.abs(group.returns.filter((value) => value < 0)
      .reduce((sum, value) => sum + value, 0));
    return {
      entry_profile_id: group.entry_profile_id,
      exit_profile_id: group.exit_profile_id,
      signals: group.signals,
      independent_mints: group.mints.size,
      closed: group.closed,
      no_exit: group.no_exit,
      no_entry: group.no_entry,
      price_jump: group.price_jump,
      wins: wins.length,
      win_rate_pct: group.returns.length ? rounded(wins.length / group.returns.length * 100) : null,
      average_net_return_pct: group.returns.length
        ? rounded(group.returns.reduce((sum, value) => sum + value, 0) / group.returns.length)
        : null,
      median_net_return_pct: rounded(median(group.returns)),
      profit_factor: negative > 0 ? rounded(positive / negative) : (positive > 0 ? 'INF' : null),
      max_winner_pct: group.returns.length ? rounded(Math.max(...group.returns)) : null,
    };
  }).sort((left, right) => (
    left.entry_profile_id.localeCompare(right.entry_profile_id)
      || left.exit_profile_id.localeCompare(right.exit_profile_id)
  ));
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const databasePath = path.resolve(args.db || process.env.FLOW_DB_PATH || 'data/flow-research.db');
  const outputDir = path.resolve(args['out-dir'] || 'data/exports/cya-organic-burst');
  const startMs = finite(args['start-ms']);
  const endMs = finite(args['end-ms']);
  fs.mkdirSync(outputDir, { recursive: true });

  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  let rows;
  try {
    const exists = db.prepare(`
      SELECT 1 present FROM sqlite_master WHERE type='table' AND name=?
    `).get(TABLE);
    if (!exists) throw new Error(`Missing ${TABLE} in ${databasePath}`);
    const where = [];
    const bindings = [];
    if (startMs != null) { where.push('signal_at >= ?'); bindings.push(startMs); }
    if (endMs != null) { where.push('signal_at < ?'); bindings.push(endMs); }
    rows = db.prepare(`
      SELECT * FROM ${TABLE}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY signal_at, id
    `).all(...bindings);
  } finally {
    db.close();
  }

  const summary = buildCohortSummary(rows);
  writeCsv(path.join(outputDir, 'cob_positions_all.csv'), rows, rows.length ? Object.keys(rows[0]) : []);
  writeCsv(path.join(outputDir, 'cob_cohort_summary.csv'), summary);
  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceDatabase: databasePath,
    startMs,
    endMs,
    rows: rows.length,
    cohortRows: summary.length,
    entryProfiles: [...new Set(rows.map((row) => row.entry_profile_id))].sort(),
    exitProfiles: [...new Set(rows.map((row) => row.exit_profile_id))].sort(),
    summaryGrouping: ['entry_profile_id', 'exit_profile_id'],
    exitProfileFilterApplied: false,
  };
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(manifest, null, 2));
  return manifest;
}

if (require.main === module) main();

module.exports = { buildCohortSummary, main, parseArgs };
