# Maintainer notes

The supported customer flow is in the [README](../README.md). The browser plugin
only copies a fixed-source installation request and a usage example. It does not
download files, run an installer, persist settings, read credentials or call
payment APIs. File checks in the prompt are requests to Builder Agent, not
plugin-enforced filesystem controls.

## Verification

- `npm test`: build and test the prompt, clipboard, UI and Pages staging.
- `npm run test:package`: pack into a temporary directory and enforce the exact
  browser-only package allowlist; no registry publication or CLI installation.
- `npm run check:antom-skill-drift`: compare the actual pinned upstream entry
  with upstream main; never update the pin automatically.

The old CLI, configuration editors, mirrored Skills and ZIP distribution are
removed. Existing Skills and saved settings in user projects remain untouched.
Local tests are not evidence of Builder source retrieval, installation or Skill
discovery; verify those separately in a real Builder project.

## Publication boundaries

Webpack collects the package license and NOTICE files for third-party modules in
emitted chunks (including concatenated modules). Full texts are appended to
`dist/plugin.system.js.LICENSE.txt`, alongside the minifier's extracted notices.
Missing or empty license texts fail the build. This file ships with both the npm
package and current/revision-pinned Pages bundles. Externally supplied Builder
and React modules are not bundled. The root MIT license remains unchanged.

GitHub Pages only stages browser bundles, license notices and build metadata.
Public source hosting or npm publication does not imply Builder public approval.
The README is the intended post-approval user guide; confirm the final package
identity and Fusion/Agent support with Builder before submitting.

Company approval for public source, license, brand, recording assets, publishing
account and maintenance ownership is separate from technical verification.
