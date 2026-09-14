import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createEnvExample, validateSettingsSnapshot } from '../src/antomSettings.mjs';

const SKILL_DIRECTORIES = Object.freeze({
  integration: 'antom-integration',
  reconciliation: 'antom-reconciliation-expert',
});
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ENV_BYTES = 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW || 0;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function parseSkillSelection(value = 'integration') {
  const skills = Array.isArray(value) ? value : String(value).split(',');
  if (!skills.length || skills.some((id) => !Object.hasOwn(SKILL_DIRECTORIES, id))) {
    throw new Error('Select integration, reconciliation, or integration,reconciliation.');
  }
  return [...new Set(skills)];
}

function validateAssetPath(filePath, skillId) {
  const segments = typeof filePath === 'string' ? filePath.split('/') : [];
  if (
    segments.length < 4 ||
    segments[0] !== '.builder' ||
    segments[1] !== 'skills' ||
    segments[2] !== SKILL_DIRECTORIES[skillId] ||
    segments.some((segment) =>
      !/^[A-Za-z0-9._-]+$/.test(segment) ||
      segment === '.' || segment === '..' || segment.endsWith('.') ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    )
  ) {
    throw new Error('The skill bundle contains an unsafe file path.');
  }
}

export function validateBundle(bundle, selection = ['integration']) {
  const skills = parseSkillSelection(selection);
  if (bundle?.formatVersion !== 1 || !Array.isArray(bundle.skills)) {
    throw new Error('Unsupported skill bundle format.');
  }
  const selected = [];
  const seenPaths = new Set();
  let totalBytes = 0;
  for (const id of skills) {
    const matches = bundle.skills.filter((skill) => skill?.id === id);
    if (matches.length !== 1 || !Array.isArray(matches[0].files) || !matches[0].files.length) {
      throw new Error('The requested skill is missing or duplicated in the bundle.');
    }
    const skill = matches[0];
    for (const file of skill.files) {
      validateAssetPath(file?.path, id);
      if (typeof file.content !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) {
        throw new Error('The skill bundle contains an invalid file record.');
      }
      const bytes = Buffer.byteLength(file.content, 'utf8');
      totalBytes += bytes;
      if (bytes > MAX_FILE_BYTES || totalBytes > MAX_BUNDLE_BYTES) {
        throw new Error('The skill bundle exceeds the supported size limit.');
      }
      if (sha256(file.content) !== file.sha256) {
        throw new Error('Skill bundle integrity validation failed. No files were installed.');
      }
      const portablePath = file.path.toLowerCase();
      if (seenPaths.has(portablePath)) {
        throw new Error('The skill bundle contains duplicate file paths.');
      }
      seenPaths.add(portablePath);
    }
    if (!skill.files.some((file) => file.path === `.builder/skills/${SKILL_DIRECTORIES[id]}/SKILL.md`)) {
      throw new Error('The skill bundle is missing SKILL.md.');
    }
    selected.push(skill);
  }
  for (const filePath of seenPaths) {
    const segments = filePath.split('/');
    while (segments.pop() && segments.length) {
      if (seenPaths.has(segments.join('/'))) {
        throw new Error('A skill bundle file conflicts with a directory path.');
      }
    }
  }
  return selected;
}

async function statOrMissing(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Unable to inspect the requested file path.');
  }
}

// Do not resolve symlinks silently: an installer must not write through a link
// to another project or secret directory. Callers can supply the real path.
async function assertSafePath(filePath, { allowMissing = false, leaf = 'file', allowHardlinks = false } = {}) {
  const absolutePath = path.resolve(filePath);
  const parsed = path.parse(absolutePath);
  const segments = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = await statOrMissing(current);
    if (!stat) {
      if (allowMissing) return null;
      throw new Error('The requested file or project directory does not exist.');
    }
    if (stat.isSymbolicLink()) {
      throw new Error('Symbolic links are not supported. Use a real project/file path.');
    }
    const isLeaf = index === segments.length - 1;
    if (!isLeaf || leaf === 'directory') {
      if (!stat.isDirectory()) throw new Error('A required directory is not a directory.');
    } else if (!stat.isFile() || (!allowHardlinks && stat.nlink !== 1)) {
      throw new Error('Only regular files without hard links are supported.');
    }
  }
  return statOrMissing(absolutePath);
}

async function resolveProject(projectPath) {
  const project = path.resolve(projectPath || process.cwd());
  await assertSafePath(project, { leaf: 'directory' });
  if (project === path.parse(project).root) {
    throw new Error('A filesystem root cannot be used as a project.');
  }
  return project;
}

function sameFile(left, right, allowHardlinks = false) {
  return left && right && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && (allowHardlinks || right.nlink === 1);
}

async function readSafeFile(filePath, maximumBytes, { allowHardlinks = false } = {}) {
  const before = await assertSafePath(filePath, { allowHardlinks });
  if (before.size > maximumBytes) throw new Error('The input file exceeds the supported size limit.');
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW);
    const opened = await handle.stat();
    if (!sameFile(before, opened, allowHardlinks)) throw new Error('The file changed during validation. Retry after other writers stop.');
    const bytes = await handle.readFile();
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) {
      throw new Error('The file is not valid UTF-8 text.');
    }
    if (bytes.length > maximumBytes || !sameFile(opened, await handle.stat(), allowHardlinks)) {
      throw new Error('The file changed during validation. Retry after other writers stop.');
    }
    return { content, stat: opened };
  } finally {
    await handle?.close();
  }
}

export async function loadSkillBundle(bundlePath) {
  // npm may itself be installed under a symlink. Resolve this trusted package
  // location only; never do so for a user-selected project or config file.
  const canonicalPath = await realpath(bundlePath);
  const { content } = await readSafeFile(canonicalPath, MAX_BUNDLE_BYTES, { allowHardlinks: true });
  try {
    return JSON.parse(content);
  } catch {
    throw new Error('The packaged skill bundle is not valid JSON.');
  }
}

async function inspectFiles(project, selected) {
  const results = [];
  for (const skill of selected) {
    for (const file of skill.files) {
      const target = path.join(project, ...file.path.split('/'));
      const stat = await assertSafePath(target, { allowMissing: true });
      if (!stat) {
        results.push({ ...file, status: 'missing' });
      } else {
        const { content } = await readSafeFile(target, MAX_FILE_BYTES);
        results.push({ ...file, status: sha256(content) === file.sha256 ? 'ok' : 'modified' });
      }
    }
  }
  return results;
}

async function createParentDirectories(project, relativePath) {
  const directories = relativePath.split('/').slice(0, -1);
  let current = project;
  for (const directory of directories) {
    await assertSafePath(current, { leaf: 'directory' });
    current = path.join(current, directory);
    if (!(await assertSafePath(current, { allowMissing: true, leaf: 'directory' }))) {
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    await assertSafePath(current, { leaf: 'directory' });
  }
}

export async function installSkills({ bundle, projectPath, skills = ['integration'], dryRun = false }) {
  const selected = validateBundle(bundle, skills);
  const project = await resolveProject(projectPath);
  const inspected = await inspectFiles(project, selected);
  const conflicts = inspected.filter((file) => file.status === 'modified');
  if (conflicts.length) {
    throw new Error(`Installation stopped: ${conflicts.length} existing skill file(s) differ. No files were written. Back up and reconcile them manually.`);
  }
  const missing = inspected.filter((file) => file.status === 'missing');
  const written = [];
  if (!dryRun) {
    for (const file of missing) {
      await createParentDirectories(project, file.path);
      const target = path.join(project, ...file.path.split('/'));
      if (await assertSafePath(target, { allowMissing: true })) {
        throw new Error('A target appeared during installation. Nothing was overwritten; rerun the check command.');
      }
      let handle;
      try {
        handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o644);
        if (!sameFile(await assertSafePath(target), await handle.stat())) {
          throw new Error('The target changed during installation. Stop concurrent filesystem changes and retry.');
        }
        await handle.writeFile(file.content, 'utf8');
        written.push(file.path);
      } finally {
        await handle?.close();
      }
    }
  }
  return {
    projectPath: project,
    skills: selected.map((skill) => skill.id),
    written,
    planned: missing.map((file) => file.path),
    skipped: inspected.filter((file) => file.status === 'ok').map((file) => file.path),
    dryRun,
  };
}

function runProbe(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024,
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: !result.error && result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const PYTHON_MODULES = Object.freeze(['openpyxl', 'requests', 'jsonschema']);
const PYTHON_DISCOVERY = [
  'import importlib.util, json',
  `names = ${JSON.stringify(PYTHON_MODULES)}`,
  'print(json.dumps({name: importlib.util.find_spec(name) is not None for name in names}))',
].join('\n');

function discoverPython(runCommand) {
  for (const command of ['python3', 'python']) {
    const result = runCommand(command, ['--version']);
    const match = result.ok && `${result.stdout}\n${result.stderr}`.match(/\bPython (\d+)\.(\d+)\.(\d+)\b/);
    if (!match || !(Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 8))) continue;
    // Isolated mode excludes the project working directory, PYTHONPATH, and
    // user site packages. Top-level find_spec does not import these packages.
    // Use a trusted project virtual environment to make dependencies visible.
    const discovery = runCommand(command, ['-I', '-c', PYTHON_DISCOVERY]);
    let modules = null;
    try {
      const parsed = discovery.ok && JSON.parse(discovery.stdout);
      if (parsed && PYTHON_MODULES.every((id) => typeof parsed[id] === 'boolean')) modules = parsed;
    } catch {
      // Never print arbitrary interpreter/startup output or assume readiness.
    }
    return { command, version: match.slice(1).join('.'), modules };
  }
  return null;
}

export function probeRequirements(requirements, { runCommand = runProbe } = {}) {
  const python = requirements.some((id) => id === 'python' || PYTHON_MODULES.includes(id)) ? discoverPython(runCommand) : null;
  const results = [];
  for (const id of new Set(requirements)) {
    if (id === 'python') {
      results.push({ id, status: python ? 'available' : 'missing', detail: python ? `Python ${python.version} (${python.command}; isolated environment).` : 'Python 3.8+ is required in the Agent runtime.' });
    } else if (PYTHON_MODULES.includes(id)) {
      const discovered = python?.modules?.[id];
      const status = typeof discovered === 'boolean' ? (discovered ? 'available' : 'missing') : 'unverified';
      const detail = status === 'available'
        ? 'Top-level module found in the isolated Python environment; package execution was not tested.'
        : status === 'missing'
          ? 'Not found in the isolated Python environment. Prepare dependencies in the project virtual environment and check again.'
          : 'Python module discovery did not complete. This prerequisite is not verified.';
      results.push({ id, status, detail });
    } else if (id === 'antom-cli') {
      const result = runCommand('antom', ['--version']);
      results.push({ id, status: result.ok ? 'available' : 'missing', detail: result.ok ? 'Version command succeeded; merchant authentication was not checked.' : 'Install the official Antom CLI separately when online operations are needed.' });
    } else {
      results.push({ id, status: 'unverified', detail: 'Not installed or imported by this check. Verify this dependency in the Agent runtime.' });
    }
  }
  return results;
}

export async function checkSkills({ bundle, projectPath, skills = ['integration'], probe = probeRequirements }) {
  const selected = validateBundle(bundle, skills);
  const project = await resolveProject(projectPath);
  const inspected = await inspectFiles(project, selected);
  const requirements = probe(selected.flatMap((skill) => skill.requirements || []));
  const filesOk = inspected.every((file) => file.status === 'ok');
  const runtimeReady = requirements.every((item) => item.status === 'available');
  return {
    projectPath: project,
    files: inspected.map(({ path: filePath, status }) => ({ path: filePath, status })),
    requirements,
    limitations: [...new Set(selected.flatMap((skill) => skill.limitations || []))],
    filesOk,
    runtimeReady,
    ok: filesOk && runtimeReady,
  };
}

function assertExactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error('The configuration contains unsupported fields. Export it again from the plugin.');
  }
}

export async function validateConfigDocument(document) {
  assertExactKeys(document, ['formatVersion', 'settings']);
  if (![1, 2].includes(document.formatVersion)) throw new Error('Unsupported configuration format.');
  const allowed = ['clientId', 'antomPublicKey', 'environment', 'keyVersion', 'gatewayOrigin'];
  // Version 1 exports predate authentication selection and must remain RSA.
  // Do not accept a mode on v1: an older consumer could otherwise ignore it.
  if (document.formatVersion === 2) allowed.push('authMode');
  assertExactKeys(document.settings, allowed);
  if (allowed.some((key) => typeof document.settings[key] !== 'string')) {
    throw new Error('The configuration must contain every supported text setting for its format version.');
  }
  if (document.formatVersion === 2 && !['rsa', 'api_key'].includes(document.settings.authMode)) {
    throw new Error('Authentication mode must be rsa or api_key.');
  }
  return validateSettingsSnapshot({ ...document.settings, authMode: document.formatVersion === 1 ? 'rsa' : document.settings.authMode }, { cryptoObject: webcrypto });
}

// Group multiline quoted dotenv values so resetting existing private-key or
// API-key examples never leaves their continuation lines behind. Never evaluate dotenv.
function readAssignment(lines, start) {
  const match = lines[start].match(/^([^\S\r\n]*(?:export[^\S\r\n]+)?)([A-Za-z_][A-Za-z0-9_]*)([^\S\r\n]*=[^\S\r\n]*)(.*)$/);
  if (!match) return null;
  const value = match[4];
  const quote = ['"', "'", '`'].includes(value[0]) ? value[0] : '';
  if (!quote) {
    const commentMatch = value.match(/([ \t]*#.*)$/)?.[1] || '';
    const comment = commentMatch.startsWith('#') ? ` ${commentMatch}` : commentMatch;
    return { key: match[2], prefix: match[1], end: start, comment, value: value.slice(0, value.length - commentMatch.length).trim() };
  }
  let escaped = false;
  for (let row = start; row < lines.length; row += 1) {
    const text = row === start ? value : lines[row];
    for (let index = row === start ? 1 : 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === quote && !escaped) {
        const suffix = text.slice(index + 1);
        if (suffix.trim() && !/^[ \t]*#/.test(suffix)) {
          throw new Error('The existing .env.example has a malformed quoted value. Correct it manually first.');
        }
        const rawValue = row === start
          ? value.slice(1, index)
          : [value.slice(1), ...lines.slice(start + 1, row), text.slice(0, index)].join('\n');
        // Match dotenv's double-quoted newline escapes without evaluating
        // interpolation, shell syntax, or JavaScript expressions.
        const decoded = quote === '"' ? rawValue.replace(/\\n/g, '\n').replace(/\\r/g, '\r') : rawValue;
        return { key: match[2], prefix: match[1], end: row, comment: suffix.includes('#') ? suffix : '', value: decoded };
      }
      escaped = character === '\\' && !escaped;
    }
    escaped = false;
  }
  throw new Error('The existing .env.example has an unterminated quoted value. Correct it manually first.');
}

const CONFIG_ENV_KEYS = Object.freeze({
  ANTOM_AUTH_MODE: 'authMode',
  ANTOM_CLIENT_ID: 'clientId',
  ANTOM_PUBLIC_KEY: 'antomPublicKey',
  ANTOM_ENVIRONMENT: 'environment',
  ANTOM_KEY_VERSION: 'keyVersion',
  ANTOM_GATEWAY_ORIGIN: 'gatewayOrigin',
});

function assertNoConfigConflicts(existing, settings) {
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  const conflicts = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const assignment = readAssignment(lines, index);
    if (!assignment) continue;
    index = assignment.end;
    const setting = Object.hasOwn(CONFIG_ENV_KEYS, assignment.key) ? CONFIG_ENV_KEYS[assignment.key] : null;
    const secret = ['ANTOM_API_KEY', 'ANTOM_MERCHANT_PRIVATE_KEY'].includes(assignment.key);
    if (assignment.value !== '' && (secret || (setting && assignment.value !== settings[setting]))) conflicts.add(assignment.key);
  }
  if (conflicts.size) {
    throw new Error(`Setup stopped: conflicting non-empty .env.example settings: ${[...conflicts].join(', ')}. No files were written. Reconcile these keys manually.`);
  }
}

export function mergeEnvExample(existing, settings) {
  if (existing.includes('\0')) throw new Error('The existing .env.example is not a supported text file.');
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const replacements = new Map(createEnvExample(settings).split('\n').map((line) => [line.slice(0, line.indexOf('=')), line]));
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const seen = new Set();
  const merged = [];
  for (let index = 0; index < lines.length; index += 1) {
    const assignment = readAssignment(lines, index);
    if (!assignment) {
      merged.push(lines[index]);
      continue;
    }
    const original = lines.slice(index, assignment.end + 1);
    index = assignment.end;
    if (!replacements.has(assignment.key)) {
      merged.push(...original);
      continue;
    }
    seen.add(assignment.key);
    // Currency is project-specific, not a setting supplied by the plugin.
    if (assignment.key === 'ANTOM_DEFAULT_CURRENCY') merged.push(...original);
    else merged.push(`${assignment.prefix}${replacements.get(assignment.key)}${assignment.comment}`);
  }
  for (const [key, line] of replacements) {
    if (!seen.has(key)) merged.push(line);
  }
  const result = `${merged.join(eol)}${eol}`;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(result)) {
    throw new Error('The existing .env.example contains a private-key block outside the managed setting. Remove it manually before continuing.');
  }
  return result;
}

export async function applyProjectConfig({ filePath, projectPath }) {
  const configPath = path.resolve(filePath || '');
  if (!filePath || !/\.json$/i.test(path.basename(configPath)) || /^\.env(?:\.|$)/i.test(path.basename(configPath))) {
    throw new Error('Use the exported configuration .json file, never an environment or secret file.');
  }
  const { content } = await readSafeFile(configPath, MAX_CONFIG_BYTES);
  let document;
  try {
    document = JSON.parse(content);
  } catch {
    throw new Error('The configuration file is not valid JSON.');
  }
  const settings = await validateConfigDocument(document);
  const project = await resolveProject(projectPath);
  const plan = await planProjectConfig(project, settings);
  return writeProjectConfig(plan);
}

async function planProjectConfig(project, settings, { refuseConflicts = false } = {}) {
  const target = path.join(project, '.env.example');
  const originalStat = await assertSafePath(target, { allowMissing: true });
  const original = originalStat ? await readSafeFile(target, MAX_ENV_BYTES) : { content: '', stat: null };
  if (refuseConflicts) assertNoConfigConflicts(original.content, settings);
  const merged = mergeEnvExample(original.content, settings);
  return { project, target, original, merged };
}

async function assertConfigUnchanged({ project, target, original }) {
  await assertSafePath(project, { leaf: 'directory' });
  const stat = await assertSafePath(target, { allowMissing: true });
  if (!original.stat && !stat) return;
  if (original.stat && stat) {
    const current = await readSafeFile(target, MAX_ENV_BYTES);
    if (sameFile(original.stat, current.stat) && original.content === current.content) return;
  }
  throw new Error('.env.example changed during configuration. Nothing was overwritten; retry after other writers stop.');
}

async function writeProjectConfig(plan) {
  const { project, target, original, merged } = plan;
  await assertConfigUnchanged(plan);
  if (merged === original.content) return { changed: false, file: '.env.example' };
  if (!original.stat) {
    let handle;
    try {
      handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
      if (!sameFile(await assertSafePath(target), await handle.stat())) {
        throw new Error('The target changed during configuration. Stop concurrent filesystem changes and retry.');
      }
      await handle.writeFile(merged, 'utf8');
    } finally {
      await handle?.close();
    }
  } else {
    const temporary = path.join(project, `.antom-env-example-${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, original.stat.mode & 0o777);
      temporaryCreated = true;
      try {
        await handle.writeFile(merged, 'utf8');
      } finally {
        await handle.close();
      }
      await assertConfigUnchanged(plan);
      await rename(temporary, target);
      temporaryCreated = false;
    } finally {
      if (temporaryCreated) await unlink(temporary).catch(() => {});
    }
  }
  return { changed: true, file: '.env.example' };
}

export async function setupProject({
  bundle, projectPath, skills = ['integration'], configDocument, dryRun = false, probe = probeRequirements,
}) {
  const selection = parseSkillSelection(skills);
  let settings;
  if (selection.includes('integration')) {
    if (configDocument?.formatVersion !== 2) {
      throw new Error('Integration setup requires a formatVersion 2 configuration from --config-stdin.');
    }
    settings = await validateConfigDocument(configDocument);
  } else if (configDocument !== undefined) {
    throw new Error('Reconciliation-only setup does not accept payment configuration. Omit --config-stdin.');
  }

  // All three preflights finish before the first directory or file is created.
  // Installation repeats its safe-path/hash checks at the write boundary.
  const installationPlan = await installSkills({ bundle, projectPath, skills: selection, dryRun: true });
  const configPlan = settings
    ? await planProjectConfig(installationPlan.projectPath, settings, { refuseConflicts: true })
    : null;
  if (configPlan) await assertConfigUnchanged(configPlan);

  let installation = installationPlan;
  let configuration = configPlan
    ? { file: '.env.example', changed: false, planned: configPlan.merged !== configPlan.original.content }
    : null;
  if (!dryRun) {
    try {
      installation = await installSkills({ bundle, projectPath, skills: selection });
      if (configPlan) configuration = { ...await writeProjectConfig(configPlan), planned: configuration.planned };
    } catch {
      // We intentionally do not promise rollback: exclusive creation may have
      // installed some files before a concurrent change or I/O failure.
      throw new Error('Setup stopped during writing. Some skill files or .env.example may already have been installed or updated. Check the project before retrying; changes were not rolled back.');
    }
  }
  let check;
  try {
    check = await checkSkills({ bundle, projectPath, skills: selection, probe });
  } catch {
    throw new Error(dryRun
      ? 'Setup dry run could not complete verification. No files were written.'
      : 'Setup files may already have been installed or updated, but verification failed. Check the project before retrying; changes were not rolled back.');
  }
  return { installation, configuration, check, dryRun, ok: dryRun ? check.runtimeReady : check.ok };
}
