// Mission Control — HTTP server + refresh loops.
// Binds to 127.0.0.1 only; Tailscale `serve` fronts it with HTTPS on the tailnet.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import * as C from './config.js';
import * as col from './collectors.js';
import * as upt from './modules/uptime.js';
import * as ga4mod from './modules/ga4.js';
import * as gscmod from './modules/gsc.js';
import * as idxmod from './modules/indexace.js';
import * as climod from './modules/claudelimits.js';
import * as wpschedmod from './modules/wpsched.js';
import * as ncmod from './modules/nanoclaw.js';
import * as wdmod from './modules/watchdog.js';
import * as netstat from './netstat.js';
import * as jarvis from './jarvis.js';
import * as prev from './previews.js';
import * as stream from './stream.js';
import * as alerts from './alerts.js';
import * as threads from './threads.js';
import * as mctasks from './mctasks.js';
import * as timeline from './timeline.js';
import * as termLabels from './term-labels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

// Static catalog for the command palette (services that can be restarted, jobs
// that can be triggered). Built ONCE from config — the object reference never
// changes, so it rides each SSE snapshot and never re-appears in patches.
const CATALOG = {
  services: Object.entries(C.RESTARTABLE_SERVICES).map(([target, s]) => ({ target, label: s.label })),
  jobs: Object.entries(C.RUNNABLE_JOBS).map(([id, j]) => ({ id, label: j.label })),
  // Terminálový launcher (public/ui/term.js) + mctask select čtou tohle ze
  // snapshotu — dir záměrně chybí (serverové tajemství, klient ho nepotřebuje).
  termProjects: C.TERM_PROJECTS.map((p) => ({ key: p.key, label: p.label })),
  // public/ui/timeline.js z tohohle staví filtr chip „DENÍKY" (narrative.<id>
  // zdroje) — JEDINÝ zdroj pravdy je zase config.js WATCHDOG_PROJECTS, žádný
  // natvrdo napsaný seznam id na klientu (viz timeline.js NARR).
  watchdogProjects: C.WATCHDOG_PROJECTS.map((p) => ({ id: p.id, label: p.label || p.id })),
};

let state = { ts: 0, booting: true, catalog: CATALOG, jarvisBusy: false, branding: C.BRAND, modules: C.MODULES };

// Compact "9h 27m" / "42m" / "18s" from a second count.
function durHM(sec) {
  if (sec == null) return '';
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// české skloňování počtu: [1, 2–4, 0/5+]
function plural(n, forms) {
  const a = Math.abs(n | 0);
  return forms[a === 1 ? 0 : (a >= 2 && a <= 4 ? 1 : 2)];
}

// ---------- assemble snapshot ----------
function buildProjects(s) {
  const projects = [];
  const pv = s.previews || [];
  const pvWord = pv.length === 1 ? 'náhled' : (pv.length >= 2 && pv.length <= 4 ? 'náhledy' : 'náhledů');
  projects.push({
    id: 'previews', name: 'Náhledy', icon: '▣',
    state: pv.length ? 'ok' : 'idle',
    metric: `${pv.length} ${pvWord}`,
    sub: pv.length ? (pv[0].title || pv[0].slug) : 'co ti agent vyrobí, otevřeš tady',
  });
  return projects;
}

function buildSummary(s, projects) {
  // idle / paused are normal operating states, not degradations — they must not
  // drive the overall health color. Only ok / warn / crit matter for the core.
  const norm = (x) => (x === 'idle' || x === 'paused' ? 'ok' : x);
  // uptime už není v projects (přesunuté do panelu WEBY), ale jeho
  // stav musí dál hlídat jádro — výpadek webu = červené jádro. unknown→ok (neměř před prvním měřením).
  const health = (x) => { const n = norm(x || 'ok'); return n === 'unknown' ? 'ok' : n; };
  const svcStates = (s.services || []).map((x) => norm(x.state));
  const projStates = projects.map((p) => norm(p.state));
  // alerts.state přidává stav alert enginu (evaluate běží PŘED buildSummary,
  // takže crit výstraha obarví jádro hned v témže ticku, ne o 8 s později).
  const overall = col.worst(...svcStates, ...projStates, health(s.system?.state), health(s.uptime?.state), health(s.nanoclaw?.state), health(s.alerts?.state));
  const counts = { ok: 0, warn: 0, crit: 0, idle: 0, paused: 0 };
  for (const p of projects) counts[p.state] = (counts[p.state] || 0) + 1;
  let message = 'Všechny systémy nominální';
  if (overall === 'warn') message = 'Drobné odchylky — zkontroluj zvýrazněné';
  if (overall === 'crit') message = 'Kritický stav — vyžaduje pozornost';
  return { summary: { state: overall, counts, message } };
}

async function fastRefresh() {
  try {
    const [system, services, claude, term] = await Promise.all([
      col.collectSystem(), col.collectServices(), col.collectClaude(), col.collectTermSessions(),
    ]);
    const next = { ...state, ts: Date.now(), booting: false, hostname: C.HOSTNAME, system, services, claude, term,
      docker: col.collectDocker(),
      mctasks: mctasks.collect(term), previews: prev.listPreviews() };
    alerts.evaluate(next); // sets next.alerts — MUSÍ běžet před buildSummary (barva jádra)
    timeline.recent(next); // sets next.timeline.recent (~20 událostí pro ticker) — mtime-gated, levné
    const projects = buildProjects(next);
    Object.assign(next, { projects }, buildSummary(next, projects));
    state = next;
    stream.publish(state);
  } catch (e) {
    console.error('[fastRefresh]', e);
  }
}

async function slowRefresh() {
  try {
    // docker se plní ve fastRefresh přímo z dockeru; tady jen tailscale
    state.tailscale = await col.collectTailscale();
    stream.publish(state);
  } catch (e) {
    console.error('[slowRefresh]', e);
  }
}

// Vzor „modul" (Task 6, uptime jako první): boot seed + první refresh (async,
// neblokuje) + interval, ale JEN když je modul zapnutý v CFG.modules.<id>.
// Vypnutý modul = nulová stopa: žádný seed, žádný interval, žádné volání DB.
function moduleLoop(enabled, seedFn, refreshFn, intervalMs) {
  if (!enabled) return;
  try { seedFn(); } catch (e) { console.error('[module seed]', e.message); }
  refreshFn(); setInterval(refreshFn, intervalMs);
}

// Probe the external sites once a minute, then recompute the rolled-up snapshot
// that buildProjects/the drawer read from. Carried forward via state spread.
async function uptimeRefresh() {
  try {
    await upt.probeUptime();
    state.uptime = upt.collectUptime();
    stream.publish(state);
  } catch (e) {
    console.error('[uptimeRefresh]', e);
  }
}

// GA4 návštěvnost má DVĚ kadence sdílející jednu DB (data/ga4.db): plný refresh
// (hostname ověření + denní řady + realtime, drahý na API kvótu) a lehký
// realtime-only refresh mezitím (1 request/web). Obojí přes moduleLoop() —
// viz boot sekvence níž, kde se volá dvakrát nad stejným MODULES.ga4 gate.
async function ga4Refresh() {
  try {
    await ga4mod.refreshGa4();
    state.ga4 = ga4mod.buildGa4Section();
    stream.publish(state);
  } catch (e) {
    console.error('[ga4Refresh]', e);
  }
}
async function ga4LiveRefresh() {
  try {
    await ga4mod.refreshGa4Live();
    state.ga4 = ga4mod.buildGa4Section();
    stream.publish(state);
  } catch (e) {
    console.error('[ga4LiveRefresh]', e);
  }
}

// GSC organická návštěvnost — jedna kadence (na rozdíl od ga4 žádný live
// pulz, GSC data jsou vždy 2–3 dny lagovaná, realtime nemá smysl).
async function gscRefresh() {
  try {
    await gscmod.refreshGSC();
    state.gsc = gscmod.collectGSC();
    stream.publish(state);
  } catch (e) {
    console.error('[gscRefresh]', e);
  }
}

// INDEXACE (GSC URL Inspection) — jedna kadence (24 h default); MIN_GAP brána
// proti spálení denní kvóty na restart žije UVNITŘ modulu (refreshSite), ne tady.
async function indexaceRefresh() {
  try {
    await idxmod.refreshIndexace();
    state.indexace = idxmod.collectIndexace();
    stream.publish(state);
  } catch (e) {
    console.error('[indexaceRefresh]', e);
  }
}

// Limity Claude subscription (5h okno + týden) — na rozdíl od ostatních modulů
// žádná DB: modul si poslední dobrá data drží jen v paměti procesu
// (last/lastOkTs/lastErr uvnitř modules/claudelimits.js), collect je tu proto
// jen čtení toho in-memory stavu, ne DB dotaz.
async function claudeLimitsRefresh() {
  try {
    await climod.refreshClaudeLimits();
    state.claudeLimits = climod.collectClaudeLimits();
    stream.publish(state);
  } catch (e) {
    console.error('[claudeLimitsRefresh]', e);
  }
}

// WPSCHED (hlídač zaseknutých naplánovaných WP postů, WP REST — read-only) —
// jedna kadence (4 h default). ŽÁDNÝ zápis na WP (viz modules/wpsched.js
// hlavička) — na rozdíl od původního interního MC modul nikdy nic needituje.
async function wpschedRefresh() {
  try {
    await wpschedmod.refreshWpsched();
    state.wpsched = wpschedmod.collectWpsched();
    stream.publish(state);
  } catch (e) {
    console.error('[wpschedRefresh]', e);
  }
}

// NANOCLAW (read-only panel nad lokální instalací NanoClaw — jen čte jeho
// data/v2.db + stav systemd --user unity, ŽÁDNÝ zápis, viz modules/nanoclaw.js
// hlavička) — jedna kadence (60 s default, jen lokální čtení, žádná síť).
async function nanoclawRefresh() {
  try {
    await ncmod.refreshNanoclaw();
    state.nanoclaw = ncmod.collectNanoclaw();
    stream.publish(state);
  } catch (e) {
    console.error('[nanoclawRefresh]', e);
  }
}

// WATCHDOG (read-only panel/drawer nad výstupem hodinového cron-watchdog
// agenta — jen čte data/watchdog-history.jsonl + data/narrative/*.log, ŽÁDNÝ
// zápis, žádné spouštění claude, viz modules/watchdog.js hlavička) — jedna
// kadence (60 s default, jen lokální čtení malých souborů, žádná síť). Vnější
// cron, který ty soubory PÍŠE (watchdog/run-watchdog.sh), je mimo tenhle
// proces — instaluje ho INSTALL.md, ne tenhle server.
async function watchdogRefresh() {
  try {
    state.watchdog = wdmod.collectWatchdog();
    stream.publish(state);
  } catch (e) {
    console.error('[watchdogRefresh]', e);
  }
}

// Sample the VPS NIC counters into netstat.db and recompute today / last-24 h
// transfer totals for the SYSTÉM panel. Cheap; runs on its own 1-min cadence.
function netstatRefresh() {
  try {
    netstat.sampleNet();
    state.netstat = netstat.collectNetstat();
    stream.publish(state);
  } catch (e) {
    console.error('[netstatRefresh]', e);
  }
}






// ---------- actions (allowlisted) ----------
function runAction(body) {
  return new Promise((resolve) => {
    const { type, target, id } = body || {};
    if (type === 'service.restart') {
      const svc = C.RESTARTABLE_SERVICES[target];
      if (!svc) return resolve({ ok: false, error: 'service not allowed' });
      execFile('systemctl', ['--user', 'restart', target], { timeout: 30000 }, (err, so, se) => {
        if (!err) alerts.recordEvent('action', 'info', '⟳', `Restartována služba ${svc.label}`, null);
        resolve({ ok: !err, action: `restart ${svc.label}`, output: (so || se || '').slice(0, 400), error: err ? String(err.message) : null });
      });
      return;
    }
    // Výstrahy: skrytí do vyřešení (silence) + ruční diagnóza — deleguje na
    // alert engine. alert.ack zůstává jen pro kompatibilitu (UI tlačítko
    // „potvrdit" odstraněno 2026-06-11, nahrazeno „✕ skrýt" = alert.silence).
    if (type === 'alert.silence' || type === 'alert.ack' || type === 'alert.diagnose') {
      return resolve(alerts.handleAction(body));
    }
    // MC fronta úkolů — deleguje na mctasks.js (mctask.add/remove/start/done).
    // Allowlist-shaped: projekt jen z C.MCTASK_PROJECTS, id jen existující úkol;
    // mctask.start 'term' vrací promise (session create), vložení zadání běží
    // na pozadí (HTTP odpověď nečeká na claude prompt).
    if (typeof type === 'string' && type.startsWith('mctask.')) {
      return resolve(mctasks.handleAction(body));
    }
    if (type === 'term.kill') {
      if (!C.TERM_KEYS.includes(target)) return resolve({ ok: false, error: 'terminal not allowed' });
      // Optional session number; digits only. Absent => legacy single session.
      const sid = (body.sid != null && /^\d{1,3}$/.test(String(body.sid))) ? String(body.sid) : null;
      const sess = sid ? `${C.TERM_SESSION_PREFIX}${target}-${sid}` : `${C.TERM_SESSION_PREFIX}${target}`;
      const label = sid ? `„${target}" #${sid}` : `„${target}"`;
      // Explicitní „Ukončit" zapomene uložené jméno, aby se nevzkřísilo na
      // pozdější session, co náhodou dostane stejné jméno. NÁHODNÁ smrt (Claude
      // skončí sám) tuhle akci nevolá, takže jméno zůstává a při resume/respawnu
      // ho collectTermSessions() obnoví — to je smysl term-labels.js.
      if (sid) termLabels.setLabel(sess, null);
      execFile(C.TERM_TMUX_BIN, ['-L', C.TERM_TMUX_SOCKET, 'kill-session', '-t', sess],
        { timeout: 10000, env: { ...process.env, HOME: C.HOME } }, (err, so, se) => {
          const msg = (se || so || '').toString();
          // Already gone (no session / no server) => treat as success: idempotent.
          const gone = /can.?t find session|no server running|no such|session not found/i.test(msg);
          resolve({ ok: !err || gone, action: `ukončena session ${label}`, output: msg.slice(0, 200), error: (err && !gone) ? msg.slice(0, 200) || String(err.message) : null });
        });
      return;
    }
    if (type === 'term.rename') {
      // Store the custom name as the session's @mc_label user option. Lives with the
      // tmux session (no extra state file); cleared when label is empty. Same trust/
      // allowlist plane as the other term.* actions (tailnet-only, allowlisted key).
      if (!C.TERM_KEYS.includes(target)) return resolve({ ok: false, error: 'terminal not allowed' });
      const sid = (body.sid != null && /^\d{1,3}$/.test(String(body.sid))) ? String(body.sid) : null;
      if (!sid) return resolve({ ok: false, error: 'bad session id' });
      const sess = `${C.TERM_SESSION_PREFIX}${target}-${sid}`;
      // Sanitize: tabs/newlines would break the list-sessions -F parsing, #{} would be
      // re-expanded by tmux's format engine. Collapse whitespace, cap length. execFile
      // takes argv, so there's no shell to inject into.
      const label = String(body.label || '').replace(/[\t\n\r#{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
      const argv = label
        ? ['-L', C.TERM_TMUX_SOCKET, 'set-option', '-t', sess, '@mc_label', label]
        : ['-L', C.TERM_TMUX_SOCKET, 'set-option', '-t', sess, '-u', '@mc_label'];
      execFile(C.TERM_TMUX_BIN, argv, { timeout: 8000, env: { ...process.env, HOME: C.HOME } }, (err, so, se) => {
        const msg = (se || so || '').toString();
        // Zrcadlo do trvalého úložiště, ať jméno přežije smrt session (label ''
        // smaže tmux option i uložený záznam).
        if (!err) termLabels.setLabel(sess, label || null);
        resolve({ ok: !err, label: label || null, action: label ? `přejmenováno na „${label}"` : 'jméno odebráno', error: err ? (msg.slice(0, 200) || String(err.message)) : null });
      });
      return;
    }
    if (type === 'term.scroll') {
      // Drive tmux copy-mode scroll server-side: the iframe's xterm.js wheel
      // can't reach tmux, and the conversation history lives in tmux's scrollback
      // (not xterm.js, which resets on every reattach). dir: up|down|bottom.
      if (!C.TERM_KEYS.includes(target)) return resolve({ ok: false, error: 'terminal not allowed' });
      const sid = (body.sid != null && /^\d{1,3}$/.test(String(body.sid))) ? String(body.sid) : null;
      const sess = sid ? `${C.TERM_SESSION_PREFIX}${target}-${sid}` : `${C.TERM_SESSION_PREFIX}${target}`;
      const dir = body.dir === 'down' ? 'down' : body.dir === 'bottom' ? 'bottom' : 'up';
      const n = Math.min(200, Math.max(1, parseInt(body.lines, 10) || 3));
      const S = C.TERM_TMUX_SOCKET;
      // up: enter copy-mode (-e exits at the bottom) then scroll up N lines.
      // down: scroll down N (auto-exits to live when it hits the bottom).
      // bottom: cancel copy-mode -> jump back to the live prompt.
      const argv = dir === 'up'
        ? ['-L', S, 'copy-mode', '-e', '-t', sess, ';', 'send-keys', '-X', '-t', sess, '-N', String(n), 'scroll-up']
        : dir === 'down'
          ? ['-L', S, 'send-keys', '-X', '-t', sess, '-N', String(n), 'scroll-down']
          : ['-L', S, 'send-keys', '-X', '-t', sess, 'cancel'];
      execFile(C.TERM_TMUX_BIN, argv, { timeout: 8000, env: { ...process.env, HOME: C.HOME } }, (err, so, se) => {
        const msg = (se || so || '').toString();
        // "not in a mode" (already live / nothing to scroll) and "can't find pane"
        // are benign for down/bottom — treat as success so the wheel feels smooth.
        const benign = /not in a mode|can.?t find|no server running|no current target/i.test(msg);
        resolve({ ok: !err || benign, dir, error: (err && !benign) ? msg.slice(0, 160) || String(err.message) : null });
      });
      return;
    }
    if (type === 'term.keys') {
      // Drive Claude's TUI from a touch device: send a named key (arrows / Enter /
      // Esc / Ctrl-C…) or a literal line of text into the tmux session. xterm.js in
      // the iframe needs focus + a working soft keyboard (flaky on mobile) and has
      // no arrows/Esc/Ctrl at all, so menus and prompts are unselectable there.
      // `tmux send-keys` reaches the program regardless of focus. Same trust/plane
      // as term.scroll (tailnet-only, allowlisted key).
      if (!C.TERM_KEYS.includes(target)) return resolve({ ok: false, error: 'terminal not allowed' });
      const sid = (body.sid != null && /^\d{1,3}$/.test(String(body.sid))) ? String(body.sid) : null;
      const sess = sid ? `${C.TERM_SESSION_PREFIX}${target}-${sid}` : `${C.TERM_SESSION_PREFIX}${target}`;
      const S = C.TERM_TMUX_SOCKET;
      // Allowlist of tmux key names the touch bar may send (no arbitrary key names).
      const NAMED = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab',
        'Space', 'Home', 'End', 'PageUp', 'PageDown', 'BSpace', 'C-c', 'C-d', 'C-u', 'C-l', 'C-r', 'C-a', 'C-e', 'C-z', 'C-g']);
      let keyArgv = null;
      if (typeof body.key === 'string' && NAMED.has(body.key)) {
        keyArgv = ['-L', S, 'send-keys', '-t', sess, body.key];
      } else if (typeof body.text === 'string' && body.text.length) {
        // -l + -- => everything after is sent literally (never parsed as a key name
        // or an option). execFile takes argv, so there's no shell to inject into.
        keyArgv = ['-L', S, 'send-keys', '-t', sess, '-l', '--', body.text.slice(0, 500)];
      } else {
        return resolve({ ok: false, error: 'no key/text' });
      }
      const opts = { timeout: 6000, env: { ...process.env, HOME: C.HOME } };
      const benign = (m) => /can.?t find|no server running|no current target/i.test(m);
      const sendEnter = (done) => execFile(C.TERM_TMUX_BIN, ['-L', S, 'send-keys', '-t', sess, 'Enter'], opts,
        (e, o, s) => done(!e || benign((s || o || '').toString())));
      // Leave copy-mode first, as its OWN command: a chained `cancel` that errors
      // (when not scrolling history) aborts the rest of a ; chain, swallowing the key.
      execFile(C.TERM_TMUX_BIN, ['-L', S, 'send-keys', '-X', '-t', sess, 'cancel'], opts, () => {
        execFile(C.TERM_TMUX_BIN, keyArgv, opts, (err, so, se) => {
          const msg = (se || so || '').toString();
          const ok = !err || benign(msg);
          if (!ok || !body.enter) return resolve({ ok, error: ok ? null : msg.slice(0, 160) || String(err && err.message) });
          sendEnter((ok2) => resolve({ ok: ok2 }));
        });
      });
      return;
    }
    if (type === 'preview.remove') {
      return resolve(prev.removePreview(target));
    }
    if (type === 'cron.run') {
      const job = C.RUNNABLE_JOBS[id];
      if (!job) return resolve({ ok: false, error: 'job not allowed' });
      // detached: fire-and-forget, log to its file if defined
      const opts = { detached: true, stdio: 'ignore', cwd: job.cwd, env: job.env ? { ...process.env, ...job.env } : process.env };
      try {
        const child = execFile(job.argv[0], job.argv.slice(1), opts);
        child.unref();
        alerts.recordEvent('action', 'info', '▶', `Ručně spuštěno: ${job.label}`, 'cron');
        resolve({ ok: true, action: `spuštěno: ${job.label}`, note: 'běží na pozadí' });
      } catch (e) {
        resolve({ ok: false, error: String(e.message) });
      }
      return;
    }
    resolve({ ok: false, error: 'unknown action' });
  });
}

// ---------- static + routing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// gzip-at-boot: every file under PUBLIC is precompressed into memory once at
// startup (small static frontend — the whole dir is well under 2 MB, raw+gz fits
// in a few MB of heap). Applies ONLY to this static handler: /api/*, SSE, the
// reverse proxies, /preview/* and /file/* are streamed live and never touch it.
// A per-request mtime check keeps on-disk edits visible without a restart —
// changed or uncached files fall back to a fresh disk read and re-enter the cache.
const GZ_CACHE = new Map(); // abs path -> { raw, gz|null, mime, mtimeMs }
function gzEntry(full, st) {
  const raw = fs.readFileSync(full);
  const gz = zlib.gzipSync(raw, { level: 9 });
  const e = { raw, gz: gz.length < raw.length ? gz : null, mime: MIME[path.extname(full)] || 'application/octet-stream', mtimeMs: st.mtimeMs };
  GZ_CACHE.set(full, e);
  return e;
}
function precompressPublic(dir = PUBLIC) {
  let n = 0;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    try {
      if (d.isDirectory()) n += precompressPublic(full);
      else if (d.isFile()) { gzEntry(full, fs.statSync(full)); n++; }
    } catch { /* unreadable file — request-time fallback returns 404 */ }
  }
  return n;
}

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const full = path.normalize(path.join(PUBLIC, p));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    let e = GZ_CACHE.get(full);
    if (!e || e.mtimeMs !== st.mtimeMs) {
      try { e = gzEntry(full, st); } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    }
    const wantGz = !!e.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const head = { 'Content-Type': e.mime, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (wantGz) head['Content-Encoding'] = 'gzip';
    res.writeHead(200, head);
    res.end(wantGz ? e.gz : e.raw);
  });
}

// Serve a single file from the user's home so the terminal's Claude can show the
// user an HTML report / image / pdf in the browser: `mc-open <file>` prints a
// /file/<abs-path> URL. Path-based (not a query) so an HTML's relative assets
// resolve under the same /file/<dir>/ prefix. Scoped to HOME with a traversal
// guard; tailnet-only, same trust as the terminals.
function serveFile(req, res, url) {
  const rel = decodeURIComponent(url.replace(/^\/file/, '')) || '/';
  if (rel === '/' || rel === '') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`zadej cestu: /file/<cesta k souboru pod ${C.HOME}>`);
  }
  const full = path.normalize(rel.startsWith('/') ? rel : '/' + rel);
  if (full !== C.HOME && !full.startsWith(C.HOME + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`forbidden — jen soubory pod ${C.HOME}`);
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('soubor nenalezen');
    }
    const ct = prev.MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  });
}

// Reverse-proxy the ttyd terminal (loopback) so it shares this tailnet origin.
const TTYD_PORT = 7682;
function proxyTerm(req, res) {
  const pr = http.request({ host: '127.0.0.1', port: TTYD_PORT, path: req.url, method: req.method, headers: req.headers }, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  pr.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('terminal offline'); });
  req.pipe(pr);
}




// ----- Jarvis durable live turn -----
// A turn keeps running server-side even if the client disconnects (reload / close
// tab). Events are buffered and broadcast to any attached SSE responses; on reload
// the client re-attaches via /api/jarvis/attach and the buffer is replayed, so the
// conversation is never lost. Explicit stop goes through /api/jarvis/abort.
let jarvisLive = null; // { events:[], subs:Set<res>, ended:false }
const SSE_HEAD = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };
function jarvisWrite(res, ev, id) { try { res.write(`id: ${id}\ndata: ${JSON.stringify(ev)}\n\n`); } catch {} }
function jarvisBroadcast(ev) {
  if (!jarvisLive) return;
  const id = jarvisLive.events.length; // 0-based index doubles as the SSE event id (for ?from= reconnect)
  jarvisLive.events.push(ev);
  for (const r of jarvisLive.subs) jarvisWrite(r, ev, id);
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/term' || url.startsWith('/term/')) return proxyTerm(req, res);
  if (url === '/preview' || url.startsWith('/preview/')) return prev.handlePreview(req, res, url);
  if (url === '/file' || url.startsWith('/file/')) return serveFile(req, res, url);
  if (url === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, ts: Date.now() })); }
  if (url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(state));
  }
  // SSE state push: snapshot on connect, then only changed sections as patches.
  // /api/status above stays as the poll fallback for the old frontend.
  if (url === '/api/stream' && req.method === 'GET') return stream.handleStream(req, res, state);
  // Timeline („lodní deník"): stránkovaný chronologický feed všech zdrojů.
  if (url === '/api/timeline' && req.method === 'GET') return timeline.handleTimeline(req, res, state);
  if (url === '/api/action' && req.method === 'POST') {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let body; try { body = JSON.parse(buf); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"error":"bad json"}'); }
      const result = await runAction(body);
      // refresh soon so the UI reflects the change — but NOT for term.scroll /
      // term.keys, which fire rapidly on input and change no dashboard state.
      if (body?.type !== 'term.scroll' && body?.type !== 'term.keys') {
        setTimeout(fastRefresh, 1500);
        setTimeout(slowRefresh, 2500);
      }
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  // ----- Alert threads (interaktivní diagnostická vlákna per výstraha) -----
  // POST {key} startuje vlákno nad aktivní výstrahou; POST {key, message}
  // posílá odpověď/follow-up (a křísí stale-waiting). Allowlist-shaped:
  // klíč musí patřit aktivní výstraze nebo existujícímu vláknu.
  if (url === '/api/alert/thread' && req.method === 'POST') {
    let buf = '', tooBig = false;
    req.on('data', (c) => { buf += c; if (buf.length > C.JARVIS_MAX_MSG + 512) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) { res.writeHead(413, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"error":"zpráva je příliš dlouhá"}'); }
      let body; try { body = JSON.parse(buf); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"error":"bad json"}'); }
      const result = threads.handleMessage(body?.key, (body && typeof body.message === 'string') ? body.message : null);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  if (url === '/api/alert/thread/state' && req.method === 'GET') {
    let key = ''; try { key = new URL(req.url, 'http://x').searchParams.get('key') || ''; } catch {}
    const st = threads.stateInfo(key);
    res.writeHead(st ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(st ? JSON.stringify(st) : '{"ok":false,"error":"vlákno neexistuje"}');
  }
  // SSE attach: replay eventů od ?from= + živý stream (zrcadlí /api/jarvis/attach)
  if (url === '/api/alert/thread/attach' && req.method === 'GET') return threads.handleAttach(req, res);
  if (url === '/api/alert/thread/abort' && req.method === 'POST') {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 2048) req.destroy(); });
    req.on('end', () => {
      let body; try { body = JSON.parse(buf); } catch { body = null; }
      const result = threads.abortThread(body?.key);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  // ----- Jarvis (main agent) chat -----
  if (url === '/api/jarvis' && req.method === 'POST') {
    let buf = '', tooBig = false;
    req.on('data', (c) => { buf += c; if (buf.length > C.JARVIS_MAX_MSG + 256) { tooBig = true; req.destroy(); } });
    req.on('end', async () => {
      if (tooBig) { res.writeHead(413, { 'Content-Type': 'application/json' }); return res.end('{"error":"zpráva je příliš dlouhá"}'); }
      let body; try { body = JSON.parse(buf); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"bad json"}'); }
      const message = (body && typeof body.message === 'string') ? body.message.trim() : '';
      if (!message) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"prázdná zpráva"}'); }
      if (jarvisLive || jarvis.isBusy()) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end('{"error":"Jarvis právě pracuje"}'); }
      res.writeHead(200, SSE_HEAD);
      jarvisLive = { events: [], subs: new Set([res]), ended: false, hb: null };
      // jarvisBusy rides a patch immediately — the v2 client uses it to trigger
      // live console re-attach. Cleared in the teardown below, which every exit
      // path reaches (done / error / abort / watchdog kill all resolve runJarvis).
      state.jarvisBusy = true;
      stream.publish(state);
      // Keepalive: a turn that runs a long tool produces no SSE traffic, and a
      // silent stream gets idle-closed by Tailscale serve / the browser. A ':'
      // comment every 15 s keeps the connection warm (clients ignore comments).
      jarvisLive.hb = setInterval(() => {
        if (!jarvisLive) return;
        for (const r of jarvisLive.subs) { try { r.write(': ping\n\n'); } catch {} }
      }, 15000);
      // Client disconnect (reload / close tab) just detaches this response —
      // the turn keeps running server-side and finishes into the transcript.
      res.on('close', () => { if (jarvisLive) jarvisLive.subs.delete(res); });
      await jarvis.runJarvis(message, jarvisBroadcast);
      jarvisLive.ended = true;
      clearInterval(jarvisLive.hb);
      for (const r of jarvisLive.subs) { try { r.end(); } catch {} }
      jarvisLive = null;
      state.jarvisBusy = false;
      stream.publish(state);
      setTimeout(fastRefresh, 1500); // in case Jarvis changed services/repos
    });
    return;
  }
  // Re-attach to an in-progress turn after a reload: replay its buffer, keep streaming.
  if (url === '/api/jarvis/attach' && req.method === 'GET') {
    if (!jarvisLive) { res.writeHead(204); return res.end(); } // turn already finished & torn down
    res.writeHead(200, SSE_HEAD);
    // ?from=<n>: replay only events the client hasn't rendered yet, so a mid-turn
    // reconnect never duplicates already-shown text / tool rows.
    let from = 0; try { from = Math.max(0, parseInt(new URL(req.url, 'http://x').searchParams.get('from'), 10) || 0); } catch {}
    for (let i = from; i < jarvisLive.events.length; i++) jarvisWrite(res, jarvisLive.events[i], i);
    if (jarvisLive.ended) { try { res.end(); } catch {} return; }
    jarvisLive.subs.add(res);
    res.on('close', () => { if (jarvisLive) jarvisLive.subs.delete(res); });
    return;
  }
  if (url === '/api/jarvis/history' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ transcript: jarvis.getTranscript(), busy: !!jarvisLive || jarvis.isBusy() }));
  }
  if (url === '/api/jarvis/abort' && req.method === 'POST') {
    jarvis.abort(); // kills the child -> turn finishes as 'aborted', POST handler tears down jarvisLive
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (url === '/api/jarvis/reset' && req.method === 'POST') {
    jarvis.abort(); jarvis.reset();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405); res.end('method not allowed');
});

// WebSocket upgrade proxy: ttyd terminal + proxy-type previews (e.g. Vite HMR).
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/preview/')) { prev.handlePreviewUpgrade(req, socket, head); return; }
  if (!req.url.startsWith('/term')) { socket.destroy(); return; }
  const up = net.connect(TTYD_PORT, '127.0.0.1', () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    raw += '\r\n';
    up.write(raw);
    if (head && head.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

// ---------- boot ----------
(async () => {
  // Alert engine first: opens alerts.db and restores still-open alerts as active
  // tracks (openedTs/ackTs/diagnóza z DB), takže restart služby neztratí otevřené
  // výstrahy — první fastRefresh je buď potvrdí (podmínka dál platí), nebo je
  // nechá normálně doběhnout přes resolving→resolved. Řádky pravidel, která už
  // v configu nejsou, se při bootu zavřou jako stale.
  alerts.init();
  threads.init({ getState: () => state }); // obnova vláken z data/threads/ (resumable přes --resume)
  mctasks.init({ getState: () => state }); // PO threads.init — rekonciliace stavů úkolů s obnovenými vlákny
  timeline.recent(state); // seed state.timeline.recent před prvním publish (ticker má data už v prvním snapshotu)
  await slowRefresh();
  // uptime = první modul podle vzoru moduleLoop(): seed z historie (unknown do
  // první proby) + start proby (async) + interval — vše najednou gatované
  // MODULES.uptime. Vypnutý modul: state.uptime se nikdy nenastaví (viz test
  // modules-gating.test.mjs — klíč "uptime" pak v /api/status chybí úplně).
  moduleLoop(C.MODULES.uptime, () => { state.uptime = upt.collectUptime(); }, uptimeRefresh, C.UPTIME_INTERVAL_MS);
  // ga4 = druhý modul, ale PRVNÍ s dvěma refresh kadencemi nad stejnou DB:
  // moduleLoop() se volá dvakrát nad stejným MODULES.ga4 gate — seed (čtení
  // poslední dobré DB hodnoty do state.ga4) patří jen do prvního volání, druhé
  // dostává no-op seed (state.ga4 už je nastavené), ať se nepřepisuje zbytečně
  // dvakrát. Vypnutý modul: obě volání se hned vrátí, žádný seed/refresh/interval.
  moduleLoop(C.MODULES.ga4, () => { state.ga4 = ga4mod.buildGa4Section(); }, ga4Refresh, C.GA4_REFRESH_MS);
  moduleLoop(C.MODULES.ga4, () => {}, ga4LiveRefresh, C.GA4_LIVE_REFRESH_MS);
  // gsc = třetí modul, jedna kadence (6 h default) — seed čte poslední dobrou
  // hodnotu z data/gsc.db, vypnutý modul: žádný seed/refresh/interval.
  moduleLoop(C.MODULES.gsc, () => { state.gsc = gscmod.collectGSC(); }, gscRefresh, C.GSC_REFRESH_MS);
  // indexace = čtvrtý modul, jedna kadence (24 h default) — seed čte poslední
  // dobrou hodnotu z data/indexace.db, vypnutý modul: žádný seed/refresh/interval.
  moduleLoop(C.MODULES.indexace, () => { state.indexace = idxmod.collectIndexace(); }, indexaceRefresh, C.INDEXACE_REFRESH_MS);
  // claudelimits = pátý modul, žádná DB — seed jen čte collectClaudeLimits()
  // (vrátí bezpečný idle/stale placeholder, dokud neproběhne první refresh).
  // Vypnutý modul: state.claudeLimits se nikdy nenastaví (test/modules-gating.test.mjs).
  moduleLoop(C.MODULES.claudelimits, () => { state.claudeLimits = climod.collectClaudeLimits(); }, claudeLimitsRefresh, C.CLAUDE_LIMITS_REFRESH_MS);
  // wpsched = šestý modul, jedna kadence (4 h default) — seed čte poslední
  // dobrý snímek z data/wpsched.json (viz modules/wpsched.js loadSeed), vypnutý
  // modul: state.wpsched se nikdy nenastaví (test/modules-gating.test.mjs).
  moduleLoop(C.MODULES.wpsched, () => { state.wpsched = wpschedmod.collectWpsched(); }, wpschedRefresh, C.WPSCHED_REFRESH_MS);
  // nanoclaw = sedmý modul, jedna kadence (60 s default) — seed čte bezpečný
  // 'off' placeholder (collectNanoclaw() bez cache), vypnutý modul:
  // state.nanoclaw se nikdy nenastaví (test/modules-gating.test.mjs).
  moduleLoop(C.MODULES.nanoclaw, () => { state.nanoclaw = ncmod.collectNanoclaw(); }, nanoclawRefresh, C.NANOCLAW_REFRESH_MS);

  // watchdog = osmý modul, jedna kadence (60 s default) — seed čte bezpečný
  // "warn, žádný history záznam" placeholder (collectWatchdog() bez cache),
  // vypnutý modul: state.watchdog se nikdy nenastaví (test/modules-gating.test.mjs).
  moduleLoop(C.MODULES.watchdog, () => { state.watchdog = wdmod.collectWatchdog(); }, watchdogRefresh, C.WATCHDOG_REFRESH_MS);
  netstatRefresh(); // first NIC sample + seed today/24h transfer totals
  await fastRefresh();
  setInterval(fastRefresh, C.FAST_MS);
  setInterval(slowRefresh, C.SLOW_MS);
  setInterval(netstatRefresh, C.NETSTAT_REFRESH_MS);
  const nGz = precompressPublic(); // gzip-at-boot: static assets -> in-memory raw+gz
  server.listen(C.PORT, C.HOST, () => {
    console.log(`[mission-control] listening on http://${C.HOST}:${C.PORT} (${nGz} static files precompressed)`);
  });
})();
