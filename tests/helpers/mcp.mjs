import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../../dist/server.mjs', import.meta.url));
export const dummyApiKey = 'not-a-real-redmine-api-key';

// Each test gets its own loopback listener and actual built MCP subprocess.
// No developer REDMINE_* variables or credentials are inherited.
export async function startMcp(t, fixture, configuration = {}) {
  await access(entry);
  const requests = [];
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    const reply = typeof fixture === 'function' ? fixture(request) : fixture;
    response.writeHead(reply.status, reply.headers);
    response.end(typeof reply.body === 'string'
      ? reply.body
      : JSON.stringify(reply.body));
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${http.address().port}/redmine`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    stderr: 'pipe',
    env: {
      REDMINE_URL: `${baseUrl}/`,
      REDMINE_API_KEY: dummyApiKey,
      REDMINE_MCP_READ_ONLY: configuration.readOnly ?? 'false',
      REDMINE_MCP_TOOLS_ALLOW_PATTERN: configuration.allow ?? '',
      REDMINE_MCP_TOOLS_DENY_PATTERN: configuration.deny ?? '',
    },
  });
  const client = new Client({ name: 'wiki-regression-tests', version: '1.0.0' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  t.after(async () => {
    try {
      await client.close();
    } finally {
      http.closeAllConnections();
      await new Promise(resolve => http.close(resolve));
    }
  });
  try {
    await client.connect(transport, { timeout: 10000 });
  } catch (error) {
    t.diagnostic(stderr);
    throw error;
  }
  return {
    client, requests, baseUrl,
    call: (name, args) => client.callTool(
      { name, arguments: args }, undefined, { timeout: 10000 },
    ),
  };
}
