/* Texpark Pro — data + business rules.
   Every write goes through here so stock can never become inconsistent again. */

const KEY = 'texpark_pro_v2';
const OLD_KEY = 'texpark_biz_v1';

const DEFAULT_SETTINGS = {
  syncUrl: '',
  company: {
    name: 'TEXPARK BUYING HOUSE',
    tagline: 'Buying House',
    md: 'MAHMUDUL HASAN SOURAV',
    phone: '01621-008204 | 01854-373404 | 01551-029365',
    email: 'texpark.international01@gmail.com',
    address: 'House-12, Road-06, Sector-09, Uttara, Dhaka-1230',
    bin: '',
    vatReg: ''
  },
  memoPrefix: 'TXP/SM/',
  warnOnShortStock: true,      // show a reminder when stock is not entered yet
  lowStockLevel: 10,
  vatPercent: 0,
  autoBackup: true
};

function blankDB() {
  return {
    version: 2,
    products: [
      { id: id(), name: 'Kids 3pcs Set',     sku: 'K3S', category: 'Kids',   unit: 'pcs', rate: 220, cost: 165, vat: 0, reorderLevel: 10 },
      { id: id(), name: 'Kids Girls Sweater',sku: 'KGS', category: 'Kids',   unit: 'pcs', rate: 145, cost: 108, vat: 0, reorderLevel: 10 },
      { id: id(), name: 'Baby Keepers',      sku: 'BK',  category: 'Baby',   unit: 'pcs', rate: 55,  cost: 41,  vat: 0, reorderLevel: 10 }
    ],
    suppliers: [],
    customers: [],
    stock: [],        // {productId, opening, purchased, sold, adjusted, available, cost}
    ledger: [],       // append-only stock movement log
    purchases: [],    // {purchaseNo, date, supplierId, items[], subtotal, paid, due, status}
    expenses: [],     // {date, head, amount, note}
    memos: [],
    deliveries: [],
    payments: [],     // customer receipts: {date, customerId, amount, method, note}
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    seq: { memo: 1, purchase: 1 }
  };
}

var db;

/* ============================ helpers ============================ */
function id() { return Math.random().toString(36).slice(2, 10); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(n) { return Math.round(num(n) * 100) / 100; }
function money(n) {
  const v = round2(n);
  return '\u09F3' + v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function today() { return new Date().toISOString().slice(0, 10); }
function esc(s) {
  return String(s ?? '').replace(/[&<>'"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[m]));
}

/* ============================ persistence ============================ */
function loadDB() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) { console.error('Corrupt data, starting fresh:', e); }
  return blankDB();
}

// Guarantees every collection exists, so a half-written record can't crash a page.
function migrate(d) {
  const base = blankDB();
  if (!d || typeof d !== 'object') return base;
  d.version = 2;
  ['products', 'suppliers', 'customers', 'stock', 'ledger', 'purchases', 'expenses', 'memos', 'deliveries', 'payments']
    .forEach(k => { if (!Array.isArray(d[k])) d[k] = []; });
  d.settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
  d.settings.company = Object.assign({}, DEFAULT_SETTINGS.company, d.settings.company || {});
  d.seq = Object.assign({ memo: 1, purchase: 1 }, d.seq || {});
  d.products.forEach(p => {
    p.cost = num(p.cost); p.rate = num(p.rate); p.vat = num(p.vat);
    p.reorderLevel = num(p.reorderLevel);
    if (!p.unit) p.unit = 'pcs';
    if (!p.category) p.category = 'General';
  });
  d.stock.forEach(s => {
    s.opening = num(s.opening); s.purchased = num(s.purchased);
    s.sold = num(s.sold); s.adjusted = num(s.adjusted);
    s.available = stockAvailable(s);
    s.cost = num(s.cost);
  });
  d.memos.forEach(m => {
    m.items = m.items || [];
    m.items.forEach(it => { it.qty = num(it.qty); it.rate = num(it.rate); it.cost = num(it.cost); it.amount = round2(it.qty * it.rate); });
    m.subtotal = num(m.subtotal); m.discount = num(m.discount); m.deliveryCharge = num(m.deliveryCharge);
    m.grandTotal = num(m.grandTotal); m.advance = num(m.advance); m.due = num(m.due);
    m.cogs = num(m.cogs); m.profit = num(m.profit);
  });
  d.purchases.forEach(p => { p.items = p.items || []; p.subtotal = num(p.subtotal); p.paid = num(p.paid); p.due = num(p.due); });
  d.expenses.forEach(e => { e.amount = num(e.amount); });
  d.payments.forEach(p => { p.amount = num(p.amount); });
  return d;
}

/* Single write path. Nothing mutates localStorage directly. */
const SNAP_KEY = 'texpark_pro_snapshots';

function commit() {
  try {
    snapshot();
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch (e) {
    alert('\u09A1\u09C7\u099F\u09BE \u09B8\u09C7\u09AD \u0995\u09B0\u09BE \u09AF\u09BE\u099A\u09CD\u099B\u09C7 \u09A8\u09BE: ' + e.message);
    return false;
  }
  if (typeof renderAll === 'function') renderAll();
  return true;
}

/* Rolling safety copies, kept newest-first. Lets a bad edit be undone. */
function snapshot() {
  try {
    const arr = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]');
    const last = arr[0];
    const sig = db.memos.length + '|' + db.products.length + '|' + db.purchases.length + '|' + db.stock.length;
    if (last && last.sig === sig && Date.now() - last.at < 60000) return;   // avoid spam
    arr.unshift({ at: Date.now(), sig, data: JSON.stringify(db) });
    localStorage.setItem(SNAP_KEY, JSON.stringify(arr.slice(0, 8)));
  } catch (e) { /* snapshot is best-effort; never block a save */ }
}

function listSnapshots() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY) || '[]'); } catch (e) { return []; }
}

function restoreSnapshot(index) {
  const arr = listSnapshots();
  const s = arr[index];
  if (!s) return alert('Snapshot nei.');
  if (!confirm('Snapshot (' + new Date(s.at).toLocaleString() + ') restore korben? Ekhonkar data replace hobe.')) return;
  try {
    db = migrate(JSON.parse(s.data));
    if (!db.users || !db.users.length) db.users = defaultUsers();
    localStorage.setItem(KEY, JSON.stringify(db));
    alert('Snapshot restore hoyeche. Page reload hobe.');
    location.reload();
  } catch (e) {
    alert('Snapshot restore fail: ' + e.message);
  }
}


/* ============================ document numbers ============================ */
function nextMemoNo() {
  const d = today().replaceAll('-', '/');
  return db.settings.memoPrefix + d + '-' + String(db.seq.memo).padStart(3, '0');
}
function consumeMemoNo() {
  const no = nextMemoNo();
  db.seq.memo++;
  return no;
}
function nextPurchaseNo() {
  const d = today().replaceAll('-', '/');
  return 'TXP/PO/' + d + '-' + String(db.seq.purchase).padStart(3, '0');
}
function consumePurchaseNo() {
  const no = nextPurchaseNo();
  db.seq.purchase++;
  return no;
}

/* ============================ stock engine ============================ */
// available = opening + purchased - sold  (adjusted folds into purchased/opening)
function stockAvailable(s) {
  if (!s) return 0;
  return num(s.opening) + num(s.purchased) - num(s.sold);
}

/* Read-only stock lookup - never creates a card, so callers that only want to
   *look* at stock (reports, warnings) cannot accidentally mask a fresh product. */
function findStock(productId) {
  return db.stock.find(x => x.productId === productId) || null;
}

function stockOf(productId) {
  let s = findStock(productId);
  if (!s) {
    s = { id: id(), productId, opening: 0, purchased: 0, sold: 0, cost: 0, available: 0 };
    db.stock.push(s);
  }
  s.available = stockAvailable(s);
  return s;
}

/* A product that shows up in a memo must also show up in the Stock book, even when
   nobody has entered opening stock yet. Creates the card with 0 received so the
   sale has somewhere to land; the user tops up the received qty whenever it suits. */
function ensureStockCard(productId) {
  const p = productById(productId);
  if (!p) return null;
  const existed = findStock(productId);
  const s = stockOf(productId);
  if (!existed) {
    s.cost = num(p.cost);
    db.ledger.push({
      id: id(), at: new Date().toISOString(), date: today(), productId,
      type: 'AutoAdd', qty: 0, balance: s.available, ref: 'Memo',
      note: 'Stock card created from a sales memo - received qty ekhono deya hoy ni'
    });
  }
  return s;
}

function productById(pid) { return db.products.find(p => p.id === pid); }

function stockCost(productId) {
  const s = db.stock.find(x => x.productId === productId);
  const p = productById(productId);
  return num(s?.cost) || num(p?.cost) || 0;
}

/* Append-only movement log — every change is traceable. */
function logStock(productId, type, qty, ref, note) {
  db.ledger.push({
    id: id(),
    at: new Date().toISOString(),
    date: today(),
    productId,
    type,                     // Opening | Purchase | Sale | SaleReturn | Adjustment | Damage
    qty: num(qty),            // +in / -out
    balance: stockAvailable(db.stock.find(x => x.productId === productId)),
    ref: ref || '',
    note: note || ''
  });
}

/* Stock report only - tells you what is still to be entered. A short line never
   blocks a memo: the memo is the source of truth, the stock book is topped up after. */
function checkStockForItems(items, opts) {
  opts = opts || {};
  const problems = [];
  const need = {};
  items.forEach(it => { need[it.productId] = (need[it.productId] || 0) + num(it.qty); });
  Object.keys(need).forEach(pid => {
    const p = productById(pid);
    const card = findStock(pid);
    const req = need[pid];
    const avail = num(card ? card.available : 0) + num(opts.allowFor || 0);
    if (avail < req) {
      problems.push({
        productId: pid,
        name: p ? p.name : '(deleted product)',
        requested: req,
        available: avail,
        short: req - avail
      });
    }
  });
  return problems;
}

function applySaleToStock(memo) {
  memo.items.forEach(it => {
    const s = stockOf(it.productId);
    s.sold = num(s.sold) + num(it.qty);
    s.available = stockAvailable(s);
    logStock(it.productId, 'Sale', -num(it.qty), memo.memoNo, memo.customerName);
  });
}

function reverseSaleFromStock(memo) {
  memo.items.forEach(it => {
    const s = db.stock.find(x => x.productId === it.productId);
    if (!s) return;
    s.sold = Math.max(0, num(s.sold) - num(it.qty));
    s.available = stockAvailable(s);
    logStock(it.productId, 'SaleReturn', num(it.qty), memo.memoNo, 'Memo deleted');
  });
}

function applyPurchaseToStock(purchase) {
  purchase.items.forEach(it => {
    const s = stockOf(it.productId);
    s.purchased = num(s.purchased) + num(it.qty);
    // Weighted-average cost, so profit stays honest as buying prices change.
    const onHand = num(s.purchased) + num(s.opening) - num(s.sold);
    const oldValue = num(s.cost) * Math.max(0, onHand - num(it.qty));
    const newValue = num(it.cost) * num(it.qty);
    if (onHand > 0) s.cost = round2((oldValue + newValue) / onHand);
    else s.cost = num(it.cost);
    s.available = stockAvailable(s);
    logStock(it.productId, 'Purchase', num(it.qty), purchase.purchaseNo, purchase.supplierName);
  });
}

/* ============================ money maths ============================ */
// Grand = Subtotal - Discount + Delivery + VAT. Due = Grand - Advance.
function memoMath(items, charges) {
  charges = charges || {};
  let subtotal = 0, cogs = 0, vat = 0;
  items.forEach(it => {
    const qty = num(it.qty), rate = num(it.rate);
    const amount = round2(qty * rate);
    it.qty = qty; it.rate = rate; it.amount = amount;
    it.cost = num(it.cost);
    subtotal = round2(subtotal + amount);
    cogs = round2(cogs + round2(qty * it.cost));
    vat = round2(vat + round2(amount * num(it.vat) / 100));
  });
  const discount = Math.min(Math.max(0, num(charges.discount)), subtotal);
  const deliveryCharge = Math.max(0, num(charges.deliveryCharge));
  const grandTotal = round2(Math.max(0, subtotal - discount + deliveryCharge + vat));
  const advance = Math.min(Math.max(0, num(charges.advance)), grandTotal);
  const due = round2(grandTotal - advance);
  return {
    subtotal, discount, deliveryCharge, vat, grandTotal, advance, due,
    cogs, profit: round2(subtotal - discount + deliveryCharge - cogs)
  };
}

/* ============================ profit & loss ============================ */
function dateInRange(d, from, to) {
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function plSummary(from, to) {
  let sales = 0, cogs = 0, discount = 0, deliveryIncome = 0, vatCollected = 0, grossProfit = 0;
  db.memos.forEach(m => {
    if (!dateInRange(m.date, from, to)) return;
    sales = round2(sales + num(m.subtotal));
    discount = round2(discount + num(m.discount));
    deliveryIncome = round2(deliveryIncome + num(m.deliveryCharge));
    vatCollected = round2(vatCollected + num(m.vat));
    cogs = round2(cogs + num(m.cogs));
    grossProfit = round2(grossProfit + num(m.profit));
  });
  const expense = db.expenses
    .filter(e => dateInRange(e.date, from, to))
    .reduce((a, e) => round2(a + num(e.amount)), 0);
  return {
    sales, discount, cogs, grossProfit, deliveryIncome, vatCollected, expense,
    netProfit: round2(grossProfit - expense)
  };
}

function totalReceivable() {
  return round2(db.memos.reduce((a, m) => a + num(m.due), 0));
}
function totalPayable() {
  return round2(db.purchases.reduce((a, p) => a + num(p.due), 0));
}
function stockValue() {
  return round2(db.products.reduce((a, p) => {
    const s = db.stock.find(x => x.productId === p.id);
    return a + num(s?.available) * stockCost(p.id);
  }, 0));
}

/* ============================ ageing ============================ */
function ageingBuckets(items, todayStr) {
  const t = new Date(todayStr || today()).getTime();
  const b = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
  items.forEach(it => {
    const due = num(it.due);
    if (due <= 0) return;
    const days = Math.floor((t - new Date(it.date).getTime()) / 86400000);
    if (days <= 30) b.current += due;
    else if (days <= 60) b.d30 += due;
    else if (days <= 90) b.d60 += due;
    else if (days <= 120) b.d90 += due;
    else b.over90 += due;
  });
  b.total = round2(b.current + b.d30 + b.d60 + b.d90 + b.over90);
  return b;
}

/* ============================ users / roles ============================ */
// Stored hashed (djb2) — this gates screens, it is not encryption.
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

const PERMS = {
  admin:     ['dashboard', 'memo', 'history', 'purchase', 'supplier', 'products', 'stock', 'delivery', 'customers', 'ledger', 'profit', 'pl', 'ledgerreport', 'expense', 'users', 'settings', 'backup'],
  manager:   ['dashboard', 'memo', 'history', 'purchase', 'supplier', 'products', 'stock', 'delivery', 'customers', 'ledger', 'profit', 'pl', 'ledgerreport', 'expense', 'backup'],
  salesman:  ['dashboard', 'memo', 'history', 'products', 'stock', 'delivery', 'customers', 'ledger', 'backup'],
  accountant:['dashboard', 'history', 'customers', 'ledger', 'profit', 'pl', 'ledgerreport', 'expense', 'supplier', 'backup']
};

function defaultUsers() {
  return [{ id: id(), username: 'admin', name: 'Administrator', pass: hash('admin123'), role: 'admin', active: true, createdAt: new Date().toISOString() }];
}

var session = null;   // {userId, username, name, role}

function can(page) {
  if (!session) return false;
  return (PERMS[session.role] || []).indexOf(page) !== -1;
}
