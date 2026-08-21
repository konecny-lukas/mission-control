// Mission Control — timeline aggregator („lodní deník", GET /api/timeline).
// Hybrid feed: materialized events (alert transitions / actions / diagnoses in
// alerts.db `events`) + lazy mtime-cached source adapters over files that other
// agents already write (narrative logs, watchdog history, jarvis transcript) +
// in-memory snapshot sections (cron) + on-demand uptime episodes. Every
// adapter returns normalized events:
//   { ts (epoch ms), source, severity 'ok'|'info'|'warn'|'crit', icon, text, link }
// The handler k-way merges them desc by ts with an opaque `ts-seq` cursor (seq
// disambiguates equal timestamps so pagination never drops or duplicates an
// event), a hard window floor of TIMELINE_MAX_DAYS and a TIMELINE_CACHE_MS
// whole-response cache for the no-cursor first page. `filter=` selects
// ADAPTERS (e.g. `db` = the alerts.db materialized stream — its events keep
// their stored source values alert/action/diagnosis); `severity=` is a MINIMUM
// (info < ok < warn < crit), so severity=warn ⇒ warn + crit.
// recent(state) keeps state.timeline = { recent: [~20 newest] } for the ticker;
// noteLive() lets alerts.recordEvent update that ring immediately (alongside
// stream.pushTimeline) without waiting for the next fastRefresh tick.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as C from './config.js';

const SEV_RANK = { info: 0, ok: 1, warn: 2, crit: 3 };
const RECENT_N = 20;
const NARR_MAX_BYTES = 25 * 1024; // lazy whole-file read cap per narrative log

// ---------- shared helpers ----------
// Tail-read up to maxBytes; when truncated, drop the partial first line.
function readTailLines(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf-8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // partial first line
    return text.split('\n').filter((l) => l.trim());
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}
function mtimeOf(file) { try { return fs.statSync(file).mtimeMs; } catch { return 0; } }
const hhmm = (ts) => new Date(ts).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

// ---------- narrative (cron-watchdog píše [YYYY-MM-DD HH:MM] emoji text) ----------
// Odvozeno z CFG.modules.watchdog.projects (config.js WATCHDOG_PROJECTS) —
// JEDINÝ zdroj pravdy pro projekty hlídače, viz watchdog/gen.mjs. Modul
// vypnutý / bez configu -> prázdné pole -> žádné narrative.* adaptéry (žádná
// natvrdo napsaná čtyřka jako v původním interním systému (podle research
// přípravy balíčku k watchdogu a skillům, §A3).
// `link` míří na jediný watchdog drawer (public/drawers.js) — balíček na
// rozdíl od zdroje nemá samostatný drawer per projekt.
const NARR = C.WATCHDOG_PROJECTS.map((p) => [`narrative.${p.id}`, `${p.id}.log`, 'watchdog']); // [adapter source id, log file, drawer link]
const NARR_LINE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\]\s*(.*)$/;
const NARR_EMOJI = /^(\p{Extended_Pictographic}(?:[\uFE0F\u200D]\p{Extended_Pictographic}?)*)\s*/u; // vč. VS16 (⚠️) a ZWJ sekvencí
function narrSeverity(emoji) {
  if (!emoji) return 'info';
  if (emoji.includes('🔴') || emoji.includes('❌')) return 'crit';
  if (emoji.includes('⚠')) return 'warn';
  if (emoji.includes('✅')) return 'ok';
  return 'info';
}
const narrCache = new Map(); // file -> { mtime, events }
function narrativeEvents(source, file, link) {
  const full = path.join(C.NARRATIVE_DIR, file);
  const mt = mtimeOf(full);
  if (!mt) return [];
  const hit = narrCache.get(full);
  if (hit && hit.mtime === mt) return hit.events;
  const events = [];
  for (const line of readTailLines(full, NARR_MAX_BYTES)) {
    const m = line.match(NARR_LINE);
    if (!m) continue;
    const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime(); // lokální čas (log píše agent na tomto boxu)
    let rest = m[6];
    const em = rest.match(NARR_EMOJI);
    let icon = '·';
    if (em) { icon = em[1]; rest = rest.slice(em[0].length); }
    events.push({ ts, source, severity: narrSeverity(icon), icon, text: rest.slice(0, 400), link });
  }
  narrCache.set(full, { mtime: mt, events });
  return events;
}

// ---------- watchdog (hourly jsonl; POZOR: `ts` je ISO string, ne epoch) ----------
let wdCache = { mtime: -1, events: [] };
function watchdogEvents() {
  const mt = mtimeOf(C.WATCHDOG_HISTORY);
  if (!mt) return [];
  if (wdCache.mtime === mt) return wdCache.events;
  const events = [];
  let prevAlert = null; // last seen entry with overall=='alert' (for the resolved transition)
  for (const line of readTailLines(C.WATCHDOG_HISTORY, C.TIMELINE_TAIL_BYTES)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(e?.ts);
    if (!Number.isFinite(ts)) continue;
    if (e.overall === 'alert') {
      // alerts[] jsou objekty {id,text} (watchdog/prompt-template.md) — starší/
      // nekonzistentní holé stringy se taky podporují (viz alerts.js sigOf()).
      const list = Array.isArray(e.alerts) ? e.alerts : [];
      const text = list.map((a) => (a && typeof a === 'object') ? (a.text || a.id || '') : String(a || '')).filter(Boolean).join(' · ').slice(0, 400) || 'problém (viz watchdog log)';
      events.push({ ts, source: 'watchdog', severity: 'warn', icon: '🐕', text: `Hlídač cronů: ${text}`, link: 'watchdog' });
      prevAlert = e;
    } else {
      if (prevAlert) events.push({ ts, source: 'watchdog', severity: 'ok', icon: '✓', text: 'Hlídač cronů: vyřešeno', link: 'watchdog' });
      prevAlert = null;
    }
  }
  wdCache = { mtime: mt, events };
  return events;
}

// ---------- uptime episodes (data/uptime.db, on-demand + krátká TTL cache) ----------
// Down checks (1min proby) se slévají do epizod: mezera ≤ 2× interval = táž
// epizoda. Otevřená epizoda (poslední check webu je down) běží dál → crit.
let uptimeDb = null;
function uptimeDb_() {
  if (uptimeDb) return uptimeDb;
  try {
    if (!fs.existsSync(C.UPTIME_DB)) return null;
    uptimeDb = new DatabaseSync(C.UPTIME_DB, { readOnly: true });
  } catch { uptimeDb = null; }
  return uptimeDb;
}
let upCache = { ts: 0, events: [] }; // TTL cache — dotaz scanuje ~300k řádků, nedělat každý tick
function uptimeEvents(now) {
  if (!C.MODULES.uptime) return []; // modul vypnutý — žádné čtení uptime.db (ani nemusí existovat)
  if (now - upCache.ts < 60_000) return upCache.events;
  const d = uptimeDb_();
  if (!d) return [];
  const floor = now - C.TIMELINE_MAX_DAYS * 86400000;
  let rows = [];
  try { rows = d.prepare('SELECT site, ts FROM checks WHERE up=0 AND ts>=? ORDER BY site, ts').all(floor); }
  catch { return upCache.events; }
  const gap = 2 * C.UPTIME_INTERVAL_MS;
  const labelOf = (id) => C.UPTIME_SITES.find((s) => s.id === id)?.label || id;
  const episodes = []; // { site, start, end }
  let cur = null;
  for (const r of rows) {
    const ts = Number(r.ts);
    if (cur && cur.site === r.site && ts - cur.end <= gap) { cur.end = ts; continue; }
    if (cur) episodes.push(cur);
    cur = { site: r.site, start: ts, end: ts };
  }
  if (cur) episodes.push(cur);
  const events = episodes.map((ep) => {
    let open = false;
    if (now - ep.end <= gap) { // possibly still down → confirm against the site's latest check
      try { open = Number(d.prepare('SELECT up FROM checks WHERE site=? ORDER BY ts DESC LIMIT 1').get(ep.site)?.up) === 0; }
      catch { open = true; }
    }
    const label = labelOf(ep.site);
    const mins = Math.max(1, Math.round((ep.end - ep.start) / 60000) + 1);
    return open
      ? { ts: ep.start, source: 'uptime', severity: 'crit', icon: '✖', text: `${label} výpadek od ${hhmm(ep.start)} (probíhá)`, link: 'uptime' }
      : { ts: ep.start, source: 'uptime', severity: 'warn', icon: '⚡', text: `${label} výpadek ${hhmm(ep.start)}–${hhmm(ep.end)} (${mins}m)`, link: 'uptime' };
  });
  upCache = { ts: now, events };
  return events;
}

// ---------- jarvis (data/jarvis-transcript.json, ≤60 entries, ts epoch ms) ----------
// Auto runy (diagnózy) se PŘESKAKUJÍ — materializuje je už zdroj `db` (source
// 'diagnosis'), duplikát ve feedu by jen šuměl.
let jvCache = { mtime: -1, events: [] };
function jarvisEvents() {
  const mt = mtimeOf(C.JARVIS_TRANSCRIPT);
  if (!mt) return [];
  if (jvCache.mtime === mt) return jvCache.events;
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(C.JARVIS_TRANSCRIPT, 'utf-8')); } catch { return jvCache.events; }
  const events = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.auto || !e.text || !Number.isFinite(e.ts)) continue;
    if (e.role !== 'user' && e.role !== 'assistant') continue;
    events.push({
      ts: e.ts, source: 'jarvis', severity: 'info',
      icon: e.role === 'user' ? '›' : '◆',
      // 'Ty' místo jména konkrétního provozovatele — balíček je generický,
      // label musí sedět komukoli, kdo si Mission Control nasadí (drží
      // stejný neformální hlas jako zbytek Jarvis chatu).
      text: `${e.role === 'user' ? 'Ty' : 'Jarvis'}: ${String(e.text).replace(/\s+/g, ' ').trim().slice(0, 200)}`,
      link: 'jarvis',
    });
  }
  jvCache = { mtime: mt, events };
  return events;
}

// ---------- cron (in-memory ze snapshotu — poslední doběh per job) ----------
const STATUS_MAP = { ok: ['ok', '✓'], idle: ['info', '·'], warn: ['warn', '⚠'], crit: ['crit', '✖'] };
function cronEvents(state) {
  const events = [];
  for (const j of state?.cron?.jobs || []) {
    if (!j?.lastRun) continue;
    const ts = Date.parse(j.lastRun);
    const sm = STATUS_MAP[j.lastStatus];
    if (!Number.isFinite(ts) || !sm) continue; // unknown status ⇒ nic užitečného k ukázání
    events.push({ ts, source: 'cron', severity: sm[0], icon: sm[1], text: `Cron „${j.label}“ — ${(j.lastLine || 'doběhl').slice(0, 220)}`, link: 'cron' });
  }
  return events;
}

// ---------- db (materializované události z alerts.db: alert/action/diagnosis) ----------
// Vlastní readonly spojení (WAL snese souběžné čtenáře); zdrojová pole `source`
// zůstávají jak je recordEvent uložil — adaptér se pro filter jmenuje `db`.
let eventsDb = null;
function eventsDb_() {
  if (eventsDb) return eventsDb;
  try {
    if (!fs.existsSync(C.ALERTS_DB)) return null;
    eventsDb = new DatabaseSync(C.ALERTS_DB, { readOnly: true });
  } catch { eventsDb = null; }
  return eventsDb;
}
function dbEvents(floor) {
  const d = eventsDb_();
  if (!d) return [];
  let rows = [];
  try { rows = d.prepare('SELECT ts, source, severity, icon, text, link FROM events WHERE ts>=? ORDER BY ts DESC LIMIT 2000').all(floor); }
  catch { return []; }
  return rows.map((r) => ({
    ts: Number(r.ts), source: String(r.source || 'alert'),
    severity: SEV_RANK[r.severity] != null ? r.severity : 'info',
    icon: r.icon || '·', text: String(r.text || '').slice(0, 500), link: r.link || null,
  }));
}

// ---------- merge ----------
const ADAPTER_NAMES = new Set([...NARR.map((n) => n[0]), 'watchdog', 'uptime', 'jarvis', 'cron', 'db']);
// Deterministic order: ts desc, then source/text asc — equal-ts runs must sort
// identically on every request or `ts-seq` cursors would drift between pages.
function cmp(a, b) {
  return b.ts - a.ts
    || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)
    || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
}
function gather(state, filter, now) {
  const floor = now - C.TIMELINE_MAX_DAYS * 86400000;
  const want = (name) => !filter || filter.has(name);
  const out = [];
  for (const [source, file, link] of NARR) if (want(source)) out.push(...narrativeEvents(source, file, link));
  if (want('watchdog')) out.push(...watchdogEvents());
  if (want('uptime')) out.push(...uptimeEvents(now));
  if (want('jarvis')) out.push(...jarvisEvents());
  if (want('cron')) out.push(...cronEvents(state));
  if (want('db')) out.push(...dbEvents(floor));
  const evs = out.filter((e) => Number.isFinite(e.ts) && e.ts >= floor && e.ts <= now + 60_000);
  evs.sort(cmp);
  return evs;
}

// ---------- GET /api/timeline ----------
const pageCache = new Map(); // first-page (no cursor) responses: qkey -> { ts, body }
export function handleTimeline(req, res, state) {
  let q;
  try { q = new URL(req.url, 'http://x').searchParams; } catch { q = new URLSearchParams(); }
  const limit = Math.max(1, Math.min(200, parseInt(q.get('limit'), 10) || C.TIMELINE_PAGE));
  const filterRaw = (q.get('filter') || '').trim();
  const names = filterRaw ? filterRaw.split(',').map((s) => s.trim()).filter((s) => ADAPTER_NAMES.has(s)) : [];
  const filter = names.length ? new Set(names) : null;
  const sevRaw = (q.get('severity') || '').trim();
  const sevMin = SEV_RANK[sevRaw] ?? 0;
  const cm = String(q.get('before') || '').match(/^(\d+)-(\d+)$/);
  const cursor = cm ? { ts: Number(cm[1]), seq: Number(cm[2]) } : null;

  const qkey = `${limit}|${names.join(',')}|${sevMin}`;
  const now = Date.now();
  if (!cursor) {
    const hit = pageCache.get(qkey);
    if (hit && now - hit.ts < C.TIMELINE_CACHE_MS) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Timeline-Cache': 'hit' });
      return res.end(hit.body);
    }
  }

  let all;
  try { all = gather(state, filter, now); } catch (e) { console.error('[timeline]', e); all = []; }
  if (sevMin > 0) all = all.filter((e) => (SEV_RANK[e.severity] ?? 0) >= sevMin);
  // seq per equal-ts run, assigned AFTER content filters (cursor stability needs
  // the client to repeat the same filter/severity params on follow-up pages).
  let seq = 0, prevTs = null;
  for (const e of all) { e.seq = (e.ts === prevTs) ? seq + 1 : 0; seq = e.seq; prevTs = e.ts; }
  const visible = cursor ? all.filter((e) => e.ts < cursor.ts || (e.ts === cursor.ts && e.seq > cursor.seq)) : all;
  const page = visible.slice(0, limit).map((e) => ({
    id: `${e.ts}-${e.seq}`, ts: e.ts, source: e.source, severity: e.severity, icon: e.icon, text: e.text, link: e.link,
  }));
  const body = JSON.stringify({ events: page, nextBefore: page.length === limit ? page[page.length - 1].id : null });
  if (!cursor) {
    pageCache.set(qkey, { ts: now, body });
    if (pageCache.size > 24) { const oldest = pageCache.keys().next().value; pageCache.delete(oldest); }
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// ---------- ticker ring (state.timeline.recent, ~20 newest events) ----------
// Recomputed every fastRefresh tick — the mtime/TTL caches above make a warm
// pass nearly free (6 statSync + 1 indexed SELECT + in-memory merge). The
// object reference is preserved when content is unchanged so the SSE diff in
// stream.publish skips it.
let ringObj = { recent: [] };
let ringStr = '';
let stateRef = null;

export function recent(state) {
  stateRef = state;
  let top;
  try { top = gather(state, null, Date.now()).slice(0, RECENT_N); }
  catch (e) { console.error('[timeline] recent', e); state.timeline = ringObj; return ringObj; }
  const slim = top.map((e) => ({ ts: e.ts, source: e.source, severity: e.severity, icon: e.icon, text: e.text, link: e.link }));
  const str = JSON.stringify(slim);
  if (str !== ringStr) { ringObj = { recent: slim }; ringStr = str; }
  state.timeline = ringObj;
  return ringObj;
}

// Live hook: alerts.recordEvent calls this alongside stream.pushTimeline so the
// ring (and any snapshot served before the next tick) carries the event at
// once. The next recent() pass rebuilds the canonical merged order anyway —
// recordEvent has already inserted the row into alerts.db at this point.
export function noteLive(event) {
  const e = event || {};
  if (!Number.isFinite(e.ts)) return;
  const slim = {
    ts: e.ts, source: String(e.source || 'alert'),
    severity: SEV_RANK[e.severity] != null ? e.severity : 'info',
    icon: e.icon || '·', text: String(e.text || '').slice(0, 500), link: e.link || null,
  };
  ringObj = { recent: [slim, ...ringObj.recent].slice(0, RECENT_N) };
  ringStr = ''; // force canonical rebuild on the next tick
  pageCache.clear(); // a fresh event must not be masked by the 30s first-page cache
  if (stateRef) stateRef.timeline = ringObj;
}
