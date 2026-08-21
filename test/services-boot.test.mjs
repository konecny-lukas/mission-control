// Task 17b — boot-level test pro mc.config.json "services" (spec §4).
// Fixture pojmenovává neexistující systemd jednotku (mc-smoke-fixture-svc) —
// na testovacím boxu (a v CI) žádná taková jednotka neběží, takže se
// neověřuje "active", ale to, že collectServices() jednotku vůbec NEZTRATÍ:
// `systemctl --user is-active <neexistující>` vrací exit!=0, ale stdout
// "inactive" (ověřeno ručně na tomhle boxu) -> svcActive() ho vrátí jako
// "inactive" a collectServices() ho namapuje na state:'crit', ne že by ho
// vynechal. Proto jde přímo assertovat na state.services, ne (jen) na
// catalog.services (RESTARTABLE_SERVICES) — kdyby se ukázalo, že se na
// jiném systemd/distru neexistující jednotka z výstupu ztrácí, tenhle test
// spadne s jasnou zprávou a je třeba přejít na alternativu popsanou v
// task-17b reportu (assert na catalog.services místo state.services).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/mc.config.services.json', import.meta.url));
const PORT = 8809; // vlastní port — modules-gating.test.mjs má 8807/8808

async function bootServer(port, configFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-services-boot-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, MC_PORT: String(port), MC_CONFIG: configFile, MC_AGENT_HOME: tmp, MC_DATA_DIR: dataDir };
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

function stopServer(proc) {
  if (!proc || proc.exitCode != null) return;
  try { process.kill(proc.pid, 'SIGTERM'); } catch { /* už neběží */ }
  try { setTimeout(() => { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ } }, 2000).unref(); } catch { /* ignore */ }
}

test('boot smoke: mc.config.json "services" nahrazuje sledované jednotky, /api/status.services obsahuje nakonfigurovanou (byť neexistující) jednotku', async () => {
  const { proc, status } = await bootServer(PORT, FIXTURE);
  try {
    assert.ok(Array.isArray(status.services), `state má obsahovat pole "services" — mám ${JSON.stringify(status.services)}`);
    const fixture = status.services.find((s) => s.name === 'mc-smoke-fixture-svc');
    assert.ok(fixture, `konfigurovaná jednotka "mc-smoke-fixture-svc" chybí v state.services — mám ${JSON.stringify(status.services)}`);
    assert.equal(fixture.label, 'Fixture služba');
    // Neexistující jednotka -> systemctl is-active vrací "inactive" (ne "active") -> state 'crit', ne vynechání.
    assert.equal(fixture.active, 'inactive');
    assert.equal(fixture.state, 'crit');

    // Vestavěné defaultní jednotky (tailscaled, fail2ban) NEJSOU sledované,
    // protože config "services" je nahrazuje úplně — viz collectors.js.
    assert.ok(!status.services.some((s) => s.name === 'tailscaled'), 'tailscaled by při nastaveném "services" neměl být sledovaný');

    // catalog (RESTARTABLE_SERVICES) — potvrzuje wiring i pro akční allowlist:
    // scope:'user' přibude VEDLE vestavěných mission-control/mc-ttyd, scope:'system' ne.
    const targets = (status.catalog?.services || []).map((s) => s.target);
    assert.ok(targets.includes('mission-control'), `catalog.services musí pořád obsahovat "mission-control" — mám ${JSON.stringify(targets)}`);
    assert.ok(targets.includes('mc-smoke-fixture-svc'), `catalog.services musí obsahovat scope:'user' jednotku z configu — mám ${JSON.stringify(targets)}`);
    assert.ok(!targets.includes('mc-smoke-system-svc'), 'scope:"system" jednotka nepatří do restart allowlistu');
  } finally {
    stopServer(proc);
  }
});
