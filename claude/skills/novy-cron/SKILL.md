---
name: novy-cron
description: Závazný postup pro založení KAŽDÉ nové opakované úlohy na serveru — skutečný crontab záznam s důkazem (řádek + next-run čas), volný slot v denním rozvrhu (RAM), napojení na Mission Control (narativ + hlídač cronů) a rotace logů. Použij vždy, když padne „každý den choď a…", „pravidelně kontroluj…", „nastav cron", „automatizuj to", „jednou týdně spusť…", „hlídej mi to" — a taky vždy, když sám slibuješ jakoukoli opakovanou činnost. Slíbená automatizace bez crontab řádku NEEXISTUJE (session skončí a nikdo nikam „chodit" nebude).
---

# Nový cron (novy-cron)

**Slíbená automatizace bez crontab řádku NEEXISTUJE.** Agent po konci session
neběží — „budu to každý den kontrolovat" je prázdný slib, dokud pro to není
záznam v crontabu. Proto: žádné „budu to dělat", jen crontab + důkaz v chatu.
Checklist níž je **závazný celý**, v tomhle pořadí.

V cestách níž znamená `<MC_DIR>` kořen instalace Mission Control (typicky
`~/mission-control`, absolutně `/home/<uživatel>/mission-control`) — vždy
dosaď skutečnou absolutní cestu, cron `~` neexpanduje.

## Závazný checklist

### 1. Skutečný crontab záznam (append, nikdy přepis)

```bash
crontab -l | { cat; echo ""; echo "# <projekt> · <co dělá> (<kdy, slovy>)"; echo "<m> <h> <dom> <mon> <dow> /bin/bash /home/<uživatel>/<projekt>/<skript>.sh >> /home/<uživatel>/<projekt>/logs/<nazev>.log 2>&1"; } | crontab -
```

- **Vždy absolutní cesty** (cron má minimální prostředí, žádné `~`, žádné
  proměnné z tvého shellu).
- **Vždy `>> …log 2>&1` — nikdy `/dev/null`.** Log je vstupenka do hlídače
  cronů: watchdog si sledované logy bere automaticky z crontabu (krok 5).
  Přesměrování do `/dev/null` = úloha, jejíž tiché selhání nikdo nikdy neuvidí.
- Komentářový řádek nad záznamem, česky, ve stejném stylu jako zbytek crontabu.
- Těžká úloha = **wrapper skript**, ne dlouhý příkaz přímo v crontabu. Vzor:
  `<MC_DIR>/watchdog/run-watchdog.sh` — exportuje `HOME` a `PATH` (cron nemá
  `~/.local/bin` na PATH, tedy ani `claude`), obaluje běh `timeout`em a
  u headless Claude přidává `--max-budget-usd`.

### 2. Důkaz do chatu (řádek + next-run)

Bez tohohle úloha „není nastavená". Ukaž uživateli obojí:

```bash
crontab -l | grep -B1 "<skript>"
python3 ~/.claude/skills/novy-cron/next_run.py "<m> <h> <dom> <mon> <dow>"
```

`next_run.py` (součást tohohle skillu, čistý stdlib — croniter na serveru být
nemusí) vypíše 3 příští spuštění v lokálním čase + „za kolik". Umí i celý
řádek: `next_run.py --line '<celý crontab řádek>'`. Výstup vlož do chatu.

### 3. Najdi volný slot (RAM a kolize)

Cron nemá tušení, kolik toho na stroji zrovna běží — rozvrh je na tobě.

```bash
crontab -l                      # co už je obsazené (a v jakých minutách)
grep run-parts /etc/crontab     # systémový rozvrh: hodinový run-parts má svou minutu
free -h                         # kolik RAM reálně zbývá
```

- **Vypiš si obsazené minuty a hodiny z `crontab -l`** a vyber slot, kde nic
  jiného neběží.
- **Na malém VPS (4–8 GB) max 1 headless Claude naráz** — každá session je
  řádově stovky MB. Dvě těžké úlohy ve stejnou hodinu = riziko OOM, a OOM
  na tomhle boxu bere s sebou i terminálové tmux sessions.
- Počítej s **přetečením**: úloha naplánovaná na celou hodinu může běžet 60+
  minut a zasáhnout do dalšího slotu. Mezi dvěma Claude úlohami nech rezervu.
- **Minutu volit mimo `:00`** (tam startuje kdekdo) a **mimo minutu
  systémového `run-parts`** z `/etc/crontab` (na Debianu/Ubuntu typicky `:17`)
  — jinak se starty zbytečně mačkají.

### 4. Viditelnost v Mission Control

- Cron log z kroku 1 se v MC objeví sám (panel s hlídačem cronů čte logy
  z crontabu). U headless Claude proto **vždy `claude -p` (print-mode)**: do
  logu jde jen finální shrnutí a log zůstane čitelný. Vzor:
  `<MC_DIR>/watchdog/run-watchdog.sh`.
- Chce-li uživatel k projektu **narativní kartu** (český vypravěč, řádek za
  každý běh), narativ se píše do `<MC_DIR>/data/narrative/<id>.log` ve formátu:

  ```
  [YYYY-MM-DD HH:MM] <emoji> <jedna věta česky, co se stalo>
  ```

  Legenda emoji: `🟢` běží · `⏳` čeká/probíhá · `✅` hotovo · `⚠️` varování ·
  `🔴` chyba · `💤` klid, nic se nedělo. Řádek si může připisovat sám skript
  (`echo "[$(date '+%Y-%m-%d %H:%M')] ✅ …" >> …`), nebo ho za projekt píše
  hlídač cronů.
- Aby MC kartu/deník vykreslilo, **přidej projekt do `mc.config.json`**:

  ```json
  { "modules": { "watchdog": { "projects": [
      { "id": "<id>", "label": "<Jméno projektu>", "sources": "/home/<uživatel>/<projekt>/logs/<nazev>.log" }
  ] } } }
  ```

  `id` = kebab-case (a-z, 0-9, pomlčka, max 32 znaků) a zároveň jméno souboru
  narativu. Config je **jediný zdroj pravdy** — prompt hlídače i shell smyčky
  se z něj generují (`node <MC_DIR>/watchdog/gen.mjs prompt`), nikde se seznam
  projektů nepíše podruhé. Po změně configu:
  `systemctl --user restart mission-control`.

### 5. Registrace u hlídače cronů (hlídání tichého selhání)

Watchdogův `check.sh` si sledované logy bere **automaticky z crontabu**: každý
`>>` cíl kromě `/dev/null`. Správný redirect z kroku 1 tedy stačí. Ověř to
**stejnou extrakcí, jakou používá `check.sh`** — samotný `check.sh`
**NESPOUŠTĚJ**: posunul by byte-offsety a hlídač by o ty řádky přišel.

```bash
crontab -l | grep -vE '^[[:space:]]*#' | grep -oE '>>[[:space:]]*[^[:space:]]+' \
  | sed -E 's/^>>[[:space:]]*//' | grep -v '^/dev/null$' | grep "<tvůj log>"
```

Píše-li skript i **interní logy** mimo cron redirect (vlastní soubor, do
kterého si loguje sám), přidej je do pole `LOGS` v `<MC_DIR>/watchdog/check.sh`
(sekce „nové řádky sledovaných logů").

### 6. Rotace / úklid logů

Pokud job píše soubory nebo log roste rychle, přidej úklidový řádek:

```bash
0 3 * * 0   find /home/<uživatel>/<projekt>/logs -name "*.log" -mtime +30 -delete
```

Malé logy (pár řádků denně) rotovat netřeba — nezanášej crontab zbytečně.

## Zákazy a pasti

- **Nikdy neslibuj opakovanou činnost bez crontab záznamu** — to je hlavní
  důvod existence tohohle skillu.
- **Žádné `* * * * *` pro těžké úlohy.** Interval volit podle ceny a délky
  běhu; minutový cron je jen pro triviální, rychlé sondy.
- Nepřepisuj crontab (`crontab <soubor>`) — vždy append přes rouru z kroku 1,
  jinak tiše zahodíš cizí úlohy.
- Cron běží s minimálním prostředím: žádné `nvm`, žádné aliasy, jiný `PATH`,
  jiné `HOME`. Co funguje v tvém shellu, nemusí fungovat v cronu — proto
  wrapper s explicitním exportem.
- Po nasazení zkontroluj **první reálný běh** v logu a napiš uživateli
  výsledek (nebo to nech na hlídači, je-li log registrovaný — krok 5).
