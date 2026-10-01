/* The buying price is stored twice: on the product, and on the stock card.
   stockCost() reads the card first, so a price typed on the Products page did
   nothing to profit until the card was rewritten too. The owner saw this as
   profit going the wrong way: he corrected the buying price and the margin
   stayed on the old number. Run: node test/cost.test.js */

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
    addEventListener() {}, focus() {}, click() {}, querySelector() { return makeEl('x'); },
    querySelectorAll() { return []; }
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
const triggers = { alert: [], confirm: true, prompt: '' };
global.window = { addEventListener() {}, print() {}, location: { reload() {} } };
global.document = {
  body: makeEl('body'),
  getElementById: id => (id ? el(id) : null),
  querySelectorAll: () => [], createElement: () => makeEl('tmp'), addEventListener() {}
};
global.alert = m => { triggers.alert.push(String(m)); };
global.confirm = () => triggers.confirm;
global.prompt = () => triggers.prompt;
global.setTimeout = fn => 0;
global.clearTimeout = () => {};
global.URL = { createObjectURL: () => 'blob:x' };
global.Blob = function () {};
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
vm.runInThisContext('boot();', { filename: 'boot' });

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + a + ', want ' + b + ')'); }

el('loginUser').value = 'admin';
el('loginPass').value = 'admin123';
doLogin();

console.log('\n--- a product is created with buying 100 ---');
nav('products');
el('pName').value = 'Pant';
el('pCost').value = '100';
el('pRate').value = '150';
addProduct();
const pant = db.products.find(p => p.name === 'Pant');

console.log('\n--- it is sold, which creates the stock card ---');
nav('memo');
newMemo();
el('customerName').value = 'Karim';
addMemoLine();
memoPickProduct(0, pant.id);
memoSet(0, 'qty', '1');
saveMemo();
const card = findStock(pant.id);
ok(!!card, 'stock card auto-created by the sale');
eq(card.cost, 100, 'card took the buying price');

console.log('\n--- THE BUG: he corrects the buying price to 120 ---');
nav('products');
editProduct(pant.id);
el('epCost').value = '120';
saveProductEdit();
eq(pant.cost, 120, 'product now says buying 120');
eq(stockCost(pant.id), 120, 'stockCost follows the correction - it used to stay 100');
eq(findStock(pant.id).cost, 120, 'the stock card was updated too');

console.log('\n--- the next memo uses the corrected buying price ---');
nav('memo');
newMemo();
el('customerName').value = 'Rahim';
addMemoLine();
memoPickProduct(0, pant.id);
memoSet(0, 'qty', '10');
eq(memoDraft.items[0].cost, 120, 'the new memo line picked up buying 120');
ok(el('memoProfit').textContent.includes('300'), 'profit = 1500 - 1200 = 300');
ok(!el('memoProfit').textContent.includes('-'), 'profit is not negative');

console.log('\n--- a selling price typed into Unit Cost no longer poisons profit forever ---');
/* The owner once typed 200 (the selling price) into the stock card\'s Unit Cost.
   Correcting the product must be able to undo that. */
findStock(pant.id).cost = 200;
nav('products');
editProduct(pant.id);
el('epCost').value = '100';
saveProductEdit();
eq(stockCost(pant.id), 100, 'the stale 200 is replaced by the corrected buying price');

console.log('\n--- clearing the buying price to 0 does not wipe the card ---');
editProduct(pant.id);
el('epCost').value = '0';
saveProductEdit();
eq(stockCost(pant.id), 100, 'a 0 does not erase a known cost');

console.log('\n--- products list margin reflects the correction ---');
nav('products');
renderProducts();
ok(el('productTable').innerHTML.includes('৳50'), 'margin = 150 - 100');

console.log('\n=== cost: ' + pass + ' pass / ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
