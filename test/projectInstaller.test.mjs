import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, symlink, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  applyProjectConfig, checkSkills, installSkills, loadSkillBundle, mergeEnvExample,
  parseSkillSelection, probeRequirements, setupProject, validateBundle, validateConfigDocument,
} from '../lib/project-installer.mjs';

const INTEGRATION_ROOT = '.builder/skills/antom-integration';
const RECONCILIATION_ROOT = '.builder/skills/antom-reconciliation-expert';
const SETTINGS = Object.freeze({
  clientId: 'example-client', antomPublicKey: '', environment: 'sandbox',
  keyVersion: '1', gatewayOrigin: 'https://open-sea-global.alipay.com',
});
const CONFIG = { formatVersion: 1, settings: SETTINGS };
const configWithMode = (authMode) => ({ formatVersion: 2, settings: { ...SETTINGS, authMode } });
const CLI = fileURLToPath(new URL('../bin/antom-builder.mjs', import.meta.url));

function file(filePath, content = '# Example skill\n') {
  return { path: filePath, content, sha256: createHash('sha256').update(content).digest('hex') };
}

function fixtureBundle() {
  return {
    formatVersion: 1, package: { name: 'test-package', version: '1.0.0' },
    skills: [
      { id: 'integration', name: 'Payment', requirements: [], limitations: [], files: [
        file(`${INTEGRATION_ROOT}/SKILL.md`),
        file(`${INTEGRATION_ROOT}/references/config.md`, 'Preserve upstream content.\n'),
      ] },
      { id: 'reconciliation', name: 'Reconciliation', requirements: ['python', 'openpyxl'], limitations: ['Supplied-file analysis only.'], files: [
        file(`${RECONCILIATION_ROOT}/SKILL.md`),
        file(`${RECONCILIATION_ROOT}/scripts/cli.py`, 'print("example only")\n'),
      ] },
    ],
  };
}

async function temporaryProject(t) {
  const base = await realpath(tmpdir());
  const project = await mkdtemp(path.join(base, 'antom-installer-test-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  return project;
}

async function configFile(project, contents = CONFIG) {
  const config = path.join(project, 'antom-config.json');
  await writeFile(config, JSON.stringify(contents));
  return config;
}

async function createTestSymlink(t, target, linkPath, type) {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'ENOTSUP'].includes(error.code)) {
      t.skip('This Windows account cannot create symlinks; enable Developer Mode or symlink privileges to run this guard test.');
      return false;
    }
    throw error;
  }
}

test('installer creates complete selected skills and repeat installs skip identical files', async (t) => {
  const projectPath = await temporaryProject(t);
  const bundle = fixtureBundle();
  await writeFile(path.join(projectPath, 'application.txt'), 'unrelated');
  const first = await installSkills({ projectPath, bundle, skills: ['integration', 'reconciliation'] });
  assert.equal(first.written.length, 4);
  for (const skill of bundle.skills) {
    for (const asset of skill.files) assert.equal(await readFile(path.join(projectPath, asset.path), 'utf8'), asset.content);
  }
  const repeated = await installSkills({ projectPath, bundle, skills: ['integration', 'reconciliation'] });
  assert.equal(repeated.written.length, 0);
  assert.equal(repeated.skipped.length, 4);
  assert.equal(await readFile(path.join(projectPath, 'application.txt'), 'utf8'), 'unrelated');
});

test('dry run validates without creating any directory or file', async (t) => {
  const projectPath = await temporaryProject(t);
  const result = await installSkills({ projectPath, bundle: fixtureBundle(), dryRun: true });
  assert.equal(result.planned.length, 2);
  assert.equal(result.written.length, 0);
  assert.deepEqual(await readdir(projectPath), []);
});

test('all existing file conflicts are preflighted before writing missing files', async (t) => {
  const projectPath = await temporaryProject(t);
  await mkdir(path.join(projectPath, INTEGRATION_ROOT, 'references'), { recursive: true });
  const custom = path.join(projectPath, INTEGRATION_ROOT, 'references/config.md');
  await writeFile(custom, 'user changes');
  await assert.rejects(installSkills({ projectPath, bundle: fixtureBundle() }), /No files were written/);
  await assert.rejects(readFile(path.join(projectPath, INTEGRATION_ROOT, 'SKILL.md')), { code: 'ENOENT' });
  assert.equal(await readFile(custom, 'utf8'), 'user changes');
});

test('installer checks every selected asset hash before creating anything', async (t) => {
  const projectPath = await temporaryProject(t);
  const bundle = fixtureBundle();
  bundle.skills[1].files[1].content = 'tampered';
  await assert.rejects(installSkills({ projectPath, bundle, skills: ['integration', 'reconciliation'] }), /integrity/);
  assert.deepEqual(await readdir(projectPath), []);
});

test('bundle rejects traversal, absolute, Windows, and cross-skill paths', () => {
  const badPaths = [
    '../outside', '/tmp/outside', `${INTEGRATION_ROOT}/../outside`,
    `${INTEGRATION_ROOT}/nested\\outside`, `${INTEGRATION_ROOT}/C:outside`,
    `${INTEGRATION_ROOT}//file`, `${INTEGRATION_ROOT}/CON.txt`,
    `${INTEGRATION_ROOT}/file.`, `${INTEGRATION_ROOT}/bad\nname`,
    `${RECONCILIATION_ROOT}/SKILL.md`,
  ];
  for (const assetPath of badPaths) {
    const bundle = fixtureBundle();
    bundle.skills[0].files.push(file(assetPath));
    assert.throws(() => validateBundle(bundle), /unsafe/);
  }
});

test('bundle rejects duplicate paths, case collisions, parent-file collisions, and missing skill entries', () => {
  for (const duplicatePath of [`${INTEGRATION_ROOT}/SKILL.md`, `${INTEGRATION_ROOT}/skill.md`]) {
    const bundle = fixtureBundle();
    bundle.skills[0].files.push(file(duplicatePath));
    assert.throws(() => validateBundle(bundle), /duplicate/);
  }
  const parentCollision = fixtureBundle();
  parentCollision.skills[0].files.push(file(`${INTEGRATION_ROOT}/references`));
  assert.throws(() => validateBundle(parentCollision), /directory path/);
  const missingSkill = fixtureBundle();
  missingSkill.skills[0].files.shift();
  assert.throws(() => validateBundle(missingSkill), /missing SKILL/);
  assert.throws(() => validateBundle({ formatVersion: 2, skills: [] }), /format/);
  assert.throws(() => parseSkillSelection('integration,unknown'), /Select/);
  assert.deepEqual(parseSkillSelection('integration,integration'), ['integration']);
});

test('installer rejects symlinked .builder and symlinked files without touching their destinations', async (t) => {
  const projectPath = await temporaryProject(t);
  const outside = await temporaryProject(t);
  if (!(await createTestSymlink(t, outside, path.join(projectPath, '.builder'), 'dir'))) return;
  await assert.rejects(installSkills({ projectPath, bundle: fixtureBundle() }), /Symbolic links/);
  assert.deepEqual(await readdir(outside), []);
  await rm(path.join(projectPath, '.builder'));
  await mkdir(path.join(projectPath, INTEGRATION_ROOT), { recursive: true });
  const destination = path.join(outside, 'original.md');
  await writeFile(destination, 'original');
  if (!(await createTestSymlink(t, destination, path.join(projectPath, INTEGRATION_ROOT, 'SKILL.md'), 'file'))) return;
  await assert.rejects(installSkills({ projectPath, bundle: fixtureBundle() }), /Symbolic links/);
  assert.equal(await readFile(destination, 'utf8'), 'original');
});

test('installer rejects symlinked project directories and hard-linked target files', async (t) => {
  const projectPath = await temporaryProject(t);
  const outside = await temporaryProject(t);
  const alias = path.join(outside, 'linked-project');
  if (!(await createTestSymlink(t, projectPath, alias, 'dir'))) return;
  await assert.rejects(installSkills({ projectPath: alias, bundle: fixtureBundle() }), /Symbolic links/);
  await mkdir(path.join(projectPath, INTEGRATION_ROOT), { recursive: true });
  const destination = path.join(outside, 'original.md');
  await writeFile(destination, '# Example skill\n');
  await link(destination, path.join(projectPath, INTEGRATION_ROOT, 'SKILL.md'));
  await assert.rejects(installSkills({ projectPath, bundle: fixtureBundle() }), /hard links/);
  assert.equal(await readFile(destination, 'utf8'), '# Example skill\n');
});

test('trusted packaged bundle supports store hardlinks without allowing hardlinked project/config targets', async (t) => {
  const projectPath = await temporaryProject(t);
  const source = path.join(projectPath, 'store-bundle.json');
  const packaged = path.join(projectPath, 'package-bundle.json');
  await writeFile(source, JSON.stringify(fixtureBundle()));
  await link(source, packaged);
  assert.deepEqual(await loadSkillBundle(packaged), fixtureBundle());
  await assert.rejects(applyProjectConfig({ projectPath, filePath: packaged }), /hard links/);
});

test('check reports actual missing, intact, and modified files and explicit unverified prerequisites', async (t) => {
  const projectPath = await temporaryProject(t);
  const bundle = fixtureBundle();
  const probe = (requirements) => requirements.map((id) => ({ id, status: id === 'python' ? 'available' : 'unverified' }));
  const options = { projectPath, bundle, skills: ['integration', 'reconciliation'], probe };
  const empty = await checkSkills(options);
  assert.equal(empty.ok, false);
  assert.ok(empty.files.every((asset) => asset.status === 'missing'));
  await installSkills(options);
  const installed = await checkSkills(options);
  assert.equal(installed.filesOk, true);
  assert.equal(installed.runtimeReady, false);
  assert.equal(installed.ok, false);
  assert.deepEqual(installed.requirements.map((item) => item.status), ['available', 'unverified']);
  assert.deepEqual(installed.limitations, ['Supplied-file analysis only.']);
  const ready = await checkSkills({ ...options, probe: (ids) => ids.map((id) => ({ id, status: 'available' })) });
  assert.equal(ready.ok, true);
  assert.equal(ready.runtimeReady, true);
  await writeFile(path.join(projectPath, INTEGRATION_ROOT, 'SKILL.md'), 'custom');
  const changed = await checkSkills(options);
  assert.equal(changed.ok, false);
  assert.equal(changed.files[0].status, 'modified');
  assert.equal((await checkSkills({ ...options, probe: () => [{ id: 'python', status: 'missing' }] })).ok, false);
});

test('runtime probe discovers only allowlisted top-level Python modules in isolated mode', () => {
  const calls = [];
  const results = probeRequirements(['python', 'openpyxl', 'requests', 'jsonschema'], {
    runCommand(command, args) {
      calls.push({ command, args });
      return args[0] === '--version'
        ? { ok: true, stdout: 'Python 3.12.0', stderr: '' }
        : { ok: true, stdout: JSON.stringify({ openpyxl: true, requests: false, jsonschema: false }), stderr: '' };
    },
  });
  assert.deepEqual(results.map(({ status }) => status), ['available', 'available', 'missing', 'missing']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { command: 'python3', args: ['--version'] });
  assert.deepEqual(calls[1].args.slice(0, 2), ['-I', '-c']);
  assert.match(calls[1].args[2], /importlib\.util\.find_spec/);
  assert.doesNotMatch(calls[1].args[2], /import (openpyxl|requests|jsonschema)/);
  assert.ok(results.every(({ detail }) => !detail.includes('/Users/')));
});

test('runtime probe failures remain unverified and never display arbitrary interpreter output', () => {
  const failure = probeRequirements(['python', 'requests', 'jsonschema'], {
    runCommand: (_command, args) => args[0] === '--version'
      ? { ok: true, stdout: 'Python 3.12.0', stderr: '' }
      : { ok: false, stdout: 'never-print-me', stderr: 'never-print-me' },
  });
  assert.deepEqual(failure.map(({ status }) => status), ['available', 'unverified', 'unverified']);
  assert.ok(!JSON.stringify(failure).includes('never-print-me'));
  const absent = probeRequirements(['python', 'requests'], { runCommand: () => ({ ok: false, stdout: '', stderr: '' }) });
  assert.deepEqual(absent.map(({ status }) => status), ['missing', 'unverified']);
  const unknown = probeRequirements(['unsupported-module'], { runCommand: () => { throw new Error('Must not run'); } });
  assert.equal(unknown[0].status, 'unverified');
});

test('config creates only .env.example and repeated application is a no-op', async (t) => {
  const projectPath = await temporaryProject(t);
  const filePath = await configFile(projectPath);
  await writeFile(path.join(projectPath, '.env'), 'DO_NOT_READ_OR_MODIFY=secret');
  const first = await applyProjectConfig({ projectPath, filePath });
  assert.equal(first.changed, true);
  const example = await readFile(path.join(projectPath, '.env.example'), 'utf8');
  assert.match(example, /ANTOM_CLIENT_ID="example-client"/);
  assert.match(example, /ANTOM_AUTH_MODE="rsa"\n/);
  assert.match(example, /ANTOM_API_KEY=\n/);
  assert.match(example, /ANTOM_MERCHANT_PRIVATE_KEY=\n/);
  assert.equal((await applyProjectConfig({ projectPath, filePath })).changed, false);
  assert.equal(await readFile(path.join(projectPath, '.env'), 'utf8'), 'DO_NOT_READ_OR_MODIFY=secret');
  assert.deepEqual((await readdir(projectPath)).sort(), ['.env', '.env.example', 'antom-config.json']);
});

test('config merge preserves unrelated variables, comments, multiline examples, currency, and CRLF', () => {
  const existing = [
    '# Project examples', 'OTHER="first', 'second" # Keep multiline',
    'export ANTOM_CLIENT_ID="old" # Merchant example',
    "ANTOM_MERCHANT_PRIVATE_KEY='private", "key' # Fill manually",
    'ANTOM_DEFAULT_CURRENCY=USD', 'PORT=3000', '',
  ].join('\r\n');
  const merged = mergeEnvExample(existing, SETTINGS);
  assert.ok(merged.includes('# Project examples\r\nOTHER="first\r\nsecond" # Keep multiline'));
  assert.ok(merged.includes('export ANTOM_CLIENT_ID="example-client" # Merchant example'));
  assert.ok(merged.includes('ANTOM_MERCHANT_PRIVATE_KEY= # Fill manually'));
  assert.ok(merged.includes('ANTOM_DEFAULT_CURRENCY=USD'));
  assert.ok(merged.includes('PORT=3000'));
  assert.ok(!merged.includes("private\r\nkey"));
  assert.ok(!/(?<!\r)\n/.test(merged));
  assert.equal(mergeEnvExample(merged, SETTINGS), merged);
});

test('all duplicate managed assignments are reset without preserving a private key value', () => {
  const merged = mergeEnvExample('ANTOM_MERCHANT_PRIVATE_KEY=unsafe\nANTOM_MERCHANT_PRIVATE_KEY="also-unsafe"\n', SETTINGS);
  assert.equal(merged.match(/^ANTOM_MERCHANT_PRIVATE_KEY=$/gm).length, 2);
  assert.ok(!merged.includes('unsafe'));
  const bom = mergeEnvExample('\uFEFFANTOM_MERCHANT_PRIVATE_KEY=unsafe\n', SETTINGS);
  assert.ok(bom.startsWith('\uFEFFANTOM_MERCHANT_PRIVATE_KEY=\n'));
  assert.ok(!bom.includes('unsafe'));
  assert.throws(() => mergeEnvExample('# -----BEGIN PRIVATE KEY-----\n', SETTINGS), /private-key block/);
});

test('versioned configuration preserves legacy RSA and supports either explicit authentication mode', async () => {
  assert.deepEqual(await validateConfigDocument(CONFIG), { ...SETTINGS, authMode: 'rsa' });
  for (const authMode of ['rsa', 'api_key']) {
    assert.deepEqual(await validateConfigDocument(configWithMode(authMode)), { ...SETTINGS, authMode });
  }
});

test('both modes clear duplicate and multiline API-key examples while retaining RSA settings for notify', () => {
  const existing = [
    '# Keep project documentation', 'PORT=3000',
    'ANTOM_AUTH_MODE="old"', 'export ANTOM_AUTH_MODE="duplicate"',
    'ANTOM_API_KEY=unsafe-first', 'export ANTOM_API_KEY="unsafe-second" # Set manually',
    "ANTOM_API_KEY='unsafe", "continuation'", '\uFEFFANTOM_API_KEY=`unsafe-backtick`',
    'ANTOM_MERCHANT_PRIVATE_KEY="unsafe-rsa"', '',
  ].join('\r\n');
  for (const authMode of ['rsa', 'api_key']) {
    const merged = mergeEnvExample(existing, { ...SETTINGS, authMode });
    assert.doesNotMatch(merged, /unsafe|continuation|duplicate/);
    assert.match(merged, /# Keep project documentation\r\nPORT=3000\r\n/);
    assert.match(merged, /export ANTOM_API_KEY= # Set manually\r\n/);
    assert.equal(merged.match(/^(?:export |\uFEFF)?ANTOM_API_KEY=(?: # Set manually)?\r?$/gm).length, 4);
    assert.equal(merged.match(new RegExp(`^(?:export )?ANTOM_AUTH_MODE="${authMode}"\\r?$`, 'gm')).length, 2);
    assert.match(merged, /ANTOM_MERCHANT_PRIVATE_KEY=\r\n/);
    assert.match(merged, /ANTOM_PUBLIC_KEY=""\r\n/);
    assert.match(merged, /ANTOM_KEY_VERSION="1"\r\n/);
    assert.equal(mergeEnvExample(merged, { ...SETTINGS, authMode }), merged);
  }
  assert.throws(() => mergeEnvExample('ANTOM_API_KEY="unterminated', { ...SETTINGS, authMode: 'api_key' }), /unterminated/);
});

test('configuration switches between API Key and RSA without touching runtime secrets', async (t) => {
  const projectPath = await temporaryProject(t);
  const runtime = 'ANTOM_API_KEY=runtime-synthetic\nANTOM_MERCHANT_PRIVATE_KEY=runtime-rsa\n';
  await writeFile(path.join(projectPath, '.env'), runtime);
  const target = path.join(projectPath, '.env.example');
  await writeFile(target, 'PORT=3000\nANTOM_API_KEY=example-secret\nANTOM_MERCHANT_PRIVATE_KEY=example-rsa\n');
  for (const authMode of ['api_key', 'rsa', 'api_key']) {
    const filePath = await configFile(projectPath, configWithMode(authMode));
    assert.equal((await applyProjectConfig({ projectPath, filePath })).changed, true);
    const result = await readFile(target, 'utf8');
    assert.match(result, new RegExp(`ANTOM_AUTH_MODE="${authMode}"\\n`));
    assert.match(result, /ANTOM_API_KEY=\n/);
    assert.match(result, /ANTOM_MERCHANT_PRIVATE_KEY=\n/);
    assert.match(result, /PORT=3000\n/);
    assert.doesNotMatch(result, /example-secret|example-rsa|runtime-/);
    assert.equal((await applyProjectConfig({ projectPath, filePath })).changed, false);
    assert.equal(await readFile(path.join(projectPath, '.env'), 'utf8'), runtime);
  }
});

test('config rejects malformed documents, unknown fields, non-string settings, and private keys', async () => {
  const invalid = [
    null, [], { ...CONFIG, formatVersion: 3 }, { ...CONFIG, formatVersion: '2' },
    { ...CONFIG, formatVersion: 2 }, { ...CONFIG, privateKey: 'never-print-me' },
    { ...CONFIG, settings: { ...SETTINGS, privateKey: 'never-print-me' } },
    { ...CONFIG, settings: { ...SETTINGS, keyVersion: 1 } },
    { ...CONFIG, settings: { ...SETTINGS, antomPublicKey: '-----BEGIN PRIVATE KEY-----\nnever-print-me\n-----END PRIVATE KEY-----' } },
    { ...CONFIG, settings: { ...SETTINGS, gatewayOrigin: 'https://evil.example' } },
    { ...CONFIG, settings: { ...SETTINGS, clientId: 'value\nINJECTED=value' } },
  ];
  for (const document of invalid) {
    await assert.rejects(validateConfigDocument(document), (error) => !error.message.includes('never-print-me'));
  }
  await assert.doesNotReject(validateConfigDocument(CONFIG));
});

test('versioned configuration refuses omitted, unknown, or downgraded modes and all secret/notify overrides', async () => {
  const invalid = [
    { ...configWithMode('api_key'), formatVersion: 1 },
    ...['', 'bearer', 'RSA', 'api_key\nINJECTED=value', ' rsa ', null, false, 1].map(configWithMode),
    ...['apiKey', 'ANTOM_API_KEY', 'merchantPrivateKey', 'privateKey', 'notifyAuthMode', 'notificationAuthMode'].map((key) => ({
      ...configWithMode('api_key'), settings: { ...configWithMode('api_key').settings, [key]: 'never-print-me' },
    })),
    { ...configWithMode('api_key'), apiKey: 'never-print-me' },
  ];
  for (const document of invalid) {
    await assert.rejects(validateConfigDocument(document), (error) => !error.message.includes('never-print-me') && !error.message.includes('INJECTED'));
  }
});

test('config rejects environment inputs, oversize or malformed JSON without modifying the project', async (t) => {
  const projectPath = await temporaryProject(t);
  for (const basename of ['.env', '.env.example', '.env.local', '.env.json', 'antom.env']) {
    await assert.rejects(applyProjectConfig({ projectPath, filePath: path.join(projectPath, basename) }), /never an environment/);
  }
  const filePath = await configFile(projectPath);
  await writeFile(filePath, 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(applyProjectConfig({ projectPath, filePath }), /size limit/);
  await writeFile(filePath, '{invalid-json-never-print-me');
  await assert.rejects(applyProjectConfig({ projectPath, filePath }), /not valid JSON/);
  await assert.rejects(readFile(path.join(projectPath, '.env.example')), { code: 'ENOENT' });
});

test('config rejects input and output symlinks and a hard-linked .env.example', async (t) => {
  const projectPath = await temporaryProject(t);
  const outside = await temporaryProject(t);
  const original = await configFile(outside);
  const filePath = path.join(projectPath, 'antom-config.json');
  if (!(await createTestSymlink(t, original, filePath, 'file'))) return;
  await assert.rejects(applyProjectConfig({ projectPath, filePath }), /Symbolic links/);
  await rm(filePath);
  await configFile(projectPath);
  const secretFile = path.join(outside, '.env');
  await writeFile(secretFile, 'PRIVATE_VALUE=untouched');
  const target = path.join(projectPath, '.env.example');
  if (!(await createTestSymlink(t, secretFile, target, 'file'))) return;
  await assert.rejects(applyProjectConfig({ projectPath, filePath }), /Symbolic links/);
  await rm(target);
  await link(secretFile, target);
  await assert.rejects(applyProjectConfig({ projectPath, filePath }), /hard links/);
  assert.equal(await readFile(secretFile, 'utf8'), 'PRIVATE_VALUE=untouched');
});

test('config refuses malformed multiline, non-text, oversized, or directory targets', async (t) => {
  const projectPath = await temporaryProject(t);
  const filePath = await configFile(projectPath);
  const target = path.join(projectPath, '.env.example');
  for (const contents of ['OTHER="unterminated', 'OTHER="closed" trailing-garbage', 'BINARY=\0', 'x'.repeat(1024 * 1024 + 1)]) {
    await writeFile(target, contents);
    await assert.rejects(applyProjectConfig({ projectPath, filePath }));
    assert.equal(await readFile(target, 'utf8'), contents);
  }
  await rm(target);
  await mkdir(target);
  await assert.rejects(applyProjectConfig({ projectPath, filePath }), /regular files/);
});

test('CLI rejects unknown or duplicate options and keeps errors free of config contents', async (t) => {
  const projectPath = await temporaryProject(t);
  const filePath = await configFile(projectPath, { ...CONFIG, settings: { ...SETTINGS, privateKey: 'never-print-me' } });
  for (const args of [['install', '--force'], ['check', '--skills', 'integration', '--skills', 'integration'], ['config'], ['config', '--file', filePath]]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes('never-print-me'));
    assert.ok(!result.stderr.includes(filePath));
  }
  const help = spawnSync(process.execPath, [CLI, '--help'], { cwd: projectPath, encoding: 'utf8', timeout: 10000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /No dependencies, credentials, payments, or Git/);
});

test('setup installs, configures and checks together, with unchanged files on repeat', async (t) => {
  const projectPath = await temporaryProject(t);
  const target = path.join(projectPath, '.env.example');
  const runtime = 'ANTOM_API_KEY=runtime-secret\nANTOM_MERCHANT_PRIVATE_KEY=runtime-rsa\n';
  await writeFile(path.join(projectPath, '.env'), runtime);
  await writeFile(target, '# Preserve examples\r\nPORT=3000\r\nANTOM_DEFAULT_CURRENCY=USD\r\nANTOM_CLIENT_ID=\r\nANTOM_API_KEY=\r\n');
  const options = { projectPath, bundle: fixtureBundle(), configDocument: configWithMode('api_key') };
  const first = await setupProject(options);
  assert.equal(first.ok, true);
  assert.equal(first.installation.written.length, 2);
  assert.equal(first.configuration.changed, true);
  assert.equal(first.check.filesOk, true);
  const example = await readFile(target, 'utf8');
  assert.match(example, /ANTOM_AUTH_MODE="api_key"\r\n/);
  assert.match(example, /# Preserve examples\r\nPORT=3000\r\nANTOM_DEFAULT_CURRENCY=USD\r\n/);
  assert.match(example, /ANTOM_API_KEY=\r\n/);
  assert.doesNotMatch(example, /example-secret|runtime-secret/);
  const before = await stat(target);
  const repeated = await setupProject(options);
  const after = await stat(target);
  assert.equal(repeated.installation.written.length, 0);
  assert.equal(repeated.configuration.changed, false);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(target, 'utf8'), example);
  assert.equal(await readFile(path.join(projectPath, '.env'), 'utf8'), runtime);
});

test('setup validates format 2 and every setting before any project write', async (t) => {
  const projectPath = await temporaryProject(t);
  const invalid = [
    undefined, null, CONFIG,
    { ...configWithMode('rsa'), settings: { ...SETTINGS, authMode: 'invalid-secret' } },
    { ...configWithMode('rsa'), settings: { ...SETTINGS, authMode: 'rsa', apiKey: 'invalid-secret' } },
    { ...configWithMode('rsa'), settings: { ...SETTINGS, authMode: 'rsa', merchantPrivateKey: 'invalid-secret' } },
    { ...configWithMode('rsa'), settings: { ...SETTINGS, authMode: 'rsa', clientId: 'invalid-secret'.repeat(6000) } },
  ];
  for (const configDocument of invalid) {
    await assert.rejects(setupProject({ projectPath, bundle: fixtureBundle(), configDocument }),
      (error) => !error.message.includes('invalid-secret'));
    assert.deepEqual(await readdir(projectPath), []);
  }
});

test('setup preflights all skill conflicts before applying configuration', async (t) => {
  const projectPath = await temporaryProject(t);
  await mkdir(path.join(projectPath, INTEGRATION_ROOT, 'references'), { recursive: true });
  await writeFile(path.join(projectPath, INTEGRATION_ROOT, 'references/config.md'), 'user content');
  await assert.rejects(setupProject({ projectPath, bundle: fixtureBundle(), configDocument: configWithMode('rsa') }), /No files were written/);
  await assert.rejects(readFile(path.join(projectPath, '.env.example')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(projectPath, INTEGRATION_ROOT, 'SKILL.md')), { code: 'ENOENT' });
});

test('setup preflights non-empty env conflicts and reports only conflicting key names', async (t) => {
  const projectPath = await temporaryProject(t);
  const target = path.join(projectPath, '.env.example');
  const keys = ['ANTOM_AUTH_MODE', 'ANTOM_CLIENT_ID', 'ANTOM_PUBLIC_KEY', 'ANTOM_ENVIRONMENT', 'ANTOM_KEY_VERSION', 'ANTOM_GATEWAY_ORIGIN', 'ANTOM_API_KEY', 'ANTOM_MERCHANT_PRIVATE_KEY'];
  const original = keys.map((key) => `export ${key}='never-print-this-value' # Keep`).join('\n');
  await writeFile(target, original);
  for (const dryRun of [true, false]) {
    await assert.rejects(setupProject({ projectPath, bundle: fixtureBundle(), configDocument: configWithMode('rsa'), dryRun }),
      (error) => keys.every((key) => error.message.includes(key)) && error.message.includes('No files were written') && !error.message.includes('never-print-this-value'));
    assert.deepEqual(await readdir(projectPath), ['.env.example']);
    assert.equal(await readFile(target, 'utf8'), original);
  }
});

test('setup detects later duplicate and multiline env conflicts before creating skills', async (t) => {
  const projectPath = await temporaryProject(t);
  const target = path.join(projectPath, '.env.example');
  for (const value of [
    'ANTOM_CLIENT_ID="example-client"\nexport ANTOM_CLIENT_ID=another-client\n',
    '\uFEFFANTOM_PUBLIC_KEY="never-print\ncontinuation"\n',
    'ANTOM_API_KEY=\nANTOM_API_KEY="never-print\ncontinuation"\n',
    'ANTOM_MERCHANT_PRIVATE_KEY="never-print\ncontinuation"\n',
  ]) {
    await writeFile(target, value);
    await assert.rejects(setupProject({ projectPath, bundle: fixtureBundle(), configDocument: configWithMode('rsa') }),
      (error) => /conflicting non-empty/.test(error.message) && !/another-client|never-print|continuation/.test(error.message));
    assert.deepEqual(await readdir(projectPath), ['.env.example']);
    assert.equal(await readFile(target, 'utf8'), value);
  }
});

test('setup dry run validates configuration and prerequisites without writing', async (t) => {
  const projectPath = await temporaryProject(t);
  const result = await setupProject({ projectPath, bundle: fixtureBundle(), configDocument: configWithMode('rsa'), dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.configuration.changed, false);
  assert.equal(result.configuration.planned, true);
  assert.equal(result.installation.planned.length, 2);
  assert.equal(result.check.filesOk, false);
  assert.deepEqual(await readdir(projectPath), []);
});

test('reconciliation-only setup never reads or writes payment environment paths', async (t) => {
  const projectPath = await temporaryProject(t);
  // These directories would fail the env-file safety check if setup inspected them.
  await mkdir(path.join(projectPath, '.env'));
  await mkdir(path.join(projectPath, '.env.example'));
  const probe = (ids) => ids.map((id) => ({ id, status: 'available' }));
  const options = { projectPath, bundle: fixtureBundle(), skills: ['reconciliation'], probe };
  const result = await setupProject(options);
  assert.equal(result.ok, true);
  assert.equal(result.configuration, null);
  assert.equal(result.installation.written.length, 2);
  assert.equal((await setupProject(options)).installation.written.length, 0);
  assert.deepEqual(await readdir(path.join(projectPath, '.env.example')), []);
  assert.deepEqual(await readdir(path.join(projectPath, '.env')), []);
  await assert.rejects(setupProject({ ...options, configDocument: configWithMode('rsa') }), /does not accept payment configuration/);
});

test('setup reports missing dependencies after installation and leaves verification failures explicit', async (t) => {
  const projectPath = await temporaryProject(t);
  const options = { projectPath, bundle: fixtureBundle(), skills: ['integration', 'reconciliation'], configDocument: configWithMode('rsa') };
  const result = await setupProject({ ...options, probe: (ids) => ids.map((id) => ({ id, status: 'missing' })) });
  assert.equal(result.installation.written.length, 4);
  assert.equal(result.check.filesOk, true);
  assert.equal(result.check.runtimeReady, false);
  assert.equal(result.ok, false);
  await assert.rejects(setupProject({ ...options, probe: () => { throw new Error('arbitrary-sensitive-output'); } }),
    (error) => /already have been installed or updated.*verification failed/.test(error.message) && !error.message.includes('arbitrary-sensitive-output'));
});

test('integration setup does not inspect a real .env symlink and preflights unsafe .env.example', async (t) => {
  const projectPath = await temporaryProject(t);
  const outside = await temporaryProject(t);
  const runtime = path.join(outside, '.env');
  await writeFile(runtime, 'SECRET=must-remain-unchanged\n');
  if (!(await createTestSymlink(t, runtime, path.join(projectPath, '.env'), 'file'))) return;
  const options = { projectPath, bundle: fixtureBundle(), configDocument: configWithMode('rsa') };
  await setupProject(options);
  assert.equal(await readFile(runtime, 'utf8'), 'SECRET=must-remain-unchanged\n');
  const unsafeProject = await temporaryProject(t);
  if (!(await createTestSymlink(t, runtime, path.join(unsafeProject, '.env.example'), 'file'))) return;
  await assert.rejects(setupProject({ ...options, projectPath: unsafeProject }), /Symbolic links/);
  assert.deepEqual(await readdir(unsafeProject), ['.env.example']);
  assert.equal(await readFile(runtime, 'utf8'), 'SECRET=must-remain-unchanged\n');
});
