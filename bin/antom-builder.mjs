#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import {
  applyProjectConfig, checkSkills, installSkills, loadSkillBundle, parseSkillSelection, setupProject,
} from '../lib/project-installer.mjs';

const USAGE = `Antom project setup (Node.js 20+)

  antom-builder setup --skills integration[,reconciliation] --config-stdin [--project path] [--dry-run]
  antom-builder setup --skills reconciliation [--project path] [--dry-run]
  antom-builder install [--skills integration,reconciliation] [--project path] [--dry-run]
  antom-builder check [--skills integration,reconciliation] [--project path]
  antom-builder config --file antom.config.json [--project path]

The default selection is integration and the default project is the current directory.
Install never overwrites existing files. Config only updates .env.example.
Setup accepts a formatVersion 2 non-secret JSON document on stdin (64 KiB maximum).
Reconciliation-only setup does not read or update payment configuration.
No dependencies, credentials, payments, or Git operations are run automatically.
`;

function parseArguments(argv) {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) return { help: true };
  const [command, ...args] = argv;
  const allowed = {
    setup: ['--skills', '--config-stdin', '--project', '--dry-run'],
    install: ['--skills', '--project', '--dry-run'],
    check: ['--skills', '--project'],
    config: ['--file', '--project'],
  }[command];
  if (!allowed) throw new Error('Unknown command. Run antom-builder --help.');
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!allowed.includes(option) || Object.hasOwn(values, option)) {
      throw new Error('Unsupported or duplicate option. Run antom-builder --help.');
    }
    if (option === '--dry-run' || option === '--config-stdin') values[option] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('An option value is missing. Run antom-builder --help.');
      values[option] = value;
    }
  }
  if (command === 'config' && !values['--file']) throw new Error('Config requires --file with an exported .json configuration.');
  const skills = parseSkillSelection(values['--skills']);
  if (command === 'setup') {
    if (skills.includes('integration') && !values['--config-stdin']) {
      throw new Error('Integration setup requires --config-stdin with a formatVersion 2 non-secret JSON document.');
    }
    if (!skills.includes('integration') && values['--config-stdin']) {
      throw new Error('Reconciliation-only setup does not accept payment configuration. Omit --config-stdin.');
    }
  }
  return {
    command, projectPath: values['--project'], filePath: values['--file'],
    skills, dryRun: Boolean(values['--dry-run']), configStdin: Boolean(values['--config-stdin']),
  };
}

async function readConfigurationStdin() {
  if (process.stdin.isTTY) throw new Error('--config-stdin requires piped JSON or a heredoc; interactive input is not supported.');
  const bytes = await new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      process.stdin.pause();
    };
    const fail = (message) => {
      cleanup();
      process.stdin.destroy();
      reject(new Error(message));
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > 64 * 1024) return fail('The stdin configuration exceeds the 64 KiB size limit.');
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = () => fail('Unable to read the stdin configuration.');
    const timer = setTimeout(() => fail('Timed out waiting for stdin configuration. Supply one complete JSON document using a pipe or heredoc.'), 2000);
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    if (process.stdin.readableEnded || process.stdin.destroyed) onEnd();
  });
  const content = bytes.toString('utf8');
  if (!content.trim()) throw new Error('The stdin configuration is empty. Supply one complete JSON document.');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error('The stdin configuration is not valid UTF-8 text.');
  try {
    return JSON.parse(content);
  } catch {
    throw new Error('The stdin configuration is not valid JSON.');
  }
}

function printCheck(result) {
  for (const file of result.files) process.stdout.write(`${file.status}: ${file.path}\n`);
  for (const item of result.requirements) process.stdout.write(`${item.status}: ${item.id} — ${item.detail}\n`);
  for (const limitation of result.limitations) process.stdout.write(`Limitation: ${limitation}\n`);
  process.stdout.write(`Files: ${result.filesOk ? 'complete' : 'incomplete or modified'}; runtime prerequisites: ${result.runtimeReady ? 'discovered' : 'missing or unverified'}.\n`);
  process.stdout.write('Checks only the environment where this command ran; no other runtime or merchant authentication is verified.\n');
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.');
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.command === 'config') {
    const result = await applyProjectConfig(options);
    process.stdout.write(result.changed ? 'Updated .env.example only. Configure real secrets manually on your server.\n' : '.env.example is already up to date.\n');
    return;
  }
  const configDocument = options.configStdin ? await readConfigurationStdin() : undefined;
  const bundle = await loadSkillBundle(fileURLToPath(new URL('../dist/skill-bundle.json', import.meta.url)));
  if (options.command === 'setup') {
    const result = await setupProject({ ...options, bundle, configDocument });
    process.stdout.write(options.dryRun
      ? `Dry run: ${result.installation.planned.length} skill file(s) would be created; ${result.installation.skipped.length} identical file(s) skipped. No files were written.\n`
      : `Installed ${result.installation.written.length} skill file(s); skipped ${result.installation.skipped.length} identical file(s).\n`);
    if (result.configuration) process.stdout.write(options.dryRun
      ? `.env.example: ${result.configuration.planned ? 'would be updated' : 'already up to date'}.\n`
      : `.env.example: ${result.configuration.changed ? 'updated' : 'already up to date'}.\n`);
    printCheck(result.check);
    process.stdout.write('Setup does not verify a payment, reconciliation result, or merchant authentication.\n');
    if (!result.ok) process.exitCode = 1;
  } else if (options.command === 'install') {
    const result = await installSkills({ ...options, bundle });
    process.stdout.write(options.dryRun
      ? `Dry run: ${result.planned.length} file(s) would be created; ${result.skipped.length} identical file(s) skipped.\n`
      : `Installed ${result.written.length} file(s); skipped ${result.skipped.length} identical file(s).\n`);
    if (options.dryRun) {
      for (const file of result.planned) process.stdout.write(`create: ${file}\n`);
      for (const file of result.skipped) process.stdout.write(`skip identical: ${file}\n`);
    }
    if (!options.dryRun) process.stdout.write('Sync these project files to the repository used by Builder, then start a new Agent session. Installation does not verify payment or reconciliation results.\n');
  } else {
    const result = await checkSkills({ ...options, bundle });
    printCheck(result);
    if (!result.ok) process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  // Node filesystem errors include user-selected paths. Do not print them,
  // stacks, config contents, command output, or credential values.
  const message = error?.code ? 'A filesystem operation failed. Check paths, permissions, and concurrent writers.' : error?.message || 'Setup failed.';
  process.stderr.write(`Antom setup: ${message}\n`);
  process.exitCode = 1;
}
