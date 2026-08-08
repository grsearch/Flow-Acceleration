'use strict';

const assert = require('assert');
const { PumpEventParser, DISCRIMINATORS } = require('../src/core/PumpEventParser');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';

const pk = (seed) => Buffer.alloc(32, seed);
const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const i64 = (value) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; };
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
}, 123456)[0];
assert.strictEqual(trade.type, 'trade');
assert.strictEqual(trade.side, 'BUY');
assert.strictEqual(trade.solAmount, 2);
assert.strictEqual(trade.tokenAmount, 100);
assert.strictEqual(trade.price, 0.02);
assert.strictEqual(trade.timestampMs, 123456);
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
}, 123500)[0];
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
}, 124000)[0];
assert.strictEqual(complete.type, 'complete');
assert.strictEqual(complete.mint, trade.mint);

const ammBuyData = Buffer.concat([
  DISCRIMINATORS.ammBuy, i64(1_800_000_020), u64(50_000_000), u64(2_000_000_000),
  u64(0), u64(0), u64(500_000_000_000), u64(50_000_000_000), u64(1_000_000_000),
  u64(0), u64(0), u64(0), u64(0), u64(0), u64(0), pk(6), pk(2),
]);
const ammBuy = parser.parseTransaction({
  slot: 45,
  transaction: { signature: Buffer.alloc(64, 6) },
  meta: {
    err: null,
    preTokenBalances: [{ mint: trade.mint }, { mint: WSOL }],
    logMessages: logData(AMM, ammBuyData),
  },
}, 125000)[0];
assert.strictEqual(ammBuy.type, 'ammTrade');
assert.strictEqual(ammBuy.side, 'BUY');
assert.strictEqual(ammBuy.mint, trade.mint);
assert.strictEqual(ammBuy.solAmount, 1);
assert.strictEqual(ammBuy.tokenAmount, 50);

console.log('test-pump-event-parser: ok');
