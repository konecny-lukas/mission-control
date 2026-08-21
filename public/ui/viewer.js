/* MC v2 — preview viewer (velké okno uvnitř MC, iframe na /preview/<slug>/).
   VERBATIM port z public/app.js:286–313; markup se montuje do #viewer.
   Esc řeší globální chain (viewer má přednost před drawerem). */

import { $ } from '../core/dom.js';
import { pushEsc } from '../core/esc.js';

let viewer, viewerFrame;
let viewerSlug = null;

// Pop a preview out into its own OS window, named by slug so re-opening the same
// one focuses its existing window while different previews each get their own.
export function popOut(slug) {
  if (!slug) return;
  window.open(`/preview/${slug}/`, `pv-${slug}`, 'width=1400,height=900');
}

export function openViewer(slug, title) {
  viewerSlug = slug;
  const url = `/preview/${slug}/`;
  $('#viewerTitle').textContent = title || slug;
  $('#viewerUrl').textContent = location.host + url;
  if (viewerFrame.getAttribute('src') !== url) viewerFrame.src = url;
  viewer.classList.add('open'); viewer.setAttribute('aria-hidden', 'false');
}

export function closeViewer() {
  if (!viewer.classList.contains('open')) return;
  viewer.classList.remove('open'); viewer.setAttribute('aria-hidden', 'true');
  // unload the iframe after the fade so a proxied dev server's WS closes
  setTimeout(() => { if (!viewer.classList.contains('open')) viewerFrame.src = 'about:blank'; }, 280);
}

export const isViewerOpen = () => !!viewer && viewer.classList.contains('open');

export function initViewer() {
  viewer = $('#viewer');
  viewer.innerHTML = `
  <div class="viewer-head">
    <span class="viewer-mark">▣</span>
    <span class="viewer-title" id="viewerTitle">—</span>
    <span class="viewer-url" id="viewerUrl"></span>
    <span class="viewer-spacer"></span>
    <button class="viewer-btn viewer-btn-wide" id="viewerOpen" type="button" title="Otevřít v samostatném okně (můžeš jich mít víc vedle sebe)">⤤ Nové okno</button>
    <button class="viewer-btn" id="viewerReload" type="button" title="Obnovit">⟲</button>
    <button class="viewer-btn" id="viewerClose" type="button" title="Zavřít (Esc)">✕</button>
  </div>
  <div class="viewer-body"><iframe class="viewer-frame" id="viewerFrame" title="Náhled" src="about:blank"></iframe></div>`;
  viewer.removeAttribute('hidden');
  viewer.setAttribute('aria-hidden', 'true');
  viewerFrame = $('#viewerFrame');
  $('#viewerClose').addEventListener('click', closeViewer);
  $('#viewerOpen').addEventListener('click', () => popOut(viewerSlug));
  $('#viewerReload').addEventListener('click', () => { const s = viewerFrame.getAttribute('src'); if (s && s !== 'about:blank') viewerFrame.src = s; });
  viewer.addEventListener('click', (e) => { if (e.target === viewer) closeViewer(); }); // click the dim margin to close
  pushEsc({ isOpen: isViewerOpen, close: closeViewer });
}
