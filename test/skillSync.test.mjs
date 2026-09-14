import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const skillDirectory = fileURLToPath(
  new URL('../.builder/skills/antom-integration/', import.meta.url)
);
const [upstream, addendum, generated, metadataText] = await Promise.all([
  readFile(`${skillDirectory}UPSTREAM_SKILL.md`, 'utf8'),
  readFile(`${skillDirectory}BUILDER_ADDENDUM.md`, 'utf8'),
  readFile(`${skillDirectory}SKILL.md`, 'utf8'),
  readFile(`${skillDirectory}antom-skill-source.json`, 'utf8'),
]);
const metadata = JSON.parse(metadataText);

test('pinned upstream skill matches its recorded digest', () => {
  assert.equal(createHash('sha256').update(upstream).digest('hex'), metadata.sha256);
});

test('generated skill is exactly upstream plus one Builder addendum', () => {
  assert.equal(generated, `${upstream.trimEnd()}\n\n${addendum.trimEnd()}\n`);
  assert.equal(generated.match(/^# Builder\.io Plugin Addendum$/gm)?.length, 1);
  assert.match(generated, /FAQ \(Coding\)/);
  assert.match(generated, /Troubleshooting Guide/);
  assert.doesNotMatch(generated, /create antom\.env/i);
  assert.doesNotMatch(generated, /ISO8601/i);
});

test('Builder addendum scopes Bearer to ordinary requests and preserves RSA notify', () => {
  assert.match(addendum, /Missing mode in legacy configuration defaults to `rsa`/);
  assert.match(addendum, /Authorization: Bearer <ANTOM_API_KEY>/);
  assert.match(addendum, /All notify-related interfaces always use RSA/);
  assert.match(addendum, /Never replace notify authentication with Bearer/);
  assert.match(addendum, /Do not infer that changing outbound request authentication removes required response verification/);
  assert.match(addendum, /Do not silently fall back/);
  assert.match(addendum, /invalid or missing signatures are rejected/);
  assert.match(addendum, /Keep both `ANTOM_API_KEY` and `ANTOM_MERCHANT_PRIVATE_KEY` empty/);
  assert.match(addendum, /Do not invent API key SDK parameters/);
});
