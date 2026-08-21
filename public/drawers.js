/* MC v2 — obecné drawer buildery (claude/uptime/previews/system + detail úkolu).
   Klientské/mrtvé buildery (traffic/gsc/indexace/spend/cron/nanoclaw/CRM/…)
   vystřiženy v Task 3 — znovupoužitelné kusy zachráněny do interních research
   poznámek (ui-snippety), tasky 8–14 z nich staví moduly.
   Registrace přes registerDrawer(id, {title, deps, build, wire, wide, term});
   deps:[] u drawerů s vloženým terminálem (rebuild by reloadnul iframe). */

import { esc, rel, dur, fmtPct, fmtNum } from './core/dom.js';
import { S } from './core/store.js';
import { postAction } from './core/net.js';
import { registerDrawer, openDrawer } from './ui/drawer.js';
import { TERMKEY, termProjects, TERM_WORK_LABEL, termInit, registerTermDrawer, openTermDrawer } from './ui/term.js';
import { popOut, openViewer } from './ui/viewer.js';

// stavová třída textu: ok/warn/crit -> .c-*, jinak .c-dim
const stC = (st) => ({ ok: 'c-ok', warn: 'c-warn', crit: 'c-crit', paused: 'c-gold' }[st] || 'c-dim');

function ledRow(state, t1, t2) {
  const led = ['ok', 'warn', 'crit', 'paused'].includes(state) ? state : 'idle';
  return `<div class="drow"><span class="led ${led}"></span><div class="grow"><div class="t1">${t1}</div><div class="t2">${t2 || ''}</div></div></div>`;
}
function dl(pairs) { return `<dl class="dl">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`; }

// ---- uptime helpers ----
function spark(arr) {
  if (!arr || !arr.length) return '';
  return `<div class="spark" title="posledních ${arr.length} kontrol (1/min)">${arr.map((v) => `<i class="${v ? 'up' : 'down'}"></i>`).join('')}</div>`;
}
function siteRow(s) {
  const status = s.up == null ? 'měřím…'
    : s.up ? `online · ${s.lastMs != null ? s.lastMs + ' ms' : '—'}`
    : `NEDOSTUPNÝ${s.lastStatus ? ' · HTTP ' + s.lastStatus : ' · timeout'}`;
  return `<div class="site-card s-${s.state}">
    <div class="site-head">
      <span class="led ${['ok', 'warn', 'crit'].includes(s.state) ? s.state : 'idle'}"></span>
      <a class="site-name" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>
      <span class="site-status ${stC(s.state)}">${status}</span>
    </div>
    ${spark(s.spark)}
    <div class="site-meta">
      <span>24 h <b>${fmtPct(s.pct24)}</b></span>
      <span>7 d <b>${fmtPct(s.pct7)}</b></span>
      <span>ø odezva <b>${s.avgMs != null ? s.avgMs + ' ms' : '—'}</b></span>
      <span>kontrola <b>${s.lastTs ? rel(new Date(s.lastTs).toISOString()) : '—'}</b></span>
    </div>
  </div>`;
}

// ---- preview cards ----
function previewCard(p) {
  const typeLabel = p.type === 'proxy' ? `živý server · :${p.port}` : 'statické';
  return `<div class="pv-card">
    <div class="pv-head">
      <span class="led ok"></span>
      <span class="pv-title">${esc(p.title)}</span>
      <span class="pv-type">${typeLabel}</span>
    </div>
    <div class="pv-url">${esc(location.host + p.url)}</div>
    ${p.note ? `<div class="pv-note">${esc(p.note)}</div>` : ''}
    <div class="pv-foot">
      <span class="pv-when">${p.created ? rel(p.created) : ''}</span>
      <span class="btn-row p0">
        <button class="btn sm" data-pv-pop="${esc(p.slug)}">⤤ Otevřít</button>
        <button class="btn btn-link sm" data-pv-view="${esc(p.slug)}" data-pv-title="${esc(p.title)}" title="zobrazit ve velkém okně uvnitř Mission Control">⤢ V MC</button>
        <button class="btn sm danger" data-act="preview.remove" data-target="${esc(p.slug)}">🗑</button>
      </span>
    </div>
  </div>`;
}
function wirePreviews(body) {
  body.querySelectorAll('[data-pv-pop]').forEach((x) => x.addEventListener('click', () => popOut(x.dataset.pvPop)));
  body.querySelectorAll('[data-pv-view]').forEach((x) => x.addEventListener('click', () => openViewer(x.dataset.pvView, x.dataset.pvTitle)));
}

// ---- actions (jednotná implementace přes postAction) ----
export function wireActions(body) {
  body.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      const label = b.textContent.trim();
      const payload = { type: act };
      if (b.dataset.target) payload.target = b.dataset.target;
      if (b.dataset.id) payload.id = b.dataset.id;
      await postAction(payload, b, { confirm: `Potvrdit: ${label}?` });
    });
  });
}

// =====================================================================
// buildery drawerů (verbatim z public/app.js drawerBody)
// =====================================================================

function buildClaude() {
  const c = S.claude || {};
  let h = dl([['Otevřené úkoly', c.openTasks ?? 0], ['Sessions', (c.sessions || []).length]]);
  h += `<div class="section-h">AKTIVNÍ SESSIONS</div>`;
  h += (c.sessions || []).map((s) => ledRow(s.status === 'running' ? 'ok' : 'idle', s.cwd || s.id, `${s.status} · ${rel(s.updatedAt)}`)).join('') || '<div class="note">žádné aktivní</div>';
  h += `<div class="section-h">POSLEDNÍ AKTIVITA</div>`;
  h += (c.recent || []).map((r) => ledRow('idle', r.display || '—', `${r.project ? r.project.split('/').pop() : ''} ${r.ts ? rel(new Date(r.ts).toISOString()) : ''}`)).join('');
  h += `<div class="note">Naplánované cloud routiny (/schedule) žijí v claude.ai, ne lokálně — zde nejsou.</div>`;
  return h;
}

function buildUptime() {
  const u = S.uptime || {};
  const sites = u.sites || [];
  let h = dl([
    ['Online teď', `${u.sitesUp ?? 0} / ${u.sitesTotal ?? sites.length}`],
    ['Uptime 24 h', fmtPct(u.overallPct)],
    ['Interval', '1 min'],
    ['Poslední měření', u.checkedAt ? rel(new Date(u.checkedAt).toISOString()) : '—'],
  ]);
  if (u.downNow) h += `<div class="note crit">⚠ ${u.downNow} web nedostupný — viz níže.</div>`;
  else if (u.warnNow) h += `<div class="note">${u.warnNow} web měl právě výpadek jedné kontroly (sleduji).</div>`;
  h += `<div class="section-h">WEBY</div>`;
  h += sites.map(siteRow).join('') || '<div class="note">zatím bez měření — první kontrola proběhne do minuty.</div>';
  return h;
}

// ---- ga4 (NÁVŠTĚVNOST) — port trafficSiteCard/gscChart z interních research
// poznámek (ui-snippety), zjednodušeno na GA4-only (žádný Ahrefs merge —
// hlavní MC měl dva zdroje vedle sebe, tenhle balíček jen GA4).
function trafficChart(vals, gid) {
  const v = vals || [];
  if (!v.length || !v.some((x) => x > 0)) return '<div class="note nm4">zatím bez dat pro tenhle web</div>';
  const W = 100, H = 30, n = v.length;
  const max = Math.max(1, ...v);
  const X = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const Y = (x) => H - 1 - (x / max) * (H - 2);
  const pts = v.map((x, i) => `${X(i).toFixed(2)},${Y(x).toFixed(2)}`);
  const line = 'M' + pts.join(' L');
  const area = `M0,${H} L${pts.join(' L')} L${W},${H} Z`;
  return `<svg class="gsc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="denní relace (sessions)">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity="0.42"/>
        <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${gid})"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    </svg>
    <div class="gsc-ax"><span>28 d zpět</span><span>max ${fmtNum(max)} relací/den</span><span>včera</span></div>`;
}
function trafficSiteCard(s) {
  const hasData = (s.d28 && s.d28.sessions > 0) || (s.spark || []).some((v) => v > 0);
  const head = hasData ? `${fmtNum(s.d28?.sessions)} relací / 28 d` : (s.today || s.d7?.sessions ? 'zatím bez dat' : 'měřím…');
  let h = `<div class="site-card">
    <div class="site-head">
      <span class="led ${s.live != null ? 'ok' : hasData ? 'idle' : 'idle'}"></span>
      <span class="site-name">${esc(s.label)}</span>
      <span class="site-status ${hasData ? 'c-acc' : 'c-dim'}">${head}</span>
    </div>
    ${trafficChart(s.spark, `ga4t-${esc(s.id)}`)}
    <div class="site-meta">
      <span title="GA4 dnešek je neúplný, dokud neproběhne denní zpracování (intraday lag)">dnes (dobíhá) <b>${fmtNum(s.today?.sessions)}</b></span>
      <span>relace 7 d <b>${fmtNum(s.d7?.sessions)}</b></span>
      <span>relace 28 d <b>${fmtNum(s.d28?.sessions)}</b></span>
      <span>uživatelé 28 d <b>${fmtNum(s.d28?.users)}</b></span>
      <span>zobrazení 28 d <b>${fmtNum(s.d28?.pv)}</b></span>
      ${s.live != null ? `<span title="GA4 realtime">teď na webu <b class="c-ok">${fmtNum(s.live)}</b></span>` : ''}
    </div>
  </div>`;
  return h;
}
function buildTraffic() {
  const g = S.ga4 || {};
  const sites = g.sites || [];
  let h = dl([
    ['Weby s daty', `${sites.filter((s) => (s.d28?.sessions || 0) > 0).length} / ${sites.length}`],
    ['Poslední refresh', g.updatedAt ? rel(new Date(g.updatedAt).toISOString()) : '—'],
  ]);
  h += `<div class="section-h">WEBY</div>`;
  h += sites.map(trafficSiteCard).join('') || '<div class="note">zatím bez měření — první stažení proběhne do pár minut.</div>';
  return h;
}

// ---- gsc (VYHLEDÁVÁNÍ) — port renderGscCards/gscChart/fmtClicks/trendBadge
// z interních research poznámek (ui-snippety), zjednodušeno na jediný zdroj
// (GSC organické kliky per web) — žádné vlajky/jazykové mutace/Ahrefs merge,
// ty patřily k WPML slicing jedné property v původním interním MC.
const fmtClicks = (n) => (n == null ? '—' : Number(n).toLocaleString('cs'));
function gscChart(vals, gid) {
  const v = vals || [];
  if (!v.length || !v.some((x) => x > 0)) return '<div class="note nm4">zatím bez dat pro tenhle web</div>';
  const W = 100, H = 30, n = v.length;
  const max = Math.max(1, ...v);
  const X = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const Y = (x) => H - 1 - (x / max) * (H - 2);
  const pts = v.map((x, i) => `${X(i).toFixed(2)},${Y(x).toFixed(2)}`);
  const line = 'M' + pts.join(' L');
  const area = `M0,${H} L${pts.join(' L')} L${W},${H} Z`;
  return `<svg class="gsc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="denní kliky">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity="0.42"/>
        <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${gid})"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    </svg>
    <div class="gsc-ax"><span>28 d zpět</span><span>max ${fmtClicks(max)} kliků/den</span><span>-3 d (GSC lag)</span></div>`;
}
function gscSiteCard(s) {
  const hasData = (s.clicks28 || 0) > 0 || (s.spark || []).some((v) => v > 0);
  const head = hasData ? `${fmtClicks(s.clicks28)} kliků / 28 d` : ((s.impressions28 || 0) > 0 ? 'zatím bez kliků' : 'měřím…');
  let h = `<div class="gsc-card">
    <div class="site-head">
      <span class="led ${hasData ? 'ok' : 'idle'}"></span>
      <span class="site-name">${esc(s.label)}</span>
      <span class="site-status ${hasData ? 'c-acc' : 'c-dim'}">${head}</span>
    </div>
    ${gscChart(s.spark, `gscg-${esc(s.id)}`)}
    <div class="site-meta">
      <span>kliky 28 d <b>${fmtClicks(s.clicks28)}</b></span>
      <span>zobrazení 28 d <b>${fmtClicks(s.impressions28)}</b></span>
      <span>ø pozice <b>${s.position28 != null ? s.position28.toFixed(1) : '—'}</b></span>
    </div>`;
  const qs = s.topQueries || [];
  if (qs.length) {
    h += `<div class="gsc-chips">${qs.map((q) => `<span class="gsc-chip">${esc(q.q)} <b>${fmtClicks(q.clicks)}</b></span>`).join('')}</div>`;
  }
  h += `</div>`;
  return h;
}
function buildGsc() {
  const g = S.gsc || {};
  const sites = g.sites || [];
  let h = dl([
    ['Weby s daty', `${sites.filter((s) => (s.clicks28 || 0) > 0).length} / ${sites.length}`],
    ['Poslední refresh', g.updatedAt ? rel(new Date(g.updatedAt).toISOString()) : '—'],
  ]);
  h += `<div class="section-h">WEBY</div>`;
  h += sites.map(gscSiteCard).join('') || '<div class="note">zatím bez měření — první stažení proběhne do pár minut.</div>';
  return h;
}

// ---- indexace (INDEXACE) — port renderIndexaceCards/idxChart/idxColor/idxSites
// z interních research poznámek (ui-snippety). Proti zdroji vypuštěn per-mutace
// rozpad (WPML properties[] jazykové mutace jedné property — v tomhle balíčku
// je jedna GSC property PER WEB, žádné mutace k rozpadu, viz modules/indexace.js).
// COVERAGE_CZ je jen generický Czech překlad GSC coverageState hlášek — s WPML
// nemá nic společného, zůstává 1:1.
const COVERAGE_CZ = {
  'Submitted and indexed': 'Odesláno a indexováno',
  'Indexed, not submitted in sitemap': 'Indexováno (mimo sitemapu)',
  'Indexed, low interest': 'Indexováno (nízký zájem)',
  'Crawled - currently not indexed': 'Procházeno – zatím neindexováno',
  'Discovered - currently not indexed': 'Objeveno – zatím neindexováno',
  'URL is unknown to Google': 'Google URL nezná',
  'Page with redirect': 'Stránka s přesměrováním',
  'Soft 404': 'Soft 404',
  'Not found (404)': 'Nenalezeno (404)',
  'Blocked by robots.txt': 'Blokováno robots.txt',
  "Excluded by 'noindex' tag": 'Vyloučeno (noindex)',
  'Duplicate without user-selected canonical': 'Duplicita bez kanonické',
  'Duplicate, Google chose different canonical than user': 'Duplicita (jiná kanonická)',
  'Alternate page with proper canonical tag': 'Alternativa (kanonická)',
  'neznámé': 'neznámé / nezměřeno',
};
const covLabel = (c) => COVERAGE_CZ[c] || c || 'neznámé';

function idxColor(pct) { // pct = 0..1 (dynamická barva — zůstává inline)
  if (pct == null) return 'var(--ink-dim)';
  if (pct >= 0.9) return 'var(--ok)';
  if (pct >= 0.7) return 'var(--warn)';
  return 'var(--crit)';
}
function idxSites() {
  return (S.indexace?.sites || []).slice().filter((s) => s.hasData).sort((a, b) => (a.pct ?? 1) - (b.pct ?? 1));
}
function idxChart(s) {
  const vals = (s.spark || []);
  const days = (s.sparkDays || []);
  if (vals.length < 2) return ''; // jedno měření -> graf nedává smysl
  const W = 100, H = 30, n = vals.length;
  const X = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const Y = (v) => H - 1 - (Math.max(0, Math.min(100, v)) / 100) * (H - 2);
  const pts = vals.map((v, i) => `${X(i).toFixed(2)},${Y(v).toFixed(2)}`);
  const line = 'M' + pts.join(' L');
  const area = `M0,${H} L${pts.join(' L')} L${W},${H} Z`;
  const gid = `idxg-${esc(s.id)}`;
  return `<svg class="gsc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="denní index-rate">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity="0.42"/>
        <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${gid})"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    </svg>
    <div class="gsc-ax"><span>${days[0] || ''}</span><span>index-rate</span><span>${days[days.length - 1] || ''}</span></div>`;
}
function renderIndexaceCards(sites) {
  if (!sites.length) return '<div class="note">zatím bez měření — první kontrola indexace proběhne do pár minut.</div>';
  return sites.map((s) => {
    const col = idxColor(s.pct);
    const stWord = { ok: '', warn: 'pozor', crit: 'chyba', idle: 'měřím…', running: 'běží…' }[s.status] || '';
    let h = `<div class="gsc-card" data-site="${esc(s.id)}">
      <div class="site-head">
        <span class="gsc-flag" style="color:${col}">${s.pct >= 0.9 ? '✓' : '◖'}</span>
        <a class="site-name" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>
        <span class="site-status" style="color:${col}">${fmtNum(s.indexed)}/${fmtNum(s.total)}${s.pct != null ? ` · ${fmtPct(s.pct * 100)}` : ''}</span>
      </div>
      ${idxChart(s)}
      <div class="site-meta">
        <span>indexováno <b class="c-ok">${fmtNum(s.indexed)}</b></span>
        <span>neindexováno <b class="${s.notIndexedCount ? 'c-warn' : 'c-ok'}">${fmtNum(s.notIndexedCount)}</b></span>
        <span>URL celkem <b>${fmtNum(s.total)}</b></span>
        ${s.truncated ? `<span title="víc URL než denní kvóta — zbytek se doplňuje další dny (rotace), nic se neztrácí" class="c-acc">rotace ⟳</span>` : ''}
        ${stWord ? `<span style="color:${col}">${stWord}</span>` : ''}
      </div>`;
    const cov = Object.entries(s.byCoverage || {}).sort((a, b) => b[1] - a[1]);
    if (cov.length) {
      h += `<div class="gsc-chips">${cov.map(([c, n]) => {
        const bad = /not indexed|neindex|unknown|nezná|404|redirect|přesměrov|blocked|blokov|noindex|excluded|vyloučen|duplicate|duplicit|alternat|neznámé/i.test(c);
        return `<span class="gsc-chip ${bad ? 'bd-warn' : 'bd-ok'}" title="${esc(c)}">${esc(covLabel(c))} <b>${fmtNum(n)}</b></span>`;
      }).join('')}</div>`;
    }
    const ni = s.notIndexed || [];
    if (ni.length) {
      const shown = ni.slice(0, 80);
      h += `<div class="section-h sm10">NEINDEXOVANÉ URL (${fmtNum(s.notIndexedCount)})</div>`;
      h += `<div class="idx-urls">${shown.map((u) => {
        let p; try { p = new URL(u.url).pathname || '/'; } catch { p = u.url; }
        return `<div class="idx-url" title="${esc(u.url)} · ${esc(u.coverage)}${u.lastCrawl ? ' · naposled procházeno ' + rel(u.lastCrawl) : ''}">
          <a href="${esc(u.url)}" target="_blank" rel="noopener" class="idx-url-path">${esc(p)}</a>
          <span class="idx-url-cov">${esc(covLabel(u.coverage))}</span>
        </div>`;
      }).join('')}</div>`;
      if (ni.length > shown.length) h += `<div class="note nm6">…a dalších ${fmtNum(ni.length - shown.length)} (zobrazeno prvních ${shown.length})</div>`;
    } else if (s.total) {
      h += `<div class="note ok-edge">✓ Všechny nalezené URL jsou indexované.</div>`;
    }
    if (s.note) h += `<div class="note nm6">${esc(s.note)}</div>`;
    h += `</div>`;
    return h;
  }).join('');
}
function buildIndexace() {
  const x = S.indexace || {};
  const sites = idxSites();
  let h = dl([
    ['Indexováno / celkem', `<b class="big" style="color:${idxColor(x.pct)}">${fmtNum(x.indexedUrls)} / ${fmtNum(x.totalUrls)}</b>${x.pct != null ? ` · ${fmtPct(x.pct * 100)}` : ''}`],
    ['Neindexováno', `<b class="${x.notIndexedUrls ? 'c-warn' : 'c-ok'}">${fmtNum(x.notIndexedUrls)}</b>`],
    ['Webů', x.siteCount ?? 0],
    ['Nejhorší web', x.worstSite ? `${esc(x.worstSite)} · ${x.worstPct != null ? fmtPct(x.worstPct * 100) : '—'}` : '—'],
    ['Aktualizováno', x.updatedAt ? rel(new Date(x.updatedAt).toISOString()) : 'měřím…'],
  ]);
  h += `<div class="note">Stav indexace stránek přímo z <b>Google Search Console</b> (URL Inspection API) — autoritativní náhrada ručního <code>site:</code> dotazu. URL se berou ze sitemap webů, <b>verdict PASS = indexováno</b>. Zdarma, kontrola 1×/24 h. Jen weby ověřené v GSC.</div>`;
  h += renderIndexaceCards(sites);
  return h;
}

// ---- wpsched (WP PLÁNOVANÉ) — adaptováno z `wpschedSection` snippetu
// (research poznámky, ui-snippety — public/drawers.js:792-810
// v původním interním MC) na nový (per-web) tvar snímku modules/wpsched.js:
// `sites[]` s vlastním `ok`/`err`/`stuck`/`next` per web místo jednoho
// plochého seznamu. Žádné `legacyCount`/`reason` (missing-cron vs. overdue) —
// REST nemá přístup k WP cron tabulce jako `wp eval` ve zdroji, jen datum
// postu, takže klasifikace je prostší (jen "stuck"/"next", viz
// modules/wpsched.js buildSnapshot). Oprava v poznámce je bez wp-cli — REST
// éra na to nemá po ruce shell na serveru, jen ruční zásah v adminu.
function wpDateMs(at) {
  if (!at) return null;
  const ms = Date.parse(String(at).endsWith('Z') ? at : `${at}Z`);
  return Number.isFinite(ms) ? ms : null;
}
function wpAt(at) {
  const ms = wpDateMs(at);
  return ms != null ? rel(new Date(ms).toISOString()) : esc(at || '—');
}
function wpschedSiteCard(s) {
  const stuck = s.stuck || [];
  const st = !s.ok ? 'warn' : stuck.length ? 'crit' : 'ok';
  let h = `<div class="site-card s-${st}">
    <div class="site-head">
      <span class="led ${st}"></span>
      <a class="site-name" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>
      <span class="site-status ${stC(st)}">${!s.ok ? esc(s.err || 'chyba sondy') : `${fmtNum(s.futureCount)} naplánováno`}</span>
    </div>`;
  if (s.ok) {
    for (const p of stuck) {
      h += `<div class="drow"><span class="led crit"></span><div class="grow"><div class="t1 c-crit">${esc(p.title)}</div>
        <div class="t2">⚠ mělo vyjít ${wpAt(p.at)} — termín prošel a post nevyšel${p.link ? ` · <a href="${esc(p.link)}" target="_blank" rel="noopener">otevřít</a>` : ''}</div></div></div>`;
    }
    if (!stuck.length) h += `<div class="note c-ok">✓ žádný zaseknutý post</div>`;
    if (s.next) h += ledRow('ok', esc(s.next.title), `vyjde ${wpAt(s.next.at)}`);
  }
  h += `</div>`;
  return h;
}
function buildWpsched() {
  const w = S.wpsched || {};
  const sites = w.sites || [];
  const stuckTotal = sites.reduce((a, s) => a + (s.stuck || []).length, 0);
  let h = dl([
    ['Webů', sites.length],
    ['Zaseknuto', `<b class="${stuckTotal ? 'c-crit' : 'c-ok'}">${stuckTotal}</b>`],
    ['Poslední kontrola', w.checkedAt ? rel(new Date(w.checkedAt).toISOString()) : 'měřím…'],
  ]);
  h += `<div class="note">Kontrola naplánovaných (<code>future</code>) WP postů přes REST API (read-only, application password), 1×/4 h. Zaseknutý = termín prošel o víc než 15 min a post pořád nevyšel — obvykle vypnutý/rozbitý WP cron na webu. Oprava: zkontroluj <code>wp-cron.php</code>, nebo post publikuj ručně z administrace WordPressu.</div>`;
  h += `<div class="section-h">WEBY</div>`;
  h += sites.map(wpschedSiteCard).join('') || '<div class="note">zatím bez měření — první kontrola proběhne do pár minut.</div>';
  return h;
}

// ---- nanoclaw (read-only panel nad lokální instalací NanoClaw — jen čte
// jeho data/v2.db + stav systemd --user unity, viz modules/nanoclaw.js
// hlavička). Hint na restart je ČISTĚ TEXT (`systemctl --user restart
// <unit>`), ŽÁDNÉ tlačítko — state-changing akce běží jen přes allowlist
// (config.js RESTARTABLE_SERVICES) a nanoclaw unita tam záměrně NENÍ (mimo
// scope balíčku — viz task-13 brief). ----
function nanoclawAgentCard(a) {
  const led = (a.running || 0) > 0 ? 'ok' : 'idle';
  return `<div class="drow"><span class="led ${led}"></span><div class="grow">
    <div class="t1">${esc(a.name)} <span class="c-dim">(${esc(a.folder)})</span></div>
    <div class="t2">${a.running || 0}/${a.sessions || 0} session běží · naposledy ${a.lastActive ? rel(new Date(a.lastActive).toISOString()) : 'nikdy'}</div>
  </div></div>`;
}
const NANOCLAW_STATE_LABEL = { ok: 'BĚŽÍ', warn: 'POZOR', crit: 'STOJÍ', off: 'NENAINSTALOVÁNO' };
function buildNanoclaw() {
  const n = S.nanoclaw || {};
  const agents = n.agents || [];
  const unit = n.unit;
  let h = dl([
    ['Stav', `<b class="${stC(n.state)}">${NANOCLAW_STATE_LABEL[n.state] || n.state || '—'}</b>`],
    ['Systemd unit', unit ? `<code>${esc(unit.name)}</code> · ${esc(unit.active)}` : 'nenalezena'],
    ['Agentů', agents.length],
    ['Běžících session', agents.reduce((a, x) => a + (x.running || 0), 0)],
    ['Aktualizováno', n.updatedAt ? rel(new Date(n.updatedAt).toISOString()) : 'zatím nikdy'],
  ]);
  h += `<div class="note">Read-only panel nad instalací <b>NanoClaw</b> na tomhle boxu — MC čte jen její <code>data/v2.db</code> (SQLite, read-only) a stav systemd <code>--user</code> unity, nikam nezapisuje. ${unit ? `Restart: <code>systemctl --user restart ${esc(unit.name)}</code>.` : 'Unit nenalezena — zkontroluj instalaci (<code>bash nanoclaw.sh</code>) nebo cestu v configu (<code>modules.nanoclaw.dir</code>).'}</div>`;
  h += `<div class="section-h">AGENTI</div>`;
  h += agents.map(nanoclawAgentCard).join('') || '<div class="note">žádní agenti v <code>agent_groups</code>.</div>';
  return h;
}

// ---- watchdog (HLÍDAČ) — poslední běh hodinového cron-watchdog agenta
// (modules/watchdog.js collectWatchdog(), read-only nad data/watchdog-
// history.jsonl + data/narrative/*.log). MC sem nic nezapisuje ani nespouští
// claude — to dělá vnější cron (watchdog/run-watchdog.sh, viz INSTALL.md).
// narrativeSection vzor viz interní research poznámky (ui-snippety). ----
const WD_OVERALL_LABEL = { ok: 'OK', fixed: 'OPRAVENO', alert: 'ALERT' };
function watchdogHistoryRow(e) {
  const led = e.overall === 'alert' ? 'warn' : 'ok';
  const label = WD_OVERALL_LABEL[e.overall] || String(e.overall || '?').toUpperCase();
  const n = (e.actions || []).length, m = (e.alerts || []).length;
  return ledRow(led, `${label} · ${n} akcí · ${m} alertů`, e.ts ? rel(e.ts) : '');
}
function narrativeSection(lines) {
  const rows = (lines || []).slice().reverse().map((l) => {
    const m = String(l).match(/^\[([^\]]+)\]\s*(.*)$/);
    return `<div class="narr"><span class="narr-ts">${esc(m ? m[1] : '')}</span><span class="narr-tx">${esc(m ? m[2] : l)}</span></div>`;
  }).join('');
  return rows || '<div class="note">zatím bez narativu</div>';
}
function watchdogProjectCard(p) {
  return `<div class="section-h sm10">${esc(p.label)}</div>${narrativeSection(p.narrative)}`;
}
function buildWatchdog() {
  const w = S.watchdog || {};
  const last = w.last;
  const lastLabel = last ? (WD_OVERALL_LABEL[last.overall] || String(last.overall || '?').toUpperCase()) : null;
  let h = dl([
    ['Poslední běh', last ? `<b class="${stC(w.state)}">${lastLabel}</b> · ${rel(last.ts)}` : 'zatím žádný'],
    ['Akce', last ? (last.actions || []).length : '—'],
    ['Alerty', last ? (last.alerts || []).length : '—'],
    ['Projektů', (w.projects || []).length],
    ['Aktualizováno', w.updatedAt ? rel(new Date(w.updatedAt).toISOString()) : 'zatím nikdy'],
  ]);
  h += `<div class="note">Hodinový hlídač cronů (headless Claude, viz <code>watchdog/</code>) — Mission Control sem jen ČTE historii a narativy, nic nespouští. Vnější cron záznam nastavuje INSTALL.md.</div>`;
  if (last && (last.actions || []).length) {
    h += `<div class="section-h">AKCE POSLEDNÍHO BĚHU</div>`;
    h += last.actions.map((a) => `<div class="note nm6">• ${esc(String(a))}</div>`).join('');
  }
  if (last && (last.alerts || []).length) {
    h += `<div class="section-h">ALERTY POSLEDNÍHO BĚHU</div>`;
    h += last.alerts.map((a) => `<div class="note nm6 c-warn">⚠ ${esc(typeof a === 'object' && a ? (a.text || a.id || '') : String(a))}</div>`).join('');
  }
  h += `<div class="section-h">HISTORIE (POSLEDNÍCH ${(w.history || []).length})</div>`;
  h += (w.history || []).map(watchdogHistoryRow).join('') || '<div class="note">zatím bez historie</div>';
  h += `<div class="section-h">NARATIVY PROJEKTŮ</div>`;
  h += (w.projects || []).map(watchdogProjectCard).join('') || '<div class="note">v configu není nastaven žádný projekt (modules.watchdog.projects)</div>';
  return h;
}

function buildPreviews() {
  const list = S.previews || [];
  let h = `<div class="note">Co ti Claude na VPS vyrobí a zaregistruje, se objeví tady. „⤢ Otevřít" = velké okno přímo v Mission Control; „⤤ Nové okno" = samostatná záložka prohlížeče.</div>`;
  h += `<div class="section-h">NÁHLEDY (${list.length})</div>`;
  if (!list.length) {
    h += `<div class="note">Zatím prázdné. Z terminálu projektu spusť:<br><code>mc-preview add &lt;slug&gt; --static ./dist --title "Název"</code><br>nebo živý dev server:<br><code>mc-preview add &lt;slug&gt; --port 5173</code></div>`;
  } else {
    h += list.map(previewCard).join('');
  }
  return h;
}

function buildSystem() {
  const s = S.system || {};
  const rows = [
    ['CPU', `${s.cpuPct ?? 0} %`],
    ['RAM', s.mem ? `${(s.mem.usedB / 1073741824).toFixed(1)} / ${(s.mem.totalB / 1073741824).toFixed(1)} GiB (${s.mem.usedPct}%)` : '—'],
    ['Swap', s.mem && s.mem.swapTotalB ? `${(s.mem.swapUsedB / 1073741824).toFixed(1)} / ${(s.mem.swapTotalB / 1073741824).toFixed(1)} GiB (${s.mem.swapUsedPct}%)` : 'vypnutý'],
  ];
  const disks = (s.disks && s.disks.length) ? s.disks : (s.disk ? [{ label: 'Disk /', ...s.disk }] : []);
  for (const d of disks) rows.push([d.label || d.mount || 'Disk', `${(d.usedB / 1073741824).toFixed(0)} / ${(d.totalB / 1073741824).toFixed(0)} GiB (${d.usedPct}%)`]);
  rows.push(['Load', (s.load || []).join(' / ')], ['Jádra', s.cores], ['Uptime', dur(s.uptimeSec)]);
  return dl(rows) + `<div class="btn-row"><button class="btn sm" data-act="service.restart" data-target="mission-control">⟳ Restart Mission Control</button></div>`;
}

// ---- detail úkolu (klik z panelu ÚKOLY; opts.i = index v S.claude.tasks) ----
const PROJ2ID = { shared_crm: 'crm', 'ig-publisher': 'ig', 'gyg-cards': 'gyg', 'nanoclaw-v2': 'nanoclaw', nanoclaw: 'v1', 'mission-control': 'system' };
// živá tmux session, ve které úkol běží (kolektor mapuje pid Clauda -> pane)
const taskTermSession = (t) => (t && t.termKey != null && t.termSid != null)
  ? ((S.term || {}).sessions || []).find((x) => x.key === t.termKey && x.sid === t.termSid) || null : null;
function buildTask(_S, o) {
  const t = (S.claude?.tasks || [])[o?.i];
  if (!t) return '<div class="note">úkol už není v seznamu</div>';
  const tag = { in_progress: 'běží', pending: 'čeká', completed: 'hotovo' }[t.status] || t.status;
  const ts = taskTermSession(t);
  const rows = [['Stav', tag], ['Projekt', esc(t.project || t.group || '—')]];
  if (ts) {
    const work = ts.work || 'dormant';
    rows.push(['Session', `<button class="btn sm" id="taskSess" data-tkey="${esc(ts.key)}" data-tsid="${ts.sid}"
      title="${esc(TERM_WORK_LABEL[work] || work)} · otevřít tenhle terminál"><span class="led work-${esc(work)}"></span> ⌁ ${esc(ts.label || '#' + ts.sid)}</button>`]);
  }
  let h = dl(rows);
  h += `<div class="section-h">CO PRÁVĚ DĚLÁ</div><div class="note">${esc(t.activeForm || t.subject || '—')}</div>`;
  h += `<div class="section-h">ZADÁNÍ</div><div class="note">${esc(t.subject || '—')}</div>`;
  if (t.description) h += `<div class="section-h">DETAIL / NA CO SE VÁŽE</div><div class="note">${esc(t.description)}</div>`;
  if (t.blockedBy && t.blockedBy.length) h += `<div class="note">⛔ blokováno: ${esc(t.blockedBy.join(', '))}</div>`;
  if (t.blocks && t.blocks.length) h += `<div class="note">⛓ blokuje: ${esc(t.blocks.join(', '))}</div>`;
  const pid = PROJ2ID[t.project];
  if (!ts && pid) h += `<div class="btn-row mt14"><button class="btn" id="taskTerm" data-pid="${esc(pid)}">⌁ Otevřít terminál projektu</button></div>`;
  return h;
}

// =====================================================================
// registrace + sdílený wire
// =====================================================================
const TITLES = { claude: 'CLAUDE CODE', system: 'SYSTÉM', uptime: 'UPTIME — WEBY', traffic: 'NÁVŠTĚVNOST', gsc: 'VYHLEDÁVÁNÍ', indexace: 'INDEXACE', wpsched: 'WP PLÁNOVANÉ', nanoclaw: 'NANOCLAW', watchdog: 'HLÍDAČ', previews: 'NÁHLEDY' };

function wireCommon(body) {
  wireActions(body);
  wirePreviews(body);
}

export function initDrawers() {
  registerTermDrawer();

  const BUILDERS = {
    claude: buildClaude, uptime: buildUptime, traffic: buildTraffic, gsc: buildGsc,
    indexace: buildIndexace, wpsched: buildWpsched, nanoclaw: buildNanoclaw, watchdog: buildWatchdog, previews: buildPreviews, system: buildSystem,
  };
  // živé deps jen tam, kde rebuild nic nerozbije; drawery s terminálem a
  // s rozbalovacím/scroll stavem jsou statické
  const DEPS = {
    uptime: ['uptime'], traffic: ['ga4'], gsc: ['gsc'], indexace: ['indexace'], wpsched: ['wpsched'], nanoclaw: ['nanoclaw'], watchdog: ['watchdog'], previews: ['previews'],
  };

  for (const [id, build] of Object.entries(BUILDERS)) {
    const termKey = TERMKEY[id];
    registerDrawer(id, {
      title: TITLES[id] || id.toUpperCase(),
      deps: DEPS[id] || [],
      wide: !!termKey,
      term: !!termKey,
      build: termKey
        // terminálové drawery: projektový obsah + vložený Claude terminál (jako v1)
        ? () => `<div class="drawer-proj">${build()}</div><div class="section-h term-h">⌁ CLAUDE TERMINÁL</div><div class="term-wrap" id="termWrap"></div>`
        : (S, o) => build(S, o),
      wire: (body, opts, phase) => {
        wireCommon(body);
        if (termKey) termInit(termKey);
        // INDEXACE: fokus na kliknutý web (panel řádek -> openDrawer('indexace',
        // {focus:id})) — odscroll na kartu + krátké zvýraznění. JEN při otevření
        // ('open') — patch rebuild by jinak ukradl scroll pozici uživateli.
        if (id === 'indexace' && opts?.focus && phase === 'open') {
          const card = body.querySelector(`.gsc-card[data-site="${CSS.escape(opts.focus)}"]`);
          if (card) {
            card.scrollIntoView({ block: 'start', behavior: 'auto' });
            card.classList.add('focus-flash');
            setTimeout(() => card.classList.remove('focus-flash'), 1600);
          }
        }
      },
    });
  }

  registerDrawer('task', {
    title: 'ÚKOL',
    deps: ['claude', 'term'], // term: session chip (label + work LED) žije v S.term
    build: buildTask,
    wire: (body) => {
      const b = body.querySelector('#taskTerm');
      if (b) b.addEventListener('click', () => openDrawer(b.dataset.pid));
      const sb = body.querySelector('#taskSess');
      if (sb) sb.addEventListener('click', () => {
        const key = sb.dataset.tkey;
        const label = (termProjects().find((p) => p.key === key) || {}).label || key;
        openTermDrawer(key, label, Number(sb.dataset.tsid));
      });
    },
  });
}
