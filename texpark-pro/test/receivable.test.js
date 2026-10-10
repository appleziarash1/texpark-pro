/* Receivable and delivery-collection rules, driven through the REAL app.js against
   the same DOM shim as e2e.test.js. The dashboard's Receivable must agree with what
   each memo actually still owes: recording a payment must move the memo, the history
   row, the customer due and the ageing bucket together, and a memo that was never
   touched by a receipt must read exactly as it always did.

   Run: node test/receivable.test.js */

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
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'courier.js'), 'utf8'), { filename: 'courier.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8'), { filename: 'app.js' });
vm.runInThisContext('boot();', { filename: 'boot' });

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + a + ', want ' + b + ')'); }

el('loginUser').value = 'admin';
el('loginPass').value = 'admin123';
doLogin();

/* A clean slate for one memo: 10 pieces at 150 = 1500, nothing paid yet. */
function freshMemo(customer) {
  db.memos = db.memos.filter(m => m.customerName !== customer);
  nav('memo');
  newMemo();
  el('memoDate').value = today();
  el('customerName').value = customer;
  memoDraft.items = [{ productId: 'seed-k3s', qty: 10, rate: 150, cost: 100, vat: 0, amount: 1500 }];
  renderMemoLines();
  calcMemo();
  saveMemo();
  return db.memos[db.memos.length - 1];
}

console.log('\n=== receivable: dashboard agrees with what each memo owes ===');
const m1 = freshMemo('Karim');
eq(num(m1.grandTotal), 1500, 'memo grand total = 1500');
eq(memoRemainingDue(m1), 1500, 'a fresh memo owes its whole grand total');
eq(totalReceivable(), 1500, 'dashboard receivable = 1500');

console.log('\n--- the regression that matters: no-receipt data is unchanged ---');
db.payments = [];
for (const m of db.memos) m.due = round2(num(m.grandTotal) - num(m.advance));
eq(totalReceivable(), round2(db.memos.reduce((a, m) => a + num(m.due), 0)),
  'with no receipts, receivable equals the old sum-of-due exactly');

console.log('\n--- a delivery that collects cash ---');
nav('delivery');
openDelivery(m1.id);
eq(num(el('dlCollect').value), 1500, 'a full delivery prefills the whole due');
el('dlQty').value = '4';
deliveryQtyChanged();
eq(num(el('dlCollect').value), 600, 'a 4-of-10 delivery prefills four tenths of the due');
el('dlCollect').value = '600';
el('dlDriver').value = 'Jamal';
saveDelivery();
eq(db.payments.length, 1, 'one receipt recorded');
eq(num(db.payments[0].amount), 600, 'receipt amount = 600');
eq(memoRemainingDue(m1), 900, 'memo due drops to 900');
eq(totalReceivable(), 900, 'dashboard receivable drops to 900');

console.log('\n--- over-collection is clamped, never negative ---');
openDelivery(m1.id);
el('dlQty').value = '6';
el('dlCollect').value = '5000';
triggers.alert.length = 0;
saveDelivery();
ok(triggers.alert.some(a => /more than/.test(a)), 'owner warned the collection exceeded the due');
eq(num(db.payments[db.payments.length - 1].amount), 900, 'the receipt is clamped down to the 900 still owed');
eq(memoRemainingDue(m1), 0, 'memo is fully collected, never negative');
eq(totalReceivable(), 0, 'dashboard receivable floors at zero');

console.log('\n--- the receipt is linked so it can be found and removed ---');
eq(db.payments[db.payments.length - 1].memoId, m1.id, 'receipt carries the memo id');
eq(db.payments[db.payments.length - 1].deliveryId, db.deliveries[db.deliveries.length - 1].id,
  'receipt carries the delivery id that collected it');

console.log('\n--- customer ledger and history read the same remaining due ---');
nav('customers');
renderCustomers();
ok(el('customerTable').innerHTML.includes('৳0'), 'the customer row is fully settled');
nav('history');
renderHistory();
ok(!/₹?1,500/.test(el('historyTable').innerHTML) || /৳0/.test(el('historyTable').innerHTML),
  'history no longer shows the collected 1500 as due');

console.log('\n--- deleting the memo takes its receipts with it (no orphan) ---');
const before = db.payments.length;
triggers.confirm = true;
deleteMemo(m1.id);
const live = db.payments.filter(p => !p.del && p.memoId === m1.id);
eq(live.length, 0, 'every receipt of the deleted memo is retired');
eq(db.payments.filter(p => p.del).length, before, 'they were soft-deleted, not silently dropped');
eq(totalReceivable(), 0, 'receivable is unaffected once the memo and its receipts are gone');

console.log('\n--- the Receive button still works, exactly as before ---');
/* A customer-level receipt (the Receive button, no memoId) is the LEGACY shape: the
   customer ledger counts it, and the dashboard never did. That is preserved here so
   an existing book reads byte-for-byte the same after this change. */
const m2 = freshMemo('Rahim');
nav('customers');
const cust2 = db.customers.find(c => c.name === 'Rahim');
openPayment(cust2.id);
el('payAmount').value = '300';
el('payMethod').value = 'bKash';
savePayment();
const manual = db.payments[db.payments.length - 1];
eq(manual.method, 'bKash', 'manual receipt method stored');
eq(manual.memoId, undefined, 'a manual receipt is still customer-level, not memo-linked');
eq(customerDue(cust2).paid, 300, 'the customer ledger counts the 300 received');
eq(customerDue(cust2).due, 1200, 'the customer ledger due drops to 1200');
eq(totalReceivable(), 1500, 'the dashboard stays memo-based, exactly as it was before receipts existed');

console.log('\n--- a soft-deleted receipt stays deleted across a merge ---');
/* The other device still holds the live receipt (older stamp). Pulling its snapshot
   must not undo the delete, or the money would silently reappear on the dashboard. */
const m3 = freshMemo('Merge Test');
nav('delivery');
openDelivery(m3.id);
el('dlQty').value = '10';
el('dlCollect').value = '1500';
saveDelivery();
const payId = db.payments[db.payments.length - 1].id;
eq(memoRemainingDue(m3), 0, 'the memo is fully collected');
const staleOther = JSON.parse(JSON.stringify(db));   // the other device's older copy
deleteMemo(m3.id);
eq(db.payments.find(p => p.id === payId).del, true, 'the receipt is soft-deleted here');
mergeCloudInto_(staleOther);
const after = db.payments.find(p => p.id === payId);
ok(!after || after.del === true, 'the stale live copy does not resurrect the deleted receipt');
ok(!db.memos.some(m => m.id === m3.id), 'and the deleted memo stays deleted');
/* The only receivable left is the still-open Rahim memo (1500); the deleted, fully
   collected Merge Test memo must contribute nothing after the stale merge. */
eq(totalReceivable(), 1500, 'the deleted memo contributes nothing to the dashboard');

console.log('\n=== receivable: ' + pass + ' pass / ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
