'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { PreEntryRugRiskTracker } = require('../src/core/PreEntryRugRiskTracker');
const { ResearchStore } = require('../src/data/ResearchStore');
const { chooseFilter, exportResearchWindow } = require('./export-research-window');

const base = Date.UTC(2026, 8, 6);
const stage = 'AMM_EARLY';
const market = 'PUMP_AMM';
const config = {
  enabled: true, windowMs: 15_000, stateRetentionMs: 60_000,
  maxEventsPerMint: 256, minTrades: 10, cacheMaxAgeMs: 1_000,
  crossMintEnabled: true, dumpabilityEnabled: false,
  extremeDumpabilityEnabled: false,
};
const tracker = () => new PreEntryRugRiskTracker({ config });
const template = {
  fingerprint: `${stage}|${market}|4|50|10.00,10.00,10.00,10.00`,
  lifecycleStage: stage, market, largeBuyCount: 4, burstSpanMs: 30,
  amounts: [10, 10, 10, 10], totalBuySol: 40,
};
const record = (patch = {}) => ({
  ...template, mint: 'origin', labeledAt: base + 100, expiresAt: base + 900,
  ...patch,
});
const walletRecord = (patch = {}) => record({
  wallet: 'known-wallet', walletRole: 'COORDINATED_BUYER', ...patch,
});

// Loading an end-of-window snapshot at an earlier time must not import labels
// that were not yet known. Legacy scope remains quarantined, never upgraded.
{
  const t = tracker();
  assert.equal(t._ingestToxicMemory({
    templates: [record()], wallets: [walletRecord()],
  }, base + 99), 0);
  assert.equal(t.toxicTemplates.size, 0);
  assert.equal(t.toxicWallets.size, 0);
  assert.equal(t._ingestToxicMemory({
    templates: [record()], wallets: [walletRecord()],
  }, base + 100), 2);
  assert.equal(t._toxicWalletMatch(['known-wallet'], base + 99, stage, market).overlap, 0);
  assert.equal(t._activeToxicTemplate(template, base + 99), null);
  assert.equal(t.toxicTemplates.size, 1, 'early query must not delete a future label');
  assert.equal(t.toxicWallets.size, 1);
  assert.equal(t._toxicWalletMatch(['known-wallet'], base + 100, stage, market).overlap, 1);
  assert.equal(t._activeToxicTemplate(template, base + 100)?.labeledAt, base + 100);
  assert.equal(t._toxicWalletMatch(['known-wallet'], base + 900, stage, market).overlap, 0);
  assert.equal(t._activeToxicTemplate(template, base + 900), null);
}

for (const labeledAt of [undefined, null, '', 0, -1, NaN, Infinity, 'unknown']) {
  const t = tracker();
  assert.equal(t._ingestToxicMemory({
    templates: [record({ labeledAt })], wallets: [walletRecord({ labeledAt })],
  }, base + 200), 0);
  // Matching is defensive even if a caller bypasses the snapshot loader.
  t.toxicTemplates.set(template.fingerprint, record({ labeledAt }));
  t._indexToxicTemplate(record({ labeledAt }));
  t.toxicWallets.set(t._toxicWalletKey('known-wallet', stage, market,
    'COORDINATED_BUYER'), walletRecord({ labeledAt }));
  assert.equal(t._activeToxicTemplate(template, base + 200), null);
  assert.equal(t._toxicWalletMatch(['known-wallet'], base + 200, stage, market).overlap, 0);
}

{
  const t = tracker();
  const lateTemplate = record({ createdAt: base + 500 });
  const lateWallet = walletRecord({ createdAt: base + 500 });
  assert.equal(t._ingestToxicMemory({ templates: [lateTemplate], wallets: [lateWallet] }, base + 499), 0);
  assert.equal(t._ingestToxicMemory({ templates: [lateTemplate], wallets: [lateWallet] }, base + 500), 2);
  assert.equal(t.toxicTemplates.get(template.fingerprint).createdAt, base + 500);
  assert.equal([...t.toxicWallets.values()][0].createdAt, base + 500);
  assert.equal(t._activeToxicTemplate(template, base + 499), null);
  assert.equal(t._toxicWalletMatch(['known-wallet'], base + 499, stage, market).overlap, 0);
  assert.equal(t._activeToxicTemplate(template, base + 500)?.createdAt, base + 500);
  assert.equal(t._toxicWalletMatch(['known-wallet'], base + 500, stage, market).overlap, 1);
}

{
  const t = tracker();
  const oldScope = record({ lifecycleStage: undefined, market: undefined });
  t._ingestToxicMemory({ templates: [oldScope], wallets: [walletRecord({
    lifecycleStage: undefined, market: undefined,
  })] }, base + 200);
  assert.equal(t.toxicTemplates.get(template.fingerprint).lifecycleStage, 'LEGACY_GLOBAL');
  assert.equal(t._toxicWalletMatch(['known-wallet'], base + 200, stage, market).overlap, 0);
}

// Fuzzy matches have the same as-of fence as exact matches.
{
  const t = tracker();
  t._ingestToxicMemory({ templates: [record()] }, base + 100);
  const fuzzy = { ...template, fingerprint: 'nearby-amounts', amounts: [10.01, 10, 10, 10] };
  assert.equal(t._activeToxicTemplate(fuzzy, base + 99), null);
  assert.equal(t._activeToxicTemplate(fuzzy, base + 100)?.fingerprint, template.fingerprint);
}

// Future/past evaluations cannot leak through either the Shadow or LIVE cache.
// No new trade/version is needed for a label or expiry boundary to invalidate it.
for (const source of ['SHADOW', 'LIVE']) for (const evidence of ['template', 'wallets'])
  for (const knowledgeFence of ['labeledAt', 'createdAt']) {
  const t = tracker();
  for (let i = 0; i < 4; i += 1) t.observeTrade({
    mint: 'copy', side: 'BUY', market, wallet: `buyer-${i}`, solAmount: 10,
    timestampMs: base + i * 10, price: 1,
  });
  const observedTemplate = t.states.get('copy').template;
  const toxic = { ...record(), ...observedTemplate,
    labeledAt: knowledgeFence === 'labeledAt' ? base + 100 : base + 50,
    ...(knowledgeFence === 'createdAt' ? { createdAt: base + 100 } : {}),
    expiresAt: base + 900 };
  t._ingestToxicMemory(evidence === 'template' ? { templates: [toxic] } : {
    wallets: [0, 1].map((i) => ({ ...toxic, wallet: `buyer-${i}`,
      walletRole: 'COORDINATED_BUYER' })),
  }, base + 200);
  const decide = (offset) => t.evaluateGuard({
    strategyId: 'ASOF_TEST', mint: 'copy', timestampMs: base + offset, source,
    hardBlockSignatures: ['crossMintToxicTemplate', 'crossMintToxicWallets'],
  });
  assert.equal(decide(99).blocked, false);
  assert.equal(decide(100).blocked, true, 'activation must invalidate a recent negative cache');
  assert.equal(decide(99).blocked, false, 'future positive cache must not travel backwards');
  assert.equal(decide(100).blocked, true);
  assert.equal(decide(110).blocked, true);
  if (source === 'LIVE') assert.equal(t.health().liveCacheHits, 1,
    'normal short forward cache remains available');
  assert.equal(decide(900).blocked, false, 'expiry must invalidate a recent positive cache');
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-rug-asof-'));
const sourcePath = path.join(directory, 'source.db');
const destinationPath = path.join(directory, 'window.db');
const store = new ResearchStore({ dbPath: sourcePath });
let exported = null;
try {
  const startMs = base;
  const endMs = base + 10_000;
  const row = (subject, labeledAt, expiresAt, createdAt = labeledAt) => {
    store.recordPreEntryRugToxicHistory([{
      kind: 'WALLET', subject, wallet: subject, mint: 'origin',
      lifecycleStage: stage, market, walletRole: 'COORDINATED_BUYER',
      labeledAt, expiresAt,
    }]);
    store.db.prepare('UPDATE pre_entry_rug_toxic_history SET created_at=? WHERE subject=?')
      .run(createdAt, subject);
  };
  row('prewindow-active-60days', base - 59 * 86_400_000, base + 86_400_000);
  row('prewindow-active-30days', base - 29 * 86_400_000, base + 1_000);
  row('expired-at-start', base - 5_000, startMs);
  row('expired-before-start', base - 5_000, startMs - 1);
  row('during-window', base + 5_000, endMs + 5_000);
  row('during-window-late-write', base - 1, endMs + 5_000, base + 5_000);
  row('at-exclusive-end', endMs, endMs + 5_000);
  row('future-label', endMs + 1, endMs + 5_000, base - 1);
  row('late-backfill', base - 1, endMs + 5_000, endMs);
  row('unknown-label-zero', 0, endMs + 5_000, base - 1);
  row('unknown-label-negative', -1, endMs + 5_000, base - 1);
  row('unknown-creation-zero', base - 1, endMs + 5_000, 0);
  row('unknown-creation-negative', base - 1, endMs + 5_000, -1);

  const atStart = store.loadActivePreEntryRugToxicHistory(startMs).map((r) => r.subject);
  assert.deepEqual(atStart.sort(), ['prewindow-active-30days',
    'prewindow-active-60days'].sort());
  assert.equal(store.loadActivePreEntryRugToxicHistory(base + 4_999)
    .some((r) => r.subject === 'during-window-late-write'), false);
  assert.equal(store.loadActivePreEntryRugToxicHistory(base + 5_000)
    .find((r) => r.subject === 'during-window-late-write').createdAt, base + 5_000);
  assert.equal(store.loadActivePreEntryRugToxicHistory(base + 4_999)
    .some((r) => r.subject === 'during-window'), false);
  assert.equal(store.loadActivePreEntryRugToxicHistory(base + 5_000)
    .some((r) => r.subject === 'during-window'), true);

  // Small persistence extension for the strict second-leg cohort. Omitted/null
  // features leave earlier metadata untouched; an explicit object replaces it.
  const position = store.createMigrationSecondLegShadowPosition({
    cohortId: 'ASOF_TEST', episodeId: 'one', mint: 'feature-copy',
    positionSol: 0.02, configuredCostPct: 3.05, migrationAt: base - 20_000,
    signalAt: base, signalPrice: 1, signalAgeMs: 20_000,
    features: { frozen: 'original' }, entryTargetAt: base + 1_000,
    entryDeadlineAt: base + 3_000, hardStopPct: 20, maxHoldMs: 8_000,
  });
  const readFeatures = () => JSON.parse(store.db.prepare(
    'SELECT features_json FROM migration_second_leg_shadow_positions WHERE id=?',
  ).get(position.id).features_json);
  store.updateMigrationSecondLegShadowPosition(position.id, { lastPrice: 1.1 });
  assert.deepEqual(readFeatures(), { frozen: 'original' });
  const features = { units: 0, cursor: { slot: 42, eventIndex: 0 }, exit: { delayMs: 1_000 } };
  store.updateMigrationSecondLegShadowPosition(position.id, { features });
  assert.deepEqual(readFeatures(), features);
  store.updateMigrationSecondLegShadowPosition(position.id, { features: null });
  assert.deepEqual(readFeatures(), features);
  store.updateMigrationSecondLegShadowPosition(position.id, { features: {} });
  assert.deepEqual(readFeatures(), {});

  const filter = chooseFilter('pre_entry_rug_toxic_history', [
    'labeled_at', 'expires_at', 'created_at',
  ]);
  assert.equal(filter.anchor, 'labeled_at');
  const plan = store.db.prepare(`EXPLAIN QUERY PLAN
    SELECT * FROM pre_entry_rug_toxic_history INDEXED BY ${filter.sourceIndex}
    WHERE ${filter.where}`)
    .all(...filter.bind(startMs, endMs));
  assert.ok(plan.some((r) => /SEARCH .* USING INDEX idx_pre_entry_rug_toxic_history_expires \(expires_at>\?\)/
    .test(r.detail)),
    JSON.stringify(plan));

  // Export while the source is still open in WAL mode: includes committed rows
  // from the pinned source snapshot, while the explicit end fence stays causal.
  const manifest = exportResearchWindow({ sourcePath, destinationPath, startMs, endMs });
  assert.equal(manifest.integrity, 'ok');
  assert.equal(manifest.mode, 'CONSISTENT_READ_TRANSACTION_WINDOW');
  const table = manifest.tables.find((r) => r.table === 'pre_entry_rug_toxic_history');
  assert.equal(table.rows, 4);
  assert.equal(table.anchor, 'labeled_at');
  assert.equal(table.firstMs, base - 59 * 86_400_000);
  exported = new Database(destinationPath, { readonly: true, fileMustExist: true });
  assert.deepEqual(exported.prepare('SELECT subject FROM pre_entry_rug_toxic_history ORDER BY subject')
    .all().map((r) => r.subject), ['during-window', 'during-window-late-write', 'prewindow-active-30days',
    'prewindow-active-60days']);
  const loadExport = ResearchStore.prototype.loadActivePreEntryRugToxicHistory.bind({ db: exported });
  assert.deepEqual(loadExport(startMs).map((r) => r.subject).sort(),
    ['prewindow-active-30days', 'prewindow-active-60days']);
  assert.equal(loadExport(base + 4_999).some((r) => r.subject === 'during-window'), false);
  assert.equal(loadExport(base + 5_000).some((r) => r.subject === 'during-window'), true);
  assert.equal(loadExport(base + 4_999).some((r) => r.subject === 'during-window-late-write'), false);
  assert.equal(loadExport(base + 5_000).find((r) => r.subject === 'during-window-late-write').createdAt,
    base + 5_000);
  // Old source archives without the preferred index remain exportable. The
  // compatibility path must never create an index or alter a source schema.
  store.db.exec('DROP INDEX idx_pre_entry_rug_toxic_history_expires');
  const legacyManifest = exportResearchWindow({ sourcePath,
    destinationPath: path.join(directory, 'without-expiry-index.db'), startMs, endMs });
  assert.equal(legacyManifest.tables.find((r) => r.table === 'pre_entry_rug_toxic_history').rows, 4);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='idx_pre_entry_rug_toxic_history_expires'")
    .get(), undefined);
  console.log(`RUG as-of export plan: ${plan.map((r) => r.detail).join('; ')}`);
} finally {
  if (exported) exported.close();
  store.close();
  // This test owns the exact mkdtemp child and closes every connection first.
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('RUG history as-of, window seed export and second-leg feature update tests passed');
