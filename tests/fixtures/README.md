# Wiki response fixtures

These are source-derived examples, **not HTTP captures from a running Redmine**.
The fixture IDs, status, explicit headers and body are in `wiki-responses.json`.
Every fixture lists source IDs from the table below. Record actual deployment
differences when #2 / #3 supply relevant real-Redmine observations; this suite
does not claim that all responses have been measured on a real server.

The Redmine source is pinned to `f7ea71f9563ea7b346a8dbc7abb3854fc69321ea`
(7.0.2.devel); Rails sources are pinned to `v8.1.4`. Application values such as
IDs, titles, timestamps and the validation message are illustrative test data.
The error message is not a locale-independent assertion about Redmine's wording.
Only `html-403` is a synthetic response for a custom-code branch.

| Source ID | Source and relevant processing |
| --- | --- |
| `wiki-show` | [wiki_controller.rb, show, lines 87–101](https://github.com/redmine/redmine/blob/f7ea71f9563ea7b346a8dbc7abb3854fc69321ea/app/controllers/wiki_controller.rb#L87-L101): API lookup and missing-content 404. |
| `wiki-update` | [wiki_controller.rb, update, lines 157–216](https://github.com/redmine/redmine/blob/f7ea71f9563ea7b346a8dbc7abb3854fc69321ea/app/controllers/wiki_controller.rb#L157-L216): new page 201, existing page 204, validation 422 and stale-content 409. |
| `wiki-view` | [show.api.rsb](https://github.com/redmine/redmine/blob/f7ea71f9563ea7b346a8dbc7abb3854fc69321ea/app/views/wiki/show.api.rsb): Wiki JSON fields, optional parent and attachments. |
| `api-error` | [application_controller.rb, lines 614–640](https://github.com/redmine/redmine/blob/f7ea71f9563ea7b346a8dbc7abb3854fc69321ea/app/controllers/application_controller.rb#L614-L640): 403 / 404 go through `render_error`, non-HTML requests use `head`. |
| `api-head` | [application_controller.rb, lines 807–815](https://github.com/redmine/redmine/blob/f7ea71f9563ea7b346a8dbc7abb3854fc69321ea/app/controllers/application_controller.rb#L807-L815): `render_api_ok` / `render_api_head`. |
| `api-validation` | [application_controller.rb, lines 817–827](https://github.com/redmine/redmine/blob/f7ea71f9563ea7b346a8dbc7abb3854fc69321ea/app/controllers/application_controller.rb#L817-L827): errors are collected from the content object and rendered with 422. |
| `errors-view` | [error_messages.api.rsb](https://github.com/redmine/redmine/blob/f7ea71f9563ea7b346a8dbc7abb3854fc69321ea/app/views/common/error_messages.api.rsb): JSON errors array, including an empty array. |
| `rails-head` | [head.rb, lines 23–67](https://github.com/rails/rails/blob/v8.1.4/actionpack/lib/action_controller/metal/head.rb#L23-L67): format-derived content type and `charset = false` for 403 / 404 / 409. |
| `rails-response` | [response.rb](https://github.com/rails/rails/blob/v8.1.4/actionpack/lib/action_dispatch/http/response.rb), charset handling (329–336), normal content-type defaults, and `handle_no_content!` (588–593): JSON responses use UTF-8; `head` removes charset; 204 removes Content-Type. |
| `custom-fetch` | [custom-fetch.ts](https://github.com/onozaty/redmine-mcp-server/blob/7345677c1020ace42b4eefab5070b6c2190d7b4e/src/api/custom-fetch.ts): non-2xx `text/html` throws with status, URL and the first 200 body characters. |

For the head responses, the request format is `.json` and there is no content-type
override. The 204 fixture has an empty body and no Content-Type. The 403, 404 and
409 fixtures have an empty body and exactly `application/json` without charset.
The mock HTTP server may add transport headers such as Date or Connection; they
are not claims about Redmine's entire response header set.

The OpenAPI 409 error-JSON definition is deliberately not used as a fixture:
the pinned controller sends an empty body. The generated client turns an empty
body into `{}` and serializes the Response's Headers object as `{}`. Consequently
the current MCP result text is `{"data":{},"status":409,"headers":{}}`, without
`isError: true`. This is measured by the mock-backed MCP test, not by real Redmine.

`html-403` is a deliberately invented, non-2xx HTML response longer than 200
characters. It checks the exception and truncation implemented by `customFetch`
and the SDK's `isError: true` tool result. It does not model a measured Redmine
response and does not share the provenance of the API fixtures.
