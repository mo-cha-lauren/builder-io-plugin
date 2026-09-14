/**
 * Antom Payment Integration Plugin for Builder.io
 *
 * Plugin entrypoint following Builder's custom plugin setup.
 */

/** @jsx jsx */
import { jsx } from '@emotion/core';
import { Builder } from '@builder.io/react';
import appState from '@builder.io/app-context';
import pkg from '../package.json';

import AntomEditTab from './components/AntomEditTab';
import {
  AntomAuthModeEditor,
  AntomEnvironmentEditor,
  AntomGatewayEditor,
  AntomNotifyPublicKeyEditor,
} from './components/AntomSettingsEditors';
import {
  DEFAULT_GATEWAY_ORIGIN,
  validateSettingsSnapshot,
} from './antomSettings.mjs';

const PLUGIN_ID = pkg.name;
let openPluginSettings = null;

// Custom settings editors keep Builder's native Save/Cancel lifecycle and the
// existing flat settings keys. Rendering defaults never writes Space settings.
const SETTINGS_EDITORS = {
  AntomPaymentAuthMode: AntomAuthModeEditor,
  AntomPaymentEnvironment: AntomEnvironmentEditor,
  AntomPaymentGateway: AntomGatewayEditor,
  AntomPaymentNotifyPublicKey: AntomNotifyPublicKeyEditor,
};
for (const [name, component] of Object.entries(SETTINGS_EDITORS)) {
  Builder.registerEditor({ name, component });
}

const PLUGIN_SETTINGS = [
  {
    name: 'authMode',
    friendlyName: '1. Ordinary API authentication',
    type: 'AntomPaymentAuthMode',
    defaultValue: 'rsa',
    // Legacy drafts can be unset while the editor displays a default. Validate
    // the normalized snapshot in onSave instead of blocking untouched defaults.
    required: false,
  },
  {
    name: 'environment',
    friendlyName: 'Environment',
    type: 'AntomPaymentEnvironment',
    defaultValue: 'sandbox',
    required: false,
  },
  {
    name: 'gatewayOrigin',
    friendlyName: 'Gateway origin',
    type: 'AntomPaymentGateway',
    defaultValue: DEFAULT_GATEWAY_ORIGIN,
    required: false,
  },
  {
    name: 'clientId',
    friendlyName: 'Client ID (reference)',
    type: 'string',
    helperText: 'Optional shared reference for project code. Not an API Key; never enter a secret here.',
    required: false,
  },
  {
    name: 'antomPublicKey',
    friendlyName: '2. Notify — RSA configuration',
    type: 'AntomPaymentNotifyPublicKey',
    required: false,
  },
  {
    name: 'keyVersion',
    friendlyName: 'RSA key version',
    type: 'string',
    defaultValue: '1',
    helperText: 'Used by the RSA contract, including notify in either mode. Also used for ordinary RSA requests. Defaults to 1 when empty.',
    required: false,
  },
];

function readSettingsSnapshot() {
  const pluginSettings = appState?.user?.organization?.value?.settings?.plugins?.get(PLUGIN_ID);
  return {
    clientId: pluginSettings?.get('clientId'),
    antomPublicKey: pluginSettings?.get('antomPublicKey'),
    environment: pluginSettings?.get('environment'),
    keyVersion: pluginSettings?.get('keyVersion'),
    gatewayOrigin: pluginSettings?.get('gatewayOrigin'),
    authMode: pluginSettings?.get('authMode'),
  };
}

Builder.register('plugin', {
  name: 'Antom Payment',
  id: PLUGIN_ID,
  settings: PLUGIN_SETTINGS,
  ctaText: 'Edit plugin settings',
  async onSave(actions) {
    let settings;
    try {
      settings = await validateSettingsSnapshot(readSettingsSnapshot());
    } catch (error) {
      try {
        await actions.updateSettings({ hasConnected: false });
      } catch (updateError) {
        console.warn('[Antom Plugin] Failed to persist invalid-settings state:', updateError.message);
      }
      appState?.snackBar?.show?.('Antom settings are invalid. Correct them before continuing.', 4000);
      throw error;
    }

    // Persist exactly what the editors display and config exports normalize,
    // including untouched legacy defaults. Never copy arbitrary stored fields.
    await actions.updateSettings({ ...settings, hasConnected: true });
  },
});

Builder.register('editor.editTab', {
  name: 'Antom',
  component: () => (
    <AntomEditTab
      openSettings={() => {
        if (openPluginSettings) {
          return openPluginSettings();
        }
        appState?.snackBar?.show?.('Reload Builder once, then open Antom plugin settings.', 3000);
        return Promise.resolve();
      }}
    />
  ),
});

Builder.register('app.onLoad', async ({ triggerSettingsDialog }) => {
  openPluginSettings = () => triggerSettingsDialog(PLUGIN_ID);
  const pluginSettings = appState?.user?.organization?.value?.settings?.plugins?.get(PLUGIN_ID);
  const hasOpenedSettings = Boolean(pluginSettings?.get('hasConnected'));

  if (!hasOpenedSettings) {
    await triggerSettingsDialog(PLUGIN_ID);
  }

  console.log('[Antom Plugin] Registered successfully');
});

export { PLUGIN_ID };
export default { PLUGIN_ID };
