import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWikiRecorder } from './http-recorder.mjs';

export const parentCaseNames = [
  'create_with_parent', 'change_parent_case_insensitive', 'clear_parent',
  'create_without_parent', 'update_without_parent', 'invalid_missing_parent',
  'invalid_self_parent', 'invalid_descendant_parent', 'create_without_rename_permission',
  'update_without_rename_permission', 'stale_content_version', 'stale_parent_only_version',
  'redirect_parent_title',
];

// Expected Redmine behavior is source-derived until this suite passes against
// the pinned real server. Mocks cannot establish Redmine permission semantics.
export async function verifyWikiParents({ entry, url, manifest, credentials, record, recordCase }) {
  const recorder = await startWikiRecorder(url, manifest.project.id);
  const sessions = new Map();
  let caseName = 'setup';
  try {
    for (const fixture of ['with_rename', 'without_rename']) {
      const user = manifest.users.find(item => item.fixture === fixture);
      assert.ok(user && !user.admin);
      assert.equal(user.rename_wiki_pages, fixture === 'with_rename');
      for (const permission of ['view_wiki_pages', 'edit_wiki_pages']) assert.ok(user.permissions.includes(permission));
      assert.equal(user.permissions.includes('rename_wiki_pages'), fixture === 'with_rename');
      assert.ok(credentials[fixture]);
      const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe',
        env: { REDMINE_URL: recorder.url, REDMINE_API_KEY: credentials[fixture],
          REDMINE_MCP_READ_ONLY: 'false', REDMINE_MCP_TOOLS_ALLOW_PATTERN: '^(getWikiPage|updateWikiPage)$',
          REDMINE_MCP_TOOLS_DENY_PATTERN: '' } });
      transport.stderr.on('data', () => {});
      const client = new Client({ name: 'wiki-parent-integration', version: '1.0.0' });
      sessions.set(fixture, { client, transport, user });
      await client.connect(transport, { timeout: 30000 });
    }
    const call = async (fixture, tool, input, expectedStatus) => {
      const session = sessions.get(fixture);
      const before = recorder.exchanges.length;
      const result = await session.client.callTool({ name: tool, arguments: input }, undefined, { timeout: 30000 });
      const http = recorder.exchanges.slice(before);
      record({ suite: 'wiki-parents', case: caseName, user: fixture,
        permissions: session.user.permissions, tool, input, http, result });
      assert.deepEqual(recorder.errors, [], 'HTTP recorder must not invent an upstream response');
      assert.equal(http.length, 1, 'Exactly one HTTP exchange per MCP call');
      assert.notEqual(result.isError, true);
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, 'text');
      const response = JSON.parse(result.content[0].text);
      assert.equal(http[0].status, expectedStatus, `${caseName}: raw HTTP status`);
      assert.deepEqual(response, { status: http[0].status, headers: {},
        data: http[0].body === '' ? {} : JSON.parse(http[0].body) });
      if (tool === 'updateWikiPage') assert.deepEqual(JSON.parse(http[0].request_body), input.bodyParams);
      if (expectedStatus === 204) {
        assert.equal(http[0].body, '');
        assert.equal(http[0].content_type, null);
      } else if (expectedStatus === 409) {
        assert.equal(http[0].body, '');
        assert.equal(http[0].content_type, 'application/json');
      } else {
        assert.match(http[0].content_type, /^application\/json(?:;|$)/);
      }
      return response.data;
    };
    const pathParams = title => ({ projectId: manifest.project.id, wikiPageTitle: title, format: 'json' });
    const get = async (title, fixture = 'with_rename') =>
      (await call(fixture, 'getWikiPage', { pathParams: pathParams(title), queryParams: {} }, 200)).wiki_page;
    const put = (title, wikiPage, status = 204, fixture = 'with_rename') =>
      call(fixture, 'updateWikiPage', { pathParams: pathParams(title), bodyParams: { wiki_page: wikiPage } }, status);
    const parentIs = (page, parent) => parent === null
      ? assert.equal(Object.hasOwn(page, 'parent'), false, 'Root pages omit parent entirely')
      : assert.equal(page.parent?.title, parent.title, 'Compare with the saved, resolved parent title');
    const unchanged = (before, after) => {
      assert.equal(after.title, before.title);
      assert.equal(after.text, before.text);
      assert.equal(after.version, before.version);
      assert.deepEqual(after.parent, before.parent);
    };
    const create = async (title, text, parentTitle, fixture = 'with_rename') => {
      const body = { text };
      if (parentTitle !== undefined) body.parent_title = parentTitle;
      const created = (await put(title, body, 201, fixture)).wiki_page;
      const saved = await get(title, fixture);
      assert.equal(created.title, saved.title);
      assert.equal(created.text, text);
      assert.equal(saved.text, text);
      assert.equal(saved.version, 1);
      assert.equal(saved.author.id, sessions.get(fixture).user.id);
      assert.deepEqual(created.parent, saved.parent);
      return saved;
    };
    const run = async (name, action) => {
      caseName = name;
      try {
        await action();
        recordCase({ name, result: 'passed' });
      } catch (error) {
        recordCase({ name, result: 'failed', error: error.message });
        throw error;
      }
    };

    // Prepare parents through MCP; use their read-back titles as the oracle.
    const parentInput = '日本語 親 A';
    const parentA = await create(parentInput, '親 A 本文');
    const parentB = await create('Parent Target B', 'Parent B body');
    parentIs(parentA, null);
    parentIs(parentB, null);
    let child;
    await run('create_with_parent', async () => {
      child = await create('日本語 子ページ', '子ページ本文 1', parentInput);
      parentIs(child, parentA);
    });
    await run('change_parent_case_insensitive', async () => {
      await put(child.title, { text: '子ページ本文 2', version: child.version, parent_title: 'pArEnT tArGeT b' });
      const after = await get(child.title);
      parentIs(after, parentB);
      assert.equal(after.text, '子ページ本文 2');
      assert.equal(after.version, child.version + 1);
      child = after;
    });
    await run('clear_parent', async () => {
      await put(child.title, { text: child.text, parent_title: '' });
      child = await get(child.title);
      parentIs(child, null);
    });
    await run('create_without_parent', async () => parentIs(await create('親未指定 ページ', '親なし本文'), null));
    await run('update_without_parent', async () => {
      await put(child.title, { text: child.text, parent_title: parentInput });
      child = await get(child.title);
      parentIs(child, parentA);
      await put(child.title, { text: '親維持で本文更新', version: child.version });
      const after = await get(child.title);
      parentIs(after, parentA);
      assert.equal(after.text, '親維持で本文更新');
      assert.equal(after.version, child.version + 1);
      child = after;
    });
    const invalidParent = async parentTitle => {
      const data = await put(child.title, { text: '保存されない本文', version: child.version, parent_title: parentTitle }, 422);
      assert.deepEqual(data, { errors: [] }, 'Pinned controller returns content errors, not page errors');
      unchanged(child, await get(child.title));
    };
    await run('invalid_missing_parent', () => invalidParent('Missing Parent Fixture'));
    await run('invalid_self_parent', () => invalidParent(child.title));
    await run('invalid_descendant_parent', async () => {
      const descendant = await create('子孫 ページ', '子孫本文', child.title);
      parentIs(descendant, child);
      await invalidParent(descendant.title);
    });
    let restricted;
    await run('create_without_rename_permission', async () => {
      restricted = await create('権限差 子ページ', '権限差 本文 1', parentInput, 'without_rename');
      parentIs(restricted, parentA);
    });
    await run('update_without_rename_permission', async () => {
      await put(restricted.title, { text: '権限差 本文 2', version: restricted.version, parent_title: parentB.title }, 204, 'without_rename');
      const after = await get(restricted.title, 'without_rename');
      parentIs(after, parentA);
      assert.equal(after.text, '権限差 本文 2');
      assert.equal(after.version, restricted.version + 1);
    });
    assert.ok(child.version > 1);
    const staleVersion = child.version - 1;
    await run('stale_content_version', async () => {
      await put(child.title, { text: '競合で保存されない本文', version: staleVersion, parent_title: parentB.title }, 409);
      unchanged(child, await get(child.title));
    });
    await run('stale_parent_only_version', async () => {
      await put(child.title, { text: child.text, version: staleVersion, parent_title: parentB.title });
      const after = await get(child.title);
      parentIs(after, parentB);
      assert.equal(after.text, child.text);
      assert.equal(after.version, child.version);
      child = after;
    });
    await run('redirect_parent_title', async () => {
      const redirect = manifest.parent_fixture;
      assert.ok(redirect && redirect.previous_title !== redirect.target_title);
      const target = await get(redirect.target_title);
      await put(child.title, { text: child.text, parent_title: redirect.previous_title });
      parentIs(await get(child.title), target);
    });
  } finally {
    const closed = await Promise.allSettled([...sessions.values()].map(async ({ client, transport }) => {
      try { await client.close(); } finally { await transport.close(); }
    }));
    await recorder.close();
    const failure = closed.find(result => result.status === 'rejected');
    if (failure) throw new Error('Could not close a Wiki parent test session');
  }
}
