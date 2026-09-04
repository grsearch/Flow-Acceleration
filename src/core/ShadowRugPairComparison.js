'use strict';

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator * 100 : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function performance(values) {
  const returns = values.map(finite).filter((value) => value != null);
  const gains = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const totalGain = gains.reduce((sum, value) => sum + value, 0);
  const totalLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    resolved: returns.length,
    winRatePct: ratio(gains.length, returns.length),
    averageNetReturnPct: returns.length
      ? returns.reduce((sum, value) => sum + value, 0) / returns.length
      : null,
    medianNetReturnPct: median(returns),
    profitFactor: totalLoss > 0 ? totalGain / totalLoss : (totalGain > 0 ? null : 0),
    rug50RatePct: ratio(returns.filter((value) => value <= -50).length, returns.length),
    rug80RatePct: ratio(returns.filter((value) => value <= -80).length, returns.length),
    big50RatePct: ratio(returns.filter((value) => value >= 50).length, returns.length),
  };
}

function isRugBlock(row) {
  return row.filtered_status === 'NO_ENTRY'
    && String(row.filtered_reason || '').startsWith('PRE_ENTRY_RUG_');
}

function parsedGuard(row) {
  const raw = row?.filtered_rug_guard_json ?? row?.filteredRugGuardJson;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function buildShadowRugPairComparison({
  id,
  label,
  baselineProfileId,
  filteredProfileId,
  exitProfileId = null,
  rows = [],
}) {
  const baselineReturns = rows
    .filter((row) => row.baseline_status === 'CLOSED')
    .map((row) => finite(row.baseline_return_pct))
    .filter((value) => value != null);
  const filteredReturns = rows
    .filter((row) => row.filtered_status === 'CLOSED')
    .map((row) => finite(row.filtered_return_pct))
    .filter((value) => value != null);
  const blocked = rows.filter(isRugBlock);
  const resolvedBlocked = blocked.filter((row) => (
    row.baseline_status === 'CLOSED' && finite(row.baseline_return_pct) != null
  ));
  const comparable = rows.filter((row) => {
    if (row.baseline_status !== 'CLOSED' || finite(row.baseline_return_pct) == null) return false;
    return isRugBlock(row)
      || (row.filtered_status === 'CLOSED' && finite(row.filtered_return_pct) != null);
  });
  const comparableBaseline = comparable.map((row) => finite(row.baseline_return_pct));
  const comparableFiltered = comparable.map((row) => (
    isRugBlock(row) ? 0 : finite(row.filtered_return_pct)
  ));
  const baselinePortfolio = performance(comparableBaseline);
  const filteredPortfolio = performance(comparableFiltered);
  const avoidedRug50 = resolvedBlocked.filter((row) => finite(row.baseline_return_pct) <= -50).length;
  const avoidedRug80 = resolvedBlocked.filter((row) => finite(row.baseline_return_pct) <= -80).length;
  const blockedWinners = resolvedBlocked.filter((row) => finite(row.baseline_return_pct) > 0).length;
  const blockedBig50 = resolvedBlocked.filter((row) => finite(row.baseline_return_pct) >= 50).length;
  const guards = rows.map(parsedGuard).filter(Boolean);
  const signatureHits = {};
  const hardBlockedBySignature = {};
  for (const row of rows) {
    const guard = parsedGuard(row);
    if (!guard) continue;
    for (const [signature, matched] of Object.entries(guard.signatures || {})) {
      if (!matched) continue;
      signatureHits[signature] = (signatureHits[signature] || 0) + 1;
      if (isRugBlock(row)) {
        hardBlockedBySignature[signature] = (hardBlockedBySignature[signature] || 0) + 1;
      }
    }
  }
  return {
    id,
    label,
    baselineProfileId,
    filteredProfileId,
    exitProfileId,
    pairedSignals: rows.length,
    blocked: blocked.length,
    resolvedBlocked: resolvedBlocked.length,
    pendingBlockedOutcomes: blocked.length - resolvedBlocked.length,
    avoidedRug50,
    avoidedRug80,
    blockedWinners,
    blockedBig50,
    guardAudit: {
      evaluated: guards.length,
      sampleReady: guards.filter((guard) => guard.sampleReady).length,
      sampleInsufficient: guards.filter((guard) => !guard.sampleReady).length,
      riskFlagged: guards.filter((guard) => guard.riskFlagged || guard.flagged).length,
      hardBlocked: guards.filter((guard) => guard.blocked).length,
      signatureHits,
      hardBlockedBySignature,
    },
    blockPrecisionPct: ratio(avoidedRug50, resolvedBlocked.length),
    falsePositiveRatePct: ratio(blockedWinners, resolvedBlocked.length),
    baseline: performance(baselineReturns),
    filtered: performance(filteredReturns),
    comparableResolved: comparable.length,
    comparableBaseline: baselinePortfolio,
    comparableFiltered: filteredPortfolio,
    averageNetReturnLiftPct: baselinePortfolio.averageNetReturnPct != null
      && filteredPortfolio.averageNetReturnPct != null
      ? filteredPortfolio.averageNetReturnPct - baselinePortfolio.averageNetReturnPct
      : null,
  };
}

module.exports = { buildShadowRugPairComparison };
