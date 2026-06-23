#!/usr/bin/env bash
set -euo pipefail

tsx watch src/pollerMain.ts &
poller_pid=$!

tsx watch src/server.ts &
server_pid=$!

trap 'kill -TERM "$poller_pid" "$server_pid" 2>/dev/null || true; wait "$poller_pid" "$server_pid" 2>/dev/null || true; exit 0' TERM INT

while true; do
  running="$(jobs -pr)"

  if ! printf '%s\n' "$running" | grep -qx "$poller_pid"; then
    wait "$poller_pid"
    status=$?
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    exit "$status"
  fi

  if ! printf '%s\n' "$running" | grep -qx "$server_pid"; then
    wait "$server_pid"
    status=$?
    kill -TERM "$poller_pid" 2>/dev/null || true
    wait "$poller_pid" 2>/dev/null || true
    exit "$status"
  fi

  sleep 1
done
