# Wiki parent pages (#3)

This fork adds optional string `bodyParams.wiki_page.parent_title` to
`updateWikiPage`. The source of this input is `redmine-openapi.yaml`; run
`pnpm build` to regenerate the client, schema and handlers. Generated files
are not edited or committed. `text` remains required, and the existing
`comments` and `version` fields keep their meaning.

| Input | HTTP request | Meaning |
| --- | --- | --- |
| Existing parent title | String sent unchanged | Assign/change the parent |
| `""` | Empty string retained | Remove the parent |
| Omitted | Property absent | Keep the existing parent; no parent specified on creation |
| `null`, number, boolean, object or array | No HTTP request | MCP validation rejects with `-32602` |

## Examples

These are complete arguments for `updateWikiPage`. Replace the numeric project
ID and titles with values from your project. The child and parent must be in
the same project's Wiki. The parent must already exist.

Create a child, or assign a parent to an existing page:

```json
{
  "pathParams": { "projectId": 42, "wikiPageTitle": "子ページ", "format": "json" },
  "bodyParams": { "wiki_page": { "text": "本文", "parent_title": "親ページ" } }
}
```

Change an existing page's parent by setting `parent_title` to another existing
parent's title. Keep `text` equal to the current body if no body change is
intended. Remove the parent with an explicit empty string:

```json
{
  "pathParams": { "projectId": 42, "wikiPageTitle": "子ページ", "format": "json" },
  "bodyParams": { "wiki_page": { "text": "本文", "parent_title": "" } }
}
```

Update the body while retaining its current parent. Use the version returned
by the preceding read, rather than the illustrative `2` below:

```json
{
  "pathParams": { "projectId": 42, "wikiPageTitle": "子ページ", "format": "json" },
  "bodyParams": { "wiki_page": { "text": "更新した本文", "version": 2 } }
}
```

After each operation, call `getWikiPage` with:

```json
{
  "pathParams": { "projectId": 42, "wikiPageTitle": "子ページ", "format": "json" },
  "queryParams": {}
}
```

The JSON inside the MCP text result has `data.wiki_page`. Verify its body,
version and `parent.title`. When the parent was removed, `wiki_page` must not
contain a `parent` property at all.

## Permissions, title resolution and concurrency

The following expectations come from the pinned Redmine source. The new
real-Redmine tests must pass before treating them as measured #3 results.

- Updating an **existing** page's parent requires `rename_wiki_pages` in
  addition to Wiki editing permission. Without it, Redmine ignores
  `parent_title`: a body update can succeed with 204 while the parent stays
  unchanged. New-page parent assignment has a different permission condition;
  the suite covers creation both with and without rename permission.
- Redmine normalizes names, searches case-insensitively and resolves Wiki
  redirects. Compare `parent.title` with the **saved title of the resolved
  target page**, obtained by reading that page. Comparing it only with the
  caller's input, or just normalizing that input, is insufficient for redirects.
- With rename permission, nonexistent, self and descendant parents are
  expected to return 422. The pinned controller renders the content object's
  errors, so these parent errors are expected to produce `{"errors":[]}`.
  The MCP returns Redmine's result without inventing a reason.
- An old `version` with a changed body is expected to return an empty 409
  response and leave the stored body/version/parent unchanged.
- With an unchanged body, the parent-only update does not save Wiki content;
  an old `version` is therefore not a concurrency guard. The suite expects a
  successful parent change with the stored content version unchanged.
- Redmine 204/409/422 responses keep the existing MCP representation. Empty
  bodies become `data: {}` and the serialized Headers object is `{}`. These
  HTTP statuses do not themselves cause `isError: true`. Readback and the
  HTTP status remain necessary when interpreting the result.

This change does not add automatic readback, retries, tree traversal, page
renaming or stronger locking. The existing URL behavior for titles containing
`#` is outside #3.

## Test scope and execution

Use Node.js 22.23.4 and pnpm 10.20.0:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:integration
```

The last command requires Docker/Compose and follows
[the existing integration setup](integration-testing.md). It retains #2's
16 baseline MCP calls, then runs the following 13 parent cases:

1. Create a Japanese-named child with a Japanese-named parent.
2. Change the parent using mixed case and spaces in its name.
3. Remove the parent with `""`.
4. Create a page with the parent omitted.
5. Update a body with the parent omitted and verify preservation.
6. Reject a nonexistent parent with rename permission.
7. Reject self as parent with rename permission.
8. Reject a descendant as parent with rename permission.
9. Create a child with a parent without rename permission.
10. Update an existing page without rename permission: 204, body changes,
    parent does not change.
11. Reject a stale version when the body also changes; verify rollback.
12. Accept a stale version for unchanged-body parent-only updates; verify
    the stored content version stays the same.
13. Resolve a renamed parent's previous title through a redirect.

Each operation under test uses the built MCP server and is followed by a read.
The seed uses Redmine's normal rename callback solely to prepare the redirect
fixture; it does not assign the tested child-parent relationships. Other test
pages are prepared through MCP.

For parent tests, a loopback-only HTTP recorder forwards the MCP request to the
disposable Redmine. It saves the response status, Content-Type and exact UTF-8
body separately from the MCP result, under each `calls[].http` entry in
`result.json`. It does not call the REST API a second time. Authentication
headers and cookies are excluded from the record. Transport failures produce
failed tests, not fabricated Redmine evidence. `parent_cases` reports each case;
`environment` and `mcp_commit` identify the versions and permissions used.

Require `result: passed`, `cleanup: passed`, all 13 `parent_cases` passed and
the intended commit/dirty-worktree identity. If measurements differ, preserve
the failed result and inspect raw HTTP, MCP conversion, user permissions and
readback before revising expectations. Do not change public MCP behavior just
to make a test pass.

The existing integration workflow is extended to the suggested branch
`feat/issue-3-wiki-parent`; it runs twice from empty databases on push. It can
also be run manually for that branch because the workflow already exists on
main. The PR workflow runs generation/build, typechecking and mock/recorder
tests. **Parent behavior against real Redmine is not run automatically for
every PR.** Other branches require a manual integration run or an explicit
change to the existing branch filter.

## Verification status of this implementation

- Redmine target: `7.0.2.devel`, source
  `f7ea71f9563ea7b346a8dbc7abb3854fc69321ea`, Rails `8.1.4`, PostgreSQL `17.6`.
- MCP baseline: main `512419c7b6843662f81ded742579ab3db3147484`, package version
  `1.3.0`. The #3 changes have not been released. Actual runs record the checked
  out MCP commit, worktree status and generated artifact hash.
- The earlier [#2 GHA run](https://github.com/mamono210/redmine-mcp-server/actions/runs/40431338633)
  passed baseline Wiki tests against that Redmine twice. It did **not** test
  this parent feature.
- This authoring environment has no Docker Engine. Real-Redmine #3 tests and
  CI for this patch have not been run here. Consult the delivery's verification
  record for local checks. Run integration tests on the applied commit before
  completing #3; retain both result directories and their Gemfile.lock files.

Source expectations: pinned Redmine [Wiki model](https://github.com/redmine/redmine/blob/f7ea71f9563ea7b346a8dbc7abb3854fc69321ea/app/models/wiki.rb),
[page model](https://github.com/redmine/redmine/blob/f7ea71f9563ea7b346a8dbc7abb3854fc69321ea/app/models/wiki_page.rb),
[update controller](https://github.com/redmine/redmine/blob/f7ea71f9563ea7b346a8dbc7abb3854fc69321ea/app/controllers/wiki_controller.rb)
and [API view](https://github.com/redmine/redmine/blob/f7ea71f9563ea7b346a8dbc7abb3854fc69321ea/app/views/wiki/show.api.rsb).
