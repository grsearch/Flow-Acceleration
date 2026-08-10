'use strict';

const { SmartOpenShadowManager } = require('./SmartOpenShadowManager');

class SmartOpenShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.managers = new Map();
    for (const cohort of config.cohorts || []) {
      this.managers.set(cohort.id, new SmartOpenShadowManager({
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

  onSmartWalletEvent(event, context) {
    const results = [];
    for (const manager of this.managers.values()) {
      const result = manager.onSmartWalletEvent(event, context);
      if (result) results.push(result);
    }
    return results;
  }

  observeTrade(trade) {
    for (const manager of this.managers.values()) manager.observeTrade(trade);
  }

  advanceTime(now) {
    for (const manager of this.managers.values()) manager.advanceTime(now);
  }

  health() {
    const cohorts = [...this.managers.values()].map((manager) => manager.health());
    const total = (field) => cohorts.reduce((sum, cohort) => sum + Number(cohort[field] || 0), 0);
    const shared = (field) => Math.max(0, ...cohorts.map((cohort) => Number(cohort[field]) || 0));
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_SMART_OPEN',
      sendsTransactions: false,
      cohorts,
      pendingEntries: total('pendingEntries'),
      activePositions: total('activePositions'),
      evaluated: shared('evaluated'),
      qualifiedOpens: shared('qualifiedOpens'),
      rejected: shared('rejected'),
      opened: total('opened'),
      closed: total('closed'),
      smartExits: total('smartExits'),
      lastActionAt: Math.max(0, ...cohorts.map((cohort) => Number(cohort.lastActionAt) || 0))
        || null,
      lastError: cohorts.find((cohort) => cohort.lastError)?.lastError || null,
    };
  }
}

module.exports = { SmartOpenShadowSuite };
