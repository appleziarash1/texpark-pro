# Bangladesh district / upazila / thana dataset — source & licence

The app resolves a delivery address to a District + Thana/Upazila offline, so it
never depends on a geocoding service at runtime. This file records where that data
came from and how to rebuild it.

## Source

| | |
|---|---|
| Package | `@olism/bd-geo` |
| Version | `1.0.0` (pinned) |
| Licence | **MIT** |
| Upstream | https://github.com/mohammad-oliullah/bd-geo |
| Downloaded from | https://cdn.jsdelivr.net/npm/@olism/bd-geo@1.0.0/dist/index.cjs |
| Retrieved | 2026-10-11 |

The package is **not** a dependency of the app. Only the extracted English/Bangla
name lists are committed (`data/bd-locations.json` and the generated
`js/bd-locations.js`), so the shipped app stays dependency-free.

### Why this source

It pairs each of the 64 districts with its **556 upazilas _and_ the city thanas**
(Dhaka's Mirpur, Dhanmondi, Badda, Gulshan, … ; Chattogram's Kotwali, Pahartali, …).
The government upazila lists omit the city thanas — a Dhaka address would resolve
to a district with no usable area, which is exactly the failure this feature fixes.

## Curated additions (in-repo, not from the package)

`tools/gen-bd-locations.js` adds English **spelling variants** that differ from the
dataset's own name because shopkeepers type the older or phonetic form, e.g.:

- `Chattogram` ← chittagong, chattagram
- `Cumilla` ← comilla
- `Jashore` ← jessore
- `Barishal` ← barisal
- `Bogura` ← bogra
- `Cox's Bazar` ← coxs bazar, cox bazar
- `Narsingdi` ← narshingdi, norshingdi

Each district and thana also carries its Bangla name (`nameBn`) as an alias, so a
Bangla address matches without a transliteration step.

## How to rebuild

```bash
# downloads the pinned version itself
node texpark-pro/tools/gen-bd-locations.js

# or from a local copy of the package
node texpark-pro/tools/gen-bd-locations.js /path/to/index.cjs
```

Outputs `texpark-pro/data/bd-locations.json` (reference) and
`texpark-pro/js/bd-locations.js` (the bundle the app loads). Do not hand-edit
either; change the generator or bump `PINNED`/`VERSION` and rebuild.

## Attribution

District/upazila/thana names derived from `@olism/bd-geo` (MIT). The bundle header
and the Settings → About panel both carry this attribution.

## Coverage / limits

64 districts, 556 thanas/upazilas. It is reference data for **detection and
validation** only — it is not sent to Steadfast and does not change the booking
payload. If a location cannot be resolved, the app asks the user rather than
guessing.
