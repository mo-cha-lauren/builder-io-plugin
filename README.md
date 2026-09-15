# Antom Integration for Builder.io

Add the official **antom-integration** Skill to your Builder project through the
**Antom** plugin tab.

The plugin prepares an installation prompt. **Builder Agent retrieves and writes
the Skill files** in your current project; the plugin does not install files
directly or perform payment integration by itself.

This release offers only **Payment integration**. Reconciliation installation is
not offered.

## 1. Add the plugin to Builder

Your Builder Space must allow custom/private plugins. Builder documents private
plugins as an Enterprise feature; hosting this repository publicly does not
automatically make it an approved public Builder plugin. Check
[plugin access requirements](https://www.builder.io/c/docs/plugin-support/)
before proceeding.

Once the GitHub Pages deployment for this release has succeeded:

1. Open your Builder **Space Settings**.
2. Find **Plugins** under **Integrations** and click **Edit**.
3. Add the following JavaScript URL, then save and reload Builder.
   If you previously used the localhost version, replace that entry rather than
   loading both versions.

```text
https://mo-cha-lauren.github.io/builder-io-plugin/plugin.system.js?pluginId=%40antglobal%2Fbuilder-io-plugin-antom-payment
```

This is the deployed JavaScript URL, not the GitHub repository URL.
The deployment must be available before Builder can load it. See
[Builder's custom plugin setup](https://www.builder.io/c/docs/publish-custom-plugin-setup).

If Builder reports that your account cannot access private plugins, this is an
access restriction; making the repository public does not resolve it.

## 2. Install antom-integration

1. Open your application project in Builder and select the **Antom** tab.
2. Leave **Payment integration** selected and click **Copy install prompt**.
3. Paste the prompt into the **current project's Builder Agent chat** and send it.
4. The Agent checks for existing files, retrieves the pinned official source,
   creates missing directories and writes
   `.builder/skills/antom-integration/SKILL.md`.
5. Wait for the Agent to report source retrieval, file writing and read-back
   verification. Copying the prompt alone does not install the Skill.

The installation prompt begins with **Antom Skill installation request v3**.
If clipboard access fails, copy the identical prompt displayed in the panel.

This is the only user installation flow. You do **not** need to clone this plugin
repository into your application, connect the application to GitHub, create
directories manually, run an installer command or publish an npm package.

### Existing files or installation failures

The Agent reuses `.builder/skills` when it exists and preserves unrelated Skills.
If same-named Skill files already exist under `.builder/skills` or
`.claude/skills`, it stops and reports the conflict without overwriting them.

The Agent needs permitted source-reading and project file tools. Incomplete
source retrieval, denied operations or failed verification must be reported,
not presented as a successful installation. The prompt does not authorize
permission changes, automatic cleanup or overwriting existing files.

## 3. Verify discovery and use the Skill

After file installation is verified, start a new Builder chat **in the same
project** and send:

> Use the installed antom-integration Skill. Report the SKILL.md path, name and
> description you loaded. Do not generate code or call payment APIs yet.

Once discovery is confirmed, you can use **Copy example** in the Antom tab:

> Use antom-integration to add Antom sandbox payments to this project.

This second request starts a separate payment-integration task. Configure any
required real credentials through the application's server-side Secrets, never
in plugin settings or chat. The plugin does not configure credentials, modify
environment files or initiate payments.

## Source and verification status

The installation request points to the official
[ant-intl/antom-ai-tools repository](https://github.com/ant-intl/antom-ai-tools),
at fixed commit `1014616896d171ddb1c2a37e526beb00c33b79d7`.

- Source: `skills/antom-integration/SKILL.md` — one original file at this pin.
- Destination: `.builder/skills/antom-integration/SKILL.md`.
- No rewritten Skill, Builder addendum or lock-file update is requested.
- This plugin's hosting site does not mirror the Skill files.

Builder recognizes `.builder/skills` as its primary Skill location.
See [Builder's Skill documentation](https://www.builder.io/c/docs/skills).

In a Builder test project, installation/read-back and subsequent loading in a
new chat were reported successful by the Agent; the tester also confirmed the
destination file in the project UI. This is a scoped integration-Skill acceptance
result, not proof that every Builder account or project will support the flow.

Payment API execution, sandbox payment completion and production readiness are
**not established by installation or discovery**. Local automated tests check
the plugin and its generated prompt; they do not replace Builder acceptance.

## For developers

The commands below are for maintaining this plugin repository, **not for users
installing the Skill in their application**.

### Local development

```sh
npm install
npm run dev
```

Load this local plugin URL in Builder and reload the page:

```text
http://localhost:1268/plugin.system.js?pluginId=@antglobal/builder-io-plugin-antom-payment
```

Use the checkout containing your latest changes. A server running from another
checkout will serve that other version.

### Build and test

```sh
npm test
```

This checks the source assets, builds the production plugin and runs the tests,
including the compiled panel, clipboard behavior and installation prompt.
Retained compatibility tests and historical artifacts are explained in
[developer notes](docs/developer-notes.md); they are not additional user
installation methods.

### Publish with GitHub Pages

1. Review the changes for secrets, internal-only material and license notices.
2. Push the reviewed branch to this repository and merge it into `main`.
3. In repository **Settings → Pages**, set **Source** to **GitHub Actions**.
4. Wait for both jobs in **Publish plugin to GitHub Pages** to succeed.
5. Reload Builder using the deployed plugin URL above and confirm that only
   **Payment integration** is offered and the copied prompt starts with v3.

The [Pages workflow](.github/workflows/pages.yml) runs on pushes to `main`.
It builds and tests the plugin, then publishes only the prepared browser files,
not the repository or its Skill archives. A branch push alone does not deploy.
No npm publication is needed for this hosting flow.

GitHub Pages deployment and Builder public-plugin approval are separate.
Deploying the JavaScript does not remove Builder's account access requirements.

## License

See [LICENSE](LICENSE) and [LEGAL.md](LEGAL.md) for plugin and upstream notices.
The original Skill retains its upstream license.
