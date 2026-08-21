// TDD pro Task 14: modul watchdog (read-only panel/drawer nad výstupem
// hodinového cron-watchdog agenta). Test se NIKDY nedotkne skutečné produkční
// historie — vlastní tmp DATA_DIR (stejný vzor jako
// test/nanoclaw-collect.test.mjs), watchdog-history.jsonl a narrative/*.log
// se seedují ručně do izolovaného adresáře.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MC_CONFIG = fileURLToPath(new URL('./fixtures/mc.config.watchdog.json', import.meta.url));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-watchdog-home-'));
process.env.MC_AGENT_HOME = tmpHome;
process.env.MC_DATA_DIR = path.join(tmpHome, 'data');
fs.mkdirSync(process.env.MC_DATA_DIR, { recursive: true });

// Env MUSÍ být nastavený PŘED importem config.js/modules/watchdog.js (obojí
// čte CFG synchronně při importu) — stejný vzor jako sourozenci.
const C = await import('../config.js');
const wd = await import('../modules/watchdog.js');

after(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('collectWatchdog: žádná watchdog-history.jsonl -> state "warn" (hlídač ještě neběžel), last null, prázdná historie', () => {
  const snap = wd.collectWatchdog();
  assert.equal(snap.state, 'warn');
  assert.equal(snap.last, null);
  assert.deepEqual(snap.history, []);
  assert.equal(snap.updatedAt, null);
  // projekty z fixture (alpha/beta) se ukážou i bez narativu — jen s prázdným polem
  assert.equal(snap.projects.length, 2);
  assert.deepEqual(snap.projects[0], { id: 'alpha', label: 'Projekt Alfa', narrative: [] });
});

test('collectWatchdog: 2 history záznamy (poslední ok, čerstvý) -> state "ok", last === nejnovější záznam, history má oba (nejnovější první)', () => {
  fs.mkdirSync(C.DATA_DIR, { recursive: true });
  const now = new Date();
  const older = new Date(now.getTime() - 3600_000);
  const rows = [
    { ts: older.toISOString(), overall: 'alert', projects: { alpha: 'warn' }, actions: [], alerts: [{ id: 'stale-lock', text: 'starý problém' }] },
    { ts: now.toISOString(), overall: 'ok', projects: { alpha: 'ok', beta: 'ok' }, actions: ['smazán stale lock'], alerts: [] },
  ];
  fs.writeFileSync(C.WATCHDOG_HISTORY, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

  const snap = wd.collectWatchdog();
  assert.equal(snap.state, 'ok');
  assert.equal(snap.history.length, 2);
  assert.equal(snap.last.overall, 'ok');
  assert.deepEqual(snap.last, rows[1]);
  assert.equal(snap.history[0].overall, 'ok');   // nejnovější první
  assert.equal(snap.history[1].overall, 'alert');
  assert.ok(snap.updatedAt != null);
});

test('collectWatchdog: poslední záznam overall==="alert" -> state "warn"', () => {
  fs.mkdirSync(C.DATA_DIR, { recursive: true });
  const now = new Date();
  fs.writeFileSync(C.WATCHDOG_HISTORY, JSON.stringify({ ts: now.toISOString(), overall: 'alert', projects: {}, actions: [], alerts: [{ id: 'x', text: 'y' }] }) + '\n', 'utf-8');
  const snap = wd.collectWatchdog();
  assert.equal(snap.state, 'warn');
});

test('collectWatchdog: poslední záznam je STARÝ (>2h) i s overall "ok" -> state "warn" (freshness gate)', () => {
  fs.mkdirSync(C.DATA_DIR, { recursive: true });
  const old = new Date(Date.now() - 3 * 3600_000);
  fs.writeFileSync(C.WATCHDOG_HISTORY, JSON.stringify({ ts: old.toISOString(), overall: 'ok', projects: {}, actions: [], alerts: [] }) + '\n', 'utf-8');
  const snap = wd.collectWatchdog();
  assert.equal(snap.state, 'warn');
});

test('collectWatchdog: narativní log projektu se čte a je omezen na posledních 14 řádků', () => {
  fs.mkdirSync(C.NARRATIVE_DIR, { recursive: true });
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`[2026-08-20 0${i % 10}:00] 🟢 řádek ${i}`);
  fs.writeFileSync(path.join(C.NARRATIVE_DIR, 'alpha.log'), lines.join('\n') + '\n', 'utf-8');
  const snap = wd.collectWatchdog();
  const alpha = snap.projects.find((p) => p.id === 'alpha');
  assert.equal(alpha.narrative.length, 14);
  assert.match(alpha.narrative[13], /řádek 19$/);
  assert.match(alpha.narrative[0], /řádek 6$/); // posledních 14 z 20 -> začíná řádkem 6
});

test('modul exportuje collectWatchdog', () => {
  assert.equal(typeof wd.collectWatchdog, 'function');
});
