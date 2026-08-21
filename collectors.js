// Mission Control — data collectors.
// Běží jako neprivilegovaný uživatel (typicky bez sudo). Každý collector je
// defenzivní: chyba se zachytí a vrátí degraded stav, nikdy nevyhodí — jeden
// rozbitý zdroj nesmí zhasnout celý dashboard.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import * as C from './config.js';
import * as termLabels from './term-labels.js';

// ---------- low-level helpers ----------
export function run(cmd, args, { timeout = 6000, cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '', err: err ? String(err.message || err) : null });
    });
  });
}

function readTail(file, maxBytes = 16384) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

// Hodinový lidský narativ (watchdog modul, volitelný — viz MODULES.watchdog),
// psaný hodinovým cron-watchdog agentem do data/narrative/<id>.log — řádky
// „[YYYY-MM-DD HH:MM] emoji text", jeden řádek = jeden běh hlídače. Chybějící/
// nečitelný soubor jen znamená „zatím žádný narativ", nikdy nevyhodí (stejná
// defenzivní kostra jako readTail výš).
export function readNarrative(id, n = 14) {
  const tail = readTail(path.join(C.NARRATIVE_DIR, `${id}.log`), 12288);
  const lines = tail.split('\n').filter((l) => l.trim());
  return lines.slice(-n);
}

// worst state wins
const ORDER = { crit: 3, warn: 2, idle: 1, paused: 1, ok: 0, unknown: 0 };
export function worst(...states) {
  return states.reduce((a, b) => (ORDER[b] > ORDER[a] ? b : a), 'ok');
}

// ---------- CPU% (delta between refreshes) ----------
let prevCpu = null;
function cpuPercent() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf-8').split('\n')[0];
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = v[3] + (v[4] || 0);
    const total = v.reduce((a, b) => a + b, 0);
    let pct = 0;
    if (prevCpu) {
      const dIdle = idle - prevCpu.idle;
      const dTotal = total - prevCpu.total;
      pct = dTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100))) : 0;
    }
    prevCpu = { idle, total };
    return pct;
  } catch {
    return 0;
  }
}

// ---------- network throughput (delta between refreshes) ----------
let prevNet = null;
function netRate() {
  try {
    let rx = 0, tx = 0;
    for (const ln of fs.readFileSync('/proc/net/dev', 'utf-8').split('\n')) {
      const m = ln.match(/^\s*([^:]+):\s*(.*)$/);
      if (!m) continue;
      if (/^(lo|docker|veth|br-|tailscale|wg|virbr|cni|flannel|kube|tun)/.test(m[1].trim())) continue;
      const f = m[2].trim().split(/\s+/).map(Number);
      rx += f[0] || 0; tx += f[8] || 0;
    }
    const now = Date.now();
    let rxRate = null, txRate = null;
    if (prevNet) {
      const dt = (now - prevNet.ts) / 1000;
      if (dt > 0) { rxRate = Math.max(0, (rx - prevNet.rx) / dt); txRate = Math.max(0, (tx - prevNet.tx) / dt); }
    }
    prevNet = { ts: now, rx, tx };
    return { rxRate, txRate, rxTotal: rx, txTotal: tx };
  } catch {
    return { rxRate: null, txRate: null, rxTotal: null, txTotal: null };
  }
}

// ---------- system ----------
export async function collectSystem() {
  const out = { state: 'ok', cores: os.cpus().length };
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf-8');
    const total = Number(mi.match(/MemTotal:\s+(\d+)/)?.[1] || 0) * 1024;
    const avail = Number(mi.match(/MemAvailable:\s+(\d+)/)?.[1] || 0) * 1024;
    const swapTotal = Number(mi.match(/SwapTotal:\s+(\d+)/)?.[1] || 0) * 1024;
    const swapFree = Number(mi.match(/SwapFree:\s+(\d+)/)?.[1] || 0) * 1024;
    out.mem = {
      totalB: total, usedB: total - avail, usedPct: total ? Math.round(((total - avail) / total) * 100) : 0,
      swapTotalB: swapTotal, swapUsedB: swapTotal - swapFree,
      swapUsedPct: swapTotal ? Math.round(((swapTotal - swapFree) / swapTotal) * 100) : 0,
    };
  } catch { out.mem = null; }
  try {
    const la = fs.readFileSync('/proc/loadavg', 'utf-8').trim().split(/\s+/);
    out.load = [Number(la[0]), Number(la[1]), Number(la[2])];
  } catch { out.load = [0, 0, 0]; }
  try {
    const up = Number(fs.readFileSync('/proc/uptime', 'utf-8').split(' ')[0]);
    out.uptimeSec = Math.floor(up);
  } catch { out.uptimeSec = 0; }
  out.cpuPct = cpuPercent();
  out.net = netRate();

  out.disks = [];
  try {
    const df = await run('df', ['-B1', '--output=size,used,fstype,target']);
    for (const ln of df.stdout.trim().split('\n').slice(1)) {
      const p = ln.trim().split(/\s+/);
      if (p.length < 4) continue;
      const size = Number(p[0]); const used = Number(p[1]); const fstype = p[2];
      const target = p.slice(3).join(' ');
      if (!/^(ext4|ext3|xfs|btrfs|zfs)$/.test(fstype)) continue;
      if (target !== '/' && !target.startsWith('/mnt/')) continue;
      const volName = target.replace('/mnt/', '');
      out.disks.push({
        mount: target,
        label: target === '/' ? 'Systém (/)' : (/^HC_Volume_\d+$/.test(volName) ? 'SSD volume' : volName),
        totalB: size, usedB: used, usedPct: size ? Math.round((used / size) * 100) : 0,
      });
    }
  } catch { /* out.disks zůstane prázdné */ }
  const rootDisk = out.disks.find((d) => d.mount === '/') || null;
  out.disk = rootDisk ? { totalB: rootDisk.totalB, usedB: rootDisk.usedB, usedPct: rootDisk.usedPct } : null;

  out.state = worst(
    out.mem && out.mem.usedPct >= 92 ? 'crit' : out.mem && out.mem.usedPct >= 82 ? 'warn' : 'ok',
    out.mem && out.mem.swapUsedPct >= 80 ? 'warn' : 'ok',
    ...out.disks.map((d) => (d.usedPct >= 92 ? 'crit' : d.usedPct >= 82 ? 'warn' : 'ok')),
    out.load[0] > out.cores * 2 ? 'warn' : 'ok',
  );
  return out;
}

// ---------- services ----------
// is-active funguje i pro SYSTEM jednotky bez sudo (čistě čtení).
async function svcActive(name, user = true) {
  const args = user ? ['--user', 'is-active', name] : ['is-active', name];
  const r = await run('systemctl', args, { timeout: 4000 });
  return r.stdout.trim() || (r.ok ? 'active' : 'inactive');
}
export async function collectServices() {
  // Sledujeme MC user služby + pár reálně běžících systémových — POKUD
  // mc.config.json nemá klíč "services" (C.SERVICES_CFG === null). Je-li
  // klíč přítomný (i jako prázdné pole), přebírá se 1:1 — uživatel má plnou
  // kontrolu nad tím, co se hlídá (viz config.js SERVICES_CFG).
  const defs = C.SERVICES_CFG
    ? C.SERVICES_CFG.map((s) => ({ name: s.unit, label: s.label || s.unit, user: s.scope !== 'system' }))
    : [
        { name: 'mission-control', label: 'Mission Control', user: true },
        { name: 'mc-ttyd', label: 'Terminály (ttyd)', user: true },
        { name: 'tailscaled', label: 'Tailscale', user: false },
        { name: 'fail2ban', label: 'fail2ban', user: false },
      ];
  const res = await Promise.all(defs.map(async (d) => {
    const st = await svcActive(d.name, d.user);
    return { ...d, active: st, state: st === 'active' ? 'ok' : st === 'activating' ? 'warn' : 'crit' };
  }));
  return res;
}

// ---------- tailscale ----------
export async function collectTailscale() {
  const r = await run('tailscale', ['status', '--json'], { timeout: 5000 });
  try {
    const j = JSON.parse(r.stdout);
    const peers = Object.values(j.Peer || {});
    return {
      state: j.BackendState === 'Running' ? 'ok' : 'warn',
      backend: j.BackendState,
      self: j.Self?.DNSName?.replace(/\.$/, '') || C.HOSTNAME,
      tailnet: j.CurrentTailnet?.Name || j.MagicDNSSuffix || null,
      magicDNSSuffix: j.MagicDNSSuffix || null,
      peers: peers.map((p) => ({ name: p.HostName, os: p.OS, online: !!p.Online })),
      peersOnline: peers.filter((p) => p.Online).length,
      peersTotal: peers.length,
    };
  } catch {
    return { state: 'warn', backend: 'unknown', peers: [], peersOnline: 0, peersTotal: 0 };
  }
}

// ---------- docker (přímo, bez mezikroku) ----------
// Vyžaduje, aby uživatel MC mohl volat `docker ps` (typicky členství v docker
// group). Chybí-li binárka/oprávnění, vrátí null — panel SLUŽBY se nevykreslí
// (S.docker || [] v panels.js), zbytek dashboardu jede dál.
export function collectDocker() {
  try {
    const out = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}'],
      { timeout: 4000, encoding: 'utf-8' });
    return out.trim().split('\n').filter(Boolean).map((line) => {
      const [name, status, image] = line.split('\t');
      return { name, group: null, image: image || null, status, running: /^Up/.test(status), cpu: null, mem: null };
    });
  } catch { return null; }
}

// ---------- claude code sessions (generické) ----------
function termPaneMap() {
  const map = {}; // panePid -> { key, sid }
  try {
    const outp = execFileSync(C.TERM_TMUX_BIN,
      ['-L', C.TERM_TMUX_SOCKET, 'list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'],
      { timeout: 1500, encoding: 'utf-8', env: { ...process.env, HOME: C.HOME } });
    for (const line of outp.split('\n')) {
      const [nm, pid] = line.split('\t');
      if (!nm || !nm.startsWith(C.TERM_SESSION_PREFIX) || !Number(pid)) continue;
      const rest = nm.slice(C.TERM_SESSION_PREFIX.length);
      const dash = rest.lastIndexOf('-');
      let key = rest, sid = null;
      if (dash > 0 && /^\d+$/.test(rest.slice(dash + 1))) { key = rest.slice(0, dash); sid = Number(rest.slice(dash + 1)); }
      if (!C.TERM_KEYS.includes(key)) continue;
      map[Number(pid)] = { key, sid };
    }
  } catch { /* tmux server not running -> no terminals */ }
  return map;
}
function termOfPid(pid, paneMap) {
  let p = Number(pid);
  for (let i = 0; i < 12 && p > 1; i++) {
    if (paneMap[p]) return paneMap[p];
    try {
      const st = fs.readFileSync(`/proc/${p}/stat`, 'utf-8');
      p = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { return null; }
  }
  return null;
}

export function collectClaude() {
  const out = { state: 'ok', recent: [], sessions: [], openTasks: 0, tasks: [] };
  const sessCwd = {};
  const sessTerm = {};
  const paneMap = termPaneMap();
  const liveSessions = new Set();
  const FRESH_MS = 12 * 3600 * 1000;
  try {
    const tail = readTail(`${C.CLAUDE_DIR}/history.jsonl`, 24000);
    const entries = tail.split('\n').filter(Boolean).slice(-12).map((l) => {
      try { const j = JSON.parse(l); return { display: (j.display || '').slice(0, 80), ts: j.timestamp || null, project: j.project || j.cwd || null }; } catch { return null; }
    }).filter(Boolean).reverse();
    out.recent = entries.slice(0, 8);
  } catch { /* skip */ }
  try {
    const dir = `${C.CLAUDE_DIR}/sessions`;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        if (j.sessionId) {
          sessCwd[j.sessionId] = j.cwd || null;
          let alive = false; if (j.pid) { try { process.kill(j.pid, 0); alive = true; } catch { /* dead */ } }
          const upd = j.updatedAt ? (typeof j.updatedAt === 'number' ? j.updatedAt : Date.parse(j.updatedAt)) : 0;
          if (alive || (Date.now() - upd) < FRESH_MS) liveSessions.add(j.sessionId);
          if (alive) sessTerm[j.sessionId] = termOfPid(j.pid, paneMap);
        }
        out.sessions.push({ id: (j.sessionId || f).slice(0, 12), status: j.status || 'unknown', cwd: j.cwd || null, updatedAt: j.updatedAt || null, alive, term: sessTerm[j.sessionId] || null });
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  try {
    const base = `${C.CLAUDE_DIR}/tasks`;
    for (const uuid of fs.readdirSync(base)) {
      const tdir = path.join(base, uuid);
      let st; try { st = fs.statSync(tdir); } catch { continue; }
      if (!st.isDirectory()) continue;
      let mtime = 0; try { mtime = fs.statSync(tdir).mtimeMs; } catch { /* skip */ }
      if ((Date.now() - mtime) >= FRESH_MS && !liveSessions.has(uuid)) continue;
      const cwd = sessCwd[uuid] || null;
      const project = cwd ? cwd.split('/').filter(Boolean).pop() : null;
      const term = sessTerm[uuid] || null;
      for (const f of fs.readdirSync(tdir)) {
        if (!/^\d+\.json$/.test(f)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(tdir, f), 'utf-8'));
          if (j.status && j.status !== 'completed') out.openTasks++;
          out.tasks.push({
            subject: (j.subject || '').slice(0, 120),
            status: j.status || 'pending',
            activeForm: (j.activeForm || '').slice(0, 120),
            description: (j.description || '').slice(0, 700),
            blockedBy: Array.isArray(j.blockedBy) ? j.blockedBy : [],
            blocks: Array.isArray(j.blocks) ? j.blocks : [],
            group: uuid.slice(0, 8), project, mtime,
            termKey: term ? term.key : null, termSid: term ? term.sid : null,
          });
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  const rank = { in_progress: 0, pending: 1, completed: 2 };
  out.tasks.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || b.mtime - a.mtime);
  out.tasks = out.tasks.slice(0, 40);
  return out;
}

// ---------- persistent terminal sessions ----------
const TERM_MENU_RE = /❯\s+\d+\.\s/;
const TERM_ASK_RE = /Would you like to proceed|Do you want to |\(y\/n\)|\[y\/n\]|Press Enter to continue/i;
const TERM_IDLE_FOOTER_RE = /bypass permissions on\b/i;
function classifyTermWork(text) {
  if (!text) return 'dormant';
  const menu = TERM_MENU_RE.test(text) || TERM_ASK_RE.test(text);
  if (menu && !TERM_IDLE_FOOTER_RE.test(text)) return 'waiting';
  if (/esc to interrupt/i.test(text)) return 'working';
  return 'dormant';
}

export async function collectTermSessions() {
  const r = await run(C.TERM_TMUX_BIN, ['-L', C.TERM_TMUX_SOCKET, 'list-sessions',
    '-F', '#{session_name}\t#{session_attached}\t#{session_activity}\t#{@mc_label}'],
    { timeout: 2500, env: { HOME: C.HOME } });
  if (!r.ok) return { keys: [], sessions: [] };
  // Stored names survive a session's death (viz term-labels.js). Živý @mc_label
  // je autoritativní, dokud je nastavený; soubor je fallback a zdroj obnovy.
  // Synchronizujeme oběma směry níž.
  const stored = termLabels.allLabels();
  const sessions = [];
  for (const line of r.stdout.split('\n')) {
    const [nm, attached, activity, label] = line.split('\t');
    if (!nm || !nm.startsWith(C.TERM_SESSION_PREFIX)) continue;
    const rest = nm.slice(C.TERM_SESSION_PREFIX.length);
    const dash = rest.lastIndexOf('-');
    let key = rest, sid = null;
    if (dash > 0 && /^\d+$/.test(rest.slice(dash + 1))) { key = rest.slice(0, dash); sid = Number(rest.slice(dash + 1)); }
    if (!C.TERM_KEYS.includes(key)) continue;
    const live = (label || '').trim() || null;
    if (live) {
      // Capture: soubor drží krok se jmény nastavenými naživo (rename, nebo
      // čerstvá session, co má label rovnou). No-op, když se nic nezměnilo.
      termLabels.setLabel(nm, live);
    } else if (stored[nm]) {
      // Restore: session se vrátila bez jména (resume/respawn, nebo restart
      // tmux serveru) — znovu nastav uložený @mc_label. Best-effort; overlay
      // níž (label: stored[nm]) mezitím jméno ukazuje i tak.
      execFile(C.TERM_TMUX_BIN, ['-L', C.TERM_TMUX_SOCKET, 'set-option', '-t', nm, '@mc_label', stored[nm]],
        { timeout: 2000, env: { HOME: C.HOME } }, () => {});
    }
    sessions.push({
      name: nm, key, sid,
      label: live || stored[nm] || null,
      attached: Number(attached) > 0,
      lastActivity: Number(activity) ? Number(activity) * 1000 : null,
    });
  }
  sessions.sort((a, b) => (a.key === b.key ? (a.sid ?? 0) - (b.sid ?? 0) : a.key.localeCompare(b.key)));
  await Promise.all(sessions.map(async (s) => {
    const cap = await run(C.TERM_TMUX_BIN, ['-L', C.TERM_TMUX_SOCKET, 'capture-pane', '-p', '-t', s.name],
      { timeout: 2000, env: { HOME: C.HOME } });
    s.work = cap.ok ? classifyTermWork(cap.stdout) : 'dormant';
  }));
  return { keys: [...new Set(sessions.map((s) => s.key))], sessions };
}
