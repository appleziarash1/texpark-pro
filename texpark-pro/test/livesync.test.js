/* Live delta pull: the fast lane that makes a change on another device land within
   seconds. Driven through the REAL app.js against a DOM shim; the seams are
   `cloudConfigured`, `fbSignedIn`, `session`, `cloudBusy`/`cloudDirty`, and the
   `cloudPullMerge` the merge tests already cover - here it is a counter, because
   this test is about WHEN the pull runs, not what it merges.

   Run: node test/livesync.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function makeEl(id) {
  const el = {
    id, value: '', textContent: '', checked: false, disabled: false,
    style: {}, dataset: {}, className: '', _html: '',
    tagName: 'DIV', isContentEditable: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, removeChild() {}, closest() { return null; },
    addEventListener() {}, focus() {}, click() {}, querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = String(v); }, configurable: true });
  return el;
}
const elements = {};
function el(id) { if (!elements[id]) elements[id] = makeEl(id); return elements[id]; }

global.window = { addEventListener() {}, print() {}, location: { reload() {} } };
global.location = { reload() {}, href: 'https://appleziarash1.github.io/texpark-pro/' };
global.document = {
  body: makeEl('body'), hidden: false, activeElement: makeEl('body'),
  getElementById: id => (id ? el(id) : null),
  querySelectorAll: () => [], createElement: () => makeEl('tmp'), addEventListener() {}
};
global.alert = () => {};
global.confirm = () => true;
global.setTimeout = () => 0;
global.clearTimeout = () => {};
global.URL = { createObjectURL: () => 'blob:x' };
global.Blob = function () {};
const fakeStore = {};
global.localStorage = {
  getItem: k => (k in fakeStore ? fakeStore[k] : null),
  setItem: (k, v) => { fakeStore[k] = String(v); },
  removeItem: k => { delete fakeStore[k]; }
};
global.fetch = () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve(''), headers: { get: () => null }, json: () => Promise.resolve({}) });

for (const f of ['db.js', 'sync.js', 'voice.js', 'courier.js', 'app.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, 'js', f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* ---- the seams ---- */
let configured = true, signedIn = true, pulls = 0;
global.cloudConfigured = () => configured;
global.fbSignedIn = () => signedIn;
global.cloudPullMerge = async () => { pulls++; return { merged: false }; };
session = { userId: 1, name: 'Owner', role: 'admin' };
cloudBusy = false;
cloudDirty = false;
document.hidden = false;

(async () => {
  ok(!html.includes('stLiveSyncMode') && !html.includes('Cloud update frequency'), 'the delay selector and its card are removed');
  console.log('\n--- live delta pull: fast lane, only when it is safe ---');

  pulls = 0; configured = false; signedIn = true;
  await liveDeltaPull_();
  eq(pulls, 0, 'not configured: no live pull');

  configured = true; signedIn = false;
  await liveDeltaPull_();
  eq(pulls, 0, 'not signed in to Firestore: no live pull');

  signedIn = true; session = null;
  await liveDeltaPull_();
  eq(pulls, 0, 'no app session: no live pull');

  session = { userId: 1 };
  cloudBusy = true;
  await liveDeltaPull_();
  eq(pulls, 0, 'a sync already in flight: no second pull');

  cloudBusy = false; cloudDirty = true;
  await liveDeltaPull_();
  eq(pulls, 0, 'this device has an unsent edit: wait');

  cloudDirty = false;
  await liveDeltaPull_();
  eq(pulls, 1, 'configured, signed in, idle: pulls the delta');

  /* Re-entrancy: a slow pull must not stack. */
  pulls = 0;
  let release;
  global.cloudPullMerge = () => new Promise(r => { release = () => { pulls++; r({}); }; });
  const a = liveDeltaPull_();
  const b = liveDeltaPull_();          // must be refused while the first is in flight
  release();
  await Promise.all([a, b]);
  eq(pulls, 1, 'a slow pull does not stack a second one');

  /* Restore a working pull for the count check. */
  global.cloudPullMerge = async () => { pulls++; return {}; };
  pulls = 0;
  await liveDeltaPull_();
  eq(pulls, 1, 'after the slow pull finishes, the fast lane works again');

  /* A failing pull must never throw out of the interval. */
  global.cloudPullMerge = async () => { throw new Error('offline'); };
  let threw = false;
  try { await liveDeltaPull_(); } catch (e) { threw = true; }
  ok(!threw, 'a failed live pull is swallowed, not thrown');

  /* Cadence follows the push stream: fast when the stream is down (poll is the only
     path), calm when it is up (push delivers), fast for a moment after a cold open. */
  console.log('\n--- adaptive cadence ---');
  delete global.fbRealtimeLive;
  eq(liveDelay_(), 2000, 'no push stream: poll fast at 2 s, the poll is the only path');
  global.fbRealtimeLive = () => true;      // stream healthy
  liveNoteActivity_();
  eq(liveDelay_(), 2000, 'recent activity with push up: still fast');
  liveLastActivityAt = Date.now() - 120000;
  liveBootAt = Date.now();
  eq(liveDelay_(), 2000, 'just after a cold open: fast, so the first pull lands quickly');
  liveBootAt = Date.now() - 60000;      // boot window has passed
  eq(liveDelay_(), 2000, 'push up and idle well past boot: 2 s safety pull');
  global.fbRealtimeLive = () => false;     // stream dropped
  eq(liveDelay_(), 2000, 'stream dropped: poll fast again so we stay live');

  db = { settings: { liveSyncMode: '1d' } };
  eq(liveSyncMode_(), 'live', 'an old saved one-day preference cannot disable live updates');
  eq(liveSyncIntervalMs_(), null, 'legacy saved intervals are ignored on this live-only build');
  eq(liveDelay_(), 2000, 'live mode keeps a 2 second fallback if push drops');

  /* Cloudflare's selector is a shop-wide setting delivered over its control socket. */
  db = { settings: {} };
  let startCalls = 0;
  global.commit = () => true;
  global.cfBackendOn = () => true;
  global.fbRealtimeStart = async () => { startCalls++; };
  liveSyncModeApply_('1d', '2026-01-01T00:00:00.000Z');
  eq(db.settings.liveSyncMode, 'live', 'the old remote one-day schedule is replaced locally with live');
  eq(liveDelay_(), 2000, 'a remote legacy schedule cannot delay this device');
  ok(startCalls > 0, 'the realtime WebSocket is started after adopting live mode');
  eq(liveSyncModeApply_('invalid'), false, 'an unknown remote mode is ignored');
  delete global.cfBackendOn;
  delete global.fbRealtimeStart;
  delete global.fbRealtimeLive;

  console.log('\n=================');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})();
