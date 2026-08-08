'use strict';

const EventEmitter = require('events');
const { extractSignature } = require('./PumpEventParser');

let yellowstoneRuntime = null;

function loadYellowstone() {
  if (yellowstoneRuntime) return yellowstoneRuntime;
  let yellowstone;
  try {
    yellowstone = require('@triton-one/yellowstone-grpc');
  } catch (error) {
    if (process.platform === 'win32' && /native binding/i.test(error.message)) {
      throw new Error(
        'Yellowstone gRPC v5 does not ship a Windows native binding; run the realtime collector on Linux/WSL2',
        { cause: error },
      );
    }
    throw error;
  }
  yellowstoneRuntime = {
    Client: yellowstone.default,
    CommitmentLevel: yellowstone.CommitmentLevel,
    SubscribeRequest: yellowstone.SubscribeRequest,
    SubscribeRequestFilterTransactions: yellowstone.SubscribeRequestFilterTransactions,
  };
  return yellowstoneRuntime;
}

function transactionFilter(value) {
  const { SubscribeRequestFilterTransactions } = loadYellowstone();
  return SubscribeRequestFilterTransactions?.create
    ? SubscribeRequestFilterTransactions.create(value)
    : value;
}

function subscribeRequest(value) {
  const { SubscribeRequest } = loadYellowstone();
  return SubscribeRequest?.create ? SubscribeRequest.create(value) : value;
}

class RegionConnection {
  constructor({ endpoint, token, label, programs, onTransaction, onState, onError, onUnavailable }) {
    this.endpoint = endpoint;
    this.token = token;
    this.label = label;
    this.programs = programs;
    this.onTransaction = onTransaction;
    this.onState = onState;
    this.onError = onError;
    this.onUnavailable = onUnavailable;

    this.client = null;
    this.stream = null;
    this.running = false;
    this.connected = false;
    this.ammMints = new Set();
    this.unavailableNotified = false;
    this.lastMessageAt = null;
    this.connectedAt = null;
  }

  async start() {
    this.running = true;
    this.unavailableNotified = false;
    return this._connect();
  }

  async stop() {
    this.running = false;
    await this._close();
  }

  async setAmmMints(mints) {
    this.ammMints = new Set(mints);
    if (!this.connected || !this.stream) return;
    try {
      await this._sendSubscription();
    } catch (error) {
      this._notifyUnavailable(error, 'update_subscription');
    }
  }

  markStale(staleForMs) {
    this._notifyUnavailable(
      new Error(`no transactions received for ${staleForMs}ms`),
      'stale',
    );
  }

  async _connect() {
    if (!this.running) return;
    await this._close();
    try {
      this.onState(this.label, { state: 'connecting' });
      const { Client } = loadYellowstone();
      this.client = new Client(this.endpoint, this.token, {
        'grpc.max_receive_message_length': 64 * 1024 * 1024,
        'grpc.keepalive_time_ms': 30_000,
        'grpc.keepalive_timeout_ms': 5_000,
        'grpc.keepalive_permit_without_calls': 1,
        'grpc.http2.max_pings_without_data': 0,
      });
      if (typeof this.client.connect === 'function') await this.client.connect();
      this.stream = await this.client.subscribe();
      this.stream.on('data', (message) => this._handleMessage(message));
      this.stream.on('error', (error) => this._handleEnd(error));
      this.stream.on('end', () => this._handleEnd(new Error('stream ended')));
      this.stream.on('close', () => this._handleEnd(new Error('stream closed')));
      await this._sendSubscription();
      this.connected = true;
      this.connectedAt = Date.now();
      this.unavailableNotified = false;
      this.onState(this.label, {
        state: 'connected',
        connectedAt: this.connectedAt,
        ammMintCount: this.ammMints.size,
      });
      return true;
    } catch (error) {
      this._notifyUnavailable(error, 'connect');
      return false;
    }
  }

  async _sendSubscription() {
    if (!this.stream) return;
    const transactions = {
      pumpBondingCurve: transactionFilter({
        vote: false,
        failed: false,
        accountInclude: [this.programs.pump],
        accountExclude: [],
        accountRequired: [],
      }),
    };

    const ammMints = [...this.ammMints];
    if (ammMints.length > 0) {
      transactions.pumpAmmLabels = transactionFilter({
        vote: false,
        failed: false,
        accountInclude: ammMints,
        accountExclude: [],
        accountRequired: [this.programs.amm],
      });
    }

    const { CommitmentLevel } = loadYellowstone();
    const request = subscribeRequest({
      transactions,
      accounts: {},
      slots: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      transactionsStatus: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.PROCESSED,
    });

    await new Promise((resolve, reject) => {
      this.stream.write(request, (error) => (error ? reject(error) : resolve()));
    });
    this.onState(this.label, { ammMintCount: ammMints.length });
  }

  _handleMessage(message) {
    if (!message?.transaction) return;
    this.lastMessageAt = Date.now();
    this.onState(this.label, { lastMessageAt: this.lastMessageAt });
    this.onTransaction(message.transaction, this.label, this.lastMessageAt);
  }

  _handleEnd(error) {
    this._notifyUnavailable(error, 'stream');
  }

  _notifyUnavailable(error, phase) {
    if (!this.running || this.unavailableNotified) return;
    this.unavailableNotified = true;
    this.connected = false;
    this.onError(error, this.label, phase);
    this.onUnavailable(this, error, phase);
  }

  async _close() {
    this.connected = false;
    if (this.stream) {
      try { this.stream.removeAllListeners(); } catch (_) {}
      try { this.stream.destroy(); } catch (_) {}
      this.stream = null;
    }
    if (this.client) {
      try {
        if (typeof this.client.close === 'function') this.client.close();
        else if (this.client._connectedGrpcClient) this.client._connectedGrpcClient.close();
      } catch (_) {}
      this.client = null;
    }
  }
}

class PumpFlowStream extends EventEmitter {
  constructor({ config, tokenForEndpoint, connectionFactory }) {
    super();
    this.config = config;
    this.tokenForEndpoint = tokenForEndpoint;
    this.connectionFactory = connectionFactory || ((options) => new RegionConnection(options));
    this.connection = null;
    this.activeEndpointIndex = -1;
    this.running = false;
    this.failoverAttempts = 0;
    this.failoverTimer = null;
    this.watchdogTimer = null;
    this.states = new Map();
    this.seenSignatures = new Map();
    this.ammMints = new Set();
    this.updateTimer = null;
    this.metrics = {
      transactionsReceived: 0,
      duplicatesDropped: 0,
      errors: 0,
      failovers: 0,
      staleFailovers: 0,
      lastTransactionAt: null,
    };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.config.stream.endpoints.forEach((endpoint, index) => {
      const label = this._labelFor(index);
      this.states.set(label, {
        endpoint,
        configuredRole: index === 0 ? 'primary' : 'standby',
        active: false,
        state: 'standby',
      });
    });
    this._startWatchdog();
    await this._activateEndpoint(0, 'startup');
  }

  async stop() {
    this.running = false;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    if (this.failoverTimer) clearTimeout(this.failoverTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.updateTimer = null;
    this.failoverTimer = null;
    this.watchdogTimer = null;
    const connection = this.connection;
    this.connection = null;
    if (connection) await connection.stop();
    if (this.activeEndpointIndex >= 0) {
      this._updateState(this._labelFor(this.activeEndpointIndex), { active: false, state: 'stopped' });
    }
    this.activeEndpointIndex = -1;
  }

  setAmmMints(mints) {
    const next = new Set(mints);
    if (next.size === this.ammMints.size && [...next].every((mint) => this.ammMints.has(mint))) return;
    this.ammMints = next;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      const connection = this.connection;
      if (!connection) return;
      connection.setAmmMints(this.ammMints).catch((error) => {
        this._handleError(error, connection.label, 'set_amm_mints');
      });
    }, 100);
  }

  health() {
    const activeEndpoint = this.activeEndpointIndex >= 0
      ? this.config.stream.endpoints[this.activeEndpointIndex]
      : null;
    return {
      ...this.metrics,
      mode: 'active-passive',
      activeEndpoint,
      activeLabel: this.activeEndpointIndex >= 0 ? this._labelFor(this.activeEndpointIndex) : null,
      dedupSize: this.seenSignatures.size,
      ammMintCount: this.ammMints.size,
      regions: this.config.stream.endpoints.map((_endpoint, index) => {
        const label = this._labelFor(index);
        return { label, ...(this.states.get(label) || {}) };
      }),
    };
  }

  async _activateEndpoint(index, reason) {
    if (!this.running || this.config.stream.endpoints.length === 0) return;
    const normalizedIndex = index % this.config.stream.endpoints.length;
    const previousIndex = this.activeEndpointIndex;
    const previousConnection = this.connection;

    this.connection = null;
    if (previousConnection) await previousConnection.stop();
    if (!this.running) return;

    if (previousIndex >= 0) {
      this._updateState(this._labelFor(previousIndex), { active: false, state: 'standby' });
    }
    if (reason !== 'startup' && previousIndex >= 0 && previousIndex !== normalizedIndex) {
      this.metrics.failovers += 1;
    }

    this.activeEndpointIndex = normalizedIndex;
    const endpoint = this.config.stream.endpoints[normalizedIndex];
    const label = this._labelFor(normalizedIndex);
    const connection = this.connectionFactory({
      endpoint,
      token: this.tokenForEndpoint(endpoint),
      label,
      programs: {
        pump: this.config.pump.programId,
        amm: this.config.pump.ammProgramId,
      },
      onTransaction: (transaction, region, receivedAt) => {
        this._handleTransaction(transaction, region, receivedAt);
      },
      onState: (region, patch) => this._updateState(region, patch),
      onError: (error, region, phase) => this._handleError(error, region, phase),
      onUnavailable: (failedConnection, error, phase) => {
        this._scheduleFailover(failedConnection, error, phase);
      },
    });
    this.connection = connection;
    this._updateState(label, {
      active: true,
      state: 'connecting',
      activatedAt: Date.now(),
      activationReason: reason,
    });
    await connection.setAmmMints(this.ammMints);
    const connected = await connection.start();
    if (connected && this.connection === connection) this.failoverAttempts = 0;
  }

  _scheduleFailover(connection, _error, phase) {
    if (!this.running || connection !== this.connection || this.failoverTimer) return;
    this.failoverAttempts += 1;
    if (phase === 'stale') this.metrics.staleFailovers += 1;
    const delay = Math.min(
      this.config.stream.reconnectMaxMs,
      this.config.stream.reconnectMinMs * (2 ** Math.min(this.failoverAttempts - 1, 8)),
    );
    const nextIndex = this.config.stream.endpoints.length > 1
      ? (this.activeEndpointIndex + 1) % this.config.stream.endpoints.length
      : this.activeEndpointIndex;
    const label = this._labelFor(this.activeEndpointIndex);
    this._updateState(label, {
      state: 'reconnecting',
      reconnectInMs: delay,
      nextLabel: this._labelFor(nextIndex),
    });
    this.failoverTimer = setTimeout(() => {
      this.failoverTimer = null;
      this._activateEndpoint(nextIndex, phase).catch((error) => {
        this._handleError(error, this._labelFor(nextIndex), 'failover');
      });
    }, delay);
    if (this.failoverTimer.unref) this.failoverTimer.unref();
  }

  _startWatchdog() {
    const staleTimeoutMs = this.config.stream.staleTimeoutMs;
    const staleCheckMs = this.config.stream.staleCheckMs;
    if (!Number.isFinite(staleTimeoutMs) || staleTimeoutMs <= 0) return;
    this.watchdogTimer = setInterval(() => {
      const connection = this.connection;
      if (!this.running || !connection?.connected) return;
      const lastActivityAt = connection.lastMessageAt || connection.connectedAt;
      if (!lastActivityAt) return;
      const staleForMs = Date.now() - lastActivityAt;
      if (staleForMs >= staleTimeoutMs) connection.markStale(staleForMs);
    }, staleCheckMs);
    if (this.watchdogTimer.unref) this.watchdogTimer.unref();
  }

  _labelFor(index) {
    return `FLOW-${index + 1}`;
  }

  _handleTransaction(transaction, region, receivedAt) {
    const signature = extractSignature(transaction);
    if (signature && !this._firstSignature(signature, receivedAt)) {
      this.metrics.duplicatesDropped += 1;
      return;
    }
    this.metrics.transactionsReceived += 1;
    this.metrics.lastTransactionAt = receivedAt;
    this.emit('transaction', transaction, { region, receivedAt });
  }

  _firstSignature(signature, now) {
    const expiresAt = this.seenSignatures.get(signature);
    if (expiresAt && expiresAt > now) return false;
    this.seenSignatures.set(signature, now + this.config.stream.dedupTtlMs);
    if (this.seenSignatures.size > this.config.stream.dedupMax) {
      for (const [key, expiry] of this.seenSignatures) {
        if (expiry <= now || this.seenSignatures.size > this.config.stream.dedupMax * 0.9) {
          this.seenSignatures.delete(key);
        }
        if (this.seenSignatures.size <= this.config.stream.dedupMax * 0.9) break;
      }
    }
    return true;
  }

  _updateState(label, patch) {
    this.states.set(label, { ...(this.states.get(label) || {}), ...patch });
    this.emit('state', this.health());
  }

  _handleError(error, label, phase) {
    this.metrics.errors += 1;
    this._updateState(label, {
      state: 'error',
      lastErrorAt: Date.now(),
      lastError: `${phase}: ${error?.message || error}`,
    });
    this.emit('streamError', { label, phase, error });
  }
}

module.exports = PumpFlowStream;
