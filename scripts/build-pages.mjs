import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillBundle } from './build-skill-bundle.mjs';
import { createGithubSource, GITHUB_REPOSITORY, PAGES_ORIGIN } from './build-github-source.mjs';
import { validateGithubSource } from '../src/githubInstall.mjs';
import { OFFICIAL_SKILL_SOURCE } from '../src/officialSkillInstall.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function readRegular(projectRoot, relative) {
  const parts = relative.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const info = await lstat(path.join(projectRoot, ...parts.slice(0, index)));
    if (info.isSymbolicLink() || (index < parts.length ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
      throw new Error(`Non-regular Pages input: ${relative}`);
    }
  }
  return readFile(path.join(projectRoot, relative));
}

/** Stage reviewed browser assets only. Skills are downloaded directly from official upstream. */
export async function buildPages(projectRoot, { revision, output = '.pages' }) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Pages requires a complete commit SHA.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(output) && output !== '.pages') throw new Error('Use a dedicated Pages output directory name.');
  if (['node_modules', 'dist', 'src', 'bin', 'lib', 'test', 'scripts', 'vendor', 'docs'].includes(output)) throw new Error('Output cannot replace a project directory.');
  const bundle = await createSkillBundle(projectRoot);
  const source = createGithubSource(bundle, revision);
  validateGithubSource(source, bundle.package);
  const generated = JSON.parse((await readRegular(projectRoot, '.generated/github-source.json')).toString('utf8'));
  if (JSON.stringify(source) !== JSON.stringify(generated)) throw new Error('Rebuild the plugin at the Pages revision before publishing.');
  const bundleJson = JSON.parse((await readRegular(projectRoot, '.generated/skill-bundle.json')).toString('utf8'));
  if (JSON.stringify(bundle) !== JSON.stringify(bundleJson)) throw new Error('Rebuild the reviewed Skill data before publishing.');
  const plugin = await readRegular(projectRoot, 'dist/plugin.system.js');
  if (!plugin.includes(Buffer.from(OFFICIAL_SKILL_SOURCE.revision)) || !plugin.includes(Buffer.from(OFFICIAL_SKILL_SOURCE.repository))) {
    throw new Error('Plugin does not contain the matching official Skill source pin.');
  }
  const notices = await readRegular(projectRoot, 'dist/plugin.system.js.LICENSE.txt');
  const license = await readRegular(projectRoot, 'LICENSE');
  const legal = await readRegular(projectRoot, 'LEGAL.md');
  const manifestText = `${JSON.stringify(source.manifest, null, 2)}\n`;
  if (hash(manifestText) !== source.manifestSha256) throw new Error('Manifest pin mismatch.');
  const prefix = `releases/${revision}/`;
  const files = new Map([
    ['plugin.system.js', plugin], ['plugin.system.js.LICENSE.txt', notices],
    [`${prefix}plugin.system.js`, plugin], [`${prefix}plugin.system.js.LICENSE.txt`, notices],
    ['LICENSE', license], ['LEGAL.md', legal],
    ['.nojekyll', Buffer.from('')],
  ]);
  const pluginUrl = `${PAGES_ORIGIN}/plugin.system.js?pluginId=${encodeURIComponent(bundle.package.name)}`;
  const release = {
    formatVersion: 1, repository: GITHUB_REPOSITORY, revision, pluginUrl,
    pluginSha256: hash(plugin), officialSkillSource: OFFICIAL_SKILL_SOURCE,
    skillFiles: 0,
  };
  files.set('release.json', Buffer.from(`${JSON.stringify(release, null, 2)}\n`));
  files.set('index.html', Buffer.from(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Antom Builder plugin</title>
<style>body{max-width:760px;margin:48px auto;padding:0 20px;font:16px/1.6 system-ui;color:#252525}code{overflow-wrap:anywhere}a{color:#2359bd}</style>
<h1>Antom Builder plugin</h1>
<p>Your Builder Space needs the appropriate custom/private-plugin entitlement to load this external URL. Builder currently documents private plugins for Enterprise plans. See <a href="https://www.builder.io/c/docs/private-plugins-setup/">private plugin setup</a> and <a href="https://www.builder.io/c/docs/plugin-support/">plugin support</a>.</p>
<p>Add this URL to your Builder Space plugin settings, save and reload Builder:</p>
<p><code>${pluginUrl}</code></p>
<p>The plugin currently offers only antom-integration. In the Antom tab, select Payment integration and click <strong>Copy install prompt</strong>. Paste it in the current project's Builder Agent chat. After installation is verified, start a new chat to use antom-integration.</p>
<p>The Agent retrieves complete original files from <a href="${OFFICIAL_SKILL_SOURCE.repository}">ant-intl/antom-ai-tools</a> at a pinned commit and writes them into ${OFFICIAL_SKILL_SOURCE.targetDirectory} using native project file tools. Existing parent folders are reused; missing folders are created. The target project does not need a GitHub connection. This site does not mirror Skill files.</p>
<p>Permitted source-reading and native project file tools are required. Obtain complete raw source files before writing; preserve existing Skills and stop on conflicts or denied operations. Read back and compare the written files. This flow uses no terminal installer, runtime-version checks or ACL policy changes.</p>
<p>The browser panel only prepares the prompt. Builder cloud installation, file verification, Skill discovery and business functionality require separate acceptance.</p>
<p>There are no payment settings in this plugin. Configure real credentials in your project's server-side Secrets, outside chat. The browser plugin only prepares the request; copied text is not evidence of installed files or Skill discovery.</p>
<p>A public GitHub repository is not an approved Builder public plugin. Public listing requires submission to Builder and Builder review.</p>
<p>Build <code>${revision}</code> · <a href="https://github.com/${GITHUB_REPOSITORY}">Source and instructions</a> · <a href="release.json">Release metadata</a> · <a href="LICENSE">License</a></p></html>\n`));
  const destination = path.join(projectRoot, output);
  try {
    await mkdir(destination);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(destination)).length) {
      throw new Error('Pages output must be an empty regular directory; nothing was removed.');
    }
  }
  for (const [relative, content] of files) {
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
  }
  return { ...release, output: destination, stagedFiles: files.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--revision' || args[2] !== '--output') {
    throw new Error('Usage: node scripts/build-pages.mjs --revision <commit-sha> --output .pages');
  }
  console.log(JSON.stringify(await buildPages(root, { revision: args[1], output: args[3] }), null, 2));
}
