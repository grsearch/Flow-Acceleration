'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const coreDir = path.join(root, 'src', 'core');
const coreFiles = fs.readdirSync(coreDir).filter((name) => name.endsWith('.js'));

for (const file of coreFiles) {
  const source = fs.readFileSync(path.join(coreDir, file), 'utf8');
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/status:\s*(?:STATUS\.)?NO_EXIT|status:\s*['"]NO_EXIT['"]/.test(lines[index])) continue;
    const outcomePatch = lines.slice(index, index + 14).join('\n');
    const assignedReturns = [...outcomePatch.matchAll(
      /(?:grossReturnPct|netReturnPct):\s*([^,}\n]+)/g,
    )].map((match) => match[1].trim());
    assert.ok(
      assignedReturns.every((value) => value === 'null'),
      `${file}:${index + 1} must keep NO_EXIT censored instead of assigning a return`,
    );
  }
}

const storeSource = fs.readFileSync(path.join(root, 'src', 'data', 'ResearchStore.js'), 'utf8');
const noExitReturnAggregate =
  /status IN \(\s*'CLOSED'\s*,\s*'NO_EXIT'\s*\)[\s\S]{0,600}(?:AVG|SUM|TOTAL)\(\s*net_return_pct\s*\)|(?:AVG|SUM|TOTAL)\(\s*net_return_pct\s*\)[\s\S]{0,600}status IN \(\s*'CLOSED'\s*,\s*'NO_EXIT'\s*\)/i;
assert.doesNotMatch(
  storeSource,
  noExitReturnAggregate,
  'ResearchStore must never include NO_EXIT in realized-return aggregates',
);
assert.doesNotMatch(
  storeSource,
  /status IN \(\s*'CLOSED'\s*,\s*'EXIT_FAILED'\s*\)/i,
  'EXIT_FAILED must remain unresolved and excluded from realized returns',
);

const cobSource = fs.readFileSync(
  path.join(coreDir, 'CyaOrganicBurstShadowSuite.js'),
  'utf8',
);
assert.match(
  cobSource,
  /String\(trade\.market \|\| ''\) === String\(position\.entryMarket\)/,
  'COB exits must use the exact same market as their simulated entry',
);
assert.match(
  cobSource,
  /status='CLOSED' AND entry_market=exit_market/,
  'COB dashboard must price only same-market CLOSED outcomes',
);

console.log('shadow outcome accounting tests: PASS');
