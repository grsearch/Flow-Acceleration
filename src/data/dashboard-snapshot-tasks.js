'use strict';

// Read-only adapters: never call a trading observer's constructor/start/restore.
// Runtime counters come from the server facade, not invented worker instances.
const { ResearchStore } = require('./ResearchStore');

const EXTRA_SHADOWS = [
  ['big-winner', 'bigWinnerShadow', 'BigWinnerShadowSuite', 'big-winner'],
  ['smart-like-early', 'smartLikeEarlyShadow', 'SmartLikeEarlyShadowSuite', 'smart-like-early'],
  ['smart-resonance', 'smartResonanceShadow', 'SmartResonanceRightTailShadowSuite', 'smart-resonance'],
  ['smart-consensus-v2', 'smartWalletConsensusFlowRunnerShadow', 'SmartWalletConsensusFlowRunnerShadowSuite', null, true],
  ['smart-wallet-rug-escape', 'smartWalletRugEscapeShadow', 'SmartWalletRugEscapeShadowSuite', null, true],
  ['smart-first-open-right-tail', 'smartWalletFirstOpenRightTailShadow', 'SmartWalletFirstOpenRightTailShadowSuite', null, true],
  ['individual-smart-wallets', 'individualSmartWalletShadows', 'IndividualSmartWalletShadowPortfolio', null, true],
  ['public-flow-lead', 'publicFlowLeadShadow', 'PublicFlowLeadShadowSuite', 'public-flow-lead'],
  ['creator-affinity', 'creatorAffinityShadow', 'PublicFlowLeadShadowSuite', 'creator-affinity'],
  ['cya-slot-flow', 'cyaSlotFlowShadow', 'CyaSlotFlowShadowSuite', 'cya-slot-flow'],
  ['public-flow-recovery', 'publicFlowAbsorptionRecoveryShadow', 'PublicFlowAbsorptionRecoveryShadowSuite'],
  ['feature-edge-audit', 'featureEdgeAudit', 'FeatureEdgeAuditObserver'],
  ['post-migration-survivor', 'postMigrationSurvivorObserver', 'PostMigrationSurvivorObserver'],
  ['cya-organic-burst', 'cyaOrganicBurstShadow', 'CyaOrganicBurstShadowSuite'],
  ['early-pure-buy-burst', 'earlyPureBuyBurstShadow', 'EarlyPureBuyBurstShadowSuite'],
  ['same-slot-dump-backrun', 'sameSlotDumpBackrunShadow', 'SameSlotDumpBackrunShadowSuite'],
];

function createReadStore(db, sourceDbPath) {
  const store = Object.create(ResearchStore.prototype);
  Object.assign(store, { db, config: { dbPath: sourceDbPath }, metrics: {}, rawBuffer: [],
    dashboardStatsCache: new Map(), stmts: {
      activeLiveMintEntryLocks: db.prepare(`SELECT * FROM live_mint_entry_locks
        WHERE status='ACTIVE' ORDER BY COALESCE(last_checked_at,0), first_seen_at LIMIT ?`),
    } });
  return store;
}

function observerAdapter(name, config, store) {
  const module = require(`../core/${name}`);
  const instance = Object.create(module[name].prototype);
  Object.assign(instance, { store, db: store.db, config, now: () => Date.now(),
    health: () => ({ enabled: config.enabled, sendsTransactions: false,
      runtimeSource: 'SNAPSHOT_CONFIG_ONLY', entryProfiles: config.entryProfiles || [],
      exitProfiles: config.exitProfiles || [] }),
    // These dashboards used to flush their live observer's buffered writes.
    // The reader sees persisted rows only and must NEVER flush the source DB.
    _flushWrites: () => {},
  });
  if (name === 'PublicFlowLeadShadowSuite' || name === 'SmartWalletFirstOpenRightTailShadowSuite') {
    const fallback = name === 'PublicFlowLeadShadowSuite'
      ? 'public_flow_lead_shadow_positions' : 'smart_wallet_first_open_right_tail_shadow_positions';
    instance.storageTable = /^[a-z][a-z0-9_]*$/i.test(config.storageTable || '')
      ? config.storageTable : fallback;
    instance.strategyCode = config.strategyCode || 'SWFO-S/B-RT';
    instance.strategyName = config.strategyName || 'Smart Wallet First OPEN Right-Tail';
    instance.modeCode = config.modeCode || 'SHADOW_SMART_FIRST_OPEN_RIGHT_TAIL';
    instance.targetWallet = config.targetWallet || null;
    instance.targetMarket = config.targetMarket || null;
    instance.entryProfiles = new Map((config.entryProfiles || []).map((row) => [row.id, row]));
    instance.exitProfiles = new Map((config.exitProfiles || []).map((row) => [row.id, row]));
  }
  if (name === 'IndividualSmartWalletShadowPortfolio') {
    instance.suites = (config.profiles || []).filter((row) => row && row.enabled !== false)
      .map((profile) => ({ id: profile.id, label: profile.label, thesis: profile.thesis,
        suite: observerAdapter('SmartWalletFirstOpenRightTailShadowSuite', {
          ...(config.defaults || {}), ...profile, enabled: config.enabled === true,
        }, store) }));
  }
  if (name === 'FeatureEdgeAuditObserver') {
    instance.statements = {};
    if (config.enabled) {
      instance.statements.recent = store.db.prepare(`SELECT * FROM ${module.OBSERVATION_TABLE}
        WHERE label_schema_version=? AND signal_source=? ORDER BY signal_at_ms DESC LIMIT ?`);
      instance.statements.recentBnh = store.db.prepare(`SELECT b.* FROM ${module.BNH_TABLE} b
        JOIN ${module.OBSERVATION_TABLE} o ON o.id=b.observation_id
        WHERE o.label_schema_version=? AND o.signal_source=? ORDER BY b.signal_at_ms DESC LIMIT ?`);
    }
  }
  if (name === 'PostMigrationSurvivorObserver') {
    instance.statements = {};
    if (config.enabled) {
      instance.statements.recent = store.db.prepare(`SELECT * FROM post_migration_survivor_observations
        ORDER BY migration_at_ms DESC LIMIT ?`);
      instance.statements.recentShadow = store.db.prepare(`SELECT * FROM post_migration_survivor_shadow_positions
        ORDER BY signal_at_ms DESC, hold_ms ASC LIMIT ?`);
      instance.statements.recentMilestones = store.db.prepare(`SELECT * FROM post_migration_survivor_milestones
        ORDER BY observed_at_ms DESC LIMIT ?`);
    }
  }
  return instance;
}

function createSnapshotTasks(store, data) {
  const fast = Math.max(1000, Number(data.fastRefreshMs) || 15000);
  const shadow = Math.max(10000, Number(data.shadowRefreshMs) || 60000);
  const slow = Math.max(10000, Number(data.slowRefreshMs) || 300000);
  const idle = Math.max(fast, Number(data.idleStrategyRefreshMs) || 300000);
  const tasks = [];
  const add = (key, tier, intervalMs, compute) => tasks.push({ key, tier, intervalMs, compute });
  if (data.lane === 'FAST') {
    const strategies = data.liveStrategies || (data.liveStrategyIds || []).map((id) => ({ id }));
    const inactive = (row) => row.entryEnabled === false || row.enabled === false;
    for (const strategy of [...strategies].sort((a, b) => Number(inactive(a)) - Number(inactive(b)))) {
      add(`live-trading:${strategy.id}`, 'FAST', inactive(strategy) ? idle : fast,
        () => store.liveTradingDashboard({ strategyId: strategy.id,
          positionLimit: 100, orderLimit: 100, decisionLimit: 100 }));
    }
    add('overview', 'FAST', fast, () => store.overview(Date.now(), 0));
    add('recent-signals', 'FAST', fast, () => store.recentSignals(200));
    return tasks;
  }
  const settings = data.shadowSettings || {};
  const bundle = (session, compute) => () => ({
    timeSessions: store.shadowTimeSessionDashboard(session), ...compute(),
  });
  const existing = [
    ['primary', 'primary-shadow', 'primarySignalShadowDashboard'],
    ['flow-first', 'flow-first', 'flowFirstShadowDashboard', 'flowFirstBigWinnerPct'],
    ['smart-pullback', 'smart-pullback', 'smartPullbackShadowDashboard', 'smartPullbackBigWinnerPct'],
    ['smart-open', 'smart-open', 'smartOpenShadowDashboard', 'smartOpenBigWinnerPct'],
    ['launch-quality', null, 'launchQualityDashboard'],
    ['migrated-rebound', 'migrated-rebound', 'migratedDropReboundShadowDashboard', 'migratedBigWinnerPct'],
    ['holder-growth', 'holder-growth', 'holderGrowthShadowDashboard', 'holderGrowthBigWinnerPct'],
    ['quality-leader', 'quality-leader', 'qualityLeaderShadowDashboard', 'qualityLeaderBigWinnerPct'],
    ['migration-continuity', 'migration-continuity', 'migrationContinuityShadowDashboard'],
    ['bonding-momentum', 'bonding-momentum', 'bondingCurveMomentumShadowDashboard', 'bondingMomentumBigWinnerPct'],
    ['range-scalper', 'range-scalper', 'rangeScalperShadowDashboard'],
    ['flow-smart-confirm', 'flow-smart-confirm', 'flowSmartConfirmShadowDashboard'],
    ['cya-early-pyramid', 'cya-early-pyramid', 'cyaEarlyPyramidShadowDashboard'],
    ['graduation-hold', 'graduation-hold', 'graduationHoldShadowDashboard', 'graduationHoldBigWinnerPct'],
    ['graduation-acceleration', null, 'graduationAccelerationShadowDashboard', 'graduationAccelerationBigWinnerPct'],
  ];
  const existingConfigKeys = { primary: 'signalShadow', 'flow-first': 'flowFirstShadow',
    'smart-pullback': 'smartPullbackShadow', 'smart-open': 'smartOpenShadow',
    'launch-quality': 'launchQualityObserver', 'migrated-rebound': 'migratedDropReboundShadow',
    'holder-growth': 'holderGrowthShadow', 'quality-leader': 'qualityLeaderShadow',
    'migration-continuity': 'migrationContinuityShadow', 'bonding-momentum': 'bondingCurveMomentumShadow',
    'range-scalper': 'rangeScalperShadow', 'flow-smart-confirm': 'flowSmartConfirmShadow',
    'cya-early-pyramid': 'cyaEarlyPyramidShadow', 'graduation-hold': 'graduationHoldShadow',
    'graduation-acceleration': 'graduationAccelerationShadow' };
  for (const [slug, session, method, threshold] of existing) {
    const compute = () => store[method]({ positionLimit: 100, observationLimit: 100,
      snapshotLimit: 100, cacheStats: true,
      ...(threshold ? { bigWinnerPct: settings[threshold] ?? (slug === 'quality-leader' ? 100 : 50) } : {}),
    });
    const inactive = data.shadowConfigs?.[existingConfigKeys[slug]]?.enabled === false;
    add(`shadow:${slug}`, 'SHADOW', inactive ? Math.max(shadow, idle) : shadow,
      session ? bundle(session, compute) : compute);
  }
  for (const [slug, configKey, name, session, numericLimit] of EXTRA_SHADOWS) {
    const config = data.shadowConfigs?.[configKey];
    if (!config) continue;
    const compute = () => observerAdapter(name, config, store).dashboard(numericLimit ? 100 : {
      positionLimit: 100, observationLimit: 100, limit: 2000,
    });
    add(`shadow:${slug}`, 'SHADOW', config.enabled === false ? Math.max(shadow, idle) : shadow,
      session ? bundle(session, compute) : compute);
  }
  // These two legacy query-worker endpoints now share the same bounded history lane.
  add('shadow:launch-pullback', 'SHADOW', shadow, bundle('launch-pullback', () =>
    store.launchPullbackShadowDashboard({ positionLimit: 100, cacheStats: true })));
  add('shadow:migration-second-leg', 'SHADOW', shadow, () =>
    store.migrationSecondLegDashboard({ observationLimit: 100, snapshotLimit: 100,
      statsSnapshotLimit: 200000, cacheStats: true }));
  add('smart-wallets', 'SLOW', slow, () => store.smartWalletStats(data.smartWallets || []));
  add('signal-repetition', 'SLOW', slow, () => store.signalRepetitionStats());
  let registry;
  add('smart-wallet-registry', 'SLOW', slow, () => {
    const { SmartWalletRegistry } = require('../core/SmartWalletRegistry');
    registry ||= new SmartWalletRegistry({ store, config: {
      ...(data.smartWalletRegistryConfig || {}), skipStorageInit: true,
      readOnlyDashboard: true, maintenanceWorkerEnabled: true,
    } });
    return registry.dashboard(100);
  });
  add('smart-consensus-overlay', 'SLOW', slow, () => {
    const { SmartWalletConsensusOverlayObserver } = require('../core/SmartWalletConsensusOverlayObserver');
    const observer = Object.create(SmartWalletConsensusOverlayObserver.prototype);
    Object.assign(observer, { store, config: data.smartWalletConsensusOverlayConfig || {},
      now: () => Date.now(), lastSyncAt: 0, startedAt: 0, metrics: {} });
    return observer.dashboard(100);
  });
  return tasks;
}

module.exports = { createReadStore, createSnapshotTasks, observerAdapter, EXTRA_SHADOWS };
