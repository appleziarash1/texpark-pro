# Phase 3 — Free live multi-device sync with Firestore + Sheet fallback

Status: **DESIGN AGREED, being implemented.** This file is the design of record; read it before
touching `js/cloud.js`, `js/firebase-config.js`, `firestore.rules`, the `Records` tab in
`Code.gs`, or the tests.

## Goal

Today the PC and the phone share one Google **Sheet** through `Code.gs`, and each device pushes a
full JSON snapshot and pulls everyone else's, then merges per record (`mergeCloudInto_` in
`js/db.js`). It works and it is free, but it is a *snapshot* protocol: every save uploads the
whole book, the newest snapshot per device wins as a set, and the lag is whatever the queue is.

Phase 3 adds **live, per-record sync over Firestore** (the free Spark plan) so a memo typed on
the phone appears on the PC in seconds, without shipping the whole book each time. Firestore is
the primary path when it is configured and reachable; the Sheet `Records` tab is the **fallback**
that keeps the books moving when Firestore is down, offline, or over quota.

Hard constraints (from the owner + AGENTS.md), which this design must respect:

- **Spark (free) plan only.** No Cloud Functions, no Cloud Storage, no Blaze. Firestore reads and
  writes must fit the free daily quota.
- **No APK signing change, no new keystore, no `APP_VERSION` bump.** The Android app is not
  changed to speak Firestore in this phase — it keeps using the Sheet. The web app mirrors every
  record into the Sheet `Records` tab so the phone never sees stale data.
- **Never remove a feature or delete user data.** The Sheet snapshot sync stays exactly as it is;
  Firestore is additive. A device with no Firestore config behaves exactly as today.
- **Keep the localStorage key `texpark_pro_v2`.** Firestore config lives beside it, not inside it.
- Edit sources in `texpark-pro/`, then `node texpark-pro/build.js`. Never hand-edit root copies.

## Why Firestore can be free here

Spark gives 50,000 document reads/day, 20,000 writes/day, 1 GiB stored, 10 GiB/month egress, and
20,000 deletes/day. That is ample for a two-device shop **if the app never reads whole
collections**. The two rules that keep it inside the quota:

1. **Delta reads only.** Every record carries `at` (its last-change stamp, already written by
   `commit()` in `js/db.js`). The device remembers the newest `at` it has seen and asks only for
   documents with `at > cursor`. A two-device shop changes a few dozen records a day, not
   thousands.
2. **Per-record writes only.** A save writes just the records that changed since the last commit
   — `stampChanged_` already computes exactly that set — not the whole book.

The snapshot fallback (Sheet `Records` tab) is the safety net for the day the quota runs out or
the network is down.

## Data model

The collection is scoped to the signed-in uid by its **path**, one document per business record:

```
shops/{uid}/records/{key}__{id}
  fields:
    key        string   // MERGE_KEYS name: 'memos', 'products', 'payments', ...
    id         string   // the record's own id
    data       map      // the record exactly as it sits in db[key] (incl. its `at`)
    at         string   // ISO; duplicated at the top level so a delta query can order/filter
    deleted    bool     // tombstone mirror (true when the record was deleted)
    device     string   // device tag, for debugging and for the Sheet mirror
```

Scoping by path rather than by an `owner` field is deliberate. It removes two problems at once:

- **No composite index.** A delta query is `where('at', '>', cursor)` plus `orderBy('at')` inside
  one subcollection — a single-field range, and Firestore builds single-field indexes
  automatically. An `owner` field plus an `at` range would need a hand-created composite index,
  which the owner would have to click through in the Firebase console, and the app would break
  with `FAILED_PRECONDITION` until they did. The path scoping has no such step.
- **Trivially correct rules.** The rule is `request.auth.uid == uid` on the path segment, which
  Firestore can prove for any query inside the subcollection. A per-document `owner` field cannot
  be proven from a range query, so a list operation would be refused even when every row matched.

The document id is `{key}__{id}` rather than a subcollection per key so a single delta query
returns everything that moved, in one request, without reading a parent document per collection.

**`payments` is included.** It is in `MERGE_KEYS` already, and Phase 2 gave every receipt a stable
`id`, a `memoId` and a `deliveryId`. Receipts therefore travel per record like any other record:
a collection recorded on the phone syncs to the PC as one document, and its soft-delete
(`del:true`) travels as a tombstone exactly like a memo delete. No special-casing.

Every key in `MERGE_KEYS` is mirrored:

```
products, suppliers, customers, stock, ledger, purchases, expenses,
memos, deliveries, returns, payments, users
```

Plus **`tombstones`** are mirrored as their own documents (`key = '_tombstone'`), so a delete made
on one device reaches the other and cannot be resurrected by a stale copy — the same guarantee
`mergeTombstones_`/`applyTombstones_` give the snapshot path today.

Business **settings** are mirrored as a single document `records/_settings__shop` (company
details, memo prefix, low-stock level, VAT, auto-backup …). The machine-local settings
(`syncUrl`, `deviceTag`, `autoPull`) are **never** synced — the same exclusion `LOCAL_SETTING_KEYS`
makes in `db.js`, and for the same reason: syncing the device tag would rename a machine.

### The Sheet `Records` tab (fallback shape)

`Code.gs` gains a `Records` sheet with headers:

```
['Timestamp', 'Collection', 'Record ID', 'Chunk', 'Of', 'Checksum', 'Deleted', 'JSON']
```

The same record document is written there, chunked with the existing `CHUNK_CHARS` machinery so a
record larger than one cell still fits. `doPost type:'record'` upserts on `Collection + Record ID`
(clear-then-write, no `deleteRow`, exactly like `saveBackup_`). `doGet ?action=records&since=<at>`
returns every record with a newer stamp, so a recovering device can catch up from the Sheet.

The Sheet mirror is written **best-effort after every Firestore write and every commit**: it is
the fallback, so it must not be on the critical path of a normal save.

## Merge rules (identical to the snapshot path)

Firestore sync must not invent a second set of merge rules. It feeds the **same**
`mergeCloudInto_(incoming)` that the snapshot pull uses:

- Newest `at` wins, per record.
- A delete writes a tombstone; a tombstone only loses to a record edited *after* it (a deliberate
  re-create). Same as `applyTombstones_`.
- Accounts collapse to one per username; the newest password/role wins (`mergeUsersInto_`).
- Business settings follow the newer edit; machine-local settings are skipped.
- After a merge, `rebaseStockFromLedger()` rebuilds the stock book so it agrees with the memos
  that are left.

So a record that arrived by either path — Firestore document or Sheet `Records` row — is reduced
to an `incoming` object and merged the same way. There is one definition of "newer wins" in the
codebase.

## Reuse of the outbox / retry queue

`js/sync.js` already has a durable outbox in localStorage (`texpark_pro_syncq`) with
`pending`/`failed` states, backoff, `syncRetryAll()`, and coalescing. Firestore does **not** get a
second outbox:

- When Firestore is the active path, a save enqueues a **record job** into the *existing* queue
  (`{type:'record', key, id, data}`) and the queue's own retry/backoff carries it.
- When Firestore is unreachable, quota returns `429`, or the config is absent, the provider
  **automatically degrades to Sheet**: the same enqueue also writes the Sheet `Records` row
  (`{type:'record_sheet', ...}`) so the phone still gets the data. The two jobs are independent;
  whichever succeeds first drains, and the merge is idempotent (same `id`, same `at`).

This is why the phase reuses the existing queue rather than adding a second one: one place to
retry, one place to show the owner "N pending", one place that survives a reload.

## State machine and auto-recovery

The cloud layer exposes one state, shown in Settings and on the sync badge:

```
ONLINE_FIRESTORE   Firestore configured, reachable, under quota  -> records go to Firestore,
                                                                    Sheet mirror still written
DEGRADED_SHEET     Firestore down / 429 / not configured          -> records go to the Sheet
                                                                    Records tab; Firestore retried
                                                                    with backoff
OFFLINE            neither reachable                              -> the outbox holds everything;
                                                                    drained when either returns
```

Transitions:

- Any Firestore request that fails with a network error, `429`, `UNAVAILABLE`, or `RESOURCE_
  EXHAUSTED` moves to `DEGRADED_SHEET` and arms a retry timer with exponential backoff (starts at
  30s, caps at 15 min). The badge turns amber and the Settings panel says why.
- A scheduled probe (and every save) tries Firestore again. A success moves back to
  `ONLINE_FIRESTORE` and drains any Firestore jobs still queued.
- When Firestore returns, the device does one **delta catch-up** (`at > lastCursor`) and merges;
  it does not re-read the world.

Auto-recovery is what makes the fallback safe to use: the Sheet path is never the final state, so
a quota reset or a flaky connection self-heals without the owner pressing anything.

## Firebase Auth

Ownership is per Firebase Auth user, so a leaked project id cannot read another shop's books.

- The web app signs in with **Firebase Auth REST** (`identitytoolkit.googleapis.com`) using the
  Web API key from `firebase-config.js`. No Firebase SDK is bundled — the app has no build step,
  and pulling the SDK in would break that and add a CDN dependency to a local-first app.
- The shop's first device signs up (email + password) or signs in anonymously, then stores the
  `idToken` + `refreshToken` in localStorage (`texpark_pro_firebase_auth`). The token is refreshed
  with `securetoken.googleapis.com` before it expires.
- `firestore.rules` requires `request.auth != null` and `resource.data.owner == request.auth.uid`
  (and the same on create), so a document is readable only by the uid that wrote it. Rules are
  **deny by default** — there is no public read path.

If the owner never configures Firebase, none of this runs and the app is exactly as today.

## Migration (one-time, idempotent)

On the first successful Firestore connection:

1. Read the local `db` and the newest Sheet snapshot (the existing `pullall`) — do not assume the
   local device is complete.
2. Merge them locally with `mergeCloudInto_` (already the case for a normal open).
3. Push **every** record once to Firestore in batches (bounded to the free write quota by
   chunking batches and pausing between them; a partial migration resumes from `lastMigratedAt`).
4. Push every tombstone.
5. Record `texpark_pro_firestore_migrated = <at>` so it never runs twice.
6. From then on, only deltas move.

The migration is safe to re-run: it is an idempotent upsert keyed on the record id, and a
half-finished migration resumes rather than restarts.

## Firestore rules (deny by default)

`firestore.rules`:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // No public access at all.
    match /{document=**} { allow read, write: if false; }

    // One shop per signed-in uid. The uid in the path is what is checked, so a
    // range query inside the subcollection is provable without a composite index.
    match /shops/{uid}/records/{docId} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

Deploy with `firebase deploy --only firestore:rules` (or paste into the console's Rules tab). The
catch-all deny stays: if the path rule is ever wrong, the default is "nobody", not "everybody".

## Files

| File | Role |
|---|---|
| `docs/FIRESTORE_PLAN.md` | this design |
| `texpark-pro/js/firebase-config.js` | the owner's project keys (placeholders shipped); `window.FIREBASE_CONFIG` |
| `texpark-pro/js/cloud.js` | Auth (REST), Firestore REST client, state machine, delta push/pull, migration, Sheet fallback driver |
| `texpark-pro/firestore.rules` | the rules above (deploy with `firebase deploy --only firestore:rules`) |
| `texpark-pro/Code.gs` | `Records` tab + `record` / `records` routes |
| `texpark-pro/js/app.js` | Settings panel: Cloud (Firestore) status, sign-in, migration button |
| `texpark-pro/js/sync.js` | drains `record` / `record_sheet` jobs through the existing queue |
| `texpark-pro/test/cloud.test.js` | in-memory fake Firestore + Identity Toolkit, quota/offline toggles, drives real `cloud.js` |
| `docs/FIRESTORE_SETUP_BANGLA.txt` | owner-facing Bangla setup guide |

## Risks

- **Read budget.** Must stay delta-only. The test asserts a pull of N unchanged records issues
  **zero** document reads (the cursor has not moved).
- **Two writers.** A record changed on both devices between syncs resolves by `at` (newest wins),
  same as today; the loser's change is a deliberate overwrite, not silent data loss.
- **Rules and the API key.** The Web API key in `firebase-config.js` is a public identifier, not a
  secret; the security is the rules. The repo is public, so this is expected and documented.
- **No live project here.** We cannot run against the owner's Firestore in this sandbox, so the
  tests use a faithful in-memory fake and the code is written to the real REST contract. The
  Bangla guide tells the owner how to paste in their keys and deploy the rules.
- **APK.** The Android app keeps using the Sheet; the Sheet mirror keeps it current. No APK
  rebuild, no signing change.

## Build order

1. This plan. ✔
2. `firebase-config.js` + `firestore.rules`.
3. `cloud.js` (config, auth, client, state machine, delta, migration, fallback).
4. `Code.gs` `Records` tab + routes.
5. `sync.js` drain integration + `app.js` Settings panel.
6. `test/cloud.test.js` (and extend `sheet.test.js` for the `Records` tab).
7. `build.js` / `sw.js` / `index.html` wiring; run the full suite.
8. `docs/FIRESTORE_SETUP_BANGLA.txt`, `docs/PROGRESS.md`, `AGENTS.md`, final Bangla report.
