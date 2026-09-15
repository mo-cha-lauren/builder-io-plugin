// Historical CLI regression only; the v3 browser flow uses native Agent file tools.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OFFICIAL_SKILL_SOURCE } from '../src/officialSkillInstall.mjs';
import { getSkillSelectionKey } from '../src/installExperience.mjs';

// Historical coverage is independent of the integration-only customer catalog.
function selectedOfficialSkills(selection) {
  const names = { integration: 'antom-integration', reconciliation: 'antom-reconciliation-expert' };
  return getSkillSelectionKey(selection).split(',').map(id => ({ name: names[id] }));
}

// Retain the old CLI test independently; never expose this command in the panel.
function legacyInstallCommand(selection) {
  const names = selectedOfficialSkills(selection).map(({ name }) => name).join(' ');
  return `DISABLE_TELEMETRY=1 npx --yes --registry=https://registry.npmjs.org skills@1.5.26 add ${OFFICIAL_SKILL_SOURCE.repository}/tree/${OFFICIAL_SKILL_SOURCE.revision}/skills --skill ${names} --agent claude-code --copy --yes`;
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = await mkdtemp(path.join(tmpdir(), 'antom-official-smoke-'));
const env = { ...process.env, DISABLE_TELEMETRY: '1', npm_config_cache: path.join(temporary, 'npm-cache') };
const run = (bin, args, cwd, output = 'pipe') => execFileSync(bin, args, { cwd, env, stdio: output, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
async function listFiles(dir, prefix = '') {
  const results = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    const stat = await lstat(path.join(dir, entry.name));
    assert.ok(!stat.isSymbolicLink(), relative);
    if (stat.isDirectory()) results.push(...await listFiles(path.join(dir, entry.name), `${relative}/`));
    else { assert.ok(stat.isFile() && stat.nlink === 1, relative); results.push(relative); }
  }
  return results.sort();
}

try {
  const upstream = path.join(temporary, 'upstream');
  run('git', ['clone', '--no-checkout', OFFICIAL_SKILL_SOURCE.repository, upstream], temporary);
  const revision = OFFICIAL_SKILL_SOURCE.revision;
  assert.equal(run('git', ['rev-parse', `${revision}^{commit}`], upstream).toString().trim(), revision);
  for (const selection of [['integration'], ['reconciliation'], ['integration', 'reconciliation']]) {
    const project = path.join(temporary, selection.join('-'));
    await mkdir(project);
    await writeFile(path.join(project, 'package.json'), '{"name":"isolated-install-fixture","private":true}\n');
    // Synthetic fixtures only; no real environment files or credentials are accessed.
    const keep = new Map([
      ['app.txt', 'existing app\n'], ['.env.example', 'SYNTHETIC_PLACEHOLDER=\n'],
      ['.claude/skills/unrelated/SKILL.md', 'unrelated skill\n'],
    ]);
    for (const [relative, contents] of keep) {
      await mkdir(path.dirname(path.join(project, relative)), { recursive: true });
      await writeFile(path.join(project, relative), contents);
    }
    const priorLock = { source: 'example/fixture', sourceType: 'github', computedHash: 'fixture-hash' };
    await writeFile(path.join(project, 'skills-lock.json'), JSON.stringify({ version: 1, skills: { unrelated: priorLock } }));
    console.log(`Historical CLI regression (not the v3 installation flow): ${selection.join(', ')}`);
    run('sh', ['-c', legacyInstallCommand(selection)], project, 'inherit');
    const expectedPaths = [...keep.keys(), 'package.json', 'skills-lock.json'];
    for (const { name } of selectedOfficialSkills(selection)) {
      const prefix = `skills/${name}/`;
      const sourcePaths = run('git', ['ls-tree', '-r', '--name-only', revision, '--', prefix], upstream)
        .toString().trim().split('\n').filter(Boolean);
      const installed = path.join(project, '.claude/skills', name);
      assert.deepEqual(await listFiles(installed), sourcePaths.map(p => p.slice(prefix.length)).sort());
      for (const sourcePath of sourcePaths) {
        const destination = `.claude/${sourcePath}`;
        const original = run('git', ['show', `${revision}:${sourcePath}`], upstream);
        assert.equal(hash(await readFile(path.join(project, destination))), hash(original), destination);
        expectedPaths.push(destination);
      }
      console.log(`${name}: ${sourcePaths.length} original files; destination SHA-256 matches upstream.`);
    }
    for (const [relative, contents] of keep) assert.equal(await readFile(path.join(project, relative), 'utf8'), contents);
    assert.deepEqual(JSON.parse(await readFile(path.join(project, 'skills-lock.json'), 'utf8')).skills.unrelated, priorLock);
    assert.deepEqual(await listFiles(project), expectedPaths.sort());
    console.log('No GitHub remote required; unrelated files and prior lock entry preserved.');
  }
  console.log('Historical CLI smoke passed. This does not test v3 source reading, native file writes or Builder discovery.');
} finally {
  // This path is exclusively created by mkdtemp above, never a user project.
  await rm(temporary, { recursive: true, force: true });
}
