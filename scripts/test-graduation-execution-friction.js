'use strict';

const assert = require('node:assert/strict');
require('dotenv').config = () => ({ parsed: {} });
for (const key of Object.keys(process.env)) if (key.startsWith('FLOW_')) delete process.env[key];
process.env.FLOW_RESEARCH_FOCUS_ENABLED = 'false';
const { config } = require('../src/config');
const { ResearchStore } = require('../src/data/ResearchStore');
const { GraduationAccelerationShadowSuite, STATUS } = require('../src/core/GraduationAccelerationShadowSuite');
const friction = require('../src/core/GraduationExecutionFrictionStudy');
const SOURCE = 'O_C80_HO500_X60_POSTV1';
const HO200 = 'O_C80_HO200_X60_POSTV1';
const D1 = `${SOURCE}_FRIC1_D1000`;
const D2 = `${SOURCE}_FRIC1_D2000`;
const FEES = { lpFeeBasisPoints: '2', protocolFeeBasisPoints: '93', coinCreatorFeeBasisPoints: '30',
  buybackFeeBasisPoints: '5000', cashbackFeeBasisPoints: '1000' };
function approximately(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
function audit(row) { return JSON.parse(row.features_json).executionFriction; }

function fixture() {
  const settings = { ...config.graduationAccelerationShadow,
    entryProfiles: config.graduationAccelerationShadow.entryProfiles.filter((p) => [SOURCE, HO200].includes(p.id)),
    noExitObservationMs: 30_000, exitTimeoutMs: 3_000,
  };
  assert.equal(settings.entryProfiles.length, 2);
  const store = new ResearchStore({ dbPath: ':memory:', archiveDir: '.', rawShardingEnabled: false,
    rawRetentionHours: 24, flushMs: 60_000, flushMax: 100 }, { configuredTradingCostPct: 1.4 });
  let now = Date.now();
  let suite;
  const signals = [];
  const f = {
    store, settings, signals,
    get now() { return now; }, get suite() { return suite; },
    rows(mint) { return store.db.prepare('SELECT * FROM graduation_acceleration_shadow_positions WHERE mint=? ORDER BY id').all(mint); },
    row(mint, id = D1) { return this.rows(mint).find((r) => r.entry_profile_id === id && r.position_sol === 0.1); },
    restart() {
      suite?.stop();
      suite = new GraduationAccelerationShadowSuite({ config: settings, store, now: () => now,
        onLiveSignal(signal) {
          assert.equal(f.row(signal.mint, D1).status, STATUS.PENDING_ENTRY);
          assert.equal(f.row(signal.mint, D2).status, STATUS.PENDING_ENTRY);
          signals.push(signal);
        } });
      suite.start();
    },
    advance(at) { now = at; suite.advanceTime(at); },
    tick(mint, at, price = 1e-7, overrides = {}) {
      now = at;
      const trade = { mint, timestampMs: at, chainTimestampMs: at, receivedAtMs: at,
        slot: at, signature: `sig-${mint}-${at}`, eventIndex: 0, pool: `${mint}-pool`,
        market: 'PUMP_AMM', side: 'BUY', wallet: `wallet-${at}`, solAmount: 0.2,
        price, reservePrice: price, curvePct: 100, ammQuoteState: 'POST_TRADE_V1',
        virtualSolReservesRaw: '100000000000', virtualTokenReservesRaw: '1000000000000000',
        poolBaseReservesRaw: '1000000000000000', poolQuoteReservesRaw: String(Math.round(price * 1e18)),
        virtualQuoteReservesRaw: '0', ammExecutionFees: FEES, ...overrides };
      suite.observeTrade(trade);
      return trade;
    },
    enter(mint) {
      const at = now;
      suite.onCreate({ mint, creator: 'creator', createdAt: at });
      this.tick(mint, at + 100, 7e-8, { market: 'PUMP_BONDING_CURVE', curvePct: 70 });
      this.tick(mint, at + 1_000, 7e-8, { market: 'PUMP_BONDING_CURVE', curvePct: 80 });
      suite.onGraduated({ mint, graduated_at: at + 2_000 });
      this.tick(mint, at + 2_600);
      return this.row(mint, SOURCE);
    },
    dispose() { suite.stop(); store.close(); },
  };
  f.restart();
  return f;
}

function testFeeArithmeticAndFailClosed() {
  const trade = { ammQuoteState: 'POST_TRADE_V1', pool: 'pool',
    poolBaseReservesRaw: '1000000000000000', poolQuoteReservesRaw: '100000000000',
    virtualQuoteReservesRaw: '0', ammExecutionFees: FEES };
  const buy = friction.quote(trade, 0.1, 'BUY');
  assert.equal(buy.available, true);
  const effective = 98_765_429n; // SDK: floor budget/(1+1.25%), 2-lamport rounded-fee excess, 1-lamport guard.
  assert.equal(buy.tokenRaw, (1_000_000_000_000_000n * effective / (100_000_000_000n + effective)).toString());
  const sell = friction.quote(trade, buy.tokenUnits, 'SELL', buy.tokenRaw);
  const raw = BigInt(buy.tokenRaw);
  const gross = 100_000_000_000n * raw / (1_000_000_000_000_000n + raw);
  const totalFees = [2n, 93n, 30n].reduce((sum, bps) => sum + (gross * bps + 9_999n) / 10_000n, 0n);
  approximately(sell.proceedsSol, Number(gross - totalFees) / 1e9);
  assert.ok(sell.proceedsSol < 0.1, 'roundtrip includes both AMM fees without inventing cashback');
  const noSplit = friction.quote({ ...trade, ammExecutionFees: {
    lpFeeBasisPoints: 2, protocolFeeBasisPoints: 93, coinCreatorFeeBasisPoints: 30,
  } }, 0.1, 'BUY');
  assert.equal(noSplit.tokenRaw, buy.tokenRaw, 'buyback is not an extra 50% fee');
  for (const invalid of [null, undefined, '', ' ', -1, 1.5, NaN, Infinity, 10_000, true]) {
    const quote = friction.quote({ ...trade, ammExecutionFees: { ...FEES, protocolFeeBasisPoints: invalid } }, 0.1, 'BUY');
    assert.equal(quote.available, false);
    assert.equal(quote.reason, 'FRICTION_FEE_EVIDENCE_UNAVAILABLE');
  }
  assert.equal(friction.quote({ ...trade, ammExecutionFees: null }, 0.1, 'BUY').available, false);
  assert.equal(friction.quote({ ...trade, ammQuoteState: 'PRE_TRADE' }, 0.1, 'BUY').available, false);
  const virtualOnly = friction.quote({ ...trade, poolQuoteReservesRaw: '10',
    virtualQuoteReservesRaw: '100000000000' }, buy.tokenUnits, 'SELL', buy.tokenRaw);
  assert.equal(virtualOnly.reason, 'FRICTION_REAL_QUOTE_INVENTORY_INSUFFICIENT');
}

function testMatchedEntriesDelaysFeesAndNoLiveChanges() {
  const f = fixture();
  try {
    const original = JSON.stringify(f.settings.entryProfiles);
    const generated = f.suite.health().entryProfiles.filter((p) => p.experimentGroup === friction.VERSION);
    assert.equal(generated.length, 4);
    assert.ok(generated.every((p) => p.handoffLiveStrategyId == null && p.liveStrategyId == null && p.liveBridgeCapacitySol == null));
    assert.equal(JSON.stringify(f.settings.entryProfiles), original, 'global config is not mutated');
    const source = f.enter('pair');
    const at = source.entry_at;
    assert.equal(f.rows('pair').filter((r) => r.entry_profile_id.includes('_FRIC1_')).length, 4);
    for (const id of [D1, D2]) {
      const r = f.row('pair', id);
      assert.equal(r.status, STATUS.PENDING_ENTRY);
      assert.equal(audit(r).sourcePositionId, source.id);
      assert.equal(r.episode_id, source.episode_id);
      approximately(r.configured_cost_pct, 0.21, 1e-12);
    }
    f.tick('pair', at + 999);
    assert.equal(f.row('pair').status, STATUS.PENDING_ENTRY);
    f.tick('pair', at + 1_000, 1.01e-7, { side: 'SELL', solAmount: 20 });
    const one = f.row('pair');
    assert.equal(one.status, STATUS.RUNNER, 'frozen source eligibility is not recomputed on a later sell');
    assert.equal(one.entry_at, at + 1_000);
    assert.equal(audit(one).entry.actualDelayMs, 1_000);
    assert.equal(f.row('pair', D2).status, STATUS.PENDING_ENTRY);
    f.tick('pair', at + 2_000, 1.02e-7);
    const two = f.row('pair', D2);
    assert.equal(two.entry_at, at + 2_000);
    f.advance(one.entry_at + 60_000);
    assert.equal(f.row('pair').exit_target_at, one.entry_at + 61_000);
    f.tick('pair', one.entry_at + 60_999, 1.02e-7);
    assert.equal(f.row('pair').status, STATUS.EXIT_PENDING);
    const exitTrade = f.tick('pair', one.entry_at + 61_000, 1.02e-7,
      { ammExecutionFees: { ...FEES, protocolFeeBasisPoints: '150' } });
    const closed = f.row('pair');
    assert.equal(closed.status, STATUS.CLOSED);
    const expected = friction.quote(exitTrade, one.token_units, 'SELL', audit(one).entry.tokenRaw);
    approximately(closed.net_return_pct, (expected.proceedsSol - 0.1 - 0.00021) / 0.1 * 100);
    approximately(audit(closed).exit.economicPnlSol, closed.net_return_pct / 100 * 0.1);
    assert.equal(audit(closed).exit.schedule.protocolFeeBasisPoints, 150, 'exit uses its current fee schedule');
    assert.equal(audit(closed).exit.actualDelayMs, 1_000);
    assert.match(audit(closed).rentTreatment, /CAPITAL_NOT_TRADING_COST/);
    f.tick('pair', two.entry_at + 62_000, 1.02e-7);
    assert.equal(f.row('pair', D2).status, STATUS.CLOSED);
    assert.equal(audit(f.row('pair', D2)).exit.actualDelayMs, 2_000);
    assert.equal(f.signals.length, 1, 'only pre-existing source callback; experiments never send live signals');
  } finally { f.dispose(); }
}

function testNoExitLateExitAndRestore() {
  const f = fixture();
  try {
    const source = f.enter('late');
    f.tick('late', source.entry_at + 1_000);
    const one = f.row('late');
    f.advance(one.entry_at + 60_000);
    const requested = f.row('late');
    f.tick('late', requested.exit_target_at - 1, 1e-7);
    f.tick('late', requested.exit_target_at, 1e-7, { signature: null });
    assert.equal(f.row('late').status, STATUS.EXIT_PENDING, 'missing exit signature cannot establish an executable fill');
    f.tick('late', requested.exit_target_at + 1, 1e-7, { ammExecutionFees: null });
    assert.equal(f.row('late').status, STATUS.EXIT_PENDING);
    assert.equal(audit(f.row('late')).exitUnavailable.reason, 'FRICTION_FEE_EVIDENCE_UNAVAILABLE');
    f.advance(requested.exit_deadline_at + 1);
    const unresolved = f.row('late');
    assert.equal(unresolved.status, STATUS.NO_EXIT);
    assert.equal(unresolved.net_return_pct, null);
    assert.equal(audit(unresolved).exitOutcome, 'NO_EXIT');
    assert.equal(audit(unresolved).noExitObservationMs, 30_000);
    assert.equal(audit(unresolved).noExitObservationUntil,
      requested.exit_deadline_at + 30_000);
    approximately(audit(unresolved).zeroRecoveryStressNetReturnPct, -100.105);
    assert.ok(f.suite.trackedMints().includes('late'), 'late-exit windows must retain stream subscriptions');
    f.settings.entryProfiles = [];
    f.settings.noExitObservationMs = 1;
    f.restart();
    assert.ok(f.suite.trackedMints().includes('late'),
      'pending study restores with its frozen observation window when profiles are disabled and defaults shrink');
    f.tick('late', requested.exit_deadline_at + 1_000, 5e-8);
    const late = f.row('late');
    assert.equal(late.status, STATUS.NO_EXIT, 'a later quote must not rewrite historical exit success');
    assert.equal(late.net_return_pct, null);
    assert.equal(late.late_exit_status, 'OBSERVED_EXECUTABLE');
    assert.ok(late.late_exit_net_return_pct < -50);
    assert.equal(audit(late).lateExit.excludedFromClosedReturns, true);
    assert.equal(audit(late).lateExit.afterDeadlineMs, 1_000);
    approximately(audit(late).lateExit.netReturnPct, late.late_exit_net_return_pct);
  } finally { f.dispose(); }
}

function testMissingEntryFeesTimingAndExpiry() {
  const f = fixture();
  try {
    const source = f.enter('missing');
    f.tick('missing', source.entry_at + 1_000, 1e-7, { chainTimestampMs: source.entry_at + 999 });
    assert.equal(f.row('missing').status, STATUS.PENDING_ENTRY, 'chain time also has to clear the delay');
    f.tick('missing', source.entry_at + 1_001, 1e-7, { ammExecutionFees: null });
    assert.equal(f.row('missing').status, STATUS.NO_ENTRY);
    assert.equal(f.row('missing').rejection_reason, 'FRICTION_FEE_EVIDENCE_UNAVAILABLE');
    assert.equal(audit(f.row('missing')).entryOutcome, 'NO_ENTRY');
    f.advance(f.row('missing', D2).entry_deadline_at + 1);
    assert.equal(f.row('missing', D2).status, STATUS.NO_ENTRY);
    assert.equal(audit(f.row('missing', D2)).entryFailureReason, 'NO_POST_TRADE_IN_DELAYED_ENTRY_WINDOW');
    const expiry = f.enter('expired');
    f.tick('expired', expiry.entry_at + 1_000);
    const entry = f.row('expired');
    f.advance(entry.entry_at + 60_000);
    const exit = f.row('expired');
    f.advance(exit.exit_deadline_at + 1);
    const frozenObservationUntil = audit(f.row('expired')).noExitObservationUntil;
    assert.equal(frozenObservationUntil, exit.exit_deadline_at + 30_000);
    f.settings.noExitObservationMs = 300_000;
    f.restart();
    assert.ok(f.suite.trackedMints().includes('expired'),
      'larger future defaults must not replace the position observation window');
    f.advance(frozenObservationUntil + 1);
    assert.equal(f.row('expired').late_exit_status, 'EXPIRED_NO_EXECUTABLE_TRADE');
    assert.equal(audit(f.row('expired')).lateExitOutcome, 'EXPIRED_NO_EXECUTABLE_TRADE');
    assert.equal(f.row('expired').net_return_pct, null);
    assert.equal(f.suite.noExitWatches.has(f.row('expired').id), false,
      'the friction row expires on its own frozen deadline even if another same-mint row remains tracked');
    const pending = f.enter('restart');
    const before = f.row('restart');
    f.settings.costModel = { platformFeePct: 99, priorityFeeSol: 20 };
    f.settings.exitDelayMs = 999_000;
    f.settings.entryProfiles = [];
    f.restart();
    f.tick('restart', pending.entry_at + 1_000);
    const restored = f.row('restart');
    assert.equal(restored.status, STATUS.RUNNER);
    assert.equal(restored.configured_cost_pct, before.configured_cost_pct);
    f.advance(restored.entry_at + 60_000);
    assert.equal(f.row('restart').exit_target_at, restored.entry_at + 61_000, 'open experiment keeps frozen exit delay');
    f.tick('restart', restored.entry_at + 61_000);
    assert.equal(f.row('restart').status, STATUS.CLOSED);
    approximately(f.row('restart').net_return_pct,
      audit(f.row('restart')).exit.economicPnlSol / 0.1 * 100);
  } finally { f.dispose(); }
}

testFeeArithmeticAndFailClosed();
testMatchedEntriesDelaysFeesAndNoLiveChanges();
testNoExitLateExitAndRestore();
testMissingEntryFeesTimingAndExpiry();
console.log('test-graduation-execution-friction: ok (4 same-source groups, dual delays, observed fees, missing evidence, NO_EXIT/late pressure, restart, no live change)');
