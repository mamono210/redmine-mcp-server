import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyWiki } from './wiki.mjs';
import { collectFailureDiagnostics } from './diagnostics.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const project = `redmine-mcp-it-${randomUUID().slice(0, 12)}`;
const output = join(root, 'integration-results', project);
const compose = ['compose', '--project-name', project, '--file', join(root, 'integration/compose.yml')];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('REDMINE_') && !key.startsWith('COMPOSE_')));
env.COMPOSE_DISABLE_ENV_FILE = '1';
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => abort.abort(new Error(`Interrupted by ${signal}`)));
}
const report = {
  started_at: new Date().toISOString(), result: 'in_progress', project,
  ci: process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true',
  ci_provider: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : null,
  // Record only public run identifiers, never the environment or credentials.
  github: process.env.GITHUB_ACTIONS === 'true' ? {
    repository: process.env.GITHUB_REPOSITORY,
    run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    event_name: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
  } : null,
  commands: [], calls: [],
  cleanup_command: ['docker', ...compose, 'down', '--volumes', '--remove-orphans'],
};
let secrets = [];
let temporary;
let started = false;
let stage = 'preflight';
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
const save = (name, value) => writeFile(join(output, name), redact(
  typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'), { mode: 0o600 });

async function command(program, args, { log, cleanup = false, includeStderr = false, timeout = 120000 } = {}) {
  const item = { command: [program, ...args], started_at: new Date().toISOString() };
  report.commands.push(item);
  try {
    const result = await execute(program, args, {
      cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      timeout, signal: cleanup ? undefined : abort.signal,
    });
    item.exit_code = 0;
    if (log) await save(log, result.stdout + result.stderr);
    return (result.stdout + (includeStderr ? result.stderr : '')).trim();
  } catch (error) {
    item.exit_code = error.code ?? null;
    if (log) await save(log, (error.stdout ?? '') + (error.stderr ?? ''));
    // Do not print arbitrary subprocess output, especially from initialization.
    throw new Error(`${program} ${args.join(' ')} failed (${error.code ?? error.name})`);
  } finally {
    item.finished_at = new Date().toISOString();
  }
}
const docker = (args, options) => command('docker', [...compose, ...args], options);

await mkdir(output, { recursive: true, mode: 0o700 });
// Retain the exact recovery command even if the process is forcibly killed.
await save('result.json', report);
try {
  const expectedNode = (await readFile(join(root, '.node-version'), 'utf8')).trim();
  assert.equal(process.versions.node, expectedNode, 'Use the repository .node-version');
  report.node_version = process.versions.node;
  report.pnpm_version = await command('pnpm', ['--version']);
  assert.equal(report.pnpm_version, '10.20.0');
  report.docker_version = await command('docker', ['info', '--format', '{{json .ServerVersion}}']);
  report.compose_version = await command('docker', ['compose', 'version', '--short']);
  report.mcp_commit = await command('git', ['rev-parse', 'HEAD']);
  report.mcp_worktree_status = await command('git', ['status', '--porcelain']);
  report.mcp_version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;

  stage = 'mcp_build';
  console.log('Building the current MCP source...');
  await command('pnpm', ['build'], { log: 'mcp-build.log', timeout: 300000 });
  await command('pnpm', ['typecheck'], { log: 'mcp-typecheck.log', timeout: 120000 });
  report.mcp_artifact_sha256 = createHash('sha256').update(await readFile(join(root, 'dist/server.mjs'))).digest('hex');
  report.pnpm_lock_sha256 = createHash('sha256').update(await readFile(join(root, 'pnpm-lock.yaml'))).digest('hex');
  const configuration = JSON.parse(await docker(['config', '--format', 'json']));
  const dockerfile = await readFile(join(root, 'integration/redmine/Dockerfile'), 'utf8');
  report.ruby_image_reference = dockerfile.match(/^FROM (\S+)$/m)[1];
  report.database_image_reference = configuration.services.db.image;

  stage = 'redmine_build';
  console.log('Building the pinned Redmine source (first build can take several minutes)...');
  await docker(['build', 'redmine'], { log: 'redmine-build.log', timeout: 1200000 });
  started = true;
  stage = 'redmine_startup';
  console.log('Starting PostgreSQL and waiting for the Redmine HTTP health check...');
  await docker(['up', '--detach', '--wait', '--wait-timeout', '300', 'db', 'redmine'], {
    log: 'compose-up.log', timeout: 360000,
  });
  stage = 'environment_inspection';
  for (const service of ['db', 'redmine']) {
    const id = await docker(['ps', '--quiet', service]);
    assert.match(id, /^[a-f0-9]+$/);
    const imageId = await command('docker', ['inspect', '--format', '{{.Image}}', id]);
    const image = JSON.parse(await command('docker', ['image', 'inspect', '--format',
      '{"id":{{json .Id}},"repo_digests":{{json .RepoDigests}},"os":{{json .Os}},"architecture":{{json .Architecture}}}', imageId]));
    report[`${service}_image`] = image;
  }
  const port = await docker(['port', 'redmine', '3000']);
  assert.match(port, /^127\.0\.0\.1:\d+$/);
  const url = `http://${port}`;
  report.redmine_url = url;

  stage = 'fixture_initialization';
  console.log('Initializing the isolated project and non-admin users...');
  await docker(['exec', '-T', 'redmine', '/opt/integration/entrypoint.sh', 'seed']);
  temporary = await mkdtemp(join(tmpdir(), `${project}-`));
  await chmod(temporary, 0o700);
  const credentialPath = join(temporary, 'credentials.json');
  await docker(['cp', 'redmine:/tmp/mcp-integration-credentials.json', credentialPath]);
  await chmod(credentialPath, 0o600);
  const credentials = JSON.parse(await readFile(credentialPath, 'utf8'));
  secrets = Object.values(credentials);
  assert.equal(secrets.length, 2);
  for (const secret of secrets) assert.match(secret, /^[a-f0-9]{40}$/);
  const manifestPath = join(temporary, 'manifest.json');
  await docker(['cp', 'redmine:/tmp/mcp-integration-manifest.json', manifestPath]);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  report.environment = manifest;
  assert.equal(manifest.redmine_commit, 'f7ea71f9563ea7b346a8dbc7abb3854fc69321ea');
  assert.equal(manifest.redmine_version, '7.0.2.devel');
  assert.equal(manifest.rails_version, '8.1.4');
  assert.match(manifest.database_version, /^17\.6(?:\s|$)/);
  assert.equal(manifest.rest_api_enabled, true);
  assert.deepEqual(manifest.project.modules, ['wiki']);
  await docker(['cp', 'redmine:/redmine/Gemfile.lock', join(output, 'Gemfile.lock')]);

  stage = 'wiki_tests';
  console.log('Testing Wiki create, update and readback for both users...');
  await verifyWiki({
    entry: join(root, 'dist/server.mjs'), url, manifest, credentials,
    record: call => report.calls.push(call),
  });
  abort.signal.throwIfAborted();
  assert.equal(report.calls.length, 16);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.failed_stage = stage;
  report.error = redact(error.message);
} finally {
  if (started) {
    if (report.result === 'failed') {
      console.log('Collecting failure diagnostics before container cleanup...');
      try {
        report.diagnostics = await collectFailureDiagnostics({
          docker, command, save, startupLogs: stage === 'redmine_startup',
        });
      } catch {
        // Diagnostic failures must not replace the original error or skip cleanup.
        report.diagnostics = { errors: ['Failure diagnostics could not be collected'] };
      }
    }
    try {
      console.log('Removing this run\'s containers, network and database volume...');
      await docker(['down', '--volumes', '--remove-orphans'], { cleanup: true, log: 'cleanup.log' });
      report.cleanup = 'passed';
    } catch (error) {
      report.cleanup = 'failed';
      report.cleanup_error = redact(error.message);
      report.result = 'failed';
    }
  } else {
    report.cleanup = 'not_started';
  }
  if (temporary) {
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch {
      report.cleanup = 'failed';
      report.cleanup_error = `Could not remove private temporary directory: ${temporary}`;
      report.result = 'failed';
    }
  }
  report.finished_at = new Date().toISOString();
  await save('result.json', report);
}
console.log(`Integration ${report.result}: ${join(output, 'result.json')}`);
if (report.error) console.error(report.error);
if (report.cleanup_error) console.error(report.cleanup_error);
process.exitCode = report.result === 'passed' ? 0 : 1;
