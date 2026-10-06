/* The owner complained that a plain page reload signed him out. The session lived
   only in memory (var session = null), so every reload - and the service worker's
   own reload after a deploy - dropped him back to the login screen. This suite
   pins the fix: the session is persisted and restored on boot, and only cleared by
   an explicit sign-out or a password change.
   Run: node test/session.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

function makeEl(id) {
  const el = {
    id, value: '', textContent: '', checked: false, disabled: false,
    style: {}, dataset: {}, className: '', _html: '', _writes: 0,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    appendChild() {}, removeChild() {}, closest() { return null; },
    addEventListener() {}, focus() {}, click() {}, select() {},
    querySelector() { return makeEl('x'); }, querySelectorAll() { return []; }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; }, set(v) { this._html = String(v); this._writes++; }, configurable: true
  });
  return el;
}
const elements = {};
function el(id) { if (!elements[id]) elements[id] = makeEl(id); return elements[id]; }
const triggers = { alert: [], confirm: true };
global.window = { addEventListener() {}, print() {}, location: { reload() {} } };
global.document = {
  body: makeEl('body'),
  getElementById: id => (id ? el(id) : null),
  querySelectorAll: () => [], createElement: () => makeEl('tmp'), addEventListener() {}
};
global.alert = m => { triggers.alert.push(String(m)); };
global.confirm = () => triggers.confirm;
global.prompt = () => '';
global.setTimeout = () => 0;
global.clearTimeout = () => {};
global.URL = { createObjectURL: () => 'blob:x' };
global.Blob = function () {};
global.history = { replaceState() {} };
global.location = { origin: 'https://appleziarash1.github.io', pathname: '/texpark-pro/', search: '', hash: '', reload() {} };

const fakeStore = {};
global.localStorage = {
  getItem: k => (k in fakeStore ? fakeStore[k] : null),
  setItem: (k, v) => { fakeStore[k] = String(v); },
  removeItem: k => { delete fakeStore[k]; }
};

vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'db.js'), 'utf8'), { filename: 'db.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'sync.js'), 'utf8'), { filename: 'sync.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'voice.js'), 'utf8'), { filename: 'voice.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8'), { filename: 'app.js' });

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

console.log('\n--- a fresh device starts signed out ---');
vm.runInThisContext('boot();', { filename: 'boot' });
eq(session, null, 'no session before anyone signs in');
eq(el('loginScreen').style.display, 'flex', 'the login screen is shown');

console.log('\n--- signing in persists the session ---');
el('loginUser').value = 'admin';
el('loginPass').value = 'admin123';
doLogin();
ok(!!session && session.username === 'admin', 'signed in');
eq(el('loginScreen').style.display, 'none', 'the login screen is hidden');
ok(!!fakeStore.texpark_pro_session, 'the session was written to storage');

console.log('\n--- the reload that used to sign the owner out ---');
/* This is the exact regression: re-run boot() as a page reload would, with the
   same localStorage still in place. */
session = null;
vm.runInThisContext('boot();', { filename: 'boot' });
ok(!!session && session.username === 'admin', 'still signed in after a reload');
eq(el('loginScreen').style.display, 'none', 'the login screen did NOT come back');
eq(el('appRoot').style.display, '', 'the app shell is shown');
eq(currentPage, 'dashboard', 'and it lands on the dashboard, as a login would');

console.log('\n--- signing out clears it, and it stays cleared ---');
doLogout();
eq(session, null, 'signed out');
eq(fakeStore.texpark_pro_session, undefined, 'the stored session was removed');
vm.runInThisContext('boot();', { filename: 'boot' });
eq(session, null, 'a reload after sign-out does not sign back in');
eq(el('loginScreen').style.display, 'flex', 'the login screen is shown again');

console.log('\n--- changing the password signs out devices still holding the old hash ---');
el('loginUser').value = 'admin';
el('loginPass').value = 'admin123';
doLogin();
ok(!!fakeStore.texpark_pro_session, 'signed in again');
/* Change the stored password hash, as Change-my-password would, then reload. */
db.users[0].pass = hash('a-new-password');
localStorage.setItem(KEY, JSON.stringify(db));   // as Change-my-password persists it
session = null;
vm.runInThisContext('boot();', { filename: 'boot' });
eq(session, null, 'the stale session is refused after a password change');
eq(el('loginScreen').style.display, 'flex', 'so the login screen is shown');
eq(fakeStore.texpark_pro_session, undefined, 'and the dead session is cleared from storage');

console.log('\n--- a disabled user is not restored ---');
el('loginUser').value = 'admin';
el('loginPass').value = 'a-new-password';
doLogin();
ok(!!session, 'signed in with the new password');
db.users[0].active = false;
localStorage.setItem(KEY, JSON.stringify(db));
session = null;
vm.runInThisContext('boot();', { filename: 'boot' });
eq(session, null, 'a deactivated user is not restored');

console.log('\n--- changing your own password keeps you signed in ---');
/* The session stores the password hash as its version stamp, so Change-my-password
   has to rewrite it. Otherwise the owner would be signed out by the very next
   reload, which is the bug this suite exists for, one step removed. */
db.users[0].active = true;                 // the previous block deactivated it
localStorage.setItem(KEY, JSON.stringify(db));
el('loginUser').value = 'admin';
el('loginPass').value = 'a-new-password';  // the password set by the earlier block
doLogin();
ok(!!session, 'signed in as admin');
el('myOldPass').value = 'a-new-password';
el('myNewPass').value = 'brand-new-pass';
changeMyPass();
ok(!!session && session.username === 'admin', 'still signed in right after the change');
eq(db.users[0].pass, hash('brand-new-pass'), 'the new password was stored');
session = null;
vm.runInThisContext('boot();', { filename: 'boot' });
ok(!!session && session.username === 'admin', 'still signed in after a reload');
eq(el('loginScreen').style.display, 'none', 'the login screen did NOT come back');
/* and the new password is what actually signs in */
doLogout();
el('loginUser').value = 'admin';
el('loginPass').value = 'brand-new-pass';
doLogin();
ok(!!session, 'the new password signs in');

console.log('\n=================');
console.log('session: ' + pass + ' pass / ' + fail + ' fail');
console.log('=================');
if (fail) process.exit(1);
