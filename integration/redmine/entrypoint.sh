#!/bin/sh
set -eu
test "${MCP_INTEGRATION_ENV:-}" = wiki-only-disposable
umask 077
if [ "${1:-server}" = seed ]; then
  # docker exec does not inherit variables exported by the server process.
  . /tmp/mcp-integration-environment
  exec bundle exec rails runner /opt/integration/seed.rb
fi
# No credentials are supplied by the host. This key belongs only to this server.
export SECRET_KEY_BASE="$(ruby -rsecurerandom -e 'print SecureRandom.hex(64)')"
printf 'export SECRET_KEY_BASE=%s\n' "$SECRET_KEY_BASE" > /tmp/mcp-integration-environment
bundle exec rake db:migrate
bundle exec rake assets:precompile
exec bundle exec rails server -b 0.0.0.0 -p 3000
