'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { costBreakdown, normalizeCostModel } = require('../core/CostModel');

const LAUNCH_QUALITY_COLUMNS = Object.freeze({
  status: 'status',
  completedAt: 'completed_at',
  censorReason: 'censor_reason',
  firstTradeAt: 'first_trade_at',
  baselinePrice: 'baseline_price',
  lastTradeAt: 'last_trade_at',
  lastPrice: 'last_price',
  peakAt: 'peak_at',
  peakPrice: 'peak_price',
  maxReturnPct: 'max_return_pct',
  pump25At: 'pump_25_at',
  pump50At: 'pump_50_at',
  pump100At: 'pump_100_at',
  referencePeakAt: 'reference_peak_at',
  referencePeakPrice: 'reference_peak_price',
  firstPullbackAt: 'first_pullback_at',
  pullbackLowPrice: 'pullback_low_price',
  maxPullbackPct: 'max_pullback_pct',
  reboundAt: 'rebound_at',
  reboundPrice: 'rebound_price',
  referenceFeaturesJson: 'reference_features_json',
  labelStatus: 'label_status',
  return3s: 'return_3s',
  return5s: 'return_5s',
  return10s: 'return_10s',
  return30s: 'return_30s',
  mfe3s: 'mfe_3s',
  mae3s: 'mae_3s',
  mfe5s: 'mfe_5s',
  mae5s: 'mae_5s',
  mfe10s: 'mfe_10s',
  mae10s: 'mae_10s',
  mfe30s: 'mfe_30s',
  mae30s: 'mae_30s',
});

function ensureParent(filePath) {
  if (filePath === ':memory:') return;
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function receivedTimestampMs(value, eventTimestampMs) {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return eventTimestampMs;
  while (Math.abs(timestamp) > 100_000_000_000_000) timestamp /= 1_000;
  if (!Number.isFinite(eventTimestampMs)) return timestamp;
  return Math.abs(timestamp - eventTimestampMs) <= 86_400_000
    ? timestamp
    : eventTimestampMs;
}

function curveProgress(initialRaw, currentRaw) {
  try {
    const initial = BigInt(initialRaw);
    const current = BigInt(currentRaw);
    if (initial <= 0n) return null;
    const basisPoints = ((initial - current) * 1_000_000n) / initial;
    const percentage = Number(basisPoints) / 10_000;
    return Math.min(100, Math.max(0, percentage));
  } catch (_) {
    return null;
  }
}

function legacyCostModel(configuredCostPct = 0) {
  return normalizeCostModel({
    platformFeePct: configuredCostPct,
    buySlippagePct: 0,
    sellSlippagePct: 0,
    priceImpactPct: 0,
    baseTxFeeSol: 0,
    priorityFeeSol: 0,
    jitoTipSol: 0,
    fixedCostSol: 0,
    positionSizeSol: 0.2,
    failureRatePct: 0,
    failureLossPct: 1,
  });
}

class ResearchStore {
  constructor(storageConfig, labelsConfig) {
    this.config = storageConfig;
    this.labelsConfig = labelsConfig;
    ensureParent(storageConfig.dbPath);
    this.db = new Database(storageConfig.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this._initSchema();
    this.db.pragma('optimize');
    this._prepare();

    this.tokens = new Map();
    for (const token of this.stmts.allTokens.all()) this.tokens.set(token.mint, token);
    this.rawBuffer = [];
    this.returnUpdateStatements = new Map();
    this.launchQualityUpdateStatements = new Map();
    this.dashboardStatsCache = new Map();
    this.metrics = {
      tradesQueued: 0,
      tradesWritten: 0,
      writeErrors: 0,
      timestampCorrections: 0,
      lastFlushAt: null,
      lastFlushMs: null,
      lastArchiveAt: null,
    };

    this.flushTimer = setInterval(() => {
      try {
        this.flushRawTrades();
      } catch (error) {
        console.error('[Database] raw trade flush failed:', error.message);
      }
    }, storageConfig.flushMs);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  _cachedDashboardStats(key, ttlMs, compute) {
    const now = Date.now();
    const cached = this.dashboardStatsCache.get(key);
    if (cached && now - cached.createdAt < ttlMs) return cached.value;
    const value = compute();
    this.dashboardStatsCache.set(key, { createdAt: now, value });
    return value;
  }

  shadowTimeSessionDashboard(strategyId) {
    const strategies = {
      'primary-shadow': {
        label: 'Primary Early',
        table: 'primary_signal_shadow_positions',
        anchor: 'signal_at',
      },
      'flow-first': {
        label: 'Flow-First Â· C',
        table: 'flow_first_shadow_positions',
        anchor: 'signal_at',
      },
      'smart-pullback': {
        label: 'Smart å›è¸© Â· A/B',
        table: 'smart_pullback_shadow_positions',
        anchor: 'smart_buy_at',
      },
      'smart-open': {
        label: 'Smart OPEN Â· D',
        table: 'smart_open_shadow_positions',
        anchor: 'smart_open_at',
      },
      'flow-smart-confirm': {
        label: 'Flow to Smart Confirm L',
        table: 'flow_smart_confirm_shadow_positions',
        anchor: 'smart_open_at',
      },
      'launch-pullback': {
        label: 'Launch å›è¸© Â· F',
        table: 'launch_pullback_shadow_positions',
        anchor: 'reference_at',
      },
      'migrated-rebound': {
        label: 'ç”Ÿå‘½å‘¨æœŸè¶…è·Œåå¼¹ Â· G',
        table: 'migrated_drop_rebound_shadow_positions',
        anchor: 'rebound_at',
      },
      'range-scalper': {
        label: 'PumpSwap Range Scalper Â· J',
        table: 'range_scalper_shadow_positions',
        anchor: 'signal_at',
      },
      'cya-early-pyramid': {
        label: 'CYA Early Pyramid Â· K',
        table: 'cya_early_pyramid_shadow_positions',
        anchor: 'signal_at',
      },
      'bonding-momentum': {
        label: 'Bonding Curve åŠ¨é‡ Â· H',
        table: 'bonding_curve_momentum_shadow_positions',
        anchor: 'signal_at',
      },
      'graduation-hold': {
        label: 'æ¯•ä¸šæ¦‚ç‡æŒä»“ Â· I',
        table: 'graduation_hold_shadow_positions',
        anchor: 'signal_at',
      },
    };
    const strategy = strategies[strategyId];
    if (!strategy) throw new Error(`Unknown Shadow time-session strategy: ${strategyId}`);
    const definitions = [
      { id: '00-04', label: '00:00â€“04:00', note: 'æ·±å¤œ' },
      { id: '04-08', label: '04:00â€“08:00', note: 'å‡Œæ™¨' },
      { id: '08-18', label: '08:00â€“18:00', note: 'ç™½å¤©' },
      { id: '18-24', label: '18:00â€“24:00', note: 'æ™šé—´' },
    ];
    const hour = `CAST(strftime('%H', ${strategy.anchor} / 1000.0,
      'unixepoch', '+8 hours') AS INTEGER)`;
    const session = `CASE
      WHEN ${hour} < 4 THEN '00-04'
      WHEN ${hour} < 8 THEN '04-08'
      WHEN ${hour} < 18 THEN '08-18'
      ELSE '18-24'
    END`;
    const compute = () => {
      const rows = this.db.prepare(`
        SELECT ${session} AS session_id,
          COUNT(*) AS resolved,
          COUNT(DISTINCT mint) AS independent_mints,
          COALESCE(SUM(net_return_pct > 0), 0) AS wins,
          AVG(net_return_pct) AS average_net_return_pct,
          COALESCE(SUM(CASE WHEN net_return_pct > 0 THEN net_return_pct ELSE 0 END), 0)
            AS total_profit_pct,
          ABS(COALESCE(SUM(CASE WHEN net_return_pct < 0 THEN net_return_pct ELSE 0 END), 0))
            AS total_loss_pct
        FROM ${strategy.table}
        WHERE status IN ('CLOSED', 'NO_EXIT') AND net_return_pct IS NOT NULL
        GROUP BY session_id
      `).all();
      const byId = new Map(rows.map((row) => [row.session_id, row]));
      return definitions.map((definition) => {
        const row = byId.get(definition.id) || {};
        const resolved = Number(row.resolved) || 0;
        const wins = Number(row.wins) || 0;
        const profit = Number(row.total_profit_pct) || 0;
        const loss = Number(row.total_loss_pct) || 0;
        return {
          ...definition,
          resolved,
          independent_mints: Number(row.independent_mints) || 0,
          wins,
          win_rate_pct: resolved ? wins / resolved * 100 : null,
          average_net_return_pct: resolved ? Number(row.average_net_return_pct) : null,
          profit_factor: loss > 0 ? profit / loss : (profit > 0 ? null : 0),
        };
      });
    };
    return {
      strategyId,
      strategyLabel: strategy.label,
      timezone: 'Asia/Shanghai',
      observationOnly: true,
      countingUnit: 'resolved cohort positions',
      sessions: this._cachedDashboardStats(`shadow-time-sessions:${strategyId}`, 15_000, compute),
    };
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS flow_tokens (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        name TEXT,
        uri TEXT,
        bonding_curve TEXT,
        creator TEXT,
        created_at INTEGER,
        graduated_at INTEGER,
        migration_pool TEXT,
        initial_real_token_reserves_raw TEXT,
        token_total_supply_raw TEXT,
        last_real_token_reserves_raw TEXT,
        curve_pct REAL,
        last_price REAL,
        last_trade_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_flow_tokens_last_trade ON flow_tokens(last_trade_at);
      CREATE INDEX IF NOT EXISTS idx_flow_tokens_pool ON flow_tokens(migration_pool);

      CREATE TABLE IF NOT EXISTS raw_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        chain_timestamp_ms INTEGER,
        received_at_ms INTEGER NOT NULL,
        slot INTEGER,
        signature TEXT,
        event_index INTEGER NOT NULL DEFAULT 0,
        market TEXT NOT NULL,
        mint TEXT NOT NULL,
        bonding_curve TEXT,
        wallet TEXT,
        side TEXT NOT NULL,
        sol_amount REAL NOT NULL,
        token_amount REAL NOT NULL,
        price REAL NOT NULL,
        reserve_price REAL,
        curve_pct REAL,
        virtual_sol_reserves_raw TEXT,
        virtual_token_reserves_raw TEXT,
        real_sol_reserves_raw TEXT,
        real_token_reserves_raw TEXT,
        UNIQUE(signature, event_index, market)
      );
      CREATE INDEX IF NOT EXISTS idx_raw_trades_ts ON raw_trades(timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_raw_trades_mint_ts ON raw_trades(mint, timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_raw_trades_wallet_ts ON raw_trades(wallet, timestamp_ms);

      CREATE TABLE IF NOT EXISTS flow_signals (
        signal_id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        slot INTEGER,
        signature TEXT,
        mint TEXT NOT NULL,
        symbol TEXT,
        age_ms INTEGER,
        curve_pct REAL,
        p0 REAL NOT NULL,
        buy_flow_w1 REAL NOT NULL,
        buy_flow_w2 REAL NOT NULL,
        buy_flow_w3 REAL NOT NULL,
        sell_flow_w1 REAL NOT NULL,
        sell_flow_w2 REAL NOT NULL,
        sell_flow_w3 REAL NOT NULL,
        netflow_w1 REAL NOT NULL,
        netflow_w2 REAL NOT NULL,
        netflow_w3 REAL NOT NULL,
        delta_netflow_12 REAL NOT NULL,
        delta_netflow_23 REAL NOT NULL,
        unique_buyers_w1 INTEGER NOT NULL,
        unique_buyers_w2 INTEGER NOT NULL,
        unique_buyers_w3 INTEGER NOT NULL,
        buy_tx_w1 INTEGER NOT NULL,
        buy_tx_w2 INTEGER NOT NULL,
        buy_tx_w3 INTEGER NOT NULL,
        flow_accel_1 REAL,
        flow_accel_2 REAL,
        flow_accel REAL,
        signal_variant TEXT NOT NULL DEFAULT 'primary_3w',
        is_primary INTEGER NOT NULL DEFAULT 1,
        signal_episode_id TEXT,
        signal_rank_in_mint INTEGER,
        previous_signal_gap_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_flow_signals_ts ON flow_signals(timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_flow_signals_mint_ts ON flow_signals(mint, timestamp_ms);

      CREATE TABLE IF NOT EXISTS signal_returns (
        signal_id INTEGER PRIMARY KEY REFERENCES flow_signals(signal_id) ON DELETE CASCADE,
        p0 REAL NOT NULL,
        configured_cost_pct REAL NOT NULL DEFAULT 0,
        cost_model_json TEXT,
        label_status TEXT NOT NULL DEFAULT 'PENDING',
        censor_reason TEXT,
        missing_horizons_json TEXT,
        horizon_observation_lags_json TEXT,
        return_1s REAL, return_2s REAL, return_3s REAL, return_5s REAL,
        return_8s REAL, return_10s REAL, return_15s REAL, return_20s REAL,
        return_30s REAL, return_60s REAL,
        net_return_1s REAL, net_return_2s REAL, net_return_3s REAL, net_return_5s REAL,
        net_return_8s REAL, net_return_10s REAL, net_return_15s REAL, net_return_20s REAL,
        net_return_30s REAL, net_return_60s REAL,
        mfe_5s REAL, mae_5s REAL,
        mfe_10s REAL, mae_10s REAL,
        mfe_30s REAL, mae_30s REAL,
        last_observed_at INTEGER,
        finalized_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS smart_wallet_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        received_at_ms INTEGER,
        slot INTEGER,
        signature TEXT,
        event_index INTEGER NOT NULL DEFAULT 0,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        side TEXT NOT NULL,
        market TEXT,
        sol_amount REAL NOT NULL,
        token_amount REAL,
        price REAL,
        curve_pct REAL,
        age_ms INTEGER,
        position_phase TEXT,
        token_balance_before REAL,
        token_balance_after REAL,
        nearest_flow_signal INTEGER,
        time_from_flow_signal_ms INTEGER,
        UNIQUE(signature, event_index, wallet)
      );
      CREATE INDEX IF NOT EXISTS idx_smart_wallet_events_wallet_ts
        ON smart_wallet_events(wallet, timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_smart_wallet_events_mint_ts
        ON smart_wallet_events(mint, timestamp_ms);

      CREATE TABLE IF NOT EXISTS smart_signal_confirmations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL REFERENCES flow_signals(signal_id) ON DELETE CASCADE,
        smart_event_id INTEGER NOT NULL REFERENCES smart_wallet_events(id) ON DELETE CASCADE,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        open_timestamp_ms INTEGER NOT NULL,
        delay_ms INTEGER NOT NULL,
        open_sol REAL NOT NULL,
        UNIQUE(signal_id, smart_event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_smart_signal_confirmations_signal
        ON smart_signal_confirmations(signal_id);
      CREATE INDEX IF NOT EXISTS idx_smart_signal_confirmations_mint_ts
        ON smart_signal_confirmations(mint, open_timestamp_ms);

      CREATE TABLE IF NOT EXISTS smart_wallet_positions (
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        token_balaóMxÚÚ$z{-®éÜj×t„U$RF–ÖW7F×ö×2ãÒòäB6–væÅ÷f&–çBÄ”´Rw&–Ö'•öV&Ç•òRpĞ¢’ævWB‡6–æ6R’æâÀĞ¢6Ö'EvÆÆWEG&FW5FöF“¢F†—2æF"ç&W&R‚u4TÄT5B4õTåB‚¢’2âe$ôÒ6Ö'E÷vÆÆWEöWfVçG2t„U$RF–ÖW7F×ö×2ãÒòr’ævWB‡6–æ6R’æâÀĞ¢Ó°Ğ¢ĞĞ Ğ¢&V6VçE6–væÇ2†Æ–Ö—BÒ#’°Ğ¢&WGW&âF†—2æF"ç&W&R† Ğ¢4TÄT5B2â¢Â"ç&WGW&åóW2Â"ç&WGW&åó2Â"ç&WGW&åó32Â"æÖfUó2Â"æÖUó0Ğ¢e$ôÒfÆ÷u÷6–væÇ20Ğ¢ÄTeB¤ô”â6–væÅ÷&WGW&ç2"U4”är‡6–væÅö–BĞ¢t„U$R2æ—5÷&–Ö'’ÒĞ¢õ$DU"%’2çF–ÖW7F×ö×2DU40Ğ¢Ä”Ô•BğĞ¢’æÆÂ„ÖF‚æÖ–âƒóÂÖF‚æÖ‚ƒÂÆ–Ö—B’’“°Ğ¢ĞĞ Ğ¢6Ö'EvÆÆWE7FG2‡vÆÆWG2’°Ğ¢6öç7B&W7VÇBÒµÓ°Ğ¢6öç7BWfVçE7FFVÖVçBÒF†—2æF"ç&W&R† Ğ¢4TÄT5B¢e$ôÒ6Ö'E÷vÆÆWEöWfVçG2t„U$RvÆÆWBÒòõ$DU"%’F–ÖW7F×ö×0Ğ¢“°Ğ¢f÷"†6öç7BvÆÆWBöbvÆÆWG2’°Ğ¢6öç7BWfVçG2ÒWfVçE7FFVÖVçBæÆÂ‡vÆÆWB“°Ğ¢6öç7B÷VâÒæWrÖ‚“°Ğ¢6öç7B†öÆG2ÒµÓ°Ğ¢6öç7B†6VD'W—2ÒµÓ°Ğ¢f÷"†6öç7BWfVçBöbWfVçG2’°Ğ¢–b†WfVçBç6–FRÓÓÒt%U’r’°Ğ¢6öç7B†6RÒWfVçBç÷6—F–öå÷†6RÇÂ†÷Vâæ†2†WfVçBæÖ–çB’òtDBr¢tõTâr“°Ğ¢†6VD'W—2çW6‚‡²ââæWfVçBÂ†6RÒ“°Ğ¢–b‡†6RÓÓÒtõTâr’÷Vâç6WB†WfVçBæÖ–çBÂWfVçBçF–ÖW7F×ö×2“°Ğ¢ĞĞ¢–b†WfVçBç÷6—F–öå÷†6RÓÓÒt4Äõ4Rrbb÷Vâæ†2†WfVçBæÖ–çB’’°Ğ¢†öÆG2çW6‚†WfVçBçF–ÖW7F×ö×2Ò÷VâævWB†WfVçBæÖ–çB’“°Ğ¢÷VâæFVÆWFR†WfVçBæÖ–çB“°Ğ¢ĞĞ¢ĞĞ¢6öç7B'W—2Ò†6VD'W—3°Ğ¢6öç7B÷Væ–æt'W—2Ò'W—2æf–ÇFW"‚†WfVçB’ÓâWfVçBç†6RÓÓÒtõTâr“°Ğ¢6öç7BFD'W—2Ò'W—2æf–ÇFW"‚†WfVçB’ÓâWfVçBç†6RÓÓÒtDBr“°Ğ¢6öç7BfW&vRÒ‡fÇVW2’ÓâfÇVW2æÆVæwF€Ğ¢òfÇVW2ç&VGV6R‚‡F÷FÂÂfÇVR’ÓâF÷FÂ²fÇVRÂ’òfÇVW2æÆVæwF€Ğ¢¢çVÆÃ°Ğ¢6öç7B÷fW&Æ7BÒ‡&÷w2Âv–æF÷t×2’Óâ&÷w2æÆVæwF€Ğ¢ò‡&÷w2æf–ÇFW"‚†WfVçB’ÓâçVÖ&W"æ—4f–æ—FR†WfVçBçF–ÖUög&öÕöfÆ÷u÷6–væÅö×2Ğ¢bbWfVçBçF–ÖUög&öÕöfÆ÷u÷6–væÅö×2ãÒ Ğ¢bbWfVçBçF–ÖUög&öÕöfÆ÷u÷6–væÅö×2ÃÒv–æF÷t×2’æÆVæwF‚ò&÷w2æÆVæwF‚’¢ Ğ¢¢çVÆÃ°Ğ¢&W7VÇBçW6‚‡°Ğ¢vÆÆWBÀĞ¢G&FW3¢WfVçG2æÆVæwF‚ÀĞ¢&÷Vv‡EFö¶Vç3¢æWr6WB†'W—2æÖ‚†WfVçB’ÓâWfVçBæÖ–çB’’ç6—¦RÀĞ¢fW&vT†öÆD×3¢fW&vR††öÆG2’ÀĞ¢fW&vT'W”7W'fU7C¢fW&vR†'W—2æÖ‚†WfVçB’ÓâWfVçBæ7W'fU÷7B’æf–ÇFW"„çVÖ&W"æ—4f–æ—FR’’ÀĞ¢fW&vT'W”vT×3¢fW&vR†'W—2æÖ‚†WfVçB’ÓâWfVçBævUö×2’æf–ÇFW"„çVÖ&W"æ—4f–æ—FR’’ÀĞ¢'W”WfVçG3¢'W—2æÆVæwF‚ÀĞ¢÷Vä'W—3¢÷Væ–æt'W—2æÆVæwF‚ÀĞ¢FD'W—3¢FD'W—2æÆVæwF‚ÀĞ¢&–Ö'”÷fW&Æ37C¢÷fW&Æ7B†'W—2Â3ó’ÀĞ¢÷Vå6–væÄ÷fW&ÆU7C¢÷fW&Æ7B†÷Væ–æt'W—2ÂUó’ÀĞ¢÷Vå6–væÄ÷fW&Æ7C¢÷fW&Æ7B†÷Væ–æt'W—2Âó’ÀĞ¢÷Vå6–væÄ÷fW&Æ37C¢÷fW&Æ7B†÷Væ–æt'W—2Â3ó’ÀĞ¢FE6–væÄ÷fW&Æ37C¢÷fW&Æ7B†FD'W—2Â3ó’ÀĞ¢fÆ÷u6–væÄ÷fW&Æ7C¢÷fW&Æ7B†'W—2Â3ó’ÀĞ¢fW&vUF–ÖTg&öÕ6–væÄ×3¢fW&vR€Ğ¢'W—2æÖ‚†WfVçB’ÓâWfVçBçF–ÖUög&öÕöfÆ÷u÷6–væÅö×2’æf–ÇFW"„çVÖ&W"æ—4f–æ—FR’ÀĞ¢’ÀĞ¢Ò“°Ğ¢ĞĞ¢&WGW&â&W7VÇC°Ğ¢ĞĞ Ğ¢6–væÅ&WWF—F–öå7FG2‚’°Ğ¢6öç7B6–væÇ2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B6–væÅö–BÂÖ–çBÂF–ÖW7F×ö×2Â6–væÅöW—6öFUö–@Ğ¢e$ôÒfÆ÷u÷6–væÇ0Ğ¢t„U$R—5÷&–Ö'’ÒĞ¢õ$DU"%’F–ÖW7F×ö×2Â6–væÅö–@Ğ¢’æÆÂ‚“°Ğ¢6öç7BÆ7D'”Ö–çBÒæWrÖ‚“°Ğ¢ÆWBÆFW%6–væÇ2Ò°Ğ¢ÆWBv—F†–ãW2Ò°Ğ¢ÆWBv—F†–ã2Ò°Ğ¢ÆWBv—F†–ã32Ò°Ğ¢f÷"†6öç7B6–væÂöb6–væÇ2’°Ğ¢6öç7B&Wf–÷W2ÒÆ7D'”Ö–çBævWB‡6–væÂæÖ–çB“°Ğ¢–b„çVÖ&W"æ—4f–æ—FR‡&Wf–÷W2’’°Ğ¢ÆFW%6–væÇ2³Ò°Ğ¢6öç7BvÒ6–væÂçF–ÖW7F×ö×2Ò&Wf–÷W3°Ğ¢–b†vÃÒUó’v—F†–ãW2³Ò°Ğ¢–b†vÃÒó’v—F†–ã2³Ò°Ğ¢–b†vÃÒ3ó’v—F†–ã32³Ò°Ğ¢ĞĞ¢Æ7D'”Ö–çBç6WB‡6–væÂæÖ–çBÂ6–væÂçF–ÖW7F×ö×2“°Ğ¢ĞĞ¢6öç7B&F–òÒ‡fÇVRÂFVæöÖ–æF÷"’ÓâFVæöÖ–æF÷"òfÇVRòFVæöÖ–æF÷"¢¢çVÆÃ°Ğ¢&WGW&â°Ğ¢&–Ö'•6–væÇ3¢6–væÇ2æÆVæwF‚ÀĞ¢Væ—VTÖ–çG3¢Æ7D'”Ö–çBç6—¦RÀĞ¢6–væÄW—6öFW3¢æWr6WB‡6–væÇ2æÖ‚‡6–væÂ’Óâ6–væÂç6–væÅöW—6öFUö–BĞ¢æf–ÇFW"„&ööÆVâ’’ç6—¦RÀĞ¢ÆFW%6–væÇ2ÀĞ¢ÆFW%6–væÅ7C¢&F–ò†ÆFW%6–væÇ2Â6–væÇ2æÆVæwF‚’ÀĞ¢&WVFVEv—F†–ãW3¢v—F†–ãW2ÀĞ¢&WVFVEv—F†–ãW57C¢&F–ò‡v—F†–ãW2ÂÆFW%6–væÇ2’ÀĞ¢&WVFVEv—F†–ã3¢v—F†–ã2ÀĞ¢&WVFVEv—F†–ã57C¢&F–ò‡v—F†–ã2ÂÆFW%6–væÇ2’ÀĞ¢&WVFVEv—F†–ã33¢v—F†–ã32ÀĞ¢&WVFVEv—F†–ã357C¢&F–ò‡v—F†–ã32ÂÆFW%6–væÇ2’ÀĞ¢Ó°Ğ¢ĞĞ Ğ¢&6†—fTW‡—&VE&uG&FW2†æ÷rÒFFRææ÷r‚’ÂÆ–Ö—BÒó’°Ğ¢F†—2æfÇW6…&uG&FW2‚“°Ğ¢–b‡F†—2æ6öæf–ræF%F‚ÓÓÒs¦ÖVÖ÷'“¢r’&WGW&âçVÆÃ°Ğ¢6öç7B7WFöfbÒæ÷rÒF†—2æ6öæf–rç&u&WFVçF–öä†÷W'2¢5ócó°Ğ¢6öç7B&÷w2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B¢e$ôÒ&u÷G&FW2t„U$RF–ÖW7F×ö×2Âòõ$DU"%’–BÄ”Ô•BğĞ¢’æÆÂ†7WFöfbÂÆ–Ö—B“°Ğ¢–b‡&÷w2æÆVæwF‚ÓÓÒ’&WGW&âçVÆÃ°Ğ Ğ¢g2æÖ¶F—%7–æ2‡F†—2æ6öæf–ræ&6†—fTF—"Â²&V7W'6—fS¢G'VRÒ“°Ğ¢6öç7Bf—'7BÒ&÷w5³ÒçF–ÖW7F×ö×3°Ğ¢6öç7BÆ7BÒ&÷w5·&÷w2æÆVæwF‚ÒÒçF–ÖW7F×ö×3°Ğ¢6öç7B&6†—fUF‚ÒF‚æ¦ö–â€Ğ¢F†—2æ6öæf–ræ&6†—fTF—"ÀĞ¢&r×G&FW2ÒG¶f—'7GÒÒG¶Æ7GÒÒG¶æ÷wÒææF§6öâæw¦ÀĞ¢“°Ğ¢6öç7B&öG’Ò&÷w2æÖ‚‡&÷r’Óâ¥4ôâç7G&–æv–g’‡&÷r’’æ¦ö–â‚uÆâr’²uÆâs°Ğ¢g2çw&—FTf–ÆU7–æ2†&6†—fUF‚Â¦Æ–"æw¦—7–æ2†&öG’Â²ÆWfVÃ¢bÒ’“°Ğ¢6öç7BÖ„–BÒ&÷w5·&÷w2æÆVæwF‚ÒÒæ–C°Ğ¢F†—2æF"ç&W&R‚tDTÄUDRe$ôÒ&u÷G&FW2t„U$RF–ÖW7F×ö×2ÂòäB–BÃÒòr’ç'Vâ†7WFöfbÂÖ„–B“°Ğ¢F†—2æÖWG&–72æÆ7D&6†—fTBÒæ÷s°Ğ¢&WGW&â²&6†—fUF‚Â&÷w3¢&÷w2æÆVæwF‚Âf—'7BÂÆ7BÓ°Ğ¢ĞĞ Ğ¢†VÇF‚‚’°Ğ¢6öç7B&u&÷w2ÒF†—2æF"ç&W&R‚u4TÄT5B4õTåB‚¢’2âe$ôÒ&u÷G&FW2r’ævWB‚’æã°Ğ¢6öç7B6–væÅ&÷w2ÒF†—2æF"ç&W&R‚u4TÄT5B4õTåB‚¢’2âe$ôÒfÆ÷u÷6–væÇ2r’ævWB‚’æã°Ğ¢6öç7B&–Ö'•6–væÅ&÷w2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2âe$ôÒfÆ÷u÷6–væÇ2t„U$R—5÷&–Ö'’ÒĞ¢’ævWB‚’æã°Ğ¢6öç7BV&Ç•F‡&W6†öÆE6–væÅ&÷w2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2âe$ôÒfÆ÷u÷6–væÇ2t„U$R6–væÅ÷f&–çBÄ”´Rw&–Ö'•öV&Ç•òRpĞ¢’ævWB‚’æã°Ğ¢6öç7B6Ö'E6–væÄ6öæf—&ÖF–öç2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2âe$ôÒ6Ö'E÷6–væÅö6öæf—&ÖF–öç0Ğ¢’ævWB‚’æã°Ğ¢6öç7B&–Ö'”Æ—fTFV6—6–öç2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4ôÄU44R…5TÒ‡'VÆUöÖF6†VBÒ’Â’2ÖF6†VBÀĞ¢4ôÄU44R…5TÒ†7F–öå÷7FGW2ÒtõTâr’Â’2÷VæVBÀĞ¢4ôÄU44R…5TÒ†7F–öå÷7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀĞ¢4ôÄU44R…5TÒ†7F–öå÷7FGW2”â‚tTåE%•ôd”ÄTBrÂtU„•Eôd”ÄTBr’’Â’2f–ÆV@Ğ¢e$ôÒ&–Ö'•öÆ—fUöFV6—6–öç0Ğ¢’ævWB‚“°Ğ¢6öç7BÆ—fU÷6—F–öç2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4ôÄU44R…5TÒ‡7FGW2”â‚tõTä”ärrÂtõTârÂtU„•D”ärrÂtU„•Eôd”ÄTBr’’Â’27F—fRÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀĞ¢4ôÄU44R…5TÒ‡7FGW2”â‚tTåE%•ôd”ÄTBrÂtU„•Eôd”ÄTBr’’Â’2f–ÆV@Ğ¢e$ôÒÆ—fU÷÷6—F–öç0Ğ¢’ævWB‚“°Ğ¢6öç7B&–Ö'•6–væÅ6†F÷u÷6—F–öç2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4ôÄU44R…5TÒ‡7FGW2”â‚uTäD”äuôTåE%’rÂtõTârÂtU„•EõTäD”ärr’’Â’27F—fRÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀĞ¢4ôÄU44R…5TÒ‡7FGW2ÒtäõôU„•Br’Â’2æõöW†—@Ğ¢e$ôÒ&–Ö'•÷6–væÅ÷6†F÷u÷÷6—F–öç0Ğ¢’ævWB‚“°Ğ¢6öç7BfÆ÷tf—'7E6†F÷u÷6—F–öç2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4ôÄU44R…5TÒ‡7FGW2”â‚uTäD”äuôTåE%’rÂtõTârÂtU„•EõTäD”ärr’’Â’27F—fRÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀĞ¢4ôÄU44R…5TÒ‡7FGW2ÒtäõôU„•Br’Â’2æõöW†—@Ğ¢e$ôÒfÆ÷uöf—'7E÷6†F÷u÷÷6—F–öç0Ğ¢’ævWB‚“°Ğ¢6öç7B6Ö'EVÆÆ&6µ6†F÷u÷6—F–öç2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4ôÄU44R…5TÒ‡7FGW2”â€Ğ¢ut•D”äuõTÄÄ$4²rÂut•D”äuõ$T$õTäBrÂuTäD”äuôTåE%’rÂtõTârÂtU„•EõTäD”ärpĞ¢’’Â’27F—fRÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀĞ¢4ôÄU44R…5TÒ‡7FGW2ÒtäõôU„•Br’Â’2æõöW†—@Ğ¢e$ôÒ6Ö'E÷VÆÆ&6µ÷6†F÷u÷÷6—F–öç0Ğ¢’ævWB‚“°Ğ¢6öç7B6Ö'D÷Vå6†F÷u÷6—F–öç2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4ôÄU44R…5TÒ‡7FGW2”â‚uTäD”äuôTåE%’rÂtõTârÂtU„•EõTäD”ärr’’Â’27F—fRÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀĞ¢4ôÄU44R…5TÒ‡7FGW2ÒtäõôU„•Br’Â’2æõöW†—BÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òu%TÄUõ$T¤T5DTBr’Â’2&V¦V7FV@Ğ¢e$ôÒ6Ö'Eö÷Vå÷6†F÷u÷÷6—F–öç0Ğ¢’ævWB‚“°Ğ¢6öç7BfÆ÷u6Ö'D6öæf—&Õ6†F÷u÷6—F–öç2ÒF†—2æF"ç&W&R† ¢4TÄT5B4õTåB‚¢’2F÷FÂÀ¢4ôÄU44R…5TÒ‡7FGW2”â‚uTäD”äuôTåE%’rÂtõTârÂtU„•EõTäD”ärr’’Â’27F—fRÀ¢4ôÄU44R…5TÒ‡7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀ¢4ôÄU44R…5TÒ‡7FGW2ÒtäõôU„•Br’Â’2æõöW†—BÀ¢4ôÄU44R…5TÒ‡7FGW2Òu%TÄUõ$T¤T5DTBr’Â’2&V¦V7FV@¢e$ôÒfÆ÷u÷6Ö'Eö6öæf—&Õ÷6†F÷u÷÷6—F–öç0¢’ævWB‚“°¢6öç7BÆVæ6…VÆÆ&6µ6†F÷u÷6—F–öç2ÒF†—2æF"ç&W&R† ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4ôÄU44R…5TÒ‡7FGW2”â‚uTäD”äuôTåE%’rÂtõTârÂtU„•EõTäD”ärr’’Â’27F—fRÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀĞ¢4ôÄU44R…5TÒ‡7FGW2ÒtäõôU„•Br’Â’2æõöW†—BÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òu%TÄUõ$T¤T5DTBr’Â’2&V¦V7FV@Ğ¢e$ôÒÆVæ6…÷VÆÆ&6µ÷6†F÷u÷÷6—F–öç0Ğ¢’ævWB‚“°Ğ¢6öç7BÖ–w&FVDG&÷&V&÷VæE6†F÷u÷6—F–öç2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4õTåB„D•5D”ä5BW—6öFUö–B’26–væÇ2ÀĞ¢4õTåB„D•5D”ä5BÖ–çB’2Ö–çG2ÀĞ¢4õTåB„D•5D”ä5B44Rt„TâÆ–fV7–6ÆU÷7FvRÒu$UôÔ”u$D”ôârD„TâW—6öFUö–BTäBĞ¢2&UöÖ–w&F–öå÷6–væÇ2ÀĞ¢4õTåB„D•5D”ä5B44Rt„TâÆ–fV7–6ÆU÷7FvRÒuõ5EôÔ”u$D”ôârD„TâW—6öFUö–BTäBĞ¢2÷7EöÖ–w&F–öå÷6–væÇ2ÀĞ¢4ôÄU44R…5TÒ‡7FGW2”â‚uTäD”äuôTåE%’rÂtõTârÂtU„•EõTäD”ärr’’Â’27F—fRÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀĞ¢4ôÄU44R…5TÒ‡7FGW2ÒtäõôU„•Br’Â’2æõöW†—BÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òu$”4Uô¥TÕr’Â’2&–6Uö§V× Ğ¢e$ôÒÖ–w&FVEöG&÷÷&V&÷VæE÷6†F÷u÷÷6—F–öç0Ğ¢’ævWB‚“°Ğ¢6öç7B&ævU66ÇW%6†F÷u÷6—F–öç2ÒF†—2æF"ç&W&R† ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4õTåB„D•5D”ä5BW—6öFUö–B’26–væÇ2ÀĞ¢4õTåB„D•5D”ä5BÖ–çB’2Ö–çG2ÀĞ¢4ôÄU44R…5TÒ‡7FGW2”â‚uTäD”äuôTåE%’rÂtõTârÂtU„•EõTäD”ärr’’Â’27F—fRÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀĞ¢4ôÄU44R…5TÒ‡7FGW2ÒtäõôU„•Br’Â’2æõöW†—BÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òu$”4Uô¥TÕr’Â’2&–6Uö§V× Ğ¢e$ôÒ&ævU÷66ÇW%÷6†F÷u÷÷6—F–öç0¢’ævWB‚“°¢6öç7B7–V&Ç•—&Ö–E6†F÷u÷6—F–öç2ÒF†—2æF"ç&W&R† ¢4TÄT5B4õTåB‚¢’2F÷FÂÀ¢4õTåB„D•5D”ä5BW—6öFUö–B’26–væÇ2À¢4õTåB„D•5D”ä5BÖ–çB’2Ö–çG2À¢4ôÄU44R…5TÒ‡7FGW2”â‚uTäD”äuôTåE%’rÂtõTârÂtU„•EõTäD”ärr’’Â’27F—fRÀ¢4ôÄU44R…5TÒ‡7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀ¢4ôÄU44R…5TÒ‡7FGW2ÒtäõôU„•Br’Â’2æõöW†—BÀ¢4ôÄU44R…5TÒ‡7FGW2Òu$”4Uô¥TÕr’Â’2&–6Uö§V×À¢4ôÄU44R…5TÒ†FEö6÷VçB’Â’2FG2À¢4ôÄU44R…5TÒ‡66ÆUö÷WEö6÷VçB’Â’2'F–ÅöW†—G0¢e$ôÒ7–öV&Ç•÷—&Ö–E÷6†F÷u÷÷6—F–öç0¢’ævWB‚“°¢6öç7B&öæF–æt7W'fTÖöÖVçGVÕ6†F÷u÷6—F–öç2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4õTåB„D•5D”ä5BW—6öFUö–B’26–væÇ2ÀĞ¢4õTåB„D•5D”ä5BÖ–çB’2Ö–çG2ÀĞ¢4ôÄU44R…5TÒ‡7FGW2”â‚uTäD”äuôTåE%’rÂtõTârÂtU„•EõTäD”ärr’’Â’27F—fRÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀĞ¢4ôÄU44R…5TÒ‡7FGW2ÒtäõôU„•Br’Â’2æõöW†—BÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òu$”4Uô¥TÕr’Â’2&–6Uö§V× Ğ¢e$ôÒ&öæF–æuö7W'fUöÖöÖVçGVÕ÷6†F÷u÷÷6—F–öç0Ğ¢’ævWB‚“°Ğ¢6öç7B&öæF–æt7W'fTÖöÖVçGVÕ6†F÷u6æ6†÷G2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òtô%4U%dTBr’Â’2ö'6W'fVBÀĞ¢4ôÄU44R…5TÒ‡7FGW2ÒtäõõE$DRr’Â’2æõ÷G&FPĞ¢e$ôÒ&öæF–æuö7W'fUöÖöÖVçGVÕ÷6†F÷u÷6æ6†÷G0Ğ¢’ævWB‚“°Ğ¢6öç7Bw&GVF–öä†öÆE6†F÷u÷6—F–öç2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4õTåB„D•5D”ä5BW—6öFUö–B’26–væÇ2ÀĞ¢4õTåB„D•5D”ä5BÖ–çB’2Ö–çG2ÀĞ¢4ôÄU44R…5TÒ‡7FGW2”â‚uTäD”äuôTåE%’rÂtõTârÂtU„•EõTäD”ärr’’Â’27F—fRÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òt4Äõ4TBr’Â’26Æ÷6VBÀĞ¢4ôÄU44R…5TÒ‡7FGW2ÒtäõôU„•Br’Â’2æõöW†—BÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òu%TÄUõ$T¤T5DTBr’Â’2&V¦V7FVBÀĞ¢4ôÄU44R…5TÒ†w&GVF–öå÷&VG’Ò’Â’2w&GVF–öå÷&VGĞ¢e$ôÒw&GVF–öåö†öÆE÷6†F÷u÷÷6—F–öç0Ğ¢’ævWB‚“°Ğ¢6öç7BÆVæ6…VÆ—G”ö'6W'fF–öç2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5B4õTåB‚¢’2F÷FÂÀĞ¢4ôÄU44R…5TÒ‡7FGW2Òtô%4U%d”ärr’Â’27F—fRÀĞ¢4ôÄU44R…5TÒ‡&V&÷VæEöB•2äõBåTÄÂ’Â’2&VfW&Væ6U÷VÆÆ&6·2ÀĞ¢4ôÄU44R…5TÒ†Æ&VÅ÷7FGW2Òt4ôÕÄUDRr’Â’26ö×ÆWFRÀĞ¢4ôÄU44R…5TÒ†Æ&VÅ÷7FGW2Òu$”t…Eô4Tå4õ$TBr’Â’2&–v‡Eö6Vç6÷&VBÀĞ¢4ôÄU44R…5TÒ†Æ&VÅ÷7FGW2Òtäõõ$TdU$Tä4Rr’Â’2æõ÷&VfW&Væ6PĞ¢e$ôÒÆVæ6…÷VÆ—G•öö'6W'fF–öç0Ğ¢’ævWB‚“°Ğ¢6öç7BÆ&VÅ&÷w2ÒF†—2æF"ç&W&R† Ğ¢4TÄT5@Ğ¢4õTåB‚¢’2F÷FÂÀĞ¢4ôÄU44R…5TÒ†Æ&VÅ÷7FGW2ÒuTäD”ärr’Â’2VæF–ærÀĞ¢4ôÄU44R…5TÒ†Æ&VÅ÷7FGW2Òt4ôÕÄUDRr’Â’26ö×ÆWFRÀĞ¢4ôÄU44R…5TÒ†Æ&VÅ÷7FGW2Òu$”t…Eô4Tå4õ$TBr’Â’2&–v‡Eö6Vç6÷&VBÀĞ¢4õTåB‡&WGW&åó2’2ö'6W'fVEó2ÀĞ¢4õTåB‡&WGW&åóW2’2ö'6W'fVEóW2ÀĞ¢4õTåB‡&WGW&åó2’2ö'6W'fVEó2ÀĞ¢4õTåB‡&WGW&åó32’2ö'6W'fVEó32ÀĞ¢4õTåB‡&WGW&åóc2’2ö'6W'fVEóc0Ğ¢e$ôÒ6–væÅ÷&WGW&ç0Ğ¢’ævWB‚“°Ğ¢&WGW&â°Ğ¢ââçF†—2æÖWG&–72ÀĞ¢VæF–æuw&—FW3¢F†—2ç&t'VffW"æÆVæwF‚ÀĞ¢&u&÷w2ÀĞ¢6–væÅ&÷w2ÀĞ¢&–Ö'•6–væÅ&÷w2ÀĞ¢V&Ç•F‡&W6†öÆE6–væÅ&÷w2ÀĞ¢6†F÷u6–væÅ&÷w3¢6–væÅ&÷w2Ò&–Ö'•6–væÅ&÷w2ÒV&Ç•F‡&W6†öÆE6–væÅ&÷w2ÀĞ¢6Ö'E6–væÄ6öæf—&ÖF–öç2ÀĞ¢&–Ö'”Æ—fTFV6—6–öç2ÀĞ¢Æ—fU÷6—F–öç2ÀĞ¢&–Ö'•6–væÅ6†F÷u÷6—F–öç2ÀĞ¢fÆ÷tf—'7E6†F÷u÷6—F–öç2ÀĞ¢6Ö'EVÆÆ&6µ6†F÷u÷6—F–öç2ÀĞ¢6Ö'D÷Vå6†F÷u÷6—F–öç2À¢fÆ÷u6Ö'D6öæf—&Õ6†F÷u÷6—F–öç2À¢ÆVæ6…VÆÆ&6µ6†F÷u÷6—F–öç2ÀĞ¢Ö–w&FVDG&÷&V&÷VæE6†F÷u÷6—F–öç2ÀĞ¢&ævU66ÇW%6†F÷u÷6—F–öç2À¢7–V&Ç•—&Ö–E6†F÷u÷6—F–öç2À¢&öæF–æt7W'fTÖöÖVçGVÕ6†F÷u÷6—F–öç2À¢&öæF–æt7W'fTÖöÖVçGVÕ6†F÷u6æ6†÷G2ÀĞ¢w&GVF–öä†öÆE6†F÷u÷6—F–öç2ÀĞ¢ÆVæ6…VÆ—G”ö'6W'fF–öç2ÀĞ¢Æ&VÇ3¢Æ&VÅ&÷w2ÀĞ¢F%Fƒ¢F‚ç&W6öÇfR‡F†—2æ6öæf–ræF%F‚’ÀĞ¢Ó°Ğ¢ĞĞ Ğ¢ÆÅFö¶Vç2‚’°Ğ¢&WGW&â²ââçF†—2çFö¶Vç2çfÇVW2‚•Ó°Ğ¢ĞĞ Ğ¢vWEFö¶Vâ†Ö–çB’°Ğ¢&WGW&âF†—2çFö¶Vç2ævWB†Ö–çB’ÇÂçVÆÃ°Ğ¢ĞĞ Ğ¢6Æ÷6R‚’°Ğ¢–b‡F†—2æfÇW6…F–ÖW"’6ÆV$–çFW'fÂ‡F†—2æfÇW6…F–ÖW"“°Ğ¢F†—2æfÇW6…F–ÖW"ÒçVÆÃ°Ğ¢F†—2æfÇW6…&uG&FW2‚“°Ğ¢F†—2æF"æ6Æ÷6R‚“°Ğ¢ĞĞ§ĞĞ Ğ¦ÖöGVÆRæW‡÷'G2Ò°Ğ¢&W6V&6…7F÷&RÀĞ¢7W'fU&öw&W72ÀĞ§Ó°Ğ