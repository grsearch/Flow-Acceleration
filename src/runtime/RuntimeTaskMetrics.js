'use strict';

// Synchronous callback timings only. Async worker elapsed time is reported by
// the worker owner, not misrepresented as time spent on the main event loop.
class RuntimeTaskMetrics {
  constructor({ now = Date.now, monotonic = () => process.hrtime.bigint(),
    onSlow = () => {}, maxTasks = 256, maxSlow = 32, logIntervalMs = 30_000 } = {}) {
    Object.assign(this, { now, monotonic, onSlow, maxTasks, maxSlow, logIntervalMs });
    this.tasks = new Map();
    this.recentSlow = [];
    this.untrackedNames = 0;
    this.logErrors = 0;
  }

  run(name, callback, thresholdMs = 100) {
    const key = String(name).slice(0, 120);
    const startedAt = this.now();
    const tick = this.monotonic();
    let failed = false;
    try { return callback(); }
    catch (error) { failed = true; throw error; }
    finally {
      const durationMs = Number(this.monotonic() - tick) / 1e6;
      const finishedAt = this.now();
      let entry = this.tasks.get(key);
      if (!entry && this.tasks.size < this.maxTasks) {
        entry = { calls: 0, failures: 0, slowCalls: 0, totalMs: 0, maxMs: 0,
          lastMs: 0, lastStartedAt: null, lastFinishedAt: null, lastLoggedAt: null };
        this.tasks.set(key, entry);
      }
      if (!entry) this.untrackedNames += 1;
      else {
        entry.calls += 1;
        entry.failures += Number(failed);
        entry.totalMs += durationMs;
        entry.maxMs = Math.max(entry.maxMs, durationMs);
        entry.lastMs = durationMs;
        entry.lastStartedAt = startedAt;
        entry.lastFinishedAt = finishedAt;
        if (durationMs >= thresholdMs) {
          entry.slowCalls += 1;
          const row = { name: key, startedAt, finishedAt, durationMs, failed };
          this.recentSlow.push(row);
          if (this.recentSlow.length > this.maxSlow) this.recentSlow.shift();
          if (entry.lastLoggedAt == null || finishedAt - entry.lastLoggedAt >= this.logIntervalMs) {
            entry.lastLoggedAt = finishedAt;
            try { this.onSlow(row); } catch (_) { this.logErrors += 1; }
          }
        }
      }
    }
  }

  health() {
    return { scope: 'SYNCHRONOUS_CALLBACK_ONLY', untrackedNames: this.untrackedNames,
      logErrors: this.logErrors,
      tasks: Object.fromEntries([...this.tasks].map(([key, value]) => [key, { ...value }])),
      recentSlow: this.recentSlow.map((row) => ({ ...row })) };
  }
}

module.exports = { RuntimeTaskMetrics };
