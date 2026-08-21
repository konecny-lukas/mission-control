// Mission Control — alert threads (interaktivní diagnostická vlákna per výstraha).
//
// Každé vlákno = izolovaná headless Claude konverzace (model THREAD_MODEL,
// effort low) nad JEDNOU výstrahou (klíč ruleId:targetId). Vlákno SMÍ rovnou
// provádět bezpečné/vratné kroky (restart služeb z allowlistu, re-run cronu,
// oprava configu se zálohou) a PŘED nevratným zásahem se MUSÍ zeptat přes
// AskUserQuestion — v -p módu tool_use otázky ukončí tah (ověřeno: tool_result
// je error a result přijde hned), takže 'waiting' = tah skončil otázkou a
// žádný proces neběží; odpověď jde jako další tah s --resume <sessionId>.
//
// Stavový stroj vlákna:
//   queued        – ve FIFO frontě (max THREADS_MAX_CONCURRENT běží naráz;
//                   RAM gate ALERT_DIAGNOSE_MAX_MEM_PCT frontu pozdrží)
//   running       – claude tah běží (stall 4 min / absolutní cap 15 min řeší
//                   watchdog v jarvis.runJarvis; isWaiting() stall potlačí)
//   waiting       – tah skončil otázkou (AskUserQuestion) → ❓ čeká na uživatele;
//                   po 60 min bez odpovědi → stale-waiting (persistnuto)
//   stale-waiting – uspáno; další zpráva uživatele ho vzkřísí přes --resume
//   done | error | aborted – terminální (follow-up zprávou jde vlákno oživit)
//
// Vlákna jsou NEZÁVISLÁ na uživatelově Jarvis single-flightu (jarvis.runJarvis
// s opts.thread nebere lock, nesahá na JARVIS_STATE ani transcript) — sdílí
// jen RAM realitu, proto gate. Transcript + sessionId se persistují do
// data/threads/<safe-key>.json, takže vlákno přežije restart MC (resumable).
//
// Kromě alert vláken tu žijí i ÚKOLOVÁ vlákna (mctasks.js, klíč `task:<id>`):
// stejná mašinérie, jen kontext nedodává alerts.threadContext, ale volající
// (startTaskThread: vlastní prompt + cwd projektu). Úkolová vlákna SDÍLEJÍ
// FIFO frontu a souběh THREADS_MAX_CONCURRENT s alert vlákny — soutěží FIFO.
// Přechody stavů hlásí registrovaným listenerům (onStatus), aby mctasks mohl
// zrcadlit stav vlákna do stavu úkolu před každým publish.
import fs from 'node:fs';
import path from 'node:path';
import * as C from './config.js';
import * as jarvis from './jarvis.js';
import * as alerts from './alerts.js';
import * as stream from './stream.js';

const SSE_HEAD = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };

const threads = new Map(); // key -> thread (viz makeThread)
const queue = [];          // FIFO klíčů ve stavu 'queued'
let getState = null;       // () => živý server state (RAM gate + publish)
let pumpTimer = null;      // odložený pump (RAM gate)
let hbTimer = null;        // heartbeat pro attach SSE klienty

const safeKey = (key) => String(key).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
const fileFor = (key) => path.join(C.THREADS_DIR, `${safeKey(key)}.json`);

function makeThread(key, alert) {
  return {
    key, alert: alert || {},        // { text, rule, severity, link }
    cwd: null,                      // pracovní adresář claude subprocessu (úkolová vlákna; null = $HOME)
    status: 'queued',
    sessionId: null,
    events: [],                     // živý ring tahových eventů (id = index; replay pro attach)
    subs: new Set(),                // připojené SSE odpovědi
    transcript: [],                 // [{role:'user'|'assistant'|'question'|'error', text?, questions?, ts}]
    msgQueue: [],                   // zprávy čekající na tah (první = sestavený prompt)
    startedTs: 0, lastTs: 0,
    handle: null,                   // {kill} běžícího tahu
    waitTimer: null,                // waiting → stale-waiting po THREAD_WAIT_IDLE_MS
    lastLine: '',                   // poslední řádek odpovědi (chip v panelu)
    questionText: '',               // text poslední nezodpovězené otázky
    costUsd: 0,
    abortRequested: false,
  };
}

// ---------- persistence ----------
function persist(t) {
  try {
    fs.mkdirSync(C.THREADS_DIR, { recursive: true });
    fs.writeFileSync(fileFor(t.key), JSON.stringify({
      key: t.key, alert: t.alert, cwd: t.cwd, status: t.status, sessionId: t.sessionId,
      transcript: t.transcript.slice(-120), startedTs: t.startedTs, lastTs: t.lastTs,
      lastLine: t.lastLine, costUsd: t.costUsd,
    }));
  } catch (e) { console.error('[threads] persist', e.message); }
}
export function removeThreadFile(key) { try { fs.rmSync(fileFor(key), { force: true }); } catch { /* ok */ } }

// ---------- SSE plumbing (zrcadlí jarvisLive kontrakt: id = index eventu) ----------
function writeEv(res, ev, id) { try { res.write(`id: ${id}\ndata: ${JSON.stringify(ev)}\n\n`); } catch { /* sub spadne při close */ } }
function pushEvent(t, ev) {
  const id = t.events.length;
  t.events.push(ev);
  for (const r of t.subs) writeEv(r, ev, id);
}
function startHb() {
  if (hbTimer) return;
  hbTimer = setInterval(() => {
    let any = false;
    for (const t of threads.values()) {
      for (const r of t.subs) { any = true; try { r.write(`event: hb\ndata: ${Date.now()}\n\n`); } catch { /* close cleanup */ } }
    }
    if (!any) { clearInterval(hbTimer); hbTimer = null; }
  }, C.STREAM_HEARTBEAT_MS);
}

// ---------- status broadcast (chipy v panelu VÝSTRAHY jedou přes state.alerts) ----------
// Listenery (mctasks.js) se volají PŘED publish — zrcadlí stav vlákna do
// state.mctasks, takže jeden patch nese alerts i mctasks konzistentně.
const statusSubs = [];
export function onStatus(fn) { statusSubs.push(fn); }
function broadcastStatus() {
  for (const fn of statusSubs) { try { fn(); } catch (e) { console.error('[threads] onStatus', e.message); } }
  const st = getState && getState();
  if (!st || !st.alerts) return;
  try { alerts.rebuildAlerts(st); stream.publish(st); } catch (e) { console.error('[threads] broadcast', e.message); }
}

// ---------- veřejné info pro alerts.build (chip per výstraha) ----------
export function info(key) {
  const t = threads.get(key);
  if (!t) return null;
  return {
    status: t.status,
    queuePos: t.status === 'queued' ? queue.indexOf(key) + 1 : 0,
    waiting: t.status === 'waiting',
    lastLine: t.status === 'waiting' ? (t.questionText || t.lastLine) : t.lastLine,
  };
}
export function waitingCount() {
  let n = 0;
  for (const t of threads.values()) if (t.status === 'waiting') n++;
  return n;
}

// ---------- fronta + souběh ----------
const runningCount = () => [...threads.values()].filter((t) => t.status === 'running').length;

function schedulePump(ms) {
  if (pumpTimer) return;
  pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, ms);
}

function pump() {
  let started = false;
  while (queue.length && runningCount() < C.THREADS_MAX_CONCURRENT) {
    // RAM gate: claude subprocess je 200–400 MB — nad limitem fronta čeká (stav viditelný)
    const memPct = getState?.()?.system?.mem?.usedPct;
    if (memPct != null && memPct > C.ALERT_DIAGNOSE_MAX_MEM_PCT) { schedulePump(C.THREAD_PUMP_RETRY_MS); break; }
    const key = queue.shift();
    const t = threads.get(key);
    if (!t || t.status !== 'queued') continue;
    const msg = t.msgQueue.shift();
    if (!msg) { t.status = 'error'; t.lastLine = 'interní chyba: prázdná fronta zpráv'; persist(t); continue; }
    startTurn(t, msg);
    started = true;
  }
  if (started || queue.length) broadcastStatus(); // queuePos / status se změnily
}

function enqueue(t) {
  if (t.status === 'queued' && queue.includes(t.key)) return;
  t.status = 'queued';
  if (!queue.includes(t.key)) queue.push(t.key);
  broadcastStatus();
  pump();
}

// ---------- jeden tah ----------
function startTurn(t, message) {
  const now = Date.now();
  t.status = 'running';
  if (!t.startedTs) t.startedTs = now;
  t.lastTs = now;
  t.abortRequested = false;
  t.questionText = '';
  t.transcript.push({ role: 'user', text: message, ts: now });
  pushEvent(t, { type: 'user', text: message });
  persist(t);

  let turnText = '', gotQuestion = false, terminal = null, errMsg = null;
  const parts = []; // pořadí text/question segmentů v tahu — transcript pak věrně kopíruje replay
  jarvis.runJarvis(message, (ev) => {
    t.lastTs = Date.now();
    if (ev.type === 'session') { if (ev.sessionId) t.sessionId = ev.sessionId; return; } // init event → zachytit id pro --resume
    if (ev.type === 'text') {
      turnText += ev.text || '';
      const last = parts[parts.length - 1];
      if (last && last.role === 'assistant') last.text += ev.text || '';
      else parts.push({ role: 'assistant', text: ev.text || '' });
      const lines = turnText.split('\n').filter((l) => l.trim());
      t.lastLine = (lines[lines.length - 1] || '').slice(0, 140);
    } else if (ev.type === 'question') {
      gotQuestion = true;
      const questions = ev.questions || [];
      parts.push({ role: 'question', questions });
      t.questionText = (questions[0]?.question || 'otázka').slice(0, 200);
    } else if (ev.type === 'done') {
      terminal = 'done';
      if (typeof ev.cost === 'number') t.costUsd += ev.cost;
      if (ev.sessionId) t.sessionId = ev.sessionId;
    } else if (ev.type === 'error') { terminal = 'error'; errMsg = ev.error || 'chyba'; }
    else if (ev.type === 'aborted') terminal = 'aborted';
    pushEvent(t, ev);
  }, {
    model: C.THREAD_MODEL, effort: C.THREAD_EFFORT, maxMs: C.THREAD_MAX_TURN_MS, cwd: t.cwd || undefined,
    thread: { resume: t.sessionId, onHandle: (h) => { t.handle = h; }, isWaiting: () => gotQuestion },
  }).then(() => {
    t.handle = null;
    t.lastTs = Date.now();
    for (const p of parts) { if (p.role !== 'assistant' || p.text.trim()) t.transcript.push({ ...p, ts: t.lastTs }); }

    const rule = t.alert.rule || t.key;
    if (terminal === 'aborted' || t.abortRequested) {
      t.status = 'aborted'; t.msgQueue.length = 0;
      alerts.recordEvent('thread', 'info', '◼', `Vlákno ${rule}: zrušeno uživatelem`, t.alert.link || null);
    } else if (terminal === 'error') {
      t.status = 'error'; t.lastLine = (errMsg || 'chyba').slice(0, 140);
      if (!turnText) t.transcript.push({ role: 'error', text: errMsg || 'chyba', ts: t.lastTs });
      alerts.recordEvent('thread', 'warn', '⚠', `Vlákno ${rule} selhalo: ${(errMsg || 'chyba').slice(0, 200)}`, t.alert.link || null);
    } else if (gotQuestion) {
      t.status = 'waiting';
      armWaitTimer(t);
      alerts.recordEvent('thread', 'warn', '❓', `Vlákno ${rule} čeká na odpověď: ${t.questionText}`, t.alert.link || null);
    } else if (t.msgQueue.length) {
      enqueue(t); // uživatel mezitím poslal další zprávu
    } else {
      t.status = 'done';
      alerts.recordEvent('thread', 'info', '✓', `Vlákno ${rule} dokončeno: ${(t.lastLine || 'hotovo').slice(0, 200)}`, t.alert.link || null);
    }
    persist(t);
    broadcastStatus();
    pump(); // uvolněný slot → další z fronty
  });
}

function armWaitTimer(t) {
  clearTimeout(t.waitTimer);
  t.waitTimer = setTimeout(() => {
    if (t.status !== 'waiting') return;
    t.status = 'stale-waiting';
    try { t.handle?.kill(); } catch { /* normálně žádný proces neběží */ }
    persist(t);
    broadcastStatus();
    alerts.recordEvent('thread', 'info', '💤', `Vlákno ${t.alert.rule || t.key}: uspáno (bez odpovědi ${Math.round(C.THREAD_WAIT_IDLE_MS / 60000)} min) — další zpráva ho probudí`, t.alert.link || null);
  }, C.THREAD_WAIT_IDLE_MS);
}

// ---------- prompt prvního tahu (česky, kontrakt bezpečných akcí) ----------
function buildPrompt(ctx) {
  const services = Object.values(C.RESTARTABLE_SERVICES).map((s) => s.label).join(', ');
  return `Mission Control vyhlásil výstrahu (pravidlo ${ctx.rule}, klíč ${ctx.key}, severity ${ctx.severity}):
„${ctx.text}"

Relevantní výřez ze stavového snapshotu:
${ctx.excerpt}

Diagnostikuj a vyřeš. Bezpečné/vratné kroky (restart služeb z allowlistu: ${services}; opakované spuštění cronu; oprava configu se zálohou) proveď rovnou a průběžně popisuj, co děláš. Před nevratným nebo nejednoznačným zásahem se VŽDY zeptej (nástroj AskUserQuestion). Piš stručně česky.`;
}

// ---------- API: start / zpráva / abort ----------
// POST /api/alert/thread {key, message?} — bez message startuje vlákno nad
// aktivní výstrahou; s message posílá odpověď/follow-up (a křísí stale-waiting).
// Allowlist-shaped: key musí být aktivní výstraha nebo existující vlákno;
// message jde jako jediný argv element do claude (žádný shell).
export function handleMessage(key, message) {
  if (typeof key !== 'string' || !key || key.length > 200) return { ok: false, error: 'bad key' };
  let t = threads.get(key);

  if (message != null) {
    const msg = String(message).trim().slice(0, C.JARVIS_MAX_MSG);
    if (!msg) return { ok: false, error: 'prázdná zpráva' };
    if (!t) return { ok: false, error: 'vlákno neexistuje — nejdřív ho spusť' };
    clearTimeout(t.waitTimer); t.waitTimer = null;
    t.questionText = '';
    t.msgQueue.push(msg);
    if (t.status === 'running' || t.status === 'queued') {
      // tah běží/čeká ve frontě — zpráva se zpracuje hned po něm
      broadcastStatus();
      return { ok: true, status: t.status, note: 'zpráva zařazena — vlákno ji zpracuje po aktuálním tahu' };
    }
    enqueue(t); // waiting/stale-waiting/done/error/aborted → další tah s --resume
    return { ok: true, status: t.status };
  }

  // start bez zprávy
  if (t && (t.status === 'queued' || t.status === 'running' || t.status === 'waiting')) {
    return { ok: true, status: t.status, note: 'vlákno už běží' };
  }
  const ctx = alerts.threadContext(key);
  if (!ctx && !t) return { ok: false, error: 'výstraha není aktivní' };
  if (!t) {
    t = makeThread(key, { text: ctx.text, rule: ctx.rule, severity: ctx.severity, link: ctx.link });
    threads.set(key, t);
    alerts.recordEvent('thread', ctx.severity || 'info', '◆', `Vlákno spuštěno: ${ctx.text}`, ctx.link || null);
    t.msgQueue.push(buildPrompt(ctx));
  } else {
    // restart existujícího (done/error/aborted/stale-waiting) — naváže přes --resume
    t.msgQueue.push(ctx ? `Výstraha je stále aktivní: „${ctx.text}". Pokračuj v řešení.` : 'Pokračuj v řešení výstrahy.');
  }
  enqueue(t);
  return { ok: true, status: t.status, queuePos: queue.indexOf(key) + 1 };
}

// ---------- API: úkolové vlákno (volá mctasks.js) ----------
// Vlákno nad MC úkolem (klíč `task:<id>`): stejná mašinérie jako alert vlákna
// (FIFO fronta SDÍLENÁ s alert vlákny, souběh THREADS_MAX_CONCURRENT, RAM gate,
// persistence, attach SSE, AskUserQuestion → waiting), jen kontext prvního tahu
// dodává volající (prompt + cwd projektu). Follow-upy/abort jdou existující
// cestou handleMessage/abortThread (vlákno už existuje, alert kontext netřeba).
export function startTaskThread(key, opts) {
  const { title, prompt, cwd } = opts || {};
  if (typeof key !== 'string' || !key.startsWith('task:')) return { ok: false, error: 'bad task key' };
  let t = threads.get(key);
  if (t && (t.status === 'queued' || t.status === 'running' || t.status === 'waiting')) {
    return { ok: true, status: t.status, note: 'vlákno už běží' };
  }
  if (!t) {
    t = makeThread(key, { text: title || key, rule: `úkolu „${String(title || '').slice(0, 48)}"`, severity: 'info', link: null });
    t.cwd = cwd || null;
    threads.set(key, t);
    t.msgQueue.push(prompt || title || 'Pokračuj.');
    alerts.recordEvent('thread', 'info', '◆', `Vlákno úkolu spuštěno: ${title || key}`, null);
  } else {
    // terminální stav (done/error/aborted/stale-waiting) — restart naváže přes --resume
    t.cwd = cwd || t.cwd;
    t.msgQueue.push(prompt || 'Pokračuj v úkolu.');
  }
  enqueue(t);
  return { ok: true, status: t.status, queuePos: queue.indexOf(key) + 1 };
}

// Úklid vlákna odebraného úkolu (jen v terminálním/čekacím stavu — běžící ne).
export function dropThread(key) {
  const t = threads.get(key);
  if (t && (t.status === 'running' || t.status === 'queued')) return false;
  if (t) {
    clearTimeout(t.waitTimer);
    for (const r of t.subs) { try { r.end(); } catch { /* už zavřeno */ } }
    threads.delete(key);
  }
  const i = queue.indexOf(key);
  if (i >= 0) queue.splice(i, 1);
  removeThreadFile(key);
  return true;
}

export function abortThread(key) {
  const t = threads.get(key);
  if (!t) return { ok: false, error: 'vlákno neexistuje' };
  t.abortRequested = true;
  t.msgQueue.length = 0;
  clearTimeout(t.waitTimer); t.waitTimer = null;
  const i = queue.indexOf(key);
  if (i >= 0) queue.splice(i, 1);
  if (t.handle) { t.handle.kill(); return { ok: true, status: 'aborting' }; } // close handler dokončí přechod
  if (t.status === 'queued' || t.status === 'waiting' || t.status === 'stale-waiting') {
    t.status = 'aborted';
    pushEvent(t, { type: 'aborted' });
    persist(t);
    broadcastStatus();
    alerts.recordEvent('thread', 'info', '◼', `Vlákno ${t.alert.rule || key}: zrušeno uživatelem`, t.alert.link || null);
    pump();
  }
  return { ok: true, status: t.status };
}

// ---------- API: stav + attach ----------
// GET /api/alert/thread/state?key= — transcript pro restore draweru. Když má
// vlákno živé eventy v paměti (events.length > 0), klient ignoruje transcript
// a nechá si VŠE přehrát přes attach?from=0 (jediný zdroj pravdy pro běžící
// tah); transcript se použije jen po restartu MC (events prázdné).
export function stateInfo(key) {
  const t = threads.get(key);
  if (!t) return null;
  return {
    key: t.key, status: t.status, alert: t.alert, transcript: t.transcript,
    events: t.events.length, startedTs: t.startedTs, lastTs: t.lastTs,
    costUsd: t.costUsd, model: C.THREAD_MODEL,
    queuePos: t.status === 'queued' ? queue.indexOf(key) + 1 : 0,
  };
}

// GET /api/alert/thread/attach?key=&from=N — replay events[from..] + live.
// Stream zůstává otevřený přes konce tahů (vlákno může pokračovat follow-upy);
// heartbeat `event: hb` drží spojení (klient ho NEpočítá do from).
export function handleAttach(req, res) {
  let q;
  try { q = new URL(req.url, 'http://x').searchParams; } catch { q = new URLSearchParams(); }
  const key = q.get('key') || '';
  const t = threads.get(key);
  if (!t) { res.writeHead(204); return res.end(); }
  const from = Math.max(0, parseInt(q.get('from'), 10) || 0);
  res.writeHead(200, SSE_HEAD);
  res.write(`retry: ${C.STREAM_RETRY_MS}\n\n`);
  for (let i = from; i < t.events.length; i++) writeEv(res, t.events[i], i);
  t.subs.add(res);
  res.on('close', () => t.subs.delete(res));
  startHb();
}

// ---------- boot ----------
export function init(opts) {
  getState = opts?.getState || null;
  let files = [];
  try { files = fs.readdirSync(C.THREADS_DIR).filter((f) => f.endsWith('.json')); } catch { return; }
  let restored = 0;
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(C.THREADS_DIR, f), 'utf-8'));
      if (!j?.key) continue;
      const t = makeThread(j.key, j.alert);
      t.cwd = j.cwd || null;
      t.sessionId = j.sessionId || null;
      t.transcript = Array.isArray(j.transcript) ? j.transcript : [];
      t.startedTs = j.startedTs || 0; t.lastTs = j.lastTs || 0;
      t.lastLine = j.lastLine || ''; t.costUsd = j.costUsd || 0;
      // queued/running umřely s procesem MC; waiting ztratilo timer → vše
      // resumable jako stale-waiting (další zpráva naváže přes --resume)
      t.status = (j.status === 'done' || j.status === 'error' || j.status === 'aborted') ? j.status : 'stale-waiting';
      threads.set(j.key, t);
      restored++;
    } catch (e) { console.error('[threads] restore', f, e.message); }
  }
  if (restored) console.log(`[threads] restored ${restored} thread(s) from disk`);
}
