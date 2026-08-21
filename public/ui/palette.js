/* MC v2 — příkazová paleta (Ctrl/Cmd+K + ⌘K v topbaru; ≤560 px bottom sheet).
   Registr LAZY při otevření: drawery + terminály + náhledy + S.catalog
   (Restart/Spustit = danger s inline confirmem Enter 2×, ŽÁDNÝ window.confirm);
   poslední řádek VŽDY „◆ Jarvis: ‚dotaz'". Fuzzy: diakritika-insensitive
   subsekvence (+2 navazující, +3 hranice slova, −0,5/mezera), top 12, <b> na
   shodě. Esc-chain front priorita; otevření instantní (120 ms, bez glitche).
   Veškerý dynamický obsah jde přes esc()/hilite(). */

import { $, esc } from '../core/dom.js';
import { S } from '../core/store.js';
import { postAction } from '../core/net.js';
import { pushEsc } from '../core/esc.js';
import { drawerIds, openDrawer } from './drawer.js';
import { termProjects, openTermDrawer } from './term.js';
import { openViewer } from './viewer.js';
import { openMctaskForm } from './panels.js';
import { ask as jarvisAsk, open as jarvisOpen } from './jarvis.js';

// české labely + synonyma drawerů; term/task potřebují opts (kryjí je
// Terminál:* položky / panel ÚKOLY), timeline kryje statická „Lodní deník"
const SKIP = new Set(['term', 'task', 'timeline']);
const DRAWER_META = {
  claude:    ['Claude Code', 'claude sessions ukoly tasks kod'],
  uptime:    ['Weby — dostupnost', 'weby uptime vypadky monitoring online stranky'],
  traffic:   ['Návštěvnost', 'navstevnost ga4 traffic weby relace sessions analytics realtime'],
  gsc:       ['Vyhledávání', 'vyhledavani gsc search console organicke kliky pozice dotazy klikatelnost'],
  indexace:  ['Indexace', 'indexace google url inspection index stav indexovani stranky site'],
  nanoclaw:  ['NanoClaw', 'nanoclaw agent asistent bot telegram whatsapp docker kontejner instalace systemd unit'],
  previews:  ['Náhledy', 'previews nahledy preview'],
  system:    ['Systém', 'system cpu ram disk pamet systemd sluzby'],
};

// ---------- registry (lazy při otevření) ----------
function buildItems() {
  const it = [];
  for (const id of drawerIds()) {
    if (SKIP.has(id)) continue;
    const [label, kw] = DRAWER_META[id] || [id.toUpperCase(), id];
    it.push({ label, kw, group: 'DETAIL', run: () => openDrawer(id) });
  }
  it.push({ label: 'Lodní deník', kw: 'timeline lodni denik log udalosti historie zaznamy', group: 'DETAIL', run: () => openDrawer('timeline') });
  for (const p of termProjects()) it.push({ label: `Terminál: ${p.label}`, kw: `terminal tmux claude shell konzole ${p.key}`, group: 'TERMINÁL', run: () => openTermDrawer(p.key, p.label) });
  for (const v of S.previews || []) it.push({ label: `Náhled: ${v.title || v.slug}`, kw: `preview nahled okno ${v.slug}`, group: 'NÁHLED', run: () => openViewer(v.slug, v.title || v.slug) });
  for (const s of (S.catalog || {}).services || []) it.push({ label: `Restart: ${s.label}`, kw: `restart sluzba service systemctl ${s.target}`, group: 'AKCE', danger: true, run: () => postAction({ type: 'service.restart', target: s.target }) });
  for (const j of (S.catalog || {}).jobs || []) it.push({ label: `Spustit: ${j.label}`, kw: `spustit job cron run rucne ${j.id}`, group: 'AKCE', danger: true, run: () => postAction({ type: 'cron.run', id: j.id }) });
  it.push({ label: 'Nový úkol…', kw: 'novy ukol task fronta zadat prace todo zarazeni', group: 'AKCE', run: () => openMctaskForm() });
  it.push({ label: 'Jarvis: nová konverzace', kw: 'jarvis reset smazat nova konverzace vynulovat', group: 'AKCE', run: () => { const b = $('#jReset'); if (b) b.click(); jarvisOpen(); } });
  return it;
}

// ---------- fuzzy match (diakritika-insensitive subsekvence) ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
const isBound = (str, i) => i === 0 || /[\s\-—·:./]/.test(str[i - 1]);

// greedy subsekvence od daného startu; vrací {score, idx[]} nebo null
function subseqFrom(q, t, start) {
  let score = 0, ti = start, prev = -2;
  const idx = [];
  for (const qc of q) {
    let found = -1;
    for (let j = ti; j < t.length; j++) if (t[j] === qc) { found = j; break; }
    if (found < 0) return null;
    score += 1;                                  // základ za znak
    if (found === prev + 1) score += 2;          // navazuje na předchozí shodu
    if (isBound(t, found)) score += 3;           // hranice slova
    if (prev >= 0 && found > prev + 1) score -= 0.5 * (found - prev - 1); // mezera
    idx.push(found); prev = found; ti = found + 1;
  }
  return { score, idx };
}
// multi-start: greedy od KAŽDÉHO slovního výskytu prvního znaku (max 8),
// bere nejlepší — jinak by „sluzby" uvázlo na prvním `s` v „system cpu …"
function subseq(q, target) {
  const t = norm(target);
  const starts = [];
  for (let i = 0; i < t.length && starts.length < 8; i++) {
    if (t[i] === q[0] && (isBound(t, i) || !starts.length)) starts.push(i);
  }
  let best = null;
  for (const s of starts) {
    const r = subseqFrom(q, t, s);
    if (r && (!best || r.score > best.score)) best = r;
  }
  return best;
}
// match přes label+kw+group; zvýraznění jen když vyhrál label
function match(q, item) {
  if (!q) return { score: 0, idx: null };
  const L = subseq(q, item.label);
  const K = subseq(q, item.kw || '');
  const G = subseq(q, item.group || '');
  const best = Math.max(L ? L.score : -1, K ? K.score - 1 : -1, G ? G.score - 2 : -1); // kw/group lehce za labelem
  if (best < 0) return null;
  return { score: best, idx: (L && L.score >= best) ? L.idx : null };
}
// label s <b> na shodných znacích (idx odpovídá normalizaci 1:1 — NFD strip nemění délku)
function hilite(label, idx) {
  if (!idx || !idx.length) return esc(label);
  const set = new Set(idx);
  let h = '';
  for (let i = 0; i < label.length; i++) h += set.has(i) ? `<b>${esc(label[i])}</b>` : esc(label[i]);
  return h;
}

// ---------- UI ----------
let pal, input, list;
let items = [];     // registry (rebuild při každém otevření)
let view = [];      // aktuálně vykreslené položky (vč. jarvis řádku)
let sel = 0;        // index výběru ve view
let armed = -1;     // index danger položky čekající na druhý Enter

export const isPalOpen = () => !!pal && pal.classList.contains('open');

function render() {
  const q = norm(input.value.trim());
  const ranked = [];
  for (const item of items) {
    const m = match(q, item);
    if (m) ranked.push({ item, ...m });
  }
  ranked.sort((a, b) => b.score - a.score);
  view = ranked.slice(0, 12).map((r) => ({ ...r.item, idx: r.idx }));
  // VŽDY poslední řádek: volný dotaz na Jarvise
  const raw = input.value.trim();
  view.push({
    label: raw ? `Jarvis: „${raw}"` : 'Jarvis: otevřít konzoli', group: 'JARVIS', jarvis: true,
    run: () => { jarvisOpen(); if (raw) jarvisAsk(raw); },
  });
  sel = Math.min(sel, view.length - 1);
  armed = -1; // psaní/refresh odzbrojí confirm
  list.innerHTML = view.map((v, i) => `
    <div class="pal-it${v.danger ? ' danger' : ''}${v.jarvis ? ' jrv' : ''}${i === sel ? ' sel' : ''}" data-i="${i}">
      <span class="pal-lb">${v.jarvis ? '◆ ' : ''}${hilite(v.label, v.idx)}</span><span class="pal-gr">${esc(v.group)}</span>
    </div>`).join('');
  list.querySelector('.pal-it.sel')?.scrollIntoView({ block: 'nearest' });
}

function setSel(i) {
  const n = Math.max(0, Math.min(i, view.length - 1));
  if (n === sel && armed < 0) return;
  sel = n;
  if (armed >= 0) { render(); return; } // pohyb odzbrojí confirm -> překreslit
  list.querySelectorAll('.pal-it').forEach((el, j) => el.classList.toggle('sel', j === sel));
  list.querySelector('.pal-it.sel')?.scrollIntoView({ block: 'nearest' });
}

function runSel() {
  const v = view[sel];
  if (!v) return;
  if (v.danger && armed !== sel) {
    // inline confirm: řádek se přepne do „Enter potvrdí" stavu
    armed = sel;
    const row = list.querySelector(`.pal-it[data-i="${sel}"]`);
    if (row) {
      row.classList.add('arm');
      row.querySelector('.pal-lb').innerHTML = `⚠ ${esc(v.label)} — Enter potvrdí`;
      row.querySelector('.pal-gr').textContent = 'ESC ZRUŠÍ';
    }
    return;
  }
  closePal();
  v.run();
}

export function openPal() {
  items = buildItems(); // lazy rebuild — catalog/previews/drawery dle živého S
  input.value = '';
  sel = 0; armed = -1;
  render();
  pal.classList.add('open');
  pal.setAttribute('aria-hidden', 'false');
  input.focus();
}
export function closePal() {
  armed = -1;
  pal.classList.remove('open');
  pal.setAttribute('aria-hidden', 'true');
  input.blur();
}
export function togglePal() { isPalOpen() ? closePal() : openPal(); }

export function initPalette() {
  pal = $('#pal');
  pal.innerHTML = `
  <div class="pal-box" role="dialog" aria-label="Příkazová paleta">
    <div class="pal-in"><span class="pal-mark">⌘</span>
      <input id="palInput" type="text" placeholder="panel, terminál, restart, dotaz pro Jarvise…"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      <span class="pal-hint">↑↓ · ENTER</span></div>
    <div class="pal-list" id="palList"></div>
  </div>`;
  pal.removeAttribute('hidden');
  pal.setAttribute('aria-hidden', 'true');
  input = $('#palInput');
  list = $('#palList');

  input.addEventListener('input', () => { sel = 0; render(); });
  pal.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(sel - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); runSel(); }
    else if (e.key === 'Escape' && armed >= 0) { e.preventDefault(); e.stopPropagation(); setSel(sel); input.focus(); } // jen odzbrojit
  });
  list.addEventListener('mousemove', (e) => {
    const i = e.target.closest('.pal-it')?.dataset.i;
    if (i != null && Number(i) !== sel) setSel(Number(i));
  });
  list.addEventListener('click', (e) => {
    const i = e.target.closest('.pal-it')?.dataset.i;
    if (i == null) return;
    setSel(Number(i)); // klik na neoznačený danger řádek -> nejdřív vybrat
    runSel();
  });
  pal.addEventListener('pointerdown', (e) => { if (e.target === pal) closePal(); }); // klik do backdropu

  // Ctrl/Cmd+K kdykoliv (i nad drawerem/terminálem); Esc-chain: paleta first
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); togglePal(); }
  });
  pushEsc({ isOpen: isPalOpen, close: closePal }, true);
  $('#palBtn').addEventListener('click', togglePal);
}
