import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const copiedPaths = Object.freeze([
  'bin/antom-builder.mjs', 'bin/setup-project.mjs', 'lib/project-installer.mjs', 'src/antomSettings.mjs', 'LICENSE', 'LEGAL.md',
]);
const artifactPaths = [...copiedPaths, 'dist/skill-bundle.json', 'package.json'].sort();

async function assertRegularPath(directory, relative) {
  const parts = relative.split('/');
  let target = directory;
  for (let index = 0; index < parts.length; index += 1) {
    target = path.join(target, parts[index]);
    const entry = await lstat(target);
    if (entry.isSymbolicLink() || (index < parts.length - 1 ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) {
      throw new Error('The project installer source must contain only regular, unlinked files.');
    }
  }
}

export async function createProjectInstaller(projectRoot = root, bundle) {
  await assertRegularPath(projectRoot, 'package.json');
  const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  if (!bundle || bundle.formatVersion !== 1 || bundle.package?.name !== pkg.name || bundle.package?.version !== pkg.version) {
    throw new Error('Build a matching Skill bundle before creating the project test installer.');
  }
  const files = [];
  for (const relative of copiedPaths) {
    await assertRegularPath(projectRoot, relative);
    files.push({ path: relative, content: await readFile(path.join(projectRoot, relative), 'utf8') });
  }
  files.push({ path: 'package.json', content: `${JSON.stringify({
    name: pkg.name, version: pkg.version, license: pkg.license, private: true,
  }, null, 2)}\n` });
  files.push({ path: 'dist/skill-bundle.json', content: `${JSON.stringify(bundle, null, 2)}\n` });
  files.sort((left, right) => left.path.localeCompare(right.path));
  // Pin the other runtime files INSIDE the independently verified entry. The
  // project-local request must not be able to choose which code is trusted.
  // Excluding the entry here avoids a circular hash; the plugin pins it below.
  const entry = files.find((file) => file.path === 'bin/setup-project.mjs');
  const marker = 'const PINNED_INSTALLER = null; // build-pinned-runtime';
  if (entry.content.split(marker).length !== 2) {
    throw new Error('Build the project installer from the reviewed setup entry source template.');
  }
  const pinned = {
    formatVersion: 1, name: pkg.name, version: pkg.version,
    files: files.filter((file) => file !== entry).map(({ path: relative, content }) => ({
      path: relative, sha256: createHash('sha256').update(content).digest('hex'),
    })),
  };
  entry.content = entry.content.replace(marker,
    `const PINNED_INSTALLER = ${JSON.stringify(pinned)}; // build-pinned-runtime`);
  const manifest = {
    formatVersion: 1, name: pkg.name, version: pkg.version,
    files: files.map(({ path: relative, content }) => ({
      path: relative, sha256: createHash('sha256').update(content).digest('hex'),
    })),
  };
  return { manifest, files };
}

async function assertOutputTree(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory() && artifactPaths.some((file) => file.startsWith(`${relative}/`))) {
      await assertOutputTree(path.join(directory, entry.name), `${relative}/`);
    } else if (!entry.isFile() || !artifactPaths.includes(relative) || (await lstat(path.join(directory, entry.name))).nlink !== 1) {
      throw new Error('Unexpected file in generated test installer. Inspect it before rebuilding; nothing will be removed automatically.');
    }
  }
}

export async function buildProjectInstaller(projectRoot = root, bundle) {
  const artifact = await createProjectInstaller(projectRoot, bundle);
  const generated = path.join(projectRoot, '.generated');
  const output = path.join(generated, 'project-test-installer');
  await mkdir(generated, { recursive: true });
  if ((await lstat(generated)).isSymbolicLink()) throw new Error('Generated directory must not be a symbolic link.');
  await mkdir(output, { recursive: true });
  if ((await lstat(output)).isSymbolicLink()) throw new Error('Generated installer directory must not be a symbolic link.');
  await assertOutputTree(output);
  for (const file of artifact.files) {
    const destination = path.join(output, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
  const manifestPath = path.join(generated, 'project-installer-manifest.json');
  try {
    const entry = await lstat(manifestPath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('Generated manifest must be a regular, unlinked file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(manifestPath, `${JSON.stringify(artifact.manifest, null, 2)}\n`);
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundle = JSON.parse(await readFile(path.join(root, '.generated/skill-bundle.json'), 'utf8'));
  const { files } = await buildProjectInstaller(root, bundle);
  console.log(`Built ${files.length} pinned project test installer files.`);
}
