'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

// One bounded on-demand research lane. A client timeout does not spawn another
// copy of the same job, nor does changing query parameters spawn unlimited workers.
class DashboardQueryRunner {
  constructor(storage, { workerFactory, maxEntries = 8, timeoutMs = 60_000 } = {}) {
    this.storage = storage;
    this.workerFactory = workerFactory || ((data) => new Worker(
      path.join(__dirname, 'dashboard-ad-hoc-worker.js'), { workerData: data,
        resourceLimits: { maxOldGenerationSizeMb: 128 } },
    ));
    this.maxEntries = maxEntries;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
    this.active = null;
    this.stopped = false;
  }

  async query(task, args = {}, { ttlMs = 300_000, firstWaitMs = 500 } = {}) {
    if (!['backtest', 'migrationSecondLegDashboard', 'launchPullbackDashboardBundle'].includes(task)) {
      throw new Error('Unsupported dashboard research task');
    }
    const key = `${task}:${JSON.stringify(args)}`;
    const cached = this.cache.get(key);
    const decorate = (value, status, error = null) => ({
      ...(value || {}), dashboardQuery: { status, generatedAt: cached?.at || null, error },
    });
    if (cached && Date.now() - cached.at < ttlMs) return decorate(cached.value, 'READY');
    if (this.stopped) return decorate(cached?.value, 'ERROR', 'Dashboard is stopping');
    if (this.active && this.active.key !== key) {
      return decorate(cached?.value, cached ? 'STALE' : 'BUSY', 'Research lane occupied; retry later');
    }
    if (!this.active) {
      const worker = this.workerFactory({
        task, args, dbPath: this.storage.dbPath,
        rawShardReadDays: this.storage.rawShardReadDays, cacheSizeKb: 8_192,
      });
      let finish;
      const promise = new Promise((resolve) => { finish = resolve; });
      const active = { key, worker, promise };
      this.active = active;
      let completed = false;
      const done = (result) => {
        if (completed) return;
        completed = true;
        clearTimeout(active.timer);
        if (result.ok) {
          this.cache.delete(key);
          this.cache.set(key, { at: Date.now(), value: result.value });
          while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
        }
        // Native SQLite work may outlive a timeout. Keep the lane occupied until
        // the old thread actually exits, rather than stacking replacement jobs.
        active.completed = true;
        active.termination = Promise.resolve().then(() => worker.terminate()).finally(() => {
          if (this.active === active) this.active = null;
        });
        active.termination.catch(() => {});
        finish(result);
      };
      active.finish = done;
      active.timer = setTimeout(() => done({ ok: false, error: 'Research time budget exceeded' }), this.timeoutMs);
      active.timer.unref?.();
      worker.once('message', done);
      worker.once('error', () => done({ ok: false, error: 'Research worker failed' }));
      worker.once('exit', () => done({ ok: false, error: 'Research worker exited without a result' }));
    }
    if (cached) return decorate(cached.value, 'STALE');
    const active = this.active;
    let timer;
    const result = await Promise.race([
      active.promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1, firstWaitMs)); }),
    ]);
    clearTimeout(timer);
    if (!result) return decorate(null, 'PREPARING');
    if (!result.ok) return decorate(null, 'ERROR', result.error);
    return { ...result.value, dashboardQuery: { status: 'READY', generatedAt: this.cache.get(key)?.at } };
  }

  async stop() {
    this.stopped = true;
    const active = this.active;
    if (active) {
      active.finish({ ok: false, error: 'Dashboard stopped' });
      await active.termination;
    }
    this.cache.clear();
  }
}

module.exports = { DashboardQueryRunner };
