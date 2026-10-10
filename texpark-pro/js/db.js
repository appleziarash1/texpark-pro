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
  deviceTag: '',               // 'PC' / 'PH' is set automatically, editable in Settings
  warnOnShortStock: true,      // show a reminder when stock is not entered yet
  lowStockLevel: 10,
  vatPercent: 0,
  autoBackup: true,
  autoPull: true,       // pull new data from the cloud by itself
  reminderDefaultLead: 1,  // days before a delivery date to remind, unless an order overrides it
  orderPrefix: 'TP-',
  memoOrderEnabled: false  // off by default; the owner turns it on to mirror new memos as orders
};

function blankDB() {
  return {
    version: 2,
    /* Stable ids, not id(). These three seed rows exist on every fresh install, and
       a random id per device meant two devices that had both merely *started* would
       merge into six products under three names the first time they synced. A fixed
       id makes the seed the same record everywhere, so it merges to one. */
    products: [
      { id: 'seed-k3s', name: 'Kids 3pcs Set',     sku: 'K3S', category: 'Kids',   unit: 'pcs', rate: 220, cost: 165, vat: 0, reorderLevel: 10 },
      { id: 'seed-kgs', name: 'Kids Girls Sweater',sku: 'KGS', category: 'Kids',   unit: 'pcs', rate: 145, cost: 108, vat: 0, reorderLevel: 10 },
      { id: 'seed-bk',  name: 'Baby Keepers',      sku: 'BK',  category: 'Baby',   unit: 'pcs', rate: 55,  cost: 41,  vat: 0, reorderLevel: 10 }
    ],
    suppliers: [],
    customers: [],
    stock: [],        // {productId, opening, purchased, sold, adjusted, available, cost}
    ledger: [],       // append-only stock movement log
    purchases: [],    // {purchaseNo, date, supplierId, items[], subtotal, paid, due, status}
    expenses: [],     // {date, head, amount, note}
    memos: [],
    deliveries: [],
    orders: [],       // order command center: {orderNo, customerId, customerName, productName, qty, deliveryDate, status, priority, reminders, history[]}
    returns: [],      // parcels sent back: {memoId, qty, date, condition, ...}
    payments: [],     // customer receipts: {date, customerId, amount, method, note}
    users: defaultUsers(),  // a fresh install always has a way in
    tombstones: [],   // {key, id, at} for records deleted on some device
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
  ['products', 'suppliers', 'customers', 'stock', 'ledger', 'purchases', 'expenses', 'memos', 'deliveries', 'orders', 'returns', 'payments', 'users']
    .forEach(k => { if (!Array.isArray(d[k])) d[k] = []; });
  if (!Array.isArray(d.tombstones)) d.tombstones = [];
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
  adoptSeedIds_(d);
  return d;
}

/* The three starter products used to get a random id per device. An install that
   predates the stable ids still carries those random ones, and the first sync
   would then show six rows for three products. Rename an *untouched* seed row to
   the shared id and repoint every reference to it. A row the owner has edited, or
   a name/sku that is not one of the seeds, is left exactly as it is - guessing
   wrong there would silently move a memo or a stock card onto another product. */
const SEED_IDS = { K3S: 'seed-k3s', KGS: 'seed-kgs', BK: 'seed-bk' };

function adoptSeedIds_(d) {
  const taken = {};
  d.products.forEach(p => { if (p && p.id) taken[p.id] = true; });
  const renames = {};
  d.products.forEach(p => {
    if (!p || !p.sku) return;
    const target = SEED_IDS[String(p.sku).toUpperCase()];
    if (!target || p.id === target || taken[target]) return;
    const seed = blankDB().products.find(x => x.id === target);
    if (!seed || p.name !== seed.name || num(p.rate) !== seed.rate) return;
    renames[p.id] = target;
    taken[target] = true;
  });
  const keys = Object.keys(renames);
  if (!keys.length) return;
  d.products.forEach(p => { if (p && renames[p.id]) p.id = renames[p.id]; });
  d.stock.forEach(s => { if (s && renames[s.productId]) s.productId = renames[s.productId]; });
  d.ledger.forEach(l => { if (l && renames[l.productId]) l.productId = renames[l.productId]; });
  d.memos.forEach(m => (m.items || []).forEach(it => { if (it && renames[it.productId]) it.productId = renames[it.productId]; }));
  d.purchases.forEach(p => (p.items || []).forEach(it => { if (it && renames[it.productId]) it.productId = renames[it.productId]; }));
  d.stock = d.stock.filter((s, i, arr) => s && arr.findIndex(x => x && x.productId === s.productId) === i);
}

/* Single write path. Nothing mutates localStorage directly. */
const SNAP_KEY = 'texpark_pro_snapshots';

/* ============ change stamps + tombstones (so the cloud pull is a real merge) ============
   Pulling the newest snapshot used to mean "replace everything with whatever the
   PC last uploaded". Two things went wrong with that, and both are fixed here.

   `at` on a record is when it last changed. Without it, an edit made on the phone
   *after* the PC's last backup is overwritten by the PC's older copy the next time
   the phone pulls. With it, the newer version of each record wins individually, so
   both machines' work survives.

   Deletion cannot be expressed by the record being absent, because absence is also
   what a device that never saw the record looks like - and the other device's
   snapshot would keep handing the deleted record back. So a delete writes a small
   tombstone instead, and the record is filtered out at read time. Tombstones live
   in their own list rather than in the collections, because a hidden record that is
   still *in* memos[] would be silently dropped by the first .filter() that touches
   it - before the tombstone had a chance to defeat the other device's copy.

   `at` is stamped in commit(), the one point every write passes through, so no
   caller can forget it. Comparisons are on the ISO string: every device stamps UTC
   and the format is fixed-width, so a plain string compare is correct and does not
   depend on which machine's clock does the merging. */
const MERGE_KEYS = ['products', 'suppliers', 'customers', 'stock', 'ledger',
                    'purchases', 'expenses', 'memos', 'deliveries', 'orders', 'returns', 'payments',
                    'users'];
const TOMB_MAX = 4000;                 // plenty of history; stops unbounded growth

/* Settings travel between machines, but not all of them. These keys describe the
   machine, not the business: the sync URL is how this device reaches the sheet and
   the device tag is which machine this is. Syncing either would make the phone
   adopt the PC's URL, or rename the PC to the phone - the two ways a merge can make
   a device stop syncing at all. Everything else (company details, memo prefix,
   low-stock level, VAT, auto-backup) is the business's, so it does sync.

   `autoPull` is deliberately per-device too: switching auto-pull off on the phone
   is a decision about the phone, and it must not silence the PC. */
const LOCAL_SETTING_KEYS = ['syncUrl', 'deviceTag', 'autoPull', 'firebase'];

/* A record without its change stamp - what "changed?" actually compares. */
function bare_(o) {
  const c = Object.assign({}, o);
  delete c.at;
  return c;
}

function indexOne_(arr) {
  const m = {};
  for (const rec of (Array.isArray(arr) ? arr : [])) if (rec && rec.id) m[rec.id] = rec;
  return m;
}

function indexRecs_(d) {
  const map = {};
  for (const k of MERGE_KEYS) map[k] = indexOne_(d && d[k]);
  return map;
}

/* The same index over a detached copy of the records. stampChanged_ has to compare
   this commit against the last one, and a plain index holds the live objects - so
   an edit made in place (a password reset, a role change) looked identical to the
   previous commit and was never stamped, never pushed, and never reached the other
   machine. Freezing the copy is what makes an in-place edit visible. */
function frozenIndex_(d) {
  const map = {};
  for (const k of MERGE_KEYS) {
    const src = (d && d[k]) || [];
    map[k] = indexOne_(JSON.parse(JSON.stringify(src)));
  }
  return map;
}

function stampChanged_(now) {
  const prev = lastCommitted;
  if (!prev) return;                   // nothing to compare against (first commit)
  for (const k of MERGE_KEYS) {
    const before = prev[k] || {};
    const live = indexOne_(db[k]);
    for (const rid in live) {
      const was = before[rid];
      if (!was) { live[rid].at = live[rid].at || now; continue; }
      if (JSON.stringify(bare_(live[rid])) !== JSON.stringify(bare_(was))) live[rid].at = now;
    }
    // Present in the last commit, gone now: that is a delete, wherever it happened.
    for (const rid in before) if (!live[rid]) markDeleted_(k, rid, now);
  }
}

/* ---------------------------- tombstones ---------------------------- */
function tombList_(d) { return Array.isArray(d && d.tombstones) ? d.tombstones : []; }

function markDeleted_(key, rid, at) {
  const t = tombList_(db).slice();
  const found = t.find(x => x.key === key && x.id === rid);
  if (found) found.at = at; else t.push({ key, id: rid, at });
  db.tombstones = t.slice(-TOMB_MAX);
}

/* True when d holds a tombstone for this record, from either device. */
function isDeletedIn_(d, key, rid) {
  return tombList_(d).some(x => x.key === key && x.id === rid);
}

/* Union of both sides' tombstones, newest timestamp per record. */
function mergeTombstones_(a, b) {
  const out = tombList_({ tombstones: a }).slice();
  for (const t of tombList_({ tombstones: b })) {
    const found = out.find(x => x.key === t.key && x.id === t.id);
    if (found) { if (String(t.at || '') > String(found.at || '')) found.at = t.at; }
    else out.push({ key: t.key, id: t.id, at: t.at });
  }
  return out.slice(-TOMB_MAX);
}

/* Business settings, newest wins. The whole settings object carries no per-record
   stamp, so the device tag is compared against the value the other side sent: the
   side that changed last is the side whose value the other one has not seen. */
function mergeSettingsInto_(incoming) {
  const inSet = (incoming && incoming.settings) || null;
  if (!inSet || typeof inSet !== 'object') return;
  const mine = db.settings || (db.settings = {});
  const inCompany = inSet.company || {};
  const myCompany = mine.company || (mine.company = {});
  Object.keys(inCompany).forEach(k => {
    const theirs = inCompany[k];
    if (theirs === undefined || theirs === null || theirs === '') return;
    const ours = myCompany[k];
    if (ours === undefined || ours === null || ours === '') myCompany[k] = theirs;
    else if (JSON.stringify(ours) !== JSON.stringify(theirs) &&
             String(inSet.companyUpdatedAt || '') > String(mine.companyUpdatedAt || '')) {
      myCompany[k] = theirs;
    }
  });
  Object.keys(inSet).forEach(k => {
    if (k === 'company' || LOCAL_SETTING_KEYS.indexOf(k) !== -1) return;
    const theirs = inSet[k];
    if (theirs === undefined || theirs === null) return;
    const ours = mine[k];
    if (ours === undefined || ours === null) { mine[k] = theirs; return; }
    if (JSON.stringify(ours) === JSON.stringify(theirs)) return;
    if (String(inSet.settingsUpdatedAt || '') > String(mine.settingsUpdatedAt || '')) mine[k] = theirs;
  });
  if (String(inSet.companyUpdatedAt || '') > String(mine.companyUpdatedAt || '')) {
    mine.companyUpdatedAt = inSet.companyUpdatedAt;
  }
  if (String(inSet.settingsUpdatedAt || '') > String(mine.settingsUpdatedAt || '')) {
    mine.settingsUpdatedAt = inSet.settingsUpdatedAt;
  }
}

/* One account per username, whichever device created it. Two devices that each
   started fresh both hold an `admin`, and the ids differ because they were random -
   without this the merge produced two admins, and the login picked whichever came
   first. The newest password and role win, so a password reset on the PC still
   works on the phone. */
function mergeUsersInto_() {
  const seen = {};
  const out = [];
  (db.users || []).forEach(u => {
    if (!u || !u.username) return;
    const key = String(u.username).toLowerCase();
    const prev = seen[key];
    if (!prev) { seen[key] = u; out.push(u); return; }
    if (String(u.at || '') > String(prev.at || '')) {
      Object.keys(prev).forEach(k => { if (k !== 'id') delete prev[k]; });
      Object.assign(prev, u);
    }
  });
  db.users = out;
}

/* Where d2 has a newer version of a record, copy it into d1; where d1 is newer,
   leave it. Records d1 has never seen are added, unless d1 holds a tombstone for
   them - that is the case where a record deleted here comes back in the other
   device's snapshot, and it must not be resurrected. */
function mergeRecsInto_(d1, d2) {
  const a = indexRecs_(d1), b = indexRecs_(d2);
  for (const k of MERGE_KEYS) {
    if (!Array.isArray(d1[k])) d1[k] = [];
    for (const rid in b[k]) {
      const other = b[k][rid], mine = a[k][rid];
      if (!mine) {
        if (!isDeletedIn_(d1, k, rid) && !isDeletedIn_(d2, k, rid)) d1[k].push(other);
        continue;
      }
      // A tombstone is a delete, so it only wins while nothing newer was written.
      if (String(other.at || '') > String(mine.at || '')) {
        Object.keys(mine).forEach(key => { if (key !== 'id') delete mine[key]; });
        Object.assign(mine, other);
      }
    }
  }
  return d1;
}

/* Retire every record a tombstone names, and drop tombstones older than any edit
   that came after them (an edit after a delete is a deliberate re-create). */
function applyTombstones_(d) {
  const keep = [];
  for (const t of tombList_(d)) {
    const rec = indexOne_(d[t.key])[t.id];
    if (!rec) { keep.push(t); continue; }
    if (String(rec.at || '') > String(t.at || '')) continue;   // edited after delete
    d[t.key] = (d[t.key] || []).filter(x => !(x && x.id === t.id));
    keep.push(t);
  }
  d.tombstones = keep.slice(-TOMB_MAX);
  return d;
}

/* The whole pull-side merge: newest record wins, deletions stick, business settings
   follow the newer edit, accounts collapse to one per username, then the stock book
   is rebuilt from the ledger so it agrees with the memos that are left. */
function mergeCloudInto_(incoming) {
  mergeRecsInto_(db, incoming);
  db.tombstones = mergeTombstones_(db.tombstones, incoming.tombstones);
  applyTombstones_(db);
  mergeUsersInto_();
  mergeSettingsInto_(incoming);
  rebaseStockFromLedger();
  ensureUsers_();
}

/* Rebuild the stock book from the ledger, so it agrees with the memos that are
   actually left after a merge. A recomputation rather than a second subtraction
   pass: it discards whatever the sold/purchased counters had accumulated and
   re-derives them, so two devices' counters cannot drift apart. Memos are the
   source of truth by design (a memo must save even when stock was never entered),
   so stock follows the memos rather than the reverse. */
function rebaseStockFromLedger() {
  const byProduct = {};
  (db.ledger || []).forEach(l => {
    if (!l || !l.productId) return;
    // A product that was deleted has no ledger worth replaying: rebuilding its
    // card from old movements would leave a row for "(deleted product)" on the
    // stock page, which reads as stock the shop still owns.
    if (!productById(l.productId)) return;
    const b = byProduct[l.productId] || (byProduct[l.productId] = { opening: 0, purchased: 0, sold: 0 });
    const q = num(l.qty);
    if (l.type === 'Opening' || l.type === 'AutoAdd') b.opening += q;
    else if (l.type === 'Purchase') b.purchased += q;
    else if (l.type === 'Sale') b.sold += -q;
    else if (l.type === 'SaleReturn') b.sold -= q;
    /* A parcel that came back in sellable condition is no longer sold, so it is
       subtracted from `sold` - the same slot a memo delete frees. A damaged one is
       not stock the shop can sell, so it never re-enters `sold`. */
    else if (l.type === 'Return') b.sold -= q;
    /* The native app writes ReturnUndo where this build writes Sale for the same
       event - a deleted return - and both apps share one sheet, so each has to
       understand the other's spelling or a sync rebuilds `sold` wrongly. */
    else if (l.type === 'ReturnUndo') b.sold -= q;
    else if (l.type === 'Adjustment' || l.type === 'Damage') b.purchased += q;
  });
  const cards = {};
  (db.stock || []).forEach(s => { if (s && s.productId) cards[s.productId] = s; });
  Object.keys(byProduct).forEach(pid => {
    const t = byProduct[pid];
    let s = cards[pid];
    if (!s) { s = { id: id(), productId: pid, cost: 0 }; db.stock.push(s); cards[pid] = s; }
    s.opening = num(t.opening);
    s.purchased = num(t.purchased);
    s.sold = num(t.sold);
    s.available = stockAvailable(s);
  });
  (db.stock || []).forEach(s => { if (s) s.available = stockAvailable(s); });
  dedupeStockCards_();
}

/* One card per product. A merge can leave two, because each device used to mint its
   own random card id for the same product - the stock page would then list the same
   product twice, once under each device's numbers. Later cards keep only a cost the
   first one lacks. */
function dedupeStockCards_() {
  const seen = {};
  db.stock = (db.stock || []).filter(s => {
    if (!s || !s.productId) return false;
    if (seen[s.productId]) {
      if (!num(seen[s.productId].cost) && num(s.cost)) seen[s.productId].cost = s.cost;
      return false;
    }
    seen[s.productId] = s;
    return true;
  });
  return db.stock;
}

function commit() {
  // Capture what the indexes looked like before this save, so both stampChanged_ and
  // the Firestore delta can tell which records actually moved.
  const prevIndex = lastCommitted;
  try {
    // Stamp what this save changed *before* it is written, so the copy going to
    // disk (and later to the cloud) already carries the timestamps the merge needs.
    stampChanged_(new Date().toISOString());
    snapshot();
    localStorage.setItem(KEY, JSON.stringify(db));
    lastCommitted = frozenIndex_(db);
  } catch (e) {
    alert('\u09A1\u09C7\u099F\u09BE \u09B8\u09C7\u09AD \u0995\u09B0\u09BE \u09AF\u09BE\u099A\u09CD\u099B\u09C7 \u09A8\u09BE: ' + e.message);
    return false;
  }
  if (typeof renderAll === 'function') renderAll();
  // Anything saved since the last upload is worth pushing before the tab closes.
  if (typeof window !== 'undefined') window.cloudDirty = true;
  // Live per-record push: send only the records whose stamp moved, so Firestore sees
  // a few documents per save rather than the whole book. Muted while a merge is being
  // committed, or a record that just came down would be sent straight back up.
  if (typeof cloudQueueChanges === 'function') cloudQueueChanges(prevIndex);
  // Upload now, not only when the tab closes. A browser cancels a request started
  // from beforeunload, so "wait until he leaves the page" meant an edit made on the
  // web app often never reached the sheet at all.
  if (typeof scheduleCloudPush === 'function') scheduleCloudPush();
  // Anything saved since the last upload is worth pushing before the tab closes.
  if (typeof window !== 'undefined') window.cloudDirty = true;
  return true;
}

/* The record index as of the last commit, so the next commit can tell what moved. */
var lastCommitted = null;

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
  if (!s) return alert('No snapshot.');
  if (!confirm('Restore the snapshot from ' + new Date(s.at).toLocaleString() + '? The current data will be replaced.')) return;
  try {
    db = migrate(JSON.parse(s.data));
    if (!db.users || !db.users.length) db.users = defaultUsers();
    localStorage.setItem(KEY, JSON.stringify(db));
    alert('Snapshot restored. The page will reload.');
    location.reload();
  } catch (e) {
    alert('Snapshot restore failed: ' + e.message);
  }
}


/* ============================ document numbers ============================ */
/* Memo/PO numbers must not collide between the PC and the phone, and the Google
   Sheet upserts on the number. A per-device counter alone would mint the same
   TXP/SM/<date>-001 on both machines, and one memo would silently overwrite the
   other in the sheet. So the device gets a short stable tag baked in, derived
   once and kept, unless Settings overrides it. */
const DEVICE_KEY = 'texpark_pro_device_tag';

function deviceTag() {
  const set = ((db && db.settings && db.settings.deviceTag) || '').trim();
  if (set) return set.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  let t = '';
  try { t = localStorage.getItem(DEVICE_KEY) || ''; } catch (e) {}
  if (!t) {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    /* A bare 'PH'/'PC' is not unique: the Android app and this page on another
       machine would both claim it, and the sheet holds one backup row per tag -
       each would then overwrite the other's snapshot. Mint a suffix once and keep
       it, so memo numbers stay stable for this install and no one else takes it. */
    const base = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ? 'PH' : 'PC';
    t = base + (id().slice(0, 4).toUpperCase());
    try { localStorage.setItem(DEVICE_KEY, t); } catch (e) {}
  }
  return t;
}

function nextMemoNo() {
  const d = today().replaceAll('-', '/');
  return db.settings.memoPrefix + d + '-' + deviceTag() + String(db.seq.memo).padStart(3, '0');
}
function consumeMemoNo() {
  const no = nextMemoNo();
  db.seq.memo++;
  return no;
}
function nextPurchaseNo() {
  const d = today().replaceAll('-', '/');
  return 'TXP/PO/' + d + '-' + deviceTag() + String(db.seq.purchase).padStart(3, '0');
}
function consumePurchaseNo() {
  const no = nextPurchaseNo();
  db.seq.purchase++;
  return no;
}

/* ============================ stock engine ============================ */
/* What the books say, before physical reality is applied. This is the figure
   that can go negative, and it is kept separate so the shortfall is not lost. */
function stockRaw(s) {
  if (!s) return 0;
  return num(s.opening) + num(s.purchased) - num(s.sold);
}

/* Available is what is physically on the shelf, so it stops at 0. A memo that
   goes out before its stock is entered puts the card at 0 - not at a negative
   number, which used to read as if the shop owed goods it never bought. When the
   received qty is entered later it lands on top of these sales by itself. */
function stockAvailable(s) {
  return Math.max(0, stockRaw(s));
}

/* How much is still to be entered: the sales that have gone out minus what was
   ever received. This is the number that used to appear as a minus sign. */
function stockShort(s) {
  return Math.max(0, -stockRaw(s));
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
      note: 'Stock card created from a sales memo - received qty not entered yet'
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
    type,                     // Opening | Purchase | Sale | SaleReturn | Return | Damage | Adjustment
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

/* Undo a sale: the goods come back onto the shelf and the memo's qty leaves `sold`.
   No clamp on the way down. `sold` is a running counter, and reversing a memo that
   already had a return filed against it takes the full memo qty out here while the
   return's own entry adds its share back - so it dips below zero mid-transaction and
   the two entries net out correctly. Clamping swallowed the difference instead: a
   memo of 20 with 5 returned left `sold` at 5 and available 5 short of what it was
   before the memo. It also disagreed with rebaseStockFromLedger, which replays the
   same ledger without clamping, so the number changed by itself after a sync.
   available is what the owner sees, and that is clamped in stockAvailable. */
function reverseSaleFromStock(memo) {
  memo.items.forEach(it => {
    const s = db.stock.find(x => x.productId === it.productId);
    if (!s) return;
    s.sold = num(s.sold) - num(it.qty);
    s.available = stockAvailable(s);
    logStock(it.productId, 'SaleReturn', num(it.qty), memo.memoNo, 'Memo deleted');
  });
}

/* How much of a memo is still out with the customer: sold, minus what has been
   delivered, minus what has come back. A return is stock the shop holds again, so
   it must not count as still being with the customer. */
function deliveredQtyOf(memoId) {
  return (db.deliveries || []).filter(x => x.memoId === memoId).reduce((a, x) => a + num(x.qty), 0);
}
function returnedQtyOf(memoId) {
  return (db.returns || []).filter(x => x.memoId === memoId).reduce((a, x) => a + num(x.qty), 0);
}
function pendingQtyOf(memo) {
  return Math.max(0, num(memo.totalQty) - deliveredQtyOf(memo.id) - returnedQtyOf(memo.id));
}

/* ============================ Orders (Command Center) ============================
   An order is the promise the shop made to a customer: what was ordered, and when it
   is due. It is deliberately NOT a memo - a memo is what was actually sold. Several
   orders can be settled by one memo, one order can be split across deliveries, and an
   order exists before any sale does. Status is stored, not derived, because the owner
   moves it as the work progresses (received → in progress → ready → dispatched →
   delivered); 'overdue' is derived from the date, so it can never go stale. */

const ORDER_STATUSES = ['received', 'in_progress', 'ready', 'dispatched', 'delivered'];
const ORDER_STATUS_LABEL = {
  received: 'Order Received', in_progress: 'In Progress', ready: 'Ready to Deliver',
  dispatched: 'Dispatched', delivered: 'Delivered'
};
const ORDER_ACTIVE_STATUSES = ['received', 'in_progress', 'ready', 'dispatched'];
/* Whole days from a to b, on the YYYY-MM-DD prefix. Both sides are the same UTC
   format, so this is a plain calendar-day difference with no timezone drift. */
function daysBetween_(a, b) {
  const da = new Date(String(a).slice(0, 10) + 'T00:00:00Z');
  const db_ = new Date(String(b).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(da) || isNaN(db_)) return 0;
  return Math.round((db_ - da) / 86400000);
}
function addDays_(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + num(n));
  return d.toISOString().slice(0, 10);
}
function isOrderActive(o) { return ORDER_ACTIVE_STATUSES.indexOf(o && o.status) !== -1; }
/* Overdue means the delivery date is behind today and the goods are not delivered. */
function isOrderOverdue(o, ref) {
  if (!o || !o.deliveryDate) return false;
  if (!isOrderActive(o)) return false;
  return String(o.deliveryDate).slice(0, 10) < String(ref || today()).slice(0, 10);
}
function orderDaysLate_(o, ref) {
  return Math.max(0, daysBetween_(o.deliveryDate, ref || today()));
}
/* The single place a status label is decided, so the board, calendar and priority
   list always agree. */
function orderDisplayStatus(o, ref) {
  if (o.status === 'delivered') return 'delivered';
  if (isOrderOverdue(o, ref)) return 'overdue';
  return o.status || 'received';
}
function orderSummary(ref) {
  const r = ref || today();
  const list = db.orders || [];
  const active = list.filter(isOrderActive);
  const up = addDays_(r, 7);
  const out = {
    active: active.length,
    upcoming7: active.filter(o => o.deliveryDate >= r && o.deliveryDate <= up).length,
    overdue: active.filter(o => isOrderOverdue(o, r)).length,
    ready: (db.orders || []).filter(o => o.status === 'ready').length
  };
  return out;
}
/* Sorted most-urgent-first: overdue (most days late) then soonest delivery date. */
function ordersByUrgency(ref) {
  const r = ref || today();
  return (db.orders || []).slice().sort((a, b) => {
    const ao = isOrderOverdue(a, r) ? 0 : 1, bo = isOrderOverdue(b, r) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ad = String(a.deliveryDate || ''), bd = String(b.deliveryDate || '');
    if (ad !== bd) return ad < bd ? -1 : 1;
    return String(a.orderNo || '') < String(b.orderNo || '') ? -1 : 1;
  });
}
function ordersOnDate(date, ref) {
  return (db.orders || []).filter(o => String(o.deliveryDate || '').slice(0, 10) === String(date).slice(0, 10));
}
/* Per-order reminder lead time wins over the shop default, so one order can remind 3
   days out while another reminds 1 day out, as the owner asked. */
function orderRemindLead_(o) {
  const v = num(o && o.remindLeadDays);
  if (o && o.remindLeadDays !== undefined && o.remindLeadDays !== null && String(o.remindLeadDays) !== '') return Math.max(0, v);
  const d = num(db.settings && db.settings.reminderDefaultLead);
  return d || 1;
}
/* The reminders due for an order as of `ref`: preparation N days before, dispatch on
   the day, and one overdue alert per day late. Pure, so the same logic drives the
   Reminder Center and the test. */
function orderRemindersFor(o, ref) {
  const r = ref || today();
  const out = [];
  if (!o || !o.deliveryDate || o.status === 'delivered') return out;
  const lead = orderRemindLead_(o);
  const dd = String(o.deliveryDate).slice(0, 10);
  const prepFrom = addDays_(dd, -lead);
  if (r >= prepFrom && r <= dd) out.push({ kind: 'prep', date: r, text: 'Check preparation for ' + (o.orderNo || '') });
  if (r === dd) out.push({ kind: 'dispatch', date: r, text: 'Confirm dispatch today for ' + (o.orderNo || '') });
  if (isOrderOverdue(o, r)) out.push({ kind: 'overdue', date: r, text: 'Overdue by ' + orderDaysLate_(o, r) + ' day(s): ' + (o.orderNo || '') });
  return out;
}

/* A return puts the goods back into the stock book. `condition` decides whether they
   can be sold again: 'good' frees the sale, 'damaged' records the loss and keeps the
   goods out of available, so a damaged parcel never looks like sellable stock. */
function applyReturnToStock(ret) {
  const memo = db.memos.find(m => m.id === ret.memoId);
  const ref = memo ? memo.memoNo : (ret.memoNo || '');
  (ret.items || []).forEach(it => {
    if (!it.productId || num(it.qty) <= 0) return;
    const s = stockOf(it.productId);
    if (ret.condition === 'damaged') {
      logStock(it.productId, 'Damage', 0, ref, 'Parcel return - damaged, not sellable');
    } else {
      /* No clamp, for the same reason as reverseSaleFromStock: rebaseStockFromLedger
         subtracts the full return qty from `sold`, so clamping here would make the
         card disagree with the ledger it is rebuilt from. */
      s.sold = num(s.sold) - num(it.qty);
      logStock(it.productId, 'Return', num(it.qty), ref, (memo ? memo.customerName : '') + ' - parcel return');
    }
    s.available = stockAvailable(s);
  });
}

/* Undo a return: the goods go back out again, so the sale stands once more. */
function reverseReturnFromStock(ret) {
  const memo = db.memos.find(m => m.id === ret.memoId);
  const ref = memo ? memo.memoNo : (ret.memoNo || '');
  (ret.items || []).forEach(it => {
    if (!it.productId || num(it.qty) <= 0) return;
    const s = db.stock.find(x => x.productId === it.productId);
    if (!s) return;
    if (ret.condition !== 'damaged') {
      s.sold = num(s.sold) + num(it.qty);
      logStock(it.productId, 'Sale', -num(it.qty), ref, 'Return cancelled');
    }
    s.available = stockAvailable(s);
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

/* Money a memo has actually collected: the advance at sale time plus every live
   receipt linked to that memo. A receipt is linked by memoId, and the old
   customer-level receipts (no memoId) are ignored here on purpose: they already sit
   in customerDue() and must not be counted a second time in the memo's own due. */
function paymentsForMemo_(memoId) {
  return db.payments.filter(p => p && !p.del && p.memoId === memoId);
}
function collectedOnMemo_(memo) {
  return round2(paymentsForMemo_(memo.id).reduce((a, p) => a + num(p.amount), 0));
}
function paidOnMemo_(memo) {
  return round2(num(memo.advance) + collectedOnMemo_(memo));
}

/* What is still owed on one memo: grand total minus advance minus receipts, floored
   at zero. This is a DERIVED figure and is never hand-edited; recording a payment is
   the only way to move it. For a memo with no payments it can differ from m.due by at
   most a rounding of the stored field, which keeps old data reading exactly as before. */
function memoRemainingDue(memo) {
  return Math.max(0, round2(num(memo.grandTotal) - paidOnMemo_(memo)));
}

/* Customers' total due: the sum over live memos of what each still owes. A memo with
   no receipts contributes exactly its stored due, so every figure that exists today is
   unchanged; a memo that has collected a payment contributes the smaller remainder, so
   marking a delivery delivered (which records that payment) drops the dashboard at
   once. Payments with no memoId are deliberately not netted here - they are a legacy
   customer-level receipt that the customer ledger shows separately, and the dashboard
   never subtracted them, so leaving them out keeps old data reading identically. */
function totalReceivable() {
  return round2(db.memos.reduce((a, m) => round2(a + memoRemainingDue(m)), 0));
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

/* ==================== repairing old memos' cost ====================
   A memo freezes the buying price it was written with: the line stores `cost`, and
   `memo.cogs`/`memo.profit` are computed from it once and saved. That is correct for
   a fresh memo - but memos written while stockCost() was returning a stale figure
   (the buying-price bug) froze a wrong cost, and correcting the product today does
   not reach back into them. These two functions find those memos and rewrite them.

   The correct cost is the product's buying price *now*: that is the best available
   estimate, and it is what the owner means by "fix my old memos". A memo whose line
   already matches is left alone, so running this twice is a no-op. */

/* One item's corrected cost, or null when nothing should change. */
function repairedCostForItem(it) {
  const p = productById(it.productId);
  if (!p) return null;                     // product deleted: its price is unknown
  const want = stockCost(it.productId) || num(p.cost);
  if (!(want > 0)) return null;            // never rewrite against a missing price
  if (round2(want) === round2(num(it.cost))) return null;
  return round2(want);
}

/* Every memo that would change, with its old and new figures. Pure: reads db only,
   so the preview and the apply pass always agree. */
function planMemoCostRepair() {
  const plan = [];
  (db.memos || []).forEach(m => {
    const items = [];
    (m.items || []).forEach((it, idx) => {
      const want = repairedCostForItem(it);
      if (want === null) return;
      items.push({ idx, productName: it.productName, qty: num(it.qty), was: round2(num(it.cost)), now: want });
    });
    if (!items.length) return;
    const fixed = (m.items || []).map(it => {
      const want = repairedCostForItem(it);
      return want === null ? it : Object.assign({}, it, { cost: want });
    });
    const fin = memoMath(fixed, { discount: m.discount, deliveryCharge: m.deliveryCharge, advance: m.advance });
    plan.push({
      memoId: m.id, memoNo: m.memoNo, date: m.date, customerName: m.customerName,
      items,
      wasCogs: round2(num(m.cogs)), nowCogs: fin.cogs,
      wasProfit: round2(num(m.profit)), nowProfit: fin.profit
    });
  });
  return plan;
}

/* Apply the plan. The stock book is not touched: a memo's cost affects profit, not
   quantities, so available/sold stay exactly as they were. */
function applyMemoCostRepair() {
  const plan = planMemoCostRepair();
  plan.forEach(row => {
    const m = db.memos.find(x => x.id === row.memoId);
    if (!m) return;
    m.items = (m.items || []).map(it => {
      const want = repairedCostForItem(it);
      return want === null ? it : Object.assign({}, it, { cost: want });
    });
    const fin = memoMath(m.items, { discount: m.discount, deliveryCharge: m.deliveryCharge, advance: m.advance });
    m.cogs = fin.cogs;
    m.profit = fin.profit;
  });
  return plan.length;
}

/* One-line summary of the repair for a warning banner: how many memos are wrong
   and how far the reported profit is off. Reads the same plan the apply writes,
   so the banner can never promise a different number from the fix. */
function staleCostSummary() {
  const plan = planMemoCostRepair();
  const was = round2(plan.reduce((a, r) => a + r.wasProfit, 0));
  const now = round2(plan.reduce((a, r) => a + r.nowProfit, 0));
  return { count: plan.length, wasProfit: was, nowProfit: now, diff: round2(now - was) };
}

/* ============================ ageing ============================ */
function ageingBuckets(items, todayStr) {
  const t = new Date(todayStr || today()).getTime();
  const b = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
  items.forEach(it => {
    /* Bucket the remaining due, not the frozen field, so a customer who paid on
       delivery stops ageing an already-collected amount into "Due >60d". Callers
       pass memos; a line without grandTotal falls back to its stored due. */
    const due = it && it.grandTotal !== undefined ? memoRemainingDue(it) : num(it.due);
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
  admin:     ['dashboard', 'orders', 'memo', 'history', 'purchase', 'supplier', 'products', 'stock', 'delivery', 'customers', 'ledger', 'profit', 'pl', 'ledgerreport', 'expense', 'users', 'settings', 'backup'],
  manager:   ['dashboard', 'orders', 'memo', 'history', 'purchase', 'supplier', 'products', 'stock', 'delivery', 'customers', 'ledger', 'profit', 'pl', 'ledgerreport', 'expense', 'backup'],
  salesman:  ['dashboard', 'orders', 'memo', 'history', 'products', 'stock', 'delivery', 'customers', 'ledger', 'backup'],
  accountant:['dashboard', 'orders', 'history', 'customers', 'ledger', 'profit', 'pl', 'ledgerreport', 'expense', 'supplier', 'backup']
};

/* A fresh install always has a way in; a merge that emptied users must not lock the
   owner out of his own books. */
function ensureUsers_() {
  if (!Array.isArray(db.users) || !db.users.length) db.users = defaultUsers();
}

function defaultUsers() {
  return [{ id: 'seed-admin', username: 'admin', name: 'Administrator', pass: hash('admin123'), role: 'admin', active: true, createdAt: new Date().toISOString() }];
}

var session = null;   // {userId, username, name, role}

function can(page) {
  if (!session) return false;
  return (PERMS[session.role] || []).indexOf(page) !== -1;
}
