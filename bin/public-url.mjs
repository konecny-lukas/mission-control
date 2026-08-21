#!/usr/bin/env node
// bin/public-url.mjs — sdílený resolver veřejné (tailnet) URL Mission Control.
// Používají ho mc-open.js a mc-preview.js, ať natvrdo neopakují stejnou logiku
// (dřív dvě skoro identické konstanty HOST_URL — viz R2 §10).
//
// Pořadí priority:
//   1. C.PUBLIC_URL (config.js — MC_PUBLIC_URL env, nebo CFG.publicUrl z
//      mc.config.json)
//   2. `tailscale status --json` → `.Self.DNSName` (bez koncové tečky) →
//      `https://<dns>`
//   3. `http://<hostname>` — poslední záchrana, funguje jen v LAN/localhost
//      (žádný tailnet k dispozici — nejspíš vývojový box bez Tailscale).
//
// Všechny kroky jsou best-effort: chybějící/neúspěšný `tailscale` binárka
// nikdy nehodí výjimku, jen se propadne na další krok (execFile s timeoutem).
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PUBLIC_URL } from '../config.js';

function tailscaleUrl() {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null); // binárka chybí / timeout / tailscaled neběží
      let dns;
      try { dns = JSON.parse(stdout)?.Self?.DNSName; } catch { return resolve(null); }
      resolve(dns ? `https://${dns.replace(/\.$/, '')}` : null);
    });
  });
}

export async function resolvePublicUrl() {
  if (PUBLIC_URL) return PUBLIC_URL;
  const ts = await tailscaleUrl();
  if (ts) return ts;
  return `http://${os.hostname()}`;
}

// Spuštěno přímo (ne importováno) → vypiš výslednou URL na stdout.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(await resolvePublicUrl());
}
