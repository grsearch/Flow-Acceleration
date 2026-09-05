'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CRITICAL_FILES, collectRuntimeIntegrity, collectSafeConfigSummary } = require('../src/runtime/RuntimeIntegrity');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-integrity-'));
const headCommit = 'a'.repeat(40);
const bodies = new Map();
const secret = 'SECRET_VALUE_MUST_NEVER_APPEAR';
const config = {
  liveTrading: { enabled: true, privateKey: secret, rpcUrl: `https://host/?api-key=${secret}`,
    maxSignalAgeMs: 1500, maxPositionTradeAgeMs: 3000,
    strategies: [
      { id: 'graduation_accel_o_c80_ho500_x60_live', enabled: true, entryEnabled: true,
        sourceShadowCohortId: 'O_C80_HO500_X60:0_1SOL', positionSizeSol: 0.1,
        requireChainTimestamp: true, requireEntrySlot: true, requireSignalPool: true,
        exitMode: 'FIXED_HOLD', fixedHoldMs: 60000, credentials: secret },
      ...['migrated_ge30_r23_f2_only_g2_xleg_live', 'migrated_grt_r23_f3_v2_xleg_live'].map((id) => ({
        id, requireChainTimestamp: true, requireEntrySlot: true,
      })),
    ],
  },
  graduationAccelerationShadow: { enabled: true, entryProfiles: [{ id: 'O_C80_HO500_X60',
    handoffLiveStrategyId: 'graduation_accel_o_c80_ho500_x60_live', liveBridgeCapacitySol: 0.1,
    capacitySols: [0.1, 1], postMigrationEntryGate: { windowMs: 500, evaluateAtFill: true },
  }] },
  stream: { token: secret },
};
let calls = 0;
function runGit(args, input) {
  calls += 1;
  if (args[0] === 'rev-parse') {
    assert.deepEqual(args, ['rev-parse', '--verify', 'HEAD']);
    return Buffer.from(`${headCommit}\n`);
  }
  assert.deepEqual(args, ['cat-file', '--batch']);
  assert.equal(input, `${CRITICAL_FILES.map((file) => `${headCommit}:${file}`).join('\n')}\n`);
  return Buffer.concat(CRITICAL_FILES.map((file) => bodies.has(file)
    ? Buffer.concat([Buffer.from(`${'b'.repeat(40)} blob ${bodies.get(file).length}\n`), bodies.get(file), Buffer.from('\n')])
    : Buffer.from(`${headCommit}:${file} missing\n`)));
}

try {
  for (const file of CRITICAL_FILES) {
    const body = Buffer.from(`// ${file}\nconst value = 1;\n`);
    bodies.set(file, body);
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), body);
  }
  fs.writeFileSync(path.join(directory, '.env'), `PRIVATE_KEY=${secret}\n`);
  const input = { projectDir: directory, runtimeConfig: config, expectedCommit: headCommit.slice(0, 7), runGit };
  let result = collectRuntimeIntegrity(input);
  assert.equal(result.status, 'MATCH');
  assert.equal(result.expectedCommitMatches, true);
  assert.equal(result.files.length, CRITICAL_FILES.length);
  assert.equal(calls, 2, 'bounded to one HEAD lookup and one batch of fixed blobs');
  assert.deepEqual(result.warnings, []);
  assert(!JSON.stringify(result).includes(secret));
  assert(!JSON.stringify(result).includes(directory), 'no absolute paths in diagnostics');
  assert.equal(result.configSummary.ho500.positionSizeSol, 0.1);
  assert.equal(result.configSummary.bridge.liveBridgeCapacitySol, 0.1);
  assert.equal(result.configSummary.post[0].requireEntrySlot, true);

  fs.writeFileSync(path.join(directory, CRITICAL_FILES[0]), bodies.get(CRITICAL_FILES[0]).toString().replace(/\n/g, '\r\n'));
  result = collectRuntimeIntegrity(input);
  assert.equal(result.status, 'MATCH', 'CRLF checkout is not a mixed source version');
  assert.notEqual(result.files[0].actualSha256, result.files[0].headSha256);
  fs.writeFileSync(path.join(directory, CRITICAL_FILES[1]), 'const value = 2;\n');
  result = collectRuntimeIntegrity(input);
  assert.equal(result.status, 'MISMATCH');
  assert.deepEqual(result.mismatchedFiles, [CRITICAL_FILES[1]]);
  assert.equal(collectRuntimeIntegrity({ ...input, expectedCommit: 'c'.repeat(40) }).expectedCommitMatches, false);

  bodies.delete(CRITICAL_FILES[1]);
  result = collectRuntimeIntegrity(input);
  assert.equal(result.status, 'UNKNOWN');
  assert.deepEqual(result.unverifiedFiles, [CRITICAL_FILES[1]]);
  result = collectRuntimeIntegrity({ ...input, runGit() { throw new Error(secret); } });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.gitStatus, 'UNAVAILABLE');
  assert(!JSON.stringify(result).includes(secret), 'git stderr/error must never escape');
  result = collectRuntimeIntegrity({ ...input, runGit() { return Buffer.from(secret); } });
  assert.equal(result.headCommit, null);
  assert(!JSON.stringify(result).includes(secret), 'malformed HEAD stdout must never escape');
  assert.equal(collectRuntimeIntegrity({ ...input, runGit(args) {
    return args[0] === 'rev-parse' ? Buffer.from(headCommit) : Buffer.from('bad batch');
  } }).status, 'UNKNOWN');

  const old = structuredClone(config);
  old.liveTrading.strategies[0].sourceShadowCohortId = 'O_C80_HO500_X60:1SOL';
  old.graduationAccelerationShadow.entryProfiles[0].handoffLiveStrategyId = 'graduation_accel_o_c80_ho500_x60_recovery_live';
  old.graduationAccelerationShadow.entryProfiles[0].liveBridgeCapacitySol = 1;
  delete old.liveTrading.strategies[1].requireEntrySlot;
  const before = JSON.stringify(old);
  const summary = collectSafeConfigSummary(old);
  assert(summary.warnings.includes('HO500_SOURCE_MISMATCH'));
  assert(summary.warnings.includes('HO500_BRIDGE_STRATEGY_MISMATCH'));
  assert(summary.warnings.includes('HO500_BRIDGE_CAPACITY_NOT_0_1_SOL'));
  assert(summary.warnings.includes('ENTRY_SLOT_GATE_MISSING:migrated_ge30_r23_f2_only_g2_xleg_live'));
  assert.equal(JSON.stringify(old), before, 'diagnostics must not change trading settings');
  assert.deepEqual(collectSafeConfigSummary(null), { available: false, warnings: ['CONFIG_UNAVAILABLE'] });
  console.log('test-runtime-integrity: ok (HEAD batch, mismatch, CRLF, missing/git unavailable, redaction, HO500/POST diagnostics)');
} finally {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('flow-integrity-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
