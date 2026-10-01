/* The owner's own journey: he enters a buying price and a selling price, makes a
   memo, and reads the profit. Run: node test/journey.test.js */

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

console.log('\n--- the owner enters a product: buying 100, selling 150 ---');
nav('products');
el('pName').value = 'Pant';
el('pCost').value = '100';
el('pRate').value = '150';
addProduct();
const pant = db.products.find(p => p.name === 'Pant');
eq(pant.cost, 100, 'buying price stored on the product');
eq(pant.rate, 150, 'selling price stored on the product');

console.log('\n--- he opens the memo and picks that product ---');
nav('memo');
newMemo();
el('customerName').value = 'Karim';
addMemoLine();
memoPickProduct(0, pant.id);
eq(memoDraft.items[0].rate, 150, 'the memo line took the SELLING price as its rate');
eq(memoDraft.items[0].cost, 100, 'the memo line took the BUYING price as its cost');

console.log('\n--- he types qty 10 ---');
memoSet(0, 'qty', '10');
ok(el('memoAmount0').textContent.includes('1,500'), 'line amount = 10 x 150');
ok(el('memoSubtotal').textContent.includes('1,500'), 'subtotal 1500');
ok(el('memoCogs').textContent.includes('1,000'), 'COGS = 10 x 100');
ok(el('memoProfit').textContent.includes('500'), 'PROFIT SHOWS 500, not -500');
ok(!el('memoProfit').textContent.includes('-'), 'profit is not negative');
ok(el('memoMargin0').innerHTML.includes('500'), 'the line margin reads 500');

console.log('\n--- save, then read the history row ---');
saveMemo();
const m = db.memos[db.memos.length - 1];
eq(m.profit, 500, 'stored memo profit = 500');
eq(m.subtotal, 1500, 'stored subtotal = 1500');
eq(m.cogs, 1000, 'stored cogs = 1000');
nav('history');
renderHistory();
ok(el('historyTable').innerHTML.includes('৳500'), 'history shows ৳500 profit');
ok(!el('historyTable').innerHTML.includes('৳-500'), 'history does not show minus 500');

console.log('\n--- the Profit / Item report ---');
nav('profit');
renderProfit();
ok(el('profitTable').innerHTML.includes('৳1,500'), 'report shows 1500 sales');
ok(el('profitTable').innerHTML.includes('৳500'), 'report shows 500 profit');

console.log('\n--- Profit & Loss ---');
nav('pl');
renderPL();
ok(el('plStatement').innerHTML.includes('৳500'), 'P&L gross profit is 500');

console.log('\n--- the product list margin ---');
nav('products');
renderProducts();
ok(el('productTable').innerHTML.includes('৳50'), 'product margin = 150 - 100 = 50');

console.log('\n=== journey: ' + pass + ' pass / ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
