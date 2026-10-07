# Texpark Pro — progress across the three-phase plan

This file is the resume point. It records what is done, what is next, and the risks found,
one section per phase. Update it after every phase.

Constraints in force for all three phases (from the owner + AGENTS.md):
- Edit sources in `texpark-pro/`, then run `node texpark-pro/build.js`. Never hand-edit the
  generated root `js/*.js`, `sw.js`, `index.html`.
- Never touch `android-keystore.jks` or change the APK signing.
- Keep the localStorage key `texpark_pro_v2`.
- Never remove features or delete user data. Do not switch Pages to GitHub Actions.
- No Cloud Functions / Cloud Storage / Firebase Blaze — Spark (free) only.

---

## Phase 1 — Sheet backup "Those rows are out of bounds."

**Status: DONE** (commit `eae8e75`, plus `5ac4799`/`1d87ac6` for the earlier chunked-backup work
and its Bangla guide). All suites green.

### Root cause
The chunked backup (commit `8be2f6a`) fixed the 50,000-character cell limit and then hit the
next limit Google enforces: a tab has a **fixed** number of rows and columns.
`saveBackup_` deleted the device's old rows and `appendRow`'d the new chunks. `appendRow` does
**not** grow a sheet, so on a full or trimmed Backup tab it throws exactly
`Those rows are out of bounds.` (Bangla: "ওইসব সারি সীমার বাইরে রয়েছে।") — the error the owner
saw on every "Cloud backup (PC)" job. `deleteRow`/`deleteRows` are just as exposed: they shift
everything below, so a delete at the last row or one row past throws too. The tab had run out of
rows and the write had never asked for more.

### What changed
- `texpark-pro/Code.gs` (copied to root `Code.gs` by `build.js`):
  - New `ensureRows_`/`ensureCols_` grow the grid (`insertRowsAfter`/`insertColumnsAfter`) before
    any write that would reach outside it. `sheet_` calls `ensureCols_` before touching row 1
    (a tab can be narrower than its header).
  - `saveBackup_` no longer deletes rows. It finds the device's rows by reading the sheet,
    `clearContent`s them, then writes the whole new block in **one** `getRange(...).setValues()`
    at `getLastRow()+1`, with the grid grown first. `getLastRow()` is read *after* the clear.
    One write means a failed write cannot leave a half-backup.
  - Every `doPost`/`doGet` branch still returns JSON; exceptions are caught and returned as
    `success:false` with the real message (unchanged behaviour, re-verified).
- `texpark-pro/js/sync.js`: new `syncDropSupersededBackups(device, succeededAt)` — when a backup
  job actually lands, that device's older FAILED/PENDING backup jobs are dropped (an older
  snapshot would only overwrite the newer one now in the sheet). Backups stamped later and every
  non-backup job are left alone. `syncRequeueBackups()` still un-parks "too large" failures once.
- `texpark-pro/test/sheet.test.js`: the fake `Sheet` now enforces a finite grid (1000×26) and
  throws the exact Google errors. `makeSheet(name, width, maxRows, maxCols)` + `buildApi()` let a
  test load Code.gs onto a spreadsheet of its choosing. New cases: fresh empty sheet; a snapshot
  needing more chunks than the tab has rows (grid grown, payload round-trips); smaller second
  backup upserts with no stale rows; three devices with two writes each; a legacy single-cell row
  read alongside chunked ones; a corrupt/missing chunk reported as an error. These **fail on the
  previous Code.gs** (3 FAIL, "Those rows are out of bounds.") and pass on the fix.

### Tests
`npm test` exit 0: logic 84 · sheet 64 · e2e 251 · autopull 39 · return 51 · android 27 · native 30
(plus the node:test suites cost/journey/session/pairing/repair/ownerdata). `ci/check-site.py`
passes. No single cell ever exceeds 40,000 chars (asserted in `sheet.test.js`).

### Not done
Nothing outstanding for Phase 1.

### Risk found (blocks the "bump APP_VERSION + rebuild APK" step — affects ALL phases)
AGENTS.md says to bump `APP_VERSION` in `js/app.js`, `sw.js`, `MainActivity.java` together and
rebuild the APK, and `ci/check-site.py` fails the push unless the built APK carries the new
version string. But this machine's `android-keystore.jks` does **not** match the signing
certificate of the tracked `TexparkPro.apk`:
- tracked/published APK: SHA-256 `af3395fa045de0bee07312819ef08ae1275190f9a289fd5549fb88c11539eeba`
- on-disk keystore: SHA-256 `24fc0a79047008216ff7c49ee705c99eb8465b59db1da6160a6459df90c1591e`
Rebuilding (`python3 build-apk.py`) re-signs with `24fc…`. The original signing key is not in the
repo (correctly — it is gitignored), so a matching signature cannot be produced. Bumping the
version would therefore force a re-signed APK that Android refuses to install over the one on the
owner's phone — a change of APK signing, which the owner forbade.

**Resolution (applied in Phase 1, to be applied in Phases 2–3):** do **not** bump `APP_VERSION`,
do **not** rebuild the APK; keep the published `2027-01-01.10` and the `af33…` signature. The
version bump exists so the browser service worker refreshes its cache, but `sw.js` already serves
`js`/`css`/`.apk` **network-first**, so changed JS reaches web and installed-PWA clients without a
bump, and the Code.gs fix reaches everyone via the manual Apps Script redeploy. If the owner
recovers the original keystore, a version bump + rebuild can be done then, safely.

---

## Phase 2 — Receivable must drop when a delivery is marked delivered

**Status: NOT STARTED.**

### Investigation (to fill in before coding)
- How is "RECEIVABLE — Due from customers" computed today (web `js/db.js`/`js/app.js`, native
  `Store.java`/dashboard)?
- Is there any payment/collection record today?
- How do deliveries work (Delivered/Partial/Pending, shared pending maths with returns, charge)?
- One-paragraph root cause.

### Plan (design to confirm against the code)
Receivable stays DERIVED. Add a `payments` list (id, memoId, amount, date, method, deliveryId,
`at`, `del`). Memo remaining due = memo total − advance − sum(live payments), min 0.
Receivable = sum over live memos. Existing data with no payments must give EXACTLY today's
number. Choose Option A (delivery collects cash) vs Option B (explicit "Receive payment") after
reading how deliveries actually behave in this app.

### Next
Start Step A: read the code and write the findings here.

### Open risks
- The native Android UI cannot be driven in this environment; native changes are covered by JVM
  unit tests only (same as the existing native tests).
- Same APP_VERSION/APK conflict as Phase 1 (fix shipped web-side, no bump).

---

## Phase 3 — Free live multi-device sync with Firestore + Sheet fallback

**Status: NOT STARTED.**

Plan document to be written first: `docs/FIRESTORE_PLAN.md` (data model, merge rules, reuse of
the outbox/retry queue, risks). Then the web Firestore layer (`js/cloud.js` +
`js/firebase-config.js`), the Sheet `Records` fallback tab, the ONLINE_FIRESTORE ↔ DEGRADED_SHEET
state machine, auth/rules, one-time migration, tests, and `docs/FIRESTORE_SETUP_BANGLA.txt`.
Android gets no Firestore in this phase; the web app mirrors every record to the Sheet `Records`
tab so Android never sees stale data. Phase 4 (Android via Firestore REST) is proposed in the plan.

### Open risks
- Read budget on Spark (50k/day): must use `at`-cursor delta reads, never whole-collection reads.
- Anonymous/public repo: config keys are public identifiers, but rules must deny by default.
- Without the owner's Firebase project we cannot run against a live Firestore; tests use an
  in-memory fake with quota/offline toggles.
