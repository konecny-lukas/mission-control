// Mission Control — modul NANOCLAW: read-only panel nad instalací NanoClaw
// (osobní Claude asistent, github.com/nanocoai/nanoclaw) běžící na stejném
// boxu. ŽÁDNÝ upstream kód se sem NEVENDORUJE a MC do NanoClaw nikdy nic
// nezapisuje — jediné dva zdroje dat jsou:
//   a) `<dir>/data/v2.db` — SQLite, čteno VÝHRADNĚ přes
//      `new DatabaseSync(path, {readOnly: true})` v try/catch (nikdy zápis,
//      nikdy jiná cesta k souboru),
//   b) `systemctl --user list-units nanoclaw-v2-* --no-legend --plain` —
//      zjištění, jestli/jak běží systemd --user unit dané instalace.
// Podle interní research přípravy balíčku k NanoClaw upstreamu („Co může MC
// číst" a „Instalace" — slug unity = sha1(cesta)[:8], víc installů na jednom
// boxu se nehádá).
//
// SCHÉMA OVĚŘENO 2026-08-20 na živé DB (systémový `sqlite3`, READ-ONLY,
// `file:...?mode=ro&immutable=1`) — port z původní interní verze Mission
// Control, kde byla ověřena na referenční instalaci NanoClaw (`data/v2.db`):
//   CREATE TABLE agent_groups (
//     id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
//     agent_provider TEXT, created_at TEXT NOT NULL
//   );
//   CREATE TABLE sessions (
//     id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
//     messaging_group_id TEXT REFERENCES messaging_groups(id), thread_id TEXT,
//     agent_provider TEXT, status TEXT DEFAULT 'active',
//     container_status TEXT DEFAULT 'stopped', last_active TEXT, created_at TEXT NOT NULL
//   );
// `container_status` a `last_active` — přesně jak předpokládal R4 (interní
// research příprava balíčku k NanoClaw upstreamu), potvrzeno
// i reálnými hodnotami v tabulce (`SELECT DISTINCT container_status` vrátilo
// 'stopped' a 'running' — 'running' je jediná hodnota počítaná jako běžící).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as C from '../config.js';

let last = null; // poslední DOBRÝ snímek (module-level cache — přežije chybu čtení)
// true, jakmile ASPOŇ JEDNOU uspělo čtení agent_groups×sessions. Dokud false,
// 'ok' se nikdy nesmí vrátit (viz computeState) — bez týhle pojistky by DB,
// která se ještě nikdy nepodařilo přečíst (špatná práva, natrvalo poškozený
// soubor…), s aktivní unitou hlásila 'ok' s agents:[] NAVĚKY, protože
// last.updatedAt zůstává null a staleness demotion v collectNanoclaw() na
// null updatedAt nikdy nezareaguje (nahlášeno v review round 1, fix round 1).
let everReadOk = false;
const logged = {}; // "loguj jednou, ne každý tick" — klíč: 'missing' | 'dbread'
function logOnce(key, msg) { if (!logged[key]) { logged[key] = true; console.error(msg); } }
function clearLog(key) { logged[key] = false; }

function emptySnap() {
  return { state: 'off', unit: null, agents: [], updatedAt: null };
}

// Systemd --user unit dané instalace. Test override MC_NANOCLAW_NO_SYSTEMD=1
// (brief to mandatuje) přeskočí execFile úplně — žádné systemctl volání v
// testech. Chybějící/neúspěšné systemctl (žádný user bus, jiný OS…) i
// "nic nenalezeno" mají STEJNÝ výsledek (null) — jsou k nerozeznání a obojí
// znamená "MC neví o žádné unitě", ne chybu.
function detectUnit() {
  return new Promise((resolve) => {
    if (process.env.MC_NANOCLAW_NO_SYSTEMD === '1') return resolve(null);
    // Test-only hook (bez volání systemctl): vrátí fixní AKTIVNÍ unit — jinak
    // by nešlo v testu vůbec dosáhnout 'ok'/'crit' větví computeState() bez
    // skutečného systemd --user (regresní test na fix round 1: "unit aktivní
    // + DB se ještě nikdy nepodařilo přečíst" musí umět postavit unit==active
    // BEZ dotyku sítě/systemctl).
    if (process.env.MC_NANOCLAW_TEST_UNIT_ACTIVE === '1') return resolve({ name: 'nanoclaw-v2-test', active: 'active' });
    execFile('systemctl', ['--user', 'list-units', 'nanoclaw-v2-*', '--no-legend', '--plain'],
      { timeout: C.NANOCLAW_SYSTEMCTL_TIMEOUT_MS }, (err, stdout) => {
        if (err) return resolve(null);
        // --no-legend --plain: řádky "UNIT LOAD ACTIVE SUB DESCRIPTION…", mezerami
        // oddělené sloupce (DESCRIPTION může mít víc slov, ale ta nás nezajímá).
        const line = String(stdout || '').split('\n').map((l) => l.trim()).find(Boolean);
        if (!line) return resolve(null);
        const [name, , active] = line.split(/\s+/);
        resolve(name ? { name, active: active || 'unknown' } : null);
      });
  });
}

// Čtení agent_groups × sessions z data/v2.db. VÝHRADNĚ read-only, v try/catch
// — chybějící/zamčená/poškozená DB vrátí null (volající pak podrží poslední
// dobrá data), nikdy nehodí výjimku ven.
function readAgents(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const groups = db.prepare('SELECT id, name, folder FROM agent_groups ORDER BY name').all();
    const sessions = db.prepare('SELECT agent_group_id, container_status, last_active FROM sessions').all();
    const byGroup = new Map();
    for (const s of sessions) {
      const arr = byGroup.get(s.agent_group_id);
      if (arr) arr.push(s); else byGroup.set(s.agent_group_id, [s]);
    }
    return groups.map((g) => {
      const sess = byGroup.get(g.id) || [];
      const running = sess.filter((s) => s.container_status === 'running').length;
      let lastActive = null;
      for (const s of sess) {
        const t = Date.parse(s.last_active || '');
        if (Number.isFinite(t) && (lastActive == null || t > lastActive)) lastActive = t;
      }
      return { name: g.name, folder: g.folder, sessions: sess.length, running, lastActive };
    });
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// Stavový žebříček (čti odshora dolů, první match vyhrává):
//  'off'  — dir/DB vůbec neexistuje (nenainstalováno / špatná cesta v
//           configu) — jediný stav, kde se cache DOBŘE ZAHODÍ (viz níž), je
//           to legitimní klidový stav, ne chyba. (Řeší se o úroveň výš v
//           refreshNanoclaw — tahle fn se pro dbExists===false nevolá.)
//  'crit' — systemd --user unit NALEZENA, ale neběží (inactive/failed/…) —
//           instalace tu je, ale stojí. Má PŘEDNOST i před nepotvrzeně
//           čitelnou DB (stojící unit je naléhavější signál).
//  'warn' — buď žádná unit nenalezena, NEBO DB ještě NIKDY neprošla
//           úspěšným čtením (`everReadOk===false`) — nemáme důvod věřit
//           `agents:[]`. (Bez týhle druhé podmínky by DB, která se nikdy
//           nepodařilo přečíst, s aktivní unitou hlásila 'ok' navěky —
//           review round 1 bug, viz komentář u `everReadOk` výš.)
//  'ok'   — unit aktivní A DB byla ASPOŇ JEDNOU úspěšně přečtena. (Staleness
//           "bylo OK, teď je to stará data" řeší samostatně collectNanoclaw()
//           níž — na tuhle fn nedosáhne, protože `everReadOk` zůstává true.)
export function computeState(unit, everReadOk) {
  if (unit && unit.active !== 'active') return 'crit';
  if (!unit || !everReadOk) return 'warn';
  return 'ok';
}

// Jeden refresh cyklus: zjisti, jestli instalace vůbec existuje (dir/DB),
// zeptej se systemd na unitu, přečti agent_groups×sessions. Nikdy nehází —
// každá větev má vlastní try/catch nebo se opírá o funkce výš, které samy
// nikdy nevyhodí.
export async function refreshNanoclaw() {
  const dir = C.NANOCLAW_DIR;
  const dbPath = dir ? path.join(dir, 'data', 'v2.db') : null;
  const dbExists = !!(dbPath && fs.existsSync(dbPath));

  if (!dbExists) {
    logOnce('missing', `[nanoclaw] instalace nenalezena — ${dir ? `chybí ${dbPath}` : 'modules.nanoclaw.dir není nastaveno'}`);
    last = emptySnap(); // dir/DB entirely missing -> 'off', žádná stará cache (viz komentář u computeState)
    return;
  }
  clearLog('missing');

  const unit = await detectUnit();
  const agents = readAgents(dbPath);

  if (agents == null) {
    // DB existuje, ale čtení selhalo (zamčená/poškozená) — podrž poslední
    // dobrá agent data (last.agents, případně prázdné pole při úplně prvním
    // selhání), jen přepiš unit info (to je na DB nezávislé) a nechej stav
    // dopočítat z NĚJ přes computeState(unit, everReadOk) — pokud DB ještě
    // NIKDY nebyla úspěšně přečtená (everReadOk===false), state je 'warn'
    // bez ohledu na unit (viz computeState výš); pokud UŽ byla, uživatel
    // dostane 'ok' (je-li unit v pořádku), ale collectNanoclaw() níž ho podle
    // stáří updatedAt případně srazí na 'warn'.
    logOnce('dbread', `[nanoclaw] čtení ${dbPath} selhalo (zamčená/poškozená DB?)`);
    last = { state: computeState(unit, everReadOk), unit, agents: last?.agents || [], updatedAt: last?.updatedAt ?? null };
    return;
  }
  clearLog('dbread');
  everReadOk = true; // od teď 'ok' pustí computeState — DB je "potvrzeně čitelná"
  last = { state: computeState(unit, everReadOk), unit, agents, updatedAt: Date.now() };
}

// Práh stárnutí pro collectNanoclaw() níž: floor 5 min (dost i pro pomalejší
// refresh), jinak 2,5× refresh interval — pokrývá pár po sobě jdoucích
// neúspěšných ticků v řadě, ne jen jeden, ale ŠKÁLUJE s configem
// (modules.nanoclaw.refreshMs / MC_NANOCLAW_REFRESH_MS). Bez týhle derivace
// by operátor s refreshMs > 5 min viděl 'warn' na KAŽDÉM zdravém snímku,
// protože floor 5 min by byl kratší než samotný refresh interval (review
// round 1, bundled ruling). Exportováno jako čistá fn kvůli testu.
export function computeStaleMs(refreshMs) {
  return Math.max(5 * 60_000, 2.5 * refreshMs);
}
const STALE_MS = computeStaleMs(C.NANOCLAW_REFRESH_MS);

// Snímek, který renderuje panel/drawer — čistě čtení z paměti (module-level
// cache `last`), žádné I/O. Před prvním refreshem (boot seed) vrátí bezpečný
// 'off' placeholder.
export function collectNanoclaw() {
  if (!last) return emptySnap();
  if (last.state === 'ok' && last.updatedAt && Date.now() - last.updatedAt > STALE_MS) {
    return { ...last, state: 'warn' };
  }
  return last;
}
