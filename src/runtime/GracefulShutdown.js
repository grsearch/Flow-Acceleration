'use strict';

// A failed stage is retried on a later stop request; completed stages never run
// twice. Concurrent signals share one promise, so a second signal cannot exit
// the process while the first is still saving data.
class GracefulShutdown {
  constructor(stages, { onProgress = () => {}, progressMs = 5000 } = {}) {
    this.stages = stages;
    this.onProgress = onProgress;
    this.progressMs = progressMs;
    this.next = 0;
    this.pending = null;
    this.lastReportAt = 0;
    this.lastReportKey = null;
    this.state = { status: 'IDLE', stage: null, startedAt: null, updatedAt: null, errorCode: null };
  }

  report(details = {}) {
    Object.assign(this.state, details, { updatedAt: Date.now() });
    const key = `${this.state.status}:${this.state.stage}`;
    if (key === this.lastReportKey && Date.now() - this.lastReportAt < this.progressMs) return;
    this.lastReportKey = key;
    this.lastReportAt = Date.now();
    // Logging/telemetry must not make a completed write stage look incomplete.
    try { this.onProgress({ ...this.state }); } catch (_) { /* best effort */ }
  }

  stop(reason = 'shutdown') {
    if (this.pending) return this.pending;
    if (this.state.status === 'STOPPED') return Promise.resolve(this.state);
    this.report({ status: 'STOPPING', reason, errorCode: null,
      startedAt: this.state.startedAt || Date.now() });
    this.pending = Promise.resolve().then(async () => {
      const timer = setInterval(() => this.report(), this.progressMs);
      try {
        while (this.next < this.stages.length) {
          const [stage, task] = this.stages[this.next];
          this.report({ stage });
          await task((details) => this.report(details));
          this.next += 1;
        }
        this.report({ status: 'STOPPED', stage: 'COMPLETE' });
        return this.state;
      } catch (error) {
        this.report({ status: 'STOP_FAILED', errorCode: /^[A-Z0-9_]{1,80}$/.test(error?.code || '')
          ? error.code : 'SHUTDOWN_STAGE_FAILED' });
        throw error;
      } finally {
        clearInterval(timer);
        this.pending = null;
      }
    });
    return this.pending;
  }
}

function createSignalShutdown({ stop, exit, log = () => {}, hold = () => setInterval(() => {}, 1000),
  release = clearInterval }) {
  let pending = null;
  let exited = false;
  let keepAlive = null;
  return function request(signal) {
    if (exited) return Promise.resolve();
    if (pending) return pending;
    // Keep the process alive even if all producers/timers have already stopped.
    if (!keepAlive) keepAlive = hold();
    pending = Promise.resolve().then(() => stop(signal)).then(() => {
      exited = true;
      release(keepAlive);
      keepAlive = null;
      exit(0);
    }, () => {
      // Never exit(1) here: a supervisor restart would discard unwritten memory.
      // A later SIGTERM can retry after the operator resolves the underlying IO.
      log('[Shutdown] STOP_FAILED: process retained; do not force-kill or start another writer. Resolve the cause, then retry SIGTERM.');
    }).finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { GracefulShutdown, createSignalShutdown };
