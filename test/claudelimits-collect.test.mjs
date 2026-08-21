// TDD pro Task 11: modul claudelimits (port). Na rozdíl od ga4/gsc/indexace
// nemá modul žádnou DB — stav žije jen v paměti procesu (last/lastOkTs/lastErr
// v modules/claudelimits.js). Test proto neseeduje žádnou tabulku, jen ověřuje,
// že collectClaudeLimits() vrátí bezpečný tvar ještě PŘED prvním
// refreshClaudeLimits() — a že se test (ani modul v tomhle stavu) nikdy
// nedotkne sítě: refreshClaudeLimits() se tu vůbec nevolá, claudeDir míří na
// prázdný tmp adresář bez `.credentials.json`, takže i kdyby test omylem
// refresh zavolal, čtení creds selže dřív, než by šlo cokoliv poslat po síti
// (viz modules/claudelimits.js readCreds()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Env MUSÍ být nastavený PŘED importem config.js/modules/claudelimits.js
// (obojí čte CFG synchronně při importu) — stejný vzor jako sourozenci
// (ga4-section.test.mjs, gsc-section.test.mjs, indexace-collect.test.mjs).
// Config fixture je tu generovaná (ne statický soubor v test/fixtures/),
// protože claudeDir musí mířit na čerstvý prázdný tmp adresář — nikdy na
// reálný ~/.claude spouštějícího stroje.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claudelimits-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const claudeDir = path.join(tmp, 'empty-claude-dir'); // schválně NEvytvořený — žádné .credentials.json
const cfgFile = path.join(tmp, 'mc.config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ modules: { claudelimits: { claudeDir } } }));
process.env.MC_DATA_DIR = dataDir;
process.env.MC_CONFIG = cfgFile;
process.env.MC_AGENT_HOME = tmp;

const C = await import('../config.js');
const cl = await import('../modules/claudelimits.js');

test('claudelimits: config.claudeDir přepíše CLAUDELIMITS_DIR, CLAUDE_DIR (jarvis/collectors) zůstává beze změny', () => {
  assert.equal(C.CLAUDELIMITS_DIR, claudeDir);
  assert.equal(C.CLAUDE_DIR, `${tmp}/.claude`, 'sdílená CLAUDE_DIR (jarvis.js/collectors.js) se nesmí modulem claudelimits ovlivnit');
  assert.ok(!fs.existsSync(path.join(claudeDir, '.credentials.json')), 'fixture claudeDir by neměl obsahovat .credentials.json');
});

test('claudelimits: collectClaudeLimits() vrací bezpečný tvar i před prvním refreshem (žádná DB, žádná síť)', () => {
  const section = cl.collectClaudeLimits();
  assert.deepEqual(section, { state: 'idle', err: null, fetchedAt: null, stale: true });
});

test('claudelimits: modul exportuje refresh funkci, ale test se sítě nikdy nedotkne', () => {
  assert.equal(typeof cl.refreshClaudeLimits, 'function');
  assert.equal(typeof cl.collectClaudeLimits, 'function');
  // refreshClaudeLimits() se v tomhle testu vůbec nevolá (viz brief: žádné
  // síťové volání v testech) — i tak by ale na chybějících creds hned skončila,
  // nikdy by se nedostala k fetch().
});
