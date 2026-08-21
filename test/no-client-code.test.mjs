// Zaručuje, že v balíčku nezůstal žádný klientský/LK-specifický kód (NocoDB,
// feschu, camaxis, box.json, OneCLI, rudy). Prochází celý strom repa kromě
// dokumentace (docs/superpowers), testů, .superpowers, .git a runtime data/.
// .internal je interní archiv (Step 3 pre-push auditu — docs/superpowers sem
// přesunuto MIMO git, viz scripts/audit-publish.sh) — na disku existuje, ale
// nepublikuje se, takže sem test taky nesahá.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXCLUDE_DIRS = new Set(['docs/superpowers', 'test', '.superpowers', '.internal', '.git', 'data', 'node_modules']);
// scripts/audit-publish.sh je pre-push audit skript — musí literálně obsahovat
// tenhle vzorník slov (git grep pattern + vysvětlující komentáře), takže je
// sebereferenční stejně jako tenhle test sám (proto je 'test' v EXCLUDE_DIRS).
const EXCLUDE_FILES = new Set(['scripts/audit-publish.sh']);
const EXTS = new Set(['.js', '.mjs', '.sh', '.html', '.css', '.md', '.webmanifest', '.json']);
const PATTERN = /nocodb|feschu|camaxis|box\.json|onecli|rudy/i;

function shouldSkipDir(relPath) {
  const norm = relPath.split(path.sep).join('/');
  for (const ex of EXCLUDE_DIRS) {
    if (norm === ex || norm.startsWith(ex + '/')) return true;
  }
  return false;
}

function walk(dir, relBase, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.join(relBase, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(rel)) continue;
      walk(full, rel, out);
    } else if (entry.isFile()) {
      const norm = rel.split(path.sep).join('/');
      if (EXTS.has(path.extname(entry.name)) && !EXCLUDE_FILES.has(norm)) out.push({ full, rel });
    }
  }
  return out;
}

test('repo neobsahuje klientský/LK-specifický kód (nocodb|feschu|camaxis|box.json|onecli|rudy)', () => {
  const files = walk(ROOT, '', []);
  assert.ok(files.length > 20, `čekal jsem víc než 20 souborů ke skenu, mám jen ${files.length} — kontrola výluk`);
  const hits = [];
  for (const f of files) {
    const content = fs.readFileSync(f.full, 'utf-8');
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (PATTERN.test(line)) hits.push(`${f.rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  assert.deepEqual(hits, [], `nalezeny zbytky klientského kódu:\n${hits.join('\n')}`);
});
