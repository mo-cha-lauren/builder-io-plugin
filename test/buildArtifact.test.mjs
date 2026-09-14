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

test('main panel offers two cloud setup cards and keeps local alternatives collapsed', async () => {
  const { registrations } = executeBundle(await readFile(bundlePath, 'utf8'));
  const component = registrations.find(([type]) => type === 'editor.editTab')[1].component;
  const markup = ReactDOMServer.renderToStaticMarkup(React.createElement(component));
  assert.deepEqual(
    Array.from(markup.matchAll(/data-testid="([^"]+)"/g), ([, id]) => id),
    ['setup-in-builder', 'setup-package-status', 'start-chat', 'local-development']
  );
  assert.equal((markup.match(/\bMuiCard-root\b/g) || []).length, 2);

  const disclosures = Array.from(markup.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g));
  assert.equal(disclosures.length, 1);
  assert.equal((markup.match(/<details\b/g) || []).length, 1, 'local instructions use one disclosure');
  for (const [, attributes] of disclosures) {
    assert.doesNotMatch(attributes, /\bopen(?:\s|=|$)/, 'instructions must be collapsed initially');
  }
  assert.deepEqual(disclosures.map(([, , content]) => {
    const summary = content.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/);
    assert.ok(summary, 'native disclosure needs a visible, keyboard-accessible summary');
    return plainText(summary[1]);
  }), ['Local development (optional)']);

  const installDetails = plainText(disclosures[0][2]);
  assert.match(installDetails, /npm exec/);
  assert.match(installDetails, /antom-builder install/);
  assert.match(installDetails, /antom-builder check/);
  assert.match(installDetails, /Download Skill ZIP/);
  assert.match(installDetails, /\.builder\/skills/);
  assert.match(installDetails, /Client ID:/);
  assert.match(installDetails, /Gateway:/);
  assert.match(installDetails, /antom-builder config/);
  assert.match(installDetails, /Copy config command/);
  assert.match(installDetails, /Copy install command/);
  assert.match(installDetails, /Download config/);
  assert.match(installDetails, /Refreshing…|Refresh settings/);
  assert.match(installDetails, /\.env\.example/);

  // Model the native <details> initial visibility; SSR still contains its hidden body.
  const visible = plainText(markup.replace(/<details\b[^>]*>([\s\S]*?)<\/details>/g, (_, content) =>
    content.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)[0]
  ));
  for (const label of [
    '1. Setup in Builder', '2. Start a chat',
    'Copy setup request', 'Copy example', 'Edit settings',
    'Secrets stay on your server; notify always uses RSA.', 'Usage guide',
  ]) {
    assert.ok(visible.includes(label), `${label} should remain visible`);
  }
  assert.doesNotMatch(visible, /npm exec|Download Skill ZIP|Copy install command|Download config|Copy config command|Antom CLI guide|Client ID:|Gateway:/);
  assert.doesNotMatch(markup, /data-testid="(?:install-skills|payment-configuration)"/);
  assert.doesNotMatch(markup, /Antom CLI \(optional\)|Verify the actual payment flow/);
  assert.doesNotMatch(visible, /Install once in each project, then use Antom Skills in chat/);
  assert.match(markup, /<a\b[^>]*href="https:\/\/docs\.antom\.com\/ac\/ref\/antom_cli"[^>]*>Antom CLI guide<\/a>/);
  const buttons = Array.from(markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g));
  const setupButton = buttons.find(([, , content]) => plainText(content) === 'Copy setup request');
  assert.ok(setupButton, 'cloud setup must be the primary action');
  assert.match(setupButton[1], /\bdisabled(?:=""|="disabled")?(?:\s|$)/,
    'setup stays disabled until the GitHub source and saved settings have been checked');
  const sourceSelect = markup.match(/<select\b[^>]*aria-label="Installer source"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(sourceSelect, 'development installation requires an explicit source selection');
  assertSelected(sourceSelect[0], 'github');
  assert.match(sourceSelect[1], /<option\b[^>]*value="github"[^>]*>GitHub \(no npm\)<\/option>/);
  assert.match(sourceSelect[1], /<option\b[^>]*value="npm"[^>]*>Public npm<\/option>/);
  assert.match(sourceSelect[1], /<option value="project">Project test package<\/option>/);
  assert.doesNotMatch(visible, /Uses tools\/antom-builder/, 'GitHub does not require a preloaded installer');
  assert.match(visible, /Imports complete files with Agent tools\. No install commands\./);
  assert.ok(buttons.some(([, , content]) => plainText(content) === 'Usage guide'),
    'Usage guide opens built-in help as a button');
  assert.doesNotMatch(markup, /<a\b[^>]*>[\s]*Usage guide<\/a>/);
  assert.doesNotMatch(markup, /github\.com[^"\s]*#use-the-plugin/);
});

// Exercise the production panel's actual event handlers with a small hook
// scheduler. Builder, network and clipboard remain fixtures, not cloud E2E.
function panelHandlerFixture(bundle, writeText, { fetch: fetchFunction = githubFixtureFetch } = {}) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let tree;
  const react = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (value) => {
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
    source: () => find((props) => props['aria-label'] === 'Installer source'),
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
    },
  };
}

test('GitHub is the default source, verifies before copy, and makes no npm requests', async (t) => {
  const requests = [];
  const copied = [];
  const panel = panelHandlerFixture(await readFile(bundlePath, 'utf8'), async (text) => copied.push(text), {
    fetch: async (url, options) => {
      requests.push(String(url));
      return githubFixtureFetch(url, options);
    },
  });
  t.after(() => panel.cleanup());
  await panel.settle();
  assert.equal(panel.source().value, 'github');
  assert.equal(panel.setup().disabled, false);
  assert.ok(panel.find((props) => props.children === 'Source manifest verified; project installation is not verified.'));
  await panel.setup().onClick();
  panel.render();
  assert.equal(copied.length, 1);
  assert.match(copied[0], /\.builder\/skills\/antom-integration/);
  assert.ok(requests.length >= 6, 'copy checks all five integration files, not only the manifest');
  assert.ok(requests.every((url) => url.startsWith(githubSource.baseUrl)));
  assert.ok(requests.every((url) => !url.includes('registry.npmjs.org')));
  assert.equal(panel.setup().children, 'Request copied');
  const staleGithubCopy = panel.setup().onClick;
  panel.source().onChange({ target: { value: 'npm' } });
  await staleGithubCopy();
  assert.equal(copied.length, 1, 'a stale handler cannot reuse GitHub verification for npm');
  await panel.settle();
  panel.source().onChange({ target: { value: 'project' } });
  panel.render();
  assert.equal(panel.setup().children, 'Copy setup request', 'source change clears the old copied state');
});

test('unavailable GitHub source disables copy without falling back to npm', async (t) => {
  const requests = [];
  const copied = [];
  const panel = panelHandlerFixture(await readFile(bundlePath, 'utf8'), async (text) => copied.push(text), {
    fetch: async (url) => {
      requests.push(String(url));
      return new Response('', { status: 404 });
    },
  });
  t.after(() => panel.cleanup());
  await panel.settle();
  assert.equal(panel.source().value, 'github');
  assert.equal(panel.setup().disabled, true);
  await panel.setup().onClick();
  assert.deepEqual(copied, []);
  assert.ok(panel.find((props) => props['data-testid'] === 'setup-package-status'));
  assert.ok(requests.length > 0);
  assert.ok(requests.every((url) => url.startsWith(githubSource.baseUrl)));
});

test('GitHub asset verification failure never copies an installation request', async (t) => {
  const copied = [];
  const panel = panelHandlerFixture(await readFile(bundlePath, 'utf8'), async (text) => copied.push(text), {
    fetch: async (url) => String(url).endsWith('/manifest.json')
      ? githubFixtureFetch(url)
      : new Response('corrupt source fixture', { headers: { 'content-type': 'text/plain' } }),
  });
  t.after(() => panel.cleanup());
  await panel.settle();
  assert.equal(panel.setup().disabled, false, 'manifest availability does not promise valid file assets');
  await panel.setup().onClick();
  panel.render();
  assert.deepEqual(copied, []);
  assert.equal(panel.find((props) => props['aria-label'] === 'Setup request to copy manually'), null);
  assert.equal(panel.setup().children, 'Copy setup request');
});

test('source switches abort availability checks and ignore stale GitHub success', async (t) => {
  let releaseGithub;
  let githubSignal;
  const pendingGithub = new Promise((resolve) => { releaseGithub = resolve; });
  const panel = panelHandlerFixture(await readFile(bundlePath, 'utf8'), async () => {}, {
    fetch: async (url, options) => {
      if (String(url).startsWith(githubSource.baseUrl)) {
        githubSignal = options.signal;
        await pendingGithub;
        return githubFixtureFetch(url);
      }
      return new Response('', { status: 404 });
    },
  });
  t.after(() => { releaseGithub(); panel.cleanup(); });
  await panel.settle();
  assert.equal(panel.setup().disabled, true);
  assert.ok(githubSignal);
  panel.source().onChange({ target: { value: 'npm' } });
  await panel.settle();
  assert.equal(githubSignal.aborted, true);
  assert.equal(panel.source().value, 'npm');
  releaseGithub();
  await panel.settle();
  assert.equal(panel.setup().disabled, true);
  assert.ok(panel.find((props) => typeof props.children === 'string' && props.children.includes('not published on npm')));
  assert.equal(panel.find((props) => props.children === 'Source manifest verified; project installation is not verified.'), null);
});

test('project setup is explicit, independent of npm, and clears copied or fallback requests on source changes', async (t) => {
  const copied = [];
  let clipboardFails = false;
  const panel = panelHandlerFixture(await readFile(bundlePath, 'utf8'), async (text) => {
    if (clipboardFails) throw new Error('fixture clipboard failure');
    copied.push(text);
  });
  t.after(() => panel.cleanup());
  await panel.settle();
  assert.equal(panel.source().value, 'github');
  panel.source().onChange({ target: { value: 'npm' } });
  await panel.settle();
  assert.equal(panel.setup().disabled, true, 'npm 404 cannot enable the public flow');
  assert.ok(panel.find((props) => props['data-testid'] === 'setup-package-status'));
  panel.source().onChange({ target: { value: 'project' } });
  panel.render();
  assert.equal(panel.setup().disabled, false);
  assert.equal(panel.find((props) => props['data-testid'] === 'setup-package-status'), null);
  assert.ok(panel.find((props) => typeof props.children === 'string' &&
    props.children.includes('Uses tools/antom-builder. Project command approval is required')));
  await panel.setup().onClick();
  panel.render();
  assert.equal(copied.length, 1);
  assert.match(copied[0], /tools\/antom-builder/);
  assert.doesNotMatch(copied[0], /npm exec/);
  assert.equal(panel.setup().children, 'Request copied');

  panel.source().onChange({ target: { value: 'npm' } });
  panel.render();
  assert.equal(panel.setup().children, 'Copy setup request');
  assert.equal(panel.setup().disabled, true);
  panel.source().onChange({ target: { value: 'project' } });
  panel.render();
  clipboardFails = true;
  await panel.setup().onClick();
  panel.render();
  assert.ok(panel.find((props) => props['aria-label'] === 'Setup request to copy manually'));
  panel.source().onChange({ target: { value: 'npm' } });
  panel.render();
  assert.equal(panel.find((props) => props['aria-label'] === 'Setup request to copy manually'), null);
});

test('project setup locks source changes and duplicate copies while an asynchronous copy is pending', async (t) => {
  let releaseClipboard;
  const pendingClipboard = new Promise((resolve) => { releaseClipboard = resolve; });
  const copied = [];
  const panel = panelHandlerFixture(await readFile(bundlePath, 'utf8'), async (text) => {
    copied.push(text);
    await pendingClipboard;
  });
  t.after(() => { releaseClipboard(); panel.cleanup(); });
  await panel.settle();
  panel.source().onChange({ target: { value: 'project' } });
  panel.render();
  const sourceHandler = panel.source().onChange;
  const setupHandler = panel.setup().onClick;
  const pendingSetup = setupHandler();
  sourceHandler({ target: { value: 'npm' } });
  await setupHandler();
  await panel.settle();
  assert.equal(panel.source().value, 'project', 'the synchronous guard rejects a stale source event');
  assert.equal(panel.source().disabled, true);
  assert.equal(panel.setup().disabled, true);
  assert.equal(copied.length, 1);
  assert.match(copied[0], /tools\/antom-builder/);
  releaseClipboard();
  await pendingSetup;
  panel.render();
  assert.equal(panel.setup().children, 'Request copied');
  assert.equal(panel.source().disabled, false);
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
