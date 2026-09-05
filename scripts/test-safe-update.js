'use strict';

// Pure fixtures: no service control, Git writes, network requests, or production DB access.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CRITICAL_FILES, collectSafeConfigSummary } = require('../src/runtime/RuntimeIntegrity');
const { parseProperties, stopSeconds, servicePolicy, parseEnvironment, ownsCgroup,
  validateChanges, gitSnapshot, loadConfig, validateSummary, validateHealth, validateQuiescent,
  progressed, parseArgs, versionSatisfies, strategyState, validateStrategyState } = require('../deploy/safe-update-check');

const commit = 'b'.repeat(40), old = 'a'.repeat(40);
const options = { project: '/opt/flow-acceleration', unit: 'flow-acceleration.service', target: commit };
const service = { Id: options.unit, LoadState: 'loaded', WorkingDirectory: options.project,
  User: 'ubuntu', KillMode: 'mixed', KillSignal: '15', SendSIGKILL: 'no', TimeoutStopUSec: '3min',
  TimeoutStopFailureMode: 'terminate', ControlGroup: '/system.slice/flow-acceleration.service',
  EnvironmentFiles: `${options.project}/.env (ignore_errors=no)`, Environment: 'NODE_ENV=production' };
assert.equal(servicePolicy(service, options), 180);
assert.equal(stopSeconds('2min 30s'), 150);
assert.equal(stopSeconds('180000ms'), 180);
assert(Number.isNaN(stopSeconds('infinity')));
assert(Number.isNaN(stopSeconds('20s garbage')));
for (const [field, value, error] of [
  ['Id', 'dump-sniper.service', 'UNIT_NOT_LOADED_OR_ALIASED'],
  ['WorkingDirectory', '/opt/other', 'UNIT_WORKING_DIRECTORY_MISMATCH'],
  ['KillMode', 'control-group', 'UNSAFE_SYSTEMD_KILL_POLICY'],
  ['SendSIGKILL', 'yes', 'UNSAFE_SYSTEMD_KILL_POLICY'],
  ['TimeoutStopUSec', '20s', 'UNSAFE_STOP_TIMEOUT'],
  ['TimeoutStopUSec', 'infinity', 'UNSAFE_STOP_TIMEOUT'],
  ['TimeoutStopFailureMode', 'kill', 'UNSAFE_STOP_TIMEOUT'],
  ['ControlGroup', '/', 'UNIT_CGROUP_UNKNOWN'],
  ['EnvironmentFiles', '/etc/another.env (ignore_errors=no)', 'UNSUPPORTED_UNIT_ENVIRONMENT'],
  ['Environment', 'NODE_ENV=production FLOW_LIVE_ENABLED=1', 'UNSUPPORTED_UNIT_ENVIRONMENT'],
]) assert.throws(() => servicePolicy({ ...service, [field]: value }, options), new RegExp(error));
assert.deepEqual(parseProperties('MainPID=123\nEnvironment=NODE_ENV=production\n'), {
  MainPID: '123', Environment: 'NODE_ENV=production' });
assert(ownsCgroup('0::/system.slice/flow-acceleration.service\n', service.ControlGroup));
assert(ownsCgroup('1:name=systemd:/system.slice/flow-acceleration.service/child\n', service.ControlGroup));
assert(!ownsCgroup('0::/system.slice/flow-acceleration.service-rogue\n', service.ControlGroup));
assert(!ownsCgroup('0::/user.slice/pm2.service\n', service.ControlGroup));

assert.equal(parseEnvironment('# comment\nFLOW_LIVE_ENABLED=true\nEMPTY=\n').FLOW_LIVE_ENABLED, 'true');
const secret = 'NEVER_PRINT_THIS_SECRET';
for (const line of [`KEY="${secret}"`, `KEY=${secret} # comment`, `export KEY=${secret}`,
  `NODE_OPTIONS=--require=${secret}`, 'KEY=one\nKEY=two', 'NODE_ENV=development']) {
  assert.throws(() => parseEnvironment(line), (error) => !error.message.includes(secret));
}
assert.deepEqual(parseArgs([`--project=${options.project}`, `--unit=${options.unit}`, `--expected-commit=${commit}`]),
  { phase: 'preflight', ...options, acceptTimeout: 600 });
for (const change of ['src/data/ResearchStore.js', 'pnpm-lock.yaml', 'package.json', '.env',
  'deploy/flow-acceleration.service', '.gitattributes', 'src/data/new-schema.js', 'data/new.db']) {
  assert.throws(() => validateChanges([change]), /MANUAL_DEPLOY_REQUIRED/);
}
validateChanges(['src/config.js', 'src/core/LiveTradingManager.js', 'src/server/server.js', 'docs/readme.md']);

// Exercise Git gates with a closed command allowlist. No mock permits mutation.
function mockGit({ dirty = '', ancestor = true, localTarget = true, changed = [], head = old } = {}) {
  return (args) => {
    const text = args.join(' ');
    if (text === 'rev-parse --verify HEAD') return Buffer.from(head);
    if (text === 'rev-parse --is-inside-work-tree') return Buffer.from('true');
    if (text === 'symbolic-ref --quiet --short HEAD') return Buffer.from('main');
    if (text === 'status --porcelain=v1 --untracked-files=all') return Buffer.from(dirty);
    if (text === 'ls-files -v -z') return Buffer.from('H src/config.js\0');
    if (text === 'config --null --list') return Buffer.from('core.bare\nfalse\0');
    if (text.startsWith('rev-parse --git-path ')) return Buffer.from(path.join(__dirname, 'SAFE_UPDATE_TEST_ABSENT_STATE', args[2]));
    if (text === `rev-parse --verify ${commit}^{commit}`) {
      if (!localTarget) throw new Error('missing target');
      return Buffer.from(commit);
    }
    if (text === `merge-base --is-ancestor ${head} ${commit}`) {
      if (!ancestor) throw new Error('not ancestor');
      return Buffer.alloc(0);
    }
    if (text === `diff --no-renames --name-only -z ${head} ${commit}`) return Buffer.from(changed.join('\0'));
    if (text === `diff --no-renames --diff-filter=A --name-only -z ${head} ${commit}`) return Buffer.alloc(0);
    if (text === `ls-tree -rz ${commit}`) return Buffer.from(`100644 blob ${commit}\tsrc/config.js\0`);
    throw new Error(`Unexpected Git command in read-only checker: ${text}`);
  };
}
assert.equal(gitSnapshot(mockGit(), commit).head, old);
assert.throws(() => gitSnapshot(mockGit({ dirty: ' M src/config.js' }), commit), /DIRTY_OR_UNTRACKED_FILES/);
assert.throws(() => gitSnapshot(mockGit({ dirty: 'UU src/config.js' }), commit), /DIRTY_OR_UNTRACKED_FILES/);
assert.throws(() => gitSnapshot(mockGit({ ancestor: false }), commit), /TARGET_NOT_FAST_FORWARD/);
assert.throws(() => gitSnapshot(mockGit({ localTarget: false }), commit), /missing target/);
assert.throws(() => gitSnapshot(mockGit({ changed: ['package.json'] }), commit), /MANUAL_DEPLOY_REQUIRED/);
assert.throws(() => gitSnapshot(mockGit({ changed: ['src/data/schema-helper.js', 'src/core/schema-helper.js'] }), commit), /MANUAL_DEPLOY_REQUIRED/);
assert.throws(() => gitSnapshot(mockGit({ head: commit }), commit, old), /HEAD_CHANGED/);
assert.equal(gitSnapshot(mockGit({ dirty: '?? data/LIVE_TRADING_DISABLED' }), commit, null, ['data/LIVE_TRADING_DISABLED']).head, old);
assert.throws(() => gitSnapshot(mockGit({ dirty: '?? src/config.js' }), commit, null, ['data/LIVE_TRADING_DISABLED']), /DIRTY_OR_UNTRACKED_FILES/);
assert(versionSatisfies('1.99.0', '^1.95.3'));
assert(versionSatisfies('0.4.15', '0.4.15'));
assert(!versionSatisfies('2.0.0', '^1.95.3'));
assert(!versionSatisfies('1.95.2', '^1.95.3'));
assert(!versionSatisfies('0.5.0', '^0.4.15'));
assert(!versionSatisfies('1.0.0', 'latest'));

// Evaluate the real configuration sources in memory with fake credentials only.
const root = path.resolve(__dirname, '..');
const config = loadConfig((file) => fs.readFileSync(path.join(root, file), 'utf8'), {
  FLOW_GRPC_ENDPOINTS: 'https://example.invalid', FLOW_GRPC_TOKEN: secret,
});
const summary = collectSafeConfigSummary(config);
validateSummary(summary);
assert(!JSON.stringify(summary).includes(secret));
assert.throws(() => loadConfig(() => "require('fs').writeFileSync('x','y')", {}), /CONFIG_IMPORT_REQUIRES_MANUAL_REVIEW/);

const expected = { pid: 123, project: options.project, commit, configFingerprint: summary.fingerprint,
  dbPath: '/opt/flow-acceleration/data/flow-research.db', strategies: strategyState(config.liveTrading.strategies) };
const value = { status: 'streaming', runtime: { pid: 123, cwd: options.project,
  sourcePath: `${options.project}/src/index.js`, gitCommit: commit, dbPath: expected.dbPath }, runtimeSnapshot: { status: 'DIRECT' },
  configurationIntegrity: { status: 'MATCH', headCommit: commit, warnings: [], configSummary: summary,
    files: CRITICAL_FILES.map((file) => ({ file, status: 'MATCH' })) },
  trading: { strategies: config.liveTrading.strategies.filter((row) => row.enabled !== false) },
  database: { writeStatus: 'HEALTHY', consecutiveWriteErrors: 0, lastPersistedTradeAt: 100, lastFlushAt: 200, dbPath: expected.dbPath } };
assert.deepEqual(validateHealth(value, expected), { lastPersistedTradeAt: 100, lastFlushAt: 200 });
assert.throws(() => validateHealth({ ...value, runtime: { ...value.runtime, pid: 999 } }, expected), /IDENTITY_MISMATCH/);
assert.throws(() => validateHealth({ ...value, database: { ...value.database, writeStatus: 'LOCKED' } }, expected), /HEALTH_NOT_READY/);
assert.throws(() => validateHealth({ ...value, configurationIntegrity: { ...value.configurationIntegrity, status: 'MISMATCH' } }, expected), /SOURCE_INTEGRITY/);
assert.throws(() => validateHealth({ ...value, runtimeSnapshot: { status: 'STALE' } }, expected), /HEALTH_NOT_READY/);
assert.throws(() => validateHealth({ ...value, runtime: { ...value.runtime, dbPath: '/tmp/replacement.db' } }, expected), /IDENTITY_MISMATCH/);
assert.throws(() => validateHealth({ ...value, configurationIntegrity: { ...value.configurationIntegrity,
  files: CRITICAL_FILES.map(() => ({ file: CRITICAL_FILES[0], status: 'MATCH' })) } }, expected), /SOURCE_INTEGRITY/);
// Zero new-entry strategies is an intentional valid target. Definitions and
// exits stay present; any unexpected re-enable or disabled exit owner is rejected.
const stoppedDefinitions = [summary.ho500, ...summary.post].map((row) => ({ id: row.id, enabled: true, entryEnabled: false }));
const stoppedState = strategyState(stoppedDefinitions);
assert.equal(stoppedState.enabledIds.length, 3);
assert.deepEqual(stoppedState.entryIds, []);
validateStrategyState([...stoppedDefinitions].reverse(), stoppedState);
assert.throws(() => validateStrategyState(stoppedDefinitions.slice(1), stoppedState), /DIFFERS_FROM_TARGET/);
assert.throws(() => validateStrategyState(stoppedDefinitions.map((row, index) => index ? row : { ...row, entryEnabled: true }), stoppedState), /DIFFERS_FROM_TARGET/);
assert.throws(() => validateStrategyState([...stoppedDefinitions, { id: 'unexpected_extra_entry' }], stoppedState), /DIFFERS_FROM_TARGET/);
assert.throws(() => validateStrategyState(undefined, stoppedState), /STRATEGY_IDENTITY_UNAVAILABLE/);
assert.throws(() => validateStrategyState([stoppedDefinitions[0], stoppedDefinitions[0]], stoppedState), /STRATEGY_IDENTITY_UNAVAILABLE/);
const oneEntry = stoppedDefinitions.map((row, index) => index ? row : { ...row, entryEnabled: true });
validateStrategyState(oneEntry, strategyState(oneEntry));
assert.equal(strategyState([{ id: 'defaults' }, { id: 'disabled', enabled: false }]).entryIds.length, 1,
  'omitted flags must match LiveTradingManager defaults; explicitly disabled definitions are not active');
validateHealth({ ...value, trading: { strategies: stoppedDefinitions } }, { ...expected, strategies: stoppedState });
assert.throws(() => validateHealth({ ...value, trading: { strategies: oneEntry } }, { ...expected, strategies: stoppedState }), /DIFFERS_FROM_TARGET/);
const quiet = { trading: { activePositions: 0, pendingActions: 0, unsettledOrders: 0,
  unsettledOrdersUpdatedAt: Date.now(), activeMintEntryLocks: 0, activeMintEntryLocksUpdatedAt: Date.now(), killSwitchActive: true },
database: { pendingWrites: 0, pendingLabelWrites: 0, pendingTokenWrites: 0, consecutiveWriteErrors: 0, writeStatus: 'HEALTHY' } };
validateQuiescent(quiet);
for (const field of ['activePositions', 'pendingActions', 'unsettledOrders', 'activeMintEntryLocks']) {
  assert.throws(() => validateQuiescent({ ...quiet, trading: { ...quiet.trading, [field]: 1 } }), /NOT_CLEAR/);
}
assert.throws(() => validateQuiescent({ ...quiet, trading: { ...quiet.trading, killSwitchActive: false } }), /KILL_SWITCH_REQUIRED/);
assert.throws(() => validateQuiescent({ ...quiet, trading: { ...quiet.trading, unsettledOrdersUpdatedAt: 0 } }), /EVIDENCE_STALE/);
assert.throws(() => validateQuiescent({ ...quiet, database: { ...quiet.database, pendingTokenWrites: 1 } }), /DRAIN_NOT_CLEAR/);
assert(!progressed({ lastPersistedTradeAt: 100, lastFlushAt: 200 }, { lastPersistedTradeAt: 100, lastFlushAt: 300, observedTrades: 999999 }));
assert(progressed({ lastPersistedTradeAt: 100, lastFlushAt: 200 }, { lastPersistedTradeAt: 101, lastFlushAt: 300 }));

// Shell contract: actual side effects live only here, with explicit ordered gates.
const shell = fs.readFileSync(path.join(root, 'deploy/safe-update.sh'), 'utf8');
const steps = ['systemctl --no-ask-password stop', 'check --phase=stopped', 'merge --ff-only --no-edit',
  'check --phase=updated', 'systemctl --no-ask-password start', 'check --phase=accept'];
for (let i = 1; i < steps.length; i += 1) assert(shell.indexOf(steps[i - 1]) < shell.indexOf(steps[i]));
assert(shell.includes('if (( APPLY == 0 )); then\n  check --phase=preflight | check --phase=describe\n  exit 0'));
assert(!/^\s*(?:pkill|killall|nohup|kill|git\s+(?:fetch|push|reset|checkout)|systemctl\s+restart)\b/m.test(shell));
assert.equal((shell.match(/systemctl --no-ask-password start/g) || []).length, 1);

function findBash() {
  const candidates = [process.env.FLOW_UPDATE_TEST_BASH, 'bash'];
  if (process.platform === 'win32') {
    const where = spawnSync('where.exe', ['git'], { encoding: 'utf8' });
    for (const executable of (where.stdout || '').trim().split(/\r?\n/).filter(Boolean)) {
      candidates.push(path.resolve(path.dirname(executable), '../usr/bin/sh.exe'));
    }
  }
  return candidates.filter(Boolean).find((candidate) => {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10000 });
    return result.status === 0 && /GNU bash/.test(result.stdout);
  });
}
const bash = findBash();
let shellCases = 0;
if (bash) {
  const syntax = spawnSync(bash, ['-n'], { input: shell, encoding: 'utf8', timeout: 10000 });
  assert.equal(syntax.status, 0, syntax.stderr);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-safe-update-test-'));
  const toShellPath = (value) => process.platform === 'win32'
    ? value.replace(/\\/g, '/').replace(/^([a-z]):/i, (_, drive) => `/${drive.toLowerCase()}`) : value;
  try {
    const apply = shell.slice(shell.indexOf("stage='before stop'"));
    const preview = shell.slice(shell.indexOf('if (( APPLY == 0 )); then'), shell.indexOf('\n[[ $EUID'));
    function scenario(mode, failure, expectedTrace) {
      const trace = path.join(temporary, `trace-${shellCases}`);
      const script = `set -euo pipefail
export PATH="/usr/bin:/bin:$PATH"
TRACE="$1"
FAIL="$2"
unit=flow-acceleration.service
project=/opt/flow-acceleration
service_user=ubuntu
target=${commit}
evidence='{}'
APPLY=0
note() { printf '%s\\n' "$1" >> "$TRACE"; [[ "$1" != "$FAIL" ]]; }
systemctl() { [[ "$1" == --no-ask-password ]] || return 91; note "$2"; }
runuser() { [[ "$*" == *'merge --ff-only --no-edit --no-overwrite-ignore'* ]] || return 92; note merge; }
check() { note "\${1#--phase=}"; }
${mode === 'preview' ? preview : apply}
`;
      const result = spawnSync(bash, ['-s', '--', toShellPath(trace), failure], {
        input: script, encoding: 'utf8', timeout: 10000,
      });
      const observed = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/);
      if (mode === 'preview') observed.sort();
      assert.deepEqual(observed, expectedTrace, `${mode}/${failure}: ${result.stderr}`);
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      shellCases += 1;
    }
    scenario('preview', '', ['describe', 'preflight']);
    scenario('apply', 'stop', ['stop']);
    scenario('apply', 'stopped', ['stop', 'stopped']);
    scenario('apply', 'merge', ['stop', 'stopped', 'merge']);
    scenario('apply', 'updated', ['stop', 'stopped', 'merge', 'updated']);
    scenario('apply', 'start', ['stop', 'stopped', 'merge', 'updated', 'start']);
    scenario('apply', 'accept', ['stop', 'stopped', 'merge', 'updated', 'start', 'accept']);
    scenario('apply', '', ['stop', 'stopped', 'merge', 'updated', 'start', 'accept']);
  } finally {
    assert(path.basename(temporary).startsWith('flow-safe-update-test-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
} else {
  console.log('Bash execution scenarios not run: Bash unavailable; pure checker tests and shell contract checked.');
}
console.log(`test-safe-update: ok (pure rejection gates/config/health tests; ${shellCases} isolated Bash scenarios)`);
