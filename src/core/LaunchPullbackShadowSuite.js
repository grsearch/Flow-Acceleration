'use strict';

const { LaunchPullbackShadowManager } = require('./LaunchPullbackShadowManager');

class LaunchPullbackShadowSuite {
  constructor({ config, store, now = () => Date.now(), onLiveSignal = null }) {
    this.config = config;
    this.managers = new Map();
    this.flowSignals = new Map();
    this.retiredCohortIds = new Set(config.retiredCohortIds || []);
    const newEntriesEnabled = (cohortId, cohort = null) => (
      cohort?.newEntriesEnabled !== false && !this.retiredCohortIds.has(cohortId)
    );
    this.flowSignalRetentionMs = Math.max(
      60_000,
      ...(config.optimizationCohorts || [])
        .map((cohort) => Number(cohort.flowConfirmationWindowMs) || 0),
    );
    for (const profile of config.profiles || []) {
      for (const hold of config.holds || []) {
        const cohortId = `${profile.id}_${hold.id}`;
        this.managers.set(cohortId, new LaunchPullbackShadowManager({
          config: {
            ...config,
            ...profile,
            cohortId,
            newEntriesEnabled: newEntriesEnabled(cohortId, profile),
            cohortLabel: `${profile.label} · ${hold.label}`,
            profileId: profile.id,
            referenceProfileId: 'LEGACY_7_5_R3',
            referencePullbackPct: 7.5,
            referenceReboundPct: 3,
            exitPolicy: 'FIXED_HOLD',
            fixedHoldMs: hold.fixedHoldMs,
            profiles: undefined,
            holds: undefined,
            trailingCohorts: undefined,
            deepCohorts: undefined,
            optimizationCohorts: undefined,
            retiredCohortIds: undefined,
          },
          store,
          now,
          onLiveSignal,
        }));
      }
    }

    const profiles = new Map((config.profiles || []).map((profile) => [profile.id, profile]));
    for (const cohort of config.trailingCohorts || []) {
      const profile = profiles.get(cohort.profileId);
      if (!profile) throw new Error(`Unknown Launch Pullback profile: ${cohort.profileId}`);
      if (this.managers.has(cohort.id)) {
        throw new Error(`Duplicate Launch Pullback cohort: ${cohort.id}`);
      }
      this.managers.set(cohort.id, new LaunchPullbackShadowManager({
        config: {
          ...config,
          ...profile,
          ...cohort,
          cohortId: cohort.id,
          newEntriesEnabled: newEntriesEnabled(cohort.id, cohort),
          cohortLabel: cohort.label,
          profileId: profile.id,
          referenceProfileId: 'LEGACY_7_5_R3',
          referencePullbackPct: 7.5,
          referenceReboundPct: 3,
          exitPolicy: 'TRAILING_STOP',
          profiles: undefined,
          holds: undefined,
          trailingCohorts: undefined,
          deepCohorts: undefined,
          optimizationCohorts: undefined,
          retiredCohortIds: undefined,
        },
        store,
        now,
        onLiveSignal,
      }));
    }

    for (const cohort of config.deepCohorts || []) {
      if (this.managers.has(cohort.cohortId)) {
        throw new Error(`Duplicate Launch Pullback cohort: ${cohort.cohortId}`);
      }
      this.managers.set(cohort.cohortId, new LaunchPullbackShadowManager({
        config: {
          ...config,
          ...cohort,
          cohortId: cohort.cohortId,
          newEntriesEnabled: newEntriesEnabled(cohort.cohortId, cohort),
          cohortLabel: cohort.label,
          profileId: cohort.profileId,
          referenceProfileId: cohort.id,
          referencePullbackPct: cohort.pullbackPct,
          referenceReboundPct: cohort.reboundPct,
          exitPolicy: 'FIXED_HOLD',
          profiles: undefined,
          holds: undefined,
          trailingCohorts: undefined,
          deepCohorts: undefined,
          optimizationCohorts: undefined,
          retiredCohortIds: undefined,
        },
        store,
        now,
        onLiveSignal,
      }));
    }

    for (const cohort of config.optimizationCohorts || []) {
      if (this.managers.has(cohort.id)) {
        throw new Error(`Duplicate Launch Pullback cohort: ${cohort.id}`);
      }
      this.managers.set(cohort.id, new LaunchPullbackShadowManager({
        config: {
          ...config,
          ...cohort,
          cohortId: cohort.id,
          newEntriesEnabled: newEntriesEnabled(cohort.id, cohort),
          cohortLabel: cohort.label,
          profileId: cohort.profileId,
          referenceProfileId: cohort.referenceProfileId,
          referencePullbackPct: cohort.referencePullbackPct,
          referenceReboundPct: cohort.referenceReboundPct,
          profiles: undefined,
          holds: undefined,
          trailingCohorts: undefined,
          deepCohorts: undefined,
          optimizationCohorts: undefined,
          retiredCohortIds: undefined,
        },
        store,
        now,
        onLiveSignal,
      }));
    }
  }

  start() {
    for (const manager of this.managers.values()) manager.start();
  }

  stop() {
    for (const manager of this.managers.values()) manager.stop();
  }

  onReference(reference) {
    const referenceAt = Number(reference?.referenceAt);
    const signals = this.flowSignals.get(reference?.mint) || [];
    const results = [];
    for (const manager of this.managers.values()) {
      const windowMs = Number(manager.config.flowConfirmationWindowMs) || 0;
      if (!(windowMs > 0) || !(referenceAt > 0)) {
        results.push(manager.onReference(reference));
        continue;
      }
      const eligible = signals.filter((signal) => (
        signal.timestampMs <= referenceAt && signal.timestampMs >= referenceAt - windowMs
      ));
      const confirmation = eligible.reduce((best, signal) => (
        !best || signal.uniqueBuyersW3 > best.uniqueBuyersW3 ? signal : best
      ), null);
      results.push(manager.onReference({
        ...reference,
        features: {
          ...(reference.features || {}),
          flowConfirmationAt: confirmation?.timestampMs ?? null,
          flowConfirmationVariant: confirmation?.signalVariant ?? null,
          flowConfirmationBuyersW3: confirmation?.uniqueBuyersW3 ?? null,
          flowConfirmationNetFlowW3: confirmation?.netFlowW3 ?? null,
          flowConfirmationWindowMs: windowMs,
        },
      }));
    }
    this._pruneFlowSignals(referenceAt);
    return results;
  }

  onSignal(signal) {
    if (!this.config.enabled || !signal?.mint) return;
    const timestampMs = Number(signal.timestampMs ?? signal.timestamp_ms);
    const uniqueBuyersW3 = Number(signal.uniqueBuyersW3 ?? signal.unique_buyers_w3);
    if (!(timestampMs > 0) || !Number.isFinite(uniqueBuyersW3)) return;
    const rows = this.flowSignals.get(signal.mint) || [];
    rows.push({
      timestampMs,
      signalVariant: signal.signalVariant ?? signal.signal_variant ?? 'unknown',
      uniqueBuyersW3: Math.max(0, Math.trunc(uniqueBuyersW3)),
      netFlowW3: Number(signal.netFlowW3 ?? signal.netflow_w3) || 0,
    });
    rows.sort((left, right) => left.timestampMs - right.timestampMs);
    this.flowSignals.set(signal.mint, rows);
    this._pruneFlowSignals(timestampMs);
  }

  _pruneFlowSignals(now) {
    if (!(now > 0)) return;
    const cutoff = now - this.flowSignalRetentionMs;
    for (const [mint, rows] of this.flowSignals) {
      const kept = rows.filter((row) => row.timestampMs >= cutoff);
      if (kept.length) this.flowSignals.set(mint, kept);
      else this.flowSignals.delete(mint);
    }
  }

  observeTrade(trade, options) {
    for (const manager of this.managers.values()) manager.observeTrade(trade, options);
  }

  advanceTime(now) {
    for (const manager of this.managers.values()) manager.advanceTime(now);
  }

  health() {
    const cohorts = [...this.managers.values()].map((manager) => manager.health());
    const sum = (field) => cohorts.reduce((total, cohort) => total + Number(cohort[field] || 0), 0);
    const referenceGroups = [...cohorts.reduce((groups, cohort) => {
      const referenceProfileId = cohort.strategy?.entry?.referenceProfileId || 'LEGACY_7_5_R3';
      const current = groups.get(referenceProfileId) || {
        referenceProfileId,
        referencesSeen: 0,
        qualifiedReferences: 0,
        deduplicated: 0,
      };
      current.referencesSeen = Math.max(current.referencesSeen, Number(cohort.referencesSeen) || 0);
      current.qualifiedReferences = Math.max(
        current.qualifiedReferences,
        Number(cohort.qualifiedReferences) || 0,
      );
      current.deduplicated = Math.max(current.deduplicated, Number(cohort.deduplicated) || 0);
      groups.set(referenceProfileId, current);
      return groups;
    }, new Map()).values()];
    const referenceSum = (field) => referenceGroups.reduce(
      (total, group) => total + Number(group[field] || 0),
      0,
    );
    return {
      enabled: this.config.enabled,
      mode: 'SHADOW_F',
      sendsTransactions: false,
      retiredCohortIds: [...this.retiredCohortIds],
      cohorts,
      referenceGroups,
      pendingEntries: sum('pendingEntries'),
      activePositions: sum('activePositions'),
      referencesSeen: referenceSum('referencesSeen'),
      qualifiedReferences: referenceSum('qualifiedReferences'),
      deduplicated: referenceSum('deduplicated'),
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
