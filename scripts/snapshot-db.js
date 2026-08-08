'use strict';

require('dotenv').config();
const path = require('path');
const { config } = require('../src/config');
const { createResearchSnapshot, snapshotName } = require('../src/data/ResearchSnapshot');

function args(argv) {
  const values = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const [key, raw = 'true'] = item.slice(2).split('=', 2);
    values[key] = raw;
  }
  return values;
}

async function main() {
  const input = args(process.argv.slice(2));
  const source = input.db || config.storage.dbPath;
  const destination = input.out || path.join('data', 'snapshots', snapshotName());
  const result = await createResearchSnapshot(source, destination);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[Snapshot] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { args, main };
