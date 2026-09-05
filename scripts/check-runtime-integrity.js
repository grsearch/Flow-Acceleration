#!/usr/bin/env node
'use strict';

// Read-only deployment check. No server, DB, network, process control, git
// writes or credential output. Run from the deployed checkout before restart:
// node scripts/check-runtime-integrity.js --expected-commit=<approved-commit>
// Exit 0 = verified and no config warnings; 1 = mismatch/warnings; 2 = unknown.
const path = require('path');
const { collectRuntimeIntegrity } = require('../src/runtime/RuntimeIntegrity');

function main(args = process.argv.slice(2)) {
  let expectedCommit = null;
  let gitBinary = 'git';
  for (const arg of args) {
    if (/^--expected-commit=[a-f0-9]{7,64}$/i.test(arg)) expectedCommit = arg.slice('--expected-commit='.length);
    else if (arg.startsWith('--git=')) gitBinary = arg.slice('--git='.length);
    else throw new Error('Usage: node scripts/check-runtime-integrity.js [--expected-commit=<hash>] [--git=<executable>]');
  }
  // The config module may consume the deployment environment, but only a
  // fixed field allowlist is returned; never serialize the full config.
  let runtimeConfig = null;
  try { runtimeConfig = require('../src/config').config; } catch (_) { /* Diagnostic remains usable. */ }
  const result = collectRuntimeIntegrity({
    projectDir: path.resolve(__dirname, '..'), runtimeConfig, expectedCommit, gitBinary,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'UNKNOWN' ? 2
    : result.status === 'MISMATCH' || result.warnings.length > 0 ? 1 : 0;
  return result;
}

if (require.main === module) {
  try { main(); } catch (_) {
    process.stderr.write('Runtime integrity check failed; check the documented arguments and executable availability.\n');
    process.exitCode = 2;
  }
}

module.exports = { main };
