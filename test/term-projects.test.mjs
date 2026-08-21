// TDD pro Task 5: terminálové projekty z jednoho zdroje (CFG.terminals.projects)
// + CLI bin/mc-project.mjs, kterým se na klíč ptá i mc-claude.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MC_CONFIG = new URL('./fixtures/mc.config.json', import.meta.url).pathname;
process.env.MC_AGENT_HOME = '/tmp/mc-test-home';
const C = await import('../config.js');

const MC_PROJECT_CLI = fileURLToPath(new URL('../bin/mc-project.mjs', import.meta.url));
const ENV = { ...process.env, MC_CONFIG: process.env.MC_CONFIG, MC_AGENT_HOME: '/tmp/mc-test-home' };

test('config: TERM_KEYS obsahuje projekty z fixture configu', () => {
  assert.ok(C.TERM_KEYS.includes('home'), `TERM_KEYS = ${JSON.stringify(C.TERM_KEYS)}`);
});

test('config: TERM_PROJECTS má expandnuté dir a MCTASK_PROJECTS je odvozené', () => {
  const home = C.TERM_PROJECTS.find((p) => p.key === 'home');
  assert.equal(home.dir, '/tmp/mc-test-home');
  assert.equal(home.label, 'Domů');
  assert.deepEqual(C.MCTASK_PROJECTS.home, { label: 'Domů', dir: '/tmp/mc-test-home' });
});

test('mc-project.mjs dir <known> -> absolutní cesta na stdout', () => {
  const out = execFileSync('node', [MC_PROJECT_CLI, 'dir', 'home'], { env: ENV, encoding: 'utf-8' });
  assert.equal(out.trim(), '/tmp/mc-test-home');
});

test('mc-project.mjs dir <neznámý> -> exit != 0 + zpráva na stderr', () => {
  const r = spawnSync('node', [MC_PROJECT_CLI, 'dir', 'neexistuje'], { env: ENV, encoding: 'utf-8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /neznámý projekt/i);
});

test('mc-project.mjs list -> JSON pole projektů', () => {
  const out = execFileSync('node', [MC_PROJECT_CLI, 'list'], { env: ENV, encoding: 'utf-8' });
  const arr = JSON.parse(out);
  assert.ok(Array.isArray(arr));
  assert.ok(arr.some((p) => p.key === 'home' && p.label === 'Domů'));
});
