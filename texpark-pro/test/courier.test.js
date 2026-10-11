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

for (const f of ['db.js', 'sync.js', 'voice.js', 'bd-locations.js', 'address.js', 'courier.js', 'app.js']) {
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

  /* ---------- 10. booking: the pure rules ---------- */
  eq(courierInvoiceFor_({ orderNo: 'TP-0001' }), 'TXP-TP-0001', 'invoice is deterministic per order');
  eq(courierInvoiceFor_({ orderNo: 'TP/0001' }), 'TXP-TP-0001', 'invoice sanitizes the order no');
  eq(courierPhoneOk_('01712345678'), true, 'valid phone accepted');
  eq(courierPhoneOk_('0171'), false, 'short phone rejected');
  eq(courierPhoneOk_('02712345678'), false, 'non-01 phone rejected');

  /* The draft comes off the memo the order settles: the order's own fields first,
     then the memo's customer details, then the saved customer. */
  const memoB = {
    id: 'mB', memoNo: 'TXP/SM/0009', date: T, customerName: 'Nasir', customerPhone: '01799999999',
    customerAddress: 'Mirpur, Dhaka', items: [], totalQty: 0, grandTotal: 1200, advance: 200, due: 1000
  };
  db.memos.push(memoB);
  const ordB = { id: 'oB', orderNo: 'TP-0009', customerName: 'Nasir', productName: 'Kids 3pcs Set',
    qty: 2, deliveryDate: T, status: 'received', memoId: 'mB' };
  db.orders.push(ordB);
  const draftB = courierBookingDraft(ordB);
  eq(draftB.name, 'Nasir', 'draft name from the order');
  eq(draftB.phone, '01799999999', 'draft phone from the memo when the order has none');
  eq(draftB.address, 'Mirpur, Dhaka', 'draft address from the memo');
  eq(draftB.cod, 1000, 'draft COD is the memo remaining due');

  const reqB = courierBookRequest_(ordB, draftB);
  eq(reqB.invoice, 'TXP-TP-0009', 'payload invoice');
  eq(reqB.recipient_phone, '01799999999', 'payload phone');
  eq(reqB.cod_amount, 1000, 'payload COD');
  eq(reqB.delivery_type, 0, 'home delivery');

  const bad = courierBookErrors_({ name: 'X', phone: '01799999999', address: '', cod: 0 });
  eq(bad.length, 1, 'missing address is refused');
  eq(/address/i.test(bad[0]), true, 'the reason names the address');

  /* Parsing the reply, in the documented and the error shape. */
  const pb = parseCourierBooking_({ status: 200, consignment: { consignment_id: '987', tracking_code: 'TC9' } });
  eq(pb.consignmentId, '987', 'parses consignment id');
  eq(pb.trackingCode, 'TC9', 'parses tracking code');
  eq(!!parseCourierBooking_({ status: 400, message: 'Invoice already exists' }).error, true, 'duplicate invoice surfaced');
  eq(!!parseCourierBooking_({ status: 200 }).error, true, 'missing consignment id is an error');

  /* ---------- 11. booking: the one place it changes records ---------- */
  const rBook = await courierBookOrder_(ordB, draftB, async () => ({ consignmentId: '555111', trackingCode: 'TC555' }));
  eq(rBook.ok, true, 'booking succeeds');
  eq(ordB.consignmentId, '555111', 'consignment id saved on the order');
  eq(ordB.trackingUrl, 'https://steadfast.com.bd/t/TC555', 'tracking link built from the code');
  eq(ordB.courierStatus, 'pending', 'status starts as pending');
  eq(ordB.history[ordB.history.length - 1].text.indexOf('Booked with Steadfast') === 0, true, 'history records the booking');

  /* After booking, opening the modal must fill the tracking fields from the order,
     so a later Save Order keeps the consignment id rather than re-deriving the code. */
  el('ordId').value = 'oB';
  el('ordConsignment').value = '';
  el('ordTrackingUrl').value = '';
  renderOrderCourier();
  eq(el('ordConsignment').value, '555111', 'modal consignment field synced from the order');
  eq(el('ordTrackingUrl').value, 'https://steadfast.com.bd/t/TC555', 'modal tracking field synced from the order');

  /* A refused call changes nothing: no parcel is recorded on the order. */
  const ordC = { id: 'oC', orderNo: 'TP-0010', customerName: 'Z', productName: 'Y', qty: 1, deliveryDate: T, status: 'received' };
  db.orders.push(ordC);
  const rFail = await courierBookOrder_(ordC, { name: 'Z', phone: '01799999999', address: 'Dhaka', cod: 100, desc: 'Y' },
    async () => ({ error: 'Steadfast refused the booking' }));
  eq(rFail.ok, false, 'a refused booking reports failure');
  eq(ordC.consignmentId, undefined, 'no consignment id on a failed booking');

  /* The Book button refuses a second parcel for an order that already has one. */
  localStorage.setItem('texpark_pro_courier_key', 'k');
  localStorage.setItem('texpark_pro_courier_secret', 's');
  el('ordId').value = 'oB';
  triggers.alert.length = 0;
  bookOrderCourier();
  eq(/already has a parcel/.test(triggers.alert.join(' ')), true, 'Book refuses an order that already has a parcel');

  /* And it refuses a blank address before any request goes out. */
  el('ordId').value = 'oC';
  el('ordBookName').value = 'Z';
  el('ordBookPhone').value = '01799999999';
  el('ordBookAddress').value = '';
  el('ordBookCod').value = '100';
  triggers.alert.length = 0;
  bookOrderCourier();
  eq(/address/i.test(triggers.alert.join(' ')), true, 'Book refuses a blank address');

  /* ---------- address detection (opt-in) never changes the payload ---------- */
  console.log('\n--- offline District / Thana detection ---');
  const addrMemo = { id: 'maddr', memoNo: 'TXP/SM/ADDR', date: T, customerName: 'Rahim',
    customerPhone: '01712345678', customerAddress: 'Shibpur Narsingdi',
    items: [], totalQty: 1, grandTotal: 500, advance: 100, due: 400, cogs: 0, profit: 500 };
  db.memos.push(addrMemo);
  const ordAddr = { id: 'oAddr', orderNo: 'TP-ADDR', memoId: 'maddr', customerName: 'Rahim',
    productName: 'Frock', qty: 1, deliveryDate: T, status: 'received' };
  db.orders.push(ordAddr);

  /* With the feature off, the block renders nothing and booking is not gated. */
  db.settings.courierAddressCheck = false;
  el('ordId').value = 'oAddr';
  _bdSel = { address: '', district: '', thana: '' };
  renderOrderAddressCheck(ordAddr);
  eq(el('ordAddrCheck')._html === '', true, 'feature off -> no detection block');
  let capturedOff = null;
  const offBook = await courierBookOrder_(ordAddr, courierBookingDraft(ordAddr), async p => { capturedOff = p; return { consignmentId: 'OFF1' }; });
  eq(offBook.ok, true, 'feature off -> booking proceeds without a District/Thana choice');
  delete ordAddr.consignmentId; delete ordAddr.courierStatus;

  /* With it on, the resolver fills the selects and the address is untouched. */
  db.settings.courierAddressCheck = true;
  renderOrderCourier();
  eq(el('ordBdDistrict').value, 'Narsingdi', 'detected district shown');
  eq(el('ordBdThana').value, 'Shibpur', 'detected thana shown');
  const st = bdOrderLocationStatus_();
  eq(st.ok, true, 'detection counts as resolved -> not blocked');

  /* A blank/unknown address is blocked before any request goes out. */
  db.orders.push({ id: 'oBad', orderNo: 'TP-BAD', customerName: 'Nobody', productName: 'X', qty: 1, deliveryDate: T, status: 'received' });
  el('ordId').value = 'oBad';
  _bdSel = { address: '', district: '', thana: '' };
  renderOrderCourier();
  eq(bdOrderLocationStatus_().ok, false, 'unknown address -> not resolved');
  let calledBad = false;
  const badBook = await courierBookOrder_({ id: 'oBad', orderNo: 'TP-BAD' },
    { name: 'N', phone: '01712345678', address: 'xyz nowhere', cod: 10, desc: 'X' },
    async () => { calledBad = true; return { consignmentId: 'X' }; });
  eq(badBook.ok, false, 'unresolved address blocks the booking');
  eq(calledBad, false, 'no request is sent when blocked');

  /* The payload keeps the owner's exact address, whatever was detected. */
  el('ordId').value = 'oAddr';
  _bdSel = { address: '', district: '', thana: '' };
  renderOrderCourier();
  /* A real browser re-fills the address input to the draft value on render; the
     DOM shim keeps the value a previous case wrote, so set it explicitly. */
  el('ordBookAddress').value = 'Shibpur Narsingdi';
  const addrDraft = courierDraftFromForm_(ordAddr);
  const addrPayload = courierBookRequest_(ordAddr, addrDraft);
  eq(addrPayload.recipient_address, 'Shibpur Narsingdi', 'payload address is byte-for-byte the original');
  eq(Object.keys(addrPayload).indexOf('district'), -1, 'no district field added to the payload');
  eq(Object.keys(addrPayload).indexOf('thana'), -1, 'no thana field added to the payload');

  /* A manual pick is honoured even when detection disagrees. */
  _bdSel = { address: 'Shibpur Narsingdi', district: 'Narsingdi', thana: 'Palash' };
  renderOrderAddressCheck(ordAddr);
  const picked = bdOrderLocationStatus_();
  eq(picked.district, 'Narsingdi', 'manual district kept');
  eq(picked.thana, 'Palash', 'manual thana kept');
  eq(picked.ok, true, 'a manual pick allows booking');

  console.log('\n=================');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})();
