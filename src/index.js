'use strict';

const { config, validateConfig, streamTokenFor } = require('./config');
const { PumpEventParser } = require('./core/PumpEventParser');
const PumpFlowStream = require('./core/PumpFlowStream');
const FlowAccelerationEngine = require('./core/FlowAccelerationEngine');
const SignalLabeler = require('./core/SignalLabeler');
const LiveTradingManager = require('./core/LiveTradingManager');
const { PrimarySignalShadowSuite } = require('./core/PrimarySignalShadowSuite');
const { FlowFirstShadowSuite } = require('./core/FlowFirstShadowSuite');
const { SmartPullbackShadowSuite } = require('./core/SmartPullbackShadowSuite');
const { SmartOpenShadowSuite } = require('./core/SmartOpenShadowSuite');
const { FlowSmartConfirmShadowSuite } = require('./core/FlowSmartConfirmShadowSuite');
const { SmartLikeEarlyShadowSuite } = require('./core/SmartLikeEarlyShadowSuite');
const {
  SmartResonanceRightTailShadowSuite,
} = require('./core/SmartResonanceRightTailShadowSuite');
const {
  SmartWalletRugEscapeShadowSuite,
} = require('./core/SmartWalletRugEscapeShadowSuite');
const {
  SmartWalletFirstOpenRightTailShadowSuite,
} = require('./core/SmartWalletFirstOpenRightTailShadowSuite');
const { PublicFlowLeadShadowSuite } = require('./core/PublicFlowLeadShadowSuite');
const { CyaSlotFlowShadowSuite } = require('./core/CyaSlotFlowShadowSuite');
const { CyaOrganicBurstShadowSuite } = require('./core/CyaOrganicBurstShadowSuite');
const {
  SameSlotDumpBackrunShadowSuite,
} = require('./core/SameSlotDumpBackrunShadowSuite');
const { LaunchPullbackShadowSuite } = require('./core/LaunchPullbackShadowSuite');
const { LaunchQualityObserver } = require('./core/LaunchQualityObserver');
const { MigrationSecondLegObserver } = require('./core/MigrationSecondLegObserver');
const {
  MigrationSecondLegShadowSuite,
} = require('./core/MigrationSecondLegShadowSuite');
const { MigratedDropReboundShadowSuite } = require('./core/MigratedDropReboundShadowSuite');
const { MigrationContinuityShadowSuite } = require('./core/MigrationContinuityShadowSuite');
const { RangeScalperShadowSuite } = require('./core/RangeScalperShadowSuite');
const { CyaEarlyPyramidShadowSuite } = require('./core/CyaEarlyPyramidShadowSuite');
const {
  BondingCurveMomentumShadowSuite,
} = require('./core/BondingCurveMomentumShadowSuite');
const { GraduationHoldShadowSuite } = require('./core/GraduationHoldShadowSuite');
const { HolderGrowthShadowSuite } = require('./core/HolderGrowthShadowSuite');
const { QualityLeaderShadowSuite } = require('./core/QualityLeaderShadowSuite');
const { BigWinnerShadowSuite } = require('./core/BigWinnerShadowSuite');
const {
  GraduationAccelerationShadowSuite,
} = require('./core/GraduationAccelerationShadowSuite');
const { PumpTradeExecutor } = require('./core/PumpTradeExecutor');
const { PreEntryRugRiskTracker } = require('./core/PreEntryRugRiskTracker');
const { ResearchStore } = require('./data/ResearchStore');
const ResearchServer = require('./server/server');
const { launchStartupDashboard } = require('./server/startup-dashboard');

function createRuntime(runtimeConfig = config) {
  const runtimeStartedAt = Date.now();
  console.log('[Startup] creating research store');
  const store = new ResearchStore(runtimeConfig.storage, runtimeConfig.labels);
  const startupReplayCacheMs = Math.max(
    0,
    Number(runtimeConfig.storage.startupReplayCacheMs) || 0,
  );
  if (startupReplayCacheMs > 0) {
    const replayStartedAt = Date.now();
    console.log(`[Startup] priming ${startupReplayCacheMs}ms trade replay cache`);
    store.primeStartupTradeReplay(Date.now() - startupReplayCacheMs);
    console.log(`[Startup] trade replay cache ready in ${Date.now() - replayStartedAt}ms`);
  }
  console.log('[Startup] restoring engine and pending labels');
  const engine = new FlowAccelerationEngine(runtimeConfig.strategy);
  engine.hydrateTokens(store.allTokens());
  engine.hydrateTrades(store.recentCurveTrades(Date.now() - runtimeConfig.strategy.bufferMs));
  const labeler = new SignalLabeler({ store, config: runtimeConfig.labels });
  labeler.restore(store.restorePendingSignals());
  console.log(`[Startup] engine and labels ready in ${Date.now() - runtimeStartedAt}ms`);
  const parser = new PumpEventParser({
    pumpProgramId: runtimeConfig.pump.programId,
    pumpAmmProgramId: runtimeConfig.pump.ammProgramId,
    wsolMint: runtimeConfig.pump.wsolMint,
  });
  const stream = new PumpFlowStream({ config: runtimeConfig, tokenForEndpoint: streamTokenFor });
  const executor = runtimeConfig.liveTrading.enabled && !runtimeConfig.liveTrading.dryRun
    ? new PumpTradeExecutor(runtimeConfig.liveTrading)
    : null;
  const trader = new LiveTradingManager({
    config: runtimeConfig.liveTrading,
    store,
    executor,
  });
  trader.start();
  const smartWallets = new Set([
    ...runtimeConfig.smartWallets,
    ...(runtimeConfig.smartLikeEarlyShadow.priorityWallets || []),
    ...(runtimeConfig.smartLikeEarlyShadow.walletClusters || [])
      .flatMap((cluster) => cluster.wallets || []),
  ]);
  const preEntryRugRisk = new PreEntryRugRiskTracker({
    config: runtimeConfig.preEntryRugRisk,
  });
  preEntryRugRisk.start();
  // All entry-capable live and Shadow strategies share this forward-only guard.
  // Observers still collect every trade so risk labels remain available for research.
  store.preEntryRugRisk = preEntryRugRisk;
  const signalShadow = new PrimarySignalShadowSuite({
    config: runtimeConfig.signalShadow,
    store,
  });
  signalShadow.start();
  const flowFirstShadow = new FlowFirstShadowSuite({
    config: runtimeConfig.flowFirstShadow,
    store,
  });
  flowFirstShadow.start();
  const smartPullbackShadow = new SmartPullbackShadowSuite({
    config: runtimeConfig.smartPullbackShadow,
    store,
  });
  smartPullbackShadow.start();
  const smartOpenShadow = new SmartOpenShadowSuite({
    config: runtimeConfig.smartOpenShadow,
    store,
  });
  smartOpenShadow.start();
  const flowSmartConfirmShadow = new FlowSmartConfirmShadowSuite({
    config: runtimeConfig.flowSmartConfirmShadow,
    store,
  });
  flowSmartConfirmShadow.start();
  const smartLikeEarlyShadow = new SmartLikeEarlyShadowSuite({
    config: runtimeConfig.smartLikeEarlyShadow,
    store,
  });
  smartLikeEarlyShadow.start();
  const smartResonanceShadow = new SmartResonanceRightTailShadowSuite({
    config: {
      ...runtimeConfig.smartResonanceShadow,
      smartWallets: [...smartWallets],
    },
    store,
    rugRiskTracker: preEntryRugRisk,
  });
  smartResonanceShadow.start();
  const smartWalletRugEscapeShadow = new SmartWalletRugEscapeShadowSuite({
    config: runtimeConfig.smartWalletRugEscapeShadow,
    store,
    rugRiskTracker: preEntryRugRisk,
  });
  smartWalletRugEscapeShadow.start();
  const smartWalletFirstOpenRightTailShadow = new SmartWalletFirstOpenRightTailShadowSuite({
    config: runtimeConfig.smartWalletFirstOpenRightTailShadow,
    store,
    rugRiskTracker: preEntryRugRisk,
  });
  smartWalletFirstOpenRightTailShadow.start();
  const publicFlowLeadShadow = new PublicFlowLeadShadowSuite({
    config: {
      ...runtimeConfig.publicFlowLeadShadow,
      smartWallets: [...smartWallets],
    },
    store,
    rugRiskTracker: preEntryRugRisk,
  });
  publicFlowLeadShadow.start();
  const cyaSlotFlowShadow = new CyaSlotFlowShadowSuite({
    config: {
      ...runtimeConfig.cyaSlotFlowShadow,
      excludedWallets: [...smartWallets],
    },
    store,
  });
  cyaSlotFlowShadow.start();
  const cyaOrganicBurstShadow = new CyaOrganicBurstShadowSuite({
    config: {
      ...runtimeConfig.cyaOrganicBurstShadow,
      smartWallets: [...smartWallets],
    },
    store,
    onLiveSignal: (event) => trader.onExternalStrategySignal(event),
  });
  cyaOrganicBurstShadow.start();
  const sameSlotDumpBackrunShadow = new SameSlotDumpBackrunShadowSuite({
    config: runtimeConfig.sameSlotDumpBackrunShadow,
    store,
  });
  sameSlotDumpBackrunShadow.start();
  const launchPullbackShadow = new LaunchPullbackShadowSuite({
    config: runtimeConfig.launchPullbackShadow,
    store,
    onLiveSignal: (event) => trader.onExternalStrategySignal(event),
  });
  launchPullbackShadow.start();
  const holderGrowthShadow = new HolderGrowthShadowSuite({
    config: runtimeConfig.holderGrowthShadow,
    store,
  });
  holderGrowthShadow.start();
  const qualityLeaderShadow = new QualityLeaderShadowSuite({
    config: runtimeConfig.qualityLeaderShadow,
    store,
    onLiveSignal: (event) => trader.onExternalStrategySignal(event),
  });
  qualityLeaderShadow.start();
  const bigWinnerShadow = new BigWinnerShadowSuite({
    config: runtimeConfig.bigWinnerShadow,
    store,
    onLiveSignal: (event) => trader.onExternalStrategySignal(event),
  });
  bigWinnerShadow.start();
  const launchQualityObserver = new LaunchQualityObserver({
    config: runtimeConfig.launchQualityObserver,
    store,
    rugRiskTracker: preEntryRugRisk,
    onReference: (reference) => launchPullbackShadow.onReference(reference),
    onSnapshot: (snapshot, options) => {
      holderGrowthShadow.onSnapshot(snapshot, options);
      qualityLeaderShadow.onSnapshot(snapshot, options);
    },
  });
  launchQualityObserver.start();
  const migrationSecondLegShadow = new MigrationSecondLegShadowSuite({
    config: runtimeConfig.migrationSecondLegShadow,
    store,
  });
  migrationSecondLegShadow.start();
  const migrationSecondLegObserver = new MigrationSecondLegObserver({
    config: runtimeConfig.migrationSecondLegObserver,
    store,
    rugRiskTracker: preEntryRugRisk,
    onSnapshot: (snapshot, trade) => migrationSecondLegShadow.onSnapshot(snapshot, trade),
  });
  const m2fStartedAt = Date.now();
  console.log('[Startup] starting M2F-OBS without historical replay');
  migrationSecondLegObserver.start();
  console.log(`[Startup] M2F-OBS ready in ${Date.now() - m2fStartedAt}ms`);
  const migratedDropReboundShadow = new MigratedDropReboundShadowSuite({
    config: runtimeConfig.migratedDropReboundShadow,
    store,
    rugRiskTracker: preEntryRugRisk,
    onLiveSignal: (event) => trader.onExternalStrategySignal(event),
  });
  migratedDropReboundShadow.start();
  const migrationContinuityShadow = new MigrationContinuityShadowSuite({
    config: runtimeConfig.migrationContinuityShadow,
    store,
    onLiveSignal: (event) => trader.onExternalStrategySignal(event),
  });
  migrationContinuityShadow.start();
  const rangeScalperShadow = new RangeScalperShadowSuite({
    config: runtimeConfig.rangeScalperShadow,
    store,
  });
  rangeScalperShadow.start();
  const cyaEarlyPyramidShadow = new CyaEarlyPyramidShadowSuite({
    config: runtimeConfig.cyaEarlyPyramidShadow,
    store,
  });
  cyaEarlyPyramidShadow.start();
  const bondingCurveMomentumShadow = new BondingCurveMomentumShadowSuite({
    config: runtimeConfig.bondingCurveMomentumShadow,
    store,
  });
  bondingCurveMomentumShadow.start();
  const graduationHoldShadow = new GraduationHoldShadowSuite({
    config: runtimeConfig.graduationHoldShadow,
    store,
  });
  graduationHoldShadow.start();
  const graduationAccelerationShadow = new GraduationAccelerationShadowSuite({
    config: runtimeConfig.graduationAccelerationShadow,
    store,
    onLiveSignal: (event) => trader.onExternalStrategySignal(event),
  });
  graduationAccelerationShadow.start();
  trader.addEntryFailureObserver((event) => {
    graduationAccelerationShadow.onLiveEntryFailure(event);
  });
  store.releaseStartupTradeReplay();
  console.log(`[Startup] all strategy state restored in ${Date.now() - runtimeStartedAt}ms`);
  const server = new ResearchServer({
    config: runtimeConfig,
    store,
    engine,
    stream,
    labeler,
    trader,
    signalShadow,
    flowFirstShadow,
    smartPullbackShadow,
    smartOpenShadow,
    flowSmartConfirmShadow,
    smartLikeEarlyShadow,
    preEntryRugRisk,
    smartResonanceShadow,
    smartWalletRugEscapeShadow,
    smartWalletFirstOpenRightTailShadow,
    publicFlowLeadShadow,
    cyaSlotFlowShadow,
    cyaOrganicBurstShadow,
    sameSlotDumpBackrunShadow,
    launchPullbackShadow,
    launchQualityObserver,
    migrationSecondLegObserver,
    migrationSecondLegShadow,
    migratedDropReboundShadow,
    migrationContinuityShadow,
    rangeScalperShadow,
    cyaEarlyPyramidShadow,
    bondingCurveMomentumShadow,
    graduationHoldShadow,
    holderGrowthShadow,
    qualityLeaderShadow,
    bigWinnerShadow,
    graduationAccelerationShadow,
  });
  const runtimeMetrics = {
    parsedEvents: 0,
    parseErrors: 0,
    ignoredEvents: 0,
    shadowModuleErrors: {},
  };
  const slowTaskLastLoggedAt = new Map();
  const runTimed = (name, callback, thresholdMs = 100) => {
    const startedAt = process.hrtime.bigint();
    try {
      return callback();
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      if (durationMs >= thresholdMs) {
        const now = Date.now();
        if (now - (slowTaskLastLoggedAt.get(name) || 0) >= 30_000) {
          slowTaskLastLoggedAt.set(name, now);
          console.warn(`[Runtime:slow] ${name} ${durationMs.toFixed(1)}ms`);
        }
      }
    }
  };
  const observeShadow = (name, callback) => {
    try {
      return runTimed(`shadow:${name}`, callback);
    } catch (error) {
      runtimeMetrics.shadowModuleErrors[name] = (runtimeMetrics.shadowModuleErrors[name] || 0) + 1;
      console.error(`[Shadow:${name}] isolated failure:`, error.message);
      return undefined;
    }
  };
  let maintenanceTimer = null;
  let stopping = false;

  const refreshAmmSubscriptions = (now = Date.now()) => {
    const graduatedPending = labeler.pendingMints()
      .filter((mint) => store.getToken(mint)?.graduated_at);
    stream.setAmmMints([...new Set([
      ...graduatedPending,
      ...trader.trackedMints(now),
      ...migratedDropReboundShadow.trackedMints(now),
      ...migrationContinuityShadow.trackedMints(now),
      ...rangeScalperShadow.trackedMints(now),
      ...cyaEarlyPyramidShadow.trackedMints(),
      ...smartLikeEarlyShadow.trackedMints(),
      ...smartResonanceShadow.trackedMints(),
      ...smartWalletRugEscapeShadow.trackedMints(),
      ...smartWalletFirstOpenRightTailShadow.trackedMints(),
      ...publicFlowLeadShadow.trackedMints(),
      ...cyaSlotFlowShadow.trackedMints(),
      ...cyaOrganicBurstShadow.trackedMints(),
      ...sameSlotDumpBackrunShadow.trackedMints(now),
      ...bondingCurveMomentumShadow.trackedMints(),
      ...graduationHoldShadow.trackedMints(),
      ...holderGrowthShadow.trackedMints(),
      ...qualityLeaderShadow.trackedMints(),
      ...bigWinnerShadow.trackedMints(),
      ...graduationAccelerationShadow.trackedMints(),
      ...migrationSecondLegObserver.trackedMints(now),
      ...migrationSecondLegShadow.trackedMints(),
    ])]);
  };

  engine.on('candidate', (candidate) => {
    console.log(
      `[Candidate] ${candidate.symbol || candidate.mint.slice(0, 8)} `
      + `volume=${candidate.activityVolumeSol.toFixed(2)}SOL `
      + `tx=${candidate.activityTxCount} wallets=${candidate.activityUniqueWallets}`,
    );
  });

  const persistSignal = (signal, logPrefix) => {
    try {
      const saved = store.recordSignal(signal);
      labeler.addSignal(saved);
      observeShadow('launchPullbackSignal', () => launchPullbackShadow.onSignal(saved));
      observeShadow('smartLikeEarlySignal', () => smartLikeEarlyShadow.onSignal(saved));
      console.log(
        `[${logPrefix}] ${signal.signalVariant} ${signal.symbol || signal.mint.slice(0, 8)} `
        + `net=${signal.netFlowW1.toFixed(2)}→${signal.netFlowW2.toFixed(2)}`
        + `→${signal.netFlowW3.toFixed(2)}SOL `
        + `buyers=${signal.uniqueBuyersW1}→${signal.uniqueBuyersW2}`
        + `→${signal.uniqueBuyersW3} `
        + `tx=${signal.buyTxW1}→${signal.buyTxW2}→${signal.buyTxW3}`,
      );
      return saved;
    } catch (error) {
      console.error('[Signal] persistence failed:', error.message);
      return null;
    }
  };

  engine.on('signal', (signal) => {
    const saved = persistSignal(signal, 'FLOW_ACCEL_SIGNAL');
    if (saved) {
      observeShadow('flowFirstSignal', () => flowFirstShadow.onSignal(saved));
      observeShadow('graduationHoldSignal', () => graduationHoldShadow.onSignal(saved));
    }
  });
  engine.on('shadowSignal', (signal) => persistSignal(signal, 'FLOW_SHADOW_SIGNAL'));
  engine.on('primaryThresholdSignal', (signal) => {
    const saved = persistSignal(signal, 'PRIMARY_THRESHOLD_SIGNAL');
    if (!saved) return;
    observeShadow('primarySignalEvent', () => signalShadow.onSignal(saved));
  });

  stream.on('transaction', (transaction, context) => {
    let events;
    try {
      events = parser.parseTransaction(transaction, context.receivedAt);
    } catch (error) {
      runtimeMetrics.parseErrors += 1;
      console.error('[Parser] transaction failed:', error.message);
      return;
    }

    for (const event of events) {
      runtimeMetrics.parsedEvents += 1;
      try {
        if (event.type === 'create') {
          const token = store.recordCreate(event);
          engine.handleCreate(token || event);
          observeShadow('launchQualityCreate', () => launchQualityObserver.onCreate(token || event));
          observeShadow('graduationAccelerationCreate', () => (
            graduationAccelerationShadow.onCreate(token || event)
          ));
          continue;
        }
        if (event.type === 'complete') {
          const token = store.recordComplete(event);
          engine.handleComplete(event);
          observeShadow('migratedDropReboundGraduate', () => (
            migratedDropReboundShadow.onGraduated(token || event)
          ));
          observeShadow('migrationContinuityGraduate', () => (
            migrationContinuityShadow.onGraduated(token || event)
          ));
          observeShadow('rangeScalperGraduate', () => rangeScalperShadow.onGraduated(token || event));
          trader.onGraduated(token || event);
          observeShadow('graduationHoldGraduate', () => graduationHoldShadow.onGraduated(token || event));
          observeShadow('holderGrowthGraduate', () => holderGrowthShadow.onGraduated(token || event));
          observeShadow('qualityLeaderGraduate', () => qualityLeaderShadow.onGraduated(token || event));
          observeShadow('bigWinnerGraduate', () => bigWinnerShadow.onGraduated(token || event));
          observeShadow('graduationAccelerationGraduate', () => (
            graduationAccelerationShadow.onGraduated(token || event)
          ));
          observeShadow('migrationSecondLegGraduate', () => (
            migrationSecondLegObserver.onGraduated(token || event)
          ));
          observeShadow('sameSlotDumpBackrunGraduate', () => (
            sameSlotDumpBackrunShadow.onGraduated(token || event)
          ));
          refreshAmmSubscriptions(event.completedAt || event.timestampMs || Date.now());
          continue;
        }
        if (event.type === 'migration') {
          const token = store.recordMigration(event);
          engine.handleComplete({ ...event, completedAt: event.migratedAt });
          observeShadow('migratedDropReboundGraduate', () => (
            migratedDropReboundShadow.onGraduated(token || event)
          ));
          observeShadow('migrationContinuityGraduate', () => (
            migrationContinuityShadow.onGraduated(token || event)
          ));
          observeShadow('rangeScalperGraduate', () => rangeScalperShadow.onGraduated(token || event));
          trader.onGraduated(token || event);
          observeShadow('graduationHoldGraduate', () => graduationHoldShadow.onGraduated(token || event));
          observeShadow('holderGrowthGraduate', () => holderGrowthShadow.onGraduated(token || event));
          observeShadow('qualityLeaderGraduate', () => qualityLeaderShadow.onGraduated(token || event));
          observeShadow('bigWinnerGraduate', () => bigWinnerShadow.onGraduated(token || event));
          observeShadow('graduationAccelerationGraduate', () => (
            graduationAccelerationShadow.onGraduated(token || event)
          ));
          observeShadow('migrationSecondLegGraduate', () => (
            migrationSecondLegObserver.onGraduated(token || event)
          ));
          observeShadow('sameSlotDumpBackrunGraduate', () => (
            sameSlotDumpBackrunShadow.onGraduated(token || event)
          ));
          refreshAmmSubscriptions(event.migratedAt || event.timestampMs || Date.now());
          continue;
        }
        if (event.type !== 'trade' && event.type !== 'ammTrade') {
          runtimeMetrics.ignoredEvents += 1;
          continue;
        }

        if (event.type === 'ammTrade') {
          event.mint = store.resolveAmmMint(event.pool, event.mint);
        }
        if (!event.mint || !Number.isFinite(event.solAmount) || event.solAmount <= 0
          || !Number.isFinite(event.tokenAmount) || event.tokenAmount <= 0
          || !Number.isFinite(event.price) || event.price <= 0) {
          runtimeMetrics.ignoredEvents += 1;
          continue;
        }

        const trade = store.enrichTrade(event);
        const isSmartWalletTrade = Boolean(trade.wallet && smartWallets.has(trade.wallet));
        const smartOpenContext = isSmartWalletTrade
          ? engine.recentBuyContext(
            trade.mint,
            trade.timestampMs,
            runtimeConfig.smartOpenShadow.preBuyWindowMs,
            trade.wallet,
          )
          : null;
        store.queueRawTrade(trade);
        // SDBR must inspect the pre-dump RUG snapshot. It only mutates bounded
        // in-memory state here; all SQLite writes are deferred to maintenance.
        observeShadow('sameSlotDumpBackrun', () => sameSlotDumpBackrunShadow.observeTrade(trade));
        observeShadow('preEntryRugRisk', () => preEntryRugRisk.observeTrade(trade));
        observeShadow('smartLikeEarly', () => smartLikeEarlyShadow.observeTrade(trade));
        observeShadow('smartResonance', () => smartResonanceShadow.observeTrade(trade));
        observeShadow('smartWalletRugEscape', () => (
          smartWalletRugEscapeShadow.observeTrade(trade)
        ));
        observeShadow('smartWalletFirstOpenRightTail', () => (
          smartWalletFirstOpenRightTailShadow.observeTrade(trade)
        ));
        observeShadow('publicFlowLead', () => publicFlowLeadShadow.observeTrade(trade));
        observeShadow('cyaSlotFlow', () => cyaSlotFlowShadow.observeTrade(trade));
        observeShadow('cyaOrganicBurst', () => cyaOrganicBurstShadow.observeTrade(trade));
        observeShadow('migratedDropRebound', () => migratedDropReboundShadow.observeTrade(trade));
        observeShadow('migrationContinuity', () => migrationContinuityShadow.observeTrade(trade));
        observeShadow('rangeScalper', () => rangeScalperShadow.observeTrade(trade));
        observeShadow('cyaEarlyPyramid', () => cyaEarlyPyramidShadow.observeTrade(trade));
        observeShadow('bondingCurveMomentum', () => bondingCurveMomentumShadow.observeTrade(trade));
        observeShadow('graduationHold', () => graduationHoldShadow.observeTrade(trade));
        observeShadow('launchQuality', () => launchQualityObserver.observeTrade(trade));
        observeShadow('migrationSecondLeg', () => migrationSecondLegObserver.observeTrade(trade));
        observeShadow('migrationSecondLegShadow', () => migrationSecondLegShadow.observeTrade(trade));
        observeShadow('holderGrowth', () => holderGrowthShadow.observeTrade(trade));
        observeShadow('qualityLeader', () => qualityLeaderShadow.observeTrade(trade));
        observeShadow('bigWinner', () => bigWinnerShadow.observeTrade(trade));
        observeShadow('graduationAcceleration', () => (
          graduationAccelerationShadow.observeTrade(trade)
        ));
        observeShadow('launchPullback', () => launchPullbackShadow.observeTrade(trade));
        observeShadow('primarySignal', () => signalShadow.observeTrade(trade));
        engine.handleTrade(trade, store.getToken(trade.mint));
        observeShadow('flowFirst', () => flowFirstShadow.observeTrade(trade));
        labeler.onTrade(trade);
        trader.observeTrade(trade);
        if (isSmartWalletTrade) {
          const smartEvent = store.recordSmartWalletEvent(trade);
          if (smartEvent?.inserted) {
            const normalizedSmartEvent = { ...trade, ...smartEvent, id: smartEvent.id };
            observeShadow('smartOpenEvent', () => (
              smartOpenShadow.onSmartWalletEvent(normalizedSmartEvent, smartOpenContext || {})
            ));
            observeShadow('flowSmartConfirmEvent', () => (
              flowSmartConfirmShadow.onSmartWalletOpen(normalizedSmartEvent)
            ));
            observeShadow('smartLikeEarlyEvent', () => (
              smartLikeEarlyShadow.onSmartWalletEvent(normalizedSmartEvent)
            ));
            observeShadow('smartResonanceEvent', () => (
              smartResonanceShadow.onSmartWalletEvent(normalizedSmartEvent)
            ));
            observeShadow('smartWalletRugEscapeEvent', () => (
              smartWalletRugEscapeShadow.onSmartWalletEvent(normalizedSmartEvent)
            ));
            observeShadow('smartWalletFirstOpenRightTailEvent', () => (
              smartWalletFirstOpenRightTailShadow.onSmartWalletEvent(normalizedSmartEvent)
            ));
            observeShadow('publicFlowLeadLabel', () => (
              publicFlowLeadShadow.onSmartWalletEvent(normalizedSmartEvent)
            ));
            observeShadow('cyaSlotFlowLabel', () => (
              cyaSlotFlowShadow.onSmartWalletEvent(normalizedSmartEvent)
            ));
            observeShadow('cyaOrganicBurstLabel', () => (
              cyaOrganicBurstShadow.onSmartWalletEvent(normalizedSmartEvent)
            ));
            if (trade.side === 'BUY') {
              observeShadow('smartPullbackEvent', () => (
                smartPullbackShadow.onSmartWalletBuy({ ...trade, id: smartEvent.id })
              ));
            }
          }
        }
        observeShadow('smartPullback', () => smartPullbackShadow.observeTrade(trade));
        observeShadow('smartOpen', () => smartOpenShadow.observeTrade(trade));
        observeShadow('flowSmartConfirm', () => flowSmartConfirmShadow.observeTrade(trade));
      } catch (error) {
        runtimeMetrics.parseErrors += 1;
        console.error(`[Runtime] ${event.type} failed:`, error.message);
      }
    }
  });

  stream.on('streamError', ({ label, phase, error }) => {
    console.error(`[Stream:${label}] ${phase}: ${error?.message || error}`);
  });

  async function start() {
    await server.start();
    console.log(`Flow Acceleration dashboard: http://127.0.0.1:${runtimeConfig.server.port}`);
    console.log(`Trading mode: ${trader.mode}. Full research capture remains enabled.`);
    if (runtimeConfig.liveTrading.safetyLock) {
      console.log('Live trading safety lock: ON. Signing and chain submission are disabled.');
    }
    console.log(`Live strategies: ${runtimeConfig.liveTrading.strategies.map((strategy) => (
      `${strategy.id}=${strategy.positionSizeSol}SOL/${strategy.market}`
    )).join(', ')}; legacy Primary live entry=retired.`);
    console.log(
      `Shadow entry cohorts: ${runtimeConfig.signalShadow.profiles.map((profile) => (
        `${profile.id}=${profile.minNetFlowW3Sol}SOL/${profile.minUniqueBuyersW3}buyers`
      )).join(', ')}.`,
    );
    console.log(
      `Flow-First Shadow C: ${runtimeConfig.flowFirstShadow.cohorts.map((cohort) => (
        cohort.exitMode === 'FIXED_HOLD'
          ? `${cohort.id}=hold${cohort.fixedHoldMs}ms`
          : `${cohort.id}=trailing${cohort.trailingStopPct}%`
      )).join(', ')}; one entry per Primary episode; sends transactions=false.`,
    );
    console.log(
      `Smart pullback Shadow A/B: ${runtimeConfig.smartPullbackShadow.cohorts.map((cohort) => (
        `${cohort.id}=trailing${cohort.trailingStopPct}%`
      )).join(', ')}; sends transactions=false.`,
    );
    console.log(
      `Smart OPEN Shadow D: ${runtimeConfig.smartOpenShadow.cohorts.map((cohort) => (
        `${cohort.id}=${cohort.exitMode}`
      )).join(', ')}; isolated table; sends transactions=false.`,
    );
    console.log(
      `Flow->Smart Confirm Shadow L: ${runtimeConfig.flowSmartConfirmShadow.cohorts
        .map((cohort) => cohort.id).join(', ')}; forward entry only; sends transactions=false.`,
    );
    console.log(
      `Smart-Like Early Shadow: ${runtimeConfig.smartLikeEarlyShadow.entryProfiles.length} entries x `
      + `${runtimeConfig.smartLikeEarlyShadow.addProfiles.length} add policies x `
      + `${runtimeConfig.smartLikeEarlyShadow.exitProfiles.length} exits; isolated table; `
      + 'causal fills only; sends transactions=false.',
    );
    console.log(
      `Smart Resonance Right-Tail Shadow SR: ${runtimeConfig.smartResonanceShadow.entryProfiles.length} `
      + `causal entries x ${runtimeConfig.smartResonanceShadow.exitProfiles.length} fixed-hold exits; `
      + 'distinct-wallet edge only; sends transactions=false.',
    );
    console.log(
      `Public Flow Lead Shadow PFL: ${runtimeConfig.publicFlowLeadShadow.entryProfiles.length} `
      + `public-only entries x ${runtimeConfig.publicFlowLeadShadow.exitProfiles.length} exits; `
      + 'Smart OPEN=future label, ADD=ignored, sends transactions=false.',
    );
    console.log(
      `CYA Slot Flow Shadow CSF: ${runtimeConfig.cyaSlotFlowShadow.entryProfiles.length} `
      + `completed-slot entries x ${runtimeConfig.cyaSlotFlowShadow.managementProfiles.length} `
      + 'management profiles; target wallet excluded, target OPEN=future label, '
      + 'capacity-aware fills, sends transactions=false.',
    );
    console.log(
      `Same-Slot Dump Backrun Shadow SDBR: ${runtimeConfig.sameSlotDumpBackrunShadow.entryProfiles.length} `
      + `dump filters x ${runtimeConfig.sameSlotDumpBackrunShadow.exitProfiles.length} exits; `
      + `${runtimeConfig.sameSlotDumpBackrunShadow.positionSizeSol} SOL reserve-priced theoretical fill; `
      + 'deferred writes, no RPC, sends transactions=false.',
    );
    console.log(
      `Launch Quality Observer: snapshots=${runtimeConfig.launchQualityObserver.snapshotHorizonsMs
        .map((value) => `${value / 1_000}s`).join(',')}; `
      + `reference=${runtimeConfig.launchQualityObserver.pumpReferencePct}% pump / `
      + `${runtimeConfig.launchQualityObserver.pullbackReferencePct}% pullback / `
      + `${runtimeConfig.launchQualityObserver.reboundReferencePct}% rebound; `
      + 'observer-only, sends transactions=false.',
    );
    console.log(
      `M2F-OBS: PumpSwap ${(runtimeConfig.migrationSecondLegObserver.maxAgeMs / 1_000)}s `
      + `at ${runtimeConfig.migrationSecondLegObserver.snapshotIntervalMs}ms intervals; `
      + 'observer-only, no simulated positions, no extra RPC, sends transactions=false.',
    );
    console.log(
      `Observed Holder Growth Shadow N: ${runtimeConfig.holderGrowthShadow.entryProfiles
        .map((profile) => `${profile.id}@${(profile.horizonMs
          || runtimeConfig.holderGrowthShadow.snapshotHorizonMs) / 1_000}s`).join('/')} x `
      + `${runtimeConfig.holderGrowthShadow.entryProfiles.reduce((total, profile) => (
        total + (profile.exitProfileIds?.length
          || runtimeConfig.holderGrowthShadow.exitProfiles.length)
      ), 0)} independent cohorts; `
      + 'isolated table, sends transactions=false.',
    );
    console.log(
      `Launch Pullback Shadow F: ${runtimeConfig.launchPullbackShadow.profiles.map((profile) => (
        `${profile.id}=net>=${profile.minNetFlowSol}SOL/creator<=${profile.maxCreatorSharePct}%`
      )).join(', ')}; holds=${runtimeConfig.launchPullbackShadow.holds
        .map((hold) => `${hold.fixedHoldMs}ms`).join(',')}; trailing=${runtimeConfig
        .launchPullbackShadow.trailingCohorts?.map((cohort) => cohort.id).join(',') || 'none'}; deep=${runtimeConfig
        .launchPullbackShadow.deepCohorts?.map((cohort) => cohort.cohortId).join(',') || 'none'}; optimize=${runtimeConfig
        .launchPullbackShadow.optimizationCohorts?.map((cohort) => cohort.id).join(',') || 'none'}; `
      + 'isolated cohorts; sends transactions=false.',
    );
    console.log(
      `Lifecycle Drop/Rebound Shadow G: ${runtimeConfig.migratedDropReboundShadow.lifecycleStages.length} `
      + `stages x ${runtimeConfig.migratedDropReboundShadow.entryProfiles.length} entry profiles `
      + `x ${runtimeConfig.migratedDropReboundShadow.exitProfiles.length} exits; `
      + `post-migration PumpSwap tracking=${runtimeConfig.migratedDropReboundShadow.trackingAgeMs / 1_000}s; `
      + 'isolated table; sends transactions=false.',
    );
    console.log(
      `PumpSwap Range Scalper Shadow J: observe=${runtimeConfig.rangeScalperShadow
        .initialObservationMs / 1_000}s, extend<=${runtimeConfig.rangeScalperShadow
        .maxTrackingMs / 60_000}m; ${runtimeConfig.rangeScalperShadow.entryProfiles.length} `
      + `entries x ${runtimeConfig.rangeScalperShadow.exitProfiles.length} exits; `
      + 'dynamic subscription, isolated table, sends transactions=false.',
    );
    console.log(
      `Bonding Curve Momentum Shadow H: ${runtimeConfig.bondingCurveMomentumShadow.entryProfiles.length} `
      + `entry profiles x ${runtimeConfig.bondingCurveMomentumShadow.exitProfiles.length} exits; `
      + `snapshots=${runtimeConfig.bondingCurveMomentumShadow.snapshotHorizonsMs
        .map((value) => `${value / 1_000}s`).join(',')}; `
      + 'pre-migration only, isolated tables, sends transactions=false.',
    );
    console.log(
      `Graduation Hold Shadow I: early ${runtimeConfig.graduationHoldShadow.signalVariant} `
      + `entry only at Curve<=${runtimeConfig.graduationHoldShadow.maxSignalCurvePct}%; `
      + `${runtimeConfig.graduationHoldShadow.cohorts.map((cohort) => cohort.id).join('/')} `
      + 'hold overlays; isolated table; sends transactions=false.',
    );
    console.log(
      `Graduation Acceleration Shadow O: ${runtimeConfig.graduationAccelerationShadow
        .entryProfiles.map((profile) => profile.id).join('/')} x `
      + `${runtimeConfig.graduationAccelerationShadow.capacitySols.join('/')} SOL; `
      + 'graduation core 50% + adaptive runner; isolated table; sends transactions=false.',
    );
    console.log(
      `Wake-up 5s: volume>=${runtimeConfig.strategy.activityMinVolumeSol}SOL OR `
      + `tx>=${runtimeConfig.strategy.activityMinTxCount} OR `
      + `wallets>=${runtimeConfig.strategy.activityMinUniqueWallets}`,
    );
    console.log(
      `Signal: 3×${runtimeConfig.strategy.signalWindowMs}ms windows, `
      + `W3 net>=${runtimeConfig.strategy.minNetFlowW3Sol}SOL, `
      + `ratio>=${runtimeConfig.strategy.minAccelerationRatio}x when defined`,
    );

    const shadowMaintenanceGroups = [
      [
        ['primarySignalAdvance', signalShadow],
        ['flowFirstAdvance', flowFirstShadow],
        ['smartPullbackAdvance', smartPullbackShadow],
        ['smartOpenAdvance', smartOpenShadow],
        ['flowSmartConfirmAdvance', flowSmartConfirmShadow],
      ],
      [
        ['smartLikeEarlyAdvance', smartLikeEarlyShadow],
        ['preEntryRugRiskAdvance', preEntryRugRisk],
        ['smartResonanceAdvance', smartResonanceShadow],
        ['smartWalletRugEscapeAdvance', smartWalletRugEscapeShadow],
        ['smartWalletFirstOpenRightTailAdvance', smartWalletFirstOpenRightTailShadow],
        ['publicFlowLeadAdvance', publicFlowLeadShadow],
        ['cyaSlotFlowAdvance', cyaSlotFlowShadow],
        ['cyaOrganicBurstAdvance', cyaOrganicBurstShadow],
        ['sameSlotDumpBackrunAdvance', sameSlotDumpBackrunShadow],
        ['launchPullbackAdvance', launchPullbackShadow],
        ['launchQualityAdvance', launchQualityObserver],
      ],
      [
        ['migrationSecondLegAdvance', migrationSecondLegObserver],
        ['migrationSecondLegShadowAdvance', migrationSecondLegShadow],
        ['holderGrowthAdvance', holderGrowthShadow],
        ['qualityLeaderAdvance', qualityLeaderShadow],
        ['bigWinnerAdvance', bigWinnerShadow],
        ['migratedDropReboundAdvance', migratedDropReboundShadow],
      ],
      [
        ['migrationContinuityAdvance', migrationContinuityShadow],
        ['rangeScalperAdvance', rangeScalperShadow],
        ['cyaEarlyPyramidAdvance', cyaEarlyPyramidShadow],
        ['bondingCurveMomentumAdvance', bondingCurveMomentumShadow],
        ['graduationHoldAdvance', graduationHoldShadow],
        ['graduationAccelerationAdvance', graduationAccelerationShadow],
      ],
    ];
    let maintenanceTick = 0;
    let lastSubscriptionRefreshAt = 0;
    maintenanceTimer = setInterval(() => {
      const now = Date.now();
      const groupIndex = maintenanceTick % shadowMaintenanceGroups.length;
      maintenanceTick += 1;
      if (groupIndex === 0) {
        runTimed('maintenance:engineCleanup', () => engine.cleanup(now));
        runTimed('maintenance:labelAdvance', () => labeler.advanceTime(now));
      }
      const group = shadowMaintenanceGroups[groupIndex];
      for (const [name, target] of group) {
        observeShadow(name, () => target.advanceTime(now));
      }
      if (groupIndex === 0) {
        runTimed('maintenance:traderAdvance', () => trader.advanceTime(now));
      }
      if (now - lastSubscriptionRefreshAt >= 5_000) {
        lastSubscriptionRefreshAt = now;
        runTimed('maintenance:refreshAmmSubscriptions', () => refreshAmmSubscriptions(now));
      }
    }, 250);

    refreshAmmSubscriptions();
    await stream.start();
    store.startHealthSampler(runtimeConfig.storage.healthRefreshMs);
  }

  async function stop(reason = 'shutdown') {
    if (stopping) return;
    stopping = true;
    console.log(`[Flow] stopping: ${reason}`);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = null;
    await stream.stop();
    await trader.stop();
    signalShadow.stop();
    flowFirstShadow.stop();
    smartPullbackShadow.stop();
    smartOpenShadow.stop();
    flowSmartConfirmShadow.stop();
    smartLikeEarlyShadow.stop();
    preEntryRugRisk.stop();
    smartResonanceShadow.stop();
    smartWalletRugEscapeShadow.stop();
    smartWalletFirstOpenRightTailShadow.stop();
    publicFlowLeadShadow.stop();
    cyaSlotFlowShadow.stop();
    cyaOrganicBurstShadow.stop();
    sameSlotDumpBackrunShadow.stop();
    launchPullbackShadow.stop();
    launchQualityObserver.stop();
    migrationSecondLegObserver.stop();
    migrationSecondLegShadow.stop();
    holderGrowthShadow.stop();
    qualityLeaderShadow.stop();
    bigWinnerShadow.stop();
    migratedDropReboundShadow.stop();
    migrationContinuityShadow.stop();
    rangeScalperShadow.stop();
    cyaEarlyPyramidShadow.stop();
    bondingCurveMomentumShadow.stop();
    graduationHoldShadow.stop();
    graduationAccelerationShadow.stop();
    await server.stop();
    store.close();
  }

  function health() {
    return {
      runtime: runtimeMetrics,
      engine: engine.stats(),
      labels: labeler.stats(),
      stream: stream.health(),
      database: store.healthSnapshot(),
      trading: trader.health(),
      signalShadow: signalShadow.health(),
      flowFirstShadow: flowFirstShadow.health(),
      smartPullbackShadow: smartPullbackShadow.health(),
      smartOpenShadow: smartOpenShadow.health(),
      flowSmartConfirmShadow: flowSmartConfirmShadow.health(),
      smartLikeEarlyShadow: smartLikeEarlyShadow.health(),
      preEntryRugRisk: preEntryRugRisk.health(),
      smartResonanceShadow: smartResonanceShadow.health(),
      smartWalletRugEscapeShadow: smartWalletRugEscapeShadow.health(),
      smartWalletFirstOpenRightTailShadow: smartWalletFirstOpenRightTailShadow.health(),
      publicFlowLeadShadow: publicFlowLeadShadow.health(),
      cyaSlotFlowShadow: cyaSlotFlowShadow.health(),
      cyaOrganicBurstShadow: cyaOrganicBurstShadow.health(),
      sameSlotDumpBackrunShadow: sameSlotDumpBackrunShadow.health(),
      launchPullbackShadow: launchPullbackShadow.health(),
      launchQualityObserver: launchQualityObserver.health(),
      migrationSecondLegObserver: migrationSecondLegObserver.health(),
      migrationSecondLegShadow: migrationSecondLegShadow.health(),
      holderGrowthShadow: holderGrowthShadow.health(),
      qualityLeaderShadow: qualityLeaderShadow.health(),
      bigWinnerShadow: bigWinnerShadow.health(),
      migratedDropReboundShadow: migratedDropReboundShadow.health(),
      migrationContinuityShadow: migrationContinuityShadow.health(),
      rangeScalperShadow: rangeScalperShadow.health(),
      cyaEarlyPyramidShadow: cyaEarlyPyramidShadow.health(),
      bondingCurveMomentumShadow: bondingCurveMomentumShadow.health(),
      graduationHoldShadow: graduationHoldShadow.health(),
      graduationAccelerationShadow: graduationAccelerationShadow.health(),
    };
  }

  return {
    start, stop, health, store, engine, labeler, parser, stream, server, trader, signalShadow,
    flowFirstShadow, smartPullbackShadow, smartOpenShadow, flowSmartConfirmShadow,
    smartLikeEarlyShadow, preEntryRugRisk, smartResonanceShadow,
    smartWalletRugEscapeShadow, smartWalletFirstOpenRightTailShadow,
    publicFlowLeadShadow,
    cyaSlotFlowShadow, cyaOrganicBurstShadow,
    sameSlotDumpBackrunShadow,
    launchPullbackShadow,
    launchQualityObserver, migrationSecondLegObserver, migrationSecondLegShadow,
    holderGrowthShadow, qualityLeaderShadow, bigWinnerShadow,
    migratedDropReboundShadow,
    rangeScalperShadow, cyaEarlyPyramidShadow,
    migrationContinuityShadow, bondingCurveMomentumShadow, graduationHoldShadow,
    graduationAccelerationShadow,
  };
}

async function main() {
  const errors = validateConfig();
  if (errors.length > 0) {
    console.error('Configuration error:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  let startupDashboard = null;
  try {
    startupDashboard = await launchStartupDashboard(config.server);
    console.log(
      `Startup Dashboard: http://127.0.0.1:${config.server.port} `
      + `(pid ${startupDashboard.pid}; waiting for database and strategy restore).`,
    );
  } catch (error) {
    console.warn(`[Startup Dashboard] unavailable; continuing startup: ${error.message}`);
  }
  let runtime;
  try {
    runtime = createRuntime(config);
  } catch (error) {
    await startupDashboard?.stop();
    throw error;
  }
  const shutdown = async (signal) => {
    try {
      await runtime.stop(signal);
      process.exit(0);
    } catch (error) {
      console.error('[Shutdown]', error);
      process.exit(1);
    }
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  await startupDashboard?.stop();
  await runtime.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[Fatal]', error);
    process.exitCode = 1;
  });
}

module.exports = { createRuntime, main };
