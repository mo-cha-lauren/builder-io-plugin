import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { createBuildMetadata } from '../scripts/build-metadata.mjs';
import { OFFICIAL_SKILL_SOURCE } from '../src/officialSkillInstall.mjs';

test('release metadata binds the exact browser bytes and official installation source', () => {
  const plugin = Buffer.from('fixture bytes');
  const revision = 'a'.repeat(40);
  assert.deepEqual(createBuildMetadata(plugin, revision), {
    revision, pluginSha256: createHash('sha256').update(plugin).digest('hex'),
    officialSkillSource: OFFICIAL_SKILL_SOURCE,
  });
  for (const invalid of ['', 'main', 'a'.repeat(39), '../outside']) {
    assert.throws(() => createBuildMetadata(plugin, invalid), /complete commit SHA/);
  }
});

test('production output has no retired settings, installer, mirrored Skills or archives', async () => {
  assert.deepEqual((await readdir(new URL('../dist/', import.meta.url))).sort(), [
    'build-metadata.json', 'plugin.system.js', 'plugin.system.js.LICENSE.txt',
  ]);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.bin, undefined);
  assert.equal(pkg.antomBuilder, undefined);
  assert.deepEqual(pkg.files, [
    'dist/plugin.system.js', 'dist/plugin.system.js.LICENSE.txt',
    'docs/media/builder-installation.png', 'docs/media/antom-integration-demo.gif',
  ]);
  const metadata = JSON.parse(await readFile(new URL('../dist/build-metadata.json', import.meta.url), 'utf8'));
  const plugin = await readFile(new URL('../dist/plugin.system.js', import.meta.url));
  assert.deepEqual(metadata, createBuildMetadata(plugin, metadata.revision));
});

test('CI pins Actions, uses read-only repository access and clears checkout credentials', async () => {
  const { default: YAML } = await import('yaml');
  const workflow = YAML.parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job['timeout-minutes'] > 0);
    for (const step of job.steps.filter(step => step.uses)) {
      assert.match(step.uses, /^actions\/(checkout|setup-node)@[a-f0-9]{40}$/);
      if (step.uses.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
    }
  }
});
