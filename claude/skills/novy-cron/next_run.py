#!/usr/bin/env python3
"""next_run.py — spočítá příští spuštění cron výrazu (důkazní krok skillu novy-cron).

Použití:
  python3 next_run.py "30 5 * * *"           # 3 příští běhy
  python3 next_run.py "40 0-2,4-23 * * *" 5  # 5 příštích běhů
  python3 next_run.py --line '0 23 * * 0 /bin/bash /home/user/x.sh >> /home/user/x.log 2>&1'

Čistý stdlib (croniter nemusí být nainstalovaný). Počítá v LOKÁLNÍM čase — tedy
ve stejném pásmu, ve kterém plánuje cron démon. Pásmo lze přepsat proměnnou
prostředí TZ (např. `TZ=Europe/Prague python3 next_run.py "30 5 * * *"`);
bez ní se použije systémové nastavení stroje.

Podporuje: * , - / a čísla; den v týdnu 0-7 (0 i 7 = neděle). DOM/DOW se
kombinují OR sémantikou jako ve vixie-cronu (obě pole omezená => stačí shoda
jednoho). Jména dnů/měsíců (MON, JAN…) nepodporuje — použij čísla.
"""
import os
import sys
from datetime import datetime, timedelta

try:  # zoneinfo je ve stdlib od Pythonu 3.9; bez něj se jede na systémovém čase
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

FIELD_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]  # min hod dom mon dow


def tz_label():
    """Jak se jmenuje pásmo, ve kterém počítáme (jen pro výpis)."""
    tzname = os.environ.get("TZ")
    if tzname and ZoneInfo is not None:
        try:
            ZoneInfo(tzname)
            return tzname
        except Exception:
            pass
    return "systémové pásmo"


def local_now():
    """Aktuální čas v pásmu cronu: $TZ, jinak systémové (vždy naivní datetime)."""
    tzname = os.environ.get("TZ")
    if tzname and ZoneInfo is not None:
        try:
            return datetime.now(ZoneInfo(tzname)).replace(tzinfo=None)
        except Exception:
            pass  # neznámé pásmo -> tiše systémový čas
    return datetime.now()


def expand(field, lo, hi, is_dow=False):
    """Rozbalí jedno cron pole na množinu povolených hodnot."""
    vals = set()
    for part in field.split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/", 1)
            step = int(s)
            if step < 1:
                raise ValueError("krok /0 nedává smysl")
        if part == "*":
            start, end = lo, hi
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
        else:
            v = int(part)
            # samotné číslo s krokem ("5/15") = od čísla nahoru, bez kroku jen to číslo
            start, end = v, (hi if step > 1 else v)
        if not (lo <= start <= end <= hi):
            raise ValueError(f"hodnota mimo rozsah {lo}-{hi}: {part!r}")
        for v in range(start, end + 1, step):
            vals.add(v)
    if is_dow and 7 in vals:  # 7 = neděle = 0
        vals.discard(7)
        vals.add(0)
    return vals


def parse_expr(expr):
    fields = expr.split()
    if len(fields) != 5:
        raise ValueError(f"očekávám 5 polí (min hod dom mon dow), dostal jsem {len(fields)}: {expr!r}")
    sets = [expand(f, lo, hi, is_dow=(i == 4)) for i, (f, (lo, hi)) in enumerate(zip(fields, FIELD_RANGES))]
    dom_star = fields[2] == "*"
    dow_star = fields[4] == "*"
    return sets, dom_star, dow_star


def matches(dt, sets, dom_star, dow_star):
    minute, hour, dom, mon, dow = sets
    if dt.minute not in minute or dt.hour not in hour or dt.month not in mon:
        return False
    dom_ok = dt.day in dom
    dow_ok = ((dt.weekday() + 1) % 7) in dow  # python Po=0 → cron Ne=0
    if dom_star and dow_star:
        return True
    if dom_star:
        return dow_ok
    if dow_star:
        return dom_ok
    return dom_ok or dow_ok  # vixie-cron OR sémantika


def next_runs(expr, count=3, now=None):
    sets, dom_star, dow_star = parse_expr(expr)
    dt = (now or local_now()).replace(second=0, microsecond=0) + timedelta(minutes=1)
    out = []
    for _ in range(527040):  # ~366 dní po minutě — víc nemá smysl
        if matches(dt, sets, dom_star, dow_star):
            out.append(dt)
            if len(out) >= count:
                break
        dt += timedelta(minutes=1)
    return out


def rel(delta):
    """Lidsky čitelné 'za kolik' (dny/hodiny/minuty)."""
    total = int(delta.total_seconds() // 60)
    d, rem = divmod(total, 1440)
    h, m = divmod(rem, 60)
    parts = []
    if d:
        parts.append(f"{d} d")
    if h:
        parts.append(f"{h} h")
    parts.append(f"{m} min")
    return "za " + " ".join(parts)


def main(argv):
    args = list(argv)
    if not args or args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    if args[0] == "--line":
        if len(args) < 2:
            print("❌ --line vyžaduje celý crontab řádek v uvozovkách", file=sys.stderr)
            return 1
        tokens = args[1].split()
        if tokens and tokens[0].startswith("@"):
            print(f"❌ {tokens[0]} (např. @reboot) nemá pravidelný next-run — popiš ho slovně", file=sys.stderr)
            return 1
        expr = " ".join(tokens[:5])
        count = 3
    else:
        expr = args[0]
        count = int(args[1]) if len(args) > 1 else 3
    try:
        runs = next_runs(expr, count)
    except ValueError as e:
        print(f"❌ neplatný cron výraz: {e}", file=sys.stderr)
        return 1
    now = local_now()
    days = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"]
    tz = tz_label()
    print(f"cron výraz : {expr}")
    print(f"teď ({tz}): {now:%Y-%m-%d %H:%M} ({days[now.weekday()]})")
    if not runs:
        print("⚠ žádný běh v příštích 366 dnech (zkontroluj dom/mon kombinaci)")
        return 1
    for r in runs:
        print(f"  → {r:%Y-%m-%d %H:%M} ({days[r.weekday()]})  {rel(r - now)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
