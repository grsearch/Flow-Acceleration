'use strict';

const assert = require('assert');
const {
  GraduationAccelerationShadowSuite,
  STATUS,
} = require('../src/core/GraduationAccelerationShadowSuite');
const { ResearchStore } = require('../src/data/ResearchStore');

function makeStore() {
  return new ResearchStore({
    dbPath: ':memory:', archiveDir: '.', rawRetentionHours: 24, flushMs: 60_000, flushMax: 100,
  }, { configuredTradingCostPct: 1.4 });
}

function config() {
  return {
    enabled: true,
    entryDelayMs: 200,
    entryTimeoutMs: 2_000,
    exitDelayMs: 200,
    exitTimeoutMs: 15_000,
    maxEntryPriceJumpPct: 1_000,
    hardStopPct: 30,
    maxPreGraduationHoldMs: 300_000,
    maxPostGraduationHoldMs: 300_000,
    coreExitPct: 50,
    capacitySols: [0.05, 0.5, 1],
    entryProfiles: [
      {
        id: 'O_FAST10_C80_B20_R07', label: 'fast10', mode: 'FIXED_10S', horizonMs: 10_000,
        minCurvePct: 80, minBuyers: 20, maxSellBuyRatio: 0.7,
      },
      {
        id: 'O_C80_D5_B2_S0_NC', label: 'curve80', mode: 'CURVE_MILESTONE',
        liveStrategyId: 'graduation_accel_o_c80_d5_b2_s0_nc_live',
        thresholdPct: 80, recentWindowMs: 5_000, minCurveDeltaPct: 5,
        minBuyers: 2, maxSellTx: 0, requireNoCreatorSell: true,
      },
    ],
    trailingTiers: [
      { activationPct: 20, drawdownPct: 10 },
      { activationPct: 40, drawdownPct: 15 },
      { activationPct: 80, drawdownPct: 20 },
      { activationPct: 150, drawdownPct: 25 },
      { activationPct: 300, drawdownPct: 30 },
    ],
    costModel: {
      platformFeePct: 1.4,
      buySlippagePct: 0.3,
      sellSlippagePct: 0.3,
      priceImpactPct: 0.2,
      baseTxFeeSol: 0.00001,
      priorityFeeSol: 0.0005,
      positionSizeSol: 1,
    },
  };
}

function trade({
  mint, timestampMs, price = 1e-7, curvePct, side = 'BUY', wallet,
  market = 'PUMP_BONDING_CURVE', solAmount = 1,
}) {
  return {
    mint,
    timestampMs,
    price,
    reservePrice: price,
    curvePct,
    side,
    wallet: wallet || `wallet-${timestampMs}`,
    solAmount,
    market,
    virtualSolReservesRaw: market === 'PUMP_BONDING_CURVE' ? '100000000000' : null,
    virtualTokenReservesRaw: market === 'PUMP_BONDING_CURVE' ? '1000000000000000' : null,
    poolBaseReservesRaw: market === 'PUMP_AMM' ? '1000000000000000' : null,
    poolQuoteReservesRaw: market === 'PUMP_AMM' ? '100000000000' : null,
    virtualQuoteReservesRaw: market === 'PUMP_AMM' ? '0' : null,
  };
}

function main() {
  const store = makeStore();
  let now = 100_000;
  const liveSignals = [];
  const suite = new GraduationAccelerationShadowSuite({
    config: config(), store, now: () => now,
    onLiveSignal: (event) => liveSignals.push(event),
  });
  suite.start();
  assert.strictEqual(suite.health().sendsTransactions, false);
  assert.strictEqual(suite.health().mode, 'SHADOW_O');

  suite.onCreate({ mint: 'fast-mint', symbol: 'FAST', creator: 'creator-fast', createdAt: 100_000 });
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 100_050, curvePct: 10, side: 'SELL',
    wallet: 'creator-fast', solAmount: 0.5,
  }));
  for (let index = 0; index < 20; index += 1) {
    suite.observeTrade(trade({
      mint: 'fast-mint',
      timestampMs: 100_100 + index * 490,
      curvePct: 12 + index * 3.55,
      wallet: `fast-buyer-${index}`,
      solAmount: 1,
    }));
  }
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 110_000, curvePct: 82, wallet: 'fast-buyer-20',
  }));
  assert.strictEqual(suite.health().pendingEntries, 3, 'FAST10 creates one row per capacity');
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 110_200, curvePct: 83, wallet: 'fill-wallet',
  }));
  let dashboard = store.graduationAccelerationShadowDashboard();
  let fastRows = dashboard.positions.filter((row) => row.mint === 'fast-mint');
  assert.strictEqual(fastRows.length, 3);
  assert.ok(fastRows.every((row) => row.status === STATUS.OPEN));
  const impacts = fastRows.sort((left, right) => left.position_sol - right.position_sol)
    .map((row) => row.entry_impact_pct);
  assert.ok(impacts[2] > impacts[1] && impacts[1] > impacts[0], 'larger capacities model more curve impact');

  suite.onGraduated({ mint: 'fast-mint', graduated_at: 111_000 });
  const entryPrice = fastRows[0].entry_price;
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 111_200, price: entryPrice * 1.3,
    curvePct: 100, market: 'PUMP_AMM',
  }));
  assert.strictEqual(suite.health().coreExits, 3, 'graduation takes the 50% core exit');
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 111_300, price: entryPrice * 2,
    curvePct: 100, market: 'PUMP_AMM',
  }));
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 111_500, price: entryPrice * 1.05,
    curvePct: 100, market: 'PUMP_AMM',
  }));
  suite.observeTrade(trade({
    mint: 'fast-mint', timestampMs: 111_700, price: entryPrice * 1.04,
    curvePct: 100, market: 'PUMP_AMM',
  }));
  dashboard = store.graduationAccelerationShadowDashboard();
  fastRows = dashboard.positions.filter((row) => row.mint === 'fast-mint');
  assert.ok(fastRows.every((row) => row.status === STATUS.CLOSED));
  assert.ok(fastRows.every((row) => row.core_exit_price > 0 && row.net_return_pct > 0));

  suite.onCreate({ mint: 'curve80-mint', symbol: 'C80', creator: 'creator-c80', createdAt: 200_000 });
  suite.observeTrade(trade({
    mint: 'curve80-mint', timestampMs: 200_100, curvePct: 10, wallet: 'c80-buyer-0',
  }));
  suite.observeTrade(trade({
    mint: 'curve80-mint', timestampMs: 201_000, curvePct: 72, wallet: 'c80-buyer-1',
  }));
  suite.observeTrade(trade({
    mint: 'curve80-mint', timestampMs: 202_000, curvePct: 80, wallet: 'c80-buyer-2',
  }));
  assert.strictEqual(suite.health().pendingEntries, 3, 'Curve80 order flow creates capacity rows');
  assert.strictEqual(liveSignals.length, 1, 'only the selected Curve80 profile bridges to live');
  assert.strictEqual(liveSignals[0].strategyId, 'graduation_accel_o_c80_d5_b2_s0_nc_live');
  assert.strictEqual(liveSignals[0].features.sellTx, 0);
  suite.observeTrade(trade({
    mint: 'curve80-mint', timestampMs: 202_200, curvePct: 81, wallet: 'c80-fill',
  }));
  suite.onGraduated({ mint: 'curve80-mint', graduated_at: 203_000 });
  suite.onGraduated({ mint: 'curve80-mint', migrated_at: 204_000 });
  assert.strictEqual(suite.health().graduated, 2, 'complete and migration events deduplicate the mint');
  now = 504_001;
  suite.advanceTime(now);
  dashboard = store.graduationAccelerationShadowDashboard();
  const noExitRows = dashboard.positions.filter((row) => row.mint === 'curve80-mint');
  assert.ok(noExitRows.every((row) => row.status === STATUS.NO_EXIT));
  assert.ok(noExitRows.every((row) => row.net_return_pct == null), 'NO_EXIT is not forced to -100%');

  const cohorts = dashboard.cohorts;
  assert.strictEqual(cohorts.length, 6, '2 entries x 3 capacities remain independent');
  assert.ok(cohorts.some((row) => row.closed === 1 && row.resolved === 1));
  assert.ok(cohorts.some((row) => row.no_exit === 1 && row.resolved === 0));
  store.close();
  console.log('graduation acceleration shadow tests passed');
}

main();

function testForwardQualityAndBeijingSessionProfiles() {
  {
    const store = makeStore();
    const settings = config();
    settings.capacitySols = [1];
    settings.entryProfiles = [{
      id: 'O90_Q70_D30_X60', label: 'quality', mode: 'CURVE_MILESTONE',
      thresholdPct: 90, recentWindowMs: 5_000, minCurveDeltaPct: 30,
      minBuyers: 3, minNetFlowSol: 70, maxSellTx: 1,
      requireNoCreatorSell: true, capacityAwareExit: true,
      runnerExitMode: 'FIXED_HOLD', runnerMaxHoldMs: 60_000,
    }];
    const suite = new GraduationAccelerationShadowSuite({
      config: settings, store, now: () => Date.UTC(2026, 7, 23, 4, 0, 0),
    });
    suite.start();

    const qualifyingMint = 'o90-quality-pass';
    const base = Date.UTC(2026, 7, 23, 4, 0, 0);
    suite.onCreate({ mint: qualifyingMint, creator: 'quality-creator', createdAt: base });
    suite.observeTrade(trade({
      mint: qualifyingMint, timestampMs: base + 100, curvePct: 60,
      wallet: 'quality-buyer-1', solAmount: 25,
    }));
    suite.observeTrade(trade({
      mint: qualifyingMint, timestampMs: base + 500, curvePct: 70,
      wallet: 'quality-buyer-2', solAmount: 25,
    }));
    suite.observeTrade(trade({
      mint: qualifyingMint, timestampMs: base + 1_000, curvePct: 90,
      wallet: 'quality-buyer-3', solAmount: 25,
    }));
    assert.strictEqual(suite.health().pendingEntries, 1,
      'quality cohort requires the combined Buyers/NetFlow/CurveDelta gate');
    const qualityFeatures = JSON.parse(store.db.prepare(`
      SELECT features_json FROM graduation_acceleration_shadow_positions WHERE mint=?
    `).get(qualifyingMint).features_json);
    assert.deepStrictEqual(
      [qualityFeatures.buyers, qualityFeatures.netFlowSol,
        qualityFeatures.curveDeltaPct, qualityFeatures.signalCstHour],
      [3, 75, 30, 12],
    );

    const lowFlowMint = 'o90-quality-low-flow';
    suite.onCreate({ mint: lowFlowMint, creator: 'low-flow-creator', createdAt: base + 10_000 });
    for (const [offset, curvePct, wallet] of [
      [100, 60, 'low-flow-1'], [500, 70, 'low-flow-2'], [1_000, 90, 'low-flow-3'],
    ]) {
      suite.observeTrade(trade({
        mint: lowFlowMint, timestampMs: base + 10_000 + offset,
        curvePct, wallet, solAmount: 10,
      }));
    }
    assert.strictEqual(store.db.prepare(`
      SELECT COUNT(*) count FROM graduation_acceleration_shadow_positions WHERE mint=?
    `).get(lowFlowMint).count, 0, 'low NetFlow is not admitted to the quality cohort');
    store.close();
  }

  {
    const store = makeStore();
    const settings = config();
    settings.capacitySols = [1];
    settings.entryProfiles = [{
      id: 'O_C80_DAY1218_STAIR240', label: 'day', mode: 'CURVE_MILESTONE',
      thresholdPct: 80, recentWindowMs: 5_000, minCurveDeltaPct: 5,
      minBuyers: 2, maxSellTx: 0, requireNoCreatorSell: true,
      sessionStartHourCst: 12, sessionEndHourCst: 18,
      capacityAwareExit: true, runnerExitMode: 'TIERED_TRAILING',
      runnerMaxHoldMs: 240_000,
    }];
    const suite = new GraduationAccelerationShadowSuite({
      config: settings, store, now: () => Date.UTC(2026, 7, 23, 4, 0, 0),
    });
    suite.start();

    const observeCross = (mint, base) => {
      suite.onCreate({ mint, creator: `${mint}-creator`, createdAt: base });
      suite.observeTrade(trade({
        mint, timestampMs: base + 100, curvePct: 70, wallet: `${mint}-buyer-1`,
      }));
      suite.observeTrade(trade({
        mint, timestampMs: base + 1_000, curvePct: 80, wallet: `${mint}-buyer-2`,
      }));
    };
    observeCross('day-inside', Date.UTC(2026, 7, 23, 4, 0, 0)); // 12:00 CST
    observeCross('day-outside', Date.UTC(2026, 7, 23, 12, 0, 0)); // 20:00 CST
    assert.strictEqual(store.db.prepare(`
      SELECT COUNT(*) count FROM graduation_acceleration_shadow_positions
      WHERE entry_profile_id='O_C80_DAY1218_STAIR240'
    `).get().count, 1, 'only the Beijing 12:00-18:00 crossing is admitted');
    store.close();
  }
}

testForwardQualityAndBeijingSessionProfiles();

function testCurve90PostMigrationGate() {
  const store = makeStore();
  let now = 1_000_000;
  const settings = config();
  settings.capacitySols = [1];
  settings.entryProfiles = [{
    id: 'O90_M5_X60', label: 'o90', mode: 'CURVE_MILESTONE',
    thresholdPct: 90, recentWindowMs: 5_000, minCurveDeltaPct: 5,
    minBuyers: 1, maxSellTx: 1, requireNoCreatorSell: true,
    coreExitPct: 50,
    postMigrationGate: { windowMs: 5_000, minBuyers: 25, minNetFlowSol: 0 },
    runnerExitMode: 'FIXED_HOLD', runnerMaxHoldMs: 60_000,
  }];
  const suite = new GraduationAccelerationShadowSuite({
    config: settings, store, now: () => now,
  });
  suite.start();

  const open = (mint, base) => {
    suite.onCreate({ mint, symbol: mint, creator: `${mint}-creator`, createdAt: base });
    suite.observeTrade(trade({
      mint, timestampMs: base + 100, curvePct: 80, wallet: `${mint}-pre-1`,
    }));
    suite.observeTrade(trade({
      mint, timestampMs: base + 1_000, curvePct: 90, wallet: `${mint}-pre-2`,
    }));
    suite.observeTrade(trade({
      mint, timestampMs: base + 1_200, curvePct: 91, wallet: `${mint}-fill`,
    }));
    suite.onGraduated({ mint, graduated_at: base + 2_000 });
    suite.observeTrade(trade({
      mint, timestampMs: base + 2_200, price: 2e-7,
      market: 'PUMP_AMM', wallet: `${mint}-amm-open`,
    }));
  };

  const passMint = 'o90-gate-pass';
  open(passMint, now);
  // The first executable PumpSwap core-exit trade is buyer #1; 24 additional
  // buyers complete the causal five-second gate.
  for (let index = 0; index < 24; index += 1) {
    suite.observeTrade(trade({
      mint: passMint,
      timestampMs: now + 2_300 + index * 150,
      price: 2.1e-7,
      market: 'PUMP_AMM',
      wallet: `o90-pass-buyer-${index}`,
      side: 'BUY', solAmount: 0.1,
    }));
  }
  suite.observeTrade(trade({
    mint: passMint, timestampMs: now + 7_000, price: 2.2e-7,
    market: 'PUMP_AMM', wallet: 'o90-pass-gate-tick',
  }));
  assert.strictEqual(store.db.prepare(`
    SELECT status FROM graduation_acceleration_shadow_positions WHERE mint=?
  `).get(passMint).status, 'RUNNER', '25 post-migration buyers keep the runner alive');
  assert.strictEqual(suite.health().postMigrationGatePassed, 1);
  suite.observeTrade(trade({
    mint: passMint, timestampMs: now + 62_200, price: 2.3e-7,
    market: 'PUMP_AMM', wallet: 'o90-pass-timeout-trigger',
  }));
  suite.observeTrade(trade({
    mint: passMint, timestampMs: now + 62_400, price: 2.3e-7,
    market: 'PUMP_AMM', wallet: 'o90-pass-timeout-fill',
  }));
  assert.deepStrictEqual(store.db.prepare(`
    SELECT status, exit_reason FROM graduation_acceleration_shadow_positions WHERE mint=?
  `).get(passMint), { status: 'CLOSED', exit_reason: 'MAX_POST_GRAD_RUNNER' });

  now = 2_000_000;
  const failMint = 'o90-gate-fail';
  open(failMint, now);
  suite.observeTrade(trade({
    mint: failMint, timestampMs: now + 3_000, price: 2.1e-7,
    market: 'PUMP_AMM', wallet: 'o90-fail-buyer-1',
  }));
  suite.observeTrade(trade({
    mint: failMint, timestampMs: now + 7_000, price: 2e-7,
    market: 'PUMP_AMM', wallet: 'o90-fail-gate-tick',
  }));
  suite.observeTrade(trade({
    mint: failMint, timestampMs: now + 7_200, price: 2e-7,
    market: 'PUMP_AMM', wallet: 'o90-fail-exit-fill',
  }));
  assert.deepStrictEqual(store.db.prepare(`
    SELECT status, exit_reason FROM graduation_acceleration_shadow_positions WHERE mint=?
  `).get(failMint), { status: 'CLOSED', exit_reason: 'POST_MIGRATION_GATE_FAIL' });
  assert.strictEqual(suite.health().postMigrationGateFailed, 1);
  store.close();
}

testCurve90PostMigrationGate();

function testCurve80PersistenceRemainsShadowOnly() {
  const store = makeStore();
  let now = 3_000_000;
  const settings = config();
  settings.capacitySols = [1];
  settings.entryProfiles = [{
    id: 'O_C80_P1000_X120',
    label: 'persistence',
    mode: 'CURVE_MILESTONE_PERSISTENCE',
    thresholdPct: 80,
    recentWindowMs: 5_000,
    minCurveDeltaPct: 5,
    minBuyers: 2,
    maxSellTx: 0,
    requireNoCreatorSell: true,
    persistenceMs: 1_000,
    maxPersistenceSellTx: 0,
    maxPersistencePullbackPct: 5,
    coreExitPct: 0,
    capacityAwareExit: true,
    runnerExitMode: 'FIXED_HOLD',
    runnerMaxHoldMs: 120_000,
  }];
  const liveSignals = [];
  const suite = new GraduationAccelerationShadowSuite({
    config: settings,
    store,
    now: () => now,
    onLiveSignal: (event) => liveSignals.push(event),
  });
  suite.start();
  const mint = 'curve80-persistence';
  suite.onCreate({ mint, symbol: 'P80', creator: 'creator-p80', createdAt: now });
  suite.observeTrade(trade({
    mint, timestampMs: now + 100, curvePct: 20, wallet: 'p80-buyer-0',
  }));
  suite.observeTrade(trade({
    mint, timestampMs: now + 1_000, curvePct: 80, wallet: 'p80-buyer-1',
  }));
  assert.equal(suite.health().pendingEntries, 0, 'first threshold touch only arms persistence');
  suite.observeTrade(trade({
    mint, timestampMs: now + 2_000, curvePct: 82, wallet: 'p80-buyer-2',
  }));
  assert.equal(suite.health().pendingEntries, 1, 'persistent curve and buyers create one Shadow row');
  assert.equal(liveSignals.length, 0, 'the persistence cohort has no live bridge');
  suite.observeTrade(trade({
    mint, timestampMs: now + 2_200, curvePct: 83, wallet: 'p80-fill',
  }));
  const row = store.db.prepare(`
    SELECT status, entry_profile_id
    FROM graduation_acceleration_shadow_positions WHERE mint=?
  `).get(mint);
  assert.equal(row.status, STATUS.OPEN);
  assert.equal(row.entry_profile_id, 'O_C80_P1000_X120');
  assert.equal(suite.health().sendsTransactions, false);
  store.close();
}

testCurve80PersistenceRemainsShadowOnly();

function testEarlyCurveAndPostMigrationHandoffRemainShadowOnly() {
  {
    const store = makeStore();
    const settings = config();
    settings.capacitySols = [1];
    settings.entryProfiles = [75, 78].map((thresholdPct) => ({
      id: `O_C${thresholdPct}_D5_B2_S0_NC_EARLY`,
      label: `early-${thresholdPct}`,
      mode: 'CURVE_MILESTONE',
      thresholdPct,
      recentWindowMs: 5_000,
      minCurveDeltaPct: 5,
      minBuyers: 2,
      maxSellTx: 0,
      requireNoCreatorSell: true,
      capacityAwareExit: true,
    }));
    const liveSignals = [];
    const suite = new GraduationAccelerationShadowSuite({
      config: settings,
      store,
      now: () => 4_000_000,
      onLiveSignal: (event) => liveSignals.push(event),
    });
    suite.start();
    suite.onCreate({ mint: 'early-curve', creator: 'early-creator', createdAt: 4_000_000 });
    suite.observeTrade(trade({
      mint: 'early-curve', timestampMs: 4_000_100, curvePct: 68, wallet: 'early-1',
    }));
    suite.observeTrade(trade({
      mint: 'early-curve', timestampMs: 4_001_000, curvePct: 75, wallet: 'early-2',
    }));
    assert.equal(suite.health().pendingEntries, 1, 'Curve75 cohort starts before Curve78');
    suite.observeTrade(trade({
      mint: 'early-curve', timestampMs: 4_001_200, curvePct: 78, wallet: 'early-3',
    }));
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) count FROM graduation_acceleration_shadow_positions WHERE mint=?
    `).get('early-curve').count, 2, 'Curve78 remains an independent cohort');
    assert.equal(liveSignals.length, 0, 'early cohorts never bridge to live');
    store.close();
  }

  {
    const store = makeStore();
    let now = 5_000_000;
    const settings = config();
    settings.capacitySols = [1];
    settings.entryProfiles = [{
      id: 'O_C80_M5_HANDOFF_X60',
      label: 'handoff',
      mode: 'CURVE_MILESTONE',
      thresholdPct: 80,
      recentWindowMs: 5_000,
      minCurveDeltaPct: 5,
      minBuyers: 2,
      maxSellTx: 0,
      requireNoCreatorSell: true,
      migrationHandoff: true,
      capacityAwareExit: true,
      coreExitPct: 0,
      postMigrationEntryGate: {
        windowMs: 5_000,
        minBuyers: 5,
        minNetFlowSol: 0,
        maxSellBuyRatio: 0.7,
        maxDrawdownPct: 20,
        maxMarketMovePct: 15,
        maxSelfImpactPct: 10,
      },
      runnerExitMode: 'FIXED_HOLD',
      runnerMaxHoldMs: 60_000,
    }];
    const liveSignals = [];
    const suite = new GraduationAccelerationShadowSuite({
      config: settings,
      store,
      now: () => now,
      onLiveSignal: (event) => liveSignals.push(event),
    });
    suite.start();
    const mint = 'curve80-handoff';
    suite.onCreate({ mint, creator: 'handoff-creator', createdAt: now });
    suite.observeTrade(trade({
      mint, timestampMs: now + 100, curvePct: 70, wallet: 'handoff-pre-1',
    }));
    suite.observeTrade(trade({
      mint, timestampMs: now + 1_000, curvePct: 80, wallet: 'handoff-pre-2',
    }));
    assert.equal(suite.health().pendingEntries, 1);
    suite.onGraduated({ mint, graduated_at: now + 2_000 });
    assert.equal(suite.health().pendingEntries, 1,
      'graduation reroutes the Shadow row instead of marking it as a failed curve entry');
    for (let index = 0; index < 5; index += 1) {
      suite.observeTrade(trade({
        mint,
        timestampMs: now + 2_100 + index * 700,
        price: (1 + index * 0.01) * 1e-7,
        market: 'PUMP_AMM',
        wallet: `handoff-buyer-${index}`,
        side: 'BUY',
        solAmount: 0.2,
      }));
    }
    suite.observeTrade(trade({
      mint, timestampMs: now + 7_200, price: 1.04e-7,
      market: 'PUMP_AMM', wallet: 'handoff-fill', side: 'BUY', solAmount: 0.1,
    }));
    let row = store.db.prepare(`
      SELECT status, entry_market, entry_at
      FROM graduation_acceleration_shadow_positions WHERE mint=?
    `).get(mint);
    assert.equal(row.status, STATUS.RUNNER);
    assert.equal(row.entry_market, 'PUMP_AMM');
    assert.equal(row.entry_at, now + 7_200);
    assert.equal(suite.health().migrationHandoffPassed, 1);
    assert.equal(liveSignals.length, 0, 'handoff is Shadow-only');

    suite.observeTrade(trade({
      mint, timestampMs: now + 67_200, price: 1.2e-7,
      market: 'PUMP_AMM', wallet: 'handoff-timeout-trigger',
    }));
    suite.observeTrade(trade({
      mint, timestampMs: now + 67_400, price: 1.2e-7,
      market: 'PUMP_AMM', wallet: 'handoff-timeout-fill',
    }));
    row = store.db.prepare(`
      SELECT status, exit_reason FROM graduation_acceleration_shadow_positions WHERE mint=?
    `).get(mint);
    assert.deepStrictEqual(row, { status: STATUS.CLOSED, exit_reason: 'MAX_POST_GRAD_RUNNER' });
    store.close();
  }
}

testEarlyCurveAndPostMigrationHandoffRemainShadowOnly();

function testRelaxedFailedEntryCohortsRemainCapacityAwareAndShadowOnly() {
  {
    const store = makeStore();
    const settings = config();
    settings.capacitySols = [1];
    settings.entryProfiles = [{
      id: 'O_C80_J40_50_X60',
      label: 'jump band',
      mode: 'CURVE_MILESTONE',
      thresholdPct: 80,
      recentWindowMs: 5_000,
      minCurveDeltaPct: 5,
      minBuyers: 2,
      maxSellTx: 0,
      requireNoCreatorSell: true,
      capacityAwareExit: true,
      capacitySols: [0.1, 1],
      entryPriceJumpBand: {
        minPct: 40,
        maxPct: 50,
        minPostSignalBuyers: 1,
        minPostSignalNetFlowSol: 0,
        maxPostSignalSellTx: 0,
      },
      coreExitPct: 0,
      runnerExitMode: 'FIXED_HOLD',
      runnerMaxHoldMs: 60_000,
    }];
    const liveSignals = [];
    const suite = new GraduationAccelerationShadowSuite({
      config: settings,
      store,
      now: () => 6_000_000,
      onLiveSignal: (event) => liveSignals.push(event),
    });
    suite.start();

    const createBandMint = (mint, signalPrice) => {
      suite.onCreate({ mint, creator: `${mint}-creator`, createdAt: 6_000_000 });
      suite.observeTrade(trade({
        mint, timestampMs: 6_000_100, price: signalPrice,
        curvePct: 70, wallet: `${mint}-buyer-1`,
      }));
      suite.observeTrade(trade({
        mint, timestampMs: 6_001_000, price: signalPrice,
        curvePct: 80, wallet: `${mint}-buyer-2`,
      }));
      suite.observeTrade(trade({
        mint, timestampMs: 6_001_200, price: 1e-7,
        curvePct: 81, wallet: `${mint}-post-signal-buyer`,
      }));
    };

    createBandMint('jump-band-pass', 7e-8);
    let rows = store.db.prepare(`
      SELECT cohort_id, status, position_sol, entry_jump_pct
      FROM graduation_acceleration_shadow_positions WHERE mint=? ORDER BY position_sol
    `).all('jump-band-pass');
    assert.equal(rows.length, 2, 'profile-level capacities create independent rows');
    assert.ok(rows.every((row) => row.status === STATUS.OPEN));
    assert.deepStrictEqual(rows.map((row) => row.position_sol), [0.1, 1]);
    assert.ok(rows.every((row) => row.entry_jump_pct >= 40 && row.entry_jump_pct <= 50));
    assert.equal(suite.health().relaxedJumpBandPassed, 2);

    createBandMint('jump-band-below', 1e-7);
    rows = store.db.prepare(`
      SELECT status, rejection_reason
      FROM graduation_acceleration_shadow_positions WHERE mint=?
    `).all('jump-band-below');
    assert.ok(rows.every((row) => row.status === STATUS.NO_ENTRY));
    assert.ok(rows.every((row) => row.rejection_reason.startsWith('ENTRY_JUMP_BELOW_BAND_')));
    assert.equal(liveSignals.length, 0, 'relaxed jump bands never bridge to live');
    store.close();
  }

  {
    const store = makeStore();
    const settings = config();
    settings.capacitySols = [1];
    settings.entryProfiles = [{
      id: 'O_C80_HO500_X60',
      label: 'first PumpSwap handoff',
      mode: 'CURVE_MILESTONE',
      thresholdPct: 80,
      recentWindowMs: 5_000,
      minCurveDeltaPct: 5,
      minBuyers: 2,
      maxSellTx: 0,
      requireNoCreatorSell: true,
      migrationHandoff: true,
      handoffLiveStrategyId: 'graduation_accel_o_c80_ho500_x60_recovery_live',
      liveBridgeCapacitySol: 1,
      capacityAwareExit: true,
      capacitySols: [0.1, 1],
      coreExitPct: 0,
      postMigrationEntryGate: {
        windowMs: 500,
        evaluateAtFill: true,
        captureWindowMs: 10_000,
        minBuyers: 1,
        minNetFlowSol: 0,
        maxSellBuyRatio: 1,
        maxDrawdownPct: 20,
        maxMarketMovePct: 15,
        maxSelfImpactPct: 10,
      },
      runnerExitMode: 'FIXED_HOLD',
      runnerMaxHoldMs: 60_000,
    }];
    const liveSignals = [];
    const suite = new GraduationAccelerationShadowSuite({
      config: settings,
      store,
      now: () => 7_000_000,
      onLiveSignal: (event) => liveSignals.push(event),
    });
    suite.start();
    const mint = 'handoff-first-amm';
    suite.onCreate({ mint, creator: 'handoff-creator', createdAt: 7_000_000 });
    suite.observeTrade(trade({
      mint, timestampMs: 7_000_100, price: 7e-8, curvePct: 70, wallet: 'pre-1',
    }));
    suite.observeTrade(trade({
      mint, timestampMs: 7_001_000, price: 7e-8, curvePct: 80, wallet: 'pre-2',
    }));
    suite.onGraduated({ mint, graduated_at: 7_002_000 });
    suite.observeTrade(trade({
      mint, timestampMs: 7_002_600, price: 1e-7, market: 'PUMP_AMM',
      side: 'BUY', wallet: 'first-amm-buyer', solAmount: 0.2,
    }));
    const rows = store.db.prepare(`
      SELECT status, entry_market, position_sol, entry_impact_pct
      FROM graduation_acceleration_shadow_positions WHERE mint=? ORDER BY position_sol
    `).all(mint);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.status === STATUS.RUNNER));
    assert.ok(rows.every((row) => row.entry_market === 'PUMP_AMM'));
    assert.ok(rows[1].entry_impact_pct > rows[0].entry_impact_pct,
      '1 SOL handoff models more AMM impact than 0.1 SOL');
    assert.equal(suite.health().migrationHandoffPassed, 2);
    assert.equal(liveSignals.length, 1, 'only the selected 1 SOL cohort bridges to recovery live');
    assert.equal(
      liveSignals[0].strategyId,
      'graduation_accel_o_c80_ho500_x60_recovery_live',
    );
    assert.equal(liveSignals[0].market, 'PUMP_AMM');
    assert.ok(liveSignals[0].features.shadowEntryImpactPct > 0);
    store.close();
  }
}

testRelaxedFailedEntryCohortsRemainCapacityAwareAndShadowOnly();

function testProfileSpecificHardStopsStayIndependent() {
  const store = makeStore();
  const settings = config();
  settings.capacitySols = [1];
  settings.entryProfiles = [15, 30].map((hardStopPct) => ({
    id: `D5_H${hardStopPct}`,
    label: `D5 H${hardStopPct}`,
    mode: 'CURVE_MILESTONE',
    thresholdPct: 80,
    recentWindowMs: 5_000,
    minCurveDeltaPct: 5,
    minBuyers: 2,
    maxSellTx: 0,
    requireNoCreatorSell: true,
    hardStopPct,
  }));
  const suite = new GraduationAccelerationShadowSuite({
    config: settings,
    store,
    now: () => 8_000_000,
  });
  suite.start();
  const mint = 'd5-profile-hard-stop';
  suite.onCreate({ mint, creator: 'd5-creator', createdAt: 8_000_000 });
  suite.observeTrade(trade({
    mint, timestampMs: 8_000_100, price: 1e-7, curvePct: 70, wallet: 'd5-buyer-1',
  }));
  suite.observeTrade(trade({
    mint, timestampMs: 8_001_000, price: 1e-7, curvePct: 80, wallet: 'd5-buyer-2',
  }));
  suite.observeTrade(trade({
    mint, timestampMs: 8_001_200, price: 1e-7, curvePct: 81, wallet: 'd5-fill',
  }));
  const opened = store.db.prepare(`
    SELECT entry_profile_id, entry_price, status
    FROM graduation_acceleration_shadow_positions WHERE mint=? ORDER BY entry_profile_id
  `).all(mint);
  assert.equal(opened.length, 2);
  assert.ok(opened.every((row) => row.status === STATUS.OPEN));

  const drawdownPrice = Math.min(...opened.map((row) => row.entry_price)) * 0.84;
  suite.observeTrade(trade({
    mint, timestampMs: 8_001_400, price: drawdownPrice, curvePct: 79,
    side: 'SELL', wallet: 'd5-seller',
  }));
  let rows = store.db.prepare(`
    SELECT entry_profile_id, status, exit_reason
    FROM graduation_acceleration_shadow_positions WHERE mint=? ORDER BY entry_profile_id
  `).all(mint);
  assert.equal(rows.find((row) => row.entry_profile_id === 'D5_H15').status, STATUS.EXIT_PENDING);
  assert.equal(rows.find((row) => row.entry_profile_id === 'D5_H30').status, STATUS.OPEN);

  suite.observeTrade(trade({
    mint, timestampMs: 8_001_600, price: drawdownPrice, curvePct: 79,
    side: 'SELL', wallet: 'd5-exit-fill',
  }));
  rows = store.db.prepare(`
    SELECT entry_profile_id, status, exit_reason
    FROM graduation_acceleration_shadow_positions WHERE mint=? ORDER BY entry_profile_id
  `).all(mint);
  assert.equal(rows.find((row) => row.entry_profile_id === 'D5_H15').status, STATUS.CLOSED);
  assert.equal(rows.find((row) => row.entry_profile_id === 'D5_H15').exit_reason, 'HARD_STOP');
  assert.equal(rows.find((row) => row.entry_profile_id === 'D5_H30').status, STATUS.OPEN);
  store.close();
}

testProfileSpecificHardStopsStayIndependent();

function testLiveMigrationFailureHandoffWaitsForOrganicPumpSwapFlow() {
  const store = makeStore();
  const settings = config();
  settings.capacitySols = [1];
  settings.entryProfiles = [20_000, 30_000].map((runnerMaxHoldMs) => ({
    id: `LIVE_MIG_X${runnerMaxHoldMs / 1_000}`,
    label: `live migration x${runnerMaxHoldMs / 1_000}`,
    mode: 'LIVE_MIGRATION_FAILURE',
    sourceLiveStrategyId: 'graduation_accel_o_c80_d5_b2_s0_nc_live',
    migrationHandoff: true,
    capacityAwareExit: true,
    capacitySols: [1],
    entryTimeoutMs: 2_500,
    coreExitPct: 0,
    postMigrationEntryGate: {
      entryDelayMs: 500,
      captureWindowMs: 3_000,
      evaluateAtFill: true,
      waitForQualification: true,
      minTrades: 3,
      minBuyTx: 2,
      minBuyers: 2,
      minNetFlowSol: 0.1,
      maxSellBuyRatio: 0.5,
      maxLargestSellSol: 1,
      maxDrawdownPct: 12,
      maxMarketMovePct: 15,
      maxSelfImpactPct: 10,
    },
    runnerExitMode: 'FIXED_HOLD',
    runnerMaxHoldMs,
  }));
  const suite = new GraduationAccelerationShadowSuite({
    config: settings,
    store,
    now: () => 9_000_000,
  });
  suite.start();
  suite.onLiveEntryFailure({
    strategyId: 'graduation_accel_o_c80_d5_b2_s0_nc_live',
    episodeId: 'live-migration:ignored',
    mint: 'live-migration-ignored',
    rejectionReason: 'ENTRY_REJECTED',
    failedAt: 9_000_000,
    signalAt: 8_999_900,
    signalPrice: 1e-7,
  });
  assert.equal(suite.health().pendingEntries, 0,
    'ordinary live rejections do not seed migration handoff cohorts');

  const mint = 'live-migration-handoff';
  suite.onLiveEntryFailure({
    strategyId: 'graduation_accel_o_c80_d5_b2_s0_nc_live',
    episodeId: 'live-migration:1',
    mint,
    symbol: 'LMH',
    rejectionReason: 'ENTRY_MIGRATED_BEFORE_SUBMIT',
    errorCode: 'MIGRATED_BEFORE_SUBMIT',
    failedAt: 9_000_000,
    signalAt: 8_999_900,
    signalPrice: 1e-7,
    signalCurvePct: 82,
    slot: 123,
    features: { buyers: 4, netFlowSol: 8 },
  });
  assert.equal(suite.health().pendingEntries, 2);
  assert.equal(suite.health().liveMigrationFailuresObserved, 1);

  suite.observeTrade(trade({
    mint, timestampMs: 9_000_600, price: 1e-7, market: 'PUMP_AMM',
    side: 'BUY', wallet: 'amm-buyer-1', solAmount: 0.2,
  }));
  assert.equal(suite.health().pendingEntries, 2,
    'the first sparse PumpSwap trade waits instead of rejecting the handoff');
  suite.observeTrade(trade({
    mint, timestampMs: 9_000_750, price: 1.01e-7, market: 'PUMP_AMM',
    side: 'SELL', wallet: 'amm-seller-1', solAmount: 0.05,
  }));
  assert.equal(suite.health().pendingEntries, 2);
  suite.observeTrade(trade({
    mint, timestampMs: 9_000_900, price: 1.02e-7, market: 'PUMP_AMM',
    side: 'BUY', wallet: 'amm-buyer-2', solAmount: 0.2,
  }));

  let rows = store.db.prepare(`
    SELECT entry_profile_id, status, position_sol, features_json
    FROM graduation_acceleration_shadow_positions WHERE mint=? ORDER BY entry_profile_id
  `).all(mint);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === STATUS.RUNNER));
  assert.ok(rows.every((row) => row.position_sol === 1));
  assert.ok(rows.every((row) => (
    JSON.parse(row.features_json).sourceLiveRejectionReason === 'ENTRY_MIGRATED_BEFORE_SUBMIT'
  )));

  suite.observeTrade(trade({
    mint, timestampMs: 9_020_901, price: 1.05e-7, market: 'PUMP_AMM',
    side: 'BUY', wallet: 'later-buyer-1', solAmount: 0.1,
  }));
  suite.observeTrade(trade({
    mint, timestampMs: 9_021_101, price: 1.05e-7, market: 'PUMP_AMM',
    side: 'BUY', wallet: 'later-buyer-2', solAmount: 0.1,
  }));
  rows = store.db.prepare(`
    SELECT entry_profile_id, status FROM graduation_acceleration_shadow_positions
    WHERE mint=? ORDER BY entry_profile_id
  `).all(mint);
  assert.equal(rows.find((row) => row.entry_profile_id === 'LIVE_MIG_X20').status, STATUS.CLOSED);
  assert.equal(rows.find((row) => row.entry_profile_id === 'LIVE_MIG_X30').status, STATUS.RUNNER);

  suite.observeTrade(trade({
    mint, timestampMs: 9_030_901, price: 1.08e-7, market: 'PUMP_AMM',
    side: 'BUY', wallet: 'later-buyer-3', solAmount: 0.1,
  }));
  suite.observeTrade(trade({
    mint, timestampMs: 9_031_101, price: 1.08e-7, market: 'PUMP_AMM',
    side: 'BUY', wallet: 'later-buyer-4', solAmount: 0.1,
  }));
  rows = store.db.prepare(`
    SELECT entry_profile_id, status, entry_at, exit_at
    FROM graduation_acceleration_shadow_positions WHERE mint=?
  `).all(mint);
  assert.ok(rows.every((row) => row.status === STATUS.CLOSED));
  assert.ok(rows.find((row) => row.entry_profile_id === 'LIVE_MIG_X20').exit_at
    - rows.find((row) => row.entry_profile_id === 'LIVE_MIG_X20').entry_at >= 20_000);
  assert.ok(rows.find((row) => row.entry_profile_id === 'LIVE_MIG_X30').exit_at
    - rows.find((row) => row.entry_profile_id === 'LIVE_MIG_X30').entry_at >= 30_000);
  store.close();
}

testLiveMigrationFailureHandoffWaitsForOrganicPumpSwapFlow();
