// TDD pro Fix round 2 (SECURITY): watchdog/append.sh — validovaný appender,
// který v run-watchdog.sh SAFE módu nahrazuje obecné `Bash(echo:*)` (to šlo
// zneužít na `echo … >> ~/.ssh/authorized_keys` apod. — echo neví, KAM smí
// zapisovat). Test spouští append.sh jako SKUTEČNÝ shell proces (spawnSync),
// stejně jako test/watchdog-gen.test.mjs spouští gen.mjs — je to skript
// volaný headless Claude agentem přes --allowedTools, ne modul importovaný
// do serveru.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APPEND = fileURLToPath(new URL('../watchdog/append.sh', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/mc.config.watchdog.json', import.meta.url)); // projekty: alpha, beta

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-watchdog-append-'));
const dataDir = path.join(tmpHome, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const narrativeDir = path.join(dataDir, 'narrative');
const historyFile = path.join(dataDir, 'watchdog-history.jsonl');

const ENV = {
  ...process.env,
  MC_CONFIG: FIXTURE,
  MC_AGENT_HOME: tmpHome,
  MC_DATA_DIR: dataDir,
  MC_NARRATIVE_DIR: narrativeDir,
  MC_WATCHDOG_HISTORY: historyFile,
};

function run(args) {
  return spawnSync('bash', [APPEND, ...args], { env: ENV, encoding: 'utf-8' });
}

after(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------- happy path ----------

test('append.sh history "<text>" -> připojí přesně jeden řádek do WATCHDOG_HISTORY (i s neexistujícím rodičovským adresářem)', () => {
  assert.ok(!fs.existsSync(historyFile), 'test předpoklad: historie ještě neexistuje');
  const r = run(['history', '{"ts":"2026-08-20T10:00:00Z","overall":"ok"}']);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const content = fs.readFileSync(historyFile, 'utf-8');
  assert.equal(content, '{"ts":"2026-08-20T10:00:00Z","overall":"ok"}\n');
});

test('append.sh history: druhé volání PŘIPOJÍ (append-only), nepřepíše první řádek', () => {
  const r = run(['history', '{"ts":"2026-08-20T11:00:00Z","overall":"ok"}']);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const lines = fs.readFileSync(historyFile, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /10:00:00Z/);
  assert.match(lines[1], /11:00:00Z/);
});

test('append.sh alpha "<text>" -> nakonfigurovaný projekt (fixture) připojí řádek do narrative/alpha.log', () => {
  const r = run(['alpha', '[2026-08-20 10:00] 🟢 test běží']);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const content = fs.readFileSync(path.join(narrativeDir, 'alpha.log'), 'utf-8');
  assert.equal(content, '[2026-08-20 10:00] 🟢 test běží\n');
});

test('append.sh: víceslovný text (více argv prvků) se spojí mezerou do jednoho řádku', () => {
  const r = run(['beta', '[2026-08-20', '10:05]', '✅', 'hotovo', '—', 'více', 'slov']);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const content = fs.readFileSync(path.join(narrativeDir, 'beta.log'), 'utf-8');
  assert.equal(content, '[2026-08-20 10:05] ✅ hotovo — více slov\n');
});

// ---------- rejection path ----------

test('append.sh ../evil "<text>" -> odmítne (path traversal), nic nezapíše mimo NARRATIVE_DIR', () => {
  const r = run(['../evil', 'pokus o útěk']);
  assert.notEqual(r.status, 0, 'append.sh musí selhat na neplatný target');
  assert.match(r.stderr, /neplatný target/);
  assert.ok(!fs.existsSync(path.join(dataDir, '..', 'evil.log')), 'mimo NARRATIVE_DIR nesmí nic vzniknout');
});

test('append.sh unknown-project "<text>" -> odmítne (id sedí na regex, ale není v mc.config.json projektech)', () => {
  const r = run(['unknown-project', 'pokus o zápis mimo whitelist']);
  assert.notEqual(r.status, 0, 'append.sh musí selhat na neznámý projekt');
  assert.match(r.stderr, /neznámý watchdog projekt/);
  assert.ok(!fs.existsSync(path.join(narrativeDir, 'unknown-project.log')));
});

test('append.sh bez argumentů -> chyba na stderr + exit != 0 (set -u, žádný tichý no-op)', () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /použití/i);
});

test('append.sh history bez textu -> chyba (nesmí založit prázdný řádek)', () => {
  const before = fs.readFileSync(historyFile, 'utf-8');
  const r = run(['history']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /chybí text/);
  assert.equal(fs.readFileSync(historyFile, 'utf-8'), before, 'historie se nesmí změnit při chybě');
});

test('append.sh "; rm -rf /tmp" "<text>" -> odmítne (target neprojde kebab-case regexem, žádný shell-eval)', () => {
  const r = run(['; rm -rf /tmp', 'text']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /neplatný target/);
});
