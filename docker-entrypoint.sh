#!/bin/sh
# Starts an embedded Redis inside the container when no external REDIS_URL is given
# (single-container hosts such as Render). Set EMBEDDED_REDIS=0 to disable.
set -e
if [ -z "$REDIS_URL" ] && [ "${EMBEDDED_REDIS:-1}" = "1" ]; then
  PORT_R="${EMBEDDED_REDIS_PORT:-6379}"
  redis-server --bind 127.0.0.1 --port "$PORT_R" --protected-mode yes \
    --save "" --appendonly no --maxmemory 64mb --maxmemory-policy allkeys-lru \
    --daemonize yes --pidfile /tmp/redis.pid --logfile /tmp/redis.log
  # wait (max ~5 s) until it answers
  i=0
  until redis-cli -p "$PORT_R" ping >/dev/null 2>&1 || [ $i -ge 50 ]; do i=$((i + 1)); sleep 0.1; done
  export REDIS_URL="redis://127.0.0.1:$PORT_R"
  echo "embedded redis on 127.0.0.1:$PORT_R"
fi
exec "$@"
