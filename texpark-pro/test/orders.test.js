/* Order Command Center: the lifecycle, the delivery calendar, reminders and the
   priority list, driven through the REAL app.js against a DOM shim so the board a
   person sees is the one that is tested. The pure rules (overdue, urgency,
   reminders) are checked directly as well, because they are what the dashboard
   tiles, the calendar and the tests all agree on.

   Run: node test/orders.test.js */

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
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

el('loginUser').value = 'admin';
el('loginPass').value = 'admin123';
doLogin();

const T = today();
function mkOrder(over) {
  return Object.assign({
    id: id(), orderNo: 'TP-0001', orderDate: T, customerName: 'Karim', phone: '017',
    productName: 'T-shirt', qty: 10, deliveryDate: addDays_(T, 2), status: 'received',
    priority: 'normal', remindLeadDays: null, note: ''
  }, over || {});
}

console.log('\n=== orders: the data model lands in the collections and role perms ===');
eq(typeof db.orders, 'object', 'orders collection exists on a fresh db');
ok(Array.isArray(db.orders), 'orders is an array');
ok(MERGE_KEYS.indexOf('orders') !== -1, 'orders travels in the sync merge');
ok(can === undefined || PERMS.admin.indexOf('orders') !== -1, 'admin may open Orders');
ok(PERMS.salesman.indexOf('orders') !== -1, 'salesman may open Orders');
ok(PERMS.accountant.indexOf('orders') !== -1, 'accountant may open Orders');

console.log('\n=== orders: overdue is derived from the date, never stored stale ===');
const overdue = mkOrder({ id: 'o1', orderNo: 'TP-0002', deliveryDate: addDays_(T, -3) });
const dueToday = mkOrder({ id: 'o2', orderNo: 'TP-0003', deliveryDate: T });
const future = mkOrder({ id: 'o3', orderNo: 'TP-0004', deliveryDate: addDays_(T, 5) });
const delivered = mkOrder({ id: 'o4', orderNo: 'TP-0005', deliveryDate: addDays_(T, -9), status: 'delivered' });
db.orders = [overdue, dueToday, future, delivered];
ok(isOrderOverdue(overdue, T), 'a past delivery date on an active order is overdue');
ok(!isOrderOverdue(delivered, T), 'a delivered order is never overdue, however old');
ok(!isOrderOverdue(dueToday, T), 'due today is not overdue');
eq(orderDaysLate_(overdue, T), 3, 'days late counts the calendar difference');
eq(orderDisplayStatus(overdue, T), 'overdue', 'display status turns overdue');
eq(orderDisplayStatus(future, T), 'received', 'a future order keeps its stored status');

console.log('\n=== orders: dashboard summary counts active, upcoming, overdue, ready ===');
db.orders = [overdue, dueToday, future, delivered, mkOrder({ id: 'o5', orderNo: 'TP-0006', status: 'ready', deliveryDate: addDays_(T, 1) })];
const sum = orderSummary(T);
eq(sum.active, 4, 'four active orders (delivered excluded)');
eq(sum.overdue, 1, 'one overdue');
eq(sum.upcoming7, 3, 'due today + two within a week');
eq(sum.ready, 1, 'one ready to deliver');

console.log('\n=== orders: urgency puts overdue first, then soonest ===');
const sorted = ordersByUrgency(T).map(o => o.orderNo);
eq(sorted[0], 'TP-0002', 'the overdue order leads the list');
ok(sorted.indexOf('TP-0003') < sorted.indexOf('TP-0004'), 'due-today sorts before next week');

console.log('\n=== orders: reminders fire on lead time, dispatch day and overdue ===');
const lead3 = mkOrder({ id: 'r1', orderNo: 'TP-0010', deliveryDate: addDays_(T, 2), remindLeadDays: 3, status: 'in_progress' });
const rem = orderRemindersFor(lead3, T);
eq(rem.filter(r => r.kind === 'prep').length, 1, 'a preparation reminder is due inside the lead window');
eq(orderRemindersFor(lead3, T).filter(r => r.kind === 'dispatch').length, 0, 'no dispatch reminder before the day');
const onDay = orderRemindersFor(mkOrder({ id: 'r2', orderNo: 'TP-0011', deliveryDate: T }), T).map(r => r.kind);
ok(onDay.indexOf('dispatch') !== -1, 'a dispatch reminder fires on the delivery day');
ok(onDay.indexOf('prep') !== -1, 'the default one-day lead also fires on the day');
ok(orderRemindersFor(overdue, T).some(r => r.kind === 'overdue'), 'an overdue order gets an overdue reminder');
eq(orderRemindersFor(delivered, T).length, 0, 'a delivered order gets no reminders');

console.log('\n=== orders: the sheet of a new order is saved, numbered and pushed ===');
db.orders = [];
eq(nextOrderNo(), 'TP-0001', 'the first order number is TP-0001');
openOrder();
el('ordCustomer').value = 'Rahim';
el('ordPhone').value = '01911';
el('ordProduct').value = 'Pant';
el('ordQty').value = '24';
el('ordDeliveryDate').value = addDays_(T, 4);
el('ordPriority').value = 'urgent';
el('ordStatus').value = 'received';
triggers.alert.length = 0;
saveOrder();
eq(db.orders.length, 1, 'one order saved');
eq(db.orders[0].customerName, 'Rahim', 'customer name kept');
eq(db.orders[0].priority, 'urgent', 'priority kept');
eq(db.orders[0].orderNo, 'TP-0001', 'the generated number was kept');
ok(Array.isArray(db.orders[0].history) && db.orders[0].history.length === 1, 'creation is written to history');
eq(nextOrderNo(), 'TP-0002', 'the next number increments');

console.log('\n--- validation keeps a half-filled order out of the book ---');
openOrder();
el('ordCustomer').value = '';
el('ordProduct').value = '';
el('ordDeliveryDate').value = '';
triggers.alert.length = 0;
saveOrder();
eq(db.orders.length, 1, 'an order with no customer is rejected');
ok(triggers.alert.length >= 1, 'the rejection tells the user why');

console.log('\n=== orders: a status move is recorded and survives a reload ===');
const saved = db.orders[0];
setOrderStatus(saved.id, 'ready');
eq(saved.status, 'ready', 'status moved to ready');
ok(saved.history.some(h => /ready/i.test(h.text)), 'the move is written to history');
const reloaded = JSON.parse(fakeStore['texpark_pro_v2']);
const reloadedOrder = reloaded.orders.find(o => o.id === saved.id);
ok(!!reloadedOrder && reloadedOrder.status === 'ready', 'the order persisted with its new status');

console.log('\n=== orders: the board, calendar and priority list render the real orders ===');
db.orders = [overdue, dueToday, future, delivered];
renderOrders();
ok(el('ordBoard').innerHTML.indexOf('TP-0002') !== -1, 'the board shows the overdue order');
ok(el('ordBoard').innerHTML.indexOf('TP-0005') !== -1, 'the board shows the delivered order too');
ok(el('ordBoard').innerHTML.indexOf('badge overdue') !== -1, 'the overdue order carries the overdue badge');
ok(el('ordAttention').innerHTML.indexOf('TP-0002') !== -1, 'the priority list surfaces the overdue order');
ok(el('ordAttention').innerHTML.indexOf('OVERDUE') !== -1, 'the priority list says OVERDUE');
ok(el('ordReminders').innerHTML.indexOf('Overdue') !== -1, 'the reminder center shows the overdue alert');
ok(el('ordSummary').innerHTML.indexOf('Active Orders') !== -1, 'the summary tiles render on the Orders page');

console.log('\n--- the calendar shows a month and a pick reveals that day ---');
orderCalMonth = T.slice(0, 7);
ordCalPickDate(T);
renderOrderCalendar();
ok(el('ordCalendar').innerHTML.indexOf('cday') !== -1, 'the calendar builds day cells');
ok(el('ordCalDay').innerHTML.indexOf('TP-0003') !== -1, 'picking today lists the order due today');
const nextMonth = new Date(T.slice(0, 7) + '-01T00:00:00Z');
ordCalShift(1);
const nm = nextMonth.toISOString().slice(0, 7);
ok(orderCalMonth > T.slice(0, 7), 'Next moves the calendar forward a month');

console.log('\n--- the dashboard banner uses the same summary ===');
renderDashboard();
ok(el('dashOrderSummary').innerHTML.indexOf('Overdue Orders') !== -1, 'the dashboard shows the order summary tiles');

console.log('\n=== orders: a device merge keeps the newest version and adds unknown ones ===');
const dev1 = { orders: [ { id: 'x1', orderNo: 'TP-0001', status: 'received', at: '2026-01-01T00:00:00Z', customerName: 'A' } ], products: [], customers: [], suppliers: [], stock: [], ledger: [], purchases: [], expenses: [], memos: [], deliveries: [], returns: [], payments: [], users: [] };
const dev2 = { orders: [
  { id: 'x1', orderNo: 'TP-0001', status: 'ready', at: '2026-02-01T00:00:00Z', customerName: 'A' },
  { id: 'x2', orderNo: 'TP-0002', status: 'received', at: '2026-02-01T00:00:00Z', customerName: 'B' }
], products: [], customers: [], suppliers: [], stock: [], ledger: [], purchases: [], expenses: [], memos: [], deliveries: [], returns: [], payments: [], users: [] };
mergeRecsInto_(dev1, dev2);
eq(dev1.orders.length, 2, 'the merge added the order the first device had never seen');
eq(dev1.orders.find(o => o.id === 'x1').status, 'ready', 'the newer status won');

console.log('\n' + (fail ? 'FAILED ' + fail : 'All ' + pass + ' order checks passed') + ' (' + pass + ' passed, ' + fail + ' failed)');
process.exit(fail ? 1 : 0);
