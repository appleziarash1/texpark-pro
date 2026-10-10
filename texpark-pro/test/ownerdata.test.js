/* The owner's own 1 October books, replayed exactly. He reported profit "ulta
   palta": his Products page carried the real buying prices, but the five memos he
   wrote that day had frozen cost 0 (the product had no cost yet when they were
   saved), so profit came out equal to the whole sale - ৳61,460 instead of ৳17,135.

   The customer names are replaced with letters here: this repo is public and the
   real ones are his customers' names, phones and addresses. Everything that
   decides the money - product, qty, rate, cost, delivery charge - is verbatim.

   Run: node test/ownerdata.test.js */

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
    addEventListener() {}, focus() {}, click() {}, select() {}, scrollIntoView() {},
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
global.setTimeout = fn => { fn(); return 0; };
global.clearTimeout = () => {};
global.URL = { createObjectURL: () => 'blob:x' };
global.Blob = function () {};
global.URLSearchParams = class { constructor(q) { this.q = String(q || ''); } get() { return null; } };
global.history = { replaceState() {} };
global.location = { origin: 'https://x', pathname: '/', search: '', hash: '', reload() {} };
const fakeStore = {};
global.localStorage = {
  getItem: k => (k in fakeStore ? fakeStore[k] : null),
  setItem: (k, v) => { fakeStore[k] = String(v); },
  removeItem: k => { delete fakeStore[k]; }
};

vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'db.js'), 'utf8'), { filename: 'db.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'sync.js'), 'utf8'), { filename: 'sync.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'voice.js'), 'utf8'), { filename: 'voice.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'courier.js'), 'utf8'), { filename: 'courier.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8'), { filename: 'app.js' });
vm.runInThisContext('boot();', { filename: 'boot' });
el('loginUser').value = 'admin';
el('loginPass').value = 'admin123';
doLogin();

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* ---- his Products page, 1 Oct: name, sku, category, unit, cost, rate, reorder ---- */
const CATALOG = [
  ['Kids 3pcs Set', 'K3S', 'Kids', 'pcs', 165, 220, 10],
  ['Kids Girls Sweater', 'KGS', 'Kids', 'pcs', 108, 145, 10],
  ['Baby Keepers', 'BK', 'Baby', 'pcs', 41, 55, 10],
  ['kids 2pcs set', '', 'General', 'pcs', 165, 275, 0],
  ['girls romper set', '', 'General', 'pcs', 185, 300, 0],
  ['Girls Denim Frock', '', 'General', 'pcs', 126, 165, 0],
  ['Kids Shirt', '', 'General', 'pcs', 152, 185, 0],
  ['Girls All Over Print Frock', 'sinsy', 'General', 'pcs', 125, 145, 0],
  ['Girls Fancy Sweater', 'C&A', 'General', 'pcs', 125, 145, 0],
  ['Boys 3pcs Set', 'kot', 'General', 'pcs', 325, 395, 0],
  ['Girls Romper Set', '', 'General', 'pcs', 185, 300, 0],
  ['Girls Set', 'snail', 'General', 'pcs', 85, 145, 0],
  ['Girls Denim Jacket', '', 'General', 'pcs', 175, 250, 0]
];

console.log('\n--- his 1 Oct products are entered (cost present) ---');
CATALOG.forEach(r => {
  db.products.push({
    id: id(), name: r[0], sku: r[1], category: r[2], unit: r[3],
    cost: r[4], rate: r[5], vat: 0, reorderLevel: r[6]
  });
});
eq(db.products.length, 3 + CATALOG.length, 'all 13 products are in the book');
const prod = n => db.products.find(p => p.name.toLowerCase() === n.toLowerCase());
ok(prod('Girls Denim Jacket').cost === 175, 'Girls Denim Jacket buying 175');

/* ---- his five memos, 1 Oct, as they were SAVED: line cost frozen at 0 ---- */
const MEMOS = [
  ['TXP/SM/2026/10/01-PC001', 'Customer A', 400, [['kids 2pcs set', 275, 12], ['girls romper set', 300, 40], ['Girls Denim Frock', 165, 10], ['Kids Shirt', 185, 30]]],
  ['TXP/SM/2026/10/01-PC002', 'Customer B', 200, [['Kids Shirt', 185, 20], ['kids 2pcs set', 275, 6]]],
  ['TXP/SM/2026/10/01-PC003', 'Customer C', 250, [['Girls All Over Print Frock', 145, 36], ['Girls Fancy Sweater', 145, 24]]],
  ['TXP/SM/2026/10/01-PC004', 'Customer D', 350, [['Boys 3pcs Set', 395, 30]]],
  ['TXP/SM/2026/10/01-PC005', 'Customer E', 250, [['Girls Denim Jacket', 250, 12], ['Girls Set', 145, 12], ['Girls Romper Set', 300, 15], ['Boys 3pcs Set', 395, 6]]]
];
MEMOS.forEach(m => {
  const items = m[3].map(x => ({
    productId: prod(x[0]).id, productName: prod(x[0]).name,
    qty: x[2], rate: x[1], cost: 0, vat: 0, amount: round2(x[2] * x[1])
  }));
  const fin = memoMath(items, { discount: 0, deliveryCharge: m[2], advance: 0 });
  db.memos.push(Object.assign({
    id: id(), memoNo: m[0], date: '2026-10-01', customerName: m[1],
    customerPhone: '', customerAddress: '', items,
    totalQty: items.reduce((a, x) => a + x.qty, 0), discount: 0,
    deliveryCharge: m[2], advance: 0, note: '', savedAt: '2026-10-01T00:00:00.000Z'
  }, fin));
  items.forEach(it => { const s = stockOf(it.productId); s.sold = num(s.sold) + num(it.qty); s.available = stockAvailable(s); });
});

console.log('\n--- the reported bug: profit comes out as the whole sale ---');
eq(db.memos.length, 5, 'five memos on the book');
eq(round2(db.memos.reduce((a, m) => a + num(m.profit), 0)), 61460, 'profit reads ৳61,460 (the number he complained about)');
eq(round2(db.memos.reduce((a, m) => a + num(m.cogs), 0)), 0, 'because COGS is 0 - no buying price on any line');
eq(plSummary('', '').grossProfit, 61460, 'the P&L gross profit is wrong by the same amount');

console.log('\n--- the dashboard now says so, with the real figure ---');
nav('dashboard');
ok(el('costWarn').innerHTML.includes('5 memo(s)'), 'dashboard banner counts the five memos');
ok(el('costWarn').innerHTML.includes('61,460'), 'banner shows what is being reported now');
ok(el('costWarn').innerHTML.includes('17,135'), 'banner shows what it should be');
ok(el('costWarn').innerHTML.includes('too high'), 'banner says the figure is too high, not too low');
eq(el('costWarn').style.display, '', 'banner is visible');

console.log('\n--- the Profit page carries the same warning ---');
nav('profit');
ok(el('costWarnProfit').innerHTML.includes('17,135'), 'profit page banner agrees');

console.log('\n--- the repair, per memo, against his own arithmetic ---');
const plan = planMemoCostRepair();
eq(plan.length, 5, 'all five memos need the fix');
const want = {
  'TXP/SM/2026/10/01-PC001': 7700,
  'TXP/SM/2026/10/01-PC002': 1520,
  'TXP/SM/2026/10/01-PC003': 1450,
  'TXP/SM/2026/10/01-PC004': 2450,
  'TXP/SM/2026/10/01-PC005': 4015
};
plan.forEach(r => eq(r.nowProfit, want[r.memoNo], r.memoNo + ' corrected profit'));

console.log('\n--- apply it, and the totals land on ৳17,135 ---');
const snapshotQty = db.memos.map(m => m.totalQty);
const snapshotDue = db.memos.map(m => m.due);
const snapshotStock = db.stock.map(s => [s.productId, num(s.opening), num(s.purchased), num(s.sold), num(s.available)]);
const n = applyMemoCostRepair();
eq(n, 5, 'five memos repaired');
eq(round2(db.memos.reduce((a, m) => a + num(m.profit), 0)), 17135, 'total profit is now ৳17,135');
eq(plSummary('', '').grossProfit, 17135, 'the P&L agrees');
eq(round2(db.memos.reduce((a, m) => a + num(m.cogs), 0)), 44325, 'COGS is now ৳44,325 (61,460 - 17,135)');

console.log('\n--- and nothing that is not profit moved ---');
eq(JSON.stringify(db.memos.map(m => m.totalQty)), JSON.stringify(snapshotQty), 'qty untouched');
eq(JSON.stringify(db.memos.map(m => m.due)), JSON.stringify(snapshotDue), 'due untouched');
eq(JSON.stringify(db.stock.map(s => [s.productId, num(s.opening), num(s.purchased), num(s.sold), num(s.available)])),
  JSON.stringify(snapshotStock), 'stock untouched');

console.log('\n--- the warning clears itself once the figures are right ---');
nav('dashboard');
eq(el('costWarn').style.display, 'none', 'dashboard banner gone');
ok(el('costWarn').innerHTML === '', 'and emptied');

console.log('\n--- pressing it twice does not move anything ---');
eq(applyMemoCostRepair(), 0, 'second run repairs nothing');
eq(round2(db.memos.reduce((a, m) => a + num(m.profit), 0)), 17135, 'total profit stays ৳17,135');

console.log('\n=== ownerdata: ' + pass + ' pass / ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
