import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const GITHUB_REPOSITORY = 'mo-cha-lauren/builder-io-plugin';
export const PAGES_ORIGIN = 'https://mo-cha-lauren.github.io/builder-io-plugin';

export function getBuildRevision(root) {
  let revision = process.env.ANTOM_GITHUB_REVISION;
  if (!revision) {
    try {
      revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  }
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Use a complete Git commit SHA for GitHub distribution.');
  return revision;
}

export function createGithubSource(bundle, revision) {
  if (revision === null) return null;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid GitHub distribution revision.');
  const baseUrl = `${PAGES_ORIGIN}/releases/${revision}/`;
  const manifest = {
    formatVersion: 1, repository: GITHUB_REPOSITORY, revision, package: bundle.package,
    skills: bundle.skills.map((skill) => ({
      id: skill.id, name: skill.name, requirements: skill.requirements,
      files: skill.files.map((file) => ({
        path: file.path,
        url: `${baseUrl}${file.path.replace(/^\.builder\//, '')}`,
        bytes: Buffer.byteLength(file.content, 'utf8'), sha256: file.sha256,
      })),
    })),
  };
  return {
    formatVersion: 1, repository: GITHUB_REPOSITORY, revision, baseUrl, manifest,
    manifestSha256: createHash('sha256').update(`${JSON.stringify(manifest, null, 2)}\n`).digest('hex'),
  };
}
