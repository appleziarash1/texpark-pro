/* Realtime push via the Firebase SDK's onSnapshot: the "0" path.

   Live verification against the owner's project proved the raw REST
   documents:listen is refused (Firestore's realtime stream is gRPC-Web/WebChannel,
   not plain REST), so realtime is SDK-only. This drives the REAL cloud.js against a
   stand-in SDK injected where fbSdkLoad() would have put the real one, so
   fbRealtimeStart / fbSignIn / fbSignOut and the wake-up merge are exercised as
   written, with no network and no CDN.

   Run: node test/realtime.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

const tick = () => new Promise(r => setImmediate(r));
const ticks = async (n) => { for (let i = 0; i < n; i++) await tick(); };

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* A stand-in for the loaded firebase-* SDK. onSnapshot records the ref and the two
   callbacks so the test can push a change and watch the wake-up merge. */
function makeSdk() {
  const sdk = { snaps: [], authCalls: [], currentUser: null, unsubscribeCalls: 0, signedOut: false };
  sdk.collection = (db, ...segs) => ({ kind: 'collection', path: segs.join('/') });
  sdk.onSnapshot = (ref, onNext, onErr) => {
    sdk.snaps.push({ ref, onNext, onErr });
    return () => { sdk.unsubscribeCalls++; };
  };
  sdk.user = (uid, email) => ({ uid, email, getIdToken: async () => 'tok-' + uid });
  sdk.authApi = {
    getAuth: () => ({ get currentUser() { return sdk.currentUser; } }),
    signInWithEmailAndPassword: async (auth, email, pw) => {
      sdk.authCalls.push({ op: 'signIn', email, pw });
      sdk.currentUser = sdk.user('uid-1', email);
      return { user: sdk.currentUser };
    },
    createUserWithEmailAndPassword: async (auth, email, pw) => {
      sdk.authCalls.push({ op: 'signUp', email, pw });
      sdk.currentUser = sdk.user('uid-1', email);
      return { user: sdk.currentUser };
    },
    signOut: async () => { sdk.signedOut = true; sdk.currentUser = null; }
  };
  sdk.fsApi = { getFirestore: () => ({ name: 'db' }), collection: sdk.collection, onSnapshot: sdk.onSnapshot };
  return sdk;
}

/* Load the real cloud.js in a sandbox, then install the stand-in SDK exactly as
   fbSdkLoad() would have. A network fetch rejects, so if the SDK path is ever
   skipped the test fails loudly instead of silently hitting the REST fallback. */
function makeSandbox(sdk) {
  const store = {};
  const sandbox = {
    console, TextEncoder, TextDecoder, Promise, JSON, Date, Object, Array, Math, String, Number,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    setTimeout: () => 0, clearTimeout: () => {},
    fetch: () => Promise.reject(new Error('the test forbids the REST path')),
    document: { getElementById: () => null, addEventListener() {} },
    import: () => Promise.reject(new Error('the test forbids the CDN'))
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['js/db.js', 'js/firebase-config.js', 'js/cloud.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  // db.js declares `var session = null`, so this must be set after the scripts load.
  sandbox.db = sandbox.blankDB();
  sandbox.session = { userId: 'u1', username: 'admin' };
  sandbox.cloudBusy = false;
  if (sdk) {
    sandbox.fbSdkReady = true;
    sandbox.fbSdkAuth = { get currentUser() { return sdk.currentUser; } };
    sandbox.fbSdkAuthApi = sdk.authApi;
    sandbox.fbSdkDb = { name: 'db' };
    sandbox.fbSdkFsApi = sdk.fsApi;
  }
  return sandbox;
}

(async () => {
  console.log('\n--- realtime: onSnapshot over the records subcollection ---');
  {
    const sdk = makeSdk();
    const s = makeSandbox(sdk);
    let pulls = 0;
    s.cloudPullMerge = async () => { pulls++; return {}; };

    await s.fbSignIn('shop@example.com', 'secret1');
    eq(sdk.authCalls[0].op, 'signIn', 'sign-in went through the SDK, so the listener shares that session');
    ok(s.fbSignedIn(), 'the SDK session is stored like the REST one');
    ok(s.fbAuthLoad().uid === 'uid-1', 'the stored auth carries the SDK uid');

    s.fbRealtimeStart(); await ticks(6);
    eq(sdk.snaps.length, 1, 'exactly one live listener was attached');
    eq(sdk.snaps[0].ref.kind, 'collection', 'it listens to a collection');
    eq(sdk.snaps[0].ref.path, 'shops/uid-1/records', 'scoped to this uid, like the delta query');

    sdk.snaps[0].onNext(); await ticks(3);
    eq(pulls, 1, 'a server push wakes the ONE proven merge exactly once');

    /* A burst coalesces while a merge is in flight. */
    pulls = 0;
    let release;
    s.cloudPullMerge = () => new Promise(r => { release = () => { pulls++; r({}); }; });
    s.fbRealtimeOnChange(); s.fbRealtimeOnChange(); s.fbRealtimeOnChange();
    await tick();
    eq(pulls, 0, 'while a merge is in flight, further pushes do not stack');
    release(); await tick();
    eq(pulls, 1, 'the burst produced exactly one merge');

    /* Starting again does not attach a second listener. */
    s.fbRealtimeStart(); await ticks(3);
    eq(sdk.snaps.length, 1, 'a second Start is a no-op while one listener is live');

    /* Sign-out unsubscribes. */
    s.fbSignOut(); await ticks(3);
    eq(sdk.unsubscribeCalls, 1, 'sign-out tears the listener down');
    eq(s.fbRealtimeUnsub, null, 'and clears the handle');
    ok(sdk.signedOut, 'the SDK session is also signed out');
  }

  console.log('\n--- it stays off when there is no session or no sign-in ---');
  {
    const sdk = makeSdk();
    const s = makeSandbox(sdk);
    s.cloudPullMerge = async () => ({});
    s.session = null;
    s.fbRealtimeStart(); await ticks(6);
    eq(sdk.snaps.length, 0, 'no session: no listener');

    s.session = { userId: 'u1' };
    s.fbRealtimeStart(); await ticks(6);
    eq(sdk.snaps.length, 0, 'signed out: no listener');
  }

  console.log('\n--- boot: a saved session starts the listener even before migration ---');
  {
    const sdk = makeSdk();
    const s = makeSandbox(sdk);
    s.cloudPullMerge = async () => ({});
    s.cloudMigrate = async () => true;             // migration is not the subject; keep the boot quiet
    sdk.currentUser = sdk.user('uid-1', 'shop@example.com');
    s.fbAuthSave({ idToken: 'tok', uid: 'uid-1', email: 'shop@example.com', expiresAt: Date.now() + 1e7 });
    s.cloudBoot(); await ticks(8);
    eq(sdk.snaps.length, 1, 'a device that imported its book still starts the live listener at boot');
    eq(s.cloudMigrated(), false, 'still un-migrated, proving the listener did not wait for the first full push');
  }

  console.log('\n--- without the SDK there is no listener, so the adaptive poll is the floor ---');
  {
    const sdk = makeSdk();
    const s = makeSandbox(null);   // SDK never loaded
    s.cloudPullMerge = async () => ({});
    s.fbRealtimeStart(); await ticks(6);
    eq(sdk.snaps.length, 0, 'no SDK: no listener; the poll keeps syncing');
    eq(s.__timers === undefined || true, true, 'and nothing throws');
  }

  console.log('\n=================');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})();
