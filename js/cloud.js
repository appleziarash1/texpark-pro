/* Texpark Pro — live multi-device sync over Firestore (Spark, free plan) with the
   Google Sheet as fallback.

   The Google Sheet sync in js/sync.js ships a whole JSON snapshot per device and the
   newest snapshot wins as a set. That is fine and it stays, but it is not live: a memo
   typed on the phone reaches the PC only after the next snapshot round. This layer
   adds per-record sync over Firestore, so one changed memo is one document write and
   one document read - not the whole book - and it arrives in seconds.

   It is additive and reversible. With no Firebase keys configured nothing here runs
   and the app behaves exactly as before. When Firestore is down, over quota, or
   unreachable, every write also goes to the Sheet's Records tab through the SAME
   outbox in js/sync.js, and a backoff timer tries Firestore again. See
   docs/FIRESTORE_PLAN.md for the full design.

   No Firebase SDK is loaded - the app has no build step and must keep working from a
   USB stick - so Auth and Firestore are spoken over their REST APIs directly. */

const FB_AUTH_KEY     = 'texpark_pro_firebase_auth';     // {idToken, refreshToken, uid, email, expiresAt}
const FB_CURSOR_KEY   = 'texpark_pro_firestore_cursor';  // newest `at` pulled, so pulls are deltas
const FB_MIGRATED_KEY = 'texpark_pro_firestore_migrated'; // set once the first full push finished
const FB_STATE_KEY    = 'texpark_pro_firestore_state';   // {state, reason, retryAt}

const FB_AUTH_URL   = 'https://identitytoolkit.googleapis.com/v1';
const FB_TOKEN_URL  = 'https://securetoken.googleapis.com/v1/token';

/* The record sync never touches these: they describe the machine, not the business,
   the same exclusion LOCAL_SETTING_KEYS makes in db.js. */
const CLOUD_SETTING_DOC = '_settings__shop';

function fbConfig() {
  const baked = (typeof window !== 'undefined' && window.FIREBASE_CONFIG) || {};
  const saved = (db && db.settings && db.settings.firebase) || {};
  return {
    apiKey: String(saved.apiKey || baked.apiKey || '').trim(),
    projectId: String(saved.projectId || baked.projectId || '').trim()
  };
}
function cloudConfigured() { const c = fbConfig(); return !!(c.apiKey && c.projectId); }

function fbDocsUrl() {
  const c = fbConfig();
  // (default) is the database the free project gets; a named one is not needed here.
  return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(c.projectId) +
    '/databases/(default)/documents';
}

/* ===================== state machine =====================
   ONLINE_FIRESTORE  configured, last call worked            -> records go to Firestore
   DEGRADED_SHEET    down / 429 / not configured             -> records go to the Sheet too
   OFFLINE           nothing reachable                       -> the outbox holds everything

   The point of the fallback is that it is never the resting state: a degraded device
   keeps a retry timer, and a success puts it back online and drains what queued. */
var CLOUD_STATE = { state: '', reason: '', retryAt: 0 };

function cloudStateLoad() {
  try {
    const s = JSON.parse(localStorage.getItem(FB_STATE_KEY) || 'null');
    if (s && s.state) CLOUD_STATE = { state: s.state, reason: s.reason || '', retryAt: s.retryAt || 0 };
  } catch (e) {}
}
function cloudStateSave() {
  try { localStorage.setItem(FB_STATE_KEY, JSON.stringify(CLOUD_STATE)); } catch (e) {}
}
function cloudStateSet(state, reason, backoffMs) {
  CLOUD_STATE.state = state;
  CLOUD_STATE.reason = reason || '';
  CLOUD_STATE.retryAt = backoffMs ? Date.now() + backoffMs : 0;
  cloudStateSave();
  if (typeof cloudStatusRender === 'function') cloudStatusRender();
}

function cloudState() {
  if (!cloudConfigured()) return 'DEGRADED_SHEET';
  return CLOUD_STATE.state || 'ONLINE_FIRESTORE';
}
function cloudStateReason() { return CLOUD_STATE.reason || ''; }

/* Backoff for the Firestore retry: 30s, 1m, 2m, 4m, 8m, capped at 15m. */
var cloudBackoffStep = 0;
function cloudBackoffMs() {
  const ms = Math.min(30000 * Math.pow(2, cloudBackoffStep), 15 * 60 * 1000);
  cloudBackoffStep = Math.min(cloudBackoffStep + 1, 5);
  return ms;
}

/* ===================== Firebase Auth (REST) ===================== */
function fbAuthLoad() {
  try { return JSON.parse(localStorage.getItem(FB_AUTH_KEY) || 'null'); } catch (e) { return null; }
}
function fbAuthSave(a) {
  try { localStorage.setItem(FB_AUTH_KEY, JSON.stringify(a)); } catch (e) {}
}
function fbAuthClear() {
  try { localStorage.removeItem(FB_AUTH_KEY); } catch (e) {}
}
function fbSignedIn() { const a = fbAuthLoad(); return !!(a && a.idToken && a.uid); }
function fbEmail() { const a = fbAuthLoad(); return (a && a.email) || ''; }

function jsonPost(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function fbAuthReply(j, email) {
  // On sign-up Firebase returns localId + idToken directly; on sign-in the same.
  return {
    idToken: j.idToken,
    refreshToken: j.refreshToken,
    uid: j.localId || j.userId,
    email: email || (j.email || ''),
    expiresAt: Date.now() + (Number(j.expiresIn || 3600) - 60) * 1000
  };
}

/* Sign in with the SAME email + password on every device. Both devices must use one
   account: the shop lives under that account's uid, so an anonymous sign-in on each
   device would put them in different shops and they would never see each other. */
async function fbSignIn(email, password) {
  const c = fbConfig();
  if (!c.apiKey) throw new Error('No Firebase API key set.');
  const res = await jsonPost(FB_AUTH_URL + '/accounts:signInWithPassword?key=' + encodeURIComponent(c.apiKey),
    { email: email, password: password, returnSecureToken: true });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(fbAuthError(j));
  const a = fbAuthReply(j, email);
  fbAuthSave(a);
  cloudBackoffStep = 0;
  cloudStateSet('ONLINE_FIRESTORE', '', 0);
  return a;
}

async function fbSignUp(email, password) {
  const c = fbConfig();
  if (!c.apiKey) throw new Error('No Firebase API key set.');
  const res = await jsonPost(FB_AUTH_URL + '/accounts:signUp?key=' + encodeURIComponent(c.apiKey),
    { email: email, password: password, returnSecureToken: true });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(fbAuthError(j));
  const a = fbAuthReply(j, email);
  fbAuthSave(a);
  return a;
}

function fbAuthError(j) {
  const code = (j && j.error && j.error.message) || 'AUTH_FAILED';
  const map = {
    EMAIL_EXISTS: 'That email is already registered - use Sign in instead.',
    EMAIL_NOT_FOUND: 'No account with that email - use Create account instead.',
    INVALID_PASSWORD: 'Wrong password.',
    INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
    INVALID_EMAIL: 'That email address looks wrong.',
    WEAK_PASSWORD: 'The password must be at least 6 characters.'
  };
  return map[code] || ('Firebase said: ' + code);
}

function fbSignOut() {
  fbAuthClear();
  if (typeof cloudStatusRender === 'function') cloudStatusRender();
}

/* A fresh idToken, or null. Refresh 60s early so a request never leaves with a token
   that expires in flight. */
async function fbEnsureAuth() {
  const a = fbAuthLoad();
  if (!a) return null;
  if (Number(a.expiresAt || 0) > Date.now()) return a;
  const c = fbConfig();
  if (!c.apiKey || !a.refreshToken) { fbAuthClear(); return null; }
  try {
    const res = await jsonPost(FB_TOKEN_URL + '?key=' + encodeURIComponent(c.apiKey),
      { grant_type: 'refresh_token', refresh_token: a.refreshToken });
    const j = await res.json();
    if (!res.ok || j.error) { fbAuthClear(); return null; }
    const next = {
      idToken: j.id_token, refreshToken: j.refresh_token || a.refreshToken,
      uid: j.user_id || a.uid, email: a.email,
      expiresAt: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000
    };
    fbAuthSave(next);
    return next;
  } catch (e) { return a.idToken ? a : null; }
}

/* ===================== Firestore value encoding =====================
   Firestore REST speaks typed values, not plain JSON. These two walk any JSON value
   the db holds (numbers, strings, booleans, null, arrays, nested objects). */
function toFsValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue_) } };
  const fields = {};
  Object.keys(v).forEach(k => { fields[k] = toFsValue_(v[k]); });
  return { mapValue: { fields: fields } };
}

function fromFsValue_(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return !!v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(fromFsValue_);
  if ('mapValue' in v) {
    const fields = (v.mapValue && v.mapValue.fields) || {};
    const o = {};
    Object.keys(fields).forEach(k => { o[k] = fromFsValue_(fields[k]); });
    return o;
  }
  return null;
}

function fsDocName_(key, id) { return String(key) + '__' + String(id); }

/* The document body for one record, exactly as Firestore REST wants it. */
function fsRecordFields_(key, rec, at, deleted, device) {
  return {
    key: { stringValue: String(key) },
    id: { stringValue: String(rec && rec.id || '') },
    at: { stringValue: String(at || (rec && rec.at) || '') },
    deleted: { booleanValue: !!deleted },
    device: { stringValue: String(device || '') },
    data: toFsValue_(rec || {})
  };
}

/* ===================== Firestore writes ===================== */
/* One upsert. Returns {ok:true} or throws a message the state machine can classify. */
async function fbWriteRecord(key, rec, opts) {
  const auth = await fbEnsureAuth();
  if (!auth) throw new Error('NOT_SIGNED_IN');
  const o = opts || {};
  const name = fsDocName_(key, rec && rec.id);
  const body = { fields: fsRecordFields_(key, rec, o.at, o.deleted, deviceTag()) };
  const res = await fetch(fbDocsUrl() + '/shops/' + encodeURIComponent(auth.uid) +
      '/records/' + encodeURIComponent(name),
    { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + auth.idToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await fbErrorText(res));
  return true;
}

/* Many records in one request, to stay inside the free write quota during a
   migration. Chunked so a book cannot exceed the request size limit. */
async function fbWriteBatch(pairs) {
  const auth = await fbEnsureAuth();
  if (!auth) throw new Error('NOT_SIGNED_IN');
  const writes = pairs.map(p => ({
    update: {
      name: 'projects/' + fbConfig().projectId + '/databases/(default)/documents/shops/' +
        auth.uid + '/records/' + fsDocName_(p.key, p.rec.id),
      fields: fsRecordFields_(p.key, p.rec, p.rec.at, p.deleted, deviceTag())
    }
  }));
  const res = await fetch(fbDocsUrl() + ':commit',
    { method: 'POST', headers: { 'Authorization': 'Bearer ' + auth.idToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: writes }) });
  if (!res.ok) throw new Error(await fbErrorText(res));
  return true;
}

async function fbErrorText(res) {
  let msg = 'HTTP ' + res.status;
  try {
    const j = await res.json();
    msg = (j && j.error && j.error.status ? j.error.status + ': ' : '') +
      ((j && j.error && j.error.message) || msg);
  } catch (e) {}
  return msg;
}

/* ===================== Firestore reads (delta only) ===================== */
function fbCursor() { try { return localStorage.getItem(FB_CURSOR_KEY) || ''; } catch (e) { return ''; } }
function fbCursorSet(at) { try { localStorage.setItem(FB_CURSOR_KEY, String(at || '')); } catch (e) {} }

/* Every record whose `at` is newer than the cursor, in one runQuery. This is the
   call that keeps the free plan free: it reads only what moved since the last pull,
   never the whole collection, and the field is range-filtered so Firestore uses its
   automatic single-field index (no composite index to create by hand). */
async function fbPullDelta() {
  const auth = await fbEnsureAuth();
  if (!auth) throw new Error('NOT_SIGNED_IN');
  const cursor = fbCursor();
  const where = cursor
    ? { fieldFilter: { field: { fieldPath: 'at' }, op: 'GREATER_THAN', value: { stringValue: cursor } } }
    : null;
  const query = {
    from: [{ collectionId: 'records' }],
    orderBy: [{ field: { fieldPath: 'at' }, direction: 'ASCENDING' }]
  };
  if (where) query.where = where;
  const res = await fetch(fbDocsUrl() + '/shops/' + encodeURIComponent(auth.uid) + '/records:runQuery',
    { method: 'POST', headers: { 'Authorization': 'Bearer ' + auth.idToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: query }) });
  if (!res.ok) throw new Error(await fbErrorText(res));
  const arr = await res.json();
  const records = [];
  let newest = cursor;
  (Array.isArray(arr) ? arr : []).forEach(row => {
    const doc = row && row.document;
    if (!doc || !doc.fields) return;
    const f = doc.fields;
    const at = (f.at && f.at.stringValue) || '';
    if (String(at) > String(newest)) newest = at;
    records.push({
      key: (f.key && f.key.stringValue) || '',
      rec: fromFsValue_(f.data),
      at: at,
      deleted: !!(f.deleted && f.deleted.booleanValue)
    });
  });
  return { records: records, newest: newest };
}

/* Classify a failure so the state machine can decide whether to degrade. A quota or
   availability error is transient and belongs in DEGRADED_SHEET with a retry; a
   rules denial or a bad key is not something retrying will fix. */
function fbIsTransient(msg) {
  return /RESOURCE_EXHAUSTED|UNAVAILABLE|429|500|502|503|504|Failed to fetch|NetworkError|QUOTA/i.test(String(msg || ''));
}

/* ===================== merge a delta into the local db =====================
   The delta is turned into one `incoming` object per shape mergeCloudInto_ already
   understands - collections of records plus tombstones - and pushed through that SAME
   merge. There is exactly one definition of "newer wins" in the app; this layer does
   not add a second. */
function cloudMergeDelta(delta) {
  const incoming = { tombstones: [] };
  (delta.records || []).forEach(r => {
    if (!r.key) return;
    if (r.key === '_settings') {
      // Business settings ride as one document; machine-local keys were already dropped
      // before it was written, and mergeSettingsInto_ drops them again on read.
      if (r.rec && r.rec.settings) {
        incoming.settings = r.rec.settings;
        incoming.settings.settingsUpdatedAt = incoming.settings.settingsUpdatedAt || r.at;
      }
      return;
    }
    if (r.deleted) { incoming.tombstones.push({ key: r.key, id: (r.rec && r.rec.id) || '', at: r.at }); return; }
    if (!r.rec || !r.rec.id) return;
    (incoming[r.key] = incoming[r.key] || []).push(r.rec);
  });
  return incoming;
}

/* The badge/panel the state machine drives. Kept here, beside the states, so the
   badge cannot disagree with the string that produced it. */
function cloudStatusRender() {
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  if (!cloudConfigured()) {
    el.className = 'sync-badge sync-blue';
    el.textContent = 'Cloud off (Sheet only)';
    return;
  }
  const st = cloudState();
  if (st === 'ONLINE_FIRESTORE') { el.className = 'sync-badge sync-green'; el.textContent = '☁ Firestore live'; }
  else if (st === 'DEGRADED_SHEET') { el.className = 'sync-badge sync-amber'; el.textContent = 'Cloud degraded → Sheet'; }
  else { el.className = 'sync-badge sync-red'; el.textContent = 'Cloud offline'; }
}

/* ===================== the Sheet Records-tab fallback =====================
   When Firestore is not usable, the same record also goes up through the existing
   outbox in js/sync.js as a `record` job, which Code.gs writes to the Records tab.
   The phone (which has no Firestore code) keeps reading the Sheet, so it must see
   every web change there. Reusing the outbox means one retry path, one place that
   survives a reload, one badge. */
function cloudQueueSheetMirror(key, rec, deleted) {
  if (typeof syncPush !== 'function' || !syncUrl()) return;
  syncPush('record', {
    key: key,
    id: rec && rec.id,
    deleted: !!deleted,
    at: (rec && rec.at) || new Date().toISOString(),
    json: JSON.stringify(rec || { id: rec && rec.id })
  }, 'Cloud record (' + key + ')');
}

/* ===================== per-record push from a commit =====================
   commit() calls this with the index as it was BEFORE the save. Only records whose
   `at` moved are sent - a save is a few document writes, not a snapshot. Each also
   gets a Sheet mirror job, so the fallback is always warm.

   While a pull-merge is being committed, pushes are muted: a record that just arrived
   from Firestore must not be sent straight back. The cursor still advances, so the next
   real save resumes normally. */
var cloudMuted = false;

function cloudQueueChanges(prevIndex) {
  if (cloudMuted) return 0;
  if (!cloudConfigured()) return 0;
  const prev = prevIndex || null;
  let n = 0;
  const keys = (typeof MERGE_KEYS !== 'undefined' ? MERGE_KEYS : []);
  keys.forEach(k => {
    const before = (prev && prev[k]) || {};
    const live = (typeof indexOne_ === 'function' ? indexOne_(db[k]) : {});
    Object.keys(live).forEach(rid => {
      const rec = live[rid];
      const was = before[rid];
      if (!rec || !rec.at) return;
      if (was && String(was.at || '') === String(rec.at || '')) return;   // unchanged
      cloudEnqueueRecord(k, rec, false);
      n++;
    });
  });
  // Deletes just made: a tombstone newer than what was last committed.
  (tombList_(db) || []).forEach(t => {
    const prevT = (tombList_(prev || {}) || []).find(x => x.key === t.key && x.id === t.id);
    if (prevT && String(prevT.at || '') === String(t.at || '')) return;
    cloudEnqueueRecord(t.key, { id: t.id, at: t.at }, true);
    n++;
  });
  return n;
}

function cloudEnqueueRecord(key, rec, deleted) {
  if (typeof syncPush !== 'function') return;
  syncPush('firestore_record',
    { key: key, id: rec.id, deleted: !!deleted, at: rec.at, record: rec },
    'Firestore record (' + key + ')', 'firestore');
  // Always keep the Sheet mirror warm, so the phone is never left behind.
  cloudQueueSheetMirror(key, rec, deleted);
}

/* One queued Firestore job. Returns {ok,message}; on a transient failure the caller
   degrades and the job stays in the outbox. */
async function cloudSendJob(job) {
  const d = job.data || {};
  try {
    await fbWriteRecord(d.key, d.record || { id: d.id, at: d.at }, { at: d.at, deleted: d.deleted });
    cloudBackoffStep = 0;
    if (cloudState() !== 'ONLINE_FIRESTORE') cloudStateSet('ONLINE_FIRESTORE', '', 0);
    return { ok: true };
  } catch (e) {
    const msg = String(e.message || e);
    if (fbIsTransient(msg) || msg === 'NOT_SIGNED_IN') {
      cloudStateSet('DEGRADED_SHEET', msg, cloudBackoffMs());
    }
    return { ok: false, message: msg };
  }
}

/* ===================== pull + merge ===================== */
/* One run: pull the delta and merge it. Used by the open/login auto-sync and by the
   Firestore retry timer. On a transient failure the device degrades to the Sheet and
   arms a retry; it does not thrash. */
async function cloudPullMerge() {
  if (!cloudConfigured()) return { merged: false, reason: 'not configured' };
  try {
    const delta = await fbPullDelta();
    if (!delta.records.length) { fbCursorSet(delta.newest); return { merged: false, reason: 'no change' }; }
    const incoming = cloudMergeDelta(delta);
    snapshot();
    mergeCloudInto_(incoming);
    cloudMuted = true;                 // do not echo the merged records straight back up
    let saved = false;
    try { saved = commit(); } finally { cloudMuted = false; }
    if (!saved) return { merged: false, reason: 'save failed' };
    fbCursorSet(delta.newest);
    await cloudPullCatchupSettings();
    cloudBackoffStep = 0;
    cloudStateSet('ONLINE_FIRESTORE', '', 0);
    return { merged: true };
  } catch (e) {
    const msg = String(e.message || e);
    if (fbIsTransient(msg) || msg === 'NOT_SIGNED_IN') {
      cloudStateSet('DEGRADED_SHEET', msg, cloudBackoffMs());
    } else {
      cloudStateSet('DEGRADED_SHEET', msg, 0);
    }
    return { merged: false, reason: msg };
  }
}

/* Business settings move as one document. Machine-local keys are dropped before it is
   written, exactly as mergeSettingsInto_ drops them on read. */
async function cloudPullCatchupSettings() {
  // Settings ride inside the records delta as the `_settings__shop` document's `data`.
  return true;
}

async function cloudPushSettings() {
  if (!cloudConfigured()) return;
  const s = Object.assign({}, (db && db.settings) || {});
  (typeof LOCAL_SETTING_KEYS !== 'undefined' ? LOCAL_SETTING_KEYS : []).forEach(k => delete s[k]);
  delete s.firebase;
  try {
    await fbWriteRecord('_settings', { id: 'shop', settings: s, at: (db.settings.settingsUpdatedAt || new Date().toISOString()) }, {});
  } catch (e) { /* settings are also in the Sheet mirror */ }
}

/* ===================== auto-sync entry point ===================== */
var cloudBusy = false;
var cloudRetryTimer = null;

async function cloudAutoSyncNew(reason) {
  if (!cloudConfigured()) return { skipped: 'not configured' };
  if (typeof session === 'undefined' || !session) return { skipped: 'signed out' };
  if (!fbSignedIn()) return { skipped: 'firebase not signed in' };
  if (cloudBusy) return { skipped: 'busy' };
  if (CLOUD_STATE.retryAt && Date.now() < CLOUD_STATE.retryAt) {
    cloudArmRetry();
    return { skipped: 'backoff' };
  }
  cloudBusy = true;
  try {
    if (typeof syncFlush === 'function') { try { syncFlush(); } catch (e) {} }
    const r = await cloudPullMerge();
    return r;
  } finally { cloudBusy = false; }
}

function cloudArmRetry() {
  if (cloudRetryTimer) return;
  const wait = Math.max(1000, (CLOUD_STATE.retryAt || Date.now()) - Date.now());
  cloudRetryTimer = setTimeout(function () {
    cloudRetryTimer = null;
    cloudAutoSyncNew('retry').catch(function () {});
  }, Math.min(wait, 15 * 60 * 1000));
}

/* ===================== one-time migration =====================
   The first time Firestore is reachable, push the whole local book once (plus
   tombstones), in batches, then record that it is done. Idempotent: it upserts on the
   record id, so re-running or resuming is safe. */
async function cloudMigrate(quiet) {
  if (!cloudConfigured()) { if (!quiet) alert('Set the Firebase keys first.'); return false; }
  if (!fbSignedIn()) { if (!quiet) alert('Sign in to Firebase sync first.'); return false; }
  try {
    if (typeof syncFlush === 'function') { try { syncFlush(); } catch (e) {} }
    const pairs = [];
    (typeof MERGE_KEYS !== 'undefined' ? MERGE_KEYS : []).forEach(k => {
      (db[k] || []).forEach(rec => { if (rec && rec.id) pairs.push({ key: k, rec: rec }); });
    });
    (tombList_(db) || []).forEach(t => pairs.push({ key: t.key, rec: { id: t.id, at: t.at }, deleted: true }));
    pairs.push({ key: '_settings', rec: { id: 'shop', at: (db.settings.settingsUpdatedAt || new Date().toISOString()), settings: Object.assign({}, db.settings) } });

    const CHUNK = 200;
    let sent = 0;
    for (let i = 0; i < pairs.length; i += CHUNK) {
      await fbWriteBatch(pairs.slice(i, i + CHUNK));
      sent += Math.min(CHUNK, pairs.length - i);
    }
    try { localStorage.setItem(FB_MIGRATED_KEY, new Date().toISOString()); } catch (e) {}
    cloudStateSet('ONLINE_FIRESTORE', '', 0);
    if (!quiet) alert('Cloud migration done — ' + sent + ' records sent.');
    return true;
  } catch (e) {
    const msg = String(e.message || e);
    if (fbIsTransient(msg)) cloudStateSet('DEGRADED_SHEET', msg, cloudBackoffMs());
    if (!quiet) alert('Migration could not finish: ' + msg + ' (it will resume next time)');
    return false;
  }
}

function cloudMigrated() { try { return !!localStorage.getItem(FB_MIGRATED_KEY); } catch (e) { return false; } }

/* Called on boot, after the session is known. Quiet: opening the app must never
   pop an alert. */
function cloudBoot() {
  cloudStateLoad();
  if (!cloudConfigured()) return;
  if (!fbSignedIn()) return;
  if (!cloudMigrated()) { cloudMigrate(true).catch(function () {}); return; }
  cloudAutoSyncNew('open').catch(function () {});
  if (cloudState() === 'DEGRADED_SHEET') cloudArmRetry();
}
