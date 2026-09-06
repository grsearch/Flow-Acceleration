'use strict';

const bs58Module = require('bs58');
const { PublicKey } = require('@solana/web3.js');
const { createHash } = require('node:crypto');

const bs58 = bs58Module.default || bs58Module;

// Coarse wire sanity, not the trading freshness gate. A replay must supply its
// historical receivedAt; no comparison with the machine's current date is made.
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const EARLIEST_CHAIN_TIMESTAMP_MS = 1_577_836_800_000; // 2020-01-01, before Pump existed.
const MAX_SAFE_TIMESTAMP_SECONDS = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000));

class EventValidationError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.reason = reason;
    this.details = details;
  }
}

const DISCRIMINATORS = {
  pumpTrade: Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
  pumpCreate: Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]),
  pumpComplete: Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]),
  pumpMigration: Buffer.from([189, 233, 93, 185, 92, 148, 234, 148]),
  ammBuy: Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]),
  ammSell: Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]),
};

function encodeBase58(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return bs58.encode(Buffer.from(value));
  }
  return null;
}

class BorshReader {
  constructor(buffer, offset = 0) {
    this.buffer = Buffer.from(buffer);
    this.offset = offset;
  }

  require(size) {
    if (this.offset + size > this.buffer.length) {
      throw new EventValidationError('TRUNCATED_EVENT', { offset: this.offset, requiredBytes: size });
    }
  }

  u8() {
    this.require(1);
    return this.buffer[this.offset++];
  }

  bool() {
    const value = this.u8();
    if (value !== 0 && value !== 1) throw new EventValidationError('INVALID_BORSH_BOOL', { value });
    return value === 1;
  }

  u16() {
    this.require(2);
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  u32() {
    this.require(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  u64() {
    this.require(8);
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  i64() {
    this.require(8);
    const value = this.buffer.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  i128() {
    this.require(16);
    const low = this.buffer.readBigUInt64LE(this.offset);
    const high = this.buffer.readBigInt64LE(this.offset + 8);
    this.offset += 16;
    return (high << 64n) + BigInt(low);
  }

  remaining() {
    return this.buffer.length - this.offset;
  }

  pubkey() {
    this.require(32);
    const value = bs58.encode(this.buffer.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return value;
  }

  string() {
    const length = this.u32();
    if (length > 1_048_576) throw new EventValidationError('INVALID_STRING_LENGTH', { length });
    this.require(length);
    const value = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

function numberOf(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(seconds, details = {}) {
  if (typeof seconds !== 'bigint' || seconds <= 0n || seconds > MAX_SAFE_TIMESTAMP_SECONDS) {
    throw new EventValidationError('INVALID_CHAIN_TIMESTAMP', { ...details, chainTimestampSeconds: String(seconds) });
  }
  return Number(seconds) * 1_000;
}

function deriveBondingCurve(mint, pumpProgramId) {
  try {
    const [address] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
      new PublicKey(pumpProgramId),
    );
    return address.toBase58();
  } catch (_) {
    return null;
  }
}

function extractMeta(txMessage) {
  return txMessage?.transaction?.meta
    || txMessage?.meta
    || txMessage?.transaction?.transaction?.meta
    || null;
}

function extractSlot(txMessage) {
  const value = txMessage?.slot ?? txMessage?.transaction?.slot;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function extractSignature(txMessage) {
  const candidates = [
    txMessage?.transaction?.signature,
    txMessage?.signature,
    txMessage?.transaction?.transaction?.signature,
    txMessage?.transaction?.signatures?.[0],
    txMessage?.transaction?.transaction?.signatures?.[0],
  ];
  for (const value of candidates) {
    const encoded = encodeBase58(value);
    if (encoded) return encoded;
  }
  return null;
}

function extractCandidateMint(meta, wsolMint) {
  const balances = [
    ...(meta?.preTokenBalances || []),
    ...(meta?.postTokenBalances || []),
  ];
  for (const balance of balances) {
    if (balance?.mint && balance.mint !== wsolMint) return balance.mint;
  }
  return null;
}

function matches(buffer, discriminator) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(discriminator);
}

function decodePumpTrade(data, context) {
  const reader = new BorshReader(data, 8);
  const mint = reader.pubkey();
  const solAmountRaw = reader.u64();
  const tokenAmountRaw = reader.u64();
  const isBuy = reader.bool();
  const wallet = reader.pubkey();
  const chainTimestampMs = timestampMs(reader.i64(), {
    type: 'trade', mint, wallet, side: isBuy ? 'BUY' : 'SELL',
    solAmount: numberOf(solAmountRaw) / 1e9, tokenAmount: numberOf(tokenAmountRaw) / 1e6,
  });
  const virtualSolReservesRaw = reader.u64();
  const virtualTokenReservesRaw = reader.u64();
  const realSolReservesRaw = reader.u64();
  const realTokenReservesRaw = reader.u64();

  const solAmount = numberOf(solAmountRaw) / 1e9;
  const tokenAmount = numberOf(tokenAmountRaw) / 1e6;
  const price = tokenAmount > 0 ? solAmount / tokenAmount : null;
  const reservePrice = virtualTokenReservesRaw > 0n
    ? (numberOf(virtualSolReservesRaw) / 1e9) / (numberOf(virtualTokenReservesRaw) / 1e6)
    : null;

  return {
    type: 'trade',
    market: 'PUMP_BONDING_CURVE',
    mint,
    bondingCurve: deriveBondingCurve(mint, context.pumpProgramId),
    wallet,
    side: isBuy ? 'BUY' : 'SELL',
    solAmount,
    tokenAmount,
    price: Number.isFinite(price) && price > 0 ? price : reservePrice,
    reservePrice,
    chainTimestampMs,
    virtualSolReservesRaw: virtualSolReservesRaw.toString(),
    virtualTokenReservesRaw: virtualTokenReservesRaw.toString(),
    realSolReservesRaw: realSolReservesRaw.toString(),
    realTokenReservesRaw: realTokenReservesRaw.toString(),
  };
}

function decodePumpCreate(data) {
  const reader = new BorshReader(data, 8);
  const name = reader.string();
  const symbol = reader.string();
  const uri = reader.string();
  const mint = reader.pubkey();
  const bondingCurve = reader.pubkey();
  const user = reader.pubkey();
  const creator = reader.pubkey();
  const createdAt = timestampMs(reader.i64(), { type: 'create', mint });
  const initialVirtualTokenReservesRaw = reader.u64();
  const initialVirtualSolReservesRaw = reader.u64();
  const initialRealTokenReservesRaw = reader.u64();
  const tokenTotalSupplyRaw = reader.u64();

  return {
    type: 'create',
    mint,
    bondingCurve,
    user,
    creator,
    name,
    symbol,
    uri,
    createdAt,
    initialVirtualTokenReservesRaw: initialVirtualTokenReservesRaw.toString(),
    initialVirtualSolReservesRaw: initialVirtualSolReservesRaw.toString(),
    initialRealTokenReservesRaw: initialRealTokenReservesRaw.toString(),
    tokenTotalSupplyRaw: tokenTotalSupplyRaw.toString(),
  };
}

function decodePumpComplete(data) {
  const reader = new BorshReader(data, 8);
  return {
    type: 'complete',
    user: reader.pubkey(),
    mint: reader.pubkey(),
    bondingCurve: reader.pubkey(),
    completedAt: timestampMs(reader.i64()),
  };
}

function decodePumpMigration(data) {
  const reader = new BorshReader(data, 8);
  return {
    type: 'migration',
    user: reader.pubkey(),
    mint: reader.pubkey(),
    mintAmountRaw: reader.u64().toString(),
    solAmount: numberOf(reader.u64()) / 1e9,
    poolMigrationFeeSol: numberOf(reader.u64()) / 1e9,
    bondingCurve: reader.pubkey(),
    migratedAt: timestampMs(reader.i64()),
    pool: reader.pubkey(),
  };
}

// Event reserves are PRE-event. Never expose them as a current executable quote.
function ammPostTradeState(side, base, quote, amount, poolQuoteDelta, virtualQuote) {
  const postBase = side === 'BUY' ? base - amount : base + amount;
  const postQuote = side === 'BUY' ? quote + poolQuoteDelta : quote - poolQuoteDelta;
  const effectiveQuote = postQuote + virtualQuote;
  const maxU64 = (1n << 64n) - 1n;
  const reason = base <= 0n || quote + virtualQuote <= 0n ? 'INVALID_PRE_RESERVES'
    : amount <= 0n || poolQuoteDelta <= 0n ? 'INVALID_POOL_DELTA'
    : postBase <= 0n ? 'NON_POSITIVE_POST_BASE'
      : postQuote < 0n ? 'NEGATIVE_POST_QUOTE'
        : postBase > maxU64 || postQuote > maxU64 ? 'POST_RESERVES_OVERFLOW'
          : effectiveQuote <= 0n ? 'NON_POSITIVE_EFFECTIVE_POST_QUOTE' : null;
  return {
    ammQuoteState: reason ? 'INVALID' : 'POST_TRADE_V1',
    ammQuoteStateReason: reason,
    prePoolBaseReservesRaw: base.toString(),
    prePoolQuoteReservesRaw: quote.toString(),
    preReservePrice: base > 0n && quote + virtualQuote > 0n
      ? (Number(quote + virtualQuote) / 1e9) / (Number(base) / 1e6) : null,
    poolBaseReservesRaw: reason ? null : postBase.toString(),
    poolQuoteReservesRaw: reason ? null : postQuote.toString(),
    reservePrice: reason ? null : (Number(effectiveQuote) / 1e9) / (Number(postBase) / 1e6),
  };
}

function decodeAmmBuy(data, context) {
  const reader = new BorshReader(data, 8);
  const chainTimestampMs = timestampMs(reader.i64());
  const baseAmountRaw = reader.u64();
  reader.u64(); // max_quote_amount_in
  reader.u64(); // user_base_token_reserves
  reader.u64(); // user_quote_token_reserves
  const poolBaseReservesRaw = reader.u64();
  const poolQuoteReservesRaw = reader.u64();
  const quoteAmountRaw = reader.u64();
  const lpFeeBasisPoints = numberOf(reader.u64());
  const lpFeeRaw = reader.u64();
  const protocolFeeBasisPoints = numberOf(reader.u64());
  const protocolFeeRaw = reader.u64();
  const poolQuoteAmountRaw = reader.u64(); // quote_amount_in_with_lp_fee
  const userQuoteAmountRaw = reader.u64();
  const pool = reader.pubkey();
  const wallet = reader.pubkey();
  let virtualQuoteReservesRaw = 0n;
  let cashbackFeeBasisPoints = null;
  let cashbackRaw = null;
  let buybackFeeBasisPoints = null;
  let buybackRaw = null;
  let canBoost = null;
  let coinCreatorFeeBasisPoints = null;
  let coinCreatorFeeRaw = null;
  let ixName = 'buy';
  if (reader.remaining() > 0) {
    reader.pubkey(); // user_base_token_account
    reader.pubkey(); // user_quote_token_account
    reader.pubkey(); // protocol_fee_recipient
    reader.pubkey(); // protocol_fee_recipient_token_account
    reader.pubkey(); // coin_creator
    coinCreatorFeeBasisPoints = numberOf(reader.u64());
    coinCreatorFeeRaw = reader.u64();
    reader.bool(); // track_volume
    reader.u64(); // total_unclaimed_tokens
    reader.u64(); // total_claimed_tokens
    reader.u64(); // current_sol_volume
    reader.i64(); // last_update_timestamp
    reader.u64(); // min_base_amount_out
    ixName = reader.string();
    cashbackFeeBasisPoints = numberOf(reader.u64());
    cashbackRaw = reader.u64();
    buybackFeeBasisPoints = numberOf(reader.u64());
    buybackRaw = reader.u64();
    virtualQuoteReservesRaw = reader.i128();
    canBoost = reader.bool();
  }
  const tokenAmount = numberOf(baseAmountRaw) / 1e6;
  const solAmount = numberOf(quoteAmountRaw) / 1e9;

  return {
    type: 'ammTrade',
    market: 'PUMP_AMM',
    mint: context.candidateMint,
    pool,
    wallet,
    side: 'BUY',
    solAmount,
    tokenAmount,
    price: tokenAmount > 0 ? solAmount / tokenAmount : null,
    ...ammPostTradeState('BUY', poolBaseReservesRaw, poolQuoteReservesRaw,
      baseAmountRaw, poolQuoteAmountRaw, virtualQuoteReservesRaw),
    chainTimestampMs,
    virtualQuoteReservesRaw: virtualQuoteReservesRaw.toString(),
    cashbackFeeBasisPoints,
    cashbackRaw: cashbackRaw == null ? null : cashbackRaw.toString(),
    buybackFeeBasisPoints,
    buybackRaw: buybackRaw == null ? null : buybackRaw.toString(),
    canBoost,
    ammExecutionFees: {
      quoteAmountRaw: quoteAmountRaw.toString(), poolQuoteAmountRaw: poolQuoteAmountRaw.toString(),
      userQuoteAmountRaw: userQuoteAmountRaw.toString(), lpFeeBasisPoints, lpFeeRaw: lpFeeRaw.toString(),
      protocolFeeBasisPoints, protocolFeeRaw: protocolFeeRaw.toString(), coinCreatorFeeBasisPoints,
      coinCreatorFeeRaw: coinCreatorFeeRaw?.toString() ?? null, cashbackFeeBasisPoints,
      cashbackRaw: cashbackRaw?.toString() ?? null, buybackFeeBasisPoints,
      buybackRaw: buybackRaw?.toString() ?? null, ixName,
    },
  };
}

function decodeAmmSell(data, context) {
  const reader = new BorshReader(data, 8);
  const chainTimestampMs = timestampMs(reader.i64());
  const baseAmountRaw = reader.u64();
  reader.u64(); // min_quote_amount_out
  reader.u64(); // user_base_token_reserves
  reader.u64(); // user_quote_token_reserves
  const poolBaseReservesRaw = reader.u64();
  const poolQuoteReservesRaw = reader.u64();
  const quoteAmountRaw = reader.u64();
  const lpFeeBasisPoints = numberOf(reader.u64());
  const lpFeeRaw = reader.u64();
  const protocolFeeBasisPoints = numberOf(reader.u64());
  const protocolFeeRaw = reader.u64();
  const poolQuoteAmountRaw = reader.u64(); // quote_amount_out_without_lp_fee
  const userQuoteAmountRaw = reader.u64();
  const pool = reader.pubkey();
  const wallet = reader.pubkey();
  let virtualQuoteReservesRaw = 0n;
  let cashbackFeeBasisPoints = null;
  let cashbackRaw = null;
  let buybackFeeBasisPoints = null;
  let buybackRaw = null;
  let canBoost = null;
  let coinCreatorFeeBasisPoints = null;
  let coinCreatorFeeRaw = null;
  if (reader.remaining() > 0) {
    reader.pubkey(); // user_base_token_account
    reader.pubkey(); // user_quote_token_account
    reader.pubkey(); // protocol_fee_recipient
    reader.pubkey(); // protocol_fee_recipient_token_account
    reader.pubkey(); // coin_creator
    coinCreatorFeeBasisPoints = numberOf(reader.u64());
    coinCreatorFeeRaw = reader.u64();
    cashbackFeeBasisPoints = numberOf(reader.u64());
    cashbackRaw = reader.u64();
    buybackFeeBasisPoints = numberOf(reader.u64());
    buybackRaw = reader.u64();
    virtualQuoteReservesRaw = reader.i128();
    canBoost = reader.bool();
  }
  const tokenAmount = numberOf(baseAmountRaw) / 1e6;
  const solAmount = numberOf(quoteAmountRaw) / 1e9;

  return {
    type: 'ammTrade',
    market: 'PUMP_AMM',
    mint: context.candidateMint,
    pool,
    wallet,
    side: 'SELL',
    solAmount,
    tokenAmount,
    price: tokenAmount > 0 ? solAmount / tokenAmount : null,
    ...ammPostTradeState('SELL', poolBaseReservesRaw, poolQuoteReservesRaw,
      baseAmountRaw, poolQuoteAmountRaw, virtualQuoteReservesRaw),
    chainTimestampMs,
    virtualQuoteReservesRaw: virtualQuoteReservesRaw.toString(),
    cashbackFeeBasisPoints,
    cashbackRaw: cashbackRaw == null ? null : cashbackRaw.toString(),
    buybackFeeBasisPoints,
    buybackRaw: buybackRaw == null ? null : buybackRaw.toString(),
    canBoost,
    ammExecutionFees: {
      quoteAmountRaw: quoteAmountRaw.toString(), poolQuoteAmountRaw: poolQuoteAmountRaw.toString(),
      userQuoteAmountRaw: userQuoteAmountRaw.toString(), lpFeeBasisPoints, lpFeeRaw: lpFeeRaw.toString(),
      protocolFeeBasisPoints, protocolFeeRaw: protocolFeeRaw.toString(), coinCreatorFeeBasisPoints,
      coinCreatorFeeRaw: coinCreatorFeeRaw?.toString() ?? null, cashbackFeeBasisPoints,
      cashbackRaw: cashbackRaw?.toString() ?? null, buybackFeeBasisPoints,
      buybackRaw: buybackRaw?.toString() ?? null, ixName: 'sell',
    },
  };
}

const EVENT_DECODERS = [
  ['pumpTrade', 'pumpProgramId', decodePumpTrade],
  ['pumpCreate', 'pumpProgramId', decodePumpCreate],
  ['pumpComplete', 'pumpProgramId', decodePumpComplete],
  ['pumpMigration', 'pumpProgramId', decodePumpMigration],
  ['ammBuy', 'pumpAmmProgramId', decodeAmmBuy],
  ['ammSell', 'pumpAmmProgramId', decodeAmmSell],
];

function decodeEvent(data, currentProgram, context) {
  for (const [name, ownerKey, decode] of EVENT_DECODERS) {
    if (!matches(data, DISCRIMINATORS[name])) continue;
    // The discriminator is not globally unique. Only the runtime's currently
    // executing, configured owner may emit this event; missing ownership fails closed.
    if (!currentProgram || !context[ownerKey] || currentProgram !== context[ownerKey]) {
      throw new EventValidationError('PROGRAM_MISMATCH', {
        eventName: name, expectedProgramId: context[ownerKey] || null,
      });
    }
    try {
      return decode(data, context);
    } catch (error) {
      if (error instanceof EventValidationError) error.details = { eventName: name, ...error.details };
      throw error;
    }
  }
  return null;
}

function validateEvent(event, receivedAt) {
  if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) {
    throw new EventValidationError('INVALID_RECEIVED_TIMESTAMP');
  }
  const at = event.chainTimestampMs ?? event.createdAt ?? event.completedAt ?? event.migratedAt;
  if (!Number.isSafeInteger(at) || at < EARLIEST_CHAIN_TIMESTAMP_MS) {
    throw new EventValidationError('INVALID_CHAIN_TIMESTAMP', { chainTimestampMs: at });
  }
  if (at - receivedAt > MAX_FUTURE_SKEW_MS) {
    throw new EventValidationError('CHAIN_TIMESTAMP_IN_FUTURE', { chainTimestampMs: at });
  }
  const positive = (value) => Number.isFinite(value) && value > 0;
  if (event.type === 'trade' || event.type === 'ammTrade') {
    if (![event.solAmount, event.tokenAmount, event.price].every(positive)) {
      throw new EventValidationError('INVALID_TRADE_AMOUNT');
    }
    if (event.type === 'ammTrade') {
      if (event.ammQuoteState !== 'POST_TRADE_V1' || !positive(event.reservePrice)) {
        throw new EventValidationError('INVALID_AMM_RESERVES', { ammQuoteStateReason: event.ammQuoteStateReason });
      }
      const fees = event.ammExecutionFees;
      for (const key of ['lpFeeBasisPoints', 'protocolFeeBasisPoints', 'coinCreatorFeeBasisPoints',
        'cashbackFeeBasisPoints', 'buybackFeeBasisPoints']) {
        if (fees[key] != null && (!Number.isSafeInteger(fees[key]) || fees[key] < 0 || fees[key] > 10_000)) {
          throw new EventValidationError('INVALID_FEE_BASIS_POINTS', { field: key, value: fees[key] });
        }
      }
    } else if (!positive(event.reservePrice)
      || BigInt(event.virtualSolReservesRaw) <= 0n || BigInt(event.virtualTokenReservesRaw) <= 0n
      || BigInt(event.realSolReservesRaw) > BigInt(event.virtualSolReservesRaw)
      || BigInt(event.realTokenReservesRaw) > BigInt(event.virtualTokenReservesRaw)) {
      throw new EventValidationError('INVALID_CURVE_RESERVES');
    }
  } else if (event.type === 'create') {
    if (BigInt(event.initialVirtualTokenReservesRaw) <= 0n || BigInt(event.initialVirtualSolReservesRaw) <= 0n
      || BigInt(event.tokenTotalSupplyRaw) <= 0n
      || BigInt(event.initialRealTokenReservesRaw) > BigInt(event.initialVirtualTokenReservesRaw)
      || BigInt(event.initialRealTokenReservesRaw) > BigInt(event.tokenTotalSupplyRaw)) {
      throw new EventValidationError('INVALID_CREATE_RESERVES');
    }
  } else if (event.type === 'migration'
    && (!positive(event.solAmount) || BigInt(event.mintAmountRaw) <= 0n)) {
    throw new EventValidationError('INVALID_MIGRATION_AMOUNT');
  }
}

// Bounded whitelist: never retain raw log text, transaction payloads or errors
// from external callbacks. Raw integer strings preserve the forensic evidence.
function rejectionDetails(event, error) {
  const details = {};
  const input = { ...event, ...error.details };
  for (const key of ['eventName', 'expectedProgramId', 'type', 'market', 'mint', 'wallet', 'pool', 'side',
    'chainTimestampMs', 'chainTimestampSeconds', 'solAmount', 'tokenAmount', 'price', 'reservePrice',
    'virtualSolReservesRaw', 'virtualTokenReservesRaw', 'realSolReservesRaw', 'realTokenReservesRaw',
    'prePoolBaseReservesRaw', 'prePoolQuoteReservesRaw', 'poolBaseReservesRaw', 'poolQuoteReservesRaw',
    'virtualQuoteReservesRaw', 'ammQuoteState', 'ammQuoteStateReason', 'offset', 'requiredBytes',
    'length', 'field', 'value']) {
    const value = input[key];
    if (typeof value === 'string') details[key] = value.slice(0, 160);
    else if (typeof value === 'number' && Number.isFinite(value)) details[key] = value;
    else if (value === null || typeof value === 'boolean') details[key] = value;
  }
  if (event?.ammExecutionFees) {
    details.ammExecutionFees = {};
    for (const key of ['quoteAmountRaw', 'poolQuoteAmountRaw', 'userQuoteAmountRaw', 'lpFeeRaw',
      'protocolFeeRaw', 'coinCreatorFeeRaw', 'cashbackRaw', 'buybackRaw', 'ixName']) {
      const value = event.ammExecutionFees[key];
      if (typeof value === 'string') details.ammExecutionFees[key] = value.slice(0, 160);
    }
  }
  return details;
}

function extractProgramData(logMessages) {
  const stack = [];
  const rows = [];
  for (const line of logMessages || []) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (depth === 1) stack.length = 0;
      if (depth !== stack.length + 1) { stack.length = 0; continue; }
      stack.push(invoke[1]);
      continue;
    }
    const done = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed)/.exec(line);
    if (done) {
      const index = stack.lastIndexOf(done[1]);
      if (index >= 0) stack.splice(index);
      else stack.length = 0; // Broken/truncated ownership must not leak to later data.
      continue;
    }
    const data = /^Program data: ([A-Za-z0-9+/=]+)$/.exec(line);
    if (data) {
      rows.push({ programId: stack[stack.length - 1] || null, data: Buffer.from(data[1], 'base64') });
    }
  }
  return rows;
}

class PumpEventParser {
  constructor({ pumpProgramId, pumpAmmProgramId, wsolMint, onRejectedEvent } = {}) {
    this.pumpProgramId = pumpProgramId;
    this.pumpAmmProgramId = pumpAmmProgramId;
    this.wsolMint = wsolMint;
    this.onRejectedEvent = typeof onRejectedEvent === 'function' ? onRejectedEvent : null;
    this.stats = { acceptedEvents: 0, ignoredEvents: 0, rejectedEvents: 0,
      rejectionCallbackErrors: 0, rejectedByReason: {}, rejectedByProgram: {}, lastRejectedEvent: null };
  }

  getStats() {
    return { ...this.stats, rejectedByReason: { ...this.stats.rejectedByReason },
      rejectedByProgram: { ...this.stats.rejectedByProgram },
      lastRejectedEvent: this.stats.lastRejectedEvent && { ...this.stats.lastRejectedEvent,
        details: this.copyRejectionDetails(this.stats.lastRejectedEvent.details) } };
  }

  copyRejectionDetails(details) {
    return { ...details, ...(details.ammExecutionFees
      ? { ammExecutionFees: { ...details.ammExecutionFees } } : {}) };
  }

  recordRejectedEvent(row, error, event, context) {
    const reason = error instanceof EventValidationError ? error.reason : 'MALFORMED_EVENT';
    const record = { signature: context.signature, slot: context.slot, eventIndex: context.eventIndex,
      programId: row.programId, program: row.programId, reason,
      receivedAtMs: Number.isSafeInteger(context.receivedAt) ? context.receivedAt : null,
      dataLength: row.data.length, dataHash: createHash('sha256').update(row.data).digest('hex'),
      details: rejectionDetails(event, error) };
    this.stats.rejectedEvents += 1;
    this.stats.rejectedByReason[reason] = (this.stats.rejectedByReason[reason] || 0) + 1;
    const owner = !row.programId ? 'UNATTRIBUTED' : row.programId === this.pumpProgramId ? 'PUMP'
      : row.programId === this.pumpAmmProgramId ? 'PUMP_AMM' : 'OTHER';
    this.stats.rejectedByProgram[owner] = (this.stats.rejectedByProgram[owner] || 0) + 1;
    this.stats.lastRejectedEvent = record;
    if (!this.onRejectedEvent) return;
    try {
      const result = this.onRejectedEvent({ ...record, details: this.copyRejectionDetails(record.details) });
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => { this.stats.rejectionCallbackErrors += 1; });
      }
    } catch (_) {
      this.stats.rejectionCallbackErrors += 1;
    }
  }

  parseTransaction(txMessage, receivedAt = Date.now()) {
    const meta = extractMeta(txMessage);
    if (!meta || meta.err) return [];

    const signature = extractSignature(txMessage);
    const slot = extractSlot(txMessage);
    const candidateMint = extractCandidateMint(meta, this.wsolMint);
    const context = {
      pumpProgramId: this.pumpProgramId,
      pumpAmmProgramId: this.pumpAmmProgramId,
      candidateMint,
    };

    const events = [];
    const programData = extractProgramData(meta.logMessages || meta.log_messages || []);
    for (let eventIndex = 0; eventIndex < programData.length; eventIndex += 1) {
      const row = programData[eventIndex];
      let event;
      try {
        event = decodeEvent(row.data, row.programId, context);
        if (!event) { this.stats.ignoredEvents += 1; continue; }
        validateEvent(event, receivedAt);
        events.push({
          ...event,
          signature,
          slot,
          eventIndex,
          timestampMs: receivedAt,
          receivedAtMs: receivedAt,
          programId: row.programId,
        });
        this.stats.acceptedEvents += 1;
      } catch (error) {
        // Appended fields after a complete known layout remain compatible;
        // truncated/misaligned layouts and impossible states are quarantined.
        this.recordRejectedEvent(row, error, event, { signature, slot, eventIndex, receivedAt });
      }
    }
    return events;
  }
}

module.exports = {
  PumpEventParser,
  BorshReader,
  DISCRIMINATORS,
  deriveBondingCurve,
  extractSignature,
  extractProgramData,
  MAX_FUTURE_SKEW_MS,
  EARLIEST_CHAIN_TIMESTAMP_MS,
};
