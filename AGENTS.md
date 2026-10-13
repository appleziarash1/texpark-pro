# AGENTS.md â€” Project Memory

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
- Files: `index.html` (659KB, 220 lines â€” all UI + logic inline), `main.js` (Electron), `package.json`, `Code.gs` (Apps Script sync), `START_APP.bat`, `CREATE_DESKTOP_SHORTCUT.bat`, `README_BANGLA.txt`.
- Single-file app. No build step, no framework, no npm runtime deps (only electron + electron-builder as devDeps). `xlsx` loaded from jsDelivr CDN.
- localStorage key: **`texpark_biz_v1`** â€” must be preserved for data continuity.
- db shape: `{customers, products, stock, memos, deliveries, stockHistory, settings:{syncUrl}, seq}`
- Pages (sidebar): dashboard, memo, customers, products, stock, delivery, history, reports, settings.
- Google Sheet ID in `Code.gs`: `1RtD4Bmz-WzCay42rv-IuTZFIQpV3v9PiLnCv1iSpHqQ`
- Sheet tabs: Sales, Stock, Customers, Delivery, Reports, App_Log, Memo_Summary.

### Present features
Sales memo (rate+qty, discount, delivery charge, advance, due) Â· memo history view/edit/delete (delete reverses stock) Â· A4 print/PDF Â· Bangla taka in words (`numberWords`) Â· stock (opening/purchased/sold/available) + edit/adjust modals Â· delivery tracking Â· customers Â· products Â· Excel/CSV import + template Â· CSV/JSON export Â· backup/restore JSON Â· Google Sheets sync.

### Verified-absent features (grep count 0 in index.html)
`profit` Â· `COGS` Â· `expense` Â· `supplier` Â· `reorder` Â· `login`/`password`/`role`/`audit` Â· `mushak` Â· `barcode` Â· `chart` Â· `autoBackup` Â· party ledger / due ageing.

### Known real bug (important)
`pushSync()` uses `fetch(..., {mode:'no-cors'})` â†’ the response is unreadable, so the UI message **"âœ“ Sync request sent"** is not proof of a successful save. There is no retry and no offline queue. The comment in `Code.gs` (`saveSale_`) admits they patched around an interrupted-memo race. Any upgrade should fix verification + add a retry queue, and show Failed/Pending/Synced instead.

## Working style with this user
- User writes in Bengali (romanized "Banglish"). Reply in the same style.
- Works iteratively: asks for a **catalog of options first**, then picks one. Do not start building the app before they choose.
- When adding options, ground them in the *actual* code (audit first, then claim). The user explicitly asked for something better than the previous catalog.
- Never remove existing features. The old `texpark_biz_v1` key must not be *deleted* â€” but in the chosen plan the user said it need not be **preserved as the live key**; the new app reads it only in the one-way "Import old data" step.

## Chosen plan: "A. Texpark Pro â€” Direct Upgrade"  (DECIDED)
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
`checkStockForItems()` is a **report**, not a gate â€” it feeds the reminder box on the memo page.
`saveMemo()` requires only a customer name and at least one line with a product and qty > 0.

The owner then caught the follow-on: selling 60 with nothing received showed stock **-60**,
which reads as an error. Fixed by splitting the two numbers:
- `stockRaw(s)` = opening + purchased âˆ’ sold â€” may be negative, internal truth.
- `stockAvailable(s)` = `max(0, stockRaw)` â€” what is on the shelf, never a minus sign.
- `stockShort(s)` = `max(0, -stockRaw)` â€” the "Tola baki" column: what is still to enter.
Entering the 60 later lands on top of those sales by itself (100 received â†’ available 100).
`saveAdjust()` and `saveStockEdit()` guard against `stockRaw`, never the clamped value, so a
card that is short can still be corrected. `saveStockEdit()` still refuses to set sold below
the qty real memos prove was sold.

### Third bug the owner named: a return was swallowed when its memo was deleted
Deleting or editing a memo that already had a return filed against it left the shelf short by
the returned qty â€” 145 instead of 150 for a 20-piece memo with 5 returned. `sold` is a
**running counter**, not a physical quantity, and both `reverseSaleFromStock` and
`applyReturnToStock` clamped it at 0. Reversing a memo takes the whole memo qty out of `sold`,
while the return's own entry adds its share back, so `sold` dips below zero mid-transaction and
the two net out. The clamp swallowed exactly the returned qty instead. `available` is the number
the owner sees, and that stays clamped in `stockAvailable`. The same clamp sat in the native
`Store.reverseSaleFromStock` / `applyReturnToStock`.
The clamp also fought `rebaseStockFromLedger()`, which replays the same ledger **without**
clamping: a sync therefore changed the figure the owner was just looking at. The invariant to
test is that the card and the ledger agree â€” `rebaseStockFromLedger()` must not move `available`
or `sold`.
Two more native-only divergences were hiding behind that one:
- `Store.rebaseStockFromLedger()` had **no `Return` case at all**, so a phone sync rebuilt `sold`
  too high by the returned qty.
- The phone writes `ReturnUndo` where the web writes `Sale` for the same event (a deleted
  return). Both apps share one sheet, so **both builds must understand both spellings** â€” check
  `rebaseStockFromLedger` on both sides whenever a ledger type is added.
Native memo delete now goes through `Store.deleteMemo()`, which takes the memo's returns and
deliveries with it, matching the web build's `deleteMemo()`.

### Fourth bug the owner named: a return did not deduct the money
A parcel came back (full or partial) and the customer's due/receivable did not move â€” the money
for goods the shop now holds again was still being owed. The stock side was already right; the
money side never netted returns at all. The rule, now shared by web and native:

- `returnedValueOnMemo(memo)` values each returned piece at the rate the memo charged for it
  (walking the return's own lines against the memo lines, so a partial return drops only the
  right products). A return record with no lines â€” an older Android record, which stores `lines`
  not `items` â€” falls back to the memo's average rate, so it still comes off. **The web helper
  reads both `items` and `lines`, because both keys are in the wild on merged data.**
- `memoCharge(memo)` = `grandTotal` scaled by the value of goods kept, so a memo with no returns
  reads exactly its stored grand total (every existing figure is untouched).
- `memoRemainingDue` = `memoCharge âˆ’ advance âˆ’ collected`, floored at 0. This is the ONE place the
  due moves, so the dashboard, customer ledger, ageing and print sheet all follow automatically.
  A later return on an already-collected memo therefore stays at 0, never negative.
- `collectableOnMemo` (the delivery collection clamp) and the Android `recordCollection` /
  `collectableOnMemo` now use the remaining due, which already nets returns â€” a return can never
  re-open money for goods that came back.
- `customerDue` (web) nets `memoCharge` per memo, so the customer ledger drops the moment a
  parcel is returned.
- **Profit must not count a returned parcel as a sale.** `plSummary`, `profitRows`,
  `monthlyPLHTML` and the dashboard 14-day chart scale each memo's subtotal/cogs/profit by
  `(1 âˆ’ returnedValue/soldValue)`, per-product where the report is per-product. Gross profit
  keeps `+ deliveryCharge` (existing behaviour) â€” dropping it silently moved the P&L by the
  delivery charge. Mirrored in native `Store.plSummary`.
- The memo print sheet shows a "Less: Returned goods" line (the stored `grandTotal` is a record
  of the sale and is left as-is; the *Due* line uses the charge, so the printed bill settles).
- `collectedPrefill` (web and native) now splits the remaining due over the memo's **deliverable**
  qty (`totalQty âˆ’ returnedQty`), not `totalQty`, so a partial memo prefills sensibly.

Tests: `texpark-pro/test/return.test.js` ("a return takes the money off the memo, full and
partial") and `texpark-pro/test/native.test.js` ("a parcel return deducts the moneyâ€¦"), both
also asserting the web and native figures match.

### Second bug the owner named: the caret jumped out of the box
`memoSet()` called `renderMemoLines()`, which replaced `memoRows.innerHTML` on every keystroke â€”
so after the first digit the box lost focus and typing stopped. Now:
`memoSet()` â†’ `memoPatchLine(i)` updates only the dependent cells (available pill, amount,
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

### Memo numbers are device-scoped â€” a real collision, now fixed
`seq.memo` is per-device. Both PC and phone started at 1, so both minted
`TXP/SM/<date>-001`, and `Code.gs` upserts the Sales sheet on the memo number â€” one memo would
silently overwrite the other. Numbers now carry a device tag: `TXP/SM/2026/09/22-PC001` vs
`-PH001`. The tag is `PC`/`PH`-derived **plus a four-character per-install suffix**
(`PC7K2Q`), stored once, and overridable in Settings. The suffix is not decoration: the
sheet's backup tab keeps one row per device tag, so a bare `PH` on the phone app and a bare
`PH` in a phone's browser were the same row and each silently replaced the other's books.
Android also memoizes the tag in `Store.tagCache`. Without that, a device whose `device_tag.txt`
could not be written re-minted the tag on every call â€” changing memo numbers mid-session. The
same applies to purchase numbers (`TXP/PO/...`). Tests cover the collision.

### Edit `texpark-pro/`, then run `node texpark-pro/build.js`
`texpark-pro/` is the source of the web app; the repo root is its **build output**
(GitHub Pages serves the root, and the APK's update check derives paths from
`index.html` there). Editing a file at the root looks like it works â€” the change
is live immediately â€” but the next `node texpark-pro/build.js` copies the source
over it and silently reverts the fix. That is exactly how the push-on-save fix
came to exist at the root and not in the source. Never hand-edit root `js/*.js`,
`sw.js` or `index.html`; the root copies are regenerated. `version.txt` is written
by `build.js` from `js/app.js`, so bump `APP_VERSION` in `texpark-pro/js/app.js`
and `texpark-pro/sw.js`, not `version.txt`.

### Cloud backup AND restore (sync used to be push-only)
`js/sync.js` could only **push**; losing the PC or phone lost everything it had entered.
Now:
- `cloudBackupNow()` pushes the whole `db` as JSON into a new **Backup** tab.
- `cloudRestore()` / `cloudListDevices()` pull it back â€” `Code.gs doGet?action=pull`.
- `Settings â†’ Auto daily backup` pushes once a day on open.
- Restore always takes a local `snapshot()` first, then reloads.

### A backup is split into chunks, because one sheet cell holds only 50,000 chars
A whole `db` written into a single Backup cell stopped working once the owner's books grew
past ~49 KB: `saveBackup_` refused it ("Backup too large for one sheet cell"), so no backup
reached the sheet, the queue filled with identical "Cloud backup (PC)" jobs that could never
succeed, and the phone and the PC stopped seeing each other's work. The fix is server-side
chunking, and the reasoning is worth keeping because the limit is Google's, not ours.

- `saveBackup_(ss, d)` splits the JSON into `CHUNK_CHARS = 40000`-character pieces and writes
  one row each in the **Backup** tab. Columns 6-9 (`Chunk`, `Of`, `Total Len`, `Checksum`)
  describe the set; the whole set shares one Timestamp (column 1), which is its identity.
- **Upsert means delete-then-append.** Every existing row for that device is removed first, so a
  smaller backup over a larger one cannot leave a stale tail chunk that the assembler would glue
  onto the new payload. One backup per device, no unbounded growth.
- `assembleBackup_(rows, device)` finds the newest set (max Timestamp), joins chunks 1..Of, and
  checks the total length and a djb2 checksum. A missing or wrong chunk throws a clear error
  instead of returning a half-backup. **A row with no chunk number is the old single-cell
  format** and is returned as-is, so sheets written by the previous `Code.gs` still restore.
- `doGet ?action=pull|pullall` reassembles per device. One device that cannot be rebuilt is
  reported in an `errors` map (pullall) or as `success:false` (single pull) rather than
  hiding the other devices' good backups.
- **Both clients only store and forward** â€” neither reassembles. `js/sync.js` and
  `Sync.java` pass the JSON through untouched, so a format change stays in one place
  (`Code.gs`) and the clients keep working with either the old or the new server.
- Client-side pile-up fixes, in `js/sync.js`: `syncCoalesceBackups()` keeps only the newest
  queued backup job **per device** (an older snapshot is worthless once a newer one exists), and
  `syncRequeueBackups()` un-parks a job that failed with the "too large" error, once, so the
  existing failed jobs retry after the server is redeployed. Real data jobs (memos, stock, â€¦)
  are never coalesced or dropped.
- **A sheet grid is finite; write to it as if it were not at your peril.** The first chunked
  `saveBackup_` appended the chunk rows and deleted the device's old ones, and every upload then
  failed with Google's `Those rows are out of bounds.` A Google tab holds a *fixed* number of
  rows and columns, and `appendRow` does **not** grow it - on a full (or trimmed) tab it throws
  the same error as `getRange` past the last row. `deleteRow`/`deleteRows` are just as exposed:
  they shift everything below, so a delete at the last row or one row past throws too.
  The rewrite in `saveBackup_` never deletes rows and never appends into a full grid:
  1. `ensureRows_`/`ensureCols_` grow the grid (`insertRowsAfter`/`insertColumnsAfter`) whenever
     a write or a header would reach outside it. `sheet_` calls `ensureCols_` before touching
     row 1, because a 26-column tab can be narrower than a header.
  2. The device's old rows are found by reading the sheet, then `clearContent`'d (never
     deleted). `getLastRow()` is read *after* the clear, so the cleared rows are not counted.
  3. The new block is written in **one** `getRange(...).setValues()` at `getLastRow()+1`, with
     the grid grown first. One write means a later failure cannot leave a half-written backup,
     and no grid math has to survive an intervening delete.
  `test/sheet.test.js` now backs its fake `Sheet` with a **finite** grid that throws the exact
  Google errors, so this class of bug cannot pass the suite again. Its `makeSheet(name, width,
  maxRows, maxCols)` + `buildApi()` let a test hand Code.gs a 5-row tab and prove the row count
  is grown.
- **Queue cleanup on a landed backup.** `js/sync.js` also drops a device's superseded backup
  jobs - any FAILED or PENDING "Cloud backup" for that device stamped before the one that just
  succeeded - because an older snapshot would only overwrite the newer one now in the sheet.
  Newer backups and every non-backup job are left alone (`syncDropSupersededBackups`).
- **The deployment is manual and the URL must not change.** Apps Script code is not served from
  the repo: the owner has to paste the new `Code.gs` into the project and
  *Deploy â†’ Manage deployments â†’ edit â†’ New version*, keeping the same `/exec` URL and
  *Who has access: Anyone*. `docs/SYNC_FIX_BANGLA.txt` walks through it.

### Auto-pull: the two devices converge without a button
Manual restore was not enough in practice â€” the owner wrote a memo on the phone and the PC
kept showing yesterday's numbers until he remembered to press "fire aan". Now `cloudAutoSync()`
runs on login, on `online`, and on `visibilitychange`, and does push â†’ `?action=pullall` â†’ merge
â†’ push in that order (the push must be *awaited*; a queued push would race the pull and the
merge would run against a cloud that does not yet hold this device's work).

### A sync is only a success when the sheet says so (the "phone edit never reached the web" bug)
The owner edited stock and a product on the phone with internet, then found the web app still
showing the old numbers. Three separate faults, all fixed:

1. **Nothing pushed on save.** Both sides only synced on open/visibility, so an edit sat on the
   device until the app was restarted. The Android `Store.Listener` now calls `schedulePush()`
   after every commit (a 2 s quiet period coalesces a burst of edits; `onPause` flushes so the
   upload is not lost on the way out). The web side calls `scheduleCloudPush()` from `commit()`,
   flushing on `visibilitychange`/`pagehide` â€” *not* `beforeunload`, whose request a browser
   cancels halfway, which is why web edits often never arrived at all.
2. **A failed upload was reported as a good sync.** `Sync.pullAll` discarded the push result and
   could answer `N ta snapshot merge hoyeche` while this device's data never left. `Sync.pushAccepted`
   reads the reply body (`success !== false`), so an Apps Script refusal, an empty body and an HTML
   login page are all failures â€” a 200 is not proof of a save. `Sync.mergeReport` leads with the
   upload failure when there was one.
3. **The post-merge save was unchecked.** `store.commit()`'s result and `lastSaveError` are now
   surfaced, in `pullAll` and in `pullDevice`.

`Sync.appVersion` is a field set by `MainActivity`, not a reach into it, so `Sync` compiles and
runs on a plain JVM â€” these decision rules are tested in `native.test.js` (`pollDue`,
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
create the Pages site with `GITHUB_TOKEN` â€” creating it needs the Pages permission, which the
token does not carry, and it fails `403 Resource not accessible by integration`. The site was
turned on once by hand in Settings -> Pages. `pages.yml` was deleted rather than left failing:
with branch deploy there is nothing left for a workflow to do, and two deploys racing to serve
the same root is the one thing that could briefly serve a half-updated app.

`docs/HOSTING_BANGLA.txt` is the guide for the owner, `texpark-pro.html` is the single
self-contained file to email or carry on a USB stick.

Repository code is public (that is what free Pages requires). The business data is not: it
lives in device `localStorage` and in the owner's Google Sheet. `Code.gs` is published by
Pages and carries the spreadsheet ID in plain text, which is harmless while that Sheet is
private â€” anyone able to read `Code.gs` gains nothing without access to the Sheet itself.

### Live update: a device reloads itself when a release lands (2026-10-12)

The owner wanted a push to reach every device without a manual reload, and to stay on GitHub
Pages. A static host cannot push, so each device polls. `applyLiveUpdate_` in `app.js` sends a
HEAD for `RELEASE_URL/js/app.js` and compares the **ETag** (a few bytes; GitHub Pages sends one)
with the tag it stored. A changed ETag means a new build is published - even when `APP_VERSION`
was not bumped, which is the common case because the version only moves when the APK must be
rebuilt. The first run only records the tag; a changed tag reloads the page.

It reloads **only at a safe moment** (`updatePaused_`): never while a field has focus, never
with a `.modal.show` open, never on the `memo` page (a half-written sales memo), never while
`cloudDirty` (an unsent edit), never in a hidden tab. A held reload keeps the *old* tag, so the
release is picked up as soon as the moment passes; the new tag is recorded *before* reloading,
so a stale ETag cannot make a device reload in a loop. A reload keeps the device's data, which
lives in `localStorage` and the sheet - only the screen is rebuilt.

`sw.js` fetches app files with `cache: 'no-cache'` so the reload revalidates instead of trusting
Pages' 10-minute `max-age` and serving the old build back. `test/liveupdate.test.js` drives all
of this through the real `app.js` against a DOM shim, with `fetch` as the only seam (14 checks).

This does **not** bump `APP_VERSION` and does not touch the APK: an installed native app still
updates through the APK rebuild path. It only makes the *web* build reach every device faster.
(The alternative - a host with a faster build, e.g. Cloudflare Pages - was not taken: it would
need the owner's account and a migration away from Pages, and this closes the gap without it.)

### Live delta pull: a change on another device lands almost at once (2026-10-12)

The owner asked whether a data edit is "instant" on any device, and it was not: Firestore (the
primary sync path) was only read on open, on `visibilitychange`, and on a 30 s timer, so a memo
typed on the phone could take up to 30 s to show on the PC. `liveDeltaPull_` in `app.js` is the
fast lane: when Firestore is configured and the device is signed in, it calls `cloudPullMerge()`
on an adaptive cadence - every ~2 s while the owner is using the app (a recent pointer/key/touch
within `LIVE_ACTIVE_WINDOW_MS`), backing off to ~10 s once idle.

It reuses the ONE merge the sync tests already prove (`cloudPullMerge -> cloudMergeDelta ->
mergeCloudInto_ -> commit`); it adds no second definition of "newer wins". It runs only the
Firestore delta pull, never the slow Sheet pull, so the frequent ticks stay cheap (a delta read
is a few documents). It stands down while the tab is hidden, while a sync is in flight
(`cloudBusy`/`liveSyncInFlight`), and while this device has an unsent edit (`cloudDirty`), so it
cannot race an upload of the device's own change. The 30 s `cloudAutoSync` keeps running
underneath as the safety net; its own 8 s floor means it will not double-pull right after a live
tick. A failed tick is swallowed - offline is normal, and the 30 s net retries.

This works **with the existing Google Sheet setup only if Firebase is configured**: without
Firebase keys the app still uses the Sheet and the lag is unchanged. `test/livesync.test.js`
drives the gating and the adaptive cadence through the real `app.js` (11 checks). A true
server-push listener (`documents:listen`) was considered and not shipped: its streaming framing
is not reliably documented and could not be tested against the owner's real Firebase, so
shipping it blind to the critical sync path was not worth the risk. An adaptive ~2 s delta pull
gets "almost at once" without it.

### Realtime push: the true "0" path (2026-10-12)

The owner asked for a real 0 - not a fast poll. Firestore's realtime stream is **not** plain
REST - it rides gRPC-Web/WebChannel - so a raw `documents:listen` POST is refused with
`INVALID_ARGUMENT` even with a valid token (a first attempt at `fbListenLoop` proved this against
the live project, then was removed). The one supported browser path is the Firebase JS SDK's
`onSnapshot`, so `cloud.js` lazily imports `firebase-app/auth/firestore` (10.12.0) from the CDN
**only for auth and the listener**; reads and writes stay on the cheap REST path. `fbSdkLoad()`
resolves `false` if the CDN is blocked, and every caller falls back to the REST auth + adaptive
poll, so a blocked CDN can never stop a save.

The listener is a *wake-up*: a snapshot change calls the SAME `cloudPullMerge()` the tests already
prove, so there is still exactly one definition of "newer-wins". Bursts coalesce
(`fbRealtimeMergeQueued`), it stands down while `cloudBusy`/`cloudDirty` so it cannot race the
device's own upload, and `fbRealtimeStop()` (from `fbSignOut`) unsubscribes.

**Boot must start the listener regardless of migration.** `cloudBoot()` used to `return` right
after kicking off `cloudMigrate(true)` when the device had not finished its first full push - so a
*fresh install that imported its old book* sat on the slow poll (up to ~10 s, and only after
`cloudDirty` cleared) until its migration happened to finish, which is exactly the "sometimes it
doesn't update right away" the owner reported. The migration is idempotent and independent of the
listener and the open pull, so the boot now starts all three; migration no longer gates live
sync. `test/realtime.test.js` (19 checks) drives sign-in-through-the-SDK, the wake-up merge, the
coalescing, the burst, the sign-out unsubscribe, the no-SDK fallback, and this boot case.

### The Firebase keys are baked into the build (2026-10-12)

The owner asked that no device ever type in the Firebase keys. `js/firebase-config.js` now
carries the real `apiKey` (`AIza...`) and `projectId` (`texpark-62700`), so every device is
cloud-configured just by opening the site; `fbConfig()` reads the baked config first and any
per-device value second. The Settings -> Cloud sync card therefore has **no key fields** any
more - only "Test cloud", "Send all data to cloud", and the sign-in fields. `saveFirebaseConfig`
and the `stFbKey`/`stFbProject` inputs were removed; `renderSettings` no longer fills them.

These two values are **not secrets** (Firebase puts them in every web client) - the security is
`firestore.rules`, which only lets the signed-in uid read and write its own `shops/{uid}`. So
signing in once per device is still required, and that is the point: baking the *keys* is safe,
baking the *account password* would put the owner's books in a public repo. `test/cloud.test.js`
now asserts a fresh device reports `cloudConfigured() === true` with no typing, and still checks
the keyless-build fallback (blank the baked config) behaves exactly as before.

### One-tap provisioning: the private link, not a baked password (2026-10-13)

The owner wanted every device to reach the live shop with **nothing typed**, and to keep the
data safe. Baking the account password into this public repo would do the first and destroy the
second: anyone who opened the site would auto-sign-in and read the owner's books. Instead the
account lives in a **private setup link** the owner keeps, and the repo stays free of secrets.

`fbAdoptProvision()` in `cloud.js` reads `#cloud=<base64(email:password)>` from the URL
*fragment*. A fragment is never sent to a server and never lands in a referrer, so GitHub Pages
and Cloudflare only ever see a clean page load. Opening the link once stores the account in that
device's own `localStorage` (`texpark_pro_firebase_prov`), scrubs the fragment from the address
bar, and `fbSignInDefault()` signs in and starts the listener and the first full push. Every
later open is silent. `fbProvisionLink()` rebuilds the link for *this* host, so the GitHub Pages
link and the Cloudflare link differ only in origin and the app re-issues the right one.

The link is issued in **Settings -> Cloud sync -> Advanced -> Get private setup link**, from the
device that already carries the account (the owner device, bootstrapped once by the manual
sign-in that is still in Advanced). `cloudSignOutNow()` calls `fbProvClear()`, so signing out
also forgets the account and revokes the ability to re-issue the link.

Verified live: the account signs in against `texpark-62700`, and the rules isolate it - own shop
read `200`, another uid's shop `403`, no token `403`. The link is a **credential**: anyone who
gets it can reach the shop, so it is shared only device-to-device. `test/cloud.test.js` (43
checks) drives a fresh device adopting the link, signing in by itself into the same shop, and
forgetting it on sign-out.


### The live path had two silent blockers (2026-10-13)

After the provisioning link shipped, the owner still saw no live updates. Two bugs, each of
which degraded the device quietly rather than failing loudly:

- **The delta query called the wrong endpoint.** `fbPullDelta()` POSTed to
  `.../shops/{uid}/records:runQuery`. `:runQuery`'s parent is the **shop document**, so the path
  must end at `.../shops/{uid}:runQuery`; the collection form is rejected with
  `INVALID_ARGUMENT: Document parent name ... lacks "/"`. Every pull returned HTTP 400, so the
  device sat in `DEGRADED_SHEET` and the listener's wake-up merge never had anything to merge.
  The in-memory fake accepted any `:runQuery` URL, which is exactly why the suite stayed green -
  the fake now returns the real 400 for a `/records:runQuery` path so it cannot regress.
- **`cloudDirty` could stick true and freeze the listener.** `commit()` sets `window.cloudDirty`
  on every save, and both `fbRealtimeOnChange()` and `liveDeltaPull_()` stand down while it is
  true. It was cleared only by the Sheet-push timer, which returned early when there was no Sheet
  URL - so a **Firestore-only** device latched `cloudDirty = true` on its first save and never
  live-synced again. `scheduleCloudPush()` no longer requires a Sheet URL and clears the flag
  after `cloudBackupNow()`; `flushCloudPush()` always clears it.

Both were confirmed in a real headless-Chromium run against `texpark-62700`: before the fix the
console showed the 400s and `DEGRADED_SHEET`; after it the state is `ONLINE_FIRESTORE` and a
write from another session lands on `onSnapshot` and merges (`cloudPullMerge` runs). Verified
both with and without a Sheet URL, so a cloud-only device is covered.
`test/autopull.test.js` adds the no-Sheet-URL `cloudDirty` regression (41 checks).


### Cloudflare Pages as an optional second host (2026-10-12)

The owner asked to add Cloudflare Pages *and keep* GitHub Pages. Cloudflare needs the owner's
account, which is not available to the agent, so the repo side is wired up and inert until the
owner sets two repository secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). The
workflow `.github/workflows/cloudflare.yml` uploads the same allowlisted `_site` folder the
download/hosting zips carry (via `make-hosting-zip.py`), so no tooling, `.git` or
`android-keystore.jks` is ever uploaded. `docs/CLOUDFLARE_BANGLA.txt` is the owner's guide.

The workflow is a no-op unless both secrets exist (`if: secrets... != ''`), so the repo cannot
go red for a host it is not configured for. The owner set the two secrets, so it is now **live
at `https://texpark-pro.pages.dev`** and serves the identical build to GitHub Pages (verified:
`js/app.js` hashes match). GitHub Pages remains the primary site and the APK's update path
(`RELEASE_URL`/`DEFAULT_UPDATE_URL`) still points at it; Cloudflare is a faster mirror, not a
replacement. The token is handed only to Cloudflare's own CLI (`npx wrangler`), never to a
third-party action. No data is involved: both hosts serve the same public code, and the owner's
data stays in device `localStorage` and the private Sheet.

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

### Parcel return (owner-requested) and the customer-name autocomplete
The shop sends parcels out and some come back, so there are now two books, not one:
- A **return** is its own record (`returns`), saved by `Store.saveReturn` /
  `js/app.js saveReturn`, and written to the `Returns` sheet tab (`Code.gs`).
- Only **good** condition returns go back onto the shelf (`applyReturnToStock`); a
  **damaged** one is recorded and deliberately never becomes sellable stock. Deleting a
  return (`reverseReturnFromStock`) takes good goods back off again.
- Return lines are stored **per product**, so a partial return raises the shelf for the
  right products rather than the first one on the memo.
- Delivery and return share one pending figure. Counting them separately was the bug that
  made a returned parcel still read as pending delivery; the delivery status is
  `Delivered` / `Partial` from the same maths.
- The memo's customer box autocompletes from saved customers (`customerMatch()` in
  `js/app.js`; a "Saved customer bachun" picker in Android `ScreensData`), filling phone
  and address from the record that already exists.
- The return qty is capped at what is still pending, so a memo cannot be returned twice
  over. A memo itself is never blocked by stock - that rule is unchanged.

## The buying price lives twice (the "profit ulta palta" bug, fixed 2026-10-01)
`stockCost(productId)` reads the **stock card first** and only falls back to the product:
`num(s?.cost) || num(p?.cost)`. The Products page writes `p.cost`. So correcting a buying price
there changed nothing on a product that already had a stock card - the card kept the old figure
and every later memo reported profit against it. The owner experienced this as profit going the
wrong way: he typed the real buying price and the margin stayed put.

Both writers now update the card as well, and neither is allowed to write a 0 over a known cost:
- web: `saveProductEdit()` in `js/app.js`
- phone: `Store.setProductCost()` in `android-src/.../Store.java`, called from `ScreensData`

`test/cost.test.js` drives the web path; `test/native.test.js` drives `Store.setProductCost`
on a JVM. The same trap can be entered from the other side - a selling price once typed into the
stock card's Unit Cost outranks the product forever - and a corrected product price now clears it.

## A memo freezes its own cost, so old memos need a separate repair (2026-10-01)
Fixing the buying-price bug fixed **future** memos, not memos already written. `saveMemo` stores
`cost` on each line and computes `memo.cogs`/`memo.profit` once, then saves them; that is correct
for a fresh memo, but a memo written while `stockCost()` returned a stale figure froze the wrong
cost, and correcting the product today does not reach back into it. The owner saw this as profit
staying wrong no matter what he typed into the product.

`planMemoCostRepair()` / `applyMemoCostRepair()` (db.js) and the identical pair in
`Store.java` rewrite those memos against the product's buying price **now**. Rules that matter:
- **Preview and apply must agree.** The plan is pure - it reads `db` and returns what would change
  - so the number the owner approves is the number that gets written.
- **Never rewrite against a missing price.** A deleted product, or a cost of 0, means the price is
  unknown; that line is skipped rather than zeroed. Guessing would turn a wrong profit into a
  confidently wrong one.
- **A second run is a no-op**, because a line whose cost already matches is not in the plan. This
  is what makes it safe to press twice.
- **Stock is not touched.** Cost affects profit, not quantities, so available/sold/purchased stay
  exactly as they were. Only `cost`, `cogs` and `profit` are written.
- The UI is on the **Backup / Data** page (web) and the **Backup** screen (native), and it always
  shows the old-vs-new totals and asks before writing.
`test/repair.test.js` (30) drives the web path through the real DOM; `test/native.test.js` has a
`costRepair` op that checks the same invariants on the JVM.

## An unpaired device looks exactly like lost data (2026-10-01)
The owner reported the phone dashboard showing empty/wrong data. Root cause: `syncUrl` is a
**per-device** setting (`LOCAL_SETTING_KEYS` in db.js), so configuring it on the PC does nothing
for the phone. The phone was a fresh device with `syncUrl: ''`, so it rendered its own empty
database - three seed products at 0, every figure à§³0 - and nothing on screen said why. He read it
as his data being gone.

Two changes, and the reasoning behind them:
- **Say it on the page he actually opens.** `renderSyncWarning()` shows a loud banner at the top of
  the Dashboard whenever `syncUrl` is empty, and it distinguishes "no data of your own yet" from
  "you have N records here that are not on the sheet". The fix button focuses `#stSyncUrl`.
- **The URL has to travel by hand or by link, because sync cannot deliver it.** `?sync=<url>` on
  the address bar is adopted by `adoptSyncFromLink()` in `boot()`, validated to
  `script.google.com`, then stripped with `history.replaceState` so the sheet id is not left in
  history. `togglePairing()` on the banner generates that link.
- Native parity: the same banner is the first thing in `Screens.dashboard()`, and the fix button
  navigates to `settings`.
`test/pairing.test.js` (31) pins the empty-`syncUrl` case, the à§³0 dashboard and the seed products,
so this symptom can never be "fixed" by changing what an unpaired device displays.

## Build + test commands

- `node build.js` (in `texpark-pro/`) regenerates **both** the repo root and
  `../texpark-pro.html`. Always run this after changing source, or the shipped files drift.
  The script asserts the new cloud/device functions are present in the single file.
- `npm test` runs `test/logic.test.js` (84), `test/sheet.test.js` (48), `test/e2e.test.js` (251),
  `test/cost.test.js` (11), `test/journey.test.js` (19), `test/autopull.test.js` (32),
  `test/return.test.js` (51), `test/session.test.js` (25), `test/pairing.test.js` (31),
  `test/repair.test.js` (30), `test/ownerdata.test.js` (29), then `node --test test/android.test.js`
  (27) and `node --test test/native.test.js` (30). Total 668.
- `test/sheet.test.js` now also pushes a >200 KB and a >2 MB payload through the real `Code.gs`,
  pulls each back byte-identical, proves a smaller backup leaves no stale chunks, reads a
  hand-written legacy single-cell row, and checks that a missing chunk and a wrong checksum are
  each reported instead of returned as a half-backup.
- `test/cost.test.js` and `test/journey.test.js` both drive the **real `app.js`** through the DOM
  shim: the first pins the buying price reaching the stock card, the second walks the owner's own
  path (add product, pick it on a memo, read the profit) so a UI-level regression is caught.
- `test/merge.test.js` and `test/autopull.test.js` load `db.js` **and `sync.js`** into a `vm`
  context each, so two "devices" can be run against one fake sheet and the merge is exercised as
  two databases rather than as one.
- `test/sheet.test.js` loads the **real `Code.gs`** in a `vm` context with stubbed
  `SpreadsheetApp`/`ContentService`, so server-side backup/pull/upsert logic is actually executed.
- Current version: `2027-01-01.10` in `sw.js`, `js/app.js`, `version.txt` and
  `MainActivity.java` (bump them together, then rebuild â€” the e2e test fails if the two js
  files drift apart, and `ci/check-site.py` fails if the Java or the APK drifts too).
- `Code.gs` lives in **two** places and they are the same file: `texpark-pro/Code.gs` is the
  source, and `build.js` copies it to the repo root (where Pages serves it for the owner to
  copy from). Edit the source copy, never the root one, or the next build silently reverts it.

## The memo sheet (the document the customer is handed)
A memo is the shop's main output, so it is drawn as a real document and not as a text dump:
navy header band, Bill To / From boxes, a striped item table, an amount-in-words strip, a totals
card with the grand total and the due highlighted, two signature lines, terms and a thank-you.
- **Web**: `memoSheet()` in `js/app.js` builds the markup; its stylesheet is the `MEMO_CSS`
  constant in the same file, not a block in `css/app.css`. That is deliberate â€” the PNG/PDF
  export wraps the markup in an SVG `foreignObject` whose only stylesheet is `MEMO_CSS`, so a
  class the sheet uses but the constant does not style downloads as unstyled black text.
  `test/e2e.test.js` cross-checks every class the sheet emits against `MEMO_CSS`, which is the
  check that keeps the two in step.
  **The constant must also reach the page.** `memoCssTag()` appends `MEMO_CSS` as a `<style>`
  and `boot()` calls it first. Without that the exports still looked right (they carry their own
  copy) while the preview rendered as unstyled HTML â€” a failure the class cross-check above
  cannot see, because it only compares the markup to the string, not the string to the document.
  The e2e shim gives `document` a real `head` so a test can assert the tag lands there and that a
  second `boot()` does not append it twice.
- **Export**: `js/memoexport.js` writes PNG and PDF with no library â€” canvas for the PNG, and a
  hand-built one-page PDF for the file (`pdfFromJPEG`). It is a *five-object* PDF: catalog,
  page tree, page, image XObject, content stream. The test parses the xref table back and
  asserts each offset lands on its object, because a wrong offset gives a PDF that looks fine
  in the bytes and is refused by every viewer.
- **Native**: `MemoSheet.java` builds the same sheet out of real Android views, and `viewMemo()`
  shows it with Share (PNG) and Save PDF buttons. `toBitmap()` measures *and* layouts the view
  before drawing â€” skipping either gives a blank white rectangle, i.e. a share that silently
  sends nothing. The native app still has **no print path**; the buttons are named for what they
  do rather than promising a printer that is not there.
- **One wording, two renderers**: `Store.MEMO_TERMS`, `Store.MEMO_THANKS`, `Store.money`,
  `Store.qty` and `Store.numberWords` hold the sentences and the figure formatting, and the web
  app prints the same ones. The Android `Ui.money`/`Ui.qty`/`Ui.words` are thin wrappers over
  `Store`, because a memo that reads one way on the PC and another on the phone is the defect
  this structure exists to prevent.
- **`money()` must match `db.js` exactly**, and it did not: the native copy wrote `à§³145.50` where
  the web writes `à§³145.5`, and `à§³2400` where the web groups to `à§³2,400`. `test/native.test.js`
  now feeds both implementations the same amounts and compares the strings rather than
  hard-coding an expectation, so the next drift fails the build instead of the shop's paperwork.

## Android app (rewritten natively 2026-09-29)
`TexparkPro.apk` â€” a **fully native** app, not a WebView. The owner asked for a real Android
app, and the WebView had a fatal flaw he reported himself: **a memo could not be printed**,
because `window.print()` does nothing inside a WebView, and printing memos is the shop's main
job. Native also brings the real keyboard, date picker, back button and voice recogniser.

- Source: `android-src/com/texpark/pro/` â€” `MainActivity` (shell, top bar, sidebar, back,
  updates, voice plumbing), `Screens`/`ScreensData`/`ScreensMore` (every screen), `Ui`
  (widgets), `Store` (data + business rules), `Json`, `Sync` (Sheets backup/pull), `Voice`
  (spoken-sentence parsing), `Updater`/`SiteUrl`. Plain framework APIs only â€” no AndroidX,
  so there is no dependency resolution and no Gradle download.
- Build: `ANDROID_HOME=/opt/android-sdk python3 build-apk.py` â†’ `TexparkPro.apk` (~85 KB),
  signed with `android-keystore.jks`. **Keep that keystore** â€” a different one makes the new
  APK a different app, so it will not install over the old one.
- The SDK is **not** preinstalled and `/opt` is not writable for the agent user. Set one up under
  a writable path and point `ANDROID_HOME` at it: unzip
  `commandlinetools-linux-*_latest.zip` from `dl.google.com/android/repository/` with Python's
  `zipfile` (there is no `unzip` binary), `chmod +x` the tools in `cmdline-tools/latest/bin`,
  then `sdkmanager --sdk_root=<sdk> "platforms;android-34" "build-tools;35.0.0"`. JDK 17 is
  needed too. Any version bump **must** rebuild the APK before pushing, or `ci/check-site.py`
  fails the push with "TexparkPro.apk does not carry version ...".
- The version is stamped in three places by the build and checked by `ci/check-site.py`:
  `build.js` writes `version.txt` from `js/app.js`, and `build-apk.py` rewrites
  `MainActivity.APP_VERSION` from it before compiling. If they drift, the app offers the same
  "update" on every launch.
- `test/native.test.js` compiles the shipped `Json`, `Store` and `Voice` on a plain JVM and
  runs the real classes against the real JS business rules (30 tests). The shop's central
  rule is driven through `Store.saveMemo` itself: a memo for a product with **no stock card at
  all** must save, must create the card, must clamp `available` at 0, and must keep the whole
  quantity as a reported shortfall. That rule used to live in `ScreensData`, where an
  Android-only class could not be tested; it now lives in `Store` for that reason.
- **`totalQty` is part of `Store.memoMath`, not a per-screen sum.** Delivery and parcel
  return are both measured against it (`pendingQtyOf` = `totalQty` âˆ’ delivered âˆ’ returned),
  so if a screen added the quantities up itself the two would drift and a returned parcel
  would keep reading as out for delivery. The JS `memoMath` has always emitted it; the Java
  one did not until the return work, which is why `pendingQtyOf` silently returned 0.
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
- Recovery paths that exist on purpose: load failure â†’ dialog offering retry / change address;
  long-press Back â†’ change the stored address without losing data (data lives in WebView
  localStorage, not in the APK, so changing the address never wipes business data).
- Guide: `ANDROID_BANGLA.txt`. Download page: `demo.html`, generated by `make-demo.py`
  (two QR codes â€” the app APK and the web app â€” plus the install steps).
- **Update discovery reads `js/app.js`, not `version.txt`.** The live host was configured with
  Netlify's `/* /index.html 200` fallback, so every unknown path â€” including `version.txt` â€”
  came back 200 full of HTML. The updater had no way to tell a real version from that page and
  would sit on an old build forever. `Updater.versionIn()` pulls `APP_VERSION` out of
  `js/app.js` (a file the app genuinely needs, so a fallback cannot fake it) and
  `Updater.referencedFiles()` derives the file list from `index.html` itself. `version.txt`
  survives only as the stamp the APK's own bundled build is compared by; `filelist.txt` is gone.
  `make-hosting-zip.py` writes **no** `_redirects` so a missing file 404s instead of returning
  a valid-looking page â€” a catch-all rewrite is the one host setting that breaks the updater.
  **This rule has now regressed once.** The native-app rewrite (`75f3561`) reintroduced a bare
  `root + "/version.txt"` read inside `hasNewerRelease`, undoing `253a0f2`. The docs, the tests
  and the fix all still said `js/app.js`, so nothing caught it: the only symptom was an owner
  whose phone never offered the build that already had his fix. `hasNewerRelease` is now a
  one-line wrapper over `releaseVersionAt()`, which cannot read a version without passing the
  bytes through `looksLikeBuildFile()` first. Guarded by
  `android: the update check reads the app script, not version.txt`, which runs the real class
  against a real socket that fakes `version.txt` with HTML.
- **A stale mirror must not be able to hide a release.** An install can hold an address that
  stopped being updated â€” the old WebView shell's default was
  `https://keen-rolypoly-3f9aa4.netlify.app`, still up and still serving `2026-09-22.6`, with
  `version.txt` answered by the HTML fallback. Such an install would never hear about a new
  build. `MainActivity.releaseWithNewerApk()` therefore tries the owner's configured address
  first and `DEFAULT_UPDATE_URL` second, and `updateUrl()` falls back to the old shell's prefs
  (`texpark`/`site_url`) so a custom address the owner typed there survives the migration. The
  web app does the same for a PWA opened from a stale origin: `checkForUpdate()` compares its own
  `APP_VERSION` against `RELEASE_URL` and prints the released link instead of "you are up to
  date". `versionNewer()` does the compare numerically, because `2027-01-01.10 > 2027-01-01.9`
  as numbers but not as strings â€” the same trap `Updater.compareVersions` exists to avoid.
- **`caches.addAll(ASSETS)` in `sw.js` install is a trap.** It rejects the entire install if a
  single entry 404s, so the new worker never activates and the phone keeps serving the old CSS
  and JS forever with nothing on screen to explain it. The install caches each asset
  individually and tolerates a miss, except for `REQUIRED` (`index.html`, `js/app.js`), where a
  miss still fails loudly â€” a half-cached app is worse than an old one.
- A JDK is not part of this image and `apt` has no `openjdk-*` package. `test/android.test.js`
  and `test/native.test.js` need `javac`/`java` on `PATH`, so on a fresh shell they report a
  **false failure** â€” it is a missing tool, not broken code. Fix:
  `curl -sL -o /tmp/jdk.tar.gz https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse`,
  unpack under `/tmp/jdk17`, then `export JAVA_HOME=/tmp/jdk17; export PATH="$JAVA_HOME/bin:$PATH"`.
  Setting `JAVA_HOME` alone is not enough â€” the suite runs bare `javac`, so the directory has
  to be on `PATH` too. Both suites say "javac not found" rather than throwing an ENOENT stack,
  so this is not misread as a regression.
  `/tmp` does not survive a terminal reset: after one, expect the two Java suites to fail until
  the JDK is fetched again. The pure-Node suites are unaffected.
- Demo: `demo.html` at the repo root pairs a QR for the APK with a QR for the web app, so the
  owner can install and open both without typing a hostname. Generate it â€” do not hand-edit it:
  `python3 make-demo.py` reads the host out of `MainActivity.DEFAULT_UPDATE_URL`, draws both
  codes with segno, decodes them back with cv2 and refuses to write a page if a code does not
  read as a URL the page prints.
  This page is a trap that already sprang once. It kept a sandbox address and a "Netlify is what
  makes it permanent" note long after hosting had actually moved, and nothing noticed because a
  QR that leads nowhere looks exactly like one that works. `ci/check-site.py` now fails if
  `demo.html` disagrees with the app's host, mentions `prod-runtime.all-hands.dev`, or carries a
  code that decodes to anything the page does not print.
- The catalog pages (`catalog/index.html`, `catalog/download.html`, `catalog/catalog-pro-v1.html`)
  live in `catalog/`, so their links are **relative to that folder**: the root-level downloads are
  `../TexparkPro.apk`, `../texpark-hosting.zip`, `../texpark-pro-download.zip`, `../texpark-pro.html`,
  and the sibling pages are bare names (`download.html`, `catalog-pro-v1.html`). They were once
  written as `./download.html` / `./TexparkPro.apk`, which resolved against the repo root and gave
  the owner a 404 on every download button â€” a broken link is invisible in a rendered page, so
  check the paths on disk (`python3` walk from the repo root) after touching these files.
- `make-zip.py` builds `texpark-pro-download.zip` from an **allowlist**, never a walk of the repo
  root. It used to `os.walk(root)` with `src = root`, which swept in `.git/` and
  `android-keystore.jks` (the APK signing private key) and â€” because the walk reached the zip file
  being written and recursed into it â€” grew the archive without bound instead of finishing. The
  allowlist lives in `APP_FILES` / `APP_COPIES` / `TOP_FILES` / `CATALOG_FILES`; the catalog is
  mirrored under `catalog/` in the zip so its `../` links still resolve offline. Keep the
  `assert` block at the bottom â€” it is what fails a build that would publish the key or the history.
- Both zip builders pin their entry timestamps (`WHEN`, overridable with `SOURCE_DATE_EPOCH`).
  A zip stores a modification time per entry, so two builds of identical content used to come
  out byte-different: `git status` showed the committed `.zip` as modified after every run, which
  made a real change to the archive indistinguishable from a rebuild. After touching either
  builder, run it twice and compare `md5sum` â€” they must match.

## Live multi-device sync (Firestore) with the Sheet as fallback (2026-10-07)

The Google Sheet sync (`js/sync.js`) pushes a whole JSON snapshot and the newest snapshot wins as
a set. It is verified and retried, but it is not live, and a phone edit reaches the PC only on the
next snapshot round. `js/cloud.js` adds per-record sync over Firestore so one changed memo is one
document write and one document read â€” not the whole book â€” and it arrives in seconds. Design:
`docs/FIRESTORE_PLAN.md`. Owner setup: `docs/FIRESTORE_SETUP_BANGLA.txt`.

- **No SDK, no build step.** Firebase Auth and Firestore are spoken over their REST APIs directly
  (`js/cloud.js`). The app has no bundler and must keep running from a USB stick; loading the
  Firebase JS SDK would add a second, versioned dependency and an async init to every page.
- **Data model.** One shop per signed-in account: `shops/{uid}/records/{key}__{id}`. The uid is a
  path segment, so a range query needs no composite index and the rules can prove ownership
  (`texpark-pro/firestore.rules`, deny by default). Record keys are the `MERGE_KEYS` collections;
  business settings ride as one `_settings__shop` document.
- **One merge, not two.** A Firestore delta is converted back into the `incoming` shape and pushed
  through the *same* `mergeCloudInto_` the Sheet pull uses (`cloudMergeDelta`). There is exactly
  one definition of "newer wins" in the app; `cloud.js` must never grow a second.
- **The free-plan rule: delta only.** Both directions use the record's `at` stamp. Pull is a
  `runQuery` with `where at > cursor orderBy at`; push sends only records whose `at` moved since
  the last commit (`cloudQueueChanges`, fed the pre-commit index from `commit()`). The test asserts
  a pull with nothing new reads **zero** documents. A whole-collection read would burn the Spark
  50k/day read budget â€” do not add one.
- **One outbox, two transports.** `syncPush(..., via)` defaults to `'sheet'`; `'firestore'` jobs are
  sent by `cloudSendJob` and share the queue, retry and badge. Because a commit now queues many
  records, `syncFlush` is non-re-entrant (`syncFlushing`) and drains continuously (it picks the next
  pending job each turn), not from a snapshot â€” otherwise jobs queued mid-flush would wait for the
  retry timer.
- **The Sheet fallback is never the resting state.** A quota/offline/`NOT_SIGNED_IN` failure sets
  `DEGRADED_SHEET`, arms a backoff retry (30sâ†’15m), and the same record is also pushed to the Sheet
  `Records` tab (through the existing outbox) so the Android app, which has no Firestore, still
  sees every web change. A success returns to `ONLINE_FIRESTORE` and drains what queued.
- **Settings keys are machine-local.** `firebase` joined `LOCAL_SETTING_KEYS`, so one device's
  project id is never merged onto another's.
- **Migration is idempotent.** On first successful connect the whole local book is upserted in
  chunks (batched `:commit`), then `texpark_pro_firestore_migrated` is set. Re-running upserts on
  the record id, so it can resume safely.
- **Unconfigured = untouched.** With no keys the app behaves exactly as before; nothing in
  `cloud.js` runs. `test/cloud.test.js` drives the real `cloud.js` against an in-memory fake of
  Auth + Firestore with quota/offline toggles, and covers two devices, delta reads/writes,
  deletes/tombstones, payments, degradeâ†’recover, offline queueing.
- **Code.gs `Records` tab** (`record` / `records` routes, version 5): upsert keyed on
  Collection + Record ID, chunked like a backup, `since` delta reads. The same finite-grid care as
  `saveBackup_` applies â€” grow rows/cols before writing.
- **No APK/signing change.** Android keeps using the Sheet; the web app mirrors to it. Do not
  rebuild or re-sign the APK for this.

### Live latency, and why a version bump is blocked (2026-10-13)

The owner reported that a phone opening the site took ~20 s to show another device's change, and
that it only became ~10 s after a sign-out/sign-in. Root cause: the adaptive live poll
(`liveLoop`/`liveDelay_` in `js/app.js`) stayed on the **idle** cadence (8 s, was 10 s) until the
first user touch, because `liveLastActivityAt` starts at 0. A cold open is exactly when the owner
is watching, so it must poll fast. Fix: a `LIVE_BOOT_WINDOW_MS` (20 s) window keeps the first
pull at the 2 s active cadence; `cloudBoot()` after a late provisioning sign-in now also calls
`fbRealtimeStart()` + `cloudArmRetry()`, because it previously returned early and never started
the listener on that path. The duplicate 30 s `cloudAutoSync('timer')` and the 30 s
`courierAutoSync` interval were removed (`liveLoop` already polls faster; `visibilitychange`
covers the rest) â€” courier keeps its own 15-minute timer.

- **The service worker only re-installs when its bytes change.** `js/sw.js` must be touched (a
  version bump does it) for a new worker to install; otherwise a phone keeps the old worker. But
  the fetch handler already serves `js/*` and `index.html` with `cache: 'no-cache'` (revalidate),
  so **changed JS reaches a stale device on the next load even without a bump** â€” that is how the
  earlier `runQuery` fix landed.
- **`APP_VERSION` cannot be bumped here.** `ci/check-site.py` requires `version.txt`, `js/app.js`,
  `js/sw.js`, `MainActivity.java` and the bundled `TexparkPro.apk` to all carry the same version.
  The APK is signed with a key that is deliberately kept off GitHub (see the signing note in
  `docs/`), so a new APK cannot be produced in CI or this sandbox. Bumping therefore fails the
  `Verify` job. Leave `APP_VERSION` alone; the SW revalidation delivers JS-only fixes.

#### The push stream must heal itself, and the poll cadence follows it (2026-10-13)

Measured on the live site, the Firestore `onSnapshot` stream delivers a remote write in **~0.3 s**
— that is the "instant" the owner wants. The mistake was resilience: `fbRealtimeStart`'s error
callback was empty (`function () { /* poll carries it */ }`), so one dropped stream (network
change, `idleServer` timeout, refused listen) silently demoted the tab from push to the idle poll
for the rest of the session. That is exactly the "sometimes live, sometimes 20 s behind" report.

- **Reconnect with bounded backoff.** A failed stream is torn down, `fbRealtimeUnsub` is cleared
  (so `fbRealtimeLive()` never lies), and a retry is armed at 1 s doubling to 30 s. A healthy
  snapshot resets the backoff. The error callback captures its own `unsub` in a local `live` flag,
  so `fbRealtimeStop()` (sign-out) can never let a stale callback resurrect a stream.
- **`fbRealtimeLive()` drives the poll.** `liveDelay_()` in `js/app.js` polls at **2 s while the
  stream is down** (the poll is then the only path — this also makes a no-Firebase/Sheet-only
  device still feel live) and at **15 s while the stream is up** (push does the work; a 2 s poll
  would only burn the Spark read quota for no visible gain). Cold-open and recently-touched still
  force the fast cadence.
- **Returning to the tab re-arms the stream.** `visibilitychange` calls `fbRealtimeStart()` when
  `fbRealtimeLive()` is false, because a backgrounded tab often has its stream torn down.
- **The owner must be able to SEE it.** The top `syncBadge` reads **"Live"** with a pulsing dot
  (`.sync-live`) whenever `fbRealtimeLive()` is true and nothing is pending, and `livePulse_()`
  flashes a `.sync-bump` animation the moment `cloudPullMerge` applies a remote change. The point
  is that a sub-second arrival is otherwise indistinguishable from "nothing happened", which is
  exactly what made the owner doubt the sync. Both are pure UI and fully guarded.
- **There is no exact 0 s, and none is promised.** A write crosses a network; ~0.2–0.5 s is the
  floor (measured ~0.33 s). The guarantee is "always sub-second while the stream is up, never
  worse than a 2 s poll when it is not". Android is native (no Firestore) and polls the Sheet on
  its own cadence; making it instant would be an APK change, and the APK cannot be rebuilt here
  (see the version note).

## Orders Command Center (2026-10-06)

The owner asked for a dashboard section with a button that opens an order overview, styled as a
premium enterprise screen: summary tiles, urgent work first, a delivery calendar, reminders, the
full board and the lifecycle. It lives on its own `orders` page, reached from a card at the bottom
of the Dashboard.

- **An order is not a memo.** A memo is what was actually sold; an order is the promise before any
  sale (a memo can settle several orders, one order can split across deliveries, and an order
  exists before stock does). `db.orders` is a first-class collection, added to `MERGE_KEYS`,
  `migrate()` and `blankDB()` so it travels between devices through the same one "newer wins"
  merge as every other record. Never make an order a memo to reuse code.
- **Lifecycle, with overdue derived.** Stored status is `received -> in_progress -> ready ->
  dispatched -> delivered`. `overdue` is never stored: `orderDisplayStatus()` turns an active
  order whose `deliveryDate` is behind today into `overdue` at read time, so a date that passes
  turns red on its own and a delivered order never goes overdue. `isOrderOverdue`,
  `orderDaysLate_` and `ordersByUrgency` are the pure rules and are covered directly in the test.
- **One source for every count.** `orderSummary()` feeds the dashboard card, the Orders tiles and
  the tests, so the dashboard and the Orders page can never disagree. Reminders come from the pure
  `orderRemindersFor()` (preparation N days before, dispatch on the day, overdue alert daily);
  the per-order `remindLeadDays` overrides the shop default `settings.reminderDefaultLead`.
- **Entry + sync.** `saveOrder` / `setOrderStatus` are the only write paths, so the history line
  and the `syncPush('order', ...)` are never skipped. Code.gs gained an `Orders` tab and the
  `order` route (upsert keyed on Order No) as the Sheet fallback for the Android app; Firestore
  carries it through `MERGE_KEYS` with no extra work.
- **Settings.** `orderPrefix` (default `TP-`) and `reminderDefaultLead` (default 1) live in
  `DEFAULT_SETTINGS` and are edited in Settings -> Company.
- **Test.** `test/orders.test.js` (49 checks): overdue/urgency/reminders as pure rules, summary
  counts, save/number/validate, a status move plus persistence, board/attention/reminder/calendar
  rendering through the real `app.js`, the dashboard banner, and a two-device merge.

### Memo â†’ Order bridge, and SL numbering (2026-10-06, follow-up)

- **The memo page can open the order, but only when asked.** A collapsed "Add to Orders (optional)"
  card sits under the memo. It is off unless the owner turns the switch on
  (`settings.memoOrderEnabled`, default `false`). Turned on, `saveMemo` also calls the one
  `createOrderFromMemo`, so the order's history line and `syncPush('order', ...)` are never
  skipped. Editing an existing memo never opens a second order â€” `createOrderFromMemo` is keyed on
  `memoId` and returns the existing link.
- **The bridge is a link, not a copy.** The order stores `memoId` + `memoNo` and is shown in Memo
  History as `#TP-0001`; a memo with no order offers a one-click **Create Order**. Deleting a memo
  keeps its order (it is a separate promise) and only drops the link, so no order points at a dead
  memo. `memoOrderLink(memoId)` is the single lookup.
- **Memo History numbers every row.** An SL column (1, 2, 3 â€¦) is the row's position in the
  displayed, search-filtered list, so the owner can see how many memos there are. A count pill
  (`hCount`) states the total ("N memos in total" / "N memos matching").
- **Test grows to 69 checks** covering the switch off/on, the linked order's fields, the
  no-duplicate edit, the history one-click path, unlink-on-delete, and the SL/count rendering.


## Booking a Steadfast parcel from the order itself (2026-10-11)

Until now `courier.js` could only *follow* a parcel that already existed at Steadfast: the
owner booked it in the Steadfast portal, pasted the tracking link, and the app synced the
status back. The booking half now lives on the order too, so the whole courier job is one
place â€” `Book with Steadfast` in the order modal, next to the existing `Sync Courier Status`.

- **Idempotent by invoice, not by hope.** `courierInvoiceFor_` builds `TXP-<orderNo>`; the
  same order always produces the same invoice, so pressing Book twice, or retrying after a
  dropped reply, cannot create a second parcel â€” Steadfast refuses the duplicate invoice.
  `bookOrderCourier` also refuses outright once `order.consignmentId` exists.
- **Nothing is recorded before Steadfast confirms.** `courierBookOrder_` writes the
  consignment id, tracking link, `courierStatus: 'pending'` and a history line only after a
  reply parses; a failed call leaves the order exactly as it was. `courierBookFetch_` is the
  one seam a test stubs, so the payload and the reply handling are checked without a socket.
- **The recipient details are derived, not retyped.** `courierBookingDraft` reads the order's
  own fields first, then falls back to the memo it settles, then to the saved customer, and
  the COD defaults to the memo's remaining due (`memoRemainingDue`, floored at 0). A
  hand-typed value in the modal is never overwritten by a stale record.
- **The modal tracks the order.** `renderOrderCourier` now fills `#ordConsignment` and
  `#ordTrackingUrl` from the order when they are blank. Without that, the next `saveOrder`
  would re-derive the *tracking code* out of the URL and overwrite the *consignment id* a
  booking just stored â€” the two are different ids, and only the numeric cid routes a status
  check to `status_by_cid`.
- **Web-only, like the tracking half.** The Android app has no courier support and WebView
  CORS/credential handling makes a native port a separate project; nothing here touches the
  APK beyond the version stamp, which still has to be rebuilt every release.
- `test/courier.test.js` grows from 43 to **71 checks**, adding the invoice/phone/draft
  rules, the payload, reply and error parsing, the one write path, the modal field sync, and
  the two refusals (already booked, blank address).


## The Bangladesh area check was removed at the owner's request (2026-10-11)

The opt-in area feature (added 2026-10-11 in commits `2e19e7b` #8, `51e836c` #9, `b2b1c8d` #10,
`5f356ca` #11, `2ee6a39` #12) is gone, and the code is back to the state it was in before it
(`c30e14b`, PR #7). The owner asked to remove the Division -> Ward tables from the order form and
to be able to do the area handling manually. **Do not reintroduce it without a fresh instruction.**

What was removed, so nothing is half-left behind:

- `js/address.js`, `js/bd-locations.js`, `test/address.test.js`, `tools/gen-bd-locations.js`,
  `data/bd-locations.json`, `data/SOURCE.md` â€” the resolver, the generated bundle, its test and
  its generator. The two js files are gone from the repo root too (build output).
- `index.html`: the `Detect and correct the delivery area from the address` settings toggle, the
  `Address data:` version readout, the `#ordAddrCheck` block, the `oninput="onOrderCustomerChanged()"`
  on the customer field, and the two `<script>` tags.
- `js/courier.js`: `localizeCourierPhone_`, the whole offline area-detection/correction section
  (`renderOrderAddressCheck`, `bdOrderLocationStatus_`, `_bdSel`, the `onOrder*Changed` handlers,
  `courierCorrectDraft_`, `courierAutoFixEnabled_`, `applyOrderAddressCorrection_`, `courierFixedDraft_`,
  `_courierForm`/`_courierFormLive_`), the `courierAddressCheck` gate in `courierBookOrder_` and
  `bookOrderCourier`, and the address-check toggle read in `saveCourierSettings`. `courierBookingDraft`
  is back to its original name+phone customer match; `courierDraftFromForm_` reads the inputs directly.
- `js/app.js` (`onOrderCustomerChanged` + the settings/version reads), `js/db.js`
  (`courierAddressCheck`), `sw.js` (asset list), `build.js` (script list), `make-zip.py` (allowlist),
  `package.json` (the address test), and the area test cases in `test/courier.test.js`.

After the change `js/courier.js`, `index.html`, `js/app.js`, `js/db.js`, `sw.js` and `build.js` are
**byte-identical to `c30e14b`**, and the built `index.html`/`texpark-pro.html` are identical too.
`test/courier.test.js` keeps only its 71 pre-area checks; the full suite is green and `ci/check-site.py`
and `ci/check-zip.py` pass. No `APP_VERSION` bump, so the APK and its signature are untouched.


## Live sync now runs on Cloudflare, not Firestore (2026-10-13)

The owner wanted the business data off Firebase and Sheets, and truly instant. Live sync is
now a **Cloudflare Worker + one Durable Object per shop** (`cloudflare/`), holding each shop's
records in the object's SQLite and fanning every write out over a WebSocket. A change typed on
one device reaches the others in **~0.1 s** (measured 106-107 ms in a real two-browser test),
not the 1-2 s of the old poll.

How it is wired, and the rule that keeps it reversible:

- **One interface, two backends.** `js/cloud.js` still owns the merge, the cursor and the
  write queue; every Firebase function now first asks `cfOn_()` (in `js/cloudcf.js`) and, when
  the Cloudflare backend is on, calls its `cf*` twin instead. Nothing else in the app changed.
- **`js/cloudflare-config.js`** carries the URL and the `backend` switch only. It now ships
  with `backend:'cloudflare'` and the deployed URL
  (`https://texpark-sync.apple-ziarash1.workers.dev`), so the live app uses Cloudflare and
  Firestore stays the fallback behind the same interface. The shop
  **token is never committed** (this repo is public; a committed token would expose the
  whole shop). It is delivered per device through the same private-link mechanism the
  Firebase account uses: `fbAdoptProvision()` also accepts a `cf|<token>` payload, stores
  it in `db.settings.cloudflare` (which `cfConfig()` already reads) and scrubs the address
  bar. The owner can also paste the link/token in Settings -> Cloud sync -> Connect.
- **The secret must not gain a newline.** The deploy step sets `AUTH_TOKEN` with
  `printf '%s' "$TOKEN" | wrangler secret put` (not `echo`, which appends `\n`), and
  `tokenMatches` trims both sides. With a newline the stored secret was `<token>\n`, so every
  correct token was rejected with 401 while the Worker looked perfectly healthy - that was the
  second bug here, and `logic.test.mjs` now covers both the newline and the whitespace cases.
- **Zero-typing without a public token needs a gate.** A token baked into a public site's JS
  is readable by anyone, so the app stays token-free and uses the private setup link by
  default. The one safe way to drop the link is to put the Cloudflare Pages site behind
  **Cloudflare Access** (free up to 50 users; the JS is then not served to the public) and
  bake the token into *that* build. The bake is a separate, opt-in workflow step gated on the
  repo variable `CLOUDFLARE_BAKE_TOKEN == 'true'`; it edits only the built `_site` copy, so the
  committed file and the public GitHub Pages build never carry the token. GitHub Pages cannot
  be put behind Access, so it must stay link-based. Enable Access first, then flip the
  variable - the order is the whole safety argument. See `docs/CLOUDFLARE_ACCESS_BANGLA.txt`.
- **CORS is required and easy to miss.** The app is served from a different origin than the
  Worker (Pages -> Workers), so the Worker answers `OPTIONS` and sends
  `access-control-allow-origin: *`. Without it every fetch fails with "Failed to fetch" while
  the badge silently degrades - that was the first bug here. The token, not the origin, guards
  the shop.
- **The WebSocket uses the hibernation API** (`ctx.acceptWebSocket(server)`, never a bare
  `accept()` first - that throws "already accepted"). The Worker allows the token-in-query form
  on loopback http for local dev and requires https elsewhere.
- **"Newer wins" lives in one pure function** (`decideApply`), the delta window in another
  (`selectDelta`); the Durable Object calls them, and `cloudflare/test/logic.test.mjs` tests
  them without a Worker. `cloudflare/test/e2e.test.js` is the on-the-wire check (run a
  `wrangler dev` first, or point it at the deployed URL).
- **Deploy**: `.github/workflows/cloudflare-sync.yml` deploys `cloudflare/` when the secrets
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_SYNC_TOKEN` exist, pushing the
  token as a Worker secret. `docs/CLOUDFLARE_SYNC_BANGLA.txt` is the owner-facing guide.
- **Tests**: `test/cloudflare.test.js` (28 checks) drives the real `cloud.js`+`cloudcf.js`
  against a stand-in WebSocket/fetch; it is in `npm test`, and `verify.yml` also runs the
  Worker's `logic.test.mjs`.

## Gotchas found while auditing live sync (2026-10-13)

- **"Today shows 0" is usually true, not broken.** In a 24/7 counter shop the owner
  reads a zero as a sync failure. Verify against the Worker before believing it: the
  last memo date and the app's Today tile agree when the day genuinely has no memos.
  The badge ("☁ Cloudflare live") on both devices is the evidence.
- **A calendar day must come from the device clock, never `toISOString()`.** That is UTC;
  Bangladesh is UTC+6, so `today()` answered yesterday for every write between midnight
  and 6am - a 1am memo was dated the day before and "Today's sales" read zero.
  `ymd_()`/`today()` in `js/db.js`, the dashboard chart and the date-range shortcuts now
  use the local date. `test/date.test.js` pins it. Same trap for any new "today" code.
- **A fresh device is the real test.** Clear a browser's storage, open the `#cloud=`
  link, and check it pulls the full book (memos/customers), not the demo seed. The seed
  products (`seed-k3s` etc.) have stable ids by design and are *meant* to sync; a device
  whose OWN ids are missing started blank, it did not fail to sync.
- **Cloudflare's edge 403s `Python-urllib`.** A scripted check must send a browser
  `User-Agent`, or it sees 403 while the app (a real browser) is fine. Rule this out
  before chasing a phantom auth bug.
- **A future-stamped record must never become the cursor.** The pull cursor is "newest
  `at` pulled". A record whose `at` is ahead of real time - another device with a wrong
  clock, or a hand repair - would push the cursor past every later change and the device
  would silently stop syncing until real time caught up. `cfPullDelta()` now clamps the
  cursor to this device's own clock, so a poisoned cursor is also pulled back on the next
  pull and the device heals itself. `test/cloudflare.test.js` pins it.
- **`PHJF72` is the phone's web app, not the Android APK.** Device tags are minted once
  (`PH`+4 chars on a mobile browser, `PC`+4 on desktop). All 52 memos carry `PHJF72`,
  so the owner creates memos on the phone's browser/PWA, which syncs over the Worker.
  The APK is a native app that syncs to Google Sheets only - it never writes to the
  Worker, and its `syncUrl` is separate. Check which device a record's `device` names
  before blaming a device that was never in the loop.
- **The phone's web app can go quiet.** `PHJF72` last pushed at 04:03Z on 10/13; no
  10/13 memo exists anywhere, so "my memo is not showing" was a *not-written-or-not-pushed
  on the phone*, not a Worker/merge fault. When a day's memo is missing everywhere,
  confirm whether the writing device pushed at all (its records' `at` on the Worker)
  before hunting a sync bug.

