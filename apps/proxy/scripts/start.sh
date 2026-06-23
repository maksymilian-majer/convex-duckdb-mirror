#!/usr/bin/env bash
set -euo pipefail

node dist/pollerMain.js &
poller_pid=$!

node dist/server.js &
server_pid=$!

trap 'kill -TERM "$poller_pid" "$server_pid" 2>/dev/null || true; wait "$poller_pid" "$server_pid" 2>/dev/null || true; exit 0' TERM INT

wait -n "$poller_pid" "$server_pid"
exit $?
