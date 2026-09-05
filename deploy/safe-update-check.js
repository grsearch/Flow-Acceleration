#!/usr/bin/env node
'use strict';

// Read-only checks. This file never starts/stops services, edits Git, opens a DB,
// runs a migration, writes files, or prints environment values or raw errors.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const http = require('http');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');
const { CRITICAL_FILES, collectRuntimeIntegrity, collectSafeConfigSummary } = require('../src/runtime/RuntimeIntegrity');

const PROPERTIES = [
  'Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'WorkingDirectory',
  'ExecStart', 'User', 'KillMode', 'KillSignal', 'SendSIGKILL', 'TimeoutStopUSec',
  'TimeoutStopFailureMode', 'EnvironmentFiles', 'Environment', 'ExecMainCode', 'ExecMainStatus',
  'NRestarts', 'InvocationID',
];
const CONFIG_MODULES = ['src/config.js', 'src/core/CostModel.js', 'src/core/PrimaryThresholdProfiles.js'];
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ABS_PATH = /^\/[A-Za-z0-9_./-]+$/;
const APP_ENV = /^(FLOW_|HELIUS_|ALLENHARK_)/;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function guard(condition, code) { if (!condition) throw new Error(code); }
function command(bin, args, options = {}) {
  try {
    return execFileSync(bin, args, { timeout: 15000, maxBuffer: 32 * 1024 * 1024,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  } catch (_) { throw new Error('READ_COMMAND_FAILED'); }
}
function parseProperties(text) {
  return Object.fromEntries(text.trim().split('\n').map((line) => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
}
function systemd(unit) {
  return parseProperties(command('systemctl', ['--no-ask-password', 'show', unit,
    `--property=${PROPERTIES.join(',')}`]).toString());
}
function stopSeconds(value) {
  if (typeof value !== 'string' || /infinity/i.test(value)) return NaN;
  let total = 0;
  const parts = value.match(/\d+(?:\.\d+)?(?:min|ms|us|h|s)/g) || [];
  if (parts.join('') !== value.replace(/\s/g, '')) return NaN;
  for (const item of parts) {
    const [, number, unit] = /^(\d+(?:\.\d+)?)(min|ms|us|h|s)$/.exec(item);
    total += Number(number) * { h: 3600, min: 60, s: 1, ms: 0.001, us: 0.000001 }[unit];
  }
  return total;
}
function servicePolicy(service, options, { stopped = false } = {}) {
  guard(service.Id === options.unit && service.LoadState === 'loaded', 'UNIT_NOT_LOADED_OR_ALIASED');
  guard(service.WorkingDirectory === options.project, 'UNIT_WORKING_DIRECTORY_MISMATCH');
  guard(/^[a-z_][a-z0-9_-]*[$]?$/.test(service.User || '') && service.User !== 'root', 'SERVICE_USER_UNSUPPORTED');
  guard(service.KillMode === 'mixed' && ['15', 'SIGTERM'].includes(service.KillSignal)
    && service.SendSIGKILL === 'no', 'UNSAFE_SYSTEMD_KILL_POLICY');
  const seconds = stopSeconds(service.TimeoutStopUSec);
  guard(seconds >= 120 && seconds <= 900 && service.TimeoutStopFailureMode === 'terminate', 'UNSAFE_STOP_TIMEOUT');
  guard((stopped && service.ControlGroup === '') || (service.ControlGroup?.startsWith('/')
    && !service.ControlGroup.includes('..') && service.ControlGroup.endsWith(`/${options.unit}`)), 'UNIT_CGROUP_UNKNOWN');
  guard(service.EnvironmentFiles === `${options.project}/.env (ignore_errors=no)`
    && service.Environment === 'NODE_ENV=production', 'UNSUPPORTED_UNIT_ENVIRONMENT');
  return seconds;
}
function parseEnvironment(text) {
  const env = { NODE_ENV: 'production' };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([^\r\n]*)$/.exec(line);
    guard(match && !/[\s'"`\\#]/.test(match[2]), 'ENV_REQUIRES_SIMPLE_SYSTEMD_DOTENV_SYNTAX');
    guard(!Object.hasOwn(env, match[1]) || match[1] === 'NODE_ENV', 'DUPLICATE_ENV_KEY');
    guard(!['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(match[1]), 'UNSUPPORTED_RUNTIME_INJECTION');
    env[match[1]] = match[2];
  }
  guard(env.NODE_ENV === 'production', 'NODE_ENV_NOT_PRODUCTION');
  return env;
}
function readEnvironment(project) {
  const file = `${project}/.env`;
  const stat = fs.lstatSync(file);
  guard(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024
    && (stat.mode & 0o077) === 0, 'ENV_FILE_NOT_PRIVATE_REGULAR_FILE');
  const bytes = fs.readFileSync(file);
  return { env: parseEnvironment(bytes.toString()), digest: sha(bytes) };
}
function proc(pid) {
  const root = `/proc/${pid}`;
  const stat = fs.readFileSync(`${root}/stat`, 'utf8');
  const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const env = Object.fromEntries(fs.readFileSync(`${root}/environ`, 'utf8').split('\0').filter(Boolean)
    .map((item) => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; }));
  return { pid, birth: tail[19], cwd: fs.realpathSync(`${root}/cwd`), exe: fs.realpathSync(`${root}/exe`),
    argv: fs.readFileSync(`${root}/cmdline`, 'utf8').split('\0').filter(Boolean),
    cgroup: fs.readFileSync(`${root}/cgroup`, 'utf8'), env };
}
function ownsCgroup(text, controlGroup) {
  return text.split('\n').some((line) => {
    const match = /^([^:]*):([^:]*):(.*)$/.exec(line);
    return match && (match[1] === '0' || match[2].split(',').includes('name=systemd'))
      && (match[3] === controlGroup || match[3].startsWith(`${controlGroup}/`));
  });
}
function validateMain(service, main, options, env) {
  const pid = Number(service.MainPID);
  guard(service.ActiveState === 'active' && service.SubState === 'running' && pid > 1
    && main.pid === pid, 'SERVICE_NOT_RUNNING');
  const entry = `${options.project}/src/index.js`;
  guard(main.cwd === options.project && main.argv.length === 2
    && path.resolve(main.cwd, main.argv[1]) === entry, 'MAIN_PROCESS_ENTRY_MISMATCH');
  guard(main.exe === fs.realpathSync(process.execPath), 'USE_SAME_NODE_BINARY_AS_SERVICE');
  guard(service.ExecStart.includes(`path=${main.exe} ; argv[]=${main.exe} ${entry} ;`), 'UNIT_EXECSTART_MISMATCH');
  guard(ownsCgroup(main.cgroup, service.ControlGroup), 'MAIN_PROCESS_CGROUP_MISMATCH');
  guard(!Object.keys(main.env).some((key) => /^(pm_id|PM2_|NODE_APP_INSTANCE$)/.test(key)), 'PM2_NOT_SUPPORTED');
  guard(!['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].some((key) => main.env[key]), 'UNSUPPORTED_RUNTIME_INJECTION');
  for (const key of new Set([...Object.keys(env), ...Object.keys(main.env).filter((key) => APP_ENV.test(key))])) {
    guard(main.env[key] === env[key], 'RUNNING_ENV_DIFFERS_FROM_SERVICE_ENV_FILE');
  }
}
function databasePathMatch(file, storage, project) {
  const db = path.resolve(project, storage.dbPath);
  const shards = path.resolve(project, storage.rawShardDir);
  return file === db || file === `${db}-wal`
    || (storage.rawShardingEnabled && file.startsWith(`${shards}/`) && /\.db(?:-wal)?$/.test(file));
}
function processInventory(project, controlGroup, storage, mainPid) {
  const groupPids = [], collectorPids = [], writers = new Set();
  for (const name of fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    const pid = Number(name), root = `/proc/${name}`;
    try {
      const cgroup = fs.readFileSync(`${root}/cgroup`, 'utf8');
      if (ownsCgroup(cgroup, controlGroup)) groupPids.push(pid);
      const argv = fs.readFileSync(`${root}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (argv.length && /(?:^|\/)node(?:js)?$/.test(argv[0])) {
        const cwd = fs.realpathSync(`${root}/cwd`);
        if (argv.some((arg) => arg && !arg.startsWith('-')
          && path.resolve(cwd, arg) === `${project}/src/index.js`)) collectorPids.push(pid);
      }
      for (const fd of fs.readdirSync(`${root}/fd`)) {
        let file;
        try { file = fs.readlinkSync(`${root}/fd/${fd}`); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!databasePathMatch(file.replace(/ \(deleted\)$/, ''), storage, project)) continue;
        let flags;
        try { flags = /^flags:\s+([0-7]+)$/m.exec(fs.readFileSync(`${root}/fdinfo/${fd}`, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        guard(flags, 'DATABASE_FD_FLAGS_UNKNOWN');
        if ((parseInt(flags[1], 8) & 3) !== 0) writers.add(pid);
      }
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw new Error('PROCESS_INVENTORY_INCOMPLETE');
    }
  }
  guard(collectorPids.length === (mainPid ? 1 : 0)
    && (!mainPid || collectorPids[0] === mainPid), 'COLLECTOR_NOT_UNIQUE');
  guard([...writers].every((pid) => pid === mainPid) && (!mainPid || writers.has(mainPid)), 'DATABASE_WRITER_NOT_UNIQUE');
  return groupPids;
}
function gitFor(project, user) {
  return (args, input) => command('runuser', ['-u', user, '--', 'git', '-C', project,
    '-c', 'core.hooksPath=/dev/null', ...args], { input, env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
  } });
}
function validateChanges(files) {
  const blocked = files.filter((file) => /^(?:deploy\/|src\/data\/|data\/|node_modules\/|migrations?\/|\.env(?:$|\.)|\.git|\.npmrc$|package(?:-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$|start\.sh$)/.test(file));
  guard(blocked.length === 0, 'MANUAL_DEPLOY_REQUIRED_DEPENDENCY_STORAGE_OR_SERVICE_CHANGE');
  guard(files.every((file) => /^(?:src\/|scripts\/|docs\/|README\.md$)/.test(file)), 'MANUAL_DEPLOY_REQUIRED_UNSUPPORTED_FILE_CHANGE');
}
function gitSnapshot(runGit, target, expectedHead = null, allowedUntracked = []) {
  const read = (args) => runGit(args).toString().trim();
  const head = read(['rev-parse', '--verify', 'HEAD']);
  guard(HASH.test(head) && (!expectedHead || head === expectedHead), 'HEAD_CHANGED');
  guard(read(['rev-parse', '--is-inside-work-tree']) === 'true', 'NOT_A_CHECKOUT');
  guard(read(['symbolic-ref', '--quiet', '--short', 'HEAD']), 'DETACHED_HEAD_NOT_SUPPORTED');
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all']).toString().split(/\r?\n/).filter(Boolean);
  guard(status.every((line) => allowedUntracked.some((file) => line === `?? ${file}`)), 'DIRTY_OR_UNTRACKED_FILES');
  guard(!runGit(['ls-files', '-v', '-z']).toString().split('\0').some((entry) => /^[a-zS]/.test(entry)), 'HIDDEN_WORKTREE_FLAGS_NOT_SUPPORTED');
  const gitConfig = runGit(['config', '--null', '--list']).toString().split('\0');
  guard(!gitConfig.some((entry) => /^(?:filter\.|extensions\.partialclone\n)/i.test(entry)), 'GIT_FILTER_OR_PARTIAL_CLONE_NOT_SUPPORTED');
  for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_START']) {
    const statePath = read(['rev-parse', '--git-path', state]);
    guard(!fs.existsSync(path.isAbsolute(statePath) ? statePath : path.join(read(['rev-parse', '--show-toplevel']), statePath)), 'GIT_OPERATION_IN_PROGRESS');
  }
  guard(read(['rev-parse', '--verify', `${target}^{commit}`]) === target, 'TARGET_COMMIT_NOT_LOCAL');
  try { runGit(['merge-base', '--is-ancestor', head, target]); } catch (_) { throw new Error('TARGET_NOT_FAST_FORWARD'); }
  const changed = runGit(['diff', '--no-renames', '--name-only', '-z', head, target]).toString().split('\0').filter(Boolean);
  validateChanges(changed);
  const added = runGit(['diff', '--no-renames', '--diff-filter=A', '--name-only', '-z', head, target])
    .toString().split('\0').filter(Boolean);
  const root = added.length ? read(['rev-parse', '--show-toplevel']) : null;
  guard(!added.some((file) => fs.existsSync(path.join(root, file))), 'TARGET_WOULD_REPLACE_UNTRACKED_OR_IGNORED_FILE');
  const tree = runGit(['ls-tree', '-rz', target]).toString().split('\0').filter(Boolean);
  guard(tree.every((item) => /^100(?:644|755) blob [a-f0-9]+\t[^\r\n]+$/.test(item)), 'SYMLINK_OR_SUBMODULE_NOT_SUPPORTED');
  return { head, changed, files: tree.map((item) => item.slice(item.indexOf('\t') + 1)) };
}
function loadConfig(readSource, environment) {
  const cache = new Map();
  const env = { ...environment };
  function load(file) {
    guard(CONFIG_MODULES.includes(file), 'CONFIG_IMPORT_REQUIRES_MANUAL_REVIEW');
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    const localRequire = (name) => {
      if (name === 'dotenv') return { config: () => ({ parsed: {} }) };
      guard(name.startsWith('.'), 'CONFIG_IMPORT_REQUIRES_MANUAL_REVIEW');
      return load(`${path.posix.normalize(path.posix.join(path.posix.dirname(file), name))}.js`);
    };
    const context = vm.createContext({ module, exports: module.exports, require: localRequire,
      process: { env }, URL, console: { log() {}, warn() {}, error() {} } });
    new vm.Script(readSource(file), { filename: file }).runInContext(context, { timeout: 2000 });
    cache.set(file, module.exports);
    return module.exports;
  }
  const result = load('src/config.js');
  guard(typeof result.validateConfig === 'function' && result.validateConfig().length === 0, 'TARGET_CONFIG_INVALID');
  validateSummary(collectSafeConfigSummary(result.config));
  return result.config;
}
function validateSummary(summary) {
  guard(summary?.available && summary.warnings?.length === 0, 'CONFIG_INTEGRITY_WARNINGS');
  const expectedIds = ['migrated_ge30_r23_f2_only_g2_xleg_live', 'migrated_grt_r23_f3_v2_xleg_live'];
  guard(summary.ho500?.present && summary.ho500.id === 'graduation_accel_o_c80_ho500_x60_live'
    && summary.post?.length === 2 && expectedIds.every((id) => summary.post.some((row) => row.id === id && row.present)), 'THREE_STRATEGIES_REQUIRED');
  guard(summary.ho500.positionSizeSol === 0.1 && summary.ho500.sourceShadowCohortId === 'O_C80_HO500_X60:0_1SOL'
    && summary.bridge?.liveBridgeCapacitySol === 0.1 && summary.bridge.capacitySols.includes(0.1)
    && summary.bridge.handoffLiveStrategyId === summary.ho500.id, 'HO500_BRIDGE_MISMATCH');
}
function versionSatisfies(installed, requested) {
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(installed || '');
  const range = /^(\^?)(\d+)\.(\d+)\.(\d+)$/.exec(requested || '');
  if (!version || !range) return false; // Unsupported ranges require manual deployment.
  const actual = version.slice(1).map(Number), lower = range.slice(2).map(Number);
  if (!range[1]) return actual.every((value, index) => value === lower[index]);
  const changing = lower.findIndex((value) => value !== 0);
  const boundary = changing < 0 ? 2 : changing;
  if (!actual.slice(0, boundary + 1).every((value, index) => value === lower[index])) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== lower[index]) return actual[index] > lower[index];
  }
  return true;
}
function checkTarget(runGit, snapshot, target, env, project) {
  const read = (commit, file) => runGit(['show', `${commit}:${file}`]).toString();
  for (const file of CRITICAL_FILES) guard(snapshot.files.includes(file), 'TARGET_CRITICAL_FILE_MISSING');
  const projectRequire = createRequire(`${project}/package.json`);
  for (const file of snapshot.files.filter((file) => /^src\/.*\.js$/.test(file))) {
    const source = read(target, file);
    try { new vm.Script(source, { filename: file }); } catch (_) { throw new Error('TARGET_SOURCE_SYNTAX_INVALID'); }
    for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const name = match[1];
      if (name.startsWith('.')) {
        const stem = path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
        guard([stem, `${stem}.js`, `${stem}.json`, `${stem}/index.js`].some((candidate) => snapshot.files.includes(candidate)), 'TARGET_RELATIVE_IMPORT_MISSING');
      } else {
        try { projectRequire.resolve(name); } catch (_) { throw new Error('TARGET_DEPENDENCY_MISSING'); }
      }
    }
  }
  // Dependency declarations must be identical; no install or native rebuild occurs here.
  const pkg = JSON.parse(read(target, 'package.json'));
  for (const [name, requested] of Object.entries(pkg.dependencies || {})) {
    let directory;
    try { directory = path.dirname(projectRequire.resolve(name)); } catch (_) { throw new Error('INSTALLED_DEPENDENCY_MISSING'); }
    let manifest = null;
    while (directory !== path.dirname(directory)) {
      const file = path.join(directory, 'package.json');
      if (fs.existsSync(file)) {
        const candidate = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (candidate.name === name) { manifest = candidate; break; }
      }
      directory = path.dirname(directory);
    }
    guard(manifest && versionSatisfies(manifest.version, requested), 'INSTALLED_DEPENDENCY_VERSION_MISMATCH');
  }
  try {
    const base = path.dirname(projectRequire.resolve('better-sqlite3/package.json'));
    projectRequire(path.join(base, 'build/Release/better_sqlite3.node'));
  } catch (_) { throw new Error('SQLITE_NATIVE_NODE_ABI_MISMATCH'); }
  const before = loadConfig((file) => read(snapshot.head, file), env);
  const after = loadConfig((file) => read(target, file), env);
  guard(JSON.stringify(before.storage) === JSON.stringify(after.storage)
    && before.dashboardCache.dbPath === after.dashboardCache.dbPath && before.server.port === after.server.port,
  'MANUAL_DEPLOY_REQUIRED_STORAGE_OR_PORT_CONFIG_CHANGE');
  return { before, after };
}
function health(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 5000,
      headers: { 'Cache-Control': 'no-cache' } }, (response) => {
      let body = '';
      response.on('data', (part) => { body += part; if (body.length > 12 * 1024 * 1024) request.destroy(new Error('HEALTH_TOO_LARGE')); });
      response.on('end', () => { try { guard(response.statusCode === 200, 'HEALTH_HTTP_STATUS'); resolve(JSON.parse(body)); } catch (_) { reject(new Error('HEALTH_RESPONSE_INVALID')); } });
      response.on('error', () => reject(new Error('HEALTH_UNAVAILABLE')));
    });
    request.on('timeout', () => request.destroy(new Error('HEALTH_TIMEOUT')));
    request.on('error', () => reject(new Error('HEALTH_UNAVAILABLE')));
  });
}
function validateHealth(value, expected) {
  const runtime = value?.runtime, integrity = value?.configurationIntegrity;
  guard(runtime?.pid === expected.pid && runtime.cwd === expected.project
    && runtime.sourcePath === `${expected.project}/src/index.js` && runtime.gitCommit === expected.commit
    && runtime.dbPath === expected.dbPath && value.database?.dbPath === expected.dbPath,
  'HEALTH_RUNTIME_IDENTITY_MISMATCH');
  guard(integrity?.status === 'MATCH' && integrity.headCommit === expected.commit
    && integrity.warnings?.length === 0 && Array.isArray(integrity.files)
    && new Set(integrity.files.map((file) => file.file)).size === integrity.files.length
    && CRITICAL_FILES.every((name) => integrity.files.some((file) => file.file === name && file.status === 'MATCH'))
    && integrity.files.every((file) => file.status === 'MATCH'), 'HEALTH_SOURCE_INTEGRITY_MISMATCH');
  validateSummary(integrity.configSummary);
  guard(integrity.configSummary.fingerprint === expected.configFingerprint, 'HEALTH_CONFIG_DIFFERS_FROM_PREFLIGHT');
  guard(value.status === 'streaming' && ['HEALTHY', 'BACKLOG'].includes(value.database?.writeStatus)
    && value.database.consecutiveWriteErrors === 0 && value.runtimeSnapshot?.status !== 'STALE'
    && !value.runtimeSnapshot?.errors?.length, 'HEALTH_NOT_READY');
  guard(Number.isFinite(value.database.lastPersistedTradeAt) && Number.isFinite(value.database.lastFlushAt), 'PERSISTENCE_EVIDENCE_MISSING');
  return { lastPersistedTradeAt: value.database.lastPersistedTradeAt, lastFlushAt: value.database.lastFlushAt };
}
function validateQuiescent(value) {
  const trading = value.trading, db = value.database;
  guard(trading?.activePositions === 0 && trading.pendingActions === 0 && trading.unsettledOrders === 0
    && trading.activeMintEntryLocks === 0,
    'LIVE_POSITIONS_OR_PENDING_ACTIONS_NOT_CLEAR');
  const now = Date.now();
  guard(Number.isFinite(trading.unsettledOrdersUpdatedAt) && now - trading.unsettledOrdersUpdatedAt <= 90000
    && now >= trading.unsettledOrdersUpdatedAt && Number.isFinite(trading.activeMintEntryLocksUpdatedAt)
    && now - trading.activeMintEntryLocksUpdatedAt <= 120000 && now >= trading.activeMintEntryLocksUpdatedAt,
  'LIVE_PENDING_EVIDENCE_STALE');
  guard(trading.killSwitchActive === true, 'OPERATOR_KILL_SWITCH_REQUIRED');
  guard(db?.pendingWrites === 0 && db.pendingLabelWrites === 0 && db.pendingTokenWrites === 0
    && db.consecutiveWriteErrors === 0 && db.writeStatus === 'HEALTHY', 'DATABASE_DRAIN_NOT_CLEAR');
}
function databaseIdentity(project, storage) {
  const file = path.resolve(project, storage.dbPath);
  const stat = fs.statSync(file, { bigint: true });
  guard(stat.isFile(), 'DATABASE_NOT_A_REGULAR_FILE');
  return { path: file, realPath: fs.realpathSync(file), device: stat.dev.toString(), inode: stat.ino.toString() };
}
function sameDatabase(evidence) {
  guard(JSON.stringify(databaseIdentity(evidence.project, evidence.storage)) === JSON.stringify(evidence.database), 'DATABASE_IDENTITY_CHANGED');
}
function killSwitchFile(project, env) {
  const file = path.resolve(project, env.FLOW_LIVE_KILL_SWITCH_FILE || './data/LIVE_TRADING_DISABLED');
  guard(ABS_PATH.test(file) && file.startsWith(`${project}/data/`), 'KILL_SWITCH_PATH_REQUIRES_MANUAL_DEPLOY');
  const stat = fs.lstatSync(file);
  guard(stat.isFile() && !stat.isSymbolicLink(), 'OPERATOR_KILL_SWITCH_REQUIRED');
  return file;
}
function progressed(first, second) {
  return second.lastPersistedTradeAt > first.lastPersistedTradeAt && second.lastFlushAt > first.lastFlushAt;
}
function checkDisk(project, head, config, runGit) {
  const integrity = collectRuntimeIntegrity({ projectDir: project, runtimeConfig: config, expectedCommit: head, runGit });
  guard(integrity.status === 'MATCH' && integrity.expectedCommitMatches && !integrity.warnings.length, 'DISK_INTEGRITY_FAILED');
}
function policyFingerprint(service) {
  // systemd clears ControlGroup after clean stop and embeds per-run timestamps
  // in ExecStart. Freeze the configured executable/argv, not those live fields.
  const exec = /^\{\s*path=([^;]+?)\s*;\s*argv\[\]=([^;]+?)\s*;/.exec(service.ExecStart || '');
  guard(exec, 'UNIT_EXECSTART_UNKNOWN');
  return sha(JSON.stringify([exec.slice(1), PROPERTIES.filter((key) => !['ActiveState', 'SubState',
    'MainPID', 'ExecStart', 'ControlGroup', 'ExecMainCode', 'ExecMainStatus', 'NRestarts', 'InvocationID']
    .includes(key)).map((key) => [key, service[key]])]));
}
async function preflight(options) {
  guard(process.platform === 'linux' && process.getuid?.() === 0, 'LINUX_ROOT_REQUIRED_FOR_COMPLETE_PROC_INSPECTION');
  guard(Number(process.versions.node.split('.')[0]) >= 22, 'NODE_22_REQUIRED');
  guard(fs.realpathSync(options.project) === options.project && options.project !== '/', 'PROJECT_NOT_CANONICAL');
  const service = systemd(options.unit);
  servicePolicy(service, options);
  const uid = Number(command('id', ['-u', service.User]).toString().trim());
  guard(fs.statSync(options.project).uid === uid, 'PROJECT_OWNER_DIFFERS_FROM_SERVICE_USER');
  const environment = readEnvironment(options.project);
  const main = proc(Number(service.MainPID));
  validateMain(service, main, options, environment.env);
  const runGit = gitFor(options.project, service.User);
  guard(runGit(['rev-parse', '--show-toplevel']).toString().trim() === options.project, 'PROJECT_NOT_GIT_ROOT');
  const killSwitch = killSwitchFile(options.project, environment.env);
  const allowedUntracked = [path.posix.relative(options.project, killSwitch)];
  const snapshot = gitSnapshot(runGit, options.target, null, allowedUntracked);
  const configs = checkTarget(runGit, snapshot, options.target, environment.env, options.project);
  checkDisk(options.project, snapshot.head, configs.before, runGit);
  const pids = processInventory(options.project, service.ControlGroup, configs.before.storage, main.pid);
  guard(pids.includes(main.pid), 'MAIN_NOT_IN_UNIT_INVENTORY');
  const evidence = { project: options.project, unit: options.unit, target: options.target, user: service.User,
    oldHead: snapshot.head, oldPid: main.pid, oldBirth: main.birth, oldInvocation: service.InvocationID,
    cgroup: service.ControlGroup, policy: policyFingerprint(service), environment: environment.digest,
    storage: { dbPath: configs.before.storage.dbPath, rawShardDir: configs.before.storage.rawShardDir,
      rawShardingEnabled: configs.before.storage.rawShardingEnabled }, port: configs.before.server.port,
    beforeFingerprint: collectSafeConfigSummary(configs.before).fingerprint,
    afterFingerprint: collectSafeConfigSummary(configs.after).fingerprint, changedFiles: snapshot.changed.length,
    acceptTimeout: options.acceptTimeout, database: databaseIdentity(options.project, configs.before.storage),
    killSwitch, allowedUntracked };
  guard(path.resolve(options.project, configs.before.liveTrading.killSwitchFile) === killSwitch
    && path.resolve(options.project, configs.after.liveTrading.killSwitchFile) === killSwitch, 'KILL_SWITCH_CONFIG_CHANGED');
  const live = await health(evidence.port);
  evidence.baseline = validateHealth(live, { pid: main.pid, project: options.project,
    commit: snapshot.head, configFingerprint: evidence.beforeFingerprint, dbPath: evidence.database.path });
  validateQuiescent(live);
  const again = systemd(options.unit);
  guard(again.MainPID === service.MainPID && again.InvocationID === service.InvocationID
    && policyFingerprint(again) === evidence.policy, 'SERVICE_CHANGED_DURING_PREFLIGHT');
  return evidence;
}
function stopped(evidence, updated = false) {
  const service = systemd(evidence.unit);
  servicePolicy(service, evidence, { stopped: true });
  guard(policyFingerprint(service) === evidence.policy, 'UNIT_POLICY_CHANGED');
  guard(service.ActiveState === 'inactive' && service.SubState === 'dead' && Number(service.MainPID) === 0
    && Number(service.ExecMainCode) === 1 && Number(service.ExecMainStatus) === 0, 'SERVICE_DID_NOT_EXIT_CLEANLY');
  try { guard(proc(evidence.oldPid).birth !== evidence.oldBirth, 'OLD_PROCESS_STILL_ALIVE'); }
  catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  guard(processInventory(evidence.project, evidence.cgroup, evidence.storage, 0).length === 0, 'SERVICE_CGROUP_NOT_EMPTY');
  const environment = readEnvironment(evidence.project);
  guard(environment.digest === evidence.environment, 'ENV_CHANGED_DURING_UPDATE');
  guard(killSwitchFile(evidence.project, environment.env) === evidence.killSwitch, 'KILL_SWITCH_CONFIG_CHANGED');
  sameDatabase(evidence);
  const runGit = gitFor(evidence.project, evidence.user);
  const snapshot = gitSnapshot(runGit, evidence.target, updated ? evidence.target : evidence.oldHead, evidence.allowedUntracked);
  const config = loadConfig((file) => runGit(['show', `${snapshot.head}:${file}`]).toString(), environment.env);
  guard(collectSafeConfigSummary(config).fingerprint === (updated ? evidence.afterFingerprint : evidence.beforeFingerprint), 'CONFIG_CHANGED_DURING_UPDATE');
  checkDisk(evidence.project, snapshot.head, config, runGit);
}
async function accept(evidence) {
  // Poll reads only. Neither this loop nor its failure handler can restart a unit.
  const deadline = Date.now() + evidence.acceptTimeout * 1000;
  let first = null, firstPid = null, invocation = null, restarts = null, lastCode = 'STARTUP_NOT_READY';
  while (Date.now() < deadline) {
    const service = systemd(evidence.unit);
    servicePolicy(service, evidence);
    guard(policyFingerprint(service) === evidence.policy, 'UNIT_POLICY_CHANGED');
    guard(!['failed', 'inactive', 'deactivating'].includes(service.ActiveState), 'SERVICE_FAILED_AFTER_START');
    const pid = Number(service.MainPID);
    if (pid > 1) {
      if (firstPid == null) { firstPid = pid; invocation = service.InvocationID; restarts = service.NRestarts; }
      guard(pid === firstPid && service.InvocationID === invocation && service.NRestarts === restarts, 'SERVICE_RESTARTED_DURING_ACCEPTANCE');
      const environment = readEnvironment(evidence.project);
      guard(environment.digest === evidence.environment, 'ENV_CHANGED_DURING_UPDATE');
      guard(killSwitchFile(evidence.project, environment.env) === evidence.killSwitch, 'KILL_SWITCH_CONFIG_CHANGED');
      sameDatabase(evidence);
      validateMain(service, proc(pid), evidence, environment.env);
      guard(service.InvocationID !== evidence.oldInvocation, 'SERVICE_INVOCATION_DID_NOT_CHANGE');
      try {
        const sample = validateHealth(await health(evidence.port), { pid, project: evidence.project,
          commit: evidence.target, configFingerprint: evidence.afterFingerprint, dbPath: evidence.database.path });
        processInventory(evidence.project, evidence.cgroup, evidence.storage, pid);
        if (!first) first = sample;
        else if (progressed(first, sample) && sample.lastPersistedTradeAt > evidence.baseline.lastPersistedTradeAt) return;
      } catch (error) {
        if (!['HEALTH_UNAVAILABLE', 'HEALTH_NOT_READY', 'PERSISTENCE_EVIDENCE_MISSING',
          'HEALTH_RUNTIME_IDENTITY_MISMATCH'].includes(error.message)) throw error;
        lastCode = error.message;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(first ? 'NO_CONFIRMED_PERSISTED_TRADE_PROGRESS' : lastCode);
}
function parseArgs(args) {
  const options = { phase: 'preflight' };
  for (const arg of args) {
    const match = /^--(project|unit|expected-commit|accept-timeout|phase|field)=(.+)$/.exec(arg);
    guard(match, 'USAGE_REQUIRED_PROJECT_UNIT_EXPECTED_COMMIT');
    const key = match[1] === 'expected-commit' ? 'target' : match[1] === 'accept-timeout' ? 'acceptTimeout' : match[1];
    guard(key === 'phase' || options[key] === undefined, 'DUPLICATE_ARGUMENT');
    options[key] = match[2];
  }
  guard(ABS_PATH.test(options.project || '') && options.project !== '/' && !options.project.endsWith('/')
    && /^[A-Za-z0-9_-]+\.service$/.test(options.unit || '') && HASH.test(options.target || ''), 'USAGE_REQUIRED_PROJECT_UNIT_EXPECTED_COMMIT');
  options.acceptTimeout = options.acceptTimeout == null ? 600 : Number(options.acceptTimeout);
  guard(Number.isInteger(options.acceptTimeout) && options.acceptTimeout >= 60 && options.acceptTimeout <= 900, 'ACCEPT_TIMEOUT_MUST_BE_60_TO_900_SECONDS');
  return options;
}
async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.phase === 'preflight') return process.stdout.write(`${JSON.stringify(await preflight(options))}\n`);
  const evidence = JSON.parse(fs.readFileSync(0, 'utf8'));
  guard(evidence.project === options.project && evidence.unit === options.unit && evidence.target === options.target
    && evidence.acceptTimeout === options.acceptTimeout, 'EVIDENCE_ARGUMENT_MISMATCH');
  if (options.phase === 'field') {
    guard(['project', 'unit', 'user', 'target'].includes(options.field), 'INVALID_EVIDENCE_FIELD');
    process.stdout.write(`${evidence[options.field]}\n`);
  } else if (options.phase === 'describe') {
    process.stdout.write(`Preflight passed: ${evidence.unit}, PID ${evidence.oldPid}, ${evidence.oldHead} -> ${evidence.target}; ${evidence.changedFiles} changed files. No changes made by preflight.\n`);
  } else if (options.phase === 'stopped' || options.phase === 'updated') stopped(evidence, options.phase === 'updated');
  else if (options.phase === 'accept') await accept(evidence);
  else throw new Error('UNKNOWN_PHASE');
}
if (require.main === module) main().catch((error) => {
  const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'CHECK_FAILED_DETAILS_SUPPRESSED';
  process.stderr.write(`Safe update check failed: ${code}. No corrective process or database action was taken by the checker.\n`);
  process.exitCode = 1;
});
module.exports = { parseProperties, stopSeconds, servicePolicy, parseEnvironment, ownsCgroup,
  validateChanges, gitSnapshot, loadConfig, validateSummary, validateHealth, validateQuiescent,
  progressed, parseArgs, versionSatisfies };
