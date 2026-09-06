'use strict';

const { ammQuoteStateRejection, executableBuy, executableSell } = require('./ShadowExecutionModel');

const VERSION = 'POST_POOL_EXEC1_V1';
const MAX_SLOT_EVENT_KEYS = 256;
const duration = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;

// Only opt-in, separately named research cohorts use this policy. The complete
// policy travels with each row, so config edits cannot rewrite an open study.
function freezePolicy(profile, config, exit = {}) {
  if (!profile?.strictExecution) return null;
  if (profile.strictExecution.version !== VERSION) throw new Error('Unsupported strict AMM study version');
  return {
    version: VERSION,
    maxTradeAgeMs: 3_000,
    entryDelayMs: 1_000,
    exitDelayMs: 1_000,
    entryTimeoutMs: duration(profile.entryTimeoutMs, duration(config.entryTimeoutMs, 30_000)),
    exitTimeoutMs: duration(exit.exitTimeoutMs, duration(config.exitTimeoutMs, 30_000)),
  };
}

function observation(trade) {
  return {
    pool: trade?.pool, slot: trade?.slot, signature: trade?.signature,
    eventIndex: trade?.eventIndex, receivedAtMs: trade?.receivedAtMs,
    chainTimestampMs: trade?.chainTimestampMs,
  };
}

function slotEventKeys(cursor, slot) {
  if (!cursor || cursor.slot !== slot) return [];
  // Rows created before the first cursor advance still identify their source
  // event; include it instead of silently forgetting that it was already seen.
  return Array.isArray(cursor.seenEventKeys)
    ? cursor.seenEventKeys : [`${cursor.signature}:${cursor.eventIndex}`];
}

function rejection(trade, state, now, { targetAt = null, notBeforeChainTimestampMs = null } = {}) {
  const policy = state?.policy;
  if (!policy || policy.version !== VERSION) return 'STRICT_POLICY_UNSUPPORTED';
  if (trade?.market !== 'PUMP_AMM') return 'STRICT_AMM_REQUIRED';
  if (trade.ammQuoteState !== 'POST_TRADE_V1') return 'STRICT_POST_QUOTE_REQUIRED';
  const invalid = ammQuoteStateRejection(trade);
  if (invalid) return invalid;
  const q = observation(trade);
  if (typeof q.pool !== 'string' || !q.pool.trim()) return 'STRICT_POOL_MISSING';
  if (state.pool && q.pool !== state.pool) return 'STRICT_POOL_MISMATCH';
  if (!Number.isSafeInteger(q.slot) || q.slot <= 0
    || typeof q.signature !== 'string' || !q.signature
    || !Number.isSafeInteger(q.eventIndex) || q.eventIndex < 0) return 'STRICT_EVENT_ID_MISSING';
  if (!Number.isSafeInteger(q.receivedAtMs) || q.receivedAtMs <= 0
    || !Number.isSafeInteger(q.chainTimestampMs) || q.chainTimestampMs <= 0) {
    return 'STRICT_EVENT_TIME_MISSING';
  }
  // A correctly decoded reserve is not proof of a current quote. Test both
  // ingestion age and wall-clock age; never turn old replay into a new fill.
  if (q.chainTimestampMs > q.receivedAtMs || q.receivedAtMs > now
    || q.receivedAtMs - q.chainTimestampMs > policy.maxTradeAgeMs
    || now - q.chainTimestampMs > policy.maxTradeAgeMs) return 'STRICT_CHAIN_NOT_FRESH';
  if (notBeforeChainTimestampMs != null && q.chainTimestampMs < notBeforeChainTimestampMs) {
    return 'STRICT_PRE_RESTART_QUOTE';
  }
  const previous = state.cursor;
  if (previous && (q.slot < previous.slot || q.chainTimestampMs < previous.chainTimestampMs
    || q.receivedAtMs < previous.receivedAtMs
    || (q.signature === previous.signature && q.eventIndex <= previous.eventIndex))) {
    return 'STRICT_OUT_OF_ORDER_QUOTE';
  }
  const keys = slotEventKeys(previous, q.slot);
  if (keys.length >= MAX_SLOT_EVENT_KEYS) return 'STRICT_SLOT_EVENT_LIMIT';
  const prefix = `${q.signature}:`;
  if (keys.some(key => key.startsWith(prefix)
    && Number(key.slice(prefix.length)) >= q.eventIndex)) return 'STRICT_OUT_OF_ORDER_QUOTE';
  if (targetAt != null && (q.receivedAtMs < targetAt || q.chainTimestampMs < targetAt)) {
    return 'STRICT_BEFORE_EXECUTION_TARGET';
  }
  return null;
}

function accept(trade, state, now, options = {}) {
  const reason = rejection(trade, state, now, options);
  if (reason) {
    state.lastRejected = { reason, at: now };
    return false;
  }
  state.pool ||= trade.pool;
  state.cursor = { ...observation(trade), seenEventKeys: [
    ...slotEventKeys(state.cursor, trade.slot), `${trade.signature}:${trade.eventIndex}`,
  ] };
  return true;
}

function afterTarget(trade, targetAt) {
  return Number.isFinite(targetAt) && trade.receivedAtMs >= targetAt
    && trade.chainTimestampMs >= targetAt;
}

function buy(trade, sol, mark) {
  if (trade?.ammQuoteState !== 'POST_TRADE_V1') return { available: false };
  return executableBuy(trade, sol, mark);
}

function sell(trade, units, mark) {
  if (trade?.ammQuoteState !== 'POST_TRADE_V1') return { available: false };
  const quote = executableSell(trade, units, mark);
  if (!quote.available) return quote; // no conservative missing-quote PnL
  try {
    const b = BigInt(trade.poolBaseReservesRaw);
    const realQ = BigInt(trade.poolQuoteReservesRaw);
    const effectiveQ = realQ + BigInt(trade.virtualQuoteReservesRaw ?? 0);
    const input = BigInt(Math.max(1, Math.round(units * 1e6)));
    if (effectiveQ * input / (b + input) > realQ) {
      return { ...quote, available: false, reason: 'STRICT_REAL_QUOTE_INVENTORY_INSUFFICIENT' };
    }
  } catch (_) { return { available: false, reason: 'STRICT_INVALID_CAPACITY' }; }
  return quote;
}

module.exports = { VERSION, MAX_SLOT_EVENT_KEYS, freezePolicy, observation, rejection, accept, afterTarget, buy, sell };
