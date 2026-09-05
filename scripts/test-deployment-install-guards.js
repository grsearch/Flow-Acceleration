'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectDir = path.resolve(__dirname, '..');
const installSource = fs.readFileSync(path.join(projectDir, 'deploy/install.sh'), 'utf8');
const serviceSource = fs.readFileSync(path.join(projectDir, 'deploy/flow-acceleration.service'), 'utf8');
const pm2 = require('../deploy/ecosystem.config.cjs').apps[0];
assert(!installSource.includes('\r'), 'the Linux installer must use LF line endings');

function findBash() {
  const candidates = [process.env.FLOW_INSTALL_TEST_BASH, 'bash'];
  if (process.platform === 'win32') {
    const git = spawnSync('where.exe', ['git'], { encoding: 'utf8' });
    for (const executable of (git.stdout || '').trim().split(/\r?\n/).filter(Boolean)) {
      const gitRoot = path.resolve(path.dirname(executable), '..');
      candidates.push(path.join(gitRoot, 'bin/bash.exe'), path.join(gitRoot, 'usr/bin/sh.exe'));
    }
  }
  for (const candidate of candidates.filter(Boolean)) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (result.status === 0 && /GNU bash/.test(result.stdout)) return candidate;
  }
  throw new Error('Bash is required for installer guard tests; set FLOW_INSTALL_TEST_BASH to its executable.');
}

function shellPath(value) {
  return process.platform === 'win32'
    ? value.replace(/\\/g, '/').replace(/^([a-z]):/i, (_, drive) => `/${drive.toLowerCase()}`)
    : value;
}

const bash = findBash();
const syntax = spawnSync(bash, ['-n'], { input: installSource, encoding: 'utf8', timeout: 10_000 });
assert.equal(syntax.status, 0, syntax.stderr || syntax.error?.message);

// Execute the actual read-only guard section, with only systemctl replaced.
// The root check and all installer mutations are outside this section: these
// tests never call sudo, rsync, chown, package installation, or real services.
const guardStart = installSource.indexOf('# This entry point bootstraps');
const guardEnd = installSource.indexOf('\nif ! id "$SERVICE_USER"', guardStart);
assert(guardStart > 0 && guardEnd > guardStart, 'installer preflight boundaries must remain explicit');
const guardSource = installSource.slice(guardStart, guardEnd);
assert.equal((installSource.match(/^assert_fresh_install_target$/gm) || []).length, 2);
assert.match(installSource, /assert_fresh_install_target\nmkdir -p "\$INSTALL_DIR"\nrsync -a/);
assert.match(installSource, /--ignore-existing/);
for (const excluded of ['.git', '/data/', '/logs/', '.env']) {
  assert(installSource.includes(`--exclude='${excluded}'`), `installer must not copy ${excluded}`);
}
assert(!/^\s*systemctl\s+(?:restart|reload|try-restart)\b/m.test(installSource));
assert(installSource.includes('systemctl start "$SERVICE_NAME"'));
assert(installSource.includes('deploy/safe-update.sh'));

const unit = Object.fromEntries(serviceSource.split(/\r?\n/)
  .filter((line) => /^[A-Za-z][A-Za-z0-9]*=/.test(line))
  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
assert.equal(unit.KillMode, 'mixed', 'TERM must reach the coordinator before its workers');
assert.equal(unit.KillSignal, 'SIGTERM');
assert.equal(unit.SendSIGKILL, 'no', 'failed drains must survive the stop deadline');
assert.match(unit.TimeoutStopSec, /^\d+s?$/);
assert(parseInt(unit.TimeoutStopSec, 10) >= 120 && parseInt(unit.TimeoutStopSec, 10) <= 600);
assert.equal(pm2.autorestart, false);
assert.equal(pm2.watch, false);
assert.equal(pm2.max_memory_restart, undefined);
assert.equal(pm2.cron_restart, undefined);

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-install-guards-'));
const sourceDir = path.join(temporaryDir, 'source');
const installedUnit = path.join(temporaryDir, 'existing.service');
fs.mkdirSync(sourceDir);
fs.writeFileSync(path.join(sourceDir, 'source-marker'), 'SOURCE_MUST_REMAIN_UNCHANGED');
const absentState = 'LoadState=not-found\nActiveState=inactive\nMainPID=0';
let cases = 0;

function check(name, destination, expectedAccepted, options = {}) {
  const harness = `set -euo pipefail
export PATH="/usr/bin:/bin:$PATH"
PROJECT_DIR="$1"
INSTALL_DIR="$2"
SERVICE_FILE="$3"
SERVICE_NAME=flow-acceleration
systemctl() {
  [[ "$*" == 'show flow-acceleration.service --property=LoadState --property=ActiveState --property=MainPID' ]] || return 97
  printf '%s\\n' "$MOCK_UNIT_STATE"
  return "$MOCK_UNIT_EXIT"
}
${guardSource}
${options.afterFirstCheck || ''}
printf 'PREFLIGHT_ACCEPTED\\n'
`;
  const result = spawnSync(bash, ['-s', '--', shellPath(sourceDir), shellPath(destination),
    shellPath(options.serviceFile || path.join(temporaryDir, 'not-installed.service'))], {
    input: harness,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, MOCK_UNIT_STATE: options.state ?? absentState, MOCK_UNIT_EXIT: String(options.exit ?? 0) },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.status, expectedAccepted ? 0 : 1, `${name}: ${output || result.error?.message}`);
  assert.equal(output.includes('PREFLIGHT_ACCEPTED'), expectedAccepted, name);
  if (!expectedAccepted) {
    assert(output.includes('Initial installation refused:'), `${name}: ${output}`);
    assert(output.includes('deploy/safe-update.sh'), `${name}: must identify the update entry point`);
  }
  cases += 1;
}

try {
  const freshDir = path.join(temporaryDir, 'fresh');
  check('brand-new installation', freshDir, true);
  assert(!fs.existsSync(freshDir), 'preflight must not create the destination');
  const emptyDir = path.join(temporaryDir, 'empty');
  fs.mkdirSync(emptyDir);
  check('empty destination', emptyDir, true);
  check('source checkout as destination', sourceDir, false);
  check('source ancestor as destination', temporaryDir, false);
  check('destination inside source checkout', path.join(sourceDir, 'new-deployment'), false);
  check('filesystem root', '/', false);
  check('relative destination', 'relative-target', false);

  for (const file of ['.env', '.git/config', 'data/research.db', 'src/config.js']) {
    const destination = path.join(temporaryDir, `populated-${cases}`);
    const existingFile = path.join(destination, file);
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, `DO_NOT_OVERWRITE:${file}`);
    check(`existing ${file}`, destination, false);
    assert.equal(fs.readFileSync(existingFile, 'utf8'), `DO_NOT_OVERWRITE:${file}`);
  }

  const nonDirectory = path.join(temporaryDir, 'regular-file');
  fs.writeFileSync(nonDirectory, 'DO_NOT_OVERWRITE');
  check('destination is a file', nonDirectory, false);
  const linkedDir = path.join(temporaryDir, 'linked-source');
  fs.symlinkSync(sourceDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  check('symbolic link destination', linkedDir, false);

  check('existing inactive service', freshDir, false, {
    state: 'LoadState=loaded\nActiveState=inactive\nMainPID=0',
  });
  check('active service', freshDir, false, {
    state: 'LoadState=loaded\nActiveState=active\nMainPID=123',
  });
  check('residual process', freshDir, false, {
    state: 'LoadState=not-found\nActiveState=inactive\nMainPID=123',
  });
  check('unknown service state', freshDir, false, { state: '' });
  check('service query failure', freshDir, false, { exit: 1 });
  fs.writeFileSync(installedUnit, 'EXISTING_UNIT_MUST_REMAIN_UNCHANGED');
  check('existing service file', freshDir, false, { serviceFile: installedUnit });
  assert.equal(fs.readFileSync(installedUnit, 'utf8'), 'EXISTING_UNIT_MUST_REMAIN_UNCHANGED');

  check('destination populated between checks', emptyDir, false, {
    afterFirstCheck: ': > "$INSTALL_DIR/late-data.db"\nassert_fresh_install_target',
  });
  assert.equal(fs.readFileSync(path.join(sourceDir, 'source-marker'), 'utf8'), 'SOURCE_MUST_REMAIN_UNCHANGED');
  console.log(`Deployment install guards passed (${cases} isolated Bash scenarios; service/PM2 checks passed).`);
} finally {
  // Only the unique directory created by this test is ever removed.
  fs.rmSync(temporaryDir, { recursive: true, force: true });
}
