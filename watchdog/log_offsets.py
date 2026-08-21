#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Nové řádky sledovaných logů od minulého běhu watchdogu.

Volá ho check.sh (jediný sběr dat pro hodinový cron-watchdog). Drží byte-offsety
per log v JSON state souboru (argv[1], typicky state/offsets.json); po přečtení
offsety atomicky aktualizuje (os.replace). VŽDY končí exit 0 — chyba čtení
jednoho logu nesmí shodit celý snapshot.

Chování per log:
- první čtení        → vypíše posledních FIRST_LINES řádků, offset = konec souboru
- beze změny         → jeden řádek „beze změny od minulého běhu"
- log se zmenšil     → rotace/přepis, čte od začátku
- hodně nových řádků → prvních 10 + posledních 50, zbytek shrne počtem
- nedokončený řádek na konci (log se právě píše) → nechá na příští běh
"""
import json
import os
import sys

FIRST_LINES = 50            # kolik řádků ukázat při prvním čtení logu
MAX_LINES = 60              # strop vypsaných nových řádků na log
TAIL_BYTES = 256 * 1024     # kolik bajtů od konce číst při prvním čtení
MAX_CHUNK = 2 * 1024 * 1024  # strop čtení nových dat (ochrana RAM)
IND = "    "


def emit(lines):
    """Vypíše řádky se stropem MAX_LINES (10 + shrnutí + 50)."""
    if len(lines) > MAX_LINES:
        head, tail = lines[:10], lines[-50:]
        for ln in head:
            print(IND + ln)
        print(IND + "… ({} řádků vynecháno) …".format(len(lines) - len(head) - len(tail)))
        for ln in tail:
            print(IND + ln)
    else:
        for ln in lines:
            print(IND + ln)


def read_new(path, start, size):
    """Přečte <start, size) a vrátí (řádky, nový_offset).

    Nedokončený poslední řádek (bez \\n) nevypisuje ani nezapočítá do offsetu —
    doběhne příště. Přírůstek > MAX_CHUNK zkrátí na poslední MAX_CHUNK bajtů.
    """
    skipped_note = None
    seek_pos = start
    if size - start > MAX_CHUNK:
        seek_pos = size - MAX_CHUNK
        skipped_note = "… (přírůstek {} B je příliš velký, ukazuji jen konec) …".format(size - start)
    with open(path, "rb") as f:
        f.seek(seek_pos)
        data = f.read(size - seek_pos)
    end = seek_pos + len(data)
    if data and not data.endswith(b"\n"):
        cut = data.rfind(b"\n")
        if cut == -1:
            # žádný dokončený řádek — počkej na příští běh
            return [], (start if skipped_note is None else end)
        end -= len(data) - (cut + 1)
        data = data[: cut + 1]
    lines = data.decode("utf-8", "replace").splitlines()
    if skipped_note:
        lines.insert(0, skipped_note)
    return lines, end


def first_read(path, size):
    """První čtení: posledních FIRST_LINES řádků z konce souboru."""
    with open(path, "rb") as f:
        if size > TAIL_BYTES:
            f.seek(size - TAIL_BYTES)
            data = f.read()
            nl = data.find(b"\n")
            data = data[nl + 1:] if nl != -1 else b""
        else:
            data = f.read()
    lines = data.decode("utf-8", "replace").splitlines()
    return lines[-FIRST_LINES:]


def main():
    if len(sys.argv) < 2:
        print("použití: log_offsets.py <state.json> [log ...]")
        return 0
    state_path = sys.argv[1]
    logs = list(dict.fromkeys(sys.argv[2:]))  # dedup, zachovej pořadí

    try:
        with open(state_path, encoding="utf-8") as f:
            offsets = json.load(f)
        if not isinstance(offsets, dict):
            offsets = {}
    except Exception:
        offsets = {}

    new_offsets = {}
    for path in logs:
        print("· " + path)
        try:
            if not os.path.isfile(path):
                print(IND + "log neexistuje (u denních/týdenních jobů normální)")
                continue
            size = os.path.getsize(path)
            prev = offsets.get(path)
            if not isinstance(prev, int) or prev < 0:
                prev = None
            if prev is None:
                lines = first_read(path, size)
                print(IND + "(první čtení — posledních {} řádků, příště už jen přírůstky)".format(len(lines)))
                emit(lines)
                new_offsets[path] = size
            elif prev > size:
                print(IND + "(log se zmenšil {} → {} B — rotace/přepis, čtu od začátku)".format(prev, size))
                lines, end = read_new(path, 0, size)
                emit(lines)
                new_offsets[path] = end
            elif prev == size:
                print(IND + "beze změny od minulého běhu")
                new_offsets[path] = prev
            else:
                lines, end = read_new(path, prev, size)
                if lines:
                    print(IND + "(+{} nových řádků)".format(len(lines)))
                    emit(lines)
                else:
                    print(IND + "(jen nedokončený řádek bez newline — doběhne příště)")
                new_offsets[path] = end
        except Exception as exc:  # nikdy neshodit snapshot
            print(IND + "(chyba čtení: {})".format(exc))
            if isinstance(offsets.get(path), int):
                new_offsets[path] = offsets[path]

    try:
        tmp = state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(new_offsets, f, ensure_ascii=False, indent=1, sort_keys=True)
            f.write("\n")
        os.replace(tmp, state_path)
    except Exception as exc:
        print("(varování: offsety se nepodařilo uložit: {})".format(exc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
