---
name: mc-restore-terminals
description: Obnova ztracených terminálů Mission Control (tmux sessions na socketu -L mc) po pádu tmux serveru, OOM nebo restartu stroje. Použij, když padne „zmizely mi terminály", „obnov terminály", „spadly mi sessions v Mission Control", „ztratil jsem terminál/konverzaci v MC", „tmux server umřel", „po restartu jsou terminály pryč". Skript doplní chybějící sessions podle data/term-labels.json a vypíše příkazy `claude --resume` k navázání konverzací.
---

# Obnova terminálů Mission Control

Terminály MC = tmux sessions `mc-<klíč>-<číslo>` na vyhrazeném socketu `-L mc`.
Když tmux server spadne (typicky OOM), zmizí **všechny naráz** — ale nic není
ztraceno: jména přežívají v `<MC_DIR>/data/term-labels.json` a konverzace na
disku v `~/.claude/projects/<escapovaná-cesta>/<uuid>.jsonl`.

`<MC_DIR>` = kořen instalace Mission Control (typicky `~/mission-control`).

## Postup

1. Nejdřív náhled, co chybí (nic nemění):

   ```bash
   bash <MC_DIR>/bin/mc-restore-terminals.sh --dry-run
   ```

2. Ostrá obnova (idempotentní — existujících sessions se nedotkne, nikdy nic
   nezabíjí):

   ```bash
   bash <MC_DIR>/bin/mc-restore-terminals.sh
   ```

   Chybějící sessions vytvoří jako **detached shell** v adresáři projektu a ke
   každé vypíše kandidátní konverzace (nejnovější první, s úryvkem prvního
   promptu) + přesný příkaz `claude --resume <uuid>`.

3. **Resume nikdy naslepo.** Řiď se výstupem skriptu: v každé obnovené session
   spusť vypsaný příkaz — buď

   ```bash
   tmux -L mc attach -t <session>      # a příkaz napiš uvnitř
   tmux -L mc send-keys -t <session> 'claude --resume <uuid>' Enter
   ```

   Když si uživatel není jistý, KTERÁ konverzace k terminálu patří, ukaž mu
   úryvky kandidátů a nech ho vybrat.

   Pozn.: tmux server terminálů běží pod systemd unitou `mc-ttyd` s vlastním
   `TMUX_TMPDIR` (`<MC_DIR>/data/.tmux`). Když ti `tmux -L mc` hlásí, že žádný
   server neběží, ačkoli terminály v MC žijí, mluvíš s jiným socketem — přidej
   `TMUX_TMPDIR=<MC_DIR>/data/.tmux` před příkaz.

4. **Startuj po dávkách!** Každá Claude session zabere řádově stovky MB RAM.
   Spouštěj max ~4 najednou a mezi dávkami zkontroluj:

   ```bash
   free -h
   ```

   Hromadný start je přesně to, co sessions minule zabilo (OOM → pád tmux
   serveru → tenhle skill).

5. Ověření na závěr:

   ```bash
   node <MC_DIR>/bin/mc-smoke.js --browser-only
   ```

   Ověří jen obecné zdraví HUD (boot v2 doběhl, branding/panely/data se
   vykreslily) a že sám test nezaložil ani se nedotkl žádné tmux session —
   frontend nemá deep-link na konkrétní terminál (`?term=…` je jen v1),
   takže tenhle krok NEOVĚŘUJE konkrétní obnovenou session. Tu potvrdí
   vizuální kontrola v Mission Control (panel Terminál) — jména se
   collectoru obnoví do ~8 s sama. **Teprve pak hlásit hotovo.**
