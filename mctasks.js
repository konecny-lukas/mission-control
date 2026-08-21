// Mission Control — fronta uživatelských úkolů (panel ÚKOLY · sekce FRONTA).
//
// Úkol: { id, subject (1 řádek), detail (volitelný, multiline), project (klíč
// C.MCTASK_PROJECTS → cwd), createdTs, status, mode?, threadKey?, termSession?,
// startedTs?, doneTs?, note? }
//
// Stavový stroj úkolu:
//   queued  – ve frontě: BUĎ ještě nespuštěn (mode null → tlačítka ▶/⌨/✕),
//             NEBO spuštěn jako vlákno a čeká na volný slot (mode 'thread')
//   running – vlákno pracuje / tmux session žije
//   waiting – vlákno se zeptalo (AskUserQuestion) nebo bylo uspáno (stale-waiting)
//             → ❓ čeká na uživatele (vstup přes thread drawer)
//   done | error | aborted – terminální; done/error/aborted jdou odebrat (✕)
//
// Spuštění (volba per start, mode 'thread' | 'term'):
//  • VLÁKNO — threads.startTaskThread('task:<id>') = TATÁŽ mašinérie jako alert
//    vlákna: FIFO fronta a souběh THREADS_MAX_CONCURRENT (=2) SDÍLENÉ s alert
//    vlákny (úkolová a alert vlákna soutěží FIFO), RAM gate, persistence
//    data/threads/, attach SSE, AskUserQuestion → waiting. Stejný kontrakt
//    bezpečných akcí jako alert vlákna (viz buildTaskPrompt). Stav vlákna se
//    zrcadlí do stavu úkolu přes threads.onStatus (volá se před každým publish).
//  • TERMINÁL — server vytvoří tmux session mc-<key>-<sid> stejným kontraktem
//    jako mc-claude.sh (MC_INNER=1 → exec claude v adresáři projektu), nastaví
//    @mc_label na předmět úkolu, počká na claude prompt (capture-pane sonda na
//    footer „bypass permissions on", timeout MCTASK_TERM_READY_MS) a vloží
//    zadání (set-buffer + paste-buffer -p kvůli víceřádkovému detailu) + Enter.
//    Stav: running dokud session žije; HOTOVO je RUČNÍ (mctask.done — práce
//    v terminálu nemá strojově detekovatelný konec). Zmizí-li session bez ✓
//    (2 po sobě jdoucí měření fastRefresh), úkol spadne do aborted.
//    Cgroup pojistka: pokud tmux server na socketu `mc` neběží, session se
//    vytváří přes `systemd-run --user --scope`, aby nově spawnutý tmux server
//    NEskončil v cgroupě mission-control.service (incident 2026-06-10 20:36 —
//    restart služby by jinak zabil všechny uživatelské sessions).
//
// Persistence: data/mctasks.json (přežije restart MC). Po restartu se vlákna
// křísí jako stale-waiting (threads.init) → úkol waiting (resumable follow-up
// zprávou); vlákno, které restart nepřežilo (queued bez persistnutého tahu),
// se vrátí do nespuštěného queued. Terminálové úkoly žijí v tmuxu nezávisle.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import * as C from './config.js';
import * as threads from './threads.js';
import * as alerts from './alerts.js';
import * as stream from './stream.js';

let tasks = [];        // živý seznam (persistovaný 1:1)
let seq = 1;           // monotónní id čítač
let getState = null;   // () => živý server state (publish po změnách)
const termMiss = new Map(); // id -> po sobě jdoucí měření bez živé tmux session

const threadKeyOf = (t) => `task:${t.id}`;
const TH2TASK = { queued: 'queued', running: 'running', waiting: 'waiting', 'stale-waiting': 'waiting', done: 'done', error: 'error', aborted: 'aborted' };
const TERMINAL = new Set(['done', 'error', 'aborted']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- persistence ----------
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(C.MCTASKS_FILE, 'utf-8'));
    tasks = Array.isArray(j.tasks) ? j.tasks : [];
    seq = Number(j.seq) || 1;
  } catch { tasks = []; seq = 1; }
}
function persist() {
  try {
    fs.mkdirSync(C.DATA_DIR, { recursive: true });
    fs.writeFileSync(C.MCTASKS_FILE, JSON.stringify({ seq, tasks }));
  } catch (e) { console.error('[mctasks] persist', e.message); }
}

// ---------- snapshot sekce (state.mctasks) ----------
// Vrací VŽDY čerstvý objekt — stream.publish ho string-compare dedupne, takže
// beze změny obsahu se patch neposílá. `term` (volitelně) = živý výstup
// collectTermSessions pro liveness check terminálových úkolů.
export function collect(term) {
  checkTermLiveness(term);
  const out = tasks.map((t) => ({
    id: t.id, subject: t.subject, detail: t.detail || '', project: t.project,
    createdTs: t.createdTs, status: t.status, mode: t.mode || null,
    threadKey: t.mode === 'thread' ? threadKeyOf(t) : null,
    termSession: t.termSession || null,
    thread: t.mode === 'thread' ? threads.info(threadKeyOf(t)) : null, // {status,queuePos,waiting,lastLine}
    startedTs: t.startedTs || 0, doneTs: t.doneTs || 0, note: t.note || null,
  }));
  return {
    tasks: out,
    open: tasks.filter((t) => !TERMINAL.has(t.status)).length,
    waiting: tasks.filter((t) => t.status === 'waiting').length,
  };
}

// Aktualizace state.mctasks + okamžitý publish (po akcích / async přechodech).
function touchState(publish = true) {
  const s = getState && getState();
  if (!s) return;
  s.mctasks = collect(s.term);
  if (publish) { try { stream.publish(s); } catch (e) { console.error('[mctasks] publish', e.message); } }
}

// ---------- zrcadlení stavu vláken (threads.onStatus, volá se PŘED publish) ----------
function syncFromThreads() {
  let changed = false;
  for (const t of tasks) {
    if (t.mode !== 'thread') continue;
    const info = threads.info(threadKeyOf(t));
    if (!info) continue;
    const st = TH2TASK[info.status] || t.status;
    if (st !== t.status) {
      t.status = st;
      if (TERMINAL.has(st)) t.doneTs = Date.now();
      changed = true;
    }
  }
  if (changed) { persist(); touchState(false); } // publish udělá broadcastStatus hned po listenerech
}

// ---------- liveness terminálových úkolů ----------
// Running term úkol bez živé session (2 měření po sobě, s 90s gracem po startu,
// než se session objeví v kolektoru) → aborted. Selhání tmux dotazu vrací
// prázdný seznam — proto 2 po sobě jdoucí měření, ne jedno.
function checkTermLiveness(term) {
  if (!term || !Array.isArray(term.sessions)) return;
  let changed = false;
  for (const t of tasks) {
    if (t.mode !== 'term' || t.status !== 'running' || !t.termSession) continue;
    const live = term.sessions.some((s) => s.key === t.termSession.key && s.sid === t.termSession.sid);
    if (live) { termMiss.delete(t.id); continue; }
    if ((t.startedTs || 0) > Date.now() - 90_000) continue;
    const n = (termMiss.get(t.id) || 0) + 1;
    termMiss.set(t.id, n);
    if (n >= 2) {
      t.status = 'aborted';
      t.doneTs = Date.now();
      t.note = 'tmux session skončila bez označení hotovo';
      termMiss.delete(t.id);
      changed = true;
      alerts.recordEvent('mctask', 'info', '◼', `Úkol „${t.subject}": terminálová session skončila bez ✓`, null);
    }
  }
  if (changed) persist();
}

// ---------- prompt prvního tahu vlákna (kontrakt bezpečných akcí = alert vlákna) ----------
function buildTaskPrompt(t, proj) {
  const services = Object.values(C.RESTARTABLE_SERVICES).map((s) => s.label).join(', ');
  return `Mission Control — úkol z fronty úkolů (projekt ${proj.label}, adresář ${proj.dir}):
„${t.subject}"
${t.detail ? `\nDetail zadání:\n${t.detail}\n` : ''}
Pracuj na zadaném úkolu v adresáři projektu. Bezpečné/vratné kroky (restart služeb z allowlistu: ${services}; opakované spuštění cronu; oprava configu se zálohou) proveď rovnou a průběžně popisuj, co děláš. Před nevratným nebo nejednoznačným zásahem se VŽDY zeptej (nástroj AskUserQuestion). Na konci stručně shrň výsledek. Piš stručně česky.`;
}

// ---------- tmux helpers (vše execFile s pevným argv — žádný shell) ----------
function tmuxP(args, timeout = 10000) {
  return new Promise((res) => {
    execFile(C.TERM_TMUX_BIN, ['-L', C.TERM_TMUX_SOCKET, ...args],
      { timeout, env: { ...process.env, HOME: C.HOME } },
      (err, so, se) => res({ ok: !err, out: String(so || ''), err: String(se || so || (err && err.message) || '') }));
  });
}

async function nextSid(key) {
  const r = await tmuxP(['list-sessions', '-F', '#{session_name}'], 2500);
  if (!r.ok) return { sid: 1, serverUp: false }; // žádný server = žádné sessions
  let max = 0;
  for (const nm of r.out.split('\n')) {
    if (!nm.startsWith(`${C.TERM_SESSION_PREFIX}${key}-`)) continue;
    const sid = Number(nm.slice(`${C.TERM_SESSION_PREFIX}${key}-`.length));
    if (Number.isFinite(sid) && sid > max) max = sid;
  }
  return { sid: max + 1, serverUp: true };
}

// Vytvoří detached session stejným kontraktem jako ttyd cesta (mc-claude.sh
// outer): MC_INNER=1 → inner větev execne claude v adresáři projektu. Když tmux
// server neběží, jde to přes systemd-run --user --scope (cgroup pojistka, viz
// hlavička modulu).
function createSession(key, sid, dir, serverUp) {
  const sess = `${C.TERM_SESSION_PREFIX}${key}-${sid}`;
  const script = path.join(C.MC_DIR, 'mc-claude.sh');
  const tmuxArgv = [C.TERM_TMUX_BIN, '-L', C.TERM_TMUX_SOCKET, '-f', C.TERM_TMUX_CONF,
    'new-session', '-d', '-s', sess, '-e', 'MC_INNER=1', '-c', dir, script, key, String(sid)];
  const argv = serverUp ? tmuxArgv : ['systemd-run', '--user', '--scope', '--collect', '--quiet', '--', ...tmuxArgv];
  return new Promise((res) => {
    execFile(argv[0], argv.slice(1), { timeout: 15000, env: { ...process.env, HOME: C.HOME } },
      (err, so, se) => res({ ok: !err, err: String(se || so || (err && err.message) || '').slice(0, 300) }));
  });
}

// Sanitizace labelu — STEJNÁ pravidla jako server.js term.rename (taby/nl by
// rozbily list-sessions -F parsing, #{} by re-expandoval tmux format engine).
const labelOf = (subject) => String(subject || '').replace(/[\t\n\r#{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

// Po vytvoření session: počkat na claude prompt a vložit zadání. Fire-and-forget
// (HTTP odpověď na mctask.start nečeká) — výsledek jde do timeline + task.note.
async function injectPrompt(t, sess) {
  const text = (t.subject + (t.detail ? '\n\n' + t.detail : '')).slice(0, C.MCTASK_MAX_DETAIL);
  const deadline = Date.now() + C.MCTASK_TERM_READY_MS;
  let trusted = false;
  while (Date.now() < deadline) {
    const cap = await tmuxP(['capture-pane', '-p', '-t', sess], 4000);
    // První spuštění claude v adresáři ukáže trust dialog („Is this a project
    // you created…? ❯ 1. Yes, I trust this folder") PŘED input promptem —
    // potvrdíme Enterem (výchozí volba 1). Bezpečné: MCTASK_PROJECTS jsou
    // výhradně adresáře vlastníka boxu, stejné, které by potvrdil v ttyd.
    if (cap.ok && !trusted && /Is this a project you created|I trust this folder/i.test(cap.out)) {
      trusted = true;
      await tmuxP(['send-keys', '-t', sess, 'Enter']);
      await sleep(1200);
      continue;
    }
    // footer „⏵⏵ bypass permissions on" = idle input prompt Claude TUI
    // (stejný signál jako classifyTermWork v collectors.js)
    if (cap.ok && /bypass permissions on/i.test(cap.out)) {
      const sb = await tmuxP(['set-buffer', '-b', 'mctask', '--', text]);
      if (sb.ok) {
        await tmuxP(['paste-buffer', '-p', '-d', '-b', 'mctask', '-t', sess]); // -p = bracketed paste (víceřádkový detail nesubmitne předčasně)
        await sleep(400);
        await tmuxP(['send-keys', '-t', sess, 'Enter']);
        alerts.recordEvent('mctask', 'info', '⌨', `Úkol „${t.subject}": zadání vloženo do terminálu ${sess}`, null);
        return;
      }
      break;
    }
    await sleep(C.MCTASK_TERM_POLL_MS);
  }
  t.note = 'zadání se nepodařilo vložit (Claude prompt se neobjevil do 60 s) — otevři terminál a zadej ručně';
  persist();
  touchState();
  alerts.recordEvent('mctask', 'warn', '⚠', `Úkol „${t.subject}": ${t.note}`, null);
}

// ---------- akce (allowlist-shaped, volá server.runAction pro type mctask.*) ----------
export function handleAction(body) {
  const type = body && body.type;
  try {
    if (type === 'mctask.add') return add(body);
    if (type === 'mctask.remove') return remove(body);
    if (type === 'mctask.start') return start(body);
    if (type === 'mctask.done') return done(body);
  } catch (e) {
    console.error('[mctasks]', type, e.message);
    return { ok: false, error: e.message };
  }
  return { ok: false, error: 'unknown mctask action' };
}

function findTask(id) { return tasks.find((t) => t.id === String(id || '')); }

function add(body) {
  const subject = String(body.subject || '').replace(/\s+/g, ' ').trim().slice(0, C.MCTASK_MAX_SUBJECT);
  if (!subject) return { ok: false, error: 'prázdný předmět úkolu' };
  const detail = String(body.detail || '').trim().slice(0, C.MCTASK_MAX_DETAIL);
  const project = String(body.project || '');
  if (!C.MCTASK_PROJECTS[project]) return { ok: false, error: 'neznámý projekt' };
  const t = { id: `t${seq++}`, subject, detail, project, createdTs: Date.now(), status: 'queued', mode: null };
  tasks.push(t);
  persist();
  touchState();
  alerts.recordEvent('mctask', 'info', '＋', `Úkol zařazen do fronty: „${subject}" (${C.MCTASK_PROJECTS[project].label})`, null);
  return { ok: true, action: 'úkol zařazen do fronty', id: t.id };
}

function remove(body) {
  const t = findTask(body.id);
  if (!t) return { ok: false, error: 'úkol neexistuje' };
  if (t.status === 'running' || t.status === 'waiting') return { ok: false, error: 'úkol právě běží/čeká — nejdřív ho dokonči nebo zruš (vlákno: ◼ v draweru)' };
  if (t.mode === 'thread') {
    // queued vlákno čekající na slot vyhodit z FIFO; terminálnímu uklidit soubor
    if (t.status === 'queued') threads.abortThread(threadKeyOf(t));
    threads.dropThread(threadKeyOf(t));
  }
  tasks = tasks.filter((x) => x.id !== t.id);
  termMiss.delete(t.id);
  persist();
  touchState();
  alerts.recordEvent('mctask', 'info', '✕', `Úkol odebrán z fronty: „${t.subject}"`, null);
  return { ok: true, action: 'úkol odebrán' };
}

function start(body) {
  const t = findTask(body.id);
  if (!t) return { ok: false, error: 'úkol neexistuje' };
  if (t.mode || t.status !== 'queued') return { ok: false, error: 'úkol už byl spuštěn' };
  const mode = body.mode === 'term' ? 'term' : body.mode === 'thread' ? 'thread' : null;
  if (!mode) return { ok: false, error: 'mode musí být thread|term' };
  const proj = C.MCTASK_PROJECTS[t.project];
  if (!proj) return { ok: false, error: 'neznámý projekt' };

  if (mode === 'thread') {
    const key = threadKeyOf(t);
    const r = threads.startTaskThread(key, { title: t.subject, prompt: buildTaskPrompt(t, proj), cwd: proj.dir });
    if (!r.ok) return r;
    t.mode = 'thread';
    t.startedTs = Date.now();
    t.status = TH2TASK[r.status] || 'queued';
    persist();
    touchState();
    return { ok: true, action: 'úkol spuštěn jako vlákno', mode, key, status: t.status };
  }

  // mode === 'term': vytvořit session + label hned (rychlé), vložení zadání
  // běží na pozadí (HTTP odpověď nečeká až 60 s na claude prompt).
  return (async () => {
    const { sid, serverUp } = await nextSid(t.project);
    const sess = `${C.TERM_SESSION_PREFIX}${t.project}-${sid}`;
    const cr = await createSession(t.project, sid, proj.dir, serverUp);
    if (!cr.ok) return { ok: false, error: `tmux session se nepodařilo vytvořit: ${cr.err}` };
    const lbl = labelOf(t.subject);
    if (lbl) await tmuxP(['set-option', '-t', sess, '@mc_label', lbl]);
    t.mode = 'term';
    t.termSession = { key: t.project, sid, name: sess };
    t.startedTs = Date.now();
    t.status = 'running';
    persist();
    touchState();
    alerts.recordEvent('mctask', 'info', '⌁', `Úkol „${t.subject}" spuštěn v terminálu ${sess}`, null);
    injectPrompt(t, sess).catch((e) => console.error('[mctasks] inject', e.message)); // fire-and-forget
    return { ok: true, action: `terminál ${sess} spuštěn — zadání se vkládá`, mode, session: { key: t.project, sid }, status: t.status };
  })();
}

// Ruční ✓ — jen terminálové úkoly (vlákno si done řídí samo přes syncFromThreads;
// práce v terminálu strojově detekovatelný konec nemá).
function done(body) {
  const t = findTask(body.id);
  if (!t) return { ok: false, error: 'úkol neexistuje' };
  if (t.mode !== 'term') return { ok: false, error: 'ruční ✓ je jen pro terminálové úkoly (vlákno se dokončí samo)' };
  if (TERMINAL.has(t.status)) return { ok: true, action: 'úkol už je uzavřený' };
  t.status = 'done';
  t.doneTs = Date.now();
  persist();
  touchState();
  alerts.recordEvent('mctask', 'info', '✓', `Úkol označen jako hotový: „${t.subject}"`, null);
  return { ok: true, action: 'úkol označen ✓ hotovo' };
}

// ---------- boot ----------
export function init(opts) {
  getState = opts?.getState || null;
  load();
  // rekonciliace po restartu: vlákna se křísí jako stale-waiting (threads.init);
  // vlákno, které se neperzistovalo (queued bez prvního tahu), se ztratilo →
  // úkol zpět do nespuštěného queued, ať jde spustit znovu.
  let changed = false;
  for (const t of tasks) {
    if (t.mode !== 'thread' || TERMINAL.has(t.status)) continue;
    const info = threads.info(threadKeyOf(t));
    if (!info) {
      t.mode = null; t.status = 'queued'; t.startedTs = 0;
      t.note = 'vlákno nepřežilo restart — spusť úkol znovu';
      changed = true;
    } else {
      const st = TH2TASK[info.status] || t.status;
      if (st !== t.status) { t.status = st; changed = true; }
    }
  }
  if (changed) persist();
  threads.onStatus(syncFromThreads);
  console.log(`[mctasks] loaded ${tasks.length} task(s)`);
}
