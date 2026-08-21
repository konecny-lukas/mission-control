// TDD pro Task 13: modul nanoclaw (read-only panel nad instalací NanoClaw).
// Tabulky v tmp SQLite replikují SCHÉMA OVĚŘENÉ na živé DB (viz
// modules/nanoclaw.js hlavička + task-13-report.md): `agent_groups(id, name,
// folder, agent_provider, created_at)` a `sessions(id, agent_group_id,
// messaging_group_id, thread_id, agent_provider, status, container_status,
// last_active, created_at)`. Test se NIKDY nedotkne skutečné produkční DB
// (schéma ověřeno na referenční instalaci NanoClaw) — vlastní tmp checkout,
// vlastní DB.
// Unit detekce je vypnutá přes MC_NANOCLAW_NO_SYSTEMD=1 (brief to mandatuje)
// — test se nikdy nedotkne systemctl. Jeden test (fix round 1 regrese) na
// chvíli přepne na MC_NANOCLAW_TEST_UNIT_ACTIVE=1 (vlastní test-only hook v
// modules/nanoclaw.js detectUnit(), taky bez systemctl) a v `finally` vrátí
// NO_SYSTEMD zpátky.
//
// Testy v jednom souboru běží v node:test sekvenčně v pořadí deklarace (bez
// concurrency) — proto je bezpečné napřed ověřit 'off' (dřív, než cokoliv
// nasype do DB), pak fix-round-1 regresi na "nikdy nebyla čitelná" (MUSÍ
// běžet, dokud modulová `everReadOk` flag ještě není true) a teprve pak DB
// naseedovat pro zbytek souboru.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

process.env.MC_NANOCLAW_NO_SYSTEMD = '1';
process.env.MC_CONFIG = fileURLToPath(new URL('./fixtures/mc.config.nanoclaw.json', import.meta.url));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nanoclaw-home-'));
process.env.MC_AGENT_HOME = tmpHome;
process.env.MC_DATA_DIR = path.join(tmpHome, 'data');
fs.mkdirSync(process.env.MC_DATA_DIR, { recursive: true });

// Env MUSÍ být nastavený PŘED importem config.js/modules/nanoclaw.js (obojí
// čte CFG synchronně při importu) — stejný vzor jako sourozenci
// (claudelimits-collect.test.mjs, indexace-collect.test.mjs…).
const C = await import('../config.js');
const nc = await import('../modules/nanoclaw.js');

// C.NANOCLAW_DIR se resolvne z fixture "test/fixtures/nanoclaw-tmp" vůči
// MC_DIR (repo root) — deterministické bez ohledu na cwd (viz config.js
// resolveNanoclawDir). Tenhle adresář vytváří/uklízí VÝHRADNĚ tenhle test.
const dbDir = path.join(C.NANOCLAW_DIR, 'data');
const dbPath = path.join(dbDir, 'v2.db');
after(() => {
  try { fs.rmSync(C.NANOCLAW_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('refreshNanoclaw: chybějící data/v2.db (checkout adresář ještě neexistuje) -> collectNanoclaw() vrátí "off", nikdy nehodí', async () => {
  assert.equal(fs.existsSync(dbPath), false, 'test předpokládá, že DB ještě neexistuje (musí běžet PŘED seedem)');
  await assert.doesNotReject(nc.refreshNanoclaw());
  const snap = nc.collectNanoclaw();
  assert.equal(snap.state, 'off');
  assert.equal(snap.unit, null);
  assert.deepEqual(snap.agents, []);
  assert.equal(snap.updatedAt, null);
});

// Fix round 1 (review): DB existuje, ale čtení SELŽE — a to na úplně PRVNÍM
// refreshi, kdy `everReadOk` je ještě false (žádná dobrá data se nikdy
// nenačetla). I s AKTIVNÍ unitou musí stav být 'warn', nikdy 'ok' — DB nikdy
// nebyla potvrzeně čitelná, takže agents:[] není důvěryhodné "nic neběží",
// je to "nevíme". Před fixem `computeState(unit)` neznalo `everReadOk` a
// vracelo 'ok' navěky (last.updatedAt zůstával null, takže staleness
// demotion v collectNanoclaw() na to nikdy nedosáhla). MUSÍ běžet PŘED
// testem se seedovanou DB níž (ten teprve nastaví `everReadOk=true`).
test('refreshNanoclaw: DB existuje, ale čtení selže na PRVNÍM pokusu (nikdy nebyla potvrzeně čitelná) + unit AKTIVNÍ -> "warn", ne "ok" (regrese fix round 1)', async () => {
  fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(dbPath, 'tohle neni platny sqlite soubor');
  delete process.env.MC_NANOCLAW_NO_SYSTEMD;
  process.env.MC_NANOCLAW_TEST_UNIT_ACTIVE = '1';
  try {
    await assert.doesNotReject(nc.refreshNanoclaw());
    const snap = nc.collectNanoclaw();
    assert.equal(snap.unit?.active, 'active', `test hook musí vrátit aktivní unit — mám ${JSON.stringify(snap.unit)}`);
    assert.equal(snap.state, 'warn', `DB se ještě nikdy nepodařilo přečíst -> 'warn' i s aktivní unitou; mám ${JSON.stringify(snap)}`);
    assert.deepEqual(snap.agents, []);
  } finally {
    delete process.env.MC_NANOCLAW_TEST_UNIT_ACTIVE;
    process.env.MC_NANOCLAW_NO_SYSTEMD = '1'; // vrátit pro zbytek souboru (žádné další systemctl volání)
  }
});

test('collectNanoclaw: 1 agent + 2 sessions (1 running) v naseedované DB -> agents[0].sessions===2, running===1', async () => {
  fs.rmSync(dbPath, { force: true }); // smazat garbage soubor z testu výš — DatabaseSync na něm nesmí selhat
  fs.mkdirSync(dbDir, { recursive: true });
  const d = new DatabaseSync(dbPath);
  d.exec(`CREATE TABLE agent_groups (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
    agent_provider TEXT, created_at TEXT NOT NULL
  );`);
  d.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
    thread_id TEXT, agent_provider TEXT, status TEXT DEFAULT 'active',
    container_status TEXT DEFAULT 'stopped', last_active TEXT, created_at TEXT NOT NULL
  );`);
  const now = new Date();
  const older = new Date(now.getTime() - 3600_000);
  d.prepare('INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?,?,?,?,?)')
    .run('ag-1', 'TestAgent', 'test_folder', 'anthropic', older.toISOString());
  const ins = d.prepare(`INSERT INTO sessions (id, agent_group_id, container_status, last_active, created_at)
    VALUES (?,?,?,?,?)`);
  ins.run('s-1', 'ag-1', 'running', now.toISOString(), older.toISOString());
  ins.run('s-2', 'ag-1', 'stopped', older.toISOString(), older.toISOString());
  d.close();

  await nc.refreshNanoclaw();
  const snap = nc.collectNanoclaw();
  assert.equal(snap.agents.length, 1);
  assert.equal(snap.agents[0].name, 'TestAgent');
  assert.equal(snap.agents[0].folder, 'test_folder');
  assert.equal(snap.agents[0].sessions, 2);
  assert.equal(snap.agents[0].running, 1);
  assert.equal(snap.agents[0].lastActive, now.getTime());
  // MC_NANOCLAW_NO_SYSTEMD=1 -> žádná unit nalezena -> DB čitelná, ale bez
  // unity -> 'warn' (viz modules/nanoclaw.js computeState).
  assert.equal(snap.unit, null);
  assert.equal(snap.state, 'warn');
  assert.ok(snap.updatedAt != null);
});

test('modul exportuje refresh + collect funkce', () => {
  assert.equal(typeof nc.refreshNanoclaw, 'function');
  assert.equal(typeof nc.collectNanoclaw, 'function');
});

// Čisté testy stavového žebříčku (žádné I/O, žádný env) — přímo dokumentují
// ladder rozhodnutí z fix round 1: 'ok' vyžaduje AKTIVNÍ unit A everReadOk;
// 'crit' (stojící unit) má přednost i před nepotvrzeně čitelnou DB.
test('computeState: unit aktivní + DB potvrzeně čitelná (everReadOk=true) -> "ok"', () => {
  assert.equal(nc.computeState({ name: 'x', active: 'active' }, true), 'ok');
});
test('computeState: unit aktivní, ale DB ještě NIKDY nebyla čitelná (everReadOk=false) -> "warn", ne "ok"', () => {
  assert.equal(nc.computeState({ name: 'x', active: 'active' }, false), 'warn');
});
test('computeState: unit nalezena, ale neaktivní (inactive/failed) -> "crit" i s everReadOk=true', () => {
  assert.equal(nc.computeState({ name: 'x', active: 'inactive' }, true), 'crit');
  assert.equal(nc.computeState({ name: 'x', active: 'failed' }, true), 'crit');
});
test('computeState: stojící unit má přednost před nepotvrzeně čitelnou DB -> "crit", ne "warn"', () => {
  assert.equal(nc.computeState({ name: 'x', active: 'failed' }, false), 'crit');
});
test('computeState: žádná unit nenalezena -> "warn" bez ohledu na everReadOk', () => {
  assert.equal(nc.computeState(null, true), 'warn');
  assert.equal(nc.computeState(null, false), 'warn');
});

// computeStaleMs: floor 5 min pro krátký refresh interval, škáluje (2,5×)
// nad floor pro delší configovaný interval (bundled ruling z fix round 1 —
// bez týhle derivace by operátor s refreshMs > 5 min viděl 'warn' na každém
// zdravém snímku, protože pevných 5 min by bylo kratší než refresh interval).
test('computeStaleMs: krátký refresh (60 s, výchozí) -> floor 5 min vyhrává (2,5×60s=150s < 300s)', () => {
  assert.equal(nc.computeStaleMs(60_000), 5 * 60_000);
});
test('computeStaleMs: dlouhý refresh (10 min) -> škáluje 2,5× nad floor (25 min > 5 min)', () => {
  assert.equal(nc.computeStaleMs(10 * 60_000), 25 * 60_000);
});
