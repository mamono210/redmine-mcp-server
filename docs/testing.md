# MCP regression tests (#1)

## Local checks

Use Node.js **22.23.4** (`.node-version`) and pnpm **10.20.0**
(`package.json#packageManager`). From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

`build` already runs `gen`; an additional generation before every build is not
needed. `typecheck` is a separate `tsc --noEmit` step because tsdown does not type
check. `test` runs Node's built-in test runner and requires `dist/server.mjs` from
the preceding build. No dependencies or lockfile entries are added for tests.
pnpm 10 may report that esbuild's install script was ignored; the recorded run
used the unchanged dependency-build policy and did not run `approve-builds`.

Each test uses the existing SDK Client, a real built MCP subprocess over stdio,
and a fresh loopback HTTP listener on an ephemeral port. No external Redmine is
contacted. The subprocess receives only test REDMINE configuration and a dummy
API key. Developer REDMINE credentials and filters are not inherited.

The suite covers:

- `getWikiPage` and `updateWikiPage` methods, encoded Japanese path text, query,
  JSON body, dummy API-key header and MCP results. A `/redmine/` base URL also
  checks the existing subpath / trailing-slash handling.
- 200, 201, 204, 403, 404, 409, 422 (nonempty and empty errors) and synthetic HTML.
- Required `text`, numeric `projectId`, published schemas and readOnlyHint.
- Current unknown `parent_title` handling (string, empty string, omitted, null).
- Read-only mode, allow and deny filters, deny precedence, and inability of an
  allow pattern to bypass read-only mode. Disabled direct calls send no HTTP.

Fixture provenance and its limits are in
[tests/fixtures/README.md](../tests/fixtures/README.md).

## Generation workaround and artifact comparison

Baseline: `7345677c1020ace42b4eefab5070b6c2190d7b4e`.
Orval 7.10.0 produces one import of `UploadAttachmentFileBody` in `handlers.ts`,
but the schemas do not export that type and the handler does not use it.
`post-generate.js` removes only this unused import after each generation. It
fails if the identifier gains another occurrence or the import shape changes,
so a future generator change must be reviewed instead of silently removing uses.
Generated files stay ignored; no type-check exclusion or error suppression is used.

To reproduce the before/after check, use a disposable checkout at the baseline
commit and keep it at the **same absolute path** for both builds:

1. Record the commit, clean starting diff, Node / pnpm versions and lockfile hash.
2. Run `pnpm install --frozen-lockfile`. Keep the dependency versions and build
   environment fixed for both runs.
3. Remove only `src/__generated__` and `dist` in that disposable checkout. Run
   `pnpm gen`, `pnpm build` and `pnpm exec tsc --noEmit` separately and record each
   exit code. The expected baseline is successful generation / build and one
   TS2724 type error for `UploadAttachmentFileBody`.
4. Save `dist/server.mjs` outside the checkout as the before artifact.
5. Apply **only the change to `post-generate.js`**. Do not apply the package,
   test or CI changes yet. Confirm that it is the only tracked difference.
6. Remove the same two generated-output directories and repeat generation,
   build and typecheck. All three must now succeed.
7. Compare the before artifact and the new `dist/server.mjs` with `cmp`, and
   compute their SHA-256 (for example, `shasum -a 256` on macOS). Require exact
   bytes and hashes without stripping comments or normalizing paths.

An unexpected reproduction or artifact difference must be investigated and
recorded, not hidden by normalizing the output. The same-path condition makes
the comparison conservative; it does not assert that different paths must differ.

## Recorded local results

On 2026-10-26, the baseline and workaround-only build were executed with Node
22.23.4, pnpm 10.20.0, Orval 7.10.0, TypeScript 5.8.3, tsdown 0.12.9,
SDK 1.15.0 and Zod 3.25.75. The lockfile was not changed.

- Before: generation 0, build 0, typecheck 2; one TS2724 at handlers.ts:60.
- After the generator-only change: generation 0, build 0, typecheck 0.
- Before and after `dist/server.mjs` were byte-identical, SHA-256:
  `3fb720298958ef4aac03ce8b0661000183ee78ddcc65f3b0277e7bbe557da0dc`.
- Lockfile SHA-256:
  `413e499af7a0656852fd06b49dc388bb2ddf14d2fb3391199daca9406b08fea2`.

These are local implementation checks, not an executed GitHub Actions run or
real-Redmine integration results. The delivery includes command logs and the
before/after comparison record. A PR run must still validate the GitHub workflow.

## PR CI

`.github/workflows/ci.yml` runs the same install → build → typecheck → test
sequence on `pull_request`, with `contents: read`, no job-level permission
increase and no registered secrets. Checkout does not persist credentials.
Each stage is a separate ordinary step: no `continue-on-error` or shell construct
converts failures to success. No release / publish operation is part of this CI.

All external Actions are pinned to complete commits. The following refs were
resolved in their owning GitHub repositories on 2026-10-26:

| Action / source ref | Pinned commit |
| --- | --- |
| [actions/checkout v5](https://github.com/actions/checkout/commit/fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09) | `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` |
| [pnpm/action-setup v4](https://github.com/pnpm/action-setup/commit/b906affcce14559ad1aafd4ab0e942779e9f58b1) | `b906affcce14559ad1aafd4ab0e942779e9f58b1` |
| [actions/setup-node v6](https://github.com/actions/setup-node/commit/249970729cb0ef3589644e2896645e5dc5ba9c38) | `249970729cb0ef3589644e2896645e5dc5ba9c38` |

The pnpm ref is an annotated tag; the workflow uses its resolved **commit**,
not the tag-object SHA. Node and pnpm versions are fixed separately from Actions.

## Publishing workflow gate

Leave `.github/workflows/publish.yml` unchanged. In the fork, a human enables
Actions if needed and immediately disables **Publish Package** through its menu,
before pushing release tags or starting PR CI operation.

Use unauthenticated GETs to retain the raw responses and request metadata:

- `https://api.github.com/repos/mamono210/redmine-mcp-server/actions/workflows/publish.yml`
- `https://api.github.com/repos/mamono210/redmine-mcp-server/actions/workflows/publish.yml/runs?per_page=100`

Verify the workflow path / ID and `state: disabled_manually`. Follow every `next`
Link for runs, without status / branch / event filters. Require no run whose
status is different from `completed`. If a run exists, a human cancels it in the
UI and reads its final status / conclusion; cancellation requested is insufficient.
Read the workflow and all run pages again after any cancellation.

Save raw JSON, UTC retrieval times, request URLs, HTTP statuses, workflow ID /
path / state and any run ID / URL / cancellation / final status / conclusion.
An API error, incomplete pagination or an unfinished run is not a passing gate.
Disabling the workflow does not cancel existing runs; do not test this by
triggering publication. On upstream sync, inspect added / renamed workflows and
trigger changes, applying the same gate to any publishing workflow.

Sources: [disable / enable](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows),
[workflow API](https://docs.github.com/en/rest/actions/workflows),
[run API](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow).

## Limits and follow-up

- #3 changes the schema and the four `parent_title` baseline tests. In #1 the
  unknown field is stripped even for null. #3 must send string / empty string,
  omit absent fields and reject null before HTTP. Required `text` is unchanged.
- Real parent / permission / version behavior is not measured here. #2 supplies
  a real test environment; #3 performs the parent-related integration checks.
- The generated URL builder interpolates the title without explicit encoding.
  Japanese text is percent-encoded by fetch. A raw `#` begins a URL fragment and
  can truncate the request path. This known limitation is documented, not fixed.
- With SDK 1.15.0, filtering out every tool means the tools capability and request
  handlers are absent. `tools/list` and `tools/call` then return `-32601` (method
  not found); when some tools remain, a disabled tool call returns `-32602`.
- The tests run the built server. Rebuild after source changes; running only
  `pnpm test` may exercise a stale artifact. CI always builds first.
