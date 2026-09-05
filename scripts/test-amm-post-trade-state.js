'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PumpEventParser, BorshReader } = require('../src/core/PumpEventParser');
const { executableBuy, executableSell } = require('../src/core/ShadowExecutionModel');
const fixtures = require('./fixtures/amm-post-trade-receipts.json').fixtures;
const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';
const parser = new PumpEventParser({ pumpAmmProgramId: AMM, wsolMint: WSOL });
const idl = JSON.parse(fs.readFileSync(require.resolve('@pump-fun/pump-swap-sdk')
  .replace(/dist[\\/].*$/, 'src/idl/pump_amm.json'), 'utf8'));

function balance(accountIndex, mint, amount, pool) {
  return { accountIndex, mint, owner: pool,
    uiTokenAmount: { amount, decimals: mint === WSOL ? 9 : 6 } };
}

function parse(fixture, buffers = [Buffer.from(fixture.programDataBase64, 'base64')], final = fixture) {
  return parser.parseTransaction({
    slot: fixture.slot,
    transaction: { signatures: [fixture.signature] },
    meta: {
      err: null,
      logMessages: [`Program ${AMM} invoke [1]`,
        ...buffers.map((buffer) => `Program data: ${buffer.toString('base64')}`),
        `Program ${AMM} success`],
      preTokenBalances: [balance(0, fixture.mint, fixture.prePoolBaseReservesRaw, fixture.pool),
        balance(1, WSOL, fixture.prePoolQuoteReservesRaw, fixture.pool)],
      postTokenBalances: [balance(0, fixture.mint, final.postPoolBaseReservesRaw, fixture.pool),
        balance(1, WSOL, final.postPoolQuoteReservesRaw, fixture.pool)],
    },
  }, 1_788_600_000_000);
}

function reservePrice(base, quote, virtual) {
  return ((Number(quote) + Number(virtual)) / 1e9) / (Number(base) / 1e6);
}

function expectedFees(fixture) {
  const f = fixture.knownFields, buy = fixture.side === 'BUY';
  return {
    quoteAmountRaw: buy ? f.quote_amount_in : f.quote_amount_out,
    poolQuoteAmountRaw: buy ? f.quote_amount_in_with_lp_fee : f.quote_amount_out_without_lp_fee,
    userQuoteAmountRaw: buy ? f.user_quote_amount_in : f.user_quote_amount_out,
    lpFeeBasisPoints: Number(f.lp_fee_basis_points), lpFeeRaw: f.lp_fee,
    protocolFeeBasisPoints: Number(f.protocol_fee_basis_points), protocolFeeRaw: f.protocol_fee,
    coinCreatorFeeBasisPoints: Number(f.coin_creator_fee_basis_points), coinCreatorFeeRaw: f.coin_creator_fee,
    cashbackFeeBasisPoints: Number(f.cashback_fee_basis_points), cashbackRaw: f.cashback,
    buybackFeeBasisPoints: Number(f.buyback_fee_basis_points), buybackRaw: f.buyback_fee,
    ixName: buy ? f.ix_name : 'sell',
  };
}

function assertPostState(event, fixture) {
  assert.equal(event.ammQuoteState, 'POST_TRADE_V1');
  assert.equal(event.market, 'PUMP_AMM');
  assert.equal(event.side, fixture.side);
  assert.equal(event.mint, fixture.mint);
  assert.equal(event.pool, fixture.pool);
  assert.equal(event.prePoolBaseReservesRaw, fixture.prePoolBaseReservesRaw);
  assert.equal(event.prePoolQuoteReservesRaw, fixture.prePoolQuoteReservesRaw);
  assert.equal(event.poolBaseReservesRaw, fixture.postPoolBaseReservesRaw);
  assert.equal(event.poolQuoteReservesRaw, fixture.postPoolQuoteReservesRaw);
  assert.equal(event.virtualQuoteReservesRaw, fixture.virtualQuoteReservesRaw);
  assert.equal(event.preReservePrice, reservePrice(fixture.prePoolBaseReservesRaw,
    fixture.prePoolQuoteReservesRaw, fixture.virtualQuoteReservesRaw));
  assert.equal(event.reservePrice, reservePrice(fixture.postPoolBaseReservesRaw,
    fixture.postPoolQuoteReservesRaw, fixture.virtualQuoteReservesRaw));
  assert.deepEqual(event.ammExecutionFees, expectedFees(fixture));
  for (const name of ['cashbackFeeBasisPoints', 'cashbackRaw', 'buybackFeeBasisPoints', 'buybackRaw']) {
    assert.equal(event[name], expectedFees(fixture)[name], `preserve existing top-level ${name}`);
  }
  assert.equal(event.canBoost, fixture.knownFields.can_boost);
}

function fieldOffset(fixture, fieldName) {
  const reader = new BorshReader(Buffer.from(fixture.programDataBase64, 'base64'), 8);
  const type = idl.types.find((entry) => entry.name === (fixture.side === 'BUY' ? 'BuyEvent' : 'SellEvent'));
  for (const field of type.type.fields) {
    if (field.name === fieldName) return reader.offset;
    reader[field.type]();
  }
  throw new Error(`missing fixture field ${fieldName}`);
}

function patchedU64(fixture, values) {
  const buffer = Buffer.from(fixture.programDataBase64, 'base64');
  for (const [name, value] of Object.entries(values)) buffer.writeBigUInt64LE(BigInt(value), fieldOffset(fixture, name));
  return buffer;
}

function patchedVirtual(fixture, value) {
  const buffer = Buffer.from(fixture.programDataBase64, 'base64');
  const offset = fieldOffset(fixture, 'virtual_quote_reserves');
  buffer.writeBigUInt64LE(value & ((1n << 64n) - 1n), offset);
  buffer.writeBigInt64LE(value >> 64n, offset + 8);
  return buffer;
}

function testRealChainReceipts() {
  assert.equal(fixtures.length, 14);
  assert.equal(fixtures.filter((row) => row.side === 'BUY').length, 11);
  assert.equal(fixtures.filter((row) => row.side === 'SELL').length, 3);
  for (const fixture of fixtures) {
    const events = parse(fixture);
    assert.equal(events.length, 1, fixture.source);
    assertPostState(events[0], fixture);
    assert.equal(events[0].signature, fixture.signature);
    const fees = expectedFees(fixture);
    const direction = fixture.side === 'BUY' ? 1n : -1n;
    assert.equal(BigInt(fixture.postPoolQuoteReservesRaw) - BigInt(fixture.prePoolQuoteReservesRaw),
      direction * BigInt(fees.poolQuoteAmountRaw), 'chain pool delta must use the LP-adjusted field');
    assert.equal(BigInt(fixture.prePoolBaseReservesRaw) - BigInt(fixture.postPoolBaseReservesRaw),
      direction * BigInt(fixture.baseAmountRaw));
  }
  const exact = fixtures.find((row) => row.source === 'ho500_buy72_chain_receipt.json');
  const baseOut = fixtures.find((row) => row.source === 'ho500_trigger89_chain_receipt.json');
  assert.equal(exact.knownFields.ix_name, 'buy_exact_quote_in');
  assert.equal(exact.knownFields.quote_amount_in, '100000000');
  assert.equal(exact.knownFields.user_quote_amount_in, '98814227');
  assert.equal(exact.knownFields.quote_amount_in_with_lp_fee, '99011856');
  assert.equal(baseOut.knownFields.ix_name, 'buy');
  assert.equal(baseOut.knownFields.quote_amount_in, '495811526');
  assert.equal(baseOut.knownFields.user_quote_amount_in, '502009172');
  assert.equal(baseOut.knownFields.quote_amount_in_with_lp_fee, '495910689');
}

function testTwoSwapsUseIndividualEventState() {
  const first = fixtures.find((row) => row.source === 'ho500_trigger74_chain_receipt.json');
  const second = { ...first,
    prePoolBaseReservesRaw: first.postPoolBaseReservesRaw,
    prePoolQuoteReservesRaw: first.postPoolQuoteReservesRaw,
    postPoolBaseReservesRaw: String(BigInt(first.postPoolBaseReservesRaw) - BigInt(first.baseAmountRaw)),
    postPoolQuoteReservesRaw: String(BigInt(first.postPoolQuoteReservesRaw)
      + BigInt(first.knownFields.quote_amount_in_with_lp_fee)),
  };
  const secondBuffer = patchedU64(first, {
    pool_base_token_reserves: second.prePoolBaseReservesRaw,
    pool_quote_token_reserves: second.prePoolQuoteReservesRaw,
  });
  const events = parse(first, [Buffer.from(first.programDataBase64, 'base64'), secondBuffer], second);
  assert.equal(events.length, 2);
  assertPostState(events[0], first);
  assertPostState(events[1], second);
  assert.notEqual(events[0].poolBaseReservesRaw, events[1].poolBaseReservesRaw,
    'the first event cannot be overwritten with the whole transaction final balance');
  assert.equal(events[0].eventIndex, 0);
  assert.equal(events[1].eventIndex, 1);
}

function testNegativeVirtualQuote() {
  const source = fixtures.find((row) => row.source === 'ho500_trigger74_chain_receipt.json');
  const virtual = -2_000_000_000n;
  const expected = { ...source, virtualQuoteReservesRaw: String(virtual) };
  const events = parse(source, [patchedVirtual(source, virtual)]);
  assert.equal(events.length, 1);
  assertPostState(events[0], expected);
  assert.ok(events[0].reservePrice < reservePrice(source.postPoolBaseReservesRaw,
    source.postPoolQuoteReservesRaw, 0), 'signed virtual adjustment cannot be ignored');
}

function assertInvalid(fixture, buffer) {
  const events = parse(fixture, [buffer]);
  assert.equal(events.length, 1, 'well-formed but impossible reserve state remains an explicitly invalid observation');
  const event = events[0];
  assert.equal(event.ammQuoteState, 'INVALID');
  assert.equal(event.poolBaseReservesRaw, null);
  assert.equal(event.poolQuoteReservesRaw, null);
  assert.equal(event.reservePrice, null);
  assert.ok(event.price > 0, 'keep the event price for diagnostics, not executable fallback');
  assert.equal(executableBuy(event, 0.1, event.price).available, false);
  assert.equal(executableSell(event, 100, event.price).available, false);
}

function testMalformedAndImpossibleStatesFailClosed() {
  const buy = fixtures.find((row) => row.source === 'ho500_trigger74_chain_receipt.json');
  const sell = fixtures.find((row) => row.side === 'SELL');
  assertInvalid(buy, patchedU64(buy, { pool_base_token_reserves: BigInt(buy.baseAmountRaw) - 1n }));
  assertInvalid(sell, patchedU64(sell, {
    pool_quote_token_reserves: BigInt(sell.knownFields.quote_amount_out_without_lp_fee) - 1n,
  }));
  assertInvalid(buy, patchedVirtual(buy, -BigInt(buy.postPoolQuoteReservesRaw)));
  assertInvalid(buy, patchedU64(buy, { pool_quote_token_reserves: (1n << 64n) - 1n }));
  assertInvalid(sell, patchedU64(sell, { pool_base_token_reserves: (1n << 64n) - 1n }));
  assert.deepEqual(parse(buy, [Buffer.from(buy.programDataBase64, 'base64').subarray(0, 110)]), [],
    'truncated mandatory quote data cannot fall back to old/pre-trade reserves');
}

testRealChainReceipts();
testTwoSwapsUseIndividualEventState();
testNegativeVirtualQuote();
testMalformedAndImpossibleStatesFailClosed();
console.log('test-amm-post-trade-state: ok (14 real receipts, fee modes, per-event state, signed virtual, fail-closed)');
