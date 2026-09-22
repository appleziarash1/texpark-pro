/* End-to-end test: drives the REAL app.js against a DOM shim.
   Verifies the actual user journey, not just the data layer.
   Run: node test/e2e.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

/* ---------------- minimal DOM ---------------- */
function makeEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
    style: {}, dataset: {}, className: '',
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
  return el;
}

const elements = {};
function el(id) { if (!elements[id]) elements[id] = makeEl(id); return elements[id]; }

/* capture clicks/JS the app trigger */
const triggers = { alert: [], confirm: true, prompt: '' };

global.window = {
  addEventListener() {}, print() {}, location: { reload() {} }
};
global.document = {
  getElementById: id => (id ? el(id) : null),
  querySelectorAll: () => [],
  createElement: () => makeEl('tmp'),
  addEventListener() {}
};
global.alert = m => { triggers.alert.push(String(m)); };
global.confirm = () => triggers.confirm;
global.prompt = () => triggers.prompt;
global.setTimeout = fn => { /* don't run timers during the test */ return 0; };
global.clearTimeout = () => {};
global.URL = { createObjectURL: () => 'blob:x' };
global.Blob = function () {};

const fakeStore = {};
global.localStorage = {
  getItem: k => (k in fakeStore ? fakeStore[k] : null),
  setItem: (k, v) => { fakeStore[k] = String(v); },
  removeItem: k => { delete fakeStore[k]; }
};

/* Load the real app source into this global scope. */
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'db.js'), 'utf8'), { filename: 'db.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'sync.js'), 'utf8'), { filename: 'sync.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8'), { filename: 'app.js' });

/* app.js waits for DOMContentLoaded to boot; the shim never fires it, so boot here
   exactly as the page would. */
vm.runInThisContext('boot();', { filename: 'boot' });


let pass = 0, fail = 0;
const failures = [];
function ok(c, l) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; failures.push(l); console.log('  FAIL  ' + l); }
}
function eq(a, b, l) { ok(a === b, l + '  (got ' + a + ', want ' + b + ')'); }

console.log('\n=== REAL APP end-to-end (app.js) ===');

console.log('\n--- login through the real login form ---');
ok(!!db, 'db loaded');
ok(db.users.length >= 1, 'default users seeded');

el('loginUser').value = 'admin';
el('loginPass').value = 'wrong';
doLogin();
ok(el('loginErr').textContent.length > 0, 'wrong password rejected by the real doLogin');
ok(session === null, 'no session created for a wrong password');

el('loginPass').value = 'admin123';
doLogin();
ok(!!session && session.role === 'admin', 'admin/admin123 logs in through the real doLogin');
eq(el('loginScreen').style.display, 'none', 'login screen hidden');
eq(el('appRoot').style.display, '', 'app shell shown');
eq(el('whoName').textContent, 'Administrator', 'top bar shows the logged-in user');

console.log('\n--- role restrictions ---');
session = { userId: 'x', username: 's', name: 'Sales', role: 'salesman' };
buildNav();
ok(!el('side').innerHTML.includes('Users'), 'salesman cannot see Users');
ok(!el('side').innerHTML.includes('Purchases'), 'salesman cannot see Purchases');
ok(el('side').innerHTML.includes('New Sales Memo'), 'salesman keeps the memo page');
session = { userId: db.users[0].id, username: 'admin', name: 'Administrator', role: 'admin' };
buildNav();

console.log('\n--- regression: dropdowns are filled on DIRECT page entry ---');
/* A user can land straight on Stock without ever visiting Products. */
nav('stock');
ok(el('stockProduct').innerHTML.includes('Kids 3pcs Set'),
  'Stock page product picker is filled even if Products was never opened');
eq(el('stockProduct').innerHTML.split('<option').length - 1, db.products.length + 1,
  'one option per product plus the placeholder');

console.log('\n--- add a product with a known cost ---');
nav('products');
el('pName').value = 'Test Widget';
el('pSku').value = 'TW-1';
el('pCategory').value = 'Test';
el('pUnit').value = 'pcs';
el('pCost').value = '100';
el('pRate').value = '150';
el('pVat').value = '0';
el('pReorder').value = '5';
addProduct();
const widget = db.products.find(p => p.name === 'Test Widget');
ok(!!widget, 'product created');
eq(widget.cost, 100, 'cost price stored');
eq(widget.rate, 150, 'sell rate stored');

console.log('\n--- THE RULE: memo saves even with no stock entered ---');
eq(findStock(widget.id), null, 'widget has no stock card yet');
nav('memo');
newMemo();
el('memoDate').value = today();
el('customerName').value = 'Rahim Traders';
addMemoLine();
memoDraft.items = [{ productId: widget.id, qty: 10, rate: 150, cost: 100, vat: 0, amount: 1500 }];
renderMemoLines();
calcMemo();
ok(el('memoStockWarn').innerHTML.includes('stock ekhono tola hoy ni'),
  'reminder shown that stock was not entered yet');
ok(!el('memoStockWarn').innerHTML.includes('save hobe na'), 'the message does not threaten to block');
eq(el('memoSaveBtn').disabled, false, 'save button is ENABLED, not disabled');

triggers.alert.length = 0;
saveMemo();
eq(db.memos.length, 1, 'MEMO WAS SAVED with 0 stock - the memo is the source of truth');
ok(!triggers.alert.some(a => a.includes('save kora holo na')), 'nothing told the user the memo failed');

const autoCard = findStock(widget.id);
ok(!!autoCard, 'THE STOCK CARD WAS AUTO-CREATED from the memo');
eq(autoCard.opening, 0, 'auto card starts with 0 received - user still tops it up later');
eq(autoCard.sold, 10, 'the memo qty landed in sold');
eq(autoCard.available, -10, 'available shows the honest shortfall until stock is entered');
ok(db.ledger.some(l => l.type === 'AutoAdd' && l.productId === widget.id),
  'auto-creation is traceable in the stock ledger');

console.log('\n--- top up received stock later; the shortfall closes ---');
nav('stock');
ok(el('stockProduct').innerHTML.includes('Test Widget'), 'auto-created product is in the stock picker');
el('stockProduct').value = widget.id;
el('stockAddQty').value = '50';
el('stockCost').value = '100';
addStockPurchase();
eq(findStock(widget.id).available, 40, 'received 50 closes the -10 gap to +40');
const ledgerAtTopUp = db.ledger.length;   // everything after this point already has stock

console.log('\n--- an already-carded product is not duplicated ---');
const cardsBefore = db.stock.filter(s => s.productId === widget.id).length;
ensureStockCard(widget.id);
ensureStockCard(widget.id);
eq(db.stock.filter(s => s.productId === widget.id).length, cardsBefore, 'still exactly one stock card');

console.log('\n--- second memo on the same product, charges applied ---');
nav('memo');
newMemo();
el('memoDate').value = today();
el('customerName').value = 'Rahim Traders';
el('memoDiscount').value = '100';
el('memoDeliveryCharge').value = '200';
el('memoAdvance').value = '500';
memoDraft.items = [{ productId: widget.id, qty: 10, rate: 150, cost: 100, vat: 0, amount: 1500 }];
renderMemoLines();
calcMemo();
eq(el('memoSaveBtn').disabled, false, 'save button enabled');
saveMemo();
eq(db.memos.length, 2, 'second memo saved - no new stock card needed');

const memo = db.memos[1];   // the memo that carries the charges
ok(/TXP\/SM\//.test(memo.memoNo), 'memo number uses the company prefix');
eq(memo.subtotal, 1500, 'subtotal = 10 x 150');
eq(memo.cogs, 1000, 'cogs = 10 x 100');
eq(memo.grandTotal, 1600, 'grand = 1500 - 100 + 200');
eq(memo.due, 1100, 'due = 1600 - 500');
eq(memo.profit, 600, 'profit = 1500 - 100 + 200 delivery - 1000');
eq(memo.items[0].cost, 100, 'memo stored the unit cost for future reporting');

const st = findStock(widget.id);
eq(st.sold, 20, 'sold = 10 from each of the two memos');
eq(st.available, 30, 'available = 50 received - 20 sold');
ok(st.available >= 0, 'stock stayed sane once received stock was entered');

console.log('\n--- customer auto-created + appears in ledger ---');
ok(db.customers.some(c => c.name === 'Rahim Traders'), 'customer auto-created from memo');
nav('ledger');
renderCustomerLedger();
ok(el('ledgerTable').innerHTML.includes('Rahim Traders'), 'customer shows in ledger');

console.log('\n--- history shows profit ---');
nav('history');
renderHistory();
ok(el('historyTable').innerHTML.includes(memo.memoNo), 'memo listed in history');
ok(/৳600/.test(el('historyTable').innerHTML), 'profit column rendered');

console.log('\n--- editing a memo updates only its own stock effect ---');
const firstMemo = db.memos.find(m => m.memoNo !== memo.memoNo);
editMemo(firstMemo.id);
memoDraft.items = [{ productId: widget.id, qty: 6, rate: 150, cost: 100, vat: 0, amount: 900 }];
renderMemoLines();
saveMemo();
eq(db.memos.length, 2, 'edit did not create a third memo');
eq(db.memos.find(m => m.id === firstMemo.id).items[0].qty, 6, 'quantity updated to 6');
const st2 = findStock(widget.id);
eq(st2.sold, 16, 'sold = 6 (edited) + 10 (untouched memo)');
eq(st2.available, 34, 'available = 50 - 16');

console.log('\n--- deleting that memo restores only its own effect ---');
triggers.confirm = true;
deleteMemo(firstMemo.id);
eq(db.memos.length, 1, 'memo deleted');
const st3 = findStock(widget.id);
eq(st3.sold, 10, 'sold back to the remaining memo only');
eq(st3.available, 40, 'available = 50 - 10');

console.log('\n--- deleting the last memo keeps received stock ---');
deleteMemo(db.memos[0].id);
eq(db.memos.length, 0, 'all memos deleted');
const st4 = findStock(widget.id);
eq(st4.sold, 0, 'sold back to 0');
eq(st4.available, 50, 'received 50 still there - deleting a sale does not erase what you received');

console.log('\n--- purchase flow updates stock and cost ---');
nav('supplier');
el('sName').value = 'Dhaka Suppliers';
el('sContact').value = 'Mr. Rahman';
el('sPhone').value = '01711111111';
el('sAddress').value = 'Dhaka';
addSupplier();
eq(db.suppliers.length, 1, 'supplier created');
const sup = db.suppliers[0];

nav('purchase');
purchaseDraft = { items: [] };
el('puDate').value = today();
el('puSupplier').value = sup.id;
el('puPaid').value = '500';
purchaseDraft.items = [{ productId: widget.id, qty: 10, cost: 120, amount: 1200 }];
renderPurchaseLines();
calcPurchase();
savePurchase();
eq(db.purchases.length, 1, 'purchase saved');
eq(db.purchases[0].subtotal, 1200, 'purchase subtotal');
eq(db.purchases[0].due, 700, 'due = 1200 - 500');
eq(db.purchases[0].status, 'Partial', 'partial payment status');
const st5 = findStock(widget.id);
eq(st5.purchased, 10, 'purchased qty increased');
eq(st5.available, 60, 'available = 50 + 10');
ok(stockCost(widget.id) > 100 && stockCost(widget.id) < 120,
  'weighted cost moved toward the new buy price (' + stockCost(widget.id) + ')');

console.log('\n--- expense + P&L ---');
nav('expense');
el('exDate').value = today();
el('exHead').value = 'Rent';
el('exAmount').value = '5000';
el('exNote').value = 'Office rent';
addExpense();
eq(db.expenses.length, 1, 'expense saved');

nav('memo');
newMemo();
el('memoDate').value = today();
el('customerName').value = 'Karim Store';
memoDraft.items = [{ productId: widget.id, qty: 5, rate: 150, cost: 100, vat: 0, amount: 750 }];
renderMemoLines();
saveMemo();
eq(db.memos.length, 1, 'sale memo saved for the P&L to pick up');

nav('pl');
el('plFrom').value = '';
el('plTo').value = '';
renderPL();
ok(el('plStats').innerHTML.includes('Sales'), 'P&L sees sales');
ok(el('plStats').innerHTML.includes('COGS'), 'P&L sees COGS');
ok(el('plStats').innerHTML.includes('Expenses'), 'P&L sees expenses');
ok(el('plStatement').innerHTML.includes('Net Profit'), 'P&L statement rendered');

console.log('\n--- profit report by item ---');
nav('profit');
el('prFrom').value = '';
el('prTo').value = '';
renderProfit();
ok(el('profitTable').innerHTML.includes('Test Widget'), 'item-level profit report lists the product');
ok(el('profitStats').innerHTML.includes('COGS'), 'profit stats include COGS');

console.log('\n--- stock ledger audit trail ---');
nav('stocklog');
renderStockLog();
ok(el('stockLogTable').innerHTML.includes('Test Widget'), 'stock movements listed');
ok(db.ledger.some(l => l.type === 'Purchase'), 'purchase recorded in stock ledger');
ok(db.ledger.some(l => l.type === 'Sale'), 'sale recorded in stock ledger');
ok(db.ledger.some(l => l.type === 'Opening'), 'opening stock recorded');
ok(db.ledger.some(l => l.type === 'AutoAdd'), 'auto-created stock card recorded in the ledger');
eq(db.ledger.slice(ledgerAtTopUp).filter(l => l.productId === widget.id).some(l => l.balance < 0), false,
  'once received stock is entered, no later movement pushes the balance negative');
ok(db.memos.every(m => m.items.every(i => num(i.qty) > 0)), 'every saved memo line has a positive qty');
ok(db.stock.every(s => num(s.sold) >= 0 && num(s.opening) >= 0),
  'sold and received counters never go negative themselves');

console.log('\n--- stock card edit cannot erase real sales ---');
nav('stock');
openStockEdit(widget.id);
el('seOpening').value = '50';
el('sePurchased').value = '10';
el('seSold').value = '1';
triggers.alert.length = 0;
saveStockEdit();
eq(findStock(widget.id).sold, 5, 'sold qty left alone - real memos sold 5');
ok(triggers.alert.some(a => a.includes('kome hote pare na')),
  'user warned they cannot lower sold below real sales');

console.log('\n--- delivery ---');
nav('delivery');
openDelivery(db.memos[0].id);
el('dlQty').value = '2';
el('dlDriver').value = 'Jamal';
el('dlVehicle').value = 'DHAKA-TA-11-2233';
el('dlReceiver').value = 'Karim';
saveDelivery();
eq(db.deliveries.length, 1, 'delivery recorded');
eq(db.deliveries[0].status, 'Partial', 'partial delivery status');
openDelivery(db.memos[0].id);
eq(String(el('dlQty').value), '3', 'the form pre-fills the pending qty');
saveDelivery();
eq(db.deliveries[db.deliveries.length - 1].status, 'Delivered', 'full delivery status once the whole memo is delivered');

console.log('\n--- payment receive ---');
nav('customers');
const cust = db.customers.find(c => c.name === 'Karim Store');
ok(!!cust, 'customer exists');
openPayment(cust.id);
el('payAmount').value = '300';
el('payMethod').value = 'bKash';
savePayment();
eq(db.payments.length, 1, 'payment recorded');
eq(db.payments[0].method, 'bKash', 'payment method stored');

console.log('\n--- sync queue is real, not fake-success ---');
db.settings.syncUrl = '';
saveSyncUrl();
eq(syncCounts().pending, 0, 'nothing queued when sync URL is empty');
db.settings.syncUrl = 'https://script.google.com/macros/s/FAKE/exec';
syncPush('sale', { memoNo: 'X' }, 'test job');
eq(syncCounts().pending, 1, 'job queued when sync URL is set');
eq(syncQueue[0].state, 'pending', 'queued as pending, not claimed as sent');
ok(el('syncBadge').textContent.length > 0, 'sync badge renders a status');

console.log('\n--- print sheet renders the company + totals ---');
const sheet = memoSheet(db.memos[0]);
ok(sheet.includes('TEX') && sheet.includes('PARK'), 'memo sheet has the company name');
ok(sheet.includes(db.memos[0].memoNo), 'memo sheet has the memo number');
ok(/Amount in Words/i.test(sheet), 'memo sheet has the amount in words');
ok(!/undefined|NaN/.test(sheet), 'memo sheet has no undefined/NaN');

console.log('\n--- every page renders without throwing ---');
let renderErr = '';
try {
  ['dashboard', 'memo', 'history', 'delivery', 'customers', 'ledger', 'purchase', 'supplier',
    'products', 'stock', 'stocklog', 'profit', 'pl', 'expense', 'ledgerreport', 'users',
    'settings', 'backup'].forEach(id => nav(id));
} catch (e) { renderErr = e.message; }
eq(renderErr, '', 'all pages rendered cleanly');

console.log('\n--- data survives a reload ---');
eq(db.memos.length, 1, 'memos persisted');
eq(db.products.length, 4, 'products persisted');
ok(!!fakeStore['texpark_pro_v2'], 'data stored under the v2 key');
ok(!fakeStore['texpark_biz_v1'], 'old v1 key not mixed in');
eq(loadDB().memos.length, 1, 'reload reads the same memos back');

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
console.log('=================');
if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(' - ' + f)); }
process.exit(fail ? 1 : 0);
