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
    id, value: '', textContent: '', checked: false, disabled: false,
    style: {}, dataset: {}, className: '',
    _html: '', _writes: 0,
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
  /* innerHTML is counted, and children is derived from it. Together they let a
     test see whether the memo table was rebuilt under the owner's cursor - the
     bug this shim previously could not observe. */
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); this._writes++; },
    configurable: true
  });
  Object.defineProperty(el, 'children', {
    get() { const m = String(this._html).match(/<tr>/g); return { length: m ? m.length : 0 }; },
    configurable: true
  });
  return el;
}

const elements = {};
function el(id) { if (!elements[id]) elements[id] = makeEl(id); return elements[id]; }

/* <head> records what is appended to it, so a test can prove the sheet's stylesheet
   actually reaches the page. Without this the shim cannot tell a styled preview from
   an unstyled one, which is how the sheet shipped unstyled once. */
const headChildren = [];
const headEl = makeEl('head');
headEl.appendChild = node => { headChildren.push(node); };

/* capture clicks/JS the app trigger */
const triggers = { alert: [], confirm: true, prompt: '' };

global.window = {
  addEventListener() {}, print() {}, location: { reload() {} }
};
global.document = {
  body: makeEl('body'),
  head: headEl,
  getElementById: id => {
    // 'memoCss' must behave like a real lookup: the element only exists once
    // memoCssTag() has appended it, so a second boot can be proved not to append it
    // twice. Every other id is auto-created, as the rest of the tests expect.
    if (id === 'memoCss') return headChildren.find(n => n.id === 'memoCss') || null;
    return id ? el(id) : null;
  },
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
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'voice.js'), 'utf8'), { filename: 'voice.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'memoexport.js'), 'utf8'), { filename: 'memoexport.js' });
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
ok(el('memoStockWarn').innerHTML.includes('has not been entered yet'),
  'reminder shown that stock was not entered yet');
ok(!/will not save|cannot save/i.test(el('memoStockWarn').innerHTML), 'the message does not threaten to block');
eq(el('memoSaveBtn').disabled, false, 'save button is ENABLED, not disabled');

triggers.alert.length = 0;
saveMemo();
eq(db.memos.length, 1, 'MEMO WAS SAVED with 0 stock - the memo is the source of truth');
ok(!triggers.alert.some(a => /failed|could not save/i.test(a)), 'nothing told the user the memo failed');

const autoCard = findStock(widget.id);
ok(!!autoCard, 'THE STOCK CARD WAS AUTO-CREATED from the memo');
eq(autoCard.opening, 0, 'auto card starts with 0 received - user still tops it up later');
eq(autoCard.sold, 10, 'the memo qty landed in sold');
eq(autoCard.available, 0, 'available stops at 0 - a shelf cannot hold minus ten');
eq(stockShort(autoCard), 10, 'the shortfall is reported separately as tola baki');
eq(findStock(widget.id).available >= 0, true, 'nothing on the stock card shows a minus');
ok(db.ledger.some(l => l.type === 'AutoAdd' && l.productId === widget.id),
  'auto-creation is traceable in the stock ledger');

console.log('\n--- top up received stock later; the shortfall closes ---');
nav('stock');
ok(el('stockProduct').innerHTML.includes('Test Widget'), 'auto-created product is in the stock picker');
el('stockProduct').value = widget.id;
el('stockAddQty').value = '50';
el('stockCost').value = '100';
addStockPurchase();
eq(findStock(widget.id).available, 40, 'received 50 closes the 10 shortfall to +40');
eq(stockShort(findStock(widget.id)), 0, 'nothing left to enter once 50 was received');
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

console.log('\n--- typing in a memo box keeps its caret (no table rebuild) ---');
/* Regression: memoSet used to call renderMemoLines(), which replaced memoRows
   and threw the caret out of the box after the first digit. Nothing is saved
   here, so the memos counted above stay the ones the rest of the file asserts on. */
nav('memo');
newMemo();
memoDraft.items = [{ productId: widget.id, qty: 1, rate: 0, cost: 100, vat: 0, amount: 0 }];
renderMemoLines();
const rowsBefore = el('memoRows')._writes;
memoSet(0, 'qty', '6');
memoSet(0, 'qty', '60');
memoSet(0, 'rate', '250');
eq(el('memoRows')._writes, rowsBefore, 'the memo table was NOT rebuilt while typing');
eq(memoDraft.items[0].qty, 60, 'both digits of 60 landed in the draft');
eq(memoDraft.items[0].rate, 250, 'the rate landed too');
ok(el('memoAmount0').textContent.includes('15,000'), 'the line amount updated in place');
/* The browser owns the input's text; the app must not write it back while the
   owner types. Park a value in the box and confirm the patch leaves it alone. */
el('memoQty0').value = '60';
memoSet(0, 'qty', '65');
eq(el('memoQty0').value, '60', 'the input is never rewritten by the patch');

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
ok(triggers.alert.some(a => a.includes('cannot go below')),
  'user warned they cannot lower sold below real sales');

console.log('\n--- delivery collects cash and drops the memo due ---');
nav('delivery');
openDelivery(db.memos[0].id);
/* The cash box wakes up prefilled with what the memo still owes; the owner can
   overwrite it, and here he types the amount the driver actually brought back. */
eq(num(el('dlCollect').value), 750, 'the collect box prefills the whole remaining due for a full delivery');
el('dlQty').value = '2';
el('dlCollect').value = '300';
el('dlDriver').value = 'Jamal';
el('dlVehicle').value = 'DHAKA-TA-11-2233';
el('dlReceiver').value = 'Karim';
saveDelivery();
eq(db.deliveries.length, 1, 'delivery recorded');
eq(db.deliveries[0].status, 'Partial', 'partial delivery status');
eq(db.payments.length, 1, 'the 300 collected on the delivery is recorded as a payment in the same commit');
eq(db.payments[0].memoId, db.memos[0].id, 'the payment is linked to the memo');
eq(db.payments[0].deliveryId, db.deliveries[0].id, 'the payment is linked to the delivery that collected it');
eq(memoRemainingDue(db.memos[0]), 450, 'the memo due drops by the 300 that came in');

openDelivery(db.memos[0].id);
eq(String(el('dlQty').value), '3', 'the form pre-fills the pending qty');
eq(num(el('dlCollect').value), 270, 'a 3-of-5 delivery prefills three fifths of the 450 still owed');
el('dlCollect').value = '450';
saveDelivery();
eq(db.deliveries[db.deliveries.length - 1].status, 'Delivered', 'full delivery status once the whole memo is delivered');
eq(memoRemainingDue(db.memos[0]), 0, 'the whole memo is now collected');

console.log('\n--- manual payment receive ---');
nav('customers');
const cust = db.customers.find(c => c.name === 'Karim Store');
ok(!!cust, 'customer exists');
openPayment(cust.id);
el('payAmount').value = '300';
el('payMethod').value = 'bKash';
savePayment();
eq(db.payments.length, 3, 'the manual receipt is added alongside the two delivery receipts');
eq(db.payments[2].method, 'bKash', 'payment method stored');

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

console.log('\n--- the memo sheet is the document the customer sees ---');
const sheet2 = memoSheet(db.memos[0]);
// The exported PNG/PDF wraps this same markup in an SVG with only MEMO_CSS inside
// it, so a class the sheet uses but the constant does not style would download as
// unstyled black text - the exact failure the constant exists to prevent.
const usedClasses = [...sheet2.matchAll(/class="([^"]+)"/g)]
  .flatMap(m => m[1].split(/\s+/)).filter(Boolean);
const styled = new Set([...MEMO_CSS.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
const unstyled = [...new Set(usedClasses)].filter(c => !styled.has(c));
eq(unstyled.join(','), '', 'every class the sheet uses is in MEMO_CSS: ' + unstyled.join(', '));
ok(/memo-top/.test(sheet2), 'the sheet has its navy header band');
ok(/Bill To/.test(sheet2) && /From/.test(sheet2), 'the sheet has both party boxes');
ok(/memo-grand/.test(sheet2) && /memo-due/.test(sheet2),
   'the grand total and the due are the two highlighted rows');
ok(/memo-items/.test(sheet2), 'the sheet has its item table');
ok(/Signature/.test(sheet2), 'and the two signature lines');
ok(/Terms:/.test(sheet2), 'and the terms the shop hands over with every memo');
ok(!/memo-sheet\b[^>]*class="mh"/.test(sheet2), 'the old .mh header markup is gone');
ok(/memo-strip/.test(sheet2), 'the sheet has the due date / payment / delivery strip');
ok(/Due Date/.test(sheet2), 'the strip prints the due date');
eq(memoDueDate('2027-01-01'), '2027-01-16', 'the due date is 15 days after the sale');
eq(memoDueDate(''), '-', 'an unparseable date falls back to a dash, not NaN');

// The stylesheet is a string in app.js; something has to put it in the document, or
// the preview is unstyled HTML while the exports stay correct - which is exactly how
// this shipped once. boot() is what runs it.
ok(headChildren.some(n => n.id === 'memoCss' && n.textContent === MEMO_CSS),
   'boot() puts MEMO_CSS into the page, so the on-screen sheet is styled');
boot();
eq(headChildren.filter(n => n.id === 'memoCss').length, 1,
   'booting again does not append the stylesheet twice');
// An empty memo is still a valid sheet - a memo can be saved before any line is
// filled in when stock is missing, and the sheet must render then too.
const emptySheet = memoSheet({ memoNo: 'X', date: today(), customerName: 'A', items: [],
  totalQty: 0, subtotal: 0, discount: 0, deliveryCharge: 0, vat: 0, grandTotal: 0,
  advance: 0, due: 0, note: '' });
ok(!/undefined|NaN/.test(emptySheet), 'an empty memo sheet renders without undefined/NaN');
ok(/No products/.test(emptySheet), 'and says so instead of showing a bare table');

console.log('\n--- a memo can leave the app as a file ---');
ok(typeof memoSheetSVG === 'function' && /<svg/.test(memoSheetSVG(db.memos[0])),
   'the sheet can be wrapped as a standalone SVG');
ok(memoSheetSVG(db.memos[0]).indexOf(MEMO_CSS) !== -1,
   'the SVG carries the sheet stylesheet, so the download is styled, not bare text');
ok(memoSheetSVG(db.memos[0]).indexOf('foreignObject') !== -1,
   'the SVG carries the real sheet markup, so it cannot drift from the preview');
const pdf = pdfFromJPEG(new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]), 200, 100);
// Array.from, not pdf.map: a typed array's map returns another typed array, and
// joining that would print numbers instead of the PDF's text.
const pdfText = Array.from(pdf, b => String.fromCharCode(b)).join('');
ok(pdfText.startsWith('%PDF-1.4'), 'a PDF is written, not a renamed text file');
ok(pdfText.indexOf('%%EOF') !== -1, 'and it is terminated properly');
ok(/\/Filter \/DCTDecode/.test(pdfText), 'the image is stored as a JPEG');
ok(/\/MediaBox \[0 0 595\.28 841\.89\]/.test(pdfText), 'on an A4 page');
// The xref offsets have to point at the byte offsets of the objects. A wrong one
// gives a PDF that a viewer refuses to open, with nothing obviously wrong in it.
// ^xref$, not lastIndexOf('xref'): that also matches the word inside "startxref",
// so the table looked like it began at the wrong byte.
const xrefAt = pdfText.search(/^xref$/m);
const offsets = [...pdfText.slice(xrefAt).matchAll(/^(\d{10}) 00000 n /gm)].map(m => Number(m[1]));
ok(offsets.length === 5, 'the xref table lists all five objects');
offsets.forEach((off, i) => {
  ok(pdfText.slice(off, off + String(i + 1).length + 6) === (i + 1) + ' 0 obj',
     'xref offset ' + (i + 1) + ' points at object ' + (i + 1));
});
const startxref = Number((pdfText.match(/startxref\n(\d+)/) || [])[1]);
eq(startxref, xrefAt, 'startxref points at the xref table');

console.log('\n--- every button in the HTML is wired to a real function ---');
/* A renamed or deleted function leaves an onclick that silently does nothing when
   the owner taps it - the button looks fine and the shop finds out the hard way. */
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// Inline handlers legitimately start with `if` (a click outside a modal closes it),
// which is not a function name and must not be reported as a missing one.
const JS_KEYWORDS = new Set(['if', 'return', 'this', 'event', 'void', 'typeof']);
const handlers = new Set();
[...indexHtml.matchAll(/on(?:click|input|change)="([a-zA-Z_$][\w$]*)\(/g)]
  .map(m => m[1]).filter(h => !JS_KEYWORDS.has(h)).forEach(h => handlers.add(h));
const missing = [...handlers].filter(h => typeof global[h] !== 'function');
eq(missing.join(','), '', 'every handler exists: ' + missing.join(', '));
ok(handlers.has('savePreviewMemo') && handlers.has('saveViewMemo')
   && handlers.has('previewCurrentMemo') && handlers.has('printViewMemo'),
   'the memo preview and export buttons are wired');
// The history row buttons are built in JS, so they are checked from the generated
// markup instead of the static HTML.
const historyHtml = (function () {
  db.memos.length || db.memos.push({ id: 'x', memoNo: 'M1', date: today(),
    customerName: 'A', items: [], totalQty: 0, grandTotal: 0, profit: 0, due: 0 });
  renderHistory();
  return el('historyTable').innerHTML;
})();
['viewMemo', 'printMemoById', 'exportMemoById', 'editMemo', 'deleteMemo'].forEach(fn => {
  ok(historyHtml.indexOf(fn + "('") !== -1, 'the history row offers ' + fn);
});

console.log('\n--- every page renders without throwing ---');
let renderErr = '';
try {
  ['dashboard', 'memo', 'history', 'delivery', 'customers', 'ledger', 'purchase', 'supplier',
    'products', 'stock', 'stocklog', 'profit', 'pl', 'expense', 'ledgerreport', 'users',
    'settings', 'backup'].forEach(id => nav(id));
} catch (e) { renderErr = e.message; }
eq(renderErr, '', 'all pages rendered cleanly');

console.log('\n--- phone drawer opens, closes, and shuts on nav ---');
eq(document.body.classList.contains('nav-open'), false, 'drawer starts closed');
toggleNav();
eq(document.body.classList.contains('nav-open'), true, 'tapping the hamburger opens the drawer');
closeNav();
eq(document.body.classList.contains('nav-open'), false, 'tapping the scrim closes it');
toggleNav();
eq(document.body.classList.contains('nav-open'), true, 'opened again');
nav('stock');
eq(document.body.classList.contains('nav-open'), false, 'picking a page closes the drawer');
eq(document.getElementById('topTitle').textContent, 'Stock', 'and the page actually changed');
nav('memo');
eq(document.getElementById('topTitle').textContent, 'New Sales Memo', 'nav still works after drawer use');

console.log('\n--- voice entry: speaking a received product ---');
nav('stock');
const voiceProductsBefore = db.products.length;
// the sentence the boss would actually say
const heard = 'ajke ei product ta in hoise naam eita Mouse Pad, quantity 20, price porche 150';
let parsed = parseVoiceCommand(heard, { defaultKind: 'in' });
eq(parsed.actions.length, 1, 'one action was understood');
eq(parsed.actions[0].kind, 'in', 'understood as a stock-in');
eq(parsed.actions[0].matched, undefined, 'not resolved until it is applied');
applyVoiceActions(parsed.actions);
const mousePad = db.products.find(p => /mouse pad/i.test(p.name));
ok(!!mousePad, 'the new product was created on the spot');
eq(findStock(mousePad.id).available, 20, 'received 20 landed in stock');
eq(num(findStock(mousePad.id).cost), 150, 'purchase price 150 became the cost');
ok(db.products.length > voiceProductsBefore, 'product list grew');
ok(db.ledger.some(l => l.productId === mousePad.id && l.type === 'Opening'), 'ledger recorded the receipt');

console.log('\n--- voice entry: the same sentence reuses the existing product ---');
const heard2 = 'Mouse Pad in hoise 5 pcs, price porche 160';
parsed = parseVoiceCommand(heard2, { defaultKind: 'in' });
applyVoiceActions(parsed.actions);
eq(db.products.filter(p => /mouse pad/i.test(p.name)).length, 1, 'no duplicate product created');
eq(findStock(mousePad.id).available, 25, 'available is now 25');
eq(num(findStock(mousePad.id).cost), 160, 'cost updated to the latest price');

console.log('\n--- voice entry: Bangla digits and spoken numbers ---');
parsed = parseVoiceCommand('naam eita Cable Clip, quantity ৫০, price porche ek shoto', { defaultKind: 'in' });
eq(parsed.actions[0].qty, 50, 'Bangla digit 50 understood');
eq(parsed.actions[0].cost, 100, 'spoken "ek shoto" became 100');

console.log('\n--- voice entry: a sale goes onto the memo ---');
nav('memo');
newMemo();
const beforeMemoItems = memoDraft.items.length;
parsed = parseVoiceCommand('Rahim ke Mouse Pad sell holo quantity 3, sell price 250', { defaultKind: 'out' });
applyVoiceActions(parsed.actions);
eq(memoDraft.items.length, beforeMemoItems + 1, 'a memo line was added');
const vline = memoDraft.items[memoDraft.items.length - 1];
eq(vline.productId, mousePad.id, 'the line points at the spoken product');
eq(vline.qty, 3, 'qty 3');
eq(vline.rate, 250, 'rate 250');
eq(vline.cost, 160, 'cost came from the stock card automatically');
ok(memoDraft.items.some(x => num(x.qty) > 0), 'memo can be saved right away');

console.log('\n--- voice entry: two products in one breath ---');
nav('stock');
parsed = parseVoiceCommand('aras Power Strip in hoise 10, price porche 320', { defaultKind: 'in' });
parsed = parseVoiceCommand('Power Strip ar HDMI Cable in hoise, quantity 10 ar quantity 6', { defaultKind: 'in' });
eq(parsed.actions.length, 2, 'two actions split from one sentence');
eq(parsed.actions[0].qty, 10, 'first product qty 10');
eq(parsed.actions[1].qty, 6, 'second product qty 6');

console.log('\n--- voice entry: names that contain numbers ---');
parsed = parseVoiceCommand('ajke ei product ta in hoise naam eita Kids 3pcs Set, quantity 12, price porche 250', { defaultKind: 'in' });
eq(parsed.actions[0].name, 'kids set', 'the number inside the name is not mistaken for the quantity');
eq(parsed.actions[0].qty, 12, 'qty is still the spoken quantity');
eq(parsed.actions[0].cost, 250, 'cost is still the spoken price');

console.log('\n--- voice entry: the customer is not part of the product name ---');
parsed = parseVoiceCommand('Karim ke Mouse Pad sell holo quantity 2, sell price 260', { defaultKind: 'out' });
eq(parsed.actions[0].name, 'mouse pad', 'the "<name> ke" customer prefix is dropped');
eq(parsed.actions[0].rate, 260, 'sell price understood');

console.log('\n--- voice entry: nonsense never writes anything ---');
const before = db.ledger.length;
parsed = parseVoiceCommand('', { defaultKind: 'in' });
eq(parsed.actions.length, 0, 'empty speech yields no action');
const junk = parseVoiceCommand('hmm', { defaultKind: 'in' });
const junkDone = applyVoiceActions(junk.actions);
eq(junkDone.length, 0, 'a half-sentence writes nothing');
eq(db.ledger.length, before, 'ledger untouched by the junk attempt');

console.log('\n--- mic: the app explains why it cannot work instead of failing silently ---');
// an iPhone with the site installed to the home screen: Apple blocks speech here
function micCase(ua, opts) {
  // note: Node's global navigator is read-only, so the app reads window.navigator
  global.window.navigator = { userAgent: ua, maxTouchPoints: opts.touch || 0, platform: opts.platform || 'iPhone' };
  global.window.location = { hostname: opts.host || 'example.com', protocol: opts.proto || 'https:' };
  global.window.isSecureContext = opts.secure !== false;
  global.window.SpeechRecognition = opts.supported === false ? undefined : function () {};
  global.window.webkitSpeechRecognition = opts.supported === false ? undefined : function () {};
  global.window.matchMedia = () => ({ matches: !!opts.standalone });
  return voiceMicBlocked();
}
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

let blk = micCase(IPHONE, { standalone: true, secure: true });
ok(!!blk, 'iPhone + installed app is caught');
ok(/Apple/i.test(blk.title + blk.body), 'and the reason names Apple, not the user');
ok(/Safari/i.test(blk.body), 'and tells them to open Safari instead');
ok(!/permission/i.test(blk.title), 'it does not blame a missing permission');

blk = micCase(IPHONE, { standalone: false, secure: true });
eq(blk, null, 'iPhone in plain Safari is allowed through');

blk = micCase(ANDROID, { standalone: false, secure: true, platform: 'Linux' });
eq(blk, null, 'Android Chrome is allowed through');

blk = micCase(ANDROID, { standalone: false, secure: true, platform: 'Linux', supported: false });
ok(blk && /support/i.test(blk.title), 'a browser without the API is told so plainly');

blk = micCase(ANDROID, { standalone: false, secure: false, proto: 'http:', host: '192.168.0.9', platform: 'Linux' });
ok(blk && /https/i.test(blk.title), 'plain http is flagged - the browser never even asks there');

blk = micCase(ANDROID, { standalone: false, secure: false, proto: 'http:', host: 'localhost', platform: 'Linux' });
eq(blk, null, 'localhost still counts as secure, so desktop testing keeps working');

// and a refusal mid-session must leave the typing path usable
global.window.navigator = { userAgent: ANDROID, maxTouchPoints: 0, platform: 'Linux' };
global.window.location = { hostname: 'example.com', protocol: 'https:' };
global.window.isSecureContext = true;
global.window.matchMedia = () => ({ matches: false });
let fired = null;
global.window.SpeechRecognition = function () {
  const self = this;
  this.start = function () { fired = self; };
  this.stop = function () {};
};
voiceToggle();
ok(!!fired, 'tapping the mic actually starts a session when nothing is blocking');
fired.onerror({ error: 'not-allowed' });
const panelText = document.getElementById('voiceBody').innerHTML;
ok(/permission/i.test(panelText), 'a denied permission is explained');
ok(/type below/i.test(panelText), 'and the typing fallback is pointed at');
ok(!document.createElement('voiceBtn').classList.contains('listening'), 'the button stops showing as listening');

console.log('\n--- phone install / offline wiring ---');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
const swSrc = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
eq(manifest.name, 'Texpark Pro - Business Manager', 'manifest names the app');
eq(manifest.display, 'standalone', 'installs as a standalone app, not a browser tab');
eq(manifest.start_url, './index.html', 'opens the app on launch');
ok(manifest.icons.length >= 2, 'manifest ships icons for the home screen');
manifest.icons.forEach(ic => {
  ok(fs.existsSync(path.join(root, ic.src)), 'icon exists: ' + ic.src);
  // the sizes field must match the file we actually generated
  const buf = fs.readFileSync(path.join(root, ic.src));
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  eq(ic.sizes, w + 'x' + h, ic.src + ' is really ' + ic.sizes);
});
ok(/rel="manifest" href="manifest.webmanifest"/.test(html), 'index.html links the manifest');
ok(/apple-touch-icon/.test(html), 'iOS gets a home-screen icon');
ok(/name="theme-color"/.test(html), 'theme colour set for the status bar');

// every file the service worker promises to cache must actually be there
const assets = (swSrc.match(/ASSETS = \[([\s\S]*?)\]/) || [])[1] || '';
const listed = [...assets.matchAll(/'(\.\/[^']*)'/g)].map(m => m[1]);
ok(listed.length >= 8, 'service worker caches the whole app');
listed.forEach(a => {
  const rel = a === './' ? 'index.html' : a.replace(/^\.\//, '');
  ok(fs.existsSync(path.join(root, rel)), 'offline cache asset exists: ' + a);
});
// anything index.html loads must be in that list, or it breaks offline
[...html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)].forEach(m => {
  ok(listed.indexOf('./' + m[1]) !== -1, 'index.html loads ' + m[1] + ' and the SW caches it');
});
ok(/serviceWorker/.test(html) && /register\('sw\.js'\)/.test(html), 'index.html registers the service worker');
ok(/location\.protocol/.test(html), 'service worker is skipped on file:// so the desktop app still opens');

console.log('\n--- a phone must be able to get OFF an old cached build ---');
const sw2 = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
// the browser only installs a new worker when sw.js changes, and a worker that
// does not change on deploy is exactly what left a phone on the old CSS
const swVer = (sw2.match(/APP_VERSION = '([^']+)'/) || [])[1];
const appVer = (appJs.match(/APP_VERSION = '([^']+)'/) || [])[1];
ok(!!swVer, 'sw.js carries a cache version');
ok(!!appVer, 'app.js carries a version to display');
eq(swVer, appVer, 'the two versions match, so they can be bumped together');
ok(sw2.indexOf("'texpark-pro-' + APP_VERSION") !== -1,
   'the cache name is derived from the version, so bumping the version makes a new cache');
// code must not be served cache-first
ok(/mustBeFresh/.test(sw2), 'the worker defines which requests must be fresh');
ok(/\.\(\?:js\|css\|webmanifest\|apk\)/.test(sw2),
   'js, css, the manifest and the APK are treated as must-be-fresh');
ok(/\|apk\)\$/.test(sw2),
   'the APK is network-first: a cached copy would reinstall an older build');
ok(/mode === 'navigate'/.test(sw2), 'the page itself is treated as must-be-fresh');
// an updated worker should reload the open page instead of waiting for a manual refresh
ok(/clients\.matchAll/.test(sw2) && /navigate/.test(sw2), 'an updated worker reloads the open page');
ok(/skipWaiting/.test(sw2) && /clients\.claim/.test(sw2), 'the new worker takes over immediately');
// one missing asset must not reject the whole install: caches.addAll() does
// exactly that, and the phone then keeps the old worker - and the old app -
// forever, with nothing on screen to explain it
ok(!/addAll\(ASSETS\)/.test(sw2),
   'assets are cached one by one, so a single 404 cannot pin the phone to the old build');
ok(/REQUIRED/.test(sw2), 'the files the app cannot start without still fail the install loudly');
// and there must be a way for the user to tell, and to force it
ok(/function checkForUpdate/.test(appJs), 'Settings offers an update check');
ok(/id="appVersion"/.test(html) && /id="updateOut"/.test(html), 'Settings shows the build it is running');
ok(/checkForUpdate\(\)/.test(html), 'the update button is wired to the function');
ok(/cache: 'reload'/.test(appJs), 'the check bypasses the cache instead of being fooled by it');
// a copy opened from an address that stopped being updated must be told where
// the current build is, not told it is up to date
ok(/RELEASE_URL/.test(appJs), 'the released address is known to the app');
ok(/staleOrigin/.test(appJs), 'a stale address is reported as stale');
// the numeric compare, so .10 is not read as older than .9
const vNewer = new Function('a', 'b', 'return (' +
  (appJs.match(/function versionNewer[\s\S]*?\n}/) || ['return false'])[0] + ')(a, b)');
ok(vNewer('2027-01-01.10', '2027-01-01.9'), '.10 counts as newer than .9');
ok(!vNewer('2027-01-01.9', '2027-01-01.10'), '.9 does not count as newer than .10');
ok(!vNewer('2027-01-01.5', '2027-01-01.5'), 'the same version is not newer than itself');
// the stale-build bug itself: the phone fix must be present in the shipped css
ok(/iOS zooms the whole page in/.test(fs.readFileSync(path.join(root, 'css/app.css'), 'utf8')),
   'the phone fix is really in the css that ships');

console.log('\n--- data survives a reload ---');
eq(db.memos.length, 1, 'memos persisted');
eq(db.products.length, 5, 'products persisted - incl. the voice-created one');
ok(!!fakeStore['texpark_pro_v2'], 'data stored under the v2 key');
ok(!fakeStore['texpark_biz_v1'], 'old v1 key not mixed in');
eq(loadDB().memos.length, 1, 'reload reads the same memos back');

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
console.log('=================');
if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(' - ' + f)); }
process.exit(fail ? 1 : 0);
