'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const { PUMP_AMM_PROGRAM_ID } = require('@pump-fun/pump-swap-sdk');
const { PublicKey, TransactionInstruction } = require('@solana/web3.js');
const {
  ammQuotePriceDiagnostics,
  ammReservePrice,
  classifyBuyReconciliation,
  replaceAmmBuyWithExactQuoteIn,
  tokenDeltaFromTransaction,
  walletSolSettlementFromTransaction,
} = require('../src/core/PumpTradeExecutor');
const { ResearchStore } = require('../src/data/ResearchStore');

function testPreviousLiveSchemaUpgrade() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-live-strategy-migration-'));
  const dbPath = path.join(directory, 'previous.db');
  const previous = new Database(dbPath);
  previous.exec(`
    CREATE TABLE live_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id INTEGER,
      primary_decision_id INTEGER,
      source_type TEXT NOT NULL DEFAULT 'PRIMARY_SIGNAL',
      signal_id INTEGER,
      mint TEXT NOT NULL,
      trigger_wallet TEXT,
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
      decision_id INTEGER,
      primary_decision_id INTEGER,
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
    CREATE UNIQUE INDEX idx_live_positions_one_active_mint
    ON live_positions(mint)
    WHERE status IN ('OPENING','OPEN','EXITING','EXIT_FAILED');
    INSERT INTO live_positions (
      source_type, mint, mode, status, position_sol, token_amount_raw,
      entry_market, entry_price, exit_market, exit_price, exit_reason,
      opened_at, closed_at, created_at, updated_at
    ) VALUES (
      'PRIMARY_THRESHOLD', 'legacy-mint', 'DRY_RUN', 'CLOSED', 0.05, '1000',
      'PUMP_BONDING_CURVE', 1, 'PUMP_BONDING_CURVE', 1.1, 'LEGACY_TEST',
      1000, 2000, 900, 2000
    );
    INSERT INTO live_orders (
      position_id, mint, side, venue, attempt, requested_sol,
      requested_token_raw, status, signature, created_at, updated_at
    ) VALUES (1, 'legacy-mint', 'BUY', 'PUMP_BONDING_CURVE', 1, 0.05,
      '1000', 'CONFIRMED', 'legacy-signature', 1000, 1000);
  `);
  previous.close();

  const upgraded = new ResearchStore({
    dbPath, archiveDir: directory, rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  }, { horizonsSeconds: [1], excursionSeconds: [1] });
  assert.strictEqual(upgraded.db.prepare(`
    SELECT COUNT(*) AS n FROM live_positions WHERE mint = 'legacy-mint'
  `).get().n, 1);
  assert.strictEqual(upgraded.db.prepare(`
    SELECT COUNT(*) AS n FROM live_orders WHERE signature = 'legacy-signature'
  `).get().n, 1);
  assert.ok(upgraded.db.prepare('PRAGMA table_info(live_positions)').all()
    .some((column) => column.name === 'strategy_id'));
  assert.ok(upgraded.db.prepare('PRAGMA table_info(live_orders)').all()
    .some((column) => column.name === 'strategy_decision_id'));
  assert.ok(upgraded.db.prepare('PRAGMA table_info(live_positions)').all()
    .some((column) => column.name === 'realized_pnl_sol'));
  assert.ok(upgraded.db.prepare('PRAGMA table_info(live_orders)').all()
    .some((column) => column.name === 'wallet_sol_delta'));
  const activeMintIndexes = upgraded.db.prepare("PRAGMA index_list('live_positions')").all();
  assert.strictEqual(
    activeMintIndexes.some((index) => index.name === 'idx_live_positions_one_active_mint'),
    false,
  );
  assert.strictEqual(
    activeMintIndexes.find((index) => index.name === 'idx_live_positions_active_mint')?.unique,
    0,
  );
  upgraded.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

testPreviousLiveSchemaUpgrade();

const fakeAmmBuy = new TransactionInstruction({
  programId: PUMP_AMM_PROGRAM_ID,
  keys: [{ pubkey: PublicKey.default, isSigner: false, isWritable: false }],
  data: Buffer.alloc(24, 1),
});
const exactAmmBuy = replaceAmmBuyWithExactQuoteIn([fakeAmmBuy], 50_000_000n, 123_456n)[0];
const decodedExactAmmBuy = require('@pump-fun/pump-swap-sdk')
  .OFFLINE_PUMP_AMM_PROGRAM.coder.instruction.decode(exactAmmBuy.data);
assert.strictEqual(decodedExactAmmBuy.name, 'buyExactQuoteIn');
assert.strictEqual(decodedExactAmmBuy.data.spendableQuoteIn.toString(), '50000000');
assert.strictEqual(decodedExactAmmBuy.data.minBaseAmountOut.toString(), '123456');

const syntheticBaseReserve = 100_000_000_000_000n;
const syntheticVirtualQuote = 20_000_000_000n;
const syntheticFreshQuote = 52_000_000_000n;
const syntheticEffectiveInput = 990_000_000n;
const syntheticQuotedBase = syntheticBaseReserve * syntheticEffectiveInput
  / (syntheticFreshQuote + syntheticVirtualQuote + syntheticEffectiveInput);
const correctedSignalPrice = ammReservePrice({
  baseReserveRaw: syntheticBaseReserve,
  quoteReserveRaw: 50_000_000_000n,
  virtualQuoteReservesRaw: syntheticVirtualQuote,
  baseDecimals: 6,
});
assert.ok(Math.abs(correctedSignalPrice - 0.0000007) < 1e-15);
const quoteDiagnostics = ammQuotePriceDiagnostics({
  signalBaseReserveRaw: syntheticBaseReserve,
  signalQuoteReserveRaw: 50_000_000_000n,
  freshBaseReserveRaw: syntheticBaseReserve,
  freshQuoteReserveRaw: syntheticFreshQuote,
  virtualQuoteReservesRaw: syntheticVirtualQuote,
  baseDecimals: 6,
  positionSol: 1,
  quotedBaseRaw: syntheticQuotedBase,
  internalQuoteWithoutFeesRaw: syntheticEffectiveInput,
  legacyReferencePrice: 0.0000005,
});
assert.strictEqual(quoteDiagnostics.referencePriceMode, 'EFFECTIVE_POOL_RESERVES');
assert.ok(Math.abs(quoteDiagnostics.marketReferencePrice - 0.0000007) < 1e-15);
assert.ok(Math.abs(quoteDiagnostics.signalReservePrice - 0.0000007) < 1e-15);
assert.ok(Math.abs(quoteDiagnostics.freshReservePrice - 0.00000072) < 1e-15);
assert.ok(Math.abs(quoteDiagnostics.marketMovePct - 2.857142857142847) < 1e-9);
assert.ok(Math.abs(quoteDiagnostics.selfImpactPct - 1.375) < 1e-6);
assert.ok(Math.abs(quoteDiagnostics.feeImpactPct - 1.0101010101010166) < 1e-6);
assert.ok(quoteDiagnostics.totalQuotePremiumPct > 5
  && quoteDiagnostics.totalQuotePremiumPct < 6);

const receiptMint = PublicKey.unique().toBase58();
const receiptOwner = PublicKey.unique().toBase58();
const settlement = walletSolSettlementFromTransaction({
  transaction: { message: { accountKeys: [receiptOwner, PublicKey.unique().toBase58()] } },
  meta: {
    err: { InstructionError: [3, 'Custom'] },
    fee: 500_000,
    preBalances: [2_000_000_000, 0],
    postBalances: [1_010_500_000, 0],
  },
}, receiptOwner);
assert.deepStrictEqual(settlement, {
  walletSolDelta: -0.9895,
  networkFeeSol: 0.0005,
  walletIndex: 0,
});
const receivedRaw = tokenDeltaFromTransaction({
  meta: {
    err: null,
    preTokenBalances: [{
      accountIndex: 6, mint: receiptMint, owner: receiptOwner,
      uiTokenAmount: { amount: '0' },
    }],
    postTokenBalances: [{
      accountIndex: 6, mint: receiptMint, owner: receiptOwner,
      uiTokenAmount: { amount: '134585106701' },
    }],
  },
}, receiptMint, receiptOwner);
assert.strictEqual(receivedRaw, 134_585_106_701n);
assert.deepStrictEqual(
  classifyBuyReconciliation({ err: null, confirmationStatus: 'confirmed' }, 0n, {
    transactionTokenDeltaRaw: receivedRaw,
    transactionObserved: true,
    balanceObserved: false,
  }),
  {
    state: 'CONFIRMED',
    tokenAmountRaw: '134585106701',
    confirmationStatus: 'confirmed',
    recoveredFrom: 'TRANSACTION_META',
  },
);
assert.strictEqual(
  classifyBuyReconciliation({ err: null, confirmationStatus: 'confirmed' }, 0n, {
    transactionObserved: false,
    balanceObserved: false,
  }).state,
  'UNKNOWN',
  'an indexed signature plus an unindexed Token-2022 ATA must not close the position',
);
assert.deepStrictEqual(
  classifyBuyReconciliation({ err: null, confirmationStatus: 'confirmed' }, 999_999n, {
    transactionTokenDeltaRaw: 123n,
    transactionObserved: true,
    balanceObserved: true,
  }),
  {
    state: 'CONFIRMED',
    tokenAmountRaw: '123',
    confirmationStatus: 'confirmed',
    recoveredFrom: 'TRANSACTION_META',
  },
  'a same-Mint buy must attribute only the current transaction receipt to its position lot',
);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-post-live-'));
const store = new ResearchStore({
  dbPath: path.join(temp, 'test.db'),
  archiveDir: path.join(temp, 'archive'),
  flushMs: 25,
  flushMax: 20,
  rawRetentionHours: 24,
}, { horizonsSeconds: [1], excursionSeconds: [1] });

let now = 1_000_000;
const config = {
  enabled: true,
  requestedEnabled: true,
  safetyLock: false,
  dryRun: true,
  maxSignalAgeMs: 1_500,
  maxConcurrentPositions: 1,
  minWalletReserveSol: 0.05,
  mintCooldownMs: 10 * 60_000,
  failedEntryCooldownMs: 1_000,
  failedEntryWindowMs: 10_000,
  maxFailedEntriesPerMint: 2,
  buySlippagePct: 10,
  sellSlippagePct: 15,
  maxHoldMs: 15_000,
  exitRetryCount: 1,
  exitRetryDelayMs: 10,
  entryReconcileCount: 1,
  entryReconcileDelayMs: 10,
  killSwitchFile: path.join(temp, 'KILL'),
  strategies: [{
    id: 'post_gd25_35_xleg',
    label: 'test',
    enabled: true,
    market: 'PUMP_AMM',
    positionSizeSol: 0.05,
    trackingAgeMs: 120_000,
    maxSignalAgeMs: 1_500,
    windowMs: 1_000,
    dropMinPct: 25,
    dropMaxPct: 35,
    reboundMinPct: 2,
    reboundMaxPct: 5,
    reboundTimeoutMs: 1_000,
    maxEntriesPerMint: 2,
    reentryCooldownMs: 1_000,
    maxEntryPriceJumpPct: 15,
    trailingActivationPct: 8,
    trailingStopPct: 3,
    fastTakeProfitPct: 18,
    fastTakeProfitWindowMs: 5_000,
    lossCheckAtMs: 6_000,
    maxHoldMs: 15_000,
  }],
};
config.strategies.push({
  ...config.strategies[0],
  id: 'legacy_history_only',
  label: 'legacy history only',
  entryEnabled: false,
});

store.recordCreate({
  mint: 'MintLive111111111111111111111111111111111', symbol: 'LIVE',
  name: null, uri: null, bondingCurve: null, creator: null,
  createdAt: now - 10_000, initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
});
store.recordComplete({
  mint: 'MintLive111111111111111111111111111111111', completedAt: now,
  timestampMs: now,
});

const manager = new LiveTradingManager({ config, store, now: () => now });
manager.start();
manager.onGraduated(store.getToken('MintLive111111111111111111111111111111111'));

const sharedMint = 'MintSharedSlots111111111111111111111111111111';
const sharedMintManager = new LiveTradingManager({
  config: {
    ...config,
    maxConcurrentPositions: 10,
    maxConcurrentPositionsPerMint: 2,
  },
  store,
  now: () => now,
});
sharedMintManager._addPosition({ id: 9001, mint: sharedMint, strategyId: 'first' });
assert.strictEqual(sharedMintManager._riskReason({
  strategyId: 'post_gd25_35_xleg', mint: sharedMint,
}), null);
sharedMintManager._addPosition({ id: 9002, mint: sharedMint, strategyId: 'second' });
assert.strictEqual(sharedMintManager._riskReason({
  strategyId: 'post_gd25_35_xleg', mint: sharedMint,
}), 'MAX_POSITIONS_PER_MINT');

sharedMintManager.strategies.set('beijing-window-test', {
  ...config.strategies[0],
  id: 'beijing-window-test',
  entryBeijingStartHour: 4,
  entryBeijingEndHour: 24,
});
assert.strictEqual(sharedMintManager._riskReason({
  strategyId: 'beijing-window-test',
  mint: 'MintBeijingBlocked11111111111111111111111111',
  timestampMs: Date.UTC(2026, 7, 28, 18, 0, 0), // Beijing 02:00
}), 'STRATEGY_TIME_WINDOW');
assert.strictEqual(sharedMintManager._riskReason({
  strategyId: 'beijing-window-test',
  mint: 'MintBeijingAllowed11111111111111111111111111',
  timestampMs: Date.UTC(2026, 7, 28, 21, 0, 0), // Beijing 05:00
}), null);

store.recordPreEntryRugFirstCliffAudits([{
  auditKey: 'audit-test|1000',
  strategyId: 'beijing-window-test',
  source: 'LIVE',
  mint: 'MintAudit111111111111111111111111111111111',
  lifecycleStage: 'LAUNCH',
  lifecycleLabel: 'launch',
  entryAt: 1_000,
  resolvedAt: 31_000,
  entryPrice: 1,
  hc1Matched: true,
  hc2Matched: false,
  effectiveBuyers: 2,
  top1InventoryPct: 20,
  top3InventoryPct: 40,
  top1RealReservePct: 10,
  top3RealReservePct: 20,
  top3RecoveryPct: 30,
  maxWalletBuyTxSharePct: 40,
  outcome: 'NO_CLIFF_30S',
  returnPct: 5,
  cliffDropPct: 0,
  markLagMs: 30_000,
}]);
store.recordPreEntryRugFirstCliffAudits([{
  auditKey: 'audit-test|1000',
  strategyId: 'beijing-window-test',
  source: 'LIVE',
  mint: 'MintAudit111111111111111111111111111111111',
  entryAt: 1_000,
  resolvedAt: 31_000,
  outcome: 'NO_CLIFF_30S',
}]);
assert.strictEqual(store.db.prepare(`
  SELECT COUNT(*) AS n FROM pre_entry_rug_first_cliff_audits
  WHERE audit_key = 'audit-test|1000'
`).get().n, 1);

// COB-D's live trailing mode takes the full position at +10% only during the
// first two seconds. Outside that window the existing +30% trailing rule
// remains in control.
const cobFastStrategy = {
  exitMode: 'TRAILING',
  minHoldMs: 0,
  fastTakeProfitPct: 10,
  fastTakeProfitWindowMs: 2_000,
  trailingActivationPct: 30,
  trailingStopPct: 10,
  hardStopPct: 20,
  maxHoldMs: 60_000,
};
const cobFastManager = new LiveTradingManager({ config, store, now: () => now });
let cobExitReason = null;
cobFastManager._requestExit = (_position, reason) => { cobExitReason = reason; };
cobFastManager._evaluatePositionExit({
  id: 9010,
  mint: 'MintCobFast11111111111111111111111111111111',
  status: 'OPEN',
  strategy: cobFastStrategy,
  entryPrice: 100,
  highestPrice: 111,
  openedAt: now,
}, now + 1_500, 111);
assert.strictEqual(cobExitReason, 'FAST_TAKE_PROFIT');

cobExitReason = null;
cobFastManager._evaluatePositionExit({
  id: 9011,
  mint: 'MintCobLate11111111111111111111111111111111',
  status: 'OPEN',
  strategy: cobFastStrategy,
  entryPrice: 100,
  highestPrice: 111,
  openedAt: now,
}, now + 2_001, 111);
assert.strictEqual(cobExitReason, null);

// The executable 0.1 SOL G-V2 strategy must not turn every temporary loss at
// the two-second checkpoint into an exit.  It exits only when the bounce from
// the observed low is still weak; a real recovery remains open.
const gV2RiskStrategy = {
  exitMode: 'RISK_XLEG',
  trailingActivationPct: 8,
  trailingStopPct: 3,
  hardStopPct: 15,
  fastTakeProfitPct: 18,
  fastTakeProfitWindowMs: 5_000,
  lossCheckAtMs: 2_000,
  lossCheckRecoveryPct: 1,
  maxHoldMs: 15_000,
};
const gV2RiskManager = new LiveTradingManager({ config, store, now: () => now });
let gV2ExitReason = null;
gV2RiskManager._requestExit = (_position, reason) => { gV2ExitReason = reason; };
const weakRecoveryPosition = {
  id: 9012,
  mint: 'MintGV2Weak111111111111111111111111111111111',
  status: 'OPEN',
  strategy: gV2RiskStrategy,
  entryPrice: 100,
  highestPrice: 100,
  lowestPrice: 100,
  openedAt: now,
};
gV2RiskManager._evaluatePositionExit(weakRecoveryPosition, now + 1_000, 90);
assert.strictEqual(gV2ExitReason, null);
gV2RiskManager._evaluatePositionExit(weakRecoveryPosition, now + 2_100, 90.5);
assert.strictEqual(gV2ExitReason, 'RISK_LOSS_CHECK');

gV2ExitReason = null;
const recoveredPosition = {
  id: 9013,
  mint: 'MintGV2Recovered111111111111111111111111111111',
  status: 'OPEN',
  strategy: gV2RiskStrategy,
  entryPrice: 100,
  highestPrice: 100,
  lowestPrice: 100,
  openedAt: now,
};
gV2RiskManager._evaluatePositionExit(recoveredPosition, now + 1_000, 90);
gV2RiskManager._evaluatePositionExit(recoveredPosition, now + 2_100, 92);
assert.strictEqual(gV2ExitReason, null);

// A rejected/failed buy is not a successful entry and must not consume one of
// the two durable per-Mint slots.
const failedMint = 'MintFailedEntry11111111111111111111111111111';
const failedPosition = store.createLivePosition({
  strategyId: 'post_gd25_35_xleg', sourceType: 'post_gd25_35_xleg',
  mint: failedMint, mode: 'LIVE', status: 'OPENING', positionSol: 0.05,
  entryMarket: 'PUMP_AMM', entryPrice: 1,
});
store.updateLivePosition(failedPosition.id, {
  status: 'ENTRY_FAILED', exitReason: 'ENTRY_REJECTED', entryError: 'test rejection',
});
store.db.prepare(`
  UPDATE live_positions SET created_at=?, updated_at=? WHERE id=?
`).run(now, now, failedPosition.id);
manager.strategies.set('cross_strategy_retry_test', {
  ...config.strategies[0],
  id: 'cross_strategy_retry_test',
});
assert.strictEqual(store.successfulLiveEntryCountForMintStrategy(
  failedMint, 'post_gd25_35_xleg',
), 0);
assert.strictEqual(manager._riskReason({
  strategyId: 'post_gd25_35_xleg', mint: failedMint,
}), 'MINT_FAILED_ENTRY_COOLDOWN');
assert.strictEqual(manager._riskReason({
  strategyId: 'cross_strategy_retry_test', mint: failedMint,
}), 'MINT_FAILED_ENTRY_COOLDOWN',
  'a failed Mint must cool down globally instead of retrying through another strategy');
now += 1_001;
assert.strictEqual(manager._riskReason({
  strategyId: 'post_gd25_35_xleg', mint: failedMint,
}), null, 'one failed entry may retry after the short cooldown');

const secondFailedPosition = store.createLivePosition({
  strategyId: 'post_gd25_35_xleg', sourceType: 'post_gd25_35_xleg',
  mint: failedMint, mode: 'LIVE', status: 'OPENING', positionSol: 0.05,
  entryMarket: 'PUMP_AMM', entryPrice: 1,
});
store.updateLivePosition(secondFailedPosition.id, {
  status: 'ENTRY_FAILED', exitReason: 'ENTRY_TRANSACTION_FAILED', entryError: 'second failure',
});
store.db.prepare(`
  UPDATE live_positions SET created_at=?, updated_at=? WHERE id=?
`).run(now, now, secondFailedPosition.id);
assert.strictEqual(manager._riskReason({
  strategyId: 'post_gd25_35_xleg', mint: failedMint,
}), 'MINT_FAILED_ENTRY_COOLDOWN');
now += 1_001;
assert.strictEqual(manager._riskReason({
  strategyId: 'post_gd25_35_xleg', mint: failedMint,
}), 'MINT_FAILED_ENTRY_LIMIT', 'repeated failed buys must not retry forever');
assert.strictEqual(manager._riskReason({
  strategyId: 'cross_strategy_retry_test', mint: failedMint,
}), 'MINT_FAILED_ENTRY_LIMIT',
  'the failed-entry limit must aggregate the same Mint across all strategies');
now += 10_001;
assert.strictEqual(manager._riskReason({
  strategyId: 'post_gd25_35_xleg', mint: failedMint,
}), null, 'the failed-entry rolling window must eventually release the Mint');

const trade = (price, offset) => {
  now = 1_000_000 + offset;
  manager.observeTrade({
    mint: 'MintLive111111111111111111111111111111111', symbol: 'LIVE', market: 'PUMP_AMM', price,
    reservePrice: price, timestampMs: now, receivedAtMs: now, slot: 10 + offset,
  });
};

trade(100, 100);
trade(72, 500); // -28%, candidate
trade(74, 800); // +2.78% rebound, signal

setImmediate(() => {
  (async () => {
  await manager.entryQueue;
  const dashboard = store.liveTradingDashboard({ strategyId: 'post_gd25_35_xleg' });
  assert.strictEqual(dashboard.decisions.length, 1);
  assert.strictEqual(dashboard.decisions[0].strategy_id, 'post_gd25_35_xleg');
  assert.strictEqual(dashboard.positions[0].position_sol, 0.05);
  assert.strictEqual(dashboard.positions[0].entry_market, 'PUMP_AMM');
  assert.strictEqual(manager.health().strategies[0].positionSizeSol, 0.05);
  assert.strictEqual(manager._riskReason({
    strategyId: 'legacy_history_only', mint: 'NeverEnterLegacy111111111111111111111111111',
  }), 'STRATEGY_ENTRY_DISABLED');
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) AS n FROM live_strategy_decisions WHERE strategy_id='legacy_history_only'
  `).get().n, 0);

  // A stale PumpSwap AMM quote (6040) gets exactly one immediate fresh-quote
  // retry while the original signal is still young. Both attempts remain
  // auditable, and the safety price/self-impact checks still run in buyAmm.
  const quoteRetryStrategy = {
    ...config.strategies[0],
    id: 'amm_quote_retry_test',
    maxSignalAgeMs: 2_500,
    entryQuoteRefreshRetryCount: 1,
    entryQuoteRefreshMaxSignalAgeMs: 2_500,
  };
  let quoteRetryCalls = 0;
  const quoteRetryManager = new LiveTradingManager({
    config: {
      ...config,
      dryRun: false,
      maxConcurrentPositions: 10,
      strategies: [quoteRetryStrategy],
    },
    store,
    now: () => now,
    executor: {
      async buyAmm() {
        quoteRetryCalls += 1;
        if (quoteRetryCalls === 1) {
          const error = new Error(
            'AnchorError 6040 BuySlippageBelowMinBaseAmountOut: stale AMM quote',
          );
          error.code = 'SIMULATION_FAILED';
          throw error;
        }
        return {
          signature: 'amm-quote-retry-success',
          venue: 'PUMP_AMM',
          tokenAmountRaw: '1000000',
          expectedPrice: 1,
          execution: {
            settlement: { walletSolDelta: -0.05, networkFeeSol: 0.0005 },
          },
        };
      },
    },
  });
  const quoteRetryMint = 'MintAmmQuoteRetry111111111111111111111111111';
  const quoteRetryDecision = store.recordLiveStrategyDecision({
    strategyId: quoteRetryStrategy.id,
    episodeId: `${quoteRetryMint}:1`,
    timestampMs: now,
    receivedAtMs: now,
    mint: quoteRetryMint,
    symbol: 'RETRY',
    ruleVersion: 'test',
    market: 'PUMP_AMM',
    referencePrice: 1,
    features: {},
    ruleMatched: true,
    rejectionReasons: [],
    mode: 'LIVE',
    actionStatus: 'MATCHED',
  });
  await quoteRetryManager._enter(quoteRetryDecision, {
    strategyId: quoteRetryStrategy.id,
    episodeId: `${quoteRetryMint}:1`,
    mint: quoteRetryMint,
    symbol: 'RETRY',
    market: 'PUMP_AMM',
    price: 1,
    timestampMs: now,
    receivedAtMs: now,
    slot: 123,
    features: {},
  });
  assert.strictEqual(quoteRetryCalls, 2);
  assert.deepStrictEqual(store.db.prepare(`
    SELECT attempt, status FROM live_orders
    WHERE strategy_id = ? ORDER BY attempt
  `).all(quoteRetryStrategy.id), [
    { attempt: 1, status: 'FAILED' },
    { attempt: 2, status: 'CONFIRMED' },
  ]);
  const quoteRetryPosition = store.db.prepare(`
    SELECT status FROM live_positions WHERE strategy_id = ?
  `).get(quoteRetryStrategy.id);
  assert.strictEqual(quoteRetryPosition.status, 'OPEN');
  const quoteRetryPositionId = store.db.prepare(`
    SELECT id FROM live_positions WHERE strategy_id = ?
  `).get(quoteRetryStrategy.id).id;
  store.updateLivePosition(quoteRetryPositionId, {
    status: 'CLOSED',
    exitReason: 'TEST_CLEANUP',
    closedAt: now,
  });
  await quoteRetryManager.stop();

  // A loss visible at the six-second checkpoint triggers XLEG loss exit.
  trade(70, 7_000);
  await new Promise((resolve) => setImmediate(resolve));
  const closed = store.liveTradingDashboard({ strategyId: 'post_gd25_35_xleg' }).positions[0];
  assert.strictEqual(closed.status, 'CLOSED');
  assert.strictEqual(closed.exit_reason, 'LOSS_CHECK');
  assert.strictEqual(Math.round(closed.price_return_pct * 100), -541);

  // Real live PnL uses signed wallet SOL deltas (including fees), while price
  // return remains a separate execution diagnostic.
  const settledDecision = store.recordLiveStrategyDecision({
    strategyId: 'settlement_test', episodeId: 'settlement-test:1',
    timestampMs: now, receivedAtMs: now, mint: 'MintSettlementTest',
    ruleVersion: 'test', market: 'PUMP_AMM', referencePrice: 1,
    features: {}, ruleMatched: true, rejectionReasons: [], mode: 'LIVE',
    actionStatus: 'CLOSED',
  });
  const settledPosition = store.createLivePosition({
    strategyDecisionId: settledDecision.id, strategyId: 'settlement_test',
    sourceType: 'settlement_test', mint: 'MintSettlementTest', mode: 'LIVE',
    status: 'OPENING', positionSol: 1, entryMarket: 'PUMP_AMM', entryPrice: 1,
  });
  store.updateLivePosition(settledPosition.id, {
    status: 'CLOSED', entryPrice: 1, exitPrice: 1.1,
    openedAt: now, closedAt: now + 1_000, exitReason: 'TEST',
  });
  store.recordLiveOrder({
    positionId: settledPosition.id, strategyDecisionId: settledDecision.id,
    strategyId: 'settlement_test', mint: 'MintSettlementTest', side: 'BUY',
    attempt: 1, status: 'CONFIRMED', signature: 'settlement-buy',
    walletSolDelta: -0.989, networkFeeSol: 0.0005,
  });
  store.recordLiveOrder({
    positionId: settledPosition.id, strategyDecisionId: settledDecision.id,
    strategyId: 'settlement_test', mint: 'MintSettlementTest', side: 'SELL',
    attempt: 1, status: 'CONFIRMED', signature: 'settlement-sell',
    walletSolDelta: 1.06, networkFeeSol: 0.0005,
  });
  store.refreshLivePositionSettlement(settledPosition.id);
  const settledDashboard = store.liveTradingDashboard({ strategyId: 'settlement_test' });
  assert.strictEqual(settledDashboard.positions[0].realized_pnl_sol, 0.07100000000000006);
  assert.ok(Math.abs(settledDashboard.positions[0].realized_return_pct - 7.178968655207286) < 1e-9);
  assert.ok(Math.abs(settledDashboard.positions[0].price_return_pct - 10) < 1e-9);
  assert.strictEqual(settledDashboard.stats.settled_closed_positions, 1);
  assert.strictEqual(settledDashboard.stats.win_rate_pct, 100);

  // A failed sell fee is not proof that the successful sell receipt has settled.
  // Keep realized PnL pending until every signed order has a wallet SOL delta,
  // then durably recover the missing partial-sell receipt after a restart.
  const partialDecision = store.recordLiveStrategyDecision({
    strategyId: 'partial_settlement_test', episodeId: 'partial-settlement-test:1',
    timestampMs: now, receivedAtMs: now, mint: 'MintPartialSettlementTest',
    ruleVersion: 'test', market: 'PUMP_AMM', referencePrice: 1,
    features: {}, ruleMatched: true, rejectionReasons: [], mode: 'LIVE',
    actionStatus: 'CLOSED',
  });
  const partialPosition = store.createLivePosition({
    strategyDecisionId: partialDecision.id, strategyId: 'partial_settlement_test',
    sourceType: 'partial_settlement_test', mint: 'MintPartialSettlementTest', mode: 'LIVE',
    status: 'OPENING', positionSol: 1, entryMarket: 'PUMP_AMM', entryPrice: 1,
  });
  store.updateLivePosition(partialPosition.id, {
    status: 'CLOSED', entryPrice: 1, exitPrice: 0.9643,
    openedAt: now, closedAt: now + 10_000, exitReason: 'LOSS_CHECK',
  });
  store.recordLiveOrder({
    positionId: partialPosition.id, strategyDecisionId: partialDecision.id,
    strategyId: 'partial_settlement_test', mint: 'MintPartialSettlementTest', side: 'BUY',
    attempt: 1, status: 'CONFIRMED', signature: 'partial-settlement-buy',
    walletSolDelta: -1.00257908, networkFeeSol: 0.0005,
  });
  store.recordLiveOrder({
    positionId: partialPosition.id, strategyDecisionId: partialDecision.id,
    strategyId: 'partial_settlement_test', mint: 'MintPartialSettlementTest', side: 'SELL',
    attempt: 1, status: 'FAILED', signature: 'partial-settlement-failed-sell',
    walletSolDelta: -0.000505, networkFeeSol: 0.000505,
  });
  const partialSellOrderId = store.recordLiveOrder({
    positionId: partialPosition.id, strategyDecisionId: partialDecision.id,
    strategyId: 'partial_settlement_test', mint: 'MintPartialSettlementTest', side: 'SELL',
    attempt: 2, status: 'CONFIRMED_PARTIAL', signature: 'partial-settlement-successful-sell',
  });
  store.recordLiveOrder({
    positionId: partialPosition.id, strategyDecisionId: partialDecision.id,
    strategyId: 'partial_settlement_test', mint: 'MintPartialSettlementTest', side: 'SELL',
    attempt: 3, status: 'ALREADY_EMPTY', signature: null,
  });
  const pendingSettlement = store.refreshLivePositionSettlement(partialPosition.id);
  assert.strictEqual(pendingSettlement.complete, false);
  assert.strictEqual(pendingSettlement.pendingSettlements, 1);
  let partialDashboard = store.liveTradingDashboard({ strategyId: 'partial_settlement_test' });
  assert.strictEqual(partialDashboard.positions[0].realized_pnl_sol, null);
  assert.strictEqual(partialDashboard.positions[0].realized_return_pct, null);
  assert.strictEqual(partialDashboard.stats.settled_closed_positions, 0);
  assert.ok(store.unsettledLiveOrders(2_000)
    .some((order) => order.id === partialSellOrderId));
  // Simulate the stale -100% persisted by the previous completeness rule.
  store.updateLivePosition(partialPosition.id, {
    realizedPnlSol: -1.003084,
    realizedReturnPct: -100.05,
  });

  let settlementAvailable = false;
  let settlementRecoveryNow = now;
  const settlementRecoveryManager = new LiveTradingManager({
    config: { ...config, dryRun: false, strategies: [] },
    store,
    now: () => settlementRecoveryNow,
    executor: {
      async transactionSettlement(signature) {
        if (settlementAvailable && signature === 'partial-settlement-successful-sell') {
          return { walletSolDelta: 0.659232, networkFeeSol: 0.0005 };
        }
        return null;
      },
    },
  });
  settlementRecoveryManager.start();
  await Promise.allSettled([...settlementRecoveryManager.pending]);
  partialDashboard = store.liveTradingDashboard({ strategyId: 'partial_settlement_test' });
  assert.strictEqual(partialDashboard.positions[0].realized_pnl_sol, null);
  settlementAvailable = true;
  settlementRecoveryNow += 30_001;
  settlementRecoveryManager.advanceTime(settlementRecoveryNow);
  await Promise.allSettled([...settlementRecoveryManager.pending]);
  partialDashboard = store.liveTradingDashboard({ strategyId: 'partial_settlement_test' });
  assert.ok(Math.abs(partialDashboard.positions[0].realized_pnl_sol - (-0.34385208)) < 1e-12);
  assert.ok(Math.abs(
    partialDashboard.positions[0].realized_return_pct - (-34.29675392787968)
  ) < 1e-9);
  assert.strictEqual(partialDashboard.stats.settled_closed_positions, 1);
  await settlementRecoveryManager.stop();

  // A fully closed mint may enter one fresh causal cycle a second time.
  trade(100, 8_000);
  trade(70, 8_300);
  trade(72, 8_600);
  await manager.entryQueue;
  let repeatDashboard = store.liveTradingDashboard({ strategyId: 'post_gd25_35_xleg' });
  assert.strictEqual(repeatDashboard.decisions.length, 2);
  assert.strictEqual(repeatDashboard.positions.filter(
    (row) => row.mint === 'MintLive111111111111111111111111111111111',
  ).length, 2);
  assert.strictEqual(store.successfulLiveEntryCountForMintStrategy(
    'MintLive111111111111111111111111111111111',
    'post_gd25_35_xleg',
  ), 2);

  // Close entry two, then prove a third fresh cycle is recorded but rejected.
  trade(70, 15_000);
  await new Promise((resolve) => setImmediate(resolve));
  trade(100, 16_000);
  trade(70, 16_300);
  trade(72, 16_600);
  await manager.entryQueue;
  repeatDashboard = store.liveTradingDashboard({ strategyId: 'post_gd25_35_xleg' });
  assert.strictEqual(repeatDashboard.decisions.length, 3);
  assert.strictEqual(repeatDashboard.positions.filter(
    (row) => row.mint === 'MintLive111111111111111111111111111111111',
  ).length, 2);
  assert.strictEqual(repeatDashboard.decisions[0].action_status, 'RISK_REJECTED');
  assert.strictEqual(repeatDashboard.decisions[0].action_reason, 'MINT_ENTRY_LIMIT');

  // The successful count is stored in SQLite, so a process restart cannot
  // reset the two-entry limit.
  const restartedManager = new LiveTradingManager({ config, store, now: () => now });
  restartedManager.start();
  assert.strictEqual(
    restartedManager._riskReason({
      strategyId: 'post_gd25_35_xleg',
      mint: 'MintLive111111111111111111111111111111111',
    }),
    'MINT_ENTRY_LIMIT',
  );
  await restartedManager.stop();

  // The safety lock disables execution but must not disable forward observation.
  const disabledMint = 'MintDisabled111111111111111111111111111111';
  store.recordCreate({
    mint: disabledMint, symbol: 'OFF', name: null, uri: null, bondingCurve: null,
    creator: null, createdAt: now - 1_000, initialRealTokenReservesRaw: null,
    tokenTotalSupplyRaw: null,
  });
  store.recordComplete({ mint: disabledMint, completedAt: now, timestampMs: now });
  const disabledManager = new LiveTradingManager({
    config: { ...config, enabled: false, requestedEnabled: true, safetyLock: true },
    store,
    now: () => now,
  });
  disabledManager.start();
  disabledManager.onGraduated(store.getToken(disabledMint));
  const disabledBase = now;
  for (const [price, offset] of [[100, 100], [72, 500], [74, 800]]) {
    now = disabledBase + offset;
    disabledManager.observeTrade({
      mint: disabledMint, symbol: 'OFF', market: 'PUMP_AMM', price,
      reservePrice: price, timestampMs: now, receivedAtMs: now, slot: 100 + offset,
    });
  }
  const disabledDecision = store.db.prepare(`
    SELECT action_status FROM live_strategy_decisions WHERE mint = ?
  `).get(disabledMint);
  assert.strictEqual(disabledDecision.action_status, 'MATCHED_DISABLED');
  assert.strictEqual(store.db.prepare(`
    SELECT COUNT(*) AS n FROM live_positions WHERE mint = ?
  `).get(disabledMint).n, 0);
  await disabledManager.stop();

  // Recover rows incorrectly closed by the old single-read Token-2022 balance
  // check. Receipt reconciliation must reopen and then honor the elapsed max hold.
  const legacyMint = 'MintLegacyEmpty1111111111111111111111111111';
  const legacyDecision = store.recordLiveStrategyDecision({
    strategyId: 'post_gd25_35_xleg',
    episodeId: `${legacyMint}:episode`,
    timestampMs: now - 30_000,
    receivedAtMs: now - 30_000,
    mint: legacyMint,
    symbol: 'LEGACY',
    ruleVersion: 'test',
    market: 'PUMP_AMM',
    referencePrice: 1,
    features: {},
    ruleMatched: true,
    rejectionReasons: [],
    mode: 'LIVE',
    actionStatus: 'CLOSED',
  });
  const legacyPosition = store.createLivePosition({
    strategyDecisionId: legacyDecision.id,
    strategyId: 'post_gd25_35_xleg',
    sourceType: 'post_gd25_35_xleg',
    mint: legacyMint,
    mode: 'LIVE',
    status: 'OPENING',
    positionSol: 0.05,
    entryMarket: 'PUMP_AMM',
    entryPrice: 1,
  });
  store.updateLivePosition(legacyPosition.id, {
    status: 'CLOSED',
    tokenAmountRaw: '0',
    entrySignature: 'legacy-empty-signature',
    entryError: 'Buy transaction confirmed but the trading wallet has no token balance',
    exitReason: 'ENTRY_CONFIRMED_EMPTY',
    openedAt: now - 30_000,
    closedAt: now - 29_000,
  });
  const legacyOrderId = store.recordLiveOrder({
    positionId: legacyPosition.id,
    strategyDecisionId: legacyDecision.id,
    strategyId: 'post_gd25_35_xleg',
    mint: legacyMint,
    side: 'BUY',
    venue: 'PUMP_AMM',
    attempt: 1,
    requestedSol: 0.05,
    requestedTokenRaw: '0',
    status: 'CONFIRMED',
    signature: 'legacy-empty-signature',
  });
  let recoveredSellCalls = 0;
  let recoveredSellRequest = null;
  const recoveryManager = new LiveTradingManager({
    config: { ...config, dryRun: false },
    store,
    now: () => now,
    executor: {
      async reconcileBuy() {
        return { state: 'CONFIRMED', tokenAmountRaw: '134585106701' };
      },
      async sell(request) {
        recoveredSellCalls += 1;
        recoveredSellRequest = request;
        return {
          signature: 'legacy-recovery-sell', venue: 'PUMP_AMM',
          tokenAmountRaw: '134585106701', remainingTokenAmountRaw: '0',
          balanceVerified: true,
        };
      },
    },
  });
  recoveryManager.start();
  await Promise.allSettled([...recoveryManager.pending]);
  await Promise.allSettled([...recoveryManager.pending]);
  const recoveredPosition = store.db.prepare('SELECT * FROM live_positions WHERE id = ?')
    .get(legacyPosition.id);
  assert.strictEqual(recoveredPosition.status, 'CLOSED');
  assert.strictEqual(recoveredPosition.token_amount_raw, '134585106701');
  assert.strictEqual(recoveredPosition.exit_reason, 'ENTRY_RECONCILED_MAX_HOLD');
  assert.strictEqual(recoveredPosition.closed_at > 0, true);
  assert.strictEqual(recoveredSellCalls, 1);
  assert.deepStrictEqual(recoveredSellRequest, {
    mint: legacyMint,
    tokenAmountRaw: '134585106701',
    expectedMarket: 'PUMP_AMM',
  });
  assert.strictEqual(store.db.prepare('SELECT requested_token_raw FROM live_orders WHERE id = ?')
    .get(legacyOrderId).requested_token_raw, '134585106701');
  await recoveryManager.stop();

  // A block-height-expired signature must not reserve a global position slot
  // forever. Release it only after the grace period and only when signature
  // history, transaction metadata and a token receipt all remain absent.
  const expiredMint = 'MintExpiredUnknown111111111111111111111111111';
  const expiredDecision = store.recordLiveStrategyDecision({
    strategyId: 'post_gd25_35_xleg',
    episodeId: `${expiredMint}:episode`,
    timestampMs: now - 120_000,
    receivedAtMs: now - 120_000,
    mint: expiredMint,
    ruleVersion: 'test',
    market: 'PUMP_AMM',
    referencePrice: 1,
    features: {},
    ruleMatched: true,
    rejectionReasons: [],
    mode: 'LIVE',
    actionStatus: 'ENTRY_CONFIRMATION_UNKNOWN',
  });
  const expiredPosition = store.createLivePosition({
    strategyDecisionId: expiredDecision.id,
    strategyId: 'post_gd25_35_xleg',
    sourceType: 'post_gd25_35_xleg',
    mint: expiredMint,
    mode: 'LIVE',
    status: 'OPENING',
    positionSol: 0.05,
    entryMarket: 'PUMP_AMM',
    entryPrice: 1,
  });
  const expiredError = 'Signature expired-entry-signature has expired: block height exceeded';
  store.updateLivePosition(expiredPosition.id, {
    status: 'EXIT_FAILED',
    entrySignature: 'expired-entry-signature',
    entryError: expiredError,
    exitReason: 'ENTRY_CONFIRMATION_UNKNOWN',
    exitError: expiredError,
  });
  store.db.prepare('UPDATE live_positions SET created_at = ? WHERE id = ?')
    .run(now - 120_000, expiredPosition.id);
  const expiredOrderId = store.recordLiveOrder({
    positionId: expiredPosition.id,
    strategyDecisionId: expiredDecision.id,
    strategyId: 'post_gd25_35_xleg',
    mint: expiredMint,
    side: 'BUY',
    venue: 'PUMP_AMM',
    attempt: 1,
    requestedSol: 0.05,
    status: 'CONFIRMATION_UNKNOWN',
    signature: 'expired-entry-signature',
    error: expiredError,
  });
  const expiredManager = new LiveTradingManager({
    config: { ...config, dryRun: false, expiredEntryReleaseMs: 60_000 },
    store,
    now: () => now,
    executor: {
      async reconcileBuy() {
        return {
          state: 'UNKNOWN',
          tokenAmountRaw: '0',
          confirmationStatus: null,
          transactionObserved: false,
          balanceObserved: false,
        };
      },
    },
  });
  expiredManager.start();
  await Promise.allSettled([...expiredManager.pending]);
  const releasedPosition = store.db.prepare('SELECT * FROM live_positions WHERE id = ?')
    .get(expiredPosition.id);
  assert.strictEqual(releasedPosition.status, 'ENTRY_FAILED');
  assert.strictEqual(releasedPosition.exit_reason, 'ENTRY_EXPIRED_UNOBSERVED');
  assert.strictEqual(store.db.prepare('SELECT status FROM live_orders WHERE id = ?')
    .get(expiredOrderId).status, 'FAILED');
  assert.strictEqual(expiredManager.positions.has(expiredPosition.id), false);
  await expiredManager.stop();

  await manager.stop();

  // The promoted GD25 F1 strategy consumes the first matched opportunity,
  // rather than the first successful entry. A later rebound cannot replace a
  // rejected or losing first sample, and the count survives a process restart.
  let firstNow = 2_000_000;
  const firstOnlyStore = new ResearchStore({
    dbPath: ':memory:', archiveDir: temp, rawRetentionHours: 24,
    flushMs: 60_000, flushMax: 100,
  }, { horizonsSeconds: [1], excursionSeconds: [1] });
  const firstOnlyMint = 'MintFirstOpportunity11111111111111111111111111';
  firstOnlyStore.recordCreate({
    mint: firstOnlyMint, symbol: 'F1', name: null, uri: null, bondingCurve: null,
    creator: null, createdAt: firstNow - 10_000,
    initialRealTokenReservesRaw: null, tokenTotalSupplyRaw: null,
  });
  firstOnlyStore.recordComplete({
    mint: firstOnlyMint, completedAt: firstNow, timestampMs: firstNow,
  });
  const firstOnlyStrategy = {
    ...config.strategies[0],
    id: 'post_gd25_35_f1_xleg_live_v1',
    ruleVersion: 'post_migration_gd25_35_first_xleg_live_v1',
    maxSignalsPerMint: 1,
    maxEntriesPerMint: 1,
    reentryCooldownMs: 0,
  };
  const firstOnlyConfig = {
    ...config,
    maxConcurrentPositions: 1,
    strategies: [firstOnlyStrategy],
  };
  const firstOnlyManager = new LiveTradingManager({
    config: firstOnlyConfig, store: firstOnlyStore, now: () => firstNow,
  });
  firstOnlyManager.start();
  firstOnlyManager.onGraduated(firstOnlyStore.getToken(firstOnlyMint));
  const firstTrade = (price, offset) => {
    firstNow = 2_000_000 + offset;
    firstOnlyManager.observeTrade({
      mint: firstOnlyMint, symbol: 'F1', market: 'PUMP_AMM', price,
      reservePrice: price, timestampMs: firstNow, receivedAtMs: firstNow,
      slot: 20_000 + offset,
    });
  };
  firstTrade(100, 100);
  firstTrade(72, 500);
  firstTrade(74, 800);
  await firstOnlyManager.entryQueue;
  assert.strictEqual(firstOnlyStore.liveStrategyDecisionCountForMintStrategy(
    firstOnlyMint, firstOnlyStrategy.id,
  ), 1);
  firstTrade(70, 7_000);
  await new Promise((resolve) => setImmediate(resolve));
  firstTrade(100, 8_000);
  firstTrade(72, 8_400);
  firstTrade(74, 8_700);
  await firstOnlyManager.entryQueue;
  let firstOnlyDashboard = firstOnlyStore.liveTradingDashboard({
    strategyId: firstOnlyStrategy.id,
  });
  assert.strictEqual(firstOnlyDashboard.decisions.length, 1);
  assert.strictEqual(firstOnlyDashboard.positions.length, 1);
  await firstOnlyManager.stop();

  const firstOnlyRestarted = new LiveTradingManager({
    config: firstOnlyConfig, store: firstOnlyStore, now: () => firstNow,
  });
  firstOnlyRestarted.start();
  firstOnlyRestarted.onGraduated(firstOnlyStore.getToken(firstOnlyMint));
  for (const [price, offset] of [[100, 16_000], [72, 16_400], [74, 16_700]]) {
    firstNow = 2_000_000 + offset;
    firstOnlyRestarted.observeTrade({
      mint: firstOnlyMint, symbol: 'F1', market: 'PUMP_AMM', price,
      reservePrice: price, timestampMs: firstNow, receivedAtMs: firstNow,
      slot: 30_000 + offset,
    });
  }
  await firstOnlyRestarted.entryQueue;
  firstOnlyDashboard = firstOnlyStore.liveTradingDashboard({ strategyId: firstOnlyStrategy.id });
  assert.strictEqual(firstOnlyDashboard.decisions.length, 1);
  assert.strictEqual(firstOnlyDashboard.positions.length, 1);
  await firstOnlyRestarted.stop();
  firstOnlyStore.close();

  store.close();
  fs.rmSync(temp, { recursive: true, force: true });
    console.log('post-migration live tests passed');
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
