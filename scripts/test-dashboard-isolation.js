'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Worker } = require('node:worker_threads');
const { DashboardReadModel, initializeDatabase } = require('../src/data/DashboardReadModel');
const { RotatingReadSource, nextRefreshDelay } = require('../src/data/dashboard-preaggregate-worker');
const { shanghaiDay } = require('../src/data/RawTradeShardManager');
const { config } = require('../src/config');
const { createReadStore, createSnapshotTasks, EXTRA_SHADOWS } = require('../src/data/dashboard-snapshot-tasks');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testMemoryAndRecovery() {
  let now = 10000;
  const created = [];
  let alive = 0;
  let peakAlive = 0;
  class FakeWorker extends EventEmitter {
    constructor(lane) { super(); this.lane = lane; this.alive = true; alive += 1;
      peakAlive = Math.max(peakAlive, alive); }
    async terminate() {
      await delay(3);
      if (this.alive) { this.alive = false; alive -= 1; }
      this.emit('exit', 1);
    }
    postMessage(message) {
      if (message.type === 'STOP') {
        if (this.alive) { this.alive = false; alive -= 1; }
        this.emit('message', { type: 'STOPPED' });
      }
    }
  }
  // Nonexistent DB paths prove construction, read and health perform no I/O.
  const model = new DashboardReadModel({ storage: { dbPath: '/never-open/research.db' },
    config: { dbPath: '/never-open/dashboard.db', maxSnapshotAgeMs: 100,
      workerTimeoutMs: 1000, restartBaseMs: 5, restartMaxMs: 10 }, now: () => now,
    workerFactory(_file, options) { const worker = new FakeWorker(options.workerData.lane);
      assert.equal(options.resourceLimits.maxOldGenerationSizeMb,
        options.workerData.lane === 'FAST' ? 128 : 256);
      created.push(worker); return worker; } });
  assert.equal(model.read('live-trading:a'), null);
  assert.equal(model.health().snapshots, 0);
  model.start();
  assert.deepEqual(created.map((w) => w.lane), ['FAST', 'HISTORY']);
  const [fast, history] = created;
  history.emit('message', { type: 'TASK_START', key: 'shadow:slow' });
  const publish = (worker, key, extra = {}) => worker.emit('message', {
    type: 'SNAPSHOT', key, value: { key, count: 1 }, generatedAt: now,
    durationMs: 3, tier: worker.lane === 'FAST' ? 'FAST' : 'SHADOW', ...extra });
  publish(fast, 'live-trading:a');
  assert.equal(model.read('live-trading:a').status, 'READY', 'hung history never gates FAST publication');
  publish(history, 'shadow:old', { generatedAt: now - 1000, hydrated: true });
  assert.equal(model.read('shadow:old').status, 'STALE', 'old snapshots retain their actual generation time');
  history.emit('message', { type: 'KEY_ERROR', key: 'shadow:old', tier: 'SHADOW', error: 'fixture failure' });
  assert.equal(model.read('shadow:old').status, 'ERROR');
  assert.equal(model.read('shadow:old').value.count, 1, 'failed refresh preserves last successful payload');
  history.emit('message', { type: 'KEY_ERROR', key: 'shadow:missing', tier: 'SHADOW', error: 'missing table' });
  assert.equal(model.read('shadow:missing').status, 'ERROR');
  history.emit('message', { type: 'TASK_START', key: 'shadow:hung' });
  now += 1100;
  fast.emit('message', { type: 'HEARTBEAT', stats: {} });
  model._checkWatchdog();
  await delay(25);
  assert.equal(created.length, 3);
  assert.equal(created[2].lane, 'HISTORY');
  assert.equal(peakAlive, 2, 'termination completes before replacement starts');
  publish(fast, 'live-trading:a');
  assert.equal(model.read('live-trading:a').status, 'READY');
  created[2].emit('error', new Error('crash'));
  await model.stop();
  await delay(30);
  assert.equal(created.length, 3, 'shutdown cancels backoff recovery');
  assert.equal(alive, 0);
}

function testMemoryBudgets() {
  const model = new DashboardReadModel({ storage: { dbPath: '/fixture/source.db' },
    config: { dbPath: '/fixture/cache.db', maxMemoryBytes: 5120, maxSnapshotBytes: 3072 } });
  const value = { toJSON() { throw new Error('HTTP owner must not serialize for accounting'); } };
  const add = (key, tier, payloadBytes, generatedAt = 1) => model._cacheSnapshot({
    key, tier, payloadBytes, generatedAt, value, durationMs: 1 });
  assert.equal(add('live-trading:a', 'FAST', 2000), true);
  assert.equal(add('shadow:old', 'SHADOW', 2000), true);
  assert.equal(add('shadow:new', 'SHADOW', 2000, 2), true);
  assert.equal(model.read('shadow:old').error, 'SNAPSHOT_EVICTED_CAPACITY');
  assert.equal(model.memoryBytes, 4000);
  assert.equal(add('live-trading:a', 'FAST', 3000), true);
  assert.equal(model.memoryBytes, 5000, 'same-key replacement deducts old payload');
  assert.equal(add('live-trading:a', 'FAST', 4000), false);
  assert.equal(model.read('live-trading:a').payloadBytes, 3000, 'oversize keeps prior result');
  assert.equal(model.read('live-trading:a').error, 'SNAPSHOT_TOO_LARGE');
  assert.equal(add('live-trading:b', 'FAST', 3000), false);
  assert.equal(model.read('live-trading:b').error, 'SNAPSHOT_MEMORY_CAPACITY');
  assert.ok(model.read('shadow:new').value, 'failed admission must not partially evict good snapshots');
  assert.equal(model.health().memoryBytes, 5000);
}

async function testRealThreadIsolation() {
  const gate = new SharedArrayBuffer(4);
  const model = new DashboardReadModel({ storage: { dbPath: '/fixture/source.db' },
    config: { dbPath: '/fixture/cache.db' }, workerFactory(_file, options) {
      return new Worker(`const {parentPort,workerData}=require('node:worker_threads');
        parentPort.on('message',m=>{if(m.type==='STOP') process.exit(0)});
        if(workerData.lane==='HISTORY') {
          parentPort.postMessage({type:'TASK_START',key:'shadow:blocking',tier:'SHADOW'});
          Atomics.wait(new Int32Array(workerData.gate),0,0,10000);
        } else {
          setInterval(()=>parentPort.postMessage({type:'SNAPSHOT',key:'live-trading:fast',
            tier:'FAST',value:{ok:true},generatedAt:Date.now(),durationMs:0}),10);
        }`, { eval: true, workerData: { ...options.workerData, gate } });
    } });
  try {
    model.start();
    const deadline = Date.now() + 3000;
    while (!model.read('live-trading:fast') && Date.now() < deadline) await delay(10);
    assert.ok(model.read('live-trading:fast'), 'real synchronous history thread cannot delay FAST');
    assert.equal(model.health().workers.length, 2);
  } finally {
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    await model.stop();
  }
}

function testAdaptersAndScheduling() {
  let reads = 0;
  const db = { prepare(sql) {
    assert.match(sql.trim(), /^SELECT\b/i, 'read-only adapter must not initialize or mutate schemas');
    return { all() { reads += 1; return []; }, get() { reads += 1; return {}; } };
  } };
  const store = createReadStore(db, 'fixture');
  const tasks = createSnapshotTasks(store, { lane: 'HISTORY', shadowConfigs: config });
  const extraKeys = new Set(EXTRA_SHADOWS.map(([slug]) => `shadow:${slug}`));
  for (const task of tasks.filter((task) => extraKeys.has(task.key))) {
    assert.ok(task.compute(), `compute ${task.key}`);
  }
  assert.equal(tasks.filter((task) => extraKeys.has(task.key)).length, 16);
  assert.ok(reads > 25);
  const fast = createSnapshotTasks(store, { lane: 'FAST', fastRefreshMs: 1000,
    liveStrategies: [{ id: 'retired', entryEnabled: false }, { id: 'active', entryEnabled: true }] });
  assert.equal(fast[0].key, 'live-trading:active');
  assert.ok(fast[1].intervalMs >= fast[0].intervalMs * 10);
  assert.equal(nextRefreshDelay(1000, 5000), 20000);
  assert.ok(nextRefreshDelay(1000, 1, 4) >= 80000);
}

function testDayRotation() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-dashboard-rotation-'));
  const dbPath = path.join(directory, 'source.db');
  const shardDir = path.join(directory, 'raw');
  fs.mkdirSync(shardDir);
  let now = Date.UTC(2026, 8, 4, 15, 59, 59); // CST 23:59:59
  const sourceDb = new Database(dbPath);
  sourceDb.exec(`CREATE TABLE raw_trades(id INTEGER PRIMARY KEY, timestamp_ms INTEGER);
    CREATE TABLE raw_trade_shard_meta(id INTEGER PRIMARY KEY, enabled_at INTEGER,
      shard_dir TEXT, active_day TEXT)`);
  sourceDb.prepare('INSERT INTO raw_trade_shard_meta VALUES(1,?,?,?)')
    .run(now - 1000, shardDir, shanghaiDay(now));
  sourceDb.close();
  const shard = (at) => {
    const db = new Database(path.join(shardDir, `raw-trades-${shanghaiDay(at)}-CST.db`));
    db.exec('CREATE TABLE raw_trades(id INTEGER PRIMARY KEY, timestamp_ms INTEGER)');
    db.prepare('INSERT INTO raw_trades VALUES(1,?)').run(at);
    db.close();
  };
  shard(now);
  const reader = new RotatingReadSource({ sourceDbPath: dbPath, rawShardReadDays: 3 }, () => now);
  try {
    assert.equal(reader.refresh(), true);
    assert.equal(reader.db.prepare('SELECT COUNT(*) n FROM raw_trades_all').get().n, 1);
    assert.equal(reader.refresh(), false);
    now += 2000;
    // First read at midnight can precede the writer creating that day's shard.
    assert.equal(reader.refresh(), true);
    assert.equal(reader.db.prepare('SELECT COUNT(*) n FROM raw_trades_all').get().n, 1);
    shard(now);
    const writer = new Database(dbPath);
    writer.prepare('UPDATE raw_trade_shard_meta SET active_day=? WHERE id=1').run(shanghaiDay(now));
    writer.close();
    now += 31000;
    assert.equal(reader.refresh(), true);
    assert.equal(reader.db.prepare('SELECT COUNT(*) n FROM raw_trades_all').get().n, 2);
    assert.equal(reader.rotations, 3);
    assert.throws(() => reader.db.exec('DELETE FROM raw_trades'));
  } finally {
    reader.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('flow-dashboard-rotation-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const aliasDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-dashboard-alias-'));
  const source = path.join(aliasDirectory, 'source.db');
  const alias = path.join(aliasDirectory, 'dashboard.db');
  try {
    fs.writeFileSync(source, 'must not be opened as a snapshot database');
    fs.linkSync(source, alias);
    assert.throws(() => initializeDatabase(alias, source), /aliases the realtime database/);
    assert.equal(fs.readFileSync(source, 'utf8'), 'must not be opened as a snapshot database');
  } finally {
    if (fs.existsSync(alias)) fs.unlinkSync(alias);
    if (fs.existsSync(source)) fs.unlinkSync(source);
    fs.rmdirSync(aliasDirectory);
  }
  await testMemoryAndRecovery();
  testMemoryBudgets();
  await testRealThreadIsolation();
  testAdaptersAndScheduling();
  testDayRotation();
  console.log('test-dashboard-isolation: ok (RAM, independent lanes, recovery, stale/error, adapters, rotation)');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
