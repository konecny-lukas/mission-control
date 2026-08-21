// TDD pro Task 6: modulový gating v jádru — uptime jako první modul.
// Boot-level test: reálně nastartuje server.js jako child proces s fixture
// configem a čte /api/status. Sonduje jen přítomnost klíčů (`in`), ne výsledek
// reálné HTTP probe na example.com (ta smí selhat — fire-and-forget).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const FIX_WITH_UPTIME = fileURLToPath(new URL('./fixtures/mc.config.json', import.meta.url));
const FIX_EMPTY = fileURLToPath(new URL('./fixtures/mc.config.empty.json', import.meta.url));

// nanoclaw v FIX_WITH_UPTIME má dir na neexistující cestu -> refreshNanoclaw()
// nikdy nesahá na DB (viz modules/nanoclaw.js) a i tak se testu vyhne
// systemctl volání úplně (brief to mandatuje pro testy) — bez tohohle by boot
// (i s neexistující DB) mohl na cizím CI/dev stroji bez systemd --user viset
// na execFile timeoutu (4 s, jen zpomalí, nespadne, ale zbytečně).
process.env.MC_NANOCLAW_NO_SYSTEMD = '1';

// Nastartuje server.js jako child proces s izolovaným tmp HOME/DATA_DIR a
// vlastním portem, počká na /api/status (timeout), vrátí { proc, status }.
// Volající MUSÍ vždy zavolat stop(proc) — i při chybě (finally).
async function bootServer(port, configFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gating-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const env = {
    ...process.env,
    MC_PORT: String(port),
    MC_CONFIG: configFile,
    MC_AGENT_HOME: tmp,
    MC_DATA_DIR: dataDir,
  };
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (proc.exitCode != null) throw new Error(`server (port ${port}) skončil dřív, než se rozjel — kód ${proc.exitCode}\n${stderr.slice(0, 2000)}`);
    try {
      const res = await fetch(`${base}/api/status`);
      if (res.ok) return { proc, status: await res.json() };
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill('SIGKILL');
  throw new Error(`server (port ${port}) neodpověděl do 10 s: ${lastErr?.message || 'timeout'}\n${stderr.slice(0, 2000)}`);
}

// ALWAYS kill by PID — i kdyby proces sám nezvládl SIGTERM (test nesmí viset).
function stopServer(proc) {
  if (!proc || proc.exitCode != null) return;
  try { process.kill(proc.pid, 'SIGTERM'); } catch { /* už neběží */ }
  try { setTimeout(() => { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ } }, 2000).unref(); } catch { /* ignore */ }
}

test('modulový gating: uptime+ga4+gsc+indexace+claudelimits+wpsched+nanoclaw+watchdog zapnuté -> modules.*===true, klíče "uptime"/"ga4"/"gsc"/"indexace"/"claudeLimits"/"wpsched"/"nanoclaw"/"watchdog" ve stavu', async () => {
  const { proc, status } = await bootServer(8807, FIX_WITH_UPTIME);
  try {
    assert.equal(status.modules.uptime, true, `modules.uptime = ${JSON.stringify(status.modules)}`);
    assert.equal(status.modules.gsc, true, `modules.gsc = ${JSON.stringify(status.modules)}`);
    assert.equal(status.modules.indexace, true, `modules.indexace = ${JSON.stringify(status.modules)}`);
    assert.equal(status.modules.claudelimits, true, `modules.claudelimits = ${JSON.stringify(status.modules)}`);
    assert.equal(status.modules.wpsched, true, `modules.wpsched = ${JSON.stringify(status.modules)}`);
    assert.equal(status.modules.nanoclaw, true, `modules.nanoclaw = ${JSON.stringify(status.modules)}`);
    // ga4: fixture keyFile míří na neexistující soubor -> createTokenProvider
    // selže dřív, než by cokoli poslal po síti (stejný vzor jako gsc/indexace
    // výš), takže i tenhle boot-level test je bez skutečného HTTP volání.
    assert.equal(status.modules.ga4, true, `modules.ga4 = ${JSON.stringify(status.modules)}`);
    assert.ok('ga4' in status, 'state má obsahovat klíč "ga4", když je modul zapnutý');
    assert.ok('uptime' in status, 'state má obsahovat klíč "uptime", když je modul zapnutý');
    assert.ok('gsc' in status, 'state má obsahovat klíč "gsc", když je modul zapnutý');
    assert.ok('indexace' in status, 'state má obsahovat klíč "indexace", když je modul zapnutý');
    // Pozor na casing: config klíč je "claudelimits" (malé l), ale stav se
    // jmenuje "claudeLimits" (camelCase) — stejně jako v hlavním MC (state.claudeLimits).
    assert.ok('claudeLimits' in status, 'state má obsahovat klíč "claudeLimits", když je modul zapnutý');
    // wpsched: fixture appPasswordFile míří na neexistující soubor -> probeSite()
    // vrátí {ok:false} DŘÍV, než by cokoli poslala po síti (viz modules/wpsched.js),
    // takže i tenhle boot-level test je bez skutečného HTTP volání.
    assert.ok('wpsched' in status, 'state má obsahovat klíč "wpsched", když je modul zapnutý');
    // nanoclaw: fixture dir míří na neexistující cestu -> refreshNanoclaw()
    // nikdy nesahá na DatabaseSync (viz modules/nanoclaw.js fs.existsSync
    // brána) -> collector musí bez pádu vrátit state 'off'.
    assert.ok('nanoclaw' in status, 'state má obsahovat klíč "nanoclaw", když je modul zapnutý');
    assert.equal(status.nanoclaw.state, 'off', `nanoclaw dir neexistuje -> state 'off', mám ${JSON.stringify(status.nanoclaw)}`);
    // watchdog: fixture má 1 dummy projekt, ale žádnou historii -> collectWatchdog()
    // musí bez pádu vrátit state 'warn' ("hlídač ještě neběžel", viz modules/watchdog.js).
    assert.ok('watchdog' in status, 'state má obsahovat klíč "watchdog", když je modul zapnutý');
    assert.equal(status.watchdog.state, 'warn', `žádná historie -> state 'warn', mám ${JSON.stringify(status.watchdog)}`);
    assert.equal(status.watchdog.projects?.[0]?.id, 'dummy');
  } finally {
    stopServer(proc);
  }
});

test('modulový gating: config bez "modules" -> žádný modul zapnutý, klíče "uptime"/"gsc"/"indexace"/"claudeLimits"/"wpsched"/"nanoclaw"/"watchdog" ve stavu chybí', async () => {
  const { proc, status } = await bootServer(8808, FIX_EMPTY);
  try {
    assert.equal(status.modules.uptime, false);
    assert.equal(status.modules.gsc, false);
    assert.equal(status.modules.indexace, false);
    assert.equal(status.modules.claudelimits, false);
    assert.equal(status.modules.wpsched, false);
    assert.equal(status.modules.nanoclaw, false);
    assert.equal(status.modules.watchdog, false);
    assert.ok(!('uptime' in status), `state.uptime by neměl existovat bez modulu — mám ${JSON.stringify(status.uptime)}`);
    assert.ok(!('gsc' in status), `state.gsc by neměl existovat bez modulu — mám ${JSON.stringify(status.gsc)}`);
    assert.ok(!('indexace' in status), `state.indexace by neměl existovat bez modulu — mám ${JSON.stringify(status.indexace)}`);
    assert.ok(!('claudeLimits' in status), `state.claudeLimits by neměl existovat bez modulu — mám ${JSON.stringify(status.claudeLimits)}`);
    assert.ok(!('wpsched' in status), `state.wpsched by neměl existovat bez modulu — mám ${JSON.stringify(status.wpsched)}`);
    assert.ok(!('nanoclaw' in status), `state.nanoclaw by neměl existovat bez modulu — mám ${JSON.stringify(status.nanoclaw)}`);
    assert.ok(!('watchdog' in status), `state.watchdog by neměl existovat bez modulu — mám ${JSON.stringify(status.watchdog)}`);
  } finally {
    stopServer(proc);
  }
});
