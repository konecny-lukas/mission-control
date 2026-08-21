/* MC v2 — drawer infrastruktura.
   registerDrawer(id, {title, deps, build, wire, wide, term}) + openDrawer(id, opts).
   Buildery vrací HTML string (class-contract: vzhled dělá výhradně styles.css).
   - opts se předávají do title/build/wire (např. {focus} u indexace, {key,label}
     u terminálu, {i} u detailu úkolu) a přežívají patch re-render.
   - wire(body, opts, phase) — phase 'open' | 'patch': jednorázové efekty
     (scrollIntoView na fokusovanou kartu apod.) patří JEN do fáze 'open'.
   - deps: [] = statický obsah (terminálové drawery — rebuild by reloadnul iframe).
   - Re-render běží na 'patch' (průnik s deps) i na 'snapshot' (plná výměna S) —
     drawer otevřený dřív, než dorazí snapshot, by jinak navždy ukazoval prázdný
     stub (řídké klíče jako indexace patchují 1×/24 h, nikdy by ho neopravily).
   - Re-render guardy: fokus/výběr textu + aktivní scrollování (rebuild by utnul
     setrvačný scroll). Odložený rebuild po ~1 s klidu, ať se zmeškaná data
     dorenderují. scrollTop se přes rebuild explicitně zachovává.
   - closeDrawer čistí tělo až po slide-outu — odpojí ttyd iframe (zavře WS,
     ttyd ukončí klienta -> uvolní RAM), stejně jako v1. */

import { $, fx } from '../core/dom.js';
import { S } from '../core/store.js';
import { bus } from '../core/net.js';
import { pushEsc } from '../core/esc.js';

const drawers = new Map(); // id -> { title, deps:Set, build, wire, wide, term }
let openId = null;
let openOpts = null;

export function registerDrawer(id, def) {
  drawers.set(id, { ...def, deps: new Set(def.deps || []) });
}

function mountEls() {
  return { drawer: $('#drawer'), backdrop: $('#backdrop'), title: $('#drawerTitle'), body: $('#drawerBody') };
}

export function openDrawer(id, opts) {
  const def = drawers.get(id);
  if (!def) return false;
  const { drawer, backdrop, title, body } = mountEls();
  openId = id;
  openOpts = opts || null;
  pendingRerender = false; // čerstvý build — případný odložený rebuild je bezpředmětný
  clearTimeout(settleTimer);
  title.textContent = typeof def.title === 'function' ? def.title(S, openOpts) : def.title;
  body.innerHTML = def.build(S, openOpts); // buildery escapují přes esc() — viz class-contract
  body.scrollTop = 0;
  drawer.classList.toggle('wide', !!def.wide);
  drawer.classList.toggle('term', !!def.term); // mobil: terminál přes celý viewport
  drawer.classList.toggle('thread', !!def.thread); // konzole vlákna: .db = flex sloupec, scroll má .th-log
  drawer.classList.add('open');
  backdrop.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  fx(body); // glitch jen na obsah, slide zůstává plynulý
  if (def.wire) def.wire(body, openOpts, 'open');
  return true;
}

export function closeDrawer() {
  if (!openId) return;
  openId = null;
  openOpts = null;
  const { drawer, backdrop, body } = mountEls();
  drawer.classList.remove('open');
  backdrop.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  // tělo vyčistit až po slide-outu — vložený terminálový iframe se odpojí
  // (zavře WebSocket -> ttyd ukončí Claude klienta -> uvolní RAM)
  setTimeout(() => { if (!drawer.classList.contains('open')) body.innerHTML = ''; }, 360);
}

export const isDrawerOpen = () => !!openId;

// enumerace registru (paleta si nad ids staví vlastní české labely + synonyma)
export const drawerIds = () => [...drawers.keys()];

// ---- re-render otevřeného draweru (patch / snapshot, s guardy) ----
const SCROLL_QUIET_MS = 900; // klid od posledního scrollu, než smí proběhnout rebuild
let lastScrollTs = 0;        // poslední scroll v #drawerBody (touch fling i kolečko)
let settleTimer = 0;         // čekající odložený rebuild
let pendingRerender = false; // rebuild zmeškaný kvůli guardu — doženeme po klidu

function userIsInteracting(body) {
  if (body.contains(document.activeElement) && document.activeElement !== document.body) return true;
  const sel = window.getSelection();
  return !!(sel && !sel.isCollapsed && sel.anchorNode && body.contains(sel.anchorNode));
}

function tryRerender() {
  if (!openId) { pendingRerender = false; return; }
  const def = drawers.get(openId);
  if (!def || !def.deps.size) { pendingRerender = false; return; } // statické (terminál) nikdy
  const { body } = mountEls();
  if (userIsInteracting(body) || Date.now() - lastScrollTs < SCROLL_QUIET_MS) {
    // uživatel zrovna čte/scrolluje — rebuild odložit, ať mu neuteče pozice
    pendingRerender = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(tryRerender, SCROLL_QUIET_MS + 150);
    return;
  }
  pendingRerender = false;
  const st = body.scrollTop; // innerHTML rebuild nesmí ztratit pozici (Safari ji zahazuje)
  body.innerHTML = def.build(S, openOpts);
  if (def.wire) def.wire(body, openOpts, 'patch');
  body.scrollTop = st; // clamp na kratší obsah udělá prohlížeč sám
}

bus.addEventListener('patch', (e) => {
  if (!openId) return;
  const def = drawers.get(openId);
  if (!def) return;
  const keys = e.detail || [];
  if (!keys.some((k) => def.deps.has(k)) && !pendingRerender) return;
  tryRerender();
});
// snapshot = plná výměna S (první data po načtení / SSE reconnect) — bez tohohle
// by drawer otevřený před snapshotem zůstal navždy na prázdném stubu
bus.addEventListener('snapshot', tryRerender);

// ---- wiring mountů (1× při startu) ----
export function initDrawer() {
  const { backdrop, body } = mountEls();
  $('#drawerX').addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);
  // scroll-guard: živý scroll v těle odkládá patch rebuildy (viz tryRerender)
  body.addEventListener('scroll', () => { lastScrollTs = Date.now(); }, { passive: true });
  pushEsc({ isOpen: isDrawerOpen, close: closeDrawer });
}
