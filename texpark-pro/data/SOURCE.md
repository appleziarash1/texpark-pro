# Bangladesh administrative-area dataset — source & licence

The app resolves a delivery address to the full administrative area offline, so it
never depends on a geocoding service at runtime. This file records where that data
came from and how to rebuild it.

## Sources

| | |
|---|---|
| Registry | `montasim/bangladesh-location-registry` |
| Release | `data-2026.08.04` (pinned) |
| Asset | `address-bd-data-2026.08.04-json.tar.zst` |
| SHA-256 | `9b76179403d735231604aa460031b29b1a60123112f6ea5b27996269c1cd604c` (checked on download) |
| Licence | Government-published data (Open Government Licence); each record carries its `sourceId` |
| Upstream | https://github.com/montasim/bangladesh-location-registry |
| Underlying publishers | BBS Population & Housing Census 2022, Bangladesh Post, LGD, DGHS |
| Retrieved | 2026-10-11 |

| | |
|---|---|
| Name/Bangla layer | `@olism/bd-geo` `1.0.0` — **MIT** |
| Used for | Bangla names for districts and thanas, and older English spellings |
| Downloaded from | https://cdn.jsdelivr.net/npm/@olism/bd-geo@1.0.0/dist/index.cjs |

Neither package is a dependency of the app. Only the extracted names are committed
(`data/bd-locations.json` and the generated `js/bd-locations.js`), so the shipped
app stays dependency-free and works with no network.

### Why the registry

It is the only list found that carries the **whole** hierarchy in one place, each
record traceable to a government publisher: 8 divisions, 64 districts, 495
upazilas, 105 metropolitan thanas, 4762 unions, 329 paurashavas and urban wards.
The older `@olism/bd-geo` list had districts + upazilas/city thanas only, so an
address naming a village had no Union to resolve to. The registry is English-only
below union level, so `@olism/bd-geo` supplies the Bangla district and thana names
that a Bangla address needs.

## Curated additions (in-repo, not from any package)

`tools/gen-bd-locations.js` adds English spelling variants that differ from the
dataset's own name because shopkeepers type the older or phonetic form, e.g.:

- `Chattogram` ← chittagong, chattagram
- `Cumilla` ← comilla
- `Jashore` ← jessore
- `Cox's Bazar` ← coxs bazar, cox bazar
- `Charfasson` ← char fasson
- `Narsingdi` ← narshingdi, norshingdi

It also sets the Dhaka city-corporation names (`Dhaka North`, `Dhaka South`) from
the BBS codes, and adds courier spellings for a few metro thanas (`Uttara` →
`Uttara Purba`).

## Levels and fields

Each record carries the English name and, where known, the Bangla name (`nameBn`),
so a Bangla address matches without a transliteration step.

| Level | Count | Linked to |
|---|---|---|
| Division | 8 | — |
| District (জেলা) | 64 | Division |
| City Corporation | 12 | District (Dhaka has North and South) |
| Thana / Upazila | 600 (495 upazila + 105 metro thana) | District, and City Corporation for metro thanas |
| Union | 4762 | District + Upazila |
| Paurashava | 329 | District only (see limits) |
| Ward | 3142 | a City Corporation or a Paurashava |

## Coverage / limits

- The registry links a **paurashava to its district only**, with
  `relationshipConfidence` of `district-only`/`dghs-code`. The parent upazila is
  therefore **not** invented in the bundle; the form lets the owner pick one.
- The registry's **city-corporation ward** mapping is incomplete for Dhaka: only
  part of Dhaka North's wards are attached. The bundle keeps exactly what the
  source states rather than inventing the rest, so the Ward picker is useful only
  where the source has data. The Thana/City-Corporation levels are complete.
- This is reference data for **detection and validation** only — it is not sent to
  Steadfast and does not change the booking payload. If a location cannot be
  resolved, the app asks the user rather than guessing.

## How to rebuild

```bash
# downloads the pinned release itself and checks its SHA-256
node texpark-pro/tools/gen-bd-locations.js

# or from a directory of the already-extracted json/ tree
node texpark-pro/tools/gen-bd-locations.js /path/to/extracted/json-dir
```

Outputs `texpark-pro/data/bd-locations.json` (reference) and
`texpark-pro/js/bd-locations.js` (the bundle the app loads). Do not hand-edit
either; change the generator or bump `RELEASE`/`VERSION` and rebuild.

## Attribution

Administrative names from the government-published location registry
`data-2026.08.04` (BBS, Bangladesh Post, LGD, DGHS). Bangla names and English
spelling variants from `@olism/bd-geo` (MIT). The bundle header and the
Settings → App Update panel both carry the dataset version.
