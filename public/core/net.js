/* MC v2 — síťová vrstva: SSE (/api/stream) primárně, poll (/api/status) jako
   fallback. Obě cesty ústí do téhož patch pipeline ve store.js.

   Pravidla (dle plánu):
   - snapshot  -> replaceState + renderAll
   - patch     -> Object.assign(S, sections) + store.patch(klíče)
   - timeline  -> prepend do S.timeline.recent + bus event (pulz jádra)
   - hb        -> jen občerství staleness timestamp
   - >=3 SSE onerror za 30 s -> zavřít, poll fallback po 8 s (client-side
     per-key JSON compare), re-probe SSE každých 60 s
   - staleness > 40 s -> tvrdý reconnect (+ poll kick)
   - visibilitychange -> visible + stale -> reconnect
   - body.signal-lost JEN když selhávají oba transporty
   - ?nosse=1 -> SSE se vůbec nezkouší (testovací přepínač poll fallbacku) */

import { S, replaceState, patch, renderAll } from './store.js';
import { toast } from './dom.js';

export const bus = new EventTarget(); // 'snapshot' | 'patch' | 'timeline' | 'net'

const NOSSE = new URLSearchParams(location.search).has('nosse');
const POLL_MS = 8000;
const PROBE_MS = 60000;
const STALE_MS = 40000;
const TL_CAP = 40; // strop živě prependované timeline v paměti

let es = null;
let pollTimer = 0, probeTimer = 0;
let lastSeen = 0;        // poslední přijatá data/hb (libovolný transport)
let errTimes = [];       // časy SSE onerror v posuvném okně 30 s
let sseDead = NOSSE;     // SSE odepsáno -> jedeme na poll
let pollFailing = false; // poslední poll selhal
let gotFirst = false;
const strCache = new Map(); // per-key serializace pro poll diff

// ---------- stav „ztracený signál" ----------
function updateLost() {
  const stale = !lastSeen || (Date.now() - lastSeen > STALE_MS);
  const sseDown = sseDead || !es || es.readyState === EventSource.CLOSED;
  const lost = gotFirst ? (stale && sseDown && pollFailing) : (sseDown && pollFailing);
  document.body.classList.toggle('signal-lost', lost);
  bus.dispatchEvent(new CustomEvent('net', { detail: { lost } }));
  patch(['_net']);
}

function alive() {
  lastSeen = Date.now();
  if (pollFailing || document.body.classList.contains('signal-lost')) {
    pollFailing = false;
    updateLost();
  }
}

// ---------- aplikace dat (společné pro SSE i poll) ----------
function seedCache(state) {
  strCache.clear();
  for (const k of Object.keys(state)) {
    if (k === 'ts') continue;
    try { strCache.set(k, JSON.stringify(state[k])); } catch { /* cyklus nevadí */ }
  }
}

function applySnapshot(state) {
  replaceState(state);
  seedCache(state);
  gotFirst = true;
  alive();
  renderAll();
  bus.dispatchEvent(new CustomEvent('snapshot'));
}

function applySections(sections, ts) {
  const keys = Object.keys(sections);
  for (const k of keys) {
    S[k] = sections[k];
    try { strCache.set(k, JSON.stringify(sections[k])); } catch { /* ignore */ }
  }
  if (ts) S.ts = ts;
  alive();
  patch(keys);
  bus.dispatchEvent(new CustomEvent('patch', { detail: keys }));
}

function applyTimeline(ev) {
  if (!ev) return;
  const tl = S.timeline && Array.isArray(S.timeline.recent) ? S.timeline : (S.timeline = { recent: [] });
  tl.recent.unshift(ev);
  if (tl.recent.length > TL_CAP) tl.recent.length = TL_CAP;
  alive();
  patch(['timeline']);
  bus.dispatchEvent(new CustomEvent('timeline', { detail: ev }));
}

// ---------- SSE ----------
function closeSSE() {
  if (es) { try { es.close(); } catch { /* ignore */ } es = null; }
}

function openSSE() {
  if (NOSSE) return;
  closeSSE();
  es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => {
    try { applySnapshot(JSON.parse(e.data).state); } catch (err) { console.error('[net] snapshot', err); }
  });
  es.addEventListener('patch', (e) => {
    try { const d = JSON.parse(e.data); applySections(d.sections || {}, d.ts); } catch (err) { console.error('[net] patch', err); }
  });
  es.addEventListener('timeline', (e) => {
    try { applyTimeline(JSON.parse(e.data)); } catch { /* ignore */ }
  });
  es.addEventListener('hb', () => alive());
  es.onopen = () => {
    errTimes = [];
    sseDead = false;
    stopPoll();   // SSE žije -> poll už netřeba
    stopProbe();
    updateLost();
  };
  es.onerror = () => {
    const now = Date.now();
    errTimes.push(now);
    errTimes = errTimes.filter((t) => now - t < 30000);
    if (errTimes.length >= 3) {
      // SSE to nedává -> odepsat, přejít na poll, sondovat každou minutu
      closeSSE();
      sseDead = true;
      startPoll();
      startProbe();
    }
    updateLost();
  };
}

// ---------- poll fallback ----------
async function pollOnce() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const st = await r.json();
    pollFailing = false;
    if (!gotFirst) { applySnapshot(st); return; }
    // client-side per-key diff -> stejná patch cesta jako SSE
    const changed = {};
    let n = 0;
    for (const k of Object.keys(st)) {
      if (k === 'ts') continue;
      let str;
      try { str = JSON.stringify(st[k]); } catch { continue; }
      if (strCache.get(k) !== str) { changed[k] = st[k]; n++; }
    }
    if (n) applySections(changed, st.ts);
    else alive();
  } catch (e) {
    pollFailing = true;
    updateLost();
  }
}

function startPoll() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
}
function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
  pollFailing = false;
}

// re-probe SSE každých 60 s, dokud jedeme na poll
function startProbe() {
  if (probeTimer || NOSSE) return;
  probeTimer = setInterval(() => { if (sseDead) openSSE(); }, PROBE_MS);
}
function stopProbe() {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = 0; }
}

// okamžitý kick mimo plán (po akci) — ať UI odráží změnu i v SSE režimu
export function kick() { pollOnce(); }

// QA hook (window.__mc): syntetická timeline událost STEJNOU cestou jako SSE
// event `timeline` — jen page-side, nikam se neukládá.
export function injectTimeline(ev) { applyTimeline(ev); }

// ---------- jednotná akce (confirm + POST /api/action + toast) ----------
// JEDINÁ implementace pro celé UI (drawery, výstrahy, terminál launcher).
// opts.confirm = text potvrzení (bez něj se neptá); opts.refresh = ms do kicku.
export async function postAction(body, btn, opts = {}) {
  if (opts.confirm && !window.confirm(opts.confirm)) return null;
  let old;
  if (btn) { btn.disabled = true; old = btn.textContent; btn.textContent = '…'; }
  try {
    const r = await fetch('/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!opts.quiet) toast(j.ok ? `✓ ${j.action || 'hotovo'}${j.note ? ' — ' + j.note : ''}` : `✕ ${j.error || 'chyba'}`, j.ok ? 'ok' : 'err');
    return j;
  } catch (e) {
    if (!opts.quiet) toast('✕ ' + e.message, 'err');
    return { ok: false, error: e.message };
  } finally {
    if (btn) { btn.disabled = false; if (old != null) btn.textContent = old; }
    if (opts.refresh !== 0) setTimeout(kick, opts.refresh || 1800);
  }
}

// ---------- staleness watchdog + visibility ----------
function hardReconnect() {
  errTimes = [];
  if (!NOSSE) openSSE();
  pollOnce(); // okamžitý kick — ať jsou data hned, i kdyby SSE handshake trval
}

export function startNet() {
  if (NOSSE) {
    sseDead = true;
    startPoll();
  } else {
    openSSE();
  }
  setInterval(() => {
    if (lastSeen && Date.now() - lastSeen > STALE_MS) {
      hardReconnect();
      if (sseDead) startPoll();
      updateLost();
    }
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && lastSeen && Date.now() - lastSeen > STALE_MS) hardReconnect();
  });
}
