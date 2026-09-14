import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const CLI = fileURLToPath(new URL('../bin/antom-builder.mjs', import.meta.url));
const CONFIG = {
  formatVersion: 2,
  settings: {
    authMode: 'rsa', clientId: 'example-client', antomPublicKey: '',
    environment: 'sandbox', keyVersion: '1', gatewayOrigin: 'https://open-sea-global.alipay.com',
  },
};
const SETUP = ['setup', '--skills', 'integration', '--config-stdin'];

async function temporaryProject(t) {
  const project = await mkdtemp(path.join(await realpath(tmpdir()), 'antom-cloud-setup-test-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  return project;
}

function run(projectPath, args = SETUP, input = JSON.stringify(CONFIG), options = {}) {
  return spawnSync(process.execPath, [CLI, ...args, '--project', projectPath], {
    cwd: projectPath, encoding: 'utf8', input, timeout: 7000, ...options,
  });
}

test('cloud setup CLI installs from stdin, is idempotent, and never echoes config values', async (t) => {
  const project = await temporaryProject(t);
  const runtime = 'ANTOM_API_KEY=runtime-secret\n';
  await writeFile(path.join(project, '.env'), runtime);
  const first = run(project);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Files: complete/);
  assert.match(first.stdout, /does not verify a payment/);
  assert.doesNotMatch(first.stdout + first.stderr, /example-client|runtime-secret|open-sea-global/);
  const target = path.join(project, '.env.example');
  const before = await stat(target);
  const repeated = run(project);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Installed 0 skill file\(s\)/);
  assert.match(repeated.stdout, /already up to date/);
  const after = await stat(target);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(path.join(project, '.env'), 'utf8'), runtime);
});

test('cloud setup dry run validates stdin but creates no files', async (t) => {
  const project = await temporaryProject(t);
  const result = run(project, [...SETUP, '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No files were written/);
  assert.deepEqual(await readdir(project), []);
});

test('cloud setup rejects invalid, empty, invalid UTF-8, secret, legacy and oversized stdin before writes', async (t) => {
  const project = await temporaryProject(t);
  const invalid = [
    '', '  \n', '{secret-no-echo', Buffer.from([0xff, 0xfe]),
    JSON.stringify({ ...CONFIG, formatVersion: 1 }),
    JSON.stringify({ ...CONFIG, settings: { ...CONFIG.settings, apiKey: 'secret-no-echo' } }),
    JSON.stringify({ ...CONFIG, settings: { ...CONFIG.settings, merchantPrivateKey: 'secret-no-echo' } }),
    JSON.stringify({ ...CONFIG, settings: { ...CONFIG.settings, environment: 'secret-no-echo' } }),
    'secret-no-echo'.repeat(6000),
  ];
  for (const input of invalid) {
    const result = run(project, SETUP, input);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-no-echo|example-client/);
    assert.deepEqual(await readdir(project), []);
  }
  assert.match(run(project, SETUP, Buffer.alloc(64 * 1024 + 1, 0x20)).stderr, /64 KiB size limit/);
});

test('cloud setup accepts exactly 64 KiB and rejects any byte beyond the limit', async (t) => {
  const project = await temporaryProject(t);
  const json = JSON.stringify(CONFIG);
  const exact = json.padEnd(64 * 1024, ' ');
  assert.equal(run(project, [...SETUP, '--dry-run'], exact).status, 0);
  const oversized = run(project, [...SETUP, '--dry-run'], `${exact} `);
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /64 KiB size limit/);
  assert.deepEqual(await readdir(project), []);
});

test('cloud setup requires config stdin only for integration and rejects duplicate or unsupported options', async (t) => {
  const project = await temporaryProject(t);
  for (const args of [
    ['setup', '--skills', 'integration'],
    ['setup', '--skills', 'integration,reconciliation'],
    ['setup', '--skills', 'reconciliation', '--config-stdin'],
    [...SETUP, '--config-stdin'], [...SETUP, '--file', 'config.json'],
  ]) {
    assert.equal(run(project, args).status, 1);
    assert.deepEqual(await readdir(project), []);
  }
});

test('cloud setup rejects interactive stdin immediately', async (t) => {
  const project = await temporaryProject(t);
  const source = `
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    process.argv = ${JSON.stringify([process.execPath, CLI, ...SETUP, '--project', project])};
    await import(${JSON.stringify(pathToFileURL(CLI).href)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: project, encoding: 'utf8', timeout: 1500 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive input is not supported/);
  assert.deepEqual(await readdir(project), []);
});

test('cloud setup times out an open pipe with missing input instead of hanging', async (t) => {
  const project = await temporaryProject(t);
  const child = spawn(process.execPath, [CLI, ...SETUP, '--project', project], { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('CLI did not stop waiting for stdin.')); }, 5000);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(status, 1);
  assert.match(stderr, /Timed out waiting for stdin configuration/);
  assert.deepEqual(await readdir(project), []);
});

test('cloud setup env conflicts stop before installation and never echo values', async (t) => {
  const project = await temporaryProject(t);
  const target = path.join(project, '.env.example');
  const original = 'ANTOM_CLIENT_ID=conflict-no-echo\nANTOM_API_KEY=secret-no-echo\n';
  await writeFile(target, original);
  const result = run(project);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ANTOM_CLIENT_ID, ANTOM_API_KEY/);
  assert.match(result.stderr, /No files were written/);
  assert.doesNotMatch(result.stdout + result.stderr, /conflict-no-echo|secret-no-echo|example-client/);
  assert.equal(await readFile(target, 'utf8'), original);
  assert.deepEqual(await readdir(project), ['.env.example']);
});

test('reconciliation setup without config installs then exits nonzero when runtime dependencies are missing', async (t) => {
  const project = await temporaryProject(t);
  const original = 'ANTOM_CLIENT_ID=leave-untouched\nANTOM_API_KEY=secret-no-echo\n';
  await writeFile(path.join(project, '.env.example'), original);
  const result = run(project, ['setup', '--skills', 'reconciliation'], undefined, { env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Files: complete; runtime prerequisites: missing or unverified/);
  assert.match(result.stdout, /missing: python/);
  assert.doesNotMatch(result.stdout + result.stderr, /leave-untouched|secret-no-echo/);
  assert.equal(await readFile(path.join(project, '.env.example'), 'utf8'), original);
  assert.ok((await readFile(path.join(project, '.builder/skills/antom-reconciliation-expert/SKILL.md'), 'utf8')).length > 0);
});

test('setup reports partial installation accurately when config replacement fails during writing', async (t) => {
  const project = await temporaryProject(t);
  const target = path.join(project, '.env.example');
  await writeFile(target, 'PORT=3000\n');
  const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    fs.promises.rename = async () => { throw new Error('filesystem-secret-no-echo'); };
    syncBuiltinESMExports();
    process.argv = ${JSON.stringify([process.execPath, CLI, ...SETUP, '--project', project])};
    await import(${JSON.stringify(pathToFileURL(CLI).href)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: project, encoding: 'utf8', input: JSON.stringify(CONFIG), timeout: 7000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Some skill files or .env.example may already have been installed or updated/);
  assert.match(result.stderr, /not rolled back/);
  assert.doesNotMatch(result.stderr, /No files were written|filesystem-secret-no-echo/);
  assert.ok((await readFile(path.join(project, '.builder/skills/antom-integration/SKILL.md'), 'utf8')).length > 0);
  assert.equal(await readFile(target, 'utf8'), 'PORT=3000\n');
  assert.ok(!(await readdir(project)).some((name) => name.endsWith('.tmp')));
});

test('setup preserves concurrent env edits made after preflight and reports the partial installation', async (t) => {
  const project = await temporaryProject(t);
  const target = path.join(project, '.env.example');
  await writeFile(target, 'PORT=3000\n');
  const concurrent = 'PORT=4000\nANTOM_CLIENT_ID=concurrent-no-echo\n';
  const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const open = fs.promises.open;
    let changed = false;
    fs.promises.open = async (target, flags, ...rest) => {
      if (!changed && String(target).includes('.builder') && (flags & fs.constants.O_CREAT)) {
        changed = true;
        await fs.promises.writeFile(${JSON.stringify(target)}, ${JSON.stringify(concurrent)});
      }
      return open(target, flags, ...rest);
    };
    syncBuiltinESMExports();
    process.argv = ${JSON.stringify([process.execPath, CLI, ...SETUP, '--project', project])};
    await import(${JSON.stringify(pathToFileURL(CLI).href)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: project, encoding: 'utf8', input: JSON.stringify(CONFIG), timeout: 7000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /may already have been installed or updated/);
  assert.doesNotMatch(result.stderr, /No files were written|concurrent-no-echo/);
  assert.equal(await readFile(target, 'utf8'), concurrent);
  assert.ok((await readFile(path.join(project, '.builder/skills/antom-integration/SKILL.md'), 'utf8')).length > 0);
});
