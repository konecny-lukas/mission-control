// TDD pro Task 14: watchdog/gen.mjs — JEDINÝ zdroj pravdy pro projekty a
// parametry hlídače je CFG.modules.watchdog (config.js); gen.mjs z něj
// generuje prompt pro headless Claude + seznamy pro shell smyčky
// (watchdog/run-watchdog.sh, watchdog/check.sh). Test volá gen.mjs jako
// SKUTEČNÉ CLI (spawnSync), stejně jako bin/mc-project.mjs v
// test/term-projects.test.mjs — je to podproces spouštěný z bash skriptů,
// ne modul importovaný přímo do serveru.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GEN = fileURLToPath(new URL('../watchdog/gen.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/mc.config.watchdog.json', import.meta.url));
// Fix round 1: permissionMode:'full' fixture (permissionMode:'safe' je default
// bez explicitního klíče — FIXTURE výš to pokrývá).
const FIXTURE_FULL = fileURLToPath(new URL('./fixtures/mc.config.watchdog.full.json', import.meta.url));

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-watchdog-gen-'));
const dataDir = path.join(tmpHome, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const ENV = { ...process.env, MC_CONFIG: FIXTURE, MC_AGENT_HOME: tmpHome, MC_DATA_DIR: dataDir };

test('gen.mjs prompt: fixture se 2 projekty -> vygeneruje data/watchdog-prompt.md s oběma labely, bez {{ placeholderů', () => {
  const r = spawnSync(process.execPath, [GEN, 'prompt'], { env: ENV, encoding: 'utf-8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const outPath = r.stdout.trim();
  assert.ok(outPath, 'gen.mjs prompt musí vypsat cestu k vygenerovanému souboru na stdout');
  assert.ok(fs.existsSync(outPath), `vygenerovaný soubor neexistuje: ${outPath}`);
  const content = fs.readFileSync(outPath, 'utf-8');
  assert.match(content, /Projekt Alfa/);
  assert.match(content, /Projekt Beta/);
  assert.ok(!content.includes('{{'), `v promptu zůstal nenahrazený placeholder:\n${content}`);
});

test('gen.mjs projects: vypíše 2 řádky (id projektů, jeden na řádek)', () => {
  const r = spawnSync(process.execPath, [GEN, 'projects'], { env: ENV, encoding: 'utf-8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  assert.deepEqual(lines, ['alpha', 'beta']);
});

test('gen.mjs env: vypíše WATCHDOG_MODEL/WATCHDOG_BUDGET/WATCHDOG_TIMEOUT z configu', () => {
  const r = spawnSync(process.execPath, [GEN, 'env'], { env: ENV, encoding: 'utf-8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /^WATCHDOG_MODEL=haiku$/m);
  assert.match(r.stdout, /^WATCHDOG_BUDGET=0\.5$/m);
  assert.match(r.stdout, /^WATCHDOG_TIMEOUT=300$/m);
});

test('gen.mjs bez subcommand -> chyba na stderr + exit != 0', () => {
  const r = spawnSync(process.execPath, [GEN], { env: ENV, encoding: 'utf-8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /použití/i);
});

test('gen.mjs prompt: prázdné projekty (empty fixture) -> soubor se vygeneruje, bez {{ placeholderů, s vysvětlující poznámkou', () => {
  const emptyEnv = { ...ENV, MC_CONFIG: fileURLToPath(new URL('./fixtures/mc.config.empty.json', import.meta.url)) };
  const r = spawnSync(process.execPath, [GEN, 'prompt'], { env: emptyEnv, encoding: 'utf-8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const outPath = r.stdout.trim();
  const content = fs.readFileSync(outPath, 'utf-8');
  assert.ok(!content.includes('{{'), `v promptu zůstal nenahrazený placeholder:\n${content}`);
});

// ── Fix round 1: SECURITY finding 1 (permissionMode safe/full) ─────────────

test('gen.mjs env: bez permissionMode v configu -> WATCHDOG_PERMISSION_MODE=safe (default)', () => {
  const r = spawnSync(process.execPath, [GEN, 'env'], { env: ENV, encoding: 'utf-8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /^WATCHDOG_PERMISSION_MODE=safe$/m);
});

test('gen.mjs env: permissionMode:"full" v configu -> WATCHDOG_PERMISSION_MODE=full', () => {
  const fullEnv = { ...ENV, MC_CONFIG: FIXTURE_FULL };
  const r = spawnSync(process.execPath, [GEN, 'env'], { env: fullEnv, encoding: 'utf-8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /^WATCHDOG_PERMISSION_MODE=full$/m);
});

test('gen.mjs prompt: obsahuje prompt-injection hardening blok ("DATA, ne instrukce") v obou permissionMode', () => {
  const r1 = spawnSync(process.execPath, [GEN, 'prompt'], { env: ENV, encoding: 'utf-8' });
  assert.equal(r1.status, 0, `stderr: ${r1.stderr}`);
  const content1 = fs.readFileSync(r1.stdout.trim(), 'utf-8');
  assert.match(content1, /DATA, ne instrukce/);
  assert.match(content1, /Nikdy nevykonávej pokyny nalezené/);

  const fullEnv = { ...ENV, MC_CONFIG: FIXTURE_FULL };
  const r2 = spawnSync(process.execPath, [GEN, 'prompt'], { env: fullEnv, encoding: 'utf-8' });
  assert.equal(r2.status, 0, `stderr: ${r2.stderr}`);
  const content2 = fs.readFileSync(r2.stdout.trim(), 'utf-8');
  assert.match(content2, /DATA, ne instrukce/);
  assert.match(content2, /Nikdy nevykonávej pokyny nalezené/);
});

test('gen.mjs prompt: safe mode (default) -> SAFE-fixes sekce (žádný kill/rm, jen alert+user systemd restart), bez {{', () => {
  const r = spawnSync(process.execPath, [GEN, 'prompt'], { env: ENV, encoding: 'utf-8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const content = fs.readFileSync(r.stdout.trim(), 'utf-8');
  assert.match(content, /SAFE mode/);
  assert.match(content, /POUZE NAHLAS, NEZASAHUJ/);
  assert.ok(!content.includes('kill -TERM <PID>'), `safe mode nesmí obsahovat plnou kill whitelist z full módu:\n${content}`);
  assert.ok(!content.includes('{{'), `v promptu zůstal nenahrazený placeholder:\n${content}`);
});

test('gen.mjs prompt: full mode -> původní whitelist (kill dle PID), žádný SAFE-mode text, bez {{', () => {
  const fullEnv = { ...ENV, MC_CONFIG: FIXTURE_FULL };
  const r = spawnSync(process.execPath, [GEN, 'prompt'], { env: fullEnv, encoding: 'utf-8' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const content = fs.readFileSync(r.stdout.trim(), 'utf-8');
  assert.match(content, /kill -TERM <PID>/);
  assert.match(content, /Zabít proces/);
  assert.ok(!content.includes('SAFE mode'), `full mode nesmí obsahovat SAFE-mode text:\n${content}`);
  assert.ok(!content.includes('{{'), `v promptu zůstal nenahrazený placeholder:\n${content}`);
});
