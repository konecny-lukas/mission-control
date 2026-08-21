#!/usr/bin/env bash
# Základní zabezpečení čerstvého VPS (Ubuntu 24.04) pro Mission Control.
#
# POZOR: tenhle skript běží PŘÍMO NA SERVERU pod root/sudo — ne na tvém
# stroji. Např.:
#   scp install/harden.sh deploy@<ip>:~/
#   ssh deploy@<ip> 'sudo bash ~/harden.sh'
#
# Kroky: (1) unattended-upgrades + fail2ban jail na sshd, (2) ufw
# default-deny příchozí + důvěra tailscale0 + rate-limit SSH, (3) lehké
# sysctl zpevnění sítě. NEŘEŠÍ dedikovaného běhového uživatele `mc` (bez
# sudo, vlastní /srv layout) — to je pokročilá sandboxová varianta popsaná
# v INSTALL.md, na tenhle skript nenavazuje.
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Spusť pod root/sudo: sudo bash $0" >&2
  exit 1
fi

say() { printf '  • %s\n' "$*"; }

# ---- 1. unattended-upgrades + fail2ban --------------------------------------
say "unattended-upgrades + fail2ban"
systemctl enable --now unattended-upgrades 2>/dev/null || true
cat >/etc/fail2ban/jail.d/mc-sshd.conf <<'F2B'
[sshd]
enabled  = true
mode     = aggressive
maxretry = 4
bantime  = 1h
findtime = 10m
F2B
systemctl enable --now fail2ban 2>/dev/null || true

# ---- 2. ufw: default-deny příchozí, důvěra tailnetu, rate-limit SSH --------
say "ufw default-deny + tailscale0 trusted + limit 22"
ufw --force reset >/dev/null 2>&1 || true
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
# Rozhraní tailscale0 nemusí v tuhle chvíli ještě existovat (dokud neproběhne
# `tailscale up`) — pravidlo se přesto uloží a je pak neškodné.
ufw allow in on tailscale0 >/dev/null 2>&1 || true
# Veřejný SSH fallback, rate-limited. Hetzner cloud firewall (viz
# install/provision-hetzner.sh) tohle taky filtruje, tohle je druhá vrstva.
ufw limit 22/tcp >/dev/null
# --force přeskočí interaktivní potvrzení ("Command may disrupt existing ssh
# connections..."). PŘEDTÍM tu bylo `yes | ufw enable` — pod `set -o
# pipefail` (viz hlavička skriptu) to spolehlivě umíralo se SIGPIPE (exit
# 141), protože `yes` dostane SIGPIPE, jakmile `ufw enable` přestane číst ze
# stdin, a pipefail tenhle exit kód pošle dál i když samotný `ufw enable`
# uspěl — skript pak skončil TADY a sysctl krok (3) níž se nikdy nespustil.
# Ověřeno živě na e2e test serveru (task 19).
ufw --force enable >/dev/null
ufw status verbose | sed 's/^/    /'

# ---- 3. sysctl: lehké síťové zpevnění ---------------------------------------
say "sysctl hardening"
cat >/etc/sysctl.d/99-mc.conf <<'SYS'
net.ipv4.conf.all.rp_filter=1
net.ipv4.tcp_syncookies=1
net.ipv4.conf.all.accept_redirects=0
net.ipv6.conf.all.accept_redirects=0
net.ipv4.conf.all.send_redirects=0
kernel.kptr_restrict=2
kernel.dmesg_restrict=1
fs.protected_hardlinks=1
fs.protected_symlinks=1
SYS
sysctl --system >/dev/null 2>&1 || true

say "hotovo"
echo "HARDEN_OK"
