# Antom Payment Plugin for Builder.io

> Development distribution. GitHub Pages publishes the browser plugin and pinned Skill data after its workflow succeeds. This public source repository is not an approved Builder public plugin. External URL loading requires the appropriate Builder custom/private-plugin entitlement. Source verification and a green build do not prove a successful Builder cloud installation.

Antom's Builder.io editor plugin helps teams install reviewed, pinned Antom Skills once per project, then use them through ordinary Builder Agent chat. No additional backend service or MCP connection is required.

The plugin:

- Adds an `Antom` editor tab.
- Stores optional, non-secret Antom reference values in Builder plugin settings.
- Creates one revision-pinned GitHub file-import request for Builder Agent in the connected cloud project.
- Supports payment integration and supplied-file settlement analysis, including the required supporting scripts.
- Includes validated, non-secret payment configuration in the setup request and instructs Agent to apply it only to `.env.example`.
- Lets projects select RSA or API key authentication for ordinary payment API requests; notify-related interfaces always retain RSA.

It never stores an API key or merchant private key, or authenticates Antom requests in the browser. Authentication, signing and secret handling must remain in trusted server-side code generated for the target project.

## Install in a Builder Space

![Builder.io plugin installation settings](./docs/media/builder-installation.png)

Your Space needs permission to load a custom/private plugin from an external
URL. Builder currently documents this capability for Enterprise plans; confirm
your organization's entitlement with its Space administrator. Making a GitHub
repository public does not make its plugin an approved Builder public plugin.
Public distribution through Builder requires submission to Builder's repository
and Builder review. See [private plugin setup](https://www.builder.io/c/docs/private-plugins-setup/)
and [plugin support](https://www.builder.io/c/docs/plugin-support/).

1. In Builder, open your **Space settings → Integrations → Plugins → Edit** and add:

   ```text
   https://mo-cha-lauren.github.io/builder-io-plugin/plugin.system.js?pluginId=@antglobal/builder-io-plugin-antom-payment
   ```

2. Remove an older URL for this same plugin from the Space plugin list if present, then save and reload Builder. Do not install duplicate copies of the same plugin ID.
3. Open the **Antom** tab in your connected target project and follow the setup below.

The plugin URL becomes available after the repository's Pages deployment
succeeds. If Builder refuses external plugin URLs, resolve the Space entitlement
with your administrator before proceeding.

## Use the plugin

![Antom Builder.io plugin demo](./docs/media/builder-io-demo.gif)

The demo above shows an earlier panel layout. The current panel guides you
through setup directly in Builder's connected cloud project.

The `Antom` tab has two main cards:

1. **Setup in Builder**: choose **Payment integration**, **Bill analysis**, or both. For payment integration, use **Edit settings** to review the authentication mode, environment and non-secret reference values. Select **Copy setup request** and paste it once into Builder Agent chat for the connected project. Bill analysis alone does not require payment settings or create payment environment variables.
2. **Start a chat**: review Agent's import and read-back results and any unverified runtime prerequisites, then start a new Agent session so it can discover the installed Skills. Copy an example request or write your own; there is no need to paste the full Skill again.

The copied request asks Agent to inspect the project and import the complete,
pinned Skill files through its permitted web-reading and file-editing tools.
Agent preflights all destination and configuration conflicts before writing,
creates missing files, preserves identical files and reads the result back.
Customized or conflicting files require resolution before retrying. The request
does not run an installer, install dependencies, authorize command-policy
changes, or access real `.env` files or secret-manager values.

Installing the plugin in a Space and importing Skills into a project are
separate steps. The browser panel cannot write project files or verify the
remote installation. **Copied** confirms only that the request was copied.
Review Agent's actual import and read-back results and any unverified runtime prerequisites before starting a new
chat. Use the panel's **Usage guide** for setup help without leaving Builder.

### Source and project verification

The panel verifies the pinned source manifest and, before copying, the selected
source files' exact byte lengths and SHA-256 hashes. **Source manifest verified**
does not mean the target project is installed. Agent must read every source file
in full and report changed, skipped and conflicting files with full read-back
results. If native destination hashing is unavailable, it must report
**Destination SHA-256 not verified**; it cannot claim byte-level verification.

Stop setup if native tools are denied or unavailable, source content is
transformed or truncated, safe project paths cannot be established, or conflicts
remain. Do not work around these failures with shell commands or a preloaded
test package. Only start the new chat after the complete import has been
reviewed. Source verification alone does not establish Builder cloud acceptance,
Skill discovery or business functionality.

### Example requests

- Payment: "Use antom-integration to add Antom payment to this project. Confirm the product, integration mode and region first."
- Reconciliation: "Use antom-reconciliation-expert to analyze the sanitized Settlement Detail file I provide. Do not retrieve online bills or access production accounts. Ask before installing dependencies."

Review Agent's actual use of the Skill and its output; a particular opening
sentence is not an installation or functional test.

### Payment configuration

1. In **Setup in Builder**, select payment integration and open **Edit settings**. Choose **RSA** or **API Key (Bearer)** for ordinary API requests, enter non-secret reference values, and confirm the gateway for the merchant's contracted region. Keep the RSA reference values needed for notify even when choosing API Key.
2. Save settings, then select **Copy setup request** and paste it into Builder Agent chat. The request includes only the six allowlisted settings below, never an API key or private key. Agent applies them to `.env.example` through its permitted file-editing tools.
3. Review `.env.example`. Agent is instructed to preserve unrelated variables/comments and leave both API key and merchant private key empty. Configure real values yourself in a trusted server environment or secret manager, never in Agent chat.
4. Ask Agent to implement the payment flow using the integration Skill and the project's existing frontend/server patterns. Validate the real flow in Builder Preview with sandbox credentials, including verified final payment status.

After changing plugin settings, copy and submit a fresh setup request. Plugin
settings do not automatically synchronize to project files or runtime secrets. Cloud setup stops
if a non-empty managed value in `.env.example` conflicts with the new settings
or either secret placeholder is non-empty; review and reconcile the reported
keys before retrying.

The settings dialog separates **Ordinary API authentication** from **Notify —
RSA configuration**. API key mode explains where to configure `ANTOM_API_KEY`
on the project server; the dialog never asks for its value. Unset environment
and gateway settings display their defaults immediately. Clicking **Save**
persists the normalized values shown in the dialog, including defaults you did
not change; opening the dialog alone does not save settings. Review the gateway
for your merchant region before saving. Unsupported saved values show an error
instead of silently selecting another value.

#### Authentication modes

| Operation | `rsa` (default) | `api_key` |
| --- | --- | --- |
| Ordinary outbound Antom API request | Existing RSA signing | `Authorization: Bearer <ANTOM_API_KEY>` from server Secrets |
| Any notify-related interface | RSA | RSA, unchanged |

The mode selects generated project code behavior; the plugin and setup request do
not call payment APIs. Keep notification verification and any RSA signing
required by the notify contract in both modes. API key mode does not remove
required response verification or imply that an RSA-only SDK supports Bearer.
Agent must check SDK support, use the installed Builder addendum for the
authentication extension, and use the endpoint's official documentation for
all other request requirements. Never silently fall back to another mode after
an authentication error.

An existing project must receive the updated integration Skill before using
new authentication guidance. Changing plugin settings alone does not upgrade
installed guidance or business code. Review changed Skill files before replacing
them; the setup request stops when existing files differ from the pinned source.

`ANTOM_API_KEY` is needed in server Secrets for ordinary API key requests. RSA
material required by notify remains necessary; do not delete it when switching
modes. Select API key mode only with credentials provisioned for the intended
merchant and environment. Verify an ordinary sandbox request and valid/invalid
RSA notifications through the real project before using the mode in production.

### Verify the sandbox payment flow

Installing Skills or updating example configuration does not verify a payment.
After reviewing the generated code, configure sandbox secrets manually in the
project's trusted server environment, outside Agent chat, then check:

1. Complete checkout through the actual project's frontend and server in Builder Preview.
2. Confirm the ordinary API request uses the selected RSA or API key mode. Invalid credentials must fail without silently switching modes.
3. Confirm a valid RSA notification is verified before it updates payment status. Reject notifications with invalid or missing signatures, even in API key mode.
4. Check the backend result and final status through a verified RSA notification or an Antom query. A redirect page or mocked response is not proof of payment.
5. Confirm frontend output, logs and exported files contain no API keys, private keys or `Authorization` values.

### Reconciliation and CLI boundaries

Supplied-file analysis supports authorized, sanitized **Settlement Detail
CSV/XLSX** reports. It requires Python 3.8+ and `openpyxl`, `requests`, and
`jsonschema` in the actual Agent execution environment. Setup does not install
them. Use a project virtual environment and review dependency changes.
Business knowledge, rules and templates may still be loaded from the upstream
public CDN; this is not a fully offline product.

The original upstream scripts are preserved. Some online operations hardcode
`--live`; online bill retrieval and transaction queries are **outside this
integration's supported scope**. Builder's sandbox setting does not select a
CLI profile or prevent production access. The separate Builder addendum provides
workflow guidance, not technical isolation. Only process data you are authorized
to use in the chosen local or cloud runtime.

For separate CLI usage, consult the [official Antom CLI documentation](https://docs.antom.com/ac/ref/antom_cli).
Users install and authorize it themselves. The plugin does not ship an additional
CLI Skill, store CLI credentials, or automatically invoke payment/merchant commands.

## Settings

| Setting | Required | Description |
| --- | --- | --- |
| `authMode` | No | `rsa` (default for existing settings) or `api_key`; selects ordinary requests only. Notify-related interfaces always use RSA. This field never contains the API key itself. |
| `clientId` | No | Antom Client ID used as non-secret reference data. |
| `antomPublicKey` | No | Antom RSA public key as Base64-encoded SPKI (the Dashboard/SDK form) or `PUBLIC KEY` PEM. It is cryptographically parsed during validation and normalized to Base64 before being handed to Agent. |
| `environment` | No | `sandbox` or `production`; defaults to `sandbox`. |
| `keyVersion` | No | Numeric Antom signature key version; defaults to `1`. |
| `gatewayOrigin` | No | Allowlisted Antom gateway for the merchant's contracted region. |

Supported online-payment gateway origins are:

- `https://open.antglobal-us.com`
- `https://open-na-global.alipay.com`
- `https://open-na.alipay.com`
- `https://open-sea-global.alipay.com`
- `https://open-sea.alipay.com`
- `https://open-de-global.alipay.com`

Always confirm the correct region and current API path in the [official Antom API documentation](https://docs.antom.com/ac/ams/api). The installed Skill routes Agent to product-specific documentation for request bodies, timestamps and RSA protocols. The separate Builder addendum supplies the ordinary-request Bearer contract described above without modifying the pinned upstream Skill source.

## Security boundary

- Do not put API keys or private keys in Builder settings, frontend code, source control, screenshots, logs, or Agent prompts. Never log the `Authorization` header.
- Agent may create or update `.env.example`; it is explicitly instructed not to read, create, or modify real `.env` files or secret-manager values.
- The setup request includes explicit non-secret reference settings and instructs Agent to stop on file conflicts or unsafe paths. Review Agent's verification of these conditions before accepting the import.
- Keep `ANTOM_API_KEY` and `ANTOM_MERCHANT_PRIVATE_KEY` empty in `.env.example` in both modes. Setup stops if either is non-empty.
- Keep notify-related interfaces on RSA in both modes; never bypass signature verification because ordinary requests use Bearer.
- Verify asynchronous notifications before trusting them, and do not treat a client redirect as final payment status.
- Confirm uncertain status through a verified notification or Antom query API.

Example template:

```dotenv
ANTOM_AUTH_MODE="rsa"
ANTOM_API_KEY=
ANTOM_CLIENT_ID="your_client_id"
ANTOM_PUBLIC_KEY="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A..."
ANTOM_MERCHANT_PRIVATE_KEY=
ANTOM_ENVIRONMENT="sandbox"
ANTOM_KEY_VERSION="1"
ANTOM_GATEWAY_ORIGIN="https://open-sea-global.alipay.com"
ANTOM_DEFAULT_CURRENCY=
```

## Developer maintenance and verification

This section is for plugin maintainers. Customer setup uses the single
**Copy setup request → Builder Agent → new chat** flow above. Local build and
packaging checks require Node.js 20 or newer.

```bash
npm ci
npm test
npm run test:package
npm audit
npm pack --dry-run --json
```

For a developer's local Builder smoke test, run `npm run dev`, then add this
exact URL to the Space's plugin list and reload Builder:

```text
http://localhost:1268/plugin.system.js?pluginId=@antglobal/builder-io-plugin-antom-payment
```

The `pluginId` query parameter must match the package name registered by the
plugin. Without it, the `Antom` editor tab can load while Builder cannot associate
the URL with the plugin settings dialog.

`npm test` checks the pinned upstream Skills, builds the production SystemJS bundle,
and tests the installer, setup preflight, stdin configuration, conflict/path
protections, RSA/API key configuration and legacy config compatibility, cloud
setup controls, asset hashes and ZIP/installer consistency. CI also covers
Windows installation behavior. To compare the pinned integration Skill with
the current upstream `main` branch, run:

```bash
npm run check:antom-skill-drift
```

Both Skill sources are pinned to the commit recorded in their source manifests.
Original reconciliation files live under `vendor/antom-reconciliation-expert/`;
Builder-specific additions live under `adapters/`. The existing integration
snapshot stays under `.builder/skills/antom-integration/`. These are build inputs,
not files generated for this plugin's own payment integration.

`npm run build:skills` verifies the source manifests and generates distribution
payloads under `.generated/`. `npm run build` produces the browser plugin and
maintainer packaging artifacts under `dist/`. The customer panel exposes only
the pinned file-import setup request.

The integration distribution contains **5 files**: its runtime `SKILL.md`
combines the upstream instructions and Builder addendum; `UPSTREAM_SKILL.md`
and `BUILDER_ADDENDUM.md` preserve those components for audit, alongside source
metadata and the upstream license. Reconciliation contains the same **5 kinds
of instruction, audit, metadata and license files**, plus **14 script/schema
files**, including three empty `__init__.py` files, for **19 files** total.
These counts describe the complete pinned distribution, not separate features
or a claim that every file is required for the current workflow. The retained
upstream online bill and transaction scripts remain outside the supported
supplied-file analysis scope. Source files, provenance and licenses are preserved.

`npm run test:package` installs the packed npm archive offline into a disposable
directory and checks complete installation, stdin setup, repeat runs, conflicts,
configuration merging and preservation of real environment files without the
source checkout. This checks local packaging; it does not establish public npm
availability, Builder cloud setup or Agent Skill execution.
`npm run test:reconciliation` runs an offline
synthetic CSV/XLSX parsing smoke; Python is required, and the XLSX case is skipped
if `openpyxl` is unavailable. On Windows, run `python -B test/reconciliation-smoke.py`
if the Python command is named `python`. This smoke forbids network and subprocess
calls; it does not verify CDN knowledge, DSL rules or a real merchant workflow.

### GitHub Pages maintenance

In this repository, set **Settings → Pages → Source → GitHub Actions**, then
wait for **Actions → Publish plugin to GitHub Pages** on `main` to succeed.

The Pages workflow builds and tests the exact `main` commit, stages only the
browser bundle/licenses and complete inert Skill data, then deploys with
GitHub's Pages actions. It never uploads the repository tree or executes the
copied upstream scripts as part of installation. Build permissions are read-only;
only the deployment job receives Pages/OIDC permissions. No personal token is
needed. A workflow running on any other branch cannot deploy.

The site hosts only the current deployment's revision. Old plugin builds stop
when their pinned data is unavailable; reload the current plugin instead of
silently selecting another revision. The site root and `release.json` show the
deployed commit and plugin hash. This workflow does not publish an npm package.

After deployment, verify the public plugin URL, `release.json`, manifest and
every selected asset hash. Test the customer flow in an ordinary connected
application with no preinstalled Antom Skills or `tools/antom-builder`. Review
complete imports under `.builder/skills/antom-integration/` and
`.builder/skills/antom-reconciliation-expert/`, destination read-back results,
conflict and repeat-run behavior, and absence of real credential access.
Confirm payment reference configuration changes only `.env.example` and
bill-only setup leaves it untouched. Test new-chat Skill discovery, both payment authentication modes
with RSA notify verification, and supplied-file analysis in the actual cloud
runtime. Record unresolved tools, hashing or runtime limitations. Local tests,
Pages deployment and source verification do not establish cloud acceptance.

## Support

Open an issue in the [public source repository](https://github.com/mo-cha-lauren/builder-io-plugin/issues) or email [TechnicalService@antom.com](mailto:TechnicalService@antom.com).

## License

Released under the [MIT License](LICENSE). See [LEGAL.md](LEGAL.md) for the repository's language disclaimer.
