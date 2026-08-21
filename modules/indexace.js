// Mission Control — INDEXACE: stav indexace stránek v Googlu.
// Generický port indexace.js z původního interního Mission Control —
// vychází z research přípravy balíčku (mapa modulů, §6, indexace). Pro
// každý web v CFG.modules.indexace.sites vezme všechny URL z jeho sitemap
// (sitemap URL je POVINNÁ přímo v configu — žádné hádání přes robots.txt/
// konvenční cesty jako zdroj) a u každé se zeptá Google Search Console URL
// Inspection API, jestli je v indexu. To je autoritativní, ZDARMA náhrada za
// ruční `site:` dotaz — verdict PASS = indexováno; coverageState dává lidský
// důvod (Submitted and indexed, Crawled/Discovered - currently not indexed,
// URL is unknown to Google, …).
//
// Na rozdíl od zdroje: JEDNA GSC property PER WEB (žádné pole víc property pro
// víc jazykových mutací jedné property, žádný per-mutace rozpad — YAGNI),
// `languageCode` z configu (default 'cs-CZ') a `label` webu je buď z configu,
// nebo doména z jeho property — žádná klientská heuristika podle URL cesty.
//
// Per-URL stav + denní index-rate jdou do indexace.db (historie/trend přežijí
// restart). Auth: modules/google-auth.js (createTokenProvider) — sdílené s
// ga4/gsc, service account NEBO OAuth installed-app refresh token (auto-
// detekce podle obsahu keyFile). Klíč se NIKDY nepřepisuje. Vše defenzivní:
// chybný web/URL se zaloguje a přeskočí, refresh smyčka nikdy nehodí. Kvóta
// (2000/den/property, ~600/min) je hlídaná stropem URL/web, malou souběžností
// a min-gapem (restart nespálí kvótu). Zero deps (node:sqlite DatabaseSync).
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as C from '../config.js';
import { createTokenProvider } from './google-auth.js';

const INSPECT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Token provider se vytváří jednou při importu modulu — nečte keyFile hned
// (google-auth.js ho čte líně až při prvním skutečném volání), takže import
// samotný nemá žádný I/O side-effect (bezpečné i v testech bez sítě). Sdílí
// keyFile se stejným Google projektem jako gsc (výchozí secrets/google.json).
const getToken = createTokenProvider({ keyFile: C.INDEXACE_KEY_FILE, timeoutMs: C.INDEXACE_TIMEOUT_MS, tag: 'indexace' });

let db = null;
function db_() {
  if (db) return db;
  fs.mkdirSync(C.DATA_DIR, { recursive: true });
  const d = new DatabaseSync(C.INDEXACE_DB);
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec(`CREATE TABLE IF NOT EXISTS urls (
    site        TEXT NOT NULL,
    url         TEXT NOT NULL,
    verdict     TEXT,
    coverage    TEXT,
    robots      TEXT,
    fetch_state TEXT,
    last_crawl  TEXT,
    indexed     INTEGER,
    checked_at  INTEGER,
    PRIMARY KEY (site, url)
  );`);
  d.exec(`CREATE TABLE IF NOT EXISTS daily (
    site    TEXT NOT NULL,
    day     TEXT NOT NULL,
    total   INTEGER,
    indexed INTEGER,
    PRIMARY KEY (site, day)
  );`);
  d.exec(`CREATE TABLE IF NOT EXISTS meta (
    site      TEXT PRIMARY KEY,
    last_run  INTEGER,
    status    TEXT,
    note      TEXT,
    total     INTEGER,
    indexed   INTEGER,
    truncated INTEGER
  );`);
  db = d;
  return db;
}

// ---- helpery pro popis webu (label/url) — generické, žádná klientská heuristika ----
// doména z GSC property (URL-prefix i sc-domain: tvar) — fallback label, když
// config nedá vlastní `label`.
function domainOf(property) {
  try {
    const u = typeof property === 'string' && property.startsWith('sc-domain:')
      ? `https://${property.slice('sc-domain:'.length)}` : property;
    return new URL(u).hostname;
  } catch { return property || '?'; }
}
// odkaz webu pro panel/drawer: URL-prefix property je rovnou použitelná URL,
// sc-domain: nemá schéma/cestu (doplní se https://…/), poslední záchrana =
// origin sitemap URL (ta je v configu vždy).
function siteUrl(site) {
  const p = site.property;
  if (typeof p === 'string' && !p.startsWith('sc-domain:')) return p;
  if (typeof p === 'string') return `https://${p.slice('sc-domain:'.length)}/`;
  try { return `${new URL(site.sitemap).origin}/`; } catch { return null; }
}

// ---- sitemap parsing (zero-dep, defenzivní) ----
// `tries` > 1 → retry přechodných chyb (5xx / timeout / síť) s krátkým backoffem.
// Důležité pro sitemap fetch: WP (zvlášť po přegenerování Rank Math) občas hodí 5xx
// na část child-sitemap; bez retry by collectUrls vrátil neúplnou sadu a stale-removal
// by promazal dobrá data. robots.txt necháváme na 1 pokus (404 má stejně fallback).
async function fetchText(url, tries = 1) {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await sleep(500 * attempt);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(C.INDEXACE_TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MissionControl/1.0; +indexace)' },
      });
      if (res.ok) return await res.text();
    } catch { /* přechodné — zkus znovu */ }
  }
  return null;
}
const decodeEntities = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');
function extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m; while ((m = re.exec(xml))) out.push(decodeEntities(m[1].trim()));
  return out;
}
const isSitemapIndex = (xml) => /<sitemapindex[\s>]/i.test(xml);

// Je URL v rozsahu jediné (ověřené) property tohoto webu? URL Inspection API
// odmítne URL, která neleží pod dotazovanou property, takže přiřazení musí být
// přesné: sc-domain: bere celou doménu, URL-prefix vyžaduje přesnou shodu
// prefixu. (Zdroj měl tohle jako propertyFor() s longest-prefix-match přes
// pole víc property pro víc mutací jedné property — tady je jen jedna
// property na web, takže je to prostý booleovský test.)
function inScope(site, url) {
  const p = site.property;
  if (typeof p !== 'string') return false;
  if (p.startsWith('sc-domain:')) {
    let host; try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
    const dom = p.slice('sc-domain:'.length).toLowerCase();
    return host === dom || host.endsWith('.' + dom);
  }
  return url.startsWith(p);
}

// Walk the site's sitemap (sitemap-indexy expanded up to 3 levels deep, jak
// je config zadá — žádné auto-discovery přes robots.txt) a return the de-duped
// page URLs v rozsahu property, capped at INDEXACE_MAX_URLS. `truncated` flags
// a cap hit so the UI never silently under-reports.
async function collectUrls(site) {
  const pages = new Set();
  const visited = new Set();
  const queue = [{ u: site.sitemap, depth: 0 }];
  // Sběr ze sitemapy nestojí kvótu (ta je až u inspekce), strop je jen pojistka
  // proti nekonečné sitemapě — jedna property na web = jedna denní kvóta.
  const cap = C.INDEXACE_MAX_URLS;
  let truncated = false;
  let failures = 0; // kolik child-sitemap se NEPODAŘILO stáhnout (i po retry)
  while (queue.length) {
    if (pages.size >= cap) { truncated = true; break; }
    const { u, depth } = queue.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    const xml = await fetchText(u, 3); // retry — flaky WP nesmí vést k neúplné sadě
    if (!xml) { failures++; continue; }
    const locs = extractLocs(xml);
    if (isSitemapIndex(xml) && depth < 3) {
      for (const l of locs) if (/^https?:\/\//i.test(l)) queue.push({ u: l, depth: depth + 1 });
    } else {
      for (const l of locs) {
        if (!/^https?:\/\//i.test(l) || !inScope(site, l)) continue;
        pages.add(l);
        if (pages.size >= cap) { truncated = true; break; }
      }
    }
  }
  // `complete` = žádná child-sitemap neselhala → smí se dělat stale-removal. Když část
  // sitemapy spadla, sada je neúplná a mazání „chybějících" URL by zničilo dobrá data.
  if (failures) console.error(`[indexace] ${site.id}: ${failures} child-sitemap se nepodařilo stáhnout (i po retry) — sada NEúplná`);
  return { urls: [...pages], truncated, complete: failures === 0 };
}

// ---- URL Inspection ----
// Returns parsed result, or { rate:true } on 429 (caller backs off), or null on any
// other error (caller skips that URL — it just won't update this round). Vlastní
// implementace (nesdílí google-auth.js googleApiPost): na 429 vrací {rate:true}
// OKAMŽITĚ (backoff řídí volající jedním ručním retry, ne vestavěná smyčka) a na
// jinou chybu žádný interní retry — s až tisíci URL na web by 2–3 pokusy PER URL
// byly neúnosně pomalé, radši selže rychle a URL se dožene příští běh.
async function inspect(token, siteUrl_, url) {
  try {
    const res = await fetch(INSPECT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspectionUrl: url, siteUrl: siteUrl_, languageCode: C.INDEXACE_LANG }),
      signal: AbortSignal.timeout(C.INDEXACE_TIMEOUT_MS),
    });
    if (res.status === 429) return { rate: true };
    if (!res.ok) return null;
    const j = await res.json();
    const r = (j.inspectionResult && j.inspectionResult.indexStatusResult) || {};
    return {
      verdict: r.verdict || null,
      coverage: r.coverageState || null,
      robots: r.robotsTxtState || null,
      fetchState: r.pageFetchState || null,
      lastCrawl: r.lastCrawlTime || null,
      indexed: r.verdict === 'PASS' ? 1 : 0,
    };
  } catch { return null; }
}

// Small concurrency pool over a shared cursor (keeps us well under the per-minute
// quota while still finishing a big sitemap in reasonable time).
async function runPool(items, n, worker) {
  let i = 0;
  const next = async () => { while (i < items.length) { const idx = i++; await worker(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, next));
}

// Refresh one site: sitemap -> inspect each URL -> upsert rows (INKREMENTÁLNĚ) +
// daily rollup + meta. Never throws.
// Robustnost vůči restartům: (1) přeskoč celý web jen když je ZDRAVÝ a ČERSTVÝ
// (status ok + data + < MIN_GAP) — orphan „running"/„crit"/prázdné se zopakují;
// (2) RESUME — URL zkontrolovaná v okně MIN_GAP se znovu neprovolává a každý řádek
// se zapisuje hned, takže restart uprostřed naváže a nespálí kvótu znovu.
const putMetaStmt = (d) => d.prepare(`INSERT INTO meta (site, last_run, status, note, total, indexed, truncated)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(site) DO UPDATE SET last_run=excluded.last_run, status=excluded.status,
    note=excluded.note, total=excluded.total, indexed=excluded.indexed, truncated=excluded.truncated`);

async function refreshSite(d, token, site, now) {
  const putMeta = putMetaStmt(d);
  const prev = (() => { try { return d.prepare('SELECT last_run, status, note, total, indexed, truncated FROM meta WHERE site=?').get(site.id); } catch { return null; } })();
  // Fast path: zdravý a čerstvý web → přeskoč (šetři kvótu). Orphan/selhaný/prázdný se NEpřeskakuje.
  if (prev && prev.status === 'ok' && prev.total > 0 && prev.last_run && now - prev.last_run < C.INDEXACE_MIN_GAP_MS) return;

  let urls = [], truncated = false, complete = true;
  try { ({ urls, truncated, complete } = await collectUrls(site)); } catch (e) { console.error(`[indexace] ${site.id} sitemap`, e.message); complete = false; }
  if (!urls.length) {
    try { putMeta.run(site.id, now, 'warn', 'sitemap nenalezena / prázdná', prev ? prev.total : 0, prev ? prev.indexed : 0, 0); } catch { /* ignore */ }
    console.error(`[indexace] ${site.id}: žádné URL ze sitemap`);
    return;
  }
  // Filtruj jen URL v rozsahu ověřené property (URL Inspection odmítne URL mimo ni).
  const scoped = urls.filter((u) => inScope(site, u));

  // RESUME + ROTACE denní kvóty: property má kvótu URL Inspection 2000/den.
  // (1) Přeskoč URL zkontrolované v okně MIN_GAP (resume po restartu / týž den). (2) Zbytek
  // seřaď NEJSTARŠÍ-zkontrolované-první (nezkontrolované = checked_at 0 jdou první) a vezmi
  // max MAX_URLS. Když web nakročí nad kvótu, přebytek se doplní příští běh — díky
  // oldest-first se URL točí dokola, takže žádná nezůstane navždy nezkontrolovaná
  // (to byl důvod, proč starý plochý strop 2000 pokrýval pořád stejných 2000).
  const since = now - C.INDEXACE_MIN_GAP_MS;
  const checkedAt = new Map();
  try { for (const r of d.prepare('SELECT url, checked_at FROM urls WHERE site=?').all(site.id)) checkedAt.set(r.url, r.checked_at || 0); } catch { /* ignore */ }
  let fresh = 0;
  const todo = [];
  for (const u of scoped) {
    if ((checkedAt.get(u) || 0) >= since) { fresh++; continue; } // čerstvé — přeskoč (resume)
    todo.push(u);
  }
  todo.sort((a, b) => (checkedAt.get(a) || 0) - (checkedAt.get(b) || 0)); // nejstarší/nezkontrolované první
  let deferred = 0;
  if (todo.length > C.INDEXACE_MAX_URLS) { deferred = todo.length - C.INDEXACE_MAX_URLS; todo.length = C.INDEXACE_MAX_URLS; }
  if (deferred) console.error(`[indexace] ${site.id}: ${deferred} URL nad denní kvótu ${C.INDEXACE_MAX_URLS} — doplní se příští běh (rotace)`);

  try { putMeta.run(site.id, now, 'running', prev ? prev.note : null, prev ? prev.total : null, prev ? prev.indexed : null, prev ? prev.truncated : 0); } catch { /* ignore */ }

  // INKREMENTÁLNÍ zápis: každý řádek se uloží hned po inspekci (WAL autocommit) —
  // JS je single-thread, takže ups.run() z „paralelních" workerů serializuje samo.
  const ups = d.prepare(`INSERT INTO urls (site, url, verdict, coverage, robots, fetch_state, last_crawl, indexed, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(site, url) DO UPDATE SET verdict=excluded.verdict, coverage=excluded.coverage,
      robots=excluded.robots, fetch_state=excluded.fetch_state, last_crawl=excluded.last_crawl,
      indexed=excluded.indexed, checked_at=excluded.checked_at`);
  let rateHits = 0, checked = 0;
  await runPool(todo, C.INDEXACE_CONCURRENCY, async (url) => {
    let r = await inspect(token, site.property, url);
    if (r && r.rate) { await sleep(2000); r = await inspect(token, site.property, url); } // jeden backoff retry
    if (!r || r.rate) { rateHits += (r && r.rate) ? 1 : 0; return; } // selhání/limit — řádek nech být
    checked++;
    try { ups.run(site.id, url, r.verdict, r.coverage, r.robots, r.fetchState, r.lastCrawl, r.indexed, now); } catch (e) { console.error(`[indexace] ${site.id} upsert`, e.message); }
  });

  // Stale removal: zahoď řádky pro URL, které už nejsou v aktuální sitemapě — ALE jen
  // když máme jistotu. DVĚ pojistky proti zničení dobrých dat částečnou sitemapou
  // (flaky WP vracel 5xx na část child-sitemap → to byl bug, co smazal spoustu řádků):
  // (1) sada musí být KOMPLETNÍ (`complete` — žádný child-fetch neselhal);
  // (2) i tak nesmaž víc než 15 % DB najednou (velký výmaz = nejspíš pořád částečná sada).
  try {
    const dbUrls = d.prepare('SELECT url FROM urls WHERE site=?').all(site.id).map((r) => r.url);
    if (!complete) {
      console.error(`[indexace] ${site.id}: sitemap NEúplná → stale-removal PŘESKOČEN (chráním data, doplní se příští běh)`);
    } else if (scoped.length < dbUrls.length * 0.95) {
      // Snímek menší než to, co už v DB máme → nejspíš částečná/dostavující se sitemapa
      // (Rank Math vrací 200 OK i s neúplným obsahem). Nemaž — mazat smí jen snímek, co
      // pokrývá aspoň 95 % známých URL.
      console.error(`[indexace] ${site.id}: snímek (${scoped.length}) < DB (${dbUrls.length}) → stale-removal PŘESKOČEN (sitemap se nejspíš dostavuje)`);
    } else {
      const inSitemap = new Set(scoped);
      const toDel = dbUrls.filter((u) => !inSitemap.has(u));
      if (toDel.length > Math.max(50, Math.floor(dbUrls.length * 0.15))) {
        console.error(`[indexace] ${site.id}: stale-removal by smazal ${toDel.length}/${dbUrls.length} URL — podezřele moc, PŘESKAKUJI`);
      } else {
        const del = d.prepare('DELETE FROM urls WHERE site=? AND url=?');
        for (const u of toDel) del.run(site.id, u);
      }
    }
  } catch (e) { console.error(`[indexace] ${site.id} stale`, e.message); }

  // Rollup = aktuální stav celého webu z DB (zahrnuje resume + čerstvě zkontrolované).
  let total = 0, idx = 0;
  try {
    const row = d.prepare('SELECT COUNT(*) c, COALESCE(SUM(indexed),0) i FROM urls WHERE site=?').get(site.id);
    if (row) { total = row.c; idx = row.i; }
  } catch { /* ignore */ }
  try {
    d.prepare(`INSERT INTO daily (site, day, total, indexed) VALUES (?, ?, ?, ?)
      ON CONFLICT(site, day) DO UPDATE SET total=excluded.total, indexed=excluded.indexed`)
      .run(site.id, ymd(now), total, idx);
    d.prepare('DELETE FROM daily WHERE site=? AND day < ?').run(site.id, ymd(now - C.INDEXACE_HISTORY_DAYS * DAY));
  } catch (e) { console.error(`[indexace] ${site.id} daily`, e.message); }

  // crit jen když web fakt nemá v DB nic (sitemap měla URL, ale vše selhalo). Rotace
  // (deferred>0) NENÍ chyba — je to plánované rozložení přes víc dní, takže jen poznámka.
  const note = rateHits ? `rate-limit u ${rateHits} URL (přeskočeno, zkusí se příště)`
    : (deferred ? `rotace přes víc dní: ${deferred} URL nad denní kvótu ${C.INDEXACE_MAX_URLS} se doplní příští běh` : null);
  const status = total === 0 ? 'crit' : (rateHits ? 'warn' : 'ok');
  try { putMeta.run(site.id, now, status, note, total, idx, deferred ? 1 : 0); } catch { /* ignore */ }
  console.error(`[indexace] ${site.id}: hotovo — ${idx}/${total} indexováno (nově zkontrolováno ${checked}, resume ${fresh}, odloženo ${deferred})`);
}

// Refresh všech webů sekvenčně (každý web má svou kvótu, ale držíme to v klidu).
// Safe to call on a timer; min-gap uvnitř refreshSite zařídí ~1×/24 h.
export async function refreshIndexace() {
  let token; try { token = await getToken(); } catch (e) { console.error('[indexace]', e.message); return; }
  let d; try { d = db_(); } catch (e) { console.error('[indexace] db open', e); return; }
  const now = Date.now();
  for (const site of C.INDEXACE_SITES) {
    try { await refreshSite(d, token, site, now); } catch (e) { console.error(`[indexace] ${site.id}`, e.message); }
  }
}

// Snapshot, který renderuje panel/drawer. Čistě čtení z DB.
export function collectIndexace() {
  let d; try { d = db_(); } catch { return { state: 'idle', sites: [] }; }
  const HIST = Number(C.INDEXACE_HISTORY_DAYS);

  const sites = C.INDEXACE_SITES.map((s) => {
    let meta = {};
    try { meta = d.prepare('SELECT last_run, status, note, total, indexed, truncated FROM meta WHERE site=?').get(s.id) || {}; } catch { /* ignore */ }

    // rozpad podle coverageState (důvody neindexace) + total/indexed z reálných řádků
    let rows = [];
    try { rows = d.prepare('SELECT url, coverage, indexed FROM urls WHERE site=?').all(s.id); } catch { /* ignore */ }
    const total = rows.length;
    const indexed = rows.reduce((a, r) => a + (r.indexed ? 1 : 0), 0);
    const byCoverage = {};
    for (const r of rows) { const k = r.coverage || 'neznámé'; byCoverage[k] = (byCoverage[k] || 0) + 1; }

    // seznam NEindexovaných URL (akční část) — seřazeno podle důvodu
    let notIndexed = [];
    try {
      notIndexed = d.prepare(`SELECT url, coverage, last_crawl FROM urls
        WHERE site=? AND (indexed IS NULL OR indexed=0) ORDER BY coverage, url LIMIT 300`).all(s.id);
    } catch { /* ignore */ }

    // sparkline denní index-rate (%)
    let daily = [];
    try { daily = d.prepare(`SELECT day, total, indexed FROM daily WHERE site=? ORDER BY day DESC LIMIT ${HIST}`).all(s.id); } catch { /* ignore */ }
    const spark = daily.slice().reverse();

    return {
      id: s.id, label: s.label || domainOf(s.property), url: siteUrl(s),
      property: s.property,
      total, indexed, notIndexedCount: total - indexed,
      pct: total ? indexed / total : null,
      byCoverage,
      notIndexed: notIndexed.map((r) => ({ url: r.url, coverage: r.coverage || 'neznámé', lastCrawl: r.last_crawl || null })),
      spark: spark.map((r) => (r.total ? Math.round((r.indexed / r.total) * 100) : 0)),
      sparkDays: spark.map((r) => r.day),
      status: meta.status || 'idle',
      note: meta.note || null,
      truncated: !!meta.truncated,
      updatedAt: meta.last_run || null,
      hasData: total > 0,
    };
  });

  const haveAny = sites.some((s) => s.hasData);
  const totalUrls = sites.reduce((a, s) => a + (s.total || 0), 0);
  const totalIdx = sites.reduce((a, s) => a + (s.indexed || 0), 0);
  const worst = sites.filter((s) => s.hasData).slice().sort((a, b) => (a.pct ?? 1) - (b.pct ?? 1))[0];
  return {
    state: haveAny ? 'ok' : 'idle',
    siteCount: sites.filter((s) => s.hasData).length,
    totalUrls: haveAny ? totalUrls : null,
    indexedUrls: haveAny ? totalIdx : null,
    notIndexedUrls: haveAny ? totalUrls - totalIdx : null,
    pct: totalUrls ? totalIdx / totalUrls : null,
    worstSite: worst ? worst.label : null,
    worstPct: worst ? worst.pct : null,
    updatedAt: sites.reduce((mx, s) => Math.max(mx, s.updatedAt || 0), 0) || null,
    sites,
  };
}
