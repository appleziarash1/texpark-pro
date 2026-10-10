/* Old memos froze the buying price they were written with. Memos written while
   stockCost() returned a stale figure froze a wrong one, and correcting the product
   today does not reach back into them - so the owner's old memos still show the old
   profit. This suite pins the repair: it finds exactly the memos that are wrong,
   leaves the correct ones alone, is a no-op the second time, and never touches
   quantity, due or stock.
   Run: node test/repair.test.js */

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
  get() { return null; }
};
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

console.log('\n--- a product whose buying price is 100 ---');
nav('products');
el('pName').value = 'Pant';
el('pCost').value = '100';
el('pRate').value = '150';
addProduct();
const pant = db.products.find(p => p.name === 'Pant');

console.log('\n--- an OLD memo that froze the wrong buying price (100 instead of 120) ---');
/* This is what a memo written through the bug looks like: the line cost is stale,
   and cogs/profit were computed from that stale figure at save time. */
const oldMemo = {
  id: 'old1', memoNo: 'TXP/SM/2026/09/20-PC001', date: '2026-09-20', customerName: 'Karim',
  items: [{ productId: pant.id, productName: 'Pant', qty: 10, rate: 150, cost: 100, vat: 0, amount: 1500 }],
  totalQty: 10, subtotal: 1500, discount: 0, deliveryCharge: 0, vat: 0, grandTotal: 1500,
  advance: 0, due: 1500, cogs: 1000, profit: 500
};
db.memos.push(oldMemo);

console.log('\n--- and a memo that is already correct ---');
const goodMemo = {
  id: 'good1', memoNo: 'TXP/SM/2026/09/20-PC002', date: '2026-09-20', customerName: 'Rahim',
  items: [{ productId: pant.id, productName: 'Pant', qty: 2, rate: 150, cost: 120, vat: 0, amount: 300 }],
  totalQty: 2, subtotal: 300, discount: 0, deliveryCharge: 0, vat: 0, grandTotal: 300,
  advance: 0, due: 300, cogs: 240, profit: 60
};
db.memos.push(goodMemo);

console.log('\n--- he corrects the buying price to 120 ---');
nav('products');
editProduct(pant.id);
el('epCost').value = '120';
saveProductEdit();
eq(stockCost(pant.id), 120, 'stockCost is 120 now');

console.log('\n--- the preview finds the wrong memo, and only that one ---');
const plan = planMemoCostRepair();
eq(plan.length, 1, 'exactly one memo needs fixing');
eq(plan[0].memoNo, 'TXP/SM/2026/09/20-PC001', 'and it is the stale one');
eq(plan[0].wasCogs, 1000, 'its old COGS was 10 x 100');
eq(plan[0].nowCogs, 1200, 'the correct COGS is 10 x 120');
eq(plan[0].wasProfit, 500, 'its old profit was 500');
eq(plan[0].nowProfit, 300, 'the correct profit is 300');
eq(plan[0].items.length, 1, 'one line is rewritten');
eq(plan[0].items[0].was, 100, 'that line said 100');
eq(plan[0].items[0].now, 120, 'it should say 120');

console.log('\n--- applying it rewrites the memo, and nothing else ---');
const qtyBefore = num(oldMemo.totalQty);
const dueBefore = num(oldMemo.due);
const grandBefore = num(oldMemo.grandTotal);
const stockBefore = JSON.stringify(db.stock);
const n = applyMemoCostRepair();
eq(n, 1, 'one memo repaired');
eq(num(oldMemo.items[0].cost), 120, 'the line now carries 120');
eq(num(oldMemo.cogs), 1200, 'COGS recomputed');
eq(num(oldMemo.profit), 300, 'profit recomputed, not -500 and not 500');
ok(num(oldMemo.profit) >= 0, 'profit is not negative');
eq(num(oldMemo.totalQty), qtyBefore, 'qty untouched');
eq(num(oldMemo.due), dueBefore, 'due untouched - he still owes the same money');
eq(num(oldMemo.grandTotal), grandBefore, 'grand total untouched - the customer bill is unchanged');
eq(JSON.stringify(db.stock), stockBefore, 'stock untouched - cost does not move quantities');
eq(num(goodMemo.items[0].cost), 120, 'the already-correct memo still says 120');
eq(num(goodMemo.profit), 60, 'and its profit is unchanged');

console.log('\n--- running it again is a no-op ---');
eq(planMemoCostRepair().length, 0, 'nothing left to fix');
eq(applyMemoCostRepair(), 0, 'applying again changes nothing');
eq(num(oldMemo.profit), 300, 'profit is still 300, not double-corrected');

console.log('\n--- the dashboard and P&L now show the corrected figure ---');
nav('profit');
ok(el('profitStats').innerHTML.includes('360'), 'gross profit is 300 + 60 = 360');
ok(!el('profitStats').innerHTML.includes('-'), 'and it is not negative');

console.log('\n--- a product with no buying price is never used to rewrite a memo ---');
const orphan = { id: 'orph1', memoNo: 'TXP/SM/2026/09/20-PC003', date: '2026-09-20', customerName: 'X',
  items: [{ productId: 'ghost', productName: 'Deleted thing', qty: 1, rate: 50, cost: 30, vat: 0, amount: 50 }],
  totalQty: 1, subtotal: 50, discount: 0, deliveryCharge: 0, vat: 0, grandTotal: 50,
  advance: 0, due: 50, cogs: 30, profit: 20 };
db.memos.push(orphan);
eq(planMemoCostRepair().length, 0, 'a memo whose product was deleted is left alone');
eq(num(orphan.items[0].cost), 30, 'its cost is not zeroed or guessed');

console.log('\n--- a product priced at 0 does not wipe a real cost ---');
nav('products');
el('pName').value = 'Freebie';
el('pCost').value = '0';
el('pRate').value = '10';
addProduct();
const freebie = db.products.find(p => p.name === 'Freebie');
const zeroMemo = { id: 'z1', memoNo: 'TXP/SM/2026/09/20-PC004', date: '2026-09-20', customerName: 'Y',
  items: [{ productId: freebie.id, productName: 'Freebie', qty: 5, rate: 10, cost: 7, vat: 0, amount: 50 }],
  totalQty: 5, subtotal: 50, discount: 0, deliveryCharge: 0, vat: 0, grandTotal: 50,
  advance: 0, due: 50, cogs: 35, profit: 15 };
db.memos.push(zeroMemo);
eq(planMemoCostRepair().length, 0, 'a product with no buying price is skipped');
eq(num(zeroMemo.items[0].cost), 7, 'the memo keeps the cost it had');

console.log('\n=== repair: ' + pass + ' pass / ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
