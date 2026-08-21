// TDD pro Task 8: modul ga4 (denní řady + realtime, generický port).
// buildGa4Section() je čisté čtení z DB — test sype 3 řádky přímo do
// ga4_daily a ověřuje agregaci d7/d28/spark. Fixture keyFile míří na
// neexistující soubor a refresh se v testu nikdy nevolá, takže se nikdy
// nesáhne na síť/Google API (viz test níž, který to i explicitně hlídá).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Env MUSÍ být nastavený PŘED importem config.js/modules/ga4.js (obojí čte
// CFG synchronně při importu) — stejný vzor jako test/config.test.mjs.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ga4-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.MC_DATA_DIR = dataDir;
process.env.MC_CONFIG = fileURLToPath(new URL('./fixtures/mc.config.ga4.json', import.meta.url));
process.env.MC_AGENT_HOME = tmp;

const C = await import('../config.js');
const ga4 = await import('../modules/ga4.js');

const DAY = 86400000;
// Vlastní kopie „ymd v timezoně" — test nezávisí na interním (neexportovaném)
// helperu modulu, jen na tom, že GA4_TZ z configu (default Europe/Prague) sedí.
const ymd = (tz, ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(ms);

test('ga4: buildGa4Section() agreguje d7/d28 ze 3 nasypaných řádků ga4_daily', () => {
  const now = Date.now();
  const yesterday = ymd(C.GA4_TZ, now - DAY);
  const d2 = ymd(C.GA4_TZ, now - 2 * DAY);
  const d3 = ymd(C.GA4_TZ, now - 3 * DAY);

  // Seed přímo do DB stejným schématem jako modules/ga4.js db_() (tabulka se
  // založí i touhle cestou — PRIMARY KEY (site, day) sedí na upsert modulu).
  const d = new DatabaseSync(C.GA4_DB);
  d.exec(`CREATE TABLE IF NOT EXISTS ga4_daily (
    site TEXT NOT NULL, day TEXT NOT NULL, sessions INTEGER, users INTEGER, pageviews INTEGER,
    PRIMARY KEY (site, day)
  );`);
  const ins = d.prepare('INSERT INTO ga4_daily (site, day, sessions, users, pageviews) VALUES (?,?,?,?,?)');
  ins.run('example', yesterday, 10, 5, 20);
  ins.run('example', d2, 20, 8, 40);
  ins.run('example', d3, 5, 2, 9);
  d.close();

  const section = ga4.buildGa4Section();
  assert.equal(section.sites.length, 1);
  const site = section.sites[0];
  assert.equal(site.id, 'example');
  assert.equal(site.label, 'Example');
  assert.equal(site.host, 'example.com');
  // 10+20+5=35 sessions, 5+8+2=15 users, 20+40+9=69 pageviews — jen 3 dny dat,
  // takže d28 sedí na d7 (obě okna vidí totéž).
  assert.deepEqual(site.d7, { sessions: 35, users: 15, pv: 69 });
  assert.deepEqual(site.d28, { sessions: 35, users: 15, pv: 69 });
  assert.deepEqual(site.spark, [5, 20, 10]); // oldest-first pro sparkline
  assert.equal(site.today, null); // dnešek zatím bez dat
  assert.equal(site.live, null); // bez ga4_live řádků
});

test('ga4: modul exportuje refresh funkce, ale test se sítě nikdy nedotkne', () => {
  assert.equal(typeof ga4.refreshGa4, 'function');
  assert.equal(typeof ga4.refreshGa4Live, 'function');
  assert.equal(typeof ga4.buildGa4Section, 'function');
  // fixture keyFile míří na neexistující soubor — kdyby refresh omylem běžel,
  // spadl by na chybějícím souboru dřív, než by cokoliv poslal po síti. Test
  // ale refreshGa4()/refreshGa4Live() vůbec nevolá (viz brief: žádné síťové
  // volání v testech).
  assert.ok(!fs.existsSync(C.GA4_KEY_FILE), 'fixture keyFile by měl mířit na neexistující cestu');
});
