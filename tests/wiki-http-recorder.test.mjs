import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { startWikiRecorder } from '../integration/http-recorder.mjs';

test('recorder preserves raw JSON and empty responses without recording credentials', async t => {
  const fixtureKey = 'fixture-api-key-never-record';
  const fixtureCookie = 'fixture-cookie-never-record';
  const received = [];
  let reply;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ key: request.headers['x-redmine-api-key'], body: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(reply.status, { 'set-cookie': fixtureCookie,
      ...(reply.contentType ? { 'content-type': reply.contentType } : {}) });
    response.end(reply.body);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  const recorder = await startWikiRecorder(`http://127.0.0.1:${upstream.address().port}`, 42);
  t.after(() => recorder.close());
  const requestBody = JSON.stringify({ wiki_page: { text: '本文', parent_title: '' } });
  for (const fixture of [
    { status: 201, contentType: 'application/json; charset=utf-8', body: '{"wiki_page":{"title":"子ページ"}}' },
    { status: 204, contentType: null, body: '' },
    { status: 409, contentType: 'application/json', body: '' },
    { status: 422, contentType: 'application/json; charset=utf-8', body: '{\n  "errors": []\n}' },
  ]) {
    reply = fixture;
    const response = await fetch(`${recorder.url}/projects/42/wiki/${encodeURIComponent('子ページ')}.json`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-redmine-api-key': fixtureKey }, body: requestBody,
    });
    assert.equal(response.status, fixture.status);
    assert.equal(await response.text(), fixture.body);
    const exchange = recorder.exchanges.at(-1);
    assert.equal(exchange.body, fixture.body);
    assert.equal(exchange.content_type, fixture.contentType);
    assert.equal(exchange.request_body, requestBody);
    assert.equal(received.at(-1).key, fixtureKey);
    assert.equal(received.at(-1).body, requestBody);
  }
  assert.deepEqual(recorder.errors, []);
  const saved = JSON.stringify(recorder.exchanges);
  assert.ok(!saved.includes(fixtureKey));
  assert.ok(!saved.includes(fixtureCookie));
  const before = received.length;
  assert.equal((await fetch(`${recorder.url}/users/current.json`)).status, 400);
  assert.equal((await fetch(`${recorder.url}/projects/43/wiki/Wiki.json`)).status, 400);
  assert.equal(received.length, before);
});

test('recorder only accepts a loopback test server without URL credentials', async () => {
  for (const url of ['https://127.0.0.1', 'http://example.com', 'http://user:password@127.0.0.1', 'http://127.0.0.1?key=value']) {
    await assert.rejects(startWikiRecorder(url, 42));
  }
});

test('recorder reports transport failure without claiming a Redmine response', async t => {
  const upstream = createServer((request, response) => response.destroy());
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const recorder = await startWikiRecorder(`http://127.0.0.1:${upstream.address().port}`, 42);
  t.after(() => recorder.close());
  const response = await fetch(`${recorder.url}/projects/42/wiki/Wiki.json`);
  assert.equal(response.status, 502);
  await response.text();
  assert.equal(recorder.exchanges.length, 0);
  assert.deepEqual(recorder.errors, ['Wiki recorder transport failed']);
});
