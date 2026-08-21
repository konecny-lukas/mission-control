#!/usr/bin/env node
// mc-open — ukáže jeden soubor (HTML report, obrázek, PDF, …) v prohlížeči přes
// Mission Control. Vypíše URL /file/<abs-cesta> na tomhle tailnet originu; otevři
// ji v prohlížeči (nová karta). Na celou složku/web nebo dev server použij `mc-preview`.
import fs from 'node:fs';
import path from 'node:path';
import { PORT, HOME } from './config.js';
import { resolvePublicUrl } from './bin/public-url.mjs';

const HOST_URL = (await resolvePublicUrl().catch(() => null)) || `http://localhost:${PORT}`;
// HOME (agenta) se bere z config.js — TÁŽ hodnota, jakou používá server.js
// serveFile() jako hranici /file/ endpointu (MC_AGENT_HOME || os.homedir()).
// Dřív tu byl vlastní `process.env.MC_AGENT_HOME || '/srv/mc'`: na jednoduché
// instalaci (MC běží jako ty, žádné /srv/mc) tím CLI odmítalo úplně všechno,
// co server ochotně servíroval.

const arg = process.argv[2];
if (!arg || ['-h', '--help', 'help'].includes(arg)) {
  const out = arg ? console.log : console.error;
  out(`mc-open — ukaž soubor v prohlížeči přes Mission Control (jen tailnet)

Použití:
  mc-open <soubor>     HTML, obrázek, PDF, … (musí být uvnitř ${HOME})

Vypíše URL ${HOST_URL}/file/…, který otevřeš v prohlížeči.
Pro celou složku/web nebo živý dev server použij mc-preview.`);
  process.exit(arg ? 0 : 1);
}

const full = path.resolve(process.cwd(), arg);
if (full !== HOME && !full.startsWith(HOME + path.sep)) {
  console.error(`✕ soubor musí být uvnitř ${HOME}`);
  process.exit(1);
}
let st;
try { st = fs.statSync(full); } catch { console.error(`✕ soubor neexistuje: ${full}`); process.exit(1); }
if (!st.isFile()) { console.error(`✕ není soubor (pro složku použij mc-preview): ${full}`); process.exit(1); }

const url = `${HOST_URL}/file${encodeURI(full)}`;
console.log(`✓ otevři v prohlížeči:\n  ${url}`);
