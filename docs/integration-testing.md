# Disposable Redmine integration environment (#2)

This suite, runnable locally or on GitHub Actions, builds Redmine from the exact source selected in #2,
creates a fresh PostgreSQL database and two non-admin users, and exercises
the **built MCP server over stdio**. It does not use a running personal or
production Redmine instance. `REDMINE_URL`, `REDMINE_API_KEY` and tool filters
from the host are not used.

## Requirements and execution

- Docker Engine through Docker Desktop, Colima, or another local Docker context.
- Docker Compose v2 with `up --wait`, `--wait-timeout`, `config --format json`
  and `cp` support. The configuration was parsed with Compose **2.40.3**.
- Node.js **22.23.4**, pnpm **10.20.0**, and Git.
- Network access to Docker Hub, GitHub, Debian package mirrors and RubyGems
  during the first image build. Native Linux amd64 and arm64 images are available.

From the repository root, with the Node version in `.node-version` selected:

```sh
pnpm install --frozen-lockfile
pnpm test:integration
```

The command checks Docker availability, builds and typechecks the current MCP
source, builds the Redmine image, starts the containers, initializes fixtures,
runs the Wiki checks, and removes its containers, network and DB volume in
`finally`. A failed setup, assertion or cleanup produces a nonzero exit code.
It does not install dependencies automatically; use the frozen install above.

The first build can take several minutes. Console messages identify the stage;
command logs and `result.json` are saved in
`integration-results/redmine-mcp-it-<unique-id>/`. This directory is excluded
from Git and the existing Docker build context. Run the command a second time
to verify clean-environment repeatability: each invocation uses a different
Compose project, new database volume and newly generated API keys.

## Fixed source and images

| Component | Fixed selection |
| --- | --- |
| Redmine | `f7ea71f9563ea7b346a8dbc7abb3854fc69321ea` (`7.0.2.devel`) |
| Rails | `8.1.4`, specified by that source's Gemfile |
| Ruby base | `ruby:3.4.5-bookworm@sha256:7a61aa7fe86768830f65d8e12571fc115f381a54557c7c88619a5368b92a0474` |
| PostgreSQL | `postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3` |

These Docker Hub multi-platform index digests were resolved on 2026-10-27 JST.
The Dockerfile fetches the exact Redmine commit and checks the checked-out SHA.
It adds PostgreSQL configuration and makes upstream's `puma` dependency
available outside the test group, through `Gemfile.local`. It does not patch
Redmine's authorization, API or concurrency behavior.

The `ldap` gem group is installed because production eager loading loads
`AuthSourceLdap`, which requires `net/ldap`, even when LDAP authentication is
not configured. The image build verifies those requires before startup.

The source does **not** include a Gemfile.lock. Debian packages and transitive
gems are resolved at image build time: this is not a claim of byte-reproducible
image builds. The same built image/cache may be reused for subsequent runs.
Every actual run records Redmine, Rails, Ruby, Bundler and PostgreSQL versions,
the resolved image IDs/RepoDigests/platform, and exports the generated
`Gemfile.lock` with its SHA-256. Retain that lock and image when exact dependency
replay is needed; rebuilding without the cache may resolve different gems.
Never describe a digest resolved from the registry as a locally built image ID.

## Startup and initialization

`integration/compose.yml` publishes only Redmine, on a dynamically allocated
**127.0.0.1** port. PostgreSQL has no host port. No host Redmine/database
configuration or credentials are mounted. The database password in the fixture
is disposable test data, not a production credential.

1. PostgreSQL must pass `pg_isready`.
2. The Redmine entrypoint creates a private session secret, migrates the empty
   database and precompiles assets before starting Rails in production mode.
   The schema migration is necessary to boot; it is not the test-data seed.
3. `docker compose up --wait` requires an HTTP 200 from `/login`, rather than
   treating elapsed time as readiness.
4. Only after readiness, the harness runs the seed through `rails runner` in
   that container. It enables the **global** REST API setting and creates a
   private project with only the Wiki module enabled. It refuses a nonempty
   project database and checks the fixture environment/database/source first.
5. The initial admin account is locked. Two non-admin members are created with
   the following explicit role permissions. Passwords are random; no admin API
   key is used. Permission checks in the seed validate fixture configuration,
   not the parent-change behavior reserved for #3.

| Fixture | Explicit role permissions |
| --- | --- |
| `with_rename` | `view_wiki_pages`, `edit_wiki_pages`, `rename_wiki_pages` |
| `without_rename` | `view_wiki_pages`, `edit_wiki_pages` |

`integration/redmine/seed.rb` writes a public manifest and a separate mode-0600
credential file inside the container. The harness copies credentials to a
private OS temporary directory, passes them only to the MCP subprocess and
removes that directory during cleanup. They are never put in command arguments,
printed, committed or copied into the result directory. Raw MCP stderr and seed
output are not published. Known generated API keys are redacted from saved
results/errors as an additional measure. Do not print the private file yourself.

## Assertions and evidence

For each user, the suite creates one Latin-name page and one Japanese-name page
(four independent cases, sixteen MCP calls):

1. `updateWikiPage` creates a page with a nonempty body; expect HTTP 201.
2. `getWikiPage` returns the canonical title, exact body and version 1.
3. `updateWikiPage` changes the body using the read version; expect HTTP 204.
4. Read back the canonical title, changed body and version increment by one.

The names contain spaces, so expected names explicitly use `_`; the Latin
example also checks capitalization of the first character. The numeric project
ID comes from the seed manifest. Readback author IDs must match the non-admin
user. This does not add `parent_title` to the MCP schema.

`result.json` includes:

- Command arguments, timestamps, exit codes and final test/cleanup results.
- MCP Git commit, dirty worktree status, package version, lock hash and built
  server hash. A dirty checkout is recorded, not presented as a clean commit.
- Fixed source/image references, actual running versions, image IDs/digests and
  architecture, project ID, enabled modules, user IDs and role permissions.
- Every Wiki MCP input, result and readback, with generated API keys redacted.
- Whether CI is running, and GitHub repository/run/attempt/event/ref/SHA when
  running on Actions. Environment variables and tokens are not dumped.

Inspect `result: passed` **and** `cleanup: passed`. HTTP status alone is not the
test oracle. Keep the entire result directory for the run, including the
Gemfile.lock and logs. These results establish only the four normal cases;
the error fixtures from #1 remain source-derived, not real-Redmine measurements.

## Cleanup and recovery

On failure, `result.json` records `failed_stage`. Before removing containers,
the runner attempts to save `container-state.json` with exit codes, OOM flags,
health status and timestamps; it does not dump container environment variables.
If `up --wait` fails before fixture initialization, it also saves the last 300
log lines per service as `startup-containers.log`. The entrypoint prints stage
markers for environment/session initialization, migration, asset compilation
and Rails startup. Credential-bearing lines, URL credentials and long hex
values are redacted before saving. Raw logs are never written to an artifact.
Container logs are not collected after startup, when fixture credentials may
exist. Diagnostic errors are recorded separately and do not prevent cleanup
or replace the original failure. Inspect these files before changing timeouts
or dependency versions.

Normally `pnpm test:integration` performs cleanup automatically, including on
test failures. If the process is forcibly killed, Docker stops responding, or
cleanup fails, use the exact `cleanup_command` array saved in `result.json`.
For a run with project name `redmine-mcp-it-<id>`, its shell equivalent is:

```sh
docker compose --project-name redmine-mcp-it-<id> --file integration/compose.yml down --volumes --remove-orphans
```

Replace `<id>` with that run's actual ID. Do not run a broad Docker prune.
The private temporary directory has the same project-name prefix in the OS
temporary directory; remove that run's directory if a forced kill prevented
normal cleanup. Build cache and locally built images remain for reuse; remove
only the specific recorded image/tag separately if no longer needed. Result
files remain until you delete that run's directory.

## CI and #3 handoff

`.github/workflows/integration.yml` runs **Redmine integration tests** on pushes
to `test/issue-2-redmine-integration`. Include the workflow and all #2 files in
the pushed commit. A PR or merge into `main` is not required for this trigger.

The workflow uses `ubuntu-24.04` and its Docker/Compose installation, installs
the pinned Node.js/pnpm versions and frozen dependencies, then runs
`pnpm test:integration` twice. Each invocation uses a new database, project and
users; Docker build cache may be reused. The second run starts only if the first
succeeds. The 23 existing mock-backed tests and startup diagnostic tests run
after both integration passes.
No step suppresses failures. The job has a 60-minute timeout.

The workflow has `contents: read`, does not reference registered secrets, does
not persist checkout credentials and pins every external Action by full commit
SHA. The upload action is `actions/upload-artifact` v4 at
`ea165f8d65b6e75b540449e92b4886f43607fa02` (resolved and its inputs checked on
2026-10-27 JST). Existing checkout/Node/pnpm Action pins are reused from #1.

On success or failure, the final `always()` step attempts to save the explicit
allowlist of reports, Gemfile.lock and safe command logs as
`redmine-integration-<run-id>-<attempt>`, retained for **14 days**. It does not
upload OS temporary files, private credentials, raw container logs or raw MCP/seed
diagnostics. Sanitized startup logs and selected container state are included
when available. Missing artifacts are an error; a killed/timed-out runner may not
finish upload. Download the artifact before expiry for long-term evidence.

After a run, check both independent `result.json` files for `result: passed`,
`cleanup: passed`, `ci: true` and `ci_provider: github-actions`, matching the
run ID and tested SHA. The final workflow must also succeed. A workflow merely
being present, or a local test with simulated CI variables, is not CI evidence.

`workflow_dispatch` enables manual runs **after this workflow exists on the
default branch (`main`)**. Then open Actions → Redmine integration tests →
Run workflow and select the branch. The selected branch must contain the
workflow and test files. Until then, use a push to the branch above.

**Real Redmine integration tests are not automatically run for every PR.**
Other branches and pushes to `main` do not match this push filter. #3 can use
manual execution once the workflow is on `main`, or deliberately extend the
branch filter. `.github/workflows/ci.yml` retains #1's PR-triggered tests, and
`publish.yml` is unchanged. Local `pnpm test:integration` remains supported.

#3 can reuse the Compose environment, seed manifest's numeric project ID and
two credential entries, and the MCP Client connection pattern in
`integration/wiki.mjs`. Extend the runner while the disposable environment is
alive; credentials and DB data are intentionally unavailable after cleanup.
Parent/permission/error/version scenarios and their data belong to #3. The
current assertions and the 23 mock-backed tests remain a regression baseline.

## Validation status of this delivery

The authoring environment has no Docker Engine or Ruby runtime and cannot start
containers. Registry digests and pinned source were inspected, but a Redmine
image has **not** been built here and real Redmine API tests have **not** run.
See the accompanying delivery verification record for the exact static and
mock-backed checks performed. A successful pair of local Docker or GHA runs
and their evidence are still required before closing #2. Adding this workflow
does not mean that GHA or real Redmine verification has already succeeded.
