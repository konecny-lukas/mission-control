// Mission Control — VPS network transfer totals (today + last 24 h).
// /proc/net/dev only exposes cumulative byte counters since boot, so to get
// windowed totals we periodically sample the real-NIC counters and accumulate a
// monotonic "lifetime" sum of positive deltas (a counter that goes backwards =
// a reboot → count the new value from zero). Window totals are then just
// life_now − life_at(window_start). Persisted to sqlite so the totals survive a
// Mission Control restart. Defensive throughout: a failed read is skipped, never
// thrown, so the sampler can't die.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as C from './config.js';

const DAY = 86400000;

let db = null;
function db_() {
  if (db) return db;
  fs.mkdirSync(C.DATA_DIR, { recursive: true });
  const d = new DatabaseSync(C.NETSTAT_DB);
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec(`CREATE TABLE IF NOT EXISTS samples (
    ts     INTEGER PRIMARY KEY,
    raw_rx INTEGER, raw_tx INTEGER,
    life_rx INTEGER, life_tx INTEGER
  );`);
  db = d;
  return db;
}

// Same real-NIC filter as the live rate in collectors.js (eth0 etc.; drops
// loopback + docker/veth/bridge/tailscale/wireguard virtuals).
function readCounters() {
  let rx = 0, tx = 0;
  for (const ln of fs.readFileSync('/proc/net/dev', 'utf-8').split('\n')) {
    const m = ln.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    if (/^(lo|docker|veth|br-|tailscale|wg|virbr|cni|flannel|kube|tun)/.test(m[1].trim())) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    rx += f[0] || 0; tx += f[8] || 0;
  }
  return { rx, tx };
}

// Take one sample: accumulate the delta since the last sample into the lifetime
// totals (reset-safe), persist, prune. Call on a timer.
export function sampleNet() {
  let d; try { d = db_(); } catch (e) { console.error('[netstat] db', e); return; }
  let cur; try { cur = readCounters(); } catch (e) { console.error('[netstat] read', e.message); return; }
  const now = Date.now();
  const last = d.prepare('SELECT raw_rx, raw_tx, life_rx, life_tx FROM samples ORDER BY ts DESC LIMIT 1').get();
  let lifeRx, lifeTx;
  if (last) {
    const dRx = cur.rx >= last.raw_rx ? cur.rx - last.raw_rx : cur.rx; // backwards = reboot → from 0
    const dTx = cur.tx >= last.raw_tx ? cur.tx - last.raw_tx : cur.tx;
    lifeRx = last.life_rx + dRx; lifeTx = last.life_tx + dTx;
  } else {
    lifeRx = 0; lifeTx = 0; // first sample = baseline; totals accumulate from here
  }
  try {
    d.prepare('INSERT OR REPLACE INTO samples (ts, raw_rx, raw_tx, life_rx, life_tx) VALUES (?,?,?,?,?)')
      .run(now, cur.rx, cur.tx, lifeRx, lifeTx);
    d.prepare('DELETE FROM samples WHERE ts < ?').run(now - 4 * DAY); // keep 4 days
  } catch (e) { console.error('[netstat] insert', e.message); }
}

// Timestamp of the most recent 00:00 in Europe/Prague (the user's day boundary),
// independent of the server's own timezone.
function pragueMidnight(now) {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now));
    const g = (t) => Number(p.find((x) => x.type === t)?.value || 0);
    const secsIntoDay = g('hour') * 3600 + g('minute') * 60 + g('second');
    return now - secsIntoDay * 1000;
  } catch { return now - (now % DAY); }
}

// Build the snapshot the panel reads: today + last-24 h totals per direction,
// plus how far back our samples actually reach (so the UI can flag a not-yet-full
// window right after a fresh start).
export function collectNetstat() {
  let d; try { d = db_(); } catch { return null; }
  const now = Date.now();
  const cur = d.prepare('SELECT life_rx, life_tx FROM samples ORDER BY ts DESC LIMIT 1').get();
  if (!cur) return { ready: false };
  const earliest = d.prepare('SELECT ts, life_rx, life_tx FROM samples ORDER BY ts ASC LIMIT 1').get();
  // last sample at or before `since`; fall back to the earliest sample we have
  const baseAt = (since) => d.prepare('SELECT life_rx, life_tx FROM samples WHERE ts <= ? ORDER BY ts DESC LIMIT 1').get(since) || earliest;
  const dayStart = pragueMidnight(now);
  const day = baseAt(dayStart);
  const win = baseAt(now - DAY);
  return {
    ready: true,
    todayRx: Math.max(0, cur.life_rx - day.life_rx),
    todayTx: Math.max(0, cur.life_tx - day.life_tx),
    d24Rx: Math.max(0, cur.life_rx - win.life_rx),
    d24Tx: Math.max(0, cur.life_tx - win.life_tx),
    sinceTs: earliest.ts,
    fullDay: earliest.ts <= dayStart,   // have we been sampling since midnight?
    full24: earliest.ts <= now - DAY,   // do we have a full 24 h of history?
  };
}
