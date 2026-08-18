'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { PublicKey, TransactionInstruction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { PUMP_PROGRAM_ID } = require('@pump-fun/pump-sdk');
const BN = require('bn.js');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const {
  PumpTradeExecutor,
  classifyBuyReconciliation,
  confirmedTransactionFailure,
  exactQuoteInInstructionData,
  minimumTokensOut,
  replaceBuyV2WithExactQuoteIn,
} = require('../src/core/PumpTradeExecutor');
const { evaluatePrimarySignal, REJECT } = require('../src/core/PrimarySignalStrategy');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 1.4 });
}

function testLegacyLiveSchemaMigration() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-live-migration-'));
  const dbPath = path.join(tempDir, 'legacy.db');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE live_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      trigger_wallet TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      position_sol REAL NOT NULL,
      token_amount_raw TEXT,
      entry_market TEXT,
      entry_price REAL,
      entry_signature TEXT,
      entry_error TEXT,
      highest_price REAL,
      exit_market TEXT,
      exit_price REAL,
      exit_signature TEXT,
      exit_reason TEXT,
      exit_error TEXT,
      opened_at INTEGER,
      exit_requested_at INTEGER,
      closed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE live_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      decision_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      venue TEXT,
      attempt INTEGER NOT NULL,
      requested_sol REAL,
      requested_token_raw TEXT,
      status TEXT NOT NULL,
      signature TEXT,
      error TEXT,
      execution_json TEXT,
      submitted_at INTEGER,
      confirmed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  legacy.close();

  const migrated = new ResearchStore({
    dbPath, archiveDir: tempDir, rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 1.4 });
  const positionColumns = new Map(
    migrated.db.prepare('PRAGMA table_info(live_positions)').all()
      .map((column) => [column.name, column]),
  );
  const orderColumns = new Map(
    migrated.db.prepare('PRAGMA table_info(live_orders)').all()
      .map((column) => [column.name, column]),
  );
  assert.strictEqual(positionColumns.get('decision_id').notnull, 0);
  assert.strictEqual(positionColumns.get('trigger_wallet').notnull, 0);
  assert.ok(positionColumns.has('primary_decision_id'));
  assert.ok(positionColumns.has('signal_id'));
  assert.ok(orderColumns.has('primary_decision_id'));
  migrated.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function managerConfig(overrides = {}) {
  return {
    enabled: true,
    dryRun: false,
    signalVariant: 'primary_early_5_4',
    minNetFlowW3Sol: 5,
    minUniqueBuyersW3: 4,
    maxSignalAgeMs: 1_500,
    positionSizeSol: 0.05,
    maxConcurrentPositions: 1,
    minWalletReserveSol: 0.05,
    mintCooldownMs: 600_000,
    maxEntryPriceJumpPct: 10,
    buySlippagePct: 10,
    sellSlippagePct: 15,
    computeUnitLimit: 250_000,
    priorityFeeMicroLamports: 20_000,
    readCommitment: 'processed',
    confirmationCommitment: 'confirmed',
    contextSlotRetryCount: 2,
    contextSlotRetryDelayMs: 25,
    commitment: 'confirmed',
    trailingStopPct: 7.5,
    maxHoldMs: 60_000,
    exitRetryCount: 1,
    exitRetryDelayMs: 1,
    entryReconcileCount: 1,
    entryReconcileDelayMs: 1,
    killSwitchFile: '',
    ...overrides,
  };
}

function primarySignal(store, {
  mint = 'primary-mint', timestampMs, price = 0.01, netFlowW3 = 5,
  uniqueBuyersW3 = 4, signalVariant = 'primary_early_5_4', isPrimary = false,
}) {
  return store.recordSignal({
    timestampMs,
    slot: 1,
    signature: `${mint}-${timestampMs}`,
    mint,
    symbol: mint,
    curvePct: 50,
    ageMs: 10_000,
    price,
    buyFlowW1: 1,
    buyFlowW2: 5,
    buyFlowW3: Math.max(5, netFlowW3),
    sellFlowW1: 0,
    sellFlowW2: 0,
    sellFlowW3: 0,
    netFlowW1: 1,
    netFlowW2: 5,
    netFlowW3,
    deltaNetFlow12: 4,
    deltaNetFlow23: 5,
    uniqueBuyersW1: 2,
    uniqueBuyersW2: 5,
    uniqueBuyersW3,
    buyTxW1: 2,
    buyTxW2: 6,
    buyTxW3: 15,
    flowAccel1: 5,
    flowAccel2: 2,
    flowAccel: 2,
    signalVariant,
    isPrimary,
  });
}

async function main() {
  testLegacyLiveSchemaMigration();
  const exactInputData = exactQuoteInInstructionData(50_000_000n, 900_000n);
  assert.strictEqual(exactInputData.length, 24);
  assert.deepStrictEqual([...exactInputData.subarray(0, 8)], [194, 171, 28, 70, 104, 77, 91, 47]);
  assert.strictEqual(exactInputData.readBigUInt64LE(8), 50_000_000n);
  assert.strictEqual(exactInputData.readBigUInt64LE(16), 900_000n);
  assert.strictEqual(minimumTokensOut('1000000', 10).toString(), '900000');
  assert.strictEqual(minimumTokensOut('1000000', 12.34).toString(), '876600');
  const originalKey = PublicKey.unique();
  const setupInstruction = new TransactionInstruction({
    programId: PublicKey.unique(),
    keys: [],
    data: Buffer.from([1]),
  });
  const templateInstruction = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [{ pubkey: originalKey, isSigner: true, isWritable: true }],
    data: Buffer.from([2]),
  });
  const replacedInstructions = replaceBuyV2WithExactQuoteIn(
    [setupInstruction, templateInstruction],
    50_000_000n,
    900_000n,
  );
  assert.strictEqual(replacedInstructions[0], setupInstruction);
  assert.ok(replacedInstructions[1].programId.equals(PUMP_PROGRAM_ID));
  assert.ok(replacedInstructions[1].keys[0].pubkey.equals(originalKey));
  assert.deepStrictEqual(replacedInstructions[1].data, exactInputData);

  const stateExecutor = Object.create(PumpTradeExecutor.prototype);
  const stateMint = PublicKey.unique();
  const stateSigner = PublicKey.unique();
  const stateMintInfo = { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82) };
  const stateCurveInfo = { owner: PUMP_PROGRAM_ID, data: Buffer.from([1]) };
  const stateAtaData = Buffer.alloc(165);
  stateAtaData.writeBigUInt64LE(42n, 64);
  const stateAtaInfo = { owner: TOKEN_PROGRAM_ID, data: stateAtaData };
  let stateReadConfig = null;
  let stateReadCalls = 0;
  stateExecutor.signer = { publicKey: stateSigner };
  stateExecutor.readCommitment = 'processed';
  stateExecutor.config = { contextSlotRetryCount: 1, contextSlotRetryDelayMs: 0 };
  stateExecutor.tokenPrograms = new Map();
  stateExecutor.pump = {
    decodeBondingCurve(accountInfo) {
      assert.strictEqual(accountInfo, stateCurveInfo);
      return { complete: false };
    },
  };
  stateExecutor.connection = {
    async getMultipleAccountsInfoAndContext(keys, config) {
      assert.strictEqual(keys.length, 4);
      assert.ok(keys[0].equals(stateMint));
      stateReadConfig = config;
      stateReadCalls += 1;
      if (stateReadCalls === 1) {
        const error = new Error('Minimum context slot has not been reached');
        error.code = -32016;
        throw error;
      }
      return {
        context: { slot: 123_460 },
        value: [stateMintInfo, stateCurveInfo, stateAtaInfo, null],
      };
    },
  };
  const synchronizedState = await stateExecutor._buyStateAtSignalSlot(stateMint, 123_456);
  assert.deepStrictEqual(stateReadConfig, {
    commitment: 'processed',
    minContextSlot: 123_456,
  });
  assert.strictEqual(synchronizedState.contextSlot, 123_460);
  assert.strictEqual(synchronizedState.contextRetries, 1);
  assert.strictEqual(synchronizedState.contextReads, 2);
  assert.strictEqual(synchronizedState.contextRpcSource, 'PRIMARY');
  assert.strictEqual(stateReadCalls, 2);
  assert.ok(synchronizedState.tokenProgram.equals(TOKEN_PROGRAM_ID));
  assert.strictEqual(synchronizedState.balanceBefore, 42n);
  stateExecutor.config.contextSlotRetryCount = 0;
  stateExecutor.connection.getMultipleAccountsInfoAndContext = async () => {
    const error = new Error('Minimum context slot has not been reached');
    error.code = -32016;
    throw error;
  };
  await assert.rejects(
    stateExecutor._buyStateAtSignalSlot(stateMint, 123_500),
    (error) => error.code === 'RPC_CONTEXT_BEHIND' && error.contextRetries === 0,
  );
  let fallbackReads = 0;
  stateExecutor.contextFallbackConnection = {
    async getMultipleAccountsInfoAndContext() {
      fallbackReads += 1;
      return {
        context: { slot: 123_501 },
        value: [stateMintInfo, stateCurveInfo, stateAtaInfo, null],
      };
    },
  };
  const fallbackState = await stateExecutor._buyStateAtSignalSlot(stateMint, 123_500);
  assert.strictEqual(fallbackState.contextRpcSource, 'FALLBACK');
  assert.strictEqual(fallbackState.contextReads, 2);
  assert.strictEqual(fallbackReads, 1);

  const sellExecutor = Object.create(PumpTradeExecutor.prototype);
  const sellMint = PublicKey.unique();
  const sellCurve = {
    complete: false,
    tokenTotalSupply: new BN('1000000000000000'),
    virtualTokenReserves: new BN('1000000000000'),
    virtualQuoteReserves: new BN('100000000000'),
    creator: PublicKey.unique(),
    isMayhemMode: false,
  };
  let sellBalanceReads = 0;
  let instructionSellRaw = null;
  sellExecutor.config = { sellSlippagePct: 15 };
  sellExecutor.confirmationCommitment = 'confirmed';
  sellExecutor.signer = { publicKey: PublicKey.unique() };
  sellExecutor._tokenProgram = async () => TOKEN_PROGRAM_ID;
  sellExecutor._tokenBalanceSnapshot = async (mint, tokenProgram, commitment) => {
    assert.ok(mint.equals(sellMint));
    assert.ok(tokenProgram.equals(TOKEN_PROGRAM_ID));
    sellBalanceReads += 1;
    if (sellBalanceReads === 1) return { amount: 1_005_000n, observed: true };
    assert.strictEqual(commitment, 'confirmed');
    return { amount: 0n, observed: true };
  };
  sellExecutor._protocolState = async () => ({
    global: { feeBasisPoints: new BN(0), creatorFeeBasisPoints: new BN(0) },
    feeConfig: null,
  });
  sellExecutor.onlinePump = {
    async fetchSellState() {
      return { bondingCurve: sellCurve, bondingCurveAccountInfo: {} };
    },
  };
  sellExecutor.pump = {
    async sellV2Instructions({ amount }) {
      instructionSellRaw = amount.toString();
      return [];
    },
  };
  sellExecutor._send = async () => 'sell-all-signature';
  const sellAll = await sellExecutor.sell({
    mint: sellMint.toBase58(),
  });
  assert.strictEqual(instructionSellRaw, '1005000',
    'sell must use the complete live wallet balance, not the stale entry amount');
  assert.strictEqual(sellAll.tokenAmountRaw, '1005000');
  assert.strictEqual(sellAll.remainingTokenAmountRaw, '0');
  assert.strictEqual(sellAll.balanceVerified, true);

  const confirmedFailure = confirmedTransactionFailure(
    'failed-chain-signature',
    { InstructionError: [3, { Custom: 6002 }] },
  );
  assert.strictEqual(confirmedFailure.code, 'TRANSACTION_FAILED');
  assert.strictEqual(confirmedFailure.signature, 'failed-chain-signature');
  assert.strictEqual(confirmedFailure.transactionFailed, true);
  assert.strictEqual(classifyBuyReconciliation({
    err: { InstructionError: [3, { Custom: 6002 }] },
    confirmationStatus: 'confirmed',
  }, 0n).state, 'FAILED');
  assert.strictEqual(classifyBuyReconciliation({
    err: null,
    confirmationStatus: 'confirmed',
  }, 500n).state, 'CONFIRMED');
  assert.strictEqual(classifyBuyReconciliation({
    err: null,
    confirmationStatus: 'finalized',
  }, 0n).state, 'UNKNOWN');
  assert.strictEqual(classifyBuyReconciliation(null, 0n).state, 'UNKNOWN');

  const exact = evaluatePrimarySignal({
    isPrimary: false,
    signalVariant: 'primary_early_5_4',
    netFlowW3: 5,
    uniqueBuyersW3: 4,
    price: 1,
    timestampMs: 10_000,
    createdAt: 10_000,
  }, managerConfig(), 10_100);
  assert.strictEqual(exact.matched, true);
  const rejected = evaluatePrimarySignal({
    isPrimary: false,
    signalVariant: 'two_window',
    netFlowW3: 4.9,
    uniqueBuyersW3: 3,
    price: 0,
    timestampMs: 1,
    createdAt: 1,
  }, managerConfig(), 10_000);
  assert.ok(rejected.rejectReasons.includes(REJECT.NOT_PRIMARY));
  assert.ok(rejected.rejectReasons.includes(REJECT.WRONG_VARIANT));
  assert.ok(rejected.rejectReasons.includes(REJECT.NETFLOW_W3_BELOW_MIN));
  assert.ok(rejected.rejectReasons.includes(REJECT.BUYERS_W3_BELOW_MIN));
  assert.ok(rejected.rejectReasons.includes(REJECT.INVALID_PRICE));
  assert.ok(rejected.rejectReasons.includes(REJECT.STALE_SIGNAL));

  const store = makeStore();
  let now = 10_000;
  const calls = { buy: 0, buyRequest: null, sell: 0, sellRequests: [] };
  const executor = {
    async buy(request) {
      calls.buy += 1;
      calls.buyRequest = request;
      return {
        signature: 'live-buy-signature', venue: 'PUMP_BONDING_CURVE',
        tokenAmountRaw: '5000000', expectedPrice: 0.01,
        execution: {
          version: 1,
          buyMode: 'EXACT_QUOTE_IN_V2_FIXED_SOL',
          timelineMs: { submitted_ms: 12, confirmed_ms: 24 },
        },
      };
    },
    async sell(request) {
      calls.sell += 1;
      calls.sellRequests.push(request);
      if (calls.sell === 1) {
        return {
          signature: 'live-sell-partial-signature', venue: 'PUMP_BONDING_CURVE',
          tokenAmountRaw: '5000000', remainingTokenAmountRaw: '1000', balanceVerified: true,
        };
      }
      return {
        signature: 'live-sell-signature', venue: 'PUMP_BONDING_CURVE',
        tokenAmountRaw: '1000', remainingTokenAmountRaw: '0', balanceVerified: true,
      };
    },
  };
  const manager = new LiveTradingManager({
    config: managerConfig(), store, executor, now: () => now,
  });
  manager.start();
  const open = primarySignal(store, { timestampMs: now });
  manager.onSignal(open);
  await manager.entryQueue;
  assert.strictEqual(calls.buy, 1);
  assert.strictEqual(calls.buyRequest.signalSlot, 1);
  assert.strictEqual(store.activeLivePositions().length, 1);
  assert.strictEqual(
    store.db.prepare('SELECT action_status FROM primary_live_decisions').get().action_status,
    'OPEN',
  );

  now = 10_050;
  manager.observeTrade({
    mint: 'primary-mint', market: 'PUMP_BONDING_CURVE', price: 0.012, timestampMs: now,
  });
  await Promise.allSettled([...manager.pending]);
  assert.strictEqual(calls.sell, 0, 'a new high must not trigger an exit');
  assert.strictEqual(store.activeLivePositions().length, 1);

  now = 10_100;
  manager.observeTrade({
    mint: 'primary-mint', market: 'PUMP_BONDING_CURVE', price: 0.0115, timestampMs: now,
  });
  await Promise.allSettled([...manager.pending]);
  assert.strictEqual(calls.sell, 0, 'a drawdown below 7.5% must not trigger an exit');

  now = 10_200;
  manager.observeTrade({
    mint: 'primary-mint', market: 'PUMP_BONDING_CURVE', price: 0.011, timestampMs: now,
  });
  await Promise.allSettled([...manager.pending]);
  assert.strictEqual(calls.sell, 2, 'a confirmed residual balance must be sold by the retry');
  assert.deepStrictEqual(calls.sellRequests, [
    { mint: 'primary-mint' },
    { mint: 'primary-mint' },
  ]);
  assert.strictEqual(store.activeLivePositions().length, 0);
  assert.strictEqual(
    store.db.prepare('SELECT status FROM live_positions').get().status,
    'CLOSED',
  );
  const repeated = primarySignal(store, { timestampMs: 10_300 });
  manager.onSignal(repeated);
  await manager.entryQueue;
  assert.strictEqual(calls.buy, 1, 'one Primary episode must create at most one live decision');
  assert.strictEqual(
    store.db.prepare('SELECT COUNT(*) AS n FROM primary_live_decisions').get().n,
    1,
  );
  const dashboard = store.liveTradingDashboard();
  assert.strictEqual(dashboard.stats.decisions, 1);
  assert.strictEqual(dashboard.stats.matched, 1);
  assert.strictEqual(dashboard.stats.positions, 1);
  assert.strictEqual(dashboard.stats.closed_positions, 1);
  assert.strictEqual(dashboard.stats.confirmed_orders, 3);
  assert.strictEqual(dashboard.positions[0].status, 'CLOSED');
  assert.strictEqual(dashboard.orders.length, 3);
  const dashboardSells = dashboard.orders.filter((order) => order.side === 'SELL');
  assert.deepStrictEqual(
    dashboardSells.map((order) => order.status).sort(),
    ['CONFIRMED', 'CONFIRMED_PARTIAL'],
  );
  assert.deepStrictEqual(
    dashboardSells.map((order) => order.requested_token_raw).sort(),
    ['1000', '5000000'],
  );
  const dashboardBuy = dashboard.orders.find((order) => order.side === 'BUY');
  assert.strictEqual(dashboardBuy.execution.buyMode, 'EXACT_QUOTE_IN_V2_FIXED_SOL');
  assert.strictEqual(dashboardBuy.execution.timelineMs.submitted_ms, 12);
  assert.strictEqual(dashboardBuy.execution.manager.triggerType, 'PRIMARY_THRESHOLD');
  assert.strictEqual(dashboardBuy.execution.manager.signalId, open.signalId);
  assert.ok(Number.isFinite(dashboardBuy.execution.manager.eventToEntryStartMs));
  assert.ok(Array.isArray(dashboard.decisions[0].rejection_reasons));
  const health = manager.health();
  assert.strictEqual(health.strategy.ruleVersion, 'primary-early-threshold-v2');
  assert.strictEqual(health.strategy.entry.signalVariant, 'primary_early_5_4');
  assert.strictEqual(health.strategy.entry.minNetFlowW3Sol, 5);
  assert.strictEqual(health.strategy.entry.minUniqueBuyersW3, 4);
  assert.strictEqual(health.strategy.exit.maxHoldMs, 60_000);
  assert.strictEqual(health.strategy.exit.policy, 'PRIMARY_IMMEDIATE_TRAILING');
  assert.strictEqual(health.strategy.exit.trailingActivationPct, 0);
  assert.strictEqual(health.strategy.exit.trailingStopPct, 7.5);
  assert.strictEqual(health.strategy.risk.positionSizeSol, 0.05);
  assert.strictEqual(health.strategy.risk.maxDailySpendSol, undefined);
  assert.strictEqual(health.strategy.execution.buySlippagePct, 10);
  assert.strictEqual(health.strategy.execution.sellSlippagePct, 15);
  assert.strictEqual(health.strategy.execution.buyMode, 'EXACT_QUOTE_IN_V2_FIXED_SOL');
  assert.strictEqual(health.strategy.execution.hardSpendCap, true);
  assert.strictEqual(health.strategy.execution.readCommitment, 'processed');
  assert.strictEqual(health.strategy.execution.preflightCommitment, 'processed');
  assert.strictEqual(health.strategy.execution.confirmationCommitment, 'confirmed');
  assert.strictEqual(health.strategy.execution.contextSlotRetryCount, 2);
  assert.strictEqual(health.strategy.execution.contextSlotRetryDelayMs, 25);

  await manager.stop();
  store.close();

  const latencyStore = makeStore();
  let latencyNow = 15_000;
  let resolveDelayedBuy;
  let latencySellCalls = 0;
  const delayedBuy = new Promise((resolve) => { resolveDelayedBuy = resolve; });
  const latencyManager = new LiveTradingManager({
    config: managerConfig(),
    store: latencyStore,
    now: () => latencyNow,
    executor: {
      async buy() { return delayedBuy; },
      async sell() {
        latencySellCalls += 1;
        return {
          signature: 'latency-sell-signature',
          venue: 'PUMP_BONDING_CURVE',
          tokenAmountRaw: '5000000',
        };
      },
    },
  });
  latencyManager.start();
  latencyManager.onSignal(primarySignal(latencyStore, {
    mint: 'latency-mint', timestampMs: latencyNow,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  latencyNow = 15_050;
  latencyManager.observeTrade({
    mint: 'latency-mint', market: 'PUMP_BONDING_CURVE', price: 0.012,
    timestampMs: latencyNow,
  });
  latencyNow = 15_100;
  latencyManager.observeTrade({
    mint: 'latency-mint', market: 'PUMP_BONDING_CURVE', price: 0.011,
    timestampMs: latencyNow,
  });
  resolveDelayedBuy({
    signature: 'latency-buy-signature',
    venue: 'PUMP_BONDING_CURVE',
    tokenAmountRaw: '5000000',
    expectedPrice: 0.01,
  });
  await latencyManager.entryQueue;
  await Promise.allSettled([...latencyManager.pending]);
  assert.strictEqual(latencySellCalls, 0,
    'prices observed before the confirmed fill must not become the live trailing peak');
  latencyNow = 15_150;
  latencyManager.observeTrade({
    mint: 'latency-mint', market: 'PUMP_BONDING_CURVE', price: 0.012,
    timestampMs: latencyNow,
  });
  latencyNow = 15_200;
  latencyManager.observeTrade({
    mint: 'latency-mint', market: 'PUMP_BONDING_CURVE', price: 0.011,
    timestampMs: latencyNow,
  });
  await Promise.allSettled([...latencyManager.pending]);
  assert.strictEqual(latencySellCalls, 1, 'post-fill peak drawdown must still trigger the exit');
  await latencyManager.stop();
  latencyStore.close();

  const failedStore = makeStore();
  let failedNow = 20_000;
  let failedSellCalls = 0;
  const failedManager = new LiveTradingManager({
    config: managerConfig(),
    store: failedStore,
    now: () => failedNow,
    executor: {
      async buy() {
        const error = confirmedTransactionFailure(
          'too-much-sol-signature',
          { InstructionError: [3, { Custom: 6002 }] },
        );
        error.execution = {
          version: 1,
          buyMode: 'EXACT_QUOTE_IN_V2_FIXED_SOL',
          timelineMs: { submitted_ms: 10, total_ms: 15 },
        };
        throw error;
      },
      async sell() { failedSellCalls += 1; },
      async reconcileBuy() { throw new Error('deterministic failure must not be reconciled'); },
    },
  });
  failedManager.start();
  const failedOpen = primarySignal(failedStore, {
    mint: 'failed-primary-mint', timestampMs: failedNow,
  });
  failedManager.onSignal(failedOpen);
  await failedManager.entryQueue;
  const failedPosition = failedStore.db.prepare('SELECT * FROM live_positions').get();
  const failedOrder = failedStore.db.prepare('SELECT * FROM live_orders').get();
  assert.strictEqual(failedPosition.status, 'ENTRY_FAILED');
  assert.strictEqual(failedPosition.exit_reason, 'ENTRY_TRANSACTION_FAILED');
  assert.strictEqual(failedOrder.status, 'FAILED');
  assert.strictEqual(failedOrder.signature, 'too-much-sol-signature');
  assert.strictEqual(
    JSON.parse(failedOrder.execution_json).buyMode,
    'EXACT_QUOTE_IN_V2_FIXED_SOL',
  );
  assert.strictEqual(failedSellCalls, 0, 'confirmed chain failure must never trigger a sell');
  assert.strictEqual(failedStore.activeLivePositions().length, 0);
  await failedManager.stop();
  failedStore.close();

  const unknownStore = makeStore();
  let unknownNow = 30_000;
  let unknownSellCalls = 0;
  const unknownManager = new LiveTradingManager({
    config: managerConfig(),
    store: unknownStore,
    now: () => unknownNow,
    executor: {
      async buy() {
        const error = new Error('RPC confirmation timed out');
        error.signature = 'unknown-buy-signature';
        throw error;
      },
      async reconcileBuy() { return { state: 'UNKNOWN', tokenAmountRaw: '0' }; },
      async sell() { unknownSellCalls += 1; },
    },
  });
  unknownManager.start();
  const unknownOpen = primarySignal(unknownStore, {
    mint: 'unknown-primary-mint', timestampMs: unknownNow,
  });
  unknownManager.onSignal(unknownOpen);
  await unknownManager.entryQueue;
  assert.strictEqual(
    unknownStore.db.prepare('SELECT status FROM live_positions').get().status,
    'EXIT_FAILED',
  );
  assert.strictEqual(
    unknownStore.db.prepare('SELECT COUNT(*) AS n FROM live_orders').get().n,
    1,
    'unknown entry must not generate blind sell orders',
  );
  assert.strictEqual(unknownSellCalls, 0);
  await unknownManager.stop();

  unknownNow = 31_000;
  const recoveryManager = new LiveTradingManager({
    config: managerConfig(),
    store: unknownStore,
    now: () => unknownNow,
    executor: {
      async reconcileBuy() {
        return { state: 'FAILED', error: 'Transaction failed on chain: Custom 6002' };
      },
      async sell() { unknownSellCalls += 1; },
    },
  });
  recoveryManager.start();
  await Promise.allSettled([...recoveryManager.pending]);
  assert.strictEqual(
    unknownStore.db.prepare('SELECT status FROM live_positions').get().status,
    'ENTRY_FAILED',
    'restart recovery should release a known-failed entry',
  );
  assert.strictEqual(unknownStore.db.prepare('SELECT status FROM live_orders').get().status, 'FAILED');
  assert.strictEqual(unknownSellCalls, 0);
  assert.strictEqual(unknownStore.activeLivePositions().length, 0);
  await recoveryManager.stop();
  unknownStore.close();

  console.log('test-primary-signal-live: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
