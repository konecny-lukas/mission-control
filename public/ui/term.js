/* MC v2 — terminálový stack. VERBATIM port z public/app.js:832–1182:
   termSessions/nextSid, renameTerm/killTerm, openTermSession/renderTerm,
   sendTermKey/sendTermType/termScroll, wheel/touch coalescing + injectTermWheel,
   keybar, termProjects, openTermDrawer. Všechny .term-* třídy zachovány
   (mobilní CSS portováno 1:1). ttyd iframe kontrakt: /term/?arg=<key>&arg=<sid>.
   Jediné adaptace: fetchStatus -> kick() (net.js), drawer DOM -> openDrawer
   infra ('term' drawer s opts {key,label}), toast typy. */

import { $, esc, toast } from '../core/dom.js';
import { S } from '../core/store.js';
import { kick } from '../core/net.js';
import { registerDrawer, openDrawer } from './drawer.js';

// drawer id -> term key (projektové drawery s vloženým terminálem) — bez configu žádné
export const TERMKEY = {};

// Terminálové projekty — jediný zdroj pravdy je server (CFG.terminals.projects
// z config.js), promítnutý do state.catalog.termProjects (jen key+label — dir
// zůstává serverové tajemství). Funkce, ne konstantní pole: S je mutovaný
// singleton naplněný AŽ prvním /api/status snapshotem, který přijde po tom, co
// se tenhle modul naimportuje — pevné pole by tak zůstalo navždy prázdné.
export const termProjects = () => S.catalog?.termProjects || [];

// Which session iframe is currently shown in the drawer (per project key).
let termView = { key: null, sid: null };

// Live sessions for a project key, sorted by session number.
export const termSessions = (key) => (S?.term?.sessions || []).filter((s) => s.key === key && s.sid != null).sort((a, b) => a.sid - b.sid);
const nextSid = (key) => { const ss = termSessions(key); return ss.length ? Math.max(...ss.map((s) => s.sid)) + 1 : 1; };

// Terminal work-state: drives the LED colour — green=pracuje, červená=čeká, šedá=spící.
export const TERM_WORK_LABEL = { working: 'pracuje', waiting: 'čeká na tvůj vstup', dormant: 'hotovo · nečinný' };
export const aggTermWork = (ss) => ss.some((s) => s.work === 'waiting') ? 'waiting'
  : ss.some((s) => s.work === 'working') ? 'working' : 'dormant';
// Display name for a session: the user's custom label (@mc_label), else "#<sid>".
const termLabel = (s) => (s && s.label) ? s.label : `#${s?.sid}`;

// Prompt for a custom name and persist it on the session (@mc_label) via the server.
// Empty input clears the name (back to #<sid>). Returns true if the state changed.
async function renameTerm(key, sid) {
  if (key == null || sid == null) return false;
  const cur = termSessions(key).find((s) => s.sid === sid);
  const name = prompt(`Pojmenuj terminál (prázdné = zpět na #${sid}):`, cur?.label || '');
  if (name == null) return false; // dialog cancelled
  const label = name.trim().slice(0, 40);
  if ((cur?.label || '') === label) return false; // no change
  try {
    const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'term.rename', target: key, sid, label }) }).then((x) => x.json());
    toast(r.ok ? `✓ ${r.action || 'přejmenováno'}` : `✕ ${r.error || 'chyba'}`, r.ok ? 'ok' : 'err');
    if (!r.ok) return false;
    const s = (S?.term?.sessions || []).find((x) => x.key === key && x.sid === sid); // optimistic
    if (s) s.label = r.label || null;
    setTimeout(kick, 1500);
    return true;
  } catch (e) { toast('✕ ' + e.message, 'err'); return false; }
}

// Kill one session (mc-<key>-<sid>) via the allowlisted server action. Idempotent.
async function killTerm(key, sid, btn) {
  const cur = termSessions(key).find((s) => s.sid === sid);
  const nm = cur?.label ? `„${cur.label}"` : (sid != null ? '#' + sid : `„${key}"`);
  if (!confirm(`Ukončit terminál ${nm}? Běžící Claude se zruší.`)) return false;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const body = { type: 'term.kill', target: key };
    if (sid != null) body.sid = sid;
    const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    toast(j.ok ? `✓ ${j.action || 'ukončeno'}` : `✕ ${j.error || 'chyba'}`, j.ok ? 'ok' : 'err');
    if (S?.term?.sessions) S.term.sessions = S.term.sessions.filter((s) => !(s.key === key && s.sid === sid)); // optimistic
    if (S?.term && !termSessions(key).length && S.term.keys) S.term.keys = S.term.keys.filter((k) => k !== key);
    setTimeout(kick, 1500);
    return j.ok;
  } catch (e) { toast('✕ ' + e.message, 'err'); return false; }
}

// Select (attach to / create) a session and show it in the drawer.
function openTermSession(key, sid, isNew) {
  termView = { key, sid };
  if (isNew && S?.term) { // optimistic: show in the tab bar before the next poll
    S.term.sessions = S.term.sessions || [];
    if (!S.term.sessions.some((s) => s.key === key && s.sid === sid)) S.term.sessions.push({ name: `mc-${key}-${sid}`, key, sid, attached: true, lastActivity: Date.now() });
    if (S.term.keys && !S.term.keys.includes(key)) S.term.keys.push(key);
  }
  renderTerm(key);
}

export function renderTerm(key) {
  const w = $('#termWrap'); if (!w) return;
  const sessions = termSessions(key);
  const tabs = sessions.map((s) => {
    const active = termView.key === key && termView.sid === s.sid;
    const work = s.work || 'dormant';
    const tip = `${TERM_WORK_LABEL[work]} · ${s.attached ? 'právě připojeno' : 'běží na pozadí'}${s.label ? ' · #' + s.sid : ''}`;
    return `<button class="term-tab${active ? ' active' : ''}" data-sid="${s.sid}" title="${tip}">
      <span class="led work-${work}"></span><span class="lbl">${esc(termLabel(s))}</span><span class="ren" data-ren="${s.sid}" title="přejmenovat terminál">✎</span><span class="x" data-kill="${s.sid}" title="ukončit terminál">✕</span></button>`;
  }).join('');
  const addBtn = `<button class="term-tab add" id="termAdd" title="nová nezávislá session">✚&nbsp;nová</button>`;

  let view;
  if (termView.key === key && termView.sid != null) {
    const src = `/term/?arg=${encodeURIComponent(key)}&arg=${termView.sid}`;
    const curName = esc(termLabel(sessions.find((s) => s.sid === termView.sid) || { sid: termView.sid }));
    view = `<div class="btn-row" style="margin-top:10px">
        <button class="btn sm" id="termUp" title="Posun výš v historii konverzace (nebo táhni prstem dolů v terminálu)">▲ Číst výš</button>
        <button class="btn sm" id="termDown" title="O kus níž">▼ Níž</button>
        <button class="btn sm" id="termLive" title="Skok zpět na živý řádek (ukončí prohlížení historie)">⤓ Live</button>
        <button class="btn sm" id="termTall">⤢ Výška</button>
        <button class="btn sm" id="termRename" title="Pojmenovat tenhle terminál">✎ Přejmenovat</button>
        <a class="btn btn-link sm" href="${src}" target="_blank" rel="noopener">⤤ Nové okno</a>
        <button class="btn sm danger" id="termKill">⏻ Ukončit ${curName}</button>
      </div>
      <iframe class="term-frame" id="termFrame" src="${src}"></iframe>
      <div class="term-keybar" id="termKeybar">
        <div class="tk-row">
          <button class="tk" data-key="Escape" title="Esc — zruš / zavři menu">Esc</button>
          <button class="tk" data-key="C-c" title="Ctrl-C — přeruš běžící akci">^C</button>
          <button class="tk" data-key="Tab" title="Tab">⇥</button>
          <button class="tk" data-key="BTab" title="Shift-Tab — přepíná režim Claude (plán / auto)">⇧⇥</button>
          <button class="tk" data-key="Left" title="vlevo">←</button>
          <button class="tk" data-key="Up" title="nahoru — výběr v menu">↑</button>
          <button class="tk" data-key="Down" title="dolů — výběr v menu">↓</button>
          <button class="tk" data-key="Right" title="vpravo">→</button>
          <button class="tk tk-enter" data-key="Enter" title="Enter — potvrď výběr / odešli">⏎</button>
        </div>
        <div class="tk-type">
          <input class="tk-input" id="termType" type="text" inputmode="text" autocomplete="off"
            autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send"
            placeholder="napiš Claudovi (Enter odešle) — nebo číslo volby…">
          <button class="tk tk-send" id="termSend" title="Odeslat řádek + Enter">➤</button>
        </div>
      </div>
      <div class="note"><b>Číst výš v konverzaci:</b> táhni prstem <b>dolů</b> přímo v terminálu (nebo tlačítko ▲ Číst výš); tah nahoru / ⤓ Live tě vrátí k živému řádku. <b>Šipky ↑/↓ na liště NEscrollují</b> — ty posílají pohyb do Claudova menu (⏎ potvrdí volbu, Esc/^C zruší). Do políčka napiš text nebo číslo volby a ➤ odešle (bez boje se systémovou klávesnicí). Zavřením panelu se jen odpojíš, session běží dál.</div>`;
  } else if (sessions.length) {
    view = `<div class="note">Klikni na session nahoře pro připojení, nebo spusť „✚ nová".</div>`;
  } else {
    view = `<div class="btn-row"><button class="btn" id="termStart">⌁ Spustit terminál</button></div>
      <div class="note">Spustí Claude Code v adresáři projektu „${key}" v perzistentní session — přežije zavření okna i prohlížeče. Můžeš mít víc nezávislých sessions a přepínat mezi nimi. (--dangerously-skip-permissions, jen tailnet)</div>`;
  }
  w.innerHTML = `<div class="term-tabs">${tabs}${addBtn}</div>${view}`;

  w.querySelectorAll('.term-tab[data-sid]').forEach((b) => b.addEventListener('click', (e) => {
    if (e.target.closest('[data-kill]') || e.target.closest('[data-ren]')) return;
    openTermSession(key, Number(b.dataset.sid));
  }));
  w.querySelectorAll('[data-ren]').forEach((p) => p.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (await renameTerm(key, Number(p.dataset.ren))) renderTerm(key);
  }));
  w.querySelectorAll('[data-kill]').forEach((x) => x.addEventListener('click', async (e) => {
    e.stopPropagation();
    const sid = Number(x.dataset.kill);
    if (await killTerm(key, sid, x)) {
      if (termView.key === key && termView.sid === sid) termView = { key: null, sid: null };
      renderTerm(key);
    }
  }));
  const onAdd = () => openTermSession(key, nextSid(key), true);
  $('#termAdd')?.addEventListener('click', onAdd);
  $('#termStart')?.addEventListener('click', onAdd);
  $('#termTall')?.addEventListener('click', () => $('#termFrame').classList.toggle('tall'));
  $('#termRename')?.addEventListener('click', async () => { if (await renameTerm(key, termView.sid)) renderTerm(key); });
  $('#termUp')?.addEventListener('click', () => termScroll(key, termView.sid, 'up', 12));
  $('#termDown')?.addEventListener('click', () => termScroll(key, termView.sid, 'down', 12));
  $('#termLive')?.addEventListener('click', () => termScroll(key, termView.sid, 'bottom', 0));
  $('#termKill')?.addEventListener('click', async (e) => { if (await killTerm(key, termView.sid, e.currentTarget)) { termView = { key: null, sid: null }; renderTerm(key); } });
  // touch keybar: each tap sends one named key into the tmux session (server-side).
  w.querySelectorAll('.tk[data-key]').forEach((b) => b.addEventListener('click', () => {
    sendTermKey(key, termView.sid, b.dataset.key);
    flashKey(b);
  }));
  // type a whole line (+Enter): the soft keyboard works fine on a plain <input>.
  const typeEl = $('#termType'), sendTyped = () => {
    if (!typeEl.value.length) return; // bare Enter is the ⏎ button's job
    sendTermType(key, termView.sid, typeEl.value, true);
    typeEl.value = ''; typeEl.focus();
  };
  $('#termSend')?.addEventListener('click', sendTyped);
  typeEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendTyped(); } });
  injectTermWheel($('#termFrame'));
}

// brief visual ack on a keybar button press
function flashKey(b) { b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 130); }

// Send one allowlisted named key (Up/Enter/Escape/C-c…) into a session via tmux send-keys.
function sendTermKey(key, sid, name) {
  if (key == null || sid == null || !name) return Promise.resolve();
  return fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'term.keys', target: key, sid, key: name }) }).catch(() => {});
}
// Send a literal line of text; enter=true appends Enter (submit the line to Claude).
function sendTermType(key, sid, text, enter) {
  if (key == null || sid == null) return Promise.resolve();
  return fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'term.keys', target: key, sid, text: String(text), enter: !!enter }) }).catch(() => {});
}

// Fire-and-forget copy-mode scroll on the server (the only place the persistent
// history lives). Direction up|down|bottom; `lines` is the wheel-accumulated count.
function termScroll(key, sid, dir, lines) {
  if (key == null || sid == null) return Promise.resolve();
  return fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'term.scroll', target: key, sid, dir, lines }) }).catch(() => {});
}

// Wheel -> copy-mode scroll on the *currently shown* session. Coalesced: one
// request in flight, fast spins accumulate. + = down(live), - = up(history).
let termWheelPending = 0, termWheelBusy = false;
function termWheelFlush() {
  if (termWheelBusy || !termWheelPending || termView.key == null || termView.sid == null) return;
  const dir = termWheelPending < 0 ? 'up' : 'down';
  const n = Math.min(80, Math.max(1, Math.round(Math.abs(termWheelPending))));
  termWheelPending = 0; termWheelBusy = true;
  termScroll(termView.key, termView.sid, dir, n).finally(() => { termWheelBusy = false; termWheelFlush(); });
}
// Global so the injected (iframe-realm) script below can reach it across frames.
window.__mcTermWheel = (deltaY, deltaMode) => {
  // normalise wheel units: 0=pixel/trackpad, 1=line, 2=page
  termWheelPending += deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1) / 24;
  termWheelFlush();
};

// xterm.js in the /term iframe doesn't scroll tmux on the wheel; we inject a
// <script> that runs in the iframe's OWN realm and forwards WHEEL deltas
// (desktop) and vertical TOUCH-DRAG (mobile) to our parent handler. Touch is
// captured + stopped so it never reaches xterm as a mouse event. A parent-realm
// capture listener mirrors both as a fallback; dedup on e.__mcSeen.
function injectTermWheel(frame) {
  if (!frame) return;
  const wire = () => {
    let doc; try { doc = frame.contentDocument; } catch { return; } // cross-origin guard
    if (!doc || doc.__mcWheel) return;                              // keyed per document
    doc.__mcWheel = true;
    const onWheel = (e) => {
      if (e.__mcSeen) return; e.__mcSeen = true;
      e.preventDefault(); e.stopPropagation();
      window.__mcTermWheel(e.deltaY, e.deltaMode);
    };
    doc.addEventListener('wheel', onWheel, { capture: true, passive: false }); // parent-realm fallback
    let ly = null; // parent-realm touch fallback (last finger Y)
    doc.addEventListener('touchstart', (e) => { if (e.touches.length === 1) ly = e.touches[0].clientY; }, { capture: true, passive: true });
    doc.addEventListener('touchmove', (e) => {
      if (ly == null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY, dy = y - ly; ly = y;
      if (e.cancelable) e.preventDefault(); e.stopPropagation();
      window.__mcTermWheel(-dy * 1.4, 0); // drag down (dy>0) -> scroll up into history
    }, { capture: true, passive: false });
    doc.addEventListener('touchend', () => { ly = null; }, { capture: true, passive: true });
    try { // iframe-realm listener (robust on Safari): callback lives where the event fires
      const s = doc.createElement('script');
      s.textContent = "(function(){try{var b=parent.__mcTermWheel;if(!b)return;"
        + "window.addEventListener('wheel',function(e){if(e.__mcSeen)return;e.__mcSeen=true;e.preventDefault();e.stopPropagation();b(e.deltaY,e.deltaMode);},{capture:true,passive:false});"
        + "var ly=null;"
        + "window.addEventListener('touchstart',function(e){if(e.touches.length===1)ly=e.touches[0].clientY;},{capture:true,passive:true});"
        + "window.addEventListener('touchmove',function(e){if(ly==null||e.touches.length!==1)return;var y=e.touches[0].clientY,dy=y-ly;ly=y;if(e.cancelable)e.preventDefault();e.stopPropagation();b(-dy*1.4,0);},{capture:true,passive:false});"
        + "window.addEventListener('touchend',function(){ly=null;},{capture:true,passive:true});"
        + "}catch(_){}})();";
      (doc.head || doc.documentElement).appendChild(s);
    } catch {}
  };
  frame.addEventListener('load', wire);
  // ttyd boots xterm.js after load and can reconnect (new document) later — keep
  // polling so we re-attach to each fresh document; stop once the iframe is gone.
  const iv = setInterval(() => { if (!frame.isConnected) { clearInterval(iv); return; } wire(); }, 300);
  wire();
}

// ---- napojení na drawer infra (v2) ----
// Projektové drawery (TERMKEY) volají termInit ve svém wire(); samostatný
// terminálový drawer 'term' se otevírá přes openTermDrawer(key, label, sid?).
// sid (volitelný) = rovnou se připojit ke konkrétní session (detail úkolu).
export function termInit(key, sid) {
  const ss = termSessions(key);
  termView = (sid != null && ss.some((s) => s.sid === sid)) ? { key, sid } // přímý skok na session
    : ss.length === 1 ? { key, sid: ss[0].sid } : { key: null, sid: null }; // single session -> auto-attach
  renderTerm(key);
}

export function openTermDrawer(key, label, sid) {
  openDrawer('term', { key, label, sid });
}

export function registerTermDrawer() {
  registerDrawer('term', {
    title: (S, o) => `${o?.label || o?.key || ''} · TERMINÁL`,
    deps: [], // statický — rebuild by reloadnul ttyd iframe
    wide: true,
    term: true,
    build: () =>
      `<div class="section-h term-h">⌁ CLAUDE TERMINÁL</div><div class="term-wrap" id="termWrap"></div>`,
    wire: (body, o) => termInit(o.key, o.sid),
  });
}
