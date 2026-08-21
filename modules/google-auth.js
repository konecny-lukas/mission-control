// Mission Control — sdílený Google OAuth token provider (SA JWT + refresh_token)
// + sdílený POST s backoffem na 429/5xx pro volání samotných Google API.
//
// Nahrazuje tři skoro identické kopie accessToken() v ga4/gsc/indexace jedním
// místem: createTokenProvider({keyFile, timeoutMs, tag}) vrátí async funkci bez
// argumentů, která vrací platný access token. Cache je držená v uzávěru vrácené
// funkce — obnova probíhá až 60 s před expirací, mezitím se nesahá na síť.
//
// googleApiPost() nahrazuje druhou dvojici skoro identických funkcí — apiPost()
// v ga4.js a query() v gsc.js měly stejnou 429/5xx backoff smyčku (max 2
// opakování, respektuje Retry-After, wait clamp 2–30 s), lišily se jen v tom,
// co z odpovědi vytáhnou. Volající si tenkým lokálním wrapperem doplní svůj
// tvar (ga4: celý JSON, gsc: jen `.rows`). indexace svou vlastní inspect()
// NEsdílí — má jiné error/retry chování (429 vrací hned {rate:true} a nechává
// backoff na volajícím, žádný 3pokusový retry na jednotlivou URL — s tisíci
// URL na web by to bylo neúnosně pomalé), takže zůstává samostatná.
//
// keyFile má DVA možné tvary, auto-detekce podle obsahu JSON:
//   1. Service account (má private_key + client_email) — JWT RS256 grant.
//      Scope je napevno „analytics.readonly + webmasters.readonly" — jeden SA
//      soubor tak stačí pro ga4 i gsc/indexace zároveň.
//   2. OAuth installed-app (má refresh_token) — refresh_token grant, stejný
//      tvar jako dřívější accessToken() v ga4.js.
// keyFile se NIKDY nepřepisuje, jen čte — a to líně, až při prvním volání
// vrácené funkce (ne při importu modulu), a jen JEDNOU: změna souboru na disku
// se projeví až po restartu procesu (žádné sledování mtime — ať to zůstane
// prosté; sourozenci to dělali stejně natvrdo per-run).
//
// Chyby vždy throw s prefixem `[${tag}]` — volající moduly (ga4/gsc/indexace)
// si je chytají sami a běh jen přeskočí, tenhle modul nikam nic neloguje.
import fs from 'node:fs';
import crypto from 'node:crypto';

const TOKEN_URI_DEFAULT = 'https://oauth2.googleapis.com/token';
const SCOPE_SA = 'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly';
const RENEW_MARGIN_MS = 60_000; // obnova 60 s před expirací
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// base64url bez paddingu (RFC 4648 §5) — Node má jen běžné base64 nativně.
function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Sestaví a podepíše JWT assertion pro service account grant.
function buildServiceAccountJwt(cfg, tag) {
  if (!cfg.private_key) throw new Error(`[${tag}] keyFile: service account bez private_key`);
  const tokenUri = cfg.token_uri || TOKEN_URI_DEFAULT;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: cfg.client_email, scope: SCOPE_SA, aud: tokenUri, iat: now, exp: now + 3600 };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  let signature;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    signature = base64url(signer.sign(cfg.private_key));
  } catch (e) {
    throw new Error(`[${tag}] podpis JWT selhal: ${e.message}`);
  }
  return { jwt: `${signingInput}.${signature}`, tokenUri };
}

// Jeden POST na token endpoint (form-encoded) — sdílený oběma flow.
async function postToken(tokenUri, params, timeoutMs, tag) {
  let res;
  try {
    res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`[${tag}] token request selhal: ${e.message}`);
  }
  // Nejdřív text (nikdy nezmizí), teprve pak zkusit JSON — chybová odpověď
  // nemusí být JSON (HTML stránka od proxy, plaintext hláška) a `.json()` by
  // ji potichu zahodilo do `{}`; takhle se do chyby vždy dostane skutečný obsah.
  const text = await res.text().catch(() => '');
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || !json?.access_token) {
    const detail = json ? JSON.stringify(json) : text;
    throw new Error(`[${tag}] token endpoint HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  return json;
}

function readKeyFile(keyFile, tag) {
  let raw;
  try {
    raw = fs.readFileSync(keyFile, 'utf-8');
  } catch (e) {
    throw new Error(`[${tag}] keyFile nelze číst (${keyFile}): ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`[${tag}] keyFile není platný JSON (${keyFile}): ${e.message}`);
  }
}

// Vytvoří token provider pro daný keyFile. Vrácená funkce je bezargumentová
// (`async () => accessToken`) a nese si vlastní cache v uzávěru — víc providerů
// nad stejným keyFile má každý svou cache (jednoduché, čitelné; sdílet cache
// napříč instancemi by nepřineslo nic zásadního, providery volají moduly
// jednou za refresh cyklus, ne v horké smyčce).
export function createTokenProvider({ keyFile, timeoutMs = 25000, tag = 'google' } = {}) {
  if (!keyFile) throw new Error(`[${tag}] createTokenProvider: chybí keyFile`);
  let cfg = null; // líně načtený obsah keyFile, cache na celou životnost providera
  let cache = { value: null, exp: 0 };

  return async function accessToken() {
    if (cache.value && Date.now() < cache.exp - RENEW_MARGIN_MS) return cache.value;
    if (!cfg) cfg = readKeyFile(keyFile, tag);

    let json;
    if (cfg.private_key && cfg.client_email) {
      const { jwt, tokenUri } = buildServiceAccountJwt(cfg, tag);
      json = await postToken(tokenUri, {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }, timeoutMs, tag);
    } else if (cfg.refresh_token) {
      if (!cfg.client_id || !cfg.client_secret) throw new Error(`[${tag}] keyFile: refresh_token vyžaduje i client_id a client_secret`);
      json = await postToken(cfg.token_uri || TOKEN_URI_DEFAULT, {
        grant_type: 'refresh_token',
        client_id: cfg.client_id,
        client_secret: cfg.client_secret,
        refresh_token: cfg.refresh_token,
      }, timeoutMs, tag);
    } else {
      throw new Error(`[${tag}] keyFile nerozpoznán — chybí private_key+client_email (service account) nebo refresh_token (installed-app)`);
    }

    cache = { value: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
    return cache.value;
  };
}

// Jeden POST na Google API JSON endpoint s backoffem na 429/5xx (max 2
// opakování, respektuje Retry-After, wait clamp 2–30 s) — sdílená smyčka, dřív
// duplikovaná jako ga4.js apiPost() a gsc.js query(). Vrací parsed JSON na
// úspěch, nebo null (volající chybějící report/dotaz přeskočí). `tag` jde
// celý do hranaté závorky logu (`[ga4 example daily]`, `[gsc example query]`)
// — volající si skládá `${modul} ${popis}`.
export async function googleApiPost({ url, token, body, timeoutMs = 25000, tag = 'google' }) {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const ra = Number(res.headers.get('retry-after')) || 0;
        const wait = Math.min(Math.max(ra * 1000, attempt ? 5000 : 2000), 30_000);
        console.error(`[${tag}] HTTP ${res.status} — retry za ${wait} ms`);
        await sleep(wait);
        continue;
      }
      const t = await res.text().catch(() => '');
      console.error(`[${tag}] HTTP ${res.status} ${t.slice(0, 200)}`);
      return null;
    } catch (e) {
      if (attempt < 2) { await sleep(2000); continue; }
      console.error(`[${tag}]`, e.message);
      return null;
    }
  }
  return null;
}
