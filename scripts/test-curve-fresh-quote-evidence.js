'use strict';

const assert = require('assert');
const BN = require('bn.js');
const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { bondingCurvePda } = require('@pump-fun/pump-sdk');
const { PumpTradeExecutor } = require('../src/core/PumpTradeExecutor');

// Exercise the real offline SDK arithmetic, but instantiate no connection,
// keypair or signer. Stop at instruction construction, before any submission.
async function captureQuote(options = {}) {
  const mint = PublicKey.unique();
  const executor = Object.create(PumpTradeExecutor.prototype);
  const counts = { state: 0, protocol: 0, balance: 0, blockhash: 0, instructions: 0, send: 0 };
  const curve = {
    complete: options.complete === true,
    virtualTokenReserves: new BN('1000000000000000'),
    virtualQuoteReserves: new BN('30000000000'),
    realTokenReserves: new BN('700000000000000'),
    realQuoteReserves: new BN('5000000000'),
    tokenTotalSupply: new BN('1000000000000000'),
    creator: PublicKey.unique(), isMayhemMode: false,
    // Conflicting legacy aliases prove the SDK v2 quote fields take priority.
    ...(options.legacyAliases ? { virtualSolReserves: new BN('1'), realSolReserves: new BN('2') } : {}),
  };
  executor.config = { buySlippagePct: 2, minWalletReserveSol: 0 };
  executor.readCommitment = 'processed';
  executor.confirmationCommitment = 'confirmed';
  executor.signer = { publicKey: PublicKey.unique() };
  executor._buyStateAtSignalSlot = async (key, slot) => {
    counts.state += 1;
    assert.ok(key.equals(mint));
    assert.strictEqual(slot, 123_456);
    return { tokenProgram: TOKEN_PROGRAM_ID, balanceBefore: 0n, bondingCurve: curve,
      contextSlot: 123_460, contextRetries: 1, contextReads: 2, contextRpcSource: 'MOCK_ONLY',
      bondingCurveAccountInfo: {}, associatedUserAccountInfo: null };
  };
  executor._protocolState = async () => {
    counts.protocol += 1;
    return { global: { feeBasisPoints: new BN(100), creatorFeeBasisPoints: new BN(20) }, feeConfig: null };
  };
  executor.connection = {
    async getLatestBlockhashAndContext(config) {
      counts.blockhash += 1;
      assert.deepStrictEqual(config, { commitment: 'processed' });
      return { context: { slot: 123_462 }, value: { blockhash: 'never-submitted', lastValidBlockHeight: 1 } };
    },
    async getBalanceAndContext() {
      counts.balance += 1;
      return { context: { slot: 123_461 }, value: 1_000_000_000 };
    },
  };
  executor.pump = { async buyV2Instructions(args) {
    counts.instructions += 1;
    assert.ok(args.bondingCurve === curve);
    const error = new Error('Mock capture: never build/sign/send a transaction');
    error.code = 'MOCK_QUOTE_CAPTURE';
    throw error;
  } };
  executor._send = async () => {
    counts.send += 1;
    throw new Error('TEST MUST NEVER SIGN, SUBMIT OR USE NETWORK');
  };
  const args = { mint: mint.toBase58(), solAmount: 0.02, referencePrice: options.referencePrice ?? 2.5e-8,
    maxPriceJumpPct: options.maxPriceJumpPct ?? -1, signalSlot: 123_456 };
  if (Object.hasOwn(options, 'maxSelfImpactPct')) args.maxSelfImpactPct = options.maxSelfImpactPct;
  let error;
  try { await executor.buy(args); } catch (caught) { error = caught; }
  assert.ok(error, 'the mock must always halt before transaction construction');
  assert.strictEqual(counts.send, 0);
  assert.strictEqual(counts.state, 1);
  assert.strictEqual(counts.protocol, 1);
  assert.strictEqual(counts.balance, 1);
  assert.strictEqual(counts.blockhash, 1);
  return { error, execution: error.execution, counts, mint };
}

async function main() {
  const result = await captureQuote();
  assert.strictEqual(result.error.code, 'MOCK_QUOTE_CAPTURE', 'omitted cap must remain disabled');
  const audit = result.execution;
  assert.deepStrictEqual(audit.curveQuoteState, {
    virtualTokenReserves: '1000000000000000', virtualSolReserves: '30000000000',
    realTokenReserves: '700000000000000', realSolReserves: '5000000000',
    tokenTotalSupply: '1000000000000000',
  });
  assert.strictEqual(audit.bondingCurve, bondingCurvePda(result.mint).toBase58());
  assert.strictEqual(audit.freshCurveMidPrice, 30 / 1_000_000_000);
  assert.strictEqual(audit.rpcContextSlot, 123_460);
  assert.strictEqual(audit.slotLag, 4);
  assert.strictEqual(audit.contextRpcSource, 'MOCK_ONLY');
  assert.deepStrictEqual(audit.rpcSlots, { minimumContextSlot: 123_456,
    quoteContextSlot: 123_460, walletContextSlot: 123_461, blockhashContextSlot: 123_462 });
  assert.strictEqual(audit.contextRetries, 1);
  assert.strictEqual(audit.contextReads, 2);
  assert.strictEqual(audit.spendableQuoteRaw, '20000000');
  // Independently reproduce SDK v2's fee-inclusive exact-input integer quote.
  const netInput = (20_000_000n - 1n) * 10_000n / 10_120n;
  const tokenRaw = netInput * 1_000_000_000_000_000n / (30_000_000_000n + netInput);
  const expectedPrice = 0.02 / (Number(tokenRaw) / 1e6);
  assert.strictEqual(audit.quotedTokenRaw, tokenRaw.toString());
  assert.strictEqual(audit.quotedPrice, expectedPrice);
  assert.strictEqual(audit.freshQuotePremiumPct, (expectedPrice / audit.freshCurveMidPrice - 1) * 100);
  assert.ok(audit.freshQuotePremiumPct > 1.2, 'premium includes the 1.2% fees plus pool impact');
  assert.strictEqual(audit.sourceToFreshMarketPct, (audit.freshCurveMidPrice / 2.5e-8 - 1) * 100);
  assert.strictEqual(audit.quotePremiumScope, 'CURVE_QUOTE_INCLUDES_PROTOCOL_FEES_AND_IMPACT');
  assert.ok(Number.isFinite(audit.timelineMs.state_and_blockhash_ready_ms));
  assert.ok(Number.isFinite(audit.timelineMs.total_ms));
  assert.strictEqual((await captureQuote({ legacyAliases: true })).execution.freshCurveMidPrice,
    audit.freshCurveMidPrice, 'canonical SDK quote reserves override legacy alias values');

  for (const cap of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const disabled = await captureQuote({ maxSelfImpactPct: cap });
    assert.strictEqual(disabled.error.code, 'MOCK_QUOTE_CAPTURE', `disabled cap ${String(cap)}`);
    assert.strictEqual(disabled.counts.instructions, 1);
  }
  for (const cap of [0, audit.freshQuotePremiumPct - 0.000001]) {
    const rejected = await captureQuote({ maxSelfImpactPct: cap });
    assert.strictEqual(rejected.error.code, 'ENTRY_SELF_IMPACT');
    assert.strictEqual(rejected.counts.instructions, 0, 'guard must precede instruction creation');
    assert.strictEqual(rejected.execution.freshQuotePremiumPct, audit.freshQuotePremiumPct);
    assert.deepStrictEqual(rejected.execution.curveQuoteState, audit.curveQuoteState);
  }
  for (const cap of [audit.freshQuotePremiumPct, audit.freshQuotePremiumPct + 1]) {
    assert.strictEqual((await captureQuote({ maxSelfImpactPct: cap })).error.code, 'MOCK_QUOTE_CAPTURE',
      'equal-to-cap passes: reject only when premium exceeds cap');
  }
  const sourceMoved = await captureQuote({ referencePrice: 1e-8, maxSelfImpactPct: 10 });
  assert.strictEqual(sourceMoved.error.code, 'MOCK_QUOTE_CAPTURE');
  assert.strictEqual(sourceMoved.execution.freshQuotePremiumPct, audit.freshQuotePremiumPct,
    'source drift must not be mislabeled self-impact');
  assert.strictEqual(sourceMoved.execution.sourceToFreshMarketPct, (audit.freshCurveMidPrice / 1e-8 - 1) * 100);
  const jump = await captureQuote({ referencePrice: 1e-8, maxPriceJumpPct: 15, maxSelfImpactPct: 10 });
  assert.strictEqual(jump.error.code, 'PRICE_JUMP', 'legacy source-to-quote jump guard stays separate');
  assert.strictEqual(jump.counts.instructions, 0);
  assert.strictEqual(jump.execution.freshQuotePremiumPct, audit.freshQuotePremiumPct);
  const complete = await captureQuote({ complete: true });
  assert.strictEqual(complete.error.code, 'CURVE_COMPLETE');
  assert.deepStrictEqual(complete.execution.curveQuoteState, audit.curveQuoteState,
    'fresh raw quote evidence is retained on a completed-curve rejection');
  console.log('Curve fresh RPC quote evidence and optional premium guard (mock only): PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
