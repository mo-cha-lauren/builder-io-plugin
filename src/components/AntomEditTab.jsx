/** @jsx jsx */
import { jsx } from '@emotion/core';
import { useEffect, useRef, useState } from 'react';
import appState from '@builder.io/app-context';
import Button from '@material-ui/core/Button';
import Card from '@material-ui/core/Card';
import CardContent from '@material-ui/core/CardContent';
import Typography from '@material-ui/core/Typography';
import pkg from '../../package.json';
import githubSource from '../../.generated/github-source.json';
import { checkGithubSource, createGithubSetupPrompt } from '../githubInstall.mjs';
import AntomUsageGuide from './AntomUsageGuide';
import {
  copyPlainText,
  createEmptySettingsSnapshot,
  validateSettingsSnapshot,
} from '../antomSettings.mjs';
import { SKILL_OPTIONS } from '../installExperience.mjs';

const PLUGIN_ID = pkg.name;
const SETUP_COPY_KEY = 'setup-request';
const buttonStyle = { textTransform: 'none' };
const buttonRowStyle = { display: 'flex', flexWrap: 'wrap', gap: '8px' };
const smallTextStyle = { fontSize: '12px', lineHeight: 1.5 };

/** Copies a request for the user to run in Builder Agent; never executes it. */
const AntomEditTab = ({ openSettings }) => {
  const [selectedSkills, setSelectedSkills] = useState(['integration']);
  const [copiedText, setCopiedText] = useState('');
  const [copyingKey, setCopyingKey] = useState('');
  const [manualRequest, setManualRequest] = useState('');
  const [settingsSnapshot, setSettingsSnapshot] = useState(createEmptySettingsSnapshot());
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState('');
  const [openingSettings, setOpeningSettings] = useState(false);
  const [packageState, setPackageState] = useState({ status: 'checking', message: 'Checking source manifest…' });
  const [guideOpen, setGuideOpen] = useState(false);
  const copyResetTimer = useRef(null);
  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const packageSequenceRef = useRef(0);
  const packageControllerRef = useRef(null);
  const copyControllerRef = useRef(null);
  const packageCheckingRef = useRef(false);
  const copySequenceRef = useRef(0);
  const copyLockRef = useRef(false);
  const settingsLockRef = useRef(false);
  const sourceAvailableRef = useRef(false);
  const setupRevisionRef = useRef(0);
  const setupRevision = setupRevisionRef.current;
  const hasIntegration = selectedSkills.includes('integration');
  const copyingSetup = copyingKey === SETUP_COPY_KEY;

  useEffect(() => {
    mountedRef.current = true;
    refreshPackage();
    return () => {
      mountedRef.current = false;
      lifecycleRef.current += 1;
      refreshSequenceRef.current += 1;
      packageSequenceRef.current += 1;
      copySequenceRef.current += 1;
      packageControllerRef.current?.abort();
      copyControllerRef.current?.abort();
      packageCheckingRef.current = false;
      copyLockRef.current = false;
      settingsLockRef.current = false;
      sourceAvailableRef.current = false;
      clearTimeout(copyResetTimer.current);
    };
  }, []);

  useEffect(() => {
    if (hasIntegration) refreshSettings();
    return () => { refreshSequenceRef.current += 1; };
  }, [hasIntegration]);

  const showMessage = (message) => {
    if (mountedRef.current) appState?.snackBar?.show?.(message, 4000);
  };

  const loadCurrentSettings = async () => {
    const pluginSettings = appState?.user?.organization?.value?.settings?.plugins?.get(PLUGIN_ID);
    const settings = await validateSettingsSnapshot({
      clientId: pluginSettings?.get('clientId') || '',
      antomPublicKey: pluginSettings?.get('antomPublicKey') || '',
      environment: pluginSettings?.get('environment') || 'sandbox',
      keyVersion: pluginSettings?.get('keyVersion') || '1',
      gatewayOrigin: pluginSettings?.get('gatewayOrigin'),
      authMode: pluginSettings?.get('authMode'),
    });
    return { ...settings, refreshedAt: new Date().toLocaleString() };
  };

  const refreshSettings = async () => {
    const requestId = ++refreshSequenceRef.current;
    setSettingsLoading(true);
    setManualRequest('');
    setCopiedText('');
    clearTimeout(copyResetTimer.current);
    try {
      const nextSnapshot = await loadCurrentSettings();
      if (!mountedRef.current || requestId !== refreshSequenceRef.current) return null;
      setSettingsSnapshot(nextSnapshot);
      setSettingsError('');
      return nextSnapshot;
    } catch {
      if (!mountedRef.current || requestId !== refreshSequenceRef.current) return null;
      setSettingsSnapshot(createEmptySettingsSnapshot());
      setSettingsError('Settings unavailable. Edit and save to continue.');
      return null;
    } finally {
      if (mountedRef.current && requestId === refreshSequenceRef.current) setSettingsLoading(false);
    }
  };

  const refreshPackage = async () => {
    if (packageCheckingRef.current || copyLockRef.current || !mountedRef.current) return;
    packageCheckingRef.current = true;
    sourceAvailableRef.current = false;
    const requestId = ++packageSequenceRef.current;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    packageControllerRef.current = controller;
    setPackageState({ status: 'checking', message: 'Checking source manifest…' });
    try {
      const result = await checkGithubSource(githubSource, { signal: controller?.signal });
      if (!mountedRef.current || requestId !== packageSequenceRef.current) return;
      sourceAvailableRef.current = result.status === 'available';
      setPackageState(result);
    } catch {
      if (!mountedRef.current || requestId !== packageSequenceRef.current) return;
      setPackageState({ status: 'unavailable', message: 'Unable to verify the source manifest. Retry.' });
    } finally {
      if (mountedRef.current && requestId === packageSequenceRef.current) {
        packageCheckingRef.current = false;
        packageControllerRef.current = null;
      }
    }
  };

  const handleOpenSettings = async () => {
    if (settingsLockRef.current || copyLockRef.current) return;
    settingsLockRef.current = true;
    setupRevisionRef.current += 1;
    const lifecycle = lifecycleRef.current;
    setOpeningSettings(true);
    setManualRequest('');
    setCopiedText('');
    try {
      await openSettings();
    } catch {
      if (mountedRef.current && lifecycle === lifecycleRef.current) {
        showMessage('Unable to open Antom plugin settings.');
      }
    } finally {
      if (mountedRef.current && lifecycle === lifecycleRef.current) {
        await refreshSettings();
        if (mountedRef.current && lifecycle === lifecycleRef.current) {
          settingsLockRef.current = false;
          setOpeningSettings(false);
        }
      }
    }
  };

  const copyContent = async (getText, key, message) => {
    if (copyLockRef.current || !mountedRef.current) return;
    copyLockRef.current = true;
    const requestId = ++copySequenceRef.current;
    const isCurrent = () => mountedRef.current && requestId === copySequenceRef.current;
    setCopyingKey(key);
    setCopiedText('');
    if (key === SETUP_COPY_KEY) setManualRequest('');
    clearTimeout(copyResetTimer.current);
    let text;
    try {
      text = await getText();
      if (!text || !isCurrent()) return;
      await copyPlainText(text);
      if (!isCurrent()) return;
      setCopiedText(key);
      if (message) showMessage(message);
      copyResetTimer.current = setTimeout(() => {
        if (isCurrent()) setCopiedText('');
      }, 3000);
    } catch {
      if (isCurrent()) {
        if (key === SETUP_COPY_KEY && text) {
          setManualRequest(text);
          showMessage('Clipboard unavailable. Copy the request shown below and paste in Builder Agent.');
        } else {
          showMessage(key === SETUP_COPY_KEY
            ? 'Unable to prepare a verified request. Check the source and settings, then retry.'
            : 'Copy failed. Try again or copy the displayed text manually.');
        }
      }
    } finally {
      if (isCurrent()) {
        copyLockRef.current = false;
        setCopyingKey('');
      }
    }
  };

  const copyText = (text) => copyContent(() => text, text);

  const copySetupRequest = () => {
    if (setupRevision !== setupRevisionRef.current || !selectedSkills.length || !sourceAvailableRef.current ||
      settingsLockRef.current || (hasIntegration && (settingsLoading || settingsError))) return;
    const selection = [...selectedSkills];
    return copyContent(async () => {
      const latestSnapshot = hasIntegration ? await refreshSettings() : {};
      if (!latestSnapshot || !mountedRef.current || setupRevision !== setupRevisionRef.current) return null;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      copyControllerRef.current = controller;
      try {
        const request = await createGithubSetupPrompt(pkg, selection, latestSnapshot, githubSource, { signal: controller?.signal });
        return mountedRef.current && setupRevision === setupRevisionRef.current ? request : null;
      } catch (error) {
        if (mountedRef.current && setupRevision === setupRevisionRef.current) {
          sourceAvailableRef.current = false;
          setPackageState({ status: 'unavailable', message: 'Unable to verify the selected Skill files. Retry.' });
        }
        throw error;
      } finally {
        if (copyControllerRef.current === controller) copyControllerRef.current = null;
      }
    }, SETUP_COPY_KEY, 'Request copied. Paste in Builder Agent');
  };

  const toggleSkill = (id) => {
    if (copyLockRef.current || settingsLockRef.current) return;
    setupRevisionRef.current += 1;
    clearTimeout(copyResetTimer.current);
    setSelectedSkills((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : [...current, id]);
    setCopiedText('');
    setManualRequest('');
  };

  const settingsBusy = settingsLoading || openingSettings || copyingSetup;
  const setupDisabled = !selectedSkills.length || Boolean(copyingKey) || packageState.status !== 'available' ||
    (hasIntegration && (settingsBusy || Boolean(settingsError)));

  return (
    <div css={{ padding: '12px', height: '100%', minWidth: 0, boxSizing: 'border-box', overflow: 'auto', overflowWrap: 'anywhere' }}>
      <Typography variant="h6" css={{ fontSize: '16px', marginBottom: '12px' }}>
        Antom Payment
      </Typography>

      <Card data-testid="setup-in-builder" css={{ marginBottom: '12px' }}>
        <CardContent>
          <Typography variant="subtitle1" css={{ fontSize: '15px', marginBottom: '8px' }}>
            1. Setup in Builder
          </Typography>
          <div css={{ display: 'grid', gap: '8px', marginBottom: '12px' }}>
            {SKILL_OPTIONS.map(({ id, label }) => (
              <label key={id} css={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
                <input type="checkbox" value={id} checked={selectedSkills.includes(id)}
                  disabled={Boolean(copyingKey) || openingSettings} onChange={() => toggleSkill(id)} />
                {label}
              </label>
            ))}
          </div>
          <Typography variant="body2" color="textSecondary" css={{ ...smallTextStyle, marginBottom: '8px' }}>
            Imports complete files with Agent tools.
          </Typography>
          {hasIntegration && (
            <div css={{ ...buttonRowStyle, alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <Typography variant="body2" css={smallTextStyle}>
                {settingsLoading ? 'Loading settings…' : settingsError ? 'Settings unavailable' :
                  `${settingsSnapshot.authMode === 'api_key' ? 'API Key (Bearer)' : 'RSA'} · ${settingsSnapshot.environment}`}
              </Typography>
              <Button type="button" size="small" onClick={handleOpenSettings}
                disabled={openingSettings || Boolean(copyingKey)} style={buttonStyle}>
                {openingSettings ? 'Opening…' : 'Edit settings'}
              </Button>
            </div>
          )}
          {hasIntegration && settingsError && (
            <Typography variant="body2" color="error" role="alert" css={{ ...smallTextStyle, marginBottom: '8px' }}>
              {settingsError}
            </Typography>
          )}
          <Typography variant="body2" color="textSecondary" css={{ ...smallTextStyle, marginBottom: '12px' }}>
            {hasIntegration
              ? 'Paste in Builder Agent to import files and non-secret settings. Verify the written files before use.'
              : 'Paste in Builder Agent to import Skill files. Verify the written files before use.'}
          </Typography>
          <Button type="button" variant="contained" color="primary" size="small"
            onClick={copySetupRequest} disabled={setupDisabled} style={buttonStyle}>
            {copyingSetup ? 'Preparing request…' : copiedText === SETUP_COPY_KEY ? 'Request copied' : 'Copy setup request'}
          </Button>
          <div data-testid="setup-package-status" role="status" aria-live="polite" css={{ ...smallTextStyle, marginTop: '8px', color: '#616161' }}>
            <span>{packageState.status === 'available' ? 'Source manifest verified; project installation is not verified.' : packageState.message}</span>
            {!['checking', 'available'].includes(packageState.status) && (
              <Button type="button" size="small" onClick={refreshPackage} style={buttonStyle}>Retry</Button>
            )}
          </div>
          {!selectedSkills.length && (
            <Typography variant="body2" color="textSecondary" role="status" css={{ ...smallTextStyle, marginTop: '8px' }}>
              Select at least one Skill.
            </Typography>
          )}
          {manualRequest && (
            <div css={{ ...smallTextStyle, marginTop: '12px' }}>
              <p role="alert">Clipboard unavailable. Select and copy this request, then paste in Builder Agent.</p>
              <textarea aria-label="Setup request to copy manually" readOnly value={manualRequest} rows={5}
                onFocus={(event) => event.currentTarget.select()}
                css={{ width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: '11px', padding: '8px', resize: 'vertical' }} />
              <Button type="button" size="small" onClick={() => setManualRequest('')} style={buttonStyle}>Dismiss</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="start-chat" css={{ marginBottom: '12px' }}>
        <CardContent>
          <Typography variant="subtitle1" css={{ fontSize: '15px', marginBottom: '4px' }}>
            2. Start a chat
          </Typography>
          <Typography variant="body2" color="textSecondary" css={smallTextStyle}>
            After the Agent confirms setup, start a new Builder chat.
          </Typography>
          {SKILL_OPTIONS.filter(({ id }) => selectedSkills.includes(id)).map(({ id, label, example }) => (
            <div key={id} css={{ marginTop: '10px' }}>
              {selectedSkills.length > 1 && <Typography variant="body2" css={{ fontWeight: 600 }}>{label}</Typography>}
              <p css={{ fontSize: '13px', lineHeight: 1.5, margin: '6px 0' }}>{example}</p>
              <Button type="button" variant="outlined" size="small" onClick={() => copyText(example)}
                disabled={Boolean(copyingKey)} style={buttonStyle}>
                {copiedText === example ? 'Example copied' : 'Copy example'}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>


      <Typography variant="body2" color="textSecondary" css={smallTextStyle}>
        Secrets stay on your server; notify always uses RSA.
      </Typography>
      <Button type="button" size="small" onClick={() => setGuideOpen(true)} style={buttonStyle}>Usage guide</Button>
      <AntomUsageGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
    </div>
  );
};

export default AntomEditTab;
