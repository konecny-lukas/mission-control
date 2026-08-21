#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# append.sh <target> <text…> — validovaný appender pro headless watchdog
# agenta v SAFE módu (viz run-watchdog.sh CLAUDE_PERM_ARGS).
#
# PROČ: obecné `Bash(echo:*)` v allowlistu dovolovalo agentovi (byť jen pod
# prompt-injection z logu, který sleduje) `echo … >> ~/.ssh/authorized_keys`
# nebo cokoli jiného — echo neví, KAM smí zapisovat. Tenhle skript zná jen
# dva legitimní cíle a nic jiného nepustí:
#   history    -> $WATCHDOG_HISTORY  (append JSON řádku hlídače)
#   <proj-id>  -> $NARRATIVE_DIR/<proj-id>.log  (append narativního řádku),
#                 proj-id MUSÍ být mezi projekty z `node gen.mjs projects`
#                 (aktuální mc.config.json modules.watchdog.projects) A sedět
#                 na stejný regex jako WATCHDOG_PROJECTS filtr v config.js
#                 (^[a-z0-9-]{1,32}$) — dvojitá pojistka, ne buď/nebo.
#
# Cesty se odvozují STEJNĚ jako run-watchdog.sh/check.sh (MC_DATA_DIR/
# MC_NARRATIVE_DIR/MC_WATCHDOG_HISTORY env override, jinak <MC_DIR>/data/...).
# set -u (chybějící argument = chyba, ne tichý no-op) a žádný eval — target i
# text jdou jako obyčejné argv, nikdy se nevykonávají jako shell.
# ─────────────────────────────────────────────────────────────────────────────
set -u

WATCHDOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MC_DIR="$(dirname "$WATCHDOG_DIR")"
DATA_DIR="${MC_DATA_DIR:-$MC_DIR/data}"
NARRATIVE_DIR="${MC_NARRATIVE_DIR:-$DATA_DIR/narrative}"
WATCHDOG_HISTORY="${MC_WATCHDOG_HISTORY:-$DATA_DIR/watchdog-history.jsonl}"

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "append.sh: použití: append.sh <history|projekt-id> <text…>" >&2
  exit 1
fi
shift
TEXT="$*"
if [ -z "$TEXT" ]; then
  echo "append.sh: chybí text k připojení" >&2
  exit 1
fi

if [ "$TARGET" = "history" ]; then
  DEST="$WATCHDOG_HISTORY"
else
  if ! [[ "$TARGET" =~ ^[a-z0-9-]{1,32}$ ]]; then
    echo "append.sh: neplatný target '$TARGET' (musí být 'history' nebo kebab-case id 1-32 znaků)" >&2
    exit 1
  fi
  # target musí být SKUTEČNÝ nakonfigurovaný projekt, ne jen id tvarem sedící
  # na regex — jinak by šlo zapisovat kamkoli pod NARRATIVE_DIR jako <cokoli>.log
  if ! node "$WATCHDOG_DIR/gen.mjs" projects | grep -qxF "$TARGET"; then
    echo "append.sh: neznámý watchdog projekt '$TARGET' (není v mc.config.json modules.watchdog.projects)" >&2
    exit 1
  fi
  DEST="$NARRATIVE_DIR/$TARGET.log"
fi

mkdir -p "$(dirname "$DEST")" 2>/dev/null || true
printf '%s\n' "$TEXT" >> "$DEST"
