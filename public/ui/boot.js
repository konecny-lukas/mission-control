/* MC v2 — boot orchestrátor (JEDINÝ vlastník boot sekvence).
   Sekvence dle mockupu B: grid fade -> panel trace + typewriter titulky
   (CSS animace s per-panel --d staggerem) -> core ignition (gl.boot) ->
   data populate (rowIn slide) -> „SYSTÉMY ONLINE" v pillu.
   - skip: keydown/pointerdown -> okamžitý snap do final stavu (html.done)
   - repeat visit (sessionStorage mc.booted): zkrácená ignition (html.fast)
   - prefers-reduced-motion: žádné animace, jen fade (CSS) + okamžitý done */

import { bus } from '../core/net.js';
import { $ } from '../core/dom.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let done = false;
let coreRef = null; // gl core API, dodá app.js

function finish() {
  if (done) return;
  done = true;
  document.documentElement.classList.add('done');
  document.documentElement.removeAttribute('data-boot');
  const ov = $('#boot');
  if (ov) { ov.classList.add('out'); setTimeout(() => ov.remove(), 450); }
  try { sessionStorage.setItem('mc.booted', '1'); } catch { /* private mode */ }
}

function skip() {
  if (done) return;
  finish();
}

export function initBoot(core) {
  coreRef = core;
  const html = document.documentElement;
  const repeat = (() => { try { return sessionStorage.getItem('mc.booted') === '1'; } catch { return false; } })();

  if (reduced) {
    // reduced-motion: 1 statický frame jádra, žádná choreografie
    html.classList.add('done');
    html.removeAttribute('data-boot');
    const ov = $('#boot'); if (ov) ov.remove();
    done = true;
    coreRef.boot(null);
    return;
  }

  if (repeat) html.classList.add('fast'); // zkrácená ignition, bez typewriteru

  // per-panel stagger (--d čte CSS u panelIn / type / rowIn animací)
  document.querySelectorAll('.panel').forEach((p, i) =>
    p.style.setProperty('--d', (repeat ? 60 : 250 + i * 60) + 'ms'));

  // core ignition: spustí se po panel trace, nezávisle na datech
  setTimeout(() => coreRef.boot(null), repeat ? 150 : 650);

  // boot overlay zmizí na první snapshot NEBO po 1200 ms (co přijde dřív)
  const ovOut = () => { const ov = $('#boot'); if (ov && !ov.classList.contains('out')) { ov.classList.add('out'); setTimeout(() => ov.remove(), 450); } };
  bus.addEventListener('snapshot', ovOut, { once: true });
  setTimeout(ovOut, 1200);

  // konec bootu: snap do final stavu (html.done sundá animace -> patche pak
  // přestavují DOM bez re-animací)
  setTimeout(finish, repeat ? 700 : 2200);

  // skippable
  addEventListener('keydown', skip, { capture: true, once: false });
  addEventListener('pointerdown', skip, { capture: true, once: false });
}

// ⟲ BOOT tlačítko — přehraje sekvenci znovu (plnou, ne zkrácenou)
export function replayBoot() {
  try { sessionStorage.removeItem('mc.booted'); } catch { /* ignore */ }
  location.reload();
}
