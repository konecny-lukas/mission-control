/* MC v2 — DOM helpers + formátery (porty z public/app.js, české konvence:
   desetinná čárka, tisíce úzkou mezerou; USD zůstává en-US). */

export const $ = (s) => document.querySelector(s);

export const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

export const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- čísla ----------
export const TS = ' '; // thin space (U+2009) pro tisíce

// celé číslo s úzkou mezerou: 4 908
export const fmt = (n) => (n == null ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, TS));

// české desetinné číslo: 96,7 (desetinná čárka, tisíce úzká mezera)
export function cz(n, d = 0) {
  if (n == null || !isFinite(+n)) return '—';
  const s = (+n).toFixed(d).split('.');
  s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, TS);
  return s.join(',');
}

// locale formát z public/app.js (toLocaleString cs)
export const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('cs'));

// procenta uptime: 100 % / 99,51 %
export function fmtPct(p) {
  if (p == null) return '—';
  if (p >= 99.995) return '100 %';
  return `${cz(p, 2)} %`;
}

// USD en-US: $1,639.07 (adaptivní přesnost jako v public/app.js; d vynutí počet
// desetinných míst — např. usd(n, 0) pro týdenní hero)
export function usd(n, d = null) {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (n < 0.01 && n > 0 && d == null) return `$${n.toFixed(4)}`;
  const neg = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const dd = d != null ? d : (a < 10 ? 3 : 2);
  const s = a.toFixed(dd).split('.');
  s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg}$${s.join('.')}`;
}

// ---------- čas ----------
export function rel(iso) {
  if (!iso) return '—';
  const d = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!d) return '—';
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 0) {
    const a = -s;
    if (a < 90) return `za ${a}s`;
    if (a < 5400) return `za ${Math.round(a / 60)} min`;
    if (a < 172800) return `za ${Math.round(a / 3600)} h`;
    return `za ${Math.round(a / 86400)} d`;
  }
  if (s < 60) return `před ${s}s`;
  if (s < 5400) return `před ${Math.round(s / 60)} min`;
  if (s < 172800) return `před ${Math.round(s / 3600)} h`;
  return `před ${Math.round(s / 86400)} d`;
}

export function dur(sec) {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const p2 = (n) => String(n).padStart(2, '0');
// epoch ms -> HH:MM / HH:MM:SS / DD.MM. HH:MM (Europe/Prague je lokální TZ VPS i uživatele)
export const hm = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
export const hms = (ms) => { const d = new Date(ms); return `${hm(ms)}:${p2(d.getSeconds())}`; };
export const dmhm = (ms) => { const d = new Date(ms); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}. ${hm(ms)}`; };

// ---------- jednotky ----------
// propustnost: B/s -> adaptivní B/s · kB/s · MB/s
export function fmtRate(bps) {
  if (bps == null) return '…';
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1048576) return `${cz(bps / 1024, bps < 10240 ? 1 : 0)} kB/s`;
  return `${cz(bps / 1048576, bps < 10485760 ? 2 : 1)} MB/s`;
}

// kumulativní přenos: bytes -> kB · MB · GB
export function fmtBytes(b) {
  if (b == null) return '…';
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1048576) return `${cz(b / 1024, 0)} kB`;
  if (b < 1073741824) return `${cz(b / 1048576, 1)} MB`;
  return `${cz(b / 1073741824, 2)} GB`;
}

export const GB = (b) => b / 1073741824;

// ---------- glitch helper ----------
// Jedna sdílená CSS animace (.glitch-in), globální throttle 1 glitch / 2 s.
// Nikdy na hover/value-update — jen drawer open, eskalace stavu, nová výstraha.
let lastGlitch = 0;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
export function fx(target) {
  if (reduced || !target) return;
  const now = Date.now();
  if (now - lastGlitch < 2000) return;
  lastGlitch = now;
  target.classList.remove('glitch-in');
  void target.offsetWidth;
  target.classList.add('glitch-in');
  setTimeout(() => target.classList.remove('glitch-in'), 600);
}

// ---------- toast ----------
let toastTimer = 0;
export function toast(msg, type = 'info') {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.dataset.type = type;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
