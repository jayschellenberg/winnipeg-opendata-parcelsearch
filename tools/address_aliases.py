#!/usr/bin/env python3
"""
Civic-address aliases for a property — Winnipeg and the rest of Manitoba.

Both assessment sites index one address per roll, but a property answers to
more than one, so searching an alias misses it. The two jurisdictions publish
completely different data, so the alias has to be recovered two ways.

WINNIPEG (default) — winnipegassessment.com indexes one *primary* civic address
per roll, while the parcel usually carries several. There is no roll -> alias
table in open data, so it is reconstructed spatially:

  Assessment Parcels (d4mq-wa44)  -> roll number + parcel polygon + primary address
  Addresses         (cam2-ii3u)   -> every civic address point in the city

Every address point falling inside the parcel polygon is an address for that
roll. Points are assigned to the parcel that actually contains them, so a
neighbour's address on a shared boundary is not reported as an alias.
"1393 Border St" resolves to roll 07560170500, indexed as "1347 Border Street".

MANITOBA (--mb) — Manitoba publishes NO province-wide civic-address dataset, so
there is no second layer to join. The aliases live inside the single
ROLL_ENTRY.Property_Address string, in two forms:

  civic range      "1511 - 1519 26TH ST"        8,964 rows
  unit prefix      "Unit 10    - 1015 26TH ST"  5,972 rows

The first answers to every number between its endpoints, the second to its
building's number. "1515 26th St" resolves to roll 510875; "1015 26th St"
resolves to a building plus its unit rolls, all of which MAO holds separately.

The span parsing below mirrors parseCivicAddressSpans in the Manitoba web app
(mb-parcelsearch/web/src/lib/civicRange.js). Keep the two in step — in
particular the rule that only a SPACED hyphen marks a range, because every
unspaced one in that column is a legal description ("15-42-244" is lot 15 of
plan 42, not civic 15 to 42).

Usage:
    python address_aliases.py 1393 Border St
    python address_aliases.py --roll 07560170500
    python address_aliases.py --mb 1515 26th St --muni "BRANDON (CITY)"
    python address_aliases.py --mb --roll 510875
    python address_aliases.py --batch queries.txt --csv aliases.csv
"""

import argparse
import csv
import json
import re
import sys
import urllib.parse
import urllib.request

DOMAIN = "https://data.winnipeg.ca/resource"
PARCELS = "d4mq-wa44"      # Map of Assessment Parcels
ADDRESSES = "cam2-ii3u"    # Addresses

# Manitoba (everything except Winnipeg): one ArcGIS layer, one address string.
ROLL_ENTRY = ("https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/"
              "services/ROLL_ENTRY/FeatureServer/0/query")
ROLL_ENTRY_FIELDS = ("Roll_No_Txt,Property_Address,Municipality,"
                     "Muni_Name_With_Typ,Dwelling_Units,Total_Value,"
                     "Frontage_or_Area,Asmt_Rpt_Url")

# Assessment Parcels spells street types out; Addresses abbreviates them.
STREET_TYPES = {
    "ST": "STREET", "STREET": "STREET",
    "AVE": "AVENUE", "AV": "AVENUE", "AVENUE": "AVENUE",
    "RD": "ROAD", "ROAD": "ROAD",
    "DR": "DRIVE", "DRIVE": "DRIVE",
    "BLVD": "BOULEVARD", "BOULEVARD": "BOULEVARD",
    "CR": "CRESCENT", "CRES": "CRESCENT", "CRESCENT": "CRESCENT",
    "PL": "PLACE", "PLACE": "PLACE",
    "BAY": "BAY", "WAY": "WAY", "LANE": "LANE", "LN": "LANE",
    "PKWY": "PARKWAY", "PARKWAY": "PARKWAY",
    "TRL": "TRAIL", "TRAIL": "TRAIL",
    "HWY": "HIGHWAY", "HIGHWAY": "HIGHWAY",
    "CIR": "CIRCLE", "CIRCLE": "CIRCLE",
    "CT": "COURT", "COURT": "COURT",
    "SQ": "SQUARE", "SQUARE": "SQUARE",
    "GATE": "GATE", "GDNS": "GARDENS", "GARDENS": "GARDENS",
    "TERR": "TERRACE", "TERRACE": "TERRACE",
    "PROM": "PROMENADE", "PROMENADE": "PROMENADE",
    "CLOSE": "CLOSE", "COVE": "COVE", "LOOP": "LOOP", "RISE": "RISE",
    "ROW": "ROW", "RUN": "RUN", "VIEW": "VIEW", "WALK": "WALK",
}
DIRECTIONS = {"N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST"}


# ---------------------------------------------------------------- SODA access

def soda(resource, **params):
    url = "%s/%s.json?%s" % (DOMAIN, resource, urllib.parse.urlencode(params))
    req = urllib.request.Request(url, headers={"User-Agent": "wpg-address-aliases/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


# ------------------------------------------------------------- input handling

def parse_address(text):
    """'1393 Border St E' -> ('1393', 'BORDER', 'STREET', 'E'). Type/dir may be None."""
    tokens = re.sub(r"[.,]", " ", text.upper()).split()
    if not tokens:
        return None
    m = re.match(r"^(\d+)([A-Z]?)$", tokens[0])
    if not m:
        return None
    number, rest = m.group(1), tokens[1:]
    direction = None
    if rest and rest[-1] in DIRECTIONS:
        direction = rest.pop()
    stype = None
    if len(rest) > 1 and rest[-1] in STREET_TYPES:
        stype = STREET_TYPES[rest.pop()]
    return number, " ".join(rest), stype, direction


def esc(value):
    return value.replace("'", "''")


def summarize_rolls(rolls, keep=4):
    """Condo sites carry hundreds of unit rolls — show a few, count the rest."""
    if len(rolls) <= keep:
        return ", ".join(rolls)
    return "%s (+%d more)" % (", ".join(rolls[:keep]), len(rolls) - keep)


# ------------------------------------------------------------------- geometry

def ring_contains(ring, x, y):
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < xin:
                inside = not inside
    return inside


def polygon_contains(geom, x, y):
    """Point-in-(multi)polygon, honouring holes. GeoJSON dict from SODA."""
    if not geom:
        return False
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        if not poly:
            continue
        if ring_contains(poly[0], x, y) and not any(ring_contains(h, x, y) for h in poly[1:]):
            return True
    return False


def bounds(geom):
    xs, ys = [], []
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        for ring in poly:
            for pt in ring:
                xs.append(pt[0])
                ys.append(pt[1])
    return min(xs), min(ys), max(xs), max(ys)


# ----------------------------------------------------------------- the lookup

def parcel_by_roll(roll):
    rows = soda(PARCELS, **{"$where": "roll_number='%s'" % esc(roll), "$limit": "5"})
    return rows[0] if rows else None


def parcel_at_point(lon, lat):
    """Parcels containing a point. A condo site returns one row per unit roll."""
    return soda(PARCELS, **{
        "$where": "intersects(geometry, 'POINT(%.10f %.10f)')" % (lon, lat),
        "$limit": "2000",
    })


def find_address_point(number, street, stype, direction):
    clauses = ["street_number='%s'" % esc(number), "street_name='%s'" % esc(street)]
    rows = soda(ADDRESSES, **{"$where": " and ".join(clauses), "$limit": "50"})
    if stype and len(rows) > 1:
        typed = [r for r in rows
                 if STREET_TYPES.get((r.get("street_type") or "").upper()) == stype]
        rows = typed or rows
    if direction and len(rows) > 1:
        dirs = [r for r in rows
                if (r.get("street_direction") or "").upper().startswith(direction[0])]
        rows = dirs or rows
    return rows


def resolve_parcel(query):
    """query -> (parcel row, note). Accepts a roll number or a civic address."""
    if re.fullmatch(r"\d{9,11}", query.strip()):
        parcel = parcel_by_roll(query.strip())
        return (parcel, None) if parcel else (None, "no parcel with roll %s" % query)

    parsed = parse_address(query)
    if not parsed:
        return None, "could not parse %r as a roll number or civic address" % query
    number, street, stype, direction = parsed

    # An address point is the reliable route: open data has one for aliases too.
    points = find_address_point(number, street, stype, direction)
    for pt in points:
        loc = pt.get("location") or {}
        if not loc.get("longitude"):
            continue
        hits = parcel_at_point(float(loc["longitude"]), float(loc["latitude"]))
        if hits:
            note = None
            if len(hits) > 1:
                # Condo units are stacked on one footprint; any unit roll gives
                # the same address list, so report the site rather than a unit.
                note = ("%d rolls sit on this footprint (condo or multi-roll site), so the "
                        "address list covers the whole site, not one unit. Rolls: %s"
                        % (len(hits), summarize_rolls([h["roll_number"] for h in hits])))
            return hits[0], note

    # Fall back to the parcel's own primary address string.
    where = "street_number='%s' and street_name='%s'" % (esc(number), esc(street))
    rows = soda(PARCELS, **{"$where": where, "$limit": "5"})
    if rows:
        return rows[0], "matched the parcel's primary address; no address point found"
    if points:
        return None, "address point exists but falls outside every assessment parcel"
    return None, "no address point or parcel found for %r" % query


def aliases_for_parcel(parcel):
    """All civic addresses whose point lies inside this parcel's polygon."""
    geom = parcel.get("geometry")
    if not geom:
        return [], "parcel has no geometry in open data"
    minx, miny, maxx, maxy = bounds(geom)
    pad = 0.00005  # ~5 m, catches points surveyed just off the lot line
    rows = soda(ADDRESSES, **{
        "$where": "within_box(location, %.8f, %.8f, %.8f, %.8f)"
                  % (maxy + pad, minx - pad, miny - pad, maxx + pad),
        "$select": "full_address,street_number,street_name,street_type,neighbourhood,location",
        "$limit": "5000",
    })

    # Neighbouring parcels overlap that bbox, so assign each point to the parcel
    # that actually contains it rather than claiming everything in the box.
    corners = [(minx - pad, miny - pad), (maxx + pad, miny - pad), (maxx + pad, maxy + pad),
               (minx - pad, maxy + pad), (minx - pad, miny - pad)]
    neighbours = soda(PARCELS, **{
        "$where": "intersects(geometry, 'POLYGON((%s))')"
                  % ", ".join("%.8f %.8f" % pt for pt in corners),
        "$select": "roll_number,full_address,geometry",
        "$limit": "3000",
    })

    roll = parcel["roll_number"]
    out = []
    for row in rows:
        loc = row.get("location") or {}
        if not loc.get("longitude"):
            continue
        x, y = float(loc["longitude"]), float(loc["latitude"])
        owners = [n["roll_number"] for n in neighbours if polygon_contains(n.get("geometry"), x, y)]
        if roll in owners:
            out.append({
                "address": row["full_address"],
                "street_number": row.get("street_number", ""),
                "street_name": row.get("street_name", ""),
                "street_type": row.get("street_type", ""),
                "neighbourhood": row.get("neighbourhood", ""),
                "shared_with": [r for r in owners if r != roll],
                "lon": x,
                "lat": y,
            })

    def sort_key(a):
        digits = re.sub(r"\D", "", a["street_number"])
        return (a["street_name"], a["street_type"], int(digits) if digits else 0)

    return sorted(out, key=sort_key), None


def same_address(primary, alias):
    """'1347 BORDER STREET' vs '1347 BORDER ST' -> True.

    A condo roll's primary address carries a unit prefix ('1805-55 NASSAU
    STREET N'); that is the same civic address as the site's address point.
    """
    def norm(s):
        s = re.sub(r"^\s*[\w]+\s*-\s*(?=\d)", "", (s or "").upper())
        toks = re.sub(r"[.,]", " ", s).split()
        return " ".join(STREET_TYPES.get(t, t) for t in toks)
    return norm(primary) == norm(alias)


def lookup(query):
    parcel, note = resolve_parcel(query)
    if not parcel:
        return {"query": query, "error": note}
    aliases, geom_note = aliases_for_parcel(parcel)
    return {
        "query": query,
        "roll_number": parcel["roll_number"],
        "primary_address": parcel.get("full_address", ""),
        "neighbourhood": parcel.get("neighbourhood_area", ""),
        "property_use": parcel.get("property_use_code", ""),
        "detail_url": (parcel.get("detail_url") or {}).get("url", ""),
        "addresses": aliases,
        "notes": [n for n in (note, geom_note) if n],
    }


# ------------------------------------------------------------- Manitoba (MB)
#
# Ported from mb-parcelsearch/web/src/lib/civicRange.js. See the module
# docstring: change one, change the other.

# A civic number as written, optionally with one letter suffix.
RE_MB_PLAIN = re.compile(r"^(\d+)([A-Za-z]?)\s")
# The rural grid form that splits the number at the thousands mark:
# "1 106 E ROAD 71 N" is civic 1106E.
RE_MB_GROUPED = re.compile(r"^(\d{1,3})((?:\s+\d{3})+)\s*([A-Za-z]?)(?=\s|$)")
# A range. The SPACED hyphen is the whole discriminator — an unspaced one is
# always a legal description in this column.
RE_MB_RANGE = re.compile(r"^(\d+)([A-Za-z]?)\s+-\s+(\d+)([A-Za-z]?)(?=\s|$)")
# A unit designator ahead of the building's civic address.
RE_MB_UNIT = re.compile(r"^(?:UNIT|APT|SUITE|STE)\s+\S+\s*-\s*(?=\d)", re.I)


def mb_civic_key(digits, letter):
    """num*100 + letter index, so 100 < 100A < 100B < 101."""
    try:
        num = int(digits)
    except (TypeError, ValueError):
        return None
    return num * 100 + (ord(letter.upper()) - 64 if letter else 0)


def mb_address_keys(text):
    """Point keys for a non-range address, closed-up reading first.

    The internal space is genuinely ambiguous — "1 106 E ROAD 71 N" is civic
    1106, but "32 502 RD" is civic 32 on road 502 — so both readings are kept
    rather than guessed between.
    """
    s = str(text or "")
    keys = []
    m = RE_MB_PLAIN.match(s)
    if m:
        k = mb_civic_key(m.group(1), m.group(2))
        if k is not None:
            keys.append(k)
    g = RE_MB_GROUPED.match(s)
    if g:
        k = mb_civic_key(g.group(1) + re.sub(r"\s+", "", g.group(2)), g.group(3))
        if k is not None and k not in keys:
            keys.append(k)
    return keys


def mb_address_spans(text):
    """Inclusive [lo, hi] civic spans an address occupies.

    "1525 26TH ST"              -> [(152500, 152500)]
    "1511 - 1519 26TH ST"       -> [(151100, 151999)]
    "Unit 10   - 1015 26TH ST"  -> [(101500, 101500)]
    "DESC NE22-21-3E"           -> []
    """
    if not text:
        return []
    s = RE_MB_UNIT.sub("", str(text))
    m = RE_MB_RANGE.match(s)
    if m:
        lo = mb_civic_key(m.group(1), m.group(2))
        hi = (mb_civic_key(m.group(3), m.group(4)) if m.group(4)
              else int(m.group(3)) * 100 + 99)
        if lo is not None and hi is not None and hi >= lo:
            return [(lo, hi)]
    return [(k, k) for k in mb_address_keys(s)]


def mb_bound(number, letter, kind):
    """A searched number as a comparison key, matching the app's asymmetry:
    a bare upper bound covers that number's letter-suffixed variants."""
    num = int(number)
    if letter:
        return num * 100 + (ord(letter.upper()) - 64)
    return num * 100 + (99 if kind == "upper" else 0)


def mb_canonical_roll(raw):
    """'510875' -> '510875.000', the form Roll_No_Txt stores."""
    s = str(raw or "").strip()
    m = re.match(r"^(\d+)(?:\.(\d*))?$", s)
    if not m:
        return s
    return "%s.%s" % (m.group(1), (m.group(2) or "").ljust(3, "0")[:3])


def mb_query(where, limit=2000):
    params = {
        "where": where, "outFields": ROLL_ENTRY_FIELDS,
        "returnGeometry": "false", "resultRecordCount": str(limit), "f": "json",
    }
    url = ROLL_ENTRY + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "wpg-address-aliases/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        payload = json.load(r)
    if "error" in payload:
        raise RuntimeError(payload["error"].get("message", "ArcGIS error"))
    return [f["attributes"] for f in payload.get("features", [])]


def mb_esc(value):
    return str(value).replace("'", "''")


def mb_street_clause(street):
    """Substring match on the street name, across the spacing variants the
    rural grid addresses use ("1106" also written "1 106")."""
    base = re.sub(r"\s+", " ", str(street or "").strip().upper())
    if not base:
        return None
    variants = [base]
    collapsed = base
    while True:
        nxt = re.sub(r"(\d)\s+(\d)", r"\1\2", collapsed)
        if nxt == collapsed:
            break
        collapsed = nxt
    grouped = re.sub(r"\d{4,}", lambda m: " ".join(
        [m.group(0)[:len(m.group(0)) % 3 or 3]]
        + [m.group(0)[i:i + 3] for i in range(len(m.group(0)) % 3 or 3, len(m.group(0)), 3)]
    ), base)
    for v in (collapsed, grouped):
        if v and v not in variants:
            variants.append(v)
    return "(%s)" % " OR ".join(
        "UPPER(Property_Address) LIKE '%%%s%%'" % mb_esc(v) for v in variants)


def mb_parse_query(text):
    """'1515 26th St' -> (number, letter, street-term). Street term keeps the
    type token: Property_Address is one string, so 'ST' helps narrow it."""
    s = re.sub(r"[.,]", " ", str(text).upper()).strip()
    m = re.match(r"^(\d+)([A-Z]?)\s+(.*\S)$", s)
    if not m:
        return None
    return m.group(1), m.group(2), m.group(3)


def mb_rolls_at(street_clause, muni, lo, hi):
    """Every roll whose address span overlaps [lo, hi] on this street."""
    clauses = [c for c in (street_clause,) if c]
    if muni:
        clauses.append("Muni_Name_With_Typ = '%s'" % mb_esc(muni))
    rows = mb_query(" AND ".join(clauses) if clauses else "1=1")
    hits = []
    for row in rows:
        for span_lo, span_hi in mb_address_spans(row.get("Property_Address")):
            if span_lo <= hi and span_hi >= lo:
                hits.append(row)
                break
    return hits


def mb_span_note(address, number):
    """Why this roll answers to the searched number."""
    spans = mb_address_spans(address)
    if not spans:
        return None
    if RE_MB_UNIT.match(str(address or "")):
        return "unit address - the civic number is the building's"
    lo, hi = spans[0]
    if hi - lo >= 100:
        return ("address is a RANGE - it answers to any civic number from "
                "%d to %d" % (lo // 100, hi // 100))
    if number is not None and lo // 100 != int(number):
        return "matched on the split-number reading of the address"
    return None


def mb_subject_rank(address, lo, hi):
    """Sort key picking which matching roll to lead with: a plain address that
    IS the searched number first, then a range covering it, then units."""
    s = str(address or "")
    spans = mb_address_spans(s)
    if RE_MB_UNIT.match(s):
        return (2, s)
    if spans and spans[0][0] == spans[0][1] and lo <= spans[0][0] <= hi:
        return (0, s)
    return (1, s)


def mb_display_roll(roll):
    """'510875.000' -> '510875'. The .000 is storage padding; MAO and the
    web app both show the bare number."""
    s = str(roll or "")
    return s[:-4] if s.endswith(".000") else s


def mb_lookup(query, muni=None):
    q = str(query).strip()
    if re.fullmatch(r"\d+(?:\.\d*)?", q):
        roll = mb_canonical_roll(q)
        where = "Roll_No_Txt = '%s'" % mb_esc(roll)
        if muni:
            where += " AND Muni_Name_With_Typ = '%s'" % mb_esc(muni)
        rows = mb_query(where)
        if not rows:
            return {"query": query, "error": "no parcel with roll %s%s"
                    % (roll, " in %s" % muni if muni else "")}
        if len(rows) > 1 and not muni:
            return {"query": query, "error":
                    "roll %s exists in %d municipalities - add --muni: %s"
                    % (roll, len(rows),
                       ", ".join(sorted(r["Muni_Name_With_Typ"] for r in rows)))}
        subject = rows[0]
        number = None
    else:
        parsed = mb_parse_query(q)
        if not parsed:
            return {"query": query,
                    "error": "could not parse %r as a roll number or civic address" % query}
        number, letter, street = parsed
        lo = mb_bound(number, letter, "lower")
        hi = mb_bound(number, letter, "upper")
        hits = mb_rolls_at(mb_street_clause(street), muni, lo, hi)
        if not hits:
            return {"query": query, "error":
                    "no roll answers to %s%s" % (q, " in %s" % muni if muni else "")}
        # Prefer the roll addressed EXACTLY as typed. Searching "1015 26th St"
        # should lead with the building, not whichever of its unit rolls the
        # service happened to return first.
        hits.sort(key=lambda r: mb_subject_rank(r.get("Property_Address"), lo, hi))
        subject = hits[0]

    # Everything MAO holds separately at the subject's own address. For a
    # range that is the neighbours sharing the span; for a condo it is the
    # building and its units, which are separate rolls with separate reports.
    spans = mb_address_spans(subject.get("Property_Address"))
    siblings = []
    if spans:
        lo, hi = spans[0]
        street_term = re.sub(RE_MB_UNIT, "", subject.get("Property_Address") or "")
        street_term = re.sub(r"^[\d\sA-Za-z]*?\d[A-Za-z]?\s+", "", street_term, count=1)
        siblings = mb_rolls_at(mb_street_clause(street_term),
                               subject.get("Muni_Name_With_Typ"), lo, hi)

    return {
        "query": query,
        "roll_number": mb_display_roll(subject.get("Roll_No_Txt")),
        "municipality": subject.get("Muni_Name_With_Typ", ""),
        "primary_address": subject.get("Property_Address", ""),
        "dwelling_units": subject.get("Dwelling_Units"),
        "total_value": subject.get("Total_Value"),
        "frontage_or_area": subject.get("Frontage_or_Area"),
        "detail_url": subject.get("Asmt_Rpt_Url", ""),
        "span_note": mb_span_note(subject.get("Property_Address"), number),
        "rolls": [
            {"roll_number": mb_display_roll(r.get("Roll_No_Txt")),
             "address": r.get("Property_Address", ""),
             "municipality": r.get("Muni_Name_With_Typ", ""),
             "detail_url": r.get("Asmt_Rpt_Url", "")}
            for r in sorted(siblings, key=lambda r: r.get("Roll_No_Txt", ""))
        ],
    }


def report_mb(result, stream=sys.stdout):
    if result.get("error"):
        print("%s: %s" % (result["query"], result["error"]), file=stream)
        return
    print("Query           : %s" % result["query"], file=stream)
    print("Roll number     : %s" % result["roll_number"], file=stream)
    print("Municipality    : %s" % result["municipality"], file=stream)
    print("Assessed as     : %s   <- search MAO with this"
          % result["primary_address"], file=stream)
    if result.get("dwelling_units") not in (None, ""):
        print("Dwelling units  : %s" % result["dwelling_units"], file=stream)
    if result.get("total_value"):
        print("Assessed value  : %s" % result["total_value"], file=stream)
    if result.get("span_note"):
        print("Why it matched  : %s" % result["span_note"], file=stream)
    others = [r for r in result["rolls"] if r["roll_number"] != result["roll_number"]]
    print("", file=stream)
    if others:
        print("Other rolls at this address (%d) - MAO holds each separately:"
              % len(others), file=stream)
        for r in others:
            print("  %-14s %s" % (r["roll_number"], r["address"]), file=stream)
    else:
        print("No other roll shares this address.", file=stream)
    if result.get("detail_url"):
        print("\n%s" % result["detail_url"], file=stream)


def write_csv_mb(results, path):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["query", "roll_number", "assessed_address", "municipality",
                    "is_subject", "other_roll", "other_address", "mao_url"])
        for r in results:
            if r.get("error"):
                w.writerow([r["query"], "", "", "", "", "", "", r["error"]])
                continue
            for o in r["rolls"]:
                w.writerow([r["query"], r["roll_number"], r["primary_address"],
                            r["municipality"],
                            "Y" if o["roll_number"] == r["roll_number"] else "N",
                            o["roll_number"], o["address"], o["detail_url"]])


# --------------------------------------------------------------------- output

def report(result, stream=sys.stdout):
    if result.get("error"):
        print("%s: %s" % (result["query"], result["error"]), file=stream)
        return
    print("Query           : %s" % result["query"], file=stream)
    print("Roll number     : %s" % result["roll_number"], file=stream)
    print("Primary address : %s   <- search the assessment site with this"
          % result["primary_address"], file=stream)
    if result["neighbourhood"]:
        print("Neighbourhood   : %s" % result["neighbourhood"], file=stream)
    if result["property_use"]:
        print("Property use    : %s" % result["property_use"], file=stream)
    others = [a for a in result["addresses"]
              if not same_address(result["primary_address"], a["address"])]
    print("", file=stream)
    if others:
        print("Also addressed as (%d):" % len(others), file=stream)
        for a in others:
            flag = ("   [also inside roll %s]" % summarize_rolls(a["shared_with"])
                    if a["shared_with"] else "")
            print("  %s%s" % (a["address"], flag), file=stream)
    else:
        print("No alias addresses found on this parcel.", file=stream)
    for n in result["notes"]:
        print("\nNote: %s" % n, file=stream)
    if result["detail_url"]:
        print("\n%s" % result["detail_url"], file=stream)


def write_csv(results, path):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["query", "roll_number", "primary_address", "address",
                    "is_primary", "neighbourhood", "lon", "lat", "shared_with_rolls"])
        for r in results:
            if r.get("error"):
                w.writerow([r["query"], "", "", "", "", "", "", "", r["error"]])
                continue
            for a in r["addresses"]:
                w.writerow([r["query"], r["roll_number"], r["primary_address"], a["address"],
                            "Y" if same_address(r["primary_address"], a["address"]) else "N",
                            a["neighbourhood"], "%.8f" % a["lon"], "%.8f" % a["lat"],
                            " ".join(a["shared_with"])])


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("address", nargs="*", help="civic address, e.g. 1393 Border St")
    ap.add_argument("--roll", help="roll number instead of an address")
    ap.add_argument("--mb", "--manitoba", dest="mb", action="store_true",
                    help="search Manitoba (ROLL_ENTRY) instead of Winnipeg")
    ap.add_argument("--muni", help="Manitoba municipality as MAO writes it, "
                                   'e.g. "BRANDON (CITY)" — narrows an ambiguous roll')
    ap.add_argument("--batch", help="file with one address or roll per line")
    ap.add_argument("--csv", help="write every address found to this CSV")
    ap.add_argument("--json", action="store_true", help="print raw JSON instead of a report")
    args = ap.parse_args()
    if args.muni and not args.mb:
        ap.error("--muni applies to --mb searches only (Winnipeg is one municipality)")

    queries = []
    if args.roll:
        queries.append(args.roll)
    if args.address:
        queries.append(" ".join(args.address))
    if args.batch:
        with open(args.batch, encoding="utf-8") as fh:
            queries += [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]
    if not queries:
        ap.error("give an address, --roll, or --batch")

    results = [mb_lookup(q, args.muni) if args.mb else lookup(q) for q in queries]
    if args.json:
        print(json.dumps(results, indent=2))
    else:
        for i, r in enumerate(results):
            if i:
                print("\n" + "-" * 60 + "\n")
            (report_mb if args.mb else report)(r)
    if args.csv:
        (write_csv_mb if args.mb else write_csv)(results, args.csv)
        print("\nWrote %s" % args.csv)
    return 0 if all(not r.get("error") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
