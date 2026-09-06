#!/bin/bash
# Start the Qwen Python proxy in the background, fully detached.
set -e

DIR="/home/z/my-project/mini-services/qwen-python"
LOG="/tmp/qwen_py_proxy.log"
PIDFILE="$DIR/qwen_py.pid"

# Kill any existing instance
if [ -f "$PIDFILE" ]; then
  OLDPID=$(cat "$PIDFILE" 2>/dev/null || echo "")
  if [ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null; then
    kill "$OLDPID" 2>/dev/null || true
    sleep 2
    kill -9 "$OLDPID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

cd "$DIR"
# Spawn detached, redirect stdin/stdout/stderr properly
( exec /home/z/.venv/bin/python3 -u qwen_proxy.py --use-default-creds --no-dashboard ) >"$LOG" 2>&1 < /dev/null &
NEWPID=$!
echo "$NEWPID" > "$PIDFILE"
disown $NEWPID

# Give it a moment to start
sleep 2
if kill -0 "$NEWPID" 2>/dev/null; then
  echo "Started qwen_proxy.py with PID $NEWPID"
  echo "Logs: $LOG"
else
  echo "FAILED to start. Log:"
  cat "$LOG"
  exit 1
fi
