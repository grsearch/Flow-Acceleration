'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');

function sanitize(value, key = '') {
  if (/private.?key|secret|password|credential|authorization|api.?key|access.?token|rpc.?url|helius.?token|allen.?hark.?token/i.test(key)) return undefined;
  if (typeof value === 'function' || value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    // Error messages may embed a full credential-bearing provider URL.
    return value.replace(/(?:https?|wss?|grpc):\/\/[^\s"'<>]+/gi, (match) => {
      try { return new URL(match).origin; } catch (_) { return '[provider]'; }
    });
  }
  if (Array.isArray(value)) return value.map((row) => sanitize(row));
  if (value instanceof Set) return [...value].map((row) => sanitize(row));
  const output = {};
  for (const [name, child] of Object.entries(value)) {
    const clean = sanitize(child, name);
    if (clean !== undefined) output[name] = clean;
  }
  return output;
}

function dashboardConfig(config) {
  // Do not send RPC clients, stream credentials, signing configuration or env
  // into the read-only child. It needs strategy definitions, not executors.
  const keys = new Set(['dashboardCache', 'storage', 'smartWallets', 'labels', 'strategy', 'backtest',
    'smartWalletRegistry', 'smartWalletConsensusOverlay', 'featureEdgeAudit']);
  const selected = Object.fromEntries(Object.entries(config)
    .filter(([key]) => keys.has(key) || /Shadow|Shadows|Observer/.test(key)));
  selected.server = { host: config.server?.host, port: config.server?.port };
  selected.liveTrading = { strategies: config.liveTrading?.strategies || [],
    enabled: config.liveTrading?.enabled, dryRun: config.liveTrading?.dryRun };
  return sanitize(selected);
}

function childEnvironment() {
  const result = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'TZ']) {
    if (process.env[key] != null) result[key] = process.env[key];
  }
  return result;
}

function collectRuntime(options) {
  const sections = {};
  const errors = [];
  for (const [key, component] of Object.entries(options)) {
    if (['config', 'runtimeIdentity', 'store'].includes(key) || !component) continue;
    const method = ['engine', 'labeler'].includes(key) ? 'stats' : 'health';
    if (typeof component[method] !== 'function') continue;
    try { sections[key] = component[method]({ includeDatabase: false }); }
    catch (_) { errors.push(key); }
  }
  let database = {};
  try { database = options.store.healthSnapshot(); } catch (_) { errors.push('database'); }
  let maintenance = null;
  try { maintenance = options.smartWalletRegistry?.maintenanceHealth?.() || null; } catch (_) {}
  return sanitize({ at: Date.now(), sections, database, maintenance, errors });
}

class DashboardProcessServer {
  constructor(options, { forkFactory } = {}) {
    this.options = options;
    this.config = options.config;
    this.child = null;
    this.timer = null;
    this.restartTimer = null;
    this.stopping = false;
    this.sending = false;
    this.restarts = 0;
    this.forkFactory = forkFactory || fork;
    this.lastError = null;
    this.port = null;
  }

  async start() {
    if (this.child) return;
    this.stopping = false;
    await this._launch();
    if (!this.timer) {
      this.timer = setInterval(() => this.publish(), Math.max(1000,
        Number(this.config.dashboardCache?.runtimeRefreshMs) || 5000));
      this.timer.unref?.();
    }
  }

  _launch() {
    const child = this.forkFactory(path.join(__dirname, 'dashboard-child.js'), [], {
      env: childEnvironment(), windowsHide: true,
      execArgv: [`--max-old-space-size=${Math.max(128, Number(this.config.dashboardCache?.httpHeapMb) || 256)}`],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.child = child;
    this.sending = false;
    return new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        if (ready) return;
        reject(new Error('Independent Dashboard did not start within 20 seconds'));
        child.kill('SIGKILL');
      }, 20_000);
      child.on('message', (message) => {
        if (message?.type === 'READY') {
          ready = true;
          clearTimeout(timeout);
          this.port = message.port;
          this.lastError = null;
          resolve();
        }
        if (message?.type === 'ERROR') {
          this.lastError = message.error;
          if (!ready) { clearTimeout(timeout); reject(new Error(message.error)); child.kill('SIGKILL'); }
        }
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        this.lastError = error.message;
        if (!ready) reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        if (this.child === child) this.child = null;
        if (!ready) reject(new Error(`Independent Dashboard exited (${code}) before readiness`));
        if (this.stopping || !ready) return;
        this._scheduleRestart();
      });
      child.send({ type: 'INIT', config: dashboardConfig(this.config),
        runtimeIdentity: sanitize(this.options.runtimeIdentity), snapshot: collectRuntime(this.options) });
    });
  }

  _scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.restarts++, 5));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      void Promise.resolve().then(() => this._launch()).catch((error) => {
        this.lastError = error.message;
        this._scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  publish() {
    const child = this.child;
    if (!child?.connected || this.sending || this.stopping) return;
    this.sending = true;
    try {
      child.send({ type: 'RUNTIME', snapshot: collectRuntime(this.options) }, () => { this.sending = false; });
    } catch (_) { this.sending = false; }
  }

  health() {
    return { mode: 'INDEPENDENT_HTTP_PROCESS', pid: this.child?.pid || null,
      restarts: this.restarts, lastError: this.lastError };
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    clearTimeout(this.restartTimer);
    this.timer = null;
    this.restartTimer = null;
    const child = this.child;
    if (!child) return;
    await new Promise((resolve, reject) => {
      let confirmation;
      const timeout = setTimeout(() => {
        // SIGTERM is already handled by the child and cannot interrupt native
        // SQLite work. Do not report a clean stop until the process really exits.
        child.kill('SIGKILL');
        confirmation = setTimeout(() => reject(new Error('Dashboard child exit was not confirmed')), 2000);
      }, 5000);
      child.once('exit', () => { clearTimeout(timeout); clearTimeout(confirmation); resolve(); });
      if (child.exitCode != null || child.signalCode != null) { clearTimeout(timeout); resolve(); return; }
      if (child.connected) child.send({ type: 'STOP' }, (error) => { if (error) child.kill('SIGKILL'); });
      else child.kill('SIGKILL');
    });
    this.child = null;
  }
}

module.exports = { DashboardProcessServer, collectRuntime, sanitize, dashboardConfig, childEnvironment };
