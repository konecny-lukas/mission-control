/* MC v2 — timeline drawer „LODNÍ DENÍK" (jediný drawer s vlastním fetchem:
   GET /api/timeline?before=&limit=&filter=&severity= -> {events,nextBefore}).
   Filter chips po skupinách zdrojů (multi-select, persist mc.tl; vše zapnuté =
   bez filtru -> cached první stránka), severity = minimum, denní separátory,
   „↓ starší" kurzorová paginace. Živý prepend: bus 'timeline' (SSE) + patch
   sekce 'timeline' (tudy tečou rutinní cron doběhy) — respektuje filtry;
   deps:[] takže patch infra drawer NIKDY nepřestavuje. */

import { $, esc, hm } from '../core/dom.js';
import { S } from '../core/store.js';
import { bus } from '../core/net.js';
import { registerDrawer, openDrawer } from './drawer.js';

const PAGE = 60;
// Narativní projekty (watchdog modul) jsou config-driven — id/label přichází
// v state.catalog.watchdogProjects (server.js CATALOG, ze CFG.modules.watchdog.
// projects — viz config.js WATCHDOG_PROJECTS). Skupina 'narr' se proto počítá
// LÍNĚ (funkce groups(), ne statický top-level pole) — v okamžiku importu
// tohohle modulu ještě není žádná SSE snapshot doručená, takže katalog je
// prázdný; první reálné volání (drawer open) už S.catalog má.
const watchdogProjects = () => S.catalog?.watchdogProjects || [];
function groups() { // chip -> adapter sources (přesné názvy z timeline.js backendu)
  return [
    { id: 'weby',   label: 'WEBY',     srcs: ['uptime'] },
    { id: 'crony',  label: 'CRONY',    srcs: ['cron', 'watchdog'] },
    { id: 'narr',   label: 'DENÍKY',   srcs: watchdogProjects().map((p) => `narrative.${p.id}`) },
    { id: 'jarvis', label: 'JARVIS',   srcs: ['jarvis'] },
    { id: 'db',     label: 'VÝSTRAHY', srcs: ['db'] }, // alert/action/diagnosis (uložené v alerts.db)
  ];
}
const SEVS = [{ id: '', label: 'VŠE' }, { id: 'warn', label: '⚠ WARN+' }, { id: 'crit', label: '✖ CRIT' }];
const SEV_RANK = { info: 0, ok: 1, warn: 2, crit: 3 };
const STATIC_SRC_LABEL = {
  cron: 'CRON', watchdog: 'HLÍDAČ', uptime: 'WEBY', jarvis: 'JARVIS',
  alert: 'VÝSTRAHA', action: 'AKCE', diagnosis: 'DIAGNÓZA', thread: 'VLÁKNO',
};
// zdroj události -> čitelný chip label. narrative.<id> je config-driven
// (watchdogProjects()), proto funkce místo statické tabulky jako STATIC_SRC_LABEL.
function srcLabel(source) {
  if (STATIC_SRC_LABEL[source]) return STATIC_SRC_LABEL[source];
  if (source && source.startsWith('narrative.')) {
    const id = source.slice('narrative.'.length);
    const p = watchdogProjects().find((x) => x.id === id);
    return (p ? p.label : id).slice(0, 16).toUpperCase();
  }
  return String(source || '').toUpperCase();
}
// zdroj události -> chip skupina (db ukládá alert/action/diagnosis/thread)
function groupOf(source) {
  if (source === 'alert' || source === 'action' || source === 'diagnosis' || source === 'thread') return 'db';
  for (const g of groups()) if (g.srcs.includes(source)) return g.id;
  return null;
}

// ---------- persistovaný stav filtrů (mc.tl) ----------
function load() {
  try {
    const j = JSON.parse(localStorage.getItem('mc.tl') || '{}');
    return { on: Array.isArray(j.on) && j.on.length ? j.on.filter((x) => groups().some((g) => g.id === x)) : groups().map((g) => g.id), sev: SEVS.some((s) => s.id === j.sev) ? j.sev : '' };
  } catch { return { on: groups().map((g) => g.id), sev: '' }; }
}
function save() { try { localStorage.setItem('mc.tl', JSON.stringify(cur)); } catch { /* private mode */ } }

let cur = load();          // { on:[group ids], sev:'' | 'warn' | 'crit' }
let transient = false;     // filtr přišel z opts (pill) -> nepersistovat
let nextBefore = null;     // kurzor paginace
let lastDay = '';          // den posledního vykresleného řádku (separátory)
let seen = new Set();      // obsahové klíče (dedup fetch/živý prepend)
let loading = false;

const allOn = () => cur.on.length === groups().length;
const srcsParam = () => groups().filter((g) => cur.on.includes(g.id)).flatMap((g) => g.srcs).join(',');
const passes = (ev) => {
  const g = groupOf(ev.source);
  if (!allOn() && (!g || !cur.on.includes(g))) return false;
  return (SEV_RANK[ev.severity] ?? 0) >= (SEV_RANK[cur.sev] ?? 0);
};
// dedup VŽDY přes obsahový klíč — fetchnuté události mají id, živé (SSE) ne;
// týž event musí mít týž klíč v obou cestách, jinak by patch prependoval dupy
const keyOf = (ev) => `${ev.ts}|${ev.source}|${ev.text}`;
const mounted = () => !!document.getElementById('tlList') && $('#drawer').classList.contains('open');

// ---------- render ----------
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function dayLabel(ts) {
  const now = new Date(), k = dayKey(ts);
  if (k === dayKey(now)) return 'DNES';
  if (k === dayKey(now - 86400000)) return 'VČERA';
  return new Date(ts).toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric' }).toUpperCase();
}
const sepHTML = (ts) => `<div class="tl-sep" data-day="${dayKey(ts)}"><span>${esc(dayLabel(ts))}</span></div>`;
function rowHTML(ev) {
  const sev = SEV_RANK[ev.severity] != null ? ev.severity : 'info';
  return `<div class="tl-row sev-${sev}"${ev.link ? ` data-link="${esc(ev.link)}" role="button" tabindex="0"` : ''}>
    <span class="tl-ic">${esc(ev.icon || '·')}</span><span class="tl-ts">${hm(ev.ts)}</span>
    <span class="tl-src">${esc(srcLabel(ev.source))}</span>
    <span class="tl-tx">${esc(ev.text || '')}</span>${ev.link ? '<span class="tl-go">▸</span>' : ''}</div>`;
}
function appendEvents(list, evs) {
  let h = '';
  for (const ev of evs) {
    const k = keyOf(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    const dk = dayKey(ev.ts);
    if (dk !== lastDay) { h += sepHTML(ev.ts); lastDay = dk; }
    h += rowHTML(ev);
  }
  list.insertAdjacentHTML('beforeend', h);
}
function setMore(body) {
  const m = body.querySelector('#tlMore');
  if (m) m.innerHTML = nextBefore ? `<button class="btn" id="tlMoreBtn">↓ starší</button>` : `<span class="tl-end">— začátek deníku (strop 30 dní) —</span>`;
}

// ---------- fetch ----------
async function fetchPage(body, before) {
  if (loading) return;
  loading = true;
  const list = body.querySelector('#tlList');
  if (!before) { list.innerHTML = '<div class="tl-loading">načítám lodní deník…</div>'; nextBefore = null; }
  const q = new URLSearchParams({ limit: String(PAGE) });
  if (!allOn()) q.set('filter', srcsParam());
  if (cur.sev) q.set('severity', cur.sev);
  if (before) q.set('before', before);
  try {
    const r = await fetch(`/api/timeline?${q}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!body.isConnected) return; // drawer mezitím zavřen/přestavěn
    // reset dedup stavu až S ODPOVĚDÍ — živý prepend během fetche se nezahodí
    if (!before) { list.innerHTML = ''; lastDay = ''; seen = new Set(); }
    appendEvents(list, j.events || []);
    nextBefore = j.nextBefore || null;
    if (!list.children.length) list.innerHTML = '<div class="tl-loading">žádné záznamy pro zvolený filtr</div>';
  } catch (e) {
    if (body.isConnected) list.insertAdjacentHTML('beforeend', `<div class="tl-loading">✕ deník se nepodařilo načíst (${esc(e.message)})</div>`);
  } finally {
    loading = false;
    if (body.isConnected) setMore(body);
  }
}

// ---------- živý prepend (respektuje filtry; jen když je drawer otevřený) ----------
function prepend(ev) {
  if (!mounted() || !ev || !Number.isFinite(ev.ts) || !passes(ev)) return;
  const k = keyOf(ev);
  if (seen.has(k)) return;
  seen.add(k);
  const list = document.getElementById('tlList');
  const first = list.firstElementChild;
  const dk = dayKey(ev.ts);
  if (first && first.classList.contains('tl-sep') && first.dataset.day === dk) {
    first.insertAdjacentHTML('afterend', rowHTML(ev)); // pod existující „DNES"
  } else {
    list.insertAdjacentHTML('afterbegin', sepHTML(ev.ts) + rowHTML(ev));
    if (!first) lastDay = dk; // prázdný seznam -> separátor dole nezdvojit
  }
  const row = list.querySelector('.tl-row');
  if (row) { row.classList.add('tl-new'); setTimeout(() => row.classList.remove('tl-new'), 1200); }
}

// ---------- drawer ----------
function build(_S, opts) {
  // filtr z opts (pill s alerty -> {filter:'db'}) je TRANSIENTNÍ — nepersistuje
  // a plain reopen ho vrátí na uložený stav; řeší se tady (build kreslí chips)
  if (opts && opts.filter && groups().some((g) => g.id === opts.filter)) { cur = { on: [opts.filter], sev: load().sev }; transient = true; }
  else if (transient) { cur = load(); transient = false; }
  const chips = groups().map((g) => `<button class="tl-chip${cur.on.includes(g.id) ? ' on' : ''}" data-grp="${g.id}">${g.label}</button>`).join('');
  const sevs = SEVS.map((s) => `<button class="tl-chip sev${cur.sev === s.id ? ' on' : ''}" data-sev="${s.id}">${s.label}</button>`).join('');
  return `<div class="tl-bar"><div class="tl-chips">${chips}</div><div class="tl-chips tl-right">${sevs}</div></div>
    <div id="tlList"></div><div class="tl-more" id="tlMore"></div>`;
}

function wire(body) {
  body.querySelector('.tl-bar').addEventListener('click', (e) => {
    const c = e.target.closest('.tl-chip');
    if (!c) return;
    if (c.dataset.grp) {
      const id = c.dataset.grp;
      if (transient) { transient = false; cur = { on: [id], sev: cur.sev }; } // ruční klik přebírá transientní výběr
      else cur.on = cur.on.includes(id) ? cur.on.filter((x) => x !== id) : [...cur.on, id];
      if (!cur.on.length) cur.on = groups().map((g) => g.id); // poslední chip nelze vypnout
      save();
      body.querySelectorAll('.tl-chip[data-grp]').forEach((x) => x.classList.toggle('on', cur.on.includes(x.dataset.grp)));
    } else {
      cur.sev = c.dataset.sev || '';
      if (!transient) save();
      body.querySelectorAll('.tl-chip[data-sev]').forEach((x) => x.classList.toggle('on', x.dataset.sev === cur.sev));
    }
    fetchPage(body);
  });

  body.addEventListener('click', (e) => {
    if (e.target.closest('#tlMoreBtn')) { fetchPage(body, nextBefore); return; }
    const link = e.target.closest('.tl-row[data-link]')?.dataset.link;
    if (link && !openDrawer(link)) openDrawer('timeline'); // neznámý link -> zůstat v deníku
  });
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const link = e.target.closest?.('.tl-row[data-link]')?.dataset.link;
    if (link) openDrawer(link);
  });

  fetchPage(body);
}

export function initTimeline() {
  registerDrawer('timeline', { title: 'LODNÍ DENÍK', wide: true, deps: [], build, wire });
  // živé události: SSE `timeline` (alerty/akce) + patch sekce (cron doběhy)
  bus.addEventListener('timeline', (e) => prepend(e.detail));
  bus.addEventListener('patch', (e) => {
    if (!mounted() || !(e.detail || []).includes('timeline')) return;
    const rec = (S.timeline || {}).recent || [];
    [...rec].reverse().forEach((ev) => { if (!seen.has(keyOf(ev))) prepend(ev); });
  });
}
