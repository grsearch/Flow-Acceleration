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
          },
          store,
          now,
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
        },
        store,
        now,
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
        },
        store,
        now,
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
