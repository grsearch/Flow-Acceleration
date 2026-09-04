'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PreEntryRugRiskTracker } = require('../src/core/PreEntryRugRiskTracker');

const config = {
  enabled: true,
  windowMs: 15_000,
  stateRetentionMs: 60_000,
  sweepIntervalMs: 5_000,
  maxEventsPerMint: 256,
  cacheMaxAgeMs: 1_000,
  minTrades: 10,
  minBuySharePct: 58,
  minConsecutiveBuys: 14,
  maxSideAlternationPct: 30,
  minUpTickSharePct: 55,
  minReturnPct: 30,
  minFlags: 5,
  verticalFragileMinReturnPct: 50,
  verticalFragileMinBuyImpactPct: 10,
  verticalFragileMinWalletTxSharePct: 8,
  sparseBreadthMinBuysPerBuyer: 2,
  chaseRepeatedMinReturnPct: 30,
  chaseRepeatedMinSizeSharePct: 15,
  beijingRiskWindowEnabled: true,
  beijingRiskStartHour: 16,
  beijingRiskEndHour: 20,
  beijingRiskMinFlags: 4,
  cliffEnabled: true,
  cliffWindowMs: 2_000,
  cliffMaxSells: 3,
  cliffMinDropPct: 50,
  cliffPersistMaxRatioPct: 75,
  cliffPairIgnoreMs: 100,
  slowRugMinDurationMs: 10_000,
  dumpabilityEnabled: true,
  dumpabilityPositionSol: 1,
  dumpTop1ReserveWarnPct: 25,
  dumpTop3ReserveWarnPct: 50,
  extremeDumpabilityEnabled: true,
  extremeDumpabilityMinObservedWallets: 4,
  extremeDumpabilityTop3ObservedSharePct: 70,
  extremeDumpabilityTop3RecoveryMaxPct: 20,
  firstCliffCounterfactualEnabled: true,
  firstCliffHorizonMs: 30_000,
  firstCliffMaxPending: 10_000,
  firstCliffAuditFlushMs: 1_000,
  firstCliffEffectiveBuyersMax: 3,
  firstCliffHc1Top1Pct: 15,
  firstCliffHc1Top3Pct: 35,
  firstCliffHc2Top1Pct: 20,
  firstCliffHc2Top3Pct: 35,
  firstCliffLifecycleEnabled: true,
  firstCliffLaunchMaxAgeMs: 5_000,
  firstCliffCurveEarlyMaxAgeMs: 30_000,
  firstCliffCurveMigrationMinPct: 80,
  firstCliffAmmEarlyMaxAgeMs: 10_000,
  firstCliffAmmHc1Top3RecoveryMaxPct: 50,
  firstCliffAmmHc2Top3RecoveryMaxPct: 40,
  firstCliffAmmHc1WalletBuyTxSharePct: 50,
  firstCliffAmmHc2WalletBuyTxSharePct: 60,
  crossMintEnabled: true,
  templateWindowMs: 5_000,
  templateLargeBuyMinSol: 1,
  templateMinLargeBuys: 4,
  templateMaxLargeBuys: 6,
  templateMinTotalBuySol: 40,
  templateMaxBurstSpanMs: 500,
  templateSizeBucketSol: 0.25,
  toxicCollapsePct: 60,
  toxicCollapseWindowMs: 30_000,
  toxicRetentionMs: 86_400_000,
  toxicWalletRetentionMs: 60 * 86_400_000,
  toxicTemplateRetentionMs: 30 * 86_400_000,
  toxicWalletOverlapMin: 2,
  maxToxicWallets: 4_096,
  maxToxicTemplates: 1_024,
};

{
  const tracker = new PreEntryRugRiskTracker({ config });
  tracker.observeTrade({
    mint: 'cliff-rug', side: 'BUY', market: 'PUMP_AMM', wallet: 'buyer',
    timestampMs: 1_000, price: 1,
  });
  tracker.observeTrade({
    mint: 'cliff-rug', side: 'SELL', market: 'PUMP_AMM', wallet: 'dumper',
    timestampMs: 2_000, price: 0.12,
  });
  const confirmation = {
    mint: 'cliff-rug', side: 'BUY', market: 'PUMP_AMM', wallet: 'independent',
    timestampMs: 2_100, price: 0.18,
  };
  tracker.observeTrade(confirmation);
  assert.equal(confirmation.rugPath.kind, 'CLIFF_DROP_50');
  assert.equal(confirmation.rugPath.confirmed, true);
  const outcome = tracker.classifyOutcome('cliff-rug', 1, 1_000, 2_100);
  assert.equal(outcome.kind, 'CLIFF_RUG_80');
  assert.equal(tracker.classifyOutcome('cliff-rug', 1)?.kind, 'CLIFF_RUG_80');
  assert.equal(tracker.health().cliffConfirmed, 1);
  assert.equal(tracker.health().cliffRug80, 1);
}

{
  const tracker = new PreEntryRugRiskTracker({ config });
  tracker.observeTrade({
    mint: 'paired-artifact', side: 'BUY', market: 'PUMP_AMM', wallet: 'router',
    timestampMs: 1_000, price: 1,
  });
  tracker.observeTrade({
    mint: 'paired-artifact', side: 'SELL', market: 'PUMP_AMM', wallet: 'router',
    timestampMs: 1_050, price: 0.1,
  });
  const snapshot = tracker.snapshot('paired-artifact', 1_100);
  assert.equal(snapshot.rugPath, null);
  assert.equal(tracker.health().cliffPairedArtifactsIgnored, 1);
}

{
  const tracker = new PreEntryRugRiskTracker({ config });
  const prices = [1, 0.96, 0.93, 0.89, 0.85, 0.81, 0.77, 0.73, 0.69, 0.65];
  prices.forEach((price, index) => tracker.observeTrade({
    mint: 'slow-rug', side: index % 2 === 0 ? 'BUY' : 'SELL', market: 'PUMP_AMM',
    wallet: `wallet-${index}`, timestampMs: 1_000 + index * 1_500, price,
  }));
  const snapshot = tracker.snapshot('slow-rug', 14_600);
  assert.equal(snapshot.rugPath.kind, 'SLOW_RUG_30');
  assert.equal(tracker.classifyOutcome('slow-rug', 1, 1_000).kind, 'SLOW_RUG_30');
}

{
  const tracker = new PreEntryRugRiskTracker({ config });
  for (let index = 0; index < 10; index += 1) {
    tracker.observeTrade({
      mint: 'dumpability', side: 'BUY', market: 'PUMP_AMM',
      wallet: index < 6 ? 'large-observed-wallet' : `wallet-${index}`,
      tokenAmount: index < 6 ? 50_000 : 10_000,
      solAmount: 1,
      timestampMs: 1_000 + index * 500,
      price: 0.0001,
      poolBaseReservesRaw: '1000000000000',
      poolQuoteReservesRaw: '100000000000',
      virtualQuoteReservesRaw: '0',
    });
  }
  const snapshot = tracker.snapshot('dumpability', 5_600);
  assert.equal(snapshot.dumpability.sampleReady, true);
  assert.ok(snapshot.dumpability.top1ReservePct >= 25);
  assert.ok(snapshot.dumpability.top1RecoveryPct < 100);
  assert.ok(snapshot.researchWarnings.includes('OBSERVED_TOP1_DUMPABLE_INVENTORY'));
  assert.equal(tracker.health().dumpabilityWarnings, 1);
}

{
  // Regression for the 4zu5-style first attack: only nine trades exist, so the
  // generic ten-trade sample is not ready. The coordinated burst and post-top3
  // recovery calculation must still produce a high-specificity hard-block signal.
  const tracker = new PreEntryRugRiskTracker({ config });
  const base = 10_000;
  const largeSol = [17.0184, 15.8488, 16.9740, 16.1467];
  for (let index = 0; index < 9; index += 1) {
    tracker.observeTrade({
      mint: 'first-occurrence-extreme',
      side: 'BUY',
      market: 'PUMP_BONDING_CURVE',
      wallet: `extreme-wallet-${index}`,
      solAmount: index < 4 ? largeSol[index] : 0.1,
      tokenAmount: index < 4 ? 600_000_000 : 1_000_000,
      timestampMs: base + (index < 4 ? index * 90 : 400 + index * 100),
      price: 0.00000003 * (1 + index * 0.1),
      virtualTokenReservesRaw: '1000000000000000',
      virtualSolReservesRaw: '30000000000',
      realTokenReservesRaw: '600000000000000',
      realSolReservesRaw: '10000000000',
      curvePct: 95,
    });
  }
  const risk = tracker.snapshot('first-occurrence-extreme', base + 1_300);
  assert.equal(risk.sampleReady, false);
  assert.equal(risk.templateLargeBuyCount, 4);
  assert.ok(risk.dumpability.top3ObservedSharePct >= 70);
  assert.ok(risk.dumpability.top3RecoveryPct <= 20);
  assert.equal(risk.signatures.extremeCoordinatedDumpability, true);
  assert.equal(risk.flagged, true);
  const decision = tracker.evaluateGuard({
    strategyId: 'CURVE-LIVE',
    mint: 'first-occurrence-extreme',
    timestampMs: base + 1_300,
    source: 'LIVE',
    market: 'PUMP_BONDING_CURVE',
    enforcementMode: 'HARD_BLOCK',
    hardBlockSignatures: ['extremeCoordinatedDumpability'],
  });
  assert.equal(decision.blocked, true);
  assert.equal(decision.reason, 'PRE_ENTRY_RUG_EXTREME_DUMPABILITY');
  assert.equal(tracker.health().guardExtremeDumpabilityRejected, 1);
}

{
  const persistedAudits = [];
  const tracker = new PreEntryRugRiskTracker({
    config,
    store: {
      recordPreEntryRugFirstCliffAudits(rows) {
        persistedAudits.push(...rows);
        return rows.length;
      },
    },
  });
  const seedFirstCliffCandidate = (mint, base, buyToken = [22, 4, 4, 4, 4]) => {
    const buySol = [8, 0.5, 0.5, 0.5, 0.5];
    for (let index = 0; index < 10; index += 1) {
      const buyIndex = Math.floor(index / 2);
      tracker.observeTrade({
        mint,
        side: index % 2 === 0 ? 'BUY' : 'SELL',
        market: 'PUMP_BONDING_CURVE',
        wallet: index % 2 === 0 ? `holder-${mint}-${buyIndex}` : `seller-${mint}-${buyIndex}`,
        solAmount: index % 2 === 0 ? buySol[buyIndex] : 0.01,
        tokenAmount: index % 2 === 0 ? buyToken[buyIndex] : 0.1,
        timestampMs: base + index * 500,
        price: 1,
        virtualTokenReservesRaw: '1000000000000',
        virtualSolReservesRaw: '100000000000',
        realTokenReservesRaw: '100000000',
        realSolReservesRaw: '10000000000',
      });
    }
  };

  seedFirstCliffCandidate('hc-cliff', 1_000);
  const feature = tracker.snapshot('hc-cliff', 5_600);
  assert.equal(feature.flagged, false);
  assert.equal(feature.firstCliffCounterfactual.eligible, true);
  assert.equal(feature.firstCliffCounterfactual.hc1Matched, true);
  assert.equal(feature.firstCliffCounterfactual.hc2Matched, true);
  assert.ok(feature.firstCliffCounterfactual.effectiveBuyers < 3);
  assert.equal(feature.firstCliffCounterfactual.lifecycleStage, 'LAUNCH');
  assert.equal(feature.firstCliffCounterfactual.lifecycleLabel, '发射 0–5 秒');
  const cliffEntry = tracker.evaluateGuard({
    strategyId: 'HC-LIVE', mint: 'hc-cliff', timestampMs: 5_600, source: 'LIVE',
  });
  assert.equal(cliffEntry.blocked, false);
  tracker.observeTrade({
    mint: 'hc-cliff', side: 'SELL', market: 'PUMP_BONDING_CURVE', wallet: 'cliff-dumper',
    timestampMs: 6_500, price: 0.2, tokenAmount: 50,
  });
  tracker.observeTrade({
    mint: 'hc-cliff', side: 'BUY', market: 'PUMP_BONDING_CURVE', wallet: 'cliff-confirm',
    timestampMs: 6_600, price: 0.2, tokenAmount: 0.1, solAmount: 0.01,
  });

  seedFirstCliffCandidate('hc-no-cliff', 101_000);
  const noCliffEntry = tracker.evaluateGuard({
    strategyId: 'HC-SHADOW', mint: 'hc-no-cliff', timestampMs: 105_600, source: 'SHADOW',
  });
  assert.equal(noCliffEntry.blocked, false);
  tracker.observeTrade({
    mint: 'hc-no-cliff', side: 'BUY', market: 'PUMP_BONDING_CURVE', wallet: 'late-buyer',
    timestampMs: 136_000, price: 1.05, tokenAmount: 0.1, solAmount: 0.01,
  });

  // Persist the unflagged control arm too; otherwise recall and missed-cliff
  // counts would be unknowable tomorrow.
  seedFirstCliffCandidate('hc-missed-cliff', 201_000, [1, 1, 1, 1, 1]);
  const controlFeature = tracker.snapshot('hc-missed-cliff', 205_600);
  assert.equal(controlFeature.firstCliffCounterfactual.eligible, true);
  assert.equal(controlFeature.firstCliffCounterfactual.hc1Matched, false);
  assert.equal(controlFeature.firstCliffCounterfactual.hc2Matched, false);
  tracker.evaluateGuard({
    strategyId: 'HC-CONTROL', mint: 'hc-missed-cliff', timestampMs: 205_600, source: 'SHADOW',
  });
  tracker.observeTrade({
    mint: 'hc-missed-cliff', side: 'SELL', market: 'PUMP_BONDING_CURVE', wallet: 'control-dumper',
    timestampMs: 206_500, price: 0.2, tokenAmount: 50,
  });
  tracker.observeTrade({
    mint: 'hc-missed-cliff', side: 'BUY', market: 'PUMP_BONDING_CURVE', wallet: 'control-confirm',
    timestampMs: 206_600, price: 0.2, tokenAmount: 0.1, solAmount: 0.01,
  });

  assert.equal(tracker._flushFirstCliffAudits(), 3);
  assert.equal(persistedAudits.length, 3);
  assert.deepEqual(
    persistedAudits.map((row) => row.outcome).sort(),
    ['CLIFF_RUG_70', 'CLIFF_RUG_70', 'NO_CLIFF_30S'],
  );
  assert.ok(persistedAudits.every((row) => row.auditKey));
  const health = tracker.health();
  assert.equal(health.firstCliffCandidates, 3);
  assert.equal(health.firstCliffResolved, 3);
  assert.equal(health.firstCliffCaught, 2);
  assert.equal(health.firstCliffNoCliff30s, 1);
  assert.equal(health.firstCliffPending, 0);
  assert.equal(health.firstCliffAuditsPersisted, 3);
  assert.equal(health.firstCliffAuditErrors, 0);
  const liveStats = health.strategyStats.find((row) => row.strategyId === 'HC-LIVE');
  assert.equal(liveStats.firstCliffHc1Caught, 1);
  assert.equal(liveStats.firstCliffHc2Caught, 1);
  assert.equal(liveStats.firstCliffHc1PrecisionPct, 100);
  const liveLaunchStats = liveStats.firstCliffByStage.find((row) => row.lifecycleStage === 'LAUNCH');
  assert.equal(liveLaunchStats.firstCliffHc1Caught, 1);
  const shadowStats = health.strategyStats.find((row) => row.strategyId === 'HC-SHADOW');
  assert.equal(shadowStats.firstCliffHc1NoCliff30s, 1);
  assert.ok(shadowStats.firstCliffHc1AverageReturnPct > 4.9);
  const launchLifecycle = health.firstCliffLifecycleSummary.find((row) => row.lifecycleStage === 'LAUNCH');
  assert.equal(launchLifecycle.firstCliffHc1Caught, 1);
  assert.equal(launchLifecycle.firstCliffHc1NoCliff30s, 1);
  assert.ok(health.recentFirstCliffCounterfactuals.some((row) => row.outcome === 'CLIFF_RUG_70'));
}

{
  const tracker = new PreEntryRugRiskTracker({ config });
  for (let index = 0; index < 15; index += 1) {
    tracker.observeTrade({
      mint: 'rug', side: 'BUY', market: 'PUMP_BONDING_CURVE',
      timestampMs: 1_000 + index * 500, price: 1 + index * 0.04,
    });
  }
  const snapshot = tracker.snapshot('rug', 9_000);
  assert.equal(snapshot.sampleReady, true);
  assert.equal(snapshot.flagged, true);
  assert.equal(snapshot.score, 5);
  assert.equal(snapshot.maxConsecutiveBuys, 15);

  const liveDecision = tracker.evaluateGuard({
    strategyId: 'LIVE-TEST', mint: 'rug', timestampMs: 9_050, source: 'LIVE',
  });
  assert.equal(liveDecision.blocked, true);
  assert.equal(tracker.health().liveCacheHits, 1);

  // A newer trade invalidates the snapshot. Live refreshes from the bounded
  // in-memory ring so the universal guard cannot silently miss a current RUG.
  tracker.observeTrade({ mint: 'rug', side: 'BUY', timestampMs: 9_100, price: 1.7 });
  const liveMiss = tracker.evaluateGuard({
    strategyId: 'LIVE-TEST', mint: 'rug', timestampMs: 9_110, source: 'LIVE',
  });
  assert.equal(liveMiss.blocked, true);
  assert.equal(liveMiss.reason, 'PRE_ENTRY_RUG_RISK');
  assert.equal(tracker.health().liveCacheMisses, 1);
  const shadowDecision = tracker.evaluateGuard({
    strategyId: 'SHADOW-TEST', mint: 'rug', timestampMs: 9_110, source: 'SHADOW',
  });
  assert.equal(shadowDecision.blocked, true);
  const health = tracker.health();
  assert.equal(health.scope, 'LIFECYCLE_AND_STRATEGY_TIERED');
  assert.equal(health.strategyStats.find((row) => row.strategyId === 'LIVE-TEST').evaluated, 2);
  assert.ok(health.recentFlagged.some((row) => row.strategyId === 'SHADOW-TEST'));
}

{
  const tracker = new PreEntryRugRiskTracker({ config });
  for (let index = 0; index < 20; index += 1) {
    tracker.observeTrade({
      mint: 'normal', side: index % 2 ? 'SELL' : 'BUY', market: 'PUMP_AMM',
      timestampMs: 1_000 + index * 300, price: 1 + (index % 4) * 0.01,
    });
  }
  const snapshot = tracker.snapshot('normal', 8_000);
  assert.equal(snapshot.sampleReady, true);
  assert.equal(snapshot.flagged, false);
  assert.ok(snapshot.sideAlternationPct > 90);
}

{
  const tracker = new PreEntryRugRiskTracker({ config });
  const base = Date.UTC(2026, 7, 20, 2, 0, 0);
  for (let index = 0; index < 12; index += 1) {
    tracker.observeTrade({
      mint: 'vertical-fragile', side: index % 3 === 2 ? 'SELL' : 'BUY',
      wallet: index % 4 === 0 ? 'repeat-wallet' : `wallet-${index}`,
      solAmount: 0.011 + index * 0.001,
      timestampMs: base + index * 500,
      price: index === 0 ? 1 : (index === 1 ? 1.12 : 1.12 + index * 0.04),
    });
  }
  const snapshot = tracker.snapshot('vertical-fragile', base + 6_000);
  assert.equal(snapshot.flagged, true);
  assert.equal(snapshot.signatures.verticalFragileReuse, true);
  assert.ok(snapshot.maxBuyImpactPct >= 10);
}

{
  const tracker = new PreEntryRugRiskTracker({ config });
  const base = Date.UTC(2026, 7, 20, 2, 0, 0);
  for (let index = 0; index < 12; index += 1) {
    tracker.observeTrade({
      mint: 'sparse-breadth', side: index < 10 ? 'BUY' : 'SELL',
      wallet: `wallet-${index % 3}`,
      solAmount: 0.01 + index * 0.001,
      timestampMs: base + index * 500,
      price: 1 + index * 0.005,
    });
  }
  const snapshot = tracker.snapshot('sparse-breadth', base + 6_000);
  assert.equal(snapshot.flagged, true);
  assert.equal(snapshot.signatures.sparseBuyerBreadth, true);
  assert.ok(snapshot.buysPerBuyer >= 2);
}

{
  const tracker = new PreEntryRugRiskTracker({ config });
  const base = Date.UTC(2026, 7, 20, 2, 0, 0);
  for (let index = 0; index < 12; index += 1) {
    tracker.observeTrade({
      mint: 'chase-repeat', side: index % 2 === 0 ? 'BUY' : 'SELL',
      wallet: `wallet-${index}`,
      solAmount: index % 2 === 0 ? 0.1 : 0.03 + index * 0.001,
      timestampMs: base + index * 500,
      price: 1 + index * 0.04,
    });
  }
  const snapshot = tracker.snapshot('chase-repeat', base + 6_000);
  assert.equal(snapshot.flagged, true);
  assert.equal(snapshot.signatures.chaseRepeatedSize, true);
  assert.ok(snapshot.repeatedBuySizeSharePct >= 15);
}

{
  const tracker = new PreEntryRugRiskTracker({ config });
  const buildFourOfFive = (mint, base) => {
    for (let index = 0; index < 28; index += 1) {
      const side = index < 14 ? 'BUY' : (index % 2 === 0 ? 'BUY' : 'SELL');
      tracker.observeTrade({
        mint, side, wallet: `wallet-${mint}-${index}`,
        solAmount: 0.01 + index * 0.001,
        timestampMs: base + index * 400,
        price: 1 + index * 0.015,
      });
    }
  };
  const beijing17 = Date.UTC(2026, 7, 20, 9, 0, 0);
  const beijing12 = Date.UTC(2026, 7, 20, 4, 0, 0);
  buildFourOfFive('risk-hour', beijing17);
  buildFourOfFive('normal-hour', beijing12);
  const riskHour = tracker.snapshot('risk-hour', beijing17 + 11_300);
  const normalHour = tracker.snapshot('normal-hour', beijing12 + 11_300);
  assert.equal(riskHour.score, 4);
  assert.equal(riskHour.beijingRiskWindow, true);
  assert.equal(riskHour.flagged, true);
  assert.equal(normalHour.score, 4);
  assert.equal(normalHour.beijingRiskWindow, false);
  assert.equal(normalHour.flagged, false);
}

{
  const tracker = new PreEntryRugRiskTracker({ config });
  const base = Date.UTC(2026, 7, 23, 4, 0, 0);
  const toxicSizes = [20.01, 20.07, 19.16, 19.25];
  toxicSizes.forEach((solAmount, index) => tracker.observeTrade({
    mint: 'first-toxic-mint', side: 'BUY', wallet: `toxic-wallet-${index}`,
    solAmount, timestampMs: base + index * 10, price: 1 + index * 0.2,
  }));
  tracker.observeTrade({
    mint: 'first-toxic-mint', side: 'SELL', wallet: 'dump-wallet', solAmount: 70,
    timestampMs: base + 1_000, price: 0.2,
  });
  assert.equal(tracker.health().toxicCollapsesLabeled, 1);
  assert.equal(tracker.health().toxicTemplates, 1);
  assert.equal(tracker.health().toxicWallets, 4);

  // Rotating every wallet does not evade an identical amount/timing template.
  toxicSizes.forEach((solAmount, index) => tracker.observeTrade({
    mint: 'rotated-wallet-copy', side: 'BUY', wallet: `rotated-${index}`,
    solAmount, timestampMs: base + 2_000 + index * 10, price: 1 + index * 0.2,
  }));
  const templateCopy = tracker.evaluateGuard({
    strategyId: 'O90', mint: 'rotated-wallet-copy',
    timestampMs: base + 2_100, source: 'LIVE',
  });
  assert.equal(templateCopy.sampleReady, false);
  assert.equal(templateCopy.crossMintToxic, true);
  assert.equal(templateCopy.signatures.crossMintToxicTemplate, true);
  assert.equal(templateCopy.blocked, true);

  // Different amounts are still rejected when two learned wallets reappear.
  [12, 13, 14, 15].forEach((solAmount, index) => tracker.observeTrade({
    mint: 'wallet-overlap-copy', side: 'BUY',
    wallet: index < 2 ? `toxic-wallet-${index}` : `fresh-wallet-${index}`,
    solAmount, timestampMs: base + 3_000 + index * 10, price: 1 + index * 0.1,
  }));
  const walletCopy = tracker.evaluateGuard({
    strategyId: 'O90', mint: 'wallet-overlap-copy',
    timestampMs: base + 3_100, source: 'SHADOW',
  });
  assert.equal(walletCopy.sampleReady, false);
  assert.equal(walletCopy.toxicWalletOverlap, 2);
  assert.equal(walletCopy.signatures.crossMintToxicWallets, true);
  assert.equal(walletCopy.blocked, true);

  [5, 10, 15, 20].forEach((solAmount, index) => tracker.observeTrade({
    mint: 'benign-burst', side: 'BUY', wallet: `benign-${index}`,
    solAmount, timestampMs: base + 4_000 + index * 10, price: 1 + index * 0.02,
  }));
  const benign = tracker.evaluateGuard({
    strategyId: 'O90', mint: 'benign-burst',
    timestampMs: base + 4_100, source: 'LIVE',
  });
  assert.equal(benign.sampleReady, false);
  assert.equal(benign.crossMintToxic, false);
  assert.equal(benign.blocked, false);
  assert.equal(tracker.health().guardCrossMintRejected, 2);
}

{
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-rug-memory-'));
  const memoryPath = path.join(temporaryDirectory, 'toxic-memory.json');
  const base = Date.UTC(2026, 7, 23, 5, 0, 0);
  const toxicHistory = [];
  try {
    const first = new PreEntryRugRiskTracker({
      config: { ...config, toxicMemoryPath: memoryPath, toxicPersistIntervalMs: 60_000 },
      store: {
        recordPreEntryRugToxicHistory(rows) {
          toxicHistory.push(...rows);
          return rows.length;
        },
      },
      now: () => base + 2_000,
    });
    first.start();
    const toxicSizes = [20.01, 20.07, 19.16, 19.25];
    toxicSizes.forEach((solAmount, index) => first.observeTrade({
      mint: 'persistent-toxic', side: 'BUY', wallet: `persist-wallet-${index}`,
      solAmount, timestampMs: base + index * 10, price: 1 + index * 0.2,
    }));
    first.observeTrade({
      mint: 'persistent-toxic', side: 'SELL', wallet: 'dump-wallet', solAmount: 70,
      timestampMs: base + 1_000, price: 0.2,
    });
    assert.equal(toxicHistory.length, 5);
    assert.equal(
      toxicHistory.find((row) => row.kind === 'WALLET').expiresAt,
      base + 1_000 + 60 * 86_400_000,
    );
    assert.equal(
      toxicHistory.find((row) => row.kind === 'TEMPLATE').expiresAt,
      base + 1_000 + 30 * 86_400_000,
    );
    assert.equal(first.health().toxicHistoryPersisted, 5);
    first.stop();
    assert.equal(fs.existsSync(memoryPath), true);

    const restored = new PreEntryRugRiskTracker({
      config: { ...config, toxicMemoryPath: memoryPath, toxicPersistIntervalMs: 60_000 },
      now: () => base + 3_000,
    });
    restored.start();
    assert.ok(restored.health().toxicMemoryLoaded >= 5);
    // Each buy is shifted enough to change the exact 0.25-SOL fingerprint,
    // while remaining within the conservative 2% amount tolerance. The burst
    // also crosses an exact span bucket but stays within 100ms.
    toxicSizes.forEach((solAmount, index) => restored.observeTrade({
      mint: 'fuzzy-copy', side: 'BUY', wallet: `new-wallet-${index}`,
      solAmount: solAmount + 0.3,
      timestampMs: base + 2_100 + index * 40, price: 1 + index * 0.1,
    }));
    const decision = restored.evaluateGuard({
      strategyId: 'O90', mint: 'fuzzy-copy', timestampMs: base + 2_300, source: 'LIVE',
    });
    assert.equal(decision.blocked, true);
    assert.equal(decision.signatures.crossMintToxicTemplate, true);
    assert.equal(restored.health().toxicFuzzyMatches, 1);
    restored.stop();
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

console.log('pre-entry RUG risk tests passed');
