#!/usr/bin/env node
// Mission Control — watchdog/gen.mjs
//
// JEDINÝ zdroj pravdy pro watchdog projekty/parametry je CFG.modules.watchdog
// (config.js) — v původním interním systému byl počet projektů natvrdo rozházený
// na 4 místech (run-watchdog.sh, check.sh, prompt tabulka, timeline.js) a
// časem se rozjel (podle interní research přípravy balíčku k watchdogu a
// skillům, §A3). Tenhle skript z configu generuje vše, co watchdog/*.sh
// potřebují — volá ho run-watchdog.sh na začátku KAŽDÉHO běhu (config změny
// se tak propíšou bez restartu Mission Control).
//
// Subcommands:
//   node gen.mjs prompt    -> zapíše data/watchdog-prompt.md z
//                              watchdog/prompt-template.md, vypíše absolutní
//                              cestu k výsledku na stdout
//   node gen.mjs projects  -> vypíše id projektů, jeden na řádek (pro
//                              `mapfile -t PROJECTS < <(node gen.mjs projects)`)
//   node gen.mjs env       -> vypíše WATCHDOG_MODEL=…/WATCHDOG_BUDGET=…/
//                              WATCHDOG_TIMEOUT=…/WATCHDOG_PERMISSION_MODE=…
//                              — config-based DEFAULTY. run-watchdog.sh
//                              NEDĚLÁ shell `eval` nad tímhle výstupem (to by
//                              spustilo, cokoli by tam bylo) — vytáhne
//                              jednotlivé hodnoty přes `sed -n
//                              's/^WATCHDOG_X=//p'` a teprve pak je použije
//                              jako ${VAR:-…} fallback, který smí přebít
//                              vlastní env volajícího (viz run-watchdog.sh
//                              hlavička).
import fs from 'node:fs';
import path from 'node:path';
import {
  WATCHDOG_PROJECTS, WATCHDOG_MODEL, WATCHDOG_BUDGET, WATCHDOG_TIMEOUT,
  WATCHDOG_PERMISSION_MODE, WATCHDOG_PROMPT_TEMPLATE, WATCHDOG_PROMPT_OUT,
  NARRATIVE_DIR, MC_DIR,
} from '../config.js';

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function projectsTable() {
  if (!WATCHDOG_PROJECTS.length) {
    return '_(v configu není nastaven žádný projekt — `modules.watchdog.projects` je prázdné pole nebo chybí)_';
  }
  const rows = WATCHDOG_PROJECTS.map((p) => {
    const narr = path.join(NARRATIVE_DIR, `${p.id}.log`);
    const sources = (p.sources && String(p.sources).trim())
      || (p.log && String(p.log).trim())
      || '(viz obecná sekce „nové řádky sledovaných logů" ve snapshotu)';
    return `| ${p.label || p.id} | \`${narr}\` | ${sources} |`;
  });
  return `| Projekt | Narativní log | Zdroje pravdy (čti tail/DB) |\n|---|---|---|\n${rows.join('\n')}`;
}

// Fix round 1 (finding 1, controller-ruled): whitelist bezpečných oprav je
// permissionMode-aware — v 'safe' módu run-watchdog.sh spouští claude BEZ
// --dangerously-skip-permissions a jen s úzkým --allowedTools allowlistem
// (žádný obecný Bash, tedy žádný `kill`/`rm`), takže agent zaseknuté procesy
// a stale locky FYZICKY nemůže sám opravit — smí je jen ohlásit. Restart
// USER systemd jednotky zůstává i v safe módu povolený, protože
// run-watchdog.sh mu na to dává explicitní `Bash(systemctl --user:*)`
// pravidlo. V 'full' módu (--dangerously-skip-permissions, explicitní
// opt-in v mc.config.json) platí původní plná whitelist vč. kill dle PID.
function safeFixesSection(mode) {
  if (mode === 'full') {
    return `**Bezpečné opravy, které SMÍŠ provést (NIC JINÉHO):**
1. **Zabít proces — JEN když je PROKAZATELNĚ zaseknutý** (nikdy jen podle
   délky běhu!): najdi konkrétní PID přes \`ps\`, ověř znovu \`ps -p <PID>\`
   těsně před zásahem, pak \`kill -TERM <PID>\`. Smaž případný lock soubor,
   který proces držel, teprve POTÉ, co je proces skutečně mrtvý.
2. **Smazat stale lock** (nejdřív ověř \`ps\`, že vlastník nežije — nikdy
   neber jen stáří souboru jako důkaz).
3. **Restartovat spadlou systemd jednotku** ze sekce „systemd failed
   jednotky" — \`systemctl restart <jednotka>\` (nebo \`--user\`, podle
   sekce) JEDNOU, pak ověř \`systemctl is-active\`. Když se nenahodí
   napodruhé, nech být a dej alert.

Cokoli jiného → jen alert. Nikdy needituj konfigurační soubory, nikdy nemaž
data, nikdy nespouštěj deploy/build/publish příkazy.

### ⚠️ Jak bezpečně zabíjet
Zabíjej **podle čísla PID** z \`ps\`. **NIKDY** \`pkill -f\`/\`pgrep -f\` s
patternem, který může sedět i na tvůj vlastní shell/proces — zabil bys sám
sebe. Vždy \`kill -TERM <PID>\`, pak ověř \`ps -p <PID>\`.`;
  }
  // 'safe' (default): úzký --allowedTools allowlist ti fyzicky nedovolí kill
  // ani mazání souborů (viz hlavička run-watchdog.sh) — netvař se, že to
  // zkusíš, jen popiš problém do alertů.
  return `**Bezpečné opravy, které SMÍŠ provést (NIC JINÉHO) — SAFE mode:**
Běžíš v SAFE módu (\`modules.watchdog.permissionMode\` je \`safe\`, výchozí
nastavení): máš k dispozici jen úzký seznam nástrojů (\`Read\`, \`Grep\`,
\`Glob\`, spuštění \`{{MC_DIR}}/watchdog/check.sh\`, validovaný append
\`bash {{MC_DIR}}/watchdog/append.sh <history|projekt-id> "<text>"\` pro zápis
do narativů/historie a \`systemctl --user restart\`/\`systemctl --user
is-active\`). **Obecný \`Bash\` (tedy ani \`kill\`, \`pkill\`, \`rm\`, holé
\`echo\` ani jiný příkaz mimo tenhle seznam) NEMÁŠ povolený a spuštění by ti
bylo zamítnuto** — proto:
1. **Restartovat spadlou USER systemd jednotku** ze sekce „systemd failed
   jednotky" smíš — \`systemctl --user restart <jednotka>\` JEDNOU, pak ověř
   \`systemctl --user is-active\`. Když se nenahodí napodruhé, nech být a
   dej alert. (Systémové, non-user jednotky v SAFE módu NERESTARTUJEŠ —
   jen alert.)
2. **Zaseknutý proces nebo stale lock POUZE NAHLAS, NEZASAHUJ.** Do
   \`alerts\` napiš PID, jak dlouho běží, cestu k locku a proč to vypadá
   zaseknuté — provozovatel to doladí ručně (nebo přepne modul do
   \`permissionMode: 'full'\`, pokud chce, aby hlídač zasahoval sám).

Cokoli jiného → jen alert. Nikdy needituj konfigurační soubory, nikdy nemaž
data, nikdy nespouštěj deploy/build/publish příkazy — v SAFE módu to navíc
ani technicky nejde, protože k tomu nemáš povolený žádný nástroj.`;
}

function renderPrompt() {
  let tpl;
  try { tpl = fs.readFileSync(WATCHDOG_PROMPT_TEMPLATE, 'utf-8'); }
  catch (e) { fail(`nejde přečíst šablonu ${WATCHDOG_PROMPT_TEMPLATE}: ${e.message}`); return; }
  const out = tpl
    .replaceAll('{{PROJECTS_TABLE}}', projectsTable())
    .replaceAll('{{SAFE_FIXES}}', safeFixesSection(WATCHDOG_PERMISSION_MODE))
    .replaceAll('{{MC_DIR}}', MC_DIR);
  fs.mkdirSync(path.dirname(WATCHDOG_PROMPT_OUT), { recursive: true });
  fs.writeFileSync(WATCHDOG_PROMPT_OUT, out, 'utf-8');
  process.stdout.write(WATCHDOG_PROMPT_OUT + '\n');
}

function printProjects() {
  for (const p of WATCHDOG_PROJECTS) process.stdout.write(p.id + '\n');
}

function printEnv() {
  process.stdout.write(`WATCHDOG_MODEL=${WATCHDOG_MODEL}\n`);
  process.stdout.write(`WATCHDOG_BUDGET=${WATCHDOG_BUDGET}\n`);
  process.stdout.write(`WATCHDOG_TIMEOUT=${WATCHDOG_TIMEOUT}\n`);
  process.stdout.write(`WATCHDOG_PERMISSION_MODE=${WATCHDOG_PERMISSION_MODE}\n`);
}

const cmd = process.argv[2];
if (cmd === 'prompt') renderPrompt();
else if (cmd === 'projects') printProjects();
else if (cmd === 'env') printEnv();
else fail('použití: node gen.mjs <prompt|projects|env>');
