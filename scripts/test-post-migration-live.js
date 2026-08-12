'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LiveTradingManager = require('../src/core/LiveTradingManager');
const { PUMP_AMM_PROGRAM_ID } = require('@pump-fun/pump-swap-sdk');
const { PublicKey, TransactionInstruction } = require('@solana/web3.js');
const { replaceAmmBuyWithExactQuoteIn } = require('../src/core/PumpTradeExecutor');
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
    maxEntryPriceJumpPct: 15,
    trailingActivationPct: 8,
    trailingStopPct: 3,
    fastTakeProfitPct: 18,
    fastTakeProfitWindowMs: 5_000,
    lossCheckAtMs: 6_000,
    maxHoldMs: 15_000,
  }],
};

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

  // A loss visible at the six-second checkpoint triggers XLEG loss exit.
  trade(70, 7_000);
  await new Promise((resolve) => setImmediate(resolve));
  const closed = store.liveTradingDashboard({ strategyId: 'post_gd25_35_xleg' }).positions[0];
  assert.strictEqual(closed.status, 'CLOSED');
  assert.strictEqual(closed.exit_reason, 'LOSS_CHECK');

  // The same mint never creates a second live episode.
  trade(100, 8_000);
  trade(70, 8_300);
  trade(72, 8_600);
  await manager.entryQueue;
  assert.strictEqual(
    store.liveTradingDashboard({ strategyId: 'post_gd25_35_xleg' }).decisions.length,
    1,
  );

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

  await manager.stop();
  store.close();
  fs.rmSync(temp, { recursive: true, force: true });
    console.log('post-migration live tests passed');
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
