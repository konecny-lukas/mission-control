// resolvePublicUrl (bin/public-url.mjs) — bez MC_PUBLIC_URL/CFG.publicUrl a bez
// `tailscale` binárky v PATH (odsimulováno smazáním PATH) spadne na
// http://<hostname>, nikdy nehodí výjimku.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.MC_CONFIG = fileURLToPath(new URL('./fixtures/mc.config.empty.json', import.meta.url));
process.env.MC_AGENT_HOME = '/tmp/mc-test-home';
delete process.env.MC_PUBLIC_URL;

const { resolvePublicUrl } = await import('../bin/public-url.mjs');

test('resolvePublicUrl: bez env/CFG a bez tailscale v PATH -> http://<hostname>', async () => {
  const origPath = process.env.PATH;
  process.env.PATH = '/nonexistent-bin-dir'; // tailscale binárka „nenalezena"
  try {
    assert.equal(await resolvePublicUrl(), `http://${os.hostname()}`);
  } finally {
    process.env.PATH = origPath;
  }
});
