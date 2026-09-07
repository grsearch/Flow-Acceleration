'use strict';

// A new, shadow-only cohort. Existing POSTV1 and D1000 economics remain intact.
const VERSION = 'HO_EXECUTION_FRICTION_V1';
const FEE_MODEL = 'OBSERVED_AMM_BPS_NETWORK_ASSUMPTION_V1';
const NETWORK_FEE_SOL_PER_SIDE = 0.000105; // 0.0001 priority + 0.000005 base; not a receipt.
const SOURCES = ['O_C80_HO200_X60_POSTV1', 'O_C80_HO500_X60_POSTV1'];

function profilesWithFriction(profiles, config = {}) {
  const result = [...profiles];
  for (const sourceId of SOURCES) {
    const source = profiles.find((profile) => profile.id === sourceId);
    if (!source) continue;
    for (const delay of [1_000, 2_000]) {
      const id = `${sourceId}_FRIC1_D${delay}`;
      if (result.some((profile) => profile.id === id)) continue;
      result.push({ ...source, id,
        label: `${sourceId.replace('_X60_POSTV1', '')} · POST V1 同源 / 双边延迟${delay / 1_000}秒 / 事件费率 / FIX60`,
        experimentGroup: VERSION, feeModel: FEE_MODEL,
        pairedSignalProfileId: source.id, pairedEntryProfileId: null,
        pairedBaselineProfileId: source.id, capacitySols: [0.1],
        shadowExecutionDelayMs: delay, exitDelayMs: delay,
        entryTimeoutMs: source.entryTimeoutMs ?? config.entryTimeoutMs ?? 2_500,
        exitTimeoutMs: config.exitTimeoutMs ?? 15_000,
        noExitObservationMs: config.noExitObservationMs ?? 600_000,
        newEntriesEnabled: source.newEntriesEnabled !== false,
        handoffLiveStrategyId: null, liveStrategyId: null, liveBridgeCapacitySol: null,
        capacityAwareExit: true,
      });
    }
  }
  return result;
}

function isFriction(position) { return position?.features?.executionFriction?.version === VERSION; }
function afterTarget(trade, target, deadline = Infinity) {
  return Number(trade.chainTimestampMs) >= target && Number(trade.receivedAtMs) >= target
    && Number(trade.chainTimestampMs) <= deadline && Number(trade.receivedAtMs) <= deadline;
}
function integer(value) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && value.trim() === '')) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function feeSchedule(trade) {
  const evidence = trade.ammExecutionFees;
  if (!evidence || typeof evidence !== 'object') return null;
  const names = ['lpFeeBasisPoints', 'protocolFeeBasisPoints', 'coinCreatorFeeBasisPoints'];
  const bps = names.map((name) => integer(evidence[name]));
  if (bps.some((n) => n == null || n > 10_000) || bps.reduce((sum, n) => sum + n, 0) >= 10_000) return null;
  return Object.fromEntries(names.map((name, index) => [name, bps[index]]));
}
function evidence(trade, schedule) {
  return { pool: trade.pool || trade.poolAddress, slot: trade.slot, signature: trade.signature,
    eventIndex: trade.eventIndex, chainTimestampMs: trade.chainTimestampMs,
    receivedAtMs: trade.receivedAtMs, reserveState: trade.ammQuoteState,
    poolBaseReservesRaw: trade.poolBaseReservesRaw, poolQuoteReservesRaw: trade.poolQuoteReservesRaw,
    virtualQuoteReservesRaw: trade.virtualQuoteReservesRaw ?? '0', schedule,
    feeAssumption: 'EVENT_BPS_PROJECTED_TO_SIMULATED_SIZE; NO_CASHBACK_CREDIT; BUYBACK_NOT_ADDED',
  };
}
function pool(trade) {
  if (trade.ammQuoteState !== 'POST_TRADE_V1') throw new Error('FRICTION_POST_RESERVES_REQUIRED');
  const base = BigInt(trade.poolBaseReservesRaw);
  const realQuote = BigInt(trade.poolQuoteReservesRaw);
  const quote = realQuote + BigInt(trade.virtualQuoteReservesRaw ?? 0);
  if (base <= 0n || realQuote <= 0n || quote <= 0n) throw new Error('FRICTION_RESERVES_UNAVAILABLE');
  return { base, realQuote, quote };
}
function fees(amount, schedule) {
  // PumpSwap rounds each fee component up independently; buyback is a split of
  // protocol revenue, not an additional fee. No speculative cashback credit.
  const parts = Object.values(schedule).map((bps) => (amount * BigInt(bps) + 9_999n) / 10_000n);
  return { lp: parts[0], total: parts.reduce((sum, n) => sum + n, 0n) };
}
function quote(trade, amount, side, tokenRaw = null) {
  const schedule = feeSchedule(trade);
  if (!schedule) return { available: false, reason: 'FRICTION_FEE_EVIDENCE_UNAVAILABLE' };
  try {
    const { base, realQuote, quote: reserves } = pool(trade);
    const spot = (Number(reserves) / 1e9) / (Number(base) / 1e6);
    let input, output, charge, units, price;
    if (side === 'BUY') {
      input = BigInt(Math.round(amount * 1e9));
      if (input <= 0n) throw new Error('FRICTION_AMOUNT_INVALID');
      const totalBps = Object.values(schedule).reduce((sum, n) => sum + n, 0);
      let effective = input * 10_000n / (10_000n + BigInt(totalBps));
      charge = fees(effective, schedule).total;
      const excess = effective + charge - input;
      if (excess > 0n) effective -= excess;
      // Match the SDK's conservative one-lamport input guard.
      output = base * (effective - 1n) / (reserves + effective - 1n);
      if (effective <= 1n || output <= 0n) throw new Error('FRICTION_ZERO_OUTPUT');
      units = Number(output) / 1e6;
      price = Number(input) / 1e9 / units;
      return { available: true, price, tokenUnits: units, tokenRaw: output.toString(),
        impactPct: (price / spot - 1) * 100,
        audit: { ...evidence(trade, schedule), inputSol: Number(input) / 1e9,
          tokenRaw: output.toString(), projectedAmmFeeSol: Number(charge) / 1e9,
          networkFeeSolAssumption: NETWORK_FEE_SOL_PER_SIDE } };
    }
    input = tokenRaw == null ? BigInt(Math.floor(amount * 1e6 + 1e-6)) : BigInt(tokenRaw);
    if (input <= 0n) throw new Error('FRICTION_AMOUNT_INVALID');
    const gross = reserves * input / (base + input);
    const charges = fees(gross, schedule);
    if (realQuote < gross - charges.lp) throw new Error('FRICTION_REAL_QUOTE_INVENTORY_INSUFFICIENT');
    output = gross - charges.total;
    if (output < 0n) throw new Error('FRICTION_FEES_EXCEED_OUTPUT');
    units = Number(input) / 1e6;
    price = Number(output) / 1e9 / units;
    return { available: true, price, proceedsSol: Number(output) / 1e9,
      impactPct: (1 - price / spot) * 100,
      audit: { ...evidence(trade, schedule), tokenRaw: input.toString(),
        grossProceedsSol: Number(gross) / 1e9, projectedAmmFeeSol: Number(charges.total) / 1e9,
        proceedsAfterAmmFeeSol: Number(output) / 1e9,
        networkFeeSolAssumption: NETWORK_FEE_SOL_PER_SIDE } };
  } catch (error) {
    return { available: false, reason: String(error.message).startsWith('FRICTION_')
      ? error.message : 'FRICTION_RESERVES_UNAVAILABLE' };
  }
}
function initialAudit(source, profile, target, deadline) {
  return { version: VERSION, feeModel: FEE_MODEL,
    sourcePositionId: source.id, sourceProfileId: source.entryProfileId,
    sourceCohortId: source.cohortId, sourceEpisodeId: source.episodeId,
    sourceQualifiedAt: source.entryAt, population: 'SOURCE_POSTV1_FILLED_0_1_SOL',
    entryDelayMs: profile.shadowExecutionDelayMs, exitDelayMs: profile.exitDelayMs,
    noExitObservationMs: profile.noExitObservationMs,
    entryTargetAt: target, entryDeadlineAt: deadline,
    networkFeeSolPerSideAssumption: NETWORK_FEE_SOL_PER_SIDE,
    returnBasis: 'REQUESTED_SWAP_SOL', rentTreatment: 'RECOVERABLE_CAPITAL_NOT_TRADING_COST; NOT_ESTIMATED',
    limitations: 'OBSERVED_POOL_SIMULATION_NOT_REAL_FILL; NO_MEV_OR_TOKEN_TRANSFER_FEE_MODEL',
    entry: null, exit: null, lateExit: null,
  };
}

module.exports = { VERSION, FEE_MODEL, NETWORK_FEE_SOL_PER_SIDE,
  profilesWithFriction, isFriction, afterTarget, quote, initialAudit };
