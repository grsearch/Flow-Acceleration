'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { sanitizeHealth, readHealth, cacheDiagnostics, captureDiagnostics } = require('./export-runtime-diagnostics');

async function main() {
  const secret = 'SENSITIVE-WALLET-SECRET-ENDPOINT';
  const payload = {
    status: 'streaming', uptimeMs: 1200, dataLatencyMs: 13,
    runtime: { pid: 123, startedAt: 1000, gitCommit: 'a'.repeat(40), cwd: secret, dbPath: secret },
    stream: { transactionsReceived: 500, errors: 2, endpoint: secret, token: secret },
    liveTrading: { enabled: true, rejectedPositionTrades: 7, takeProfitQuoteRejected: 2,
      entries: 3, wallet: secret, lastError: secret },
    preEntryRugRisk: {
      enabled: true, toxicTemplateCandidates: 4, toxicCollapsesLabeled: 1,
      toxicMemoryDbLoaded: 6, toxicHistoryPersisted: 6, toxicMemoryDirty: false,
      toxicLastCollapseAt: 2000, lastError: secret, toxicMemoryPath: secret,
      recentFlagged: [{ mint: secret, wallet: secret }],
      toxicMemoryByScope: {
        'CURVE_MIGRATION|PUMP_BONDING_CURVE': {
          wallets: 5, templates: 1, roles: { COORDINATED_BUYER: 4, DUMP_SELLER: 1, [secret]: 500 },
        },
        [secret]: { wallets: 50 },
      },
      thresholds: { toxicCollapsePct: 60, toxicWalletOverlapMin: 2, apiKey: secret },
    },
  };
  const clean = sanitizeHealth(payload);
  assert.equal(JSON.stringify(clean).includes(secret), false);
  assert.equal(clean.preEntryRugRisk.toxicHistoryPersisted, 6);
  assert.equal(clean.preEntryRugRisk.toxicMemoryByScope
    ['CURVE_MIGRATION|PUMP_BONDING_CURVE'].roles.DUMP_SELLER, 1);
  assert.equal(clean.runtime.gitCommit, 'a'.repeat(40));
  assert.equal(clean.liveTrading.rejectedPositionTrades, 7);
  assert.equal(clean.liveTrading.takeProfitQuoteRejected, 2);
  assert.equal(clean.liveTrading.entries, 3);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-runtime-diagnostics-'));
  const file = path.join(directory, 'cache.json');
  let responseMode = 'normal';
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/health');
    if (responseMode === 'timeout') return;
    if (responseMode === 'oversize') { response.end('x'.repeat(256)); return; }
    if (responseMode === 'invalid') { response.end(secret); return; }
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 3, savedAt: 2000,
      templates: [{ fingerprint: secret, mint: secret, expiresAt: 5000,
        lifecycleStage: 'AMM_EARLY', market: 'PUMP_AMM' }],
      wallets: [{ wallet: secret, expiresAt: 5000 }, { wallet: secret, expiresAt: 1000 }],
    }));
    const cache = cacheDiagnostics(file, 3000);
    assert.equal(cache.active, 2);
    assert.equal(cache.expired, 1);
    assert.equal(cache.counts['LEGACY_GLOBAL|UNKNOWN'].wallets, 1);
    assert.equal(JSON.stringify(cache).includes(secret), false);

    const captured = await captureDiagnostics({ projectDir: path.resolve(__dirname, '..'),
      memoryPath: file, port, now: 3000 });
    assert.equal(captured.api.status, 'CAPTURED');
    assert.equal(captured.clock, 'CAPTURE_TIME_NOT_EXPORT_WINDOW_END');
    assert.match(captured.source.sourceFilesAtCapture['src/core/PreEntryRugRiskTracker.js'], /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(captured).includes(secret), false);

    responseMode = 'oversize';
    assert.equal((await readHealth({ port, maxBytes: 32 })).reason, 'RESPONSE_TOO_LARGE');
    responseMode = 'invalid';
    const invalid = await readHealth({ port });
    assert.equal(invalid.reason, 'INVALID_JSON');
    assert.equal(JSON.stringify(invalid).includes(secret), false);
    responseMode = 'timeout';
    const startedAt = Date.now();
    assert.equal((await readHealth({ port, timeoutMs: 25 })).reason, 'TIMEOUT');
    assert.ok(Date.now() - startedAt < 1000, 'health capture must have a wall-clock deadline');
    assert.equal(cacheDiagnostics(path.join(directory, 'missing.json'), 3000).status, 'MISSING');

    const shell = fs.readFileSync(path.join(__dirname, 'export-last24h-cos.sh'), 'utf8');
    assert.match(shell, /--out=\$STAGE\/runtime-before\.json/);
    assert.match(shell, /--out=\$STAGE\/runtime-after\.json/);
    assert.match(shell, /timeout --foreground 8s/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('flow-runtime-diagnostics-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('Runtime diagnostics export tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
