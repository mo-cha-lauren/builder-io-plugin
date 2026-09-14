import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const skillDirectory = fileURLToPath(
  new URL('../.builder/skills/antom-integration/', import.meta.url)
);
const upstreamPath = `${skillDirectory}UPSTREAM_SKILL.md`;
const addendumPath = `${skillDirectory}BUILDER_ADDENDUM.md`;
const metadataPath = `${skillDirectory}antom-skill-source.json`;
const generatedPath = `${skillDirectory}SKILL.md`;
const checkOnly = process.argv.includes('--check');

const [upstream, addendum, metadataText] = await Promise.all([
  readFile(upstreamPath, 'utf8'),
  readFile(addendumPath, 'utf8'),
  readFile(metadataPath, 'utf8'),
]);
const metadata = JSON.parse(metadataText);
const actualHash = createHash('sha256').update(upstream).digest('hex');

if (actualHash !== metadata.sha256) {
  throw new Error(
    `Pinned Antom skill hash mismatch: expected ${metadata.sha256}, received ${actualHash}`
  );
}

const generated = `${upstream.trimEnd()}\n\n${addendum.trimEnd()}\n`;

if (checkOnly) {
  const current = await readFile(generatedPath, 'utf8').catch(() => '');
  if (current !== generated) {
    throw new Error('Generated Antom SKILL.md is stale. Run npm run sync:antom-skill.');
  }
  console.log(`Antom skill is synchronized to ${metadata.commit}.`);
} else {
  await writeFile(generatedPath, generated, 'utf8');
  console.log(`Synchronized Antom skill to ${metadata.commit}.`);
}
