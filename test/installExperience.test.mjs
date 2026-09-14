import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  createCheckCommand,
  createConfigCommand,
  createConfigExport,
  createInstallCommand,
  downloadBlob,
  downloadConfigFile,
  downloadSkillArchive,
  getSkillSelectionKey,
} from '../src/installExperience.mjs';

const pkg = { name: '@antglobal/builder-io-plugin-antom-payment', version: '1.0.0' };
const prefix = `npm exec --package=${pkg.name}@${pkg.version} -- antom-builder`;

test('selection is allowlisted, canonical, and nonempty', () => {
  assert.equal(getSkillSelectionKey(['integration']), 'integration');
  assert.equal(getSkillSelectionKey(['reconciliation']), 'reconciliation');
  assert.equal(getSkillSelectionKey(['reconciliation', 'integration', 'integration']), 'integration,reconciliation');
  for (const value of [[], null, 'integration', ['cli'], ['integration;echo bad'], ['__proto__'], [1]]) {
    assert.throws(() => getSkillSelectionKey(value));
  }
});

test('commands pin the package version and contain no merchant settings', () => {
  assert.equal(createInstallCommand(pkg, ['integration']), `${prefix} install --skills integration`);
  assert.equal(createInstallCommand(pkg, ['reconciliation', 'integration']), `${prefix} install --skills integration,reconciliation`);
  assert.equal(createCheckCommand(pkg, ['reconciliation']), `${prefix} check --skills reconciliation`);
  assert.equal(createConfigCommand(pkg), `${prefix} config --file antom.config.json`);
  assert.ok(createInstallCommand({ ...pkg, version: '2.3.4-beta.1' }, ['integration']).includes('@2.3.4-beta.1 '));
  assert.equal(createConfigCommand({ ...pkg, clientId: 'secret merchant value' }), createConfigCommand(pkg));
});

test('commands reject shell metacharacters and unpinned package metadata', () => {
  for (const value of [null, {}, { ...pkg, name: '@scope/pkg;echo' }, { ...pkg, name: 'pkg$(whoami)' },
    { ...pkg, name: '--evil' }, { ...pkg, version: 'latest' }, { ...pkg, version: '^1.0.0' },
    { ...pkg, version: '1.0.0 && echo' }, { ...pkg, version: '1.0.0\n' }]) {
    assert.throws(() => createConfigCommand(value));
  }
});

test('config exports only normalized non-secret fields and validates the RSA key', async () => {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const text = await createConfigExport({
    clientId: ' client-1 ', antomPublicKey: publicKey, environment: 'sandbox', keyVersion: '2',
    gatewayOrigin: 'https://open-sea-global.alipay.com/', refreshedAt: 'today',
    merchantPrivateKey: 'must not export', apiKey: 'api-secret-must-not-export',
    authorization: 'Bearer must-not-export', notifyAuthMode: 'api_key', unknown: 'not exported',
  }, { cryptoObject: webcrypto });
  const exported = JSON.parse(text);
  assert.equal(exported.formatVersion, 2);
  assert.deepEqual(Object.keys(exported.settings).sort(),
    ['clientId', 'antomPublicKey', 'environment', 'keyVersion', 'gatewayOrigin', 'authMode'].sort());
  assert.equal(exported.settings.authMode, 'rsa');
  assert.equal(exported.settings.clientId, 'client-1');
  assert.equal(exported.settings.gatewayOrigin, 'https://open-sea-global.alipay.com');
  assert.doesNotMatch(exported.settings.antomPublicKey, /[\s-]/);
  assert.doesNotMatch(text, /must not export|not exported|must-not-export|refreshedAt|merchantPrivateKey|apiKey|authorization|notifyAuthMode/);
  assert.ok(text.endsWith('\n'));
});

test('config exports either ordinary authentication mode but never API Key credentials or a notify override', async () => {
  for (const authMode of ['rsa', 'api_key']) {
    const text = await createConfigExport({
      authMode,
      apiKey: 'secret-placeholder-do-not-export',
      ANTOM_API_KEY: 'secret-placeholder-do-not-export',
      merchantPrivateKey: 'private-placeholder-do-not-export',
      notifyAuthMode: 'api_key',
    });
    const exported = JSON.parse(text);
    assert.equal(exported.formatVersion, 2);
    assert.equal(exported.settings.authMode, authMode);
    assert.equal(Object.keys(exported.settings).length, 6);
    assert.doesNotMatch(text, /placeholder-do-not-export|ANTOM_API_KEY|apiKey|merchantPrivateKey|notifyAuthMode/);
  }
});

test('config export fails closed for private keys, bad RSA bytes, and injection', async () => {
  for (const settings of [
    { antomPublicKey: '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----' },
    { antomPublicKey: 'QUJD' },
    { clientId: 'ok\nEVIL=1' },
    { gatewayOrigin: 'https://evil.example' },
    { environment: 'sandbox; --live' },
    { authMode: 'bearer' },
    { authMode: 'api_key\nANTOM_API_KEY=secret' },
    { authMode: false },
  ]) {
    await assert.rejects(() => createConfigExport(settings, { cryptoObject: webcrypto }));
  }
});

function createDownloadEnvironment(options = {}) {
  const events = [];
  const timers = [];
  let savedBlob;
  const anchor = {
    style: {},
    click() { events.push('click'); if (options.failClick) throw new Error('blocked'); },
    remove() { events.push('remove'); },
  };
  return {
    events, timers, anchor,
    get blob() { return savedBlob; },
    options: {
      documentObject: {
        body: { appendChild(value) { assert.equal(value, anchor); events.push('append'); } },
        createElement(name) { assert.equal(name, 'a'); return anchor; },
      },
      urlObject: {
        createObjectURL(blob) { savedBlob = blob; events.push('create'); return 'blob:generated-test'; },
        revokeObjectURL(url) { assert.equal(url, 'blob:generated-test'); events.push('revoke'); },
      },
      setTimeoutFunction(fn, milliseconds) { timers.push({ fn, milliseconds }); },
    },
  };
}

test('download uses a local Blob and releases the object URL after download starts', async () => {
  const environment = createDownloadEnvironment();
  downloadConfigFile('{"formatVersion":2}', environment.options);
  assert.equal(environment.anchor.href, 'blob:generated-test');
  assert.equal(environment.anchor.download, 'antom.config.json');
  assert.deepEqual(environment.events, ['create', 'append', 'click', 'remove']);
  assert.equal(await environment.blob.text(), '{"formatVersion":2}');
  assert.equal(environment.blob.type, 'application/json;charset=utf-8');
  assert.equal(environment.timers.length, 1);
  assert.equal(environment.timers[0].milliseconds, 30_000);
  environment.timers[0].fn();
  assert.equal(environment.events.at(-1), 'revoke');
});

test('failed download removes the anchor and revokes its object URL immediately', () => {
  const environment = createDownloadEnvironment({ failClick: true });
  assert.throws(() => downloadBlob(new Blob(['test']), 'test.zip', environment.options));
  assert.deepEqual(environment.events, ['create', 'append', 'click', 'revoke', 'remove']);
  assert.equal(environment.timers.length, 0);
  assert.throws(() => downloadBlob(new Blob(['test']), '../unsafe.zip', environment.options));
  assert.throws(() => downloadBlob(new Blob(['test']), 'test.zip', { documentObject: {} }));
});

test('download revokes its URL even if DOM creation or timer scheduling fails', () => {
  const creationFailure = createDownloadEnvironment();
  creationFailure.options.documentObject.createElement = () => { throw new Error('unavailable'); };
  assert.throws(() => downloadBlob(new Blob(['test']), 'test.zip', creationFailure.options));
  assert.deepEqual(creationFailure.events, ['create', 'revoke']);

  const timerFailure = createDownloadEnvironment();
  timerFailure.options.setTimeoutFunction = () => { throw new Error('unavailable'); };
  assert.throws(() => downloadBlob(new Blob(['test']), 'test.zip', timerFailure.options));
  assert.deepEqual(timerFailure.events, ['create', 'append', 'click', 'revoke', 'remove']);
});

test('ZIP downloads use exactly the selected bundled archive and canonical filename', async () => {
  const bytes = Buffer.from('PK\u0003\u0004fixture');
  const archives = { 'integration,reconciliation': bytes.toString('base64') };
  const environment = createDownloadEnvironment();
  const filename = downloadSkillArchive(archives, ['reconciliation', 'integration'], environment.options);
  assert.equal(filename, 'antom-skills-integration-reconciliation.zip');
  assert.equal(environment.anchor.download, filename);
  assert.equal(environment.blob.type, 'application/zip');
  assert.deepEqual(Buffer.from(await environment.blob.arrayBuffer()), bytes);
  environment.timers[0].fn();
});

test('missing or invalid archives fail before starting a browser download', () => {
  for (const encoded of [undefined, '', 'not base64!', '===A', 'A===', '====', Buffer.from('not a ZIP').toString('base64')]) {
    const environment = createDownloadEnvironment();
    assert.throws(() => downloadSkillArchive({ integration: encoded }, ['integration'], environment.options));
    assert.deepEqual(environment.events, []);
  }
});

test('every generated project ZIP can be downloaded without changing its bytes', async () => {
  const archives = JSON.parse(await readFile(new URL('../.generated/skill-downloads.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(archives).sort(), ['integration', 'integration,reconciliation', 'reconciliation']);
  for (const [key, encoded] of Object.entries(archives)) {
    const environment = createDownloadEnvironment();
    downloadSkillArchive(archives, key.split(','), environment.options);
    assert.deepEqual(Buffer.from(await environment.blob.arrayBuffer()), Buffer.from(encoded, 'base64'));
    environment.timers[0].fn();
  }
});
