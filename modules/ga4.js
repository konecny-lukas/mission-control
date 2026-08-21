// Mission Control — návštěvnost z Google Analytics 4 (Data API v1beta).
//
// Generický port ga4.js z původního interního Mission Control — vychází
// z research přípravy balíčku (mapa modulů, §1-§7, ga4). Config
// (GA4_SITES / cesty / kadence) žije v config.js jako u sourozenců (uptime.js);
// tvar modulu = refresh fn bez argumentů + buildGa4Section() čistě z DB
// (zapojeno v server.js: ga4Refresh / ga4LiveRefresh smyčky + state.ga4).
//
// Co sbírá (per GA4 property, z CFG.modules.ga4.sites):
//   • denní řada 35 dní zpět: sessions / activeUsers (denní unikáti) /
//     screenPageViews → tabulka ga4_daily (upsert per site+den)
//   • realtime: activeUsers právě teď (runRealtimeReport) → ga4_live, drží se 24 h
//
// INTRADAY LAG: GA4 čísla pro dnešek (a často i včerejšek) jsou neúplná, dokud
// neproběhne denní zpracování (typicky do 24–48 h). Řešíme to tak, že KAŽDÝ
// refresh stahuje a upsertuje celé 35denní okno — koncové (částečné) dny se tak
// při dalších bězích samy dokonvergují, žádná zvláštní logika není potřeba.
//
// OVĚŘENÍ HOSTNAME: mapování web→property se při každém plném refreshi ověřuje
// runReportem na dimenzi hostName (7 d). Sbíráme JEN z properties, jejichž
// dominantní hostname (po oříznutí „www.") sedí na očekávanou doménu — mismatch
// se zaloguje, uloží do ga4_meta a property se ten běh přeskočí. Nikdy nehádáme.
//
// KVÓTY: Data API core = 25 000 tokenů/den/property; realtime má vlastní pool.
// Plný refresh = 2×N requestů (N properties × hostname+daily, realtime běží
// souběžně s daily) — i při běhu každých 30 min řádově pod limitem. Na 429/5xx
// je jednoduchý backoff (respektuje Retry-After, max 2 opakování).
//
// Auth: modules/google-auth.js (createTokenProvider) — sdílené s budoucími
// gsc/indexace moduly, service account NEBO OAuth installed-app refresh token
// (auto-detekce podle obsahu keyFile). Klíč se NIKDY nepřepisuje. Vše
// defenzivní: chybující property/report se zaloguje a přeskočí, refresh smyčka
// nikdy nespadne. Zero deps (node:sqlite DatabaseSync).
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as C from '../config.js';
import { createTokenProvider, googleApiPost } from './google-auth.js';

const API = 'https://analyticsdata.googleapis.com/v1beta';
const DAY = 86400000;

// Token provider se vytváří jednou při importu modulu — nečte keyFile hned
// (google-auth.js ho čte líně až při prvním skutečném volání), takže import
// samotný nemá žádný I/O side-effect (bezpečné i v testech bez sítě).
const getToken = createTokenProvider({ keyFile: C.GA4_KEY_FILE, timeoutMs: C.GA4_TIMEOUT_MS, tag: 'ga4' });

// GA4 vrací datum jako YYYYMMDD; v DB držíme YYYY-MM-DD jako sourozenci.
const ymdFromGa = (s) => `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}`;
// „Dnes/včera" v timezoně z configu (GA4_TZ, default Europe/Prague) — sites
// jsou typicky weby v jedné časové zóně, takže to sedí na date dimenzi z GA4.
const ymdInTz = (tz, ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(ms);
const num = (mv) => Math.round(Number(mv?.value || 0)) || 0;
const normHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

let db = null;
function db_() {
  if (db) return db;
  fs.mkdirSync(C.DATA_DIR, { recursive: true });
  const d = new DatabaseSync(C.GA4_DB);
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec(`CREATE TABLE IF NOT EXISTS ga4_daily (
    site      TEXT NOT NULL,
    day       TEXT NOT NULL,
    sessions  INTEGER,
    users     INTEGER,
    pageviews INTEGER,
    PRIMARY KEY (site, day)
  );`);
  // Realtime pulz — každé měření nový řádek, drží se 24 h (mini-graf v draweru).
  d.exec(`CREATE TABLE IF NOT EXISTS ga4_live (
    site   TEXT    NOT NULL,
    ts     INTEGER NOT NULL,
    active INTEGER,
    PRIMARY KEY (site, ts)
  );`);
  // meta: 'refresh' = ts posledního úspěšného běhu; 'hosts' = výsledek ověření
  // hostname per property (JSON), aby ho viděl i lehký live-refresh a dashboard.
  d.exec(`CREATE TABLE IF NOT EXISTS ga4_meta (
    key  TEXT PRIMARY KEY,
    ts   INTEGER,
    json TEXT
  );`);
  db = d;
  return db;
}

// Jeden POST na Data API s backoffem na 429/5xx (respektuje Retry-After, max 2
// opakování). Vrací parsed JSON, nebo null — volající chybějící report přeskočí.
// Tenký adaptér nad sdíleným modules/google-auth.js googleApiPost (dřív tu byla
// vlastní kopie backoff smyčky, identická s gsc.js query() — viz Task 10).
const apiPost = (token, url, body, tag) =>
  googleApiPost({ url, token, body, timeoutMs: C.GA4_TIMEOUT_MS, tag: `ga4 ${tag}` });

const runReport = (token, property, body, tag) =>
  apiPost(token, `${API}/properties/${property}:runReport`, body, tag);

// Ověření web→property: hostName report za 7 d, dominantní hostname (nejvíc
// sessions, bez www.) se musí rovnat očekávané doméně. Při selhání reportu se
// použije poslední uložený výsledek (transientní výpadek ≠ mismatch). Dobrá
// pojistka proti prohozeným/přejmenovaným properties — nikdy nehádáme.
async function verifyHosts(token, d) {
  let prev = {};
  try { const r = d.prepare(`SELECT json FROM ga4_meta WHERE key='hosts'`).get(); if (r) prev = JSON.parse(r.json); } catch { /* ignore */ }

  const out = {};
  for (const s of C.GA4_SITES) {
    const rep = await runReport(token, s.property, {
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'hostName' }],
      metrics: [{ name: 'sessions' }],
      limit: '50',
    }, `${s.id} hostName`);
    if (!rep) {
      out[s.id] = prev[s.id] || { ok: false, expected: s.host, top: null, hosts: [], error: 'report failed, no previous' };
      if (!prev[s.id]) console.error(`[ga4] ${s.id}: hostname ověření selhalo a není předchozí výsledek — property se přeskočí`);
      continue;
    }
    const hosts = (rep.rows || [])
      .map((r) => ({ host: r.dimensionValues?.[0]?.value || '', sessions: num(r.metricValues?.[0]) }))
      .sort((a, b) => b.sessions - a.sessions);
    const top = hosts[0]?.host || null;
    const ok = normHost(top) === s.host;
    // reason: 'mismatch' = property měří jinou doménu; 'no-data' = property za
    // 7 d nemá vůbec žádná data (hostname nejde potvrdit) — obojí se přeskakuje.
    const reason = ok ? null : (top == null ? 'no-data' : 'mismatch');
    out[s.id] = { ok, reason, expected: s.host, top, hosts: hosts.slice(0, 5) };
    if (reason === 'mismatch') console.error(`[ga4] MISMATCH ${s.id}: property ${s.property} hlásí hostname „${top}", čekáme „${s.host}" — přeskakuji`);
    if (reason === 'no-data') console.error(`[ga4] ${s.id}: property ${s.property} nemá za 7 d žádná data, hostname nejde ověřit — přeskakuji`);
  }
  try {
    d.prepare(`INSERT INTO ga4_meta (key, ts, json) VALUES ('hosts', ?, ?)
      ON CONFLICT(key) DO UPDATE SET ts=excluded.ts, json=excluded.json`).run(Date.now(), JSON.stringify(out));
  } catch (e) { console.error('[ga4] hosts meta', e.message); }
  return out;
}

// ---- Plný refresh: hostname ověření + denní řady + realtime ----
// Bezpečné volat na timeru. Properties se zpracují sekvenčně (daily+realtime
// uvnitř webu běží souběžně) — hluboko pod per-minute kvótami Data API.
export async function refreshGa4() {
  let token; try { token = await getToken(); } catch (e) { console.error('[ga4]', e.message); return; }
  let d; try { d = db_(); } catch (e) { console.error('[ga4] db open', e); return; }

  const now = Date.now();
  const hosts = await verifyHosts(token, d);

  const upDaily = d.prepare(`INSERT INTO ga4_daily (site, day, sessions, users, pageviews)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(site, day) DO UPDATE SET
      sessions=excluded.sessions, users=excluded.users, pageviews=excluded.pageviews`);
  const insLive = d.prepare(`INSERT INTO ga4_live (site, ts, active) VALUES (?, ?, ?)
    ON CONFLICT(site, ts) DO UPDATE SET active=excluded.active`);

  // 35 dní vč. dneška; celé okno se upsertuje při každém běhu (viz hlavička —
  // tím se částečné koncové dny průběžně dokonvergují).
  const dateRanges = [{ startDate: '34daysAgo', endDate: 'today' }];

  for (const s of C.GA4_SITES) {
    if (!hosts[s.id]?.ok) continue; // mismatch / neověřeno → nesbíráme, nehádáme
    const [daily, rt] = await Promise.all([
      runReport(token, s.property, {
        dateRanges,
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'screenPageViews' }],
        limit: '100',
      }, `${s.id} daily`),
      apiPost(token, `${API}/properties/${s.property}:runRealtimeReport`,
        { metrics: [{ name: 'activeUsers' }] }, `${s.id} realtime`),
    ]);

    try {
      for (const r of (daily?.rows || [])) {
        upDaily.run(s.id, ymdFromGa(r.dimensionValues[0].value),
          num(r.metricValues[0]), num(r.metricValues[1]), num(r.metricValues[2]));
      }
    } catch (e) { console.error(`[ga4] ${s.id} daily upsert`, e.message); }

    // Prázdné rows při 0 aktivních = legitimní nula (report sám prošel).
    if (rt) {
      const active = rt.rows?.length ? num(rt.rows[0].metricValues?.[0]) : 0;
      try { insLive.run(s.id, now, active); } catch (e) { console.error(`[ga4] ${s.id} live`, e.message); }
    }
  }

  // Úklid: live jen 24 h zpět, denní řady držíme 180 d (spark potřebuje 28).
  try { d.prepare('DELETE FROM ga4_live WHERE ts < ?').run(now - 24 * 3600 * 1000); } catch { /* ignore */ }
  const cutoff = ymdInTz(C.GA4_TZ, now - 180 * DAY);
  try { d.prepare('DELETE FROM ga4_daily WHERE day < ?').run(cutoff); } catch { /* ignore */ }
  try {
    d.prepare(`INSERT INTO ga4_meta (key, ts, json) VALUES ('refresh', ?, NULL)
      ON CONFLICT(key) DO UPDATE SET ts=excluded.ts`).run(now);
  } catch { /* ignore */ }
}

// ---- Lehký, častý refresh jen realtime ukazatele (1 request/web) ----
// Používá poslední uložené hostname ověření — bez něj (první běh) se web přeskočí
// a počká se na plný refreshGa4().
export async function refreshGa4Live() {
  let token; try { token = await getToken(); } catch (e) { console.error('[ga4] live:', e.message); return; }
  let d; try { d = db_(); } catch (e) { console.error('[ga4] live db open', e); return; }

  let hosts = {};
  try { const r = d.prepare(`SELECT json FROM ga4_meta WHERE key='hosts'`).get(); if (r) hosts = JSON.parse(r.json); } catch { /* ignore */ }

  const now = Date.now();
  const insLive = d.prepare(`INSERT INTO ga4_live (site, ts, active) VALUES (?, ?, ?)
    ON CONFLICT(site, ts) DO UPDATE SET active=excluded.active`);
  for (const s of C.GA4_SITES) {
    if (!hosts[s.id]?.ok) continue;
    const rt = await apiPost(token, `${API}/properties/${s.property}:runRealtimeReport`,
      { metrics: [{ name: 'activeUsers' }] }, `${s.id} realtime`);
    if (!rt) continue;
    const active = rt.rows?.length ? num(rt.rows[0].metricValues?.[0]) : 0;
    try { insLive.run(s.id, now, active); } catch (e) { console.error(`[ga4] ${s.id} live`, e.message); }
  }
  try { d.prepare('DELETE FROM ga4_live WHERE ts < ?').run(now - 24 * 3600 * 1000); } catch { /* ignore */ }
}

// ---- Snapshot pro server.js (state.ga4) — čistě čtení z DB ----
// d7/d28 = celé dny do včerejška (dnešek je kvůli intraday lagu částečný a je
// vidět zvlášť v `today`); spark = 28 celých dní sessions, oldest-first.
export function buildGa4Section() {
  let d; try { d = db_(); } catch { return { updatedAt: null, sites: [] }; }
  const now = Date.now();
  const today = ymdInTz(C.GA4_TZ, now);
  const yesterday = ymdInTz(C.GA4_TZ, now - DAY);
  const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const aggTrip = (rows) => ({ sessions: sum(rows, 'sessions'), users: sum(rows, 'users'), pv: sum(rows, 'pageviews') });
  const trip = (r) => r ? { sessions: r.sessions || 0, users: r.users || 0, pv: r.pageviews || 0 } : null;

  let updatedAt = null;
  try { const r = d.prepare(`SELECT ts FROM ga4_meta WHERE key='refresh'`).get(); updatedAt = r ? r.ts : null; } catch { /* ignore */ }

  // poslední živé měření per web; po 20 min ho bereme jako zastaralé (= null)
  let liveBy = {};
  try {
    for (const r of d.prepare(`SELECT site, ts, active FROM ga4_live WHERE (site, ts) IN
      (SELECT site, MAX(ts) FROM ga4_live GROUP BY site)`).all()) liveBy[r.site] = r;
  } catch { /* ignore */ }
  const liveFresh = (r) => r && r.ts && (now - r.ts) < 20 * 60 * 1000;

  const sites = C.GA4_SITES.map((s) => {
    let rows = [];
    try { rows = d.prepare('SELECT day, sessions, users, pageviews FROM ga4_daily WHERE site=? ORDER BY day DESC LIMIT 35').all(s.id); } catch { /* ignore */ }
    const full = rows.filter((r) => r.day <= yesterday); // bez částečného dneška
    const d7rows = full.slice(0, 7);
    const d28rows = full.slice(0, 28);
    const spark = d28rows.slice().reverse(); // oldest-first pro sparkline
    const lr = liveBy[s.id];
    return {
      id: s.id,
      label: s.label || s.id,
      host: s.host,
      today: trip(rows.find((r) => r.day === today)),
      d7: aggTrip(d7rows),
      d28: aggTrip(d28rows),
      live: liveFresh(lr) ? (lr.active | 0) : null,
      spark: spark.map((r) => r.sessions || 0),
    };
  });

  return { updatedAt, sites };
}
