import assert from 'node:assert/strict';

// Startup logs are collected only before fixture users/API keys are created.
// Omit whole credential-bearing lines, rather than guessing the value's length.
export function sanitizeStartupLog(value) {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .split('\n')
    .map(line => /password|passwd|secret|token|authorization|cookie|api[_ -]?key|credential|private[_ -]?key/i.test(line)
      ? '[REDACTED credential-bearing line]'
      : line.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
        .replace(/\b[a-f0-9]{40,}\b/gi, '[REDACTED hex value]'))
    .join('\n');
}

export async function collectFailureDiagnostics({ docker, command, save, startupLogs }) {
  const result = { errors: [], startup_logs: startupLogs ? 'pending' : 'not_collected_after_startup' };
  const options = { cleanup: true, timeout: 15000 };
  if (startupLogs) {
    try {
      const logs = await docker(['logs', '--no-color', '--timestamps', '--tail', '300', 'db', 'redmine'],
        { ...options, includeStderr: true });
      await save('startup-containers.log', sanitizeStartupLog(logs));
      result.startup_logs = 'saved';
    } catch {
      result.startup_logs = 'failed';
      result.errors.push('Could not collect startup container logs');
    }
  }
  const states = [];
  for (const service of ['db', 'redmine']) {
    try {
      // Include stopped containers. Never inspect Config.Env or credentials.
      const id = await docker(['ps', '--all', '--quiet', service], options);
      if (!id) {
        states.push({ service, status: 'not_created' });
        continue;
      }
      assert.match(id, /^[a-f0-9]+$/);
      const format = '{"status":{{json .State.Status}},"exit_code":{{.State.ExitCode}},' +
        '"oom_killed":{{.State.OOMKilled}},"error":{{json .State.Error}},' +
        '"started_at":{{json .State.StartedAt}},"finished_at":{{json .State.FinishedAt}},' +
        '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}';
      const state = JSON.parse(await command('docker', ['inspect', '--format', format, id], options));
      state.error = sanitizeStartupLog(state.error);
      states.push({ service, ...state });
    } catch {
      states.push({ service, status: 'unavailable' });
      result.errors.push(`Could not inspect ${service} container state`);
    }
  }
  try {
    await save('container-state.json', states);
    result.container_state = 'saved';
  } catch {
    result.container_state = 'failed';
    result.errors.push('Could not save container state');
  }
  return result;
}
