# INSTALL.md — instalace Mission Control

**Tenhle soubor je psaný pro tebe, Claude.** Uživatel ti řekl „nainstaluj
Mission Control podle INSTALL.md" — ty jsi ten, kdo instalaci provede. Postupuj
fázemi 0–6 popořadě a **po každé fázi spusť blok „OVĚŘ" a jeho výstup ukaž
uživateli**. Kde je označeno **ZEPTEJ SE**, použij `AskUserQuestion` — nehádej
za uživatele branding, domény ani přístupy.

Konvence a předpoklady:

- Cílový stroj: **Ubuntu 24.04 LTS** (funguje i Debian 12; jiné distribuce si
  budeš muset přebrat sám).
- Instaluješ **pod běžným uživatelem s `sudo`**, ne pod rootem. Mission Control
  běží jako ten uživatel přes `systemd --user`.
- V cestách níž je `~/mission-control` = kořen instalace. Kdykoli píšeš cestu
  do cronu, systemd unity nebo configu, používej **absolutní** cestu.
- Všechny ověřovací příkazy počítají s portem **8088** (výchozí). Když ho
  uživatel v configu změní, dosaď jeho.
- Když nějaký krok selže, **nepokračuj dál** — oprav ho, nebo se zeptej.
  Instalace, která „skoro proběhla", je horší než přerušená.

---

## Fáze 0 — Server (přeskoč, pokud už nějaký máš)

**ZEPTEJ SE:** „Máš už server, na který to nainstalovat?"
Možnosti: *Mám server (pokračujeme fází 1)* · *Založ mi ho na Hetzneru* ·
*Chci netcup (levnější, založím ručně)*.

Minimum pro rozumný provoz: **4 vCPU / 8 GB RAM / 80 GB disk**. Proč ne 4 GB:
Mission Control sám je nenáročný, ale každá Claude Code session (terminály,
Jarvis, hodinový hlídač) zabere řádově **stovky MB RAM**. Na 4 GB se dvě
sessions plus nějaký projekt potkají s OOM killerem — a OOM tady bere s sebou
i tmux server s terminály.

### 0a) Hetzner Cloud (doporučeno — má API, server ti založí skript)

Doporučený plán **CX33 (4 vCPU / 8 GB / 80 GB, ~8,50 €/měs.)**, lokace `nbg1`,
image `ubuntu-24.04`. (Hetzner mezitím přejmenoval starou `cx` řadu — pokud
narazíš na hlášku `server type … is deprecated`, zkontroluj přes `GET
/v1/server_types`, jaké jméno má ekvivalent aktuálně; typicky jde jen o
posun čísla, specifikace zůstávají stejné.)

Skript spouštíš **na svém stroji** (ne na cílovém serveru — ten ještě
neexistuje), z klonu tohohle repa:

```bash
git clone https://github.com/konecny-lukas/mission-control.git ~/mission-control
HCLOUD_TOKEN=<token z Hetzner Cloud Console → Security → API tokens (Read & Write)> \
  MC_NAME=<slug, např. acme> \
  bash ~/mission-control/install/provision-hetzner.sh
```

Co skript udělá: ed25519 deploy klíč → registrace klíče v projektu → cloud
firewall (vstup jen 22/tcp, 41641/udp pro Tailscale, ICMP) → cloud-init
(uživatel `deploy`, zakázané heslové přihlášení a root login, `unattended-upgrades`,
fail2ban, tmux, jq, Tailscale) → vytvoření serveru → čekání na SSH a na marker
dokončeného bootstrapu. Je **idempotentní**: stav si ukládá do
`~/.mc-deploys/<MC_NAME>.env`, opakované spuštění už nic nezaloží.

Na konci vypíše `MC_TARGET=<IP>`. Přihlas se a pokračuj fází 1:

```bash
ssh -i ~/.ssh/mc-deploy-<MC_NAME> deploy@<IP>
```

**OVĚŘ:**

```bash
ssh -i ~/.ssh/mc-deploy-<MC_NAME> deploy@<IP> 'cat /etc/os-release | head -2; nproc; free -h | head -2; test -f /var/lib/mc-bootstrap-done && echo BOOTSTRAP_OK'
```

Musíš vidět Ubuntu 24.04, ≥ 4 CPU, ≥ 7 GiB RAM a `BOOTSTRAP_OK`.

### 0b) netcup (levnější, bez objednávkového API)

netcup nemá API na objednání serveru — uživatel ho musí objednat ručně přes
web. Doporuč řadu s **~4 vCPU / 8 GB RAM** (v době psaní odpovídá „VPS 1000",
ale **nabídku i ceny si ověř na netcup.com**, mění se). Postup pro uživatele:

1. objednat VPS s **Ubuntu 24.04** jako předinstalovaným systémem,
2. v Server Control Panelu (SCP) nastavit hostname a nabootovat,
3. přihlásit se přes SSH jako `root` s heslem z e-mailu,
4. založit běžného uživatele a nahrát mu SSH klíč:

   ```bash
   adduser --gecos "" <uživatel>
   usermod -aG sudo <uživatel>
   install -d -m 700 -o <uživatel> -g <uživatel> /home/<uživatel>/.ssh
   # veřejný klíč uživatele:
   printf '%s\n' 'ssh-ed25519 AAAA… komentář' > /home/<uživatel>/.ssh/authorized_keys
   chown <uživatel>:<uživatel> /home/<uživatel>/.ssh/authorized_keys
   chmod 600 /home/<uživatel>/.ssh/authorized_keys
   ```

5. odhlásit se, přihlásit jako nový uživatel a pokračovat fází 1 (hardening
   `install/harden.sh` je tam součástí — zakáže heslové přihlášení až po
   ověření, že klíč funguje).

**OVĚŘ:** `ssh <uživatel>@<ip> 'id; sudo -n true && echo SUDO_OK'`

---

## Fáze 1 — Prerekvizity

Všechno v téhle fázi běží **na cílovém serveru**.

### 1a) Balíčky

```bash
sudo apt-get update
sudo apt-get install -y git tmux ttyd jq curl ca-certificates python3
```

`ttyd` je v Ubuntu 24.04 i Debianu 12 v repozitáři (`/usr/bin/ttyd`). Kdyby
v tvé distribuci chyběl, stáhni statickou binárku a **umísti ji tak, aby byla
na `/usr/bin/ttyd`** — systemd unita `mc-ttyd.service` má tuhle cestu napevno:

```bash
sudo curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64
sudo chmod +x /usr/local/bin/ttyd
sudo ln -sf /usr/local/bin/ttyd /usr/bin/ttyd
```

### 1b) Node ≥ 22.5

Mission Control je zero-dependency Node aplikace, ale používá **vestavěný
`node:sqlite`**, který je až od 22.5. Ubuntu 24.04 má v repozitáři Node 18 —
nestačí. Instaluj z NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 1c) Claude Code CLI

Oficiální instalátor (instaluje do `~/.local/bin/claude` — přesně tam, kde ho
Mission Control hledá; jinou cestu bys musel dopsat do `mc.env` jako
`MC_CLAUDE_BIN`):

```bash
curl -fsSL https://claude.ai/install.sh | bash
grep -q '.local/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"
```

Přihlášení řeší až **fáze 3** — teď stačí, že binárka existuje.

### 1d) Hardening (jen u čerstvého serveru)

Pokud server právě vznikl (fáze 0) a ještě není zabezpečený, naklonuj repo
a spusť hardening skript. Klon použiješ i ve fázi 2, takže ho udělej rovnou
na finální místo:

```bash
git clone https://github.com/konecny-lukas/mission-control.git ~/mission-control
sudo apt-get install -y ufw fail2ban unattended-upgrades
sudo bash ~/mission-control/install/harden.sh
```

Skript udělá: `unattended-upgrades` + fail2ban jail na sshd (4 pokusy, ban 1 h)
· `ufw` default-deny příchozí, povolené `tailscale0`, rate-limited 22/tcp ·
lehké sysctl zpevnění sítě.

⚠ **Pozor:** `harden.sh` resetuje `ufw` a povolí jen port 22. Běží-li SSH na
jiném portu, uprav pravidlo **před** spuštěním (jinak se odřízneš). Skript
nezakazuje heslové přihlášení — to už udělal cloud-init u Hetzneru; u ručně
objednaného serveru to nastav sám v `/etc/ssh/sshd_config` (`PasswordAuthentication no`,
`PermitRootLogin no`) **až poté**, co ověříš přihlášení klíčem.

### 1e) (Pokročilé, volitelné) Sandbox s dedikovaným uživatelem

Výchozí instalace je „jednoduchá": Mission Control běží **jako ty**, pod tvým
domovským adresářem. Terminály a Jarvis tak mají stejná práva jako ty — což je
záměr (je to tvůj box), ale není to bezpečnostní hranice.

Chceš-li skutečnou OS hranici, založ dedikovaného uživatele bez `sudo`
(vlastní `HOME` mimo tvůj, `loginctl enable-linger`), MC provozuj pod ním
a v `mc.env` nastav `MC_AGENT_HOME` na jeho domovský adresář. Detaily a pasti
jsou okomentované přímo v `systemd/mission-control.service` (sekce „pískoviště"
— pozor na `status=218/CAPABILITIES` u `systemctl --user`) a v `mc.env.example`.
Zbytek tohohle návodu předpokládá jednoduchou variantu.

**OVĚŘ (fáze 1):**

```bash
node -v            # musí být v22.5.0 nebo vyšší
tmux -V
ttyd --version
command -v /usr/bin/ttyd && echo TTYD_PATH_OK
~/.local/bin/claude --version
jq --version && git --version && python3 -V
```

---

## Fáze 2 — Instalace HUD

### 2a) Klon a konfigurace

```bash
test -d ~/mission-control || git clone https://github.com/konecny-lukas/mission-control.git ~/mission-control
cp -n ~/mission-control/mc.config.example.json ~/mission-control/mc.config.json
cp -n ~/mission-control/mc.env.example ~/mission-control/mc.env
```

**ZEPTEJ SE** (jednou, více otázek najednou):

1. **Název HUD** — co má svítit v hlavičce (např. „ACME OPS"). → `name`
2. **Podtitulek** — krátká vsuvka pod názvem (default „server HUD"). → `tagline`
3. **Akcentní barva** — hex, default `#2ba8ff` (nabídni pár variant: modrá
   `#2ba8ff`, zelená `#3ddc84`, oranžová `#ff9f43`, fialová `#a78bfa`). → `accent`
4. **Terminálové projekty** — které adresáře chce mít v terminálovém drawéru
   jako záložky (klíč = a–z/0–9, max 16 znaků; jméno; cesta). Vždycky nabídni
   `home` (`~`) a `app` (samotný Mission Control). → `terminals.projects`
5. **Port** — default 8088, měň jen při kolizi. → `port`

Pak `mc.config.json` uprav. **Modul je zapnutý právě tehdy, když má v
`modules` svou sekci** — proto v téhle fázi z example souboru **smaž všechny
sekce v `modules`** (nech `"modules": {}`) a moduly zapínej až ve fázi 4, jeden
po druhém, s ověřením. Example má všech osm sekcí jen jako referenci tvaru.

Výsledek by měl vypadat takhle:

```json
{
  "name": "ACME OPS",
  "tagline": "server HUD",
  "accent": "#2ba8ff",
  "port": 8088,
  "terminals": {
    "projects": [
      { "key": "home", "label": "Domů", "dir": "~" },
      { "key": "app", "label": "Mission Control", "dir": "~/mission-control" }
    ]
  },
  "modules": {}
}
```

`mc.env` obvykle měnit nemusíš — je celý okomentovaný a všechny hodnoty mají
rozumné defaulty. Zajímavé jsou `MC_PORT` (musí sedět s `port` v configu, pokud
ho měníš) a `MC_JARVIS_MODEL` (model pro Jarvise — doplň podle plánu uživatele).

### 2b) Systém prompt pro Jarvise

Jarvis (servisní chat v HUD) čte `data/agent-system.md`. Ten se **vyrábí ze
šablony** — nahraď placeholdery skutečnými hodnotami:

```bash
sed -e "s|{{NAME}}|ACME OPS|g" \
    -e "s|{{OWNER}}|Jan|g" \
    -e "s|{{PROJECTS_DIR}}|$HOME/projects|g" \
    -e "s|{{MC_DIR}}|$HOME/mission-control|g" \
    ~/mission-control/agent-system.md.template > ~/mission-control/data/agent-system.md
```

`{{OWNER}}` = jak Jarvis oslovuje uživatele, `{{PROJECTS_DIR}}` = kde na boxu
budou žít projekty (adresář klidně založ: `mkdir -p ~/projects`). Bez tohohle
souboru Jarvis funguje taky, jen bez znalosti kontextu boxu.

### 2c) CLI zkratky `mc-open` / `mc-preview`

```bash
bash ~/mission-control/bin/install-shims.sh
```

Nainstaluje do `~/.local/bin` dva příkazy: `mc-open <soubor>` (vypíše URL, na
které si uživatel soubor otevře v prohlížeči) a `mc-preview` (statická složka
nebo reverse-proxy na dev server). Bez nich je práce na headless boxu slepá.

### 2d) systemd user unity

```bash
mkdir -p ~/.config/systemd/user
cp ~/mission-control/systemd/mission-control.service ~/mission-control/systemd/mc-ttyd.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mission-control mc-ttyd
loginctl enable-linger "$USER"
```

`enable-linger` je důležitý: bez něj systemd sestřelí uživatelské služby
v okamžiku, kdy se odhlásíš ze SSH. (Kdyby si příkaz vyžádal autorizaci,
použij `sudo loginctl enable-linger "$USER"`.)

Obě unity čtou `~/mission-control/mc.env` (volitelně) a sdílejí
`TMUX_TMPDIR=~/mission-control/data/.tmux` — díky tomu vidí obě na **stejný**
tmux server s terminály. Tuhle proměnnou nikdy neměň jen v jedné z nich.

**OVĚŘ (fáze 2):**

```bash
systemctl --user --no-pager status mission-control mc-ttyd | head -20
curl -s http://127.0.0.1:8088/api/health
curl -s http://127.0.0.1:8088/api/status | jq '{branding, modules, services: [.services[].name]}'
node ~/mission-control/bin/mc-smoke.js
```

Čekáš: obě unity `active (running)`, `{"ok":true,…}`, v `/api/status` svůj
`name`/`tagline`/`accent` a `modules` se samými `false`. `mc-smoke.js` bez
zapnutého watchdogu a bez Playwrightu vypíše samé `SKIP` a skončí kódem 0 —
to je v pořádku; `FAIL` v pořádku není. (Chceš-li i reálný prohlížečový test,
stáhni Chromium: `npx playwright install chromium` — a chybí-li systémové
knihovny, `sudo npx playwright install-deps chromium`. Pak
`node ~/mission-control/bin/mc-smoke.js --browser-only`.)

Do prohlížeče se ještě nedostaneš — server záměrně poslouchá jen na
`127.0.0.1`. Expozice je fáze 5; pokud si to chce uživatel prohlédnout hned,
udělej z jeho stroje SSH tunel:
`ssh -N -L 8088:127.0.0.1:8088 <uživatel>@<ip>` a otevři `http://localhost:8088`.

---

## Fáze 3 — Přihlášení Claude Code

Jedno přihlášení pokrývá **všechno**: terminály v HUD, Jarvise i hodinového
hlídače. Přihlášení je uložené v `~/.claude` toho uživatele, pod kterým MC
běží. **Žádný API klíč se nikam nezadává** — Mission Control záměrně nikdy
neinjektuje `ANTHROPIC_API_KEY`.

### 3a) Interaktivní přihlášení (doporučeno)

V SSH shellu prostě spusť:

```bash
claude
```

Projdi OAuth: Claude vypíše URL, uživatel ji otevře ve svém prohlížeči,
přihlásí se a vrátí kód do terminálu. Pak `/exit`.

### 3b) Headless alternativa

Nemá-li uživatel jak proklikat OAuth ze serveru, vygeneruje si token na svém
počítači (kde Claude Code má prohlížeč):

```bash
claude setup-token     # na desktopu uživatele
```

Vzniklý token vlož na serveru do `~/mission-control/mc.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=<token>
```

a restartuj obě unity (`systemctl --user restart mission-control mc-ttyd`).
Obě mají `EnvironmentFile=-…/mc.env`, takže proměnnou zdědí i Claude
spouštěný pro terminály a Jarvise. **Ověř to skutečným dotazem** (níž), ne
jen tím, že soubor existuje.

### 3c) Terminály v HUD

Terminály jsou tmux sessions `mc-<klíč>-<číslo>` na socketu `-L mc`. Ten tmux
server běží pod unitou `mc-ttyd` s vlastním `TMUX_TMPDIR` — **když se k němu
chceš dostat ze SSH, musíš tu proměnnou nastavit taky**, jinak mluvíš s úplně
jiným (prázdným) tmux serverem:

```bash
TMUX_TMPDIR=~/mission-control/data/.tmux tmux -L mc ls
TMUX_TMPDIR=~/mission-control/data/.tmux tmux -L mc attach -t mc-home-1
```

(Odpojení: `Ctrl-b d`.) Pohodlnější cesta je otevřít terminál rovnou v HUD
v prohlížeči — tam se session vytvoří sama a `TMUX_TMPDIR` řeší unita.

Poznámka: `MC_TERM_CLAUDE_ARGS` v `mc.env` přidá argumenty Claudovi
spouštěnému v terminálu. `--dangerously-skip-permissions` sem dávej **jen**
u boxu dostupného výhradně přes tailnet a jen když uživatel rozumí důsledkům
(Claude se pak na nic neptá).

**OVĚŘ (fáze 3):**

```bash
claude -p "Odpověz jedním slovem: funguje?"
TMUX_TMPDIR=~/mission-control/data/.tmux tmux -L mc ls || echo "(zatím žádná session — vytvoř ji v HUD)"
curl -s http://127.0.0.1:8088/api/status | jq '.claude.sessions'   # co MC vidí za běžící Claude sessions
```

První příkaz musí vrátit skutečnou odpověď modelu (ne chybu o přihlášení).
Nakonec nech uživatele napsat Jarvisovi v HUD („ahoj") a potvrdit, že
odpovídá — Jarvis bez přihlášeného Claude nepadá, jen se tváří jako nedostupný.

---

## Fáze 4 — Volitelné moduly

**ZEPTEJ SE**, které moduly uživatel chce (nabídni je jako vícenásobný výběr
s krátkým popisem):

| Modul | K čemu je | Co k tomu potřebuješ |
|---|---|---|
| `uptime` | HTTP sondy webů, historie dostupnosti | jen URL |
| `ga4` | návštěvnost z Google Analytics 4 | service account + property ID |
| `gsc` | kliky/imprese ze Search Console | service account + property |
| `indexace` | stav indexace URL ze sitemap | service account + sitemap |
| `claudelimits` | vytížení limitů Claude účtu | nic (čte lokální `~/.claude`) |
| `wpsched` | naplánované posty ve WordPressu | application password |
| `nanoclaw` | panel nad osobním asistentem NanoClaw | instalaci NanoClaw |
| `watchdog` | hodinový hlídač cronů + český vypravěč | crontab řádek |

Každý zapnutý modul = jedna sekce v `mc.config.json` → `modules`. **Po každé
změně configu restartuj službu:**

```bash
systemctl --user restart mission-control
```

(Bezpečnější varianta, která navíc ověří, že restart nesebral terminály:
`bash ~/mission-control/bin/mc-safe-restart.sh`.)

Zapínej moduly **po jednom** a po každém ověř. Tajemství (klíče, hesla) patří
do `~/mission-control/secrets/` — ten adresář je v `.gitignore`:

```bash
mkdir -p ~/mission-control/secrets && chmod 700 ~/mission-control/secrets
```

### 4a) uptime

**ZEPTEJ SE** na seznam webů (URL + krátké jméno).

```json
"uptime": {
  "sites": [
    { "id": "web", "label": "Firemní web", "url": "https://example.com" }
  ],
  "intervalMs": 60000,
  "retentionDays": 30
}
```

`id` = krátký klíč (používá se v DB a v UI), `intervalMs` = perioda sondy
(default 60 s), `retentionDays` = jak dlouho držet historii (default 30 dní).

**OVĚŘ:** `curl -s http://127.0.0.1:8088/api/status | jq '.uptime'` — po první
minutě musí být u každého webu `state` a doba odezvy.

### 4b) Google trojice (`ga4`, `gsc`, `indexace`) — společná příprava

Všechny tři moduly sdílejí **jeden** přístupový soubor. Nejjednodušší je
service account (nevyprší, nepatří žádné fyzické osobě):

1. **Google Cloud Console** → nový (nebo existující) projekt.
2. **APIs & Services → Library** → povol podle modulů:
   - `Google Analytics Data API` (pro `ga4`),
   - `Google Search Console API` (pro `gsc` i `indexace`).
3. **IAM & Admin → Service Accounts → Create service account** (žádné role
   v projektu nepotřebuje) → **Keys → Add key → Create new key → JSON**.
4. JSON stáhne uživatel; ty ho ulož na server a zamkni:

   ```bash
   # obsah JSON vlož do souboru (editorem, nebo heredocem se STAŽENÝM obsahem)
   chmod 600 ~/mission-control/secrets/google.json
   ```

5. Zjisti e-mail service accountu — ten se přidává do property:

   ```bash
   jq -r '.client_email' ~/mission-control/secrets/google.json
   ```

Cesta ke klíči v configu (`keyFile`) může být relativní vůči kořeni instalace
(`secrets/google.json`) — to je i výchozí hodnota, takže ji obvykle stačí
vynechat.

⚠ Klíč nikdy necituj do chatu a nikdy ho nedávej do `mc.config.json` — do
configu patří jen **cesta** k souboru.

#### ga4

1. V Google Analytics: **Admin → Property access management → +** → přidej
   e-mail service accountu s rolí **Viewer**.
2. **Property ID** je číselné (Admin → Property details), např. `123456789` —
   ne „G-XXXX" (to je measurement ID).
3. `host` = doména, kterou modul očekává; kolektor si ověří, že property
   opravdu reportuje tenhle hostname (ochrana proti prohozené property).

```json
"ga4": {
  "keyFile": "secrets/google.json",
  "sites": [
    { "id": "web", "label": "Firemní web", "property": "123456789", "host": "example.com" }
  ],
  "timezone": "Europe/Prague"
}
```

**OVĚŘ:** restart + `curl -s http://127.0.0.1:8088/api/status | jq '.ga4'`
(první plný sběr může trvat desítky sekund) a `journalctl --user -u mission-control -n 40 --no-pager | grep ga4`
— řádek `MISMATCH` znamená špatně spárovanou property a `host`.

#### gsc

1. V Search Console: **Nastavení → Uživatelé a oprávnění → Přidat uživatele**
   → e-mail service accountu → oprávnění **Full** (`indexace` níž ho vyžaduje,
   pro samotné `gsc` by stačilo Restricted — dej rovnou Full, ať to sedí).
2. `property` piš **přesně tak, jak je v Search Console**: buď URL-prefix
   `https://example.com/` (včetně koncového lomítka), nebo doménová property
   `sc-domain:example.com`.

```json
"gsc": {
  "keyFile": "secrets/google.json",
  "sites": [
    { "id": "web", "label": "Firemní web", "property": "https://example.com/" }
  ],
  "windowDays": 90
}
```

**OVĚŘ:** `curl -s http://127.0.0.1:8088/api/status | jq '.gsc'`. Search
Console data mají zpoždění ~2 dny — prázdné „dnes" není chyba.

#### indexace

Stav indexace stránek přes **URL Inspection API** — autoritativní a zdarma,
ale s kvótou **2000 URL / den / property**. Modul si proto bere jen tolik URL
denně, zbytek dobere další den (rotace). Běží 1×/24 h.

```json
"indexace": {
  "keyFile": "secrets/google.json",
  "sites": [
    { "id": "web", "label": "Firemní web",
      "property": "https://example.com/",
      "sitemap": "https://example.com/sitemap.xml" }
  ],
  "languageCode": "cs-CZ",
  "maxUrls": 2000
}
```

`sitemap` je **povinná** (nic se nehádá) — sitemap index s odkazy na další
sitemapy je v pořádku, modul je projde. `property` musí pokrývat URL ze
sitemap, jinak je Google odmítne.

**OVĚŘ:** `curl -s http://127.0.0.1:8088/api/status | jq '.indexace'` —
sleduj `total`/`indexed`; první běh nad velkým webem trvá dlouho (rate limit).

### 4c) claudelimits

Panel s vytížením limitů účtu. Čte **jen** lokální `~/.claude/.credentials.json`
(read-only, nikdy nezapisuje) — funguje tedy pro předplatné přihlášené ve
fázi 3, ne pro API klíč.

```json
"claudelimits": {}
```

**OVĚŘ:** `curl -s http://127.0.0.1:8088/api/status | jq '.claudeLimits'`
(pozor, klíč je camelCase).

### 4d) wpsched

Read-only přehled naplánovaných příspěvků ve WordPressu přes REST API. Modul
posílá **výhradně GET** — na web nikdy nic nezapíše.

1. Ve WordPressu: **Uživatelé → profil → Aplikační hesla** → nové heslo
   (pojmenuj třeba „Mission Control"). Heslo se zobrazí jednou.
2. Ulož ho na server (jen heslo, nic víc):

   ```bash
   printf '%s' 'xxxx xxxx xxxx xxxx xxxx xxxx' > ~/mission-control/secrets/wp-web.pass
   chmod 600 ~/mission-control/secrets/wp-web.pass
   ```

```json
"wpsched": {
  "sites": [
    { "id": "web", "label": "Firemní web", "url": "https://example.com",
      "user": "<WP login>", "appPasswordFile": "secrets/wp-web.pass" }
  ]
}
```

Heslo se čte líně při každém refreshi — otočení hesla ve WordPressu se projeví
bez restartu MC.

**OVĚŘ:** `curl -s http://127.0.0.1:8088/api/status | jq '.wpsched'` — `ok:true`
a počet budoucích příspěvků. `ok:false` s `err` řekne, co chybí (typicky špatný
`user`, nebo heslo se zalomeným řádkem).

### 4e) nanoclaw

[NanoClaw](https://github.com/nanocoai/nanoclaw) je osobní Claude asistent
napojený na messaging (Telegram, WhatsApp, Discord, Slack…). Mission Control
nad ním dělá **read-only panel** (stav služby, seznam agentů, poslední
aktivita) — nic do něj nezapisuje a žádný jeho kód neobsahuje.

Instalace (na stejném boxu, **nikdy pod rootem**):

```bash
git clone https://github.com/nanocoai/nanoclaw.git ~/nanoclaw
cd ~/nanoclaw && bash nanoclaw.sh
```

Instalátor je interaktivní a provede řadu kroků: prostředí → build kontejneru →
trezor na tajemství → přihlášení Claude → mounty → systemd služba → CLI agent →
časové pásmo → kanál → závěrečné ověření. Co u toho potřebuješ vědět:

- **Docker** si instalátor doinstaluje sám (build image trvá 3–10 min).
  Počítej s RAM — na 8GB boxu neplánuj nic dalšího náročného ve stejnou chvíli.
- **Kanál** — nejsnazší je **Telegram**: uživatel si u `@BotFather` založí bota,
  vloží token, instalátor ověří `getMe` a pošle do chatu párovací kód.
  **ZEPTEJ SE**, jaký kanál chce (Telegram / WhatsApp / jiný).
- **Jméno asistenta** — `ASSISTANT_NAME` v `~/nanoclaw/.env`, zároveň trigger
  `@<jméno>` ve skupinách. **ZEPTEJ SE** na jméno (default „Andy").
- **Přihlášení Claude** — nabídne se předplatné (přes `claude setup-token`),
  OAuth token nebo API klíč. Na headless serveru je nejjednodušší token
  vygenerovaný na desktopu.
- **Osobnost** prvního agenta se píše do `~/nanoclaw/groups/<folder>/CLAUDE.local.md`
  (`CLAUDE.md` ve stejné složce negeneruj ručně — skládá ho host při spuštění).
- Služba je **systemd --user** unit `nanoclaw-v2-<slug>` (slug je odvozený
  z cesty, takže víc instalací na jednom boxu se nehádá) + `loginctl enable-linger`.
- Test konverzace: `cd ~/nanoclaw && pnpm run chat hi`, logy v
  `~/nanoclaw/logs/nanoclaw.log`.
- Volitelně existuje oficiální dashboard (skill `/add-dashboard`). Poslouchá
  na `0.0.0.0` — pokud ho zapneš, **schovej ho za firewall/tailnet**.

Teprve pak sekce v configu:

```json
"nanoclaw": { "dir": "~/nanoclaw" }
```

**OVĚŘ:**

```bash
systemctl --user list-units 'nanoclaw-v2-*' --no-legend --plain
curl -s http://127.0.0.1:8088/api/status | jq '.nanoclaw'
```

Panel má hlásit `state` podle unity a seznam agentů. `state: "off"` znamená,
že `dir` neukazuje na instalaci (zkontroluj, že existuje `~/nanoclaw/data/v2.db`).

### 4f) watchdog

Hodinový **hlídač cronů a vypravěč**: cron spustí headless Claude, ten si
udělá snímek systému (`watchdog/check.sh`), zkontroluje služby, běžící procesy
a nové řádky logů, provede jen **bezpečné** opravy a napíše český narativní
řádek za každý projekt + strojový záznam do historie, ze které MC dělá výstrahy.

1. **Projekty** — **ZEPTEJ SE**, co má hlídat (typicky: každý cron/služba, o
   kterých chce uživatel vidět deník). Zapiš do configu:

   ```json
   "watchdog": {
     "model": "sonnet",
     "budgetUsd": 1.0,
     "timeoutSecs": 600,
     "permissionMode": "safe",
     "projects": [
       { "id": "zaloha", "label": "Zálohy", "sources": "/home/<uživatel>/zalohy/logs/backup.log" }
     ]
   }
   ```

   `id` = kebab-case, max 32 znaků (je z něj jméno souboru narativu
   `data/narrative/<id>.log`) — tohle je **jediný zdroj pravdy**, prompt
   hlídače i shell smyčky se z něj generují.

2. **`permissionMode` — rozhodnutí o bezpečnosti. ZEPTEJ SE uživatele:**
   - `safe` (**výchozí, doporučené**): hlídač běží bez
     `--dangerously-skip-permissions`, jen s úzkým seznamem nástrojů (číst
     soubory, spustit `check.sh`, `echo` do narativů, `systemctl --user`).
     Umí restartovat spadlou uživatelskou službu; zaseknuté procesy a stale
     locky jen **nahlásí**.
   - `full`: hlídač dostane `--dangerously-skip-permissions` a smí i zabíjet
     procesy podle PID a mazat stale locky.
     **Trade-off:** hlídač čte logy, a do logů může psát kdokoli, kdo mluví
     s tvými službami (web server, cizí API). Takový text je pro agenta vstup
     — v `full` režimu je to cesta k prompt injection a spuštění libovolného
     příkazu pod tvým účtem. Zapínej `full` jen na boxu, kde všem sledovaným
     logům plně důvěřuješ.

3. **Crontab řádek.** Použij postup ze skillu **`novy-cron`** (viz fáze 6 —
   nainstaluj skilly nejdřív). Minuta `:40` je dobrá volba: mimo `:00`, kdy
   startuje kdekoli co, a mimo systémový `run-parts` (`:17` na Debianu/Ubuntu).

   ```bash
   crontab -l 2>/dev/null | { cat; echo ""; echo "# Mission Control · hodinový hlídač cronů + vypravěč"; echo "40 * * * * $HOME/mission-control/watchdog/run-watchdog.sh >> $HOME/mission-control/data/watchdog.log 2>&1"; } | crontab -
   ```

   Nechávej `>> … 2>&1` — bez logu nemá hlídač co ukázat a sám sebe by neuhlídal.

4. Rozpočet: jeden běh vyjde řádově na jednotky až desítky centů (model
   `sonnet`). `budgetUsd` je **pojistka proti ujetému běhu**, ne cíl —
   nesnižuj ji pod ~0,5 $, jinak budeš zabíjet zdravé běhy uprostřed.

**OVĚŘ:**

```bash
crontab -l | grep -A1 "hlídač cronů"
python3 ~/mission-control/claude/skills/novy-cron/next_run.py "40 * * * *"
node ~/mission-control/watchdog/gen.mjs projects        # vypíše id projektů z configu
bash ~/mission-control/watchdog/run-watchdog.sh          # první ostrý běh (2–4 min, stojí peníze)
tail -n 20 ~/mission-control/data/watchdog.log
curl -s http://127.0.0.1:8088/api/status | jq '.watchdog'
node ~/mission-control/bin/mc-smoke.js --alerts-only     # teď už proběhne i test výstrah
```

Po prvním běhu musí v `data/narrative/<id>.log` přibýt řádek ve tvaru
`[YYYY-MM-DD HH:MM] <emoji> …` a v `data/watchdog-history.jsonl` jeden JSON
řádek. `mc-smoke.js --alerts-only` projde celý životní cyklus výstrahy a po
sobě uklidí.

---

## Fáze 5 — Zpřístupnění z prohlížeče

Mission Control **nemá vlastní přihlašování** a poslouchá jen na `127.0.0.1`.
Kdo se k němu dostane, má terminál s Claude Code na tvém serveru — tedy
plnou kontrolu nad boxem. Vrstva před ním proto není detail.

**ZEPTEJ SE**, jakou cestu uživatel chce.

### 5a) Tailscale (doporučeno)

Privátní síť, do které se nikdo zvenčí nedostane; HUD je dostupný jen ze
zařízení uživatele.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 8088
tailscale serve status
```

`serve` vystaví HUD na `https://<jméno-stroje>.<tailnet>.ts.net` (port 443
uvnitř tailnetu, s platným certifikátem). V admin konzoli Tailscalu musí být
zapnuté **MagicDNS** a **HTTPS Certificates** (DNS → HTTPS Certificates).

⚠ **Nepoužívej `tailscale funnel`** — to je veřejný internet bez
přihlašování.

Po zapnutí si `mc-open`/`mc-preview` odvodí veřejnou URL samy z
`tailscale status`. Pokud ne, dopiš ji do `mc.config.json` jako
`"publicUrl": "https://<host>.<tailnet>.ts.net"`.

### 5b) SSH tunel (nulová konfigurace, jen pro sebe)

Nic se nevystavuje; uživatel si tunel otevře, když HUD potřebuje:

```bash
ssh -N -L 8088:127.0.0.1:8088 <uživatel>@<ip>
# pak v prohlížeči: http://localhost:8088
```

### 5c) Reverzní proxy (Caddy) s basic auth — jen když to jinak nejde

Vystavuje HUD do veřejného internetu. **Varování uživateli:** basic auth je
jediná bariéra mezi internetem a shellem s Claude Code na jeho serveru; slabé
heslo = ztráta boxu. Vždy jen přes HTTPS a se silným, unikátním heslem.

V Ubuntu universe je Caddy jen ve staré verzi 2.6.x — pro aktuální verzi přidej
oficiální repo (postup z caddyserver.com):

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

caddy hash-password        # zeptá se na heslo a vypíše jeho bcrypt hash
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
```

`/etc/caddy/Caddyfile`:

```
mc.example.com {
    basic_auth {
        admin <bcrypt-hash-z-caddy-hash-password>
    }
    reverse_proxy 127.0.0.1:8088
}
```

```bash
sudo systemctl reload caddy
```

(Na starších Caddy 2.x se direktiva jmenuje `basicauth` — `caddy validate
--config /etc/caddy/Caddyfile` ti to řekne.) WebSockety pro terminály
`reverse_proxy` propouští sám, nic dalšího nastavovat nemusíš. Doména musí mít
A/AAAA záznam na server, jinak Caddy nedostane certifikát.

**OVĚŘ (fáze 5):** otevři výslednou URL v **reálném prohlížeči** a zkontroluj:
HUD se vykreslí, panely mají data, terminál v drawéru naběhne a Jarvis
odpovídá. Screenshot nebo potvrzení od uživatele je součást „hotovo".

```bash
tailscale serve status          # varianta 5a
curl -s http://127.0.0.1:8088/api/health
```

---

## Fáze 6 — Dokončení

### 6a) Nainstaluj Claude vrstvu (skilly + CLAUDE.md)

Aby tvůj (i budoucí) Claude na tomhle boxu věděl, jak se tu pracuje:

```bash
mkdir -p ~/.claude/skills
rm -rf ~/.claude/skills/novy-cron ~/.claude/skills/mc-restore-terminals
cp -r ~/mission-control/claude/skills/novy-cron ~/.claude/skills/
cp -r ~/mission-control/claude/skills/mc-restore-terminals ~/.claude/skills/
sed "s|{{MC_DIR}}|$HOME/mission-control|g" ~/mission-control/claude/CLAUDE.md.template \
  >> ~/.claude/CLAUDE.md
```

(`rm -rf` na začátku je kvůli opakované instalaci: `cp -r` do existujícího
adresáře se stejným jménem by vyrobil vnořenou kopii.)

⚠ Pokud `~/.claude/CLAUDE.md` už existuje, obsah **připoj** (jako výš přes
`>>`) a pak ho projdi — ať tam nejsou dvě protichůdné instrukce.

Co tím box získá: `mc-open`/`mc-preview` místo mrtvých cest na disku, pravidlo
„hotovo = ověřeno" (`mc-smoke.js` po změnách MC), závazný postup pro každou
novou opakovanou úlohu (`novy-cron`) a obnovu terminálů po pádu tmuxu
(`mc-restore-terminals`).

### 6b) Rekapitulace pro uživatele

Napiš uživateli shrnutí — konkrétně, ne obecně:

- **URL HUD** a jak se k němu dostat (tailnet / tunel / doména).
- **Zapnuté moduly** a co v HUD uvidí.
- **Přihlášení Claude** — čí účet, jaký plán, kde se to projeví (terminály,
  Jarvis, hlídač).
- **Založené crony** (řádek + příští běh z `next_run.py`).
- **Kde je config**: `~/mission-control/mc.config.json`, tajemství
  v `~/mission-control/secrets/` (chmod 600), oboje mimo git.

### 6c) Jak se to rozšiřuje později

- **Přidat web/službu do modulu**: dopiš položku do `sites[]` příslušné sekce
  v `mc.config.json` → `systemctl --user restart mission-control`.
- **Zapnout další modul**: přidej jeho sekci (tvary jsou v
  `mc.config.example.json`) → restart. **Vypnout** = sekci smazat.
- **Přidat terminálový projekt**: položka v `terminals.projects`
  (`{"key","label","dir"}`) → restart. Klíč musí sedět na `^[a-z0-9]{1,16}$`.
- **Sledované systemd jednotky** (panel se stavem služeb): přidej položku do
  `services[]` v `mc.config.json` (`{"unit", "label"?, "scope"?: "user"|"system"}`,
  vzor v `mc.config.example.json`) → `systemctl --user restart mission-control`.
  Klíč v configu chybí = default `mission-control`, `mc-ttyd`, `tailscaled`,
  `fail2ban`; jakmile je `services[]` v configu, nahrazuje ho úplně (žádné
  auto-sčítání) — chceš-li default vidět dál, vypiš ho v configu taky.
  `scope: "user"` navíc jde restartovat z příkazové palety (systémové jednotky
  restart vyžadují sudo, který tenhle allowlist záměrně nedělá).
- **Nová opakovaná úloha**: vždy skillem `novy-cron` (crontab + důkaz +
  narativ), nikdy slibem.
- **Upgrade balíčku**: `git -C ~/mission-control pull` →
  `bash ~/mission-control/bin/mc-safe-restart.sh`. `mc.config.json`, `mc.env`,
  `data/` i `secrets/` jsou mimo git, takže je pull nepřepíše. Kdyby přibyly
  nové systemd unity, zkopíruj je znovu do `~/.config/systemd/user/`
  a `systemctl --user daemon-reload`.

**OVĚŘ (závěr):**

```bash
systemctl --user --no-pager status mission-control mc-ttyd | grep -E 'Loaded|Active'
curl -s http://127.0.0.1:8088/api/status | jq '{branding, modules}'
node ~/mission-control/bin/mc-smoke.js
ls ~/.claude/skills
```

Teprve když tohle projde a uživatel potvrdí, že HUD v prohlížeči žije, je
instalace hotová.
