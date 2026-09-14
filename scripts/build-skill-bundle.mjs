import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { buildProjectInstaller } from './build-project-installer.mjs';
import { createGithubSource, getBuildRevision } from './build-github-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

async function listFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      result.push(...await listFiles(path.join(directory, entry.name), `${relative}/`));
    } else if (entry.isFile()) {
      result.push(relative);
    } else {
      throw new Error(`Unsupported asset type: ${relative}`);
    }
  }
  return result.sort();
}

function makeFile(targetPath, content) {
  return { path: targetPath, content, sha256: digest(content) };
}

function assertRelativePath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.\-/]+$/.test(value) ||
      value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid pinned asset path.');
  }
}

export async function createSkillBundle(projectRoot = root) {
  const pkg = await readJson(path.join(projectRoot, 'package.json'));
  const integrationRoot = path.join(projectRoot, '.builder/skills/antom-integration');
  const metadata = await readJson(path.join(integrationRoot, 'antom-skill-source.json'));
  const upstream = await readFile(path.join(integrationRoot, 'UPSTREAM_SKILL.md'), 'utf8');
  const addendum = await readFile(path.join(integrationRoot, 'BUILDER_ADDENDUM.md'), 'utf8');
  const generated = await readFile(path.join(integrationRoot, 'SKILL.md'), 'utf8');
  if (digest(upstream) !== metadata.sha256 ||
      generated !== `${upstream.trimEnd()}\n\n${addendum.trimEnd()}\n`) {
    throw new Error('Integration Skill differs from its pinned source or Builder addendum.');
  }

  const reconMetadata = await readJson(path.join(projectRoot, 'vendor/antom-reconciliation-source.json'));
  if (reconMetadata.commit !== metadata.commit || !/^[a-f0-9]{40}$/.test(reconMetadata.commit)) {
    throw new Error('Review and pin both upstream assets to the same Antom source commit.');
  }
  const reconRoot = path.join(projectRoot, 'vendor/antom-reconciliation-expert');
  const recordedPaths = reconMetadata.files.map((file) => file.path).sort();
  if (new Set(recordedPaths).size !== recordedPaths.length ||
      JSON.stringify(await listFiles(reconRoot)) !== JSON.stringify(recordedPaths)) {
    throw new Error('Reconciliation asset tree differs from its reviewed file manifest.');
  }
  const reconciliationFiles = [];
  const reconciliationAddendum = await readFile(
    path.join(projectRoot, 'adapters/reconciliation/BUILDER_ADDENDUM.md'), 'utf8'
  );
  for (const file of reconMetadata.files) {
    assertRelativePath(file.path);
    const bytes = await readFile(path.join(reconRoot, file.path));
    const content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes) || digest(bytes) !== file.sha256) {
      throw new Error(`Pinned reconciliation asset mismatch: ${file.path}`);
    }
    const targetDirectory = '.builder/skills/antom-reconciliation-expert';
    if (file.path === 'SKILL.md') {
      reconciliationFiles.push(makeFile(`${targetDirectory}/UPSTREAM_SKILL.md`, content));
      reconciliationFiles.push(makeFile(`${targetDirectory}/SKILL.md`,
        `${content.trimEnd()}\n\n${reconciliationAddendum.trimEnd()}\n`));
    } else {
      reconciliationFiles.push(makeFile(`${targetDirectory}/${file.path}`, content));
    }
  }
  reconciliationFiles.push(makeFile('.builder/skills/antom-reconciliation-expert/BUILDER_ADDENDUM.md',
    reconciliationAddendum));
  reconciliationFiles.push(makeFile(
    '.builder/skills/antom-reconciliation-expert/antom-skill-source.json',
    `${JSON.stringify(reconMetadata, null, 2)}\n`
  ));
  const integrationFiles = [];
  for (const file of ['SKILL.md', 'UPSTREAM_SKILL.md', 'BUILDER_ADDENDUM.md', 'antom-skill-source.json']) {
    integrationFiles.push(makeFile(`.builder/skills/antom-integration/${file}`,
      await readFile(path.join(integrationRoot, file), 'utf8')));
  }
  integrationFiles.push(makeFile('.builder/skills/antom-integration/UPSTREAM_LICENSE',
    await readFile(path.join(reconRoot, 'UPSTREAM_LICENSE'), 'utf8')));

  return {
    formatVersion: 1,
    package: { name: pkg.name, version: pkg.version },
    skills: [
      {
        id: 'integration', name: 'antom-integration',
        description: 'Antom payment integration with the existing Builder addendum.',
        source: metadata, requirements: [],
        limitations: ['Merchant secrets stay outside Agent chat and the plugin. Test the generated application in sandbox.'],
        files: integrationFiles,
      },
      {
        id: 'reconciliation', name: 'antom-reconciliation-expert',
        description: 'Analyze supplied, authorized and sanitized settlement CSV/XLSX files.',
        source: reconMetadata,
        requirements: ['python', 'openpyxl', 'requests', 'jsonschema'],
        limitations: [
          'Python 3.8+ and the listed Python packages must be available in the Agent execution environment.',
          'Public knowledge/rules may require internet access. Supplied-file analysis is not guaranteed offline.',
          'Online bill retrieval is outside this integration\'s supported scope. Unmodified upstream scripts can use --live with an authenticated Antom CLI.',
          'Builder sandbox settings do not configure CLI profiles or prevent production access; instructions are not runtime isolation.',
          'Only use files you are authorized to process in the chosen Builder runtime. Installation does not upload any bill.',
        ],
        files: reconciliationFiles,
      },
    ],
  };
}

export function createSkillDownloads(bundle) {
  const downloads = {};
  for (const selection of [['integration'], ['reconciliation'], ['integration', 'reconciliation']]) {
    const entries = {};
    for (const skill of bundle.skills.filter((item) => selection.includes(item.id))) {
      for (const file of skill.files) {
        // Fixed timestamp makes the ZIP reproducible across builds and time zones.
        entries[file.path] = [Buffer.from(file.content), { mtime: new Date(2020, 0, 1) }];
      }
    }
    downloads[selection.join(',')] = Buffer.from(zipSync(entries, { level: 9 })).toString('base64');
  }
  return downloads;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundle = await createSkillBundle();
  const downloads = createSkillDownloads(bundle);
  const outputDirectory = path.join(root, '.generated');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'skill-bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
  await writeFile(path.join(outputDirectory, 'skill-downloads.json'), `${JSON.stringify(downloads)}\n`);
  await writeFile(path.join(outputDirectory, 'github-source.json'),
    `${JSON.stringify(createGithubSource(bundle, getBuildRevision(root)), null, 2)}\n`);
  await buildProjectInstaller(root, bundle);
  console.log(`Built ${bundle.skills.length} pinned Skills and ${Object.keys(downloads).length} ZIP selections.`);
}
