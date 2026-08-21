// Mission Control — centrální konfigurace.
// Běží jako neprivilegovaný uživatel (typicky bez sudo), všechny cesty absolutní.
// Žádné klientské zdroje natvrdo — vše personalizované jde přes mc.config.json
// (viz níže) nebo volitelné moduly (config.js:32 MODULE_IDS).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HOME agenta — kam Claude Code (Jarvis i terminály) ukládá session/creds
// (~/.claude), odkud se bere CLAUDE_BIN a hranice /file/ endpointu. Default =
// domovský adresář uživatele, pod kterým MC běží (jednoduchá instalace: běžíš
// jako ty). MC_AGENT_HOME přepiš jen pro sandboxovou variantu s dedikovaným
// běhovým uživatelem (jiný HOME, než pod kterým je spuštěný proces) — viz
// INSTALL.md.
export const HOME = process.env.MC_AGENT_HOME || os.homedir();
export const MC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const HOST = process.env.MC_HOST || '127.0.0.1'; // nikdy 0.0.0.0 — Caddy/loopback ji fronts
export const HOSTNAME = os.hostname();

// ---- mc.config.json — jediné místo personalizace (gitignored) ----
export function expandHome(p) { return p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p; }
const CFG_FILE = process.env.MC_CONFIG || path.join(MC_DIR, 'mc.config.json');
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf-8')); }
  catch { return {}; } // bez configu jede holé jádro s defaulty
}
export const CFG = loadCfg();
export const PORT = Number(process.env.MC_PORT || CFG.port || 8088);

// Veřejná (tailnet) URL pro mc-open/mc-preview CLI (bin/public-url.mjs).
// Priorita tady: env přepis → CFG.publicUrl (mc.config.json). Prázdné/null
// znamená „nech resolvePublicUrl() zkusit tailscale status --json, pak
// http://<hostname>" — viz bin/public-url.mjs.
export const PUBLIC_URL = process.env.MC_PUBLIC_URL || CFG.publicUrl || null;

// Branding (frontend si bere z /api/status; titul je i v index.html)
export const BRAND = {
  name: process.env.MC_CLIENT_NAME || CFG.name || 'MISSION CONTROL',
  tagline: process.env.MC_TAGLINE || CFG.tagline || 'server HUD',
  accent: CFG.accent || '#2ba8ff',
};
const MODULE_IDS = ['uptime', 'ga4', 'gsc', 'indexace', 'claudelimits', 'wpsched', 'nanoclaw', 'watchdog'];
export const MODULES = Object.fromEntries(MODULE_IDS.map((id) => [id, !!(CFG.modules && CFG.modules[id])]));

// Refresh kadence (ms)
export const FAST_MS = 8000;
export const SLOW_MS = 20000;

export const CLAUDE_DIR = `${HOME}/.claude`;
export const DATA_DIR = process.env.MC_DATA_DIR || path.join(MC_DIR, 'data');

// ---- mc.config.json "services" — sledované systemd jednotky (spec §4) ----
// [{unit, label?, scope?: 'user'|'system'}]. null = klíč v configu chybí ->
// collectors.js drží starý napevno daný seznam (zpětná kompatibilita).
// unit validovaný přísně (žádný volný vstup do execFile argv) — jméno musí
// sedět na běžné systemd znaky, jinak se položka tiše zahodí. První znak
// musí být alfanumerický (žádné vedoucí '-' — to by u některých nástrojů
// mohlo být čteno jako přepínač, ne jako jméno jednotky).
export const SERVICES_CFG = Array.isArray(CFG.services)
  ? CFG.services.filter((s) => s && typeof s.unit === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9@._-]{0,63}$/.test(s.unit))
  : null;

// ---- Akční allowlist (state-changing endpointy) ----
// Jen tyhle přesné cíle/příkazy lze vyvolat. Žádný volný vstup nejde do shellu
// — execFile s pevným argv.
export const RESTARTABLE_SERVICES = {
  'mission-control': { label: 'Mission Control', scope: 'user' },
  'mc-ttyd': { label: 'Terminály (ttyd)', scope: 'user' },
  // Uživatelské jednotky z mc.config.json "services" navíc — chybějící scope
  // se (stejně jako v collectors.js collectServices) bere jako 'user'. Restart
  // endpoint běží vždy jako `systemctl --user restart <target>` (server.js
  // runAction), takže systémové (scope:'system') jednotky sem nepatří —
  // chtělo by to sudo, což tenhle allowlist záměrně nedělá.
  ...Object.fromEntries(
    (SERVICES_CFG || [])
      .filter((s) => s.scope !== 'system')
      .map((s) => [s.unit, { label: s.label || s.unit, scope: 'user' }]),
  ),
};

// Joby spustitelné na klik (argv, bez shellu). Čistý box zatím žádné nemá —
// přidají se, až tu poběží projekty (např. „spustit build", „sync"…).
export const RUNNABLE_JOBS = {};

// ---- Persistentní terminály (tmux na vyhrazeném socketu) ----
export const TERM_TMUX_BIN = '/usr/bin/tmux';
export const TERM_TMUX_SOCKET = 'mc';
export const TERM_SESSION_PREFIX = 'mc-';
export const TERM_TMUX_CONF = path.join(MC_DIR, 'mc-tmux.conf');
// Jediný zdroj pravdy pro terminálové projekty (launcher v UI, mctask fronta,
// mc-claude.sh case blok přes bin/mc-project.mjs): CFG.terminals.projects
// z mc.config.json, jinak vestavěný default. Klíč musí sedět do tmux session
// jména i shell argv (bezpečný allowlist tvar); dir smí začínat '~' (expandne
// se na HOME agenta — viz expandHome výš).
const DEFAULT_TERM_PROJECTS = [
  { key: 'home', label: 'Domů', dir: '~' },
  { key: 'app', label: 'Mission Control', dir: MC_DIR },
];
export const TERM_PROJECTS = ((CFG.terminals && CFG.terminals.projects) || DEFAULT_TERM_PROJECTS)
  .filter((p) => /^[a-z0-9]{1,16}$/.test(p.key)).map((p) => ({ ...p, dir: expandHome(p.dir) }));
export const TERM_KEYS = TERM_PROJECTS.map((p) => p.key);
export const MCTASK_PROJECTS = Object.fromEntries(TERM_PROJECTS.map((p) => [p.key, { label: p.label, dir: p.dir }]));
// Perzistentní jména terminálů (@mc_label přežije jen v paměti tmux serveru) —
// viz term-labels.js. MC_TERM_LABELS jde přepsat v testech, ať nesahají do
// reálné data/ tohoto stroje.
export const TERM_LABELS_FILE = process.env.MC_TERM_LABELS || path.join(DATA_DIR, 'term-labels.json');

// ---- Jarvis (servisní agent) ----
// Headless Claude Code session řízená server-side. Ve výchozí (jednoduché)
// instalaci běží jako přihlášený uživatel, pod kterým jede Mission Control —
// stejná důvěra jako /term terminály (tailnet), viz jarvis.js hlavička.
// --dangerously-skip-permissions je proto OK. Pokročilá sandboxová varianta
// s dedikovaným uživatelem `mc` bez sudo (ProtectSystem=strict) je volitelná,
// viz INSTALL.md. Uživatelská zpráva jde jako jediný argv prvek.
export const JARVIS_STATE = path.join(DATA_DIR, 'jarvis-state.json');
export const JARVIS_TRANSCRIPT = path.join(DATA_DIR, 'jarvis-transcript.json');
// Vyrobený z agent-system.md.template (repo root) při instalaci — viz INSTALL.md.
// Chybí-li (čerstvý checkout bez proběhlé instalace), jarvis.js flag
// --append-system-prompt-file prostě vynechá (fs.existsSync guard).
export const JARVIS_SYSTEM_PROMPT = path.join(DATA_DIR, 'agent-system.md');
export const CLAUDE_BIN = process.env.MC_CLAUDE_BIN || `${HOME}/.local/bin/claude`;
export const JARVIS_MODEL = process.env.MC_JARVIS_MODEL || 'claude-opus-4-8';
export const JARVIS_EFFORT = process.env.MC_JARVIS_EFFORT || 'high';
export const JARVIS_CWD = HOME;
export const JARVIS_MAX_MSG = 16384;
export const JARVIS_TRANSCRIPT_MAX = 60;
export const JARVIS_STALL_MS = Number(process.env.MC_JARVIS_STALL_MS || 240_000);
export const JARVIS_MAX_MS = Number(process.env.MC_JARVIS_MAX_MS || 900_000);
// Lokální claude OAuth (~/.claude) — NIKDY neinjektovat ANTHROPIC_API_KEY.
export const JARVIS_ENV = {
  ...process.env,
  HOME,
  PATH: `${HOME}/.local/bin:${HOME}/.local/share/claude:/usr/local/bin:/usr/bin:/bin`,
  TERM: 'xterm-256color',
};

// ---- SSE push (GET /api/stream) ----
export const STREAM_MAX_CLIENTS = Number(process.env.MC_STREAM_MAX_CLIENTS || 8);
export const STREAM_HEARTBEAT_MS = Number(process.env.MC_STREAM_HEARTBEAT_MS || 15_000);
export const STREAM_RETRY_MS = Number(process.env.MC_STREAM_RETRY_MS || 3000);

// ---- Uptime monitoring (volitelný modul — viz MODULES.uptime) ----
// Vzor pro všechny další moduly: sekce z CFG.modules.<id>, odvozené konstanty
// s dosavadními defaulty jako fallback (config bez explicitních hodnot = stejné
// chování jako dřív natvrdo).
export const UPTIME_DB = path.join(DATA_DIR, 'uptime.db');
const UPTIME_CFG = CFG.modules?.uptime || {};
export const UPTIME_SITES = UPTIME_CFG.sites || []; // prázdné = žádný web k hlídání (nastav v mc.config.json)
export const UPTIME_INTERVAL_MS = UPTIME_CFG.intervalMs || 60_000;
export const UPTIME_TIMEOUT_MS = UPTIME_CFG.timeoutMs || 10_000;
export const UPTIME_RETENTION_DAYS = UPTIME_CFG.retentionDays || 30;

// ---- Sdílený resolver keyFile cesty pro Google moduly (ga4/gsc/indexace) ----
// '~' expanduje na HOME agenta (expandHome, jako TERM_PROJECTS dir výš),
// relativní cesta bez '~' se bere vůči MC_DIR (repo) — ať jde klíč nasadit jako
// sourozenec configu (secrets/google.json) bez nutnosti absolutní cesty. Dřív
// tři skoro identické kopie (resolveGa4KeyFile/resolveGscKeyFile/…), teď jedno místo.
export function resolveGoogleKeyFile(p) {
  const h = expandHome(p);
  return path.isAbsolute(h) ? h : path.join(MC_DIR, h);
}

// ---- Google Analytics 4 — návštěvnost (volitelný modul — viz MODULES.ga4) ----
// Auth přes modules/google-auth.js (createTokenProvider) — sdílené s gsc/indexace
// moduly, service account NEBO OAuth installed-app refresh token.
export const GA4_DB = path.join(DATA_DIR, 'ga4.db');
const GA4_CFG = CFG.modules?.ga4 || {};
export const GA4_KEY_FILE = resolveGoogleKeyFile(GA4_CFG.keyFile || 'secrets/google.json');
export const GA4_SITES = GA4_CFG.sites || []; // [{id, property, host, label?}] — prázdné = žádný web (nastav v mc.config.json)
export const GA4_TZ = GA4_CFG.timezone || 'Europe/Prague';
export const GA4_REFRESH_MS = Number(process.env.MC_GA4_REFRESH_MS || GA4_CFG.refreshMs || 30 * 60_000);
export const GA4_LIVE_REFRESH_MS = Number(process.env.MC_GA4_LIVE_REFRESH_MS || GA4_CFG.liveRefreshMs || 5 * 60_000);
export const GA4_TIMEOUT_MS = Number(process.env.MC_GA4_TIMEOUT_MS || GA4_CFG.timeoutMs || 25_000);

// ---- Google Search Console — organická návštěvnost (volitelný modul — viz
// MODULES.gsc). Auth přes stejný modules/google-auth.js jako ga4 (výchozí
// keyFile je stejný soubor, secrets/google.json — jeden SA/OAuth klíč stačí
// na obojí). Na rozdíl od ga4 se hostname/property NEOVĚŘUJE: jedna GSC
// property = jeden web, žádné WPML slicing jako v původním interním MC.
export const GSC_DB = path.join(DATA_DIR, 'gsc.db');
const GSC_CFG = CFG.modules?.gsc || {};
export const GSC_KEY_FILE = resolveGoogleKeyFile(GSC_CFG.keyFile || 'secrets/google.json');
export const GSC_SITES = GSC_CFG.sites || []; // [{id, property, label?}] — prázdné = žádný web (nastav v mc.config.json)
export const GSC_WINDOW_DAYS = Number(GSC_CFG.windowDays || 90);
export const GSC_REFRESH_MS = Number(process.env.MC_GSC_REFRESH_MS || GSC_CFG.refreshMs || 6 * 60 * 60_000);
export const GSC_TIMEOUT_MS = Number(process.env.MC_GSC_TIMEOUT_MS || GSC_CFG.timeoutMs || 25_000);

// ---- Google Search Console URL Inspection — stav indexace stránek v Googlu
// (volitelný modul — viz MODULES.indexace). Autoritativní, ZDARMA náhrada za
// ruční `site:` dotaz. Auth sdílená s gsc (výchozí keyFile stejný soubor).
// Na rozdíl od původního interního MC: JEDNA GSC property PER WEB (žádné WPML
// properties[] pole pro víc jazykových mutací jedné property — YAGNI, viz R2 §6)
// a sitemap URL je POVINNÁ přímo v configu (žádné hádání přes robots.txt/
// konvenční cesty — admin ji zadá jednou při zapnutí modulu).
export const INDEXACE_DB = path.join(DATA_DIR, 'indexace.db');
const INDEXACE_CFG = CFG.modules?.indexace || {};
export const INDEXACE_KEY_FILE = resolveGoogleKeyFile(INDEXACE_CFG.keyFile || 'secrets/google.json');
export const INDEXACE_SITES = INDEXACE_CFG.sites || []; // [{id, property, sitemap, label?}] — prázdné = žádný web
export const INDEXACE_LANG = INDEXACE_CFG.languageCode || 'cs-CZ';
export const INDEXACE_REFRESH_MS = Number(process.env.MC_INDEXACE_REFRESH_MS || INDEXACE_CFG.refreshMs || 24 * 60 * 60_000);
export const INDEXACE_MIN_GAP_MS = Number(INDEXACE_CFG.minGapMs || 20 * 60 * 60_000); // restart-safe brána — nespálí kvótu
export const INDEXACE_TIMEOUT_MS = Number(process.env.MC_INDEXACE_TIMEOUT_MS || INDEXACE_CFG.timeoutMs || 25_000);
export const INDEXACE_MAX_URLS = Number(INDEXACE_CFG.maxUrls || 2000); // strop NA WEB = denní kvóta URL Inspection/property
export const INDEXACE_CONCURRENCY = Number(INDEXACE_CFG.concurrency || 6);
export const INDEXACE_HISTORY_DAYS = Number(INDEXACE_CFG.historyDays || 90);

// ---- Limity Claude subscription (volitelný modul — viz MODULES.claudelimits)
// Modul čte OAuth access token z `<claudeDir>/.credentials.json` — READ-ONLY,
// nikdy nezapisuje, nikdy nepoužívá refreshToken (viz modules/claudelimits.js
// hlavička). CLAUDE_DIR výš (`${HOME}/.claude`) čtou i jarvis.js (Jarvis
// servisní agent) a collectors.js (`claude` CLI stav session) — tenhle modul
// z NĚJ jen odvozuje vlastní konstantu se stejným defaultem, ať jde přepsat
// per-instalaci (mc.config.json → modules.claudelimits.claudeDir) bez rizika
// zásahu do těch dvou existujících konzumentů CLAUDE_DIR.
const CLAUDELIMITS_CFG = CFG.modules?.claudelimits || {};
export const CLAUDELIMITS_DIR = expandHome(CLAUDELIMITS_CFG.claudeDir) || CLAUDE_DIR;
export const CLAUDE_LIMITS_REFRESH_MS = Number(process.env.MC_CLAUDE_LIMITS_REFRESH_MS || CLAUDELIMITS_CFG.refreshMs || 60_000);

// ---- WordPress naplánované posty (volitelný modul — viz MODULES.wpsched).
// REWRITE, ne port původního interního MC modulu — ten mluvil na WP přes sshpass
// s heslem po SSH a spouštěl `eval(base64_decode(...))` PHP (navíc se
// skrytým auto-repair write path) — VŠECHNO tohle je tu zakázané (podle
// interní research přípravy balíčku, mapa modulů §6 wpsched). Tenhle
// modul mluví jen s WP REST API přes application password a je přísně
// READ-ONLY (jediný HTTP verb = GET). `appPasswordFile` sdílí resolveGoogleKeyFile
// logiku (expandHome pro '~', jinak relativně vůči MC_DIR — např. secrets/wp-x.pass)
// i sémantiku: soubor se NIKDY nepřepisuje, jen čte, a to líně při každém
// refreshi (ne jednou při startu) — otočení hesla na WP straně se tak projeví
// bez restartu MC.
function resolveWpschedAppPasswordFile(p) {
  const h = expandHome(p);
  return path.isAbsolute(h) ? h : path.join(MC_DIR, h);
}
const WPSCHED_CFG = CFG.modules?.wpsched || {};
export const WPSCHED_SITES = (WPSCHED_CFG.sites || []) // [{id, label?, url, user, appPasswordFile}]
  .map((s) => ({ ...s, appPasswordFile: resolveWpschedAppPasswordFile(s.appPasswordFile) }));
export const WPSCHED_REFRESH_MS = Number(process.env.MC_WPSCHED_REFRESH_MS || WPSCHED_CFG.refreshMs || 4 * 60 * 60_000);
export const WPSCHED_GRACE_MS = Number(WPSCHED_CFG.graceMs || 15 * 60_000);
export const WPSCHED_TIMEOUT_MS = Number(process.env.MC_WPSCHED_TIMEOUT_MS || WPSCHED_CFG.timeoutMs || 20_000);
export const WPSCHED_STATE_FILE = path.join(DATA_DIR, 'wpsched.json');

// ---- NanoClaw — read-only panel nad lokální instalací (volitelný modul —
// viz MODULES.nanoclaw). ŽÁDNÝ upstream kód se nevendoruje a nic se do
// NanoClaw nezapisuje — modul jen ČTE jeho `data/v2.db` (SQLite, read-only)
// a zjišťuje stav systemd --user unit `nanoclaw-v2-*`. Podle interní
// research přípravy balíčku k NanoClaw upstreamu („Co může MC číst").
// `dir` = kořen checkoutu (typicky `~/nanoclaw-v2`) — stejná resolve
// konvence jako WPSCHED_SITES.appPasswordFile výš (expandHome pro '~',
// jinak relativně vůči MC_DIR, ať fixture v testech nezávisí na cwd).
function resolveNanoclawDir(p) {
  if (!p) return null;
  const h = expandHome(p);
  return path.isAbsolute(h) ? h : path.join(MC_DIR, h);
}
const NANOCLAW_CFG = CFG.modules?.nanoclaw || {};
export const NANOCLAW_DIR = resolveNanoclawDir(NANOCLAW_CFG.dir); // null = nenastaveno -> modul vždy 'off'
export const NANOCLAW_REFRESH_MS = Number(process.env.MC_NANOCLAW_REFRESH_MS || NANOCLAW_CFG.refreshMs || 60_000);
export const NANOCLAW_SYSTEMCTL_TIMEOUT_MS = Number(NANOCLAW_CFG.systemctlTimeoutMs || 4_000);

// ---- Watchdog — hodinový hlídač cronů + vypravěč (volitelný modul — viz
// MODULES.watchdog). JEDINÝ zdroj pravdy pro projekty a parametry hlídače je
// CFG.modules.watchdog = {model?, budgetUsd?, timeoutSecs?, permissionMode?
// ('safe'|'full', default 'safe'), projects: [{id,label,log?,sources?}]} —
// watchdog/gen.mjs z něj generuje prompt pro
// headless Claude (data/watchdog-prompt.md) i seznamy pro shell smyčky
// (watchdog/run-watchdog.sh, watchdog/check.sh). V původním interním systému byl
// počet projektů natvrdo rozházený na 4 místech a časem se rozjel (podle
// interní research přípravy balíčku k watchdogu a skillům, §A3
// „Nekonzistence k opravě") — tenhle balíček to řeší jedním zdrojem.
// WATCHDOG_REFRESH_MS řídí jen MC-stranu (panel/drawer čtou historii+narativy
// z disku, žádné spouštění claude — to dělá vnější cron, viz INSTALL.md).
const WATCHDOG_CFG = CFG.modules?.watchdog || {};
// Bezpečnostní filtr id: stejný princip jako TERM_PROJECTS výš (config.js:69)
// — `id` teče do `path.join(NARRATIVE_DIR, id+'.log')` (tenhle soubor) i do
// bash `"$NARRATIVE_DIR/$N.log"` a `mapfile` smyček (run-watchdog.sh,
// check.sh). Bez filtru by `../` v id korumpovalo cesty mimo NARRATIVE_DIR a
// newline v id rozbil parsing `mapfile -t PROJECTS < <(node gen.mjs projects)`
// (id se tam vypisuje jeden na řádek). Kebab-case, max 32 znaků — víc netřeba.
export const WATCHDOG_PROJECTS = (Array.isArray(WATCHDOG_CFG.projects) ? WATCHDOG_CFG.projects : [])
  .filter((p) => p && typeof p.id === 'string' && /^[a-z0-9-]{1,32}$/.test(p.id));
export const WATCHDOG_MODEL = WATCHDOG_CFG.model || 'sonnet';
export const WATCHDOG_BUDGET = Number(WATCHDOG_CFG.budgetUsd || 1.0);
export const WATCHDOG_TIMEOUT = Number(WATCHDOG_CFG.timeoutSecs || 600);
// Fix round 1 (security, HIGH): 'safe' (DEFAULT) = run-watchdog.sh spouští
// claude BEZ --dangerously-skip-permissions, jen s úzkým --allowedTools
// allowlistem (žádný obecný kill/rm) — logy a výstup check.sh mohou nést
// útočníkem ovlivněný text (viz prompt-injection), headless agent se
// skip-permissions nad nimi by byl RCE cesta. 'full' = původní chování
// (--dangerously-skip-permissions), explicitní opt-in v mc.config.json.
export const WATCHDOG_PERMISSION_MODE = WATCHDOG_CFG.permissionMode === 'full' ? 'full' : 'safe';
export const WATCHDOG_PROMPT_TEMPLATE = path.join(MC_DIR, 'watchdog', 'prompt-template.md');
export const WATCHDOG_PROMPT_OUT = path.join(DATA_DIR, 'watchdog-prompt.md');
export const WATCHDOG_REFRESH_MS = Number(process.env.MC_WATCHDOG_REFRESH_MS || 60_000);

// ---- Network transfer totals (z /proc/net/dev) ----
export const NETSTAT_DB = path.join(DATA_DIR, 'netstat.db');
export const NETSTAT_REFRESH_MS = 60_000;

// ---- Preview registry (věci, co agent postaví; mc-preview CLI) ----
export const PREVIEWS_FILE = path.join(DATA_DIR, 'previews.json');

// ---- Alert engine (alerts.js) ----
export const ALERTS_DB = path.join(DATA_DIR, 'alerts.db');
export const ALERT_HISTORY_RETENTION_DAYS = 90;
export const ALERT_SILENCE_MAX_DAYS = 7;
// Auto-diagnóza (headless claude na crit) — u klienta VYPNUTO (žádné překvapivé
// náklady na jeho účet; ruční „diagnostikovat" tlačítko zůstává). Žádné pravidlo
// níž nemá diagnose:true, takže se subprocess nikdy nespustí automaticky.
export const ALERT_DIAGNOSE_ENABLED = process.env.MC_ALERT_DIAGNOSE === '1';
export const ALERT_DIAGNOSE_MODEL = process.env.MC_ALERT_MODEL || 'claude-sonnet-4-6';
export const ALERT_DIAGNOSE_EFFORT = 'low';
export const ALERT_DIAGNOSE_MAX_MS = 180_000;
export const ALERT_DIAGNOSE_MAX_PER_HOUR = 2;
export const ALERT_DIAGNOSE_MAX_MEM_PCT = 80;
// Hlídač cronů (builtin watchdog pravidlo, volitelný modul) — bez zapnutého
// MODULES.watchdog alert engine tohle pravidlo vůbec nepřidá (viz ALERT_RULES
// níž), takže se soubor nikdy nečte. Env override umožňuje sdílet existující
// historii (jiný stroj/cesta) bez přesunu dat do repa.
export const WATCHDOG_HISTORY = process.env.MC_WATCHDOG_HISTORY || path.join(DATA_DIR, 'watchdog-history.jsonl');

// ---- Alert threads (interaktivní diagnostická vlákna threads.js) ----
export const THREADS_DIR = path.join(DATA_DIR, 'threads');
export const THREADS_MAX_CONCURRENT = Number(process.env.MC_THREADS_MAX || 2);
export const THREAD_MODEL = process.env.MC_THREAD_MODEL || 'claude-sonnet-4-6';
export const THREAD_EFFORT = 'low';
export const THREAD_MAX_TURN_MS = 15 * 60_000;
export const THREAD_WAIT_IDLE_MS = 60 * 60_000;
export const THREAD_PUMP_RETRY_MS = 30_000;

// ---- MC fronta úkolů (mctasks.js) ----
export const MCTASKS_FILE = path.join(DATA_DIR, 'mctasks.json');
export const MCTASK_MAX_SUBJECT = 140;
export const MCTASK_MAX_DETAIL = 4000;
export const MCTASK_TERM_READY_MS = 60_000;
export const MCTASK_TERM_POLL_MS = 1500;
// MCTASK_PROJECTS je odvozené z TERM_PROJECTS výš (jediný zdroj pravdy).

// ---- Timeline — „lodní deník" (timeline.js) ----
export const NARRATIVE_DIR = process.env.MC_NARRATIVE_DIR || path.join(DATA_DIR, 'narrative');
export const TIMELINE_TAIL_BYTES = Number(process.env.MC_TIMELINE_TAIL_BYTES || 262_144);
export const TIMELINE_PAGE = Number(process.env.MC_TIMELINE_PAGE || 50);
export const TIMELINE_CACHE_MS = Number(process.env.MC_TIMELINE_CACHE_MS || 30_000);
export const TIMELINE_MAX_DAYS = Number(process.env.MC_TIMELINE_MAX_DAYS || 30);

// Tvar pravidla viz alerts.js. Výchozí sada = jen systémové/služby signály (RAM, swap, disk, load, služby).
const MIN = 60_000, HOUR = 3_600_000;
export const ALERT_RULES = [
  { id: 'ram-warn', type: 'metric', path: 'system.mem.usedPct',
    when: (v) => typeof v === 'number' && v >= 90 && v < 95,
    severity: 'warn', forMs: 2 * MIN, clearMs: 2 * MIN, cooldownMs: 10 * MIN, diagnose: false,
    text: 'Využití RAM {value} % (≥ 90 % přes 2 min)', link: 'system' },
  { id: 'ram-crit', type: 'metric', path: 'system.mem.usedPct',
    when: (v) => typeof v === 'number' && v >= 95,
    severity: 'crit', forMs: 2 * MIN, clearMs: 2 * MIN, cooldownMs: 10 * MIN, diagnose: false,
    text: 'Kritické využití RAM {value} % (≥ 95 % přes 2 min)', link: 'system' },
  { id: 'swap-high', type: 'metric', path: 'system.mem.swapUsedPct',
    when: (v) => typeof v === 'number' && v >= 85,
    severity: 'warn', forMs: 5 * MIN, clearMs: 5 * MIN, cooldownMs: 30 * MIN, diagnose: false,
    text: 'Swap na {value} % (≥ 85 % přes 5 min)', link: 'system' },
  { id: 'disk-warn', type: 'each', path: 'system.disks', keyField: 'mount',
    when: (d) => typeof d.usedPct === 'number' && d.usedPct >= 90 && d.usedPct < 95,
    severity: 'warn', forMs: 0, clearMs: 10 * MIN, cooldownMs: HOUR, diagnose: false,
    text: 'Disk {label} zaplněn na {usedPct} %', link: 'system' },
  { id: 'disk-crit', type: 'each', path: 'system.disks', keyField: 'mount',
    when: (d) => typeof d.usedPct === 'number' && d.usedPct >= 95,
    severity: 'crit', forMs: 0, clearMs: 10 * MIN, cooldownMs: HOUR, diagnose: false,
    text: 'Disk {label} kriticky plný — {usedPct} %', link: 'system' },
  { id: 'load-high', type: 'metric', path: 'system',
    when: (s) => (s?.load && s.cores && s.load[0] > s.cores * 3) ? { load1: s.load[0], cores: s.cores } : false,
    severity: 'warn', forMs: 5 * MIN, clearMs: 5 * MIN, cooldownMs: 30 * MIN, diagnose: false,
    text: 'Load {load1} — přes 3× počet jader ({cores}) déle než 5 min', link: 'system' },
  { id: 'service-down', type: 'each', path: 'services', keyField: 'name',
    when: (s) => s.state === 'crit',
    severity: 'crit', forMs: 30_000, clearMs: MIN, cooldownMs: 5 * MIN, diagnose: false,
    text: 'Služba {label} neběží ({active})', link: 'system' },
];
// wp-stuck-post: port pravidla z původního interního MC config.js:736, ale adaptované
// na nový (per-web) tvar snímku modules/wpsched.js — zdroj měl JEDEN web a plochý
// seznam postů (`wpsched.stuck`), tenhle balíček podporuje víc webů
// (`wpsched.sites[]`), takže `each` běží nad weby (klíč = id webu), ne nad
// jednotlivými posty — výstraha je PER WEB a shrnuje počet + první zaseknutý
// post, vyřeší se sama, jakmile na webu žádný stuck post nezbyde. Přidáno JEN
// když je modul zapnutý (jinde ALERT_RULES nemá co hlídat — bez configu
// wpsched.sites nikdy nic nevrátí). fixHint jde do target/meta stejně jako ve
// zdroji (manuální diagnóza z něj čte), ale REST éra nemá po ruce wp-cli —
// hint je „zkontroluj WP cron / publikuj ručně" místo `wp eval`.
if (MODULES.wpsched) {
  ALERT_RULES.push({
    id: 'wp-stuck-post', type: 'each', path: 'wpsched.sites', keyField: 'id',
    when: (s) => (s.ok && Array.isArray(s.stuck) && s.stuck.length) ? {
      count: s.stuck.length,
      title: s.stuck[0].title,
      at: s.stuck[0].at,
      fixHint: 'Zkontroluj WP cron (wp-cron.php) na webu, nebo naplánovaný post publikuj ručně z administrace WordPressu.',
    } : false,
    severity: 'warn', forMs: 0, clearMs: WPSCHED_REFRESH_MS, cooldownMs: 24 * HOUR, diagnose: false,
    text: 'wpsched {label}: {count} zaseknutý naplánovaný post — např. „{title}“ mělo vyjít {at}', link: 'wpsched' });
}
// watchdog-alert: builtin pravidlo hlídače cronů (alerts.js watchdogLatest() +
// rule.type==='watchdog', port z původního interního MC config.js:748-750). Přidáno
// JEN když je modul zapnutý — jinak by alert engine zbytečně stat-oval
// neexistující watchdog-history.jsonl na každý tick. `link` míří na drawer
// 'watchdog' (public/drawers.js) — na rozdíl od zdroje (`link:'cron'`) tenhle
// balíček nemá samostatný cron-jobs drawer, jen watchdog jako celek.
if (MODULES.watchdog) {
  ALERT_RULES.push({
    id: 'watchdog-alert', type: 'watchdog', path: 'cron', liveText: true,
    severity: 'warn', forMs: 0, clearMs: 0, cooldownMs: 30 * MIN, diagnose: false,
    text: 'Hlídač cronů hlásí problém: {summary}', link: 'watchdog' });
}
