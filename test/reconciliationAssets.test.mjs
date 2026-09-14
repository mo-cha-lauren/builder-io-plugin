import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const assetRoot = fileURLToPath(
  new URL('../vendor/antom-reconciliation-expert/', import.meta.url)
);
const metadata = JSON.parse(
  await readFile(new URL('../vendor/antom-reconciliation-source.json', import.meta.url), 'utf8')
);

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.equal(entry.isSymbolicLink(), false, `${relative} must not be a symlink`);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.join(directory, entry.name), relative));
    } else {
      assert.ok(entry.isFile(), `${relative} must be a regular file`);
      files.push(relative);
    }
  }
  return files.sort();
}

test('reconciliation payload includes the complete pinned upstream tree and license', async () => {
  assert.equal(metadata.repository, 'https://github.com/ant-intl/antom-ai-tools');
  assert.match(metadata.commit, /^[a-f0-9]{40}$/);
  assert.equal(metadata.path, 'skills/antom-reconciliation-expert');
  assert.equal(metadata.license, 'MIT');
  assert.equal(metadata.files.length, 16);
  assert.equal(new Set(metadata.files.map(file => file.path)).size, metadata.files.length);
  assert.deepEqual(await listFiles(assetRoot), metadata.files.map(file => file.path).sort());

  for (const file of metadata.files) {
    assert.ok(!path.isAbsolute(file.path) && !file.path.split('/').includes('..'));
    assert.equal(
      file.sourcePath,
      file.path === 'UPSTREAM_LICENSE' ? 'LICENSE' : `${metadata.path}/${file.path}`
    );
    const bytes = await readFile(path.join(assetRoot, file.path));
    assert.equal(bytes.length, file.bytes, `${file.path}: exact upstream byte length`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
    assert.equal(
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
      file.gitBlobSha,
      `${file.path}: exact upstream Git blob`
    );
  }

  const license = await readFile(path.join(assetRoot, 'UPSTREAM_LICENSE'), 'utf8');
  assert.match(license, /^MIT License\n/);
  assert.match(license, /Copyright \(c\) 2026 Antom/);
});

test('reconciliation distribution records the unchanged online Live environment boundary', async () => {
  for (const relative of [
    'scripts/io_modules/bill_list_api.py',
    'scripts/retrieval/transaction_detail_query.py',
  ]) {
    assert.match(await readFile(path.join(assetRoot, relative), 'utf8'), /"--live"/);
  }
  assert.match(metadata.distributionNotes.join('\n'), /hardcoded --live/);
  assert.match(metadata.runtime.network, /CDN/);
  assert.match(metadata.runtime.antomCli, /not required for supplied-file analysis/);
});
