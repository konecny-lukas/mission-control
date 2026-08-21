// Mission Control — SSE state push (/api/stream).
// One stream per browser tab: on connect a full `snapshot` event, then `patch`
// events carrying ONLY the top-level state sections that actually changed,
// `timeline` events (live ticker items, wired by the alert engine), and a real
// `hb` heartbeat event every STREAM_HEARTBEAT_MS (EventSource clients can't see
// `:` comments, and the client staleness watchdog needs to observe traffic).
//
// Diffing relies on a contract with server.js: fastRefresh rebuilds state via
// `{ ...state, <touched sections> }`, so an UNTOUCHED section keeps its object
// reference between ticks → ref-equality is the fast path. Sections whose ref
// changed get a JSON.stringify string-compare backstop (refresh fns reassign
// fresh objects even when nothing changed). No replay buffer: a reconnect just
// gets a fresh snapshot — cheaper and simpler than gap replay.
import * as C from './config.js';

// Same header set as server.js's SSE_HEAD (Jarvis stream) — duplicated here to
// avoid a circular import for the sake of one constant.
const SSE_HEAD = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };

const clients = new Set(); // Set keeps insertion order → first element = oldest connection
let v = 0;                 // monotonic frame counter, doubles as the SSE `id:`
let hbTimer = null;        // heartbeat interval — runs only while clients.size > 0

// Diff caches, global (one stream of truth, all clients get identical frames):
// section key → last seen ref / last seen serialized form.
const cacheRef = new Map();
const cacheStr = new Map();

function dropClient(res, destroy = true) {
  clients.delete(res);
  if (destroy) { try { res.destroy(); } catch {} }
  if (!clients.size && hbTimer) { clearInterval(hbTimer); hbTimer = null; }
}

function writeFrame(res, frame) {
  // Slow consumer guard: a client that stops reading would buffer frames in
  // process memory forever — cap at 1 MB of unflushed data, then cut it loose
  // (it will reconnect and get a fresh snapshot).
  if (res.writableLength > 1_000_000) return dropClient(res);
  try { res.write(frame); } catch { dropClient(res); }
}

function broadcast(frame) {
  for (const res of clients) writeFrame(res, frame); // Set tolerates deletes mid-iteration
}

function startHeartbeat() {
  if (hbTimer) return;
  hbTimer = setInterval(() => {
    broadcast(`event: hb\ndata: ${Date.now()}\n\n`);
  }, C.STREAM_HEARTBEAT_MS);
}

// GET /api/stream — register the client and send the full current state.
export function handleStream(req, res, state) {
  // No replay: Last-Event-ID is read only to log how big the gap was (helps
  // judge whether reconnects are frequent enough to ever justify replay).
  const lastId = parseInt(req.headers['last-event-id'], 10);
  if (Number.isFinite(lastId)) console.log(`[stream] reconnect: last seen id ${lastId}, current ${v} (gap ${Math.max(0, v - lastId)}) — sending fresh snapshot`);

  res.writeHead(200, SSE_HEAD);
  res.write(`retry: ${C.STREAM_RETRY_MS}\n\n`);
  v++;
  try {
    res.write(`id: ${v}\nevent: snapshot\ndata: ${JSON.stringify({ v, state })}\n\n`);
  } catch {
    try { res.destroy(); } catch {}
    return;
  }
  clients.add(res);
  // Overflow → evict the OLDEST stream (likely a zombie tab); newest tab is the
  // one the user is actually looking at.
  while (clients.size > C.STREAM_MAX_CLIENTS) {
    const oldest = clients.values().next().value;
    console.log(`[stream] ${clients.size} clients > max ${C.STREAM_MAX_CLIENTS} — evicting oldest`);
    dropClient(oldest);
  }
  res.on('close', () => dropClient(res, false));
  startHeartbeat();
}

// Called at the END of every refresh fn (and on jarvisBusy flips). Computes the
// changed top-level sections and broadcasts them as one `patch` frame.
export function publish(state) {
  let sections = null;
  for (const key of Object.keys(state)) {
    if (key === 'ts') continue; // ts changes every tick and rides the patch envelope instead
    const val = state[key];
    if (val === undefined) continue;
    if (cacheRef.get(key) === val) continue; // ref preserved ⇒ untouched (fastRefresh spread contract)
    cacheRef.set(key, val);
    let str;
    try { str = JSON.stringify(val); } catch { continue; } // defensive: a cycle must not kill a refresh loop
    if (cacheStr.get(key) === str) continue; // fresh object, identical content ⇒ not a real change
    cacheStr.set(key, str);
    (sections ??= {})[key] = val;
  }
  // Caches are kept warm even with zero clients (cheap: only changed-ref
  // sections get stringified) so the first patch after a connect stays small.
  if (!sections || !clients.size) return;
  v++;
  // Assembled ONCE per publish; sections are small at steady state, so the
  // second stringify of already-stringified values is accepted (plan 3.4).
  broadcast(`id: ${v}\nevent: patch\ndata: ${JSON.stringify({ v, ts: state.ts, sections })}\n\n`);
}

// Live ticker event (alert transitions, action results …) — wired by the alert
// engine later; exported now so the contract is in place.
export function pushTimeline(event) {
  if (!clients.size) return;
  v++;
  broadcast(`id: ${v}\nevent: timeline\ndata: ${JSON.stringify(event)}\n\n`);
}
