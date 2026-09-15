import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { OFFICIAL_SKILL_SOURCE } from '../src/officialSkillInstall.mjs';
import { buildPages } from '../scripts/build-pages.mjs';
import { createSkillBundle } from '../scripts/build-skill-bundle.mjs';
import { createGithubSource, GITHUB_REPOSITORY, PAGES_ORIGIN } from '../scripts/build-github-source.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fixtureInputs = [
  'package.json', 'LICENSE', 'LEGAL.md',
  '.builder/skills/antom-integration',
  'vendor/antom-reconciliation-expert',
  'vendor/antom-reconciliation-source.json',
  'adapters/reconciliation/BUILDER_ADDENDUM.md',
];

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'antom-pages-build-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t) {
  const project = await temporaryDirectory(t);
  for (const relative of fixtureInputs) {
    const destination = path.join(project, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repository, relative), destination, { recursive: true });
  }
  const bundle = await createSkillBundle(project);
  const source = createGithubSource(bundle, REVISION);
  await mkdir(path.join(project, '.generated'));
  await writeFile(path.join(project, '.generated/skill-bundle.json'), JSON.stringify(bundle));
  await writeFile(path.join(project, '.generated/github-source.json'), JSON.stringify(source));
  await mkdir(path.join(project, 'dist'));
  // The unit boundary checks staging and pins, not execution of the real browser bundle.
  const plugin = Buffer.from(`/* fixture official source: ${OFFICIAL_SKILL_SOURCE.repository} ${OFFICIAL_SKILL_SOURCE.revision} */\n`);
  await writeFile(path.join(project, 'dist/plugin.system.js'), plugin);
  await writeFile(path.join(project, 'dist/plugin.system.js.LICENSE.txt'), 'Fixture dependency notice.\n');
  return { project, bundle, source, plugin };
}

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${item.name}`;
    if (item.isDirectory()) files.push(...await listFiles(path.join(directory, item.name), `${relative}/`));
    else {
      assert.ok(item.isFile(), `Unexpected non-regular staged file: ${relative}`);
      files.push(relative);
    }
  }
  return files.sort();
}

async function assertNoOutput(project) {
  await assert.rejects(lstat(path.join(project, '.pages')), { code: 'ENOENT' });
}

async function createTestSymlink(t, target, linkPath, type) {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'ENOTSUP'].includes(error.code)) {
      t.skip('This Windows account lacks symlink privileges.');
      return false;
    }
    throw error;
  }
}

test('Pages publishes browser assets and official source metadata, never mirrored Skills or config', async (t) => {
  const { project, bundle, plugin } = await fixture(t);
  for (const relative of ['.git/config', '.env', 'node_modules/private.js', 'src/private.js', 'dist/unreviewed.txt']) {
    await mkdir(path.dirname(path.join(project, relative)), { recursive: true });
    await writeFile(path.join(project, relative), 'Synthetic excluded fixture.\n');
  }
  const result = await buildPages(project, { revision: REVISION });
  const prefix = `releases/${REVISION}/`;
  const expectedFiles = [
    '.nojekyll', 'index.html', 'release.json', 'LICENSE', 'LEGAL.md',
    'plugin.system.js', 'plugin.system.js.LICENSE.txt',
    prefix + 'plugin.system.js', prefix + 'plugin.system.js.LICENSE.txt',
  ].sort();
  assert.deepEqual(await listFiles(result.output), expectedFiles);
  assert.equal(result.stagedFiles, expectedFiles.length);
  assert.equal(result.skillFiles, 0);
  assert.deepEqual(await readFile(path.join(result.output, 'plugin.system.js')), plugin);
  assert.deepEqual(await readFile(path.join(result.output, prefix, 'plugin.system.js')), plugin);
  const release = JSON.parse(await readFile(path.join(result.output, 'release.json'), 'utf8'));
  assert.deepEqual(release, {
    formatVersion: 1, repository: GITHUB_REPOSITORY, revision: REVISION,
    pluginUrl: PAGES_ORIGIN + '/plugin.system.js?pluginId=' + encodeURIComponent(bundle.package.name),
    pluginSha256: hash(plugin), officialSkillSource: OFFICIAL_SKILL_SOURCE, skillFiles: 0,
  });
  const html = await readFile(path.join(result.output, 'index.html'), 'utf8');
  assert.ok(html.includes(release.pluginUrl));
  assert.ok(html.includes(REVISION));
  assert.ok(html.includes(OFFICIAL_SKILL_SOURCE.repository));
  assert.match(html, /Builder cloud installation.*require separate acceptance/);
  assert.match(html, /Copy install prompt.*Builder Agent chat.*start a new chat/);
  assert.match(html, /custom\/private-plugin entitlement/);
  assert.match(html, /public GitHub repository is not an approved Builder public plugin/);
  assert.match(html, /There are no payment settings/);
  assert.match(html, /currently offers only antom-integration/);
  assert.doesNotMatch(html, /Bill analysis|antom-reconciliation-expert/);
  assert.doesNotMatch(html, /review any payment settings|Download Skill ZIP|Download config|Copy setup request/);
});

test('Pages rejects a different build revision before creating output', async (t) => {
  const { project } = await fixture(t);
  await assert.rejects(buildPages(project, { revision: 'f'.repeat(40) }), /Rebuild the plugin at the Pages revision/);
  await assertNoOutput(project);
});

test('Pages rejects malformed revisions and output paths without touching project files', async (t) => {
  const { project } = await fixture(t);
  const before = await listFiles(project);
  for (const revision of ['', 'main', '1234567', 'F'.repeat(40), '../outside']) {
    await assert.rejects(buildPages(project, { revision }), /complete commit SHA/);
  }
  for (const output of ['', '.', '..', '../outside', 'nested/pages', '/tmp/pages-output', 'C:\\pages', '.git', '.env', 'src', 'dist', 'node_modules']) {
    await assert.rejects(buildPages(project, { revision: REVISION, output }), /output directory name|replace a project directory/);
  }
  assert.deepEqual(await listFiles(project), before);
  await assertNoOutput(project);
});

test('Pages preserves nonempty output and never overwrites prior publication files', async (t) => {
  const { project } = await fixture(t);
  const destination = path.join(project, '.pages');
  await mkdir(destination);
  await writeFile(path.join(destination, 'keep.txt'), 'Existing user content.\n');
  await assert.rejects(buildPages(project, { revision: REVISION }), /empty regular directory; nothing was removed/);
  assert.deepEqual(await readdir(destination), ['keep.txt']);
  assert.equal(await readFile(path.join(destination, 'keep.txt'), 'utf8'), 'Existing user content.\n');
});

test('Pages accepts an empty dedicated output directory', async (t) => {
  const { project } = await fixture(t);
  await mkdir(path.join(project, 'pages-output'));
  const result = await buildPages(project, { revision: REVISION, output: 'pages-output' });
  assert.equal(result.output, path.join(project, 'pages-output'));
  assert.ok((await readdir(result.output)).includes('release.json'));
});

test('Pages rejects tampered generated source or Skill data and a mismatched plugin pin', async (t) => {
  for (const kind of ['source', 'bundle', 'plugin']) {
    await t.test(kind, async (st) => {
      const { project, source, bundle } = await fixture(st);
      if (kind === 'source') {
        source.manifestSha256 = '0'.repeat(64);
        await writeFile(path.join(project, '.generated/github-source.json'), JSON.stringify(source));
      } else if (kind === 'bundle') {
        bundle.skills[0].files[0].content += 'Tampered generated text.\n';
        await writeFile(path.join(project, '.generated/skill-bundle.json'), JSON.stringify(bundle));
      } else {
        await writeFile(path.join(project, 'dist/plugin.system.js'), '/* wrong build */\n');
      }
      await assert.rejects(buildPages(project, { revision: REVISION }), /Rebuild|matching official Skill source pin/);
      await assertNoOutput(project);
    });
  }
});

test('Pages rejects symlinked dist directory and plugin inputs', async (t) => {
  for (const kind of ['directory', 'file']) {
    await t.test(kind, async (st) => {
      const { project } = await fixture(st);
      const original = kind === 'directory' ? 'dist' : 'dist/plugin.system.js';
      const moved = `${original}.original`;
      await rename(path.join(project, original), path.join(project, moved));
      if (!(await createTestSymlink(st, path.join(project, moved), path.join(project, original), kind === 'directory' ? 'dir' : 'file'))) return;
      await assert.rejects(buildPages(project, { revision: REVISION }), /Non-regular Pages input/);
      await assertNoOutput(project);
    });
  }
});

test('Pages rejects a symlinked output and leaves its destination untouched', async (t) => {
  const { project } = await fixture(t);
  const outside = await temporaryDirectory(t);
  if (!(await createTestSymlink(t, outside, path.join(project, '.pages'), 'dir'))) return;
  await assert.rejects(buildPages(project, { revision: REVISION }), /empty regular directory; nothing was removed/);
  assert.deepEqual(await readdir(outside), []);
});
