// Trvalé úložiště vlastních jmen terminálů (akce „Přejmenovat" v drawer).
//
// Proč to existuje: tmux volba `@mc_label` žije JEN v paměti běžícího tmux
// serveru. Session, která umře — Claude skončí, OOM, tmux server se restartuje
// — si jméno vezme s sebou, beze stopy kdekoli jinde. Jednou nás to už bolelo
// („Destinační huby" zmizely, když session umřela). Tenhle soubor drží jméno
// klíčované plným jménem session (`mc-<key>-<sid>`), takže session, která se
// vrátí pod stejným jménem (resume, respawn), dostane svůj label zpátky — viz
// collectors.collectTermSessions(), který odsud čte a znovu aplikuje.
//
// Zero-dep, zrcadlí persistenci previews.json / mctasks.json v tomhle repu.
// In-memory cache + atomický zápis (tmp + rename), takže pád uprostřed zápisu
// nemůže nechat napůl zapsaný soubor. Labely oříznuté na 40 znaků, stejný
// strop jako term.rename.
// Port z původní interní verze Mission Control — generický, beze změny
// logiky. Jediná adaptace: cesta jde přes C.TERM_LABELS_FILE (config.js), aby
// šla přepsat MC_TERM_LABELS v testech (nesahat do reálné data/ stroje).

import fs from 'node:fs';
import * as C from './config.js';

const FILE = C.TERM_LABELS_FILE;
let cache = null;

function load() {
  if (cache) return cache;
  try {
    const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch {
    cache = {}; // chybějící/poškozený soubor → začni znovu
  }
  return cache;
}

function save() {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n');
  fs.renameSync(tmp, FILE); // atomická náhrada
}

// Uložený label pro dané jméno session, nebo null.
export function getLabel(name) {
  return load()[name] || null;
}

// Mělká kopie celé mapy jméno→label (pro overlay v kolektoru).
export function allLabels() {
  return { ...load() };
}

// Uloží (label je pravdivý) nebo zapomene (label je nepravdivý) jméno session.
// Beze změny + bez zápisu na disk, když je uložená hodnota už přesně to, co
// bychom zapsali — kolektor tak může volat na každý tick bez zbytečného
// přepisování souboru.
export function setLabel(name, label) {
  if (!name) return;
  const m = load();
  const v = label ? String(label).slice(0, 40) : null;
  if (v) {
    if (m[name] === v) return;
    m[name] = v;
  } else {
    if (!(name in m)) return;
    delete m[name];
  }
  try { save(); } catch { /* best-effort; cache si hodnotu drží dál */ }
}
