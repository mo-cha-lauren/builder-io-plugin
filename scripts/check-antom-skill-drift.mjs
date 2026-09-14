import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const metadataPath = fileURLToPath(
  new URL('../.builder/skills/antom-integration/antom-skill-source.json', import.meta.url)
);
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
const response = await fetch(metadata.latestUrl, {
  headers: { 'user-agent': 'antom-builder-io-plugin-skill-drift-check' },
});

if (!response.ok) {
  throw new Error(`Unable to fetch upstream Antom skill: HTTP ${response.status}`);
}

const latest = await response.text();
const latestHash = createHash('sha256').update(latest).digest('hex');

if (latestHash !== metadata.sha256) {
  throw new Error(
    `Upstream Antom skill changed (${metadata.sha256} -> ${latestHash}). Review and repin it.`
  );
}

console.log(`No Antom skill drift detected at ${metadata.latestUrl}.`);
