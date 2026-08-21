#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# check.sh — deterministický snapshot stavu pro watchdog (krok 1 promptu).
# Generický port z původní interní verze hlídače cronů (jen obecné sekce) —
# BEZ klientských/projektových sond. Ty žijí v mc.config.json
# modules.watchdog.projects[].sources jako volný text „zdroje pravdy", který
# gen.mjs vloží do promptu jako tabulku — hlídač si na ně sáhne sám, jen když
# je bude potřebovat; tenhle snapshot je nevypisuje natvrdo.
#
# Jediný sběr dat pro hodinový watchdog běh: VŽDY končí exit 0 a vypisuje
# strukturované sekce — žádné falešné ERRORy z ls/grep na zdravém stavu
# (chybějící lock = „none (idle — OK)", ne exit 2).
#
# Nové řádky logů čte od offsetu z minulého běhu (data/watchdog-state/
# offsets.json, aktualizuje log_offsets.py) — „beze změny" znamená, že v logu
# opravdu nic nepřibylo, staré tails se nečtou dokola.
#
# POZOR: posouvá byte-offsety sledovaných logů — smí se v JEDNOM watchdog
# běhu spustit jen JEDNOU (run-watchdog.sh ho volá přesně 1×). Ruční spuštění
# je bezpečné (jen čte + posune vlastní offsety), ale druhé spuštění hned po
# sobě už nic nového neukáže ("beze změny").
# ─────────────────────────────────────────────────────────────────────────────
set -u

WATCHDOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MC_DIR="$(dirname "$WATCHDOG_DIR")"
# Stejná env-override jména a defaulty jako config.js (NARRATIVE_DIR/
# WATCHDOG_HISTORY) — viz run-watchdog.sh hlavička, stejná poznámka platí tady.
DATA_DIR="${MC_DATA_DIR:-$MC_DIR/data}"
NARRATIVE_DIR="${MC_NARRATIVE_DIR:-$DATA_DIR/narrative}"
WATCHDOG_HISTORY="${MC_WATCHDOG_HISTORY:-$DATA_DIR/watchdog-history.jsonl}"
STATE_DIR="$DATA_DIR/watchdog-state"
mkdir -p "$STATE_DIR" 2>/dev/null || true

echo "═══════════════ WATCHDOG SNAPSHOT ═══════════════"
echo "čas: UTC $(date -u '+%F %T') | lokální $(date '+%F %T %Z') | $(date '+%A')"
echo "cesty: narrativní logy = $NARRATIVE_DIR | historie = $WATCHDOG_HISTORY"

# ── systemd failed jednotky ──────────────────────────────────────────────────
echo ""
echo "--- systemd failed jednotky ---"
SYS_FAILED="$(systemctl list-units --state=failed --no-legend --plain 2>/dev/null | sed 's/^[[:space:]]*//' || true)"
if [ -n "$SYS_FAILED" ]; then
  echo "system:"
  echo "$SYS_FAILED" | sed 's/^/    /'
else
  echo "system: žádné failed jednotky (OK)"
fi
USR_FAILED="$(XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" systemctl --user list-units --state=failed --no-legend --plain 2>&1 | sed 's/^[[:space:]]*//' || true)"
if echo "$USR_FAILED" | grep -qi 'failed to connect'; then
  echo "user: bus nedostupný (běžné na headless serveru bez systemd --user session — NENÍ chyba)"
elif [ -n "$USR_FAILED" ]; then
  echo "user:"
  echo "$USR_FAILED" | sed 's/^/    /'
else
  echo "user: žádné failed jednotky (OK)"
fi

# ── disk ─────────────────────────────────────────────────────────────────────
echo ""
echo "--- disk ---"
df -h / 2>/dev/null || true

# ── aktivní crontab ──────────────────────────────────────────────────────────
echo ""
echo "--- aktivní crony (crontab -l bez komentářů) ---"
crontab -l 2>/dev/null | grep -vE '^[[:space:]]*(#|$)' || echo "(crontab nedostupný nebo prázdný)"

# ── narativní logy (pro vypravěče — navaž, neopakuj se) ──────────────────────
echo ""
echo "--- narativní logy (poslední 3 řádky každého — navaž na ně) ---"
mapfile -t PROJECTS < <(node "$WATCHDOG_DIR/gen.mjs" projects)
if [ "${#PROJECTS[@]}" -eq 0 ]; then
  echo "(žádné projekty v mc.config.json modules.watchdog.projects — nic k vypravění)"
fi
for N in "${PROJECTS[@]}"; do
  echo "· $NARRATIVE_DIR/$N.log:"
  tail -n 3 "$NARRATIVE_DIR/$N.log" 2>/dev/null | sed 's/^/    /' || true
done

# ── historie hlídače (recyklace alert id) ────────────────────────────────────
echo ""
echo "--- watchdog-history.jsonl (poslední 3 řádky — recykluj alert id) ---"
tail -n 3 "$WATCHDOG_HISTORY" 2>/dev/null || echo "(historie zatím prázdná)"

# ── nové řádky sledovaných logů ──────────────────────────────────────────────
echo ""
echo "--- nové řádky sledovaných logů od minulého běhu ---"
LOGS=()
# redirect cíle všech aktivních cronů (za `>>`), bez /dev/null a .remember
# (paměťový adresář Claude Code pluginu remember — psaný samostatně, ne cron log)
while IFS= read -r P; do LOGS+=("$P"); done < <(
  crontab -l 2>/dev/null \
    | grep -vE '^[[:space:]]*#' \
    | grep -oE '>>[[:space:]]*[^[:space:]]+' \
    | sed -E 's/^>>[[:space:]]*//' \
    | grep -v '^/dev/null$' \
    | grep -v '\.remember/' \
    | sort -u
)
python3 "$WATCHDOG_DIR/log_offsets.py" "$STATE_DIR/offsets.json" "${LOGS[@]}" \
  || echo "(log_offsets.py selhal — offsety nezměněny, prohlédni logy ručně)"

echo "═══════════════ KONEC SNAPSHOTU ═══════════════"
exit 0
