'use strict';

const assert = require('node:assert/strict');
const LiveAccountRecovery = require('../src/core/LiveAccountRecovery');
const LiveTradingManager = require('../src/core/LiveTradingManager');

function fixture({ enabled = true, initial = [], mode = 'LIVE' } = {}) {
  let now = 2_000_000;
  const events = [];
  const rows = new Map(initial.map(row => [row.id, { ...row }]));
  const state = { busy: false, allowed: true, sends: 0, result: { status: 'CONFIRMED',
    refundLamports: '1887234', networkFeeSol: 0.000105, walletSolDelta: 0.001782234 } };
  const store = {
    liveAccountRecoveryPendingLocks() {
      return [...rows.values()].filter(r => ['PREPARED', 'UNKNOWN'].includes(r.status));
    },
    liveAccountRecoveryCandidates({ now: at, limit }) {
      return [...rows.values()].filter(r => ['PENDING', 'PREPARED', 'UNKNOWN'].includes(r.status)
        && !(r.next_attempt_at > at)).slice(0, limit).map(r => ({ ...r }));
    },
    updateLiveAccountRecovery(id, patch) {
      events.push(`save:${patch.status}`);
      const map = { preparedJson: 'prepared_json', nextAttemptAt: 'next_attempt_at', errorStage: 'error_stage',
        refundLamports: 'refund_lamports', networkFeeSol: 'network_fee_sol', walletSolDelta: 'wallet_sol_delta' };
      const row = rows.get(id);
      for (const [key, value] of Object.entries(patch)) row[map[key] || key] = value;
      return { ...row };
    },
    liveAccountRecoveryMintBlocked() { return state.busy; },
    liveAccountFundingBackfillOrders() { return []; },
    recordLiveAccountFunding(id, settlement) { events.push(`funding:${id}`); },
  };
  const executor = {
    async prepareEmptyTokenAccountClose(c) {
      events.push('prepare');
      return { status: 'READY', signature: `close-${c.address}`, rawTransactionBase64: 'offline-only',
        account: c.address, mint: c.mint, owner: c.owner, programId: c.programId,
        sourceSignature: c.sourceSignature, blockhash: 'fake', lastValidBlockHeight: 10,
        expectedRefundLamports: c.fundedLamports, estimatedFeeLamports: '105000' };
    },
    async sendPreparedTokenAccountClose(p) {
      events.push('send'); state.sends++;
      assert([...rows.values()].some(r => r.signature === p.signature && r.status === 'PREPARED'));
      if (state.sendError) throw new Error('offline-timeout');
      return p.signature;
    },
    async reconcileTokenAccountClose() { events.push('reconcile'); return state.result; },
    async transactionSettlement() { return { accountFunding: { verified: true } }; },
  };
  const make = () => new LiveAccountRecovery({ config: { enabled, batchSize: 3 }, store, executor,
    mode, now: () => now, isMintBusy: () => state.busy, canRun: () => state.allowed });
  const worker = make();
  return { rows, events, state, store, executor, worker, make,
    advance() { now += 60_001; } };
}

function candidate(id = 1, mint = 'mint-1') {
  return { id, status: 'PENDING', mint, account_address: `ata-${id}`, owner: 'owner',
    token_program: 'token', creation_signature: `buy-${id}`, position_id: id,
    funded_lamports: '1887234', created_at: 1, attempts: 0 };
}

async function main() {
  {
    const f = fixture({ initial: [candidate()] });
    const prepare = f.executor.prepareEmptyTokenAccountClose;
    f.executor.prepareEmptyTokenAccountClose = async () => {
      f.events.push('prepare-unavailable');
      throw Object.assign(new Error('Cleanup quote unavailable'), { code: 'CLEANUP_FEE_UNAVAILABLE', recoveryStage: 'FEE_QUOTE' });
    };
    f.worker.start(); await f.worker.tick();
    assert.equal(f.state.sends, 0);
    assert.equal(f.rows.get(1).status, 'PENDING');
    assert.equal(f.rows.get(1).signature, undefined);
    assert.equal(f.rows.get(1).attempts, 0, 'no signed/broadcast attempt took place');
    assert.equal(f.rows.get(1).error, 'CLEANUP_FEE_UNAVAILABLE');
    assert.equal(f.rows.get(1).error_stage, 'FEE_QUOTE');
    assert.equal(f.worker.health().status, 'DEGRADED');
    assert.equal(f.worker.health().lastRunErrors, 1);
    assert.equal(f.worker.health().lastErrorStage, 'FEE_QUOTE');
    assert(!f.worker.blocksMint('mint-1'), 'unsigned failure must not retain entry lock');
    await f.worker.tick();
    assert.equal(f.events.filter(item => item === 'prepare-unavailable').length, 1, 'wait for normal bounded maintenance interval');
    f.executor.prepareEmptyTokenAccountClose = prepare;
    f.advance(); await f.worker.tick();
    assert.equal(f.state.sends, 1);
    assert.equal(f.rows.get(1).status, 'CONFIRMED');
    assert.equal(f.rows.get(1).error, null); assert.equal(f.rows.get(1).error_stage, null);
    assert.equal(f.worker.health().lastRunErrors, 0);
    assert.equal(f.worker.health().status, 'READY');
    await f.worker.stop();
  }
  {
    const f = fixture({ initial: [candidate()] }); f.worker.start(); await f.worker.tick();
    assert.equal(f.state.sends, 1);
    assert(f.events.indexOf('save:PREPARED') < f.events.indexOf('send'));
    assert.equal(f.rows.get(1).status, 'CONFIRMED');
    assert.equal(f.rows.get(1).refund_lamports, '1887234');
    assert.equal(f.worker.blocksMint('mint-1'), false);
    f.advance(); await f.worker.tick(); assert.equal(f.state.sends, 1);
    await f.worker.stop();
  }
  {
    const f = fixture({ initial: [candidate()] }); f.state.busy = true;
    f.worker.start(); await f.worker.tick(); assert(!f.events.includes('prepare'));
    await f.worker.stop();
  }
  {
    const f = fixture({ initial: [candidate(), candidate(2)] });
    f.state.sendError = true; f.worker.start(); await f.worker.tick();
    assert.equal(f.state.sends, 1, 'same-Mint second candidate must not broadcast');
    assert(f.worker.blocksMint('mint-1'));
    await f.worker.stop();
    const restarted = f.make(); restarted.start();
    assert(restarted.blocksMint('mint-1'), 'restore durable locks synchronously');
    f.advance(); f.state.allowed = false; await restarted.tick();
    assert.equal(f.state.sends, 1, 'unknown never sends another transaction');
    assert.equal(f.rows.get(1).status, 'CONFIRMED');
    assert(!restarted.blocksMint('mint-1'));
    await restarted.stop();
  }
  {
    const f = fixture({ initial: [candidate()] });
    f.store.updateLiveAccountRecovery = () => { throw new Error('offline-disk-error'); };
    f.worker.start(); await f.worker.tick(); assert.equal(f.state.sends, 0);
    await f.worker.stop();
  }
  {
    const f = fixture({ initial: [candidate()] });
    const save = f.store.updateLiveAccountRecovery;
    let fail = true;
    f.store.updateLiveAccountRecovery = (id, patch) => {
      const row = save(id, patch);
      if (patch.status === 'CONFIRMED' && fail) { fail = false; throw new Error('readback-error'); }
      return row;
    };
    f.worker.start(); await f.worker.tick();
    assert.equal(f.rows.get(1).status, 'CONFIRMED');
    assert(!f.worker.blocksMint('mint-1'), 'prune terminal lock after durable commit/readback error');
    f.advance(); await f.worker.tick(); assert.equal(f.state.sends, 1);
    await f.worker.stop();
  }
  for (const result of [
    { status: 'CONFIRMED', refundLamports: '1887234', walletSolDelta: 100, networkFeeSol: 0 },
    { status: 'FAILED', walletSolDelta: 0.000105, networkFeeSol: -0.000105 },
    { status: 'UNVERIFIED' },
  ]) {
    const f = fixture({ initial: [candidate()] }); f.state.result = result;
    f.worker.start(); await f.worker.tick();
    assert(f.worker.blocksMint('mint-1')); assert.notEqual(f.rows.get(1).status, 'CONFIRMED');
    await f.worker.stop();
  }
  {
    const f = fixture({ initial: [candidate()] }); f.state.result = { status: 'FAILED',
      walletSolDelta: -0.000105, networkFeeSol: 0.000105 };
    f.worker.start(); await f.worker.tick();
    assert.equal(f.rows.get(1).status, 'BLOCKED');
    assert.equal(f.rows.get(1).network_fee_sol, 0.000105);
    f.advance(); await f.worker.tick(); assert.equal(f.state.sends, 1);
    await f.worker.stop();
  }
  {
    const f = fixture({ initial: [candidate()] }); f.state.result = { status: 'EXPIRED' };
    f.worker.start(); await f.worker.tick();
    assert.equal(f.rows.get(1).status, 'BLOCKED'); assert(!f.worker.blocksMint('mint-1'));
    await f.worker.stop();
  }
  {
    const f = fixture({ initial: [candidate()] });
    const prepare = f.executor.prepareEmptyTokenAccountClose;
    f.executor.prepareEmptyTokenAccountClose = async c => { f.state.busy = true; return prepare(c); };
    f.worker.start(); await f.worker.tick(); assert.equal(f.state.sends, 0);
    assert(!f.worker.blocksMint('mint-1')); await f.worker.stop();
  }
  {
    const f = fixture({ initial: [candidate()] });
    const prepare = f.executor.prepareEmptyTokenAccountClose;
    f.executor.prepareEmptyTokenAccountClose = async c => ({ ...await prepare(c), owner: 'foreign' });
    f.worker.start(); await f.worker.tick(); assert.equal(f.state.sends, 0); await f.worker.stop();
  }
  {
    const f = fixture({ initial: [candidate()], enabled: false });
    f.worker.start(); await f.worker.tick(); assert.equal(f.events.length, 0); await f.worker.stop();
    const dry = fixture({ initial: [candidate()], mode: 'DRY_RUN' });
    dry.worker.start(); await dry.worker.tick(); assert.equal(dry.events.length, 0);
  }
  {
    const f = fixture(); f.worker.start();
    f.store.liveAccountRecoveryPendingLocks = () => { throw new Error('offline-SQLITE_BUSY'); };
    await f.worker.tick(); assert(f.worker.blocksMint('unrelated-mint'));
    f.store.liveAccountRecoveryPendingLocks = () => [];
    f.advance(); await f.worker.tick(); assert(!f.worker.blocksMint('unrelated-mint'));
    await f.worker.stop();
  }
  {
    const f = fixture(); f.store.liveAccountRecoveryPendingLocks = () => [{ id: 1, status: 'UNKNOWN' }];
    f.worker.start(); assert(f.worker.blocksMint('any')); await f.worker.stop();
    const g = fixture(); delete g.store.updateLiveAccountRecovery; g.worker.start();
    assert(g.worker.blocksMint('any')); await g.worker.stop();
  }
  {
    const f = fixture(); const seen = [];
    f.store.liveAccountFundingBackfillOrders = ({ afterId }) => {
      seen.push(afterId); return Object.assign([], { lastScannedId: afterId + 3, hasMore: true });
    };
    f.worker.start(); await f.worker.tick(); f.advance(); await f.worker.tick();
    assert.deepEqual(seen, [0, 3], 'empty filtered page still advances bounded scan cursor');
    await f.worker.stop();
  }
  {
    const manager = new LiveTradingManager({ config: { enabled: true, dryRun: false,
      strategies: [], lossRugFeedback: { enabled: false } }, store: {}, executor: {} });
    manager.accountRecovery.locks.set(1, 'mint');
    assert.equal(manager._riskReason({ market: 'PUMP_BONDING_CURVE', mint: 'mint' }),
      'TOKEN_ACCOUNT_RECOVERY_PENDING');
    await manager.stop();
  }
  console.log('live account recovery coordinator: safe durable outbox, locks, accounting, restart, bounded backfill passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
