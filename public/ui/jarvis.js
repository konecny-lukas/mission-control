/* MC v2 — Jarvis konzole. VERBATIM port z public/app.js:1674–1929.
   Adaptace (jen tyto): markup se montuje do #jarvis, export {ask, open},
   Esc jde přes globální chain (viewer > drawer > jarvis) místo vlastního
   keydownu, a SSE patch s jarvisBusy=true spouští liveReattach (auto-diagnóza
   serveru se objeví v konzoli bez reloadu). Síťový kontrakt beze změny:
   POST /api/jarvis (SSE fetch-reader), /attach?from=N replay, /abort, /reset,
   /history. Bublina/tool/question renderery + SSE parser žijí ve sdíleném
   ui/console-kit.js (sdílí je thread drawer) — chování 1:1 s původní verzí. */

import { $ } from '../core/dom.js';
import { S } from '../core/store.js';
import { bus } from '../core/net.js';
import { pushEsc } from '../core/esc.js';
import { makeConsole, readSSE } from './console-kit.js';

let _ask = null, _open = null;
export function ask(text) { if (_ask) _ask(text); }
export function open() { if (_open) _open(true); }

export function initJarvis() {
  const jarvis = $('#jarvis'); if (!jarvis) return;
  jarvis.innerHTML = `
  <div class="j-head">
    <span class="j-title"><span class="j-mark">◆</span> JARVIS</span>
    <span class="j-status" id="jStatus">připraven</span>
    <span class="j-spacer"></span>
    <button class="j-btn" id="jReset" type="button" title="Nová konverzace">⟲</button>
    <button class="j-btn" id="jCollapse" type="button" title="Sbalit">▾</button>
  </div>
  <div class="j-log" id="jLog"></div>
  <form class="j-input-row" id="jForm">
    <span class="j-prompt"><span class="j-mark">◆</span></span>
    <textarea class="j-input" id="jInput" rows="1" placeholder="napiš Jarvisovi…" autocomplete="off" spellcheck="false"></textarea>
    <button class="j-send" id="jSend" type="submit" title="Odeslat (↵)">↵</button>
  </form>`;
  jarvis.removeAttribute('hidden');
  jarvis.dataset.open = 'false';

  const log = $('#jLog'), input = $('#jInput'), form = $('#jForm'), sendBtn = $('#jSend'), statusEl = $('#jStatus');
  let busy = false, controller = null, opened = false;
  let seen = 0, stopped = false; // seen: # of live events rendered this turn (drives ?from= reconnect)
  const queue = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const setStatus = (t) => { statusEl.textContent = t; };
  const setOpen = (v) => { if (v === opened) { if (v) kit.scrollDown(); return; } opened = v; jarvis.dataset.open = v ? 'true' : 'false'; if (v) kit.scrollDown(); };

  // sdílené renderery (bubble/tool/question/stream) — klik na volbu otázky
  // posílá odpověď stejnou cestou jako ruční zpráva (submit)
  const kit = makeConsole(log, { onAnswer: (val) => submit(val) });

  const doneStatus = (cost) => { setStatus(cost ? `hotovo · $${Number(cost).toFixed(3)}` : 'hotovo'); setTimeout(() => { if (!busy) setStatus('připraven'); }, 4000); };

  function handleEv(ev) {
    if (ev.type === 'text') { setStatus('odpovídá…'); kit.appendStream(ev.text); }
    else if (ev.type === 'tool') { setStatus('pracuje…'); kit.toolRow(ev.name, ev.input); }
    else if (ev.type === 'question') { kit.renderQuestion(ev.questions); }
    else if (ev.type === 'done') { kit.resetStream(); doneStatus(ev.cost); }
    else if (ev.type === 'error') { kit.resetStream(); kit.bubble('err', '⚠ ' + (ev.error || 'chyba')); setStatus('chyba'); }
    else if (ev.type === 'aborted') { kit.resetStream(); setStatus('zastaveno'); }
  }

  // parse an SSE event stream (id + data frames; ': ' keepalive comments ignored).
  // bumps `seen` per delivered event and returns true if a terminal event arrived.
  async function readEventStream(r) {
    let terminal = false;
    await readSSE(r, (evName, dataLine) => {
      if (evName === 'hb') return; // jen keepalive (Jarvis stream ho neposílá, guard zdarma)
      let evt; try { evt = JSON.parse(dataLine); } catch { return; }
      seen++;
      if (evt.type === 'done' || evt.type === 'error' || evt.type === 'aborted') terminal = true;
      handleEv(evt);
    });
    return terminal;
  }

  // Drive a live turn to completion. If the stream is cut before the turn finishes
  // the turn keeps running server-side, so we re-attach — replaying only events
  // past `seen` — until a terminal event arrives.
  async function consumeUntilDone(firstResp) {
    let r = firstResp, attempt = 0;
    for (;;) {
      let terminal = false;
      try { terminal = await readEventStream(r); } catch {}
      if (stopped || (controller && controller.signal.aborted)) { setStatus('zastaveno'); return; }
      if (terminal) return;                     // turn finished cleanly (done/error/aborted)
      setStatus('obnovuji spojení…');           // stream cut mid-turn → reconnect with backoff
      await sleep(Math.min(800 * Math.pow(1.6, attempt), 8000));
      if (stopped) { setStatus('zastaveno'); return; }
      let next;
      try { next = await fetch('/api/jarvis/attach?from=' + seen); } catch { attempt++; continue; }
      if (next.status === 204) { await resyncTail(); doneStatus(); return; } // turn ended while we were away
      if (!next.ok || !next.body) { attempt++; continue; }
      r = next; attempt = 0;                     // reconnected → reset backoff
    }
  }

  // After a reconnect finds the turn already torn down (204), make sure the last
  // assistant bubble matches the saved transcript tail.
  async function resyncTail() {
    try {
      const j = await (await fetch('/api/jarvis/history', { cache: 'no-store' })).json();
      const t = j.transcript || [], last = t[t.length - 1];
      if (last && last.role === 'assistant' && last.text) {
        if (kit.hasStream()) { kit.setStreamText(last.text); }
        else if (last.text !== kit.streamText()) kit.bubble('bot', last.text);
      }
    } catch {}
  }

  function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; }

  // ---- message queue: stack multiple Enters like a terminal; they run in order ----
  function submit(explicit) {
    const fromInput = explicit == null;
    const text = (fromInput ? input.value : explicit).trim();
    if (!text) return;
    setOpen(true);
    kit.bubble('user', text);      // show immediately, in the order they were sent
    if (fromInput) { input.value = ''; autoGrow(); }
    queue.push(text);
    if (busy) setStatus(`pracuje · ${queue.length} ve frontě`);
    pump();
  }
  function pump() { if (busy || !queue.length) return; runTurn(queue.shift()); }
  // stop the live turn server-side too and clear the queue.
  function stop() { stopped = true; queue.length = 0; fetch('/api/jarvis/abort', { method: 'POST' }).catch(() => {}); if (controller) controller.abort(); setStatus('zastaveno'); }

  async function runTurn(text) {
    busy = true; jarvis.dataset.busy = 'true'; sendBtn.textContent = '⏹';
    setStatus(queue.length ? `přemýšlí · ${queue.length} ve frontě` : 'přemýšlí…');
    kit.resetStream(); seen = 0; stopped = false;
    controller = new AbortController();
    let requeued = false;
    try {
      const r = await fetch('/api/jarvis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }), signal: controller.signal });
      if (r.status === 409) {
        // Jarvis je zaneprázdněný — zpráva NENÍ chyba, vrať ji na začátek fronty.
        queue.unshift(text); requeued = true;
        setStatus(`čekám na Jarvise${queue.length > 1 ? ` · ${queue.length} ve frontě` : ''}…`);
      } else if (!r.ok || !r.body) {
        let msg = 'nedostupné'; try { msg = (await r.json()).error || msg; } catch {}
        kit.bubble('err', '⚠ ' + msg); setStatus('chyba');
      } else {
        await consumeUntilDone(r);
      }
    } catch (e) {
      if ((e && e.name === 'AbortError') || stopped) setStatus('zastaveno');
      else {
        // The POST itself failed before we could stream — but the turn may have
        // started server-side anyway. Try to re-attach before declaring failure.
        if (!(await tryRecover())) {
          // Síťový výpadek při přepnutí jinam (Safari „Load failed"): žádná
          // trvalá chybová bublina — visibilitychange/jarvisBusy handlery se
          // po návratu samy znovu připojí.
          if (document.hidden || !navigator.onLine) setStatus('spojení přerušeno — obnovím po návratu');
          else { kit.bubble('err', '⚠ ' + (e && e.message || 'chyba spojení')); setStatus('chyba'); }
        }
      }
    } finally {
      busy = false; jarvis.dataset.busy = 'false'; sendBtn.textContent = '↵'; controller = null;
      if (requeued) setTimeout(pump, 2000);   // server byl busy → zkus frontu znovu za chvíli
      else if (queue.length) pump();
      else input.focus();
    }
  }

  // Probe for a live turn and, if one exists, drive it to completion.
  async function tryRecover() {
    try {
      const r = await fetch('/api/jarvis/attach?from=' + seen);
      if (r.status === 200 && r.body) { await consumeUntilDone(r); return true; }
    } catch {}
    return false;
  }

  // Re-attach to a turn that's still running server-side (after a reload, or after
  // returning to a backgrounded tab). `from` = events already on screen this turn.
  async function liveReattach(from) {
    if (busy) return;
    busy = true; jarvis.dataset.busy = 'true'; sendBtn.textContent = '⏹'; setStatus('pracuje…');
    if (from === 0) kit.resetStream();
    seen = from; stopped = false; controller = new AbortController();
    try {
      const r = await fetch('/api/jarvis/attach?from=' + from);
      if (r.status === 200 && r.body) await consumeUntilDone(r);
      else setStatus('připraven');
    } catch { setStatus('připraven'); }
    finally { busy = false; jarvis.dataset.busy = 'false'; sendBtn.textContent = '↵'; controller = null; if (queue.length) pump(); }
  }

  // Enter always sends/queues (terminal-style). The send button stops when busy.
  form.addEventListener('submit', (e) => { e.preventDefault(); if (busy) stop(); else submit(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  input.addEventListener('input', autoGrow);
  input.addEventListener('focus', () => setOpen(true));
  $('#jCollapse').addEventListener('click', () => setOpen(false));
  $('#jReset').addEventListener('click', async () => {
    stopped = true; queue.length = 0; if (controller) controller.abort();
    try { await fetch('/api/jarvis/reset', { method: 'POST' }); } catch {}
    kit.clear(); busy = false; jarvis.dataset.busy = 'false'; sendBtn.textContent = '↵';
    setStatus('nová konverzace'); setTimeout(() => { if (!busy) setStatus('připraven'); }, 2500);
  });

  // Esc-chain (viewer > drawer > jarvis): busy -> stop; jinak sbal konzoli
  // (pokud fokus není v inputu — tam Esc necháváme být, jako v1).
  pushEsc({
    isOpen: () => busy || (opened && document.activeElement !== input),
    close: () => { if (busy) stop(); else setOpen(false); },
  });

  // SSE patch flipne jarvisBusy=true (uživatelův turn z jiného tabu nebo
  // serverová auto-diagnóza) -> připoj se k živému streamu.
  bus.addEventListener('patch', (e) => {
    if (!(e.detail || []).includes('jarvisBusy')) return;
    if (S.jarvisBusy && !busy) liveReattach(seen);
  });

  // Returning to a backgrounded tab: if a turn is live but our stream died while
  // hidden, pick it back up from where we left off.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || busy) return;
    fetch('/api/jarvis/history', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
      if (j && j.busy && !busy) liveReattach(seen);
    }).catch(() => {});
  });

  // restore prior transcript so the conversation survives reloads
  (async () => {
    try {
      const j = await (await fetch('/api/jarvis/history', { cache: 'no-store' })).json();
      for (const m of (j.transcript || [])) {
        if (m.role === 'question') kit.renderQuestion(m.questions);
        else kit.bubble(m.role === 'user' ? 'user' : 'bot', m.text);
      }
      if ((j.transcript || []).length) kit.scrollDown();
      if (j.busy) liveReattach(0);   // turn survived our reload — re-attach and keep streaming
    } catch {}
  })();

  _ask = submit;
  _open = setOpen;
}
