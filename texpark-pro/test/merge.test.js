/* Multi-device merge test. Run: node test/merge.test.js

   The whole point of the auto-pull is that the PC and the phone can both be
   edited offline and neither loses the other's work. That is a claim about two
   databases, so it is tested as one: two real db.js instances, each with its own
   localStorage, synced through the real merge path. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}
function eq(a, b, label) { ok(a === b, label + '  (got ' + a + ', want ' + b + ')'); }

/* A fresh copy of the real db.js + sync.js over its own private localStorage.
   js/app.js is deliberately absent: it needs a DOM, and nothing here is a UI
   question. */
function makeDevice(name) {
  const store = {};
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  const sandbox = {
    localStorage,
    console,
    alert() {},
    confirm: () => true,
    document: { getElementById: () => null, addEventListener() {} },
    navigator: { userAgent: name === 'PH' ? 'Android Mobile' : 'Mozilla/5.0' },
    setTimeout, clearTimeout, fetch: undefined,
    APP_VERSION: 'test'
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['js/db.js', 'js/sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  sandbox.db = sandbox.blankDB();
  sandbox.db.settings.deviceTag = name;
  sandbox.lastCommitted = sandbox.indexRecs_(sandbox.db);
  return sandbox;
}

/* What the device would upload: exactly what cloudBackupNow puts in the sheet. */
function snapshotOf(dev) { return JSON.parse(JSON.stringify(dev.db)); }

function addMemo(dev, memoNo, name, qty, rate) {
  const p = dev.db.products[0];
  const memo = {
    id: 'm-' + memoNo, memoNo, date: dev.today(), customerName: name,
    items: [{ productId: p.id, productName: p.name, qty, rate, cost: 100, vat: 0, amount: qty * rate }],
    totalQty: qty, subtotal: qty * rate, discount: 0, deliveryCharge: 0, vat: 0,
    grandTotal: qty * rate, advance: 0, due: qty * rate, cogs: qty * 100,
    profit: qty * (rate - 100), savedAt: new Date().toISOString()
  };
  dev.db.memos.push(memo);
  dev.applySaleToStock(memo);
  dev.commit();
  return memo;
}

/* ------------------------------ PC and phone both write ------------------------------ */
console.log('\n--- two devices, no contact ---');
const pc = makeDevice('PC');
const ph = makeDevice('PH');
const pcMemo = addMemo(pc, 'TXP/SM/1-PC001', 'PC Customer', 2, 220);
const phMemo = addMemo(ph, 'TXP/SM/1-PH001', 'Phone Customer', 3, 250);

eq(pc.db.memos.length, 1, 'PC has its own memo');
eq(ph.db.memos.length, 1, 'phone has its own memo');
ok(pcMemo.at, 'the PC memo carries a change stamp');
ok(phMemo.at, 'the phone memo carries a change stamp');

/* ------------------------------ merge both ways ------------------------------ */
console.log('\n--- the phone pulls the PC ---');
ph.mergeCloudInto_(snapshotOf(pc));
ph.commit();
eq(ph.db.memos.length, 2, 'phone now has both memos - its own survived the merge');
ok(ph.db.memos.some(m => m.memoNo === 'TXP/SM/1-PC001'), 'the PC memo arrived');
ok(ph.db.memos.some(m => m.memoNo === 'TXP/SM/1-PH001'), 'the phone memo was not overwritten');

console.log('\n--- and the PC pulls the phone ---');
pc.mergeCloudInto_(snapshotOf(ph));
pc.commit();
eq(pc.db.memos.length, 2, 'PC has both memos too');
ok(pc.db.memos.some(m => m.memoNo === 'TXP/SM/1-PH001'), 'the phone memo arrived on the PC');

/* Merging twice must not duplicate anything - the pull runs on every open. */
console.log('\n--- merging again changes nothing ---');
pc.mergeCloudInto_(snapshotOf(ph));
pc.commit();
eq(pc.db.memos.length, 2, 'still two memos after a second merge');
eq(pc.db.memos.filter(m => m.memoNo === 'TXP/SM/1-PH001').length, 1, 'the phone memo was not duplicated');

/* ------------------------------ edit vs edit ------------------------------ */
console.log('\n--- the same memo edited on both devices ---');
const shared = addMemo(pc, 'TXP/SM/1-SHARED', 'Original', 1, 100);
shared.customerName = 'Edited on PC later';
shared.at = '2099-01-01T00:00:00.000Z';       // the later edit
pc.commit();
const onPhone = JSON.parse(JSON.stringify(shared));
onPhone.customerName = 'Edited on phone earlier';
onPhone.at = '2000-01-01T00:00:00.000Z';
ph.db.memos.push(onPhone);
ph.commit();

ph.mergeCloudInto_(snapshotOf(pc));
ph.commit();
const winner = ph.db.memos.find(m => m.memoNo === 'TXP/SM/1-SHARED');
eq(winner.customerName, 'Edited on PC later', 'the newer edit wins, whichever device merges');
eq(ph.db.memos.filter(m => m.memoNo === 'TXP/SM/1-SHARED').length, 1, 'still one copy of the memo');

/* ------------------------------ delete sticks ------------------------------ */
console.log('\n--- a memo deleted on the PC stays deleted ---');
addMemo(ph, 'TXP/SM/1-DOOMED', 'Delete me', 1, 100);
const doomed = ph.db.memos.find(m => m.memoNo === 'TXP/SM/1-DOOMED');
ph.commit();
/* The PC receives it, then deletes it, as the owner would. */
pc.mergeCloudInto_(snapshotOf(ph));
pc.commit();
ok(pc.db.memos.some(m => m.memoNo === 'TXP/SM/1-DOOMED'), 'the PC has it before deleting');
pc.db.memos = pc.db.memos.filter(m => m.id !== doomed.id);
pc.commit();
ok(pc.db.tombstones.some(t => t.id === doomed.id), 'the delete left a tombstone');

/* The phone still remembers the memo and offers it back. It must not return. */
pc.mergeCloudInto_(snapshotOf(ph));
pc.commit();
ok(!pc.db.memos.some(m => m.memoNo === 'TXP/SM/1-DOOMED'), 'the deleted memo was not resurrected from the phone');
ok(pc.db.tombstones.some(t => t.id === doomed.id), 'the tombstone survived the merge');

/* And the phone, pulling the tombstone, deletes it too. */
ph.mergeCloudInto_(snapshotOf(pc));
ph.commit();
ok(!ph.db.memos.some(m => m.memoNo === 'TXP/SM/1-DOOMED'), 'the phone honoured the other device\u2019s delete');

/* ------------------------------ stock follows the memos ------------------------------ */
console.log('\n--- stock is rebuilt from the ledger, not summed twice ---');
pc.rebaseStockFromLedger();
const pcCard = pc.db.stock.find(s => s.productId === pc.db.products[0].id);
eq(pc.db.stock.filter(s => s.productId === pc.db.products[0].id).length, 1, 'one stock card per product after a merge, not one per device');
/* Sales minus returns: a deleted memo leaves both its original Sale and the
   SaleReturn that undid it, so a raw sale count overstates what went out. */
const soldFromLedger = pc.db.ledger
  .filter(l => l.productId === pc.db.products[0].id)
  .reduce((a, l) => a + (l.type === 'Sale' ? Math.abs(pc.num(l.qty)) : l.type === 'SaleReturn' ? -Math.abs(pc.num(l.qty)) : 0), 0);
eq(pcCard.sold, soldFromLedger, 'sold matches the net movements in the ledger');
ok(pcCard.available >= 0, 'available never goes negative');
/* Deleting the memo released its sale, and the stock must reflect that. */
ok(!pc.db.memos.some(m => m.id === doomed.id), 'the doomed memo is gone before the stock check');

console.log('\n--- a memo still saves with no stock at all ---');
const bare = makeDevice('PH2');
const p = bare.db.products[0];
const shortMemo = {
  id: 'm-short', memoNo: 'TXP/SM/1-SHORT', date: bare.today(), customerName: 'No stock',
  items: [{ productId: p.id, productName: p.name, qty: 50, rate: 220, cost: 100, vat: 0, amount: 11000 }],
  totalQty: 50, subtotal: 11000, discount: 0, deliveryCharge: 0, vat: 0,
  grandTotal: 11000, advance: 0, due: 11000, cogs: 5000, profit: 6000
};
bare.db.memos.push(shortMemo);
bare.applySaleToStock(shortMemo);
ok(bare.commit(), 'the memo committed even though stock was never entered');
eq(bare.db.memos.length, 1, 'the memo is there');
eq(bare.db.stock.find(s => s.productId === p.id).available, 0, 'stock shows 0, not a negative number');
ok(bare.stockShort(bare.db.stock.find(s => s.productId === p.id)) === 50, 'the shortfall is still visible as "to be entered"');

/* Merging an identical snapshot must not bump the stamps. If it did, each device
   would restamp every record on every open and push it, and the other device would
   stamp it back - a ping-pong that never settles and rewrites the whole database
   on each launch. */
console.log('\n--- merging an identical snapshot is a no-op ---');
addMemo(pc, 'TXP/SM/1-STEADY', 'Steady', 1, 100);
pc.commit();
ph.mergeCloudInto_(snapshotOf(pc));
ph.commit();
const steadyId = pc.db.memos.find(m => m.memoNo === 'TXP/SM/1-STEADY').id;
const stampBefore = ph.db.memos.find(m => m.id === steadyId).at;
ph.mergeCloudInto_(snapshotOf(pc));
ph.commit();
eq(ph.db.memos.find(m => m.id === steadyId).at, stampBefore, 'the merge left the stamp alone');
pc.mergeCloudInto_(snapshotOf(ph));
pc.commit();
eq(pc.db.memos.find(m => m.id === steadyId).at, stampBefore, 'and the other direction does too');

console.log('\n--- an install from before the stable seed ids is adopted, not duplicated ---');
/* No code change here: this is what an existing phone carries - the three starter
   products with the random ids they were created with. After migrate() they must
   carry the shared ids, or the first sync with a second device shows six rows for
   three products. */
const old = makeDevice('PH3');
old.db.products = [
  { id: 'a1b2c3d4', name: 'Kids 3pcs Set', sku: 'K3S', category: 'Kids', unit: 'pcs', rate: 220, cost: 165, vat: 0, reorderLevel: 10 },
  { id: 'e5f6g7h8', name: 'Kids Girls Sweater', sku: 'KGS', category: 'Kids', unit: 'pcs', rate: 145, cost: 108, vat: 0, reorderLevel: 10 }
];
old.db.memos.push({
  id: 'm-old', memoNo: 'OLD-1', date: old.today(), customerName: 'Old Customer',
  items: [{ productId: 'a1b2c3d4', productName: 'Kids 3pcs Set', qty: 2, rate: 220, cost: 165, vat: 0, amount: 440 }],
  totalQty: 2, subtotal: 440, discount: 0, deliveryCharge: 0, vat: 0, grandTotal: 440, advance: 0, due: 440, cogs: 330, profit: 110
});
old.db.stock.push({ id: 'st1', productId: 'a1b2c3d4', opening: 10, purchased: 0, sold: 2, available: 8, cost: 165 });
old.db.ledger.push({ id: 'l1', at: '2026-01-01T00:00:00.000Z', date: '2026-01-01', productId: 'a1b2c3d4', type: 'Sale', qty: -2, balance: 8, ref: 'OLD-1', note: '' });
old.db = old.migrate(old.db);
const k3s = old.db.products.find(p => p.sku === 'K3S');
eq(k3s.id, 'seed-k3s', 'the untouched starter row took the shared id');
eq(old.db.memos[0].items[0].productId, 'seed-k3s', 'the memo item follows it, so the sale is not orphaned');
eq(old.db.stock[0].productId, 'seed-k3s', 'so does the stock card');
eq(old.db.ledger[0].productId, 'seed-k3s', 'and the ledger entry');

console.log('\n--- an edited product keeps its own id ---');
const edited = makeDevice('PH4');
edited.db.products = [
  { id: 'zzzz', name: 'Kids 3pcs Set', sku: 'K3S', category: 'Kids', unit: 'pcs', rate: 999, cost: 165, vat: 0, reorderLevel: 10 }
];
edited.db = edited.migrate(edited.db);
eq(edited.db.products[0].id, 'zzzz', 'a seed row the owner repriced is not silently renamed');

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
console.log('=================');
process.exit(fail ? 1 : 0);
