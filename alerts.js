// Mission Control — alert engine.
// Declarative rules (config.ALERT_RULES) evaluated over the in-memory snapshot
// on every fastRefresh tick, BEFORE buildSummary (the core color must never lag
// behind an alert). Zero I/O per tick except the watchdog builtin — and that is
// mtime-gated (stat max 1×/min, full tail read only when the file changed,
// which the hourly cron-watchdog does ~1×/h).
//
// State machine per key `ruleId:targetId`:
//   pending   – condition true for less than rule.forMs (debounce; a flicker
//               that clears before forMs leaves no trace)
//   active    – condition held → DB row inserted + timeline event; listed in
//               state.alerts.active (and stays listed while resolving)
//   resolving – condition false for less than rule.clearMs (hysteresis)
//   resolved  – condition stayed false → DB row updated + timeline event; the
//               key then can't re-open within rule.cooldownMs.
// All timers are in-memory: a service restart resets forMs/clearMs windows
// (acceptable). Open alerts themselves are NOT lost on restart — init()
// restores unresolved DB rows as active tracks (openedTs/ackTs preserved) and
// the first evaluate() either keeps them (condition still true) or walks them
// through resolving→resolved normally. Rows whose rule no longer exists in
// config are closed as stale at boot so they can't linger forever.
//
// Silences („✕ skrýt do vyřešení", action alert.silence {key}): a silenced
// alert (a) is dropped from state.alerts.active, (b) is EXCLUDED from
// state.alerts.state (must not drive the core color while hidden), (c) its
// state machine keeps running — when the condition clears it resolves silently
// and the silence is CLEARED so a fresh future episode shows again, (d) safety
// auto-expire: still firing after ALERT_SILENCE_MAX_DAYS → silence lifts and
// the alert reappears. Persisted in alerts.db (table silences) → survives
// restarts; orphaned rows (no open alert for the key) are pruned at boot.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as C from './config.js';
import * as stream from './stream.js';
import * as jarvis from './jarvis.js';
import * as timeline from './timeline.js';
import * as threads from './threads.js'; // kruhový import OK: obě strany volají jen funkce za runtime

// ---------- persistence (data/alerts.db, WAL like the sibling modules) ----------
let db = null;
function db_() {
  if (db) return db;
  fs.mkdirSync(C.DATA_DIR, { recursive: true });
  const d = new DatabaseSync(C.ALERTS_DB);
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec(`CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY,
    key        TEXT    NOT NULL,
    rule       TEXT    NOT NULL,
    severity   TEXT    NOT NULL,
    openedTs   INTEGER NOT NULL,
    resolvedTs INTEGER,
    ackTs      INTEGER,
    text       TEXT,
    meta       TEXT
  );`);
  d.exec('CREATE INDEX IF NOT EXISTS idx_alerts_opened ON alerts(openedTs);');
  d.exec(`CREATE TABLE IF NOT EXISTS events (
    ts       INTEGER NOT NULL,
    source   TEXT    NOT NULL,
    severity TEXT,
    icon     TEXT,
    text     TEXT,
    link     TEXT
  );`);
  d.exec('CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);');
  // skryté výstrahy (alert.silence) — viz hlavička modulu; tabulka v původním
  // plánu existovala, byla vyškrtnuta a doplněna až teď (proto IF NOT EXISTS)
  d.exec(`CREATE TABLE IF NOT EXISTS silences (
    key        TEXT PRIMARY KEY,
    silencedTs INTEGER NOT NULL
  );`);
  db = d;
  return db;
}

// ---------- in-memory engine state ----------
const tracks = new Map();        // key -> { rule, target, phase, since, falseSince, dbId, openedTs, ackTs, text, diagnosis }
const cooldownUntil = new Map(); // key -> ts before which the key may not re-open
const silences = new Map();      // key -> silencedTs (zrcadlo tabulky silences; jen pro AKTUÁLNÍ epizodu klíče)
let recentOpens = [];            // openedTs of alerts opened in the last 24 h (seeded from DB)
let diagRuns = [];               // start timestamps of diagnosis spawns (sliding 1 h budget)
let lastPrune = 0;
let lastState = null;            // latest snapshot — RAM gate + diagnosis prompt excerpts
let lastBuilt = null;            // cached state.alerts object: stable ref ⇒ no SSE patch churn
let lastBuiltStr = '';

const SEV_ICON = { crit: '✖', warn: '⚠', info: '·' };

function getPath(obj, p) {
  let v = obj;
  for (const k of p.split('.')) { if (v == null) return undefined; v = v[k]; }
  return v;
}
function fmtVal(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(1);
  if (v == null || v === '') return '—';
  return String(v).slice(0, 140);
}
function fillText(tpl, target) { return String(tpl || '').replace(/\{([\w.]+)\}/g, (_, p) => fmtVal(getPath(target, p))); }
// Only primitive target fields go into the DB meta (cron jobs carry logTail arrays etc.).
function compactTarget(target) {
  const out = {};
  for (const [k, v] of Object.entries(target || {})) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
  }
  return out;
}

// Fallback podpis watchdog alertu, který přišel jako holý string (starý/
// nekonzistentní formát, ne {id,text}): normalizace (bez čísel/interpunkce,
// tokeny ≥4 znaky, seřazené) + djb2 hash. LLM přeformulování to úplně nespasí
// — proto watchdog/prompt-template.md chce objekty {id, text} se STABILNÍM
// id; tohle je jen záchranná síť.
function sigOf(s) {
  const norm = String(s).toLowerCase().replace(/\d+/g, ' ').replace(/[^a-zá-ž ]+/gi, ' ')
    .split(/\s+/).filter((w) => w.length >= 4).sort().slice(0, 12).join(' ');
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0;
  return 's' + h.toString(36);
}

// ---------- watchdog builtin (the one allowed I/O — mtime-gated) ----------
const wd = { lastStat: 0, mtime: -1, entry: null };
function watchdogLatest() {
  const now = Date.now();
  if (now - wd.lastStat < 60_000) return wd.entry; // stat at most 1×/min
  wd.lastStat = now;
  let st;
  try { st = fs.statSync(C.WATCHDOG_HISTORY); } catch { wd.entry = null; return null; }
  if (st.mtimeMs === wd.mtime) return wd.entry;    // unchanged → no read (file changes ~1×/h)
  wd.mtime = st.mtimeMs;
  try {
    const fd = fs.openSync(C.WATCHDOG_HISTORY, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 16384);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const j = JSON.parse(lines[i]); if (j && j.ts) { wd.entry = j; return wd.entry; } } catch { /* partial first line of the tail window */ }
    }
  } catch { /* unreadable → keep last entry */ }
  return wd.entry;
}

// ---------- rule evaluation → list of currently-true { key, target } ----------
function ruleHits(rule, state) {
  const hits = [];
  const push = (tid, target) => hits.push({ key: `${rule.id}:${tid}`, target });

  if (rule.type === 'each') {
    const arr = getPath(state, rule.path);
    if (!Array.isArray(arr)) return hits;
    for (const item of arr) {
      if (!item || item[rule.keyField] == null) continue;
      let res;
      try { res = rule.when(item, state); } catch { continue; }
      if (!res) continue;
      push(String(item[rule.keyField]), typeof res === 'object' ? { ...item, ...res } : item);
    }
    return hits;
  }

  if (rule.type === 'metric') {
    const v = getPath(state, rule.path);
    let res;
    if (rule.when) { try { res = rule.when(v, state); } catch { res = false; } }
    else if (rule.op === '>=') res = typeof v === 'number' && v >= rule.value;
    else if (rule.op === '>') res = typeof v === 'number' && v > rule.value;
    else if (rule.op === '<') res = typeof v === 'number' && v < rule.value;
    else if (rule.op === '<=') res = typeof v === 'number' && v <= rule.value;
    else if (rule.op === '===') res = v === rule.value;
    if (res) push('_', typeof res === 'object' ? res : { value: v });
    return hits;
  }

  if (rule.type === 'watchdog') {
    // Per-PROBLÉM klíče: alerts[] v history jsonl jsou objekty {id, text} se
    // stabilním id napříč běhy (watchdog/prompt-template.md); holý string
    // (starší/nekonzistentní zápis) dostane sigOf() fallback. Stejné id =
    // stejný klíč = JEDNA průběžná výstraha (text se obnovuje přes liveText),
    // zmizení z posledního zápisu = normální resolve — NE jeden slévající
    // klíč 'latest', který by zbytečně přeotvíral stejný problém pokaždé, když
    // LLM přeformuluje text.
    const e = watchdogLatest();
    if (e && e.overall === 'alert') {
      const ts = Date.parse(e.ts); // POZOR: ts je ISO string, ne epoch
      // freshness gate: a dead watchdog must not pin its last alert forever
      if (Number.isFinite(ts) && Date.now() - ts < 2 * 3600_000) {
        const list = Array.isArray(e.alerts) ? e.alerts : [];
        for (const a of list) {
          if (a && typeof a === 'object' && a.id) {
            const id = String(a.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
            push(id || 'issue', { summary: String(a.text || a.id).slice(0, 220) });
          } else if (typeof a === 'string' && a.trim()) {
            push(sigOf(a), { summary: a.slice(0, 220) });
          }
        }
        // overall=alert bez alerts[] (nemělo by nastat) — zachovej viditelnost
        if (!list.length) push('latest', { summary: 'viz watchdog log' });
      }
    }
    return hits;
  }

  return hits;
}

// ---------- transitions ----------
function activate(key, t, now) {
  t.phase = 'active';
  t.openedTs = now;
  t.text = fillText(t.rule.text, t.target);
  try {
    const d = db_();
    // Idempotence otevření (oprava duplicit z 2026-06-11, ids 4+15 na jednom
    // klíči): pokud pro klíč UŽ existuje otevřený řádek (restart, který ho
    // nerestoroval — např. dočasně chybějící pravidlo; souběžný proces při
    // verifikacích), NÁROKUJEME si ho — přebíráme id i původní openedTs a jen
    // aktualizujeme text/meta. Další otevřené řádky téhož klíče (historické
    // duplicity) se zavřou. INSERT padá jen když žádný otevřený řádek není.
    const open = d.prepare('SELECT id, openedTs FROM alerts WHERE key=? AND resolvedTs IS NULL ORDER BY id DESC').all(key);
    if (open.length) {
      t.dbId = Number(open[0].id);
      t.openedTs = Number(open[0].openedTs) || now;
      d.prepare('UPDATE alerts SET severity=?, text=?, meta=? WHERE id=?')
        .run(t.rule.severity, t.text, JSON.stringify({ target: compactTarget(t.target) }), t.dbId);
      for (const r of open.slice(1)) {
        d.prepare(`UPDATE alerts SET resolvedTs=?, meta=json_patch(COALESCE(meta,'{}'), '{"stale":"duplicate open row"}') WHERE id=?`).run(now, r.id);
      }
    } else {
      const r = d.prepare('INSERT INTO alerts (key, rule, severity, openedTs, text, meta) VALUES (?,?,?,?,?,?)')
        .run(key, t.rule.id, t.rule.severity, now, t.text, JSON.stringify({ target: compactTarget(t.target) }));
      t.dbId = Number(r.lastInsertRowid);
      recentOpens.push(now); // jen skutečně NOVÉ otevření (nárokovaný řádek už je v count24h z init seedu)
    }
  } catch (e) { console.error('[alerts] insert', e.message); }
  lastBuiltStr = '';
  recordEvent('alert', t.rule.severity, SEV_ICON[t.rule.severity] || '⚠', t.text, t.rule.link || null);
  if (t.rule.diagnose && t.rule.severity === 'crit' && C.ALERT_DIAGNOSE_ENABLED) autoDiagnose(t);
}

function resolveTrack(key, t, now) {
  tracks.delete(key);
  if (t.rule.cooldownMs > 0) cooldownUntil.set(key, now + t.rule.cooldownMs);
  if (cooldownUntil.size > 500) { for (const [k, ts] of cooldownUntil) if (ts <= now) cooldownUntil.delete(k); }
  try { if (t.dbId != null) db_().prepare('UPDATE alerts SET resolvedTs=? WHERE id=?').run(now, t.dbId); }
  catch (e) { console.error('[alerts] resolve', e.message); }
  // skrytí platí jen pro TUHLE epizodu — vyřešením se maže, příští výskyt se ukáže
  const wasSilenced = silences.has(key);
  if (wasSilenced) clearSilence(key);
  lastBuiltStr = '';
  const mins = Math.max(1, Math.round((now - (t.openedTs || now)) / 60000));
  recordEvent('alert', 'info', '✓', `Vyřešeno${wasSilenced ? ' (skryté)' : ''}: ${t.text} (trvalo ${mins} min)`, t.rule.link || null);
}

// silence pryč z paměti i z DB (resolve / auto-expire / úklid sirotků při bootu)
function clearSilence(key) {
  silences.delete(key);
  try { db_().prepare('DELETE FROM silences WHERE key=?').run(key); }
  catch (e) { console.error('[alerts] clearSilence', e.message); }
}

// ---------- public: evaluate (called from fastRefresh, BEFORE buildSummary) ----------
export function evaluate(state) {
  lastState = state;
  const now = Date.now();
  pruneMaybe(now);

  const trueKeys = new Map(); // key -> { rule, target }
  for (const rule of C.ALERT_RULES) {
    let hits = [];
    try { hits = ruleHits(rule, state); } catch (e) { console.error('[alerts] rule', rule.id, e.message); }
    for (const h of hits) trueKeys.set(h.key, { rule, target: h.target });
  }

  for (const [key, { rule, target }] of trueKeys) {
    const t = tracks.get(key);
    if (!t) {
      if ((cooldownUntil.get(key) || 0) > now) continue;
      const tr = { rule, target, phase: 'pending', since: now, falseSince: 0, dbId: null, openedTs: 0, ackTs: null, text: null, diagnosis: null };
      tracks.set(key, tr);
      if (!(rule.forMs > 0)) activate(key, tr, now);
      continue;
    }
    t.rule = rule; t.target = target;
    if (t.phase === 'pending' && now - t.since >= (rule.forMs || 0)) activate(key, t, now);
    else if (t.phase === 'resolving') { t.phase = 'active'; t.falseSince = 0; }
  }

  for (const [key, t] of tracks) {
    if (trueKeys.has(key)) continue;
    if (t.phase === 'pending') { tracks.delete(key); continue; }
    if (t.phase === 'active') { t.phase = 'resolving'; t.falseSince = now; }
    if (t.phase === 'resolving' && now - t.falseSince >= (t.rule.clearMs || 0)) resolveTrack(key, t, now);
  }

  state.alerts = build(now);
  return state.alerts;
}

function build(now) {
  recentOpens = recentOpens.filter((ts) => ts > now - 86400000);
  const active = [];
  const silencedKeys = [];
  const silenceMaxMs = C.ALERT_SILENCE_MAX_DAYS * 86400000;
  for (const [key, t] of tracks) {
    if (t.phase !== 'active' && t.phase !== 'resolving') continue;
    const sTs = silences.get(key);
    if (sTs != null) {
      if (now - sTs >= silenceMaxMs) {
        // pojistka: výstraha hoří i po N dnech skrytí → skrytí vyprší, výstraha se vrací
        clearSilence(key);
        recordEvent('alert', t.rule.severity, SEV_ICON[t.rule.severity] || '⚠',
          `Skrytí vypršelo (${C.ALERT_SILENCE_MAX_DAYS} d) a výstraha stále platí: ${t.text}`, t.rule.link || null);
      } else {
        silencedKeys.push(key); // skrytá: mimo active i mimo state (nebarví jádro)
        continue;
      }
    }
    active.push({
      id: t.dbId, key, rule: t.rule.id, severity: t.rule.severity,
      openedTs: t.openedTs, ackTs: t.ackTs, text: t.text, link: t.rule.link || null, diagnosis: t.diagnosis,
      // interaktivní vlákno k výstraze (threads.js): {status,queuePos,waiting,lastLine}
      // — jede v patchích automaticky (string-compare níž zachytí každou změnu)
      thread: threads.info(key),
    });
  }
  active.sort((a, b) => (a.severity === b.severity ? b.openedTs - a.openedTs : (a.severity === 'crit' ? -1 : 1)));
  const built = {
    state: active.some((a) => a.severity === 'crit') ? 'crit' : (active.length ? 'warn' : 'ok'),
    active,
    count24h: recentOpens.length,
    silencedCount: silencedKeys.length, // chip „✕ skryté: N" v patičce panelu
    silencedKeys,                       // tooltip chipu (seznam klíčů)
  };
  const str = JSON.stringify(built);
  if (str === lastBuiltStr && lastBuilt) return lastBuilt; // unchanged ⇒ same ref ⇒ stream skips it
  lastBuilt = built; lastBuiltStr = str;
  return built;
}

// Okamžitý rebuild state.alerts mimo evaluate tick — volá threads.js při
// přechodech vlákna, aby chip ve VÝSTRAHÁCH neskákal až s dalším 8s tickem.
export function rebuildAlerts(state) {
  lastBuiltStr = '';
  state.alerts = build(Date.now());
}

// Kontext pro první tah vlákna (threads.js): text výstrahy + výřez snapshotu
// stejnou cestou jako one-shot diagnóza. null = výstraha už není aktivní.
export function threadContext(key) {
  const t = tracks.get(key);
  if (!t || (t.phase !== 'active' && t.phase !== 'resolving')) return null;
  return {
    key, text: t.text || '', rule: t.rule?.id || '?',
    severity: t.rule?.severity || 'warn', link: t.rule?.link || null,
    excerpt: snapshotExcerpt(t),
  };
}

function snapshotExcerpt(t) {
  const section = t.rule?.path ? t.rule.path.split('.')[0] : null;
  let excerpt = '{}';
  try {
    excerpt = JSON.stringify({ vystraha: compactTarget(t.target), [section || 'stav']: section ? getPath(lastState || {}, section) : undefined });
  } catch { /* keep '{}' */ }
  if (excerpt.length > 4000) excerpt = excerpt.slice(0, 4000) + '…';
  return excerpt;
}

function pruneMaybe(now, force = false) {
  if (!force && now - lastPrune < 86400000) return;
  lastPrune = now;
  try {
    const d = db_();
    const cut = now - C.ALERT_HISTORY_RETENTION_DAYS * 86400000;
    d.prepare('DELETE FROM alerts WHERE openedTs < ?').run(cut);
    d.prepare('DELETE FROM events WHERE ts < ?').run(cut);
    d.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (e) { console.error('[alerts] prune', e.message); }
}

// ---------- timeline events ----------
export function recordEvent(source, severity, icon, text, link = null) {
  const ts = Date.now();
  const txt = String(text || '').slice(0, 500);
  try { db_().prepare('INSERT INTO events (ts, source, severity, icon, text, link) VALUES (?,?,?,?,?,?)').run(ts, source, severity, icon, txt, link); }
  catch (e) { console.error('[alerts] event', e.message); }
  try { stream.pushTimeline({ ts, source, severity, icon, text: txt, link }); } catch { /* never break a caller */ }
  try { timeline.noteLive({ ts, source, severity, icon, text: txt, link }); } catch { /* never break a caller */ }
}

// ---------- actions (alert.silence / alert.ack / alert.diagnose, wired from server.runAction) ----------
export function handleAction(body) {
  const { type, id, key } = body || {};

  // „Skrýt do vyřešení" — adresováno KLÍČEM (ne dbId): skrytí se váže na epizodu
  // klíče, podrobná sémantika viz hlavička modulu (sekce Silences).
  if (type === 'alert.silence') {
    const k = typeof key === 'string' ? key : '';
    const t = tracks.get(k);
    if (!t || (t.phase !== 'active' && t.phase !== 'resolving')) return { ok: false, error: 'výstraha už není aktivní' };
    if (silences.has(k)) return { ok: true, action: 'výstraha už je skrytá' };
    // Guard: nad výstrahou běží/čeká vlákno → skrýt ji by schovalo i jeho chip
    // (vlákna se na výstrahy věší přes key). Vynuceno tady, ne jen v UI.
    const th = threads.info(k);
    if (th && (th.status === 'running' || th.status === 'waiting' || th.status === 'queued')) {
      return { ok: false, error: 'nejdřív ukonči vlákno — nad touto výstrahou právě běží/čeká' };
    }
    const now = Date.now();
    silences.set(k, now);
    try { db_().prepare('INSERT OR REPLACE INTO silences (key, silencedTs) VALUES (?,?)').run(k, now); }
    catch (e) { console.error('[alerts] silence', e.message); }
    lastBuiltStr = ''; // další evaluate tick ji vyřadí z active (server po akci kopne fastRefresh)
    recordEvent('alert', 'info', '✕', `Skryto uživatelem: ${t.text} (do vyřešení, max ${C.ALERT_SILENCE_MAX_DAYS} dní)`, t.rule.link || null);
    return { ok: true, action: 'výstraha skryta do vyřešení' };
  }

  const dbId = Number(id);
  if (!Number.isFinite(dbId)) return { ok: false, error: 'bad alert id' };
  const entry = [...tracks.values()].find((t) => t.dbId === dbId);

  // POZN.: tlačítko „✓ potvrdit" bylo z UI odstraněno (2026-06-11 — mátlo,
  // výstrahu nijak neskrývalo; nahrazeno alert.silence výš). Endpoint i sloupec
  // ackTs zůstávají pro kompatibilitu (staré klienty / historická data).
  if (type === 'alert.ack') {
    const now = Date.now();
    try { db_().prepare('UPDATE alerts SET ackTs=? WHERE id=? AND ackTs IS NULL').run(now, dbId); }
    catch (e) { return { ok: false, error: e.message }; }
    if (entry) { entry.ackTs = now; lastBuiltStr = ''; }
    return { ok: true, action: 'výstraha potvrzena', ackTs: now };
  }

  if (type === 'alert.diagnose') {
    if (!entry) return { ok: false, error: 'výstraha už není aktivní' };
    // Manual trigger: same RAM/busy gates as auto, but NO severity gate and no
    // hourly budget (the user asked explicitly).
    const memPct = lastState?.system?.mem?.usedPct;
    if (memPct != null && memPct > C.ALERT_DIAGNOSE_MAX_MEM_PCT) { setDiagnosis(entry, 'skipped (RAM)'); return { ok: false, error: `RAM ${memPct} % > ${C.ALERT_DIAGNOSE_MAX_MEM_PCT} % — diagnóza odložena` }; }
    if (jarvis.isBusy() || lastState?.jarvisBusy) return { ok: false, error: 'Jarvis právě pracuje — zkus to za chvíli' };
    startDiagnosis(entry, true);
    return { ok: true, action: 'diagnóza spuštěna', note: 'výsledek dorazí do výstrahy a do timeline' };
  }

  return { ok: false, error: 'unknown alert action' };
}

// ---------- diagnosis (auto on crit+diagnose rules, manual via alert.diagnose) ----------
// Guards IN ORDER: (1) RAM pressure (a claude subprocess is 200–400 MB — never
// pile onto a box already over the limit), (2) Jarvis busy → ONE retry after
// 120 s, (3) sliding-window budget MAX_PER_HOUR.
function autoDiagnose(t, retried = false) {
  const memPct = lastState?.system?.mem?.usedPct;
  if (memPct != null && memPct > C.ALERT_DIAGNOSE_MAX_MEM_PCT) return setDiagnosis(t, 'skipped (RAM)');
  if (jarvis.isBusy() || lastState?.jarvisBusy) {
    if (retried) return setDiagnosis(t, 'skipped (busy)');
    setTimeout(() => { if (t.phase === 'active' || t.phase === 'resolving') autoDiagnose(t, true); }, 120_000);
    return;
  }
  diagRuns = diagRuns.filter((ts) => ts > Date.now() - 3600_000);
  if (diagRuns.length >= C.ALERT_DIAGNOSE_MAX_PER_HOUR) return setDiagnosis(t, 'skipped (budget)');
  startDiagnosis(t, false);
}

function startDiagnosis(t, manual) {
  diagRuns.push(Date.now());
  const ruleId = t.rule?.id || '?';
  const excerpt = snapshotExcerpt(t);
  const prompt = `Mission Control vyhlásil výstrahu (pravidlo ${ruleId}, severity ${t.rule?.severity}):\n„${t.text}"\n\nRelevantní výřez ze stavového snapshotu:\n${excerpt}\n\nDiagnostikuj pravděpodobnou příčinu, nic neměň, max 6 vět.`;
  console.log(`[alerts] diagnosis ${manual ? 'manual' : 'auto'} start: ${ruleId} #${t.dbId}`);
  let out = '';
  jarvis.runJarvis(prompt, (ev) => {
    if (ev.type === 'text' && ev.text) out += ev.text;
    else if (ev.type === 'error' && !out) out = `diagnóza selhala: ${ev.error}`;
    else if (ev.type === 'aborted' && !out) out = 'diagnóza přerušena';
  }, { model: C.ALERT_DIAGNOSE_MODEL, effort: C.ALERT_DIAGNOSE_EFFORT, maxMs: C.ALERT_DIAGNOSE_MAX_MS, auto: true }).then(() => {
    const text = (out || 'diagnóza nevrátila žádný text').trim().slice(0, 2000);
    setDiagnosis(t, text);
    recordEvent('diagnosis', t.rule?.severity || 'info', '◆', `Diagnóza (${ruleId}): ${text.slice(0, 300)}`, t.rule?.link || null);
    console.log(`[alerts] diagnosis done: ${ruleId} #${t.dbId} (${text.length} chars)`);
  });
}

function setDiagnosis(t, text) {
  t.diagnosis = text;
  lastBuiltStr = ''; // next evaluate tick rebuilds state.alerts → patch carries it
  if (t.dbId == null) return;
  try {
    const d = db_();
    const row = d.prepare('SELECT meta FROM alerts WHERE id=?').get(t.dbId);
    let meta = {}; try { meta = JSON.parse(row?.meta || '{}'); } catch { /* keep {} */ }
    meta.diagnosis = text;
    d.prepare('UPDATE alerts SET meta=? WHERE id=?').run(JSON.stringify(meta), t.dbId);
  } catch (e) { console.error('[alerts] meta', e.message); }
}

// ---------- boot ----------
export function init() {
  let d;
  try { d = db_(); } catch (e) { console.error('[alerts] init db', e.message); return; }
  const now = Date.now();
  try { recentOpens = d.prepare('SELECT openedTs FROM alerts WHERE openedTs > ?').all(now - 86400000).map((r) => Number(r.openedTs)); } catch { /* fresh db */ }
  try { for (const r of d.prepare('SELECT key, silencedTs FROM silences').all()) silences.set(String(r.key), Number(r.silencedTs)); } catch { /* fresh db */ }
  let rows = [];
  try { rows = d.prepare('SELECT id, key, rule, severity, openedTs, ackTs, text, meta FROM alerts WHERE resolvedTs IS NULL ORDER BY id').all(); } catch { /* fresh db */ }
  // Dedup otevřených řádků per klíč (incident 2026-06-11: traffic-drop měl
  // otevřené ids 4 i 15): restore smí klíč nárokovat jen JEDNOU — necháme
  // NEJNOVĚJŠÍ řádek (nejvyšší id), starší zavřeme jako duplicity. Bez toho
  // by starší řádek zůstal otevřený navždy (tracks.set by ho jen přepsal).
  let deduped = 0;
  const byKey = new Map();
  for (const r of rows) {
    const prev = byKey.get(r.key);
    if (prev) {
      try { d.prepare(`UPDATE alerts SET resolvedTs=?, meta=json_patch(COALESCE(meta,'{}'), '{"stale":"duplicate open row"}') WHERE id=?`).run(now, prev.id); deduped++; }
      catch (e) { console.error('[alerts] dedupe', e.message); }
    }
    byKey.set(r.key, r); // ORDER BY id ⇒ poslední viděný = nejnovější
  }
  let restored = 0;
  for (const r of byKey.values()) {
    const rule = C.ALERT_RULES.find((x) => x.id === r.rule);
    if (!rule) {
      // rule disappeared from config → close the row as stale (documented choice)
      try { d.prepare("UPDATE alerts SET resolvedTs=?, meta=json_patch(COALESCE(meta,'{}'), '{\"stale\":\"rule removed\"}') WHERE id=?").run(now, r.id); } catch { /* json1 always built-in */ }
      continue;
    }
    let diagnosis = null;
    try { diagnosis = JSON.parse(r.meta || '{}').diagnosis || null; } catch { /* ignore */ }
    tracks.set(r.key, {
      rule, target: {}, phase: 'active',
      since: Number(r.openedTs), falseSince: 0,
      dbId: Number(r.id), openedTs: Number(r.openedTs),
      ackTs: r.ackTs != null ? Number(r.ackTs) : null,
      text: r.text, diagnosis,
    });
    restored++;
  }
  // Osiřelá skrytí (klíč bez otevřené výstrahy — resolve proběhl, když MC
  // neběžel, nebo pravidlo zmizelo z configu) by jinak skryla BUDOUCÍ epizodu.
  for (const k of [...silences.keys()]) if (!tracks.has(k)) clearSilence(k);
  pruneMaybe(now, true);
  if (deduped) console.log(`[alerts] closed ${deduped} duplicate open row(s) at boot`);
  if (restored) console.log(`[alerts] restored ${restored} open alert(s) from db`);
  if (silences.size) console.log(`[alerts] ${silences.size} silence(s) active`);
}
