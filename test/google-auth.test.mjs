// TDD pro Task 7: sdílený Google token provider (modules/google-auth.js).
// Bez sítě — mockuje globalThis.fetch, RSA pár na SA flow generuje reálně přes
// node:crypto, keyFile leží ve mkdtempSync tmp adresáři (nikdy v repu).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenProvider } from '../modules/google-auth.js';

// base64url dekodér pro ověření JWT hlavičky/podpisu (opak base64url encoderu
// v samotném modulu — test si ho musí udělat vlastní, nic neimportuje interně).
function b64urlDecode(seg) {
  const pad = seg.length % 4 === 0 ? '' : '='.repeat(4 - (seg.length % 4));
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-google-auth-'));
}

test('google-auth: service account JWT flow — token, cache, platný podpis', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const tmp = mkTmpDir();
  const keyFile = path.join(tmp, 'sa.json');
  fs.writeFileSync(keyFile, JSON.stringify({
    private_key: privateKey,
    client_email: 'sa@example.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  }));

  let calls = 0;
  let lastAssertion = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(init.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    lastAssertion = init.body.get('assertion');
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 3600 }) };
  };

  try {
    const provider = createTokenProvider({ keyFile, tag: 'testsa' });
    const tok1 = await provider();
    assert.equal(tok1, 'tok');
    const tok2 = await provider();
    assert.equal(tok2, 'tok');
    assert.equal(calls, 1, 'druhé volání mělo přijít z cache, ne z fetch');

    // JWT assertion: 3 base64url segmenty oddělené tečkou.
    const parts = lastAssertion.split('.');
    assert.equal(parts.length, 3, `JWT musí mít 3 části, mám ${parts.length}`);
    const header = JSON.parse(b64urlDecode(parts[0]).toString('utf-8'));
    assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(b64urlDecode(parts[1]).toString('utf-8'));
    assert.equal(claims.iss, 'sa@example.iam.gserviceaccount.com');
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    assert.ok(claims.scope.includes('analytics.readonly') && claims.scope.includes('webmasters.readonly'));
    assert.equal(claims.exp - claims.iat, 3600);

    // Ověření podpisu proti vygenerovanému veřejnému klíči (RS256).
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    assert.ok(verifier.verify(publicKey, b64urlDecode(parts[2])), 'podpis JWT assertion neodpovídá veřejnému klíči');
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('google-auth: refresh-token (installed-app) flow posílá grant_type=refresh_token', async () => {
  const tmp = mkTmpDir();
  const keyFile = path.join(tmp, 'installed.json');
  fs.writeFileSync(keyFile, JSON.stringify({
    client_id: 'cid',
    client_secret: 'csecret',
    refresh_token: 'rtok',
    token_uri: 'https://oauth2.googleapis.com/token',
  }));

  let seenGrant = null;
  let seenBody = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seenBody = init.body;
    seenGrant = init.body.get('grant_type');
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'reftok', expires_in: 3600 }) };
  };

  try {
    const provider = createTokenProvider({ keyFile, tag: 'testrefresh' });
    const tok = await provider();
    assert.equal(tok, 'reftok');
    assert.equal(seenGrant, 'refresh_token');
    assert.equal(seenBody.get('client_id'), 'cid');
    assert.equal(seenBody.get('client_secret'), 'csecret');
    assert.equal(seenBody.get('refresh_token'), 'rtok');
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('google-auth: nerozpoznaný tvar keyFile -> throw s prefixem [tag]', async () => {
  const tmp = mkTmpDir();
  const keyFile = path.join(tmp, 'bad.json');
  fs.writeFileSync(keyFile, JSON.stringify({ foo: 'bar' }));
  try {
    const provider = createTokenProvider({ keyFile, tag: 'badcfg' });
    await assert.rejects(provider(), /\[badcfg\]/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('google-auth: HTTP chyba na token endpointu -> throw s prefixem [tag]', async () => {
  const tmp = mkTmpDir();
  const keyFile = path.join(tmp, 'installed.json');
  fs.writeFileSync(keyFile, JSON.stringify({
    client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtok',
  }));
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_grant' }) });
  try {
    const provider = createTokenProvider({ keyFile, tag: 'testerr' });
    await assert.rejects(provider(), /\[testerr\]/);
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('google-auth: nerozparsovatelné tělo chyby (HTML/plaintext) -> raw text v hlášce, nic se neztratí', async () => {
  const tmp = mkTmpDir();
  const keyFile = path.join(tmp, 'installed.json');
  fs.writeFileSync(keyFile, JSON.stringify({
    client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtok',
  }));
  const origFetch = globalThis.fetch;
  // 502 od nějakého proxy/LB mezi klientem a token endpointem — tělo NENÍ JSON.
  globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => 'Bad Gateway' });
  try {
    const provider = createTokenProvider({ keyFile, tag: 'testbadgw' });
    await assert.rejects(provider(), (err) => {
      assert.match(err.message, /\[testbadgw\]/);
      assert.match(err.message, /Bad Gateway/, `raw text se musí objevit v chybě, mám: ${err.message}`);
      assert.match(err.message, /502/);
      return true;
    });
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
