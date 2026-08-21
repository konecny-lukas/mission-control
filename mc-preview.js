#!/usr/bin/env node
// mc-preview — přidá/odebere věc, kterou má Mission Control vystavit pod
// <veřejná URL>/preview/<slug>/ . Zapisuje registry, který běžící server
// mission-control čte při každém refreshi; nic dalšího restart nepotřebuje.
import fs from 'node:fs';
import path from 'node:path';
import * as prev from './previews.js';
import { PORT } from './config.js';
import { resolvePublicUrl } from './bin/public-url.mjs';

const HOST_URL = (await resolvePublicUrl().catch(() => null)) || `http://localhost:${PORT}`;

function usage(code = 0) {
  const out = code ? console.error : console.log;
  out(`mc-preview — vystav věc na ${HOST_URL}/preview/<slug>/ (objeví se v Mission Control)

Použití:
  mc-preview add <slug> --static <dir>  [--title "..."] [--note "..."]
  mc-preview add <slug> --port <číslo>  [--title "..."] [--note "..."] [--strip]
  mc-preview list
  mc-preview rm <slug>

  <slug>          a-z 0-9 a pomlčky, 1–39 znaků (cesta v URL)
  --static <dir>  složka se soubory (index.html). Relativní URL fungují (vloží se <base>).
  --port <n>      reverse-proxy na 127.0.0.1:<n> (Vite/Next/node, vč. HMR/WS).
                  Dev server spusť pod base path /preview/<slug>/  (např. vite --base=/preview/<slug>/).
  --strip         u --port odřízne prefix /preview/<slug> (pro app servírující z rootu)`);
  process.exit(code);
}

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--strip') out.strip = true;
    else if (a.startsWith('--')) out[a.slice(2)] = args[++i];
    else out._.push(a);
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || ['help', '--help', '-h'].includes(cmd)) usage(0);

if (cmd === 'list') {
  const list = prev.loadRegistry();
  if (!list.length) { console.log('(žádné náhledy)'); process.exit(0); }
  for (const p of list) {
    const loc = p.type === 'proxy' ? `:${p.port}${p.strip ? ' (strip)' : ''}` : p.dir;
    console.log(`${p.slug.padEnd(20)} ${(p.type || '?').padEnd(7)} ${HOST_URL}/preview/${p.slug}/   ${loc}`);
  }
  process.exit(0);
}

if (cmd === 'rm' || cmd === 'remove') {
  if (!rest[0]) usage(1);
  const r = prev.removePreview(rest[0]);
  console.log(r.ok ? `✓ ${r.action}` : `✕ ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'add') {
  const f = parseFlags(rest);
  const slug = f._[0];
  if (!slug || !prev.SLUG_RE.test(slug)) { console.error('✕ neplatný <slug> (a-z, 0-9, pomlčky, 1–39 znaků)'); process.exit(1); }
  const hasStatic = f.static != null, hasPort = f.port != null;
  if (hasStatic === hasPort) { console.error('✕ zadej PRÁVĚ jedno: --static <dir> NEBO --port <n>'); process.exit(1); }

  const entry = { slug, title: f.title || slug, created: new Date().toISOString() };
  if (f.note) entry.note = f.note;

  if (hasStatic) {
    const dir = path.resolve(process.cwd(), f.static);
    let st; try { st = fs.statSync(dir); } catch { console.error(`✕ složka neexistuje: ${dir}`); process.exit(1); }
    if (!st.isDirectory()) { console.error(`✕ není složka: ${dir}`); process.exit(1); }
    if (!fs.existsSync(path.join(dir, 'index.html'))) console.warn('⚠ ve složce není index.html — kořen náhledu vrátí 404, fungovat budou jen konkrétní soubory');
    entry.type = 'static';
    entry.dir = dir;
  } else {
    const port = Number(f.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('✕ --port musí být celé číslo 1–65535'); process.exit(1); }
    entry.type = 'proxy';
    entry.port = port;
    if (f.strip) entry.strip = true;
  }

  const list = prev.loadRegistry().filter((p) => p.slug !== slug); // replace an existing slug
  list.push(entry);
  prev.saveRegistry(list);

  console.log(`✓ náhled „${entry.title}" → ${HOST_URL}/preview/${slug}/`);
  console.log(`  Mission Control: uzel „Náhledy" → ${entry.title} → ⤢ Otevřít`);
  if (entry.type === 'proxy' && !entry.strip) {
    console.log(`  ⓘ dev server spusť pod base path /preview/${slug}/  (např. vite --base=/preview/${slug}/)`);
  }
  process.exit(0);
}

console.error(`✕ neznámý příkaz: ${cmd}`);
usage(1);
