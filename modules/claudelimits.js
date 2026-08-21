// Mission Control — spotřeba limitů Claude subscription (5h okno + týden).
//
// Zdroj = `GET https://api.anthropic.com/api/oauth/usage`, tedy přesně ten
// endpoint, ze kterého čte `/usage` v Claude Code. Autorizace OAuth tokenem
// z `<claudeDir>/.credentials.json` (scope `user:profile`) — žádný extra klíč.
//
// POZOR na token: soubor vlastní Claude Code, ten si access token sám obnovuje
// (platnost ~6 h). MC ho jen ČTE při každém pollu — NIKDY NEZAPISUJE do tohoto
// souboru a NIKDY NEPOUŽÍVÁ refresh_token: refresh token rotuje a zápis mimo
// Claude Code by uživatele odhlásil. Když access token vyprší a dlouho
// neběžela žádná Claude session (nikdo ho neobnovil), poslední známá čísla
// zůstanou zobrazená se značkou „stale" — nikdy nehádáme, nikdy nepíšeme.
import fs from 'node:fs';
import * as C from '../config.js';

// C.CLAUDELIMITS_DIR (config.js) — odvozeno z CLAUDE_DIR (sdílená konstanta,
// čtou i jarvis.js a collectors.js), ale jde přepsat jen pro tenhle modul přes
// mc.config.json → modules.claudelimits.claudeDir (viz komentář v config.js).
const CRED_FILE = `${C.CLAUDELIMITS_DIR}/.credentials.json`;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const STALE_MS = 15 * 60 * 1000; // starší data než 15 min = „stale" (poll je 1×/min)

let last = null;      // poslední ÚSPĚŠNĚ načtená data (drží se i přes chybu)
let lastOkTs = 0;
let lastErr = null;

function readCreds() {
  try {
    const j = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
    const o = j.claudeAiOauth || {};
    if (!o.accessToken) return null;
    return { token: o.accessToken, expiresAt: o.expiresAt || 0, plan: o.subscriptionType || null, tier: o.rateLimitTier || null };
  } catch { return null; }
}

// Barva z procent (API posílá i vlastní `severity`, ta ale zůstává „normal"
// dlouho do červené zóny — pro HUD je čitelnější vlastní práh).
function sev(pct, apiSeverity) {
  if (apiSeverity && /crit|exceed|block/i.test(apiSeverity)) return 'crit';
  if (pct == null) return 'idle';
  if (pct >= 90) return 'crit';
  if (pct >= 70) return 'warn';
  return 'ok';
}

const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };

// `utilization` je v procentech (0–100), `limits[].percent` totéž zaokrouhlené.
// Bereme limits[] jako primární (má i severity + resets_at), utilization jako
// jemnější fallback.
function bucket(block, lim) {
  if (!block && !lim) return null;
  const pct = lim?.percent != null ? lim.percent
    : (typeof block?.utilization === 'number' ? Math.round(block.utilization) : null);
  const resetsAt = ms(lim?.resets_at) ?? ms(block?.resets_at);
  return { pct, resetsAt, state: sev(pct, lim?.severity), active: lim?.is_active ?? null };
}

export async function refreshClaudeLimits() {
  const cred = readCreds();
  if (!cred) { lastErr = `chybí ${CRED_FILE}`; return; }
  try {
    const ac = AbortSignal.timeout(10_000);
    const r = await fetch(USAGE_URL, {
      signal: ac,
      headers: {
        Authorization: `Bearer ${cred.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
    });
    if (r.status === 401 || r.status === 403) {
      // Token vypršel a žádná Claude session ho zatím neobnovila. Nesaháme na
      // refresh_token (viz hlavička) — jen označíme data za neaktuální.
      lastErr = 'token vypršel — spusť libovolnou Claude session (obnoví se sám)';
      return;
    }
    if (!r.ok) { lastErr = `HTTP ${r.status}`; return; }
    const j = await r.json();
    const limits = Array.isArray(j.limits) ? j.limits : [];
    const byKind = (k) => limits.find((x) => x.kind === k);

    // Modelově scopované týdenní limity (na Maxu typicky Opus) — jen ty, které
    // účet reálně má; jinak by v HUDu svítily prázdné řádky.
    const scoped = limits
      .filter((x) => x.kind === 'weekly_scoped' && x.scope?.model?.display_name)
      .map((x) => ({
        label: x.scope.model.display_name,
        pct: x.percent ?? null,
        resetsAt: ms(x.resets_at),
        state: sev(x.percent, x.severity),
        active: x.is_active ?? null,
      }))
      .filter((x) => x.active || (x.pct ?? 0) > 0);

    const fiveHour = bucket(j.five_hour, byKind('session'));
    const weekly = bucket(j.seven_day, byKind('weekly_all'));
    const eu = j.extra_usage || {};

    last = {
      fiveHour,
      weekly,
      scoped,
      plan: cred.plan,
      tier: cred.tier,
      extra: eu.is_enabled ? { pct: eu.utilization ?? null, used: eu.used_credits ?? null, limit: eu.monthly_limit ?? null } : null,
      state: ['crit', 'warn', 'ok'].find((s) => [fiveHour?.state, weekly?.state, ...scoped.map((x) => x.state)].includes(s)) || 'idle',
    };
    lastOkTs = Date.now();
    lastErr = null;
  } catch (e) {
    lastErr = e.name === 'TimeoutError' ? 'timeout' : (e.message || String(e));
  }
}

export function collectClaudeLimits() {
  if (!last) return { state: 'idle', err: lastErr, fetchedAt: null, stale: true };
  const stale = Date.now() - lastOkTs > STALE_MS;
  return { ...last, state: stale ? 'idle' : last.state, fetchedAt: lastOkTs, stale, err: lastErr };
}
