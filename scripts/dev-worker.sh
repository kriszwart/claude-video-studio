#!/usr/bin/env bash
# Start/stop a background worker for local development. Usage: scripts/dev-worker.sh start|stop|restart
set -euo pipefail
cd "$(dirname "$0")/.."
PIDFILE=data/worker.pid
LOG=${WORKER_LOG:-data/worker.log}
stop() { if [[ -f $PIDFILE ]]; then kill "$(cat $PIDFILE)" 2>/dev/null || true; rm -f $PIDFILE; fi; }
start() {
  mkdir -p data
  set -a; [[ -f .env ]] && . ./.env; set +a
  nohup node --import tsx apps/worker/src/index.ts >>"$LOG" 2>&1 &
  echo $! > $PIDFILE
  echo "worker started (pid $(cat $PIDFILE)), log: $LOG"
}
case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
esac
