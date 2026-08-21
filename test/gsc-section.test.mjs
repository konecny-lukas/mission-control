// TDD pro Task 9: modul gsc (Search Console per web, generický port).
// collectGSC() je čisté čtení z DB — test sype 3 řádky přímo do `daily` a
// ověřuje agregaci clicks28/impressions28/position28/spark. Fixture keyFile
// míří na neexistující soubor a refresh se v testu nikdy nevolá, takže se
// nikdy nesáhne na síť/Google API (viz test níž, který to i explicitně hlídá).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Env MUSÍ být nastavený PŘED importem config.js/modules/gsc.js (obojí čte
// CFG synchronně při importu) — stejný vzor jako test/ga4-section.test.mjs.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gsc-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.MC_DATA_DIR = dataDir;
process.env.MC_CONFIG = fileURLToPath(new URL('./fixtures/mc.config.gsc.json', import.meta.url));
process.env.MC_AGENT_HOME = tmp;

const C = await import('../config.js');
const gsc = await import('../modules/gsc.js');

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

test('gsc: collectGSC() agreguje clicks28/impressions28/position28 ze 3 nasypaných řádků daily', () => {
  const now = Date.now();
  const d1 = ymd(now - 3 * DAY);
  const d2 = ymd(now - 4 * DAY);
  const d3 = ymd(now - 5 * DAY);

  // Seed přímo do DB stejným schématem jako modules/gsc.js db_() (tabulka se
  // založí i touhle cestou — PRIMARY KEY (site, day) sedí na upsert modulu).
  const d = new DatabaseSync(C.GSC_DB);
  d.exec(`CREATE TABLE IF NOT EXISTS daily (
    site TEXT NOT NULL, day TEXT NOT NULL, clicks INTEGER, impressions INTEGER,
    ctr REAL, position REAL, PRIMARY KEY (site, day)
  );`);
  const ins = d.prepare('INSERT INTO daily (site, day, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?)');
  ins.run('example', d1, 10, 200, 0.05, 8.0);
  ins.run('example', d2, 20, 300, 0.066, 6.0);
  ins.run('example', d3, 5, 100, 0.05, 12.0);
  d.close();

  const section = gsc.collectGSC();
  assert.equal(section.sites.length, 1);
  const site = section.sites[0];
  assert.equal(site.id, 'example');
  assert.equal(site.label, 'Example');
  assert.equal(site.property, 'https://example.com/');
  // 10+20+5 = 35 kliků, 200+300+100 = 600 zobrazení
  assert.equal(site.clicks28, 35);
  assert.equal(site.impressions28, 600);
  // impression-weighted avg pozice: (8*200 + 6*300 + 12*100) / 600 = (1600+1800+1200)/600 = 7.666..
  assert.ok(Math.abs(site.position28 - 7.6667) < 0.01, `position28 = ${site.position28}`);
  assert.deepEqual(site.spark, [5, 20, 10]); // oldest-first pro sparkline
  assert.deepEqual(site.topQueries, []); // bez snap řádku
  assert.equal(section.state, 'ok');
});

test('gsc: modul exportuje refresh funkci, ale test se sítě nikdy nedotkne', () => {
  assert.equal(typeof gsc.refreshGSC, 'function');
  assert.equal(typeof gsc.collectGSC, 'function');
  // fixture keyFile míří na neexistující cestu — kdyby refresh omylem běžel,
  // spadl by na chybějícím souboru dřív, než by cokoliv poslal po síti. Test
  // ale refreshGSC() vůbec nevolá (viz brief: žádné síťové volání v testech).
  assert.ok(!fs.existsSync(C.GSC_KEY_FILE), 'fixture keyFile by měl mířit na neexistující cestu');
});
