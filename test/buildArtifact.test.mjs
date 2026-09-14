import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createConfigExport } from '../src/installExperience.mjs';

const require = createRequire(import.meta.url);
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const bundlePath = path.join(root, pkg.main);
const githubSource = JSON.parse(await readFile(path.join(root, '.generated/github-source.json'), 'utf8'));
const skillBundle = JSON.parse(await readFile(path.join(root, '.generated/skill-bundle.json'), 'utf8'));
const sourceFiles = new Map(skillBundle.skills.flatMap((skill) => skill.files.map((file) => [file.path, file.content])));

async function githubFixtureFetch(url) {
  const baseUrl = `${githubSource.baseUrl.replace(/\/$/, '')}/`;
  if (String(url) === new URL('manifest.json', baseUrl).href) {
    return new Response(`${JSON.stringify(githubSource.manifest, null, 2)}\n`, {
      headers: { 'content-type': 'application/json' },
    });
  }
  const file = githubSource.manifest.skills.flatMap((skill) => skill.files)
    .find((entry) => new URL(entry.url, baseUrl).href === String(url));
  if (file && sourceFiles.has(file.path)) {
    return new Response(sourceFiles.get(file.path), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  return new Response('', { status: 404 });
}

function captureSystemRegistration(bundle, globals = {}) {
  let registration;
  vm.runInNewContext(bundle, {
    System: {
      register(dependencies, declare) {
        registration = { dependencies, declare };
      },
    },
    AbortController,
    Blob: globalThis.Blob,
    URL,
    clearTimeout,
    console,
    crypto: webcrypto,
    fetch: githubFixtureFetch,
    setTimeout,
    TextDecoder,
    TextEncoder,
    ...globals,
  });
  return registration;
}

function executeBundle(bundle, { react = React, globals = {} } = {}) {
  const systemRegistration = captureSystemRegistration(bundle, globals);
  const registrations = [];
  const editors = [];
  const snackMessages = [];
  const pluginSettings = new Map([
    ['clientId', 'client_1'],
    ['environment', 'sandbox'],
    ['keyVersion', '1'],
    ['gatewayOrigin', 'https://open-sea-global.alipay.com'],
  ]);
  const appState = {
    user: {
      organization: {
        value: {
          settings: {
            plugins: new Map([[pkg.name, pluginSettings]]),
          },
        },
      },
    },
    snackBar: {
      show(message) {
        snackMessages.push(message);
      },
    },
  };
  const modules = {
    '@builder.io/app-context': { default: appState },
    '@builder.io/react': {
      Builder: {
        register(type, config) {
          registrations.push([type, config]);
        },
        registerEditor(editor) {
          editors.push(editor);
        },
      },
    },
    '@emotion/core': require('@emotion/core'),
    react,
    'react-dom': require('react-dom'),
  };
  const declared = systemRegistration.declare(() => {}, {});
  systemRegistration.dependencies.forEach((dependency, index) => {
    declared.setters[index](modules[dependency]);
  });
  declared.execute();
  return { appState, pluginSettings, registrations, snackMessages, editors };
}

test('production package entry and release metadata are present', async () => {
  assert.ok((await stat(bundlePath)).isFile());
  assert.ok((await stat(path.join(root, 'LICENSE'))).isFile());
  assert.equal(pkg.publishConfig.access, 'public');
  assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org/');
  assert.equal(pkg.antomBuilder?.setupProtocol, 1);
  assert.match(pkg.name, /^@antglobal\//);
});

test('local Builder install URL maps settings to the registered package id', async () => {
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  const expectedUrl = `http://localhost:1268/plugin.system.js?pluginId=${pkg.name}`;

  assert.match(readme, new RegExp(expectedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('bundle registers as SystemJS and uses supported Builder extension points', async () => {
  const bundle = await readFile(bundlePath, 'utf8');
  const registration = captureSystemRegistration(bundle);

  assert.ok(registration);
  assert.equal(typeof registration.declare, 'function');
  assert.ok(registration.dependencies.includes('@builder.io/react'));
  assert.ok(registration.dependencies.includes('@builder.io/app-context'));
  assert.ok(registration.dependencies.includes('@emotion/core'));
  assert.ok(bundle.includes(pkg.name));
  assert.match(bundle, /editor\.editTab/);
  assert.match(bundle, /app\.onLoad/);
  assert.doesNotMatch(bundle, /editor\.toolbarButton/);
  assert.doesNotMatch(bundle, /activeTabId/);
});

test('bundle executes and its Builder lifecycle handles valid and invalid settings', async () => {
  const bundle = await readFile(bundlePath, 'utf8');
  const { pluginSettings, registrations, snackMessages, editors } = executeBundle(bundle);
  assert.deepEqual(
    registrations.map(([type]) => type),
    ['plugin', 'editor.editTab', 'app.onLoad']
  );
  const getRegistration = (type) => registrations.find(([key]) => key === type)[1];
  const plugin = getRegistration('plugin');
  const authSetting = plugin.settings.find(({ name }) => name === 'authMode');
  assert.equal(authSetting.type, 'AntomPaymentAuthMode');
  assert.equal(authSetting.defaultValue, 'rsa');
  assert.equal(authSetting.friendlyName, '1. Ordinary API authentication');
  assert.deepEqual(editors.map(({ name }) => name), [
    'AntomPaymentAuthMode', 'AntomPaymentEnvironment', 'AntomPaymentGateway', 'AntomPaymentNotifyPublicKey',
  ]);
  assert.equal(plugin.settings.find(({ name }) => name === 'antomPublicKey').friendlyName, '2. Notify — RSA configuration');
  assert.deepEqual(Array.from(plugin.settings, ({ name }) => name), [
    'authMode', 'environment', 'gatewayOrigin', 'clientId', 'antomPublicKey', 'keyVersion',
  ]);
  assert.ok(plugin.settings.some(({ name }) => name === 'antomPublicKey'));
  assert.ok(plugin.settings.some(({ name }) => name === 'keyVersion'));
  assert.ok(plugin.settings.every(({ name }) => !/api.?key|private|secret/i.test(name)));

  // Existing settings without an authMode remain valid and default to RSA.
  const validUpdates = [];
  await plugin.onSave({ updateSettings: async (value) => validUpdates.push(value) });
  assert.equal(validUpdates.length, 1);
  assert.equal(validUpdates[0].hasConnected, true);
  assert.equal(validUpdates[0].authMode, 'rsa');

  pluginSettings.set('authMode', 'api_key');
  const apiKeyUpdates = [];
  await plugin.onSave({ updateSettings: async (value) => apiKeyUpdates.push(value) });
  assert.equal(apiKeyUpdates.length, 1);
  assert.equal(apiKeyUpdates[0].hasConnected, true);
  assert.equal(apiKeyUpdates[0].authMode, 'api_key');

  pluginSettings.set('authMode', 'bearer');
  const invalidAuthUpdates = [];
  await assert.rejects(() =>
    plugin.onSave({ updateSettings: async (value) => invalidAuthUpdates.push(value) })
  );
  assert.equal(invalidAuthUpdates.length, 1);
  assert.equal(invalidAuthUpdates[0].hasConnected, false);
  assert.equal(snackMessages.length, 1);
  pluginSettings.set('authMode', 'rsa');

  pluginSettings.set('gatewayOrigin', 'https://attacker.example');
  const invalidUpdates = [];
  await assert.rejects(() =>
    plugin.onSave({ updateSettings: async (value) => invalidUpdates.push(value) })
  );
  assert.equal(invalidUpdates.length, 1);
  assert.equal(invalidUpdates[0].hasConnected, false);
  assert.equal(snackMessages.length, 2);

  pluginSettings.set('gatewayOrigin', 'https://open-sea-global.alipay.com');
  const persistenceError = new Error('persistence failed');
  await assert.rejects(
    () => plugin.onSave({ updateSettings: async () => Promise.reject(persistenceError) }),
    (error) => error === persistenceError
  );
  assert.equal(snackMessages.length, 2);

  const settingsDialogs = [];
  await getRegistration('app.onLoad')({
    triggerSettingsDialog: async (pluginId) => settingsDialogs.push(pluginId),
  });
  assert.deepEqual(settingsDialogs, [pkg.name]);

  const markup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(getRegistration('editor.editTab').component)
  );
  assert.match(markup, /Antom Payment/);
  assert.match(markup, /Loading settings…/);
  assert.match(markup, /Secrets stay on your server; notify always uses RSA\./);
});

function plainText(markup) {
  return markup
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

test('main panel and built-in help offer only the native file-import setup flow', async () => {
  const bundle = await readFile(bundlePath, 'utf8');
  const { registrations } = executeBundle(bundle);
  const component = registrations.find(([type]) => type === 'editor.editTab')[1].component;
  const markup = ReactDOMServer.renderToStaticMarkup(React.createElement(component));
  const visible = plainText(markup);
  assert.deepEqual(
    Array.from(markup.matchAll(/data-testid="([^"]+)"/g), ([, id]) => id),
    ['setup-in-builder', 'setup-package-status', 'start-chat']
  );
  assert.equal((markup.match(/\bMuiCard-root\b/g) || []).length, 2);
  assert.doesNotMatch(markup, /<details\b|<select\b/);
  for (const label of [
    '1. Setup in Builder', '2. Start a chat', 'Copy setup request', 'Copy example',
    'Edit settings', 'Secrets stay on your server; notify always uses RSA.', 'Usage guide',
  ]) assert.ok(visible.includes(label), `${label} should remain visible`);
  assert.match(visible, /Imports complete files with Agent tools\./);
  assert.match(visible, /Paste in Builder Agent/);
  assert.match(visible, /After the Agent confirms setup, start a new Builder chat\./);
  assert.match(visible, /Checking source manifest…/);
  for (const content of [markup, bundle]) {
    assert.doesNotMatch(content, /Installer source|Public npm|Project test package|Legacy installers|Local development \(optional\)|Download Skill ZIP|Download config|Copy install command|Copy config command|Copy check command|Antom CLI guide/);
  }
  assert.match(bundle, /click Copy setup request, then paste it in the current Builder Agent chat/);
  assert.match(bundle, /Copying a request does not install Skills/);
  assert.match(bundle, /verifies every selected file before copying the request/);
  const buttons = Array.from(markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g));
  const setupButton = buttons.find(([, , content]) => plainText(content) === 'Copy setup request');
  assert.ok(setupButton);
  assert.match(setupButton[1], /\bdisabled(?:=""|="disabled")?(?:\s|$)/,
    'setup stays disabled until the source manifest and saved settings have been checked');
});

// Exercise the production panel's actual event handlers with a small hook
// scheduler. Builder, network and clipboard remain fixtures, not cloud E2E.
function panelHandlerFixture(bundle, writeText, { fetch: fetchFunction = githubFixtureFetch } = {}) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let tree;
  let disposed = false;
  let updatesAfterUnmount = 0;
  const react = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (value) => {
        if (disposed) updatesAfterUnmount += 1;
        slots[index].value = typeof value === 'function' ? value(slots[index].value) : value;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const fixture = executeBundle(bundle, {
    react,
    globals: {
      fetch: fetchFunction,
      navigator: { clipboard: { writeText } },
    },
  });
  const registration = fixture.registrations.find(([type]) => type === 'editor.editTab')[1];
  const panel = registration.component();
  const render = () => {
    cursor = 0;
    effects = [];
    tree = panel.type(panel.props);
    for (const effect of effects) effect();
    return tree;
  };
  const find = (predicate, element = tree) => {
    if (!React.isValidElement(element)) return null;
    if (predicate(element.props)) return element.props;
    for (const child of React.Children.toArray(element.props.children)) {
      const result = find(predicate, child);
      if (result) return result;
    }
    return null;
  };
  render();
  return {
    ...fixture,
    render,
    find,
    skill: (id) => find((props) => props.type === 'checkbox' && props.value === id),
    button: (label) => find((props) => typeof props.onClick === 'function' && props.children === label),
    manualRequest: () => find((props) => props['aria-label'] === 'Setup request to copy manually'),
    updatesAfterUnmount: () => updatesAfterUnmount,
    setup: () => find((props) => typeof props.onClick === 'function' &&
      ['Copy setup request', 'Preparing request…', 'Request copied'].includes(props.children)),
    async settle() {
      for (let i = 0; i < 6; i += 1) {
        await new Promise(setImmediate);
        render();
      }
    },
    cleanup() {
      for (const slot of slots) slot?.cleanup?.();
      disposed = true;
    },
  };
}

test('initial status checks only the manifest and copy verifies every selected source file', async (t) => {
  const requests = [];
  const copied = [];
  const panel = panelHandlerFixture(await readFile(bundlePath, 'utf8'), async (text) => copied.push(text), {
    fetch: async (url) => {
      requests.push(String(url));
      return githubFixtureFetch(url);
    },
  });
  t.after(() => panel.cleanup());
  await panel.settle();
  assert.equal(panel.find((props) => props['aria-label'] === 'Installer source'), null);
  assert.deepEqual(requests, [githubSource.baseUrl + 'manifest.json']);
  assert.equal(panel.setup().disabled, false);
  assert.ok(panel.find((props) => props.children === 'Source manifest verified; project installation is not verified.'));
  panel.skill('reconciliation').onChange();
  panel.render();
  await panel.setup().onClick();
  panel.render();
  assert.equal(copied.length, 1);
  assert.match(copied[0], /\.builder\/skills\/antom-integration/);
  assert.match(copied[0], /\.builder\/skills\/antom-reconciliation-expert/);
  assert.equal(requests[1], githubSource.baseUrl + 'manifest.json');
  assert.deepEqual(requests.slice(2).sort(), githubSource.manifest.skills.flatMap((skill) => skill.files.map((file) => file.url)).sort());
  assert.ok(requests.every((url) => url.startsWith(githubSource.baseUrl)));
  assert.equal(panel.setup().children, 'Request copied');
});

test('unavailable source blocks clipboard until its Retry succeeds', async (t) => {
  const requests = [];
  const copied = [];
  let available = false;
  const panel = panelHandlerFixture(await readFile(bundlePath, 'utf8'), async (text) => copied.push(text), {
    fetch: async (url) => {
      requests.push(String(url));
      return available ? githubFixtureFetch(url) : new Response('', { status: 404 });
    },
  });
  t.after(() => panel.cleanup());
  await panel.settle();
  assert.equal(panel.setup().disabled, true);
  await panel.setup().onClick();
  assert.deepEqual(copied, []);
  assert.equal(panel.manualRequest(), null);
  assert.ok(panel.button('Retry'));
  available = true;
  await panel.button('Retry').onClick();
  panel.render();
  assert.equal(panel.setup().disabled, false);
  await panel.setup().onClick();
  assert.equal(copied.length, 1);
  assert.ok(requests.every((url) => url.startsWith(githubSource.baseUrl)));
});

test('asset verification failure blocks copy and manual fallback, then supports Retry', async (t) => {
  const copied = [];
  let corrupt = true;
  const panel = panelHandlerFixture(await readFile(bundlePath, 'utf8'), async (text) => copied.push(text), {
    fetch: async (url) => !corrupt || String(url).endsWith('/manifest.json')
      ? githubFixtureFetch(url)
      : new Response('corrupt source fixture', { headers: { 'content-type': 'text/plain' } }),
  });
  t.after(() => panel.cleanup());
  await panel.settle();
  assert.equal(panel.setup().disabled, false, 'manifest availability does not promise valid file assets');
  const staleCopy = panel.setup().onClick;
  await staleCopy();
  panel.render();
  assert.deepEqual(copied, []);
  assert.equal(panel.manualRequest(), null);
  assert.equal(panel.setup().disabled, true);
  await staleCopy();
  assert.deepEqual(copied, [], 'stale handlers cannot reuse a failed availability check');
  corrupt = false;
  await panel.button('Retry').onClick();
  panel.render();
  await panel.setup().onClick();
  assert.equal(copied.length, 1);
});

test('unmount aborts pending manifest and asset checks and ignores late responses', async () => {
  const bundle = await readFile(bundlePath, 'utf8');
  for (const phase of ['manifest', 'assets']) {
    let release;
    let signal;
    const pending = new Promise((resolve) => { release = resolve; });
    const copied = [];
    const panel = panelHandlerFixture(bundle, async (text) => copied.push(text), {
      fetch: async (url, options) => {
        if (phase === 'manifest' || !String(url).endsWith('/manifest.json')) {
          signal = options.signal;
          await pending;
        }
        return githubFixtureFetch(url);
      },
    });
    try {
      await panel.settle();
      const copying = phase === 'assets' ? panel.setup().onClick() : null;
      await panel.settle();
      assert.ok(signal);
      panel.cleanup();
      assert.equal(signal.aborted, true);
      release();
      await copying;
      await panel.settle();
      assert.deepEqual(copied, []);
      assert.equal(panel.updatesAfterUnmount(), 0);
      assert.deepEqual(panel.snackMessages, []);
    } finally {
      release();
      panel.cleanup();
    }
  }
});

test('setup copy excludes duplicate/example copies and selection/settings changes until completion', async (t) => {
  let releaseClipboard;
  const pendingClipboard = new Promise((resolve) => { releaseClipboard = resolve; });
  const copied = [];
  const panel = panelHandlerFixture(await readFile(bundlePath, 'utf8'), async (text) => {
    copied.push(text);
    await pendingClipboard;
  });
  t.after(() => { releaseClipboard(); panel.cleanup(); });
  await panel.settle();
  const toggle = panel.skill('reconciliation').onChange;
  const edit = panel.button('Edit settings').onClick;
  const example = panel.button('Copy example').onClick;
  const setup = panel.setup().onClick;
  const copying = setup();
  toggle();
  await edit();
  await example();
  await setup();
  await panel.settle();
  assert.equal(panel.skill('reconciliation').checked, false);
  assert.equal(panel.skill('reconciliation').disabled, true);
  assert.equal(panel.button('Edit settings').disabled, true);
  assert.equal(panel.setup().disabled, true);
  assert.equal(copied.length, 1);
  releaseClipboard();
  await copying;
  panel.render();
  assert.equal(panel.setup().children, 'Request copied');
  assert.equal(panel.skill('reconciliation').disabled, false);
});

test('clipboard fallback and copied state clear when selection or saved settings change', async (t) => {
  const attempts = [];
  let clipboardFails = true;
  const panel = panelHandlerFixture(await readFile(bundlePath, 'utf8'), async (text) => {
    attempts.push(text);
    if (clipboardFails) throw new Error('fixture clipboard failure');
  });
  t.after(() => panel.cleanup());
  await panel.settle();
  const oldSelectionCopy = panel.setup().onClick;
  await oldSelectionCopy();
  panel.render();
  assert.ok(panel.manualRequest());
  panel.skill('reconciliation').onChange();
  panel.render();
  assert.equal(panel.manualRequest(), null);
  await oldSelectionCopy();
  assert.equal(attempts.length, 1, 'a stale selection handler cannot copy a previous selection');
  await panel.setup().onClick();
  panel.render();
  assert.ok(panel.manualRequest());
  const oldSettingsCopy = panel.setup().onClick;
  panel.pluginSettings.set('clientId', 'client_2');
  await panel.button('Edit settings').onClick();
  panel.render();
  assert.equal(panel.manualRequest(), null);
  await oldSettingsCopy();
  assert.equal(attempts.length, 2, 'a stale settings handler cannot copy a previous settings snapshot');
  clipboardFails = false;
  await panel.setup().onClick();
  panel.render();
  assert.equal(panel.setup().children, 'Request copied');
  assert.match(attempts.at(-1), /"clientId": "client_2"/);
  panel.skill('reconciliation').onChange();
  panel.render();
  assert.equal(panel.setup().children, 'Copy setup request');
});

test('invalid settings fail closed and bill-only copy omits payment configuration', async (t) => {
  const requests = [];
  const copied = [];
  const panel = panelHandlerFixture(await readFile(bundlePath, 'utf8'), async (text) => copied.push(text), {
    fetch: async (url) => {
      requests.push(String(url));
      return githubFixtureFetch(url);
    },
  });
  t.after(() => panel.cleanup());
  await panel.settle();
  panel.pluginSettings.set('gatewayOrigin', 'https://invalid.example');
  await panel.setup().onClick();
  panel.render();
  assert.deepEqual(copied, []);
  assert.equal(panel.setup().disabled, true);
  panel.skill('integration').onChange();
  panel.render();
  assert.equal(panel.setup().disabled, true, 'an empty selection cannot be copied');
  panel.skill('reconciliation').onChange();
  panel.render();
  assert.equal(panel.setup().disabled, false, 'bill-only import does not require payment settings');
  assert.equal(panel.button('Edit settings'), null);
  requests.length = 0;
  await panel.setup().onClick();
  assert.equal(copied.length, 1);
  assert.doesNotMatch(copied[0], /nonSecretPaymentConfig|\.builder\/skills\/antom-integration/);
  assert.match(copied[0], /Bill-only import: do not read, create or change \.env\.example or any payment configuration/);
  const files = githubSource.manifest.skills.find((skill) => skill.id === 'reconciliation').files;
  assert.deepEqual(requests.sort(), [githubSource.baseUrl + 'manifest.json', ...files.map((file) => file.url)].sort());
});

function settingsFixture(bundle) {
  const result = executeBundle(bundle);
  const plugin = result.registrations.find(([type]) => type === 'plugin')[1];
  const editor = (fieldName) => {
    const field = plugin.settings.find(({ name }) => name === fieldName);
    return result.editors.find(({ name }) => name === field.type).component;
  };
  const render = (fieldName, props = {}) => ReactDOMServer.renderToStaticMarkup(
    React.createElement(editor(fieldName), props)
  );
  return { ...result, plugin, editor, render };
}

// These settings editors are stateless. Walk their returned elements to invoke
// the actual control handler without mocking the normalizer or editor itself.
function findControl(element, label) {
  if (!React.isValidElement(element)) return null;
  if (element.props['aria-label'] === label && typeof element.props.onChange === 'function') return element.props;
  for (const child of React.Children.toArray(element.props.children)) {
    const control = findControl(child, label);
    if (control) return control;
  }
  if (typeof element.type === 'function') return findControl(element.type(element.props), label);
  return null;
}

function assertSelected(markup, value) {
  const selected = markup.match(/<option\b[^>]*\bselected=""[^>]*>/g) || [];
  assert.equal(selected.length, 1);
  assert.ok(selected[0].includes(`value="${value}"`), selected[0]);
}

test('settings editors visibly show canonical defaults without changing the draft on render', async () => {
  const { render } = settingsFixture(await readFile(bundlePath, 'utf8'));
  const changes = [];
  const onChange = (value) => changes.push(value);
  for (const value of [undefined, null]) {
    assertSelected(render('authMode', { value, onChange }), 'rsa');
  }
  for (const value of [undefined, null, '', '   ']) {
    assertSelected(render('environment', { value, onChange }), 'sandbox');
    assertSelected(render('gatewayOrigin', { value, onChange }), 'https://open-sea-global.alipay.com');
  }
  assertSelected(render('environment', { value: 'production', onChange }), 'production');
  assertSelected(render('gatewayOrigin', { value: 'https://open-de-global.alipay.com/', onChange }), 'https://open-de-global.alipay.com');
  assert.deepEqual(changes, []);
});

test('custom settings editors explain server Secrets and keep notify RSA visible in both modes', async () => {
  const { render } = settingsFixture(await readFile(bundlePath, 'utf8'));
  for (const value of ['rsa', 'api_key']) {
    const markup = render('authMode', { value });
    assertSelected(markup, value);
    assert.match(markup, /Notify-related interfaces always use RSA/);
    assert.match(markup, /environment or secret manager/);
    assert.match(markup, /Agent chat/);
    assert.doesNotMatch(markup, /<input/);
  }
  assert.match(render('authMode', { value: 'api_key' }), /Manually set ANTOM_API_KEY/);
  assert.match(render('authMode', { value: 'api_key' }), /There is no API Key input here/);
  const notify = render('antomPublicKey', { value: 'public-reference' });
  assert.match(notify, /regardless of the ordinary API authentication mode/);
  assert.match(notify, /Antom public key/);
  assert.match(notify, /rows="4"/);
});

test('invalid saved choices are visible errors, never echoed or silently changed', async () => {
  const { render } = settingsFixture(await readFile(bundlePath, 'utf8'));
  for (const name of ['authMode', 'environment', 'gatewayOrigin']) {
    const changes = [];
    const markup = render(name, { value: 'invalid-synthetic-secret', onChange: (value) => changes.push(value) });
    assert.match(markup, /aria-invalid="true"/);
    assert.match(markup, /Select a valid value before saving/);
    assert.doesNotMatch(markup, /invalid-synthetic-secret/);
    assert.deepEqual(changes, []);
  }
});

test('settings control changes update the draft only on interaction and respect read-only state', async () => {
  const { editor } = settingsFixture(await readFile(bundlePath, 'utf8'));
  const cases = [
    ['authMode', 'Authentication method', 'api_key'],
    ['environment', 'Environment', 'production'],
    ['gatewayOrigin', 'Gateway origin', 'https://open-de-global.alipay.com'],
    ['antomPublicKey', 'Antom public key', 'public-reference'],
  ];
  for (const [name, label, value] of cases) {
    const changes = [];
    const props = { onChange: (next) => changes.push(next) };
    const control = findControl(React.createElement(editor(name), props), label);
    assert.ok(control, name);
    assert.deepEqual(changes, []);
    control.onChange({ target: { value } });
    assert.deepEqual(changes, [value]);
    for (const lock of [{ disabled: true }, { readOnly: true }, { field: { readOnly: true } }]) {
      findControl(React.createElement(editor(name), { ...props, ...lock }), label).onChange({ target: { value } });
    }
    assert.deepEqual(changes, [value]);
    if (name !== 'antomPublicKey') {
      control.onChange({ target: { value: 'invalid-synthetic-secret' } });
      assert.deepEqual(changes, [value]);
    }
  }
});

test('explicit Save persists untouched defaults and export/reopen agree without including extra fields', async () => {
  const { plugin, pluginSettings, render } = settingsFixture(await readFile(bundlePath, 'utf8'));
  pluginSettings.delete('authMode');
  pluginSettings.set('environment', '');
  pluginSettings.set('gatewayOrigin', '');
  pluginSettings.set('keyVersion', '');
  pluginSettings.set('apiKey', 'synthetic-secret');
  pluginSettings.set('customFlag', true);
  const updates = [];
  await plugin.onSave({ updateSettings: async (value) => updates.push(value) });
  const saved = JSON.parse(JSON.stringify(updates[0]));
  assert.deepEqual(saved, {
    authMode: 'rsa', clientId: 'client_1', antomPublicKey: '', environment: 'sandbox',
    keyVersion: '1', gatewayOrigin: 'https://open-sea-global.alipay.com', hasConnected: true,
  });
  assertSelected(render('environment', { value: saved.environment }), 'sandbox');
  assertSelected(render('gatewayOrigin', { value: saved.gatewayOrigin }), 'https://open-sea-global.alipay.com');
  const exported = JSON.parse(await createConfigExport(saved)).settings;
  const { hasConnected, ...expected } = saved;
  assert.deepEqual(exported, expected);
  // No direct Map mutation: Builder's explicit Save action owns persistence.
  assert.equal(pluginSettings.get('environment'), '');
  assert.equal(pluginSettings.get('gatewayOrigin'), '');

  pluginSettings.set('authMode', 'api_key');
  pluginSettings.set('environment', 'production');
  pluginSettings.set('gatewayOrigin', 'https://open-de-global.alipay.com/');
  await plugin.onSave({ updateSettings: async (value) => updates.push(value) });
  assert.equal(updates[1].authMode, 'api_key');
  assert.equal(updates[1].environment, 'production');
  assert.equal(updates[1].gatewayOrigin, 'https://open-de-global.alipay.com');
});

test('production bundle contains no local build paths or private-key material', async () => {
  const bundle = await readFile(bundlePath, 'utf8');
  assert.doesNotMatch(bundle, /\/Users\//);
  assert.doesNotMatch(bundle, /\/home\//);
  assert.doesNotMatch(bundle, /[A-Za-z]:\\\\Users\\\\/);
  assert.doesNotMatch(bundle, /__source/);
  assert.doesNotMatch(bundle, /__self/);
  assert.doesNotMatch(bundle, /-----BEGIN PRIVATE KEY-----/);
});
