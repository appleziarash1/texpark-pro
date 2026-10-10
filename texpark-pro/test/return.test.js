/* End-to-end test of the two things the owner asked for next: the memo form
   recognising a customer that is already saved, and a parcel coming back updating
   the stock book. Drives the REAL app.js against the same DOM shim as e2e.test.js,
   so it tests the real saveReturn/applyReturnToStock path, not a re-implementation.
   Run: node test/return.test.js */

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

const triggers = { alert: [], confirm: true, prompt: '' };

global.window = { addEventListener() {}, print() {}, location: { reload() {} } };
global.document = {
  body: makeEl('body'),
  getElementById: id => (id ? el(id) : null),
  querySelectorAll: () => [],
  createElement: () => makeEl('tmp'),
  addEventListener() {},
  activeElement: null
};
global.alert = m => { triggers.alert.push(String(m)); };
global.confirm = () => triggers.confirm;
global.prompt = () => triggers.prompt;
global.setTimeout = () => 0;
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
function ok(c, l) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l); }
}
function eq(a, b, l) { ok(a === b, l + '  (got ' + a + ', want ' + b + ')'); }

console.log('\n=== customer autocomplete and parcel return (real app.js) ===');

session = { userId: db.users[0].id, username: 'admin', name: 'Administrator', role: 'admin' };
const p1 = db.products[0];

console.log('\n--- the memo form recognises a saved customer ---');
/* Save a memo so the customer exists, exactly as the owner would. */
nav('memo');
el('customerName').value = 'Md. Karim Uddin';
el('customerPhone').value = '01711111111';
el('customerAddress').value = 'Mirpur, Dhaka';
memoDraft = { items: [{ productId: p1.id, qty: 5, rate: 220, cost: 165, vat: 0 }] };
saveMemo();
const savedCustomer = db.customers.find(c => c.name === 'Md. Karim Uddin');
ok(!!savedCustomer, 'the customer was added to the customer list on save');

/* Now a fresh memo, typing the name a second time. */
newMemo();
el('customerName').value = 'md  karim uddin';   // different case and spacing
memoCustomerCheck();
ok(el('memoCustHint').innerHTML.includes('already saved'),
  'typing the name in a different case/spacing is recognised as already saved');
eq(el('customerPhone').value, '01711111111', 'the saved phone is filled in');
eq(el('customerAddress').value, 'Mirpur, Dhaka', 'the saved address is filled in');
ok(el('memoCustHint').innerHTML.includes('Memos: 1'), 'the hint says how many memos this customer has');

/* The datalist carries every known name, saved list plus memo names. */
newMemo();
ok(el('customerNames').innerHTML.includes('Md. Karim Uddin'),
  'the name box offers the saved customer as a suggestion');

console.log('\n--- a brand new name is flagged, not silently added ---');
newMemo();
el('customerName').value = 'Notun Chele';
memoCustomerCheck();
ok(el('memoCustHint').innerHTML.includes('New customer'),
  'an unknown name is announced as a new customer');

console.log('\n--- a parcel comes back: stock goes up again ---');
/* Sell 10, so 10 leave the shelf, then return 4. */
db = blankDB();
const card = stockOf(p1.id);
card.opening = 30;
card.available = stockAvailable(card);
eq(card.available, 30, '30 on the shelf before selling');

nav('memo');
el('customerName').value = 'Karim';
el('customerPhone').value = '';
memoDraft = { items: [{ productId: p1.id, qty: 10, rate: 220, cost: 165, vat: 0 }] };
saveMemo();
const memo = db.memos[db.memos.length - 1];
eq(stockOf(p1.id).available, 20, 'selling 10 of 30 leaves 20');

ok(typeof pendingQtyOf(memo) === 'number', 'pending qty is computed from the memo');
eq(pendingQtyOf(memo), 10, 'nothing delivered or returned yet, so all 10 are pending');

/* Enter the return through the real modal path. */
openReturn(memo.id);
ok(el('returnModal').classList.contains('show'), 'the return modal opens');
eq(num(el('rtQty').value), 10, 'the return box defaults to the whole pending qty');
eq(num(el('rtLine0').value), 10, 'the per-product box follows the total');

el('rtQty').value = 4;
returnQtyChanged();
eq(num(el('rtLine0').value), 4, 'typing 4 as the total puts 4 on the product line');
el('rtCondition').value = 'good';
el('rtNote').value = 'Customer firiye diyeche';
saveReturn();

const ret = db.returns[db.returns.length - 1];
ok(!!ret, 'the return was saved as its own record');
eq(ret.qty, 4, 'return qty 4');
eq(ret.condition, 'good', 'condition remembered');
eq(stockOf(p1.id).available, 24, '4 returned goods are back on the shelf (20 + 4)');
eq(pendingQtyOf(memo), 6, 'pending drops to 6 - a return is no longer with the customer');

console.log('\n--- the return shows up on the Delivery page ---');
nav('delivery');
ok(el('returnTable').innerHTML.includes('Customer firiye diyeche'), 'the return list shows the note');
ok(el('returnTable').innerHTML.includes('Good'), 'the return list shows the condition');
ok(el('deliveryTable').innerHTML.includes('>4<'), 'the delivery table shows the returned qty');

console.log('\n--- a damaged return must NOT become sellable stock ---');
const before = stockOf(p1.id).available;
openReturn(memo.id);
el('rtQty').value = 2;
returnQtyChanged();
el('rtCondition').value = 'damaged';
saveReturn();
eq(stockOf(p1.id).available, before, 'damaged goods do not raise available');
eq(pendingQtyOf(memo), 4, 'but the damaged parcel is still no longer with the customer');

console.log('\n--- deleting a return puts the stock back where it was ---');
const availBefore = stockOf(p1.id).available;
const good = db.returns.find(r => r.condition === 'good');
deleteReturn(good.id);
eq(stockOf(p1.id).available, availBefore - good.qty, 'undoing a good return takes the goods back off the shelf');
ok(!db.returns.some(r => r.id === good.id), 'the return record is gone');

console.log('\n--- delivery and return cannot add up to more than was sold ---');
db = blankDB();
stockOf(p1.id).opening = 100;
nav('memo');
el('customerName').value = 'Limit Test';
memoDraft = { items: [{ productId: p1.id, qty: 10, rate: 100, cost: 60, vat: 0 }] };
saveMemo();
const lim = db.memos[db.memos.length - 1];

/* Deliver 7, then try to return the whole 10. */
openDelivery(lim.id);
el('dlQty').value = 7;
el('dlDriver').value = 'Rahim';
saveDelivery();
eq(pendingQtyOf(lim), 3, '7 delivered leaves 3 pending');

openReturn(lim.id);
eq(num(el('rtQty').value), 3, 'the return box is capped at what is still pending');
el('rtQty').value = 9;
returnQtyChanged();
el('rtCondition').value = 'good';
triggers.alert.length = 0;
saveReturn();
ok(triggers.alert.some(a => a.includes('cannot exceed')),
  'returning more than pending is refused, not silently accepted');
eq(db.returns.length, 0, 'nothing was written for the refused return');

console.log('\n--- memo edit keeps delivery/return history honest ---');
/* Shrinking a memo below what already went out must ask first, and a refused edit
   must leave the memo untouched. */
openReturn(lim.id);
el('rtQty').value = 3;
returnQtyChanged();
el('rtCondition').value = 'good';
saveReturn();
eq(pendingQtyOf(lim), 0, 'the rest came back, nothing pending');

triggers.confirm = false;
editMemo(lim.id);
memoDraft = { items: [{ productId: p1.id, qty: 2, rate: 100, cost: 60, vat: 0 }] };
el('customerName').value = 'Limit Test';
triggers.alert.length = 0;
saveMemo();
eq(db.memos.find(m => m.id === lim.id).totalQty, 10, 'a refused edit leaves the memo as it was');

triggers.confirm = true;
editMemo(lim.id);
memoDraft = { items: [{ productId: p1.id, qty: 2, rate: 100, cost: 60, vat: 0 }] };
el('customerName').value = 'Limit Test';
saveMemo();
eq(db.memos.find(m => m.id === lim.id).totalQty, 2, 'a confirmed edit saves the smaller memo');
ok(db.returns.some(r => r.memoId === lim.id), 'the return records survive the memo edit');

console.log('\n--- deleting a memo that had a return must restore stock exactly ---');
/* Regression: reverseSaleFromStock used Math.max(0, ...) on `sold`. Reversing a memo
   takes the whole memo qty out of `sold`, and the return's own entry then adds its
   share back - so `sold` legitimately dips below zero mid-transaction. The clamp
   swallowed the difference, leaving the shop short by the returned qty, and the
   number jumped again after a sync because rebaseStockFromLedger does not clamp.
   The invariant: once the memo and its return are both gone, stock is exactly what
   it was before the memo existed. */
const regProd = db.products[1];
nav('stock');
el('stockProduct').value = regProd.id;
el('stockAddQty').value = '150';
el('stockCost').value = '165';
addStockPurchase();
const baseAvail = num(findStock(regProd.id).available);
const baseSold = num(findStock(regProd.id).sold);
eq(baseAvail, 150, 'starting point: 150 on the shelf, nothing sold');

nav('memo');
newMemo();
el('customerName').value = 'Delete Regression';
el('customerPhone').value = '';
memoDraft = { items: [{ productId: regProd.id, qty: 20, rate: 220, cost: 165, vat: 0 }] };
saveMemo();
const regMemo = db.memos.find(m => m.customerName === 'Delete Regression');
eq(num(findStock(regProd.id).available), baseAvail - 20, 'the memo took 20 off the shelf');

openReturn(regMemo.id);
el('rtLine0').value = '5';
el('rtCondition').value = 'good';
saveReturn();
eq(num(findStock(regProd.id).available), baseAvail - 15, 'the 5 returned came back on the shelf');

triggers.alert.length = 0;
deleteMemo(regMemo.id);
eq(num(findStock(regProd.id).available), baseAvail,
  'deleting the memo frees its whole 20, so stock is back to what it was before the memo');
eq(num(findStock(regProd.id).sold), baseSold,
  'the sold counter settles back where it started, not above it');
ok(!db.memos.some(m => m.id === regMemo.id), 'the memo is gone');
ok(!(db.returns || []).some(r => r.memoId === regMemo.id), 'its return records went with it');

/* The same clamp also ran on the edit path, where the memo is reversed and re-applied
   without the returns being touched. Re-saving a memo unchanged must not move stock. */
nav('memo');
newMemo();
el('customerName').value = 'Edit Regression';
memoDraft = { items: [{ productId: regProd.id, qty: 20, rate: 220, cost: 165, vat: 0 }] };
saveMemo();
const editRegMemo = db.memos.find(m => m.customerName === 'Edit Regression');
openReturn(editRegMemo.id);
el('rtLine0').value = '5';
el('rtCondition').value = 'good';
saveReturn();
const afterReturn = num(findStock(regProd.id).available);
editMemo(editRegMemo.id);
memoDraft = { items: [{ productId: regProd.id, qty: 20, rate: 220, cost: 165, vat: 0 }] };
el('customerName').value = 'Edit Regression';
saveMemo();
eq(num(findStock(regProd.id).available), afterReturn,
  're-saving a memo at the same qty leaves stock untouched');
editMemo(editRegMemo.id);
memoDraft = { items: [{ productId: regProd.id, qty: 18, rate: 220, cost: 165, vat: 0 }] };
el('customerName').value = 'Edit Regression';
saveMemo();
eq(num(findStock(regProd.id).available), afterReturn + 2,
  'shrinking the memo by 2 puts exactly 2 back');
triggers.alert.length = 0;
deleteMemo(editRegMemo.id);
eq(num(findStock(regProd.id).available), baseAvail,
  'and deleting that memo returns stock to the starting point');

/* The card and the ledger it is rebuilt from must agree. The old clamp made them
   disagree, so a sync (which calls rebaseStockFromLedger) silently changed the
   number the owner had just been looking at. */
nav('memo');
newMemo();
el('customerName').value = 'Rebase Check';
memoDraft = { items: [{ productId: regProd.id, qty: 30, rate: 220, cost: 165, vat: 0 }] };
saveMemo();
const rebMemo = db.memos.find(m => m.customerName === 'Rebase Check');
openReturn(rebMemo.id);
el('rtLine0').value = '7';
el('rtCondition').value = 'good';
saveReturn();
const beforeRebase = num(findStock(regProd.id).available);
const soldBeforeRebase = num(findStock(regProd.id).sold);
rebaseStockFromLedger();
eq(num(findStock(regProd.id).available), beforeRebase,
  'a sync does not change available - the card and the ledger agree');
eq(num(findStock(regProd.id).sold), soldBeforeRebase,
  'and they agree on the sold counter too');

console.log('\n--- a return takes the money off the memo, full and partial ---');
/* The owner's complaint: a parcel (full or partial) came back but the money was not
   deducted. A return is goods the shop holds again, so the customer cannot still owe
   for them. Drives the real openReturn/saveReturn path. */
db = blankDB();
const rp = db.products[0];
stockOf(rp.id).opening = 100;
function saleFor(name, qty) {
  nav('memo');
  newMemo();
  el('customerName').value = name;
  el('customerPhone').value = '';
  memoDraft = { items: [{ productId: rp.id, qty: qty, rate: 100, cost: 60, vat: 0 }] };
  saveMemo();
  return db.memos[db.memos.length - 1];
}

/* Full return of an undelivered memo: the whole charge drops. */
const full = saleFor('Full Return', 10);
eq(memoRemainingDue(full), 1000, 'a fresh 1000 memo owes 1000');
openReturn(full.id);
el('rtQty').value = 10;
returnQtyChanged();
el('rtCondition').value = 'good';
saveReturn();
eq(memoRemainingDue(full), 0, 'a full return clears the whole 1000 charge');
eq(totalReceivable(), 0, 'and the dashboard receivable drops to 0');

/* Partial return: only the returned pieces come off, the kept goods still count. */
const part = saleFor('Partial Return', 10);
openReturn(part.id);
el('rtQty').value = 4;
returnQtyChanged();
el('rtCondition').value = 'good';
saveReturn();
eq(memoRemainingDue(part), 600, 'a 4-of-10 return leaves 600 of the 1000 owed');
eq(totalReceivable(), 600, 'the dashboard agrees with the memo');
const partCust = db.customers.find(c => c.name === 'Partial Return');
eq(customerDue(partCust).due, 600, 'the customer ledger shows the reduced 600, not 1000');

/* Deleting the return puts the money back where it was. */
deleteReturn(db.returns.find(r => r.memoId === part.id).id);
eq(memoRemainingDue(part), 1000, 'undoing the return restores the full charge');

/* A memo already delivered and collected, then partly returned: due never goes
   negative, and no money is counted against goods that came back. */
const paid = saleFor('Paid Then Return', 10);
openDelivery(paid.id);
el('dlQty').value = 10;
el('dlCollect').value = 1000;
el('dlDriver').value = 'Jamal';
saveDelivery();
eq(memoRemainingDue(paid), 0, 'fully delivered and collected, nothing owed');
openReturn(paid.id);
el('rtQty').value = 4;
returnQtyChanged();
el('rtCondition').value = 'good';
saveReturn();
eq(memoRemainingDue(paid), 0, 'a later return never pushes the due below zero');
eq(customerDue(db.customers.find(c => c.name === 'Paid Then Return')).due, 0,
  'and the customer ledger stays at zero, not negative');

/* The profit report must not call a returned parcel a sale. Isolated so the figure
   is the one memo's contribution, not the sum of every memo the section created. */
db = blankDB();
stockOf(db.products[0].id).opening = 100;
const plMemo = saleFor('P&L Return', 10);
eq(plSummary(today(), today()).sales, 1000, 'P&L counts the full 1000 before any return');
openReturn(plMemo.id);
el('rtQty').value = 5;
returnQtyChanged();
el('rtCondition').value = 'good';
saveReturn();
eq(plSummary(today(), today()).sales, 500, 'P&L drops to the 500 of goods kept, not the full sale');
eq(plSummary(today(), today()).grossProfit, 200, 'and profit drops with it (300 to 200)');

console.log('\n--- returns sync to the sheet ---');
const syncSrc = fs.readFileSync(path.join(root, 'js', 'sync.js'), 'utf8');
ok(/function pushRecord|function syncPush/.test(syncSrc), 'the push path exists for a return');
/* Code.gs is build output too - build.js copies it from texpark-pro/, so read the
   source or the test would pass against a file the next build overwrites. */
const gsSrc = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
ok(/returns: 'Returns'/.test(gsSrc), 'the sheet has a Returns tab');
ok(/saveReturn_/.test(gsSrc), 'the sheet can save a return row');
ok(/'returns'/.test(fs.readFileSync(path.join(root, 'js', 'db.js'), 'utf8')),
  'returns take part in the cloud merge, so they are not lost on another device');

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
console.log('=================');
process.exit(fail ? 1 : 0);
