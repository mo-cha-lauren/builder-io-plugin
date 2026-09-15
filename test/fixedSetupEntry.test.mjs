import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProjectInstaller } from '../scripts/build-project-installer.mjs';

const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const PACKAGE = JSON.parse(await readFile(path.join(REPOSITORY, 'package.json'), 'utf8'));
const ENTRY = 'tools/antom-builder/bin/setup-project.mjs';
const CONFIG = {
  formatVersion: 2,
  settings: {
    authMode: 'api_key', clientId: 'example-client', antomPublicKey: '', environment: 'sandbox',
    keyVersion: '1', gatewayOrigin: 'https://open-sea-global.alipay.com',
  },
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const content = '# Minimal installer fixture; not an upstream payment Skill.\n';
const BUNDLE = {
  formatVersion: 1, package: { name: PACKAGE.name, version: PACKAGE.version },
  skills: [
    ['integration', 'antom-integration'], ['reconciliation', 'antom-reconciliation-expert'],
  ].map(([id, directory]) => ({
    id, name: id, requirements: [], limitations: [],
    files: [{ path: `.builder/skills/${directory}/SKILL.md`, content, sha256: sha256(content) }],
  })),
};

async function fixture(t, skills = ['integration'], sourceOverrides = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'antom-fixed-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let source = REPOSITORY;
  if (Object.keys(sourceOverrides).length) {
    source = await mkdtemp(path.join(await realpath(tmpdir()), 'antom-fixed-reviewed-source-'));
    t.after(() => rm(source, { recursive: true, force: true }));
    for (const relative of [
      'package.json', 'LICENSE', 'bin/antom-builder.mjs', 'bin/setup-project.mjs',
      'lib/project-installer.mjs', 'src/antomSettings.mjs',
    ]) {
      const destination = path.join(source, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, sourceOverrides[relative] ?? await readFile(path.join(REPOSITORY, relative)));
    }
  }
  const artifact = await createProjectInstaller(source, BUNDLE);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'target-application', private: true }));
  for (const file of artifact.files) {
    const destination = path.join(root, 'tools/antom-builder', file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
  const request = {
    formatVersion: 1, skills, installer: artifact.manifest,
    ...(skills.includes('integration') ? { config: structuredClone(CONFIG) } : {}),
  };
  await saveRequest(root, request);
  return { root, request, artifact };
}

async function saveRequest(root, request) {
  await writeFile(path.join(root, 'antom.setup.json'), JSON.stringify(request));
}

function run(root, args = [], entry = ENTRY) {
  return spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
}

async function noSetup(root, result, { verified = false } = {}) {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  if (!verified) assert.doesNotMatch(result.stdout, /Verified all/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /never-print-me/);
  await assert.rejects(readFile(path.join(root, '.builder/skills/antom-integration/SKILL.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, '.builder/skills/antom-reconciliation-expert/SKILL.md')), { code: 'ENOENT' });
}

test('fixed entry verifies 7 files, installs integration and preserves real .env', async (t) => {
  const { root, request } = await fixture(t);
  await writeFile(path.join(root, '.env'), 'REAL_SERVER_SECRET=never-print-me\n');
  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Verified all 7 pinned test installer files/);
  assert.match(first.stdout, /Installed 1 skill file/);
  assert.equal(await readFile(path.join(root, '.builder/skills/antom-integration/SKILL.md'), 'utf8'), content);
  const env = await readFile(path.join(root, '.env.example'), 'utf8');
  assert.match(env, /ANTOM_AUTH_MODE="api_key"/);
  assert.match(env, /ANTOM_API_KEY=\s*\n/);
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), 'REAL_SERVER_SECRET=never-print-me\n');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'antom.setup.json'), 'utf8')), request);
  assert.doesNotMatch(`${first.stdout}${first.stderr}`, /never-print-me/);
  const repeated = run(root);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Installed 0 skill file/);
  assert.equal(await readFile(path.join(root, '.env.example'), 'utf8'), env);
});

test('reconciliation-only entry never accesses payment environment paths', async (t) => {
  const { root } = await fixture(t, ['reconciliation']);
  // These paths would fail the existing config reader if it inspected them.
  await mkdir(path.join(root, '.env'));
  await mkdir(path.join(root, '.env.example'));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(root, '.builder/skills/antom-reconciliation-expert/SKILL.md'), 'utf8'), content);
  assert.doesNotMatch(result.stdout, /\.env\.example:/);
  await assert.rejects(readFile(path.join(root, '.builder/skills/antom-integration/SKILL.md')), { code: 'ENOENT' });
});

test('fixed entry rejects every command argument and wrong working directory', async (t) => {
  const { root } = await fixture(t);
  for (const args of [['--help'], ['--project', '/never-print-me'], ['setup'], ['--config-stdin']]) {
    await noSetup(root, run(root, args));
  }
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  await noSetup(root, run(nested, [], path.join(root, ENTRY)));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: PACKAGE.name }));
  await noSetup(root, run(root));
});

test('setup request rejects unknown fields, duplicate skills and incomplete configuration', async (t) => {
  const { root, request } = await fixture(t);
  const invalid = [
    null, [], { ...request, formatVersion: 2 }, { ...request, formatVersion: '1' },
    { ...request, command: 'never-print-me' }, { ...request, configPath: 'never-print-me' },
    { ...request, skills: [] }, { ...request, skills: 'integration' },
    { ...request, skills: ['integration', 'integration'] },
    { ...request, skills: ['integration', 'unknown'] },
    { ...request, config: null }, { ...request, config: { ...CONFIG, formatVersion: 1 } },
    { ...request, config: { ...CONFIG, privateKey: 'never-print-me' } },
    { ...request, config: { ...CONFIG, settings: { ...CONFIG.settings, apiKey: 'never-print-me' } } },
    { ...request, config: { ...CONFIG, settings: { ...CONFIG.settings, clientId: 123 } } },
    { ...request, config: { ...CONFIG, settings: { ...CONFIG.settings, keyVersion: undefined } } },
    { ...request, config: undefined },
    { ...request, skills: ['reconciliation'], config: null },
    { ...request, skills: ['reconciliation'] },
  ];
  for (const candidate of invalid) {
    await saveRequest(root, candidate);
    await noSetup(root, run(root));
  }
});

test('setup manifest rejects unsupported identities, paths, versions and hash records', async (t) => {
  const { root, request } = await fixture(t);
  const original = request.installer;
  const invalid = [
    null, [], { ...original, formatVersion: 2 }, { ...original, extra: 'never-print-me' },
    { ...original, name: 'never-print-me' }, { ...original, version: 'latest' },
    { ...original, version: '01.0.0' }, { ...original, version: '1.0.0-01' },
    { ...original, files: original.files.slice(1) },
    { ...original, files: [...original.files, original.files[0]] },
    { ...original, files: original.files.map((file, index) => index === 1 ? original.files[0] : file) },
    { ...original, files: original.files.map((file, index) => index === 0 ? { ...file, path: '../never-print-me' } : file) },
    { ...original, files: original.files.map((file, index) => index === 0 ? { ...file, path: '/never-print-me' } : file) },
    { ...original, files: original.files.map((file, index) => index === 0 ? { ...file, sha256: 'invalid' } : file) },
    { ...original, files: original.files.map((file, index) => index === 0 ? { ...file, content: 'never-print-me' } : file) },
  ];
  for (const installer of invalid) {
    await saveRequest(root, { ...request, installer });
    await noSetup(root, run(root));
  }
  await saveRequest(root, { ...request, installer: { ...original, version: '99.0.0' } });
  await noSetup(root, run(root));
});

test('tampering any of all 7 pinned files stops before the CLI runs', async (t) => {
  const { root, artifact } = await fixture(t);
  assert.equal(artifact.files.length, 7);
  for (const file of artifact.files) {
    const target = path.join(root, 'tools/antom-builder', file.path);
    // A harmless comment also keeps the entry executable so its manifest check
    // is exercised. A malicious entry itself requires the separate external hash check.
    const suffix = file.path.endsWith('.mjs') ? '\n// changed bytes\n' : '\n ';
    await writeFile(target, file.content + suffix);
    await noSetup(root, run(root));
    await writeFile(target, file.content);
  }
});

test('request input rejects oversize, invalid UTF-8 and malformed JSON without echoing data', async (t) => {
  const { root } = await fixture(t);
  for (const bytes of [Buffer.alloc(64 * 1024 + 1, 32), Buffer.from([0xff, 0xfe]), '{"never-print-me":']) {
    await writeFile(path.join(root, 'antom.setup.json'), bytes);
    await noSetup(root, run(root));
  }
});

test('request and runtime inputs reject hardlinks and directories', async (t) => {
  for (const relative of ['antom.setup.json', 'tools/antom-builder/LICENSE']) {
    const { root } = await fixture(t);
    const target = path.join(root, relative);
    const saved = await readFile(target);
    const hardlink = path.join(root, 'linked-input');
    await link(target, hardlink);
    await noSetup(root, run(root));
    await rm(hardlink);
    await rm(target);
    await mkdir(target);
    await noSetup(root, run(root));
    await rm(target, { recursive: true });
    await writeFile(target, saved);
  }
});

test('request, entry, runtime file and runtime directories reject symlinks', async (t) => {
  for (const relative of ['antom.setup.json', ENTRY, 'tools/antom-builder/LICENSE', 'tools/antom-builder/lib']) {
    const { root } = await fixture(t);
    const target = path.join(root, relative);
    const isDirectory = relative.endsWith('/lib');
    const saved = isDirectory ? undefined : await readFile(target);
    const linkedTarget = path.join(root, 'symlink-target');
    if (isDirectory) await mkdir(linkedTarget);
    else await writeFile(linkedTarget, saved);
    await rm(target, { recursive: isDirectory });
    try {
      await symlink(linkedTarget, target, isDirectory ? 'dir' : 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'ENOTSUP'].includes(error.code)) {
        t.skip('This Windows account cannot create symlinks.');
        return;
      }
      throw error;
    }
    await noSetup(root, run(root));
  }
});

test('FIFO request and runtime inputs fail promptly without reading them', { skip: process.platform === 'win32' }, async (t) => {
  for (const relative of ['antom.setup.json', 'tools/antom-builder/LICENSE']) {
    const { root } = await fixture(t);
    const target = path.join(root, relative);
    await rm(target);
    const fifo = spawnSync('mkfifo', [target], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr);
    await noSetup(root, run(root));
  }
});

test('runtime size limit and rehashed package identity mismatch fail before CLI', async (t) => {
  const { root, request } = await fixture(t);
  const licensePath = path.join(root, 'tools/antom-builder/LICENSE');
  const license = await readFile(licensePath);
  await writeFile(licensePath, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
  await noSetup(root, run(root));
  await writeFile(licensePath, license);
  const pkg = JSON.stringify({ name: 'not-the-expected-package', version: request.installer.version });
  await writeFile(path.join(root, 'tools/antom-builder/package.json'), pkg);
  request.installer.files.find((file) => file.path === 'package.json').sha256 = sha256(pkg);
  await saveRequest(root, request);
  await noSetup(root, run(root));
});

test('verified CLI value-validation and conflict failures preserve status and existing files', async (t) => {
  const { root, request } = await fixture(t);
  request.config.settings.authMode = 'never-print-me';
  await saveRequest(root, request);
  await noSetup(root, run(root), { verified: true });
  request.config.settings.authMode = 'rsa';
  await saveRequest(root, request);
  const existing = path.join(root, '.builder/skills/antom-integration/SKILL.md');
  await mkdir(path.dirname(existing), { recursive: true });
  await writeFile(existing, 'User-owned conflicting Skill.\n');
  const conflict = run(root);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /Verified all 7/);
  assert.match(conflict.stderr, /No files were written/);
  assert.equal(await readFile(existing, 'utf8'), 'User-owned conflicting Skill.\n');
  await assert.rejects(readFile(path.join(root, '.env.example')), { code: 'ENOENT' });
});

test('entry preserves the verified child exit code and diagnostic streams', async (t) => {
  const relative = 'bin/antom-builder.mjs';
  const stub = 'process.stdout.write("fixture stdout\\n"); process.stderr.write("fixture stderr\\n"); process.exitCode = 7;\n';
  // A trusted source rebuild pins this deliberate test double in the entry;
  // editing only project runtime files or request hashes must never authorize it.
  const { root } = await fixture(t, ['reconciliation'], { [relative]: stub });
  const result = run(root);
  assert.equal(result.status, 7);
  assert.match(result.stdout, /fixture stdout/);
  assert.match(result.stderr, /fixture stderr/);
});

test('tampering runtime code and updating request hashes cannot change the embedded trust anchor', async (t) => {
  const { root, request } = await fixture(t, ['reconciliation']);
  const relative = 'bin/antom-builder.mjs';
  const malicious = 'process.stdout.write("UNTRUSTED_EXECUTED\\n");\n';
  await writeFile(path.join(root, 'tools/antom-builder', relative), malicious);
  request.installer.files.find((file) => file.path === relative).sha256 = sha256(malicious);
  await saveRequest(root, request);
  const result = run(root);
  await noSetup(root, result);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /UNTRUSTED_EXECUTED/);
  assert.match(result.stderr, /build-pinned installer/);
});

test('unbuilt entry source fails closed even when its new hash is put in the request', async (t) => {
  const { root, request } = await fixture(t);
  const source = await readFile(path.join(REPOSITORY, 'bin/setup-project.mjs'));
  await writeFile(path.join(root, ENTRY), source);
  request.installer.files.find((file) => file.path === 'bin/setup-project.mjs').sha256 = sha256(source);
  await saveRequest(root, request);
  const result = run(root);
  await noSetup(root, result);
  assert.match(result.stderr, /Rebuild the project test installer/);
});
