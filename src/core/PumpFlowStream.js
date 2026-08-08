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
  constructor({ endpoint, token, label, programs, reconnect, onTransaction, onState, onError }) {
    this.endpoint = endpoint;
    this.token = token;
    this.label = label;
    this.programs = programs;
    this.reconnect = reconnect;
    this.onTransaction = onTransaction;
    this.onState = onState;
    this.onError = onError;

    this.client = null;
    this.stream = null;
    this.running = false;
    this.connected = false;
    this.ammMints = new Set();
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.reconnectScheduled = false;
    this.lastMessageAt = null;
    this.connectedAt = null;
  }

  async start() {
    this.running = true;
    await this._connect();
  }

  async stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectScheduled = false;
    await this._close();
  }

  async setAmmMints(mints) {
    this.ammMints = new Set(mints);
    if (!this.connected || !this.stream) return;
    try {
      await this._sendSubscription();
    } catch (error) {
      this.onError(error, this.label, 'update_subscription');
      this._scheduleReconnect();
    }
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
      this.reconnectAttempts = 0;
      this.reconnectScheduled = false;
      this.onState(this.label, {
        state: 'connected',
        connectedAt: this.connectedAt,
        ammMintCount: this.ammMints.size,
      });
    } catch (error) {
      this.onError(error, this.label, 'connect');
      this._scheduleReconnect();
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
    if (!this.running || this.reconnectScheduled) return;
    this.connected = false;
    this.onError(error, this.label, 'stream');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.running || this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    this.connected = false;
    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.reconnect.maxMs,
      this.reconnect.minMs * (2 ** Math.min(this.reconnectAttempts - 1, 8)),
    );
    this.onState(this.label, { state: 'reconnecting', reconnectInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectScheduled = false;
      this._connect().catch((error) => this.onError(error, this.label, 'reconnect'));
    }, delay);
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
  constructor({ config, tokenForEndpoint }) {
    super();
    this.config = config;
    this.tokenForEndpoint = tokenForEndpoint;
    this.connections = [];
    this.states = new Map();
    this.seenSignatures = new Map();
    this.ammMints = new Set();
    this.updateTimer = null;
    this.metrics = {
      transactionsReceived: 0,
      duplicatesDropped: 0,
      errors: 0,
      lastTransactionAt: null,
    };
  }

  async start() {
    const programs = {
      pump: this.config.pump.programId,
      amm: this.config.pump.ammProgramId,
    };
    this.connections = this.config.stream.endpoints.map((endpoint, index) => new RegionConnection({
      endpoint,
      token: this.tokenForEndpoint(endpoint),
      label: `FLOW-${index + 1}`,
      programs,
      reconnect: {
        minMs: this.config.stream.reconnectMinMs,
        maxMs: this.config.stream.reconnectMaxMs,
      },
      onTransaction: (transaction, label, receivedAt) => this._handleTransaction(transaction, label, receivedAt),
      onState: (label, patch) => this._updateState(label, patch),
      onError: (error, label, phase) => this._handleError(error, label, phase),
    }));

    await Promise.all(this.connections.map((connection) => connection.start()));
  }

  async stop() {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = null;
    await Promise.all(this.connections.map((connection) => connection.stop()));
    this.connections = [];
  }

  setAmmMints(mints) {
    const next = new Set(mints);
    if (next.size === this.ammMints.size && [...next].every((mint) => this.ammMints.has(mint))) return;
    this.ammMints = next;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      for (const connection of this.connections) {
        connection.setAmmMints(this.ammMints).catch((error) => {
          this._handleError(error, connection.label, 'set_amm_mints');
        });
      }
    }, 100);
  }

  health() {
    return {
      ...this.metrics,
      dedupSize: this.seenSignatures.size,
      ammMintCount: this.ammMints.size,
      regions: [...this.states.entries()].map(([label, state]) => ({ label, ...state })),
    };
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
