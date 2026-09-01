'use strict';

const { costBreakdown } = require('./CostModel');
const { executableBuy, executableSell } = require('./ShadowExecutionModel');
const { tradePrice } = require('./PreEntryRugRiskTracker');

const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function profitFactor(values) {
  const profit = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(values.filter((value) => value < 0)
    .reduce((sum, value) => sum + value, 0));
  return loss > 0 ? profit / loss : (profit > 0 ? null : 0);
}

function topProfitContribution(values) {
  const wins = values.filter((value) => value > 0).sort((left, right) => right - left);
  const total = wins.reduce((sum, value) => sum + value, 0);
  return total > 0 ? wins[0] / total * 100 : null;
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || '') || fallback;
  } catch (_) {
    return fallback;
  }
}

function gradeWeight(grade) {
  if (grade === 'S_A') return 1;
  if (grade === 'S_B') return 0.5;
  return 0;
}

function copyWeight(grade) {
  if (grade === 'C_A') return 1;
  if (grade === 'C_B') return 0.5;
  return 0;
}

class SmartWalletRegistry {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.costs = costBreakdown(config.costModel || { positionSizeSol: config.labelPositionSol });
    this.labels = new Map();
    this.labelsByMint = new Map();
    this.metrics = {
      discovered: 0,
      seeded: 0,
      labelsCreated: 0,
      labelsCompleted: 0,
      labelsNoEntry: 0,
      gradeRefreshes: 0,
      lastGradeRefreshAt: null,
      lastActionAt: null,
    };
    this._initStorage();
  }

  _initStorage() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS smart_wallet_registry_meta (
        id INTEGER PRIMARY KEY CHECK(id=1),
        registry_version INTEGER NOT NULL,
        last_grade_refresh_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO smart_wallet_registry_meta (
        id, registry_version, last_grade_refresh_at, updated_at
      ) VALUES (1, 1, NULL, 0);

      CREATE TABLE IF NOT EXISTS smart_wallet_registry (
        wallet TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        selection_grade TEXT NOT NULL,
        copy_grade TEXT NOT NULL,
        holding_grade TEXT NOT NULL,
        risk_status TEXT NOT NULL,
        source TEXT NOT NULL,
        discovered_at INTEGER NOT NULL,
        effective_from INTEGER NOT NULL,
        last_seen_at INTEGER,
        metrics_json TEXT NOT NULL,
        registry_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_swr_status_effective
        ON smart_wallet_registry(status, effective_from);
      CREATE INDEX IF NOT EXISTS idx_swr_grades
        ON smart_wallet_registry(selection_grade, copy_grade, updated_at DESC);

      CREATE TABLE IF NOT EXISTS smart_wallet_discovery_seeds (
        wallet TEXT NOT NULL,
        seed_mint TEXT NOT NULL,
        source TEXT NOT NULL,
        discovered_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(wallet, seed_mint)
      );
      CREATE INDEX IF NOT EXISTS idx_swr_seed_mint
        ON smart_wallet_discovery_seeds(seed_mint, wallet);

      CREATE TABLE IF NOT EXISTS smart_wallet_cluster_memberships (
        wallet TEXT PRIMARY KEY,
        cluster_id TEXT NOT NULL,
        confidence TEXT NOT NULL,
        reason_json TEXT NOT NULL,
        valid_from INTEGER NOT NULL,
        valid_to INTEGER,
        registry_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_swr_cluster_active
        ON smart_wallet_cluster_memberships(cluster_id, valid_from, valid_to);

      CREATE TABLE IF NOT EXISTS smart_wallet_grade_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL,
        effective_at INTEGER NOT NULL,
        old_status TEXT,
        new_status TEXT NOT NULL,
        old_selection_grade TEXT,
        new_selection_grade TEXT NOT NULL,
        old_copy_grade TEXT,
        new_copy_grade TEXT NOT NULL,
        old_holding_grade TEXT,
        new_holding_grade TEXT NOT NULL,
        reason TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        registry_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_swr_grade_history_wallet
        ON smart_wallet_grade_history(wallet, effective_at DESC);

      CREATE TABLE IF NOT EXISTS smart_wallet_forward_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        smart_event_id INTEGER NOT NULL UNIQUE,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        status TEXT NOT NULL,
        signal_at INTEGER NOT NULL,
        signal_market TEXT NOT NULL,
        signal_price REAL NOT NULL,
        entry_target_at INTEGER NOT NULL,
        entry_deadline_at INTEGER NOT NULL,
        entry_at INTEGER,
        entry_market TEXT,
        entry_price REAL,
        entry_impact_pct REAL,
        token_units REAL,
        return_30s_pct REAL,
        return_300s_pct REAL,
        max_favorable_return_pct REAL,
        max_adverse_return_pct REAL,
        graduated_at INTEGER,
        seed_excluded INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER,
        rejection_reason TEXT,
        configured_cost_pct REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_swr_labels_wallet_time
        ON smart_wallet_forward_labels(wallet, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_swr_labels_mint_status
        ON smart_wallet_forward_labels(mint, status, signal_at DESC);
      CREATE INDEX IF NOT EXISTS idx_swr_labels_status_target
        ON smart_wallet_forward_labels(status, entry_target_at);
    `);
    this.insertRegistry = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_registry (
        wallet, status, selection_grade, copy_grade, holding_grade, risk_status,
        source, discovered_at, effective_from, last_seen_at, metrics_json,
        registry_version, created_at, updated_at
      ) VALUES (
        @wallet, @status, @selectionGrade, @copyGrade, @holdingGrade, @riskStatus,
        @source, @discoveredAt, @effectiveFrom, NULL, @metricsJson,
        @registryVersion, @createdAt, @updatedAt
      )
    `);
    this.insertSeed = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_discovery_seeds (
        wallet, seed_mint, source, discovered_at, created_at
      ) VALUES (@wallet, @seedMint, @source, @discoveredAt, @createdAt)
    `);
    this.insertCluster = this.store.db.prepare(`
      INSERT INTO smart_wallet_cluster_memberships (
        wallet, cluster_id, confidence, reason_json, valid_from, valid_to,
        registry_version, created_at, updated_at
      ) VALUES (
        @wallet, @clusterId, @confidence, @reasonJson, @validFrom, NULL,
        @registryVersion, @createdAt, @updatedAt
      ) ON CONFLICT(wallet) DO UPDATE SET
        cluster_id=excluded.cluster_id,
        confidence=excluded.confidence,
        reason_json=excluded.reason_json,
        valid_from=excluded.valid_from,
        valid_to=NULL,
        registry_version=excluded.registry_version,
        updated_at=excluded.updated_at
    `);
    this.insertLabel = this.store.db.prepare(`
      INSERT OR IGNORE INTO smart_wallet_forward_labels (
        smart_event_id, wallet, mint, status, signal_at, signal_market, signal_price,
        entry_target_at, entry_deadline_at, seed_excluded, configured_cost_pct,
        created_at, updated_at
      ) VALUES (
        @smartEventId, @wallet, @mint, 'PENDING_ENTRY', @signalAt, @signalMarket,
        @signalPrice, @entryTargetAt, @entryDeadlineAt, @seedExcluded,
        @configuredCostPct, @createdAt, @updatedAt
      )
    `);
    this.updateLabel = this.store.db.prepare(`
      UPDATE smart_wallet_forward_labels SET
        status=@status,
        entry_at=@entryAt,
        entry_market=@entryMarket,
        entry_price=@entryPrice,
        entry_impact_pct=@entryImpactPct,
        token_units=@tokenUnits,
        return_30s_pct=@return30sPct,
        return_300s_pct=@return300sPct,
        max_favorable_return_pct=@maxFavorableReturnPct,
        max_adverse_return_pct=@maxAdverseReturnPct,
        graduated_at=@graduatedAt,
        completed_at=@completedAt,
        rejection_reason=@rejectionReason,
        updated_at=@updatedAt
      WHERE id=@id
    `);
  }

  start() {
    if (!this.config.enabled) return;
    const now = this.now();
    for (const wallet of this.config.seedWallets || []) {
      const created = this.discoverWallet({
        wallet,
        source: 'CONFIG_SEED',
        discoveredAt: now,
        effectiveFrom: now,
      });
      if (created) this.metrics.seeded += 1;
    }
    for (const cluster of this.config.seedClusters || []) {
      for (const wallet of cluster.wallets || []) {
        this.setCluster({
          wallet,
          clusterId: cluster.id,
          confidence: 'CONFIRMED',
          reason: { source: 'CONFIG_SEED' },
          validFrom: now,
        });
      }
    }
    const active = this.store.db.prepare(`
      SELECT * FROM smart_wallet_forward_labels
      WHERE status IN ('PENDING_ENTRY','OPEN')
      ORDER BY signal_at, id
    `).all();
    for (const row of active) this._hydrateLabel(row);
    const meta = this._meta();
    if (!meta.last_grade_refresh_at
      || now - meta.last_grade_refresh_at >= this.config.gradeRefreshMs) {
      this.refreshGrades(now);
    }
  }

  stop() {
    this.labels.clear();
    this.labelsByMint.clear();
  }

  _meta() {
    return this.store.db.prepare('SELECT * FROM smart_wallet_registry_meta WHERE id=1').get();
  }

  _nextVersion(now = this.now()) {
    this.store.db.prepare(`
      UPDATE smart_wallet_registry_meta
      SET registry_version=registry_version+1, updated_at=? WHERE id=1
    `).run(now);
    return this._meta().registry_version;
  }

  version() {
    return Number(this._meta().registry_version) || 1;
  }

  discoverWallet({
    wallet, source = 'ROLLING_DISCOVERY', seedMint = null,
    discoveredAt = this.now(), effectiveFrom = null,
  }) {
    if (!this.config.enabled || !wallet) return false;
    const now = this.now();
    const version = this.version();
    const result = this.insertRegistry.run({
      wallet,
      status: 'PROBATION',
      selectionGrade: 'S_C',
      copyGrade: 'C_C',
      holdingGrade: 'H_C',
      riskStatus: 'OK',
      source,
      discoveredAt,
      effectiveFrom: effectiveFrom == null
        ? discoveredAt + this.config.discoveryDelayMs
        : effectiveFrom,
      metricsJson: JSON.stringify({ candidateStreak: 0, candidateGrades: null }),
      registryVersion: version,
      createdAt: now,
      updatedAt: now,
    });
    if (seedMint) {
      this.insertSeed.run({ wallet, seedMint, source, discoveredAt, createdAt: now });
    }
    if (result.changes) {
      this.metrics.discovered += 1;
      this.metrics.lastActionAt = now;
    }
    return Boolean(result.changes);
  }

  nominateWallet({ wallet, seedMint, source = 'GRADUATED_EARLY_BUYER', discoveredAt }) {
    if (!this.config.enabled || !wallet || !seedMint) return false;
    const now = this.now();
    this.insertSeed.run({ wallet, seedMint, source, discoveredAt, createdAt: now });
    const seedCount = this.store.db.prepare(`
      SELECT COUNT(DISTINCT seed_mint) n
      FROM smart_wallet_discovery_seeds WHERE wallet=?
    `).get(wallet).n;
    if (seedCount < this.config.discoveryMinSeedMints) return false;
    return this.discoverWallet({ wallet, source, discoveredAt });
  }

  setCluster({
    wallet, clusterId, confidence = 'UNKNOWN', reason = {}, validFrom = this.now(),
  }) {
    if (!this.config.enabled || !wallet || !clusterId) return false;
    const existing = this.store.db.prepare(
      'SELECT * FROM smart_wallet_cluster_memberships WHERE wallet=?',
    ).get(wallet);
    if (existing && existing.cluster_id === clusterId
      && existing.confidence === confidence) return false;
    const now = this.now();
    const version = this._nextVersion(now);
    this.insertCluster.run({
      wallet,
      clusterId,
      confidence,
      reasonJson: JSON.stringify(reason || {}),
      validFrom,
      registryVersion: version,
      createdAt: existing?.created_at || now,
      updatedAt: now,
    });
    return true;
  }

  setGrades({
    wallet, selectionGrade, copyGrade, holdingGrade = 'H_C', status = 'ACTIVE',
    reason = 'MANUAL_REVIEW', metrics = {}, effectiveAt = this.now(),
  }) {
    const current = this.store.db.prepare('SELECT * FROM smart_wallet_registry WHERE wallet=?')
      .get(wallet);
    if (!current) return false;
    const now = this.now();
    const version = this._nextVersion(now);
    this.store.db.prepare(`
      UPDATE smart_wallet_registry SET
        status=?, selection_grade=?, copy_grade=?, holding_grade=?, metrics_json=?,
        registry_version=?, updated_at=? WHERE wallet=?
    `).run(
      status, selectionGrade, copyGrade, holdingGrade, JSON.stringify(metrics || {}),
      version, now, wallet,
    );
    this.store.db.prepare(`
      INSERT INTO smart_wallet_grade_history (
        wallet, effective_at, old_status, new_status,
        old_selection_grade, new_selection_grade,
        old_copy_grade, new_copy_grade,
        old_holding_grade, new_holding_grade,
        reason, metrics_json, registry_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      wallet, effectiveAt, current.status, status,
      current.selection_grade, selectionGrade, current.copy_grade, copyGrade,
      current.holding_grade, holdingGrade, reason, JSON.stringify(metrics || {}), version, now,
    );
    return true;
  }

  quarantine(wallet, reason = 'RISK_REVIEW', at = this.now()) {
    const row = this.store.db.prepare('SELECT * FROM smart_wallet_registry WHERE wallet=?').get(wallet);
    if (!row) return false;
    const version = this._nextVersion(at);
    this.store.db.prepare(`
      UPDATE smart_wallet_registry SET status='QUARANTINED', risk_status=?,
        registry_version=?, updated_at=? WHERE wallet=?
    `).run(reason, version, at, wallet);
    return true;
  }

  walletSnapshot(wallet, at = this.now()) {
    const row = this.store.db.prepare(`
      SELECT * FROM smart_wallet_registry
      WHERE wallet=? AND effective_from<=?
    `).get(wallet, at);
    if (!row || row.status === 'QUARANTINED' || row.risk_status !== 'OK') return null;
    const cluster = this.store.db.prepare(`
      SELECT * FROM smart_wallet_cluster_memberships
      WHERE wallet=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?)
    `).get(wallet, at, at);
    return {
      wallet,
      status: row.status,
      selectionGrade: row.selection_grade,
      copyGrade: row.copy_grade,
      holdingGrade: row.holding_grade,
      selectionWeight: gradeWeight(row.selection_grade),
      copyWeight: copyWeight(row.copy_grade),
      clusterId: cluster?.cluster_id || wallet,
      clusterConfidence: cluster?.confidence || 'UNKNOWN',
      registryVersion: row.registry_version,
      effectiveFrom: row.effective_from,
    };
  }

  activeClusterCounts(at = this.now()) {
    const rows = this.store.db.prepare(`
      SELECT wallet FROM smart_wallet_registry
      WHERE effective_from<=? AND status IN ('PROBATION','ACTIVE') AND risk_status='OK'
    `).all(at);
    const eligible = new Set();
    const selectionA = new Set();
    for (const row of rows) {
      const snapshot = this.walletSnapshot(row.wallet, at);
      if (!snapshot) continue;
      eligible.add(snapshot.clusterId);
      if (snapshot.selectionGrade === 'S_A') selectionA.add(snapshot.clusterId);
    }
    return { eligible: eligible.size, selectionA: selectionA.size };
  }

  trackedWallets(at = this.now()) {
    return this.store.db.prepare(`
      SELECT wallet FROM smart_wallet_registry
      WHERE effective_from<=? AND status IN ('PROBATION','ACTIVE') AND risk_status='OK'
      ORDER BY wallet
    `).all(at).map((row) => row.wallet);
  }

  onSmartWalletEvent(event) {
    if (!this.config.enabled || !event?.wallet || !event?.mint) return null;
    const signalAt = finite(event.timestampMs ?? event.timestamp_ms);
    if (!(signalAt > 0)) return null;
    const snapshot = this.walletSnapshot(event.wallet, signalAt);
    if (!snapshot) return null;
    this.store.db.prepare(`
      UPDATE smart_wallet_registry SET last_seen_at=?, updated_at=? WHERE wallet=?
    `).run(signalAt, this.now(), event.wallet);
    const phase = String(event.positionPhase || event.position_phase || '').toUpperCase();
    if (String(event.side || '').toUpperCase() !== 'BUY' || phase !== 'OPEN') return null;
    const signalPrice = tradePrice(event);
    if (!(signalPrice > 0) || !event.id || !event.market) return null;
    const seedExcluded = this.store.db.prepare(`
      SELECT 1 FROM smart_wallet_discovery_seeds WHERE wallet=? AND seed_mint=?
    `).get(event.wallet, event.mint) ? 1 : 0;
    const now = this.now();
    const result = this.insertLabel.run({
      smartEventId: Number(event.id),
      wallet: event.wallet,
      mint: event.mint,
      signalAt,
      signalMarket: event.market,
      signalPrice,
      entryTargetAt: signalAt + this.config.labelEntryDelayMs,
      entryDeadlineAt: signalAt + this.config.labelEntryDelayMs
        + this.config.labelEntryTimeoutMs,
      seedExcluded,
      configuredCostPct: this.costs.deterministicCostPct,
      createdAt: now,
      updatedAt: now,
    });
    if (!result.changes) return null;
    const row = this.store.db.prepare(
      'SELECT * FROM smart_wallet_forward_labels WHERE smart_event_id=?',
    ).get(Number(event.id));
    const label = this._hydrateLabel(row);
    this.metrics.labelsCreated += 1;
    this.metrics.lastActionAt = now;
    return label;
  }

  onGraduated(event) {
    if (!this.config.enabled || !event?.mint) return;
    const graduatedAt = finite(event.graduated_at ?? event.graduatedAt
      ?? event.completedAt ?? event.migratedAt ?? event.timestampMs);
    if (!(graduatedAt > 0)) return;
    this.store.db.prepare(`
      UPDATE smart_wallet_forward_labels SET graduated_at=?, updated_at=?
      WHERE mint=? AND signal_at<=? AND graduated_at IS NULL
    `).run(graduatedAt, this.now(), event.mint, graduatedAt);
    for (const id of this.labelsByMint.get(event.mint) || []) {
      const label = this.labels.get(id);
      if (!label) continue;
      label.graduatedAt = graduatedAt;
      this._saveLabel(label);
    }
    if (!this.config.discoveryEnabled) return;
    const token = this.store.getToken(event.mint);
    const candidates = this.store.db.prepare(`
      SELECT wallet, MIN(timestamp_ms) first_buy_at,
        SUM(CASE WHEN side='BUY' THEN sol_amount ELSE 0 END) buy_sol,
        SUM(CASE WHEN side='SELL' THEN sol_amount ELSE 0 END) sell_sol,
        MIN(CASE WHEN side='BUY' THEN curve_pct END) first_curve_pct
      FROM raw_trades
      WHERE mint=? AND market='PUMP_BONDING_CURVE' AND timestamp_ms<=?
        AND wallet IS NOT NULL AND wallet<>''
      GROUP BY wallet
      HAVING buy_sol>=? AND buy_sol>sell_sol
      ORDER BY first_buy_at
      LIMIT ?
    `).all(
      event.mint,
      graduatedAt,
      this.config.discoveryMinBuySol,
      this.config.discoveryMaxEarlyBuyers,
    );
    for (const candidate of candidates) {
      if (candidate.wallet === token?.creator) continue;
      if (finite(candidate.first_curve_pct, 101) > this.config.discoveryMaxCurvePct) continue;
      this.nominateWallet({
        wallet: candidate.wallet,
        seedMint: event.mint,
        discoveredAt: graduatedAt,
      });
    }
  }

  observeTrade(trade) {
    if (!this.config.enabled || !trade?.mint) return;
    const ids = this.labelsByMint.get(trade.mint);
    if (!ids?.size) return;
    const timestampMs = finite(trade.timestampMs);
    const price = tradePrice(trade);
    if (!(timestampMs > 0) || !(price > 0)) return;
    for (const id of [...ids]) {
      const label = this.labels.get(id);
      if (!label || timestampMs < label.signalAt) continue;
      if (label.status === 'PENDING_ENTRY') this._tryLabelEntry(label, trade, timestampMs, price);
      if (label.status !== 'OPEN') continue;
      if (!this._comparable(label, trade, price)) continue;
      const markReturn = (price / label.entryPrice - 1) * 100;
      label.maxFavorableReturnPct = Math.max(label.maxFavorableReturnPct || 0, markReturn);
      label.maxAdverseReturnPct = Math.min(label.maxAdverseReturnPct || 0, markReturn);
      const ageMs = timestampMs - label.entryAt;
      if (label.return30sPct == null && ageMs >= this.config.copyReturnHorizonMs) {
        label.return30sPct = this._executableReturn(label, trade, price);
      }
      if (ageMs >= this.config.selectionHorizonMs) {
        label.return300sPct = this._executableReturn(label, trade, price);
        label.status = 'COMPLETE';
        label.completedAt = timestampMs;
        this.metrics.labelsCompleted += 1;
        this._saveLabel(label);
        this._removeLabel(label);
      } else this._saveLabel(label);
    }
  }

  _tryLabelEntry(label, trade, timestampMs, price) {
    if (timestampMs < label.entryTargetAt) return;
    if (timestampMs > label.entryDeadlineAt) {
      label.status = 'NO_ENTRY';
      label.rejectionReason = 'ENTRY_TIMEOUT';
      this.metrics.labelsNoEntry += 1;
      this._saveLabel(label);
      this._removeLabel(label);
      return;
    }
    if (!this._comparable(label, trade, price)) return;
    const quote = executableBuy(trade, this.config.labelPositionSol, price);
    if (!quote.available || !(quote.price > 0) || !(quote.tokenUnits > 0)) return;
    label.status = 'OPEN';
    label.entryAt = timestampMs;
    label.entryMarket = trade.market;
    label.entryPrice = quote.price;
    label.entryImpactPct = quote.impactPct;
    label.tokenUnits = quote.tokenUnits;
    label.maxFavorableReturnPct = Math.max(0, (price / quote.price - 1) * 100);
    label.maxAdverseReturnPct = Math.min(0, (price / quote.price - 1) * 100);
    const token = this.store.getToken(label.mint);
    label.graduatedAt = finite(token?.graduated_at ?? token?.graduatedAt);
    this._saveLabel(label);
  }

  _comparable(label, trade, price) {
    if (trade.market === label.signalMarket || trade.market === label.entryMarket) return true;
    const graduatedAt = label.graduatedAt
      || finite(this.store.getToken(label.mint)?.graduated_at);
    if (!(graduatedAt > 0) || trade.market !== 'PUMP_AMM' || trade.timestampMs < graduatedAt) {
      return false;
    }
    const reference = label.entryPrice || label.signalPrice;
    return Math.abs((price / reference - 1) * 100) <= this.config.maxCrossMarketJumpPct;
  }

  _executableReturn(label, trade, price) {
    const markReturnPct = (price / label.entryPrice - 1) * 100;
    const quote = executableSell(trade, label.tokenUnits, price, { rugMarkReturnPct: markReturnPct });
    if (!quote.available && !quote.conservative) return null;
    const proceeds = finite(quote.proceedsSol, finite(quote.price, 0) * label.tokenUnits);
    const gross = (proceeds / this.config.labelPositionSol - 1) * 100;
    return gross - label.configuredCostPct;
  }

  _hydrateLabel(row) {
    const label = {
      id: row.id,
      smartEventId: row.smart_event_id,
      wallet: row.wallet,
      mint: row.mint,
      status: row.status,
      signalAt: row.signal_at,
      signalMarket: row.signal_market,
      signalPrice: row.signal_price,
      entryTargetAt: row.entry_target_at,
      entryDeadlineAt: row.entry_deadline_at,
      entryAt: row.entry_at,
      entryMarket: row.entry_market,
      entryPrice: row.entry_price,
      entryImpactPct: row.entry_impact_pct,
      tokenUnits: row.token_units,
      return30sPct: row.return_30s_pct,
      return300sPct: row.return_300s_pct,
      maxFavorableReturnPct: row.max_favorable_return_pct,
      maxAdverseReturnPct: row.max_adverse_return_pct,
      graduatedAt: row.graduated_at,
      seedExcluded: row.seed_excluded,
      configuredCostPct: row.configured_cost_pct,
      completedAt: row.completed_at,
      rejectionReason: row.rejection_reason,
    };
    this.labels.set(label.id, label);
    const bucket = this.labelsByMint.get(label.mint) || new Set();
    bucket.add(label.id);
    this.labelsByMint.set(label.mint, bucket);
    return label;
  }

  _saveLabel(label) {
    this.updateLabel.run({
      id: label.id,
      status: label.status,
      entryAt: label.entryAt ?? null,
      entryMarket: label.entryMarket ?? null,
      entryPrice: label.entryPrice ?? null,
      entryImpactPct: label.entryImpactPct ?? null,
      tokenUnits: label.tokenUnits ?? null,
      return30sPct: label.return30sPct ?? null,
      return300sPct: label.return300sPct ?? null,
      maxFavorableReturnPct: label.maxFavorableReturnPct ?? null,
      maxAdverseReturnPct: label.maxAdverseReturnPct ?? null,
      graduatedAt: label.graduatedAt ?? null,
      completedAt: label.completedAt ?? null,
      rejectionReason: label.rejectionReason ?? null,
      updatedAt: this.now(),
    });
  }

  _removeLabel(label) {
    this.labels.delete(label.id);
    const bucket = this.labelsByMint.get(label.mint);
    bucket?.delete(label.id);
    if (bucket && !bucket.size) this.labelsByMint.delete(label.mint);
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const label of [...this.labels.values()]) {
      if (label.status === 'PENDING_ENTRY' && now > label.entryDeadlineAt) {
        label.status = 'NO_ENTRY';
        label.rejectionReason = 'ENTRY_TIMEOUT';
        this.metrics.labelsNoEntry += 1;
        this._saveLabel(label);
        this._removeLabel(label);
      } else if (label.status === 'OPEN'
        && now > label.entryAt + this.config.selectionHorizonMs + this.config.labelGraceMs) {
        label.status = 'NO_EXIT';
        label.rejectionReason = 'NO_COMPARABLE_300S_QUOTE';
        this._saveLabel(label);
        this._removeLabel(label);
      }
    }
    const meta = this._meta();
    if (!meta.last_grade_refresh_at
      || now - meta.last_grade_refresh_at >= this.config.gradeRefreshMs) {
      this.refreshGrades(now);
    }
  }

  refreshGrades(now = this.now()) {
    if (!this.config.enabled) return;
    const cutoff = now - this.config.lookbackMs;
    const rows = this.store.db.prepare(`
      SELECT wallet, signal_at, return_30s_pct, return_300s_pct,
        max_favorable_return_pct, graduated_at
      FROM smart_wallet_forward_labels
      WHERE status='COMPLETE' AND seed_excluded=0 AND signal_at>=?
        AND return_300s_pct IS NOT NULL
      ORDER BY wallet, signal_at
    `).all(cutoff);
    const baselineGradRate = rows.length
      ? rows.filter((row) => row.graduated_at != null).length / rows.length : 0;
    const baselineBig50Rate = rows.length
      ? rows.filter((row) => finite(row.max_favorable_return_pct, -Infinity) >= 50).length
        / rows.length
      : 0;
    const grouped = new Map();
    for (const row of rows) {
      const bucket = grouped.get(row.wallet) || [];
      bucket.push(row);
      grouped.set(row.wallet, bucket);
    }
    const wallets = this.store.db.prepare('SELECT * FROM smart_wallet_registry').all();
    for (const current of wallets) {
      if (current.status === 'QUARANTINED') continue;
      const sample = grouped.get(current.wallet) || [];
      const returns30 = sample.map((row) => finite(row.return_30s_pct)).filter(Number.isFinite);
      const returns300 = sample.map((row) => finite(row.return_300s_pct)).filter(Number.isFinite);
      const activeDays = new Set(sample.map((row) => Math.floor(row.signal_at / DAY_MS))).size;
      const weeks = new Map();
      for (const row of sample) {
        const key = Math.floor(row.signal_at / WEEK_MS);
        const bucket = weeks.get(key) || [];
        bucket.push(finite(row.return_30s_pct));
        weeks.set(key, bucket);
      }
      const positiveWeekPct = weeks.size
        ? [...weeks.values()].filter((values) => average(values) > 0).length / weeks.size * 100
        : 0;
      const graduationRate = sample.length
        ? sample.filter((row) => row.graduated_at != null).length / sample.length : 0;
      const big50Rate = sample.length
        ? sample.filter((row) => finite(row.max_favorable_return_pct, -Infinity) >= 50).length
          / sample.length
        : 0;
      const graduationLift = baselineGradRate > 0 ? graduationRate / baselineGradRate : null;
      const big50Lift = baselineBig50Rate > 0 ? big50Rate / baselineBig50Rate : null;
      const avg30 = average(returns30);
      const median30 = median(returns30);
      const pf30 = profitFactor(returns30);
      const top1Pct = topProfitContribution(returns30);
      let selectionGrade = 'S_C';
      if (sample.length >= this.config.selectionMinSamples
        && activeDays >= this.config.minActiveDays
        && graduationLift >= this.config.minGraduationLift
        && big50Lift >= this.config.minBig50Lift) selectionGrade = 'S_A';
      else if (sample.length >= Math.ceil(this.config.selectionMinSamples / 2)
        && (graduationLift >= this.config.minSelectionBLift
          || big50Lift >= this.config.minSelectionBLift)) selectionGrade = 'S_B';
      let copyGrade = 'C_C';
      if (returns30.length >= this.config.copyMinSamples
        && activeDays >= this.config.minActiveDays
        && avg30 > 0 && median30 > 0 && (pf30 == null || pf30 >= this.config.minCopyPf)
        && positiveWeekPct >= this.config.minPositiveWindowPct
        && (top1Pct == null || top1Pct <= this.config.maxTop1ProfitPct)) copyGrade = 'C_A';
      else if (returns30.length >= Math.ceil(this.config.copyMinSamples / 2)
        && avg30 > 0 && (pf30 == null || pf30 >= 1)) copyGrade = 'C_B';
      const runnerUplifts = sample.map((row) => {
        const maxFavorable = finite(row.max_favorable_return_pct);
        const return300 = finite(row.return_300s_pct);
        return Number.isFinite(maxFavorable) && Number.isFinite(return300)
          ? maxFavorable - return300 : null;
      }).filter(Number.isFinite);
      const medianRunnerUplift = median(runnerUplifts);
      const bigWinnerRate = sample.length
        ? sample.filter((row) => finite(row.max_favorable_return_pct, -Infinity)
          >= this.config.holdingBigWinnerPct).length / sample.length * 100
        : 0;
      let holdingGrade = 'H_C';
      if (sample.length >= this.config.holdingMinSamples
        && medianRunnerUplift >= this.config.holdingMinRunnerUpliftPct
        && bigWinnerRate >= this.config.holdingMinBigWinnerRatePct) holdingGrade = 'H_A';
      else if (sample.length >= Math.ceil(this.config.holdingMinSamples / 2)
        && (medianRunnerUplift > 0 || bigWinnerRate > 0)) holdingGrade = 'H_B';
      const desiredStatus = selectionGrade !== 'S_C' || copyGrade !== 'C_C'
        ? 'ACTIVE' : 'PROBATION';
      const metrics = {
        sampleSize: sample.length,
        activeDays,
        copy30AveragePct: avg30,
        copy30MedianPct: median30,
        copy30ProfitFactor: pf30,
        top1ProfitContributionPct: top1Pct,
        positiveWindowPct: positiveWeekPct,
        graduationRatePct: graduationRate * 100,
        graduationLift,
        big50RatePct: big50Rate * 100,
        big50Lift,
        medianRunnerUpliftPct: medianRunnerUplift,
        bigWinnerRatePct: bigWinnerRate,
        baselineGraduationRatePct: baselineGradRate * 100,
        baselineBig50RatePct: baselineBig50Rate * 100,
      };
      const prior = parseJson(current.metrics_json, {});
      const sameCandidate = prior.candidateGrades?.selectionGrade === selectionGrade
        && prior.candidateGrades?.copyGrade === copyGrade
        && prior.candidateGrades?.holdingGrade === holdingGrade
        && prior.candidateGrades?.status === desiredStatus;
      const candidateStreak = sameCandidate ? finite(prior.candidateStreak, 0) + 1 : 1;
      const nextMetrics = {
        ...metrics,
        candidateGrades: {
          selectionGrade, copyGrade, holdingGrade, status: desiredStatus,
        },
        candidateStreak,
      };
      const changed = current.selection_grade !== selectionGrade
        || current.copy_grade !== copyGrade || current.holding_grade !== holdingGrade
        || current.status !== desiredStatus;
      if (changed && candidateStreak >= this.config.gradeConfirmationRuns) {
        this.setGrades({
          wallet: current.wallet,
          selectionGrade,
          copyGrade,
          holdingGrade,
          status: desiredStatus,
          reason: 'ROLLING_FORWARD_METRICS',
          metrics: nextMetrics,
          effectiveAt: now,
        });
      } else {
        this.store.db.prepare(`
          UPDATE smart_wallet_registry SET metrics_json=?, updated_at=? WHERE wallet=?
        `).run(JSON.stringify(nextMetrics), now, current.wallet);
      }
    }
    this.store.db.prepare(`
      UPDATE smart_wallet_registry_meta SET last_grade_refresh_at=?, updated_at=? WHERE id=1
    `).run(now, now);
    this.metrics.gradeRefreshes += 1;
    this.metrics.lastGradeRefreshAt = now;
  }

  dashboard(limit = 100) {
    const capped = Math.max(1, Math.min(500, Number(limit) || 100));
    return {
      enabled: this.config.enabled,
      mode: 'SMART_WALLET_ROLLING_REGISTRY',
      observerOnly: true,
      sendsTransactions: false,
      registryVersion: this.version(),
      clusterCounts: this.activeClusterCounts(),
      sourceCounts: Object.fromEntries(this.store.db.prepare(`
        SELECT source, COUNT(*) count
        FROM smart_wallet_registry
        GROUP BY source
        ORDER BY source
      `).all().map((row) => [row.source, row.count])),
      wallets: this.store.db.prepare(`
        SELECT r.*, c.cluster_id, c.confidence cluster_confidence
        FROM smart_wallet_registry r
        LEFT JOIN smart_wallet_cluster_memberships c ON c.wallet=r.wallet
        ORDER BY r.status, r.selection_grade, r.copy_grade, r.wallet
        LIMIT ?
      `).all(capped),
      walletLimit: capped,
      recentGradeChanges: this.store.db.prepare(`
        SELECT * FROM smart_wallet_grade_history ORDER BY effective_at DESC, id DESC LIMIT ?
      `).all(capped),
      recentLabels: this.store.db.prepare(`
        SELECT * FROM smart_wallet_forward_labels ORDER BY signal_at DESC, id DESC LIMIT ?
      `).all(capped),
      health: this.health(),
    };
  }

  health() {
    return {
      enabled: this.config.enabled,
      mode: 'SMART_WALLET_ROLLING_REGISTRY',
      observerOnly: true,
      sendsTransactions: false,
      registryVersion: this.version(),
      wallets: this.store.db.prepare('SELECT COUNT(*) n FROM smart_wallet_registry').get().n,
      active: this.store.db.prepare(`
        SELECT COUNT(*) n FROM smart_wallet_registry WHERE status='ACTIVE'
      `).get().n,
      probation: this.store.db.prepare(`
        SELECT COUNT(*) n FROM smart_wallet_registry WHERE status='PROBATION'
      `).get().n,
      quarantined: this.store.db.prepare(`
        SELECT COUNT(*) n FROM smart_wallet_registry WHERE status='QUARANTINED'
      `).get().n,
      pendingLabels: this.labels.size,
      ...this.metrics,
    };
  }
}

module.exports = {
  SmartWalletRegistry,
  gradeWeight,
  copyWeight,
};
