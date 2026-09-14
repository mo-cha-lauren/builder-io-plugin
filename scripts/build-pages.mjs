import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillBundle } from './build-skill-bundle.mjs';
import { createGithubSource, GITHUB_REPOSITORY, PAGES_ORIGIN } from './build-github-source.mjs';
import { validateGithubSource } from '../src/githubInstall.mjs';

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

/** Stage only reviewed browser assets and inert Skill data, never the source checkout. */
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
  if (!plugin.includes(Buffer.from(source.manifestSha256))) throw new Error('Plugin does not contain the matching GitHub manifest pin.');
  const notices = await readRegular(projectRoot, 'dist/plugin.system.js.LICENSE.txt');
  const license = await readRegular(projectRoot, 'LICENSE');
  const legal = await readRegular(projectRoot, 'LEGAL.md');
  const manifestText = `${JSON.stringify(source.manifest, null, 2)}\n`;
  if (hash(manifestText) !== source.manifestSha256) throw new Error('Manifest pin mismatch.');
  const prefix = `releases/${revision}/`;
  const files = new Map([
    ['plugin.system.js', plugin], ['plugin.system.js.LICENSE.txt', notices],
    [`${prefix}plugin.system.js`, plugin], [`${prefix}plugin.system.js.LICENSE.txt`, notices],
    [`${prefix}manifest.json`, Buffer.from(manifestText)],
    ['LICENSE', license], ['LEGAL.md', legal],
    ['.nojekyll', Buffer.from('')],
  ]);
  for (const skill of bundle.skills) {
    for (const file of skill.files) {
      const bytes = Buffer.from(file.content, 'utf8');
      if (hash(bytes) !== file.sha256) throw new Error('Skill asset pin mismatch.');
      files.set(`${prefix}${file.path.replace(/^\.builder\//, '')}`, bytes);
    }
  }
  const pluginUrl = `${PAGES_ORIGIN}/plugin.system.js?pluginId=${encodeURIComponent(bundle.package.name)}`;
  const release = {
    formatVersion: 1, repository: GITHUB_REPOSITORY, revision, pluginUrl,
    pluginSha256: hash(plugin), manifestUrl: `${source.baseUrl}manifest.json`, manifestSha256: source.manifestSha256,
    skillFiles: bundle.skills.reduce((total, skill) => total + skill.files.length, 0),
  };
  files.set('release.json', Buffer.from(`${JSON.stringify(release, null, 2)}\n`));
  files.set('index.html', Buffer.from(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Antom Builder plugin</title>
<style>body{max-width:760px;margin:48px auto;padding:0 20px;font:16px/1.6 system-ui;color:#252525}code{overflow-wrap:anywhere}a{color:#2359bd}</style>
<h1>Antom Builder plugin</h1>
<p>Add this URL to your Builder Space plugin settings:</p>
<p><code>${pluginUrl}</code></p>
<p>Select <strong>GitHub (no npm)</strong> in the Antom tab. Copy the setup request into a clean target project's Agent chat. It requests complete file import using permitted native tools, not an executable installer.</p>
<p>This deployment verifies the distribution source only. Builder cloud import, destination hashes, Skill discovery and business functionality require separate acceptance. Stop on unavailable or denied tools, truncated files or conflicts. Do not change command restrictions.</p>
<p>Old builds are not retained by this site. Reload the current plugin if its pinned manifest is unavailable; never silently substitute another revision.</p>
<p>Secrets stay on your server. Notification interfaces always use RSA. No npm package is published by this workflow.</p>
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
