import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFailureDiagnostics, sanitizeStartupLog } from '../integration/diagnostics.mjs';

test('startup diagnostics retain errors and remove credential material', () => {
  const sensitive = ['example-password', 'example-token', 'example-cookie', 'example-key',
    'example-secret', 'url-password', 'private-body', 'a'.repeat(128)];
  const raw = [
    '[redmine-startup] stage=db_migrate', 'rake aborted! Connection refused',
    'password: example-password', 'Authorization: Bearer example-token',
    'Cookie: example-cookie', 'X-Redmine-API-Key: example-key',
    'SECRET_KEY_BASE=example-secret', 'postgres://user:url-password@db/test',
    '-----BEGIN PRIVATE KEY-----', 'private-body', '-----END PRIVATE KEY-----',
    'a'.repeat(128), '\u001b[31mRuntimeError: boot failed\u001b[0m',
  ].join('\n');
  const sanitized = sanitizeStartupLog(raw);
  for (const value of sensitive) assert.ok(!sanitized.includes(value));
  assert.match(sanitized, /stage=db_migrate/);
  assert.match(sanitized, /rake aborted! Connection refused/);
  assert.match(sanitized, /RuntimeError: boot failed/);
  assert.ok(!sanitized.includes('\u001b'));
});

function fixture({ startupLogs = true, failLogs = false, failInspect = false } = {}) {
  const calls = [];
  const saved = new Map();
  const options = {
    startupLogs,
    docker: async (args, settings) => {
      calls.push(args);
      assert.equal(settings.cleanup, true);
      assert.equal(settings.timeout, 15000);
      if (args[0] === 'logs') {
        assert.equal(settings.includeStderr, true);
        if (failLogs) throw new Error('password=do-not-persist');
        return 'stage=db_migrate\nRuntimeError: boot failed\npassword=do-not-persist';
      }
      assert.deepEqual(args.slice(0, 3), ['ps', '--all', '--quiet']);
      return args[3] === 'db' ? 'abc123' : 'def456';
    },
    command: async (program, args) => {
      assert.equal(program, 'docker');
      assert.equal(args[0], 'inspect');
      assert.ok(!args[2].includes('Config'));
      if (failInspect) throw new Error('token=do-not-persist');
      return JSON.stringify({ status: 'exited', exit_code: 1, oom_killed: false,
        error: 'secret=do-not-persist', started_at: 'start', finished_at: 'end', health: 'unhealthy' });
    },
    save: async (name, value) => saved.set(name, value),
  };
  return { calls, saved, options };
}

test('startup failure saves sanitized logs and stopped container states', async () => {
  const { options, saved } = fixture();
  const result = await collectFailureDiagnostics(options);
  assert.equal(result.startup_logs, 'saved');
  assert.equal(result.container_state, 'saved');
  assert.deepEqual(result.errors, []);
  assert.match(saved.get('startup-containers.log'), /RuntimeError: boot failed/);
  const states = saved.get('container-state.json');
  assert.equal(states.length, 2);
  assert.equal(states[1].exit_code, 1);
  assert.equal(states[1].oom_killed, false);
  assert.ok(!JSON.stringify([...saved]).includes('do-not-persist'));
});

test('log and inspect failures are contained without persisting raw errors', async () => {
  const { options, saved } = fixture({ failLogs: true, failInspect: true });
  const result = await collectFailureDiagnostics(options);
  assert.equal(result.startup_logs, 'failed');
  assert.equal(result.container_state, 'saved');
  assert.equal(result.errors.length, 3);
  assert.deepEqual(saved.get('container-state.json').map(item => item.status), ['unavailable', 'unavailable']);
  assert.ok(!JSON.stringify(result).includes('do-not-persist'));
});

test('failures after startup never collect container logs', async () => {
  const { options, calls, saved } = fixture({ startupLogs: false });
  const result = await collectFailureDiagnostics(options);
  assert.equal(result.startup_logs, 'not_collected_after_startup');
  assert.ok(calls.every(args => args[0] !== 'logs'));
  assert.ok(!saved.has('startup-containers.log'));
});

test('diagnostic write failure is reported without throwing', async () => {
  const { options } = fixture();
  options.save = async () => { throw new Error('disk unavailable'); };
  const result = await collectFailureDiagnostics(options);
  assert.equal(result.startup_logs, 'failed');
  assert.equal(result.container_state, 'failed');
  assert.equal(result.errors.length, 2);
});
