// Mission Control — preview registry + server.
// Serves the things Claude builds on the VPS under /preview/<slug>/, sharing this
// process's tailnet origin (no extra Tailscale serve mounts, no firewall change).
//
// Two kinds:
//   static  — files served from an absolute dir on disk. HTML gets a <base> tag
//             injected so relative URLs resolve under the subpath.
//   proxy   — reverse-proxy to a loopback port (dev servers, incl. WebSocket/HMR).
//             The full /preview/<slug> path is forwarded as-is, so the upstream
//             must serve under that base (e.g. `vite --base=/preview/<slug>/`).
//             Pass strip:true for root-serving apps to drop the prefix instead.
//
// The registry is mutated ONLY by the `mc-preview` CLI — there is no HTTP endpoint
// that can register an arbitrary dir/port. The UI can only list, open and remove.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import * as C from './config.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};

export function loadRegistry() {
  try {
    const arr = JSON.parse(fs.readFileSync(C.PREVIEWS_FILE, 'utf-8'));
    return Array.isArray(arr) ? arr.filter((p) => p && SLUG_RE.test(p.slug)) : [];
  } catch {
    return [];
  }
}

export function saveRegistry(list) {
  fs.mkdirSync(path.dirname(C.PREVIEWS_FILE), { recursive: true });
  fs.writeFileSync(C.PREVIEWS_FILE, JSON.stringify(list, null, 2) + '\n');
}

const find = (slug) => loadRegistry().find((p) => p.slug === slug);

// Snapshot for the UI — never leaks the on-disk dir, just what the HUD shows.
export function listPreviews() {
  return loadRegistry()
    .map((p) => ({
      slug: p.slug,
      title: p.title || p.slug,
      type: p.type,
      port: p.type === 'proxy' ? p.port : undefined,
      created: p.created || null,
      note: p.note || '',
      url: `/preview/${p.slug}/`,
    }))
    .sort((a, b) => String(b.created || '').localeCompare(String(a.created || ''))); // newest first
}

// Remove by slug (called from the allowlisted preview.remove action).
export function removePreview(slug) {
  if (!SLUG_RE.test(String(slug || ''))) return { ok: false, error: 'neplatný slug' };
  const list = loadRegistry();
  const idx = list.findIndex((p) => p.slug === slug);
  if (idx < 0) return { ok: false, error: 'náhled neexistuje' };
  const [gone] = list.splice(idx, 1);
  saveRegistry(list);
  return { ok: true, action: `odebrán náhled „${gone.title || slug}"` };
}

// ---- HTML <base> injection (static only) so relative URLs work under the subpath ----
function injectBase(html, base) {
  if (/<base\b/i.test(html)) return html; // author already set one — respect it
  const tag = `<base href="${base}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + tag);
  return tag + html;
}

function errPage(code, msg) {
  return `<!doctype html><meta charset="utf-8"><title>náhled</title>` +
    `<body style="font-family:system-ui;background:#02060c;color:#cfeaff;display:grid;place-items:center;height:100vh;margin:0">` +
    `<div style="text-align:center"><div style="font-size:42px;opacity:.5">▣</div>` +
    `<h1 style="font-weight:600;letter-spacing:.04em">${code}</h1><p style="color:#5f86a3">${msg}</p></div></body>`;
}

// ---- static dir serving ----
function serveStaticPreview(req, res, p, rest) {
  const root = path.resolve(p.dir);
  let rel = decodeURIComponent(rest || '/').split('?')[0];
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.normalize(path.join(root, rel));
  if (full !== root && !full.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(errPage('404', `soubor nenalezen v náhledu „${p.slug}"`));
    }
    const ext = path.extname(full).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    let out = data;
    if (ext === '.html' || ext === '.htm') out = Buffer.from(injectBase(data.toString('utf-8'), `/preview/${p.slug}/`));
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
    res.end(out);
  });
}

// ---- reverse-proxy to a loopback dev server ----
// no strip → forward the whole /preview/<slug>/... path (app serves under base).
// strip    → drop the /preview/<slug> prefix (app serves at root).
function upstreamPath(p, url) {
  if (!p.strip) return url;
  const stripped = url.replace(new RegExp(`^/preview/${p.slug}(?=/|$)`), '');
  return stripped || '/';
}

function proxyPreview(req, res, p) {
  const pr = http.request(
    { host: '127.0.0.1', port: p.port, path: upstreamPath(p, req.url), method: req.method, headers: req.headers },
    (pres) => { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); },
  );
  pr.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(errPage('502', `náhled „${p.slug}" je offline (port ${p.port} neodpovídá)`));
  });
  req.pipe(pr);
}

// ---- main HTTP entry: handle /preview and /preview/<slug>/... ----
export function handlePreview(req, res, url) {
  // bare /preview → bounce to the HUD (no index of previews is exposed here)
  if (url === '/preview' || url === '/preview/') { res.writeHead(302, { Location: '/' }); return res.end(); }
  const m = url.match(/^\/preview\/([^/]+)(\/.*)?$/);
  if (!m) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
  const slug = decodeURIComponent(m[1]);
  if (!SLUG_RE.test(slug)) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('bad slug'); }
  // /preview/<slug> → /preview/<slug>/ so <base> and relative URLs resolve
  if (!m[2]) { res.writeHead(302, { Location: `/preview/${slug}/` }); return res.end(); }
  const p = find(slug);
  if (!p) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(errPage('404', `náhled „${slug}" neexistuje`)); }
  if (p.type === 'proxy') return proxyPreview(req, res, p);
  return serveStaticPreview(req, res, p, m[2]);
}

// ---- WebSocket upgrade (proxy previews only — e.g. Vite HMR) ----
// Returns true if the request was for /preview (handled or rejected here).
export function handlePreviewUpgrade(req, socket, head) {
  const m = req.url.match(/^\/preview\/([^/?]+)/);
  if (!m) { socket.destroy(); return false; }
  const p = find(decodeURIComponent(m[1]));
  if (!p || p.type !== 'proxy') { socket.destroy(); return true; }
  const up = net.connect(p.port, '127.0.0.1', () => {
    let raw = `${req.method} ${upstreamPath(p, req.url)} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    raw += '\r\n';
    up.write(raw);
    if (head && head.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  return true;
}
