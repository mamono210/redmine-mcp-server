#!/bin/sh
set -eu
stage=environment_check
trap 'status=$?; if [ "$status" -ne 0 ]; then printf "[redmine-startup] failed stage=%s exit=%s\n" "$stage" "$status" >&2; fi' 0
printf '[redmine-startup] stage=%s\n' "$stage"
test "${MCP_INTEGRATION_ENV:-}" = wiki-only-disposable
umask 077
if [ "${1:-server}" = seed ]; then
  stage=fixture_initialization
  printf '[redmine-startup] stage=%s\n' "$stage"
  # docker exec does not inherit variables exported by the server process.
  . /tmp/mcp-integration-environment
  exec bundle exec rails runner /opt/integration/seed.rb
fi
# No credentials are supplied by the host. This key belongs only to this server.
stage=session_initialization
printf '[redmine-startup] stage=%s\n' "$stage"
export SECRET_KEY_BASE="$(ruby -rsecurerandom -e 'print SecureRandom.hex(64)')"
printf 'export SECRET_KEY_BASE=%s\n' "$SECRET_KEY_BASE" > /tmp/mcp-integration-environment
stage=db_migrate
printf '[redmine-startup] stage=%s\n' "$stage"
bundle exec rake db:migrate
stage=assets_precompile
printf '[redmine-startup] stage=%s\n' "$stage"
bundle exec rake assets:precompile
stage=rails_server
printf '[redmine-startup] stage=%s\n' "$stage"
exec bundle exec rails server -b 0.0.0.0 -p 3000
