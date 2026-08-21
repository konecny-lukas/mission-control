// TDD pro Task 12: modul wpsched (WP REST, read-only) — Step 1: buildSnapshot()
// je čistá klasifikační fn, ŽÁDNÉ I/O, ŽÁDNÁ síť (probeSite/refreshWpsched se
// tu nikdy nevolají — viz brief: "No network in tests"). Vstup napodobuje, co
// server dostane z probeSite() ve modules/wpsched.js: pole
// [{id, label, url, ok, err?, posts:[{id, title, date_gmt, status, link}]}].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../modules/wpsched.js';
import * as C from '../config.js';

// WP REST date_gmt tvar: 'YYYY-MM-DDTHH:MM:SS' BEZ 'Z' (ale je to UTC).
const wpIso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '');

test('buildSnapshot: post s date_gmt hodinu v minulosti (za grace) je stuck', () => {
  const now = Date.now();
  const past = now - 60 * 60_000;
  const snap = buildSnapshot(now, [
    { id: 'a', label: 'A', url: 'https://a.example', ok: true, posts: [
      { id: 1, title: 'Zaseknutý', date_gmt: wpIso(past), status: 'future', link: 'https://a.example/?p=1' },
    ] },
  ]);
  assert.equal(snap.state, 'crit');
  assert.equal(snap.checkedAt, now);
  assert.equal(snap.sites.length, 1);
  assert.equal(snap.sites[0].id, 'a');
  assert.equal(snap.sites[0].ok, true);
  assert.equal(snap.sites[0].futureCount, 1);
  assert.equal(snap.sites[0].stuck.length, 1);
  assert.equal(snap.sites[0].stuck[0].id, 1);
  assert.equal(snap.sites[0].stuck[0].title, 'Zaseknutý');
  assert.equal(snap.sites[0].stuck[0].link, 'https://a.example/?p=1');
  assert.equal(snap.sites[0].next, null);
});

test('buildSnapshot: post s date_gmt za hodinu je next, ne stuck', () => {
  const now = Date.now();
  const future = now + 60 * 60_000;
  const snap = buildSnapshot(now, [
    { id: 'a', label: 'A', url: 'https://a.example', ok: true, posts: [
      { id: 2, title: 'V pořádku', date_gmt: wpIso(future), status: 'future', link: 'https://a.example/?p=2' },
    ] },
  ]);
  assert.equal(snap.state, 'ok');
  assert.equal(snap.sites[0].stuck.length, 0);
  assert.deepEqual(snap.sites[0].next, { title: 'V pořádku', at: wpIso(future) });
});

test('buildSnapshot: next = nejbližší z víc budoucích postů (bez ohledu na pořadí ve vstupu)', () => {
  const now = Date.now();
  const soon = now + 30 * 60_000;
  const later = now + 5 * 3600_000;
  const snap = buildSnapshot(now, [
    { id: 'a', ok: true, posts: [
      { id: 1, title: 'Pozdější', date_gmt: wpIso(later) },
      { id: 2, title: 'Brzo', date_gmt: wpIso(soon) },
    ] },
  ]);
  assert.equal(snap.sites[0].next.title, 'Brzo');
});

test('buildSnapshot: hranice grace okna — těsně uvnitř NENÍ stuck, těsně za NÍM JE', () => {
  const now = Date.now();
  // 5s bezpečný odstup od hranice, ať ho nesmaže useknutí ms při iso->WP tvaru
  const insideGrace = now - (C.WPSCHED_GRACE_MS - 5000);
  const pastGrace = now - (C.WPSCHED_GRACE_MS + 5000);
  const snap = buildSnapshot(now, [
    { id: 'a', ok: true, posts: [
      { id: 1, title: 'Těsně uvnitř grace', date_gmt: wpIso(insideGrace), status: 'future' },
      { id: 2, title: 'Těsně za grace', date_gmt: wpIso(pastGrace), status: 'future' },
    ] },
  ]);
  assert.equal(snap.sites[0].stuck.length, 1);
  assert.equal(snap.sites[0].stuck[0].id, 2);
  assert.equal(snap.sites[0].next.title, 'Těsně uvnitř grace');
});

test('buildSnapshot: title jako {rendered} objekt i jako holý string', () => {
  const now = Date.now();
  const future = now + 3_600_000;
  const snap = buildSnapshot(now, [
    { id: 'a', ok: true, posts: [
      { id: 1, title: { rendered: 'Objekt' }, date_gmt: wpIso(future) },
    ] },
  ]);
  assert.equal(snap.sites[0].next.title, 'Objekt');
});

test('buildSnapshot: chybějící/nerozparsovatelné date_gmt nehavaruje a post se nepočítá jako stuck ani next', () => {
  const now = Date.now();
  assert.doesNotThrow(() => buildSnapshot(now, [
    { id: 'a', ok: true, posts: [
      { id: 1, title: 'Bez data', date_gmt: null },
      { id: 2, title: 'Blbost', date_gmt: 'not-a-date' },
      { id: 3, title: 'Chybí pole' },
    ] },
  ]));
  const snap = buildSnapshot(now, [
    { id: 'a', ok: true, posts: [{ id: 1, title: 'Bez data', date_gmt: null }] },
  ]);
  assert.equal(snap.sites[0].stuck.length, 0);
  assert.equal(snap.sites[0].next, null);
  assert.equal(snap.sites[0].futureCount, 1); // futureCount = počet postů ze sondy, ne jen klasifikovaných
  assert.equal(snap.state, 'ok');
});

test('buildSnapshot: web s ok:false propaguje err a state je aspoň warn', () => {
  const now = Date.now();
  const snap = buildSnapshot(now, [
    { id: 'a', label: 'A', url: 'https://a.example', ok: false, err: 'HTTP 401' },
  ]);
  assert.equal(snap.state, 'warn');
  assert.equal(snap.sites[0].ok, false);
  assert.equal(snap.sites[0].err, 'HTTP 401');
  assert.equal(snap.sites[0].futureCount, 0);
  assert.deepEqual(snap.sites[0].stuck, []);
  assert.equal(snap.sites[0].next, null);
});

test('buildSnapshot: crit má přednost před warn (jeden web stuck, druhý ok:false)', () => {
  const now = Date.now();
  const past = now - 3_600_000;
  const snap = buildSnapshot(now, [
    { id: 'a', ok: true, posts: [{ id: 1, title: 'X', date_gmt: wpIso(past) }] },
    { id: 'b', ok: false, err: 'timeout' },
  ]);
  assert.equal(snap.state, 'crit');
});

test('buildSnapshot: prázdný vstup -> state ok, žádné weby', () => {
  const now = Date.now();
  const snap = buildSnapshot(now, []);
  assert.equal(snap.state, 'ok');
  assert.deepEqual(snap.sites, []);
});

test('modul exportuje refresh funkci, ale tenhle test se sítě nikdy nedotkne', () => {
  // Nepoužívá se nic síťového ani I/O — jen ověření, že export existuje a je fn.
  return import('../modules/wpsched.js').then((m) => {
    assert.equal(typeof m.refreshWpsched, 'function');
    assert.equal(typeof m.collectWpsched, 'function');
    assert.equal(typeof m.buildSnapshot, 'function');
  });
});
