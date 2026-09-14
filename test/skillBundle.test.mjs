import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { unzipSync } from 'fflate';
import { createSkillBundle, createSkillDownloads } from '../scripts/build-skill-bundle.mjs';

const bundle = await createSkillBundle();
const downloads = createSkillDownloads(bundle);

test('all pinned Skill content hashes match and payloads contain no internal review or project secrets', () => {
  assert.deepEqual(bundle.skills.map((skill) => skill.id), ['integration', 'reconciliation']);
  for (const skill of bundle.skills) {
    assert.ok(skill.files.some((file) => file.path.endsWith('/SKILL.md')));
    assert.ok(skill.files.some((file) => file.path.endsWith('/UPSTREAM_LICENSE')));
    for (const file of skill.files) {
      assert.equal(createHash('sha256').update(file.content).digest('hex'), file.sha256);
      assert.match(file.path, /^\.builder\/skills\/antom-/);
      assert.doesNotMatch(file.path, /(?:CODE_REVIEW|\.git\/|\.env|docs\/media)/i);
    }
  }
  const recon = bundle.skills.find((skill) => skill.id === 'reconciliation');
  assert.ok(recon.files.some((file) => file.path.endsWith('/scripts/core/parser.py')));
  assert.ok(recon.files.some((file) => file.path.endsWith('/scripts/cli.py')));
  assert.match(recon.limitations.join(' '), /--live/);
});

test('each ZIP contains exactly the same complete files as the selected installer payload', () => {
  assert.deepEqual(Object.keys(downloads), ['integration', 'reconciliation', 'integration,reconciliation']);
  for (const [key, base64] of Object.entries(downloads)) {
    const extracted = unzipSync(Buffer.from(base64, 'base64'));
    const expected = bundle.skills.filter((skill) => key.split(',').includes(skill.id)).flatMap((skill) => skill.files);
    assert.deepEqual(Object.keys(extracted).sort(), expected.map((file) => file.path).sort());
    for (const file of expected) assert.equal(Buffer.from(extracted[file.path]).toString('utf8'), file.content);
  }
  assert.deepEqual(createSkillDownloads(bundle), downloads);
});

test('webpack emits the reviewed bundle and matching downloadable archives into the npm dist directory', async () => {
  const packaged = JSON.parse(await readFile(new URL('../dist/skill-bundle.json', import.meta.url), 'utf8'));
  assert.deepEqual(packaged, bundle);
  for (const [selection, base64] of Object.entries(downloads)) {
    const archive = await readFile(new URL(`../dist/antom-skills-${selection.replace(',', '-')}.zip`, import.meta.url));
    assert.deepEqual(archive, Buffer.from(base64, 'base64'));
  }
});
