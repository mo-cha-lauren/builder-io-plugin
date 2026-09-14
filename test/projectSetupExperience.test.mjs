import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildProjectInstaller, createProjectInstaller } from '../scripts/build-project-installer.mjs';
import { createSkillBundle } from '../scripts/build-skill-bundle.mjs';
import { createProjectSetupPrompt, PROJECT_INSTALLER_PATH } from '../src/installExperience.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await createSkillBundle(root);
const artifact = await createProjectInstaller(root, bundle);
const pkg = bundle.package;
const settings = { clientId: 'sandbox-project-test', authMode: 'api_key' };
const integrationSkill = '.builder/skills/antom-integration/SKILL.md';

async function projectFixture(t, includeInstaller = true) {
  const project = await mkdtemp(path.join(await realpath(tmpdir()), 'antom-project-setup-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'builder-antom-test', private: true }));
  if (includeInstaller) {
    for (const file of artifact.files) {
      const destination = path.join(project, PROJECT_INSTALLER_PATH, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }
  }
  return project;
}

async function executePrompt(prompt, project, options = {}) {
  // Local integration harness models the explicit owner approval and file-tool
  // steps. It does not emulate or claim to validate Builder's cloud ACL engine.
  const blocks = Array.from(prompt.matchAll(/```sh\n([\s\S]*?)\n```/g), ([, command]) => command);
  assert.deepEqual(blocks, ['ls -ld tools tools/antom-builder tools/antom-builder/bin tools/antom-builder/bin/setup-project.mjs', 'sha256sum tools/antom-builder/bin/setup-project.mjs', 'node tools/antom-builder/bin/setup-project.mjs']);
  if (options.approved === false) return { status: 126, stdout: '', stderr: 'Project command approval required.' };
  const request = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1]);
  await writeFile(path.join(project, 'antom.setup.json'), JSON.stringify(request));
  const expectedHash = prompt.match(/plugin-pinned value: ([a-f0-9]{64})/)[1];
  const failure = { status: 1, stdout: '', stderr: 'Project installer verification failed. Setup was not run.' };
  const paths = ['tools', 'tools/antom-builder', 'tools/antom-builder/bin', 'tools/antom-builder/bin/setup-project.mjs'];
  const metadata = spawnSync('ls', ['-ld', ...paths], { cwd: project, encoding: 'utf8', timeout: 5000 });
  if (metadata.status !== 0) return failure;
  const lines = metadata.stdout.trim().split('\n');
  if (lines.length !== paths.length) return failure;
  for (const relative of paths) {
    const line = lines.find((value) => value.endsWith(` ${relative}`));
    const fields = line?.match(/^([d-])\S*\s+(\d+)\s+\S+\s+\S+\s+(\d+)\s+/);
    if (!fields || (relative.endsWith('.mjs')
      ? fields[1] !== '-' || Number(fields[2]) !== 1 || Number(fields[3]) > 8 * 1024 * 1024
      : fields[1] !== 'd')) return failure;
  }
  const hash = spawnSync('sha256sum', ['tools/antom-builder/bin/setup-project.mjs'], { cwd: project, encoding: 'utf8', timeout: 5000 });
  if (hash.status !== 0 || hash.stdout.trim().split(/\s+/)[0] !== expectedHash) return failure;
  const result = spawnSync(process.execPath, ['tools/antom-builder/bin/setup-project.mjs'], {
    cwd: project, encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  assert.equal(result.error, undefined);
  return result;
}

const shellTest = (name, callback) => test(name, { skip: process.platform === 'win32' ? 'The cloud request uses Linux sha256sum.' : false }, callback);

async function assertSetupUntouched(project) {
  await assert.rejects(readFile(path.join(project, integrationSkill)), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(project, '.env.example')), { code: 'ENOENT' });
  assert.ok(!(await readdir(project)).includes('.builder'));
}

test('project test artifact contains only eight reviewed runtime files with reproducible hashes', async () => {
  assert.deepEqual(artifact.files.map((file) => file.path).sort(), [
    'LEGAL.md', 'LICENSE', 'bin/antom-builder.mjs', 'bin/setup-project.mjs', 'dist/skill-bundle.json',
    'lib/project-installer.mjs', 'package.json', 'src/antomSettings.mjs',
  ].sort());
  const metadata = JSON.parse(artifact.files.find((file) => file.path === 'package.json').content);
  assert.deepEqual(Object.keys(metadata).sort(), ['license', 'name', 'private', 'version']);
  assert.equal(metadata.private, true);
  assert.equal(metadata.name, pkg.name);
  assert.equal(artifact.manifest.formatVersion, 1);
  for (const file of artifact.files) {
    assert.equal(artifact.manifest.files.find((entry) => entry.path === file.path).sha256,
      createHash('sha256').update(file.content).digest('hex'));
  }
  assert.deepEqual(await createProjectInstaller(root, bundle), artifact);
  await assert.rejects(createProjectInstaller(root, { ...bundle, package: { ...pkg, version: '0.0.0' } }));
});

test('builder writes the matching manifest and refuses unexpected output without deleting it', async (t) => {
  const project = await projectFixture(t, false);
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ ...pkg, license: 'MIT' }));
  for (const file of artifact.files.filter((file) => !['package.json', 'dist/skill-bundle.json'].includes(file.path))) {
    const destination = path.join(project, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.path === 'bin/setup-project.mjs'
      ? await readFile(path.join(root, file.path), 'utf8') : file.content);
  }
  const result = await buildProjectInstaller(project, bundle);
  const manifestPath = path.join(project, '.generated/project-installer-manifest.json');
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), result.manifest);
  for (const file of result.files) {
    assert.equal(await readFile(path.join(project, '.generated/project-test-installer', file.path), 'utf8'), file.content);
  }
  const unexpected = path.join(project, '.generated/project-test-installer/CODE_REVIEW.md');
  await writeFile(unexpected, 'internal material must not be exported or silently deleted');
  await assert.rejects(buildProjectInstaller(project, bundle), /Unexpected file/);
  assert.equal(await readFile(unexpected, 'utf8'), 'internal material must not be exported or silently deleted');
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), result.manifest);
});

test('unpublished package can generate a project request without fetching npm or copying secrets', async () => {
  const prompt = await createProjectSetupPrompt(pkg, ['integration'], {
    ...settings, apiKey: 'do-not-copy-api-key', merchantPrivateKey: 'do-not-copy-private-key',
    authorization: 'Bearer do-not-copy-auth',
  }, { ...artifact.manifest, unexpectedSecret: 'do-not-copy-manifest-secret' }, {
    fetchFunction: () => { throw new Error('Project setup must not access npm.'); },
  });
  assert.match(prompt, /current Builder cloud code project/);
  assert.match(prompt, /node tools\/antom-builder\/bin\/setup-project\.mjs/);
  assert.match(prompt, /project owner must approve ALL THREE exact commands/);
  assert.match(prompt, /Do not create or edit builder\.config\.json/);
  const commands = Array.from(prompt.matchAll(/```sh\n([\s\S]*?)\n```/g), ([, value]) => value);
  assert.equal(commands.length, 3);
  for (const command of commands) assert.doesNotMatch(command, /[\n;&|<>`]|\$\(/);
  assert.match(prompt, /notify-related interfaces always use RSA/);
  assert.match(prompt, /No Git operations, payments, or live account access are authorized/);
  assert.match(prompt, /Do not open real \.env files/);
  assert.doesNotMatch(prompt, /do-not-copy|npm exec|registry\.npmjs\.org|https:\/\/github/);
});

test('invalid selection, settings, package metadata and injected manifests are rejected before copy', async () => {
  for (const selection of [[], ['integration; echo bad'], ['unknown']]) {
    await assert.rejects(createProjectSetupPrompt(pkg, selection, settings, artifact.manifest));
  }
  await assert.rejects(createProjectSetupPrompt(pkg, ['integration'], { clientId: 'bad\nANTOM_SETUP_CONFIG\necho bad' }, artifact.manifest));
  await assert.rejects(createProjectSetupPrompt({ ...pkg, version: 'latest' }, ['integration'], settings, artifact.manifest));
  const first = artifact.manifest.files[0];
  for (const manifest of [
    undefined, {}, { ...artifact.manifest, formatVersion: 2 }, { ...artifact.manifest, version: '0.0.0' },
    { ...artifact.manifest, name: 'other-package' }, { ...artifact.manifest, files: [] },
    { ...artifact.manifest, files: [first, ...artifact.manifest.files.slice(0, -1)] },
    { ...artifact.manifest, files: [{ ...first, path: '../outside' }, ...artifact.manifest.files.slice(1)] },
    { ...artifact.manifest, files: [{ ...first, path: 'LICENSE\nANTOM_VERIFY_PROJECT_INSTALLER\necho bad' }, ...artifact.manifest.files.slice(1)] },
    { ...artifact.manifest, files: [{ ...first, sha256: "'; echo bad" }, ...artifact.manifest.files.slice(1)] },
  ]) await assert.rejects(createProjectSetupPrompt(pkg, ['integration'], settings, manifest));
});

shellTest('fixed setup request fails closed when the unpublished project installer is missing', async (t) => {
  const project = await projectFixture(t, false);
  const prompt = await createProjectSetupPrompt(pkg, ['integration'], settings, artifact.manifest);
  const result = await executePrompt(prompt, project);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /verification failed.*Setup was not run/);
  await assertSetupUntouched(project);
});

shellTest('without owner command approval the local harness does not create input or run setup', async (t) => {
  const project = await projectFixture(t);
  const result = await executePrompt(await createProjectSetupPrompt(pkg, ['integration'], settings, artifact.manifest), project, { approved: false });
  assert.equal(result.status, 126);
  await assert.rejects(readFile(path.join(project, 'antom.setup.json')), { code: 'ENOENT' });
  await assertSetupUntouched(project);
});

shellTest('independent entry hash comparison rejects executable replacement before running it', async (t) => {
  const project = await projectFixture(t);
  await writeFile(path.join(project, PROJECT_INSTALLER_PATH, 'bin/setup-project.mjs'),
    "import {writeFileSync} from 'node:fs'; writeFileSync('UNVERIFIED_ENTRY_RAN', 'bad');");
  const result = await executePrompt(await createProjectSetupPrompt(pkg, ['integration'], settings, artifact.manifest), project);
  assert.notEqual(result.status, 0);
  await assert.rejects(readFile(path.join(project, 'UNVERIFIED_ENTRY_RAN')), { code: 'ENOENT' });
  await assertSetupUntouched(project);
});

shellTest('changing any pinned artifact file prevents executing setup and writing project files', async (t) => {
  for (const file of artifact.files) {
    const project = await projectFixture(t);
    await writeFile(path.join(project, PROJECT_INSTALLER_PATH, file.path), `${file.content}\nchanged-test-artifact\n`);
    const prompt = await createProjectSetupPrompt(pkg, ['integration'], settings, artifact.manifest);
    const result = await executePrompt(prompt, project);
    assert.notEqual(result.status, 0, file.path);
    assert.match(result.stderr, /Setup was not run|Nothing was run/);
    await assertSetupUntouched(project);
  }
});

shellTest('verifier rejects symbolic-link directories and linked files even with matching bytes', async (t) => {
  for (const linkType of ['directory', 'file', 'hardlink']) {
    const project = await projectFixture(t);
    const target = path.join(project, PROJECT_INSTALLER_PATH, linkType === 'directory' ? 'bin' : 'LICENSE');
    const copy = path.join(project, linkType === 'directory' ? 'outside-bin' : 'outside-license');
    if (linkType === 'directory') {
      await mkdir(copy);
      await writeFile(path.join(copy, 'antom-builder.mjs'), artifact.files.find((file) => file.path === 'bin/antom-builder.mjs').content);
    } else await writeFile(copy, artifact.files.find((file) => file.path === 'LICENSE').content);
    await rm(target, { recursive: linkType === 'directory' });
    if (linkType === 'hardlink') await link(copy, target);
    else await symlink(copy, target);
    const prompt = await createProjectSetupPrompt(pkg, ['integration'], settings, artifact.manifest);
    const result = await executePrompt(prompt, project);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Setup was not run|Nothing was run/);
    await assertSetupUntouched(project);
  }
});

shellTest('verifier rejects a FIFO before opening it instead of hanging the Agent shell', async (t) => {
  const project = await projectFixture(t);
  const target = path.join(project, PROJECT_INSTALLER_PATH, 'LICENSE');
  await rm(target);
  const fifo = spawnSync('mkfifo', [target], { encoding: 'utf8' });
  assert.equal(fifo.status, 0, fifo.stderr);
  const prompt = await createProjectSetupPrompt(pkg, ['integration'], settings, artifact.manifest);
  const result = await executePrompt(prompt, project);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Setup was not run|Nothing was run/);
  await assertSetupUntouched(project);
});

shellTest('verified complete project artifact runs the real installer and preserves real secrets', async (t) => {
  const project = await projectFixture(t);
  const sentinel = 'ANTOM_API_KEY=real-environment-synthetic-secret\n';
  await writeFile(path.join(project, '.env'), sentinel);
  const guard = `import fs from 'node:fs'; import fsp from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
const check = value => { const text = String(value); if (/(?:^|\\/)\\.env(?:$|\\.(?!example$))/.test(text)) throw new Error('Real env access prohibited by test guard'); };
for (const api of [fs, fsp]) for (const base of ['access','open','readFile','writeFile','lstat','stat','realpath']) for (const method of [base, base+'Sync']) {
  if (typeof api[method] !== 'function') continue; const original = api[method];
  api[method] = function(...args) { if (typeof args[0] !== 'number') check(args[0]); return original.apply(this, args); };
} syncBuiltinESMExports();`;
  const prompt = await createProjectSetupPrompt(pkg, ['integration'], settings, artifact.manifest);
  const result = await executePrompt(prompt, project, { env: { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(guard)}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified all 8 pinned test installer files/);
  assert.match(result.stdout, /Installed 5 skill file\(s\)/);
  assert.equal(await readFile(path.join(project, integrationSkill), 'utf8'),
    bundle.skills.find((skill) => skill.id === 'integration').files.find((file) => file.path === integrationSkill).content);
  const envExample = await readFile(path.join(project, '.env.example'), 'utf8');
  assert.match(envExample, /ANTOM_AUTH_MODE="api_key"/);
  assert.match(envExample, /ANTOM_CLIENT_ID="sandbox-project-test"/);
  assert.equal(await readFile(path.join(project, '.env'), 'utf8'), sentinel);
  assert.doesNotMatch(`${result.stdout}${result.stderr}${envExample}`, /real-environment-synthetic-secret|Real env access prohibited/);
});

shellTest('bill-only setup does not inspect payment snapshot or existing payment configuration', async (t) => {
  const project = await projectFixture(t);
  const snapshot = { get authMode() { throw new Error('Payment settings must not be inspected'); } };
  // A symlink would fail any payment config preflight; bill-only must leave it alone.
  const outside = path.join(project, 'untouched-config');
  await writeFile(outside, 'unrelated-config-sentinel');
  await symlink(outside, path.join(project, '.env.example'));
  const prompt = await createProjectSetupPrompt(pkg, ['reconciliation'], snapshot, artifact.manifest);
  assert.doesNotMatch(prompt, /config-stdin|ANTOM_SETUP_CONFIG/);
  assert.match(prompt, /bill-only setup must not read or change payment configuration/);
  const result = await executePrompt(prompt, project);
  // Runtime prerequisites are checked honestly; this test doesn't install Python dependencies.
  assert.ok([0, 1].includes(result.status), result.stderr);
  assert.match(result.stdout, /Installed 19 skill file\(s\)/);
  assert.match(result.stdout, /runtime prerequisites:/);
  assert.equal(await readFile(outside, 'utf8'), 'unrelated-config-sentinel');
  await assert.rejects(readFile(path.join(project, integrationSkill)), { code: 'ENOENT' });
});

shellTest('running the setup request in the plugin repository is rejected before installation', async (t) => {
  const project = await projectFixture(t);
  await writeFile(path.join(project, 'package.json'), JSON.stringify(pkg));
  const result = await executePrompt(await createProjectSetupPrompt(pkg, ['integration'], settings, artifact.manifest), project);
  assert.notEqual(result.status, 0);
  await assertSetupUntouched(project);
});
