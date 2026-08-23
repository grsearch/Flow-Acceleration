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
  toxicWalletOverlapMin: 2,
  maxToxicWallets: 4_096,
  maxToxicTemplates: 1_024,
};

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
  assert.equal(health.scope, 'ALL_LIVE_AND_SHADOW_ENTRIES');
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
  try {
    const first = new PreEntryRugRiskTracker({
      config: { ...config, toxicMemoryPath: memoryPath, toxicPersistIntervalMs: 60_000 },
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
