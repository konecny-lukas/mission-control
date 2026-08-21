#!/usr/bin/env bash
# audit-publish.sh — pre-push audit před zveřejněním repa na GitHub.
#
# Kontroluje, že v gitem trackovaném obsahu nezůstaly:
#   (a) osobní/interní reference (jména, domény, tailnet hostnames, API klíče…)
#   (b) trackované binárky/tajné soubory (databáze, klíče, certifikáty, .env)
#   (c) mc.config.json / mc.env v indexu (produkční konfigurace se nepublikuje)
#
# Exit 0 = čisto, publikovat lze. Exit 1 = nález, oprav a spusť znovu.
#
# Poznámka k allowlistu: repo se publikuje jako github.com/konecny-lukas/mission-control,
# takže řetězec „konecny-lukas" se v package.json/README/INSTALL.md legitimně vyskytuje
# (obsahuje „lukas", ale jde o veřejnou URL adresu repozitáře, ne o únik). Pattern proto
# NEoslabujeme — místo toho z výstupu explicitně odfiltrujeme řádky obsahující „konecny-lukas".
#
# test/no-client-code.test.mjs je vlastní strážce proti návratu klientského kódu (NocoDB/
# feschu/camaxis/box.json/OneCLI/rudy) — jeho regex pattern MUSÍ literálně obsahovat tahle
# slova, aby fungoval, takže je z tohoto skenu vyloučen stejně jako LICENSE/audit-publish.sh
# samo (sebereferenční výskyt, ne únik osobních/klientských dat).

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

status=0

echo "== audit-publish: sken citlivých řetězců =="

# `grep -iE` je case-insensitive, ale NENÍ diakritiko-insensitive — 'á' a 'a'
# jsou jiné bajty, takže 'Lukáš'/'LOUDAVÝM'/'Konečný' základní PATTERN
# (bez diakritiky) tiše obejdou (fix round 1, 2026-08-20: přesně tohle
# proklouzlo do timeline.js a public/styles.css). Řešení dvojí:
#   1) explicitní akcentované varianty rovnou v PATTERN (rychlé, čitelné
#      v hlášce nálezu) — 'konečný' má \b, protože bez hranice slova chytá
#      i běžná česká slova „konečně"/„nekonečný" (falešný pozitiv, ověřeno),
#   2) druhý průchod: celý trackovaný strom se ASCII-přeloží
#      (`iconv -t ASCII//TRANSLIT` — 'Lukáš'→'Lukas', 'LOUDAVÝM'→'LOUDAVYM',
#      i 'Ořech'→'Orech') a znovu se přežene STEJNÝM PATTERN. Tohle je ten
#      obecný „root cause" fix — chytí i budoucí diakritické varianty, které
#      nikdo explicitně nevyjmenoval v bodě 1.
PATTERN='lukas|lkmedia|loudavym|camaxis|feschu|rudy|tail[0-9a-f]{6}|tskey-|sk-ant|AIza|orech|moneyspot|bezdiety|denikalergika|204\.168|167\.233|128\.140|lukáš|loudavý|\bkonečný\b|\bkonecny\b'

# Pathspec výluky sdílené oběma průchody (přímý grep i ASCII-přeložený):
# docs/superpowers je interní (Step 3) a nepublikuje se, LICENSE smí obsahovat
# jméno autora, tenhle skript i test/no-client-code.test.mjs jsou sebereferenční
# strážci a musí pattern/klíčová slova obsahovat doslova, aby fungovaly.
EXCLUDE_PATHSPECS=(':!docs/superpowers' ':!LICENSE' ':!scripts/audit-publish.sh' ':!test/no-client-code.test.mjs')

# Průchod 1: přímý git grep nad trackovaným obsahem (rychlý, přesná čísla řádků).
hits="$(git grep -inE "$PATTERN" -- "${EXCLUDE_PATHSPECS[@]}" 2>/dev/null | grep -v 'konecny-lukas' || true)"

# Průchod 2: stejný PATTERN nad ASCII-přeloženým obsahem stejných souborů —
# obecná ochrana proti JAKÉKOLI diakritické variantě (ne jen těm, co jsme si
# vyjmenovali výš). Binární soubory v repu nejsou (ověřeno), takže iconv nad
# celým trackovaným stromem je bezpečné; chyby převodu (2>/dev/null) tiše
# přeskočíme — jde jen o druhou pojistku nad textem.
fold_hits=""
while IFS= read -r f; do
  [ -f "$f" ] || continue
  folded="$(iconv -f UTF-8 -t ASCII//TRANSLIT < "$f" 2>/dev/null || true)"
  [ -n "$folded" ] || continue
  m="$(printf '%s\n' "$folded" | grep -inE "$PATTERN" | grep -v 'konecny-lukas' || true)"
  if [ -n "$m" ]; then
    fold_hits="${fold_hits}$(printf '%s\n' "$m" | sed "s|^|${f}:|")"$'\n'
  fi
done < <(git ls-files -- "${EXCLUDE_PATHSPECS[@]}" 2>/dev/null)

if [ -n "$hits" ] || [ -n "$fold_hits" ]; then
  echo "NÁLEZ: citlivé řetězce v trackovaných souborech:"
  [ -n "$hits" ] && echo "$hits"
  if [ -n "$fold_hits" ]; then
    echo "-- nálezy jen po ASCII-přeložení (diakritická varianta) --"
    echo "$fold_hits"
  fi
  status=1
else
  echo "OK: žádné citlivé řetězce (mimo docs/superpowers, LICENSE, tento skript, konecny-lukas URL) — ani diakritické varianty."
fi

echo
echo "== audit-publish: trackované tajné/binární soubory =="

secret_files="$(git ls-files | grep -E '\.(db|pem|key|crt)$|(^|/)\.env$' || true)"

if [ -n "$secret_files" ]; then
  echo "NÁLEZ: trackované soubory, které do veřejného repa nepatří:"
  echo "$secret_files"
  status=1
else
  echo "OK: žádné *.db/*.pem/*.key/*.crt/.env v indexu."
fi

echo
echo "== audit-publish: mc.config.json / mc.env v indexu =="

# Jen kořen repa — .gitignore ignoruje `/mc.config.json` a `/mc.env` stejně
# (anchored), takže testovací fixtury (test/fixtures/mc.config.json — bez
# osobních dat, potřebné pro `node --test`) tímhle nálezem NEJSOU.
config_files="$(git ls-files | grep -E '^mc\.config\.json$|^mc\.env$' || true)"

if [ -n "$config_files" ]; then
  echo "NÁLEZ: produkční konfigurace v indexu:"
  echo "$config_files"
  status=1
else
  echo "OK: mc.config.json ani mc.env nejsou v indexu (jen *.example.* a test fixtury)."
fi

echo
if [ "$status" -eq 0 ]; then
  echo "AUDIT ČISTÝ — lze publikovat."
else
  echo "AUDIT NAŠEL PROBLÉMY — oprav výše a spusť znovu."
fi

exit "$status"
