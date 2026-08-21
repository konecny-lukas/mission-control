/* MC v2 — alert thread drawer (id 'thread', opts.key). Konzole vlákna nad
   jednou výstrahou: transcript restore, SSE attach (replay ?from=N + live),
   klikací AskUserQuestion volby -> POST odpověď, input pro follow-upy, abort.
   Renderery sdílí s Jarvis konzolí (ui/console-kit.js, class-contract .j-*).

   Síťový kontrakt (zrcadlí Jarvis): GET /api/alert/thread/state?key=,
   GET /api/alert/thread/attach?key=&from=N (id=index eventu, `event: hb`
   keepalive se NEpočítá do from), POST /api/alert/thread {key, message},
   POST /api/alert/thread/abort {key}.

   Replay strategie: když má server živé eventy v paměti (state.events > 0),
   transcript se NEkreslí a vše přehraje attach?from=0 (jediný zdroj pravdy,
   vč. tool řádků běžícího tahu). Transcript kreslíme jen po restartu MC
   (events=0) — pak attach od 0 streamuje jen nové eventy.

   deps:[] — drawer infra ho NIKDY nepřestavuje (rebuild by zabil konzoli);
   stavovou hlavičku si aktualizuje sám z bus 'patch' (sekce alerts). */

import { esc, dur, usd, toast } from '../core/dom.js';
import { S } from '../core/store.js';
import { bus } from '../core/net.js';
import { registerDrawer, openDrawer } from './drawer.js';
import { makeConsole, readSSE } from './console-kit.js';

export const THREAD_STATUS = {
  queued: { cls: 'queued', label: '⏳ ve frontě' },
  running: { cls: 'running', label: '● pracuje' },
  waiting: { cls: 'waiting', label: '❓ ČEKÁ NA TEBE' },
  'stale-waiting': { cls: 'stale', label: '💤 uspáno — napiš, pokračuje' },
  done: { cls: 'done', label: '✓ hotovo' },
  error: { cls: 'error', label: '⚠ chyba' },
  aborted: { cls: 'aborted', label: '◼ zrušeno' },
};

// title (volitelný) — úkolová vlákna (klíč task:<id>) chtějí „ÚKOL — předmět"
// místo syrového klíče
export function openThreadDrawer(key, title) { openDrawer('thread', { key, title }); }

const shortKey = (key) => {
  const k = String(key || '');
  return k.length > 42 ? k.slice(0, 41) + '…' : k;
};

function build(_S, opts) {
  const key = opts?.key || '';
  return `<div class="th-head">
      <span class="th-chip big" id="thStatus">…</span>
      <span class="th-meta" id="thMeta"></span>
      <span class="j-spacer"></span>
      <button class="btn bsm danger" id="thAbort" type="button">◼ ZRUŠIT</button>
    </div>
    <div class="th-alert" id="thAlert">${esc(shortKey(key))}</div>
    <div class="th-log" id="thLog"></div>
    <form class="j-input-row th-input" id="thForm">
      <span class="j-prompt"><span class="j-mark">◆</span></span>
      <textarea class="j-input" id="thInput" rows="1" placeholder="odpověz vláknu / zadej follow-up…" autocomplete="off" spellcheck="false"></textarea>
      <button class="j-send" id="thSend" type="submit" title="Odeslat (↵)">↵</button>
    </form>`;
}

function wire(body, opts, phase) {
  if (phase !== 'open') return; // deps:[] -> patch fáze nenastává, ale pro jistotu
  const key = opts?.key || '';
  const log = body.querySelector('#thLog');
  const statusEl = body.querySelector('#thStatus');
  const metaEl = body.querySelector('#thMeta');
  const alertEl = body.querySelector('#thAlert');
  const input = body.querySelector('#thInput');
  const form = body.querySelector('#thForm');

  let seen = 0;          // eventů vykresleno (drives attach ?from=)
  let closed = false;    // drawer zavřen -> ukončit attach smyčku
  let lastState = null;  // poslední /state odpověď (cost, startedTs)
  const controller = { ac: null };

  const kit = makeConsole(log, { scroller: log, onAnswer: (val) => send(val) });

  // ---- status hlavička (z S.alerts / S.mctasks patche; fallback poslední /state) ----
  function threadInfo() {
    const a = (S.alerts?.active || []).find((x) => x.key === key);
    if (a?.thread) return a.thread;
    const t = (S.mctasks?.tasks || []).find((x) => x.threadKey === key); // úkolová vlákna
    return t?.thread || null;
  }
  function refreshHead() {
    const th = threadInfo();
    const status = th?.status || lastState?.status || '…';
    const st = THREAD_STATUS[status] || { cls: '', label: status };
    statusEl.className = `th-chip big ${st.cls}`;
    statusEl.textContent = status === 'queued' && th?.queuePos ? `⏳ fronta č.${th.queuePos}` : st.label;
    const bits = [`model ${((lastState?.model || 'sonnet')).replace('claude-', '')}`];
    if (lastState?.startedTs) bits.push(`běží ${dur(Math.round((Date.now() - lastState.startedTs) / 1000))}`);
    if (lastState?.costUsd) bits.push(usd(lastState.costUsd));
    metaEl.textContent = bits.join(' · ');
    const a = (S.alerts?.active || []).find((x) => x.key === key);
    alertEl.textContent = a?.text ? a.text : (lastState?.alert?.text || shortKey(key));
  }
  const onPatch = (e) => { if ((e.detail || []).some((k) => k === 'alerts' || k === 'mctasks')) refreshHead(); };
  bus.addEventListener('patch', onPatch);

  // ---- cleanup, jakmile drawer infra tělo vymění/vyčistí ----
  const watchdog = setInterval(() => {
    if (log.isConnected) return;
    closed = true;
    clearInterval(watchdog);
    bus.removeEventListener('patch', onPatch);
    try { controller.ac?.abort(); } catch {}
  }, 1500);

  // ---- event rendering (zrcadlí Jarvis handleEv) ----
  function handleEv(ev) {
    if (ev.type === 'user') { kit.resetStream(); kit.bubble('user', ev.text); }
    else if (ev.type === 'text') kit.appendStream(ev.text);
    else if (ev.type === 'tool') kit.toolRow(ev.name, ev.input);
    else if (ev.type === 'question') kit.renderQuestion(ev.questions);
    else if (ev.type === 'error') { kit.resetStream(); kit.bubble('err', '⚠ ' + (ev.error || 'chyba')); }
    else if (ev.type === 'done' || ev.type === 'aborted') { kit.resetStream(); refetchState(); }
  }

  async function refetchState() {
    try {
      const r = await fetch(`/api/alert/thread/state?key=${encodeURIComponent(key)}`, { cache: 'no-store' });
      if (r.ok) { lastState = await r.json(); refreshHead(); }
    } catch { /* hlavička zůstane na posledním stavu */ }
  }

  // ---- attach smyčka: drží spojení přes konce tahů, reconnect s backoffem ----
  async function attachLoop() {
    let attempt = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    while (!closed) {
      try {
        controller.ac = new AbortController();
        const r = await fetch(`/api/alert/thread/attach?key=${encodeURIComponent(key)}&from=${seen}`, { signal: controller.ac.signal });
        if (r.status === 204) { // vlákno (zatím) na serveru není — po restartu MC apod.
          await sleep(4000); attempt = 0; continue;
        }
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        attempt = 0;
        await readSSE(r, (evName, dataLine) => {
          if (evName === 'hb') return; // keepalive se nepočítá do from
          let evt; try { evt = JSON.parse(dataLine); } catch { return; }
          seen++;
          handleEv(evt);
        });
      } catch { /* spadlé spojení / abort */ }
      if (closed) return;
      await sleep(Math.min(800 * Math.pow(1.6, attempt++), 8000));
    }
  }

  // ---- odeslání odpovědi / follow-upu ----
  async function send(text) {
    const msg = String(text || '').trim();
    if (!msg) return;
    try {
      const r = await fetch('/api/alert/thread', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, message: msg }),
      });
      const j = await r.json();
      if (!j.ok) toast('✕ ' + (j.error || 'chyba'), 'err');
      // user bublina dorazí jako event 'user' přes attach (žádný optimistický
      // duplikát); u zařazené zprávy to chvíli trvá — naznač stavem
      else if (j.note) toast('⏳ ' + j.note);
    } catch (e) { toast('✕ ' + e.message, 'err'); }
  }

  function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; }
  form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value; input.value = ''; autoGrow(); send(v); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = input.value; input.value = ''; autoGrow(); send(v); } });
  input.addEventListener('input', autoGrow);

  body.querySelector('#thAbort').addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await fetch('/api/alert/thread/abort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      const j = await r.json();
      toast(j.ok ? '◼ vlákno zrušeno' : '✕ ' + (j.error || 'chyba'), j.ok ? 'ok' : 'err');
    } catch (err) { toast('✕ ' + err.message, 'err'); }
    finally { b.disabled = false; }
  });

  // ---- start: state -> transcript restore / plný replay přes attach ----
  (async () => {
    try {
      const r = await fetch(`/api/alert/thread/state?key=${encodeURIComponent(key)}`, { cache: 'no-store' });
      if (r.status === 404) { kit.bubble('err', '⚠ Vlákno zatím neexistuje — spusť ho z panelu VÝSTRAHY (◆).'); refreshHead(); return; }
      lastState = await r.json();
      refreshHead();
      if (!lastState.events && (lastState.transcript || []).length) {
        // restart MC: živé eventy pryč -> nakresli persistnutý transcript
        for (const m of lastState.transcript) {
          if (m.role === 'question') kit.renderQuestion(m.questions);
          else if (m.role === 'error') kit.bubble('err', '⚠ ' + (m.text || 'chyba'));
          else kit.bubble(m.role === 'user' ? 'user' : 'bot', m.text);
        }
        kit.scrollDown();
      }
      attachLoop(); // events>0: replay from=0 nakreslí vše; events=0: jen živé
    } catch (e) {
      kit.bubble('err', '⚠ ' + e.message);
    }
  })();
}

export function initThread() {
  registerDrawer('thread', {
    title: (_S, opts) => opts?.title || `VLÁKNO · ${shortKey(opts?.key)}`,
    wide: true, thread: true, deps: [], build, wire,
  });
}
