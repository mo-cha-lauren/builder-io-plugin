import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with npm run test:package.');
const temporary = await mkdtemp(path.join(await realpath(tmpdir()), 'antom-package-smoke-'));

function runNode(args, cwd, expectedStatus = 0, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    input: options.input,
  });
  assert.ok([expectedStatus].flat().includes(result.status),
    result.stderr || result.error?.message || `Unexpected command status: ${result.status}.`);
  assert.doesNotMatch(`${result.stdout || ''}${result.stderr || ''}`,
    /runtime-synthetic|runtime-rsa|local-synthetic|never-print-me|example-secret|example-rsa/,
    'The CLI printed a synthetic credential.');
  assert.doesNotMatch(`${result.stdout || ''}${result.stderr || ''}`,
    /Packed installer attempted real environment file access/,
    'The CLI attempted to access an actual environment file.');
  return result.stdout;
}

// Execute the packed CLI with real Node filesystem APIs, but fail if it tries
// to inspect, read or write any actual environment file. The parent creates and
// checks synthetic sentinels; the installer is only allowed .env.example.
const credentialGuard = `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
function assertAllowed(value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return;
  const name = path.basename(value).toLowerCase();
  if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') {
    throw new Error('Packed installer attempted real environment file access.');
  }
}
for (const target of [fs, fsp]) {
  for (const name of [
    'access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'createReadStream', 'createWriteStream',
    'exists', 'link', 'lstat', 'open', 'readFile', 'readlink', 'realpath', 'rename', 'rm', 'stat',
    'symlink', 'truncate', 'unlink', 'utimes', 'writeFile',
  ]) {
    for (const method of [name, name + 'Sync']) {
      if (typeof target[method] !== 'function') continue;
      const original = target[method];
      target[method] = function (...args) {
        assertAllowed(args[0]);
        if (['copyFile', 'cp', 'link', 'rename', 'symlink'].includes(name)) assertAllowed(args[1]);
        return original.apply(this, args);
      };
    }
  }
}
syncBuiltinESMExports();
`;
const credentialGuardUrl = `data:text/javascript,${encodeURIComponent(credentialGuard)}`;

try {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const cache = path.join(temporary, 'npm-cache');
  const packed = JSON.parse(runNode([npmCli, 'pack', '--ignore-scripts', '--json',
    '--pack-destination', temporary, '--cache', cache], root))[0];
  const included = packed.files.map((file) => file.path);
  for (const required of ['bin/antom-builder.mjs', 'lib/project-installer.mjs', 'src/antomSettings.mjs',
    'dist/plugin.system.js', 'dist/skill-bundle.json', 'dist/antom-skills-integration-reconciliation.zip']) {
    assert.ok(included.includes(required), `Missing npm file: ${required}`);
  }
  assert.ok(included.every((file) => !/(?:^|\/)(?:CODE_REVIEW\.md|\.git|\.env|node_modules)(?:\/|$)/.test(file)),
    'The package contains an internal review, repository history, environment file or dependency tree.');
  const consumer = path.join(temporary, 'consumer');
  const project = path.join(temporary, 'project with spaces');
  await mkdir(consumer);
  await mkdir(project);
  // Installing our local archive offline proves the runtime does not secretly
  // depend on checkout-only files, devDependencies or an unpublished endpoint.
  runNode([npmCli, 'install', path.join(temporary, packed.filename), '--prefix', consumer,
    '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', cache], consumer);
  // npm creates the executable launcher at install time; archive mode alone is
  // not the cross-platform contract (Windows uses a .cmd launcher).
  assert.match(runNode([npmCli, 'exec', '--offline', '--no', '--cache', cache,
    '--', 'antom-builder', '--help'], consumer), /Antom project setup/);
  const installed = path.join(consumer, 'node_modules', ...pkg.name.split('/'));
  const cli = path.join(installed, 'bin/antom-builder.mjs');
  const installedPackage = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(installedPackage.antomBuilder?.setupProtocol, 1,
    'Published metadata must advertise the supported cloud setup protocol.');
  const runCli = (args, cwd = project, expectedStatus = 0, input) =>
    runNode(['--import', credentialGuardUrl, cli, ...args], cwd, expectedStatus, { input });
  assert.match(runCli(['--help']), /setup .*--config-stdin/);
  const bundle = JSON.parse(await readFile(path.join(installed, 'dist/skill-bundle.json'), 'utf8'));
  const expectedFiles = bundle.skills.flatMap((skill) => skill.files);
  runCli(['install', '--skills', 'integration,reconciliation', '--dry-run']);
  assert.deepEqual(await readdir(project), []);
  runCli(['install', '--skills', 'integration,reconciliation']);
  for (const file of expectedFiles) {
    assert.equal(await readFile(path.join(project, file.path), 'utf8'), file.content);
  }
  assert.match(runCli(['install', '--skills', 'integration,reconciliation']), /Installed 0 file/);
  runCli(['check', '--skills', 'integration']);

  const modified = path.join(project, '.builder/skills/antom-integration/SKILL.md');
  await writeFile(modified, 'User customization: do not overwrite.\n');
  runCli(['install', '--skills', 'integration,reconciliation'], project, 1);
  assert.equal(await readFile(modified, 'utf8'), 'User customization: do not overwrite.\n');

  const example = path.join(project, '.env.example');
  await writeFile(example, '# Keep this comment\nPORT=3000\nANTOM_DEFAULT_CURRENCY=USD\n');
  const legacySettings = { clientId: 'synthetic-client', antomPublicKey: '', environment: 'sandbox',
    keyVersion: '1', gatewayOrigin: 'https://open-sea-global.alipay.com' };
  const configPath = path.join(project, 'antom.config.json');
  const runtime = 'ANTOM_API_KEY=runtime-synthetic\nANTOM_MERCHANT_PRIVATE_KEY=runtime-rsa\n';
  await writeFile(path.join(project, '.env'), runtime);
  for (const document of [
    { formatVersion: 1, settings: legacySettings },
    { formatVersion: 2, settings: { ...legacySettings, authMode: 'api_key' } },
    { formatVersion: 2, settings: { ...legacySettings, authMode: 'rsa' } },
  ]) {
    const previous = await readFile(example, 'utf8');
    await writeFile(example, `${previous}ANTOM_API_KEY="example-secret\ncontinued"\nANTOM_MERCHANT_PRIVATE_KEY=example-rsa\n`);
    await writeFile(configPath, JSON.stringify(document));
    runCli(['config', '--file', 'antom.config.json']);
    const merged = await readFile(example, 'utf8');
    assert.match(merged, /# Keep this comment\nPORT=3000\nANTOM_DEFAULT_CURRENCY=USD/);
    assert.match(merged, new RegExp(`ANTOM_AUTH_MODE="${document.settings.authMode || 'rsa'}"\\n`));
    assert.match(merged, /ANTOM_API_KEY=\n/);
    assert.match(merged, /ANTOM_MERCHANT_PRIVATE_KEY=\n/);
    assert.match(merged, /ANTOM_PUBLIC_KEY=""\n/);
    assert.doesNotMatch(merged, /example-secret|continued|example-rsa|runtime-/);
    assert.equal(await readFile(path.join(project, '.env'), 'utf8'), runtime);
    assert.match(runCli(['config', '--file', 'antom.config.json']), /already up to date/);
  }
  const beforeInvalid = await readFile(example, 'utf8');
  await writeFile(configPath, JSON.stringify({ formatVersion: 2, settings: { ...legacySettings, authMode: 'api_key', apiKey: 'never-print-me' } }));
  runCli(['config', '--file', 'antom.config.json'], project, 1);
  assert.equal(await readFile(example, 'utf8'), beforeInvalid);

  const cloudProject = path.join(temporary, 'cloud setup project with spaces');
  await mkdir(cloudProject);
  const cloudExample = path.join(cloudProject, '.env.example');
  const initialExample = '# Existing project settings\nPORT=3000\nANTOM_DEFAULT_CURRENCY=USD\n';
  await writeFile(cloudExample, initialExample);
  await writeFile(path.join(cloudProject, '.env'), runtime);
  await writeFile(path.join(cloudProject, '.env.local'), 'ANTOM_API_KEY=local-synthetic\n');
  const setupConfig = JSON.stringify({ formatVersion: 2, settings: { ...legacySettings, authMode: 'api_key' } });
  const setupArgs = ['setup', '--skills', 'integration', '--config-stdin', '--project', cloudProject];
  runCli([...setupArgs, '--dry-run'], consumer, 0, setupConfig);
  assert.deepEqual((await readdir(cloudProject)).sort(), ['.env', '.env.example', '.env.local']);
  assert.equal(await readFile(cloudExample, 'utf8'), initialExample);

  assert.match(runCli(setupArgs, consumer, 0, setupConfig), /Files: complete/);
  const integrationFiles = bundle.skills.find(({ id }) => id === 'integration').files;
  for (const file of integrationFiles) {
    assert.equal(await readFile(path.join(cloudProject, file.path), 'utf8'), file.content);
  }
  const configured = await readFile(cloudExample, 'utf8');
  assert.ok(configured.startsWith(initialExample));
  assert.match(configured, /ANTOM_AUTH_MODE="api_key"\n/);
  assert.match(configured, /ANTOM_API_KEY=\n/);
  assert.match(configured, /ANTOM_MERCHANT_PRIVATE_KEY=\n/);
  const unchangedPaths = [cloudExample, ...integrationFiles.map((file) => path.join(cloudProject, file.path))];
  const beforeRepeat = await Promise.all(unchangedPaths.map((file) => stat(file)));
  assert.match(runCli(setupArgs, consumer, 0, setupConfig), /Files: complete/);
  const afterRepeat = await Promise.all(unchangedPaths.map((file) => stat(file)));
  assert.deepEqual(afterRepeat.map(({ ino, size, mtimeMs }) => ({ ino, size, mtimeMs })),
    beforeRepeat.map(({ ino, size, mtimeMs }) => ({ ino, size, mtimeMs })),
    'An identical setup must not rewrite existing files.');
  assert.equal(await readFile(cloudExample, 'utf8'), configured);

  // Config rejection must happen before the additional reconciliation files
  // are installed, including when changing a previously configured auth mode.
  const combinedArgs = ['setup', '--skills', 'integration,reconciliation', '--config-stdin', '--project', cloudProject];
  const conflictingConfig = JSON.stringify({ formatVersion: 2, settings: { ...legacySettings, authMode: 'rsa' } });
  runCli(combinedArgs, consumer, 1, conflictingConfig);
  assert.deepEqual(await readdir(path.join(cloudProject, '.builder/skills')), ['antom-integration']);
  assert.equal(await readFile(cloudExample, 'utf8'), configured);
  for (const invalidInput of [
    '{ invalid JSON',
    JSON.stringify({ formatVersion: 2, settings: { ...legacySettings, authMode: 'api_key', apiKey: 'never-print-me' } }),
  ]) {
    runCli(combinedArgs, consumer, 1, invalidInput);
    assert.deepEqual(await readdir(path.join(cloudProject, '.builder/skills')), ['antom-integration']);
    assert.equal(await readFile(cloudExample, 'utf8'), configured);
  }
  const nonEmptySecretExample = configured.replace('ANTOM_API_KEY=\n', 'ANTOM_API_KEY=example-secret\n');
  await writeFile(cloudExample, nonEmptySecretExample);
  runCli(combinedArgs, consumer, 1, setupConfig);
  assert.deepEqual(await readdir(path.join(cloudProject, '.builder/skills')), ['antom-integration']);
  assert.equal(await readFile(cloudExample, 'utf8'), nonEmptySecretExample);
  await writeFile(cloudExample, configured);

  // A complete combined setup may exit 1 only because the actual runtime lacks
  // Python prerequisites; the output must still report complete installed files.
  assert.match(runCli(combinedArgs, consumer, [0, 1], setupConfig), /Files: complete/);
  for (const file of expectedFiles) {
    assert.equal(await readFile(path.join(cloudProject, file.path), 'utf8'), file.content);
  }
  assert.equal(await readFile(path.join(cloudProject, '.env'), 'utf8'), runtime);
  assert.equal(await readFile(path.join(cloudProject, '.env.local'), 'utf8'), 'ANTOM_API_KEY=local-synthetic\n');
  assert.ok(!(await readdir(cloudProject)).includes('antom.config.json'), 'stdin setup must not require or create a config file.');

  const billProject = path.join(temporary, 'bill analysis only');
  await mkdir(billProject);
  await writeFile(path.join(billProject, '.env'), runtime);
  const billArgs = ['setup', '--skills', 'reconciliation', '--project', billProject];
  assert.match(runCli(billArgs, consumer, [0, 1]), /Files: complete/);
  assert.deepEqual((await readdir(billProject)).sort(), ['.builder', '.env']);
  assert.deepEqual(await readdir(path.join(billProject, '.builder/skills')), ['antom-reconciliation-expert']);
  assert.match(runCli(billArgs, consumer, [0, 1]), /Files: complete/);
  assert.equal(await readFile(path.join(billProject, '.env'), 'utf8'), runtime);
  assert.deepEqual((await readdir(billProject)).sort(), ['.builder', '.env']);
  console.log(`Packed package smoke passed: ${included.length} package files; ${expectedFiles.length} Skill files installed and verified; stdin setup, dry-run, idempotency, conflict preflight, bill-only setup and credential-access guard passed; legacy RSA/API Key config compatibility retained. Local package validation is not Builder cloud acceptance.`);
} finally {
  // Only our explicitly allocated disposable test directory is removed.
  await rm(temporary, { recursive: true, force: true });
}
