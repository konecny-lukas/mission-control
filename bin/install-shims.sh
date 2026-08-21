#!/usr/bin/env bash
# bin/install-shims.sh — nainstaluje `mc-open` a `mc-preview` do ~/.local/bin,
# ať jdou volat odkudkoli (z terminálu, z Jarvise) bez plné cesty k appce.
# ABS_MC_DIR se odvodí z umístění TOHOTO skriptu, takže funguje i po přesunu
# repa jinam — stačí skript spustit znovu.
#
# Idempotentní: opakované spuštění jen přepíše shimy stejným obsahem.
#
# Použití: bin/install-shims.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MC_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$HOME/.local/bin"

mkdir -p "$BIN_DIR"

install_shim() {
  local name="$1" target="$2"
  cat > "$BIN_DIR/$name" <<EOF
#!/usr/bin/env bash
# Mission Control — CLI $name. Viz: $name help
exec node "$MC_DIR/$target" "\$@"
EOF
  chmod +x "$BIN_DIR/$name"
  echo "✓ $BIN_DIR/$name -> node $MC_DIR/$target"
}

install_shim mc-open mc-open.js
install_shim mc-preview mc-preview.js

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "⚠ $BIN_DIR není v PATH — přidej do svého shell rc:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
