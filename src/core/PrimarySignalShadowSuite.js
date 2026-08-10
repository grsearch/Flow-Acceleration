'use strict';

const { PrimarySignalShadowManager } = require('./PrimarySignalShadowManager');

class PrimarySignalShadowSuite {
  constructor({ config, store, now = () => Date.now() }) {
    this.config = config;
    this.managers = new Map();
    for (const profile of config.profiles || []) {
      const managerConfig = {
        ...config,
        ...profile,
        profileId: profile.id,
        profiles: undefined,
      };
      this.managers.set(profile.signalVariant, new PrimarySignalShadowManager({
        config: managerConfig,
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
    return this.managers.get(signal?.signalVariant)?.onSignal(signal) || null;
  }

  observeTrade(trade) {
    for (const manager of this.managers.values()) manager.observeTrade(trade);
  }

  advanceTime(now) {
    for (const manager of this.managers.values()) manager.advanceTime(now);
  }

  health() {
    const profiles = [...this.managers.values()].map((manager) => manager.health());
    const total = (field) => profiles.reduce((sum, profile) => sum + Number(profile[field] || 0), 0);
    const balanced = profiles.find((profile) => profile.profileId === 'balanced') || profiles[0] || null;
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW',
      strategy: balanced?.strategy || null,
      profiles,
      activePositions: total('activePositions'),
      pendingEntries: total('pendingEntries'),
      evaluated: total('evaluated'),
      matched: total('matched'),
      opened: total('opened'),
      closed: total('closed'),
      lastActionAt: Math.max(0, ...profiles.map((profile) => Number(profile.lastActionAt) || 0)) || null,
      lastError: profiles.find((profile) => profile.lastError)?.lastError || null,
    };
  }
}

module.exports = { PrimarySignalShadowSuite };
