'use strict';

const assert = require('assert');
const { PumpEventParser, DISCRIMINATORS, MAX_FUTURE_SKEW_MS } = require('../src/core/PumpEventParser');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';

const pk = (seed) => Buffer.alloc(32, seed);
const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const i64 = (value) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; };
const i128 = (value) => {
  const b = Buffer.alloc(16);
  const raw = BigInt(value);
  b.writeBigUInt64LE(raw & ((1n << 64n) - 1n), 0);
  b.writeBigInt64LE(raw >> 64n, 8);
  return b;
};
const str = (value) => { const body = Buffer.from(value); const size = Buffer.alloc(4); size.writeUInt32LE(body.length); return Buffer.concat([size, body]); };
const logData = (program, data) => [
  `Program ${program} invoke [1]`,
  `Program data: ${data.toString('base64')}`,
  `Program ${program} success`,
];

const parser = new PumpEventParser({ pumpProgramId: PUMP, pumpAmmProgramId: AMM, wsolMint: WSOL });

const tradeData = Buffer.concat([
  DISCRIMINATORS.pumpTrade,
  pk(1), u64(2_000_000_000), u64(100_000_000), Buffer.from([1]), pk(2), i64(1_800_000_000),
  u64(32_000_000_000), u64(800_000_000_000_000),
  u64(20_000_000_000), u64(500_000_000_000_000),
]);
const trade = parser.parseTransaction({
  slot: 42,
  transaction: { signature: Buffer.alloc(64, 9) },
  meta: { err: null, logMessages: logData(PUMP, tradeData) },
}, 1_800_000_000_456)[0];
assert.strictEqual(trade.type, 'trade');
assert.strictEqual(trade.side, 'BUY');
assert.strictEqual(trade.solAmount, 2);
assert.strictEqual(trade.tokenAmount, 100);
assert.strictEqual(trade.price, 0.02);
assert.strictEqual(trade.timestampMs, 1_800_000_000_456);
assert.strictEqual(trade.slot, 42);
assert.ok(trade.bondingCurve);

const createData = Buffer.concat([
  DISCRIMINATORS.pumpCreate,
  str('Flow Token'), str('FLOW'), str('https://example.invalid/meta.json'),
  pk(1), pk(3), pk(4), pk(5), i64(1_800_000_000),
  u64(1_000_000_000_000_000), u64(30_000_000_000),
  u64(793_100_000_000_000), u64(1_000_000_000_000_000),
]);
const create = parser.parseTransaction({
  slot: 43,
  transaction: { signature: Buffer.alloc(64, 8) },
  meta: { err: null, logMessages: logData(PUMP, createData) },
}, 1_800_000_000_500)[0];
assert.strictEqual(create.type, 'create');
assert.strictEqual(create.symbol, 'FLOW');
assert.strictEqual(create.initialRealTokenReservesRaw, '793100000000000');

const completeData = Buffer.concat([
  DISCRIMINATORS.pumpComplete, pk(4), pk(1), pk(3), i64(1_800_000_010),
]);
const complete = parser.parseTransaction({
  slot: 44,
  transaction: { signature: Buffer.alloc(64, 7) },
  meta: { err: null, logMessages: logData(PUMP, completeData) },
}, 1_800_000_010_000)[0];
assert.strictEqual(complete.type, 'complete');
assert.strictEqual(complete.mint, trade.mint);

// Mainnet MigrateV2 transaction 29QtMC...HXYdq (slot 443670052). The current
// event carries an appended field, so the parser must decode the documented
// prefix without requiring an exact payload length.
const migrationData = Buffer.from(
  'velduVyU6pTt/dS9z5GV1V2An/vwmiJT/SBGCX4TfaaTo5fq0YvldWkHDee3AXTVxLJ+nZKGupl2VTP3pCF1Plei8OeAmcKvAAgBqSy8AAAQ9tHJEwAAAMHh5AAAAAAAfkJSvdx/4k9PAlKvxW0ZVMqCKS9XHqufppaP6fo0D/GH9ZdqAAAAADoqx/A4CO6gYDJzNiY5gv65nicLfkcophw1WpEPpSpyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  'base64',
);
const migration = parser.parseTransaction({
  slot: 443670052,
  transaction: { signature: Buffer.alloc(64, 3) },
  meta: { err: null, logMessages: logData(PUMP, migrationData) },
}, 1788343687000)[0];
assert.strictEqual(migration.type, 'migration');
assert.strictEqual(migration.mint, '84z3jaJh5KbcpL2o3WjUoTLMVyRQS72dPKAfUxd3pump');
assert.strictEqual(migration.pool, '4v4UyAGCyLDqE6Us2PSrZbJjmZPBqEhjkJSQYYYKV12R');
assert.strictEqual(migration.migratedAt, 1788343687000);
assert.strictEqual(migration.solAmount, 84.990359056);

const ammBuyData = Buffer.concat([
  DISCRIMINATORS.ammBuy, i64(1_800_000_020), u64(50_000_000), u64(2_000_000_000),
  u64(0), u64(0), u64(500_000_000_000), u64(50_000_000_000), u64(1_000_000_000),
  u64(0), u64(0), u64(0), u64(0), u64(1_000_000_000), u64(1_000_000_000), pk(6), pk(2),
]);
const ammBuy = parser.parseTransaction({
  slot: 45,
  transaction: { signature: Buffer.alloc(64, 6) },
  meta: {
    err: null,
    preTokenBalances: [{ mint: trade.mint }, { mint: WSOL }],
    logMessages: logData(AMM, ammBuyData),
  },
}, 1_800_000_020_000)[0];
assert.strictEqual(ammBuy.type, 'ammTrade');
assert.strictEqual(ammBuy.side, 'BUY');
assert.strictEqual(ammBuy.mint, trade.mint);
assert.strictEqual(ammBuy.solAmount, 1);
assert.strictEqual(ammBuy.tokenAmount, 50);
assert.strictEqual(ammBuy.virtualQuoteReservesRaw, '0');
assert.strictEqual(ammBuy.ammQuoteState, 'POST_TRADE_V1');
assert.strictEqual(ammBuy.poolQuoteReservesRaw, '51000000000');

const boostedAmmBuyData = Buffer.concat([
  DISCRIMINATORS.ammBuy, i64(1_800_000_021), u64(50_000_000), u64(2_000_000_000),
  u64(0), u64(0), u64(500_000_000_000), u64(50_000_000_000), u64(1_000_000_000),
  u64(100), u64(10_000_000), u64(25), u64(2_500_000), u64(990_000_000),
  u64(1_002_500_000), pk(6), pk(2),
  pk(10), pk(11), pk(12), pk(13), pk(14), u64(50), u64(5_000_000),
  Buffer.from([1]), u64(0), u64(0), u64(1_000_000_000), i64(1_800_000_021),
  u64(45_000_000), str('buy_exact_quote_in'), u64(0), u64(0), u64(0), u64(0),
  i128(20_000_000_000), Buffer.from([1]),
]);
const boostedAmmBuy = parser.parseTransaction({
  slot: 46,
  transaction: { signature: Buffer.alloc(64, 5) },
  meta: {
    err: null,
    preTokenBalances: [{ mint: trade.mint }, { mint: WSOL }],
    logMessages: logData(AMM, boostedAmmBuyData),
  },
}, 1_800_000_021_000)[0];
assert.strictEqual(boostedAmmBuy.virtualQuoteReservesRaw, '20000000000');
assert.strictEqual(boostedAmmBuy.cashbackFeeBasisPoints, 0);
assert.strictEqual(boostedAmmBuy.cashbackRaw, '0');
assert.strictEqual(boostedAmmBuy.buybackFeeBasisPoints, 0);
assert.strictEqual(boostedAmmBuy.buybackRaw, '0');
assert.strictEqual(boostedAmmBuy.canBoost, true);
assert.ok(Math.abs(boostedAmmBuy.preReservePrice - 0.00014) < 1e-15);
assert.ok(Math.abs(boostedAmmBuy.reservePrice - 70.99 / 499950) < 1e-15);

const boostedAmmSellData = Buffer.concat([
  DISCRIMINATORS.ammSell, i64(1_800_000_022), u64(50_000_000), u64(500_000_000),
  u64(0), u64(0), u64(500_000_000_000), u64(50_000_000_000), u64(400_000_000),
  u64(100), u64(4_000_000), u64(25), u64(1_000_000), u64(405_000_000),
  u64(400_000_000), pk(6), pk(2),
  pk(10), pk(11), pk(12), pk(13), pk(14), u64(50), u64(2_000_000),
  u64(0), u64(0), u64(0), u64(0), i128(20_000_000_000), Buffer.from([1]),
]);
const boostedAmmSell = parser.parseTransaction({
  slot: 47,
  transaction: { signature: Buffer.alloc(64, 4) },
  meta: {
    err: null,
    preTokenBalances: [{ mint: trade.mint }, { mint: WSOL }],
    logMessages: logData(AMM, boostedAmmSellData),
  },
}, 1_800_000_022_000)[0];
assert.strictEqual(boostedAmmSell.side, 'SELL');
assert.strictEqual(boostedAmmSell.virtualQuoteReservesRaw, '20000000000');
assert.strictEqual(boostedAmmSell.cashbackFeeBasisPoints, 0);
assert.strictEqual(boostedAmmSell.cashbackRaw, '0');
assert.strictEqual(boostedAmmSell.buybackFeeBasisPoints, 0);
assert.strictEqual(boostedAmmSell.buybackRaw, '0');
assert.strictEqual(boostedAmmSell.canBoost, true);
assert.ok(Math.abs(boostedAmmSell.preReservePrice - 0.00014) < 1e-15);
assert.ok(Math.abs(boostedAmmSell.reservePrice - 69.595 / 500050) < 1e-15);

const rejected = [];
const guarded = new PumpEventParser({ pumpProgramId: PUMP, pumpAmmProgramId: AMM, wsolMint: WSOL,
  onRejectedEvent: (record) => rejected.push(record) });
const receiptAt = 1_800_000_023_456;
function txWith(logs) {
  return { slot: 48, transaction: { signature: Buffer.alloc(64, 3) },
    meta: { err: null, preTokenBalances: [{ mint: trade.mint }, { mint: WSOL }], logMessages: logs } };
}
function parseData(data, program = PUMP, at = receiptAt) {
  return guarded.parseTransaction(txWith(logData(program, data)), at);
}
function patched(data, offset, value, signed = false) {
  const copy = Buffer.from(data);
  if (signed) copy.writeBigInt64LE(BigInt(value), offset);
  else copy.writeBigUInt64LE(BigInt(value), offset);
  return copy;
}
function rejects(data, reason, program = PUMP, at = receiptAt) {
  const before = rejected.length;
  assert.deepStrictEqual(parseData(data, program, at), []);
  assert.strictEqual(rejected.length, before + 1);
  assert.strictEqual(rejected.at(-1).reason, reason);
  assert.strictEqual(rejected.at(-1).dataLength, data.length);
  assert.match(rejected.at(-1).dataHash, /^[0-9a-f]{64}$/);
  assert.strictEqual(rejected.at(-1).eventIndex, 0);
  assert.strictEqual(rejected.at(-1).programId, program);
}

// Correctly attributed discriminators only: same bytes from another program,
// including the other configured Pump family, must never become a trade.
for (const data of [tradeData, createData, completeData, migrationData]) {
  rejects(data, 'PROGRAM_MISMATCH', AMM);
}
for (const data of [ammBuyData, boostedAmmSellData]) rejects(data, 'PROGRAM_MISMATCH', PUMP);
rejects(tradeData, 'PROGRAM_MISMATCH', 'ComputeBudget111111111111111111111111111111');
assert.deepStrictEqual(guarded.parseTransaction(txWith([`Program data: ${tradeData.toString('base64')}`]), receiptAt), []);
assert.strictEqual(rejected.at(-1).reason, 'PROGRAM_MISMATCH');
assert.strictEqual(rejected.at(-1).programId, null);
const beforeUnrelated = rejected.length;
assert.deepStrictEqual(parseData(Buffer.alloc(32, 8), AMM), []);
assert.strictEqual(rejected.length, beforeUnrelated, 'unknown discriminator is counted, not quarantined');
assert.strictEqual(guarded.getStats().ignoredEvents, 1);

// A nested unrelated program cannot borrow its parent's Pump attribution; when
// the child returns, the genuine parent's following event still parses.
const nested = guarded.parseTransaction(txWith([
  `Program ${PUMP} invoke [1]`, `Program ${AMM} invoke [2]`,
  `Program data: ${tradeData.toString('base64')}`, `Program ${AMM} success`,
  `Program data: ${tradeData.toString('base64')}`, `Program ${PUMP} success`,
]), receiptAt);
assert.strictEqual(nested.length, 1);
assert.strictEqual(nested[0].eventIndex, 1);
assert.strictEqual(nested[0].programId, PUMP);
const brokenStack = guarded.parseTransaction(txWith([
  `Program ${PUMP} invoke [1]`, `Program ${AMM} invoke [1]`, `Program ${AMM} success`,
  `Program data: ${tradeData.toString('base64')}`,
]), receiptAt);
assert.deepStrictEqual(brokenStack, [], 'missing completion must not revive a stale parent owner');
assert.strictEqual(rejected.at(-1).programId, null);

// Reproduce the nine exported impossible timestamp magnitudes using synthetic
// wire seconds (the export stores rounded Numbers, not the original log bytes).
const impossibleSeconds = [
  '-4971973987791887000', '-1008806312739973800', '-4467570830349069500',
  '-648518346325032000', '6701356245528340000', '-5404319552839393000',
  '-72057594027903870', '-1657324662858064300', '-4611686018427175600',
];
for (const seconds of impossibleSeconds) {
  rejects(patched(tradeData, 89, seconds, true), 'INVALID_CHAIN_TIMESTAMP');
  assert.strictEqual(rejected.at(-1).details.chainTimestampSeconds, seconds);
  assert.strictEqual(rejected.at(-1).details.mint, trade.mint);
}
for (const seconds of [0n, 1n, 9_007_199_254_741n]) {
  rejects(patched(tradeData, 89, seconds, true), 'INVALID_CHAIN_TIMESTAMP');
}
for (const at of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
  rejects(tradeData, 'INVALID_RECEIVED_TIMESTAMP', PUMP, at);
}
const baseSeconds = 1_800_000_000;
assert.strictEqual(parseData(tradeData, PUMP, baseSeconds * 1000 - MAX_FUTURE_SKEW_MS).length, 1);
rejects(tradeData, 'CHAIN_TIMESTAMP_IN_FUTURE', PUMP, baseSeconds * 1000 - MAX_FUTURE_SKEW_MS - 1);
const historical = patched(tradeData, 89, 1_710_000_000, true);
assert.strictEqual(parseData(historical, PUMP, 1_710_000_000_999).length, 1, 'historical replay uses supplied receipt clock');
assert.strictEqual(parseData(historical, PUMP, receiptAt).length, 1, 'old valid history is not a parser freshness rejection');

rejects(tradeData.subarray(0, tradeData.length - 1), 'TRUNCATED_EVENT');
const invalidBool = Buffer.from(tradeData); invalidBool[56] = 2;
rejects(invalidBool, 'INVALID_BORSH_BOOL');
rejects(patched(tradeData, 40, 0), 'INVALID_TRADE_AMOUNT');
rejects(patched(tradeData, 48, 0), 'INVALID_TRADE_AMOUNT');
rejects(patched(tradeData, 97, 0), 'INVALID_CURVE_RESERVES');
rejects(patched(tradeData, 105, 0), 'INVALID_CURVE_RESERVES');
rejects(patched(tradeData, 113, 33_000_000_000), 'INVALID_CURVE_RESERVES');
rejects(patched(ammBuyData, 48, 49_000_000), 'INVALID_AMM_RESERVES', AMM);
rejects(patched(ammBuyData, 72, 10_001), 'INVALID_FEE_BASIS_POINTS', AMM);
rejects(boostedAmmBuyData.subarray(0, boostedAmmBuyData.length - 1), 'TRUNCATED_EVENT', AMM);
rejects(Buffer.concat([ammBuyData, Buffer.from([0])]), 'TRUNCATED_EVENT', AMM);

// No arbitrary SOL cap: very large but structurally consistent amounts remain
// available to downstream risk analysis rather than being silently filtered.
let largeTrade = patched(tradeData, 40, 793_100_000_000_000n);
largeTrade = patched(largeTrade, 97, 1_000_000_000_000_000n);
assert.strictEqual(parseData(largeTrade)[0].solAmount, 793100);
for (const [data, program] of [[tradeData, PUMP], [createData, PUMP], [completeData, PUMP],
  [migrationData, PUMP], [boostedAmmBuyData, AMM], [boostedAmmSellData, AMM]]) {
  assert.strictEqual(parseData(Buffer.concat([data, Buffer.from([7, 8, 9])]), program).length, 1,
    'unknown appended bytes after a complete known layout stay compatible');
}

// A failing audit sink must neither abort parsing nor lose subsequent valid
// events; published stats and callback objects cannot mutate parser state.
const failSink = new PumpEventParser({ pumpProgramId: PUMP, pumpAmmProgramId: AMM, wsolMint: WSOL,
  onRejectedEvent(record) { record.details.value = 'mutation'; throw new Error('sink failed'); } });
const continued = failSink.parseTransaction(txWith([
  ...logData(PUMP, invalidBool), ...logData(PUMP, tradeData),
]), receiptAt);
assert.strictEqual(continued.length, 1);
assert.strictEqual(continued[0].eventIndex, 1);
assert.strictEqual(failSink.getStats().rejectionCallbackErrors, 1);
assert.strictEqual(failSink.getStats().lastRejectedEvent.details.value, 2);
const stats = guarded.getStats(); stats.rejectedByReason.PROGRAM_MISMATCH = -1;
stats.lastRejectedEvent.details.mutated = true;
assert.ok(guarded.getStats().rejectedByReason.PROGRAM_MISMATCH > 0);
assert.strictEqual(guarded.getStats().lastRejectedEvent.details.mutated, undefined);

async function testAsyncAuditFailure() {
  const asyncSink = new PumpEventParser({ pumpProgramId: PUMP,
    onRejectedEvent: () => Promise.reject(new Error('async sink failed')) });
  assert.deepStrictEqual(asyncSink.parseTransaction(txWith(logData(PUMP, invalidBool)), receiptAt), []);
  await Promise.resolve();
  assert.strictEqual(asyncSink.getStats().rejectionCallbackErrors, 1);
  console.log('test-pump-event-parser: ok (owner attribution, 9 invalid times, wire sanity, replay, append, audit callback)');
}
testAsyncAuditFailure().catch((error) => { console.error(error); process.exitCode = 1; });
