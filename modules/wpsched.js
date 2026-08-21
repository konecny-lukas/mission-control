// Mission Control — WPSCHED: hlídač zaseknutých naplánovaných (`future`) WP
// postů. Přepis modulu z původního interního MC, NE port — podle research
// přípravy balíčku (mapa modulů, §6, wpsched). Zdroj
// tam mluvil na vzdálený WP přes `sshpass` s heslem po SSH a spouštěl
// `eval(base64_decode(...))` PHP jedním `wp eval` (navíc měl skrytý
// AUTO-REPAIR write path — druhý `wp eval`, co postům obnovoval cron event).
// VŠECHNO TOHLE JE TADY ZAKÁZANÉ. Tenhle modul mluví s webem výhradně přes WP
// REST API (`/wp-json/wp/v2/posts`) s WP application password (HTTP Basic),
// a je přísně READ-ONLY — jediný HTTP verb, který kdy použije, je GET. Žádný
// zápis na WP, žádný auto-repair.
//
// Klasifikace (inspirovaná zdrojem, zjednodušená — REST nemá přístup k WP cron
// tabulce jako `wp eval`, jen k datu postu): post se statusem `future`, jehož
// `date_gmt` je starší než (now − grace), je "stuck" — měl vyjít a nevyšel
// (WP cron se na serveru neodpálil). Post s `date_gmt` v budoucnu (nebo
// uvnitř grace okna) je normální "next" — nejbližší se hlásí per web.
import fs from 'node:fs';
import * as C from '../config.js';

let snap = null; // in-memory snímek (seed z disku při prvním collect)

function emptySnap() {
  return { state: 'idle', checkedAt: null, sites: [] };
}

function loadSeed() {
  try {
    const j = JSON.parse(fs.readFileSync(C.WPSCHED_STATE_FILE, 'utf-8'));
    if (j && Array.isArray(j.sites)) return j;
  } catch { /* první běh / nečitelné — refresh doplní */ }
  return null;
}

// title z WP REST dorazí buď jako holý string, nebo jako {rendered:string}
// (podle _fields a autentizačního kontextu) — sjednotit na string.
function titleOf(t) {
  if (typeof t === 'string') return t;
  if (t && typeof t.rendered === 'string') return t.rendered;
  return '';
}

// date_gmt z WP REST je 'YYYY-MM-DDTHH:MM:SS' BEZ 'Z' — je to ale vždy UTC
// (na rozdíl od `date`, což je lokální čas webu), takže se MUSÍ parsovat
// explicitně jako UTC (bez toho by Date.parse() posunul o časovou zónu
// procesu). Vrací ms epoch, nebo null na chybějící/nerozparsovatelné datum.
function parseDateGmt(s) {
  if (!s || typeof s !== 'string') return null;
  const ms = Date.parse(s.endsWith('Z') ? s : `${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// Čistá klasifikační fn (TDD — žádné I/O, žádná síť). `sitesRaw` = výstup
// probeSite() (nebo testová fixture): pole
// [{id, label, url, ok, err?, posts:[{id, title, date_gmt, status, link}]}].
// Post s chybějícím/nerozparsovatelným date_gmt se NIKDY nezařadí do stuck
// ani next (radši tichá díra v datech než falešná výstraha).
export function buildSnapshot(now, sitesRaw) {
  const grace = C.WPSCHED_GRACE_MS;
  const sites = (sitesRaw || []).map((s) => {
    if (!s || !s.ok) {
      return {
        id: s?.id, label: (s && (s.label || s.id)) || s?.id, url: s?.url,
        ok: false, err: (s && s.err) || 'chyba sondy', futureCount: 0, next: null, stuck: [],
      };
    }
    const posts = Array.isArray(s.posts) ? s.posts : [];
    const stuck = [];
    const upcoming = [];
    for (const p of posts) {
      if (!p || p.id == null) continue;
      const due = parseDateGmt(p.date_gmt);
      const title = titleOf(p.title);
      if (due == null) continue; // chybějící/nerozparsovatelné datum — nehavaruj, jen přeskoč
      if (due < now - grace) stuck.push({ id: p.id, title, at: p.date_gmt, link: p.link || null });
      else upcoming.push({ title, at: p.date_gmt, due });
    }
    upcoming.sort((a, b) => a.due - b.due);
    const next = upcoming.length ? { title: upcoming[0].title, at: upcoming[0].at } : null;
    return { id: s.id, label: s.label || s.id, url: s.url, ok: true, futureCount: posts.length, next, stuck };
  });
  const state = sites.some((s) => s.stuck.length) ? 'crit' : sites.some((s) => !s.ok) ? 'warn' : 'ok';
  return { state, checkedAt: now, sites };
}

// Sonda per web: WP REST API application password (Basic auth), read-only GET
// — jediný HTTP verb, co se kdy pošle. Heslo se čte LÍNĚ ze `site.appPasswordFile`
// PŘI KAŽDÉM refreshi (ne cachované v paměti procesu) — soubor je chmod-sensitive
// v secrets/, jeho OBSAH se nikdy nikam neloguje ani neserializuje do snapshotu
// (chyba čtení hlásí jen kód/zprávu, nikdy accidentally samotné heslo).
async function probeSite(site) {
  const base = { id: site.id, label: site.label || site.id, url: site.url };
  let appPassword;
  try {
    appPassword = fs.readFileSync(site.appPasswordFile, 'utf-8').trim();
  } catch (e) {
    return { ...base, ok: false, err: `appPasswordFile: ${e.code || e.message}` };
  }
  if (!appPassword) return { ...base, ok: false, err: 'appPasswordFile je prázdný' };
  if (!site.url || !site.user) return { ...base, ok: false, err: 'chybí url/user v configu' };
  const auth = Buffer.from(`${site.user}:${appPassword}`).toString('base64');
  const url = `${String(site.url).replace(/\/+$/, '')}/wp-json/wp/v2/posts`
    + '?status=future&per_page=100&orderby=date&order=asc&_fields=id,title,date_gmt,status,link';
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(C.WPSCHED_TIMEOUT_MS),
    });
    if (!res.ok) return { ...base, ok: false, err: `HTTP ${res.status}` };
    const posts = await res.json();
    if (!Array.isArray(posts)) return { ...base, ok: false, err: 'neočekávaná odpověď (ne pole)' };
    return { ...base, ok: true, posts };
  } catch (e) {
    return { ...base, ok: false, err: String(e.message || e).slice(0, 200) };
  }
}

// Sonda všech nakonfigurovaných webů (paralelně — jsou nezávislé), přepočet
// snímku a zápis do data/wpsched.json (přežije restart). Nikdy nehází.
export async function refreshWpsched() {
  const now = Date.now();
  let sitesRaw;
  try {
    sitesRaw = await Promise.all(C.WPSCHED_SITES.map(probeSite));
  } catch (e) {
    console.error('[wpsched] probe', e.message);
    return;
  }
  snap = buildSnapshot(now, sitesRaw);
  for (const s of snap.sites) if (!s.ok) console.error(`[wpsched] ${s.id}: ${s.err}`);
  try {
    fs.mkdirSync(C.DATA_DIR, { recursive: true });
    fs.writeFileSync(C.WPSCHED_STATE_FILE, JSON.stringify(snap));
  } catch (e) {
    console.error('[wpsched] persist', e.message);
  }
}

// Snapshot, který renderuje panel/drawer. Čistě čtení z paměti (seed z disku
// při prvním volání, ať má panel data hned po restartu, ne až po první sondě).
export function collectWpsched() {
  if (!snap) snap = loadSeed() || emptySnap();
  return snap;
}
