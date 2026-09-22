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

vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'db.js'), 'utf8'), { filename: 'db.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'sync.js'), 'utf8'), { filename: 'sync.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8'), { filename: 'app.js' });

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + a + ', want ' + b + ')'); }

/* ---------------- the journey ---------------- */
console.log('\n=== REAL APP end-to-end (app.js) ===');

console.log('\n--- boot + login ---');
boot();
eq(elements['loginScreen'].style.display, 'flex', 'login screen shown at boot');

el('loginUser').value = 'admin';
el('loginPass').value = 'wrongpass';
doLogin();
ok(elements['loginErr'].textContent.length > 0, 'wrong password is rejected with a message');

el('loginPass').value = 'admin123';
doLogin();
eq(elements['loginScreen'].style.display, 'none', 'correct password hides login');
eq(elements['appRoot'].style.display, '', 'app shell becomes visible');
ok(session && session.role === 'admin', 'session created as admin');
ok(elements['side'].innerHTML.includes('Dashboard'), 'nav built for admin');
ok(elements['side'].innerHTML.includes('Profit / Item'), 'admin sees the profit page');
ok(elements['side'].innerHTML.includes('Users &amp; Roles') || elements['side'].innerHTML.includes('Users & Roles'), 'admin sees users page');

console.log('\n--- role restrictions ---');
session = { userId: 'x', username: 's', name: 'Sales', role: 'salesman' };
buildNav();
ok(!elements['side'].innerHTML.includes('Users & Roles'), 'salesman cannot see Users page');
ok(!elements['side'].innerHTML.includes('Purchases'), 'salesman cannot see Purchases');
ok(elements['side'].innerHTML.includes('New Sales Memo'), 'salesman can see memo page');
ok(can('memo') && !can('users'), 'can() enforces the role');
session = { userId: db.users[0].id, username: 'admin', name: 'Administrator', role: 'admin' };
buildNav();

console.log('\n--- regression: dropdowns are filled on DIRECT page entry ---');
// A user can land straight on Stock without ever visiting Products.
nav('stock');
ok(elements['stockProduct'].innerHTML.includes('Kids 3pcs Set'),
  'Stock page product picker is filled even if Products was never opened');
ok(!/only|<option value="">- select product -<\/option>$/.test(elements['stockProduct'].innerHTML.trim()),
  'picker has real options, not just the placeholder');
fillStockProductSelect();
eq(elements['stockProduct'].innerHTML.indexOf('<option'), 0, 'picker rebuild starts with the placeholder');
ok(elements['stockProduct'].innerHTML.split('<option').length - 1 === db.products.length + 1,
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

console.log('\n--- THE FIX: memo is refused while stock is 0 ---');
nav('memo');
newMemo();
el('memoDate').value = today();
el('customerName').value = 'Rahim Traders';
addMemoLine();                       // adds a 4th blank row
memoDraft.items = [{ productId: widget.id, qty: 10, rate: 150, cost: 100, vat: 0, amount: 1500 }];
renderMemoLines();
calcMemo();
ok(el('memoStockWarn').innerHTML.includes('Stock japt nei'), 'shortage warning shown on screen');
eq(el('memoSaveBtn').disabled, true, 'save button disabled while short');

triggers.alert.length = 0;
saveMemo();
eq(db.memos.length, 0, 'MEMO WAS NOT SAVED - the old minus-stock bug is gone');
ok(triggers.alert.some(a => a.includes('Stock japt nei')), 'user told exactly why it failed');
eq(db.stock.find(s => s.productId === widget.id).available, 0, 'stock stayed at 0, not negative');

console.log('\n--- give it stock, then the same memo saves ---');
nav('stock');
el('stockProduct').value = widget.id;
el('stockAddQty').value = '50';
el('stockCost').value = '100';
addStockPurchase();
eq(db.stock.find(s => s.productId === widget.id).available, 50, 'opening stock added = 50');

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
ok(!el('memoSaveBtn').disabled, 'save button enabled once stock is sufficient');
triggers.alert.length = 0;
saveMemo();

eq(db.memos.length, 1, 'memo saved');
const memo = db.memos[0];
ok(/TXP\/SM\//.test(memo.memoNo), 'memo number uses the company prefix');
eq(memo.subtotal, 1500, 'subtotal = 10 x 150');
eq(memo.cogs, 1000, 'cogs = 10 x 100');
eq(memo.grandTotal, 1600, 'grand = 1500 - 100 + 200');
eq(memo.due, 1100, 'due = 1600 - 500');
eq(memo.profit, 400, 'profit = 1500 - 100 - 1000');
eq(memo.items[0].cost, 100, 'memo stored the unit cost for future reporting');

const st = db.stock.find(s => s.productId === widget.id);
eq(st.sold, 10, 'sold increased by 10');
eq(st.available, 40, 'available = 50 - 10, never negative');
eq(st.available >= 0, true, 'stock stayed sane');

console.log('\n--- customer auto-created + appears in ledger ---');
ok(db.customers.some(c => c.name === 'Rahim Traders'), 'customer auto-created from memo');
nav('ledger');
renderCustomerLedger();
ok(el('ledgerTable').innerHTML.includes('Rahim Traders'), 'customer shows in ledger');

console.log('\n--- history shows profit ---');
nav('history');
renderHistory();
ok(el('historyTable').innerHTML.includes(memo.memoNo), 'memo listed in history');
ok(el('historyTable').innerHTML.includes('400') || el('historyTable').innerHTML.includes('৳400'), 'profit column rendered');

console.log('\n--- editing the memo re-uses stock correctly (no double count) ---');
editMemo(memo.id);
memoDraft.items = [{ productId: widget.id, qty: 6, rate: 150, cost: 100, vat: 0, amount: 900 }];
renderMemoLines();
triggers.alert.length = 0;
saveMemo();
eq(db.memos.length, 1, 'edit did not create a second memo');
eq(db.memos[0].totalQty, 6, 'quantity updated to 6');
const st2 = db.stock.find(s => s.productId === widget.id);
eq(st2.sold, 6, 'sold reflects only the new quantity (10 reversed, 6 applied)');
eq(st2.available, 44, 'available = 50 - 6');

console.log('\n--- deleting the memo restores stock ---');
triggers.confirm = true;
deleteMemo(db.memos[0].id);
eq(db.memos.length, 0, 'memo deleted');
const st3 = db.stock.find(s => s.productId === widget.id);
eq(st3.sold, 0, 'sold back to 0');
eq(st3.available, 50, 'available back to 50');

console.log('\n--- purchase flow updates stock and cost ---');
nav('supplier');
el('sName').value = 'Dhaka Suppliers';
el('sPhone').value = '01711111111';
addSupplier();
ok(db.suppliers.length === 1, 'supplier created');

nav('purchase');
purchaseDraft.items = [];
addPurchaseLine();
purchaseDraft.items[0] = { productId: widget.id, qty: 10, cost: 120 };
renderPurchaseLines();
el('puSupplier').value = db.suppliers[0].id;
el('puDate').value = today();
el('puPaid').value = '500';
el('puNote').value = 'test po';
calcPurchase();
eq(el('puDue').textContent, '৳700', 'due = 1200 - 500 shown');
savePurchase();
eq(db.purchases.length, 1, 'purchase saved');
const po = db.purchases[0];
eq(po.subtotal, 1200, 'purchase subtotal');
eq(po.status, 'Partial', 'partial payment status');
const st4 = db.stock.find(s => s.productId === widget.id);
eq(st4.purchased, 10, 'purchased qty increased');
eq(st4.available, 60, 'available = 50 + 10');
ok(st4.cost > 100 && st4.cost <= 120, 'weighted cost moved toward the new buy price (got ' + st4.cost + ')');

console.log('\n--- expense + P&L ---');
nav('expense');
el('exDate').value = today();
el('exHead').value = 'Rent';
el('exAmount').value = '5000';
el('exNote').value = 'shop rent';
addExpense();
eq(db.expenses.length, 1, 'expense saved');

// sell again so P&L has a profit to show
nav('memo');
newMemo();
el('memoDate').value = today();
el('customerName').value = 'Karim Store';
memoDraft.items = [{ productId: widget.id, qty: 5, rate: 150, cost: st4.cost, vat: 0, amount: 750 }];
renderMemoLines();
triggers.alert.length = 0;
saveMemo();
const pl = plSummary('', '');
ok(pl.sales > 0, 'P&L sees sales');
ok(pl.cogs > 0, 'P&L sees COGS');
ok(pl.expense === 5000, 'P&L sees the expense');
eq(pl.netProfit, round2(pl.grossProfit - pl.expense + pl.deliveryIncome), 'net profit formula is consistent');

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
eq(db.ledger.some(l => l.balance < 0), false, 'NO negative balance ever recorded in the ledger');

console.log('\n--- stock card edit cannot erase real sales ---');
nav('stock');
openStockEdit(widget.id);
el('seOpening').value = '50';
el('sePurchased').value = '10';
el('seSold').value = '1';            // less than the 5 actually sold
triggers.alert.length = 0;
saveStockEdit();
eq(db.stock.find(s => s.productId === widget.id).sold, 5, 'sold qty left alone');
ok(triggers.alert.some(a => a.includes('kome hote pare na')), 'user warned they cannot lower sold below real sales');

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
ok(db.memos[0].driver === 'Jamal', 'driver stored on memo');
ok(db.memos[0].vehicle.includes('DHAKA'), 'vehicle stored on memo');

openDelivery(db.memos[0].id);
el('dlQty').value = '3';
saveDelivery();
eq(db.deliveries[1].status, 'Delivered', 'full delivery status once complete');

console.log('\n--- payment receive ---');
nav('customers');
const cust = db.customers.find(c => c.name === 'Karim Store') || db.customers[0];
openPayment(cust.id);
el('payAmount').value = '300';
el('payMethod').value = 'bKash';
savePayment();
eq(db.payments.length, 1, 'payment recorded');
eq(db.payments[0].method, 'bKash', 'payment method stored');

console.log('\n--- sync queue is real, not fake-success ---');
db.settings.syncUrl = '';
syncPush('sale', { memoNo: 'X' }, 'Sale X');
eq(syncQueue.length, 0, 'nothing queued when sync URL is empty');
db.settings.syncUrl = 'https://example.invalid/exec';
syncPush('sale', { memoNo: 'X' }, 'Sale X');
eq(syncQueue.length, 1, 'job queued when sync URL is set');
eq(syncQueue[0].state, 'pending', 'queued as pending, not claimed as sent');
const counts = syncCounts();
eq(counts.pending, 1, 'counts expose pending work');
ok(!JSON.stringify(elements['syncBadge']).includes('undefined'), 'sync badge renders without error');

console.log('\n--- print sheet renders the company + totals ---');
const sheet = memoSheet(db.memos[0]);
ok(sheet.includes('TEX') && sheet.includes('PARK'), 'memo sheet has the company name');
ok(sheet.includes(db.settings.company.phone), 'memo sheet has the company phone');
ok(sheet.includes(db.memos[0].memoNo), 'memo sheet has the memo number');
ok(sheet.includes('Amount in Words'), 'memo sheet has the amount in words');
ok(sheet.includes('Authorized Signature'), 'memo sheet has a signature line');
ok(/One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Thousand|Lakh|Hundred/.test(sheet), 'amount in words is spelled out, not digits');
ok(!/undefined|NaN/.test(sheet), 'memo sheet has no undefined/NaN');

console.log('\n--- every page renders without throwing ---');
let pageErrors = [];
['dashboard','memo','history','delivery','customers','ledger','purchase','supplier',
 'products','stock','stocklog','profit','pl','expense','ledgerreport','users','settings','backup']
  .forEach(p => {
    try { nav(p); } catch (e) { pageErrors.push(p + ': ' + e.message); }
  });
eq(pageErrors.length, 0, 'all pages rendered cleanly' + (pageErrors.length ? ' -> ' + pageErrors.join('; ') : ''));

console.log('\n--- data survives a reload ---');
commit();
const before = db.memos.length;
db = loadDB();
eq(db.memos.length, before, 'memos persisted');
eq(db.products.length, 4, 'products persisted');
ok(db.users.length >= 1, 'users persisted so login still works');

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
console.log('=================');
process.exit(fail ? 1 : 0);
