'use strict';

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveBigInt(value) {
  try {
    const result = BigInt(value || 0);
    return result > 0n ? result : 0n;
  } catch (_) {
    return 0n;
  }
}

function signedBigInt(value) {
  try {
    return BigInt(value || 0);
  } catch (_) {
    return 0n;
  }
}

function reservesForTrade(trade = {}) {
  if (trade.market === 'PUMP_AMM') {
    const baseRaw = positiveBigInt(trade.poolBaseReservesRaw);
    // virtualQuoteReserves is signed in PumpSwap events. Ignoring a negative
    // adjustment would overstate executable liquidity exactly during stress.
    const quoteRaw = positiveBigInt(trade.poolQuoteReservesRaw)
      + signedBigInt(trade.virtualQuoteReservesRaw);
    return baseRaw > 0n && quoteRaw > 0n
      ? { baseRaw, quoteRaw, source: 'PUMP_AMM_RESERVES' }
      : null;
  }
  if (trade.market === 'PUMP_BONDING_CURVE') {
    const baseRaw = positiveBigInt(trade.virtualTokenReservesRaw);
    const quoteRaw = positiveBigInt(trade.virtualSolReservesRaw);
    return baseRaw > 0n && quoteRaw > 0n
      ? { baseRaw, quoteRaw, source: 'BONDING_CURVE_VIRTUAL_RESERVES' }
      : null;
  }
  return null;
}

function rugClassification(trade = {}, rugMarkReturnPct = null) {
  const markReturnPct = finite(rugMarkReturnPct);
  const path = trade?.rugPath || null;
  const confirmedCliff = Boolean(path?.confirmed && String(path.kind || '').startsWith('CLIFF'));
  if (confirmedCliff && markReturnPct != null && markReturnPct <= -80) return 'CLIFF_RUG_80';
  if (confirmedCliff && markReturnPct != null && markReturnPct <= -70) return 'CLIFF_RUG_70';
  if (confirmedCliff) return 'CLIFF_DROP_50';
  if (path?.kind === 'SLOW_RUG_30') return 'SLOW_RUG_30';
  return null;
}

function executableBuy(trade, positionSol, fallbackPrice = null) {
  const marketPrice = finite(fallbackPrice);
  const sol = finite(positionSol);
  const reserves = reservesForTrade(trade);
  if (!reserves || !(sol > 0)) {
    return {
      available: false,
      price: marketPrice,
      marketPrice,
      impactPct: null,
      reason: 'ENTRY_CAPACITY_QUOTE_MISSING',
      reserveSource: reserves?.source || null,
    };
  }
  try {
    const inputRaw = BigInt(Math.max(1, Math.round(sol * 1e9)));
    const tokenOutRaw = reserves.baseRaw * inputRaw / (reserves.quoteRaw + inputRaw);
    const tokenUnits = Number(tokenOutRaw) / 1e6;
    const price = tokenUnits > 0 ? sol / tokenUnits : null;
    if (!(price > 0)) throw new Error('zero token output');
    return {
      available: true,
      price,
      marketPrice,
      tokenUnits,
      impactPct: marketPrice > 0 ? ((price / marketPrice) - 1) * 100 : null,
      reason: null,
      reserveSource: reserves.source,
    };
  } catch (_) {
    return {
      available: false,
      price: marketPrice,
      marketPrice,
      impactPct: null,
      reason: 'ENTRY_CAPACITY_QUOTE_INVALID',
      reserveSource: reserves.source,
    };
  }
}

function executableSell(trade, tokenUnits, fallbackPrice = null, {
  rugMarkReturnPct = null,
  conservativeMissingQuotePct = -100,
  maxQuoteToMarketRatio = null,
} = {}) {
  const marketPrice = finite(fallbackPrice);
  const units = finite(tokenUnits);
  const reserves = reservesForTrade(trade);
  const rugLike = finite(rugMarkReturnPct, 0) <= -35;
  const classification = rugClassification(trade, rugMarkReturnPct);
  const confirmedCliff = String(classification || '').startsWith('CLIFF');
  if (!reserves || !(units > 0)) {
    const conservative = rugLike || confirmedCliff;
    return {
      available: false,
      price: conservative ? 0 : marketPrice,
      marketPrice,
      proceedsSol: conservative ? 0 : (marketPrice > 0 && units > 0 ? marketPrice * units : null),
      impactPct: conservative ? conservativeMissingQuotePct : null,
      rugLike: rugLike || confirmedCliff,
      rugClassification: classification,
      conservative,
      reason: 'EXIT_CAPACITY_QUOTE_MISSING',
      reserveSource: reserves?.source || null,
    };
  }
  try {
    const inputRaw = BigInt(Math.max(1, Math.round(units * 1e6)));
    const quoteOutRaw = reserves.quoteRaw * inputRaw / (reserves.baseRaw + inputRaw);
    const proceedsSol = Number(quoteOutRaw) / 1e9;
    const price = proceedsSol / units;
    if (!(price >= 0) || !Number.isFinite(price)) throw new Error('invalid quote output');
    const quoteToMarketRatio = marketPrice > 0 ? price / marketPrice : null;
    const maximumRatio = finite(maxQuoteToMarketRatio);
    if (maximumRatio > 0 && quoteToMarketRatio > maximumRatio) {
      return {
        available: false,
        price: marketPrice,
        marketPrice,
        proceedsSol: marketPrice > 0 ? marketPrice * units : null,
        impactPct: null,
        quoteToMarketRatio,
        rugLike: rugLike || confirmedCliff,
        rugClassification: classification,
        conservative: false,
        reason: 'EXIT_CAPACITY_QUOTE_MARK_PRICE_MISMATCH',
        reserveSource: reserves.source,
      };
    }
    const impactPct = marketPrice > 0 ? ((price / marketPrice) - 1) * 100 : null;
    return {
      available: true,
      price,
      marketPrice,
      proceedsSol,
      impactPct,
      quoteToMarketRatio,
      rugLike: rugLike || impactPct <= -25,
      rugClassification: classification,
      conservative: false,
      reason: null,
      reserveSource: reserves.source,
    };
  } catch (_) {
    const conservative = rugLike || confirmedCliff;
    return {
      available: false,
      price: conservative ? 0 : marketPrice,
      marketPrice,
      proceedsSol: conservative ? 0 : (marketPrice > 0 ? marketPrice * units : null),
      impactPct: conservative ? conservativeMissingQuotePct : null,
      rugLike: rugLike || confirmedCliff,
      rugClassification: classification,
      conservative,
      reason: 'EXIT_CAPACITY_QUOTE_INVALID',
      reserveSource: reserves.source,
    };
  }
}

// Bounded, deterministic reserve simulation used by the forward-only RUG
// observer. It answers a different question from a mark-price stop: how much
// SOL would remain for our exit after the largest publicly observed wallets
// dump their currently observed inventory first? No RPC or database access is
// performed here.
function simulateSellSequence(trade, tokenUnitSequence = []) {
  const reserves = reservesForTrade(trade);
  if (!reserves) return { available: false, reason: 'EXIT_CAPACITY_QUOTE_MISSING', legs: [] };
  let baseRaw = reserves.baseRaw;
  let quoteRaw = reserves.quoteRaw;
  const legs = [];
  try {
    for (const requestedUnits of tokenUnitSequence) {
      const units = finite(requestedUnits, 0);
      if (!(units > 0)) {
        legs.push({ tokenUnits: 0, proceedsSol: 0, price: null });
        continue;
      }
      const inputRaw = BigInt(Math.max(1, Math.round(units * 1e6)));
      const quoteOutRaw = quoteRaw * inputRaw / (baseRaw + inputRaw);
      const proceedsSol = Number(quoteOutRaw) / 1e9;
      legs.push({
        tokenUnits: units,
        proceedsSol,
        price: proceedsSol / units,
      });
      baseRaw += inputRaw;
      quoteRaw -= quoteOutRaw;
    }
    return {
      available: true,
      reason: null,
      reserveSource: reserves.source,
      legs,
      remainingBaseRaw: baseRaw,
      remainingQuoteRaw: quoteRaw,
    };
  } catch (_) {
    return {
      available: false,
      reason: 'EXIT_CAPACITY_QUOTE_INVALID',
      reserveSource: reserves.source,
      legs: [],
    };
  }
}

function executableRoundTrip({ trade, positionSol, entryPrice, marketExitPrice }) {
  const sol = finite(positionSol);
  const entry = finite(entryPrice);
  const markExit = finite(marketExitPrice);
  if (!(sol > 0) || !(entry > 0) || !(markExit >= 0)) return null;
  const tokenUnits = sol / entry;
  const markReturnPct = ((markExit / entry) - 1) * 100;
  const exit = executableSell(trade, tokenUnits, markExit, { rugMarkReturnPct: markReturnPct });
  const executableReturnPct = exit.price == null ? null : ((exit.price / entry) - 1) * 100;
  return { tokenUnits, markReturnPct, executableReturnPct, exit };
}

module.exports = {
  reservesForTrade,
  executableBuy,
  executableSell,
  executableRoundTrip,
  rugClassification,
  simulateSellSequence,
};
