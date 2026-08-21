// resolvePublicUrl (bin/public-url.mjs) — MC_PUBLIC_URL env vyhrává nade vším
// ostatním (CFG.publicUrl, tailscale, hostname fallback nikdy neproběhnou).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.MC_CONFIG = fileURLToPath(new URL('./fixtures/mc.config.empty.json', import.meta.url));
process.env.MC_AGENT_HOME = '/tmp/mc-test-home';
process.env.MC_PUBLIC_URL = 'https://override.example.ts.net';

const { resolvePublicUrl } = await import('../bin/public-url.mjs');

test('resolvePublicUrl: MC_PUBLIC_URL env vyhrává', async () => {
  assert.equal(await resolvePublicUrl(), 'https://override.example.ts.net');
});
