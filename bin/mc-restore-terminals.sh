#!/usr/bin/env bash
# mc-restore-terminals — jednorázová obnova MC terminálů po pádu tmux serveru.
#
# Scénář (zdrojový systém, naposledy 2026-06-28 ~23:39): celý tmux server na
# socketu `-L mc` zhebne (OOM apod.) → zmizí VŠECHNY terminálové sessions
# naráz. Jména ale přežívají v data/term-labels.json a konverzace na disku
# v ~/.claude/projects/<escapovaná-cesta>/<uuid>.jsonl. Tenhle skript:
#
#   1. pro KAŽDÝ záznam v data/term-labels.json ověří, že session mc-<key>-<sid>
#      existuje; chybějící vytvoří DETACHED s obyčejným shellem v adresáři
#      projektu (schválně NE rovnou claude --resume — auto-výběr špatného uuid
#      by připojil cizí konverzaci a víc Claudů naráz by sežralo RAM),
#   2. vypíše kandidátní .jsonl konverzace (nejnovější první) + PŘESNÝ příkaz
#      `claude --resume <uuid>`, který se spustí UVNITŘ session.
#
# IDEMPOTENTNÍ: existujících sessions se NEDOTÝKÁ, nikdy nic nezabíjí.
# Jména se re-aplikují (set-option @mc_label) — collector by je do pár vteřin
# obnovil sám, tady jsou vidět hned.
#
# Závislost: jq (parsuje term-labels.json i výpis prvního promptu z .jsonl).
# Bez něj skript hned skončí se srozumitelnou chybou.
#
# Použití:  bin/mc-restore-terminals.sh [--dry-run]
#   --dry-run  jen vypíše, co by se stalo (nic nevytváří)
# Env (přepis defaultů — pro jinou instalaci/testy):
#   MC_TERM_LABELS       cesta k term-labels.json (jinak <MC>/data/term-labels.json —
#                         musí sedět s config.js:TERM_LABELS_FILE)
#   MC_TMUX_SOCKET        tmux -L socket terminálů (default mc)
#   CLAUDE_PROJECTS_DIR   kořen Claude Code projektů (default $HOME/.claude/projects)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MC="$(dirname "$SCRIPT_DIR")"
TMUX=/usr/bin/tmux
SOCKET="${MC_TMUX_SOCKET:-mc}"
CONF="$MC/mc-tmux.conf"
LABELS="${MC_TERM_LABELS:-$MC/data/term-labels.json}"
PROJROOT="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

command -v jq >/dev/null || { echo "✕ chybí jq (nutná závislost tohoto skriptu — nainstaluj přes balíčkovací systém)"; exit 1; }
[ -f "$LABELS" ] || { echo "✕ labels soubor neexistuje: $LABELS"; exit 1; }

echo "mc-restore-terminals — $( [ $DRY = 1 ] && echo 'DRY RUN (nic se nevytváří)' || echo 'obnova' )"
echo "labels: $LABELS"
echo

existed=0; created=0; skipped=0

while IFS=$'\t' read -r sess label; do
  [ -n "$sess" ] || continue
  if [[ ! "$sess" =~ ^mc-([a-z0-9]+)-([0-9]+)$ ]]; then
    echo "· $sess — nesedí na vzor mc-<key>-<sid>, přeskakuji"; skipped=$((skipped+1)); continue
  fi
  key="${BASH_REMATCH[1]}"; sid="${BASH_REMATCH[2]}"

  # adresář projektu — stejný zdroj pravdy jako mc-claude.sh (builtiny + custom)
  dir="$(node "$MC/bin/mc-project.mjs" dir "$key" 2>/dev/null || true)"
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    echo "⚠ $sess („$label“) — neznámý/neexistující adresář projektu „$key“, používám \$HOME"
    dir="$HOME"
  fi

  if "$TMUX" -L "$SOCKET" has-session -t "=$sess" 2>/dev/null; then
    echo "✓ $sess („${label:-bez jména}“) — BĚŽÍ, nesahám"
    existed=$((existed+1))
  else
    if [ $DRY = 1 ]; then
      echo "＋ $sess („${label:-bez jména}“) — chybí, VYTVOŘILA by se detached shell session v $dir"
    else
      "$TMUX" -L "$SOCKET" -f "$CONF" new-session -d -s "$sess" -c "$dir"
      [ -n "$label" ] && "$TMUX" -L "$SOCKET" set-option -t "$sess" @mc_label "$label"
      echo "＋ $sess („${label:-bez jména}“) — vytvořena detached (shell v $dir)"
    fi
    created=$((created+1))

    # kandidátní konverzace: ~/.claude/projects/<escapovaná cesta>/*.jsonl
    # (escapování Claude Code: každý ne-alfanumerický znak cesty → '-')
    esc="$(printf '%s' "$dir" | tr -c 'a-zA-Z0-9' '-')"
    pdir="$PROJROOT/$esc"
    if [ -d "$pdir" ] && ls "$pdir"/*.jsonl >/dev/null 2>&1; then
      echo "   kandidátní konverzace (nejnovější první — vyber podle prvního promptu):"
      n=0
      while IFS= read -r f; do
        n=$((n+1)); [ $n -gt 3 ] && break
        uuid="$(basename "$f" .jsonl)"
        mt="$(date -r "$f" '+%d.%m. %H:%M')"
        # první skutečný user prompt (best-effort; dlouhé řádky useknuté headem jq tiše přeskočí)
        excerpt="$(head -n 40 "$f" | jq -r 'select(.type=="user" and .isMeta!=true) | .message.content | if type=="string" then . else ([.[]?|select(.type=="text")|.text]|join(" ")) end' 2>/dev/null | grep -v '^\s*$' | head -n1 | tr -d '\n' | cut -c1-100 || true)"
        echo "     $n) $mt  $uuid"
        [ -n "$excerpt" ] && echo "        „${excerpt}…“"
      done < <(ls -t "$pdir"/*.jsonl 2>/dev/null)
      newest="$(basename "$(ls -t "$pdir"/*.jsonl 2>/dev/null | head -n1)" .jsonl)"
      echo "   → obnova (v terminálu, nebo přes MC drawer projektu „$key“, session #$sid):"
      echo "     tmux -L $SOCKET attach -t $sess"
      echo "     a uvnitř:  claude --resume $newest"
    else
      echo "   (žádné .jsonl v $pdir — konverzaci hledej ručně v $PROJROOT)"
    fi
  fi
done < <(jq -r 'to_entries[] | [.key, .value] | @tsv' "$LABELS")

echo
echo "── hotovo: $existed běželo, $created $( [ $DRY = 1 ] && echo 'by se vytvořilo' || echo 'vytvořeno' ), $skipped přeskočeno ──"
if [ $DRY = 0 ] && [ $created -gt 0 ]; then
  echo "Sessions jsou zatím jen shell — Claude nastartuj příkazy výš (klidně po dávkách,"
  echo "každá MC Claude session zabere řádově stovky MB RAM — hlídej 'free -h')."
fi
