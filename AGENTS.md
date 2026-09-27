# AGENTS.md — Project Memory

## What this workspace is
Two things live here:

| Path | What it is |
|---|---|
| `/home/openhands/workspace/project/` | The user's real **Texpark Business Manager** app (Electron + Google Apps Script). Do not delete old app folder. |
| `/workspace/project/` | Catalog/review pages served over HTTP on port 12000. `index.html` = current catalog (v2). `catalog/catalog-v1.html` = archived first catalog. |

Serve command used: `python3 -m http.server 12000 --bind 0.0.0.0` from `/workspace/project`.
Public URL: `https://appleziarash1.github.io/texpark-pro` (permanent). The sandbox URL
`https://work-1-zwmlgjnofcfiguwb.prod-runtime.all-hands.dev/` is temporary - do not hand it out.

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

### The rule the owner set: the memo is the source of truth
A memo must **never** be blocked by missing or insufficient stock. It saves, the product
auto-appears in Stock (0 received), and the received qty is entered whenever it suits.
`checkStockForItems()` is a **report**, not a gate — it feeds the reminder box on the memo page.
`saveMemo()` requires only a customer name and at least one line with a product and qty > 0.

The owner then caught the follow-on: selling 60 with nothing received showed stock **-60**,
which reads as an error. Fixed by splitting the two numbers:
- `stockRaw(s)` = opening + purchased − sold — may be negative, internal truth.
- `stockAvailable(s)` = `max(0, stockRaw)` — what is on the shelf, never a minus sign.
- `stockShort(s)` = `max(0, -stockRaw)` — the "Tola baki" column: what is still to enter.
Entering the 60 later lands on top of those sales by itself (100 received → available 100).
`saveAdjust()` and `saveStockEdit()` guard against `stockRaw`, never the clamped value, so a
card that is short can still be corrected. `saveStockEdit()` still refuses to set sold below
the qty real memos prove was sold.

### Second bug the owner named: the caret jumped out of the box
`memoSet()` called `renderMemoLines()`, which replaced `memoRows.innerHTML` on every keystroke —
so after the first digit the box lost focus and typing stopped. Now:
`memoSet()` → `memoPatchLine(i)` updates only the dependent cells (available pill, amount,
profit, warn class) and never writes to an `<input>`. `calcMemo()` ends with `memoSyncLines()`,
which patches rows when the row count is unchanged and only falls back to a full
`renderMemoLines()` when a line was added or removed. Inputs are labelled `memoRate<i>` /
`memoQty<i>` so the patch can find them.

### Things that bit me here (don't repeat)
- **Never re-render a container that holds an input the user is typing in.** Patch the cells.
- The e2e DOM shim could not see the caret bug because its `innerHTML` was a plain property and
  it had no `children`. It now counts `innerHTML` writes (`_writes`) and derives `children` from
  the markup, so `eq(el('memoRows')._writes, before, ...)` catches a table rebuild.
- `let db` / `let session` in `app.js` are **not** `window` properties. Tests must load the source
  with `vm.runInThisContext` (Node) or inject a `<script>` into an iframe (browser) to reach them.
- The browser's typed input did not persist into app fields via the automation tool; drive
  functions directly for verification instead of relying on synthetic typing.
- To verify a fix in a **real** browser, copy `index.html` to `probe.html` with an injected
  `<script>` that drives the functions and writes results into a `<div id="probeOut">`, serve the
  deploy folder, and read the page. `chromium --dump-dom` hangs in this image; the browser tool
  works. Guard the probe with `sessionStorage` and call `boot()` yourself, because the service
  worker reloads the page on activation and the probe would otherwise run twice on stale state.
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
silently overwrite the other. Numbers now carry a device tag: `TXP/SM/2026/09/22-PC001` vs
`-PH001`. The tag is `PC`/`PH`-derived **plus a four-character per-install suffix**
(`PC7K2Q`), stored once, and overridable in Settings. The suffix is not decoration: the
sheet's backup tab keeps one row per device tag, so a bare `PH` on the phone app and a bare
`PH` in a phone's browser were the same row and each silently replaced the other's books.
Android also memoizes the tag in `Store.tagCache`. Without that, a device whose `device_tag.txt`
could not be written re-minted the tag on every call — changing memo numbers mid-session. The
same applies to purchase numbers (`TXP/PO/...`). Tests cover the collision.

### Edit `texpark-pro/`, then run `node texpark-pro/build.js`
`texpark-pro/` is the source of the web app; the repo root is its **build output**
(GitHub Pages serves the root, and the APK's update check derives paths from
`index.html` there). Editing a file at the root looks like it works — the change
is live immediately — but the next `node texpark-pro/build.js` copies the source
over it and silently reverts the fix. That is exactly how the push-on-save fix
came to exist at the root and not in the source. Never hand-edit root `js/*.js`,
`sw.js` or `index.html`; the root copies are regenerated. `version.txt` is written
by `build.js` from `js/app.js`, so bump `APP_VERSION` in `texpark-pro/js/app.js`
and `texpark-pro/sw.js`, not `version.txt`.

### Cloud backup AND restore (sync used to be push-only)
`js/sync.js` could only **push**; losing the PC or phone lost everything it had entered.
Now:
- `cloudBackupNow()` pushes the whole `db` as JSON into a new **Backup** tab.
- `cloudRestore()` / `cloudListDevices()` pull it back — `Code.gs doGet?action=pull`.
- One row per device per day (upsert), so the sheet does not grow without bound.
- `Settings → Auto daily backup` pushes once a day on open.
- Restore always takes a local `snapshot()` first, then reloads.
- `saveBackup_` refuses payloads over ~49 KB (a Sheets cell holds 50,000 chars) loudly rather
  than letting Google truncate a half-backup.

### Auto-pull: the two devices converge without a button
Manual restore was not enough in practice — the owner wrote a memo on the phone and the PC
kept showing yesterday's numbers until he remembered to press "fire aan". Now `cloudAutoSync()`
runs on login, on `online`, and on `visibilitychange`, and does push → `?action=pullall` → merge
→ push in that order (the push must be *awaited*; a queued push would race the pull and the
merge would run against a cloud that does not yet hold this device's work).

### A sync is only a success when the sheet says so (the "phone edit never reached the web" bug)
The owner edited stock and a product on the phone with internet, then found the web app still
showing the old numbers. Three separate faults, all fixed:

1. **Nothing pushed on save.** Both sides only synced on open/visibility, so an edit sat on the
   device until the app was restarted. The Android `Store.Listener` now calls `schedulePush()`
   after every commit (a 2 s quiet period coalesces a burst of edits; `onPause` flushes so the
   upload is not lost on the way out). The web side calls `scheduleCloudPush()` from `commit()`,
   flushing on `visibilitychange`/`pagehide` — *not* `beforeunload`, whose request a browser
   cancels halfway, which is why web edits often never arrived at all.
2. **A failed upload was reported as a good sync.** `Sync.pullAll` discarded the push result and
   could answer `N ta snapshot merge hoyeche` while this device's data never left. `Sync.pushAccepted`
   reads the reply body (`success !== false`), so an Apps Script refusal, an empty body and an HTML
   login page are all failures — a 200 is not proof of a save. `Sync.mergeReport` leads with the
   upload failure when there was one.
3. **The post-merge save was unchecked.** `store.commit()`'s result and `lastSaveError` are now
   surfaced, in `pullAll` and in `pullDevice`.

`Sync.appVersion` is a field set by `MainActivity`, not a reach into it, so `Sync` compiles and
runs on a plain JVM — these decision rules are tested in `native.test.js` (`pollDue`,
`pushAccepted`, `mergeReport`) without a phone.

The merge is why records carry an `at` stamp and deletes leave a `del` tombstone; a pull that
merges an identical snapshot must not bump those stamps, or every open would restamp everything
and the two devices would rewrite each other forever. `test/merge.test.js` and
`test/autopull.test.js` both assert the no-op case.

Three latent duplicates had to be fixed for this to be safe, all found by the merge tests:
- Seed products got random `id()`s per device, so two machines that had both merely *started*
  merged into six products under three names. They now use fixed `seed-*` ids, and
  `adoptSeedIds_()` renames an *untouched* legacy row (same name and rate) and repoints its memo
  items, stock card and ledger entries. An edited seed row is left alone.
- Each device minted its own random **stock card** id for the same product, so a merge left two
  cards for one product and the stock page listed it twice. `dedupeStockCards_()` runs after
  every rebase.
- `rebaseStockFromLedger()` skips products that no longer exist, so deleting a product cannot
  resurrect a "(deleted product)" row from old ledger movements.

### Permanent hosting: live on GitHub Pages
**The site is live and permanent: `https://appleziarash1.github.io/texpark-pro`.** Pages is
configured as *Deploy from a branch -> main -> / (root)*, which is why `build.js` writes the app
to the repo root. Pushing to `main` redeploys the site and the APK's update check follows it,
so no manual upload step exists any more.

The sandbox URL (`https://work-1-...prod-runtime.all-hands.dev/`) is still only temporary: it
dies with the sandbox and must never be given to the owner as *the* address.

**Pages must not be switched to "GitHub Actions" build.** `actions/configure-pages` cannot
create the Pages site with `GITHUB_TOKEN` — creating it needs the Pages permission, which the
token does not carry, and it fails `403 Resource not accessible by integration`. The site was
turned on once by hand in Settings -> Pages. `pages.yml` was deleted rather than left failing:
with branch deploy there is nothing left for a workflow to do, and two deploys racing to serve
the same root is the one thing that could briefly serve a half-updated app.

`docs/HOSTING_BANGLA.txt` is the guide for the owner, `texpark-pro.html` is the single
self-contained file to email or carry on a USB stick.

Repository code is public (that is what free Pages requires). The business data is not: it
lives in device `localStorage` and in the owner's Google Sheet. `Code.gs` is published by
Pages and carries the spreadsheet ID in plain text, which is harmless while that Sheet is
private — anyone able to read `Code.gs` gains nothing without access to the Sheet itself.

### The repo root *is* the site
`build.js` writes the app to the repo root (`index.html`, `js/`, `css/`, `sw.js`, icons,
`version.txt`, `TexparkPro.apk`) because GitHub Pages serves the root of the branch it is
pointed at. That is also what the installed APK needs: its update check derives every path by
resolving index.html's own relative links, so moving the app into a subfolder would make it
fetch from the wrong place. Consequence: the repo root holds the app **and** the build tooling
and `.git` together, so anything that walks it must use an allowlist. `make-hosting-zip.py`
does exactly that, and asserts `android-keystore.jks` and `.git/` are absent - the keystore is
the private key that signs the APK, and publishing it would let anyone sign an APK that Android
accepts as an update to the installed one.

The catalog pages (`index.html`, `download.html`) live in `catalog/`, not the root, precisely so
the root `index.html` can be the app.

## Build + test commands
- `node build.js` (in `texpark-pro/`) regenerates **both** the repo root and
  `../texpark-pro.html`. Always run this after changing source, or the shipped files drift.
  The script asserts the new cloud/device functions are present in the single file.
- `npm test` runs `test/logic.test.js` (84), `test/sheet.test.js` (28), `test/e2e.test.js` (205),
  `test/merge.test.js` (33), `test/autopull.test.js` (15), then `node --test test/android.test.js`
  (27). Total 392.
- `test/merge.test.js` and `test/autopull.test.js` load `db.js` **and `sync.js`** into a `vm`
  context each, so two "devices" can be run against one fake sheet and the merge is exercised as
  two databases rather than as one.
- `test/sheet.test.js` loads the **real `Code.gs`** in a `vm` context with stubbed
  `SpreadsheetApp`/`ContentService`, so server-side backup/pull/upsert logic is actually executed.
- Current version: `2027-01-01.1` in `sw.js`, `js/app.js`, `version.txt` and
  `MainActivity.java` (bump them together, then rebuild — the e2e test fails if the two js
  files drift apart, and `ci/check-site.py` fails if the Java or the APK drifts too).

## Android app (rewritten natively 2026-09-29)
`TexparkPro.apk` — a **fully native** app, not a WebView. The owner asked for a real Android
app, and the WebView had a fatal flaw he reported himself: **a memo could not be printed**,
because `window.print()` does nothing inside a WebView, and printing memos is the shop's main
job. Native also brings the real keyboard, date picker, back button and voice recogniser.

- Source: `android-src/com/texpark/pro/` — `MainActivity` (shell, top bar, sidebar, back,
  updates, voice plumbing), `Screens`/`ScreensData`/`ScreensMore` (every screen), `Ui`
  (widgets), `Store` (data + business rules), `Json`, `Sync` (Sheets backup/pull), `Voice`
  (spoken-sentence parsing), `Updater`/`SiteUrl`. Plain framework APIs only — no AndroidX,
  so there is no dependency resolution and no Gradle download.
- Build: `ANDROID_HOME=/opt/android-sdk python3 build-apk.py` → `TexparkPro.apk` (~77 KB),
  signed with `android-keystore.jks`. **Keep that keystore** — a different one makes the new
  APK a different app, so it will not install over the old one.
- The version is stamped in three places by the build and checked by `ci/check-site.py`:
  `build.js` writes `version.txt` from `js/app.js`, and `build-apk.py` rewrites
  `MainActivity.APP_VERSION` from it before compiling. If they drift, the app offers the same
  "update" on every launch.
- `test/native.test.js` compiles the shipped `Json`, `Store` and `Voice` on a plain JVM and
  runs the real classes against the real JS business rules (16 tests). The shop's central
  rule is driven through `Store.saveMemo` itself: a memo for a product with **no stock card at
  all** must save, must create the card, must clamp `available` at 0, and must keep the whole
  quantity as a reported shortfall. That rule used to live in `ScreensData`, where an
  Android-only class could not be tested; it now lives in `Store` for that reason.
- Two static checks guard what an emulator would otherwise catch: every `NavItem` must have
  a matching `"<id>".equals(page)` branch (a menu entry with no screen opens blank), and no
  source file may import `android.webkit` or call `window.print` in code (comments are
  stripped first, since the removal is explained in them). **The voice tests earned
  their keep immediately**: the first version read the `3` out of the product name "Kids 3pcs"
  as the quantity and lost the spoken "5 piece", and matched no product at all. Matching is now
  per-word with the product's own words stripped before the quantity is read, and a tie
  between two products refuses to guess rather than silently moving the wrong stock.
- There is no emulator here (no `/dev/kvm`), so the honest limit stands: the APK is verified
  with `apksigner verify` + `aapt2 dump badging`, and the logic classes are tested on a JVM,
  but no screen has been driven on a device. The self-update is a **download prompt**, not a
  silent install: since Android 8 an app may not install an APK from its own process, and code
  claiming otherwise would be a lie.
- Two gotchas already hit, do not rediscover them:
  1. build-tools **34.0.0**'s `d8` crashes with an internal NPE on anonymous inner classes.
     `build-apk.py` auto-picks the newest installed build-tools (35.0.0 works).
  2. `d8` needs `*.class` found **recursively** under `-d` output; a flat `os.listdir` silently
     produces an empty `obj/`.
- Recovery paths that exist on purpose: load failure → dialog offering retry / change address;
  long-press Back → change the stored address without losing data (data lives in WebView
  localStorage, not in the APK, so changing the address never wipes business data).
- Guide: `ANDROID_BANGLA.txt`. Download page: `demo.html`, generated by `make-demo.py`
  (two QR codes — the app APK and the web app — plus the install steps).
- **Update discovery reads `js/app.js`, not `version.txt`.** The live host was configured with
  Netlify's `/* /index.html 200` fallback, so every unknown path — including `version.txt` —
  came back 200 full of HTML. The updater had no way to tell a real version from that page and
  would sit on an old build forever. `Updater.versionIn()` pulls `APP_VERSION` out of
  `js/app.js` (a file the app genuinely needs, so a fallback cannot fake it) and
  `Updater.referencedFiles()` derives the file list from `index.html` itself. `version.txt`
  survives only as the stamp the APK's own bundled build is compared by; `filelist.txt` is gone.
  `make-hosting-zip.py` writes **no** `_redirects` so a missing file 404s instead of returning
  a valid-looking page — a catch-all rewrite is the one host setting that breaks the updater.
- A JDK is not part of this image and `apt` has no `openjdk-*` package. `test/android.test.js`
  and `test/native.test.js` need `javac`/`java` on `PATH`, so on a fresh shell they report a
  **false failure** — it is a missing tool, not broken code. Fix:
  `curl -sL -o /tmp/jdk.tar.gz https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse`,
  unpack under `/tmp/jdk17`, then `export JAVA_HOME=/tmp/jdk17; export PATH="$JAVA_HOME/bin:$PATH"`.
  Setting `JAVA_HOME` alone is not enough — the suite runs bare `javac`, so the directory has
  to be on `PATH` too. Both suites say "javac not found" rather than throwing an ENOENT stack,
  so this is not misread as a regression.
  `/tmp` does not survive a terminal reset: after one, expect the two Java suites to fail until
  the JDK is fetched again. The pure-Node suites are unaffected.
- Demo: `demo.html` at the repo root pairs a QR for the APK with a QR for the web app, so the
  owner can install and open both without typing a hostname. Generate it — do not hand-edit it:
  `python3 make-demo.py` reads the host out of `MainActivity.DEFAULT_UPDATE_URL`, draws both
  codes with segno, decodes them back with cv2 and refuses to write a page if a code does not
  read as a URL the page prints.
  This page is a trap that already sprang once. It kept a sandbox address and a "Netlify is what
  makes it permanent" note long after hosting had actually moved, and nothing noticed because a
  QR that leads nowhere looks exactly like one that works. `ci/check-site.py` now fails if
  `demo.html` disagrees with the app's host, mentions `prod-runtime.all-hands.dev`, or carries a
  code that decodes to anything the page does not print.
