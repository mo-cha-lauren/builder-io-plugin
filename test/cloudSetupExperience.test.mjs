import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSetupPackage, createCloudSetupPrompt, createSetupCommand } from '../src/installExperience.mjs';

const pkg = { name: '@antglobal/builder-io-plugin-antom-payment', version: '1.0.0' };
const manifest = { ...pkg, bin: { 'antom-builder': 'bin/antom-builder.mjs' }, antomBuilder: { setupProtocol: 1 } };
const availableResponse = (value = manifest) => ({ ok: true, status: 200, json: async () => value });

test('cloud setup command pins the public registry and package and selects config only for payment', () => {
  const command = createSetupCommand(pkg, ['reconciliation', 'integration']);
  assert.equal(command, `npm exec --registry=https://registry.npmjs.org --yes --package=${pkg.name}@1.0.0 -- antom-builder setup --skills integration,reconciliation --config-stdin`);
  assert.doesNotMatch(createSetupCommand(pkg, ['reconciliation']), /config-stdin/);
  assert.throws(() => createSetupCommand({ ...pkg, version: 'latest' }, ['integration']));
  assert.throws(() => createSetupCommand(pkg, []));
});

test('one setup request includes only validated non-secret JSON on literal stdin', async () => {
  const prompt = await createCloudSetupPrompt(pkg, ['integration'], {
    clientId: ' sandbox-test ', authMode: 'api_key', apiKey: 'do-not-copy-api-secret',
    merchantPrivateKey: 'do-not-copy-private-secret', authorization: 'Bearer do-not-copy-token',
  });
  assert.match(prompt, /current Builder code project/);
  assert.match(prompt, /POSIX shell/);
  assert.match(prompt, /<<'ANTOM_SETUP_CONFIG'/);
  const config = JSON.parse(prompt.split("<<'ANTOM_SETUP_CONFIG'\n")[1].split('\nANTOM_SETUP_CONFIG')[0]);
  assert.equal(config.formatVersion, 2);
  assert.equal(config.settings.clientId, 'sandbox-test');
  assert.equal(config.settings.authMode, 'api_key');
  assert.equal(Object.keys(config.settings).length, 6);
  assert.match(prompt, /notify-related interfaces always use RSA/);
  assert.match(prompt, /If package access, configuration, file conflicts, or prerequisite checks fail, stop/);
  assert.match(prompt, /Do not open real \.env files/);
  assert.doesNotMatch(prompt, /do-not-copy|Download Skill ZIP|UPSTREAM_SKILL/);
});

test('unsafe payment settings fail before a request is generated', async () => {
  for (const clientId of ['$(touch /tmp/pwned)', 'safe\nANTOM_SETUP_CONFIG\necho bad', "x'bad", '`whoami`']) {
    await assert.rejects(() => createCloudSetupPrompt(pkg, ['integration'], { clientId }));
  }
  await assert.rejects(() => createCloudSetupPrompt(pkg, ['integration'], { antomPublicKey: 'QUJD' }));
});

test('bill-only request does not read or serialize payment settings', async () => {
  const settings = { get authMode() { throw new Error('Payment settings should not be read'); } };
  const prompt = await createCloudSetupPrompt(pkg, ['reconciliation'], settings);
  assert.doesNotMatch(prompt, /config-stdin|ANTOM_SETUP_CONFIG|formatVersion/);
  assert.match(prompt, /must not read or change payment configuration/);
  assert.match(prompt, /supplied, sanitized files only/);
});

test('availability check requests only exact public package metadata without credentials or settings', async () => {
  let called = false;
  const result = await checkSetupPackage({ ...pkg, apiKey: 'never-send', clientId: 'never-send' }, {
    fetchFunction: async (url, options) => {
      called = true;
      assert.equal(url, 'https://registry.npmjs.org/%40antglobal%2Fbuilder-io-plugin-antom-payment/1.0.0');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, undefined);
      assert.equal(options.headers, undefined);
      assert.ok(options.signal instanceof AbortSignal);
      return availableResponse();
    },
  });
  assert.ok(called);
  assert.equal(result.status, 'available');
  assert.doesNotMatch(JSON.stringify(result), /never-send/);
});

test('404 disables unpublished installers and untrusted response text is never displayed', async () => {
  const result = await checkSetupPackage(pkg, { fetchFunction: async () => ({
    status: 404, ok: false, json: async () => { throw new Error('must not read body'); },
  }) });
  assert.equal(result.status, 'unpublished');
  for (const fetchFunction of [
    async () => ({ status: 403, ok: false }),
    async () => { throw new Error('private network details'); },
    async () => ({ status: 200, ok: true, json: async () => { throw new Error('private response details'); } }),
  ]) {
    const failed = await checkSetupPackage(pkg, { fetchFunction });
    assert.equal(failed.status, 'unavailable');
    assert.doesNotMatch(failed.message, /private/);
  }
});

test('old or mismatched npm packages cannot enable setup just because the version exists', async () => {
  for (const value of [null, {}, { ...manifest, name: 'other' }, { ...manifest, version: '0.9.0' },
    { ...manifest, antomBuilder: undefined }, { ...manifest, antomBuilder: { setupProtocol: 2 } },
    { ...manifest, bin: { 'antom-builder': 'wrong.mjs' } }]) {
    const result = await checkSetupPackage(pkg, { fetchFunction: async () => availableResponse(value) });
    assert.equal(result.status, 'incompatible');
  }
});

test('availability checks time out and cancellation cannot leave a pending request holding the UI', async () => {
  let signal;
  const result = await checkSetupPackage(pkg, {
    timeoutMs: 5, fetchFunction: async (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  assert.equal(result.status, 'unavailable');
  assert.ok(signal.aborted);

  const controller = new AbortController();
  const pending = checkSetupPackage(pkg, {
    signal: controller.signal, fetchFunction: async () => new Promise(() => {}),
  });
  controller.abort();
  assert.equal((await pending).status, 'unavailable');
  let called = false;
  await checkSetupPackage(pkg, { signal: controller.signal, fetchFunction: async () => { called = true; } });
  assert.equal(called, false);
});
