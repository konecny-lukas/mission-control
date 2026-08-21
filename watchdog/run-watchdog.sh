#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Cron watchdog — pustí headless Claude agenta, který hodinově kontroluje
# nakonfigurované projekty (mc.config.json modules.watchdog.projects) a
# aplikuje jen bezpečné opravy (viz watchdog/prompt-template.md). Generický
# port z původní interní verze hlídače cronů — JEDINÝ zdroj pravdy pro
# projekty/parametry je config (watchdog/gen.mjs), nikdy natvrdo v tomhle
# skriptu.
#
# Tenhle skript cron řádek SÁM nezakládá — to dělá INSTALL.md (skill
# novy-cron). Příklad:
#   40 * * * * /path/to/mission-control/watchdog/run-watchdog.sh >> /path/to/mission-control/data/watchdog.log 2>&1
#
# `claude -p` v print-módu vypisuje na stdout jen FINÁLNÍ shrnutí agenta ->
# cron log zůstává čistý a Mission Control ho ukáže v panelu HLÍDAČ.
#
# Vždy exit 0 — cron nesmí "selhat" jen proto, že hlídač našel problém
# (o problému se dozvíme z JSONL historie / narativů, ne z exit kódu cronu).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

export HOME="${HOME:-/root}"
export PATH="$HOME/.local/bin:$HOME/.local/share/claude:/usr/local/bin:/usr/bin:/bin:$PATH"

WATCHDOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MC_DIR="$(dirname "$WATCHDOG_DIR")"
# Stejná env-override jména a defaulty jako config.js (NARRATIVE_DIR/
# WATCHDOG_HISTORY) — jediné místo, které je definuje, je config.js; tady se
# jen ZRCADLÍ stejná pravidla, ať bash skript umí najít stejné soubory jako
# Mission Control server bez volání node na každou cestu zvlášť.
DATA_DIR="${MC_DATA_DIR:-$MC_DIR/data}"
NARRATIVE_DIR="${MC_NARRATIVE_DIR:-$DATA_DIR/narrative}"
STATE_DIR="$DATA_DIR/watchdog-state"
mkdir -p "$STATE_DIR" "$NARRATIVE_DIR" 2>/dev/null || true

cd "$MC_DIR" || { echo "[$(date -u +%FT%TZ)] FATAL: $MC_DIR neexistuje"; exit 0; }

if ! command -v claude >/dev/null 2>&1; then
  echo "[$(date -u +%FT%TZ)] WATCHDOG — ALERT"
  echo "watchdog: alert — claude CLI není na PATH ($PATH)"
  echo "akce: žádné"
  echo "alerty: claude binárka nenalezena, hlídač neproběhl"
  exit 0
fi

# Model/rozpočet/timeout: config (mc.config.json modules.watchdog) je default,
# ruční env override (${WATCHDOG_MODEL:-…} vzor) má přednost — stejná sémantika
# jako v původním skriptu, jen defaulty teď táhne gen.mjs z configu místo
# natvrdo napsaných literálů.
GEN_ENV="$(node "$WATCHDOG_DIR/gen.mjs" env)" || GEN_ENV=""
CFG_MODEL="$(printf '%s\n' "$GEN_ENV" | sed -n 's/^WATCHDOG_MODEL=//p')"
CFG_BUDGET="$(printf '%s\n' "$GEN_ENV" | sed -n 's/^WATCHDOG_BUDGET=//p')"
CFG_TIMEOUT="$(printf '%s\n' "$GEN_ENV" | sed -n 's/^WATCHDOG_TIMEOUT=//p')"
CFG_PERM_MODE="$(printf '%s\n' "$GEN_ENV" | sed -n 's/^WATCHDOG_PERMISSION_MODE=//p')"
MODEL="${WATCHDOG_MODEL:-${CFG_MODEL:-sonnet}}"     # sonnet = rozumný poměr cena/úsudek; lze přepnout na opus/haiku
MAX_SECS="${WATCHDOG_TIMEOUT:-${CFG_TIMEOUT:-600}}" # tvrdá pojistka: hlídač se sám nesmí zacyklit (normál 2-4 min)
BUDGET="${WATCHDOG_BUDGET:-${CFG_BUDGET:-1.00}}"    # pojistka proti ujetému běhu, ne reálná útrata
PERM_MODE="${WATCHDOG_PERMISSION_MODE:-${CFG_PERM_MODE:-safe}}" # 'safe' (default) | 'full' — viz blok níž

# ── Fix round 1 (SECURITY, HIGH): oprávnění agenta podle permissionMode ────
# Logy a výstup check.sh můžou nést útočníkem ovlivněný text (např. web
# server log, který sledovaný cron jen tailuje) — headless claude s
# --dangerously-skip-permissions nad tím je prompt-injection → spuštění
# libovolného příkazu. Proto DEFAULT = 'safe': BEZ skip-permissions, jen
# úzký --allowedTools allowlist. 'full' (--dangerously-skip-permissions,
# původní chování) je explicitní opt-in přes mc.config.json
# modules.watchdog.permissionMode: 'full'.
#
# Syntaxe --allowedTools ověřena na nainstalovaném Claude Code CLI (`claude
# --help`, binárka 2.1.237): "Bash(prefix:*)" je legacy PREFIX matching a
# platí VÝHRADNĚ pro nástroj Bash (u ostatních nástrojů `:*` odmítne jako
# neplatné — tam se místo toho používají glob patterny na argument, např.
# soubor). "Bash(přesný příkaz)" bez `*`/`:*` je EXAKTNÍ shoda na celý
# příkazový řetězec. V print/headless módu (-p, žádný TTY) claude nic mimo
# allowlist interaktivně nevyžádá — automaticky to zamítne, což je přesně
# chtěné chování v SAFE módu (žádný kill/rm/pkill/obecný Bash).
if [ "$PERM_MODE" = "full" ]; then
  CLAUDE_PERM_ARGS=(--dangerously-skip-permissions)
else
  PERM_MODE="safe" # neznámá hodnota v configu (typo apod.) padá bezpečně na safe, ne na full
  CHECK_SH_EXACT="bash $MC_DIR/watchdog/check.sh"
  APPEND_SH_PREFIX="bash $MC_DIR/watchdog/append.sh"
  # Fix round 2 (SECURITY): `Bash(echo:*)` byl obecný append kamkoli (např.
  # `echo … >> ~/.ssh/authorized_keys`) a `Bash(systemctl --user:*)` dovoloval
  # i mask/daemon-reload/stop — spolu perzistenční řetěz i uvnitř SAFE módu.
  # Nahrazeno: append.sh validuje cíl (jen "history" nebo nakonfigurovaný
  # watchdog projekt — viz watchdog/append.sh), systemctl zúžen jen na
  # restart+is-active USER jednotek (přesně to, co (B) HLÍDAČ v promptu smí).
  CLAUDE_PERM_ARGS=(
    --allowedTools
    "Read" "Grep" "Glob"
    "Bash($CHECK_SH_EXACT)"              # KROK 1 snapshot — přesně tenhle příkaz, nic jiného
    "Bash($APPEND_SH_PREFIX:*)"          # validovaný append (narativ/historie) — viz watchdog/append.sh
    "Bash(systemctl --user restart:*)"   # jen restart USER jednotek (bezpečné opravy)
    "Bash(systemctl --user is-active:*)" # jen ověření stavu po restartu
  )
fi

# Prompt se REGENERUJE na začátku KAŽDÉHO běhu — config změny (přidaný/
# odebraný projekt, jiný model…) se tak propíšou bez restartu Mission Control.
PROMPT="$(node "$WATCHDOG_DIR/gen.mjs" prompt)"
if [ -z "$PROMPT" ] || [ ! -f "$PROMPT" ]; then
  echo "[$(date -u +%FT%TZ)] WATCHDOG — ALERT"
  echo "watchdog: alert — gen.mjs prompt selhal (žádný vygenerovaný prompt soubor)"
  echo "akce: žádné"
  echo "alerty: watchdog-gen-failed"
  exit 0
fi

echo "──────────────────────────────────────────────────────────────"
echo "[$(date -u +%FT%TZ)] watchdog start (model=$MODEL, timeout=${MAX_SECS}s, budget=\$${BUDGET}, permissionMode=$PERM_MODE)"

# Výstup agenta jde přes tee i do state/last-run-output.log — hlídač hlídače
# z něj pozná, jestli agent vypsal povinné shrnutí „WATCHDOG — OK|FIXED|ALERT"
# (a hodí se pro debug posledního běhu). pipefail => RC je exit claude/timeout.
OUT="$STATE_DIR/last-run-output.log"
timeout "${MAX_SECS}" claude -p "$(cat "$PROMPT")" \
  --model "$MODEL" \
  --max-budget-usd "$BUDGET" \
  "${CLAUDE_PERM_ARGS[@]}" 2>&1 | tee "$OUT"
RC=$?

if [ "$RC" -eq 124 ]; then
  echo "[$(date -u +%FT%TZ)] WATCHDOG — ALERT: agent překročil timeout ${MAX_SECS}s, ukončen"
elif [ "$RC" -ne 0 ]; then
  echo "[$(date -u +%FT%TZ)] WATCHDOG — ALERT: claude skončil s kódem $RC"
fi

# ── Hlídač hlídače: ověř, že běh skutečně zapsal narativ ─────────────────────
# Agent píše do každého narativu řádek "[YYYY-MM-DD HH:MM] …" (lokální čas).
# Když v AKTUÁLNÍ hodině nepřibyl řádek v ŽÁDNÉM nakonfigurovaném narativu,
# běh selhal potichu (např. syntetický běh s 0 tool cally) → zapiš fallback
# řádek do narativů, ať to Mission Control ukáže.
# Když některé narativy chybí, je to legitimní JEN tehdy, když claude doběhl
# ČISTĚ (RC=0) A vypsal povinné shrnutí „WATCHDOG — OK|FIXED|ALERT" (pravidlo
# 💤 v promptu: řádek smí vynechat, jen když o projektu prokazatelně přemýšlel).
# Jinak (chyba, budget kill, nebo RC=0 bez shrnutí = tiché zapomenutí) doplň
# fallback do všech chybějících narativů.
#
# Seznam projektů je na JEDNOM místě (gen.mjs projects čte config) — ne
# natvrdo v tomhle skriptu, ať přidání/odebrání projektu v mc.config.json
# nerozbije podmínku na počet (viz R3 „Nekonzistence k opravě").
HOUR_PREFIX="[$(date '+%Y-%m-%d %H:')"
STAMP_LOCAL="$(date '+%Y-%m-%d %H:%M')"
mapfile -t PROJECTS < <(node "$WATCHDOG_DIR/gen.mjs" projects)
MISSING=()
for N in "${PROJECTS[@]}"; do
  if ! tail -n 8 "$NARRATIVE_DIR/$N.log" 2>/dev/null | grep -Fq "$HOUR_PREFIX"; then
    MISSING+=("$N")
  fi
done
SUMMARY_OK=0
grep -Eq 'WATCHDOG — (OK|FIXED|ALERT)' "$OUT" 2>/dev/null && SUMMARY_OK=1
if [ "${#MISSING[@]}" -gt 0 ] && { [ "$RC" -ne 0 ] || [ "$SUMMARY_OK" -eq 0 ]; }; then
  echo "[$(date -u +%FT%TZ)] ⚠ watchdog běh neúplný (exit=$RC, shrnutí=$([ "$SUMMARY_OK" -eq 1 ] && echo ano || echo chybí)) — fallback řádek do: ${MISSING[*]}"
  for N in "${MISSING[@]}"; do
    echo "[$STAMP_LOCAL] ⚠ watchdog běh selhal (žádný výstup)" >> "$NARRATIVE_DIR/$N.log"
  done
fi

echo "[$(date -u +%FT%TZ)] watchdog konec (exit=$RC)"
exit 0
