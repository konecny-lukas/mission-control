// Mission Control — organická návštěvnost ze Search Console (Search Analytics API).
//
// Generický port gsc.js z původního interního Mission Control — vychází
// z research přípravy balíčku (mapa modulů, §1-§7, gsc). Zdrojový
// modul byl postaven kolem JEDNÉ property sliced regexovým filtrem na dimenzi
// „page" podle WPML jazykových verzí webu; tenhle port to nahrazuje smyčkou
// přes CFG.modules.gsc.sites[] — každý web má svou vlastní ověřenou property,
// ŽÁDNÝ regex slicing (žádné filtrování podle dimenze). Vypuštěn i zapečený
// analytický zdroj třetí strany, sdílená detailová databáze napříč moduly a
// starší zpětně kompatibilní pole — vše smazáno dle R2 §6.
//
// Co sbírá (per site, z CFG.modules.gsc.sites):
//   • denní řada (GSC_WINDOW_DAYS dní zpět): clicks/impressions/ctr/position
//     (dimensions ['date']) → tabulka daily (upsert per site+den)
//   • top 10 dotazů za posledních 28 celých dní (dimensions ['query'],
//     rowLimit 10) → snap (JSON blob, cache mezi refreshi — transientní chyba
//     API tak nechá poslední dobrý blob místo jeho vynulování)
//
// GSC LAG: data v Search Console jsou zpožděná typicky o 2–3 dny (poslední
// 1–2 dny bývají neúplné nebo úplně chybí). Konec okna je proto vždy
// `now - 3 dny`, přesně jako ve zdroji — žádné domýšlení dneška.
//
// Auth: modules/google-auth.js (createTokenProvider) — sdílené s ga4/budoucí
// indexace, service account NEBO OAuth installed-app refresh token (auto-
// detekce podle obsahu keyFile). Klíč se NIKDY nepřepisuje. Vše defenzivní:
// chybující web/report se zaloguje a přeskočí, refresh smyčka nikdy nespadne.
// Zero deps (node:sqlite DatabaseSync).
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as C from '../config.js';
import { createTokenProvider, googleApiPost } from './google-auth.js';

const SA = 'https://searchconsole.googleapis.com/webmasters/v3';
const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// Token provider se vytváří jednou při importu modulu — nečte keyFile hned
// (google-auth.js ho čte líně až při prvním skutečném volání), takže import
// samotný nemá žádný I/O side-effect (bezpečné i v testech bez sítě).
const getToken = createTokenProvider({ keyFile: C.GSC_KEY_FILE, timeoutMs: C.GSC_TIMEOUT_MS, tag: 'gsc' });

let db = null;
function db_() {
  if (db) return db;
  fs.mkdirSync(C.DATA_DIR, { recursive: true });
  const d = new DatabaseSync(C.GSC_DB);
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec(`CREATE TABLE IF NOT EXISTS daily (
    site        TEXT NOT NULL,
    day         TEXT NOT NULL,
    clicks      INTEGER,
    impressions INTEGER,
    ctr         REAL,
    position    REAL,
    PRIMARY KEY (site, day)
  );`);
  // Cache top dotazů (28 d) — JSON blob per web, přežije restart.
  d.exec(`CREATE TABLE IF NOT EXISTS snap (
    site TEXT PRIMARY KEY,
    ts   INTEGER,
    json TEXT
  );`);
  d.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, ts INTEGER);`);
  db = d;
  return db;
}

// Jeden POST na Search Analytics query s backoffem na 429/5xx (sdílená smyčka
// z modules/google-auth.js googleApiPost — dřív tu byla vlastní kopie,
// identická s ga4.js apiPost — viz Task 10). Vrací rows[] (může být prázdné)
// na úspěch, nebo null — volající chybějící report přeskočí. Tenký wrapper
// místo přímého googleApiPost: gsc si skládá vlastní per-property URL a
// z odpovědi chce jen `.rows`, ne celý JSON.
async function query(token, property, body, tag) {
  const url = `${SA}/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const j = await googleApiPost({ url, token, body, timeoutMs: C.GSC_TIMEOUT_MS, tag: `gsc ${tag}` });
  return j ? (j.rows || []) : null;
}

// ---- Plný refresh: denní řada + top dotazy (28 d) per web ----
// Bezpečné volat na timeru. Weby se zpracují sekvenčně (jejich 2 reporty běží
// souběžně) — hluboko pod per-minute kvótami Search Analytics API.
export async function refreshGSC() {
  let token; try { token = await getToken(); } catch (e) { console.error('[gsc]', e.message); return; }
  let d; try { d = db_(); } catch (e) { console.error('[gsc] db open', e); return; }

  const now = Date.now();
  const endDate = ymd(now - 3 * DAY); // GSC lag ~2–3 d — konec okna vždy 3 dny zpět, žádné domýšlení dneška
  const startDate = ymd(now - (C.GSC_WINDOW_DAYS + 3) * DAY);
  const qStart = ymd(now - (28 + 3) * DAY); // top dotazy = posledních 28 celých (stejně lagovaných) dní

  const upsert = d.prepare(`INSERT INTO daily (site, day, clicks, impressions, ctr, position)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(site, day) DO UPDATE SET
      clicks=excluded.clicks, impressions=excluded.impressions,
      ctr=excluded.ctr, position=excluded.position`);
  const putSnap = d.prepare(`INSERT INTO snap (site, ts, json) VALUES (?, ?, ?)
    ON CONFLICT(site) DO UPDATE SET ts=excluded.ts, json=excluded.json`);

  for (const s of C.GSC_SITES) {
    // GSC vrací řádky seřazené clicks-desc, takže holý rowLimit dá top N.
    const [daily, queries] = await Promise.all([
      query(token, s.property, { startDate, endDate, dimensions: ['date'], rowLimit: 1000 }, `${s.id} daily`),
      query(token, s.property, { startDate: qStart, endDate, dimensions: ['query'], rowLimit: 10 }, `${s.id} query`),
    ]);

    try {
      for (const r of (daily || [])) {
        upsert.run(s.id, r.keys[0], Math.round(r.clicks || 0), Math.round(r.impressions || 0),
          r.ctr != null ? r.ctr : null, r.position != null ? r.position : null);
      }
    } catch (e) { console.error(`[gsc] ${s.id} upsert`, e.message); }

    // Blob se přepíše jen když refresh skutečně vrátil dotazy — přechodná
    // chyba API tak nechá poslední dobrý výsledek, místo aby ho vynulovala.
    if (queries) {
      const blob = { queries: queries.map((r) => ({ q: r.keys[0], clicks: r.clicks | 0 })) };
      try { putSnap.run(s.id, now, JSON.stringify(blob)); } catch (e) { console.error(`[gsc] ${s.id} snap`, e.message); }
    }
  }

  const cutoff = ymd(now - (C.GSC_WINDOW_DAYS + 40) * DAY);
  try { d.prepare('DELETE FROM daily WHERE day < ?').run(cutoff); } catch { /* ignore */ }
  try {
    d.prepare(`INSERT INTO meta (key, ts) VALUES ('refresh', ?) ON CONFLICT(key) DO UPDATE SET ts=excluded.ts`).run(now);
  } catch { /* ignore */ }
}

// ---- Snapshot pro server.js (state.gsc) — čistě čtení z DB ----
// clicks28/impressions28/position28/spark = vždy posledních 28 nasbíraných
// dní (bez ohledu na GSC_WINDOW_DAYS, který jen řídí, kolik historie se
// stahuje/drží) — stejná konvence jako d28 u modules/ga4.js.
export function collectGSC() {
  let d; try { d = db_(); } catch { return { state: 'idle', updatedAt: null, sites: [] }; }
  const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);

  let refreshTs = null;
  try { const r = d.prepare(`SELECT ts FROM meta WHERE key='refresh'`).get(); refreshTs = r ? r.ts : null; } catch { /* ignore */ }

  const sites = C.GSC_SITES.map((s) => {
    let rows = [];
    try { rows = d.prepare('SELECT day, clicks, impressions, ctr, position FROM daily WHERE site=? ORDER BY day DESC LIMIT 28').all(s.id); } catch { /* ignore */ }
    const spark = rows.slice().reverse(); // oldest-first pro sparkline

    let snap = {};
    try { const r = d.prepare('SELECT json FROM snap WHERE site=?').get(s.id); if (r) snap = JSON.parse(r.json); } catch { /* ignore */ }

    const clicks28 = sum(rows, 'clicks');
    const impressions28 = sum(rows, 'impressions');
    // impression-weighted avg pozice (prostý průměr by přecenil dny s málo zobrazeními).
    let pn = 0, pd = 0;
    for (const r of rows) { if (r.position != null && r.impressions) { pn += r.position * r.impressions; pd += r.impressions; } }

    return {
      id: s.id,
      label: s.label || s.id,
      property: s.property,
      clicks28,
      impressions28,
      position28: pd ? pn / pd : null,
      spark: spark.map((r) => r.clicks || 0),
      topQueries: (snap.queries || []).slice(0, 10),
    };
  });

  const haveAny = sites.some((s) => s.clicks28 > 0 || s.impressions28 > 0) || refreshTs != null;
  return { state: haveAny ? 'ok' : 'idle', updatedAt: refreshTs, sites };
}
