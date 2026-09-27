# AGENTS.md — Project Memory

## What this workspace is
Two things live here:

| Path | What it is |
|---|---|
| `/home/openhands/workspace/project/` | The user's real **Texpark Business Manager** app (Electron + Google Apps Script). Do not delete old app folder. |
| `/workspace/project/` | Catalog/review pages served over HTTP on port 12000. `index.html` = current catalog (v2). `catalog/catalog-v1.html` = archived first catalog. |

Serve command used: `python3 -m http.server 12000 --bind 0.0.0.0` from `/workspace/project`.
Public URL: `https://work-1-zwmlgjnofcfiguwb.prod-runtime.all-hands.dev/`

## The user's app: Texpark Business Manager v1.0.1
- Brand: TEXPARK BUYING HOUSE. MD: Mahmudul Hasan Sourav. Uttara, Dhaka.
- Files: `index.html` (659KB, 220 lines — all UI + logic inline), `main.js` (Electron), `package.json`, `Code.gs` (Apps Script sync), `START_APP.bat`, `CREATE_DESKTOP_SHORTCUT.bat`, `README_BANGLA.txt`.
- Single-file app. No build step, no framework, no npm runtime deps (only electron + electron-builder as devDeps). `xlsx` loaded from jsDelivr CDN.
- localStorage key: **`texpark_biz_v1`** — must be preserved for data continuity.
- db shape: `{customers, products, stock, memos, deliveries, stockHistory, settings:{syncUrl}, seq}`
- Pages (sidebar): dashboard, memo, customers, products, stock, delivery, history, reports, settings.
- Google Sheet ID in `Code.gs`: `1RtD4Bmz-WzCay42rv-IuTZFIQpV3v9PiLnCv1iSpHqQ`
- Sheet tabs: Sales, Stock, Customers, Delivery, Reports, App_Log, Memo_Summary.

### Present features
Sales memo (rate+qty, discount, delivery charge, advance, due) · memo history view/edit/delete (delete reverses stock) · A4 print/PDF · Bangla taka in words (`numberWords`) · stock (opening/purchased/sold/available) + edit/adjust modals · delivery tracking · customers · products · Excel/CSV import + template · CSV/JSON export · backup/restore JSON · Google Sheets sync.

### Verified-absent features (grep count 0 in index.html)
`profit` · `COGS` · `expense` · `supplier` · `reorder` · `login`/`password`/`role`/`audit` · `mushak` · `barcode` · `chart` · `autoBackup` · party ledger / due ageing.

### Known real bug (important)
`pushSync()` uses `fetch(..., {mode:'no-cors'})` → the response is unreadable, so the UI message **"✓ Sync request sent"** is not proof of a successful save. There is no retry and no offline queue. The comment in `Code.gs` (`saveSale_`) admits they patched around an interrupted-memo race. Any upgrade should fix verification + add a retry queue, and show Failed/Pending/Synced instead.

## Working style with this user
- User writes in Bengali (romanized "Banglish"). Reply in the same style.
- Works iteratively: asks for a **catalog of options first**, then picks one. Do not start building the app before they choose.
- When adding options, ground them in the *actual* code (audit first, then claim). The user explicitly asked for something better than the previous catalog.
- Never remove existing features. The old `texpark_biz_v1` key must not be *deleted* — but in the chosen plan the user said it need not be **preserved as the live key**; the new app reads it only in the one-way "Import old data" step.

## Chosen plan: "A. Texpark Pro — Direct Upgrade"  (DECIDED)
User picked option A. Business type / current pain point / priority feature were left blank,
so they were not invented; the plan stands on the audited code + the one bug the user named.

### Delivered: `/workspace/project/texpark-pro/`
| File | Role |
|---|---|
| `index.html` | App shell + all 18 pages + modals |
| `js/db.js` | Data layer + business rules + users/permissions/session |
| `js/sync.js` | Verified sync with retry queue (replaces old silent `no-cors` push) |
| `js/app.js` | UI, pages, memo stock validation, print sheet, reports |
| `css/app.css` | Stylesheet |
| `main.js`, `package.json` | Electron 38 + electron-builder (`npm start`, `npm run dist`) |
| `Code.gs` | v2 Apps Script: every branch returns JSON so the client can verify |
| `START_APP.bat`, `CREATE_DESKTOP_SHORTCUT.bat`, `README_BANGLA.txt` | Launch + docs |
| `test/logic.test.js` | 42 headless business-rule tests |
| `test/e2e.test.js` | 93 tests driving the real `app.js` through a DOM shim |

New localStorage key: **`texpark_pro_v2`** (old `texpark_biz_v1` untouched; one-way import in Backup page).
Admin seed: `admin` / `admin123`, password stored as a hash. 4 roles: admin, manager, salesman, accountant.

### The bug the user named, and the fix
Old: memo saved with zero/insufficient stock → stock went minus.
New: `checkStockForItems()` blocks the save, lists which product is short and by how much,
and the Save button is disabled. `Settings → allow negative stock` is the explicit opt-out.
`saveStockEdit()` also refuses to set sold qty below the quantity real memos prove was sold.

### Things that bit me here (don't repeat)
- `let db` / `let session` in `app.js` are **not** `window` properties. Tests must load the source
  with `vm.runInThisContext` (Node) or inject a `<script>` into an iframe (browser) to reach them.
- The browser's typed input did not persist into app fields via the automation tool; drive
  functions directly for verification instead of relying on synthetic typing.
- `renderAll()` **swallows exceptions** (`try/catch` around the per-page render). A broken page
  therefore renders empty rather than throwing. When a page looks blank, check `console.error`,
  and prefer `ok(ERRS.length === 0, ...)`-style assertions.
- The Stock page's product `<select>` was originally filled only by `renderProducts()`, so opening
  Stock directly left it empty and opening stock silently did nothing. Now shared via
  `fillStockProductSelect()`. There is a regression test for it.
- The **service worker reloads any open page** when its bytes change (`clients.navigate()` in
  `sw.js`). Any browser harness that injects state into an iframe gets wiped by that reload, which
  is why the cloud round trip is proven in Node against the real `Code.gs` instead.

## Cross-device safety (the "so data is never messed up" work)

### Memo numbers are device-scoped — a real collision, now fixed
`seq.memo` is per-device. Both PC and phone started at 1, so both minted
`TXP/SM/<date>-001`, and `Code.gs` upserts the Sales sheet on the memo number — one memo would
silently overwrite the other. Numbers now carry a device tag: `TXP/SM/2026/09/22-PC001` vs `-PH001`.
`deviceTag()` derives `PC`/`PH` from the user agent, stores it once, and is overridable in
Settings. The same applies to purchase numbers (`TXP/PO/...`). Tests cover the collision.

### Cloud backup AND restore (sync used to be push-only)
`js/sync.js` could only **push**; losing the PC or phone lost everything it had entered.
Now:
- `cloudBackupNow()` pushes the whole `db` as JSON into a new **Backup** tab.
- `cloudRestore()` / `cloudListDevices()` pull it back — `Code.gs doGet?action=pull`.
- One row per device per day (upsert), so the sheet does not grow without bound.
- `Settings → Auto daily backup` pushes once a day on open; a dirty flag pushes on tab close.
- Restore always takes a local `snapshot()` first, then reloads.
- `saveBackup_` refuses payloads over ~49 KB (a Sheets cell holds 50,000 chars) loudly rather
  than letting Google truncate a half-backup.

### Permanent hosting: what is and is not possible here
The sandbox URL is temporary and cannot be made permanent from inside. The user must host the
built bundle themselves. `HOSTING_BANGLA.txt` is the guide, `texpark-deploy/` is the folder,
`texpark-pro.html` is the single self-contained file to email or carry on a USB stick.

## Build + test commands
- `node build.js` (in `texpark-pro/`) regenerates **both** `../texpark-deploy/` and
  `../texpark-pro.html`. Always run this after changing source, or the shipped files drift.
  The script asserts the new cloud/device functions are present in the single file.
- `npm test` runs `test/logic.test.js` (78), `test/sheet.test.js` (20), `test/e2e.test.js` (197),
  then `node --test test/android.test.js` (12). Total 307.
- `test/sheet.test.js` loads the **real `Code.gs`** in a `vm` context with stubbed
  `SpreadsheetApp`/`ContentService`, so server-side backup/pull/upsert logic is actually executed.
- Current version: `2026-09-22.5` in both `sw.js` and `js/app.js` (bump both, then rebuild).

## Android app (added 2026-09-22)
`TexparkPro.apk` — a WebView **shell**, deliberately not a copy of the app. The owner types his
Netlify address once; `MainActivity` stores it and loads it live, so **one edit on the host
updates every installed phone** with no new APK. This is the user's explicit requirement.

- Source: `android-src/` (`MainActivity.java`, `SiteUrl.java`, `AndroidManifest.xml`).
  `MainActivity` uses only plain framework APIs — no AndroidX, so there is no dependency
  resolution and no Gradle download.
- Build: `ANDROID_HOME=/opt/android-sdk python3 build-apk.py` → `TexparkPro.apk` (21 KB),
  signed with `android-keystore.jks`. **Keep that keystore** — a different one makes the new
  APK a different app, so it will not install over the old one.
- `SiteUrl.normalise()` is deliberately Android-free so it can be compiled and tested on a
  plain JVM; `test/android.test.js` runs the shipped class for real. There is no emulator here
  (no `/dev/kvm`), so this is the honest limit of what can be verified locally. The APK itself
  is verified with `apksigner verify` + `androguard`.
- Two gotchas already hit, do not rediscover them:
  1. build-tools **34.0.0**'s `d8` crashes with an internal NPE on anonymous inner classes.
     `build-apk.py` auto-picks the newest installed build-tools (35.0.0 works).
  2. `d8` needs `*.class` found **recursively** under `-d` output; a flat `os.listdir` silently
     produces an empty `obj/`.
- Recovery paths that exist on purpose: load failure → dialog offering retry / change address;
  long-press Back → change the stored address without losing data (data lives in WebView
  localStorage, not in the APK, so changing the address never wipes business data).
- Guide: `ANDROID_BANGLA.txt`. Download page: `download.html` (APK button + explanation).
- A JDK is not part of this image and `apt` has no `openjdk-*` package. `test/android.test.js`
  needs `javac`/`java`, so on a fresh shell the 12 android tests report a **false failure** —
  it is a missing tool, not broken code. Fix: download Adoptium 17 and point `JAVA_HOME` at it
  (`JAVAC`/`JAVA` also work), then run `JAVA_HOME=/tmp/jdk-17.0.20.1+1 node --test test/android.test.js`.
  The suite now says "javac not found" instead of an ENOENT stack so this is not misread as a regression.
- Demo: `demo.html` at the repo root pairs a QR for the live app with a QR for the APK, so the
  owner can open the app on his phone without typing a hostname. It says plainly that the sandbox
  URL is temporary — Netlify is what makes it permanent.
