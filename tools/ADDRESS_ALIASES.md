# Civic address aliases (Winnipeg and Manitoba)

`address_aliases.py` answers: *what other civic addresses does this property carry, and
which one will the assessment site actually find?*

It covers both jurisdictions, by two completely different methods, because the two
publish completely different data. Winnipeg is the default; `--mb` searches the rest
of Manitoba. Jump to [Manitoba](#manitoba---mb) for that half.

Example: **1393 Border St** is not searchable on winnipegassessment.com. The property is
roll **07560170500**, indexed under **1347 Border Street**, and the same parcel also
carries 1361 / 1377 / 1381 / 1385 / 1393 Border St and 1860–1872 Notre Dame Ave.

## Why it has to be reconstructed

There is **no roll → alias address table in Winnipeg open data**. The two relevant
datasets each hold half the answer:

| Dataset | ID | What it gives |
|---|---|---|
| Map of Assessment Parcels | `d4mq-wa44` | one row per roll: roll number, **primary** address, parcel polygon |
| Addresses | `cam2-ii3u` | one row per civic address point in the city — **including the aliases** — but no roll number |

`d4mq-wa44` carries exactly one `full_address` per roll (the one the assessment site
indexes). `cam2-ii3u` has every address point but no property identifier. Joining them
spatially — address points inside a parcel polygon — recovers the alias set.

## How the join is done

1. Resolve the query to a parcel.
   - A roll number goes straight to `d4mq-wa44`.
   - An address is looked up in `cam2-ii3u` (works for aliases, which is the point), then
     the parcel is found with SoQL `intersects(geometry, 'POINT(lon lat)')`.
2. Pull every address point in the parcel's bounding box, padded ~5 m
   (`within_box`) — some points are surveyed slightly off the lot line.
3. Pull every parcel intersecting that same box and assign each point to the parcel that
   actually contains it (point-in-polygon, holes honoured). Without this step a
   neighbour's address gets claimed as an alias whenever the bounding boxes overlap.

Only points landing inside the target roll's polygon are reported.

## Usage

```bash
python tools/address_aliases.py 1393 Border St
python tools/address_aliases.py --roll 07560170500
python tools/address_aliases.py --batch queries.txt --csv aliases.csv
python tools/address_aliases.py 201 Portage Ave --json
```

Stdlib only — no shapely/geopandas, no API token. `--batch` takes one address or roll per
line (`#` comments allowed); `--csv` writes one row per address with an `is_primary` flag.

## Caveats

- **Condos.** Every unit roll sits on the same footprint, so a point-in-polygon test hits
  hundreds of rolls (55 Nassau St N: 297). The tool reports the site's address list and
  notes the roll count instead of listing them; the alias set is a property of the site,
  not of any one unit.
- **Shared footprints.** When an address point falls inside more than one roll's polygon,
  the extra rolls are listed in `shared_with` (`shared_with_rolls` in the CSV).
- **Address points aren't a mailing list.** They are civic address assignments, so a large
  industrial site can carry a dozen doors that were never used as mailing addresses.
- **Missing address points.** If the alias has no point in `cam2-ii3u`, the tool falls back
  to matching the parcel's own primary address and says so in a note.
- **Parcels with no geometry** in `d4mq-wa44` can't be joined at all; reported as a note.

---

# Manitoba (`--mb`)

Manitoba publishes **no province-wide civic-address dataset** — verified against the
geoportal search API and all 97 services on the province's ArcGIS org. There is no
second layer to join, so the Winnipeg method cannot be ported. Every address the
province has is the one string in `ROLL_ENTRY.Property_Address`, one row per roll.

The aliases live inside that string, in two forms:

| Form | Rows (of 438,135) | Example |
|---|---|---|
| Civic **range** | 8,964 | `1511 - 1519 26TH ST` — Brandon roll 510875 |
| **Unit** ahead of the building address | 5,972 | `Unit 10    - 1015 26TH ST` — roll 525063 |

A range answers to every number between its endpoints, so 1515 26th St is genuinely
on roll 510875. A unit address answers to its building's number, so 1015 26th St
covers a building and its unit rolls — which MAO holds as **separate reports**.

```bash
python tools/address_aliases.py --mb 1515 26th St --muni "BRANDON (CITY)"
python tools/address_aliases.py --mb --roll 510875
python tools/address_aliases.py --mb 1015 26th St --csv units.csv
```

```
Roll number     : 510875
Municipality    : BRANDON (CITY)
Assessed as     : 1511 - 1519 26TH ST   <- search MAO with this
Dwelling units  : 21
Why it matched  : address is a RANGE - it answers to any civic number from 1511 to 1519
```

`--muni` takes the municipality as MAO writes it (`"BRANDON (CITY)"`) and is optional;
it only narrows an address search or disambiguates a roll that exists in more than one
municipality (the tool says so rather than guessing). Rural split-number addresses work
too: `1106 E Road 71 N` finds Rosser roll 76250, stored as `1 106 E ROAD 71 N`.

## Caveats

- **The spaced hyphen is the whole discriminator.** Every *unspaced* hyphen in this
  column is a legal description, not a range: `15-42-244` is lot 15 of plan 42,
  `NW6-6-29W` a quarter section. Loosening the pattern would read thousands of those
  as civic ranges.
- **A range says nothing about which numbers exist.** `1511 - 1519` covers 1515, but
  the province never asserts that 1515 is a real door. The tool reports the span, and
  deliberately does not enumerate it.
- **This logic mirrors the Manitoba web app** (`mb-parcelsearch/web/src/lib/civicRange.js`,
  `parseCivicAddressSpans`). The two are independent implementations of one rule — change
  one, change the other. The app's `civicRange.test.js` is the fuller test surface.
