import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.MC_CONFIG = new URL('./fixtures/mc.config.json', import.meta.url).pathname;
process.env.MC_AGENT_HOME = '/tmp/mc-test-home';
const C = await import('../config.js');

test('config: branding z mc.config.json', () => {
  assert.equal(C.BRAND.name, 'TESTBOX');
  assert.equal(C.BRAND.accent, '#2ba8ff');
});
test('config: modul zapnutý = má sekci', () => {
  assert.equal(C.MODULES.uptime, true);
  assert.equal(C.MODULES.ga4, true);
});
test('config: prázdná sekce modulu ({}) se počítá jako zapnuto (!!({}) === true) — claudelimits z fixture', () => {
  assert.equal(C.MODULES.claudelimits, true);
});
test('config: expandHome', () => {
  assert.equal(C.expandHome('~/x'), '/tmp/mc-test-home/x');
});

// Task 17b — SERVICES_CFG (mc.config.json "services", spec §4).
test('config: services — chybějící klíč v configu -> SERVICES_CFG null (zpětná kompatibilita)', () => {
  // Fixture nahoře (mc.config.json) klíč "services" nemá.
  assert.equal(C.SERVICES_CFG, null);
  // Bez configu zůstává RESTARTABLE_SERVICES jen na vestavěné dvojici.
  assert.deepEqual(Object.keys(C.RESTARTABLE_SERVICES), ['mission-control', 'mc-ttyd']);
});

// Fresh import s jiným MC_CONFIG — cache-busting query, aby se config.js
// vyhodnotil znovu (ESM cache jinak vrátí modul importovaný nahoře).
test('config: services — validní položka zůstává, neplatný unit se vyřadí, scope se promítá do RESTARTABLE_SERVICES', async () => {
  process.env.MC_CONFIG = new URL('./fixtures/mc.config.services.json', import.meta.url).pathname;
  const C2 = await import(`../config.js?services-test=${Date.now()}`);

  // "bad unit name!" neprojde regexem /^[a-zA-Z0-9][a-zA-Z0-9@._-]{0,63}$/ (mezery, "!") -> zahozeno.
  // "-leading-dash-svc" taky neprojde — první znak musí být alfanumerický
  // (vedoucí '-' by u některých nástrojů mohlo být čteno jako přepínač).
  assert.deepEqual(C2.SERVICES_CFG.map((s) => s.unit), ['mc-smoke-fixture-svc', 'mc-smoke-system-svc']);
  assert.equal(C2.SERVICES_CFG[0].label, 'Fixture služba');

  // scope:'user' (i chybějící scope) přibývá do restart allowlistu VEDLE
  // vestavěných mission-control/mc-ttyd; scope:'system' se do restart
  // allowlistu nedostane (restart endpoint jede natvrdo `systemctl --user`).
  assert.deepEqual(Object.keys(C2.RESTARTABLE_SERVICES),
    ['mission-control', 'mc-ttyd', 'mc-smoke-fixture-svc']);
  assert.equal(C2.RESTARTABLE_SERVICES['mc-smoke-fixture-svc'].label, 'Fixture služba');
  assert.equal(C2.RESTARTABLE_SERVICES['mc-smoke-system-svc'], undefined);
});
