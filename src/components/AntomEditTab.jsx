/** @jsx jsx */
import { jsx } from '@emotion/core';
import { useEffect, useRef, useState } from 'react';
import appState from '@builder.io/app-context';
import Button from '@material-ui/core/Button';
import Card from '@material-ui/core/Card';
import CardContent from '@material-ui/core/CardContent';
import Typography from '@material-ui/core/Typography';
import pkg from '../../package.json';
import skillArchives from '../../.generated/skill-downloads.json';
import projectInstallerManifest from '../../.generated/project-installer-manifest.json';
import AntomUsageGuide from './AntomUsageGuide';
import {
  copyPlainText,
  createEmptySettingsSnapshot,
  getSettingsHash,
  validateSettingsSnapshot,
} from '../antomSettings.mjs';
import {
  SKILL_OPTIONS,
  checkSetupPackage,
  createCheckCommand,
  createCloudSetupPrompt,
  createConfigCommand,
  createConfigExport,
  createInstallCommand,
  createProjectSetupPrompt,
  downloadConfigFile,
  downloadSkillArchive,
} from '../installExperience.mjs';

const PLUGIN_ID = pkg.name;
const SETUP_COPY_KEY = 'setup-request';
const commandStyle = {
  backgroundColor: '#f7f8fa',
  padding: '8px',
  borderRadius: '4px',
  fontSize: '11px',
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
  margin: '8px 0',
};
const buttonStyle = { textTransform: 'none' };
const buttonRowStyle = { display: 'flex', flexWrap: 'wrap', gap: '8px' };
const smallTextStyle = { fontSize: '12px', lineHeight: 1.5 };

/** Copies a request for the user to run in Builder Agent; never executes it. */
const AntomEditTab = ({ openSettings }) => {
  const [selectedSkills, setSelectedSkills] = useState(['integration']);
  const [installerSource, setInstallerSource] = useState('npm');
  const [copiedText, setCopiedText] = useState('');
  const [copyingKey, setCopyingKey] = useState('');
  const [manualRequest, setManualRequest] = useState('');
  const [settingsSnapshot, setSettingsSnapshot] = useState(createEmptySettingsSnapshot());
  const [lastExportedHash, setLastExportedHash] = useState('');
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState('');
  const [openingSettings, setOpeningSettings] = useState(false);
  const [exportingConfig, setExportingConfig] = useState(false);
  const [packageState, setPackageState] = useState({ status: 'checking', message: 'Checking setup package…' });
  const [guideOpen, setGuideOpen] = useState(false);
  const copyResetTimer = useRef(null);
  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const packageSequenceRef = useRef(0);
  const packageControllerRef = useRef(null);
  const packageCheckingRef = useRef(false);
  const copySequenceRef = useRef(0);
  const copyLockRef = useRef(false);
  const setupLockRef = useRef(false);
  const settingsLockRef = useRef(false);
  const exportLockRef = useRef(false);
  const installerSourceRef = useRef('npm');
  const hasIntegration = selectedSkills.includes('integration');
  const copyingSetup = copyingKey === SETUP_COPY_KEY;
  const usingProjectInstaller = installerSource === 'project';

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
      packageCheckingRef.current = false;
      copyLockRef.current = false;
      setupLockRef.current = false;
      settingsLockRef.current = false;
      exportLockRef.current = false;
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
    if (packageCheckingRef.current || !mountedRef.current) return;
    packageCheckingRef.current = true;
    const requestId = ++packageSequenceRef.current;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    packageControllerRef.current = controller;
    setPackageState({ status: 'checking', message: 'Checking setup package…' });
    try {
      const result = await checkSetupPackage(pkg, { signal: controller?.signal });
      if (!mountedRef.current || requestId !== packageSequenceRef.current) return;
      setPackageState(result);
    } catch {
      if (!mountedRef.current || requestId !== packageSequenceRef.current) return;
      setPackageState({ status: 'unavailable', message: 'Unable to check the setup package. Retry.' });
    } finally {
      if (mountedRef.current && requestId === packageSequenceRef.current) {
        packageCheckingRef.current = false;
        packageControllerRef.current = null;
      }
    }
  };

  const handleOpenSettings = async () => {
    if (settingsLockRef.current || setupLockRef.current || exportLockRef.current) return;
    settingsLockRef.current = true;
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
    setupLockRef.current = key === SETUP_COPY_KEY;
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
          showMessage('Copy failed. Try again or copy the displayed text manually.');
        }
      }
    } finally {
      if (isCurrent()) {
        copyLockRef.current = false;
        setupLockRef.current = false;
        setCopyingKey('');
      }
    }
  };

  const copyText = (text) => copyContent(() => text, text);

  const copySetupRequest = () => {
    const source = installerSourceRef.current;
    if (!selectedSkills.length || (source === 'npm' && packageState.status !== 'available') ||
      (hasIntegration && (settingsLoading || settingsError || settingsLockRef.current || exportLockRef.current))) return;
    const selection = [...selectedSkills];
    return copyContent(async () => {
      const latestSnapshot = hasIntegration ? await refreshSettings() : {};
      if (!latestSnapshot || !mountedRef.current || source !== installerSourceRef.current) return null;
      const request = source === 'project'
        ? await createProjectSetupPrompt(pkg, selection, latestSnapshot, projectInstallerManifest)
        : await createCloudSetupPrompt(pkg, selection, latestSnapshot);
      return source === installerSourceRef.current ? request : null;
    }, SETUP_COPY_KEY, 'Request copied. Paste in Builder Agent');
  };

  const changeInstallerSource = (source) => {
    if (!['npm', 'project'].includes(source) || copyLockRef.current ||
      settingsLockRef.current || exportLockRef.current || (hasIntegration && settingsLoading)) return;
    installerSourceRef.current = source;
    setInstallerSource(source);
    copySequenceRef.current += 1;
    clearTimeout(copyResetTimer.current);
    setCopiedText('');
    setManualRequest('');
  };

  const downloadSkills = () => {
    try {
      downloadSkillArchive(skillArchives, selectedSkills);
      showMessage('Download requested. Merge the ZIP into your project; it is not installed yet.');
    } catch {
      showMessage('ZIP download failed. Try the installation command instead.');
    }
  };

  const exportConfig = async () => {
    if (exportLockRef.current || settingsLockRef.current || setupLockRef.current) return;
    exportLockRef.current = true;
    const lifecycle = lifecycleRef.current;
    setExportingConfig(true);
    try {
      const latestSnapshot = await refreshSettings();
      if (!latestSnapshot || !mountedRef.current || lifecycle !== lifecycleRef.current) return;
      const content = await createConfigExport(latestSnapshot);
      if (!mountedRef.current || lifecycle !== lifecycleRef.current) return;
      downloadConfigFile(content);
      setLastExportedHash(getSettingsHash(latestSnapshot));
      showMessage('Config download requested. Run the config command to update .env.example.');
    } catch {
      if (mountedRef.current && lifecycle === lifecycleRef.current) {
        showMessage('Config download failed. Check your settings and try again.');
      }
    } finally {
      if (mountedRef.current && lifecycle === lifecycleRef.current) {
        exportLockRef.current = false;
        setExportingConfig(false);
      }
    }
  };

  const toggleSkill = (id) => {
    if (setupLockRef.current || settingsLockRef.current || exportLockRef.current) return;
    setSelectedSkills((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : [...current, id]);
    setCopiedText('');
    setManualRequest('');
  };

  const installCommand = selectedSkills.length ? createInstallCommand(pkg, selectedSkills) : '';
  const checkCommand = selectedSkills.length ? createCheckCommand(pkg, selectedSkills) : '';
  const configCommand = createConfigCommand(pkg);
  const currentSettingsHash = settingsError ? '' : getSettingsHash(settingsSnapshot);
  const settingsChangedSinceExport = Boolean(lastExportedHash && lastExportedHash !== currentSettingsHash);
  const settingsBusy = settingsLoading || openingSettings || exportingConfig || copyingSetup;
  const setupDisabled = !selectedSkills.length || Boolean(copyingKey) || (!usingProjectInstaller && packageState.status !== 'available') ||
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
                <input type="checkbox" checked={selectedSkills.includes(id)}
                  disabled={copyingSetup || openingSettings || exportingConfig} onChange={() => toggleSkill(id)} />
                {label}
              </label>
            ))}
          </div>
          <label css={{ display: 'grid', gap: '4px', marginBottom: '12px', ...smallTextStyle }}>
            Installer source
            <select aria-label="Installer source" value={installerSource}
              disabled={Boolean(copyingKey) || openingSettings || exportingConfig || (hasIntegration && settingsLoading)}
              onChange={(event) => changeInstallerSource(event.target.value)}
              css={{ width: '100%', minWidth: 0, padding: '6px', font: 'inherit', border: '1px solid #ccc', borderRadius: '4px', background: '#fff' }}>
              <option value="npm">Public npm</option>
              <option value="project">Project test package</option>
            </select>
          </label>
          {usingProjectInstaller && (
            <Typography variant="body2" color="textSecondary" css={{ ...smallTextStyle, marginBottom: '8px' }}>
              Uses tools/antom-builder. Project command approval is required before verification and setup.
            </Typography>
          )}
          {hasIntegration && (
            <div css={{ ...buttonRowStyle, alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <Typography variant="body2" css={smallTextStyle}>
                {settingsLoading ? 'Loading settings…' : settingsError ? 'Settings unavailable' :
                  `${settingsSnapshot.authMode === 'api_key' ? 'API Key (Bearer)' : 'RSA'} · ${settingsSnapshot.environment}`}
              </Typography>
              <Button type="button" size="small" onClick={handleOpenSettings}
                disabled={openingSettings || exportingConfig || copyingSetup} style={buttonStyle}>
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
              ? 'Paste in the current Builder Agent chat to install Skills, merge non-secret settings into .env.example, and check setup.'
              : 'Paste in the current Builder Agent chat to install Skills and check setup.'}
          </Typography>
          <Button type="button" variant="contained" color="primary" size="small"
            onClick={copySetupRequest} disabled={setupDisabled} style={buttonStyle}>
            {copyingSetup ? 'Preparing request…' : copiedText === SETUP_COPY_KEY ? 'Request copied' : 'Copy setup request'}
          </Button>
          {!usingProjectInstaller && packageState.status !== 'available' && (
            <div data-testid="setup-package-status" role="status" aria-live="polite" css={{ ...smallTextStyle, marginTop: '8px', color: '#616161' }}>
              <span>{packageState.message}</span>
              {packageState.status !== 'checking' && (
                <Button type="button" size="small" onClick={refreshPackage} style={buttonStyle}>Retry</Button>
              )}
            </div>
          )}
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

      <details data-testid="local-development" css={{ ...smallTextStyle, margin: '12px 0' }}>
        <summary css={{ cursor: 'pointer', color: '#555', padding: '4px 0' }}>Local development (optional)</summary>
        <p>Run commands at your project root with Node.js 20+. The npm package must be accessible.</p>
        <p><strong>Install Skills</strong></p>
        <pre css={commandStyle}>{installCommand || 'Select at least one Skill.'}</pre>
        <div css={buttonRowStyle}>
          <Button type="button" variant="outlined" size="small" onClick={() => copyText(installCommand)}
            disabled={!installCommand || Boolean(copyingKey)} style={buttonStyle}>
            {copiedText === installCommand && installCommand ? 'Command copied' : 'Copy install command'}
          </Button>
          <Button type="button" variant="outlined" size="small" onClick={downloadSkills}
            disabled={!installCommand} style={buttonStyle}>
            Download Skill ZIP
          </Button>
        </div>
        <p>Review npm&apos;s package download prompt before approving. For ZIPs, review and merge .builder/skills without overwriting existing files, then sync to Builder. Copying or downloading does not install Skills.</p>
        {checkCommand && (
          <div>
            <p><strong>Check installation</strong></p>
            <pre css={commandStyle}>{checkCommand}</pre>
            <Button type="button" variant="outlined" size="small" onClick={() => copyText(checkCommand)}
              disabled={Boolean(copyingKey)} style={buttonStyle}>
              {copiedText === checkCommand ? 'Command copied' : 'Copy check command'}
            </Button>
          </div>
        )}
        {hasIntegration && (
          <div>
            <p><strong>Payment configuration</strong></p>
            <div css={{ display: 'grid', gap: '4px', margin: '8px 0' }}>
              <span>Client ID: {settingsSnapshot.clientId ? 'configured' : 'missing'}</span>
              <span>Antom public key: {settingsSnapshot.antomPublicKey ? 'configured' : 'missing'}</span>
              <span>Key version: {settingsSnapshot.keyVersion || '1'}</span>
              <span>Gateway: {settingsSnapshot.gatewayOrigin}</span>
              <span>Last refreshed: {settingsSnapshot.refreshedAt || 'not refreshed'}</span>
            </div>
            {settingsChangedSinceExport && <p role="status" css={{ color: '#b3261e' }}>Settings changed. Download a new config.</p>}
            <div css={buttonRowStyle}>
              <Button type="button" variant="outlined" size="small" onClick={() => {
                if (!setupLockRef.current && !settingsLockRef.current && !exportLockRef.current) refreshSettings();
              }} disabled={settingsBusy} style={buttonStyle}>
                {settingsLoading ? 'Refreshing…' : 'Refresh settings'}
              </Button>
              <Button type="button" variant="outlined" size="small" onClick={exportConfig}
                disabled={settingsBusy || Boolean(settingsError)} style={buttonStyle}>
                {exportingConfig ? 'Preparing…' : 'Download config'}
              </Button>
            </div>
            <p>Place antom.config.json at the project root, then run:</p>
            <pre css={commandStyle}>{configCommand}</pre>
            <Button type="button" variant="outlined" size="small" onClick={() => copyText(configCommand)}
              disabled={Boolean(copyingKey)} style={buttonStyle}>
              {copiedText === configCommand ? 'Command copied' : 'Copy config command'}
            </Button>
            <p>Updates .env.example only. Set API Keys and private keys in server Secrets. Confirm the gateway for your merchant region.</p>
          </div>
        )}
        {selectedSkills.includes('reconciliation') && (
          <p>Bill analysis needs sanitized files, Python, and separate dependencies. Online scripts use --live independently of the plugin environment; public knowledge may be fetched online.</p>
        )}
        <a href="https://docs.antom.com/ac/ref/antom_cli" target="_blank" rel="noopener noreferrer">Antom CLI guide</a>
      </details>

      <Typography variant="body2" color="textSecondary" css={smallTextStyle}>
        Secrets stay on your server; notify always uses RSA.
      </Typography>
      <Button type="button" size="small" onClick={() => setGuideOpen(true)} style={buttonStyle}>Usage guide</Button>
      <AntomUsageGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
    </div>
  );
};

export default AntomEditTab;
