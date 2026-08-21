// Mission Control — Jarvis backend.
// Drives a headless Claude Code session per turn (spawn `claude -p [--resume]`),
// parses the stream-json (NDJSON) output, and emits normalized events to a
// callback: { session | text | tool | done | error | aborted }.
//
// The user message is passed as a single argv element (never through a shell),
// so it cannot inject flags or commands. Runs in $HOME with full access +
// --dangerously-skip-permissions — same trust as the /term terminals (tailnet).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import * as C from './config.js';

// ---------- persistent state ----------
function ensureData() { try { fs.mkdirSync(C.DATA_DIR, { recursive: true }); } catch {} }
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; } }
function writeJSON(file, obj) { ensureData(); try { fs.writeFileSync(file, JSON.stringify(obj)); } catch (e) { console.error('[jarvis] write', file, e.message); } }

export function getSessionId() { return readJSON(C.JARVIS_STATE, {}).sessionId || null; }
function setSessionId(id) { if (id) writeJSON(C.JARVIS_STATE, { sessionId: id, updatedAt: Date.now() }); }
function clearSession() { try { fs.rmSync(C.JARVIS_STATE, { force: true }); } catch {} }

export function getTranscript() { return readJSON(C.JARVIS_TRANSCRIPT, []); }
function pushEntry(entry) {
  const t = getTranscript();
  t.push({ ...entry, ts: Date.now() });
  while (t.length > C.JARVIS_TRANSCRIPT_MAX) t.shift();
  writeJSON(C.JARVIS_TRANSCRIPT, t);
}
function pushTranscript(role, text, auto = false) { if (text) pushEntry(auto ? { role, text, auto: true } : { role, text }); }

export function reset() { clearSession(); try { fs.rmSync(C.JARVIS_TRANSCRIPT, { force: true }); } catch {} }

// ---------- single-flight ----------
let current = null; // { kill }
export function isBusy() { return !!current; }
export function abort() { if (current) current.kill(); }

// ---------- run one turn ----------
// onEvent({type, ...}); resolves when the turn finishes (success, error, or abort).
// opts (all optional — defaults keep the user's console byte-identical):
//   model  – claude model id (default C.JARVIS_MODEL)
//   effort – reasoning effort (default C.JARVIS_EFFORT); omitted entirely for
//            haiku models (`--effort` 400s on haiku)
//   maxMs  – absolute turn cap (default C.JARVIS_MAX_MS)
//   cwd    – working dir of the claude subprocess (default C.JARVIS_CWD) —
//            task threads (mctasks.js) run in their project's directory
//   auto   – machine-initiated turn (alert diagnosis): NEVER --resume, NEVER
//            persists the session id (the user's Opus session must survive
//            untouched), transcript entries flagged { auto: true }.
//   thread – alert-thread turn (threads.js): fully detached from the user's
//            Jarvis — skips the single-flight lock (`current` stays untouched,
//            isBusy()/abort() keep meaning "the user's console"), never reads
//            or writes JARVIS_STATE / the main transcript. The caller owns the
//            session id and the kill handle:
//              { resume: sessionId|null, onHandle({kill}), isWaiting() }
//            isWaiting()=true suppresses the stall watchdog (a question was
//            emitted — silence while waiting for the user is not a hang).
export function runJarvis(message, onEvent, opts = {}) {
  const emit = (ev) => { try { onEvent(ev); } catch {} };
  const thread = opts.thread || null;
  if (!thread && current) { emit({ type: 'error', error: 'Jarvis právě pracuje na předchozím dotazu.' }); return Promise.resolve(); }

  const model = opts.model || C.JARVIS_MODEL;
  const effort = opts.effort || C.JARVIS_EFFORT;
  const maxMs = opts.maxMs || C.JARVIS_MAX_MS;
  const auto = !!opts.auto;

  if (!thread) pushTranscript('user', message, auto);

  return new Promise((resolve) => {
    let aborted = false, finished = false, timedOut = null; // timedOut: null | 'stall' | 'max'
    let turnText = '', newSession = null, cost = 0, resultError = null, turnQuestions = null;
    let stallTimer = null, hardTimer = null;
    const clearTimers = () => { clearTimeout(stallTimer); clearTimeout(hardTimer); stallTimer = hardTimer = null; };

    const finish = (ok, errMsg) => {
      if (finished) return; finished = true;
      clearTimers();
      if (!thread) current = null;
      if (aborted) { emit({ type: 'aborted' }); return resolve(); }
      if (ok) {
        if (!auto && !thread) setSessionId(newSession); // session isolation: auto/thread turns never become "the" session
        if (!thread) {
          pushTranscript('assistant', turnText, auto);
          if (turnQuestions && turnQuestions.length) pushEntry({ role: 'question', questions: turnQuestions });
        }
        emit({ type: 'done', cost, sessionId: newSession });
      } else {
        emit({ type: 'error', error: errMsg || 'Jarvis selhal.' });
      }
      resolve();
    };

    const attempt = (resumeId) => {
      let stdoutBuf = '', stderrBuf = '', assistantBuf = '', sawOutput = false;
      const isHaiku = /haiku/i.test(model);
      const args = [
        '-p', message,
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--model', model,
      ];
      if (!isHaiku) args.push('--effort', effort); // --effort 400s on haiku models
      args.push('--dangerously-skip-permissions');
      // Chybí-li agent-system.md (INSTALL ho vyrobí ze šablony — viz
      // agent-system.md.template), flag prostě vynecháme: Jarvis pak jede bez
      // system promptu místo aby claude spadl na neexistujícím souboru.
      if (fs.existsSync(C.JARVIS_SYSTEM_PROMPT)) args.push('--append-system-prompt-file', C.JARVIS_SYSTEM_PROMPT);
      if (resumeId) args.push('--resume', resumeId);
      if (auto) console.log(`[jarvis] auto turn: model=${model}${isHaiku ? '' : ` effort=${effort}`} maxMs=${maxMs} resume=${resumeId ? 'YES (BUG!)' : 'no'}`);

      const child = spawn(C.CLAUDE_BIN, args, { cwd: opts.cwd || C.JARVIS_CWD, env: C.JARVIS_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
      // SIGTERM first, then SIGKILL if it ignores us — a wedged claude won't always die on TERM.
      const killChild = () => { try { child.kill('SIGTERM'); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000); };
      const handleObj = { kill: () => { aborted = true; clearTimers(); killChild(); } };
      if (thread) { try { thread.onHandle?.(handleObj); } catch {} } // thread turns NEVER take the single-flight lock
      else current = handleObj;

      // Watchdog: kill a turn that streams nothing for STALL_MS, or runs past MAX_MS
      // overall, so a single hung turn can never hold the single-flight lock forever.
      // Thread turns with an emitted question (isWaiting) just re-arm — silence
      // while the user decides is not a hang.
      const bumpStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (thread && thread.isWaiting?.()) { bumpStall(); return; }
          timedOut = 'stall'; killChild();
        }, C.JARVIS_STALL_MS);
      };
      hardTimer = setTimeout(() => { timedOut = 'max'; killChild(); }, maxMs);
      bumpStall();

      const handle = (obj) => {
        if (obj.type === 'system' && obj.subtype === 'init') {
          if (obj.session_id) { newSession = obj.session_id; emit({ type: 'session', sessionId: obj.session_id }); }
          return;
        }
        if (obj.type === 'stream_event' && obj.event) {
          const ev = obj.event;
          if (ev.type === 'message_start') { assistantBuf = ''; return; }
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) {
            assistantBuf += ev.delta.text; emit({ type: 'text', text: ev.delta.text });
          }
          return;
        }
        if (obj.type === 'assistant' && obj.message) {
          let full = '';
          for (const b of (obj.message.content || [])) {
            if (b.type === 'text') full += b.text || '';
            else if (b.type === 'tool_use' && b.name === 'AskUserQuestion') {
              turnQuestions = (b.input && b.input.questions) || [];
              emit({ type: 'question', questions: turnQuestions });
            } else if (b.type === 'tool_use') emit({ type: 'tool', name: b.name, input: b.input });
          }
          // safety net: stream any text the partial deltas didn't already deliver
          if (full && full.length > assistantBuf.length) emit({ type: 'text', text: full.slice(assistantBuf.length) });
          if (full) turnText += (turnText ? '\n' : '') + full;
          assistantBuf = '';
          return;
        }
        if (obj.type === 'result') {
          if (obj.session_id) newSession = obj.session_id;
          if (typeof obj.total_cost_usd === 'number') cost = obj.total_cost_usd;
          if (!turnText && typeof obj.result === 'string') turnText = obj.result;
          if (obj.is_error) resultError = (typeof obj.result === 'string' && obj.result) || obj.subtype || 'chyba';
          return;
        }
      };

      child.stdout.on('data', (chunk) => {
        bumpStall(); // progress → reset the stall watchdog
        stdoutBuf += chunk.toString('utf-8');
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let obj; try { obj = JSON.parse(line); } catch { continue; }
          sawOutput = true;
          handle(obj);
        }
      });
      child.stderr.on('data', (c) => { stderrBuf += c.toString('utf-8'); if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000); });

      child.on('error', (e) => finish(false, `spawn: ${e.message}`));
      child.on('close', (code) => {
        clearTimers();
        if (aborted) return finish(false);
        // watchdog fired — report a clear timeout instead of a misleading success/retry
        if (timedOut) {
          const secs = Math.round((timedOut === 'max' ? maxMs : C.JARVIS_STALL_MS) / 1000);
          const why = timedOut === 'max' ? `běžel přes ${secs} s` : `nereagoval déle než ${secs} s`;
          return finish(false, `Jarvis ${why} a byl ukončen — zkus to znovu nebo zadej stručnější úkol.`);
        }
        // stale --resume: nothing came back → drop the bad session id and retry fresh once
        // (thread turns must NOT clearSession — that file belongs to the user's Jarvis)
        if (code !== 0 && resumeId && !sawOutput) { if (!thread) clearSession(); newSession = null; return attempt(null); }
        if (resultError) return finish(false, resultError);
        if (code === 0 || sawOutput) return finish(true);
        finish(false, stderrBuf.trim().slice(-400) || `claude skončil s kódem ${code}`);
      });
    };

    // auto turns start FRESH every time (no --resume): the stale-resume retry
    // path above can then never fire either, so clearSession() can't be reached
    // and the user's session file stays untouched on both code paths.
    // thread turns resume THEIR OWN session id (or start fresh on the first turn).
    attempt(thread ? (thread.resume || null) : (auto ? null : getSessionId()));
  });
}
