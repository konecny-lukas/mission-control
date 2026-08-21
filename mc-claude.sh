#!/usr/bin/env bash
# Spouští ttyd s projektovým klíčem jako $1 a volitelným číslem session jako $2
# (z ?arg=<key>&arg=<n>). Mapuje povolený klíč -> adresář a připojí se k (nebo
# vytvoří) PERZISTENTNÍ tmux session s Claude Code. Ve výchozí instalaci běží
# jako přihlášený uživatel (celý jeho $HOME) — stejná důvěra jako zbytek
# Mission Control na tomhle tailnetu. Pokročilá sandboxová varianta s
# dedikovaným uživatelem `mc` (jen /srv, ProtectSystem=strict) je volitelná,
# viz INSTALL.md.
#
# Persistence: Claude běží v tmux session `mc-<key>-<sid>` na socketu -L mc.
# Zavření tabu jen detachne; session (a Claude) běží dál. Session zničí jen
# explicitní „Ukončit" (server -> tmux kill-session). Jen $1 přes allowlist
# bin/mc-project.mjs (jediný zdroj = config.js CFG.terminals.projects, sdílený
# se serverem i UI; neznámý klíč = exit 1) + MC_INNER env, který URL arg
# nezfalšuje — z webu nelze vnutit cestu/flag.
export HOME="${MC_AGENT_HOME:-$HOME}"
export PATH="$HOME/.local/bin:$HOME/.local/share/claude:/usr/local/bin:/usr/bin:/bin"
export TERM=xterm-256color

# Vlastní adresář skriptu (funguje bez ohledu na to, odkud je vyvolán) — odsud
# se dohledá bin/mc-project.mjs i mc-tmux.conf; jediný zdroj mapování klíč->adresář
# je teď config.js (CFG.terminals.projects), ne tenhle skript.
MC_DIR="$(cd "$(dirname "$0")" && pwd)"

key="${1:-home}"
sid="${2:-1}"
case "$sid" in (''|*[!0-9]*) sid=1 ;; esac
[ "${#sid}" -gt 3 ] && sid=1

dir="$(node "$MC_DIR/bin/mc-project.mjs" dir "$key" 2>/dev/null)" || { echo "Neznámý projekt: $key"; sleep 3; exit 1; }
name="$key"

cd "$dir" || { echo "Adresář neexistuje: $dir"; sleep 3; exit 1; }

# --- inner: běží UVNITŘ tmux session, vlastní Claude proces ---
if [ "$MC_INNER" = "1" ]; then
  clear
  printf '\033[38;5;51m▣ Claude Code · %s\033[0m \033[38;5;39m#%s\033[0m  \033[38;5;245m%s\033[0m\n' "$name" "$sid" "$dir"
  printf '\033[38;5;245m  (perzistentní session%s)\033[0m\n' "${MC_TERM_CLAUDE_ARGS:+ · $MC_TERM_CLAUDE_ARGS}"
  printf '\033[38;5;245m  Ukázat soubor v prohlížeči: \033[38;5;180mmc-open <soubor>\033[38;5;245m  ·  složku/web: \033[38;5;180mmc-preview add <slug> --static <dir>\033[0m\n\n'
  exec claude ${MC_TERM_CLAUDE_ARGS:-}
fi

# --- outer: jeden na ttyd spojení. Attach-or-create session. ---
exec tmux -L mc -f "$MC_DIR/mc-tmux.conf" \
  new-session -A -s "mc-${key}-${sid}" -e MC_INNER=1 -c "$dir" "$0" "$key" "$sid"
