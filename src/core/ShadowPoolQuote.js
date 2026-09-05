'use strict';

const { reservesForTrade } = require('./ShadowExecutionModel');
const { AMM_POST_TRADE_STATE, restoreRawExecutionContext,
  serializeAmmExecutionContext } = require('../data/RawExecutionContext');

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function capturePoolQuote(trade = {}, fallbackPrice = null) {
  const contextJson = serializeAmmExecutionContext(trade);
  trade = contextJson ? { ...trade,
    ...restoreRawExecutionContext({ ammExecutionContextJson: contextJson }) } : { ...trade };
  if (!trade?.market || !(finite(trade.timestampMs) > 0)) return null;
  // Persist explicit invalid states too, so an invalid new tick cannot silently
  // leave an earlier usable cache in place. Legacy unversioned quotes stay so.
  if (!invalidAmmState(trade) && !reservesForTrade(trade)) return null;
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
    pool: trade.pool ?? trade.poolAddress ?? null,
    slot: trade.slot ?? null,
    signature: trade.signature ?? null,
    eventIndex: trade.eventIndex ?? null,
    chainTimestampMs: trade.chainTimestampMs ?? null,
    receivedAtMs: trade.receivedAtMs ?? null,
    ammQuoteState: trade.ammQuoteState ?? null,
    ammQuoteStateReason: trade.ammQuoteStateReason ?? null,
    prePoolBaseReservesRaw: trade.prePoolBaseReservesRaw == null ? null : String(trade.prePoolBaseReservesRaw),
    prePoolQuoteReservesRaw: trade.prePoolQuoteReservesRaw == null ? null : String(trade.prePoolQuoteReservesRaw),
    preReservePrice: trade.preReservePrice == null ? null : finite(trade.preReservePrice),
    ammExecutionFees: trade.ammExecutionFees ?? null,
  };
}

function invalidAmmState(quote) {
  return quote?.market === 'PUMP_AMM' && quote.ammQuoteState != null
    && quote.ammQuoteState !== AMM_POST_TRADE_STATE;
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
  return parsed && !invalidAmmState(parsed) ? { ...parsed, mint } : null;
}

function quotePrice(quote) {
  const parsed = parsePoolQuote(quote);
  if (invalidAmmState(parsed)) return null;
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
  if (!parsed || invalidAmmState(parsed) || parsed.market !== entryMarket || parsed.timestampMs > now) return false;
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
