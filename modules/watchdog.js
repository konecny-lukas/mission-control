// Mission Control — modul WATCHDOG: read-only panel/drawer nad výstupem
// hodinového cron-watchdog agenta (watchdog/run-watchdog.sh, spuštěného
// z vnějšího cronu — viz INSTALL.md). Tenhle modul NIKDY nespouští claude
// ani nezapisuje do watchdog-history.jsonl / narrative/*.log — jen je ČTE:
//   a) `data/watchdog-history.jsonl` — poslední zápisy hlídače (ts ISO,
//      overall ok|fixed|alert, projects, actions, alerts[]), viz
//      watchdog/prompt-template.md „Výstup (POVINNÉ, na konci)".
//   b) `data/narrative/<id>.log` per projekt (config.js WATCHDOG_PROJECTS) —
//      readNarrative() z collectors.js.
// Stejný I/O vzor jako alerts.js watchdogLatest(): tail posledních bajtů
// souboru, parsuj po řádcích jako JSON, přeskoč nedokončený/poškozený řádek
// (log_offsets.py je ostatně píše atomicky přes append, ale i tak — obranná
// kostra jako všude jinde v tomhle repu).
import fs from 'node:fs';
import * as C from '../config.js';
import { readNarrative } from '../collectors.js';

const HISTORY_TAIL_BYTES = 65536; // dost na desítky posledních JSON řádků (~200-400 B/řádek)
const HISTORY_KEEP = 5;           // kolik posledních záznamů drawer ukazuje (brief: "posledních 5 history záznamů")
const FRESH_MS = 2 * 3600_000;    // stejná freshness brána jako alerts.js (2 h) — mrtvý hlídač nesmí napořád tvářit jako 'ok'

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Přečte posledních HISTORY_TAIL_BYTES bajtů watchdog-history.jsonl a
// naparsuje validní JSON řádky. Nikdy nevyhodí — chybějící/nečitelný/
// poškozený soubor vrátí prázdné pole (= "hlídač ještě neběžel").
function readHistoryTail() {
  let fd;
  try {
    fd = fs.openSync(C.WATCHDOG_HISTORY, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - HISTORY_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf-8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // zahoď nedočtený první řádek okna
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const j = JSON.parse(line); if (j && j.ts) entries.push(j); } catch { /* nedopsaný/poškozený řádek — přeskoč */ }
    }
    return entries;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// Snímek pro panel #p-watchdog + drawer 'watchdog'. Čistě synchronní čtení
// z disku (malé soubory, žádná síť) — volá se přímo z server.js moduleLoop,
// žádný samostatný async refresh krok jako u modulů se skutečným I/O na síť.
export function collectWatchdog() {
  const entries = readHistoryTail();
  const history = entries.slice(-HISTORY_KEEP).reverse(); // nejnovější první
  const last = history[0] || null;

  let state = 'warn'; // default: hlídač ještě nikdy neběžel (žádný history záznam) — nikdy 'ok' bez důkazu
  if (last) {
    const ts = Date.parse(last.ts);
    const stale = !Number.isFinite(ts) || (Date.now() - ts > FRESH_MS);
    state = last.overall === 'alert' ? 'warn' : (stale ? 'warn' : 'ok');
  }

  const projects = C.WATCHDOG_PROJECTS.map((p) => ({
    id: p.id,
    label: p.label || p.id,
    narrative: readNarrative(p.id, 14),
  }));

  return { state, updatedAt: mtimeOf(C.WATCHDOG_HISTORY) || null, last, history, projects };
}
