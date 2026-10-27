import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';

// Test-only loopback proxy: observe the same requests the built MCP makes.
// Never record authentication headers, cookies or arbitrary response headers.
export async function startWikiRecorder(targetUrl, projectId) {
  const target = new URL(targetUrl);
  assert.equal(target.protocol, 'http:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.username + target.password + target.search + target.hash, '');
  assert.equal(target.pathname, '/');
  assert.ok(Number.isInteger(projectId) && projectId > 0);
  const exchanges = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      if (!['GET', 'PUT'].includes(request.method) ||
          !request.url.startsWith(`/projects/${projectId}/wiki/`) ||
          !request.url.endsWith('.json') || request.url.includes('?')) {
        response.writeHead(400);
        response.end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('Fixture request too large');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const headers = { 'content-length': String(body.length), 'accept-encoding': 'identity' };
      for (const name of ['content-type', 'accept', 'x-redmine-api-key']) {
        if (request.headers[name] !== undefined) headers[name] = request.headers[name];
      }
      await new Promise((resolve, reject) => {
        const upstream = httpRequest({ hostname: target.hostname, port: target.port,
          path: request.url, method: request.method, headers }, reply => {
          const received = [];
          reply.on('data', chunk => received.push(chunk));
          reply.once('error', reject);
          reply.once('end', () => {
            const raw = Buffer.concat(received);
            const contentType = reply.headers['content-type'] ?? null;
            exchanges.push({ method: request.method, path: request.url,
              request_body: body.toString('utf8'), status: reply.statusCode,
              content_type: contentType, body: raw.toString('utf8') });
            response.writeHead(reply.statusCode, contentType === null ? {} : { 'content-type': contentType });
            response.end(raw);
            resolve();
          });
        });
        upstream.setTimeout(20000, () => upstream.destroy(new Error('Fixture upstream timeout')));
        upstream.once('error', reject);
        upstream.end(body);
      });
    } catch {
      errors.push('Wiki recorder transport failed');
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end('{"error":"Wiki recorder transport failed"}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`, exchanges, errors,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
