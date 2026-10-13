/* Texpark Pro — live multi-device sync, with the Google Sheet as fallback.

   Two interchangeable backends sit behind one interface:
     - Cloudflare Worker + Durable Object (js/cloudcf.js), selected by
       window.CLOUDFLARE_SYNC.backend = 'cloudflare'. One Durable Object per shop holds
       the records and pushes each change over a WebSocket, so the data lives in the
       owner's own Cloudflare account, not Firebase.
     - Firebase Firestore (this file's own REST calls), the previous backend, kept
       whole as the fallback and selected by backend = 'firebase'.
   Everything above the transport - merge, "newer wins", the cursor, the outbox, the
   badges - is shared, so the two backends cannot drift.

   The Google Sheet sync in js/sync.js ships a whole JSON snapshot per device and the
   newest snapshot wins as a set. That is fine and it stays, but it is not live: a memo
   typed on the phone reaches the PC only after the next snapshot round. This layer
   adds per-record sync, so one changed memo is one write and one read - not the whole
   book - and it arrives in well under a second.

   It is additive and reversible. With no backend configured nothing here runs and the
   app behaves exactly as before. When the cloud is down, over quota, or unreachable,
   every write also goes to the Sheet's Records tab through the SAME outbox in
   js/sync.js, and a backoff timer tries the cloud again.

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
function cloudConfigured() {
  if (cfOn_()) return true;
  const c = fbConfig(); return !!(c.apiKey && c.projectId);
}

/* True when this build is running on the Cloudflare backend (js/cloudcf.js). The
   Firestore path below stays fully intact as the fallback, so switching the build
   back to `backend:'firebase'` restores it exactly. */
function cfOn_() { return typeof cfBackendOn === 'function' && cfBackendOn(); }

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

/* ===================== one-tap provisioning (private link) =====================
   The owner wants every device to reach the live shop without typing anything, and
   without the shop's email + password living in this public repository. A link the
   owner keeps privately carries the account and password in the URL *fragment*: the
   fragment is never sent to a server and never lands in a referrer, so the hosts and
   any access log only ever see a clean page load. Opening the link signs the device
   in once and drops the secret from the address bar; the session is then cached, so
   every later open is silent.

   This is the one place a password may be stored on the device. It is stored in the
   device's own localStorage under its own key - never in a file, never in a request
   body, never in the page's own URL once adopted. */
const FB_PROV_KEY = 'texpark_pro_firebase_prov';
function fbProvLoad() { try { return JSON.parse(localStorage.getItem(FB_PROV_KEY) || 'null'); } catch (e) { return null; } }
function fbProvClear() { try { localStorage.removeItem(FB_PROV_KEY); } catch (e) {} }

/* Reads #cloud=<base64(email:password)> and adopts it. Returns true when it adopted
   something, so the caller can sign in and re-issue the link for this host. */
function fbAdoptProvision() {
  let raw = '';
  try {
    const m = /(?:^|[#&])cloud=([^&]+)/.exec(location.hash || '');
    if (m) raw = decodeURIComponent(m[1]);
  } catch (e) { raw = ''; }
  const cleanHash = (function () { try { return (location.hash || '').replace(/[#&]?cloud=[^&]+/, ''); } catch (e) { return ''; } })();
  const scrub = function () {
    try { history.replaceState(null, '', location.pathname + location.search + cleanHash); } catch (e) {}
  };
  if (raw) {
    try {
      const s = (typeof atob === 'function') ? atob(raw) : '';
      /* A `cf|<token>` payload is the Cloudflare shop token, not an email:password. */
      if (s.indexOf('cf|') === 0) {
        const token = s.slice(3);
        if (token) { cfAdoptToken_(token); scrub(); return true; }
      }
      const i = s.indexOf(':');
      if (i > 0) {
        const email = s.slice(0, i), password = s.slice(i + 1);
        if (email && password) { fbProvSave(email, password); scrub(); return true; }
      }
    } catch (e) { /* not a provisioning link; leave it */ }
    scrub();
  }
  return false;
}
function fbProvSave(email, password) {
  try { localStorage.setItem(FB_PROV_KEY, JSON.stringify({ email: email, password: password })); } catch (e) {}
}

/* ===================== Cloudflare shop token (same private-link idea) =====================
   This repository is public, so the shop token must NOT live in a committed file - a
   token in cloudflare-config.js would let anyone read and write the shop. Instead the
   token travels exactly like the Firebase account: in the URL *fragment* of a link the
   owner keeps privately. Opening the link once stores it in this device's own data
   (db.settings.cloudflare, which cfConfig() already reads) and scrubs the address bar.

   The token lives inside the same base64 blob as the Firebase account, with a `cf|`
   prefix so the two can share one link; a token-only link (no Firebase account) is
   `#cloud=<base64('cf|<token>')>`.

   NOTE: because the fragment rides the same `cloud=` parameter the app also re-issues
   on every host, a device provisioned with the token carries it in its own link. Keep
   that link as secret as the token itself. */
function cfProvToken_() {
  try { return String((db.settings.cloudflare && db.settings.cloudflare.token) || '').trim(); } catch (e) { return ''; }
}
function cfProvSave(token) {
  const t = String(token || '').trim();
  if (!t) return false;
  try {
    if (!db.settings.cloudflare) db.settings.cloudflare = {};
    db.settings.cloudflare.token = t;
    commit();
  } catch (e) { return false; }
  return true;
}
/* The token for THIS host's link, so another device can be set up in one tap. */
function cfProvisionLink() {
  const t = cfProvToken_();
  if (!t) return '';
  try { return location.origin + location.pathname + '#cloud=' + encodeURIComponent(btoa('cf|' + t)); }
  catch (e) { return ''; }
}
/* Called from fbAdoptProvision() when a `cf|` payload was seen. */
function cfAdoptToken_(token) {
  if (!cfProvSave(token)) return false;
  if (typeof cloudProvRender === 'function') { try { cloudProvRender(); } catch (e) {} }
  return true;
}

/* The link for THIS host, rebuilt from the stored account. A different host (GitHub
   Pages vs Cloudflare Pages) needs its own link, so the app re-issues one whenever it
   is opened with the other host's link - same secret, this host's address. */
function fbProvisionLink() {
  const p = fbProvLoad();
  if (!p || !p.email || !p.password) return '';
  try {
    const b64 = btoa(p.email + ':' + p.password);
    return location.origin + location.pathname + '#cloud=' + encodeURIComponent(b64);
  } catch (e) { return ''; }
}


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

/* ===================== Firebase JS SDK (realtime only) =====================
   Reads and writes stay on the REST path: it is cheap, testable, and needs no
   dependency. Realtime push is the exception. Firestore's realtime stream is NOT
   plain REST - it rides gRPC-Web (WebChannel) - so a raw `documents:listen` POST is
   refused with INVALID_ARGUMENT even with a valid token (verified against this
   project). The one supported way to get true push in a browser is the SDK's
   onSnapshot, so firebase-app/auth/firestore are loaded from the CDN and used ONLY
   for auth and the listener. If the CDN is unreachable the load resolves false and
   every caller falls back to the REST auth + adaptive poll it had before, so a
   blocked CDN can never stop the app from saving data. */
const FB_SDK_VER = '10.12.0';
const FB_SDK_BASE = 'https://www.gstatic.com/firebasejs/' + FB_SDK_VER + '/';
var fbSdkReady = false;
var fbSdkPromise = null;
var fbSdkApp = null;
var fbSdkAuth = null;
var fbSdkAuthApi = null;
var fbSdkDb = null;
var fbSdkFsApi = null;

function fbSdkLoad() {
  if (fbSdkReady) return Promise.resolve(true);
  if (fbSdkPromise) return fbSdkPromise;
  const c = fbConfig();
  if (!c.apiKey || !c.projectId) return Promise.resolve(false);
  fbSdkPromise = (async function () {
    const appMod = await import(FB_SDK_BASE + 'firebase-app.js');
    const authMod = await import(FB_SDK_BASE + 'firebase-auth.js');
    const fsMod = await import(FB_SDK_BASE + 'firebase-firestore.js');
    fbSdkApp = appMod.initializeApp({ apiKey: c.apiKey, projectId: c.projectId });
    fbSdkAuth = authMod.getAuth(fbSdkApp);
    fbSdkDb = fsMod.getFirestore(fbSdkApp);
    fbSdkAuthApi = authMod;
    fbSdkFsApi = fsMod;
    fbSdkReady = true;
    return true;
  })().catch(function () { fbSdkPromise = null; return false; });   // allow a later retry
  return fbSdkPromise;
}

/* Sign in with the SAME email + password on every device. Both devices must use one
   account: the shop lives under that account's uid, so an anonymous sign-in on each
   device would put them in different shops and they would never see each other.

   Sign-in goes through the SDK when it is available, because the listener shares that
   signed-in session; otherwise the same email/password call is made against the Auth
   REST API, so the app behaves exactly as it did before the SDK. */
async function fbSignIn(email, password) {
  const c = fbConfig();
  if (!c.apiKey) throw new Error('No Firebase API key set.');
  if (await fbSdkLoad() && fbSdkAuth && fbSdkAuthApi) {
    try {
      const cred = await fbSdkAuthApi.signInWithEmailAndPassword(fbSdkAuth, email, password);
      const a = await fbSdkAuthCred(cred.user, email);
      fbAuthSave(a);
      cloudBackoffStep = 0;
      cloudStateSet('ONLINE_FIRESTORE', '', 0);
      fbRealtimeStart();
      return a;
    } catch (e) { throw new Error(fbSdkAuthError(e)); }
  }
  const res = await jsonPost(FB_AUTH_URL + '/accounts:signInWithPassword?key=' + encodeURIComponent(c.apiKey),
    { email: email, password: password, returnSecureToken: true });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(fbAuthError(j));
  const a = fbAuthReply(j, email);
  fbAuthSave(a);
  cloudBackoffStep = 0;
  cloudStateSet('ONLINE_FIRESTORE', '', 0);
  if (typeof fbRealtimeStart === 'function') fbRealtimeStart();
  return a;
}

/* Sign in from the provisioned account when there is no live session. Quiet: the
   device was set up once, so a failure here just leaves the app on the Sheet path
   until the owner re-opens the private link. */
async function fbSignInDefault() {
  const p = fbProvLoad();
  if (!p || !p.email || !p.password) return false;
  try {
    const a = await fbSignIn(p.email, p.password);
    if (!cloudMigrated()) cloudMigrate(true).catch(function () {});
    // cloudBoot() signs in here and then returns early, so on a cold load whose
    // sign-in finishes after boot no listener would ever start. Start the pipeline
    // now: the first pull, the live stream, and (if we degraded) the retry timer.
    if (typeof cloudAutoSyncNew === 'function') cloudAutoSyncNew('provisioned').catch(function () {});
    if (typeof fbRealtimeStart === 'function') fbRealtimeStart().catch(function () {});
    if (cloudState() === 'DEGRADED_SHEET' && typeof cloudArmRetry === 'function') cloudArmRetry();
    return !!a;
  } catch (e) {
    cloudStateSet('DEGRADED_SHEET', String(e.message || e), 0);
    return false;
  }
}

async function fbSignUp(email, password) {
  const c = fbConfig();
  if (!c.apiKey) throw new Error('No Firebase API key set.');
  if (await fbSdkLoad() && fbSdkAuth && fbSdkAuthApi) {
    try {
      const cred = await fbSdkAuthApi.createUserWithEmailAndPassword(fbSdkAuth, email, password);
      const a = await fbSdkAuthCred(cred.user, email);
      fbAuthSave(a);
      fbRealtimeStart();
      return a;
    } catch (e) { throw new Error(fbSdkAuthError(e)); }
  }
  const res = await jsonPost(FB_AUTH_URL + '/accounts:signUp?key=' + encodeURIComponent(c.apiKey),
    { email: email, password: password, returnSecureToken: true });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(fbAuthError(j));
  const a = fbAuthReply(j, email);
  fbAuthSave(a);
  return a;
}

/* The stored auth shape the rest of cloud.js expects, derived from an SDK user. The
   SDK refreshes the idToken itself, so fbEnsureAuth() can simply ask it again. */
async function fbSdkAuthCred(user, email) {
  const tok = await user.getIdToken();
  return {
    idToken: tok, refreshToken: '', uid: user.uid,
    email: user.email || email || '', expiresAt: Date.now() + 3000000
  };
}

function fbSdkAuthError(e) {
  const code = (e && e.code) || 'AUTH_FAILED';
  const map = {
    'auth/email-already-in-use': 'That email is already registered - use Sign in instead.',
    'auth/user-not-found': 'No account with that email - use Create account instead.',
    'auth/wrong-password': 'Wrong password.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/invalid-email': 'That email address looks wrong.',
    'auth/weak-password': 'The password must be at least 6 characters.',
    'auth/network-request-failed': 'Network problem - check the internet connection.',
    'auth/operation-not-allowed': 'Email/password sign-in is not enabled in Firebase.',
    'auth/too-many-requests': 'Too many attempts - wait a minute and try again.'
  };
  return map[code] || ('Firebase said: ' + String(code).replace(/^auth\//, ''));
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
  fbRealtimeStop();
  if (fbSdkReady && fbSdkAuth && fbSdkAuthApi) { try { fbSdkAuthApi.signOut(fbSdkAuth); } catch (e) {} }
  fbAuthClear();
  if (typeof cloudStatusRender === 'function') cloudStatusRender();
}

/* A fresh idToken, or null. Ask the SDK first (it owns the listener's session, and
   refreshes the token itself); fall back to the stored token and the REST refresh. */
async function fbEnsureAuth() {
  await fbSdkLoad();
  if (fbSdkReady && fbSdkAuth && fbSdkAuth.currentUser) {
    try {
      const a = await fbSdkAuthCred(fbSdkAuth.currentUser, fbSdkAuth.currentUser.email);
      fbAuthSave(a);
      return a;
    } catch (e) { /* fall through to the stored-token path */ }
  }
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
  if (cfOn_()) return cfWriteRecord(key, rec, opts);
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
  if (cfOn_()) return cfWriteBatch(pairs);
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
/* The cursor is a plain "newest at pulled" value, independent of which backend wrote
   it, so both transports share it: switching backends resumes as a delta, not a full
   re-read. */
function cloudCursor() { return cfOn_() ? cfCursor() : fbCursor(); }
function cloudCursorSet(at) { if (cfOn_()) cfCursorSet(at); else fbCursorSet(at); }
function fbCursorSet(at) { try { localStorage.setItem(FB_CURSOR_KEY, String(at || '')); } catch (e) {} }

/* Every record whose `at` is newer than the cursor, in one runQuery. This is the
   call that keeps the free plan free: it reads only what moved since the last pull,
   never the whole collection, and the field is range-filtered so Firestore uses its
   automatic single-field index (no composite index to create by hand). */
async function fbPullDelta() {
  if (cfOn_()) return cfPullDelta();
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
  /* The :runQuery endpoint's parent is the SHOP document, so the path ends at
     `shops/{uid}:runQuery` - not `shops/{uid}/records:runQuery`. Firestore reads the
     parent out of the path itself and rejects a collection ("...records lacks \"/\""
     INVALID_ARGUMENT), which silently degraded every device to the Sheet. */
  const res = await fetch(fbDocsUrl() + '/shops/' + encodeURIComponent(auth.uid) + ':runQuery',
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
  const cf = typeof cfOn_ === 'function' && cfOn_();
  const liveName = cf ? 'Cloudflare' : 'Firestore';
  if (st === 'ONLINE_FIRESTORE') { el.className = 'sync-badge sync-green'; el.textContent = '☁ ' + liveName + ' live'; }
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


/* ===================== realtime push (onSnapshot) =====================
   The true "0" path: one live stream so the server pushes each change the instant it
   is written. Firestore's realtime stream is gRPC-Web (WebChannel), not plain REST, so
   this is the SDK's onSnapshot - a raw `documents:listen` POST is refused even with a
   valid token (verified against this project). Writes and the delta pull stay on the
   REST path; this is a pure wake-up.

   On any change it calls the SAME cloudPullMerge() the sync tests already prove, so
   there is exactly one definition of "newer-wins" and no second merge path. Bursts
   coalesce, and it stands down while this device is busy or has an unsent edit, so it
   cannot race its own upload. If the SDK or the stream is unavailable, the adaptive
   poll (2 s active / 10 s idle) is the guaranteed floor - the app is never worse than
   a fast poll, and reaches true push when the stream is up. */
var fbRealtimeUnsub = null;
var fbRealtimeStarting = false;
var fbRealtimeMergeQueued = false;
/* A dropped stream must come back on its own. Left with an empty error handler the
   tab silently fell from push (~0.3 s) to the idle poll for the rest of the session -
   the exact "sometimes it is live, sometimes it is not" the owner kept hitting. Retry
   with a short bounded backoff, capped so a long outage does not hammer the network. */
var fbRealtimeRetryTimer = null;
var fbRealtimeRetryMs = 1000;
var FB_REALTIME_RETRY_MAX_MS = 30000;

function fbRealtimeShouldRun() {
  return cloudConfigured() && fbSignedIn() && (typeof session !== 'undefined' && !!session);
}
/* True while the push stream is connected. app.js reads this to choose a poll
   cadence: calm when push is doing the work, fast while the stream is down and the
   poll is the only path left. That keeps "always live" without paying for a 2 s poll
   on a healthy device all day. */
function fbRealtimeLive() { return cfOn_() ? cfRealtimeLive() : !!fbRealtimeUnsub; }
function fbRealtimeRetryClear() {
  if (cfOn_()) return cfRealtimeRetryClear();
  if (fbRealtimeRetryTimer) { try { clearTimeout(fbRealtimeRetryTimer); } catch (e) {} fbRealtimeRetryTimer = null; }
  fbRealtimeRetryMs = 1000;
}
function fbRealtimeArmRetry() {
  if (cfOn_()) return cfRealtimeArmRetry();
  if (fbRealtimeRetryTimer || fbRealtimeUnsub) return;
  if (!fbRealtimeShouldRun()) return;
  var wait = fbRealtimeRetryMs;
  fbRealtimeRetryMs = Math.min(fbRealtimeRetryMs * 2, FB_REALTIME_RETRY_MAX_MS);
  fbRealtimeRetryTimer = setTimeout(function () {
    fbRealtimeRetryTimer = null;
    return fbRealtimeStart().catch(function () {});
  }, wait);
}
function fbRealtimeStop() {
  if (cfOn_()) return cfRealtimeStop();
  fbRealtimeStarting = false;
  fbRealtimeRetryClear();
  if (fbRealtimeUnsub) { try { fbRealtimeUnsub(); } catch (e) {} fbRealtimeUnsub = null; }
}
function fbRealtimeOnChange() {
  if (cfOn_()) return cfRealtimeOnChange();
  if (fbRealtimeMergeQueued) return;
  if (cloudBusy || (typeof cloudDirty !== 'undefined' && cloudDirty)) return;
  fbRealtimeMergeQueued = true;
  cloudPullMerge().catch(function () {}).then(function () { fbRealtimeMergeQueued = false; });
}
async function fbRealtimeStart() {
  if (cfOn_()) return cfRealtimeStart();
  if (fbRealtimeUnsub || fbRealtimeStarting) return;   // already listening, or starting
  if (!fbRealtimeShouldRun()) return;
  fbRealtimeStarting = true;
  try {
    if (!(await fbSdkLoad()) || !fbSdkAuth || !fbSdkAuth.currentUser) { fbRealtimeArmRetry(); return; }
    if (!fbRealtimeShouldRun()) return;                // signed out while loading
    const uid = fbSdkAuth.currentUser.uid;
    /* Captured locally: if fbRealtimeStop() runs, its callback must not clear or
       re-arm a stream that has since been replaced. */
    let live = true;
    const unsub = fbSdkFsApi.onSnapshot(
      fbSdkFsApi.collection(fbSdkDb, 'shops', uid, 'records'),
      function () {
        if (!live) return;
        fbRealtimeRetryMs = 1000;                      // a healthy callback resets the backoff
        fbRealtimeOnChange();
      },
      function () {
        // The stream itself failed (network change, idleServer timeout, refused
        // listen). Forget this one and reconnect; the adaptive poll covers the gap.
        if (!live) return;
        live = false;
        if (fbRealtimeUnsub === unsub) fbRealtimeUnsub = null;
        try { unsub(); } catch (e) {}
        if (typeof syncStatusRender === 'function') { try { syncStatusRender(); } catch (e) {} }
        fbRealtimeArmRetry();
      });
    fbRealtimeUnsub = unsub;
    fbRealtimeRetryClear();                            // it started: cancel any pending retry
    if (typeof syncStatusRender === 'function') { try { syncStatusRender(); } catch (e) {} }
  } catch (e) { fbRealtimeUnsub = null; fbRealtimeArmRetry(); }
  finally { fbRealtimeStarting = false; }
}

/* ===================== pull + merge ===================== */
/* One run: pull the delta and merge it. Used by the open/login auto-sync and by the
   Firestore retry timer. On a transient failure the device degrades to the Sheet and
   arms a retry; it does not thrash. */
async function cloudPullMerge() {
  if (!cloudConfigured()) return { merged: false, reason: 'not configured' };
  try {
    const delta = await fbPullDelta();
    if (!delta.records.length) { cloudCursorSet(delta.newest); return { merged: false, reason: 'no change' }; }
    const incoming = cloudMergeDelta(delta);
    snapshot();
    mergeCloudInto_(incoming);
    cloudMuted = true;                 // do not echo the merged records straight back up
    let saved = false;
    try { saved = commit(); } finally { cloudMuted = false; }
    if (!saved) return { merged: false, reason: 'save failed' };
    cloudCursorSet(delta.newest);
    await cloudPullCatchupSettings();
    cloudBackoffStep = 0;
    cloudStateSet('ONLINE_FIRESTORE', '', 0);
    /* A change from another device is now in. Bump the badge so the owner can SEE it
       land - the sub-second arrival is otherwise indistinguishable from "nothing
       happened". Guarded: the pulse is pure UI and must never affect the merge. */
    if (typeof livePulse_ === 'function') { try { livePulse_(); } catch (e) {} }
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
  /* The Cloudflare backend authenticates with the shop token, not a Firebase session,
     so the sign-in guard only applies to the Firestore path. */
  if (!cfOn_() && !fbSignedIn()) return { skipped: 'firebase not signed in' };
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
  if (!cfOn_() && !fbSignedIn()) { if (!quiet) alert('Sign in to Firebase sync first.'); return false; }
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
  /* Adopt a private #cloud= link FIRST, before the configured check. A brand-new
     device has no token yet, so cloudConfigured() is false and this function used to
     return here - the link was never read, and the device stayed blank until the
     owner reloaded. Reading the link first turns the very first open into a live
     device: no reload, nothing to type. */
  let adopted = false;
  try { adopted = fbAdoptProvision(); } catch (e) {}
  if (!cloudConfigured()) return;
  /* Then sign in from the link if this device has no live session yet. That is the
     whole of the "nothing to type" setup. */
  /* On the Cloudflare backend the shop token is the auth, so a Firebase session is
     neither needed nor created; the Firestore sign-in path stays for `firebase`. */
  if (!cfOn_() && !fbSignedIn()) {
    if (adopted || fbProvLoad()) fbSignInDefault().catch(function () {});
    return;
  }
  /* The first full push and live sync are independent: an un-migrated device used
     to skip the listener and the open pull entirely, so a fresh install that had
     imported its old book sat on the slow poll until its migration finished. Start
     the pull and the listener regardless; the migration is idempotent and no longer
     gates them. */
  if (!cloudMigrated()) cloudMigrate(true).catch(function () {});
  cloudAutoSyncNew('open').catch(function () {});
  if (cloudState() === 'DEGRADED_SHEET') cloudArmRetry();
  if (typeof fbRealtimeStart === 'function') fbRealtimeStart().catch(function () {});
}

/* The `hashchange` half of the private-link setup. Opening a #cloud= link inside the
   tab that is already open changes only the fragment, so the browser does not reload
   and boot()/cloudBoot() never run again. Adopt the token here and bring the backend
   up on this very page: no manual reload, which was the one step the owner kept
   missing. Cleans the fragment (fbAdoptProvision scrubs it) and is a no-op otherwise. */
function cloudAdoptFromHash_() {
  let adopted = false;
  try { adopted = (typeof fbAdoptProvision === 'function') && fbAdoptProvision(); } catch (e) { adopted = false; }
  if (!adopted) return false;
  try { cloudBoot(); } catch (e) {}
  return true;
}
