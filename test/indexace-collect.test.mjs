// TDD pro Task 10: modul indexace (GSC URL Inspection, generický port).
// collectIndexace() je čisté čtení z DB — test sype řádky přímo do `urls` +
// `daily` (+ `meta`) a ověřuje agregaci total/indexed/notIndexedCount/pct,
// rozpad podle coverage, seznam neindexovaných URL a sparkline. Fixture
// keyFile míří na neexistující soubor a refresh se v testu nikdy nevolá,
// takže se nikdy nesáhne na síť/Google API (viz test níž, který to i
// explicitně hlídá) — stejný vzor jako test/ga4-section.test.mjs a
// test/gsc-section.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Env MUSÍ být nastavený PŘED importem config.js/modules/indexace.js (obojí
// čte CFG synchronně při importu) — stejný vzor jako sourozenci.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-indexace-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.MC_DATA_DIR = dataDir;
process.env.MC_CONFIG = fileURLToPath(new URL('./fixtures/mc.config.indexace.json', import.meta.url));
process.env.MC_AGENT_HOME = tmp;

const C = await import('../config.js');
const idx = await import('../modules/indexace.js');

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

test('indexace: collectIndexace() agreguje total/indexed/coverage z nasypaných řádků urls', () => {
  const now = Date.now();
  const d1 = ymd(now - 2 * DAY);
  const d2 = ymd(now - 1 * DAY);
  const d3 = ymd(now);

  // Seed přímo do DB stejným schématem jako modules/indexace.js db_() (tabulky
  // se založí i touhle cestou — PRIMARY KEY sedí na upsert modulu).
  const d = new DatabaseSync(C.INDEXACE_DB);
  d.exec(`CREATE TABLE IF NOT EXISTS urls (
    site TEXT NOT NULL, url TEXT NOT NULL, verdict TEXT, coverage TEXT, robots TEXT,
    fetch_state TEXT, last_crawl TEXT, indexed INTEGER, checked_at INTEGER,
    PRIMARY KEY (site, url)
  );`);
  d.exec(`CREATE TABLE IF NOT EXISTS daily (
    site TEXT NOT NULL, day TEXT NOT NULL, total INTEGER, indexed INTEGER, PRIMARY KEY (site, day)
  );`);
  d.exec(`CREATE TABLE IF NOT EXISTS meta (
    site TEXT PRIMARY KEY, last_run INTEGER, status TEXT, note TEXT, total INTEGER, indexed INTEGER, truncated INTEGER
  );`);

  const ins = d.prepare(`INSERT INTO urls (site, url, verdict, coverage, robots, fetch_state, last_crawl, indexed, checked_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run('example', 'https://example.com/', 'PASS', 'Submitted and indexed', 'ALLOWED', 'SUCCESSFUL', null, 1, now);
  ins.run('example', 'https://example.com/a', 'PASS', 'Submitted and indexed', 'ALLOWED', 'SUCCESSFUL', null, 1, now);
  ins.run('example', 'https://example.com/b', 'PASS', 'Indexed, not submitted in sitemap', 'ALLOWED', 'SUCCESSFUL', null, 1, now);
  ins.run('example', 'https://example.com/c', 'NEUTRAL', 'Crawled - currently not indexed', 'ALLOWED', 'SUCCESSFUL', null, 0, now);
  ins.run('example', 'https://example.com/d', 'NEUTRAL', 'Discovered - currently not indexed', 'ALLOWED', 'SUCCESSFUL', null, 0, now);

  const insDaily = d.prepare('INSERT INTO daily (site, day, total, indexed) VALUES (?,?,?,?)');
  insDaily.run('example', d1, 4, 2);
  insDaily.run('example', d2, 5, 3);
  insDaily.run('example', d3, 5, 3);

  d.prepare('INSERT INTO meta (site, last_run, status, note, total, indexed, truncated) VALUES (?,?,?,?,?,?,?)')
    .run('example', now, 'ok', null, 5, 3, 0);
  d.close();

  const section = idx.collectIndexace();
  assert.equal(section.state, 'ok');
  assert.equal(section.siteCount, 1);
  assert.equal(section.totalUrls, 5);
  assert.equal(section.indexedUrls, 3);
  assert.equal(section.notIndexedUrls, 2);
  assert.ok(Math.abs(section.pct - 0.6) < 1e-9, `pct = ${section.pct}`);
  assert.equal(section.worstSite, 'Example');

  assert.equal(section.sites.length, 1);
  const site = section.sites[0];
  assert.equal(site.id, 'example');
  assert.equal(site.label, 'Example'); // z configu, ne doména z property
  assert.equal(site.property, 'https://example.com/');
  assert.equal(site.url, 'https://example.com/'); // URL-prefix property = přímo použitelná URL
  assert.equal(site.total, 5);
  assert.equal(site.indexed, 3);
  assert.equal(site.notIndexedCount, 2);
  assert.ok(Math.abs(site.pct - 0.6) < 1e-9, `site.pct = ${site.pct}`);
  assert.equal(site.hasData, true);
  assert.equal(site.status, 'ok');

  assert.deepEqual(site.byCoverage, {
    'Submitted and indexed': 2,
    'Indexed, not submitted in sitemap': 1,
    'Crawled - currently not indexed': 1,
    'Discovered - currently not indexed': 1,
  });

  // notIndexed: jen indexed=0 řádky, seřazené podle coverage (ORDER BY coverage, url)
  assert.equal(site.notIndexed.length, 2);
  assert.deepEqual(site.notIndexed.map((r) => r.url).sort(), ['https://example.com/c', 'https://example.com/d']);

  // spark = daily oldest-first (d1, d2, d3), index-rate v % zaokrouhlené
  assert.deepEqual(site.sparkDays, [d1, d2, d3]);
  assert.deepEqual(site.spark, [50, 60, 60]); // round(2/4*100)=50, round(3/5*100)=60
});

test('indexace: modul exportuje refresh funkci, ale test se sítě nikdy nedotkne', () => {
  assert.equal(typeof idx.refreshIndexace, 'function');
  assert.equal(typeof idx.collectIndexace, 'function');
  // fixture keyFile míří na neexistující cestu — kdyby refresh omylem běžel,
  // spadl by na chybějícím souboru dřív, než by cokoliv poslal po síti. Test
  // ale refreshIndexace() vůbec nevolá (viz brief: žádné síťové volání v testech).
  assert.ok(!fs.existsSync(C.INDEXACE_KEY_FILE), 'fixture keyFile by měl mířit na neexistující cestu');
});
