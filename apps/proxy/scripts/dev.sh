#!/usr/bin/env bash
set -euo pipefail

tsx watch src/pollerMain.ts &
poller_pid=$!

tsx watch src/server.ts &
server_pid=$!

trap 'kill -TERM "$poller_pid" "$server_pid" 2>/dev/null || true; wait "$poller_pid" "$server_pid" 2>/dev/null || true; exit 0' TERM INT

wait -n "$poller_pid" "$server_pid"
exit $?
