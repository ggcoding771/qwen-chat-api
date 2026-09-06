#!/usr/bin/env bash
# Manage the deepseek-proxy mini-service.
# Usage: ./manage.sh start | stop | restart | status

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$DIR/proxy.pid"
LOGFILE="$DIR/proxy.log"
BIN="bun"
SCRIPT="$DIR/index.ts"

is_running() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start() {
  if is_running; then
    echo "already running (pid $(cat "$PIDFILE"))"
    return 0
  fi
  # Stale pidfile?
  rm -f "$PIDFILE"
  # Kill any stale process on port 3032
  local stale_pid
  stale_pid=$(ss -tlnp 2>/dev/null | grep ':3032' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  if [ -n "$stale_pid" ]; then
    echo "killing stale process $stale_pid on port 3032…"
    kill -9 "$stale_pid" 2>/dev/null || true
    sleep 2
  fi
  echo "starting deepseek-proxy…"
  # Source .env if present so credentials are available to bun.
  if [ -f "$DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$DIR/.env"
    set +a
  fi
  setsid bash -c "cd '$DIR' && $BIN run '$SCRIPT' > '$LOGFILE' 2>&1 & echo \$! > '$PIDFILE'" < /dev/null > /dev/null 2>&1
  disown 2>/dev/null || true
  # Wait for ready (check for status:ok, not just HTTP 200)
  for i in $(seq 1 45); do
    sleep 1
    local health
    health=$(curl -sf --max-time 2 http://localhost:3032/health 2>/dev/null || echo "")
    if echo "$health" | grep -q '"status":"ok"'; then
      echo "ready (pid $(cat "$PIDFILE"))"
      return 0
    fi
    if grep -q "FAILED" "$LOGFILE" 2>/dev/null; then
      echo "FAILED — see $LOGFILE"
      tail -5 "$LOGFILE"
      return 1
    fi
  done
  echo "timeout waiting for health — log tail:"
  tail -10 "$LOGFILE"
  return 1
}

stop() {
  if ! is_running; then
    echo "not running"
    rm -f "$PIDFILE"
    return 0
  fi
  local pid
  pid="$(cat "$PIDFILE")"
  echo "stopping pid $pid…"
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 8); do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  echo "stopped"
}

status() {
  if is_running; then
    echo "running (pid $(cat "$PIDFILE"))"
    curl -sf --max-time 2 http://localhost:3032/health 2>/dev/null || echo "(health check failed)"
    return 0
  fi
  echo "not running"
  return 1
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|restart|status}"; exit 1 ;;
esac
