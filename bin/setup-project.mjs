#!/usr/bin/env node
// This project-local entry must be authorized and its SHA-256 compared with
// the plugin's pinned digest BEFORE execution. Its self-check is not a trust anchor.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PINNED_INSTALLER = null; // build-pinned-runtime
const PACKAGE_NAME = '@antglobal/builder-io-plugin-antom-payment';
const REQUEST_PATH = 'antom.setup.json';
const INSTALLER_DIRECTORY = 'tools/antom-builder';
const ENTRY_PATH = 'bin/setup-project.mjs';
const RUNTIME_FILES = Object.freeze([
  'LEGAL.md', 'LICENSE', 'bin/antom-builder.mjs', ENTRY_PATH,
  'dist/skill-bundle.json', 'lib/project-installer.mjs', 'package.json', 'src/antomSettings.mjs',
]);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RUNTIME_BYTES = 8 * 1024 * 1024;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  throw new Error(message);
}

function exactObject(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    fail('Unsupported setup request fields. Copy a fresh request from the plugin.');
  }
}

function assertPath(filePath) {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let target = parsed.root;
  let entry;
  for (let index = 0; index < segments.length; index += 1) {
    target = path.join(target, segments[index]);
    entry = lstatSync(target);
    if (entry.isSymbolicLink() || (index < segments.length - 1
      ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) {
      fail('Setup requires regular, unlinked files and directories. Nothing was run.');
    }
  }
  return entry;
}

function unchanged(left, right) {
  return right.isFile() && right.nlink === 1 && left.dev === right.dev &&
    left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readSafeBytes(filePath, maximumBytes) {
  const before = assertPath(filePath);
  if (before.size > maximumBytes) fail('A setup input exceeds its size limit. Nothing was run.');
  let descriptor;
  try {
    // Non-blocking open also prevents a concurrent FIFO replacement from hanging.
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const opened = fstatSync(descriptor);
    if (!unchanged(before, opened)) fail('A setup input changed during verification. Nothing was run.');
    const buffer = Buffer.alloc(maximumBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, count, buffer.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count > maximumBytes || count !== opened.size ||
      !unchanged(opened, fstatSync(descriptor)) || !unchanged(opened, assertPath(filePath))) {
      fail('A setup input changed during verification. Nothing was run.');
    }
    return buffer.subarray(0, count);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJson(filePath, maximumBytes) {
  const bytes = readSafeBytes(filePath, maximumBytes);
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) fail('A setup input is not valid UTF-8 JSON. Nothing was run.');
  try {
    return JSON.parse(content);
  } catch {
    fail('A setup input is not valid JSON. Nothing was run.');
  }
}

function validateRequest(request) {
  exactObject(request, ['formatVersion', 'skills', 'installer'], ['config']);
  if (request.formatVersion !== 1 || !Array.isArray(request.skills) || !request.skills.length ||
    request.skills.some((skill) => !['integration', 'reconciliation'].includes(skill)) ||
    new Set(request.skills).size !== request.skills.length) {
    fail('Invalid setup format or Skill selection. Copy a fresh request from the plugin.');
  }
  const manifest = request.installer;
  exactObject(manifest, ['formatVersion', 'name', 'version', 'files']);
  if (manifest.formatVersion !== 1 || manifest.name !== PACKAGE_NAME ||
    typeof manifest.version !== 'string' || manifest.version.length > 128 ||
    !VERSION_PATTERN.test(manifest.version) || !Array.isArray(manifest.files) ||
    manifest.files.length !== RUNTIME_FILES.length) {
    fail('Invalid pinned installer manifest. Copy a fresh request from the plugin.');
  }
  const seen = new Set();
  for (const file of manifest.files) {
    exactObject(file, ['path', 'sha256']);
    if (!RUNTIME_FILES.includes(file.path) || seen.has(file.path) ||
      typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      fail('Invalid pinned installer file list. Copy a fresh request from the plugin.');
    }
    seen.add(file.path);
  }
  if (request.skills.includes('integration')) {
    exactObject(request.config, ['formatVersion', 'settings']);
    const settings = ['authMode', 'clientId', 'antomPublicKey', 'environment', 'keyVersion', 'gatewayOrigin'];
    exactObject(request.config.settings, settings);
    if (request.config.formatVersion !== 2 || settings.some((key) => typeof request.config.settings[key] !== 'string')) {
      fail('Integration setup requires a formatVersion 2 non-secret configuration.');
    }
    // The verified CLI performs all setting-value and RSA-public-key validation
    // before writing. This entry accepts data only, never commands or secrets fields.
  } else if (Object.hasOwn(request, 'config')) {
    fail('Reconciliation-only setup must not include payment configuration.');
  }
}

function assertBuildPinnedManifest(manifest) {
  // The independently verified entry anchors these hashes. Request JSON is
  // mutable project data and must never be allowed to select trusted code.
  const expectedPaths = RUNTIME_FILES.filter((file) => file !== ENTRY_PATH);
  const pinned = PINNED_INSTALLER;
  if (!pinned || pinned.formatVersion !== 1 || pinned.name !== PACKAGE_NAME ||
    !Array.isArray(pinned.files) || pinned.files.length !== expectedPaths.length ||
    new Set(pinned.files.map((file) => file.path)).size !== expectedPaths.length ||
    pinned.files.some((file) => !expectedPaths.includes(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256))) {
    fail('Rebuild the project test installer from its reviewed source before running setup.');
  }
  if (manifest.name !== pinned.name || manifest.version !== pinned.version ||
    pinned.files.some((file) => manifest.files.find((candidate) => candidate.path === file.path)?.sha256 !== file.sha256)) {
    fail('The setup request does not match the build-pinned installer. Nothing was run.');
  }
}

function main() {
  if (process.argv.length !== 2) fail('This fixed setup entry accepts no arguments.');
  if (Number(process.versions.node.split('.')[0]) < 20) fail('Node.js 20 or newer is required.');
  if (!PINNED_INSTALLER) fail('Rebuild the project test installer from its reviewed source before running setup.');
  const root = realpathSync(process.cwd());
  if (root === path.parse(root).root) fail('Run setup in the target application project root.');
  const installerRoot = path.join(root, INSTALLER_DIRECTORY);
  const expectedEntry = path.join(installerRoot, ENTRY_PATH);
  const ownPath = fileURLToPath(import.meta.url);
  if (ownPath !== expectedEntry || realpathSync(ownPath) !== expectedEntry) {
    fail('Run the fixed entry from its target application project root.');
  }
  assertPath(expectedEntry);
  const application = readJson(path.join(root, 'package.json'), MAX_REQUEST_BYTES);
  if (!application || typeof application !== 'object' || Array.isArray(application) || application.name === PACKAGE_NAME) {
    fail('Setup requires a target application, not the plugin repository.');
  }
  const request = readJson(path.join(root, REQUEST_PATH), MAX_REQUEST_BYTES);
  validateRequest(request);
  assertBuildPinnedManifest(request.installer);
  for (const file of request.installer.files) {
    const bytes = readSafeBytes(path.join(installerRoot, file.path), MAX_RUNTIME_BYTES);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      fail('Pinned installer integrity verification failed. Nothing was run.');
    }
  }
  const pkg = readJson(path.join(installerRoot, 'package.json'), MAX_REQUEST_BYTES);
  if (pkg.name !== request.installer.name || pkg.version !== request.installer.version) {
    fail('Pinned installer package identity does not match. Nothing was run.');
  }
  process.stdout.write(`Verified all ${RUNTIME_FILES.length} pinned test installer files.\n`);
  const args = [path.join(installerRoot, 'bin/antom-builder.mjs'), 'setup', '--skills', request.skills.join(',')];
  const integration = request.skills.includes('integration');
  if (integration) args.push('--config-stdin');
  const result = spawnSync(process.execPath, args, {
    cwd: root, input: integration ? JSON.stringify(request.config) : undefined,
    encoding: 'utf8', shell: false, stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.error || result.signal || result.status === null) fail('The verified installer did not complete. Inspect its reported results before retrying.');
  process.exitCode = result.status;
}

try {
  main();
} catch (error) {
  const message = error?.code ? 'Unable to verify setup inputs. Check their presence, permissions, and concurrent writers.' : error?.message || 'Setup verification failed.';
  process.stderr.write(`Antom project setup: ${message}\n`);
  process.exitCode = 1;
}
