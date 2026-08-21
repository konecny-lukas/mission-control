/* MC v2 — state singleton + sekce.
   S je JEDINÝ zdroj pravdy (živý snapshot /api/status, průběžně přepisovaný
   SSE patchi). Sekce se registrují s deklarací závislostí na top-level klíčích;
   patch(keys) přerenderuje POUZE sekce, jejichž deps protínají změněné klíče.
   Renderery jsou idempotentní innerHTML rebuildy — žádný vlastní stav v DOM. */

export const S = {}; // živý snapshot — mutován in-place, reference stabilní pro všechny importy

const sections = []; // { id, deps:Set<string>, fn }

export function registerSection(id, deps, fn) {
  sections.push({ id, deps: new Set(deps), fn });
}

function run(sec) {
  try { sec.fn(S); }
  catch (e) { console.error(`[store] render „${sec.id}":`, e); }
}

export function renderAll() {
  for (const sec of sections) run(sec);
}

// keys = pole změněných top-level klíčů (z SSE patche nebo poll diffu)
export function patch(keys) {
  if (!keys || !keys.length) return;
  for (const sec of sections) {
    for (const k of keys) {
      if (sec.deps.has(k)) { run(sec); break; }
    }
  }
}

// celá výměna stavu (SSE snapshot / první poll) — S zůstává tentýž objekt
export function replaceState(next) {
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, next);
}
