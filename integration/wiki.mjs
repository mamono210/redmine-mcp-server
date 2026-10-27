import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Receive only the local disposable URL and generated credentials from run.mjs.
// This module never reads REDMINE_URL or REDMINE_API_KEY from the host environment.
export async function verifyWiki({ entry, url, manifest, credentials, record }) {
  const endpoint = new URL(url);
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.equal(endpoint.protocol, 'http:');
  assert.ok(Number.isInteger(manifest.project.id));
  for (const fixture of ['with_rename', 'without_rename']) {
    const user = manifest.users.find(item => item.fixture === fixture);
    assert.ok(user && !user.admin);
    assert.equal(user.rename_wiki_pages, fixture === 'with_rename');
    assert.ok(credentials[fixture]);
    const transport = new StdioClientTransport({
      command: process.execPath, args: [entry], stderr: 'pipe',
      env: {
        REDMINE_URL: url, REDMINE_API_KEY: credentials[fixture],
        REDMINE_MCP_READ_ONLY: 'false',
        REDMINE_MCP_TOOLS_ALLOW_PATTERN: '^(getWikiPage|updateWikiPage)$',
        REDMINE_MCP_TOOLS_DENY_PATTERN: '',
      },
    });
    // Drain without persisting raw process diagnostics that may contain secrets.
    transport.stderr.on('data', () => {});
    const client = new Client({ name: 'wiki-real-integration', version: '1.0.0' });
    try {
      await client.connect(transport, { timeout: 30000 });
      const call = async (tool, args, status) => {
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 30000 });
        record({ user: fixture, tool, input: args, result });
        assert.notEqual(result.isError, true, `${tool}: MCP error`);
        const content = result.content.filter(item => item.type === 'text');
        assert.equal(content.length, 1);
        const response = JSON.parse(content[0].text);
        assert.equal(response.status, status, `${tool}: HTTP status`);
        return response.data;
      };
      for (const [title, canonical] of [
        [`wiki smoke ${fixture}`, `Wiki_smoke_${fixture}`],
        [`日本語 ページ ${fixture}`, `日本語_ページ_${fixture}`],
      ]) {
        const pathParams = { projectId: manifest.project.id, wikiPageTitle: title, format: 'json' };
        const original = `初回本文: ${fixture}`;
        const updated = `更新した本文: ${fixture}`;
        const created = await call('updateWikiPage', {
          pathParams, bodyParams: { wiki_page: { text: original, comments: 'Issue 2 create' } },
        }, 201);
        assert.equal(created.wiki_page.title, canonical);
        assert.equal(created.wiki_page.text, original);
        assert.equal(created.wiki_page.version, 1);
        const read = await call('getWikiPage', { pathParams, queryParams: {} }, 200);
        assert.equal(read.wiki_page.title, canonical);
        assert.equal(read.wiki_page.text, original);
        assert.equal(read.wiki_page.version, 1);
        assert.equal(read.wiki_page.author.id, user.id);
        await call('updateWikiPage', {
          pathParams,
          bodyParams: { wiki_page: { text: updated, version: read.wiki_page.version, comments: 'Issue 2 update' } },
        }, 204);
        const final = await call('getWikiPage', { pathParams, queryParams: {} }, 200);
        assert.equal(final.wiki_page.title, canonical);
        assert.equal(final.wiki_page.text, updated);
        assert.equal(final.wiki_page.version, read.wiki_page.version + 1);
        assert.equal(final.wiki_page.author.id, user.id);
      }
    } finally {
      await client.close();
      await transport.close();
    }
  }
}
