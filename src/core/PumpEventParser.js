'use strict';

const bs58Module = require('bs58');
const { PublicKey } = require('@solana/web3.js');

const bs58 = bs58Module.default || bs58Module;

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
      throw new RangeError(`borsh buffer ended at ${this.offset}; need ${size} bytes`);
    }
  }

  u8() {
    this.require(1);
    return this.buffer[this.offset++];
  }

  bool() {
    return this.u8() !== 0;
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

  pubkey() {
    this.require(32);
    const value = bs58.encode(this.buffer.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return value;
  }

  string() {
    const length = this.u32();
    if (length > 1_048_576) throw new RangeError(`borsh string is too large: ${length}`);
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

function timestampMs(seconds) {
  const value = numberOf(seconds);
  return value == null ? null : value * 1_000;
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
  const chainTimestampMs = timestampMs(reader.i64());
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
  const createdAt = timestampMs(reader.i64());
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
  reader.u64(); // lp_fee_basis_points
  reader.u64(); // lp_fee
  reader.u64(); // protocol_fee_basis_points
  reader.u64(); // protocol_fee
  reader.u64(); // quote_amount_in_with_lp_fee
  reader.u64(); // user_quote_amount_in
  const pool = reader.pubkey();
  const wallet = reader.pubkey();
  const tokenAmount = numberOf(baseAmountRaw) / 1e6;
  const solAmount = numberOf(quoteAmountRaw) / 1e9;
  const poolBaseTokens = numberOf(poolBaseReservesRaw) / 1e6;
  const poolQuoteSol = numberOf(poolQuoteReservesRaw) / 1e9;
  const reservePrice = poolBaseTokens > 0 ? poolQuoteSol / poolBaseTokens : null;

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
    reservePrice: Number.isFinite(reservePrice) && reservePrice > 0 ? reservePrice : null,
    chainTimestampMs,
    poolBaseReservesRaw: poolBaseReservesRaw.toString(),
    poolQuoteReservesRaw: poolQuoteReservesRaw.toString(),
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
  reader.u64(); // lp_fee_basis_points
  reader.u64(); // lp_fee
  reader.u64(); // protocol_fee_basis_points
  reader.u64(); // protocol_fee
  reader.u64(); // quote_amount_out_without_lp_fee
  reader.u64(); // user_quote_amount_out
  const pool = reader.pubkey();
  const wallet = reader.pubkey();
  const tokenAmount = numberOf(baseAmountRaw) / 1e6;
  const solAmount = numberOf(quoteAmountRaw) / 1e9;
  const poolBaseTokens = numberOf(poolBaseReservesRaw) / 1e6;
  const poolQuoteSol = numberOf(poolQuoteReservesRaw) / 1e9;
  const reservePrice = poolBaseTokens > 0 ? poolQuoteSol / poolBaseTokens : null;

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
    reservePrice: Number.isFinite(reservePrice) && reservePrice > 0 ? reservePrice : null,
    chainTimestampMs,
    poolBaseReservesRaw: poolBaseReservesRaw.toString(),
    poolQuoteReservesRaw: poolQuoteReservesRaw.toString(),
  };
}

function decodeEvent(data, currentProgram, context) {
  if (matches(data, DISCRIMINATORS.pumpTrade)) return decodePumpTrade(data, context);
  if (matches(data, DISCRIMINATORS.pumpCreate)) return decodePumpCreate(data);
  if (matches(data, DISCRIMINATORS.pumpComplete)) return decodePumpComplete(data);
  if (matches(data, DISCRIMINATORS.pumpMigration)) return decodePumpMigration(data);
  if (matches(data, DISCRIMINATORS.ammBuy)) return decodeAmmBuy(data, context);
  if (matches(data, DISCRIMINATORS.ammSell)) return decodeAmmSell(data, context);
  return null;
}

function extractProgramData(logMessages) {
  const stack = [];
  const rows = [];
  for (const line of logMessages || []) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    const done = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed)/.exec(line);
    if (done) {
      const index = stack.lastIndexOf(done[1]);
      if (index >= 0) stack.splice(index);
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
  constructor({ pumpProgramId, pumpAmmProgramId, wsolMint }) {
    this.pumpProgramId = pumpProgramId;
    this.pumpAmmProgramId = pumpAmmProgramId;
    this.wsolMint = wsolMint;
  }

  parseTransaction(txMessage, receivedAt = Date.now()) {
    const meta = extractMeta(txMessage);
    if (!meta || meta.err) return [];

    const signature = extractSignature(txMessage);
    const slot = extractSlot(txMessage);
    const candidateMint = extractCandidateMint(meta, this.wsolMint);
    const context = {
      pumpProgramId: this.pumpProgramId,
      candidateMint,
    };

    const events = [];
    const programData = extractProgramData(meta.logMessages || meta.log_messages || []);
    for (let eventIndex = 0; eventIndex < programData.length; eventIndex += 1) {
      const row = programData[eventIndex];
      try {
        const event = decodeEvent(row.data, row.programId, context);
        if (!event) continue;
        events.push({
          ...event,
          signature,
          slot,
          eventIndex,
          timestampMs: receivedAt,
          receivedAtMs: receivedAt,
          programId: row.programId,
        });
      } catch (_) {
        // A program upgrade can append fields, but the documented prefix stays
        // decodable. Malformed or unrelated Program data is ignored safely.
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
};

