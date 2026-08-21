#!/usr/bin/env bash
# Vytvoří a nabootuje zpevněný Hetzner Cloud VPS pro Mission Control přes
# Hetzner Cloud API.
#
# POZOR — kde tohle běží: skript spouštíš na SVÉM stroji (operátor), ne na
# cílovém VPS ani na žádném boxu, kde už Mission Control běží. Používá plný
# `curl -sS -o -w` — pokud je tvůj `curl` jen omezený shim bez -w/-o/-d@,
# ověř si nejdřív `curl --help all | grep -- '-w,'`, jinak selže na `hapi()` níž.
#
# Použití:
#   HCLOUD_TOKEN=... MC_NAME=acme ./install/provision-hetzner.sh
# nebo token v ~/.hcloud_token (chmod 600), pak jen:
#   MC_NAME=acme ./install/provision-hetzner.sh
#
# Env:
#   MC_NAME          POVINNÉ. Krátký slug, [a-z][a-z0-9-]{1,30} — použije se
#                     jako jméno/hostname serveru a jako klíč stavu.
#   MC_SERVER_TYPE    default cx33   (4 vCPU / 8 GB, sdílené x86)
#   MC_LOCATION       default nbg1   (Norimberk, EU; alt. fsn1/hel1/ash/hil)
#   MC_IMAGE          default ubuntu-24.04
#   MC_DEPLOY_USER    default deploy (admin účet vytvořený cloud-initem)
#   MC_SSH_KEY        default ~/.ssh/mc-deploy-<MC_NAME>
#
# Idempotence: pokud pro MC_NAME už existuje stav se SERVER_ID
# (~/.mc-deploys/<MC_NAME>.env), skript nic nevytváří a jen to nahlásí
# (exit 0) — bezpečné spustit znovu po přerušení.
#
# Kroky: ssh-keygen -> registrace klíče v Hetzner projektu -> cloud firewall
# (22/tcp, 41641/udp pro Tailscale, icmp) -> render cloud-init.yaml ->
# POST /servers -> poll do stavu running -> ulož stav -> počkej na SSH +
# marker dokončeného cloud-initu.
set -euo pipefail

# ---- Logování (stderr) -------------------------------------------------------
_c() { printf '\033[%sm' "$1"; }
log()  { printf '%s%s%s %s\n' "$(_c '36;1')" "▶" "$(_c 0)" "$*" >&2; }
ok()   { printf '%s%s%s %s\n' "$(_c '32;1')" "✓" "$(_c 0)" "$*" >&2; }
warn() { printf '%s%s%s %s\n' "$(_c '33;1')" "!" "$(_c 0)" "$*" >&2; }
die()  { printf '%s%s%s %s\n' "$(_c '31;1')" "✗" "$(_c 0)" "$*" >&2; exit 1; }

# ---- Hetzner API token --------------------------------------------------------
# Priorita: $HCLOUD_TOKEN env -> ~/.hcloud_token -> ~/.hetzner.env
# (HCLOUD_TOKEN=... uvnitř). Token se nikdy nevypisuje (žádný `set -x`, žádný
# echo hodnoty) — jen do Authorization hlavičky curlu.
load_hcloud_token() {
  if [[ -n "${HCLOUD_TOKEN:-}" ]]; then return 0; fi
  if [[ -f "$HOME/.hcloud_token" ]]; then
    HCLOUD_TOKEN="$(tr -d ' \t\r\n' < "$HOME/.hcloud_token")"; export HCLOUD_TOKEN
    [[ -n "$HCLOUD_TOKEN" ]] && return 0
  fi
  if [[ -f "$HOME/.hetzner.env" ]]; then
    # shellcheck disable=SC1090
    source "$HOME/.hetzner.env"; export HCLOUD_TOKEN
    [[ -n "${HCLOUD_TOKEN:-}" ]] && return 0
  fi
  die "Hetzner API token nenalezen. Nastav \$HCLOUD_TOKEN, nebo ho ulož do ~/.hcloud_token (chmod 600)."
}

# ---- JSON helper (python3, bez závislosti na jq) -----------------------------
# Použití: echo "$json" | jget 'd["servers"][0]["id"]'
# Bezpečnostní pozn.: `eval()` tu dostává jen literál napsaný v TOMHLE
# souboru na jednotlivých volacích místech (viz "d[...]" níž) — nikdy řetězec
# odvozený z HTTP odpovědi/argv/uživatelského vstupu. `d` sám je bezpečně
# naparsovaný přes json.load(); eval jen indexuje do už-parsovaného dictu.
jget() {
  python3 -c 'import sys,json
d=json.load(sys.stdin)
try:
    print(eval(sys.argv[1]))
except Exception:
    sys.exit(3)' "$1"
}

# ---- Hetzner Cloud API volání -------------------------------------------------
# hapi METHOD PATH [json-body]  -> vypíše tělo odpovědi, HTTP >=400 = chyba.
HCLOUD_API="https://api.hetzner.cloud/v1"
hapi() {
  local method="$1" path="$2" body="${3:-}" resp code tmp
  tmp="$(mktemp)"
  if [[ -n "$body" ]]; then
    code="$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $HCLOUD_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body" "$HCLOUD_API$path")"
  else
    code="$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $HCLOUD_TOKEN" \
      "$HCLOUD_API$path")"
  fi
  resp="$(cat "$tmp")"; rm -f "$tmp"
  if [[ "$code" -ge 400 ]]; then
    warn "Hetzner API $method $path -> HTTP $code"
    echo "$resp" >&2
    return 1
  fi
  echo "$resp"
}

# ---- SSH opce (jedna identita, přátelské k prvnímu použití) -----------------
ssh_opts() {
  echo "-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${MC_KNOWN_HOSTS:-$HOME/.ssh/known_hosts} -o ConnectTimeout=10 -i $MC_SSH_KEY"
}

# ---- Slug / validace ----------------------------------------------------------
valid_slug() { [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; }

# ---- Stav (per nasazení) -------------------------------------------------------
state_file() { echo "$HOME/.mc-deploys/$MC_NAME.env"; }
save_state() { mkdir -p "$HOME/.mc-deploys"; chmod 700 "$HOME/.mc-deploys"; printf '%s=%q\n' "$1" "$2" >> "$(state_file)"; }
load_state() { local f; f="$(state_file)"; [[ -f "$f" ]] && { set -a; source "$f"; set +a; }; }

# ==============================================================================

: "${MC_NAME:?nastav MC_NAME (krátký slug, např. acme)}"
valid_slug "$MC_NAME" || die "MC_NAME musí sedět na ^[a-z][a-z0-9-]{1,30}\$ (jen malá písmena, číslice, pomlčka)"
MC_SERVER_TYPE="${MC_SERVER_TYPE:-cx33}"   # sdílené x86, 4 vCPU / 8 GB — univerzální, uveze Mission Control + pár projektů
# (Hetzner v 2026 přejmenoval starou `cx` řadu — cx22/cx32/... zmizely z API
# úplně, bez deprecation flagu, nová jména mají +1 v druhé číslici při stejné
# specifikaci: cx22->cx23, cx32->cx33. Ověřeno živě task-19 e2e testem — `POST
# /servers` s "cx32" vrátil 422 "server type 104 is deprecated". Pokud tenhle
# default zase zastará, zjisti aktuální jméno přes `GET /v1/server_types`.)
MC_LOCATION="${MC_LOCATION:-nbg1}"          # Norimberk (EU). Alt: fsn1, hel1, ash, hil
MC_IMAGE="${MC_IMAGE:-ubuntu-24.04}"
MC_DEPLOY_USER="${MC_DEPLOY_USER:-deploy}"
MC_SSH_KEY="${MC_SSH_KEY:-$HOME/.ssh/mc-deploy-$MC_NAME}"
SERVER_NAME="$MC_NAME"
HOSTNAME_FQDN="$MC_NAME"

load_hcloud_token
command -v python3    >/dev/null || die "python3 chybí (JSON parsing)"
command -v curl       >/dev/null || die "curl chybí"
command -v ssh-keygen >/dev/null || die "ssh-keygen chybí (balík openssh-client)"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HERE/cloud-init.yaml" ]] || die "$HERE/cloud-init.yaml nenalezen (spouštíš skript z klonu repa?)"

# ---- 0. Guard idempotence ----------------------------------------------------
if [[ -f "$(state_file)" ]]; then
  load_state
  if [[ -n "${MC_SERVER_ID:-}" ]]; then
    warn "Server pro '$MC_NAME' už existuje (id $MC_SERVER_ID, ip ${MC_TARGET:-?}). Přeskakuji vytvoření."
    exit 0
  fi
fi

# ---- 1. Lokální SSH klíč ------------------------------------------------------
if [[ ! -f "$MC_SSH_KEY" ]]; then
  log "Generuji deploy SSH klíč $MC_SSH_KEY"
  mkdir -p "$(dirname "$MC_SSH_KEY")"; chmod 700 "$(dirname "$MC_SSH_KEY")"
  ssh-keygen -t ed25519 -N '' -C "mc-deploy-$MC_NAME" -f "$MC_SSH_KEY" >/dev/null
fi
PUBKEY="$(cat "$MC_SSH_KEY.pub")"
ok "deploy klíč připraven"

# ---- 2. Registrace SSH klíče v Hetzner projektu ------------------------------
KEY_NAME="mc-$MC_NAME"
existing="$(hapi GET "/ssh_keys?name=$KEY_NAME" || true)"
KEY_ID="$(echo "$existing" | jget 'd["ssh_keys"][0]["id"]' 2>/dev/null || true)"
if [[ -z "$KEY_ID" || "$KEY_ID" == "None" ]]; then
  body="$(python3 -c 'import json,sys; print(json.dumps({"name":sys.argv[1],"public_key":sys.argv[2]}))' "$KEY_NAME" "$PUBKEY")"
  KEY_ID="$(hapi POST "/ssh_keys" "$body" | jget 'd["ssh_key"]["id"]')"
fi
ok "Hetzner SSH key id=$KEY_ID"

# ---- 3. Cloud firewall: zakázat vše kromě SSH + Tailscale --------------------
# Mission Control samo NIKDY neposlouchá na veřejné IP (127.0.0.1 + Tailscale
# serve/Funnel) — tohle je jen obálka serveru, ne cesta k appce.
FW_NAME="mc-$MC_NAME"
fw="$(hapi GET "/firewalls?name=$FW_NAME" || true)"
FW_ID="$(echo "$fw" | jget 'd["firewalls"][0]["id"]' 2>/dev/null || true)"
if [[ -z "$FW_ID" || "$FW_ID" == "None" ]]; then
  read -r -d '' FW_BODY <<JSON || true
{"name":"$FW_NAME","rules":[
  {"direction":"in","protocol":"tcp","port":"22","source_ips":["0.0.0.0/0","::/0"],"description":"ssh"},
  {"direction":"in","protocol":"udp","port":"41641","source_ips":["0.0.0.0/0","::/0"],"description":"tailscale direct"},
  {"direction":"in","protocol":"icmp","source_ips":["0.0.0.0/0","::/0"],"description":"ping"}
]}
JSON
  FW_ID="$(hapi POST "/firewalls" "$FW_BODY" | jget 'd["firewall"]["id"]')"
fi
ok "Hetzner firewall id=$FW_ID (vstup: 22, tailscale; vše ostatní DROP)"

# ---- 4. Render cloud-init.yaml ------------------------------------------------
USERDATA="$(mktemp)"
sed -e "s|__DEPLOY_USER__|$MC_DEPLOY_USER|g" \
    -e "s|__HOSTNAME__|$HOSTNAME_FQDN|g" \
    -e "s|__SSH_PUBKEY__|$PUBKEY|g" \
    "$HERE/cloud-init.yaml" > "$USERDATA"

# ---- 5. Vytvoření serveru ------------------------------------------------------
log "Vytvářím server $SERVER_NAME ($MC_SERVER_TYPE @ $MC_LOCATION, $MC_IMAGE)…"
CREATE_BODY="$(python3 - "$SERVER_NAME" "$MC_SERVER_TYPE" "$MC_IMAGE" "$MC_LOCATION" "$KEY_ID" "$FW_ID" "$MC_NAME" "$USERDATA" <<'PY'
import json,sys
name,stype,image,loc,keyid,fwid,slug,udfile=sys.argv[1:9]
ud=open(udfile).read()
print(json.dumps({
  "name":name,"server_type":stype,"image":image,"location":loc,
  "ssh_keys":[int(keyid)],"firewalls":[{"firewall":int(fwid)}],
  "user_data":ud,"start_after_create":True,
  "public_net":{"enable_ipv4":True,"enable_ipv6":True},
  "labels":{"role":"mission-control","mc-name":slug}
}))
PY
)"
resp="$(hapi POST "/servers" "$CREATE_BODY")"
rm -f "$USERDATA"
SERVER_ID="$(echo "$resp" | jget 'd["server"]["id"]')"
[[ -n "$SERVER_ID" && "$SERVER_ID" != "None" ]] || die "Vytvoření serveru selhalo"
ok "Server vytvořen, id=$SERVER_ID"

# Ulož stav HNED TEĎ, ne až na konci. Od tohohle okamžiku je server placený
# bez ohledu na to, co se stane dál (pád pollingu, výpadek sítě, Ctrl-C) — a
# idempotence guard na začátku (krok 0) pozná existující nasazení jen podle
# MC_SERVER_ID v souboru stavu. Kdyby se stav zapsal až po pollingu (jak to
# dřív dělal krok 7) a polling by selhal, druhé spuštění by o tomhle serveru
# nevědělo a založilo by druhý → osiřelý placený server. `mkdir -p` MUSÍ
# proběhnout před `: >` truncate — na úplně první spuštění ~/.mc-deploys
# ještě neexistuje (dřív ho zakládal až save_state(), volaný AŽ po tomhle
# truncate, takže selhal `set -euo pipefail` na "No such file or directory").
mkdir -p "$HOME/.mc-deploys"; chmod 700 "$HOME/.mc-deploys"
: > "$(state_file)"   # čistý začátek
save_state MC_NAME        "$MC_NAME"
save_state MC_SERVER_ID   "$SERVER_ID"
save_state MC_DEPLOY_USER "$MC_DEPLOY_USER"
save_state MC_SSH_KEY     "$MC_SSH_KEY"
save_state MC_SSH_KEY_ID  "$KEY_ID"
save_state MC_FIREWALL_ID "$FW_ID"
save_state MC_SERVER_TYPE "$MC_SERVER_TYPE"
save_state MC_LOCATION    "$MC_LOCATION"
ok "Stav uložen do $(state_file) (id=$SERVER_ID) — od teď idempotence guard tenhle server vidí."

# ---- 6. Poll do stavu running, získej IP --------------------------------------
log "Čekám na boot…"
IP=""
for i in $(seq 1 60); do
  s="$(hapi GET "/servers/$SERVER_ID")"
  st="$(echo "$s" | jget 'd["server"]["status"]')"
  IP="$(echo "$s" | jget 'd["server"]["public_net"]["ipv4"]["ip"]')"
  [[ "$st" == "running" ]] && break
  sleep 5
done
[[ -n "$IP" && "$IP" != "None" ]] || die "Nezískal jsem IP serveru (timeout 5 min) — server $SERVER_ID už ale běží podle Hetzner API a je uložený v $(state_file), příští spuštění na něj naváže."
ok "Server běží, IP=$IP"

# ---- 7. Dopiš IP do stavu -------------------------------------------------------
save_state MC_TARGET "$IP"

# ---- 8. Čekání na SSH + marker dokončeného cloud-initu ------------------------
log "Čekám na SSH ($MC_DEPLOY_USER@$IP)…"
for i in $(seq 1 40); do
  if ssh $(ssh_opts) "$MC_DEPLOY_USER@$IP" 'true' 2>/dev/null; then break; fi
  sleep 6
  [[ $i -eq 40 ]] && die "SSH se nepřipojilo do timeoutu (4 min)"
done
ok "SSH naživu"

log "Čekám na dokončení cloud-init (bootstrap marker)…"
for i in $(seq 1 40); do
  if ssh $(ssh_opts) "$MC_DEPLOY_USER@$IP" 'test -f /var/lib/mc-bootstrap-done' 2>/dev/null; then break; fi
  sleep 6
  [[ $i -eq 40 ]] && warn "Bootstrap marker nedorazil do 4 min — pokračuj, další kroky (install/harden.sh, INSTALL.md) jsou bezpečné spustit i tak, jen počkej pár desítek vteřin navíc."
done
ok "Server $SERVER_NAME @ $IP připraven. Stav: $(state_file)"
echo "MC_TARGET=$IP MC_SERVER_ID=$SERVER_ID MC_DEPLOY_USER=$MC_DEPLOY_USER MC_SSH_KEY=$MC_SSH_KEY"
