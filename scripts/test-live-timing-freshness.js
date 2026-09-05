'use strict';

const assert = require('assert');
const BN = require('bn.js');
const { PublicKey } = require('@solana/web3.js');
const { ResearchStore } = require('../src/data/ResearchStore');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const { PumpTradeExecutor, walletSolSettlementFromTransaction } = require('../src/core/PumpTradeExecutor');

async function main() {
  let now = 1_788_547_965_805;
  const strategy = {
    id: 'timing-regression', enabled: true, entryEnabled: true,
    signalSource: 'EXTERNAL', market: 'PUMP_AMM', positionSizeSol: 0.1,
    maxSignalAgeMs: 1500, requireChainTimestamp: true, requireEntrySlot: true,
    maxEntriesPerMint: 20, maxEntryPriceJumpPct: 15, maxEntrySelfImpactPct: 10,
    exitMode: 'LEGACY', fastTakeProfitPct: 18, fastTakeProfitWindowMs: 5000,
    hardStopPct: 20, trailingActivationPct: 8, trailingStopPct: 3,
    lossCheckAtMs: 6000, maxHoldMs: 15000,
  };
  const config = { enabled: true, dryRun: false, strategies: [strategy],
    maxConcurrentPositions: 10, maxConcurrentPositionsPerMint: 3,
    maxSignalAgeMs: 1500, maxPositionTradeAgeMs: 3000,
    maxHoldMs: 15000, exitRetryCount: 0, exitRetryDelayMs: 0,
    mintCooldownMs: 0, failedEntryCooldownMs: 0, maxFailedEntriesPerMint: 20 };
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.',
    rawRetentionHours: 24, flushMs: 60000, flushMax: 100 }, { configuredTradingCostPct: 0 });
  const manager = new LiveTradingManager({ config, store, now: () => now });
  const signal = { strategyId: strategy.id, mint: 'timing-mint', episodeId: 'timing:1',
    price: 1, timestampMs: now, receivedAtMs: now, chainTimestampMs: now - 500, slot: 444318072,
    market: 'PUMP_AMM', features: {} };
  assert.strictEqual(manager._riskReason(signal), null);
  assert.strictEqual(manager._riskReason({ ...signal, chainTimestampMs: now - 16381 }),
    'STALE_SIGNAL_CHAIN_TIME', 'position 62 source was old despite just being received');
  assert.strictEqual(manager._riskReason({ ...signal, chainTimestampMs: now - 21394 }),
    'STALE_SIGNAL_CHAIN_TIME', 'position 66 source must not pass receive-age checks');
  assert.strictEqual(manager._riskReason({ ...signal, chainTimestampMs: null }), 'SIGNAL_CHAIN_TIME_MISSING');
  assert.strictEqual(manager._riskReason({ ...signal, slot: null }), 'SIGNAL_SLOT_MISSING');

  const position = { id: 1, mint: 'timing-mint', status: 'OPEN', mode: 'LIVE', strategy,
    strategyId: strategy.id, entryMarket: 'PUMP_AMM', entrySlot: 444318125,
    entryPrice: 1, highestPrice: 1, positionSol: 0.1, tokenAmountRaw: '100000', openedAt: now - 5 };
  const trade = { mint: position.mint, market: 'PUMP_AMM', price: 2.27,
    timestampMs: now, receivedAtMs: now, chainTimestampMs: now - 500, slot: 444318072 };
  assert.strictEqual(manager._positionTradeRejection(position, trade), 'PRE_ENTRY_SLOT');
  assert.strictEqual(manager._positionTradeRejection(position, { ...trade, slot: 444318125 }), 'PRE_ENTRY_SLOT');
  assert.strictEqual(manager._positionTradeRejection(position, { ...trade,
    slot: 444318126, chainTimestampMs: now - 17805 }), 'STALE_POSITION_CHAIN_TIME');
  assert.strictEqual(manager._positionTradeRejection(position, { ...trade,
    slot: 444318126, market: 'PUMP_BONDING_CURVE' }), 'POSITION_MARKET_MISMATCH');
  assert.strictEqual(manager._positionTradeRejection({ ...position, lastAcceptedSlot: 444318128 },
    { ...trade, slot: 444318127 }), 'OUT_OF_ORDER_SLOT');
  assert.strictEqual(manager._positionTradeRejection(position, { ...trade, slot: 444318126 }), null);
  assert.strictEqual(manager._positionTradeRejection({ ...position, entrySlot: null },
    { ...trade, slot: 444318126 }), 'ENTRY_SLOT_UNAVAILABLE');
  assert.strictEqual(manager._positionTradeRejection({ ...position, entryPool: 'canonical' },
    { ...trade, pool: 'other-pool', slot: 444318126 }), 'POSITION_POOL_MISMATCH');
  assert.strictEqual(manager._positionTradeRejection({ ...position,
    strategy: { ...strategy, requireSignalPool: true } },
  { ...trade, slot: 444318126 }), 'POSITION_POOL_MISSING');

  const settlement = walletSolSettlementFromTransaction({ slot: 444318125,
    transaction: { message: { accountKeys: ['owner'] } },
    meta: { preBalances: [1_000_000_000], postBalances: [897607766], fee: 505000 } }, 'owner');
  assert.strictEqual(settlement.transactionSlot, 444318125);

  // A new slot that arrives before confirmation must be evaluated once the receipt opens the lot.
  store.recordCreate({ mint: signal.mint, createdAt: now - 100000, symbol: 'TIMING',
    name: null, uri: null, bondingCurve: null, creator: null,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null });
  store.recordComplete({ mint: signal.mint, completedAt: now - 50000 });
  let resolveBuy;
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  let sellArgs;
  const executor = {
    buyAmm() { resolveStarted(); return new Promise((resolve) => { resolveBuy = resolve; }); },
    async sell(args) {
      sellArgs = args;
      return { signature: 'confirmed-sell', venue: 'PUMP_AMM', tokenAmountRaw: args.tokenAmountRaw,
        balanceVerified: true, remainingTokenAmountRaw: '0',
        settlement: { walletSolDelta: 0.06, networkFeeSol: 0.002005, transactionSlot: 444318128 } };
    },
  };
  const opening = new LiveTradingManager({ config, store, executor, now: () => now });
  opening.onExternalStrategySignal({ ...signal, episodeId: 'confirm-crash' });
  await started;
  now += 300;
  opening.observeTrade({ ...trade, price: 0.6, slot: 444318126,
    timestampMs: now, receivedAtMs: now, chainTimestampMs: now - 500 });
  now += 100;
  resolveBuy({ signature: 'confirmed-buy', venue: 'PUMP_AMM', tokenAmountRaw: '100000',
    expectedPrice: 1, execution: { entrySlot: 444318125, settlement } });
  await opening.entryQueue;
  await Promise.allSettled([...opening.pending]);
  assert.strictEqual(sellArgs.emergency, true, 'a crash during buy confirmation must not wait for another tick');
  const closed = store.liveTradingDashboard({ strategyId: strategy.id }).positions[0];
  assert.strictEqual(closed.status, 'CLOSED');
  assert.strictEqual(closed.exit_reason, 'HARD_STOP');
  const entryOrder = store.latestLiveOrderForPositionSide(closed.id, 'BUY');
  assert.strictEqual(JSON.parse(entryOrder.execution_json).entrySlot, 444318125,
    'the actual fill slot must be durable across restart');
  const sellOrder = store.latestLiveOrderForPositionSide(closed.id, 'SELL');
  const exitExecution = JSON.parse(sellOrder.execution_json);
  assert.strictEqual(exitExecution.manager.trigger.slot, 444318126);
  assert(exitExecution.manager.queueDelayMs >= 0);
  await opening.stop();

  const simulated = new LiveTradingManager({ config: { ...config, dryRun: true }, store, now: () => now });
  simulated.onExternalStrategySignal({ ...signal, timestampMs: now, receivedAtMs: now,
    chainTimestampMs: now - 500, episodeId: 'dry-run-slot', slot: 200 });
  await simulated.entryQueue;
  const simulatedPosition = [...simulated.positions.values()][0];
  assert.strictEqual(simulatedPosition.entrySlot, 200, 'dry-run needs an explicit simulated execution fence');
  now += 100;
  simulated.observeTrade({ ...trade, price: 0.6, slot: 201, timestampMs: now,
    receivedAtMs: now, chainTimestampMs: now - 500 });
  await Promise.allSettled([...simulated.pending]);
  assert.strictEqual(simulatedPosition.status, 'CLOSED', 'strict dry-run must still execute market stops');
  await simulated.stop();

  // Same live RPC quote, fees and transaction min-output: mark profit is insufficient.
  const quoteExecutor = Object.create(PumpTradeExecutor.prototype);
  quoteExecutor.config = { computeUnitLimit: 250000 };
  const mintKey = new PublicKey('So11111111111111111111111111111111111111112');
  const poolKey = quoteExecutor._assertSignalPool(mintKey, null);
  assert.strictEqual(quoteExecutor._assertSignalPool(mintKey, poolKey.toBase58()).toBase58(), poolKey.toBase58());
  assert.throws(() => quoteExecutor._assertSignalPool(mintKey, 'other-pool'),
    (error) => error.code === 'SIGNAL_POOL_MISMATCH');
  quoteExecutor.connection = { async getSignatureStatuses() {
    return { context: { slot: 999 }, value: [{ confirmationStatus: 'confirmed', slot: 123, err: null }] };
  } };
  assert.strictEqual(await quoteExecutor._entrySlotFromReceipt('buy', { settlement: null }), 123,
    'status.slot recovers the actual buy slot while transaction metadata is still unavailable');
  let submitted = false;
  const downMoveExecutor = Object.create(PumpTradeExecutor.prototype);
  downMoveExecutor.config = { minWalletReserveSol: 0, buySlippagePct: 10 };
  downMoveExecutor.signer = { publicKey: mintKey };
  downMoveExecutor._tokenProgram = async () => PublicKey.default;
  downMoveExecutor._tokenBalanceRaw = async () => 0n;
  downMoveExecutor._send = async () => { submitted = true; throw new Error('must never send'); };
  downMoveExecutor.connection = { getBalance: async () => 1_000_000_000,
    getLatestBlockhash: async () => ({ blockhash: 'unused' }) };
  downMoveExecutor.onlineAmm = { swapSolanaState: async () => ({
    baseMint: mintKey, baseMintAccount: { decimals: 6, supply: 1_000_000_000_000_000n },
    pool: { quoteMint: mintKey, virtualQuoteReserves: new BN('20000000000'),
      coinCreator: PublicKey.default, creator: PublicKey.default },
    poolBaseAmount: new BN('100000000000000'), poolQuoteAmount: new BN('30000000000'),
    globalConfig: { lpFeeBasisPoints: new BN(20), protocolFeeBasisPoints: new BN(5),
      coinCreatorFeeBasisPoints: new BN(0) }, feeConfig: null,
  }) };
  await assert.rejects(downMoveExecutor.buyAmm({ mint: mintKey.toBase58(), solAmount: 0.1,
    maxPriceJumpPct: 15, maxSelfImpactPct: 10, signalPool: poolKey.toBase58(),
    signalPoolBaseReservesRaw: '100000000000000', signalPoolQuoteReservesRaw: '50000000000',
    signalVirtualQuoteReservesRaw: '20000000000' }),
  (error) => error.code === 'MARKET_PRICE_MOVED' && error.execution.marketMovePct < -15);
  assert.strictEqual(submitted, false, 'fresh RPC price far below the signal must not place a buy');
  const audit = { priorityFeeMicroLamports: 2000000 };
  const floor = 0.102392234 * 1.18;
  assert.throws(() => quoteExecutor._minimumTakeProfitQuote(new BN('60687378'), floor, audit),
    (error) => error.code === 'TAKE_PROFIT_NET_PROCEEDS_REJECTED'
      && error.execution.quotedNetProceedsSol < floor);
  const minOutput = quoteExecutor._minimumTakeProfitQuote(new BN('130000000'), floor, audit);
  assert(BigInt(minOutput.toString()) >= BigInt(Math.ceil(floor * 1e9)) + 505000n);
  assert.throws(() => quoteExecutor._checkSignalFreshness({ signalChainTimestampMs: Date.now() - 21000,
    maxSignalAgeMs: 1500 }), (error) => error.code === 'STALE_SIGNAL_CHAIN_TIME');
  quoteExecutor._checkSignalFreshness({ signalChainTimestampMs: Date.now() - 500, maxSignalAgeMs: 1500 });

  // A rejected quote returns to OPEN and leaves the max-hold protection armed.
  const openRow = store.createLivePosition({ strategyId: strategy.id, sourceType: strategy.id,
    mint: 'quote-mint', mode: 'LIVE', status: 'OPEN', positionSol: 0.1,
    entryMarket: 'PUMP_AMM', entryPrice: 1 });
  Object.assign(openRow, { strategy, status: 'OPEN', tokenAmountRaw: '100000', openedAt: now,
    entryWalletCostSol: 0.102392234, entryWalletCostVerified: true, entrySlot: 10 });
  store.updateLivePosition(openRow.id, { openedAt: now, tokenAmountRaw: '100000' });
  store.recordLiveOrder({ positionId: openRow.id, strategyId: strategy.id, mint: openRow.mint,
    side: 'BUY', venue: 'PUMP_AMM', attempt: 1, requestedSol: 0.1,
    requestedTokenRaw: '100000', status: 'CONFIRMED', signature: 'restart-slot-buy',
    walletSolDelta: -0.102392234, networkFeeSol: 0.000505,
    execution: { entrySlot: 10, pool: poolKey.toBase58() }, submittedAt: now, confirmedAt: now });
  store.refreshLivePositionSettlement(openRow.id);
  const restored = new LiveTradingManager({ config, store, now: () => now });
  restored.start();
  assert.strictEqual(restored.positions.get(openRow.id).entrySlot, 10);
  assert.strictEqual(restored.positions.get(openRow.id).entryPool, poolKey.toBase58());
  await restored.stop();
  const quoteManager = new LiveTradingManager({ config, store, now: () => now, executor: {
    async sell(args) {
      assert.strictEqual(args.expectedMarket, 'PUMP_AMM');
      assert.strictEqual(args.minimumNetProceedsSol, floor);
      const error = new Error('net proceeds below required floor');
      error.code = 'TAKE_PROFIT_NET_PROCEEDS_REJECTED'; error.execution = audit; throw error;
    },
  } });
  quoteManager._addPosition(openRow);
  quoteManager._requestExit(openRow, 'FAST_TAKE_PROFIT', 2.27);
  await Promise.allSettled([...quoteManager.pending]);
  assert.strictEqual(openRow.status, 'OPEN');
  assert.strictEqual(quoteManager.metrics.takeProfitQuoteRejected, 1);
  assert.strictEqual(quoteManager.metrics.exitFailures, 0);
  assert(quoteManager.timers.has(openRow.id));
  await quoteManager.stop();
  await manager.stop();
  store.close();
  console.log('test-live-timing-freshness: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
