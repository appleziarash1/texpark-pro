/* Steadfast courier link: the pure parsing/routing rules, plus the one place a status
   turns into records, driven through the REAL courier.js and app.js against a DOM shim.

   The socket is never touched: courierFetch_ is left alone and the tests inject their
   own `fetchOne`, so what is asserted is exactly the mapping the app would perform.

   Run: node test/courier.test.js */

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
  hidden: false,
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

for (const f of ['db.js', 'sync.js', 'voice.js', 'courier.js', 'app.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(root, 'js', f), 'utf8'), { filename: f });
}
vm.runInThisContext('boot();', { filename: 'boot' });

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

el('loginUser').value = 'admin';
el('loginPass').value = 'admin123';
doLogin();

const T = today();

/* ---------- 1. reading a consignment id out of what the owner pastes ---------- */
eq(extractConsignment_('https://steadfast.com.bd/t/123456'), '123456', 'tracking link → id');
eq(extractConsignment_('https://portal.packzy.com/api/v1/status_by_cid/98765'), '98765', 'api link → id');
eq(extractConsignment_('SC-9A8B7'), 'SC-9A8B7', 'raw tracking code kept');
eq(extractConsignment_('123456'), '123456', 'bare digits kept');
eq(extractConsignment_(''), '', 'empty stays empty');
eq(extractConsignment_('https://example.com/hello'), '', 'unrelated link → no guess');

/* ---------- 2. which endpoint a status check uses ---------- */
const cidOrder = { consignmentId: '123456' };
const trackOrder = { trackingUrl: 'https://steadfast.com.bd/t/AB12CD' };
eq(courierRequestFor_(cidOrder).url.endsWith('/status_by_cid/123456'), true, 'numeric id → status_by_cid');
eq(courierRequestFor_(trackOrder).kind, 'tracking', 'non-numeric → tracking code endpoint');
eq(courierRequestFor_({}), null, 'no id at all → no request');

/* ---------- 3. status parsing, against the shapes Steadfast documents ---------- */
const p1 = parseCourierStatus_({ status: 200, delivery_status: { status: 'delivered', cod_amount: 500 } });
eq(p1.status, 'delivered', 'parses delivered');
eq(p1.cod, 500, 'parses COD amount');
eq(parseCourierStatus_({ status: 401, message: 'Unauthenticated' }).error, 'Unauthenticated', 'api error surfaced');
eq(!!courierRequestFor_({ consignmentId: 'ABC' }), true, 'non-numeric id routes to the tracking endpoint');
eq(!!parseCourierStatus_({ state: 'pending' }).error, true, 'missing status is an error');
eq(courierStatusLabel_('partial_delivered'), 'Partially Delivered', 'label for partial');
eq(courierBaseStatus_('delivered_approval_pending'), 'delivered', 'approval-pending reads as its base');
eq(courierStatusFinal_('delivered_approval_pending'), false, 'approval-pending is not final');
eq(courierStatusFinal_('delivered'), true, 'delivered is final');

/* ---------- 4. what gets polled, and in what order ---------- */
const many = [
  { id: 'a', orderNo: 'A', consignmentId: '1', deliveryDate: addDays_(T, 5), status: 'received' },
  { id: 'b', orderNo: 'B', consignmentId: '2', deliveryDate: addDays_(T, 1), status: 'received' },
  { id: 'c', orderNo: 'C', consignmentId: '3', deliveryDate: addDays_(T, 2), status: 'delivered' },
  { id: 'd', orderNo: 'D', deliveryDate: addDays_(T, 1), status: 'received' },
  { id: 'e', orderNo: 'E', consignmentId: '5', deliveryDate: addDays_(T, 0), status: 'received', courierStatus: 'delivered' }
];
const targets = courierSyncTargets_(many, 8).map(o => o.orderNo);
eq(targets.join(','), 'B,A', 'only unsynced tracked active orders, soonest due first (c delivered, d no id, e already synced excluded)');
eq(courierSyncTargets_(many, 1).length, 1, 'batch cap respected');

/* ---------- 5. a delivered parcel creates the delivery + COD receipt ---------- */
/* Seed a memo with two products so the stock side can be checked too. */
const memo = {
  id: 'm1', memoNo: 'TXP/SM/0001', date: T, customerName: 'Karim', phone: '0171',
  items: [{ productId: 'seed-k3s', productName: 'Kids 3pcs Set', qty: 4, rate: 220, cost: 165, amount: 880 }],
  totalQty: 4, subtotal: 880, discount: 0, deliveryCharge: 0, vat: 0, grandTotal: 880,
  advance: 0, due: 880, cogs: 660, profit: 220, status: 'Saved'
};
db.memos.push(memo);
const ord = {
  id: 'o1', orderNo: 'TP-0001', orderDate: T, customerName: 'Karim', productName: 'Kids 3pcs Set',
  qty: 4, deliveryDate: addDays_(T, 1), status: 'received', priority: 'normal',
  memoId: 'm1', consignmentId: '123456', trackingUrl: 'https://steadfast.com.bd/t/123456'
};
db.orders.push(ord);
commit();

const deliveriesBefore = db.deliveries.length;
const paymentsBefore = db.payments.length;
(async () => {
  const r1 = await courierSyncOrders([ord], async () => ({ status: 'delivered', cod: 880 }));
  eq(r1.checked, 1, 'delivered: one order checked');
  eq(db.orders[0].status, 'delivered', 'order moved to Delivered');
  eq(db.deliveries.length, deliveriesBefore + 1, 'exactly one delivery created');
  eq(num(db.deliveries[db.deliveries.length - 1].qty), 4, 'the whole pending qty is delivered');
  eq(db.payments.length, paymentsBefore + 1, 'COD receipt created');
  eq(num(db.payments[db.payments.length - 1].amount), 880, 'COD taken off the due in full');
  eq(pendingQtyOf(db.memos[0]), 0, 'memo has nothing pending');
  eq(db.orders[0].courierStatus, 'delivered', 'courier status stored on the order');

  /* Re-running must not double-count. */
  const r2 = await courierSyncOrders([db.orders[0]], async () => ({ status: 'delivered', cod: 880 }));
  eq(db.deliveries.length, deliveriesBefore + 1, 're-sync creates no second delivery');
  eq(db.payments.length, paymentsBefore + 1, 're-sync creates no second receipt');

  /* ---------- 6. COD can be turned off ---------- */
  const memo2 = JSON.parse(JSON.stringify(memo));
  memo2.id = 'm2'; memo2.memoNo = 'TXP/SM/0002';
  db.memos.push(memo2);
  db.settings.courierAutoCod = false;
  const ord2 = { id: 'o2', orderNo: 'TP-0002', customerName: 'Rahim', productName: 'Kids 3pcs Set', qty: 4,
    deliveryDate: addDays_(T, 1), status: 'received', memoId: 'm2', consignmentId: '222' };
  db.orders.push(ord2);
  const paysBefore2 = db.payments.length;
  await courierSyncOrders([db.orders[1]], async () => ({ status: 'delivered', cod: 880 }));
  eq(db.payments.length, paysBefore2, 'COD off → no receipt created');
  eq(pendingQtyOf(db.memos[1]), 0, 'but the memo is still delivered');
  db.settings.courierAutoCod = true;

  /* ---------- 7. a returned parcel adds stock (Good) ---------- */
  const memo3 = JSON.parse(JSON.stringify(memo));
  memo3.id = 'm3'; memo3.memoNo = 'TXP/SM/0003';
  db.memos.push(memo3);
  /* Give the stock card sold qty so the return is observable. */
  db.stock.push({ productId: 'seed-k3s', opening: 0, purchased: 10, sold: 4, adjusted: 0, available: 6, cost: 165 });
  const returnsBefore = db.returns.length;
  const ord3 = { id: 'o3', orderNo: 'TP-0003', customerName: 'Jamal', productName: 'Kids 3pcs Set', qty: 4,
    deliveryDate: addDays_(T, 1), status: 'dispatched', memoId: 'm3', consignmentId: '333' };
  db.orders.push(ord3);
  const availBefore = num(db.stock.find(s => s.productId === 'seed-k3s').available);
  await courierSyncOrders([db.orders[2]], async () => ({ status: 'returned', cod: 0 }));
  eq(db.returns.length, returnsBefore + 1, 'returned: one return recorded');
  const ret = db.returns[db.returns.length - 1];
  eq(ret.condition, 'good', 'default condition is Good');
  eq(num(ret.qty), 4, 'returned qty matches what was pending');
  eq(num(db.stock.find(s => s.productId === 'seed-k3s').available), availBefore + 4, 'goods back in available stock');
  eq(pendingQtyOf(db.memos[2]), 0, 'nothing pending after the return');

  /* ---------- 8. errors are collected, not thrown ---------- */
  const ord4 = { id: 'o4', orderNo: 'TP-0004', customerName: 'X', productName: 'Y', qty: 1,
    deliveryDate: T, status: 'received', consignmentId: '444' };
  db.orders.push(ord4);
  const rErr = await courierSyncOrders([ord4], async () => ({ error: 'Steadfast rejected the API key' }));
  eq(rErr.changed, 0, 'a failed check changes nothing');
  eq(/rejected/.test(rErr.lines[0]), true, 'the error reason is reported back');

  /* ---------- 9. the badge on the board ---------- */
  eq(/Delivered/.test(ordCourierBadgeHTML(db.orders[0])), true, 'badge shows Delivered');
  eq(ordCourierBadgeHTML({ status: 'received' }), '', 'no tracking and no status → no badge');

  console.log('\n=================');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})();
