'use strict';

const { PublicKey } = require('@solana/web3.js');
const VERSION = 'TOKEN_ACCOUNT_FUNDING_V1';
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const ASSOCIATED = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const WSOL = 'So11111111111111111111111111111111111111112';
const TERMINAL = new Set(['CONFIRMED', 'ABSENT', 'BLOCKED']);
const STATES = new Set([...TERMINAL, 'PENDING', 'PREPARED', 'UNKNOWN']);
const parsed = value => { try { return JSON.parse(value || 'null'); } catch (_) { return null; } };
const bigint = value => typeof value === 'string' && /^-?\d+$/.test(value) ? BigInt(value) : null;
const sol = value => Number(value) / 1e9;
const canonical = account => {
  try { return TOKEN_PROGRAMS.has(account.programId) && account.mint !== WSOL
    && PublicKey.findProgramAddressSync([new PublicKey(account.owner).toBuffer(),
      new PublicKey(account.programId).toBuffer(), new PublicKey(account.mint).toBuffer()], ASSOCIATED)[0].toBase58() === account.address; }
  catch (_) { return false; }
};

function validateFunding(settlement, signature) {
  const funding = settlement?.accountFunding;
  if (funding?.version !== VERSION || funding.verified !== true || !signature
    || !funding.owner || settlement.wallet !== funding.owner || !Array.isArray(funding.accounts)
    || funding.sourceSignature !== signature) return null;
  const net = bigint(funding.netFundingLamports);
  if (net == null || funding.accounts.length > 32) return null;
  let sum = 0n;
  const seen = new Set();
  for (const account of funding.accounts) {
    const pre = bigint(account.preLamports); const post = bigint(account.postLamports);
    const delta = bigint(account.deltaLamports);
    if (!canonical(account) || account.owner !== funding.owner || pre == null || post == null
      || pre < 0n || post < 0n || pre > BigInt(Number.MAX_SAFE_INTEGER) || post > BigInt(Number.MAX_SAFE_INTEGER)
      || delta == null || post - pre !== delta || seen.has(account.address)
      || account.sourceSignature && account.sourceSignature !== signature) return null;
    if (account.created === true && !(pre === 0n && post > 0n)) return null;
    if (account.closed === true && !(pre > 0n && post === 0n)) return null;
    seen.add(account.address); sum += delta;
  }
  return sum === net ? funding : null;
}

const liveAccountRecoveryMethods = {
  _safeLiveAccountFunding(callback) {
    try { return this.withLiveLossRugWrite(callback); }
    catch (error) {
      const state = this.accountFundingDiagnostics ||= { errors: 0, lastError: null, lastErrorAt: null };
      state.errors += 1;
      state.lastError = String(error?.code || error?.name || 'ACCOUNT_FUNDING_ERROR').slice(0, 100);
      state.lastErrorAt = Date.now();
      return null;
    }
  },

  liveAccountFundingWriteHealth() {
    return { ...(this.accountFundingDiagnostics || { errors: 0, lastError: null, lastErrorAt: null }) };
  },

  _ensureLiveAccountRecoverySchema() {
    const ensure = (table, name, definition) => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    };
    ensure('live_orders', 'account_funding_verified', 'INTEGER');
    ensure('live_orders', 'account_net_funding_lamports', 'TEXT');
    for (const name of ['account_net_funding_sol', 'account_retained_funding_sol', 'economic_pnl_sol',
      'economic_return_pct', 'economic_cost_basis_sol', 'recovery_refund_sol', 'recovery_network_fee_sol', 'cash_after_recovery_pnl_sol', 'account_funding_cash_pnl_sol']) ensure('live_positions', name, 'REAL');
    ensure('live_positions', 'account_funding_complete', 'INTEGER');
    ensure('live_positions', 'account_recovery_complete', 'INTEGER');
    this.db.exec(`CREATE TABLE IF NOT EXISTS live_account_recoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_address TEXT NOT NULL, mint TEXT NOT NULL,
      owner TEXT NOT NULL, token_program TEXT NOT NULL, creation_signature TEXT NOT NULL,
      position_id INTEGER NOT NULL, funded_lamports TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
      creation_order_id INTEGER, creation_slot INTEGER,
      trading_close_order_id INTEGER, trading_close_position_id INTEGER,
      prepared_json TEXT, signature TEXT, refund_lamports TEXT, network_fee_sol REAL, wallet_sol_delta REAL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER DEFAULT 0, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(account_address, creation_signature)
    );
    CREATE INDEX IF NOT EXISTS idx_live_account_recoveries_due ON live_account_recoveries(next_attempt_at,id)
      WHERE status IN ('PENDING','PREPARED','UNKNOWN');
    CREATE INDEX IF NOT EXISTS idx_live_account_recoveries_position ON live_account_recoveries(position_id,id);
    CREATE INDEX IF NOT EXISTS idx_live_account_recoveries_status ON live_account_recoveries(status,id);
    CREATE INDEX IF NOT EXISTS idx_live_account_recoveries_status_due ON live_account_recoveries(status,next_attempt_at,id);
    CREATE INDEX IF NOT EXISTS idx_live_account_recoveries_updated ON live_account_recoveries(updated_at,id);
    CREATE INDEX IF NOT EXISTS idx_live_orders_account_funding_backfill ON live_orders(id)
      WHERE signature IS NOT NULL AND side IN ('BUY','SELL');
    CREATE INDEX IF NOT EXISTS idx_live_orders_signature_position ON live_orders(signature,position_id,id);
    CREATE INDEX IF NOT EXISTS idx_live_orders_mint_status ON live_orders(mint,status,id);`);
    ensure('live_account_recoveries', 'error_stage', 'TEXT');
  },

  liveAccountRecoveryCandidates({ now = Date.now(), limit = 10 } = {}) {
    const n = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 10)));
    const query = this.db.prepare(`SELECT * FROM live_account_recoveries INDEXED BY idx_live_account_recoveries_status_due
      WHERE status=? AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT ?`);
    // Reconcile possibly broadcast bytes before unsigned work, also when new
    // cleanup is disabled. Each status range is index ordered before LIMIT.
    const signed = [...query.all('PREPARED', now, n), ...query.all('UNKNOWN', now, n)]
      .sort((a, b) => a.next_attempt_at - b.next_attempt_at || a.id - b.id).slice(0, n);
    return signed.length === n ? signed : [...signed, ...query.all('PENDING', now, n - signed.length)];
  },

  liveAccountRecoveryPendingLocks() {
    return this.db.prepare(`SELECT id,mint,account_address,signature,status FROM live_account_recoveries
      WHERE status IN ('PREPARED','UNKNOWN') ORDER BY id`).all();
  },

  liveAccountRecoveryMintBlocked(mint) {
    if (this.db.prepare(`SELECT 1 FROM live_positions WHERE mint=? AND mode='LIVE'
      AND status NOT IN ('CLOSED','ENTRY_FAILED') LIMIT 1`).get(mint)) return true;
    return Boolean(this.db.prepare(`SELECT 1 FROM live_orders o JOIN live_positions p ON p.id=o.position_id
      WHERE o.mint=? AND p.mode='LIVE' AND (o.status NOT IN ('CONFIRMED','FAILED','ALREADY_EMPTY')
        OR (o.signature IS NOT NULL AND o.wallet_sol_delta IS NULL)) LIMIT 1`).get(mint));
  },

  liveAccountFundingBackfillOrders({ afterId = 0, limit = 10 } = {}) {
    const n = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 10)));
    const scanned = this.db.prepare(`SELECT * FROM live_orders INDEXED BY idx_live_orders_account_funding_backfill
      WHERE signature IS NOT NULL AND side IN ('BUY','SELL') AND id>? ORDER BY id LIMIT ?`).all(afterId, n);
    const rows = scanned.filter(row => {
      const position = this.db.prepare("SELECT * FROM live_positions WHERE id=? AND mode='LIVE'").get(row.position_id);
      return position && (row.account_funding_verified !== 1 || position.account_funding_complete == null
        || position.account_funding_cash_pnl_sol !== position.realized_pnl_sol);
    });
    rows.lastScannedId = scanned.at(-1)?.id ?? afterId;
    rows.hasMore = scanned.length === n;
    return rows;
  },

  recordLiveAccountFunding(orderId, settlement) {
    return this.withLiveLossRugWrite(() => this._recordLiveAccountFunding(orderId, settlement));
  },

  _recordLiveAccountFunding(orderId, settlement) {
    return this.db.transaction(() => {
      const order = this.db.prepare('SELECT * FROM live_orders WHERE id=?').get(orderId);
      if (!order) throw new Error('Account funding order missing');
      const position = this.db.prepare('SELECT * FROM live_positions WHERE id=?').get(order.position_id);
      if (position?.mode !== 'LIVE') return order;
      const previous = parsed(order.execution_json) || {};
      const funding = validateFunding(settlement, order.signature);
      // Later incomplete RPC replies cannot erase already verified evidence.
      if (!funding && order.account_funding_verified === 1) return order;
      const execution = { ...previous, settlement: { ...(previous.settlement || {}), ...(settlement || {}) } };
      this.db.prepare(`UPDATE live_orders SET execution_json=?,account_funding_verified=?,account_net_funding_lamports=?,
        wallet_sol_delta=COALESCE(?,wallet_sol_delta),network_fee_sol=COALESCE(?,network_fee_sol),updated_at=? WHERE id=?`)
        .run(JSON.stringify(execution), funding ? 1 : 0, funding?.netFundingLamports ?? null,
          Number.isFinite(settlement?.walletSolDelta) ? settlement.walletSolDelta : null,
          Number.isFinite(settlement?.networkFeeSol) ? settlement.networkFeeSol : null, Date.now(), orderId);
      const touched = new Set([order.position_id, ...this.db.prepare('SELECT DISTINCT position_id FROM live_orders WHERE signature=?')
        .all(order.signature).map(row => row.position_id)]);
      if (funding && order.status === 'CONFIRMED' && order.side === 'BUY') {
        for (const account of funding.accounts) {
          if (account.created !== true || account.creationVerified !== true || account.mint !== order.mint
            || bigint(account.deltaLamports) <= 0n) continue;
          this.db.prepare(`INSERT INTO live_account_recoveries(account_address,mint,owner,token_program,
            creation_signature,position_id,funded_lamports,creation_order_id,creation_slot,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(account_address,creation_signature) DO NOTHING`).run(account.address, account.mint,
              account.owner, account.programId, order.signature, order.position_id, account.deltaLamports,
              order.id, Number.isSafeInteger(settlement.transactionSlot) ? settlement.transactionSlot : null, Date.now(), Date.now());
          const generations = this.db.prepare('SELECT * FROM live_account_recoveries WHERE account_address=? ORDER BY creation_order_id DESC,id DESC').all(account.address);
          const latest = [...generations].sort((a, b) => a.creation_slot != null && b.creation_slot != null
            ? b.creation_slot - a.creation_slot : (b.creation_order_id || 0) - (a.creation_order_id || 0))[0];
          for (const old of generations) {
            if (old.id === latest.id || old.status !== 'PENDING') continue;
            this.db.prepare("UPDATE live_account_recoveries SET status='BLOCKED',error='SUPERSEDED_ACCOUNT_CREATION',updated_at=? WHERE id=?")
              .run(Date.now(), old.id);
            touched.add(old.position_id);
          }
        }
      }
      // An ordinary SELL may close the ATA. Its refund is already inside the
      // original trade cash flow, and must not become a second cleanup refund.
      if (funding && order.status === 'CONFIRMED') for (const account of funding.accounts) {
        if (!account.closed) continue;
        const candidates = this.db.prepare(`SELECT * FROM live_account_recoveries WHERE account_address=?`).all(account.address)
          .filter(row => row.creation_slot != null && Number.isSafeInteger(settlement.transactionSlot)
            && row.creation_slot !== settlement.transactionSlot ? row.creation_slot < settlement.transactionSlot
              : row.creation_order_id <= order.id)
          .sort((a, b) => a.creation_slot != null && b.creation_slot != null && a.creation_slot !== b.creation_slot
            ? b.creation_slot - a.creation_slot : (b.creation_order_id || 0) - (a.creation_order_id || 0));
        for (const candidate of candidates.slice(0, 1)) {
          if (candidate.status !== 'PENDING' && !(candidate.status === 'BLOCKED' && candidate.error === 'SUPERSEDED_ACCOUNT_CREATION')) continue;
          this.db.prepare(`UPDATE live_account_recoveries SET status='ABSENT',refund_lamports=?,
            trading_close_order_id=?,trading_close_position_id=?,error='ACCOUNT_CLOSED_IN_TRADE',updated_at=? WHERE id=?`)
            .run(account.preLamports, order.id, order.position_id, Date.now(), candidate.id);
          touched.add(candidate.position_id);
        }
      }
      for (const id of touched) {
        this.refreshLivePositionSettlement(id, { refreshAccountFunding: false });
        this.refreshLivePositionAccountFunding(id);
      }
      return this.db.prepare('SELECT * FROM live_orders WHERE id=?').get(orderId);
    })();
  },

  updateLiveAccountRecovery(id, patch = {}) {
    if (this.db.inTransaction) throw new Error('Recovery signing state requires its own durable commit');
    const priorSync = this.db.pragma('synchronous', { simple: true });
    const priorBusy = this.db.pragma('busy_timeout', { simple: true });
    this.db.pragma('synchronous = FULL');
    if (priorBusy > 100) this.db.pragma('busy_timeout = 100');
    try {
      this.db.transaction(() => {
        const row = this.db.prepare('SELECT * FROM live_account_recoveries WHERE id=?').get(id);
        if (!row) throw new Error('Recovery candidate missing');
        const fields = { status: 'status', signature: 'signature', refundLamports: 'refund_lamports',
          networkFeeSol: 'network_fee_sol', walletSolDelta: 'wallet_sol_delta', attempts: 'attempts',
          nextAttemptAt: 'next_attempt_at', error: 'error', errorStage: 'error_stage', updatedAt: 'updated_at' };
        const update = { ...patch, updatedAt: Number.isFinite(patch.updatedAt) ? patch.updatedAt : Date.now() };
        if (patch.prepared !== undefined || patch.preparedJson !== undefined) {
          const prepared = patch.prepared ?? patch.preparedJson;
          update.preparedJson = typeof prepared === 'string' ? prepared : JSON.stringify(prepared);
          if (!parsed(update.preparedJson)) throw new Error('Malformed prepared recovery job');
          fields.preparedJson = 'prepared_json';
        }
        const status = update.status ?? row.status;
        if (!STATES.has(status) || TERMINAL.has(row.status) && status !== row.status) throw new Error('Invalid recovery state transition');
        if (['PREPARED','UNKNOWN'].includes(row.status) && status === 'PENDING') throw new Error('Signed recovery cannot return to unsigned pending');
        const preparedObject = parsed(update.preparedJson ?? row.prepared_json);
        if (preparedObject?.expectedRefundLamports != null && String(preparedObject.expectedRefundLamports) !== row.funded_lamports) {
          throw new Error('Prepared refund differs from verified funding');
        }
        for (const [key, column] of [['signature', 'signature'], ['preparedJson', 'prepared_json']]) {
          if (row[column] != null && update[key] !== undefined && update[key] !== row[column]) throw new Error('Prepared recovery identity is immutable');
        }
        if (['PREPARED','UNKNOWN'].includes(status) && (!(update.signature ?? row.signature)
          || !parsed(update.preparedJson ?? row.prepared_json))) throw new Error('Signed recovery evidence required');
        if (status === 'CONFIRMED' || status === 'BLOCKED' && (update.signature ?? row.signature)) {
          const refund = bigint(update.refundLamports ?? row.refund_lamports);
          const fee = update.networkFeeSol ?? row.network_fee_sol;
          const delta = update.walletSolDelta ?? row.wallet_sol_delta;
          if (refund == null || refund < 0n || !Number.isFinite(fee) || fee < 0 || !Number.isFinite(delta)
            || Math.abs(sol(refund) - fee - delta) > 1e-9 || !(update.signature ?? row.signature)) throw new Error('Verified refund accounting required');
        }
        const keys = Object.keys(fields).filter(key => update[key] !== undefined);
        this.db.prepare(`UPDATE live_account_recoveries SET ${keys.map(key => `${fields[key]}=?`).join(',')} WHERE id=?`)
          .run(...keys.map(key => update[key]), id);
        this.refreshLivePositionAccountFunding(row.position_id);
      }).immediate();
      const saved = this.db.prepare('SELECT * FROM live_account_recoveries WHERE id=?').get(id);
      const preparedPatch = patch.prepared ?? patch.preparedJson;
      const expectedPrepared = preparedPatch === undefined ? undefined
        : typeof preparedPatch === 'string' ? preparedPatch : JSON.stringify(preparedPatch);
      if (!saved || patch.status != null && saved.status !== patch.status
        || patch.signature != null && saved.signature !== patch.signature
        || expectedPrepared !== undefined && saved.prepared_json !== expectedPrepared) throw new Error('Recovery durable reread mismatch');
      return saved;
    } finally {
      this.db.pragma(`synchronous = ${priorSync}`);
      if (priorBusy > 100) this.db.pragma(`busy_timeout = ${priorBusy}`);
    }
  },

  refreshLivePositionAccountFunding(positionId) {
    const position = this.db.prepare('SELECT * FROM live_positions WHERE id=?').get(positionId);
    if (!position || position.mode !== 'LIVE') return;
    const orders = this.db.prepare('SELECT * FROM live_orders WHERE position_id=? ORDER BY id').all(positionId);
    const signed = orders.filter(row => row.signature);
    let complete = signed.length > 0;
    let funding = 0n; let entryFunding = 0n;
    const signatures = new Set();
    for (const order of signed) {
      const amount = bigint(order.account_net_funding_lamports);
      const duplicate = signatures.has(order.signature) || this.db.prepare('SELECT 1 FROM live_orders WHERE signature=? AND position_id<>? LIMIT 1')
        .get(order.signature, positionId);
      if (duplicate || order.account_funding_verified !== 1 || amount == null || order.wallet_sol_delta == null) complete = false;
      else { funding += amount; if (order.side === 'BUY') entryFunding += amount; }
      signatures.add(order.signature);
    }
    const recoveries = this.db.prepare('SELECT * FROM live_account_recoveries WHERE position_id=?').all(positionId);
    let refund = 0; let fees = 0; let cashDelta = 0; let releasedInTrade = 0;
    let recoveryComplete = true;
    for (const row of recoveries) {
      if (row.status === 'PREPARED' || row.status === 'UNKNOWN') recoveryComplete = false;
      if (row.status === 'CONFIRMED' || row.status === 'BLOCKED' && row.signature) {
        if (bigint(row.refund_lamports) == null || !Number.isFinite(row.network_fee_sol)
          || !Number.isFinite(row.wallet_sol_delta)) { recoveryComplete = false; continue; }
        refund += sol(bigint(row.refund_lamports) ?? 0n); fees += row.network_fee_sol; cashDelta += row.wallet_sol_delta;
      } else if (row.status === 'ABSENT' && row.error === 'ACCOUNT_CLOSED_IN_TRADE') {
        // Same-position SELL funding already contains this negative delta.
        if (row.trading_close_position_id !== positionId) releasedInTrade += sol(bigint(row.refund_lamports) ?? 0n);
      }
      else if (row.status === 'ABSENT' || row.error === 'SUPERSEDED_ACCOUNT_CREATION') recoveryComplete = false;
    }
    const net = complete ? sol(funding) : null;
    const cash = position.realized_pnl_sol;
    const economic = complete && recoveryComplete && Number.isFinite(cash) ? cash + net - fees : null;
    const basis = complete && Number.isFinite(position.entry_sol_delta) ? Math.abs(position.entry_sol_delta) - sol(entryFunding) : null;
    const retained = complete && recoveryComplete ? Math.max(0, net - refund - releasedInTrade) : null;
    this.db.prepare(`UPDATE live_positions SET account_funding_complete=?,account_recovery_complete=?,
      account_net_funding_sol=?,account_retained_funding_sol=?,economic_pnl_sol=?,economic_return_pct=?,economic_cost_basis_sol=?,
      recovery_refund_sol=?,recovery_network_fee_sol=?,cash_after_recovery_pnl_sol=? WHERE id=?`)
      .run(complete ? 1 : 0, recoveryComplete ? 1 : 0, net, retained, economic,
        economic != null && basis > 0 ? economic / basis * 100 : null, basis > 0 ? basis : null, refund, fees,
        Number.isFinite(cash) && recoveryComplete ? cash + cashDelta : null, positionId);
    this.db.prepare('UPDATE live_positions SET account_funding_cash_pnl_sol=? WHERE id=?').run(cash, positionId);
  },

  liveAccountRecoveryPositionStates(positionIds = []) {
    const ids = [...new Set(positionIds.filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 500);
    const result = new Map(ids.map(id => [id, { account_recovery_states: {}, account_recovery_error: null,
      account_recovery_error_stage: null }]));
    if (!ids.length || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_account_recoveries'").get()) return new Map();
    // Indexed, bounded to the displayed positions; never infer per-position state
    // from the separately truncated recent-20 recovery panel.
    const hasErrorStage = this.db.pragma('table_info(live_account_recoveries)').some(column => column.name === 'error_stage');
    const rows = this.db.prepare(`SELECT position_id,status,error,${hasErrorStage ? 'error_stage' : 'NULL AS error_stage'} FROM live_account_recoveries
      WHERE position_id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC,id DESC`).all(...ids);
    for (const row of rows) {
      const value = result.get(row.position_id);
      value.account_recovery_states[row.status] = (value.account_recovery_states[row.status] || 0) + 1;
      if (!value.account_recovery_error && row.error && row.status !== 'CONFIRMED') {
        value.account_recovery_error = row.error;
        value.account_recovery_error_stage = row.error_stage;
      }
    }
    return result;
  },

  liveAccountRecoveryDashboard(strategyId = null) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_account_recoveries'").get()) return { available: false, summary: null, cases: [] };
    const filter = strategyId ? "p.mode='LIVE' AND p.strategy_id=?" : "p.mode='LIVE'";
    const binds = strategyId ? [strategyId] : [];
    const summary = this.db.prepare(`SELECT COUNT(*) AS positions,
      SUM(p.status='CLOSED') AS closed_positions,
      SUM(CASE WHEN p.status='CLOSED' THEN p.realized_pnl_sol END) AS cash_pnl_sol,
      SUM(p.status='CLOSED' AND p.economic_pnl_sol IS NOT NULL AND p.account_funding_cash_pnl_sol=p.realized_pnl_sol) AS funding_complete_positions,
      SUM(CASE WHEN p.status='CLOSED' AND p.account_funding_cash_pnl_sol=p.realized_pnl_sol THEN p.economic_pnl_sol END) AS verified_economic_pnl_sol,
      SUM(p.account_retained_funding_sol) AS retained_funding_sol,
      SUM(p.recovery_refund_sol) AS refund_sol, SUM(p.recovery_network_fee_sol) AS recovery_fee_sol,
      SUM(CASE WHEN p.status='CLOSED' AND p.account_funding_cash_pnl_sol=p.realized_pnl_sol THEN p.cash_after_recovery_pnl_sol END) AS cash_after_recovery_pnl_sol
      FROM live_positions p WHERE ${filter}`).get(...binds);
    const states = this.db.prepare(`SELECT r.status,COUNT(*) AS n FROM live_account_recoveries r
      JOIN live_positions p ON p.id=r.position_id WHERE ${filter} GROUP BY r.status`).all(...binds);
    // An independently refreshed read-only Dashboard snapshot can still have
    // the previous ledger schema. Missing diagnostics must not break the page.
    const hasErrorStage = this.db.pragma('table_info(live_account_recoveries)').some(column => column.name === 'error_stage');
    const cases = this.db.prepare(`SELECT r.id,r.account_address,r.mint,r.position_id,r.status,r.funded_lamports,
      r.signature,r.refund_lamports,r.network_fee_sol,r.wallet_sol_delta,r.attempts,r.next_attempt_at,r.error,${hasErrorStage ? 'r.error_stage' : 'NULL AS error_stage'},r.updated_at
      FROM live_account_recoveries r JOIN live_positions p ON p.id=r.position_id WHERE ${filter}
      ORDER BY r.updated_at DESC,r.id DESC LIMIT 20`).all(...binds);
    return { available: true, summary: { ...summary,
      economic_pnl_sol: summary.closed_positions > 0 && summary.closed_positions === summary.funding_complete_positions
        ? summary.verified_economic_pnl_sol : null,
      states: Object.fromEntries(states.map(row => [row.status, row.n])) }, cases };
  },

  liveAccountRecoveryHealth() {
    return { states: Object.fromEntries(this.db.prepare('SELECT status,COUNT(*) AS n FROM live_account_recoveries GROUP BY status').all().map(row => [row.status, row.n])),
      fundingDiagnostics: this.accountFundingDiagnostics || { errors: 0, lastError: null, lastErrorAt: null } };
  },
};

module.exports = { liveAccountRecoveryMethods, validateFunding };
