// TDD pro Task 14 fix round 1 (finding 2): shell-safety filtr na
// modules.watchdog.projects[].id. `id` teče do path.join(NARRATIVE_DIR,
// id+'.log') a do bash "$NARRATIVE_DIR/$N.log" + mapfile parsing
// (watchdog/run-watchdog.sh, watchdog/check.sh) — '../' by korumpovalo
// cesty mimo NARRATIVE_DIR, newline v id by rozbil řádkový mapfile parsing.
// Vlastní izolovaný soubor (samostatný proces node --test), aby MC_CONFIG
// nekolidoval s ostatními watchdog testy, které config.js importují přímo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.MC_CONFIG = fileURLToPath(new URL('./fixtures/mc.config.watchdog.badids.json', import.meta.url));
process.env.MC_AGENT_HOME = '/tmp/mc-test-home-watchdog-ids';
const C = await import('../config.js');

test('WATCHDOG_PROJECTS: platná id (kebab-case) projdou filtrem', () => {
  const ids = C.WATCHDOG_PROJECTS.map((p) => p.id);
  assert.ok(ids.includes('good-id'), `ids = ${JSON.stringify(ids)}`);
  assert.ok(ids.includes('second-ok'), `ids = ${JSON.stringify(ids)}`);
});

test('WATCHDOG_PROJECTS: id "../evil" (path traversal) je vyfiltrováno', () => {
  const ids = C.WATCHDOG_PROJECTS.map((p) => p.id);
  assert.ok(!ids.includes('../evil'), `ids = ${JSON.stringify(ids)}`);
});

test('WATCHDOG_PROJECTS: id s newline uvnitř je vyfiltrováno', () => {
  const ids = C.WATCHDOG_PROJECTS.map((p) => p.id);
  assert.ok(!ids.some((id) => id.includes('\n')), `ids = ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes('bad\nid'), `ids = ${JSON.stringify(ids)}`);
});

test('WATCHDOG_PROJECTS: fixture se 4 projekty -> jen 2 platné projdou filtrem', () => {
  assert.equal(C.WATCHDOG_PROJECTS.length, 2);
});
