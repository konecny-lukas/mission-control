#!/usr/bin/env node
// Mission Control — malé CLI nad terminálovými projekty (jediný zdroj pravdy
// je config.js -> CFG.terminals.projects). Volá ho mc-claude.sh, aby na klíč
// z URL nemapoval vlastní hardcoded case blok, ale stejná data jako UI/server.
//
//   node bin/mc-project.mjs dir <key>   -> absolutní cesta na stdout (exit 1
//                                          + chybová hláška na stderr, když
//                                          klíč neexistuje)
//   node bin/mc-project.mjs list        -> JSON pole [{key,label,dir}, ...]
import { TERM_PROJECTS } from '../config.js';

const [, , cmd, key] = process.argv;

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

if (cmd === 'list') {
  process.stdout.write(JSON.stringify(TERM_PROJECTS) + '\n');
} else if (cmd === 'dir') {
  const p = TERM_PROJECTS.find((x) => x.key === key);
  if (!p) fail(`neznámý projekt: '${key || ''}'`);
  else process.stdout.write(p.dir + '\n');
} else {
  fail('použití: mc-project.mjs dir <key> | list');
}
