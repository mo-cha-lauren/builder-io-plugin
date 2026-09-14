import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
// The YAML parser is already provided by the locked build dependencies.
const { parse } = require('yaml');
const text = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
const workflow = parse(text);

test('Pages only publishes main with isolated build and deployment permissions', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.build.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.deploy.permissions, { pages: 'write', 'id-token': 'write' });
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.if, "github.ref == 'refs/heads/main'");
  }
  assert.equal(workflow.jobs.deploy.needs, 'build');
  assert.equal(workflow.jobs.deploy.environment.name, 'github-pages');
  assert.equal(workflow.concurrency.group, 'github-pages');
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
});

test('Pages gates publication on tests and uploads only allowlisted build output', () => {
  const steps = workflow.jobs.build.steps;
  const run = steps.filter((step) => step.run).map((step) => step.run);
  assert.match(run[0], /git ls-remote --exit-code origin refs\/heads\/main/);
  assert.match(run[0], /"\$current_main" != "\$GITHUB_SHA"/);
  assert.deepEqual(run.slice(1), [
    'npm ci',
    'npm test',
    'npm run test:package',
    'node scripts/build-pages.mjs --revision "$GITHUB_SHA" --output .pages',
  ]);
  const upload = steps.find((step) => step.uses?.startsWith('actions/upload-pages-artifact@'));
  assert.deepEqual(upload.with, { path: '.pages' });
  assert.doesNotMatch(text, /npm publish|NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
});

test('Pages pins official Actions and does not persist checkout credentials', () => {
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const actions = steps.filter((step) => step.uses);
  assert.equal(actions.length, 4);
  for (const step of actions) {
    assert.match(step.uses, /^actions\/(checkout|setup-node|upload-pages-artifact|deploy-pages)@[a-f0-9]{40}$/);
  }
  const checkout = actions.find((step) => step.uses.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(workflow.jobs.deploy.steps.length, 1);
});
