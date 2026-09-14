/** @jsx jsx */
import { jsx } from '@emotion/core';
import {
  ALLOWED_GATEWAY_ORIGINS,
  normalizeAuthMode,
  normalizeEnvironment,
  normalizeGatewayOrigin,
} from '../antomSettings.mjs';

const containerStyle = { width: '100%', minWidth: 0, overflowWrap: 'anywhere' };
const labelStyle = { display: 'block', fontSize: '14px', fontWeight: 500 };
const descriptionStyle = { margin: '8px 0 0', fontSize: '12px', lineHeight: 1.5, color: '#616161' };
const instructionStyle = {
  ...descriptionStyle,
  padding: '12px',
  border: '1px solid #dce4f4',
  borderRadius: '4px',
  backgroundColor: '#f7f9fd',
};
const controlStyle = {
  display: 'block',
  width: '100%',
  maxWidth: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  marginTop: '8px',
  padding: '10px 12px',
  border: '1px solid #d5d5d5',
  borderRadius: '4px',
  backgroundColor: '#fafafa',
  color: '#333333',
  fontFamily: 'inherit',
  fontSize: '14px',
};

function isReadOnly({ disabled, readOnly, field }) {
  return Boolean(disabled || readOnly || field?.disabled || field?.readOnly);
}

function readSelection(value, normalize) {
  try {
    return { value: normalize(value), invalid: false };
  } catch {
    // Never echo an unrecognized saved value: it could contain a secret.
    return { value: '', invalid: true };
  }
}

function Selection({ label, showLabel = true, selection, options, normalize, editorProps }) {
  const locked = isReadOnly(editorProps);
  const handleChange = (event) => {
    if (locked) return;
    const nextSelection = readSelection(event.target.value, normalize);
    if (!nextSelection.invalid) editorProps.onChange?.(nextSelection.value);
  };

  return (
    <div css={containerStyle}>
      <label css={labelStyle}>
        {showLabel && label}
        <select
          aria-label={label}
          aria-invalid={selection.invalid || undefined}
          value={selection.value}
          onChange={handleChange}
          disabled={locked}
          css={{ ...controlStyle, textOverflow: 'ellipsis' }}
        >
          {selection.invalid && <option value="" disabled>Select a valid value</option>}
          {options.map(({ value, label: optionLabel }) => (
            <option key={value} value={value}>{optionLabel}</option>
          ))}
        </select>
      </label>
      {selection.invalid && (
        <p role="alert" css={{ ...descriptionStyle, color: '#b3261e' }}>
          The saved value is invalid. Select a valid value before saving.
        </p>
      )}
    </div>
  );
}

/** Custom editors only update Builder's draft through explicit user changes. */
export function AntomAuthModeEditor(props) {
  const selection = readSelection(props.value, normalizeAuthMode);
  return (
    <section css={containerStyle}>
      <Selection
        label="Authentication method"
        selection={selection}
        options={[
          { value: 'rsa', label: 'RSA' },
          { value: 'api_key', label: 'API Key (Bearer)' },
        ]}
        normalize={normalizeAuthMode}
        editorProps={props}
      />
      {selection.value === 'api_key' && (
        <p css={instructionStyle}>
          Ordinary API requests use Authorization: Bearer &lt;API_KEY&gt;.
          Manually set ANTOM_API_KEY in your project server's environment or secret manager.
          There is no API Key input here: never enter it in plugin settings, exported configuration,
          or Agent chat.
        </p>
      )}
      {selection.value === 'rsa' && (
        <p css={instructionStyle}>
          Ordinary API requests use RSA signing on your project server.
          Manually set ANTOM_MERCHANT_PRIVATE_KEY in its environment or secret manager;
          never enter the private key in plugin settings, exported configuration, or Agent chat.
        </p>
      )}
      <p css={{ ...descriptionStyle, fontWeight: 500 }}>
        Notify-related interfaces always use RSA, including in API Key mode. Configure their RSA
        references in the separate notify section below.
      </p>
    </section>
  );
}

export function AntomEnvironmentEditor(props) {
  return (
    <div css={containerStyle}>
      <Selection
        label="Environment"
        showLabel={false}
        selection={readSelection(props.value, normalizeEnvironment)}
        options={[
          { value: 'sandbox', label: 'Sandbox' },
          { value: 'production', label: 'Production' },
        ]}
        normalize={normalizeEnvironment}
        editorProps={props}
      />
      <p css={descriptionStyle}>
        Antom request environment. Unset settings use the displayed Sandbox default.
      </p>
    </div>
  );
}

export function AntomGatewayEditor(props) {
  return (
    <div css={containerStyle}>
      <Selection
        label="Gateway origin"
        showLabel={false}
        selection={readSelection(props.value, normalizeGatewayOrigin)}
        options={ALLOWED_GATEWAY_ORIGINS.map((origin) => ({ value: origin, label: origin }))}
        normalize={normalizeGatewayOrigin}
        editorProps={props}
      />
      <p css={descriptionStyle}>
        Confirm the gateway for your merchant region. Unset settings use the displayed default;
        this selection is independent of Sandbox or Production.
      </p>
    </div>
  );
}

export function AntomNotifyPublicKeyEditor(props) {
  const locked = isReadOnly(props);
  return (
    <section css={containerStyle}>
      <p css={{ ...instructionStyle, margin: '0 0 12px' }}>
        Notify-related interfaces always use RSA, regardless of the ordinary API authentication mode.
        The Antom public key and RSA key version remain relevant in API Key mode.
      </p>
      <label css={labelStyle}>
        Antom public key
        <textarea
          aria-label="Antom public key"
          value={typeof props.value === 'string' ? props.value : ''}
          onChange={(event) => {
            if (!locked) props.onChange?.(event.target.value);
          }}
          disabled={Boolean(props.disabled || props.field?.disabled)}
          readOnly={Boolean(props.readOnly || props.field?.readOnly)}
          rows={4}
          maxLength={16 * 1024}
          spellCheck={false}
          autoComplete="off"
          css={{ ...controlStyle, resize: 'vertical', maxHeight: '180px', overflow: 'auto', lineHeight: 1.5 }}
        />
      </label>
      <p css={descriptionStyle}>
        Optional public reference for RSA notification verification: Base64 SPKI or PUBLIC KEY PEM.
        Never enter an API Key or private key here. Configure any required merchant private key
        manually in your project server's environment or secret manager, outside Agent chat.
        RSA mode also uses these references for ordinary API requests.
      </p>
    </section>
  );
}
