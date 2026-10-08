# Maintainer notes

The supported customer flow is in the [README](../README.md). The browser plugin
only copies a fixed-source installation request and a usage example. It does not
download files, run an installer, persist settings, read credentials or call
payment APIs. File checks in the prompt are requests to Builder Agent, not
plugin-enforced filesystem controls.

## Verification

- `npm run dev` (or `npm start`): compile and watch the plugin, serving only
  `plugin.system.js` and its license notices at `http://127.0.0.1:1268/`.
  `http://localhost:1268/` is also accepted when localhost resolves to IPv4.
  The server binds to loopback only; it has no proxy or filesystem browsing.
  Builds use a private temporary directory, leaving production `dist/` untouched.
  GET/HEAD and CORS/private-network OPTIONS requests are supported. During builds
  or compilation failures it returns HTTP 503 instead of stale JavaScript.
  Edits rebuild automatically, but **refresh Builder manually** to load changes;
  webpack-dev-server's browser HMR/live reload is intentionally not included.
  Stop with Ctrl+C to close the watcher and remove temporary output. This local
  development server is not part of the published browser package.

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
