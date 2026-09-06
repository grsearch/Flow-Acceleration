'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { ResearchStore } = require('../src/data/ResearchStore');
const { exportResearchWindow } = require('./export-research-window');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-recovery-store-'));
const source = path.join(directory, 'source.db');
const store = new ResearchStore({ dbPath: source, archiveDir: directory, flushMs: 60_000, flushMax: 1000 }, { configuredTradingCostPct: 0 });
const owner = Keypair.fromSeed(Buffer.alloc(32, 1)).publicKey.toBase58();
const mint = Keypair.fromSeed(Buffer.alloc(32, 2)).publicKey.toBase58();
const program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ata = PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()],
  new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0].toBase58();
const T = 1_900_000_000_000;
const FUND = '2039280'; const F = Number(FUND) / 1e9;
function position(id, status = 'CLOSED', strategy = 'test') {
  store.db.prepare(`INSERT INTO live_positions(id,mint,strategy_id,mode,status,position_sol,opened_at,closed_at,created_at,updated_at)
    VALUES(?,?,?,'LIVE',?,0.02,?,?,?,?)`).run(id, mint, strategy, status, T - 10_000, status === 'CLOSED' ? T : null, T - 10_000, T);
}
function receipt(signature, funding = 0, created = false) {
  const before = created ? '0' : FUND;
  const after = created ? FUND : funding < 0 ? '0' : FUND;
  return { wallet: owner, transactionSlot: 100, walletSolDelta: created ? -0.02 - F - 0.0001 : 0.018 - 0.0001,
    networkFeeSol: 0.0001, accountFunding: { version: 'TOKEN_ACCOUNT_FUNDING_V1', verified: true,
      owner, sourceSignature: signature, netFundingLamports: funding > 0 ? FUND : funding < 0 ? `-${FUND}` : '0',
      accounts: [{ address: ata, mint, owner, programId: program, preLamports: before, postLamports: after,
        deltaLamports: funding > 0 ? FUND : funding < 0 ? `-${FUND}` : '0', created, closed: funding < 0,
        creationVerified: created, sourceSignature: signature, preTokenRaw: created ? '0' : '100', postTokenRaw: '0' }] } };
}
function order(id, side, signature, settlement) {
  return store.recordLiveOrder({ positionId: id, strategyId: id === 2 ? 'other' : 'test', mint, side,
    status: 'CONFIRMED', signature, walletSolDelta: settlement?.walletSolDelta, networkFeeSol: settlement?.networkFeeSol,
    execution: settlement ? { sentinel: 'preserve', settlement } : null, confirmedAt: T });
}
const p = id => store.db.prepare('SELECT * FROM live_positions WHERE id=?').get(id);
const candidate = id => store.db.prepare('SELECT * FROM live_account_recoveries WHERE position_id=?').get(id);
const approx = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} vs ${expected}`);
try {
  position(1);
  const buy = receipt('buy-1', 1, true); const sell = receipt('sell-1');
  const buyId = order(1, 'BUY', 'buy-1', buy); order(1, 'SELL', 'sell-1', sell);
  const original = store.refreshLivePositionSettlement(1);
  assert.equal(original.complete, true);
  approx(p(1).realized_pnl_sol, buy.walletSolDelta + sell.walletSolDelta);
  approx(p(1).economic_pnl_sol, original.realizedPnlSol + F);
  approx(p(1).economic_cost_basis_sol, 0.0201);
  approx(p(1).economic_return_pct, p(1).economic_pnl_sol / p(1).economic_cost_basis_sol * 100);
  approx(p(1).account_retained_funding_sol, F);
  assert.equal(candidate(1).funded_lamports, FUND);
  store.recordLiveAccountFunding(buyId, buy);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM live_account_recoveries').get().n, 1, 'duplicate funding must not add a second refund candidate');
  assert.equal(store.liveAccountRecoveryMintBlocked(mint), false);
  position(2, 'OPEN', 'other');
  assert.equal(store.liveAccountRecoveryMintBlocked(mint), true);
  const secondBuy = receipt('buy-2'); secondBuy.walletSolDelta = -0.0201;
  order(2, 'BUY', 'buy-2', secondBuy); order(2, 'SELL', 'sell-2', receipt('sell-2'));
  store.db.prepare("UPDATE live_positions SET status='CLOSED' WHERE id=2").run();
  store.refreshLivePositionSettlement(2);
  assert.equal(candidate(2), undefined, 'shared ATA not recreated incurs no new funding candidate');
  approx(p(2).account_net_funding_sol, 0);
  const recovery = candidate(1);
  store.updateLiveAccountRecovery(recovery.id, { status: 'PENDING', error: 'CLEANUP_FEE_UNAVAILABLE', errorStage: 'FEE_QUOTE' });
  const pendingDisplay = store.liveTradingDashboard({ strategyId: 'test' }).positions.find(row => row.id === 1);
  assert.deepEqual(pendingDisplay.account_recovery_states, { PENDING: 1 });
  assert.equal(pendingDisplay.account_recovery_error, 'CLEANUP_FEE_UNAVAILABLE');
  assert.equal(pendingDisplay.account_recovery_error_stage, 'FEE_QUOTE');
  approx(pendingDisplay.economic_cost_basis_sol, 0.0201);
  assert.equal(pendingDisplay.economic_verified, true, 'unsigned pending refund does not erase verified account assets');
  const pendingPerformance = store.liveTradingDashboard({ strategyId: 'test' }).performance;
  assert.equal(pendingPerformance.status, 'COMPLETE');
  approx(pendingPerformance.total_pnl_sol, original.realizedPnlSol + F);
  approx(pendingDisplay.cash_after_recovery_pnl_sol, original.realizedPnlSol, 'pending funds are not a cash refund');
  approx(pendingDisplay.recovery_refund_sol, 0);
  const prepared = { signature: 'close-1', rawTransactionBase64: 'fixture-only', account: ata };
  const syncBefore = store.db.pragma('synchronous', { simple: true });
  const saved = store.updateLiveAccountRecovery(recovery.id, { status: 'PREPARED', signature: 'close-1', preparedJson: JSON.stringify(prepared), attempts: 1, error: null, errorStage: null });
  assert.equal(saved.prepared_json, JSON.stringify(prepared));
  assert.equal(store.db.pragma('synchronous', { simple: true }), syncBefore);
  const independent = new Database(source, { readonly: true });
  assert.equal(independent.prepare('SELECT signature FROM live_account_recoveries WHERE id=?').get(recovery.id).signature, 'close-1');
  independent.close();
  assert.equal(store.liveAccountRecoveryPendingLocks().length, 1);
  assert.throws(() => store.updateLiveAccountRecovery(recovery.id, { status: 'PENDING' }), /unsigned pending/);
  assert.equal(p(1).economic_pnl_sol, null, 'prepared/unknown close cannot claim fully reconciled economic PnL');
  assert.equal(store.liveTradingDashboard({ strategyId: 'test' }).performance.verified_closed_positions, 0);
  assert.equal(store.liveTradingDashboard({ strategyId: 'test' }).performance.total_pnl_sol, null);
  assert.throws(() => store.updateLiveAccountRecovery(recovery.id, { signature: 'another-close' }), /immutable/);
  const close = { status: 'CONFIRMED', refundLamports: FUND, networkFeeSol: 0.000105,
    walletSolDelta: F - 0.000105, nextAttemptAt: null };
  store.updateLiveAccountRecovery(recovery.id, close);
  store.updateLiveAccountRecovery(recovery.id, close);
  assert.equal(store.liveAccountRecoveryPendingLocks().length, 0);
  approx(p(1).realized_pnl_sol, original.realizedPnlSol, 'cash semantics unchanged');
  approx(p(1).economic_pnl_sol, original.realizedPnlSol + F - 0.000105);
  approx(p(1).cash_after_recovery_pnl_sol, original.realizedPnlSol + F - 0.000105);
  approx(p(1).account_retained_funding_sol, 0);
  approx(p(1).recovery_refund_sol, F);
  const confirmedDisplay = store.liveTradingDashboard({ strategyId: 'test' }).positions.find(row => row.id === 1);
  assert.deepEqual(confirmedDisplay.account_recovery_states, { CONFIRMED: 1 });
  assert.equal(confirmedDisplay.account_recovery_error, null);
  assert.equal(confirmedDisplay.account_recovery_error_stage, null);
  assert.equal(confirmedDisplay.economic_verified, true);
  const confirmedPerformance = store.liveTradingDashboard({ strategyId: 'test' }).performance;
  approx(confirmedPerformance.total_pnl_sol, pendingPerformance.total_pnl_sol - 0.000105);
  assert.equal(confirmedPerformance.status, 'COMPLETE', 'refund is not counted twice as economic profit');
  approx(p(2).recovery_refund_sol, 0, 'refund stays with creator position, not later shared-ATA trader');
  assert.throws(() => store.updateLiveAccountRecovery(recovery.id, { status: 'PENDING' }), /transition/);
  store.updateLiveOrder(buyId, { execution: { extra: true, settlement: { transactionSlot: 100 } } });
  assert.equal(JSON.parse(store.db.prepare('SELECT execution_json FROM live_orders WHERE id=?').get(buyId).execution_json).settlement.accountFunding.verified, true);
  position(3); order(3, 'BUY', 'old-buy', { walletSolDelta: -0.022, networkFeeSol: 0.0001 });
  order(3, 'SELL', 'old-sell', { walletSolDelta: 0.017, networkFeeSol: 0.0001 }); store.refreshLivePositionSettlement(3);
  assert.equal(p(3).account_funding_complete, 0); assert.equal(p(3).economic_pnl_sol, null);
  assert.equal(p(3).account_net_funding_sol, null, 'old unknown must not infer zero or constant rent');
  const page1 = store.liveAccountFundingBackfillOrders({ afterId: 0, limit: 2 });
  assert.equal(page1.length, 0); assert.equal(page1.hasMore, true); assert.equal(page1.lastScannedId, 2);
  const page2 = store.liveAccountFundingBackfillOrders({ afterId: page1.lastScannedId, limit: 10 });
  assert(page2.some(row => row.signature === 'old-buy'));
  position(4); const bogus = receipt('fake-buy', 1, true); bogus.accountFunding.accounts[0].address = owner;
  order(4, 'BUY', 'fake-buy', bogus); assert.equal(candidate(4), undefined);
  position(5); const newer = receipt('buy-5', 1, true); newer.transactionSlot = 200;
  order(5, 'BUY', 'buy-5', newer); order(5, 'SELL', 'sell-5', receipt('sell-5')); store.refreshLivePositionSettlement(5);
  position(6); const newest = receipt('buy-6', 1, true); newest.transactionSlot = 300;
  order(6, 'BUY', 'buy-6', newest); order(6, 'SELL', 'sell-6', receipt('sell-6')); store.refreshLivePositionSettlement(6);
  assert.equal(candidate(5).status, 'BLOCKED'); assert.equal(candidate(5).error, 'SUPERSEDED_ACCOUNT_CREATION');
  assert.equal(p(5).economic_pnl_sol, null, 'missing previous-incarnation refund remains unknown');
  assert.equal(candidate(6).status, 'PENDING');
  const r6 = candidate(6);
  store.updateLiveAccountRecovery(r6.id, { status: 'PREPARED', signature: 'close-6', prepared: { ...prepared, signature: 'close-6' } });
  store.updateLiveAccountRecovery(r6.id, { status: 'BLOCKED', refundLamports: '0', networkFeeSol: 0.000105,
    walletSolDelta: -0.000105, error: 'CLOSE_TRANSACTION_FAILED', nextAttemptAt: null });
  approx(p(6).economic_pnl_sol, p(6).realized_pnl_sol + F - 0.000105, 'failed cleanup still costs a fee');
  position(7); const absent = receipt('buy-7', 1, true); absent.transactionSlot = 400;
  order(7, 'BUY', 'buy-7', absent); order(7, 'SELL', 'sell-7', receipt('sell-7')); store.refreshLivePositionSettlement(7);
  store.updateLiveAccountRecovery(candidate(7).id, { status: 'ABSENT', error: 'ACCOUNT_ALREADY_ABSENT_REFUND_UNATTRIBUTED' });
  assert.equal(p(7).economic_pnl_sol, null); assert.equal(p(7).account_retained_funding_sol, null);
  approx(p(7).recovery_refund_sol, 0);
  position(8); const duplicateOrder = order(8, 'BUY', 'buy-1', buy);
  assert.equal(candidate(1).position_id, 1); assert.equal(candidate(8), undefined);
  assert.equal(p(1).economic_pnl_sol, null, 'cross-position duplicated receipt invalidates economic aggregate rather than counting funding twice');
  assert.equal(store.db.prepare('SELECT account_funding_verified FROM live_orders WHERE id=?').get(duplicateOrder).account_funding_verified, 1);
  position(9); const generation9 = receipt('buy-9', 1, true); generation9.transactionSlot = 500;
  order(9, 'BUY', 'buy-9', generation9); order(9, 'SELL', 'sell-9', receipt('sell-9'));
  // The close transaction predates the newest creation, despite its late local arrival.
  position(10); const oldClose = receipt('late-old-close', -1); oldClose.transactionSlot = 350;
  order(10, 'SELL', 'late-old-close', oldClose);
  assert.equal(candidate(9).status, 'PENDING', 'late old close cannot consume the newer ATA incarnation');
  const r9 = candidate(9);
  store.updateLiveAccountRecovery(r9.id, { status: 'PREPARED', signature: 'close-9',
    prepared: { ...prepared, signature: 'close-9', expectedRefundLamports: FUND }, nextAttemptAt: T + 100 });
  position(11); const generation11 = receipt('buy-11', 1, true); generation11.transactionSlot = 600;
  order(11, 'BUY', 'buy-11', generation11);
  assert.equal(store.liveAccountRecoveryCandidates({ now: T + 200, limit: 1 })[0].id, r9.id,
    'signed reconciliation outranks unsigned candidates even if pending has next_attempt_at=0');
  // Account-funding sidecar errors cannot turn a confirmed trade into a failed order.
  position(12);
  const originalFunding = store.recordLiveAccountFunding;
  store.recordLiveAccountFunding = () => { const error = new Error('fixture lock'); error.code = 'SQLITE_BUSY'; throw error; };
  const sidecarBuy = { ...receipt('sidecar-buy'), walletSolDelta: -0.0201 };
  const safeOrder = order(12, 'BUY', 'sidecar-buy', sidecarBuy);
  assert.equal(store.db.prepare('SELECT status FROM live_orders WHERE id=?').get(safeOrder).status, 'CONFIRMED');
  assert(store.liveAccountFundingWriteHealth().errors > 0);
  assert(store.liveAccountFundingBackfillOrders({ afterId: safeOrder - 1, limit: 1 }).some(row => row.id === safeOrder));
  store.recordLiveAccountFunding = originalFunding;
  store.recordLiveAccountFunding(safeOrder, sidecarBuy);
  assert.equal(store.db.prepare('SELECT account_funding_verified FROM live_orders WHERE id=?').get(safeOrder).account_funding_verified, 1);
  const originalEconomic = store.refreshLivePositionAccountFunding;
  store.refreshLivePositionAccountFunding = () => { throw new Error('fixture economic write'); };
  order(12, 'SELL', 'sidecar-sell', receipt('sidecar-sell'));
  const safeTotals = store.refreshLivePositionSettlement(12);
  assert.equal(safeTotals.complete, true);
  assert.equal(store.liveTradingDashboard({ strategyId: 'test' }).positions.find(row => row.id === 12).economic_pnl_sol, null,
    'stale economic snapshot must not be displayed against a newer cash settlement');
  store.refreshLivePositionAccountFunding = originalEconomic;
  store.recordLiveAccountFunding(safeOrder, sidecarBuy);
  // A same-position SELL closes only one of two funded ATAs: its negative
  // funding already sits in the net, so do not subtract that refund twice.
  position(13);
  const multiBuy = receipt('multi-buy', 1, true); multiBuy.transactionSlot = 700;
  const extraMint = Keypair.fromSeed(Buffer.alloc(32, 3)).publicKey.toBase58();
  const extraAta = PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(extraMint).toBuffer()],
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0].toBase58();
  multiBuy.accountFunding.accounts.push({ ...multiBuy.accountFunding.accounts[0], address: extraAta, mint: extraMint });
  multiBuy.accountFunding.netFundingLamports = String(2n * BigInt(FUND));
  multiBuy.walletSolDelta -= F;
  order(13, 'BUY', 'multi-buy', multiBuy);
  const multiSell = receipt('multi-sell', -1); multiSell.transactionSlot = 701; multiSell.walletSolDelta += F;
  order(13, 'SELL', 'multi-sell', multiSell); store.refreshLivePositionSettlement(13);
  approx(p(13).account_retained_funding_sol, F, 'the second still-funded account remains an asset');
  assert.equal(candidate(13).status, 'ABSENT');
  const dash = store.liveTradingDashboard({ strategyId: 'test' });
  assert.equal(dash.accountRecovery.summary.economic_pnl_sol, null, 'partial verified subset is not a complete portfolio total');
  assert(!JSON.stringify(dash.accountRecovery).includes('fixture-only'), 'signed payload never goes to Dashboard');
  assert(dash.accountRecovery.cases.length <= 20);
  const exportStart = Date.now() - 1000;
  const manifest = exportResearchWindow({ sourcePath: source, destinationPath: path.join(directory, 'export.db'),
    startMs: exportStart, endMs: Date.now() + 1000 });
  assert.equal(manifest.liveAccountRecovery.included, true);
  assert.match(manifest.liveAccountRecovery.temporalScope, /never permission to broadcast/);
  const exported = new Database(path.join(directory, 'export.db'), { readonly: true });
  assert(exported.prepare('SELECT COUNT(*) n FROM live_account_recoveries').get().n >= 4);
  assert(exported.prepare('SELECT COUNT(*) n FROM live_positions WHERE id=1').get().n === 1);
  exported.close();
  // The independent Dashboard can briefly serve yesterday's read-only schema.
  // Diagnostics missing from that snapshot must degrade to null, not SQL error.
  store.db.exec('ALTER TABLE live_account_recoveries DROP COLUMN error_stage');
  store.db.exec('ALTER TABLE live_positions DROP COLUMN economic_cost_basis_sol');
  const oldSchema = new Database(source, { readonly: true });
  const oldReader = Object.create(ResearchStore.prototype); oldReader.db = oldSchema;
  try {
    const oldStates = oldReader.liveAccountRecoveryPositionStates([1, 6]);
    assert.deepEqual(oldStates.get(1).account_recovery_states, { CONFIRMED: 1 });
    assert.equal(oldStates.get(6).account_recovery_error_stage, null);
    assert.equal(oldReader.liveAccountRecoveryDashboard('test').available, true);
    const oldPage = store.liveTradingDashboard({ strategyId: 'test' });
    assert(oldPage.positions.length > 0);
    assert(oldPage.positions.every(row => row.account_recovery_error_stage == null));
  } finally { oldSchema.close(); }
  store.db.exec('DROP TABLE live_account_recoveries');
  assert.equal(store.liveAccountRecoveryDashboard('test').available, false);
  assert.equal(store.liveAccountRecoveryPositionStates([1]).size, 0, 'absent ledger means unknown, not completed');
  console.log('Live account recovery Store tests passed: verified funding, durable outbox, refund idempotency, shared ATA generations, cash/economic separation, unknown legacy, export.');
} finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
