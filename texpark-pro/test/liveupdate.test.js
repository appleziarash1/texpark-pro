/* Live update: a device reloads itself when a new release lands on the host, but
   only at a safe moment. Driven through the REAL app.js against a DOM shim; the
   only seam is `fetch`, which returns the ETag the host would.

   Run: node test/liveupdate.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

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

const triggers = { reload: 0, alert: [] };
global.window = { addEventListener() {}, print() {}, location: { reload() {} } };
global.location = { reload() { triggers.reload++; }, href: 'https://appleziarash1.github.io/texpark-pro/' };
global.document = {
  body: makeEl('body'), hidden: false, activeElement: makeEl('body'),
  getElementById: id => (id ? el(id) : null),
  querySelectorAll: () => [], createElement: () => makeEl('tmp'), addEventListener() {}
};
global.alert = m => { triggers.alert.push(String(m)); };
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

/* The one seam: what the host answers for the release ETag. */
let etag = '"etag-1"';
global.fetch = () => Promise.resolve({ headers: { get: k => (k === 'etag' ? etag : null) } });

for (const f of ['db.js', 'sync.js', 'voice.js', 'courier.js', 'app.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, 'js', f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

(async () => {
  console.log('\n--- live update: reload only for a new release, only when safe ---');

  /* Nothing stored yet: the first check records the tag and leaves the page alone. */
  localStorage.removeItem(LIVE_UPDATE_KEY);
  triggers.reload = 0;
  await applyLiveUpdate_();
  eq(liveUpdateTag_(), '"etag-1"', 'first run records the release tag');
  eq(triggers.reload, 0, 'first run does not reload');

  /* Same tag: nothing to do. */
  await applyLiveUpdate_();
  eq(triggers.reload, 0, 'same release does not reload');

  /* A new release with nothing in the way: reload, and remember the new tag so a
     stale ETag cannot make it reload forever. */
  etag = '"etag-2"';
  await applyLiveUpdate_();
  eq(triggers.reload, 1, 'a new release reloads a safe device');
  eq(liveUpdateTag_(), '"etag-2"', 'the new tag is recorded before reloading');
  await applyLiveUpdate_();
  eq(triggers.reload, 1, 'no reload loop after the tag is stored');

  /* Now the unsafe moments: each must hold the reload back AND keep the old tag,
     so the update is retried as soon as the moment passes. */
  etag = '"etag-3"';
  document.activeElement = makeEl('input'); document.activeElement.tagName = 'INPUT';
  await applyLiveUpdate_();
  eq(triggers.reload, 1, 'typing in a field holds the reload');
  eq(liveUpdateTag_(), '"etag-2"', 'a held reload does not consume the new tag');

  document.activeElement = makeEl('body');
  document.querySelectorAll = () => [makeEl('modal')];
  await applyLiveUpdate_();
  eq(triggers.reload, 1, 'an open modal holds the reload');

  document.querySelectorAll = () => [];
  currentPage = 'memo';
  await applyLiveUpdate_();
  eq(triggers.reload, 1, 'a half-written memo holds the reload');

  currentPage = 'dashboard';
  cloudDirty = true;
  await applyLiveUpdate_();
  eq(triggers.reload, 1, 'unsent cloud changes hold the reload');

  /* The moment passes: the same new release now reloads. */
  cloudDirty = false;
  await applyLiveUpdate_();
  eq(triggers.reload, 2, 'the pending release reloads once it is safe');
  eq(liveUpdateTag_(), '"etag-3"', 'the tag is recorded once it finally reloads');

  /* A hidden tab never reloads under the owner. */
  document.hidden = true; etag = '"etag-4"';
  await applyLiveUpdate_();
  eq(triggers.reload, 2, 'a hidden tab holds the reload');
  document.hidden = false;

  console.log('\n=================');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})();
