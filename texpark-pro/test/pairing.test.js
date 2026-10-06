/* The owner's PC held four memos and the phone showed a fresh, empty shop: three
   demo products at 0 and every figure ৳0. Nothing on screen said why, so he read it
   as the data being gone. It was not gone - the phone had never been told the sheet
   URL, and the URL is a per-device setting that a sync cannot deliver.

   This suite pins the three things that fix that:
     1. a fresh device really does render that exact empty dashboard (the reproduction)
     2. the dashboard says so out loud instead of staying silent
     3. a ?sync=<url> link configures the device in one tap, and is then dropped from
        the address bar so the sheet id is not left lying in the history
   Run: node test/pairing.test.js */

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
  Object.defineProperty(el, 'children', {
    get() { const m = String(this._html).match(/<tr>/g); return { length: m ? m.length : 0 }; }, configurable: true
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
global.setTimeout = fn => 0;
global.clearTimeout = () => {};
global.URL = { createObjectURL: () => 'blob:x' };
global.Blob = function () {};
global.URLSearchParams = class {
  constructor(q) { this.q = String(q || ''); }
  get(k) {
    const m = new RegExp('[?&]' + k + '=([^&]*)').exec(this.q);
    return m ? decodeURIComponent(m[1]) : null;
  }
};
const replaced = [];
global.history = { replaceState(a, b, url) { replaced.push(url); } };

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

const SHEET = 'https://script.google.com/macros/s/AKfycb_REAL/exec';

console.log('\n--- 1. the reproduction: a device that was never paired ---');
global.location = { origin: 'https://appleziarash1.github.io', pathname: '/texpark-pro/', search: '', hash: '', reload() {} };
vm.runInThisContext('boot();', { filename: 'boot' });
el('loginUser').value = 'admin';
el('loginPass').value = 'admin123';
doLogin();
nav('dashboard');
eq(db.settings.syncUrl, '', 'sync URL is empty - this device was never told where the sheet is');
eq(syncUrl(), '', 'so sync is off');
eq(el('kTodaySales').textContent, '\u09F30', 'Today Sales reads ৳0, exactly as the owner saw');
eq(el('kMonthSales').textContent, '\u09F30', 'This Month Sales reads ৳0');
eq(el('kStockValue').textContent, '\u09F30', 'Stock Value reads ৳0');
eq(db.memos.length, 0, 'no memos - the phone never had the PC work');
eq(db.products.length, 3, 'only the three demo products exist');
ok(db.products.every(p => String(p.id).startsWith('seed-')), 'and they are all seed rows, not his data');
ok(el('dashMemos').innerHTML.includes('No memos yet'), 'the dashboard says "No memos yet"');
ok(el('dashLow').innerHTML.includes('Kids 3pcs Set') && el('dashLow').innerHTML.includes('0 left'),
  'and lists the demo products at 0 left');

console.log('\n--- 2. the dashboard says why, instead of staying silent ---');
ok(el('syncWarn').style.display !== 'none', 'the sync warning is visible');
ok(el('syncWarn').innerHTML.includes('Sync is off'), 'it says sync is off');
ok(el('syncWarn').innerHTML.includes('other devices'), 'it explains other devices will not show up');
ok(el('syncWarn').innerHTML.includes('demo product'), 'and that what is on screen is only the demo data');
ok(el('syncWarn').innerHTML.includes('Settings'), 'it points at Settings');
eq(el('syncBadge').textContent, 'Sync off', 'the badge agrees');

console.log('\n--- 3. a device with real data is told its work has not left ---');
db.memos.push({ id: 'm1', memoNo: 'TXP/SM/2026/09/21-PC001', date: today(), customerName: 'Karim',
  items: [], totalQty: 0, subtotal: 0, discount: 0, deliveryCharge: 0, vat: 0, grandTotal: 0,
  advance: 0, due: 0, cogs: 0, profit: 0 });
nav('dashboard');
ok(el('syncWarn').innerHTML.includes('1'), 'it counts his own records');
ok(el('syncWarn').innerHTML.includes('reached the sheet'), 'and warns they are not uploaded yet');

console.log('\n--- 4. the pairing link: one tap on the phone ---');
const link = 'https://appleziarash1.github.io/texpark-pro/?sync=' + encodeURIComponent(SHEET);
global.location = { origin: 'https://appleziarash1.github.io', pathname: '/texpark-pro/',
  search: '?sync=' + encodeURIComponent(SHEET), hash: '', reload() {} };
const adopted = adoptSyncFromLink();
ok(adopted, 'the link is adopted');
eq(db.settings.syncUrl, SHEET, 'the phone now knows the sheet URL');
eq(syncUrl(), SHEET, 'so sync is on');
ok(replaced.length && !replaced[replaced.length - 1].includes('sync='),
  'the address bar was cleaned, so the sheet id is not left in the history');
ok(replaced[replaced.length - 1].includes('/texpark-pro/'), 'and it still points at the app');

console.log('\n--- 5. the warning goes away once paired ---');
nav('dashboard');
eq(el('syncWarn').style.display, 'none', 'no warning once sync is configured');
ok(!el('syncWarn').innerHTML.includes('Sync is off'), 'and nothing is left in it');

console.log('\n--- 6. a junk link must not be accepted ---');
global.location = { origin: 'https://x', pathname: '/', search: '?sync=' + encodeURIComponent('https://evil.example.com/steal'), hash: '', reload() {} };
const before = db.settings.syncUrl;
ok(!adoptSyncFromLink(), 'a non-Apps-Script URL is refused');
eq(db.settings.syncUrl, before, 'and the real setting is untouched');
global.location = { origin: 'https://x', pathname: '/', search: '?sync=' + encodeURIComponent('http://script.google.com/macros/s/X/exec'), hash: '', reload() {} };
ok(!adoptSyncFromLink(), 'plain http is refused too, so the sheet id cannot be sniffed');
eq(db.settings.syncUrl, before, 'setting still untouched');

console.log('\n--- 7. re-opening the same link is a no-op ---');
global.location = { origin: 'https://x', pathname: '/', search: '?sync=' + encodeURIComponent(before), hash: '', reload() {} };
ok(!adoptSyncFromLink(), 'the same URL is not written again');
eq(db.settings.syncUrl, before, 'setting unchanged');

console.log('\n=== pairing: ' + pass + ' pass / ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
