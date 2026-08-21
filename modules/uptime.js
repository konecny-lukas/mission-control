// Mission Control — external website uptime probing + history.
// Probes a fixed allowlist of sites (config.UPTIME_SITES) every minute, persists
// each check to a local sqlite db, and derives per-site + overall uptime stats.
// Like the collectors, everything is defensive: a failed probe is recorded as a
// "down" data point, never thrown, so the loop can't die.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as C from '../config.js';

let db = null;
function db_() {
  if (db) return db;
  fs.mkdirSync(C.DATA_DIR, { recursive: true });
  const d = new DatabaseSync(C.UPTIME_DB);
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec(`CREATE TABLE IF NOT EXISTS checks (
    site   TEXT    NOT NULL,
    ts     INTEGER NOT NULL,
    up     INTEGER NOT NULL,
    ms     INTEGER,
    status INTEGER
  );`);
  d.exec('CREATE INDEX IF NOT EXISTS idx_checks_site_ts ON checks(site, ts);');
  db = d;
  return db;
}

// One HTTP probe. "up" = the server answered with a non-error status (<400).
// We GET (some hosts reject HEAD), follow redirects, and discard the body.
async function probeSite(site) {
  const t0 = Date.now();
  try {
    const res = await fetch(site.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'MissionControl-Uptime/1.0' },
      signal: AbortSignal.timeout(C.UPTIME_TIMEOUT_MS),
    });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    const ms = Date.now() - t0;
    return { id: site.id, up: res.status >= 200 && res.status < 400 ? 1 : 0, ms, status: res.status };
  } catch {
    return { id: site.id, up: 0, ms: Date.now() - t0, status: 0 };
  }
}

// Probe every site once, persist the results, prune old rows. Safe on a timer.
export async function probeUptime() {
  let d; try { d = db_(); } catch (e) { console.error('[uptime] db open', e); return []; }
  const ts = Date.now();
  const results = await Promise.all(C.UPTIME_SITES.map(probeSite));
  try {
    const ins = d.prepare('INSERT INTO checks (site, ts, up, ms, status) VALUES (?, ?, ?, ?, ?)');
    for (const r of results) ins.run(r.id, ts, r.up, r.ms, r.status);
    d.prepare('DELETE FROM checks WHERE ts < ?').run(ts - C.UPTIME_RETENTION_DAYS * 86400000);
  } catch (e) {
    console.error('[uptime] insert', e);
  }
  return results;
}

const DAY = 86400000;

// Build the snapshot the dashboard renders: per-site stats + an overall roll-up.
// Cheap enough to call on the refresh loop, but data only changes once a minute.
export function collectUptime() {
  let d; try { d = db_(); } catch { return null; }
  const now = Date.now();
  const ratio = (site, since) => {
    const r = d.prepare('SELECT COUNT(*) n, COALESCE(SUM(up),0) u FROM checks WHERE site=? AND ts>=?').get(site, since);
    return r && r.n ? { n: r.n, pct: (Number(r.u) / r.n) * 100 } : { n: 0, pct: null };
  };

  const sites = C.UPTIME_SITES.map((s) => {
    const recent = d.prepare('SELECT ts, up, ms, status FROM checks WHERE site=? ORDER BY ts DESC LIMIT 60').all(s.id);
    const last = recent[0] || null;
    const prev = recent[1] || null;
    const d24 = ratio(s.id, now - DAY);
    const d7 = ratio(s.id, now - 7 * DAY);
    const avg = d.prepare('SELECT AVG(ms) a FROM checks WHERE site=? AND up=1 AND ts>=?').get(s.id, now - DAY);
    // Debounce: a single failed check is just "warn"; two in a row is a real outage.
    let state = 'unknown';
    if (last) state = last.up ? 'ok' : (prev && !prev.up ? 'crit' : 'warn');
    return {
      id: s.id, label: s.label, url: s.url, state,
      up: last ? !!last.up : null,
      lastTs: last ? last.ts : null,
      lastMs: last ? last.ms : null,
      lastStatus: last ? last.status : null,
      pct24: d24.pct, n24: d24.n,
      pct7: d7.pct, n7: d7.n,
      avgMs: avg && avg.a != null ? Math.round(avg.a) : null,
      spark: recent.map((r) => (r.up ? 1 : 0)).reverse(), // oldest-first status strip
    };
  });

  const tot = d.prepare('SELECT COUNT(*) n, COALESCE(SUM(up),0) u FROM checks WHERE ts>=?').get(now - DAY);
  const overallPct = tot && tot.n ? (Number(tot.u) / tot.n) * 100 : null;
  const downNow = sites.filter((x) => x.state === 'crit').length;
  const warnNow = sites.filter((x) => x.state === 'warn').length;
  const haveData = sites.some((x) => x.up !== null);
  return {
    state: haveData ? (downNow ? 'crit' : warnNow ? 'warn' : 'ok') : 'unknown',
    overallPct,
    sitesUp: sites.filter((x) => x.up === true).length,
    sitesTotal: sites.length,
    downNow, warnNow,
    checkedAt: sites.reduce((m, x) => Math.max(m, x.lastTs || 0), 0) || null,
    sites,
  };
}
