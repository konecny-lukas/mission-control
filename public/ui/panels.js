/* MC v2 — všechny B-grid panely. Každý panel = registerSection(id, deps, fn):
   idempotentní innerHTML rebuild nad živým S, spouštěný JEN když SSE patch
   zasáhne jeho deps. Veškerý dynamický obsah jde přes esc().
   Datové vazby jádra (přesně 3): segmenty prstence = systemd služby,
   SSE timeline event = pulz, drift roje = síťová propustnost. */

import { $, esc, fmt, cz, fmtNum, fmtPct, usd, rel, dur, hm, hms, dmhm, fmtRate, fmtBytes, GB, fx, toast } from '../core/dom.js';
import { S, registerSection } from '../core/store.js';
import { bus, postAction } from '../core/net.js';
import { openDrawer } from './drawer.js';
import { termProjects, openTermDrawer } from './term.js';
import { openThreadDrawer, THREAD_STATUS } from './thread.js';
import { replayBoot } from './boot.js';

// Brand akcent (nastavuje sekce 'brand' z CFG.accent) — čteno jednou při
// startu modulu, fallback na výchozí cyan pro případ, že proměnná ještě
// není v CSS nastavená.
const ACCENT_RGB = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '43,168,255';
const [AR, AG, AB] = ACCENT_RGB.split(',').map(Number);

// ACCENTS mapování 1:1 s public/app.js:3
const ACCENTS = {
  ok: { r: AR, g: AG, b: AB },
  warn: { r: 255, g: 176, b: 32 },
  crit: { r: 255, g: 77, b: 94 },
  idle: { r: 107, g: 143, b: 166 },
  paused: { r: 255, g: 193, b: 77 },
};
const CY = `rgba(${ACCENT_RGB},.9)`;
var core = null; // gl core API (initPanels) — var: žádná TDZ ani při kruhovém importu

// otevření formuláře „+ ÚKOL" (drátuje initPanels; volá i ⌘K paleta „Nový úkol…")
let mctOpenForm = () => {};
export function openMctaskForm() { mctOpenForm(); }

// ---------- SVG sparklines ----------
function spark(data, w, h, color, area) {
  if (!data || data.length < 2) return `<span class="spark-empty">měřím…</span>`;
  const max = Math.max(...data, 1), min = Math.min(...data);
  const span = Math.max(max - min, 1e-6);
  const pts = data.map((v, i) =>
    (i / (data.length - 1) * w).toFixed(1) + ',' + (h - 1.2 - (v - min) / span * (h - 2.6)).toFixed(1)).join(' ');
  const fill = area ? `<polygon points="0,${h} ${pts} ${w},${h}" fill="${color}" opacity=".13"/>` : '';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${fill}<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2" opacity=".85"/></svg>`;
}
function ticks(bits, w, h) {
  if (!bits || !bits.length) return '';
  const bw = w / bits.length; let r = '';
  bits.forEach((up, i) => {
    r += `<rect x="${(i * bw).toFixed(1)}" y="${up ? 3 : 0}" width="${Math.max(bw - 1, .8).toFixed(1)}" height="${up ? h - 6 : h}" fill="${up ? 'rgba(46,232,122,.5)' : '#ff4d5e'}"/>`;
  });
  return `<svg class="spark" width="${w}" height="${h}">${r}</svg>`;
}
const row = (i, cols, html, cls) => `<div class="r${cls ? ' ' + cls : ''}" style="--ri:${i};grid-template-columns:${cols}">${html}</div>`;
const setDot = (panel, state) => {
  const d = document.querySelector(`#${panel} .ptitle .sdot`);
  if (d) d.className = `sdot ${state || 'idle'}`;
};

// ---------- klientská historie síťových rychlostí (dedup na rxTotal) ----------
const NET_HIST_MAX = 40;
const netHist = [];
let netLastTotal = null;
function pushNetSample(net) {
  if (!net || net.rxRate == null) return;
  if (netLastTotal != null && net.rxTotal === netLastTotal) return;
  netLastTotal = net.rxTotal;
  netHist.push({ rx: net.rxRate, tx: net.txRate || 0 });
  if (netHist.length > NET_HIST_MAX) netHist.shift();
}

// ---------- TOPBAR (pill + hodiny řeší app.js) ----------
function pillInfo() {
  if (document.body.classList.contains('signal-lost')) return { cls: 'crit', txt: 'SIGNÁL ZTRACEN · OBNOVUJI…' };
  const act = S.alerts?.active || [];
  const nc = act.filter((a) => a.severity === 'crit').length;
  const nw = act.filter((a) => a.severity !== 'crit').length;
  // vlákno čeká na odpověď uživatele -> ❓ badge má přednost v textu pillu
  // (alert vlákna + úkolová vlákna z FRONTY — stejný ❓ tok)
  const nq = act.filter((a) => a.thread?.waiting).length + ((S.mctasks || {}).waiting || 0);
  const q = nq ? `❓ ${nq} · ` : '';
  const st = S.summary?.state || 'ok';
  if (nc) return { cls: 'crit', txt: `${q}VÝSTRAHA · ${nc} CRIT · ${nw} WARN` };
  if (st === 'crit') return { cls: 'crit', txt: `${q}KRITICKÝ STAV${nw ? ` · ${nw} WARN` : ''}` };
  if (nq) return { cls: 'warn', txt: `${q}VLÁKNO ČEKÁ NA TEBE` };
  if (nw) return { cls: 'warn', txt: `SYSTÉMY ONLINE · ${nw} VAROVÁNÍ` };
  if (st === 'warn') return { cls: 'warn', txt: 'SYSTÉMY ONLINE · ODCHYLKY' };
  return { cls: 'ok', txt: 'SYSTÉMY ONLINE' };
}
// ---------- BRAND (jméno/tagline/akcent z mc.config.json, jednou při startu) ----------
registerSection('brand', ['branding'], () => {
  const b = S.branding;
  if (!b) return;
  document.title = `${b.name} · Mission Control`;
  const el = document.querySelector('.brand .word');
  if (el) el.textContent = `${b.name} · MISSION CONTROL`;
  const rgb = b.accent.length === 7
    ? `${parseInt(b.accent.slice(1, 3), 16)},${parseInt(b.accent.slice(3, 5), 16)},${parseInt(b.accent.slice(5, 7), 16)}`
    : '43,168,255';
  const rs = document.documentElement.style;
  rs.setProperty('--cyan', b.accent);
  rs.setProperty('--accent-rgb', rgb);
});

registerSection('topbar', ['summary', 'alerts', 'mctasks', '_net'], () => {
  const p = $('#pill'), t = $('#pillTxt');
  if (!p || !t) return;
  const { cls, txt } = pillInfo();
  p.className = `pill ${cls}`;
  t.textContent = txt;
});

// ---------- SYSTÉM ----------
registerSection('system', ['system', 'netstat'], () => {
  const s = S.system || {}, n = s.net || {}, mem = s.mem || {}, ns = S.netstat || {};
  pushNetSample(n);
  const bar = (p, lo) => `<span class="bar${p >= 85 ? ' crit' : p >= (lo || 70) ? ' warn' : ''}"><i style="--w:${Math.max(0, Math.min(100, p || 0))}%"></i></span>`;
  const C = '52px minmax(0,1fr) 100px';
  let h = '';
  h += row(0, C, `<span class="lbl">CPU</span>${bar(s.cpuPct)}<span class="num">${s.cpuPct ?? '—'} % <span class="unit">· ${cz((s.load || [])[0], 2)}</span></span>`);
  h += row(1, C, `<span class="lbl">RAM</span>${bar(mem.usedPct)}<span class="num">${cz(GB(mem.usedB || 0), 1)}<span class="unit">/${cz(GB(mem.totalB || 0), 1)} GB</span></span>`);
  h += row(2, C, `<span class="lbl">SWAP</span>${bar(mem.swapUsedPct)}<span class="num">${cz(GB(mem.swapUsedB || 0), 1)}<span class="unit">/${cz(GB(mem.swapTotalB || 0), 1)} GB</span></span>`);
  (s.disks || []).forEach((d, i) => {
    h += row(3 + i, C, `<span class="lbl">${i ? 'SSD VOL' : 'DISK /'}</span>${bar(d.usedPct, 80)}<span class="num">${Math.round(GB(d.usedB))}<span class="unit">/${Math.round(GB(d.totalB))} GB · ${d.usedPct} %</span></span>`);
  });
  const di = (s.disks || []).length;
  h += row(3 + di, C, `<span class="lbl">RX ↓</span>${spark(netHist.map((x) => x.rx), 200, 14, CY)}<span class="num">${esc(fmtRate(n.rxRate))}</span>`);
  h += row(4 + di, C, `<span class="lbl">TX ↑</span>${spark(netHist.map((x) => x.tx), 200, 14, CY)}<span class="num">${esc(fmtRate(n.txRate))}</span>`);
  const up = s.uptimeSec || 0, dny = Math.floor(up / 86400), hod = Math.floor(up % 86400 / 3600);
  h += `<div class="foot"><span>UPTIME ${dny} d ${hod} h · ${s.cores || '—'} JÁDRA</span><span>${ns.ready ? `DNES ↓${cz(GB(ns.todayRx), 1)} GB ↑${cz(GB(ns.todayTx), 1)} GB` : 'MĚŘÍM PŘENOSY…'}</span></div>`;
  $('#systemBody').innerHTML = h;
  $('#sysMeta').textContent = `LOAD ${(s.load || []).map((x) => cz(x, 2)).join(' ')}`;
  setDot('p-system', s.state);
  // datová vazba 3: drift roje = síťová propustnost (EMA dělá core)
  if (core) core.setActivity(Math.max(.5, Math.min(2.5, ((n.rxRate || 0) + (n.txRate || 0)) / 80000 + .8)));
});

// ---------- limity Claude subscription (řádek v cm-grid JÁDRA, modul
// „claudelimits" — VOLITELNÝ, viz config.js MODULES + server.js moduleLoop()).
// Data z modules/claudelimits.js (GET /api/oauth/usage — tentýž zdroj jako
// `/usage` v Claude Code). Vejít se musí do JEDNOHO řádku cm-gridu: .core-meta
// je vertikálně centrovaná v pevně vysokém .core-wrap a každý další řádek by
// vytlačil obsah do minirow (ověřeno měřením v hlavním MC). Proto segmenty
// „5 H / TÝDEN" (+ volitelně model-scoped týdenní limity) vedle sebe: bar + %
// + čas resetu, zbytek do titulku. Port panels.js:124-149 hlavního MC.
const dm = (ms) => { const d = new Date(ms); return `${d.getDate()}.${d.getMonth() + 1}.`; };
function limSeg(short, full, b, stale, tipExtra) {
  if (!b || b.pct == null) return '';
  const pct = Math.max(0, Math.min(100, b.pct));
  const st = stale ? 'idle' : (b.state || 'ok');
  const cls = st === 'warn' ? ' warn' : (st === 'crit' ? ' crit' : '');
  const soon = b.resetsAt && b.resetsAt - Date.now() < 20 * 3600 * 1000;
  const rst = b.resetsAt ? (soon ? hm(b.resetsAt) : dm(b.resetsAt)) : '—';
  const left = b.resetsAt ? dur(Math.max(0, Math.round((b.resetsAt - Date.now()) / 1000))) : null;
  const tip = [`${full}: využito ${pct} %`, left ? `reset za ${left} (${dmhm(b.resetsAt)})` : null, tipExtra].filter(Boolean).join(' · ');
  return `<span class="lseg" title="${esc(tip)}"><em>${esc(short)}</em>`
    + `<span class="bar lbar${cls}"><i style="--w:${pct}%"></i></span>`
    + `<b class="lpct${cls}">${pct} %</b><span class="lrst">↺${rst}</span></span>`;
}
// Řádek se vykreslí jen když je modul zapnutý A modul už poslal aspoň jednu
// (třeba placeholder) hodnotu — vypnutý modul = state.claudeLimits vůbec
// neexistuje (server.js moduleLoop gating), takže se cm-grid řádek nikdy
// nepřidá a zbylé 4 řádky (Služby/Docker/Tailnet/Snímek) se nijak neposunou.
function claudeLimitRow() {
  if (!S.modules?.claudelimits || !S.claudeLimits) return '';
  const cl = S.claudeLimits;
  if (!cl.fiveHour && !cl.weekly) {
    return `<span class="k">Claude</span><span class="v" title="${esc(cl.err || 'zatím neměřeno')}">${cl.err ? 'limity nedostupné' : 'měřím…'}</span>`;
  }
  const st = cl.stale;
  const plan = [cl.plan ? `plán ${cl.plan}` : null,
    st ? 'POZOR: data neaktuální — OAuth token vypršel, obnoví ho libovolná Claude session' : null].filter(Boolean).join(' · ');
  const segs = [limSeg('5h', 'okno 5 h', cl.fiveHour, st, plan), limSeg('7d', 'týden', cl.weekly, st, plan)]
    .concat((cl.scoped || []).map((s) => limSeg(s.label, `${s.label} — týden`, s, st, plan))).filter(Boolean);
  return `<span class="k">Claude</span><span class="v lim${st ? ' stale' : ''}">${segs.join('')}</span>`;
}

// ---------- JÁDRO (meta + minirow + accent/segments) ----------
let lastAccent = '';
registerSection('core', ['summary', 'alerts', 'services', 'docker', 'tailscale', 'claudeLimits'], () => {
  const sum = S.summary || {}, cnt = sum.counts || {};
  const st = ['ok', 'warn', 'crit'].includes(sum.state) ? sum.state : 'ok';
  document.body.dataset.state = st;
  if (core) core.setAccent(ACCENTS[st]);
  if (lastAccent && lastAccent === 'ok' && st !== 'ok') fx($('#p-core')); // eskalace -> glitch
  lastAccent = st;
  // segmenty hlavního prstence = systemd služby (datová vazba 1)
  const sevMap = { ok: 0, warn: 1, crit: 2 };
  if (core) core.setSegments((S.services || []).map((s) => sevMap[s.state] !== undefined ? sevMap[s.state] : 3));

  const act = S.alerts?.active || [];
  const critA = act.find((a) => a.severity === 'crit');
  const docker = S.docker || [];
  const dRun = docker.filter((c) => c.running).length;
  const peers = S.tailscale?.peers || [];
  const pOn = peers.filter((p) => p.online).length;
  const funnel = peers.filter((p) => /funnel/i.test(p.name || '')).length;
  const svc = S.services || [];
  const svcUp = svc.filter((s) => s.active === 'active').length;
  const stLabel = { ok: 'NOMINÁLNÍ', warn: 'VAROVÁNÍ', crit: 'VÝSTRAHA' }[st];
  $('#coreMeta').innerHTML = `
    <div class="cm-state st-${st}">${stLabel}</div>
    <div class="cm-msg">${critA ? 'Kritická: ' + esc(critA.text) : esc(sum.message || '')}</div>
    <div class="cm-counts">
      <span style="color:var(--ok)">● <b>${cnt.ok ?? 0}</b> OK</span>
      <span style="color:var(--warn)">● <b>${cnt.warn ?? 0}</b> WARN</span>
      <span style="color:var(--crit)">● <b>${cnt.crit ?? 0}</b> CRIT</span></div>
    <div class="cm-grid">
      <span class="k">Služby</span><span class="v">${svcUp}/${svc.length} aktivních</span>
      <span class="k">Docker</span><span class="v">${dRun}/${docker.length} běží</span>
      <span class="k">Tailnet</span><span class="v">${pOn}/${peers.length} · funnel ${funnel}</span>
      ${claudeLimitRow()}
      <span class="k">Snímek</span><span class="v">${S.ts ? hms(S.ts) : '—'}</span></div>`;
  $('#coreHost').textContent = `${S.hostname || 'server'}${S.tailscale?.magicDNSSuffix ? ' · ' + S.tailscale.magicDNSSuffix.split('.')[0] : ''}`;
  setDot('p-core', st);
});

// ---------- VÝSTRAHY (skrytý když prázdný; = FRONTA vláken: chip stavu per
// výstraha; ◆ startuje interaktivní vlákno (threads.js) a otevírá jeho drawer;
// klik na chip běžícího/čekajícího/hotového vlákna otevírá drawer) ----------
const seenAlertIds = new Set();
const prevWaiting = new Set(); // klíče vláken ve stavu waiting (toast/fx jen na NOVÉ)
let alertsFirstRender = true;
function threadChip(a) {
  const th = a.thread;
  if (!th) return `<button class="btn bsm" data-act="th-start" data-key="${esc(a.key)}">◆ vlákno</button>`;
  const st = THREAD_STATUS[th.status] || { cls: '', label: th.status };
  const label = th.status === 'queued' && th.queuePos ? `⏳ fronta č.${th.queuePos}` : st.label;
  const tip = th.lastLine ? ` title="${esc(th.lastLine)}"` : '';
  return `<button class="th-chip ${st.cls}" data-act="th-open" data-key="${esc(a.key)}"${tip}>${esc(label)}</button>`;
}
registerSection('alerts', ['alerts'], () => {
  const A = S.alerts || {};
  const act = A.active || [];
  document.body.classList.toggle('no-alerts', !act.length);
  if (!act.length) { seenAlertIds.clear(); prevWaiting.clear(); alertsFirstRender = false; return; }
  const panel = $('#p-alerts');
  const worst = act.some((a) => a.severity === 'crit') ? 'crit' : 'warn';
  panel.classList.toggle('glow-warn', worst === 'warn');
  panel.classList.toggle('glow-crit', worst === 'crit');
  let isNew = false, newWaiting = null;
  let h = '';
  act.forEach((a, i) => {
    if (!seenAlertIds.has(a.id)) { seenAlertIds.add(a.id); if (!alertsFirstRender) isNew = true; }
    if (a.thread?.waiting) {
      if (!prevWaiting.has(a.key)) { prevWaiting.add(a.key); if (!alertsFirstRender) newWaiting = a; }
    } else prevWaiting.delete(a.key);
    const target = String(a.key || '').includes(':') ? a.key.split(':').slice(1).join(':') : (a.rule || '');
    h += `<div class="alert ${a.severity}${a.thread?.waiting ? ' th-wait' : ''}" style="--ri:${i}">
      <div class="ah"><span class="led ${a.severity}"></span><span class="at">${esc(target || a.rule)}</span>
      <span class="ats">${a.openedTs ? hm(a.openedTs) : ''}</span><span class="tag">${esc((a.severity || '').toUpperCase())}</span></div>
      <div class="ax">${esc(a.text || '')}</div>
      ${a.diagnosis ? `<div class="ax adiag">◆ ${esc(a.diagnosis)}</div>` : ''}
      <div class="a-act">
        ${a.link ? `<button class="btn bsm" data-act="open" data-link="${esc(a.link)}">▸ detail</button>` : ''}
        ${threadChip(a)}
        <button class="btn bsm" data-act="silence" data-key="${esc(a.key)}" title="Skryje výstrahu, dokud se nevyřeší; při novém výskytu se vrátí (max 7 dní)">✕ skrýt</button>
      </div></div>`;
  });
  // chip skrytých výstrah (alert.silence) — neinteraktivní, klíče v tooltipu
  const sil = A.silencedCount > 0
    ? `<span class="a-silenced" title="Skryté do vyřešení (max 7 dní):&#10;${esc((A.silencedKeys || []).join('\n'))}">✕ skryté: ${A.silencedCount}</span>` : '';
  h += `<div class="aclear"><b>●</b>&ensp;${A.count24h ?? act.length} výstrah za 24 h · poslední sken ${S.ts ? hms(S.ts) : '—'}${sil}</div>`;
  $('#alertsBody').innerHTML = h;
  const nc = act.filter((a) => a.severity === 'crit').length;
  const nq = act.filter((a) => a.thread?.waiting).length;
  $('#alMeta').textContent = `${nq ? `❓ ${nq} · ` : ''}${nc} CRIT · ${act.length - nc} WARN`;
  setDot('p-alerts', worst);
  if (isNew) { fx(panel); if (core) core.pulse(worst === 'crit' ? 2 : 1); }
  if (newWaiting) { fx(panel); toast(`❓ Vlákno čeká na tvou odpověď: ${newWaiting.rule || newWaiting.key}`, 'err'); if (core) core.pulse(1); }
  alertsFirstRender = false;
});

// POZN.: tlačítko „✓ potvrdit" (alert.ack) z panelu odstraněno 2026-06-11 —
// mátlo (výstrahu neskrývalo). Backend endpoint alert.ack + sloupec ackTs
// zůstávají pro kompatibilitu; UI je už nepoužívá. Náhrada = „✕ skrýt" níž.

// ---------- WEBY (modul „uptime" — VZOR pro dalších 7 modulů, viz config.js
// MODULES + server.js moduleLoop(). Gating konvence: hned na vstupu sekce se
// panel skryje/ukáže atributem hidden podle S.modules, a beze zapnutého modulu
// se dál nerenderuje (S.uptime bez modulu ani neexistuje — server.js jej
// nikdy nenastaví, viz test/modules-gating.test.mjs). Data + porty ticks()/
// row() z main MC panels.js:301-314. ----------
registerSection('weby', ['uptime'], () => {
  const p = document.getElementById('p-weby');
  if (p) p.hidden = !S.modules?.uptime;
  if (!S.modules?.uptime) return;
  const u = S.uptime || {};
  const C = '8px 1fr 56px 52px minmax(0,96px)';
  let h = '';
  (u.sites || []).forEach((s, i) => {
    const warn24 = s.pct24 != null && s.pct24 < 98;
    h += row(i, C, `<span class="led ${s.state}"></span><span class="lbl">${esc(s.label)}</span>
      <span class="num dim">${s.lastMs ?? '—'} <span class="unit">ms</span></span>
      <span class="num"${warn24 ? ' style="color:var(--warn)"' : ''}>${s.pct24 != null ? cz(s.pct24, 1) : '—'} %</span>${ticks((s.spark || []).slice(-48), 96, 12)}`);
  });
  $('#webyBody').innerHTML = h || '<div class="pempty">zatím bez měření</div>';
  $('#webMeta').textContent = `${u.sitesUp ?? 0}/${u.sitesTotal ?? 0} ONLINE · Ø ${u.overallPct != null ? cz(u.overallPct, 1) : '—'} %`;
  setDot('p-weby', u.state);
});

// ---------- NÁVŠTĚVNOST (modul „ga4" — druhý modulový panel v ř. 4, vedle
// WEBY; řádek dělený na poloviny, viz styles.css #p-weby/#p-traffic). Stejná
// gating konvence jako WEBY: panel se skryje/ukáže hned na vstupu podle
// S.modules.ga4, beze zapnutého modulu se dál nerenderuje (S.ga4 bez modulu
// ani neexistuje — server.js jej nikdy nenastaví). ----------
registerSection('traffic', ['ga4'], () => {
  const p = document.getElementById('p-traffic');
  if (p) p.hidden = !S.modules?.ga4;
  if (!S.modules?.ga4) return;
  const g = S.ga4 || {};
  const sites = g.sites || [];
  const C = '8px 1fr 56px 60px minmax(0,80px)';
  let h = '';
  sites.forEach((s, i) => {
    h += row(i, C, `<span class="led ${s.live != null ? 'ok' : 'idle'}"></span><span class="lbl">${esc(s.label)}</span>
      <span class="num dim">${s.today?.sessions != null ? fmtNum(s.today.sessions) : '—'}</span>
      <span class="num">${fmtNum(s.d7?.sessions)}<span class="unit">/7d</span></span>${spark(s.spark, 80, 12, CY, true)}`);
  });
  $('#trafficBody').innerHTML = h || '<div class="pempty">zatím bez měření</div>';
  const withData = sites.filter((s) => (s.d28?.sessions || 0) > 0).length;
  const todaySum = sites.reduce((a, s) => a + (s.today?.sessions || 0), 0);
  $('#trafficMeta').textContent = `${withData}/${sites.length} S DATY · DNES ${fmtNum(todaySum)}`;
  setDot('p-traffic', sites.length ? (withData ? 'ok' : 'idle') : 'idle');
});

// ---------- VYHLEDÁVÁNÍ (modul „gsc" — třetí modulový panel v ř. 4, vedle
// WEBY/NÁVŠTĚVNOST; řádek dělený na třetiny, viz styles.css #p-weby/
// #p-traffic/#p-search). Stejná gating konvence jako sourozenci: panel se
// skryje/ukáže hned na vstupu podle S.modules.gsc, beze zapnutého modulu se
// dál nerenderuje (S.gsc bez modulu ani neexistuje — server.js jej nikdy
// nenastaví). ----------
registerSection('search', ['gsc'], () => {
  const p = document.getElementById('p-search');
  if (p) p.hidden = !S.modules?.gsc;
  if (!S.modules?.gsc) return;
  const g = S.gsc || {};
  const sites = g.sites || [];
  const C = '8px 1fr 44px 60px minmax(0,80px)';
  let h = '';
  sites.forEach((s, i) => {
    h += row(i, C, `<span class="led ${(s.clicks28 || 0) > 0 ? 'ok' : 'idle'}"></span><span class="lbl">${esc(s.label)}</span>
      <span class="num dim">${s.position28 != null ? cz(s.position28, 1) : '—'}</span>
      <span class="num">${fmtNum(s.clicks28)}<span class="unit">/28d</span></span>${spark(s.spark, 80, 12, CY, true)}`);
  });
  $('#searchBody').innerHTML = h || '<div class="pempty">zatím bez měření</div>';
  const withData = sites.filter((s) => (s.clicks28 || 0) > 0).length;
  const clicksSum = sites.reduce((a, s) => a + (s.clicks28 || 0), 0);
  $('#searchMeta').textContent = `${withData}/${sites.length} S DATY · KLIKY 28D ${fmtNum(clicksSum)}`;
  setDot('p-search', sites.length ? (withData ? 'ok' : 'idle') : 'idle');
});

// ---------- INDEXACE (modul „indexace" — druhý řádek volitelných modulových
// panelů, sám v ř. 5, viz styles.css #p-index; pct v S.indexace.sites[].pct je
// zlomek 0–1). Stejná gating konvence jako sourozenci v ř. 4: panel se skryje/
// ukáže hned na vstupu podle S.modules.indexace, beze zapnutého modulu se dál
// nerenderuje. Klik na konkrétní řádek webu (data-id) otevře drawer rovnou
// zaostřený na jeho kartu — viz panel->drawer wiring v initPanels() níž. ----------
registerSection('index', ['indexace'], () => {
  const p = document.getElementById('p-index');
  if (p) p.hidden = !S.modules?.indexace;
  if (!S.modules?.indexace) return;
  const x = S.indexace || {};
  const C = '1fr 96px 100px 50px';
  let h = '';
  (x.sites || []).forEach((s, i) => {
    const pct = s.pct != null ? s.pct * 100 : null;
    const cls = pct != null && pct < 50 ? ' crit' : pct != null && pct < 75 ? ' warn' : '';
    h += row(i, C, `<span class="lbl" data-id="${esc(s.id)}">${esc(s.label)}</span><span class="bar${cls}"><i style="--w:${pct ?? 0}%"></i></span>
      <span class="num dim">${fmt(s.indexed)}<span class="unit">/${fmt(s.total)}</span></span>
      <span class="num"${pct != null && pct < 50 ? ' style="color:var(--crit)"' : pct != null && pct < 75 ? ' style="color:var(--warn)"' : ''}>${pct != null ? pct.toFixed(0) : '—'} %</span>`, 's26');
  });
  $('#indexBody').innerHTML = h || '<div class="pempty">měřím…</div>';
  $('#ixMeta').textContent = `${fmt(x.indexedUrls)}/${fmt(x.totalUrls)} URL · ${x.pct != null ? cz(x.pct * 100, 1) : '—'} %`;
  setDot('p-index', x.state);
});

// date_gmt z WP REST je 'YYYY-MM-DDTHH:MM:SS' BEZ 'Z' (ale je to UTC) — stejná
// explicitní UTC-parse pojistka jako server (modules/wpsched.js parseDateGmt),
// jen na klientu pro čitelné datum v panelu/draweru.
function wpDateMs(at) {
  if (!at) return null;
  const ms = Date.parse(String(at).endsWith('Z') ? at : `${at}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// ---------- WP PLÁNOVANÉ (modul „wpsched" — sdílí ř. 5 s INDEXACE, dělený na
// poloviny, viz styles.css #p-index/#p-wpsched). Stejná gating konvence jako
// sourozenci: panel se skryje/ukáže hned na vstupu podle S.modules.wpsched,
// beze zapnutého modulu se dál nerenderuje. Na rozdíl od INDEXACE je celý
// panel klikatelný (jen pár webů, žádné per-řádek fokusování dává smysl). ----------
registerSection('wpsched', ['wpsched'], () => {
  const p = document.getElementById('p-wpsched');
  if (p) p.hidden = !S.modules?.wpsched;
  if (!S.modules?.wpsched) return;
  const w = S.wpsched || {};
  const sites = w.sites || [];
  const C = '8px 1fr 60px minmax(0,120px)';
  let h = '';
  sites.forEach((s, i) => {
    const nStuck = (s.stuck || []).length;
    const led = !s.ok ? 'warn' : nStuck ? 'crit' : 'ok';
    const nextMs = s.next ? wpDateMs(s.next.at) : null;
    const info = !s.ok ? (s.err || 'chyba sondy')
      : nStuck ? `${nStuck} zaseknuto`
      : nextMs != null ? `další ${dmhm(nextMs)}` : 'nic v plánu';
    h += row(i, C, `<span class="led ${led}"></span><span class="lbl">${esc(s.label)}</span>
      <span class="num dim">${s.ok ? fmt(s.futureCount) : '—'}</span>
      <span class="num"${nStuck ? ' style="color:var(--crit)"' : ''}>${esc(info)}</span>`);
  });
  $('#wpschedBody').innerHTML = h || '<div class="pempty">měřím…</div>';
  const stuckTotal = sites.reduce((a, s) => a + (s.stuck || []).length, 0);
  $('#wpschedMeta').textContent = stuckTotal ? `${stuckTotal} ZASEKNUTO` : `${sites.filter((s) => s.ok).length}/${sites.length} OK`;
  setDot('p-wpsched', w.state);
});

// ---------- NANOCLAW (modul „nanoclaw" — třetí řádek volitelných modulových
// panelů, sám v ř. 6 na celou šířku, viz styles.css #p-nanoclaw). Read-only
// panel nad instalací NanoClaw na stejném boxu (jen čte její data/v2.db +
// systemd --user unit stav, viz modules/nanoclaw.js) — MC do ní nic
// nezapisuje, žádná akce. Stejná gating konvence jako sourozenci. ----------
registerSection('nanoclaw', ['nanoclaw'], () => {
  const p = document.getElementById('p-nanoclaw');
  if (p) p.hidden = !S.modules?.nanoclaw;
  if (!S.modules?.nanoclaw) return;
  const n = S.nanoclaw || {};
  const agents = n.agents || [];
  const C = '8px 1fr 70px minmax(0,120px)';
  let h = '';
  agents.forEach((a, i) => {
    const led = (a.running || 0) > 0 ? 'ok' : 'idle';
    h += row(i, C, `<span class="led ${led}"></span><span class="lbl">${esc(a.name)}</span>
      <span class="num dim">${a.running}/${a.sessions}</span>
      <span class="num">${a.lastActive ? rel(new Date(a.lastActive).toISOString()) : 'nikdy'}</span>`);
  });
  $('#nanoclawBody').innerHTML = h || '<div class="pempty">žádní agenti — instalace nenalezena nebo prázdná</div>';
  const runTotal = agents.reduce((a, x) => a + (x.running || 0), 0);
  const unitTxt = n.unit ? (n.unit.active === 'active' ? 'BĚŽÍ' : `UNIT ${String(n.unit.active || '?').toUpperCase()}`) : 'UNIT NENALEZENA';
  $('#nanoclawMeta').textContent = agents.length ? `${runTotal}/${agents.length} BĚŽÍ · ${unitTxt}` : unitTxt;
  setDot('p-nanoclaw', n.state);
});

// ---------- HLÍDAČ (modul „watchdog" — sdílí ř. 6 s NANOCLAW, viz styles.css
// #p-nanoclaw/#p-watchdog). MC sem jen ČTE data/watchdog-history.jsonl +
// data/narrative/*.log (modules/watchdog.js) — spouštění headless Claude
// hlídače dělá vnější cron (watchdog/run-watchdog.sh, viz INSTALL.md), ne
// tenhle proces. Řádek per projekt = poslední narativní řádek (parsovaný na
// čas+text), panel meta = poslední běh hlídače (overall/čas/počty). ----------
function narrLast(lines) {
  const l = (lines || [])[(lines || []).length - 1];
  if (!l) return null;
  const m = String(l).match(/^\[([^\]]+)\]\s*(.*)$/);
  return m ? { ts: m[1], text: m[2] } : { ts: '', text: String(l) };
}
const WD_OVERALL_LABEL = { ok: 'OK', fixed: 'OPRAVENO', alert: 'ALERT' };
registerSection('watchdog', ['watchdog'], () => {
  const p = document.getElementById('p-watchdog');
  if (p) p.hidden = !S.modules?.watchdog;
  if (!S.modules?.watchdog) return;
  const w = S.watchdog || {};
  const projects = w.projects || [];
  const C2 = '8px 1fr minmax(0,150px) 54px';
  let h = '';
  projects.forEach((pr, i) => {
    const n = narrLast(pr.narrative);
    const led = !n ? 'idle' : /🔴|❌/.test(n.text) ? 'crit' : /⚠/.test(n.text) ? 'warn' : 'ok';
    h += row(i, C2, `<span class="led ${led}"></span><span class="lbl">${esc(pr.label)}</span>
      <span class="num dim">${n ? esc(n.text.slice(0, 34)) : 'zatím bez záznamu'}</span>
      <span class="num">${n && n.ts ? esc(n.ts.slice(11)) : '—'}</span>`);
  });
  $('#watchdogBody').innerHTML = h || '<div class="pempty">v configu není nastaven žádný projekt (modules.watchdog.projects)</div>';
  const last = w.last;
  const cnt = last ? `${(last.actions || []).length} akcí · ${(last.alerts || []).length} alertů` : 'zatím žádný běh';
  const overallTxt = last ? `${WD_OVERALL_LABEL[last.overall] || String(last.overall || '?').toUpperCase()} · ` : '';
  $('#watchdogMeta').textContent = `${overallTxt}${cnt}`;
  setDot('p-watchdog', w.state);
});

// ---------- TERMINÁL (launcher; termProjects() žije v ui/term.js) ----------
function termStates() {
  // Jen reálné tmux terminály na socketu `mc` — to jsou ty připojitelné session.
  const st = {};
  const bump = (k, busy, wait) => { const o = st[k] || (st[k] = { n: 0, busy: 0, wait: 0 }); o.n++; if (busy) o.busy++; if (wait) o.wait++; };
  ((S.term || {}).sessions || []).forEach((s) => bump(s.key, s.work === 'working', s.work === 'waiting'));
  return st;
}
// Headless Claude práce MIMO tmux terminály (Jarvis brain, jeho subagenti, noční
// crony): živá session, která neběží v žádném `mc` paně (term === null). Dřív se
// chybně připočítávala k terminálům → panel ukazoval nafouknuté číslo.
function termBgCount() {
  return ((S.claude || {}).sessions || []).filter((c) => c.alive && !c.term).length;
}
registerSection('term', ['term', 'claude'], () => {
  const st = termStates();
  const C = '8px 1fr 52px';
  let h = '', tot = 0;
  termProjects().forEach((p, i) => {
    const o = st[p.key] || { n: 0, busy: 0, wait: 0 };
    tot += o.n;
    const led = o.busy ? 'run' : o.wait ? 'wait' : ''; // zelená pulsuje=pracuje · červená=čeká · šedá=spící
    const badge = o.n ? `<span class="num">${o.n}×</span>` : '<span class="tspustit">spustit</span>';
    h += row(i, C, `<span class="led ${led}"></span><span class="lbl" data-tkey="${esc(p.key)}">${esc(p.label)}</span>${badge}`, 's26');
  });
  $('#termBody').innerHTML = h;
  const bg = termBgCount();
  const plural = tot === 1 ? 'AKTIVNÍ' : (tot >= 5 || tot === 0) ? 'AKTIVNÍCH' : 'AKTIVNÍ';
  $('#tmMeta').textContent = `${tot} ${plural} · tmux mc${bg ? ` · ⚙ ${bg} na pozadí` : ''}`;
});

// mctProj <select> (formulář „+ ÚKOL") se plní stejnou termProjects() — musí čekat
// na první snapshot stejně jako launcher výš, deps prázdné stačí (statický seznam
// po celou dobu běhu klienta): registerSection ho zavolá i bez patch() při renderAll().
registerSection('mctProjOpts', [], () => {
  const mctProj = $('#mctProj');
  if (mctProj) mctProj.innerHTML = termProjects().map((p) => `<option value="${esc(p.key)}">${esc(p.label)}</option>`).join('');
});

// ---------- SLUŽBY · KONTEJNERY ----------
registerSection('srv', ['services', 'docker', 'tailscale'], () => {
  const svc = S.services || [];
  const docker = S.docker || [];
  const run = docker.filter((c) => c.running);
  const stopped = docker.filter((c) => !c.running);
  let L = `<div class="subhead">SYSTEMD · ${svc.filter((s) => s.active === 'active').length}/${svc.length}</div>`;
  svc.forEach((s, i) => {
    L += row(i, '8px 1fr 48px', `<span class="led ${s.state}"></span><span class="lbl" data-open="system">${esc(s.label)}</span><span class="num dim">${esc(s.active || '')}</span>`, 's26');
  });
  let R = `<div class="subhead">DOCKER · ${run.length}/${docker.length}</div>`;
  [...run, ...stopped].slice(0, 6).forEach((c, i) => {
    const cpu = c.cpu ? parseFloat(c.cpu) : null;
    const meta = c.running ? (cpu != null ? Math.round(cpu) + ' % CPU' : 'běží')
      : esc((c.status || 'exit').replace(/^Exited \(\d+\)\s*/, 'exit ')
        .replace(/(\d+) days? ago/, '$1 d').replace(/(\d+) hours? ago/, '$1 h')
        .replace(/(\d+) minutes? ago/, '$1 min').replace(/(\d+) weeks? ago/, '$1 týd'));
    R += row(i, '8px 1fr 64px', `<span class="led ${c.running ? (cpu > 90 ? 'warn' : 'ok') : ''}"></span>
      <span class="lbl">${esc(c.group || c.name)}</span><span class="num dim"${cpu > 90 ? ' style="color:var(--warn)"' : ''}>${meta}</span>`, 's26');
  });
  $('#srvBody').innerHTML = `<div class="col">${L}</div><div class="col">${R}</div>`;
  const peers = S.tailscale?.peers || [];
  $('#svMeta').textContent = `TAILNET ${peers.filter((p) => p.online).length}/${peers.length} ONLINE`;
  setDot('p-srv', svc.some((s) => s.state === 'crit') ? 'crit' : svc.some((s) => s.state === 'warn') ? 'warn' : 'ok');
});

// ---------- ⊞ NÁHLEDY chip (topbar vpravo) — počet registrovaných preview;
// jediný viditelný vstup do draweru NÁHLEDY mimo ⌘K paletu (klik drátuje initPanels)
registerSection('pvchip', ['previews'], () => {
  const n = (S.previews || []).length;
  $('#pvBtn').textContent = n ? `⊞ NÁHLEDY · ${n}` : '⊞ NÁHLEDY';
});

// ---------- ÚKOLY (FRONTA = MC úkoly z state.mctasks + SESSIONS = Claude Code) ----------
// FRONTA: uživatelské úkoly — spustitelné jako vlákno (▶, threads.js, klíč
// task:<id>) nebo terminál (⌨, tmux session se zadáním). Chipy stavů sdílí
// třídy .th-chip s alert vlákny. Nespuštěný queued = tlačítka, jinak chip.
const MCT_CHIP = {
  queued: { cls: 'queued', label: '⏸ fronta' },
  running: { cls: 'running', label: '● pracuje' },
  waiting: { cls: 'waiting', label: '❓ ČEKÁ' },
  done: { cls: 'done', label: '✓ hotovo' },
  error: { cls: 'error', label: '⚠ chyba' },
  aborted: { cls: 'aborted', label: '◼ zrušeno' },
};
const MCT_RANK = { waiting: 0, running: 1, queued: 2, error: 3, aborted: 4, done: 5 };
const prevMctWaiting = new Set(); // úkoly ve waiting (toast jen na NOVÉ, jako u alert vláken)
let mctFirstRender = true;
function mctChip(t) {
  if (t.status === 'queued' && t.mode === 'thread' && t.thread?.queuePos) {
    return `<span class="th-chip queued" data-mct="${esc(t.id)}">⏸ fronta č.${t.thread.queuePos}</span>`;
  }
  let st = MCT_CHIP[t.status] || { cls: '', label: t.status };
  // terminálový úkol: chip podle živého work-state session (zelená/červená LED logika)
  if (t.mode === 'term' && t.status === 'running' && t.termSession) {
    const sess = ((S.term || {}).sessions || []).find((x) => x.key === t.termSession.key && x.sid === t.termSession.sid);
    if (sess?.work === 'waiting') st = { cls: 'waiting', label: '❓ vstup' };
    else if (sess?.work !== 'working') st = { cls: 'running', label: '⌁ běží' };
  }
  const tip = t.thread?.lastLine || t.note || '';
  return `<span class="th-chip ${st.cls}" data-mct="${esc(t.id)}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(st.label)}</span>`;
}
function mctRow(t, i) {
  const projLabel = (termProjects().find((p) => p.key === t.project) || {}).label || t.project;
  const terminal = ['done', 'error', 'aborted'].includes(t.status);
  const unstarted = t.status === 'queued' && !t.mode;
  const led = t.status === 'waiting' ? 'warn' : t.status === 'running' ? 'run' : t.status === 'error' ? 'crit' : '';
  let act;
  if (unstarted) {
    act = `<span class="mct-act">
      <button class="btn bsm" data-mcta="thread" data-id="${esc(t.id)}" title="spustit jako headless vlákno (konzole, sdílená fronta s alert vlákny)">▶</button>
      <button class="btn bsm" data-mcta="term" data-id="${esc(t.id)}" title="spustit v terminálu (tmux session, zadání se vloží do Claude)">⌨</button>
      <button class="btn bsm" data-mcta="remove" data-id="${esc(t.id)}" title="odebrat z fronty">✕</button></span>`;
  } else {
    act = `<span class="mct-act">${mctChip(t)}${t.mode === 'term' && !terminal
      ? `<button class="btn bsm" data-mcta="done" data-id="${esc(t.id)}" title="označit hotovo (terminálová práce nemá strojový konec)">✓</button>` : ''}${terminal
      ? `<button class="btn bsm" data-mcta="remove" data-id="${esc(t.id)}" title="odebrat">✕</button>` : ''}</span>`;
  }
  const tip = `${projLabel}${t.detail ? ' — ' + t.detail.slice(0, 200) : ''}${t.note ? ' · ' + t.note : ''}`;
  return row(i, '9px 1fr auto', `<span class="led ${led}"></span><span class="lbl" data-mct="${esc(t.id)}" title="${esc(tip)}">${esc(t.subject)}</span>${act}`,
    's25' + (t.status === 'done' || t.status === 'aborted' ? ' mct-done' : ''));
}
registerSection('tasks', ['claude', 'term', 'mctasks'], () => {
  const mc = ((S.mctasks || {}).tasks || []);
  const mcs = [...mc].sort((a, b) => (MCT_RANK[a.status] ?? 9) - (MCT_RANK[b.status] ?? 9) || b.createdTs - a.createdTs);
  const mcOpen = mc.filter((t) => !['done', 'error', 'aborted'].includes(t.status)).length;
  let newWaiting = null;
  for (const t of mc) {
    if (t.status === 'waiting') {
      if (!prevMctWaiting.has(t.id)) { prevMctWaiting.add(t.id); if (!mctFirstRender) newWaiting = t; }
    } else prevMctWaiting.delete(t.id);
  }
  let h = `<div class="subhead">FRONTA · ${mcOpen}</div>`;
  const mcShow = mcs.slice(0, 5);
  if (!mcShow.length) h += '<div class="pempty">fronta je prázdná — „+ ÚKOL" nahoře zařadí práci pro Claude</div>';
  else mcShow.forEach((t, i) => { h += mctRow(t, i); });
  if (mcs.length > mcShow.length) h += `<div class="pempty">+${mcs.length - mcShow.length} dalších úkolů</div>`;

  // SESSIONS: původní read-only seznam úkolů z běžících Claude Code sessions
  const tasks = (S.claude || {}).tasks || [];
  const open = tasks.map((t, ti) => ({ t, ti })).filter((x) => x.t.status !== 'completed');
  const show = open.slice(0, 4);
  h += `<div class="subhead">SESSIONS · CLAUDE CODE</div>`;
  if (!show.length) h += '<div class="pempty">žádné úkoly v sessions</div>';
  show.forEach(({ t, ti }, i) => {
    const led = t.status === 'in_progress' ? 'info' : '';
    const txt = (t.status === 'in_progress' && t.activeForm) ? t.activeForm : t.subject;
    const proj = t.project || '';
    const sess = (t.termKey != null && t.termSid != null)
      ? ((S.term || {}).sessions || []).find((x) => x.key === t.termKey && x.sid === t.termSid) : null;
    const sessNm = sess ? (sess.label || '#' + sess.sid) : null;
    const chip = sessNm ? `⌁ ${sessNm.length > 16 ? sessNm.slice(0, 15) + '…' : sessNm}` : proj;
    const tip = sessNm ? `session ${sessNm}${proj ? ' · ' + proj : ''}` : proj;
    h += row(i, '9px 1fr auto', `<span class="led ${led}"></span><span class="lbl" data-ti="${ti}">${esc(txt)}</span>
     <span class="chip" title="${esc(tip)}">${esc(chip)}</span>`, 's25');
  });
  const restN = open.length - show.length;
  const ip = tasks.filter((t) => t.status === 'in_progress').length;
  h += `<div class="foot"><span>${restN > 0 ? `+${restN} dalších v sessions` : ''}</span><span>${ip} v běhu · ${open.length} otevřených</span></div>`;
  $('#tasksBody').innerHTML = h;
  const mcWait = (S.mctasks || {}).waiting || 0;
  $('#tkMeta').textContent = `FRONTA ${mcOpen}${mcWait ? ` · ❓ ${mcWait}` : ''} · CC ${open.length}`;
  setDot('p-tasks', mcWait ? 'warn' : mcOpen ? 'ok' : 'idle');
  if (newWaiting) {
    fx($('#p-tasks'));
    toast(`❓ Úkol čeká na tvou odpověď: ${newWaiting.subject}`, 'err');
    if (core) core.pulse(1);
  }
  mctFirstRender = false;
});



// ---------- LODNÍ DENÍK ----------
// (ticker chip label — samostatný od ui/timeline.js drawerové srcLabel(), ale
// stejná myšlenka: narrative.<id> je config-driven (watchdog projekty), takže
// label hledá v S.catalog.watchdogProjects místo natvrdo napsané tabulky.)
const LOG_SRC_LABEL = { cron: 'CRON', jarvis: 'JARVIS', alert: 'ALERT', action: 'AKCE', diagnosis: 'DIAG', thread: 'VLÁKNO', mctask: 'ÚKOL', uptime: 'UPTIME', watchdog: 'WATCH' };
function logSrcLabel(source) {
  if (LOG_SRC_LABEL[source]) return LOG_SRC_LABEL[source];
  if (source && source.startsWith('narrative.')) {
    const id = source.slice('narrative.'.length);
    const p = (S.catalog?.watchdogProjects || []).find((x) => x.id === id);
    return (p ? p.label : id).slice(0, 10).toUpperCase();
  }
  return String(source || '').toUpperCase();
}
registerSection('log', ['timeline'], () => {
  const ev = ((S.timeline || {}).recent || []).slice(0, 8);
  if (!ev.length) { $('#logBody').innerHTML = '<div class="pempty">deník je zatím prázdný</div>'; return; }
  const lg = (e, i) => `<div class="lg"${e.link ? ` data-link="${esc(e.link)}"` : ''} style="--ri:${i}"><span class="ts">${e.ts ? hm(e.ts) : ''}</span>
    <span class="led ${esc(e.severity || 'info')}"></span><span class="chip">${esc(logSrcLabel(e.source))}</span><span class="tx">${esc(String(e.text || '').split('\n')[0])}</span></div>`;
  $('#logBody').innerHTML = `<div class="col">${ev.slice(0, 4).map(lg).join('')}</div><div class="col">${ev.slice(4).map((e, i) => lg(e, i + 4)).join('')}</div>`;
  $('#lgMeta').textContent = `POSLEDNÍCH ${ev.length} ZÁZNAMŮ · NEJNOVĚJŠÍ ${ev[0]?.ts ? hm(ev[0].ts) : '—'}`;
});

// ---------- init + delegované listenery (stabilní mounty, 1× při startu) ----------
export function initPanels(coreApi) {
  core = coreApi;

  // SSE timeline event -> pulz jádra (datová vazba 2)
  bus.addEventListener('timeline', (e) => {
    const sev = { ok: 0, info: 0, warn: 1, crit: 2 }[e.detail?.severity] ?? 0;
    if (core) core.pulse(sev);
  });

  // panel -> drawer (WEBY->uptime, NÁVŠTĚVNOST->traffic, VYHLEDÁVÁNÍ->gsc, NÁKLADY->spend)
  const panelDrawer = (sel, id) => {
    const p = $(sel);
    if (!p) return;
    p.classList.add('click');
    p.addEventListener('click', () => openDrawer(id));
    p.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(id); } });
  };
  panelDrawer('#p-weby', 'uptime');
  panelDrawer('#p-traffic', 'traffic');
  panelDrawer('#p-search', 'gsc');
  panelDrawer('#p-wpsched', 'wpsched');
  panelDrawer('#p-nanoclaw', 'nanoclaw');
  panelDrawer('#p-watchdog', 'watchdog');

  // INDEXACE: klik na řádek webu -> drawer s fokusem na jeho kartu (jinak plný
  // panel-klik jako sourozenci výš, jen bez panelDrawer() — ten by přidal
  // .click/keyboard handling zbytečně, protože klikatelné jsou primárně řádky).
  $('#p-index').addEventListener('click', (e) => {
    const id = e.target.closest('.r')?.querySelector('[data-id]')?.dataset.id;
    openDrawer('indexace', id ? { focus: id } : undefined);
  });

  // ÚKOLY · FRONTA: formulář (statický sourozenec .pb — přežije SSE patche)
  const mctForm = $('#mctForm');
  const mctProj = $('#mctProj'); // options se plní v registerSection('mctProjOpts', …) výš — až po prvním snapshotu
  mctOpenForm = () => {
    mctForm.hidden = false;
    $('#p-tasks').scrollIntoView({ block: 'nearest' });
    $('#mctSubject').focus();
  };
  $('#mctAddBtn').addEventListener('click', () => { mctForm.hidden ? mctOpenForm() : (mctForm.hidden = true); });
  $('#mctCancel').addEventListener('click', () => { mctForm.hidden = true; });
  mctForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const subject = $('#mctSubject').value.trim();
    if (!subject) { toast('✕ zadej předmět úkolu', 'err'); $('#mctSubject').focus(); return; }
    const r = await postAction({
      type: 'mctask.add', subject,
      detail: $('#mctDetail').value.trim(),
      project: mctProj.value,
    }, $('#mctSubmit'));
    if (r?.ok) { $('#mctSubject').value = ''; $('#mctDetail').value = ''; mctForm.hidden = true; }
  });

  // ÚKOLY: delegace — FRONTA akce (▶ vlákno / ⌨ terminál / ✓ / ✕), klik na
  // běžící úkol -> drawer dle režimu; SESSIONS řádky -> detail úkolu (data-ti)
  $('#tasksBody').addEventListener('click', async (e) => {
    const ab = e.target.closest('[data-mcta]');
    if (ab) {
      e.stopPropagation();
      const id = ab.dataset.id, act = ab.dataset.mcta;
      if (act === 'thread' || act === 'term') {
        const r = await postAction({ type: 'mctask.start', id, mode: act }, ab);
        if (r?.ok) {
          const t = ((S.mctasks || {}).tasks || []).find((x) => x.id === id);
          if (act === 'thread') openThreadDrawer(r.key || `task:${id}`, `ÚKOL — ${t?.subject || id}`);
          else if (r.session) {
            const p = termProjects().find((x) => x.key === r.session.key);
            openTermDrawer(r.session.key, p?.label || r.session.key, r.session.sid);
          }
        }
      } else if (act === 'remove') postAction({ type: 'mctask.remove', id }, ab, { confirm: 'Odebrat úkol z fronty?' });
      else if (act === 'done') postAction({ type: 'mctask.done', id }, ab);
      return;
    }
    const mid = e.target.closest('.r')?.querySelector('[data-mct]')?.dataset.mct;
    if (mid != null) {
      const t = ((S.mctasks || {}).tasks || []).find((x) => x.id === mid);
      if (!t || (!t.mode && t.status === 'queued')) return; // nespuštěný — akce mají tlačítka
      if (t.mode === 'thread' && t.threadKey) openThreadDrawer(t.threadKey, `ÚKOL — ${t.subject}`);
      else if (t.mode === 'term' && t.termSession) {
        const p = termProjects().find((x) => x.key === t.termSession.key);
        openTermDrawer(t.termSession.key, p?.label || t.termSession.key, t.termSession.sid);
      }
      return;
    }
    const ti = e.target.closest('.r')?.querySelector('[data-ti]')?.dataset.ti;
    if (ti != null) openDrawer('task', { i: Number(ti) });
  });

  // SLUŽBY · KONTEJNERY: systemd -> system/nanoclaw, docker -> nanoclaw/v1
  $('#srvBody').addEventListener('click', (e) => {
    const id = e.target.closest('.r')?.querySelector('[data-open]')?.dataset.open;
    if (id) openDrawer(id);
  });

  // ⊞ NÁHLEDY chip v topbaru -> drawer s registrovanými preview
  $('#pvBtn').addEventListener('click', () => openDrawer('previews'));

  // VÝSTRAHY: delegovaná tlačítka (skrýt / vlákno start+open / detail);
  // klik na řádek výstrahy s existujícím vláknem otevírá jeho drawer
  $('#alertsBody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) {
      const row = e.target.closest('.alert');
      if (!row) return;
      const chip = row.querySelector('[data-act="th-open"]');
      if (chip) openThreadDrawer(chip.dataset.key);
      return;
    }
    e.stopPropagation();
    const act = b.dataset.act;
    // ✕ skrýt do vyřešení — server vrací chybu, když nad výstrahou běží vlákno
    if (act === 'silence') postAction({ type: 'alert.silence', key: b.dataset.key }, b);
    else if (act === 'th-open') openThreadDrawer(b.dataset.key);
    else if (act === 'th-start') {
      // ◆ startuje interaktivní vlákno (nahrazuje one-shot diagnózu v UI;
      // automatická crit diagnóza na serveru běží dál beze změny)
      b.disabled = true; const old = b.textContent; b.textContent = '…';
      try {
        const r = await fetch('/api/alert/thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: b.dataset.key }) });
        const j = await r.json();
        if (j.ok) openThreadDrawer(b.dataset.key);
        else toast('✕ ' + (j.error || 'chyba'), 'err');
      } catch (err) { toast('✕ ' + err.message, 'err'); }
      finally { b.disabled = false; b.textContent = old; }
    } else if (act === 'open') {
      if (!openDrawer(b.dataset.link)) toast(`Detail „${b.dataset.link}" zatím nemá drawer`);
    }
  });

  // TERMINÁL launcher: klik -> terminálový drawer projektu (ttyd attach)
  $('#termBody').addEventListener('click', (e) => {
    const r = e.target.closest('.r');
    if (!r) return;
    const key = r.querySelector('[data-tkey]')?.dataset.tkey;
    const p = termProjects().find((x) => x.key === key);
    if (p) openTermDrawer(p.key, p.label);
  });

  // LODNÍ DENÍK strip: řádek s linkem -> jeho drawer, jinde -> plný deník
  $('#p-log').addEventListener('click', (e) => {
    const link = e.target.closest('.lg')?.dataset.link;
    if (link && openDrawer(link)) return;
    openDrawer('timeline');
  });

  // topbar: pill -> lodní deník (při aktivních výstrahách filtr VÝSTRAHY),
  // ⌘K paletu si drátuje ui/palette.js, ⟲ BOOT -> replay
  const pillOpen = () => openDrawer('timeline', (S.alerts?.active || []).length ? { filter: 'db' } : undefined);
  $('#pill').addEventListener('click', pillOpen);
  $('#pill').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pillOpen(); } });
  $('#bootBtn').addEventListener('click', (e) => { e.stopPropagation(); replayBoot(); });
}
