'use strict';

const { reservesForTrade } = require('./ShadowExecutionModel');

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function capturePoolQuote(trade = {}, fallbackPrice = null) {
  if (!trade?.market || !(finite(trade.timestampMs) > 0) || !reservesForTrade(trade)) return null;
  return {
    timestampMs: finite(trade.timestampMs),
    market: String(trade.market),
    price: finite(trade.price),
    reservePrice: finite(trade.reservePrice, finite(fallbackPrice)),
    virtualSolReservesRaw: trade.virtualSolReservesRaw ?? null,
    virtualTokenReservesRaw: trade.virtualTokenReservesRaw ?? null,
    poolBaseReservesRaw: trade.poolBaseReservesRaw ?? null,
    poolQuoteReservesRaw: trade.poolQuoteReservesRaw ?? null,
    virtualQuoteReservesRaw: trade.virtualQuoteReservesRaw ?? null,
  };
}

function parsePoolQuote(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return capturePoolQuote(parsed, parsed?.reservePrice ?? parsed?.price);
  } catch (_) {
    return null;
  }
}

function quoteTrade(quote, mint) {
  const parsed = parsePoolQuote(quote);
  return parsed ? { ...parsed, mint } : null;
}

function quotePrice(quote) {
  const parsed = parsePoolQuote(quote);
  return finite(parsed?.reservePrice, finite(parsed?.price));
}

function cacheIsUsableForExit({
  quote,
  mint,
  entryMarket,
  exitTargetAt,
  now,
  store,
}) {
  const parsed = parsePoolQuote(quote);
  if (!parsed || parsed.market !== entryMarket || parsed.timestampMs > now) return false;
  if (entryMarket !== 'PUMP_BONDING_CURVE') return true;
  const token = store?.getToken?.(mint);
  const graduatedAt = finite(
    token?.graduated_at ?? token?.graduatedAt ?? token?.migrated_at ?? token?.migratedAt,
  );
  // A cached curve state is executable until migration. Once migration has
  // happened, a pre-migration reserve snapshot must never be reused.
  return !(graduatedAt > 0
    && graduatedAt <= exitTargetAt
    && parsed.timestampMs < graduatedAt);
}

function exitCensorReason({ mint, entryMarket, exitTargetAt, store }) {
  if (entryMarket !== 'PUMP_BONDING_CURVE') return null;
  const token = store?.getToken?.(mint);
  const graduatedAt = finite(
    token?.graduated_at ?? token?.graduatedAt ?? token?.migrated_at ?? token?.migratedAt,
  );
  return graduatedAt > 0 && graduatedAt <= exitTargetAt
    ? 'MARKET_TRANSITION_BEFORE_SAME_MARKET_EXIT'
    : null;
}

module.exports = {
  capturePoolQuote,
  parsePoolQuote,
  quoteTrade,
  quotePrice,
  cacheIsUsableForExit,
  exitCensorReason,
};
