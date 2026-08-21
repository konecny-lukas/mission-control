/* MC v2 — entry point.
   Pořadí: registrace sekcí (import panels) -> GL jádro -> boot -> síť.
   Jediný rAF loop vlastní gl/core.js; všechno ostatní je event-driven. */

import { $ } from './core/dom.js';
import { startNet } from './core/net.js';
import { initCore } from './gl/core.js';
import { initBoot } from './ui/boot.js';
import { initPanels } from './ui/panels.js';
import { initDrawer, openDrawer } from './ui/drawer.js';
import { initViewer } from './ui/viewer.js';
import { initJarvis } from './ui/jarvis.js';
import { initDrawers } from './drawers.js';
import { openTermDrawer } from './ui/term.js';
import { initPalette } from './ui/palette.js';
import { initTimeline } from './ui/timeline.js';
import { initThread } from './ui/thread.js';

// Esc-chain (pushEsc) je v core/esc.js — importují ho drawer/viewer/jarvis/palette,
// takže se modul (a jeho keydown handler) načte. Tady ho už nedeklarujeme, aby
// žádný modul neimportoval entry (app.js) → žádný kruhový import.

// ---------- hodiny ----------
function tickClock() {
  const now = new Date();
  const f = (opt) => new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', ...opt }).format(now);
  $('#clock').textContent = f({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#dateEl').textContent = f({ weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' }).toUpperCase();
}
setInterval(tickClock, 1000);
tickClock();

// ---------- start ----------
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const core = initCore($('#core'), { mobile: innerWidth <= 560, reduced });
core.setIntensity(1.15);

initPanels(core);  // registruje sekce + delegované listenery panelů
initViewer();      // preview viewer mount + Esc (má přednost před drawerem)
initDrawer();      // drawer mount wiring + Esc registrace
initDrawers();     // registrace všech drawer builderů (vč. terminálu)
initTimeline();    // timeline drawer „LODNÍ DENÍK" (fetchuje vlastní endpoint)
initThread();      // alert thread drawer (konzole vlákna nad výstrahou)
initJarvis();      // Jarvis konzole (Esc až po draweru) + history replay
initPalette();     // Ctrl+K paleta (Esc-chain front — nejvyšší priorita)
initBoot(core);    // boot sekvence (vlastní core.boot časování)
startNet();        // SSE -> snapshot -> renderAll; pak patche

// dev/QA hook (paleta/timeline QA: injectTimeline jde STEJNOU cestou jako SSE)
import { S } from './core/store.js';
import { injectTimeline } from './core/net.js';
window.__mc = { openDrawer, openTermDrawer, S, injectTimeline };

// ---------- service worker (PWA) ----------
// `'serviceWorker' in navigator` platí jen v secure contextu (https) — na plain
// HTTP mountu je to no-op. Mimo /preview/: mcv2 preview má injektovaný <base>
// a SW scope by nepasoval; register('/sw.js') by tam navíc zaregistroval cizí
// (v1) worker z kořene originu. controllerchange handshake = port z v1
// public/app.js: po převzetí stránky novým workerem jednou auto-reload, aby
// klienti s nacacheovaným starým shellem dostali čistě nový build.
if ('serviceWorker' in navigator && !location.pathname.startsWith('/preview/')) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !hadController) return; reloaded = true; location.reload();
  });
  navigator.serviceWorker.register('/sw.js').then((r) => r.update && r.update()).catch(() => {});
}
