'use strict';

const { LaunchPullbackShadowManager } = require('./LaunchPullbackShadowManager');

class LaunchPullbackShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.managers = new Map();
    for (const profile of config.profiles || []) {
      for (const hold of config.holds || []) {
        const cohortId = `${profile.id}_${hold.id}`;
        this.managers.set(cohortId, new LaunchPullbackShadowManager({
          config: {
            ...config,
            ...profile,
            cohortId,
            cohortLabel: `${profile.label} · ${hold.label}`,
            fixedHoldMs: hold.fixedHoldMs,
            profiles: undefined,
            holds: undefined,
          },
          store,
          now,
        }));
      }
    }
  }

  start() {
    for (const manager of this.managers.values()) manager.start();
  }

  stop() {
    for (const manager of this.managers.values()) manager.stop();
  }

  onReference(reference) {
    return [...this.managers.values()].map((manager) => manager.onReference(reference));
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
      mode: 'SHADOW_F',
      sendsTransactions: false,
      cohorts,
      pendingEntries: sum('pendingEntries'),
      activePositions: sum('activePositions'),
      referencesSeen: shared('referencesSeen'),
      qualifiedReferences: shared('qualifiedReferences'),
      deduplicated: shared('deduplicated'),
      rejected: sum('rejected'),
      priceJump: sum('priceJump'),
      opened: sum('opened'),
      closed: sum('closed'),
      lastActionAt: Math.max(0, ...cohorts.map((cohort) => Number(cohort.lastActionAt) || 0))
        || null,
      lastError: cohorts.find((cohort) => cohort.lastError)?.lastError || null,
    };
  }
}

module.exports = { LaunchPullbackShadowSuite };
