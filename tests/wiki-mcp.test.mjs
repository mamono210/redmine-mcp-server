import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dummyApiKey, startMcp } from './helpers/mcp.mjs';

const fixtures = JSON.parse(readFileSync(
  new URL('./fixtures/wiki-responses.json', import.meta.url), 'utf8',
));
const updateFixture = fixtures.find(fixture => fixture.id === 'update-204');
const getFixture = fixtures.find(fixture => fixture.id === 'get-200');
const pathParams = { projectId: 42, wikiPageTitle: 'Wiki', format: 'json' };
const wikiPage = { text: 'テスト本文', comments: 'test update', version: 2 };
const updateArgs = () => ({ pathParams: { ...pathParams }, bodyParams: { wiki_page: { ...wikiPage } } });
const getArgs = () => ({ pathParams: { ...pathParams }, queryParams: {} });

for (const fixture of fixtures) {
  test(`${fixture.id}: HTTP request and MCP response`, { timeout: 20000 }, async t => {
    const mcp = await startMcp(t, fixture);
    const isGet = fixture.tool === 'getWikiPage';
    const args = isGet ? getArgs() : updateArgs();
    if (fixture.id === 'get-200') {
      args.pathParams.wikiPageTitle = '日本語ページ';
      args.queryParams.include = 'attachments';
    }
    if (fixture.id === 'create-201') delete args.bodyParams.wiki_page.version;
    if (fixture.id === 'validation-422') args.bodyParams.wiki_page.text = '';
    const result = await mcp.call(fixture.tool, args);
    assert.equal(mcp.requests.length, 1);
    const request = mcp.requests[0];
    const expectedPath = `/redmine/projects/42/wiki/${encodeURIComponent(args.pathParams.wikiPageTitle)}.json`;
    const expectedQuery = fixture.id === 'get-200' ? '?include=attachments' : '';
    assert.equal(request.method, isGet ? 'GET' : 'PUT');
    assert.equal(request.url, expectedPath + expectedQuery);
    assert.equal(request.headers['x-redmine-api-key'], dummyApiKey);
    if (isGet) {
      assert.equal(request.body, '');
    } else {
      assert.equal(request.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(request.body), args.bodyParams);
    }

    if (fixture.kind === 'synthetic') {
      assert.deepEqual(result, {
        content: [{ type: 'text', text:
          `Expected JSON but received HTML (HTTP ${fixture.status}). ` +
          `URL: ${mcp.baseUrl}/projects/42/wiki/Wiki.json. ` +
          `Response body: ${fixture.body.substring(0, 200)}...`,
        }],
        isError: true,
      });
    } else {
      // Non-2xx JSON/empty HTTP responses remain ordinary tool results.
      // Headers is serialized as {}, as in the existing generated handler.
      assert.deepEqual(result, {
        content: [{ type: 'text', text: JSON.stringify({
          data: fixture.body === '' ? {} : fixture.body,
          status: fixture.status,
          headers: {},
        }) }],
      });
    }
  });
}

test('published Wiki schemas and readOnlyHint remain compatible', { timeout: 20000 }, async t => {
  const { client } = await startMcp(t, updateFixture);
  const { tools } = await client.listTools();
  const get = tools.find(tool => tool.name === 'getWikiPage');
  const update = tools.find(tool => tool.name === 'updateWikiPage');
  assert.equal(get.annotations.readOnlyHint, true);
  assert.equal(update.annotations.readOnlyHint, false);
  const page = update.inputSchema.properties.bodyParams.properties.wiki_page;
  assert.deepEqual(Object.keys(page.properties).sort(), ['comments', 'text', 'version']);
  assert.deepEqual(page.required, ['text']);
  assert.equal(page.additionalProperties, false);
  assert.equal(update.inputSchema.properties.pathParams.properties.projectId.type, 'number');
});

// #3 will replace these baseline expectations with optional-string handling.
for (const [name, value] of [['title', '親ページ'], ['empty', ''], ['omitted', undefined], ['null', null]]) {
  test(`current parent_title handling: ${name} is not sent`, { timeout: 20000 }, async t => {
    const mcp = await startMcp(t, updateFixture);
    const args = updateArgs();
    if (value !== undefined) args.bodyParams.wiki_page.parent_title = value;
    await mcp.call('updateWikiPage', args);
    assert.equal(mcp.requests.length, 1);
    assert.deepEqual(JSON.parse(mcp.requests[0].body), { wiki_page: wikiPage });
  });
}

for (const invalid of ['missing text', 'string projectId']) {
  test(`invalid input is rejected before HTTP: ${invalid}`, { timeout: 20000 }, async t => {
    const mcp = await startMcp(t, updateFixture);
    const args = updateArgs();
    if (invalid === 'missing text') delete args.bodyParams.wiki_page.text;
    else args.pathParams.projectId = 'test-project';
    await assert.rejects(mcp.call('updateWikiPage', args), error => error.code === -32602);
    assert.equal(mcp.requests.length, 0);
  });
}

const modes = [
  { name: 'default', configuration: {}, get: true, update: true },
  { name: 'read only', configuration: { readOnly: 'true' }, get: true, update: false },
  { name: 'allow get only', configuration: { allow: '^getWikiPage$' }, get: true, update: false, exact: ['getWikiPage'] },
  { name: 'allow update only', configuration: { allow: '^updateWikiPage$' }, get: false, update: true, exact: ['updateWikiPage'] },
  { name: 'deny update', configuration: { deny: '^updateWikiPage$' }, get: true, update: false },
  { name: 'deny wins over allow', configuration: { allow: '^(getWikiPage|updateWikiPage)$', deny: '^updateWikiPage$' }, get: true, update: false, exact: ['getWikiPage'] },
  { name: 'allow cannot bypass read only', configuration: { readOnly: 'true', allow: '^updateWikiPage$' }, get: false, update: false, exact: [] },
];

for (const mode of modes) {
  test(`tool publication and direct calls: ${mode.name}`, { timeout: 20000 }, async t => {
    const mcp = await startMcp(t, request => request.method === 'GET'
      ? getFixture : updateFixture, mode.configuration);
    if (mode.exact?.length === 0) {
      // SDK 1.15.0 does not install tools handlers when no tool is registered.
      assert.equal(mcp.client.getServerCapabilities().tools, undefined);
      await assert.rejects(mcp.client.listTools(), error => error.code === -32601);
      await assert.rejects(mcp.call('getWikiPage', getArgs()), error => error.code === -32601);
      await assert.rejects(mcp.call('updateWikiPage', updateArgs()), error => error.code === -32601);
      assert.equal(mcp.requests.length, 0);
      return;
    }
    const { tools } = await mcp.client.listTools();
    const names = tools.map(tool => tool.name).sort();
    assert.equal(names.includes('getWikiPage'), mode.get);
    assert.equal(names.includes('updateWikiPage'), mode.update);
    if (mode.exact) assert.deepEqual(names, mode.exact);
    for (const [name, enabled, args] of [
      ['getWikiPage', mode.get, getArgs()],
      ['updateWikiPage', mode.update, updateArgs()],
    ]) {
      const before = mcp.requests.length;
      if (enabled) {
        const result = await mcp.call(name, args);
        assert.notEqual(result.isError, true);
        assert.equal(mcp.requests.length, before + 1);
      } else {
        await assert.rejects(mcp.call(name, args), error => error.code === -32602);
        assert.equal(mcp.requests.length, before);
      }
    }
  });
}
