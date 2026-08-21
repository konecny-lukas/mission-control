#!/usr/bin/env bash
# mc-safe-restart — restart mission-control.service BEZ rizika zabití uživatelských
# tmux sessions.
#
# Incident (zdrojový systém, 2026-06-10 20:36): tmux server (socket -L mc) tehdy
# žil v cgroupě mission-control.service (spawn ze servisního procesu), takže
# `systemctl --user restart mission-control` zabil VŠECHNY uživatelské terminálové
# sessions. Tenhle wrapper proto:
#   1. najde tmux server proces a ověří, že NENÍ v cgroupě mission-control.service
#      (jinak ABORT — restart by ho vzal s sebou),
#   2. zapamatuje si seznam sessions PŘED restartem,
#   3. restartuje službu a počká na /api/health,
#   4. ověří, že seznam sessions je beze změny (jinak exit 1 + diff).
#
# Použití: bin/mc-safe-restart.sh   (žádné argumenty)
# Env (přepis defaultů — pro jinou instalaci/testy):
#   MC_SERVICE      název systemd --user jednotky (default mission-control)
#   MC_TMUX_SOCKET  tmux -L socket terminálů (default mc)
#   MC_PORT         port serveru pro health-check (default 8088)
set -euo pipefail

SVC=${MC_SERVICE:-mission-control}
SOCKET=${MC_TMUX_SOCKET:-mc}
HEALTH_URL="http://127.0.0.1:${MC_PORT:-8088}/api/health"

sessions() { tmux -L "$SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | sort || true; }

# --- 1) cgroup check ---------------------------------------------------------
P=$(pgrep -f "tmux.*-L ${SOCKET}" | head -1 || true)
if [ -n "$P" ]; then
  if grep -q "${SVC}\.service" "/proc/$P/cgroup"; then
    {
      echo "✕ ABORT: tmux server (pid $P) žije v cgroupě ${SVC}.service —"
      echo "  restart služby by zabil uživatelské tmux sessions (incident 20:36)."
      echo "  Nejdřív tmux server přesuň mimo službu (spawnout z user session,"
      echo "  ne ze servisního procesu). Aktuální cgroup:"
      cat "/proc/$P/cgroup"
    } >&2
    exit 1
  fi
fi

# --- 2) sessions před --------------------------------------------------------
BEFORE=$(sessions)
BEFORE_N=$(printf '%s' "$BEFORE" | grep -c . || true)
echo "· tmux sessions před restartem: ${BEFORE_N}"

# --- 3) restart + health -----------------------------------------------------
systemctl --user restart "$SVC"
HEALTH=
for _ in $(seq 1 30); do
  if node -e "fetch('$HEALTH_URL').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    HEALTH=ok; break
  fi
  sleep 1
done
if [ "$HEALTH" != ok ]; then
  echo "✕ služba ${SVC} po restartu neodpovídá na ${HEALTH_URL} (30 s)" >&2
  exit 1
fi

# --- 4) sessions po ----------------------------------------------------------
AFTER=$(sessions)
AFTER_N=$(printf '%s' "$AFTER" | grep -c . || true)
if [ "$BEFORE" != "$AFTER" ]; then
  {
    echo "✕ TMUX SESSIONS SE ZMĚNILY (${BEFORE_N} -> ${AFTER_N}):"
    diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") || true
  } >&2
  exit 1
fi
echo "✓ ${SVC} restartována, /api/health OK, tmux sessions beze změny (${AFTER_N})"
