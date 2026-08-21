#!/usr/bin/env node
// mc-smoke — akceptační smoke test Mission Control (výstrahy + prohlížečový boot v2).
//
// PROČ: audit frikce ukázal opakované „opraveno" u výstrah a UI bez ověření
// v reálném prohlížeči. Tenhle skript je ta chybějící brána: před hlášením
// „opraveno" u alertů/frontendu ho spusť a přilož výstup.
//
// Použití:  node bin/mc-smoke.js [--alerts-only|--browser-only]
// Exit 0 = všechny kroky PASS/SKIP, exit 1 = aspoň jeden FAIL.
//
// Část A — životní cyklus výstrahy přes HTTP API (127.0.0.1:<PORT>):
//   Vyžaduje zapnutý modul watchdog (MODULES.watchdog) — bez něj cron-watchdog
//   nic nezapisuje do WATCHDOG_HISTORY a ALERT_RULES watchdog pravidlo vůbec
//   nepřidávají (config.js), takže syntetická výstraha níž by nikdy „nenaskočila"
//   — část A se v tom případě přeskočí (SKIP, ne FAIL).
//   Server nemá endpoint „vytvoř výstrahu" — syntetická výstraha se zapaluje
//   stejně jako při e2e testu redesignu (2026-07-01): appendem syntetického
//   záznamu do watchdog-history.jsonl (builtin pravidlo watchdog-alert,
//   per-problém klíč `watchdog-alert:mc-smoke-…`). Reálné výstrahy z posledního
//   záznamu se PŘENÁŠEJÍ dál (nic se neumlčí ani nepřeotevře). Pak: fire → ack
//   → silence; každý stav se ověřuje přes GET /api/status.
//   POZOR (fix round 3): alert.unsilence/alert.snooze/alert.unsnooze/manuální
//   alert.resolve V TÉHLE VERZI ENGINU NEEXISTUJÍ (alerts.js handleAction zná
//   jen silence/ack/diagnose, resolve je čistě automatický přechod stavového
//   stroje — a UI taky nabízí jen „✕ skrýt" = alert.silence, viz
//   public/ui/panels.js) — testují se proto jako SKIP, ne FAIL, stejně jako
//   „delete" endpoint níž. Skrytí (silence) se místo ruční unsilence ověřuje
//   tím, že se samo zruší, jakmile syntetický záznam zmizí z historie
//   (přirozený resolve, clearMs=0 u watchdog-alert pravidla) — krok „po
//   úklidu" na konci.
//   Úklid: pokud do souboru mezitím nezapsal watchdog cron, náš řádek se
//   odřízne (truncate na původní délku) → soubor je bajt po bajtu jako před
//   testem. Jinak zůstane uprostřed historie (neškodný, čte se jen poslední
//   řádek) a vypíše se upozornění — v tom případě se ani neověřuje
//   automatický resolve (podmínka může dál platit donekonečna).
//
// Část B — prohlížečový smoke bootu v2 (GET /, bez query):
//   Headless Chromium (Playwright binárka, CDP přes raw WebSocket — žádná nová
//   npm závislost) načte / a ověří, že boot sekvence doběhla (html.done —
//   public/ui/boot.js finish()) a že se vykreslil branding, aspoň jeden panel
//   a živá data. Balíček ŠTÍPÍ v2 frontend (public/) — ten NEMÁ žádné
//   `?term=<key>:<sid>` zpracování (to bylo jen v1); solo-terminálový deep-link
//   se proto netestuje. Pojistka na tmux ale zůstává: pouhé otevření / se
//   k žádné session nepřipojuje, takže smoke nesmí založit ani se dotknout
//   ŽÁDNÉ tmux session (viz liveSessions() guard níž).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const C = await import(path.join(__dirname, '..', 'config.js'));

const BASE = process.env.MC_SMOKE_BASE || `http://127.0.0.1:${C.PORT}`;
const WD_FILE = process.env.MC_SMOKE_WATCHDOG || C.WATCHDOG_HISTORY;
// Playwright cache — stejný default jako install skripty (~/.cache/ms-playwright),
// přepis přes MC_SMOKE_CHROME_ROOT (jiný uživatel/box).
const CHROME_ROOT = process.env.MC_SMOKE_CHROME_ROOT || path.join(os.homedir(), '.cache/ms-playwright');

const onlyAlerts = process.argv.includes('--alerts-only');
const onlyBrowser = process.argv.includes('--browser-only');

const results = []; // { name, status: 'PASS'|'FAIL'|'SKIP', note }
const t0 = Date.now();
function report(name, status, note = '') {
  results.push({ name, status, note });
  const icon = status === 'PASS' ? '✓' : status === 'SKIP' ? '↷' : '✕';
  const pad = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
  console.log(`${pad} ${icon} ${status.padEnd(4)} ${name}${note ? ` — ${note}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}
async function postAction(body) {
  const res = await fetch(`${BASE}/api/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  let j = {};
  try { j = await res.json(); } catch { /* non-JSON error body */ }
  return { http: res.status, ...j };
}
// Poll /api/status až podmínka nad state.alerts platí (výstrahový engine jede
// na 8s ticku + akce kopnou fastRefresh za 1,5 s — proto se nikdy nekouká jen
// jednou). Vrací poslední alerts snapshot, nebo hází po timeoutu.
async function waitAlerts(cond, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try {
      const s = await getJson(`${BASE}/api/status`);
      last = s.alerts || {};
      if (cond(last)) return last;
    } catch { /* server busy — zkusí se znovu */ }
    await sleep(2000);
  }
  throw new Error(`timeout (${Math.round(timeoutMs / 1000)}s) čekání na: ${what}` +
    (last ? ` · aktivní klíče: ${(last.active || []).map((a) => a.key).join(', ') || '(žádné)'}` : ''));
}
const findByKey = (al, key) => (al.active || []).find((a) => a.key === key);

// ---------------------------------------------------------------------------
// Část A — výstrahy
// ---------------------------------------------------------------------------
async function alertSuite() {
  console.log(`\n── VÝSTRAHY (${BASE}) ──`);

  // preflight
  try {
    const h = await getJson(`${BASE}/api/health`);
    if (!h.ok) throw new Error('health != ok');
    report('server /api/health', 'PASS');
  } catch (e) {
    report('server /api/health', 'FAIL', String(e.message || e));
    return; // bez serveru nemá zbytek smysl
  }

  const min = new Date().getMinutes();
  if (min >= 35 && min <= 45) {
    console.log('  ⚠ pozn.: kolem :40 běží hodinový cron-watchdog — když zrovna zapíše,');
    console.log('    přepíše syntetický záznam a kroky níž mohou spadnout. Zkus pak znovu.');
  }

  // syntetický watchdog záznam (fire)
  const smokeId = `mc-smoke-${Date.now()}`;
  const key = `watchdog-alert:${smokeId}`;
  let origSize = null, appended = null;
  try {
    // čerstvá instalace: watchdog-history.jsonl ještě nikdy nezapsal cron
    // (soubor/adresář neexistuje) — to NENÍ chyba smoke testu, jen prázdný
    // start. Založ ho (append níž stejně vytvoří rodičovský adresář).
    fs.mkdirSync(path.dirname(WD_FILE), { recursive: true });
    if (!fs.existsSync(WD_FILE)) fs.writeFileSync(WD_FILE, '');
    const st = fs.statSync(WD_FILE);
    origSize = st.size;
    // poslední reálný záznam: jeho ŽIVÉ výstrahy (overall=alert a čerstvý < 2 h,
    // viz freshness gate v alerts.js) musíme přenést, jinak by je náš záznam
    // „vyřešil" a rozhodil reálný stav
    const tail = fs.readFileSync(WD_FILE, 'utf-8').slice(-16384).split('\n').filter((l) => l.trim());
    let lastEntry = null;
    for (let i = tail.length - 1; i >= 0; i--) {
      try { const j = JSON.parse(tail[i]); if (j && j.ts) { lastEntry = j; break; } } catch { /* useknutá první řádka okna */ }
    }
    const carry = (lastEntry && lastEntry.overall === 'alert'
      && Number.isFinite(Date.parse(lastEntry.ts)) && Date.now() - Date.parse(lastEntry.ts) < 2 * 3600_000
      && Array.isArray(lastEntry.alerts)) ? lastEntry.alerts : [];
    const entry = {
      ts: new Date().toISOString(), overall: 'alert',
      projects: lastEntry?.projects || {}, actions: [],
      alerts: [...carry, { id: smokeId, text: 'SYNTETICKÝ SMOKE TEST z bin/mc-smoke.js — ignoruj, není to reálný problém, uklidí se sám' }],
      smoke: true,
    };
    appended = JSON.stringify(entry) + '\n';
    fs.appendFileSync(WD_FILE, appended); // append-only: nikdy nepřepisujeme, cron může psát souběžně
    report('syntetická výstraha zapsána (watchdog jsonl)', 'PASS', smokeId);
  } catch (e) {
    report('syntetická výstraha zapsána (watchdog jsonl)', 'FAIL', String(e.message || e));
    return;
  }

  let entryNow = null;
  let silencedOk = false; // dosáhli jsme PASS na silence? (gate pro „po úklidu" ověření níž)
  let cleanedOk = false;  // podařilo se jsonl vrátit bajt po bajtu do původního stavu?
  try {
    // fire — engine statuje watchdog soubor max 1×/min, proto delší timeout
    const al = await waitAlerts((a) => !!findByKey(a, key), 150_000, `aktivní výstraha ${key}`);
    entryNow = findByKey(al, key);
    report('fire → výstraha aktivní v /api/status', 'PASS', `id=${entryNow.id}, severity=${entryNow.severity}`);

    // ack (tlačítko z UI zmizelo, endpoint žije — dbId adresace)
    const ack = await postAction({ type: 'alert.ack', id: entryNow.id });
    if (!ack.ok) throw new Error(`alert.ack: ${ack.error || ack.http}`);
    await waitAlerts((a) => findByKey(a, key)?.ackTs != null, 30_000, 'ackTs nastaveno');
    report('ack → ackTs nastaveno', 'PASS');

    // silence („✕ skrýt do vyřešení") — jediná manuální akce nad skrytím,
    // kterou tenhle engine má (viz alerts.js handleAction + public/ui/panels.js).
    const sil = await postAction({ type: 'alert.silence', key });
    if (!sil.ok) throw new Error(`alert.silence: ${sil.error || sil.http}`);
    await waitAlerts((a) => !findByKey(a, key) && (a.silencedKeys || []).includes(key), 30_000, 'skrytá (mimo active, v silencedKeys)');
    report('silence → mimo active, v silencedKeys', 'PASS');
    silencedOk = true;

    // unsilence/snooze/unsnooze/manuální resolve NEJSOU v alerts.js/server.js
    // implementované (ověřeno grepem: runAction routuje jen alert.silence/
    // alert.ack/alert.diagnose; resolve je jen interní resolveTrack() bez POST
    // cesty) a UI je taky nikde nenabízí — SKIP, ne FAIL, stejně jako „delete"
    // níž. Skrytí se místo ruční unsilence ověřuje automatickým sebe-zrušením
    // v kroku „po úklidu" dole.
    report('unsilence výstrahy', 'SKIP', 'akce není v této verzi enginu (alerts.js handleAction zná jen silence/ack/diagnose)');
    report('snooze výstrahy', 'SKIP', 'akce není v této verzi enginu (koncept odkladu třídy klíče v alerts.js neexistuje)');
    report('unsnooze výstrahy', 'SKIP', 'akce není v této verzi enginu (viz snooze výš)');
    report('manuální resolve výstrahy', 'SKIP', 'akce není v této verzi enginu (resolve je jen automatický přechod stavového stroje, žádná POST akce)');
    report('delete výstrahy', 'SKIP', 'endpoint neexistuje — historie v alerts.db je záměrně trvalá (řádek zůstane jako resolved)');
  } catch (e) {
    report('životní cyklus výstrahy', 'FAIL', String(e.message || e));
  } finally {
    // úklid watchdog souboru — odřízni náš řádek, POKUD je pořád poslední
    try {
      const st = fs.statSync(WD_FILE);
      if (st.size >= origSize + Buffer.byteLength(appended)) {
        const fd = fs.openSync(WD_FILE, 'r');
        const buf = Buffer.alloc(st.size - origSize);
        fs.readSync(fd, buf, 0, buf.length, origSize);
        fs.closeSync(fd);
        if (buf.toString('utf-8') === appended) {
          fs.truncateSync(WD_FILE, origSize); // soubor bajt po bajtu jako před testem
          cleanedOk = true;
          report('úklid: watchdog jsonl vrácen do původního stavu', 'PASS');
        } else {
          report('úklid: watchdog jsonl', 'SKIP', 'cron mezitím zapsal nový záznam — syntetický řádek zůstává uprostřed historie (neškodné, čte se jen poslední záznam)');
        }
      } else {
        report('úklid: watchdog jsonl', 'SKIP', 'soubor se mezitím změnil jinak, než čekáme — nechávám být');
      }
    } catch (e) {
      report('úklid: watchdog jsonl', 'FAIL', String(e.message || e));
    }
  }

  // úklid skrytí: bez manuální unsilence je JEDINÁ cesta ven z tabulky
  // `silences` v alerts.db automatický resolve (alerts.js resolveTrack() →
  // clearSilence()) — nastane, jakmile watchdogLatest() přestane vidět náš
  // klíč (soubor je zpátky beze stopy po testu) a podmínka je false na dalším
  // ticku (clearMs=0 u builtin watchdog-alert pravidla). Ověřuje se JEN když
  // silence i jsonl úklid reálně proběhly — jinak podmínka může dál platit
  // donekonečna a čekání by nikdy nedoběhlo.
  //
  // POZOR (živě ověřeno): na ČERSTVÉM/prázdném watchdog-history.jsonl (fresh
  // install nebo tenhle test běžící poprvé, viz F.1 výš) watchdogLatest()
  // v alerts.js po truncatu přečte 0 platných řádků a `wd.entry` (poslední
  // ÚSPĚŠNĚ naparsovaný záznam) NEPŘEPÍŠE zpátky na null — zůstává viset na
  // naší syntetické výstraze, dokud ji nepřebije DALŠÍ platný řádek v souboru
  // (na produkci běžný — přijde s dalším reálným cron-watchdog během) NEBO
  // dokud nevyprší 2h freshness gate (`Date.now() - ts < 2h`, alerts.js
  // ruleHits). To je řádově delší než rozumný smoke-test timeout, takže se
  // tenhle krok bere jako BEST-EFFORT: bounded wait, a když nedoběhne, SKIP
  // (ne FAIL) — sama akce alert.silence je ověřená výš, tohle je jen bonus
  // kontrola úklidu.
  if (silencedOk && cleanedOk) {
    try {
      await waitAlerts(
        (a) => !findByKey(a, key) && !(a.silencedKeys || []).includes(key),
        100_000, 'po úklidu: výstraha automaticky vyřešena a skrytí smazáno (engine statuje soubor max 1×/min, proto delší timeout)');
      report('po úklidu: výstraha automaticky vyřešena, skrytí smazáno', 'PASS');
    } catch (e) {
      report('po úklidu: výstraha automaticky vyřešena, skrytí smazáno', 'SKIP',
        `neproběhlo v časovém rozpočtu (100 s) — watchdogLatest() v alerts.js drží poslední přečtený záznam, dokud ho nepřebije nový platný řádek nebo nevyprší 2h freshness gate; na čerstvém/prázdném souboru (viz F.1) to smoke test nestihne. alert.silence samo je ověřené výš. ${String(e.message || e)}`);
    }
  } else {
    report('po úklidu: výstraha automaticky vyřešena, skrytí smazáno', 'SKIP',
      !silencedOk ? 'silence krok neproběhl — není co ověřovat' : 'jsonl úklid se nepovedl (viz výš) — bez obnoveného souboru se podmínka nemusí nikdy vyřešit');
  }
}

// ---------------------------------------------------------------------------
// Část B — prohlížeč (deep-link ?term=…)
// ---------------------------------------------------------------------------
// Playwright přejmenoval podadresář `chrome-linux` → `chrome-linux64` (chromium-1223+).
// Dokud se hledal jen starý název, prohlížečová část smoke testu tiše SKIPovala —
// tedy hlásila „nelze spustit" místo aby testovala. Zkoušíme oba layouty a bereme
// nejvyšší dostupnou verzi.
const CHROME_LAYOUTS = ['chrome-linux64', 'chrome-linux'];
function findChrome() {
  try {
    const dirs = fs.readdirSync(CHROME_ROOT)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const layout of CHROME_LAYOUTS) {
        const p = path.join(CHROME_ROOT, d, layout, 'chrome');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch { /* žádný playwright cache */ }
  return null;
}

function liveSessions() {
  return new Promise((resolve) => {
    execFile(C.TERM_TMUX_BIN, ['-L', C.TERM_TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'],
      { timeout: 8000 }, (err, so) => {
        if (err) return resolve([]);
        resolve(String(so).split('\n').map((l) => /^mc-([a-z0-9]+)-(\d+)$/.exec(l.trim())).filter(Boolean)
          .map((m) => ({ key: m[1], sid: Number(m[2]) })));
      });
  });
}

// Sady tmux sessions se porovnávají jako obsah (key+sid), ne jen počet —
// smoke nesmí ani vytvořit novou, ani se „přiživit" na existující (přibýt
// jako další klient).
function sameSessions(a, b) {
  if (a.length !== b.length) return false;
  const sig = (s) => `${s.key}:${s.sid}`;
  const as = new Set(a.map(sig));
  return b.every((s) => as.has(sig(s)));
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        return new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
          setTimeout(() => { if (pending.delete(id)) rej(new Error(`CDP timeout: ${method}`)); }, 15_000);
        });
      },
      close() { try { ws.close(); } catch { /* už zavřeno */ } },
    }));
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    });
    ws.addEventListener('error', (e) => reject(new Error(`WebSocket: ${e.message || 'chyba'}`)));
  });
}

async function browserSuite() {
  console.log('\n── PROHLÍŽEČ (boot v2, GET / bez query) ──');
  const chrome = findChrome();
  if (!chrome) { report('headless chromium nalezen', 'SKIP', `nenalezen pod ${CHROME_ROOT} — prohlížečovou část nelze spustit`); return; }

  let branding = null;
  try {
    const st = await getJson(`${BASE}/api/status`);
    branding = st.branding || null;
  } catch (e) {
    report('branding z /api/status (předpoklad pro asserce níž)', 'FAIL', String(e.message || e));
    return;
  }
  if (!branding || !branding.name) {
    report('branding z /api/status (předpoklad pro asserce níž)', 'FAIL', `chybí branding.name — mám ${JSON.stringify(branding)}`);
    return;
  }

  const url = `${BASE}/`;
  const before = await liveSessions();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-smoke-chrome-'));
  let child = null, cdp = null;
  try {
    child = spawn(chrome, [
      // --no-sandbox: VPS má vypnuté unprivileged user namespaces → bez něj
      // chromium umře hned na "No usable sandbox!" (lokální smoke, vlastní stroj)
      '--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${tmpDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--window-size=1280,900', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const to = setTimeout(() => reject(new Error(`chromium nevypsal DevTools URL do 20 s${buf ? ` · stderr: ${buf.slice(-200)}` : ''}`)), 20_000);
      child.stderr.on('data', (d) => {
        buf += d;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) { clearTimeout(to); resolve(m[1]); }
      });
      child.on('exit', (code) => { clearTimeout(to); reject(new Error(`chromium skončil předčasně (exit ${code}) · stderr: ${buf.slice(-300)}`)); });
    });
    report('headless chromium nastartován', 'PASS', path.basename(path.dirname(path.dirname(chrome))));

    cdp = await cdpConnect(wsUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    report(`stránka otevřena: ${url}`, 'PASS');

    // boot v2 (public/ui/boot.js): html.done + zmizelý #boot overlay je konec
    // sekvence (nejpozději ~2,2 s po startu, i bez dat) — poll dokud nedoběhne
    // NEBO dokud nejsou vidět i data (panel + #coreHost), co přijde později.
    const expr = `JSON.stringify({
      done: document.documentElement.classList.contains('done'),
      bootGone: !document.getElementById('boot'),
      title: document.title,
      brandWord: (document.querySelector('.brand .word') || {}).textContent || '',
      panels: document.querySelectorAll('.panel:not([hidden])').length,
      coreHost: (document.getElementById('coreHost') || {}).textContent || '',
      signalLost: document.body.classList.contains('signal-lost'),
    })`;
    const end = Date.now() + 25_000;
    let st = null;
    while (Date.now() < end) {
      try {
        const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
        st = JSON.parse(r?.result?.value || '{}');
        if (st.done && st.panels > 0 && st.coreHost) break;
      } catch { /* stránka se ještě bootuje */ }
      await sleep(1000);
    }

    const bootOk = !!(st && st.done && st.bootGone);
    report('boot sekvence doběhla (html.done, #boot pryč)', bootOk ? 'PASS' : 'FAIL',
      st ? `done=${st.done} bootGone=${st.bootGone}` : 'stránka po 25 s neodpověděla na Runtime.evaluate');

    const titleOk = !!(st && st.title && st.title.includes(branding.name));
    report('document.title obsahuje branding jméno z /api/status', titleOk ? 'PASS' : 'FAIL',
      `title="${st?.title}" · branding.name="${branding.name}"`);

    const brandOk = !!(st && st.brandWord && st.brandWord.includes(branding.name));
    report('topbar .brand .word vykreslen s branding jménem', brandOk ? 'PASS' : 'FAIL', `brandWord="${st?.brandWord}"`);

    const panelsOk = !!(st && st.panels > 0);
    report('aspoň jeden .panel:not([hidden]) existuje', panelsOk ? 'PASS' : 'FAIL', `panels=${st?.panels ?? 0}`);

    const dataOk = !!(st && st.coreHost && !st.signalLost);
    report('SSE spojeno / stav vykreslen (#coreHost naplněný, bez signal-lost)', dataOk ? 'PASS' : 'FAIL',
      `coreHost="${st?.coreHost}" · signalLost=${st?.signalLost}`);

    // pojistka: pouhé otevření / nesmí založit ani se „přiživit" na žádnou
    // tmux session — v2 nemá žádný ?term= deep-link, takže tohle by teď
    // znamenalo regresi (např. omylem znovupřidaný auto-attach).
    const after = await liveSessions();
    const clean = sameSessions(before, after);
    report('žádná tmux session nevznikla ani nebyla dotčena', clean ? 'PASS' : 'FAIL',
      clean ? `beze změny (${before.length} sessions)` : `před=${JSON.stringify(before)} po=${JSON.stringify(after)}`);
  } catch (e) {
    report('prohlížečový smoke', 'FAIL', String(e.message || e));
  } finally {
    // synchronně: unref-nutý timer by před process.exit nikdy nedoběhl a nechal
    // by v /tmp osiřelé chrome profily (chyceno při prvním běhu)
    try { cdp?.close(); } catch { /* nevadí */ }
    if (child && child.exitCode === null) {
      const gone = new Promise((r) => { child.once('exit', r); setTimeout(r, 3000).unref(); });
      try { child.kill('SIGKILL'); } catch { /* už mrtvý */ }
      await gone;
    }
    // chrome helpery umírají o chlup později než hlavní proces a stihnou do
    // profilu ještě zapsat → rm s pár opakováními, dokud adresář nezmizí
    for (let i = 0; i < 4 && fs.existsSync(tmpDir); i++) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ještě drží soubory */ }
      if (fs.existsSync(tmpDir)) await sleep(500);
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`mc-smoke — akceptační test Mission Control (${new Date().toISOString()})`);
if (!onlyBrowser) {
  if (C.MODULES.watchdog) {
    await alertSuite();
  } else {
    console.log(`\n── VÝSTRAHY (${BASE}) ──`);
    report('výstrahy (watchdog modul)', 'SKIP', 'MODULES.watchdog vypnutý — bez cron-watchdogu se syntetická výstraha nemá čím zapálit');
  }
}
if (!onlyAlerts) await browserSuite();

const fail = results.filter((r) => r.status === 'FAIL').length;
const pass = results.filter((r) => r.status === 'PASS').length;
const skip = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n── VÝSLEDEK: ${pass}× PASS, ${skip}× SKIP, ${fail}× FAIL (${((Date.now() - t0) / 1000).toFixed(0)} s) ──`);
if (fail) console.log('   ⚠ NEHLÁSIT „opraveno" — aspoň jeden krok selhal.');
process.exit(fail ? 1 : 0);
