#!/usr/bin/env bash
# Start the dev proxy, loading a saved session cookie if present.
set -euo pipefail
cd "$(dirname "$0")"

if [ -f session.env ]; then
	set -a
	# shellcheck disable=SC1091
	. ./session.env
	set +a
	echo "session.env loaded: injecting ${SESSION_COOKIE_NAME:-appSession} cookie for cookie-less requests"
else
	echo "no session.env: no cookie injection (copy session.env.example after first login)"
fi

exec caddy run --config Caddyfile
