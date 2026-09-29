#!/usr/bin/env bash
# Start/stop the Next.js dev server in the background (binds 127.0.0.1 by default).
set -euo pipefail
cd "$(dirname "$0")/.."
PIDFILE=data/web.pid
LOG=${WEB_LOG:-data/web.log}
stop() { if [[ -f $PIDFILE ]]; then kill "$(cat $PIDFILE)" 2>/dev/null || true; rm -f $PIDFILE; fi; }
start() {
  mkdir -p data
  set -a; [[ -f .env ]] && . ./.env; set +a
  (cd apps/web; nohup npx next dev --hostname "${HOST:-127.0.0.1}" --port "${PORT:-3000}" >>"../../$LOG" 2>&1 & echo $! > "../../$PIDFILE")
  echo "web started (pid $(cat $PIDFILE)) on http://${HOST:-127.0.0.1}:${PORT:-3000}, log: $LOG"
}
case "${1:-start}" in start) start ;; stop) stop ;; restart) stop; sleep 1; start ;; esac
