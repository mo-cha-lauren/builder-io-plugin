import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSkillBundle } from '../scripts/build-skill-bundle.mjs';
import { createGithubSource } from '../scripts/build-github-source.mjs';
import { checkGithubSource, createGithubSetupPrompt, validateGithubSource } from '../src/githubInstall.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await createSkillBundle(root);
const revision = 'a'.repeat(40);
const source = createGithubSource(bundle, revision);
const clone = (value) => structuredClone(value);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function harness(metadata = source) {
  const requests = [];
  const assets = new Map([[`${metadata.baseUrl}manifest.json`, `${JSON.stringify(metadata.manifest, null, 2)}\n`]]);
  for (const skill of bundle.skills) {
    for (const file of skill.files) assets.set(`${metadata.baseUrl}${file.path.replace(/^\.builder\//, '')}`, file.content);
  }
  const options = {
    cryptoApi: webcrypto,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return assets.has(url) ? new Response(assets.get(url)) : new Response('missing', { status: 404 });
    },
  };
  return { options, assets, requests };
}

test('GitHub manifest is fixed to a commit and verifies without contacting npm or sending settings', async () => {
  const { options, requests } = harness();
  assert.equal(validateGithubSource(source, bundle.package), source.manifest);
  const result = await checkGithubSource(source, options);
  assert.equal(result.status, 'available');
  assert.match(result.message, /installation is not yet verified/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${source.baseUrl}manifest.json`);
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.referrerPolicy, 'no-referrer');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.cache, 'no-store');
  assert.equal(requests[0].init.body, undefined);
});

test('GitHub setup verifies all selected files and requests native data import, never installer execution', async () => {
  const { options, requests } = harness();
  const prompt = await createGithubSetupPrompt(bundle.package, ['integration'], {}, source, options);
  assert.equal(requests.length, 6);
  assert.equal(requests.filter(({ url }) => url.includes('/antom-reconciliation-expert/')).length, 0);
  const data = JSON.parse(prompt.match(/```json\n([\s\S]+)\n```/)[1]);
  assert.equal(data.files.length, 5);
  assert.equal(data.revision, revision);
  assert.equal(data.nonSecretPaymentConfig.settings.authMode, 'rsa');
  assert.match(prompt, /DATA-ONLY import/);
  assert.match(prompt, /Do not run shell, npm, npx, Node, Python/);
  assert.match(prompt, /Do not create tools\/antom-builder/);
  assert.match(prompt, /Destination SHA-256 not verified/);
  assert.match(prompt, /fully read back every target/);
  assert.doesNotMatch(prompt, /```(?:sh|bash)|npm exec|node tools\//);
  assert.ok(data.files.every((file) => file.url.startsWith(source.baseUrl)));
});

test('both Skills retain every file and bill-only import never inspects payment settings', async () => {
  const setup = harness();
  const prompt = await createGithubSetupPrompt(bundle.package, ['reconciliation', 'integration'], {}, source, setup.options);
  assert.equal(setup.requests.length, 25);
  assert.equal(JSON.parse(prompt.match(/```json\n([\s\S]+)\n```/)[1]).files.length, 24);
  const bill = harness();
  const forbidden = new Proxy({}, { get() { throw new Error('Payment settings accessed'); } });
  const billPrompt = await createGithubSetupPrompt(bundle.package, ['reconciliation'], forbidden, source, bill.options);
  assert.equal(bill.requests.length, 20);
  assert.doesNotMatch(billPrompt, /nonSecretPaymentConfig/);
  assert.match(billPrompt, /do not read, create or change .env.example/);
});

test('API Key mode serializes only validated reference settings and keeps notify RSA', async () => {
  const { options } = harness();
  const prompt = await createGithubSetupPrompt(bundle.package, ['integration'], { authMode: 'api_key' }, source, options);
  assert.match(prompt, /"authMode": "api_key"/);
  assert.match(prompt, /notify always uses RSA/);
  assert.match(prompt, /empty placeholders/);
  const bad = harness();
  await assert.rejects(createGithubSetupPrompt(bundle.package, ['integration'], { authMode: 'shell; echo nope' }, source, bad.options));
  assert.equal(bad.requests.length, 0);
});

test('invalid source identities, URLs, paths, sizes and collisions fail before network', async () => {
  const modifications = [
    (value) => { value.repository = 'other/repo'; },
    (value) => { value.revision = 'main'; },
    (value) => { value.baseUrl = 'https://example.invalid/'; },
    (value) => { value.manifest.revision = 'b'.repeat(40); },
    (value) => { value.manifest.skills[0].files[0].url += '?credential=bad'; },
    (value) => { value.manifest.skills[0].files[0].path = '.builder/skills/antom-integration/../outside'; },
    (value) => { value.manifest.skills[0].files[0].path = '/outside'; },
    (value) => { value.manifest.skills[0].files[0].bytes = 9999999; },
    (value) => { value.manifest.skills[0].files[0].sha256 = 'invalid'; },
    (value) => { value.manifest.skills[0].files.push(value.manifest.skills[0].files[0]); },
    (value) => { value.manifest.skills[0].files = value.manifest.skills[0].files.filter((file) => !file.path.endsWith('/SKILL.md')); },
  ];
  for (const modify of modifications) {
    const value = clone(source);
    modify(value);
    const { options, requests } = harness(value);
    assert.equal((await checkGithubSource(value, options)).status, 'unavailable');
    assert.equal(requests.length, 0);
  }
});

test('changed, missing, truncated or oversized source responses never produce a setup request', async () => {
  const file = source.manifest.skills[0].files[0];
  for (const replacement of ['changed', '', `${bundle.skills[0].files[0].content}extra`]) {
    const { options, assets } = harness();
    assets.set(file.url, replacement);
    await assert.rejects(createGithubSetupPrompt(bundle.package, ['integration'], {}, source, options));
  }
  const absent = harness();
  absent.assets.delete(file.url);
  await assert.rejects(createGithubSetupPrompt(bundle.package, ['integration'], {}, source, absent.options));
  const manifest = harness();
  manifest.assets.set(`${source.baseUrl}manifest.json`, '{}');
  assert.equal((await checkGithubSource(source, manifest.options)).status, 'unavailable');
  const huge = harness();
  huge.options.fetchImpl = async () => new Response('small', { headers: { 'content-length': '99999999' } });
  assert.equal((await checkGithubSource(source, huge.options)).status, 'unavailable');
});

test('untrusted redirects, missing WebCrypto and invalid UTF-8 are rejected', async () => {
  const redirected = harness();
  redirected.options.fetchImpl = async () => ({ ok: true, redirected: true });
  assert.equal((await checkGithubSource(source, redirected.options)).status, 'unavailable');
  const noCrypto = harness();
  noCrypto.options.cryptoApi = {};
  assert.equal((await checkGithubSource(source, noCrypto.options)).status, 'unavailable');
  const altered = clone(source);
  const bytes = Uint8Array.of(0xff, 0xfe);
  altered.manifest.skills[0].files[0].sha256 = digest(bytes);
  altered.manifest.skills[0].files[0].bytes = 2;
  altered.manifestSha256 = digest(`${JSON.stringify(altered.manifest, null, 2)}\n`);
  const invalid = harness(altered);
  invalid.assets.set(altered.manifest.skills[0].files[0].url, bytes);
  await assert.rejects(createGithubSetupPrompt(bundle.package, ['integration'], {}, altered, invalid.options));
});

test('source timeout and cancellation are bounded even if fetch ignores abort', async () => {
  const stalled = { fetchImpl: () => new Promise(() => {}), cryptoApi: webcrypto, timeoutMs: 5 };
  assert.equal((await checkGithubSource(source, stalled)).status, 'unavailable');
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  assert.equal((await checkGithubSource(source, {
    signal: controller.signal, cryptoApi: webcrypto, fetchImpl: () => { calls++; return new Promise(() => {}); },
  })).status, 'unavailable');
  assert.equal(calls, 0);
});
