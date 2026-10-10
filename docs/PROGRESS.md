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

## Phase 4 — Orders Command Center (2026-10-06)

**Status: DONE (web layer).** Owner request: a dashboard section with a button that opens an order
overview, designed as a premium enterprise screen (summary tiles, urgent work first, delivery
calendar, reminders, full board, lifecycle).

### What shipped
- `js/db.js` — `orders` added to `blankDB()`, `migrate()` and `MERGE_KEYS`; the lifecycle constants
  and the pure rules `isOrderOverdue`, `orderDaysLate_`, `orderDisplayStatus`, `orderSummary`,
  `ordersByUrgency`, `ordersOnDate`, `orderRemindersFor`; `orderPrefix` and `reminderDefaultLead`
  settings; `orders` added to every role in `PERMS`.
- `index.html` — the Dashboard entry card + button, the full `page-orders` section (tiles, priority
  list, reminder center, board, calendar, lifecycle), the New/Edit Order modal, and two Settings
  fields.
- `js/app.js` — the Orders page: summary, priority list, reminder center, the board with search and
  status/time filters, the month calendar with a per-day list, and the New/Edit order modal with a
  history trail. `saveOrder` / `setOrderStatus` are the only write paths.
- `css/app.css` — the premium order styling (accent tiles, meaning-bearing colors, cards, calendar,
  lifecycle), responsive at 900px.
- `Code.gs` — an `Orders` tab and the `order` route (upsert keyed on Order No) as the Sheet fallback
  for the Android app.
- `test/orders.test.js` — 49 checks, wired into `npm test`.
- `sw.js` / `js/app.js` APP_VERSION -> `2027-01-01.11`; `build.js` rebuilt.

### Verified
Full suite green: logic 84, sheet 87, e2e 262, receivable 31, cost 11, journey 19, autopull 39,
return 51, cloud 33, orders 69, session 25, pairing 31, repair 30, ownerdata 29. (android/native
need a JDK for `javac`; not available in this sandbox, unchanged by this work.)

### Open risks (unchanged)
- Android still uses the Sheet; orders mirror to the `Orders` tab so an Android device never sees
  stale orders. No APK rebuild, no signing change.
- Orders travel through Firestore via `MERGE_KEYS`; no new read pattern was added, so the Spark
  read budget is unaffected.

### Follow-up (2026-10-06)
- The memo page gained a collapsed, off-by-default "Add to Orders (optional)" card
  (`settings.memoOrderEnabled`); when on, a new memo also opens an order linked by `memoId`.
- Memo History gained an SL column (1, 2, 3 …) and a total-count pill, plus a per-row
  order link / one-click **Create Order**.
- `test/orders.test.js` grew to 69 checks. All suites still green.
- No version bump: the tracked `TexparkPro.apk` is signed with a keystore that is not on
  this machine, so a bump plus APK rebuild would change the signing and break
  install-over-update (forbidden). `sw.js` serves `js/` network-first, so the new JS
  reaches installed clients without a bump — the version stays `2027-01-01.10`.


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

**Status: DONE.** All suites green. Web + native + Code.gs changes below.

### Root cause (confirmed by reading the code)
Receivable was `sum(memo.due)`, and `memo.due` was computed once at save time
(`grandTotal − advance`) and **never touched again by anything**. So when the customer handed
over cash at delivery, nothing reduced `due`; the dashboard, the memo, the history row, the
customer ledger and the ageing buckets all kept showing the original amount. The app already had
a `payments` list (`{date, customerId, amount, method, note}`) driven by the "Receive" button,
but it was **customer-level** — it reduced the customer ledger's due (`customerDue`) yet the
dashboard never netted it, and it could not be tied to a delivery or a memo, so it could not
drive a per-memo figure. There was no way to record "cash collected when this parcel went out".

### Design chosen — Option A: the delivery collects the cash
Receivable stays **derived**, never a hand-edited field.
- Receipts gain `memoId`, `deliveryId`, `customerId`. When a delivery goes out, the owner sees a
  new **Collected (৳)** box prefilled with the memo's remaining due (split proportionally for a
  partial delivery) and can overwrite it, including to 0.
- `memoRemainingDue(memo) = max(0, grandTotal − advance − Σ live memo-linked receipts)`.
- `totalReceivable() = Σ memoRemainingDue(memo)` over live memos.
- **Regression guarantee:** a memo with no receipts contributes exactly its stored `due`, so any
  book that exists today reads the same number. The Receive button still writes a
  customer-level receipt (no `memoId`); that keeps the ledger exactly as before and, by design,
  never moved the dashboard — so its behaviour is preserved too.
- **Tombstones:** a removed receipt (delivery/memo deleted, or the delivery re-entered) is
  soft-deleted with `del:true` rather than spliced out, so `stampChanged` records the delete and
  the cloud merge cannot resurrect it. `payments` is already in `MERGE_KEYS` on both platforms.
- Over-collection is clamped to the remaining due with a warning, so a due can never go negative.
- The collection and the delivery are written in the **same commit**, so every screen moves
  together — no instant where a parcel is delivered but the money is missing.

### What changed
- **Web** `texpark-pro/js/db.js`: `paymentsForMemo_`, `collectedOnMemo_`, `paidOnMemo_`,
  `memoRemainingDue`; `totalReceivable` rewritten to derive; `ageingBuckets` buckets the remaining
  due (callers pass memos) so a paid memo stops ageing.
- **Web** `texpark-pro/js/app.js`: `customerIdForMemo_`, `collectedPrefill_`, `deliveryQtyChanged`,
  `removePaymentForDelivery_`; `saveDelivery` records the collection in the same commit and emits
  a `payment` sync job; `openDelivery` prefills the box; `deleteMemo` soft-deletes the memo's
  receipts; history/print use `memoRemainingDue` (and the print shows a "Received (delivery)" line
  when money came in); `customerDue` ignores tombstoned receipts.
- **Web** `texpark-pro/index.html`: the `dlQty`/`dlCollect` fields in the delivery modal.
- **Native** `android-src/com/texpark/pro/Store.java`: `collectedOnMemo`, `memoRemainingDue`,
  `totalReceivable` (derived), `findDelivery`, `collectedPrefill`, `removePaymentsForDelivery`,
  `recordCollection`, `customerIdForMemo`; `deleteMemo` soft-deletes receipts; `ageingBuckets`
  uses the remaining due.
- **Native** `android-src/com/texpark/pro/ScreensMore.java`: the delivery card gains a Collected
  box and records the receipt in the same save.
- **Code.gs** `texpark-pro/Code.gs`: `payments` header gains `Payment ID` and `Memo No`;
  `savePayment_` upserts on Payment ID (falling back to append for the old id-less client) and
  calls `ensureCols_`/`ensureRows_` first so a narrow Payments tab cannot throw out of bounds.

### Tests (all green)
- New `texpark-pro/test/receivable.test.js` (web, 31 asserts): fresh memo = full due; the exact
  no-receipt regression; delivery prefill full/partial; collection drops memo + dashboard;
  over-collection clamp; receipt linkage; ledger/history agreement; memo delete soft-deletes its
  receipts; Receive button unchanged; a stale-merge test proving a soft-deleted receipt is not
  resurrected.
- `test/native.test.js` new `receivable` op + assertion (phone parity: prefill, collect, clamp,
  remove, delete, reload).
- `test/sheet.test.js` two new cases (payment id upsert; narrow Payments tab widened).
- `test/e2e.test.js` delivery/payment section updated to the new contract (collection in the same
  commit, prefill, manual Receive now adds a third receipt).

### Docs
- `docs/RECEIVABLE_BANGLA.txt` — Bangla guide for the owner.

### Open risks
- The native Android UI cannot be driven in this environment; native changes are covered by JVM
  unit tests only (same as the existing native tests).
- Same APP_VERSION/APK conflict as Phase 1 (fix shipped web-side, no bump).

---

## Phase 3 — Free live multi-device sync with Firestore + Sheet fallback

**Status: DONE (web layer).** Implemented per `docs/FIRESTORE_PLAN.md`: the design was written
first, then the web Firestore layer, the Sheet `Records` fallback tab, the ONLINE_FIRESTORE ↔
DEGRADED_SHEET state machine, auth/rules, one-time migration, tests, and
`docs/FIRESTORE_SETUP_BANGLA.txt`.

### What shipped
- `js/firebase-config.js` — the owner's project keys (placeholders), machine-local so they never
  sync between devices.
- `js/cloud.js` — Firebase Auth + Firestore over REST (no SDK, no build step), delta push/pull on
  an `at` cursor, per-record documents `shops/{uid}/records/{key}__{id}`, tombstones, settings as
  one document, one-time idempotent migration, the state machine and its backoff, and the Sheet
  fallback driver. Reuses `mergeCloudInto_`, so there is one definition of "newer wins".
- `js/sync.js` — one outbox for both transports (`via: 'sheet' | 'firestore'`), a re-entrancy
  guard and a continuous drain so a commit that queues many records sends them all in one pass.
- `Code.gs` — the `Records` tab plus the `record` / `records` routes (upsert, chunked, `since`
  delta reads), version bumped to 5.
- `index.html` / `js/app.js` — the Settings → Cloud sync panel: status badge, key save, test,
  sign-in/create account, migrate.
- `firestore.rules` — deny by default; `shops/{uid}/records` only for that uid.
- `test/cloud.test.js` — real `cloud.js` against an in-memory fake of Auth + Firestore with
  quota/offline toggles: two devices, delta-only reads/writes, delete/tombstone, payments,
  degrade→recover, offline queueing, idempotent migration, unconfigured device untouched.
- `sw.js` / `build.js` / zip builders — the two new scripts are copied and bundled.

### Verified
Full suite green: logic 84, sheet 87 (incl. Records-tab tests), e2e 262, receivable 31, cost 11,
journey 19, autopull 39, return 51, cloud 33, session 25, pairing 31, repair 30, ownerdata 29.

### Open risks (unchanged)
- Read budget on Spark (50k/day): the delta cursor is asserted to read ZERO documents when nothing
  has changed.
- Anonymous/public repo: config keys are public identifiers; rules deny by default.
- No live Firestore in the sandbox; tests use a faithful in-memory fake written to the REST
  contract, and the Bangla guide tells the owner how to paste keys and deploy the rules.
- Android still uses the Sheet; the web app mirrors every record to the Sheet `Records` tab so
  Android never sees stale data. No APK rebuild, no signing change.
