# Developer notes

These notes concern repository maintenance only. The supported user experience
is the integration-only flow in the [README](../README.md).

## Retained compatibility code

The repository retains historical CLI installers, configuration helpers, adapted
Skill bundles and archive-generation code. Some of these cover reconciliation.
They are not imported by the current browser panel as installation choices and
do not indicate that reconciliation installation is supported.

The customer catalog in `src/skillOptions.mjs` permits only `integration`.
The v3 prompt in `src/officialSkillInstall.mjs` uses the official upstream source,
not these retained bundles. Do not reintroduce retired paths as user-facing
fallbacks without separate review and Builder acceptance.

Removing a customer option does not delete any files or previous settings in a
user's Builder project or Space. The current plugin does not read or transfer
old payment settings.

## Test boundaries

- `npm test` runs source checks, the production build and tests for current
  behavior and retained compatibility code.
- `npm run test:package` is a historical package/CLI smoke test. The Pages build
  still runs it to catch regressions in the retained package.
- `npm run test:legacy-official-install` is an explicitly opt-in, network-dependent
  CLI regression. It downloads into isolated temporary fixtures; it does not
  test the current native-file installation prompt in Builder.
- Legacy reconciliation assets, tests and generated archives are maintenance
  artifacts, not an offered customer installation method.

A passing local test does not prove that a Builder session can retrieve original
source files, persist them or discover the Skill. Those need real Builder tests.
Do not label package smoke results as payment or reconciliation acceptance.

## Installation boundaries

The browser plugin copies instructions, not source file bytes. Checks requested
in the prompt are performed by the Builder Agent, not enforced by a plugin-owned
filesystem API.

The v3 request requires complete source data before writing, preserves existing
selected Skill files and asks for destination read-back. When source retrieval
or comparison is unavailable, installation remains unverified. Known partial
writes must be reported without claiming rollback or authorizing automatic repair.

The installation phase does not run Skill scripts, install application runtime
dependencies, generate payment code or access real environment files and Secrets.

## Publication

`.github/workflows/pages.yml` runs on `main`, including manual dispatches
restricted to that branch. The build job runs `npm test` and `test:package`.
`scripts/build-pages.mjs` prepares the allowlisted site files.

The Pages artifact contains browser bundles, notices and release metadata.
It does not publish mirrored Skill directories, generated Skill ZIPs or
configuration downloads. Verify the deployment independently from repository
visibility and Builder plugin-access permissions.
