'use strict';

const { FlowFirstShadowManager } = require('./FlowFirstShadowManager');

class FlowFirstShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.managers = new Map();
    for (const cohort of config.cohorts || []) {
      this.managers.set(cohort.id, new FlowFirstShadowManager({
        config: {
          ...config,
          ...cohort,
          cohortId: cohort.id,
          cohortLabel: cohort.label,
          cohorts: undefined,
        },
        store,
        now,
      }));
    }
  }

  start() {
    for (const manager of this.managers.values()) manager.start();
  }

  stop() {
    for (const manager of this.managers.values()) manager.stop();
  }

  onSignal(signal) {
    const sharedActive = signal?.mint
      && [...this.managers.values()].some((manager) => manager.hasActiveMint(signal.mint));
    const sharedSignal = sharedActive
      ? { ...signal, flowFirstSharedRejection: 'COHORT_MINT_ALREADY_ACTIVE' }
      : signal;
    return [...this.managers.values()].map((manager) => manager.onSignal(sharedSignal));
  }

  observeTrade(trade) {
    for (const manager of this.managers.values()) manager.observeTrade(trade);
  }

  advanceTime(now) {
    for (const manager of this.managers.values()) manager.advanceTime(now);
  }

  health() {
    const cohorts = [...this.managers.values()].map((manager) => manager.health());
    const sum = (field) => cohorts.reduce((total, cohort) => total + Number(cohort[field] || 0), 0);
    const shared = (field) => Math.max(0, ...cohorts.map((cohort) => Number(cohort[field] || 0)));
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_C',
      sendsTransactions: false,
      cohorts,
      pendingEntries: sum('pendingEntries'),
      activePositions: sum('activePositions'),
      signalsSeen: shared('signalsSeen'),
      episodes: shared('episodes'),
      deduplicated: shared('deduplicated'),
      rejected: shared('rejected'),
      opened: sum('opened'),
      closed: sum('closed'),
      lastActionAt: Math.max(0, ...cohorts.map((cohort) => Number(cohort.lastActionAt) || 0))
        || null,
      lastError: cohorts.find((cohort) => cohort.lastError)?.lastError || null,
    };
  }
}

module.exports = { FlowFirstShadowSuite };
