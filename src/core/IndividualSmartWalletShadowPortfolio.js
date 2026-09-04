'use strict';

const {
  SmartWalletFirstOpenRightTailShadowSuite,
} = require('./SmartWalletFirstOpenRightTailShadowSuite');

class IndividualSmartWalletShadowPortfolio {
  constructor({ config, store, rugRiskTracker = null, now = () => Date.now() }) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.suites = (config.profiles || [])
      .filter((profile) => profile && profile.enabled !== false)
      .map((profile) => ({
        id: profile.id,
        label: profile.label,
        thesis: profile.thesis,
        suite: new SmartWalletFirstOpenRightTailShadowSuite({
          config: {
            ...(config.defaults || {}),
            ...profile,
            enabled: config.enabled === true,
          },
          store,
          rugRiskTracker,
          now,
        }),
      }));
  }

  start() {
    for (const { suite } of this.suites) suite.start();
  }

  stop() {
    for (const { suite } of this.suites) suite.stop();
  }

  onSmartWalletEvent(event) {
    if (!this.config.enabled) return;
    for (const { suite } of this.suites) suite.onSmartWalletEvent(event);
  }

  observeTrade(trade) {
    if (!this.config.enabled) return;
    for (const { suite } of this.suites) suite.observeTrade(trade);
  }

  advanceTime(now = this.now()) {
    if (!this.config.enabled) return;
    for (const { suite } of this.suites) suite.advanceTime(now);
  }

  trackedMints() {
    return [...new Set(this.suites.flatMap(({ suite }) => suite.trackedMints()))];
  }

  dashboard(limit = 100) {
    return {
      enabled: this.config.enabled === true,
      mode: 'SHADOW_INDIVIDUAL_SMART_WALLETS',
      sendsTransactions: false,
      pooledConsensus: false,
      strategies: this.suites.map(({ id, label, thesis, suite }) => ({
        id,
        label,
        thesis,
        ...suite.dashboard(limit),
      })),
      health: this.health(),
    };
  }

  health() {
    return {
      enabled: this.config.enabled === true,
      mode: 'SHADOW_INDIVIDUAL_SMART_WALLETS',
      sendsTransactions: false,
      pooledConsensus: false,
      trackedMints: this.trackedMints().length,
      strategies: this.suites.map(({ id, label, suite }) => ({
        id,
        label,
        ...suite.health(),
      })),
    };
  }
}

module.exports = { IndividualSmartWalletShadowPortfolio };
