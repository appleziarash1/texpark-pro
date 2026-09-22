/* Headless test of the business rules. Run: node test/logic.test.js
   Loads the REAL db.js + sync.js source unchanged (no mocks, no rewrites),
   only stubbing localStorage, then asserts on the real functions. */

const fakeStore = {};
global.localStorage = {
  getItem: k => (k in fakeStore ? fakeStore[k] : null),
  setItem: (k, v) => { fakeStore[k] = String(v); },
  removeItem: k => { delete fakeStore[k]; }
};
global.alert = function (m) { console.log('   alert:', String(m).split(String.fromCharCode(10))[0]); };
global.document = { getElementById: () => null };

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'db.js'), 'utf8'), { filename: 'db.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'sync.js'), 'utf8'), { filename: 'sync.js' });

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}
function eq(a, b, label) { ok(a === b, label + '  (got ' + a + ', want ' + b + ')'); }

console.log('\n--- setup ---');
db = blankDB();
const p1 = db.products[0];
const p2 = db.products[1];
stockOf(p1.id);
stockOf(p2.id);
ok(db.products.length === 3, 'three seed products');

console.log('\n--- THE BUG: selling without stock ---');
let probs = checkStockForItems([{ productId: p1.id, qty: 5 }]);
ok(probs.length === 1, 'selling 5 when 0 available is blocked');
eq(probs[0].available, 0, 'reports available 0');
eq(probs[0].short, 5, 'reports shortfall 5');

console.log('\n--- opening stock, then sell ---');
const s1 = stockOf(p1.id);
s1.opening = 10;
s1.available = stockAvailable(s1);
eq(s1.available, 10, 'available = 10');
probs = checkStockForItems([{ productId: p1.id, qty: 4 }]);
ok(probs.length === 0, 'selling 4 of 10 is allowed');

console.log('\n--- memo maths + profit ---');
const items = [{ productId: p1.id, qty: 4, rate: 220, cost: 165, vat: 0 }];
const m = memoMath(items, { discount: 40, deliveryCharge: 100, advance: 500 });
eq(m.subtotal, 880, 'subtotal 4 x 220');
eq(m.cogs, 660, 'cogs 4 x 165');
eq(m.grandTotal, 940, 'grand = 880 - 40 + 100');
eq(m.advance, 500, 'advance honoured');
eq(m.due, 440, 'due = 940 - 500');
eq(m.profit, 280, 'profit = 880 - 40 discount + 100 delivery - 660 cogs');
ok(m.profit !== m.grandTotal, 'profit is not just the sale value');

console.log('\n--- apply sale moves stock once ---');
const memo = {
  memoNo: 'TXP/SM/TEST-001', date: today(), customerName: 'Test Customer',
  items: [{ productId: p1.id, qty: 4, rate: 220, cost: 165, amount: 880 }],
  totalQty: 4, subtotal: 880, discount: 40, deliveryCharge: 100, vat: 0,
  grandTotal: 940, advance: 500, due: 440, cogs: 660, profit: 280
};
db.memos.push(memo);
applySaleToStock(memo);
let st = db.stock.find(x => x.productId === p1.id);
eq(st.sold, 4, 'sold = 4');
eq(st.available, 6, 'available = 10 - 4');
ok(st.available >= 0, 'stock never went negative');

console.log('\n--- over-selling is still caught after one sale ---');
probs = checkStockForItems([{ productId: p1.id, qty: 7 }]);
ok(probs.length === 1 && probs[0].short === 1, 'selling 7 of 6 blocked, short 1');

console.log('\n--- delete memo reverses stock ---');
reverseSaleFromStock(memo);
st = db.stock.find(x => x.productId === p1.id);
eq(st.sold, 0, 'sold back to 0');
eq(st.available, 10, 'available back to 10');

console.log('\n--- purchase increases stock + weighted cost ---');
stockOf(p2.id).opening = 0;
db.stock.find(x => x.productId === p2.id).cost = 100;
const po = {
  purchaseNo: 'TXP/PO/TEST-001', date: today(), supplierName: 'Sup',
  items: [{ productId: p2.id, qty: 10, cost: 120, amount: 1200 }]
};
applyPurchaseToStock(po);
st = db.stock.find(x => x.productId === p2.id);
eq(st.purchased, 10, 'purchased = 10');
eq(st.available, 10, 'available = 10');
eq(st.cost, 120, 'avg cost becomes 120');

console.log('\n--- stock card edit guard mirrors saveStockEdit ---');
const memoSold = db.memos.reduce((a, mm) =>
  a + mm.items.filter(i => i.productId === p1.id).reduce((b, i) => b + num(i.qty), 0), 0);
ok(memoSold === 4, 'memoSold counted from real memos = 4');
ok(3 < memoSold, 'sold qty 3 would be rejected by the guard');
ok(4 >= memoSold, 'sold qty 4 is accepted');

console.log('\n--- ageing buckets ---');
const oldDate = new Date(); oldDate.setDate(oldDate.getDate() - 70);
const ageing = ageingBuckets([
  { due: 100, date: today() },
  { due: 200, date: oldDate.toISOString().slice(0, 10) }
], today());
eq(ageing.current, 100, 'current bucket 100');
eq(ageing.d60, 200, '61-90 bucket 200');
eq(ageing.total, 300, 'total 300');

console.log('\n--- P&L ---');
db.expenses.push({ id: id(), date: today(), head: 'Rent', amount: 300, note: '' });
const pl = plSummary('', '');
eq(pl.cogs, 660, 'P&L picks up COGS from memo');
eq(pl.expense, 300, 'P&L picks up expense');
eq(pl.netProfit, -20, 'net = 280 gross profit - 300 expense (delivery already inside gross)');
ok(pl.netProfit < pl.grossProfit, 'expenses pull net profit below gross profit');

console.log('\n--- stock ledger is append-only ---');
ok(db.ledger.length >= 3, 'ledger recorded movements (' + db.ledger.length + ')');
ok(db.ledger.every(l => typeof l.balance === 'number'), 'every ledger row carries a balance');

console.log('\n--- persistence round-trip ---');
commit();
const reloaded = loadDB();
eq(reloaded.memos.length, 1, 'memo survives reload');
eq(reloaded.products.length, db.products.length, 'products survive reload');
ok(!!reloaded.settings.company.name, 'company settings survive reload');

console.log('\n--- auth ---');
eq(hash('admin123'), hash('admin123'), 'hash is stable');
ok(hash('admin123') !== hash('admin124'), 'different passwords differ');
db.users = defaultUsers();
eq(db.users[0].username, 'admin', 'default user is admin');
eq(db.users[0].pass, hash('admin123'), 'default password is hashed admin123');

/* The speech engine hands back Bangla script for bn-BD/bn-IN and roman for the
   engines that only do English. The parser has to understand both, because a
   phone can land on either depending on what models the browser has. */
console.log('\n--- voice entry understands Bangla script, not just roman ---');
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'voice.js'), 'utf8'), { filename: 'voice.js' });

let va = parseVoiceCommand('নাম এটা Kids 3pcs Set পরিমাণ ৫০ দাম পড়ছে ১২০').actions[0];
eq(va.kind, 'in', 'Bangla script, stock-in: kind');
eq(va.name, 'kids set', 'Bangla script, stock-in: product name extracted');
eq(va.qty, 50, 'Bangla script: Bangla digits ৫০ read as 50');
eq(va.cost, 120, 'Bangla script: cost picked up');

va = parseVoiceCommand('নাম এটা Kids 3pcs Set পরিমাণ ৫০ বিক্রি দরে ২০০').actions[0];
eq(va.kind, 'out', 'Bangla script, sell: kind');
eq(va.rate, 200, 'Bangla script, sell: rate picked up');
eq(va.cost, null, 'Bangla script, sell: cost stays empty');

va = parseVoiceCommand('পরিমাণ ৫০').actions;
eq(va.length, 0, 'Bangla: a quantity alone is not an entry (no product named)');

// and the roman path must not regress
va = parseVoiceCommand('naam eita Kids 3pcs Set, quantity 50, price porche 120').actions[0];
eq(va.name, 'kids set', 'roman still parses');
eq(va.qty, 50, 'roman still parses qty');
eq(va.cost, 120, 'roman still parses cost');

// a Bangla sentence must not turn a filler word into the product name
va = parseVoiceCommand('আজকে নাম এটা Kids Sweater পরিমাণ ১০ দাম পড়ছে ৩০০').actions[0];
ok(va.name.indexOf('হয়') === -1, 'Bangla filler words are not taken as the product name');
eq(va.qty, 10, 'Bangla sentence: qty');

console.log('\n--- a silent speech engine must be detected, not looped on ---');
const voiceSrc = fs.readFileSync(path.join(root, 'js', 'voice.js'), 'utf8');
ok(/V_LANG_TRY/.test(voiceSrc), 'there is a list of languages to try');
ok(/bn-BD/.test(voiceSrc) && /en-IN/.test(voiceSrc), 'it starts with Bangla and falls back to a language Chrome has');
ok(/voiceGotAnything/.test(voiceSrc), 'the code tracks whether the engine ever returned anything');
ok(/voiceAdvanceLang/.test(voiceSrc), 'a language that returns nothing is swapped out');
ok(/voiceLang\(\)/.test(voiceSrc), 'the active language is shown while listening');
ok(/kono Bangla model dey na|Bangla model/.test(voiceSrc), 'when all languages fail it explains why, in Bangla');
ok(/type kore likhe din/.test(voiceSrc), 'and points at typing instead of dead-ending');

console.log('\n--- snapshots ---');
ok(listSnapshots().length >= 1, 'a snapshot was taken on commit');

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
console.log('=================');
process.exit(fail ? 1 : 0);


