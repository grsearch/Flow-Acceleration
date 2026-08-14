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
const { LaunchPullbackShadowSuite } = require('./core/LaunchPullbackShadowSuite');
const { LaunchQualityObserver } = require('./core/LaunchQualityObserver');
const { MigratedDropReboundShadowSuite } = require('./core/MigratedDropReboundShadowSuite');
const { MigrationContinuityShadowSuite } = require('./core/MigrationContinuityShadowSuite');
const { RangeScalperShadowSuite } = require('./core/RangeScalperShadowSuite');
const { CyaEarlyPyramidShadowSuite } = require('./core/CyaEarlyPyramidShadowSuite');
const {
  BondingCurveMomentumShadowSuite,
} = require('./core/BondingCurveMomentumShadowSuite');
const { GraduationHoldShadowSuite } = require('./core/GraduationHoldShadowSuite');
const { HolderGrowthShadowSuite } = require('./core/HolderGrowthShadowSuite');
const { PumpTradeExecutor } = require('./core/PumpTradeExecutor');
const { ResearchStore } = require('./data/ResearchStore');
const ResearchServer = require('./server/server');

function createRuntime(runtimeConfig = config) {
  const store = new ResearchStore(runtimeConfig.storage, runtimeConfig.labels);
  const engine = new FlowAccelerationEngine(runtimeConfig.strategy);
  engine.hydrateTokens(store.allTokens());
  engine.hydrateTrades(store.recentCurveTrades(Date.now() - runtimeConfig.strategy.bufferMs));
  const labeler = new SignalLabeler({ store, config: runtimeConfig.labels });
  labeler.restore(store.restorePendingSignals());
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
  const launchPullbackShadow = new LaunchPullbackShadowSuite({
    config: runtimeConfig.launchPullbackShadow,
    store,
  });
  launchPullbackShadow.start();
  const holderGrowthShadow = new HolderGrowthShadowSuite({
    config: runtimeConfig.holderGrowthShadow,
    store,
  });
  holderGrowthShadow.start();
  const launchQualityObserver = new LaunchQualityObserver({
    config: runtimeConfig.launchQualityObserver,
    store,
    onReference: (reference) => launchPullbackShadow.onReference(reference),
    onSnapshot: (snapshot, options) => holderGrowthShadow.onSnapshot(snapshot, options),
  });
  launchQualityObserver.start();
  const migratedDropReboundShadow = new MigratedDropReboundShadowSuite({
    config: runtimeConfig.migratedDropReboundShadow,
    store,
  });
  migratedDropReboundShadow.start();
  const migrationContinuityShadow = new MigrationContinuityShadowSuite({
    config: runtimeConfig.migrationContinuityShadow,
    store,
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
    launchPullbackShadow,
    launchQualityObserver,
    migratedDropReboundShadow,
    migrationContinuityShadow,
    rangeScalperShadow,
    cyaEarlyPyramidShadow,
    bondingCurveMomentumShadow,
    graduationHoldShadow,
    holderGrowthShadow,
  });
  const smartWallets = new Set(runtimeConfig.smartWallets);
  const runtimeMetrics = {
    parsedEvents: 0,
    parseErrors: 0,
    ignoredEvents: 0,
    shadowModuleErrors: {},
  };
  const observeShadow = (name, callback) => {
    try {
      callback();
    } catch (error) {
      runtimeMetrics.shadowModuleErrors[name] = (runtimeMetrics.shadowModuleErrors[name] || 0) + 1;
      console.error(`[Shadow:${name}] isolated failure:`, error.message);
    }
  };
  let maintenanceTimer = null;
  let archiveTimer = null;
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
      ...bondingCurveMomentumShadow.trackedMints(),
      ...graduationHoldShadow.trackedMints(),
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
        observeShadow('migratedDropRebound', () => migratedDropReboundShadow.observeTrade(trade));
        observeShadow('migrationContinuity', () => migrationContinuityShadow.observeTrade(trade));
        observeShadow('rangeScalper', () => rangeScalperShadow.observeTrade(trade));
        observeShadow('cyaEarlyPyramid', () => cyaEarlyPyramidShadow.observeTrade(trade));
        observeShadow('bondingCurveMomentum', () => bondingCurveMomentumShadow.observeTrade(trade));
        observeShadow('graduationHold', () => graduationHoldShadow.observeTrade(trade));
        observeShadow('launchQuality', () => launchQualityObserver.observeTrade(trade));
        observeShadow('holderGrowth', () => holderGrowthShadow.observeTrade(trade));
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
      `Launch Quality Observer: snapshots=${runtimeConfig.launchQualityObserver.snapshotHorizonsMs
        .map((value) => `${value / 1_000}s`).join(',')}; `
      + `reference=${runtimeConfig.launchQualityObserver.pumpReferencePct}% pump / `
      + `${runtimeConfig.launchQualityObserver.pullbackReferencePct}% pullback / `
      + `${runtimeConfig.launchQualityObserver.reboundReferencePct}% rebound; `
      + 'observer-only, sends transactions=false.',
    );
    console.log(
      `Observed Holder Growth Shadow N: ${runtimeConfig.holderGrowthShadow.entryProfiles
        .map((profile) => profile.id).join('/')} at `
      + `${runtimeConfig.holderGrowthShadow.snapshotHorizonMs / 1_000}s; `
      + `${runtimeConfig.holderGrowthShadow.exitProfile.id} exit; `
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
      `Wake-up 5s: volume>=${runtimeConfig.strategy.activityMinVolumeSol}SOL OR `
      + `tx>=${runtimeConfig.strategy.activityMinTxCount} OR `
      + `wallets>=${runtimeConfig.strategy.activityMinUniqueWallets}`,
    );
    console.log(
      `Signal: 3×${runtimeConfig.strategy.signalWindowMs}ms windows, `
      + `W3 net>=${runtimeConfig.strategy.minNetFlowW3Sol}SOL, `
      + `ratio>=${runtimeConfig.strategy.minAccelerationRatio}x when defined`,
    );

    maintenanceTimer = setInterval(() => {
      const now = Date.now();
      engine.cleanup(now);
      labeler.advanceTime(now);
      observeShadow('primarySignalAdvance', () => signalShadow.advanceTime(now));
      observeShadow('flowFirstAdvance', () => flowFirstShadow.advanceTime(now));
      observeShadow('smartPullbackAdvance', () => smartPullbackShadow.advanceTime(now));
      observeShadow('smartOpenAdvance', () => smartOpenShadow.advanceTime(now));
      observeShadow('flowSmartConfirmAdvance', () => flowSmartConfirmShadow.advanceTime(now));
      observeShadow('launchPullbackAdvance', () => launchPullbackShadow.advanceTime(now));
      observeShadow('launchQualityAdvance', () => launchQualityObserver.advanceTime(now));
      observeShadow('holderGrowthAdvance', () => holderGrowthShadow.advanceTime(now));
      observeShadow('migratedDropReboundAdvance', () => migratedDropReboundShadow.advanceTime(now));
      observeShadow('migrationContinuityAdvance', () => migrationContinuityShadow.advanceTime(now));
      observeShadow('rangeScalperAdvance', () => rangeScalperShadow.advanceTime(now));
      observeShadow('cyaEarlyPyramidAdvance', () => cyaEarlyPyramidShadow.advanceTime(now));
      observeShadow('bondingCurveMomentumAdvance', () => bondingCurveMomentumShadow.advanceTime(now));
      observeShadow('graduationHoldAdvance', () => graduationHoldShadow.advanceTime(now));
      trader.advanceTime(now);
      refreshAmmSubscriptions(now);
    }, 1_000);

    archiveTimer = setInterval(() => {
      try {
        const archived = store.archiveExpiredRawTrades();
        if (archived) console.log(`[Archive] ${archived.rows} raw trades -> ${archived.archivePath}`);
      } catch (error) {
        console.error('[Archive] failed:', error.message);
      }
    }, 60 * 60_000);
    if (archiveTimer.unref) archiveTimer.unref();

    refreshAmmSubscriptions();
    await stream.start();
  }

  async function stop(reason = 'shutdown') {
    if (stopping) return;
    stopping = true;
    console.log(`[Flow] stopping: ${reason}`);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    if (archiveTimer) clearInterval(archiveTimer);
    maintenanceTimer = null;
    archiveTimer = null;
    await stream.stop();
    await trader.stop();
    signalShadow.stop();
    flowFirstShadow.stop();
    smartPullbackShadow.stop();
    smartOpenShadow.stop();
    flowSmartConfirmShadow.stop();
    launchPullbackShadow.stop();
    launchQualityObserver.stop();
    holderGrowthShadow.stop();
    migratedDropReboundShadow.stop();
    migrationContinuityShadow.stop();
    rangeScalperShadow.stop();
    cyaEarlyPyramidShadow.stop();
    bondingCurveMomentumShadow.stop();
    graduationHoldShadow.stop();
    await server.stop();
    store.close();
  }

  function health() {
    return {
      runtime: runtimeMetrics,
      engine: engine.stats(),
      labels: labeler.stats(),
      stream: stream.health(),
      database: store.health(),
      trading: trader.health(),
      signalShadow: signalShadow.health(),
      flowFirstShadow: flowFirstShadow.health(),
      smartPullbackShadow: smartPullbackShadow.health(),
      smartOpenShadow: smartOpenShadow.health(),
      flowSmartConfirmShadow: flowSmartConfirmShadow.health(),
      launchPullbackShadow: launchPullbackShadow.health(),
      launchQualityObserver: launchQualityObserver.health(),
      holderGrowthShadow: holderGrowthShadow.health(),
      migratedDropReboundShadow: migratedDropReboundShadow.health(),
      migrationContinuityShadow: migrationContinuityShadow.health(),
      rangeScalperShadow: rangeScalperShadow.health(),
      cyaEarlyPyramidShadow: cyaEarlyPyramidShadow.health(),
      bondingCurveMomentumShadow: bondingCurveMomentumShadow.health(),
      graduationHoldShadow: graduationHoldShadow.health(),
    };
  }

  return {
    start, stop, health, store, engine, labeler, parser, stream, server, trader, signalShadow,
    flowFirstShadow, smartPullbackShadow, smartOpenShadow, flowSmartConfirmShadow,
    launchPullbackShadow,
    launchQualityObserver, holderGrowthShadow, migratedDropReboundShadow,
    rangeScalperShadow, cyaEarlyPyramidShadow,
    migrationContinuityShadow, bondingCurveMomentumShadow, graduationHoldShadow,
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

  const runtime = createRuntime(config);
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
  await runtime.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[Fatal]', error);
    process.exitCode = 1;
  });
}

module.exports = { createRuntime, main };
