/* Texpark Pro — UI + actions. */

/* Bump this together with CACHE in sw.js. Shown in Settings so a phone can
   prove which build it is actually running. */
const APP_VERSION = '2027-01-01.10';

/* Where the released build is published. Used only to tell an owner whose copy
   was opened from a stale address where the current one lives. */
const RELEASE_URL = 'https://appleziarash1.github.io/texpark-pro';

/* Numeric version compare, so 2027-01-01.10 sorts above 2027-01-01.9. A plain
   string compare puts .10 first, which is the wrong way round for releases. */
function versionNewer(a, b) {
  const parts = v => String(v || '').split(/[^0-9]+/).filter(s => s.length).map(Number);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const xi = i < x.length ? x[i] : 0, yi = i < y.length ? y[i] : 0;
    if (xi !== yi) return xi > yi;
  }
  return false;
}

const PAGES = [
  { id: 'dashboard',  label: 'Dashboard',      ic: '\u25A3', group: 'Overview' },
  { id: 'orders',     label: 'Orders',         ic: '\u26A1', group: 'Overview' },
  { id: 'memo',       label: 'New Sales Memo', ic: '\uFF0B', group: 'Sales' },
  { id: 'history',    label: 'Memo History',   ic: '\u25F7', group: 'Sales' },
  { id: 'delivery',   label: 'Delivery',       ic: '\u2713', group: 'Sales' },
  { id: 'customers',  label: 'Customers',      ic: '\u2659', group: 'Sales' },
  { id: 'ledger',     label: 'Customer Ledger',ic: '\u2261', group: 'Sales' },
  { id: 'purchase',   label: 'Purchases',      ic: '\u21A5', group: 'Purchase' },
  { id: 'supplier',   label: 'Suppliers',      ic: '\u21A6', group: 'Purchase' },
  { id: 'products',   label: 'Products',       ic: '\u25A4', group: 'Inventory' },
  { id: 'stock',      label: 'Stock',          ic: '\u25A5', group: 'Inventory' },
  { id: 'stocklog',   label: 'Stock Ledger',   ic: '\u2263', group: 'Inventory' },
  { id: 'profit',     label: 'Profit / Item',  ic: '\u2197', group: 'Accounts' },
  { id: 'pl',         label: 'Profit & Loss',  ic: '\u2211', group: 'Accounts' },
  { id: 'expense',    label: 'Expenses',       ic: '\u2212', group: 'Accounts' },
  { id: 'ledgerreport', label: 'Ledger / Ageing', ic: '\u2696', group: 'Accounts' },
  { id: 'users',      label: 'Users & Roles',  ic: '\u26BF', group: 'Admin' },
  { id: 'settings',   label: 'Settings',       ic: '\u2699', group: 'Admin' },
  { id: 'backup',     label: 'Backup / Data',  ic: '\u2913', group: 'Admin' }
];

var memoDraft = { items: [] };
var editingMemoId = null;
/** Which memo the preview modal is showing, so its Print/Save buttons act on that
 *  one. Cleared on close: a stale id would export the memo looked at last. */
var viewingMemoId = null;
var purchaseDraft = { items: [] };
var currentPage = "dashboard";

function set(elId, v) { const e = document.getElementById(elId); if (e) e.textContent = v; }
/* Read an optional input's value without crashing when the element is absent
   (e.g. a stripped-down build or a test shim that never created it). */
function valueOfEl_(elId) { const e = document.getElementById(elId); return e ? (e.value || '') : ''; }
function statBox(label, value, sub) {
  return '<div class="card stat"><div class="label">' + label + '</div><div class="value">' + value + '</div>' +
    (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
}

/* ===================== boot ===================== */
function boot() {
  // The memo sheet's stylesheet, so the preview is not unstyled HTML. First, before
  // anything can render a memo.
  memoCssTag();
  db = loadDB();
  if (!db.users || !db.users.length) db.users = defaultUsers();
  // Before anything reads the settings: a ?sync=<url> link is how a phone gets the
  // sheet URL, which cannot arrive over the sync itself.
  adoptSyncFromLink();
  // The merge compares each commit against this index to see what moved, so it has
  // to be seeded with what was actually loaded - otherwise the very first save
  // would look like every record was created and stamp the lot with one timestamp.
  lastCommitted = frozenIndex_(db);
  syncLoad();
  if (restoreSession()) {
    enterApp();
    // Opening the app while already signed in is the same moment as logging in:
    // push what is pending, then pull the other devices' work down.
    syncFlush();
    cloudAutoSync('open');
    // Live Firestore sync, kept separate from the Sheet path above so a device with
    // no cloud keys is untouched. Quiet on boot: it never pops an alert.
    if (typeof cloudBoot === 'function') cloudBoot();
  } else {
    buildLogin();
  }
}

/* ===================== session ===================== */
/* The session used to live only in memory, so any reload dropped the owner back
   to the login screen. That happened on its own, too: the service worker reloads
   the page whenever its bytes change. Persist the signed-in user and restore it
   here, so a reload keeps you signed in until you press Sign out. */
const SESSION_KEY = 'texpark_pro_session';

function saveSession(user) {
  session = { userId: user.id, username: user.username, name: user.name, role: user.role };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      userId: user.id, username: user.username, name: user.name, role: user.role, pass: user.pass
    }));
  } catch (e) {}
}

function clearSession() {
  session = null;
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}

/* Bring back a persisted session, but only while the user still exists, is still
   active, and has not changed their password since the session was written. The
   stored password hash is a cheap version stamp: changing the password signs out
   every device that was signed in with the old one. */
function restoreSession() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { saved = null; }
  if (!saved || !saved.userId) return null;
  const user = (db.users || []).find(x => x.id === saved.userId && x.active !== false);
  if (!user || saved.pass !== user.pass) { clearSession(); return null; }
  session = { userId: user.id, username: user.username, name: user.name, role: user.role };
  return session;
}

/* Show the signed-in shell. Shared by a fresh login and a restored session, so a
   reload lands in exactly the same place a login does. */
function enterApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appRoot').style.display = '';
  buildNav();
  nav('dashboard');
}

/* ===================== login ===================== */
function buildLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('appRoot').style.display = 'none';
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginErr').textContent = '';
  setTimeout(() => { const u = document.getElementById('loginUser'); if (u) u.focus(); }, 60);
}

function doLogin() {
  const u = document.getElementById('loginUser').value.trim().toLowerCase();
  const p = document.getElementById('loginPass').value;
  const user = (db.users || []).find(x => x.username.toLowerCase() === u && x.active !== false);
  if (!user || user.pass !== hash(p)) {
    document.getElementById('loginErr').textContent = 'Wrong username or password.';
    return;
  }
  saveSession(user);
  enterApp();
  syncFlush();
  // Login is the moment the owner starts looking at the books, so bring the other
  // machines' work down now rather than waiting for the next manual step.
  cloudAutoSync('login');
  if (typeof cloudBoot === 'function') cloudBoot();
}

function doLogout() { clearSession(); buildLogin(); }

/* ===================== navigation ===================== */
function buildNav() {
  const groups = {};
  PAGES.forEach(p => { if (can(p.id)) (groups[p.group] = groups[p.group] || []).push(p); });
  let html = '';
  Object.keys(groups).forEach(g => {
    html += '<div class="group">' + g + '</div>';
    groups[g].forEach(p => {
      html += '<button data-page="' + p.id + '" onclick="nav(\'' + p.id + '\')"><span class="ic">' + p.ic + '</span>' + p.label + '</button>';
    });
  });
  document.getElementById('side').innerHTML = html;
  document.getElementById('whoName').textContent = session.name;
  document.getElementById('whoRole').textContent = session.role;
}

function nav(page) {
  if (!can(page)) { alert('You do not have permission for this page.'); return; }
  currentPage = page;
  document.querySelectorAll('.side button').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
  document.getElementById('topTitle').textContent = (PAGES.find(p => p.id === page) || {}).label || '';
  closeNav();          // on phones the drawer should close once you pick a page
  renderAll();
}

/* ---------- mobile drawer ---------- */
function toggleNav() { document.body.classList.toggle('nav-open'); }
function closeNav() { document.body.classList.remove('nav-open'); }

function renderAll() {
  if (!session) return;
  const p = currentPage;
  try {
    if (p === 'dashboard') renderDashboard();
    if (p === 'orders') renderOrders();
    if (p === 'memo') { calcMemo(); renderMemoOrderBlock(); }
    if (p === 'history') renderHistory();
    if (p === 'delivery') renderDelivery();
    if (p === 'customers') renderCustomers();
    if (p === 'ledger') renderCustomerLedger();
    if (p === 'purchase') { renderPurchaseSuppliers(); renderPurchaseHistory(); calcPurchase(); }
    if (p === 'supplier') renderSuppliers();
    if (p === 'products') renderProducts();
    if (p === 'stock') renderStock();
    if (p === 'stocklog') renderStockLog();
    if (p === 'profit') renderProfit();
    if (p === 'pl') renderPL();
    if (p === 'expense') renderExpenses();
    if (p === 'ledgerreport') renderLedgerReport();
    if (p === 'users') renderUsers();
    if (p === 'settings') renderSettings();
    if (p === 'backup') renderBackup();
  } catch (e) {
    console.error('render error on ' + p, e);
  }
  syncStatusRender();
}

/* ===================== dashboard ===================== */
/* Why this device cannot see the other device's work.
   The sync URL is a per-device setting (LOCAL_SETTING_KEYS), so configuring it on
   the PC does nothing for the phone. The owner configured it on the PC, opened the
   phone, and saw an empty shop with no explanation. Say it out loud, on the page he
   actually looks at, and give him the one thing he can do about it. */
function renderSyncWarning() {
  const box = document.getElementById('syncWarn');
  if (!box) return;
  const on = !!syncUrl();
  const others = (db.memos || []).length + (db.products || []).filter(p => !String(p.id).startsWith('seed-')).length;
  if (on) { box.style.display = 'none'; box.innerHTML = ''; return; }

  box.style.display = '';
  box.innerHTML =
    '<div class="sw-head">⚠ Sync is off on this device — other devices\' data will not appear here</div>' +
    '<div class="sw-body">' +
      'This device is not yet paired with the Google Sheet. So any memo/stock you write ' +
      'on another device (PC/phone) will not show here — and data written here will not ' +
      'reach the others either. ' +
      (others === 0
        ? 'Right now this device has none of your own data — only the app\'s demo products.'
        : 'This device has <b>' + others + '</b> of your own records, but they have not reached the sheet.') +
      '<br><br>' +
      '<b>How to fix it:</b> open <b>Settings → Google Sheets Sync</b> and paste the Apps Script ' +
      '<code>/exec</code> URL. Once it is set, every device keeps in step by itself. ' +
      'If setting it on the phone is awkward, use "Pairing link" below to do it in one tap.' +
    '</div>' +
    '<div class="row">' +
      '<button class="btn-pink btn-sm" onclick="nav(\'settings\');setTimeout(function(){var e=document.getElementById(\'stSyncUrl\');if(e)e.focus();},150)">Set the URL in Settings</button>' +
      '<button class="btn-light btn-sm" onclick="togglePairing()">Create pairing link / QR</button>' +
    '</div>' +
    '<div class="sw-pair" id="pairOut" style="display:none"></div>';
}

/* A link that carries the sheet URL, so the phone does not have to be typed into.
   The URL is per-device by design, which is exactly why it has to be carried
   across by hand or by link - a sync cannot deliver it. */
function togglePairing() {
  const out = document.getElementById('pairOut');
  if (!out) return;
  if (out.style.display !== 'none') { out.style.display = 'none'; return; }
  const url = syncUrl();
  const base = location.origin + location.pathname;
  if (!url) {
    out.innerHTML = 'First set the sync URL on this device (Settings → Google Sheets Sync). ' +
      'Then you will get a link here that pairs the phone by itself when opened.';
    out.style.display = '';
    return;
  }
  const link = base + '?sync=' + encodeURIComponent(url);
  out.innerHTML = 'Send this link to the phone (SMS/WhatsApp) — opening it pairs the phone by itself:' +
    '<input readonly value="' + esc(link) + '" onclick="this.select()">' +
    '<div style="margin-top:7px"><button class="btn-light btn-sm" onclick="copyPairLink(this)">Copy link</button></div>';
  out.style.display = '';
}

function copyPairLink(btn) {
  const inp = btn.parentNode.parentNode.querySelector('input');
  if (!inp) return;
  inp.select();
  try { document.execCommand('copy'); btn.textContent = 'Copied ✓'; }
  catch (e) { btn.textContent = 'Select and copy manually'; }
}

/* A phone that opens ?sync=<url> adopts the URL and drops it from the address bar,
   so the link is not left in the history with the sheet id in it. */
function adoptSyncFromLink() {
  let raw = '';
  try { raw = new URLSearchParams(location.search).get('sync') || ''; } catch (e) { raw = ''; }
  if (!raw) return false;
  const url = String(raw).trim();
  if (!/^https:\/\/script\.google\.com\//.test(url)) return false;
  if (db.settings.syncUrl === url) return false;
  db.settings.syncUrl = url;
  commit();
  try {
    const clean = location.origin + location.pathname + location.hash;
    history.replaceState(null, '', clean);
  } catch (e) {}
  return true;
}

/* A device whose memos froze a cost of 0 (or a stale one) reports profit that is
   too high - at the extreme, profit equals the whole sale. The owner read this as
   "profit ulta palta" and had no way to tell it apart from the app being broken.
   Say it where he looks, with the exact number and the fix one click away. */
function costWarnHTML() {
  const s = staleCostSummary();
  if (!s.count) return '';
  const over = s.diff < 0;
  return '<div class="sw-head">⚠ ' + s.count + ' memo(s) show the wrong profit</div>' +
    '<div class="sw-body">' +
      'When these memos were written the product had no buying price (cost), ' +
      'so the memo recorded cost <b>0</b>. The product now has a price, but the old memo ' +
      'does not know it — so the profit reads <b>' + money(s.wasProfit) + '</b> when it ' +
      'should be <b>' + money(s.nowProfit) + '</b>' +
      (over ? ' (<b>' + money(Math.abs(s.diff)) + ' too high</b>)' : '') + '.' +
      '<br><br>' +
      '<b>Sales, qty, due and stock are all untouched</b> — only profit and cost are fixed. ' +
      'Nothing is written until you review it and approve.' +
    '</div>' +
    '<div class="row">' +
      '<button class="btn-pink btn-sm" onclick="goFixMemoCost()">Fix the profit</button>' +
    '</div>';
}

/* Send the owner to the repair panel with the preview already open, so he does not
   have to find the card on the Backup page himself. */
function goFixMemoCost() {
  nav('backup');
  setTimeout(function () {
    previewMemoCostRepair();
    const out = document.getElementById('repairOut');
    if (out && out.scrollIntoView) out.scrollIntoView({ block: 'center' });
  }, 60);
}

function renderCostWarn() {
  const html = costWarnHTML();
  [['costWarn', 'dashboard'], ['costWarnProfit', 'profit']].forEach(pair => {
    const box = document.getElementById(pair[0]);
    if (!box) return;
    box.style.display = html ? '' : 'none';
    box.innerHTML = html;
  });
}

function renderDashboard() {
  const t0 = today();
  const monthStart = t0.slice(0, 8) + '01';
  const t = plSummary(t0, t0);
  const m = plSummary(monthStart, t0);
  const all = plSummary('', '');

  set('kTodaySales', money(t.sales));
  set('kTodayProfit', money(t.grossProfit));
  set('kMonthSales', money(m.sales));
  set('kMonthProfit', money(m.grossProfit));
  set('kReceivable', money(totalReceivable()));
  set('kPayable', money(totalPayable()));
  set('kStockValue', money(stockValue()));
  set('kNetProfit', money(all.netProfit));

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const per = days.map(d => {
    let s = 0, pr = 0;
    db.memos.forEach(x => {
      if (x.date !== d) return;
      const soldValue = (x.items || []).reduce((a, it) => a + num(it.qty) * num(it.rate), 0);
      const ratio = soldValue > 0 ? Math.min(1, returnedValueOnMemo_(x) / soldValue) : 0;
      s += round2(num(x.grandTotal) * (1 - ratio) - num(x.advance));
      pr += round2(num(x.profit) * (1 - ratio));
    });
    return { d, s, pr };
  });
  const maxS = Math.max(1, ...per.map(x => x.s));
  document.getElementById('dashChart').innerHTML = per.map(x =>
    '<div class="col" title="' + x.d + ' - Sales ' + money(x.s) + ' / Profit ' + money(x.pr) + '">' +
    '<i class="p" style="height:' + Math.max(2, (x.pr / maxS) * 100) + '%"></i>' +
    '<i class="s" style="height:' + Math.max(2, (x.s / maxS) * 100) + '%"></i></div>').join('');
  document.getElementById('dashChartX').innerHTML = days.map(d => '<span>' + d.slice(8) + '</span>').join('');

  const recent = db.memos.slice(-6).reverse();
  document.getElementById('dashMemos').innerHTML = recent.length
    ? recent.map(x => '<p><b>' + esc(x.memoNo) + '</b> - ' + esc(x.customerName) +
        ' <span style="float:right">' + money(x.grandTotal) + '</span></p>').join('')
    : '<div class="empty">No memos yet</div>';

  const low = db.products.map(p => ({ p, s: db.stock.find(x => x.productId === p.id) }))
    .filter(x => num(x.s?.available) <= (num(x.p.reorderLevel) || num(db.settings.lowStockLevel)))
    .sort((a, b) => num(a.s?.available) - num(b.s?.available));
  document.getElementById('dashLow').innerHTML = low.length
    ? low.slice(0, 8).map(x => '<p>' + esc(x.p.name) +
        ' <span class="pill ' + (num(x.s?.available) <= 0 ? 'danger' : 'warn') + '" style="float:right">' +
        num(x.s?.available) + ' left</span></p>').join('')
    : '<div class="empty">All products above reorder level</div>';

  const top = {};
  db.memos.forEach(x => x.items.forEach(i => {
    top[i.productName] = top[i.productName] || { qty: 0, profit: 0 };
    top[i.productName].qty += num(i.qty);
    top[i.productName].profit += round2(num(i.amount) - num(i.qty) * num(i.cost));
  }));
  const topArr = Object.entries(top).sort((a, b) => b[1].profit - a[1].profit).slice(0, 6);
  const maxP = Math.max(1, ...topArr.map(x => x[1].profit));
  document.getElementById('dashTop').innerHTML = topArr.length
    ? topArr.map(([n, v]) => '<div class="bar-row"><div class="nm">' + esc(n) + '</div>' +
        '<div class="track"><div class="fill" style="width:' + Math.max(2, (v.profit / maxP) * 100) + '%"></div></div>' +
        '<div class="val">' + money(v.profit) + '</div></div>').join('')
    : '<div class="empty">No sales yet</div>';

  document.getElementById('dashDeliveries').innerHTML = pendingDeliveryHTML();
  renderDashOrderSummary();
  renderSyncWarning();
  renderCostWarn();
}

/* The dashboard's Order Command Center entry: the same four tiles the Orders page
   shows, from the same orderSummary(), so the two can never disagree. */
function renderDashOrderSummary() {
  const el = document.getElementById('dashOrderSummary');
  if (el) el.innerHTML = orderSummaryTilesHTML();
}

function pendingDeliveryHTML() {
  const rows = db.memos.map(m => {
    const d = deliveredQtyOf(m.id) + returnedQtyOf(m.id);
    return { m, pend: num(m.totalQty) - d };
  }).filter(x => x.pend > 0).slice(-8);
  if (!rows.length) return '<div class="empty">Nothing pending delivery</div>';
  return '<div class="tablewrap"><table><thead><tr><th>Memo</th><th>Customer</th><th>Pending</th></tr></thead><tbody>' +
    rows.map(x => '<tr><td>' + esc(x.m.memoNo) + '</td><td>' + esc(x.m.customerName) +
      '</td><td><span class="pill warn">' + x.pend + '</span></td></tr>').join('') + '</tbody></table></div>';
}

/* ===================== Order Command Center =====================
   The dashboard the owner asked for: a business summary, the orders that need
   attention first, a delivery calendar, reminders, and the full order board. All
   of the counts and colours come from the pure helpers in db.js, so the dashboard
   banner, the Orders page and the calendar always tell the same story. */
var orderCalMonth = null;      // 'YYYY-MM' being shown in the calendar
var orderCalSel = null;        // 'YYYY-MM-DD' the owner last clicked

function orderSummaryTilesHTML() {
  const s = orderSummary();
  return tile('All active', s.active, 'Active Orders', 'blue') +
    tile('Upcoming', s.upcoming7, 'Next 7 Days', 'violet') +
    tile('Attention', s.overdue, 'Overdue Orders', 'danger') +
    tile('Ready', s.ready, 'Ready to Deliver', 'green');
  function tile(label, v, sub, cls) {
    return '<div class="ostile ' + cls + '"><div class="olabel">' + label + '</div>' +
      '<div class="ovalue">' + String(v).padStart(2, '0') + '</div>' +
      '<div class="osub">' + sub + '</div></div>';
  }
}

function ordStatusBadgeHTML(status) {
  const label = status === 'overdue' ? 'Overdue' : (ORDER_STATUS_LABEL[status] || status);
  return '<span class="badge ' + status + '">' + esc(label) + '</span>';
}

function ordDateLabel(d) {
  if (!d) return 'No date';
  const parts = String(d).slice(0, 10).split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return parts[2] + ' ' + (months[num(parts[1]) - 1] || '') + ' ' + parts[0];
}

function orderCardHTML(o, ref) {
  const st = orderDisplayStatus(o, ref);
  return '<div class="ocard s-' + st + '" onclick="openOrder(\'' + o.id + '\')">' +
    '<div class="ohead"><span class="ono">' + esc(o.orderNo || '(no number)') + '</span>' + ordStatusBadgeHTML(st) + '</div>' +
    '<div class="ocust">' + esc(o.customerName || '-') + '</div>' +
    '<div class="oprod">' + esc(o.productName || '-') + (num(o.qty) ? ' · ' + num(o.qty) + ' pcs' : '') + '</div>' +
    '<div class="odate"><span>Delivery date</span><b>' + ordDateLabel(o.deliveryDate) + '</b></div>' +
    (o.priority && o.priority !== 'normal'
      ? '<div class="oprio">' + esc(o.priority) + ' priority</div>' : '') +
    (typeof ordCourierBadgeHTML === 'function' ? ordCourierBadgeHTML(o) : '') +
  '</div>';
}

function renderOrders() {
  const sumEl = document.getElementById('ordSummary');
  if (sumEl) sumEl.innerHTML = orderSummaryTilesHTML();
  ordFillStatusFilter();
  renderOrderAttention();
  renderOrderReminders();
  renderOrderBoard();
  if (!orderCalMonth) orderCalMonth = today().slice(0, 7);
  renderOrderCalendar();
}

function ordFillStatusFilter() {
  const sel = document.getElementById('ordFilterStatus');
  if (!sel) return;
  const cur = sel.value;
  let html = '<option value="">All statuses</option><option value="overdue">Overdue</option>';
  ORDER_STATUSES.forEach(s => { html += '<option value="' + s + '">' + ORDER_STATUS_LABEL[s] + '</option>'; });
  sel.innerHTML = html;
  sel.value = cur;
}

/* Needs Your Attention: overdue first, then anything due within three days. The
   owner should not have to scroll the whole list to find the fire. */
function renderOrderAttention() {
  const ref = today();
  const box = document.getElementById('ordAttention');
  if (!box) return;
  const soonCut = addDays_(ref, 3);
  const items = ordersByUrgency(ref).filter(o => {
    if (!isOrderActive(o)) return false;
    return isOrderOverdue(o, ref) || (o.deliveryDate >= ref && o.deliveryDate <= soonCut);
  }).slice(0, 8);
  const cnt = document.getElementById('ordAttnCount');
  if (cnt) cnt.textContent = String(items.length);
  if (!items.length) { box.innerHTML = '<div class="empty">Nothing urgent. Every active order is on schedule.</div>'; return; }
  box.innerHTML = items.map(o => {
    const late = orderDaysLate_(o, ref);
    const over = isOrderOverdue(o, ref);
    const dueToday = String(o.deliveryDate || '').slice(0, 10) === ref;
    const tag = over ? ('OVERDUE — ' + late + ' day' + (late === 1 ? '' : 's') + ' late')
      : (dueToday ? 'DUE TODAY' : 'DUE ' + ordDateLabel(o.deliveryDate).toUpperCase());
    return '<div class="attn ' + (over ? 'overdue' : 'soon') + '">' +
      '<div class="arow"><span class="badge ' + (over ? 'overdue' : 'received') + '">' + esc(tag) + '</span>' +
      '<span class="ano">' + esc(o.orderNo || '') + '</span><span class="acust">' + esc(o.customerName || '') + '</span>' +
      '<span class="aact"><button class="btn-light btn-sm" onclick="openOrder(\'' + o.id + '\')">Open</button>' +
      (o.status !== 'delivered' ? '<button class="btn-green btn-sm" onclick="setOrderStatus(\'' + o.id + '\',\'delivered\')">Mark Delivered</button>' : '') +
      '</span></div>' +
      '<div class="ameta">' + esc(o.productName || '') + (num(o.qty) ? ' · ' + num(o.qty) + ' pcs' : '') +
      ' · Expected: ' + ordDateLabel(o.deliveryDate) + '</div></div>';
  }).join('');
}

/* Reminder Center: everything due today across active orders, plus their own lead
   time. Same pure orderRemindersFor() the tests exercise. */
function renderOrderReminders() {
  const ref = today();
  const box = document.getElementById('ordReminders');
  if (!box) return;
  const rows = [];
  (db.orders || []).forEach(o => {
    orderRemindersFor(o, ref).forEach(r => rows.push({ o, r }));
  });
  rows.sort((a, b) => (a.r.kind === 'overdue' ? 0 : 1) - (b.r.kind === 'overdue' ? 0 : 1));
  const cnt = document.getElementById('ordRemindCount');
  if (cnt) cnt.textContent = String(rows.length);
  if (!rows.length) { box.innerHTML = '<div class="empty">No reminders for today.</div>'; return; }
  const seen = {};
  box.innerHTML = rows.slice(0, 12).map(x => {
    seen[x.r.kind] = true;
    return '<div class="remitem ' + x.r.kind + '"><span class="rdot"></span><div>' +
      '<div class="rtext">' + esc(x.r.text) + '</div>' +
      '<div class="rsub">' + esc(x.o.customerName || '') + ' · ' + ordDateLabel(x.o.deliveryDate) + '</div></div></div>';
  }).join('');
}

function ordSearchText(o) {
  return [o.orderNo, o.customerName, o.phone, o.productName, o.note].map(v => String(v || '').toLowerCase()).join(' | ');
}

function renderOrderBoard() {
  const box = document.getElementById('ordBoard');
  if (!box) return;
  const ref = today();
  const q = (document.getElementById('ordSearch')?.value || '').trim().toLowerCase();
  const fs = document.getElementById('ordFilterStatus')?.value || '';
  const ft = document.getElementById('ordFilterTime')?.value || '';
  const weekEnd = addDays_(ref, 7);
  const monthEnd = ref.slice(0, 8) + '31';
  let list = ordersByUrgency(ref);
  if (q) list = list.filter(o => ordSearchText(o).indexOf(q) !== -1);
  if (fs === 'overdue') list = list.filter(o => isOrderOverdue(o, ref));
  else if (fs) list = list.filter(o => o.status === fs);
  if (ft === 'overdue') list = list.filter(o => isOrderOverdue(o, ref));
  if (ft === 'today') list = list.filter(o => String(o.deliveryDate || '').slice(0, 10) === ref);
  if (ft === 'week') list = list.filter(o => o.deliveryDate >= ref && o.deliveryDate <= weekEnd);
  if (ft === 'month') list = list.filter(o => o.deliveryDate >= ref.slice(0, 8) + '01' && o.deliveryDate <= monthEnd);
  if (!list.length) {
    box.innerHTML = '<div class="empty">No orders match. ' +
      ((db.orders || []).length ? 'Try clearing the search or filters.' : 'Tap “+ New Order” to add the first one.') + '</div>';
    return;
  }
  box.innerHTML = list.map(o => orderCardHTML(o, ref)).join('');
}

/* ---------- calendar ---------- */
function ordCalShift(n) {
  const d = new Date(orderCalMonth + '-01T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  orderCalMonth = d.toISOString().slice(0, 7);
  orderCalSel = null;
  renderOrderCalendar();
}
function ordCalToday() { orderCalMonth = today().slice(0, 7); orderCalSel = null; renderOrderCalendar(); }
function ordCalPickDate(date) { orderCalSel = date; renderOrderCalendar(); }

function renderOrderCalendar() {
  const grid = document.getElementById('ordCalendar');
  const title = document.getElementById('ordCalTitle');
  if (!grid) return;
  const ref = today();
  const [y, m] = orderCalMonth.split('-').map(x => num(x));
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const startDow = first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (title) title.textContent = months[m - 1] + ' ' + y;
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let html = dows.map(d => '<div class="cdow">' + d + '</div>').join('');
  const cells = Math.ceil((startDow + daysInMonth) / 7) * 7;
  for (let i = 0; i < cells; i++) {
    const dayNum = i - startDow + 1;
    if (dayNum < 1 || dayNum > daysInMonth) { html += '<div class="cday out"></div>'; continue; }
    const ds = orderCalMonth + '-' + String(dayNum).padStart(2, '0');
    const list = ordersOnDate(ds, ref);
    const hasOver = list.some(o => isOrderOverdue(o, ref));
    const cls = hasOver ? 'danger' : (list.length >= 5 ? 'warn' : 'ok');
    const label = list.length
      ? (list.length >= 5 ? list.length + ' Deliveries' : list.length + ' order' + (list.length > 1 ? 's' : ''))
      : '';
    html += '<div class="cday' + (ds === ref ? ' today' : '') + (ds === orderCalSel ? ' sel' : '') +
      '" onclick="ordCalPickDate(\'' + ds + '\')"><div class="cnum">' + dayNum + '</div>' +
      (label ? '<div class="cbar"><span class="ccount ' + cls + '">' + label + '</span></div>' : '') + '</div>';
  }
  grid.innerHTML = html;
  renderOrderDay(ref);
}

function renderOrderDay(ref) {
  const box = document.getElementById('ordCalDay');
  if (!box) return;
  if (!orderCalSel) { box.innerHTML = ''; return; }
  const list = ordersOnDate(orderCalSel, ref);
  box.innerHTML = '<h3>' + ordDateLabel(orderCalSel) + ' — ' + list.length + ' delivery' + (list.length === 1 ? '' : 'ies') + '</h3>' +
    (list.length
      ? '<div class="ordboard">' + list.map(o => orderCardHTML(o, ref)).join('') + '</div>'
      : '<div class="empty">No delivery scheduled on this date.</div>');
}

/* ---------- create / edit ---------- */
function nextOrderNo(prefix) {
  const p = prefix || db.settings.orderPrefix || 'TP-';
  let max = 0;
  (db.orders || []).forEach(o => {
    const mm = String(o.orderNo || '').match(/(\d+)\s*$/);
    if (mm) max = Math.max(max, num(mm[1]));
  });
  return p + String(max + 1).padStart(4, '0');
}

function ordRenderCustomerOptions() {
  const sel = document.getElementById('ordCustList');
  if (sel) {
    sel.innerHTML = '<option value="">- select saved customer -</option>' +
      (db.customers || []).map(c => '<option value="' + c.id + '">' + esc(c.name) + (c.phone ? ' · ' + esc(c.phone) : '') + '</option>').join('');
  }
  const dl = document.getElementById('ordCustomerNames');
  if (dl) dl.innerHTML = (db.customers || []).map(c => '<option value="' + esc(c.name) + '">').join('');
  const dp = document.getElementById('ordProductNames');
  if (dp) dp.innerHTML = (db.products || []).map(p => '<option value="' + esc(p.name) + '">').join('');
}

function ordPickCustomer(cid) {
  const c = (db.customers || []).find(x => x.id === cid);
  if (!c) return;
  const n = document.getElementById('ordCustomer'); if (n) n.value = c.name || '';
  const p = document.getElementById('ordPhone'); if (p) p.value = c.phone || '';
}

function openOrder(oid) {
  ordRenderCustomerOptions();
  const sel = document.getElementById('ordStatus');
  if (sel) sel.innerHTML = ORDER_STATUSES.map(s => '<option value="' + s + '">' + ORDER_STATUS_LABEL[s] + '</option>').join('');
  const o = oid ? (db.orders || []).find(x => x.id === oid) : null;
  document.getElementById('ordId').value = o ? o.id : '';
  document.getElementById('ordModalTitle').textContent = o ? 'Edit Order' : 'New Order';
  document.getElementById('ordNo').value = o ? (o.orderNo || '') : nextOrderNo();
  document.getElementById('ordDate').value = o ? (o.orderDate || today()) : today();
  document.getElementById('ordCustomer').value = o ? (o.customerName || '') : '';
  document.getElementById('ordPhone').value = o ? (o.phone || '') : '';
  document.getElementById('ordProduct').value = o ? (o.productName || '') : '';
  document.getElementById('ordQty').value = o ? num(o.qty) : '';
  document.getElementById('ordDeliveryDate').value = o ? (o.deliveryDate || '') : addDays_(today(), 7);
  const st = document.getElementById('ordStatus');
  if (st) st.value = o ? (o.status || 'received') : 'received';
  document.getElementById('ordPriority').value = o ? (o.priority || 'normal') : 'normal';
  document.getElementById('ordRemindLead').value = (o && o.remindLeadDays !== undefined && o.remindLeadDays !== null && o.remindLeadDays !== '') ? o.remindLeadDays : '';
  document.getElementById('ordNote').value = o ? (o.note || '') : '';
  const tu = document.getElementById('ordTrackingUrl');
  if (tu) tu.value = o ? (o.trackingUrl || '') : '';
  const cs = document.getElementById('ordConsignment');
  if (cs) cs.value = o ? (o.consignmentId || '') : '';
  document.getElementById('ordDeleteBtn').style.display = o ? '' : 'none';
  const info = document.getElementById('ordModalInfo');
  if (info) info.textContent = o ? ('Created ' + ordDateLabel((o.createdAt || '').slice(0, 10)) + (o.status === 'delivered' ? ' · Delivered' : '')) : 'Fill in the order details.';
  const hist = document.getElementById('ordHistory');
  if (hist) {
    const h = (o && Array.isArray(o.history)) ? o.history.slice().reverse() : [];
    hist.innerHTML = h.length
      ? '<div class="muted" style="font-weight:700;margin-bottom:4px">History</div>' +
        h.map(x => '<div class="hrow"><b>' + ordDateLabel((x.at || '').slice(0, 10)) + '</b> — ' + esc(x.text || '') + '</div>').join('')
      : '';
  }
  if (typeof renderOrderCourier === 'function') renderOrderCourier();
  document.getElementById('orderModal').classList.add('show');
}
function closeOrder() { document.getElementById('orderModal').classList.remove('show'); }

function saveOrder() {
  const oid = document.getElementById('ordId').value;
  const customer = document.getElementById('ordCustomer').value.trim();
  const product = document.getElementById('ordProduct').value.trim();
  const deliveryDate = document.getElementById('ordDeliveryDate').value;
  if (!customer) return alert('Customer name is required.');
  if (!product) return alert('Product / description is required.');
  if (!deliveryDate) return alert('Delivery date is required.');
  const now = new Date().toISOString();
  const o = oid ? db.orders.find(x => x.id === oid) : null;
  const prevStatus = o ? o.status : null;
  const fields = {
    orderNo: document.getElementById('ordNo').value.trim() || nextOrderNo(),
    orderDate: document.getElementById('ordDate').value || today(),
    customerName: customer,
    phone: document.getElementById('ordPhone').value.trim(),
    productName: product,
    qty: num(document.getElementById('ordQty').value),
    deliveryDate: deliveryDate,
    status: document.getElementById('ordStatus').value || 'received',
    priority: document.getElementById('ordPriority').value || 'normal',
    remindLeadDays: document.getElementById('ordRemindLead').value === '' ? null : num(document.getElementById('ordRemindLead').value),
    note: document.getElementById('ordNote').value.trim(),
    trackingUrl: valueOfEl_('ordTrackingUrl').trim(),
    consignmentId: valueOfEl_('ordConsignment').trim() || extractConsignment_(valueOfEl_('ordTrackingUrl'))
  };
  if (o) {
    Object.assign(o, fields);
    o.history = o.history || [];
    if (prevStatus && prevStatus !== fields.status) {
      o.history.push({ at: now, text: 'Status: ' + (ORDER_STATUS_LABEL[prevStatus] || prevStatus) + ' → ' + (ORDER_STATUS_LABEL[fields.status] || fields.status) });
    } else {
      o.history.push({ at: now, text: 'Order details updated' });
    }
  } else {
    db.orders.push(Object.assign({ id: id(), createdAt: now, history: [{ at: now, text: 'Order created' }] }, fields));
  }
  if (!commit()) return;
  const rec = o || db.orders[db.orders.length - 1];
  syncPush('order', {
    orderId: rec.id, orderNo: rec.orderNo, customerName: rec.customerName,
    productName: rec.productName, qty: rec.qty, deliveryDate: rec.deliveryDate, status: rec.status
  }, 'Order ' + rec.orderNo);
  closeOrder();
}

function deleteOrderRecord() {
  const oid = document.getElementById('ordId').value;
  if (!oid) return;
  if (!confirm('Delete this order? This cannot be undone.')) return;
  db.orders = db.orders.filter(x => x.id !== oid);
  if (!commit()) return;
  closeOrder();
}

/* Quick status moves from the priority list and the board. Kept as one path so the
   history line and the cloud push are never skipped. */
function setOrderStatus(oid, status) {
  const o = (db.orders || []).find(x => x.id === oid);
  if (!o) return;
  const prev = o.status;
  if (prev === status) return;
  o.status = status;
  o.history = o.history || [];
  o.history.push({ at: new Date().toISOString(), text: 'Status: ' + (ORDER_STATUS_LABEL[prev] || prev) + ' → ' + (ORDER_STATUS_LABEL[status] || status) });
  if (!commit()) return;
  syncPush('order', {
    orderId: o.id, orderNo: o.orderNo, customerName: o.customerName,
    productName: o.productName, qty: o.qty, deliveryDate: o.deliveryDate, status: o.status
  }, 'Order ' + o.orderNo);
}

/* ===================== memo (the fixed screen) ===================== */
function newMemo() {
  editingMemoId = null;
  memoDraft = { items: [] };
  const b = document.getElementById('memoEditingBanner');
  b.style.display = 'none'; b.textContent = '';
  document.getElementById('memoNo').value = nextMemoNo();
  document.getElementById('memoDate').value = today();
  ['customerName', 'customerPhone', 'customerAddress', 'memoNote'].forEach(i => document.getElementById(i).value = '');
  const hint = document.getElementById('memoCustHint');
  if (hint) { hint.innerHTML = ''; hint.className = ''; }
  renderCustomerOptions();
  document.getElementById('memoDiscount').value = 0;
  document.getElementById('memoDeliveryCharge').value = 0;
  document.getElementById('memoAdvance').value = 0;
  addMemoLine(); addMemoLine(); addMemoLine();
  calcMemo();
  renderMemoOrderBlock();
}

function addMemoLine(data) {
  memoDraft.items.push(Object.assign({ productId: '', qty: 1, rate: 0, cost: 0, vat: 0, amount: 0 }, data || {}));
  renderMemoLines();
}

function renderMemoLines() {
  const tb = document.getElementById('memoRows');
  if (!tb) return;
  tb.innerHTML = memoDraft.items.map((it, i) => {
    const p = productById(it.productId);
    const s = p ? db.stock.find(x => x.productId === p.id) : null;
    const avail = num(s?.available);
    const notEntered = it.productId && num(it.qty) > avail && db.settings.warnOnShortStock !== false;
    const margin = num(it.qty) * (num(it.rate) - num(it.cost));
    return '<tr>' +
      '<td class="right">' + String(i + 1).padStart(2, '0') + '</td>' +
      '<td><select onchange="memoPickProduct(' + i + ',this.value)">' +
        '<option value="">- select -</option>' +
        db.products.map(x => '<option value="' + x.id + '"' + (x.id === it.productId ? ' selected' : '') + '>' +
          esc(x.name) + (x.sku ? ' [' + esc(x.sku) + ']' : '') + '</option>').join('') +
      '</select></td>' +
      '<td class="right"><span id="memoAvail' + i + '" class="pill ' + (avail <= 0 ? 'danger' : avail <= num(p?.reorderLevel) ? 'warn' : 'ok') + '">' +
        (it.productId ? avail : '-') + '</span></td>' +
      '<td><input id="memoRate' + i + '" class="' + (notEntered ? 'warn-field' : '') + '" type="number" step="0.01" value="' + num(it.rate) + '" oninput="memoSet(' + i + ',\'rate\',this.value)"></td>' +
      '<td><input id="memoQty' + i + '" class="' + (notEntered ? 'warn-field' : '') + '" type="number" min="0" step="1" value="' + num(it.qty) + '" oninput="memoSet(' + i + ',\'qty\',this.value)"></td>' +
      '<td class="right" id="memoAmount' + i + '">' + money(num(it.qty) * num(it.rate)) + '</td>' +
      '<td class="right">' + money(num(it.qty) * num(it.cost)) + '</td>' +
      '<td class="right" id="memoMargin' + i + '"><b class="' + (margin >= 0 ? 'green' : 'red') + '">' + money(margin) + '</b></td>' +
      '<td><button class="btn-danger btn-sm" onclick="memoDel(' + i + ')">x</button></td>' +
      '</tr>';
  }).join('');
}

/* Refresh the cells of one memo row that depend on the value just typed, without
   rebuilding the row. The inputs are left alone on purpose: rewriting an input
   the owner is typing in is what moved the caret out of the box. */
function memoPatchLine(i) {
  const it = memoDraft.items[i];
  if (!it) return;
  const p = productById(it.productId);
  const s = p ? db.stock.find(x => x.productId === p.id) : null;
  const avail = num(s?.available);
  const notEntered = it.productId && num(it.qty) > avail && db.settings.warnOnShortStock !== false;

  const pill = document.getElementById('memoAvail' + i);
  if (pill) {
    pill.className = 'pill ' + (avail <= 0 ? 'danger' : avail <= num(p?.reorderLevel) ? 'warn' : 'ok');
    pill.textContent = it.productId ? String(avail) : '-';
  }
  ['memoRate' + i, 'memoQty' + i].forEach(cid => {
    const inp = document.getElementById(cid);
    if (inp) inp.className = notEntered ? 'warn-field' : '';
  });
  const amt = document.getElementById('memoAmount' + i);
  if (amt) amt.textContent = money(num(it.qty) * num(it.rate));
  const margin = num(it.qty) * (num(it.rate) - num(it.cost));
  const mg = document.getElementById('memoMargin' + i);
  if (mg) mg.innerHTML = '<b class="' + (margin >= 0 ? 'green' : 'red') + '">' + money(margin) + '</b>';
}

/* The row count is the one thing that cannot be patched in place - a line was
   added or removed. Anything else is patched so typing keeps its caret. */
function memoSyncLines() {
  const tb = document.getElementById('memoRows');
  if (!tb) return;
  const rendered = tb.children ? tb.children.length : -1;
  if (rendered !== memoDraft.items.length) { renderMemoLines(); return; }
  memoDraft.items.forEach((_, i) => memoPatchLine(i));
}

function memoPickProduct(i, pid) {
  const it = memoDraft.items[i];
  const p = productById(pid);
  it.productId = pid;
  if (p) { it.rate = num(p.rate); it.vat = num(p.vat); it.cost = stockCost(p.id) || num(p.cost); }
  renderMemoLines();
  calcMemo();
}

function memoSet(i, field, v) {
  memoDraft.items[i][field] = num(v);
  /* Re-rendering the whole table here would throw the caret out of the box the
     owner is typing in after the first digit. Only the cells that actually
     depend on the value change in place instead. */
  memoPatchLine(i);
  calcMemo();
}

function memoDel(i) {
  memoDraft.items.splice(i, 1);
  if (!memoDraft.items.length) addMemoLine();
  renderMemoLines();
  calcMemo();
}

function memoCharges() {
  return {
    discount: num(document.getElementById('memoDiscount').value),
    deliveryCharge: num(document.getElementById('memoDeliveryCharge').value),
    advance: num(document.getElementById('memoAdvance').value)
  };
}

function calcMemo() {
  const valid = memoDraft.items.filter(x => x.productId && num(x.qty) > 0);
  valid.forEach(it => { it.cost = stockCost(it.productId) || num(it.cost); it.vat = num(it.vat); });
  const m = memoMath(valid, memoCharges());

  set('memoTotalQty', String(valid.reduce((a, x) => a + num(x.qty), 0)));
  set('memoSubtotal', money(m.subtotal));
  set('memoDiscountTotal', money(m.discount));
  set('memoDeliveryTotal', money(m.deliveryCharge));
  set('memoVatAmount', money(m.vat));
  set('memoGrand', money(m.grandTotal));
  set('memoAdvanceTotal', money(m.advance));
  set('memoDue', money(m.due));
  set('memoCogs', money(m.cogs));
  set('memoProfit', money(m.profit));

  const box = document.getElementById('memoStockWarn');
  const saveBtn = document.getElementById('memoSaveBtn');
  const short = db.settings.warnOnShortStock === false ? [] : checkStockForItems(valid);

  /* Memo save ALWAYS works. This is just a heads-up that the stock book for these
     products has not been filled in yet - not a reason to block the sale. */
  if (short.length) {
    box.innerHTML = '<div class="note warn"><b>Stock for these products has not been entered yet:</b>' +
      '<div class="shortlist"><table><thead><tr><th>Product</th><th class="right">On the memo</th>' +
      '<th class="right">In stock</th><th class="right">Short</th></tr></thead><tbody>' +
      short.map(p => '<tr><td>' + esc(p.name) + '</td><td class="right">' + p.requested +
        '</td><td class="right">' + p.available + '</td><td class="right"><b>' + p.short +
        '</b></td></tr>').join('') + '</tbody></table></div>' +
      '<div class="hint">The memo still saves — and these products appear on the Stock page by themselves. ' +
      'Enter the "Received / Opening" qty on the <b>Stock</b> page later. A memo is never blocked.</div></div>';
    if (saveBtn) saveBtn.disabled = false;
  } else {
    box.innerHTML = valid.length ? '<div class="note good">Stock is available — you can save the memo.</div>' : '';
    if (saveBtn) saveBtn.disabled = false;
  }

  const cl = document.getElementById('memoCustList');
  if (cl) cl.innerHTML = '<option value="">- New / Select -</option>' +
    db.customers.map(c => '<option value="' + c.id + '">' + esc(c.name) + (c.phone ? ' - ' + esc(c.phone) : '') + '</option>').join('');
  memoSyncLines();
}

/* The owner has hundreds of customers and could not remember who was already saved,
   so typing a name has to recognise it. Matching is on the normalised name: case,
   extra spaces and a stray 'Md.'/'Mst.' must not make one customer look like two. */
function nameKey_(v) {
  return String(v || '').toLowerCase()
    .replace(/\b(md|mst|mrs|mr|miss)\.?\s*/g, '')
    .replace(/[^\w\u0980-\u09FF]+/g, ' ')
    .trim();
}

function customerMatch(name) {
  const k = nameKey_(name);
  if (!k) return null;
  const all = db.customers || [];
  return all.find(c => nameKey_(c.name) === k) || null;
}

/* Names already used in a memo but never added to the customer list (the memo is the
   source of truth, so this happens), plus the saved list. */
function customerNameList() {
  const seen = {}, out = [];
  const push = (n) => { const k = nameKey_(n); if (k && !seen[k]) { seen[k] = 1; out.push(String(n).trim()); } };
  (db.customers || []).forEach(c => push(c.name));
  (db.memos || []).forEach(m => push(m.customerName));
  return out.sort((a, b) => a.localeCompare(b));
}

function renderCustomerOptions() {
  const dl = document.getElementById('customerNames');
  if (dl) dl.innerHTML = customerNameList().map(n => '<option value="' + esc(n) + '"></option>').join('');
}

/* Called as the name is typed: fills in the phone and address from the saved record
   and says plainly whether this customer is already saved. */
function memoCustomerCheck() {
  renderCustomerOptions();
  const box = document.getElementById('memoCustHint');
  const name = (document.getElementById('customerName').value || '').trim();
  if (!box) return;
  if (!name) { box.innerHTML = ''; box.className = ''; return; }
  const c = customerMatch(name);
  if (c) {
    const phone = document.getElementById('customerPhone');
    const addr = document.getElementById('customerAddress');
    // Only fill what is empty - never overwrite what the owner typed.
    if (phone && !phone.value.trim() && c.phone) phone.value = c.phone;
    if (addr && !addr.value.trim() && c.address) addr.value = c.address;
    const ms = (db.memos || []).filter(m => m.customerName === c.name);
    const due = customerDue(c).due;
    box.className = 'note good';
    box.innerHTML = '&#10003; This customer is already saved (' + esc(c.name) + ')' +
      (c.phone ? ' - ' + esc(c.phone) : '') +
      ' | Memos: ' + ms.length +
      (num(due) !== 0 ? ' | Due: ' + money(due) : '');
    return;
  }
  const inMemo = (db.memos || []).some(m => nameKey_(m.customerName) === nameKey_(name));
  box.className = 'note warn';
  box.innerHTML = inMemo
    ? 'A memo exists under this name but the customer is not in the list — saving adds them.'
    : 'New customer — saving adds them to the customer list.';
}

function pickMemoCustomer(cid) {
  const c = db.customers.find(x => x.id === cid);
  if (!c) return;
  document.getElementById('customerName').value = c.name;
  document.getElementById('customerPhone').value = c.phone || '';
  document.getElementById('customerAddress').value = c.address || '';
}

function saveMemo() {
  const valid = memoDraft.items.filter(x => x.productId && num(x.qty) > 0);
  const name = document.getElementById('customerName').value.trim();
  if (!name) return alert('Enter a customer name.');
  if (!valid.length) return alert('Add at least one product with a quantity.');

  /* The memo is the source of truth. It saves even with no stock - and any product
     on it lands in the stock book by itself (with 0 received), so the received qty
     can be entered later. A memo is never blocked. */
  valid.forEach(it => ensureStockCard(it.productId));

  const fin = memoMath(valid, memoCharges());
  const date = document.getElementById('memoDate').value || today();
  const prev = editingMemoId ? db.memos.find(x => x.id === editingMemoId) : null;
  const memoNo = prev ? prev.memoNo : consumeMemoNo();

  const memo = {
    id: editingMemoId || id(),
    memoNo, date,
    customerName: name,
    customerPhone: document.getElementById('customerPhone').value.trim(),
    customerAddress: document.getElementById('customerAddress').value.trim(),
    items: valid.map(x => ({
      productId: x.productId,
      productName: (productById(x.productId) || {}).name || '',
      qty: num(x.qty), rate: num(x.rate), cost: num(x.cost), vat: num(x.vat),
      amount: round2(num(x.qty) * num(x.rate))
    })),
    totalQty: valid.reduce((a, x) => a + num(x.qty), 0),
    subtotal: fin.subtotal, discount: fin.discount, deliveryCharge: fin.deliveryCharge,
    vat: fin.vat, grandTotal: fin.grandTotal, advance: fin.advance, due: fin.due,
    cogs: fin.cogs, profit: fin.profit,
    note: document.getElementById('memoNote').value.trim(),
    savedAt: new Date().toISOString()
  };

  /* A memo that was already partly delivered or returned cannot be shrunk below what
     has already gone out and come back: the delivery and return records are real
     history and would otherwise point at quantities the memo no longer has. */
  if (prev) {
    const out = deliveredQtyOf(prev.id) + returnedQtyOf(prev.id);
    if (out > num(memo.totalQty)) {
      if (!confirm('This memo already has ' + out + ' qty delivered/returned, ' +
        'but the new total is ' + num(memo.totalQty) + '.\n' +
        'Saving will leave the delivery/return figures mismatched - fix them from the Delivery page.\n' +
        'Save anyway?')) return;
    }
  }
  if (prev) { reverseSaleFromStock(prev); Object.assign(prev, memo); }
  else db.memos.push(memo);
  applySaleToStock(memo);

  const c = customerMatch(name);
  if (!c) db.customers.push({ id: id(), name, phone: memo.customerPhone, address: memo.customerAddress });
  else {
    // Fill in what the saved record is missing, but never overwrite what is there.
    if (!c.phone && memo.customerPhone) c.phone = memo.customerPhone;
    if (!c.address && memo.customerAddress) c.address = memo.customerAddress;
  }

  /* Optional: when the switch on the memo page is on, a new memo also opens an order
     on the Order Command Center. Editing an existing memo does not add a second one. */
  let newOrder = null;
  if (db.settings.memoOrderEnabled === true && !prev && can('orders')) {
    const dd = valueOfEl_('memoOrderDate') || addDays_(today(), 7);
    const pr = valueOfEl_('memoOrderPriority') || 'normal';
    const pfx = valueOfEl_('memoOrderPrefix');
    newOrder = createOrderFromMemo(memo, { deliveryDate: dd, priority: pr, orderNo: pfx ? nextOrderNo(pfx) : undefined });
  }

  if (!commit()) return;

  memo.items.forEach(it => syncPush('sale', {
    date: memo.date, memoNo: memo.memoNo, customerName: memo.customerName,
    phone: memo.customerPhone, address: memo.customerAddress,
    productId: it.productId, productName: it.productName,
    qty: it.qty, rate: it.rate, amount: it.amount, cost: it.cost,
    available: num((db.stock.find(s => s.productId === it.productId) || {}).available),
    subtotal: memo.subtotal, discount: memo.discount, deliveryCharge: memo.deliveryCharge,
    vat: memo.vat, grandTotal: memo.grandTotal, advance: memo.advance, due: memo.due,
    cogs: memo.cogs, profit: memo.profit
  }, 'Sale ' + memo.memoNo));

  syncPush('memo', {
    date: memo.date, memoNo: memo.memoNo, customerName: memo.customerName,
    phone: memo.customerPhone, address: memo.customerAddress, totalQty: memo.totalQty,
    subtotal: memo.subtotal, discount: memo.discount, deliveryCharge: memo.deliveryCharge,
    vat: memo.vat, grandTotal: memo.grandTotal, advance: memo.advance, due: memo.due,
    cogs: memo.cogs, profit: memo.profit, status: prev ? 'Updated' : 'Saved'
  }, 'Memo ' + memo.memoNo);

  if (newOrder) {
    syncPush('order', {
      orderId: newOrder.id, orderNo: newOrder.orderNo, customerName: newOrder.customerName,
      productName: newOrder.productName, qty: newOrder.qty, deliveryDate: newOrder.deliveryDate,
      status: newOrder.status
    }, 'Order ' + newOrder.orderNo);
  }

  alert('Memo ' + memo.memoNo + ' saved.\n' +
    (newOrder ? 'Order ' + newOrder.orderNo + ' created on the Order Command Center.\n' : '') +
    'Stock cards were created for these products. Enter the received/opening qty from the Stock page.');
  newMemo();
  renderMemoOrderBlock();
}

/* ===================== history ===================== */
/* ---------- optional: mirror a memo as an order ---------- */
/* The "Add to Orders" card on the memo page is off by default. Turned on, saving a
   memo also opens an order on the Order Command Center, linked back by `memoId` so
   either page can reach the other. While it is off nothing extra is created. */
function toggleMemoOrderBlock() {
  const box = document.getElementById('memoOrderBlock');
  const btn = document.getElementById('memoOrderToggle');
  if (!box) return;
  const show = box.style.display === 'none';
  box.style.display = show ? '' : 'none';
  if (btn) btn.textContent = show ? 'Hide' : 'Show';
}

function onMemoOrderEnable() {
  const on = !!document.getElementById('memoOrderEnable').checked;
  db.settings.memoOrderEnabled = on;
  const fields = document.getElementById('memoOrderFields');
  if (fields) fields.style.display = on ? '' : 'none';
  commit();
}

function renderMemoOrderBlock() {
  const box = document.getElementById('memoOrderBlock');
  if (!box) return;
  const on = db.settings.memoOrderEnabled === true;
  const cb = document.getElementById('memoOrderEnable');
  if (cb) cb.checked = on;
  const fields = document.getElementById('memoOrderFields');
  if (fields) fields.style.display = on ? '' : 'none';
  const d = document.getElementById('memoOrderDate');
  if (d && !d.value) d.value = addDays_(today(), 7);
  const q = document.getElementById('memoOrderQty');
  if (q && !q.value) {
    const total = memoDraft.items.filter(x => x.productId && num(x.qty) > 0).reduce((a, x) => a + num(x.qty), 0);
    q.value = total ? String(total) : '';
  }
  const p = document.getElementById('memoOrderPrefix');
  if (p && !p.value) p.value = db.settings.orderPrefix || 'TP-';
}

/* The order linked to a memo, if any. Keyed on `memoId`, so a memo can never
   silently open two orders. */
function memoOrderLink(memoId) {
  return (db.orders || []).find(o => o.memoId === memoId) || null;
}

/* The one path that turns a saved memo into an order, so the history line and the
   cloud push are never skipped. A memo with a single product takes that product's
   name; a multi-line memo shows its line count. */
function createOrderFromMemo(memo, opts) {
  const o = opts || {};
  const existing = memoOrderLink(memo.id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const items = memo.items || [];
  const productName = items.length === 1 ? (items[0].productName || '') : (items.length + ' items');
  const order = {
    id: id(),
    orderNo: o.orderNo || nextOrderNo(),
    orderDate: memo.date || today(),
    customerName: memo.customerName || '',
    phone: memo.customerPhone || '',
    productName: productName,
    qty: num(memo.totalQty),
    deliveryDate: o.deliveryDate || addDays_(today(), 7),
    status: 'received',
    priority: o.priority || 'normal',
    remindLeadDays: null,
    note: 'From memo ' + memo.memoNo,
    memoId: memo.id,
    memoNo: memo.memoNo,
    createdAt: now,
    history: [{ at: now, text: 'Order created from memo ' + memo.memoNo }]
  };
  db.orders.push(order);
  return order;
}

/* A one-click order from Memo History, so an old memo can be put on the board
   without re-typing it. Opens the link if the memo already has one. */
function createOrderForMemo(mid) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  if (!can('orders')) return alert('You do not have permission.');
  const existing = memoOrderLink(m.id);
  if (existing) { nav('orders'); openOrder(existing.id); return; }
  const o = createOrderFromMemo(m, {});
  if (!commit()) return;
  syncPush('order', {
    orderId: o.id, orderNo: o.orderNo, customerName: o.customerName,
    productName: o.productName, qty: o.qty, deliveryDate: o.deliveryDate, status: o.status
  }, 'Order ' + o.orderNo);
  renderHistory();
  alert('Order ' + o.orderNo + ' created for memo ' + m.memoNo + '.');
}

function renderHistory() {
  const q = (document.getElementById('hSearch').value || '').toLowerCase();
  const arr = db.memos.filter(m =>
    (m.memoNo + ' ' + m.customerName + ' ' + (m.customerPhone || '')).toLowerCase().includes(q)).slice().reverse();
  const cnt = document.getElementById('hCount');
  if (cnt) cnt.textContent = arr.length + (arr.length === 1 ? ' memo' : ' memos') +
    (q ? ' matching' : ' in total');
  document.getElementById('historyTable').innerHTML = arr.length
    ? '<div class="tablewrap"><table><thead><tr><th style="width:44px">SL</th><th>Memo No</th><th>Date</th><th>Customer</th><th class="right">Qty</th>' +
      '<th class="right">Grand</th><th class="right">Profit</th><th class="right">Due</th><th>Delivery</th><th>Orders</th><th></th></tr></thead><tbody>' +
      arr.map((m, i) => {
        const d = deliveredQtyOf(m.id), r = returnedQtyOf(m.id);
        const st = pendingQtyOf(m) <= 0 ? 'ok' : (d || r) ? 'warn' : 'danger';
        const lnk = memoOrderLink(m.id);
        const ordCell = lnk
          ? '<span class="pill ok" title="Order ' + esc(lnk.orderNo) + '">#' + esc(lnk.orderNo) + '</span>'
          : '<button class="btn-light btn-sm" onclick="createOrderForMemo(\'' + m.id + '\')">Create Order</button>';
        return '<tr><td class="right">' + (i + 1) + '</td>' +
          '<td>' + esc(m.memoNo) + '</td><td>' + m.date + '</td><td>' + esc(m.customerName) + '</td>' +
          '<td class="right">' + m.totalQty + '</td><td class="right">' + money(m.grandTotal) + '</td>' +
          '<td class="right"><b class="' + (num(m.profit) >= 0 ? 'green' : 'red') + '">' + money(m.profit) + '</b></td>' +
          '<td class="right">' + money(memoRemainingDue(m)) + '</td>' +
          '<td><span class="pill ' + st + '">' + d + '/' + m.totalQty + (r ? ' <b class="red">R' + r + '</b>' : '') + '</span></td>' +
          '<td>' + ordCell + '</td>' +
          '<td><button class="btn-light btn-sm" onclick="viewMemo(\'' + m.id + '\')">View</button> ' +
          '<button class="btn-light btn-sm" onclick="printMemoById(\'' + m.id + '\')">Print</button> ' +
          '<button class="btn-light btn-sm" onclick="exportMemoById(\'' + m.id + '\',\'png\')">Image</button> ' +
          '<button class="btn-light btn-sm" onclick="exportMemoById(\'' + m.id + '\',\'pdf\')">PDF</button> ' +
          '<button class="btn-light btn-sm" onclick="editMemo(\'' + m.id + '\')">Edit</button> ' +
          '<button class="btn-danger btn-sm" onclick="deleteMemo(\'' + m.id + '\')">Delete</button></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No memos</div>';
}

function editMemo(mid) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  if (!can('memo')) return alert('You do not have permission.');
  editingMemoId = mid;
  memoDraft = { items: m.items.map(i => ({ productId: i.productId, qty: i.qty, rate: i.rate, cost: i.cost, vat: i.vat })) };
  nav('memo');
  document.getElementById('memoNo').value = m.memoNo;
  document.getElementById('memoDate').value = m.date;
  document.getElementById('customerName').value = m.customerName;
  document.getElementById('customerPhone').value = m.customerPhone || '';
  document.getElementById('customerAddress').value = m.customerAddress || '';
  memoCustomerCheck();
  document.getElementById('memoDiscount').value = m.discount || 0;
  document.getElementById('memoDeliveryCharge').value = m.deliveryCharge || 0;
  document.getElementById('memoAdvance').value = m.advance || 0;
  document.getElementById('memoNote').value = m.note || '';
  const b = document.getElementById('memoEditingBanner');
  b.style.display = ''; 
  b.textContent = 'Editing ' + m.memoNo + ' - saving returns the old stock, then deducts the new figures.';
  renderMemoLines();
  calcMemo();
}

function deleteMemo(mid) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  if (!confirm('Delete memo ' + m.memoNo + '? The stock will be returned.')) return;
  reverseSaleFromStock(m);
  /* Receipts the memo's deliveries created go with it. Soft-deleted (`del`) rather
     than removed, so the tombstone travels to the other device and the money stops
     counting everywhere a merge reaches - no orphan receipt left behind. */
  db.payments.forEach(p => { if (p && p.memoId === mid) p.del = true; });
  db.deliveries = db.deliveries.filter(d => d.memoId !== m.id);
  (db.returns || []).filter(r => r.memoId === m.id).forEach(reverseReturnFromStock);
  db.returns = (db.returns || []).filter(r => r.memoId !== m.id);
  db.memos = db.memos.filter(x => x.id !== mid);
  /* An order that was opened from this memo is a separate promise to the customer;
     keep it, but drop the link so it no longer points at a deleted memo. */
  (db.orders || []).forEach(o => {
    if (o.memoId === mid) { delete o.memoId; delete o.memoNo; }
  });
  if (editingMemoId === mid) newMemo();
  if (!commit()) return;
  syncPush('memo_delete', { memoNo: m.memoNo }, 'Delete ' + m.memoNo);
  alert('Memo deleted and the stock returned.');
}

function viewMemo(mid) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  viewingMemoId = mid;
  document.getElementById('viewBody').innerHTML = memoSheet(m);
  const no = document.getElementById('viewMemoNo');
  if (no) no.textContent = m.memoNo + '  |  ' + m.customerName;
  document.getElementById('viewModal').classList.add('show');
}
function closeView() {
  document.getElementById('viewModal').classList.remove('show');
  viewingMemoId = null;
}

function printMemoById(mid) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  printMemoSheet(m);
}

/* Save Image / Save PDF from the preview, the history row, or the memo form. All
   three go through the same renderer so a saved memo looks like the previewed one. */
function exportMemoById(mid, kind) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  kind === 'pdf' ? saveMemoPDF(m) : saveMemoPNG(m);
}

function printViewMemo() {
  const m = db.memos.find(x => x.id === viewingMemoId);
  if (m) printMemoSheet(m);
}

function saveViewMemo(kind) {
  const m = db.memos.find(x => x.id === viewingMemoId);
  if (!m) return;
  kind === 'pdf' ? saveMemoPDF(m) : saveMemoPNG(m);
}

/* ===================== memo sheet (screen + A4 print) ===================== */
/* The sheet's look is defined here, not in css/app.css, because three different
   things have to render it identically: the on-screen preview, the A4 print, and
   the SVG that becomes the PNG/PDF download. An SVG is a separate document and
   cannot read the page's stylesheet, so a sheet styled by the stylesheet would
   download as an unstyled page of black text. One string, three renderers.

   The string is not enough on its own: nothing links it, so the page would show
   the sheet unstyled. memoCssTag() puts it in the document once, on boot. */
const MEMO_CSS = '' +
  '.memo-sheet{font-family:"Segoe UI","Noto Sans Bengali",Arial,sans-serif;color:#1f2937;font-size:12px;' +
    'background:#fff;padding:0;max-width:820px;line-height:1.45}' +
  '.memo-sheet .memo-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;' +
    'background:#0f2b52;color:#fff;padding:18px 20px;border-bottom:4px solid #d92d4b}' +
  '.memo-sheet .memo-co{display:flex;gap:13px;align-items:center;min-width:0}' +
  '.memo-sheet .memo-logo{width:52px;height:52px;border-radius:8px;background:#fff;color:#0f2b52;' +
    'font-weight:800;font-size:18px;display:flex;align-items:center;justify-content:center;letter-spacing:-.5px;flex:0 0 auto}' +
  '.memo-sheet .memo-coname{font-size:21px;font-weight:800;letter-spacing:.3px;line-height:1.1}' +
  '.memo-sheet .memo-cotag{font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:#a9c1e0;margin-top:3px}' +
  '.memo-sheet .memo-codoc{font-size:10.5px;color:#a9c1e0;margin-top:5px}' +
  '.memo-sheet .memo-doc{text-align:right;flex:0 0 auto}' +
  '.memo-sheet .memo-doc h2{margin:0;font-size:19px;letter-spacing:.24em;font-weight:800;color:#fff}' +
  '.memo-sheet .memo-doc .memo-docrow{font-size:11px;margin-top:5px;color:#cfdcee}' +
  '.memo-sheet .memo-doc .memo-docrow b{color:#fff}' +
  /* the enquiry strip under the header band, as in the sample invoices */
  '.memo-sheet .memo-strip{display:flex;justify-content:space-between;gap:16px;background:#f1f5f9;' +
    'border:1px solid #dbe3ec;border-top:0;padding:9px 20px;font-size:11px;color:#334155}' +
  '.memo-sheet .memo-strip b{color:#0f2b52}' +
  '.memo-sheet .memo-cards{display:flex;gap:0;border:1px solid #dbe3ec;border-top:0;margin-top:16px}' +
  '.memo-sheet .memo-card{flex:1;padding:12px 16px;min-width:0}' +
  '.memo-sheet .memo-card + .memo-card{border-left:1px solid #dbe3ec}' +
  '.memo-sheet .memo-card h4{margin:0 0 6px;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;' +
    'color:#d92d4b;font-weight:800}' +
  '.memo-sheet .memo-card .memo-big{font-size:13px;font-weight:700;color:#0f2b52}' +
  '.memo-sheet .memo-card div{font-size:11px;line-height:1.65;color:#475569}' +
  '.memo-sheet .memo-items{width:100%;border-collapse:collapse;margin-top:18px}' +
  '.memo-sheet .memo-items th{background:#0f2b52;color:#fff;padding:9px 10px;font-size:10px;' +
    'letter-spacing:.1em;text-transform:uppercase;text-align:left}' +
  '.memo-sheet .memo-items th:first-child{border-top-left-radius:5px}' +
  '.memo-sheet .memo-items th:last-child{border-top-right-radius:5px}' +
  '.memo-sheet .memo-items td{padding:9px 10px;border-bottom:1px solid #e2e8f0;font-size:11.5px;color:#1f2937}' +
  '.memo-sheet .memo-items tr:nth-child(even) td{background:#f8fafc}' +
  '.memo-sheet .memo-items .right,.memo-sheet .right{text-align:right}' +
  '.memo-sheet .memo-items .memo-sl{color:#94a3b8;font-weight:700;width:34px}' +
  '.memo-sheet .memo-items .memo-empty{text-align:center;color:#94a3b8;padding:16px}' +
  '.memo-sheet .memo-foot{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-top:16px}' +
  '.memo-sheet .memo-left{flex:1;min-width:0}' +
  '.memo-sheet .memo-words{border:1px solid #dbe3ec;border-left:4px solid #d92d4b;background:#f8fafc;' +
    'padding:10px 12px;border-radius:5px;font-size:11px;line-height:1.6;color:#1f2937}' +
  '.memo-sheet .memo-words b{color:#d92d4b;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;' +
    'display:block;margin-bottom:3px}' +
  '.memo-sheet .memo-note{margin-top:10px;font-size:11px;line-height:1.6;color:#475569}' +
  '.memo-sheet .memo-note b{color:#0f2b52;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;display:block;margin-bottom:3px}' +
  '.memo-sheet .memo-tot{width:300px;flex:0 0 auto}' +
  '.memo-sheet .memo-tot table{width:100%;border-collapse:collapse;border:1px solid #dbe3ec}' +
  '.memo-sheet .memo-tot td{padding:7px 12px;font-size:11.5px;color:#334155;border-bottom:1px solid #eef2f7}' +
  '.memo-sheet .memo-tot td + td{text-align:right;font-weight:600;color:#1f2937}' +
  '.memo-sheet .memo-tot tr.memo-grand td{background:#0f2b52;color:#fff;font-weight:800;font-size:13.5px;border:0}' +
  '.memo-sheet .memo-tot tr.memo-grand td + td{color:#fff}' +
  '.memo-sheet .memo-tot tr.memo-due td{background:#fef2f4;color:#b3183a;font-weight:800;font-size:13px;border:0}' +
  '.memo-sheet .memo-tot tr.memo-due td + td{color:#b3183a}' +
  '.memo-sheet .memo-terms{margin-top:12px;border-top:1px dashed #cbd5e1;padding-top:10px;' +
    'font-size:10px;color:#64748b;line-height:1.65}' +
  '.memo-sheet .memo-terms b{color:#0f2b52}' +
  '.memo-sheet .memo-sign{display:flex;justify-content:space-between;gap:24px;margin-top:46px}' +
  '.memo-sheet .memo-sign div{border-top:1px solid #1f2937;padding-top:6px;width:210px;' +
    'text-align:center;font-size:10.5px;color:#64748b}' +
  '.memo-sheet .memo-thanks{margin-top:18px;border-top:3px solid #0f2b52;padding-top:10px;' +
    'text-align:center;font-size:10.5px;color:#64748b}';

/* Puts MEMO_CSS in the document once. Without this the sheet on screen is HTML with
   no styling at all - the exports were fine because the SVG carries its own copy,
   which is exactly why the gap survived a passing test suite. Idempotent, because
   boot() runs again on every PWA resume. */
function memoCssTag() {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById('memoCss')) return;
  const s = document.createElement('style');
  s.id = 'memoCss';
  s.textContent = MEMO_CSS;
  document.head.appendChild(s);
}

/* The payment-due date printed on the sheet: 15 days after the sale, which is the
   same window the terms text promises. Derived rather than stored, so an older memo
   with no dueDate field still prints a sensible date. */
function memoDueDate(date) {
  const d = new Date(String(date || '').replace(/-/g, '/'));
  if (isNaN(d.getTime())) return String(date || '-');
  d.setDate(d.getDate() + 15);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/* Company contact lines, shared by the header block and the exported SVG, so the
   two can never disagree about what the shop's details are. */
function memoCompanyLines(c) {
  c = c || {};
  return [
    c.phone ? 'Phone: ' + c.phone : '',
    c.email ? 'Email: ' + c.email : '',
    c.address ? 'Address: ' + c.address : '',
    c.bin ? 'BIN: ' + c.bin : '',
    c.vatReg ? 'VAT Reg: ' + c.vatReg : ''
  ].filter(Boolean);
}

function memoInitials(name) {
  const w = String(name || 'T').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return 'T';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[1][0]).toUpperCase();
}

function numberWords(n) {
  n = Math.round(num(n));
  if (!n) return 'Zero';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function cv(v) {
    if (v < 20) return ones[v];
    if (v < 100) return tens[Math.floor(v / 10)] + (v % 10 ? ' ' + ones[v % 10] : '');
    if (v < 1000) return ones[Math.floor(v / 100)] + ' Hundred' + (v % 100 ? ' ' + cv(v % 100) : '');
    if (v < 100000) return cv(Math.floor(v / 1000)) + ' Thousand' + (v % 1000 ? ' ' + cv(v % 1000) : '');
    if (v < 10000000) return cv(Math.floor(v / 100000)) + ' Lakh' + (v % 100000 ? ' ' + cv(v % 100000) : '');
    return cv(Math.floor(v / 10000000)) + ' Crore' + (v % 10000000 ? ' ' + cv(v % 10000000) : '');
  }
  return cv(n);
}

/* One product line. The exported renderers walk this instead of the markup, so a
   blank row, a wrapped name or a rounding rule is decided once. */
function memoLineRows(m) {
  return (m.items || []).map((x, i) => ({
    sl: String(i + 1).padStart(2, '0'),
    name: x.productName || '',
    rate: num(x.rate),
    qty: num(x.qty),
    amount: num(x.amount)
  }));
}

function memoSheet(m) {
  const c = db.settings.company || {};
  const rows = memoLineRows(m);
  const body = rows.length
    ? rows.map(r => '<tr><td class="memo-sl">' + r.sl + '</td><td>' + esc(r.name) + '</td>' +
        '<td class="right">' + money(r.rate) + '</td><td class="right">' + num(r.qty) +
        '</td><td class="right"><b>' + money(r.amount) + '</b></td></tr>').join('')
    : '<tr><td class="memo-empty" colspan="5">No products</td></tr>';
  const contacts = memoCompanyLines(c).map(l => '<div>' + esc(l) + '</div>').join('');
  return '<div class="memo-sheet">' +
    '<div class="memo-top">' +
      '<div class="memo-co"><div class="memo-logo">' + esc(memoInitials(c.name)) + '</div>' +
        '<div><div class="memo-coname">' + esc(c.name || 'TEXPARK BUYING HOUSE') + '</div>' +
        '<div class="memo-cotag">' + esc(c.tagline || 'Buying House') + '</div>' +
        (c.md ? '<div class="memo-codoc">MD: ' + esc(c.md) + '</div>' : '') + '</div></div>' +
      '<div class="memo-doc"><h2>SALES MEMO</h2>' +
        '<div class="memo-docrow"><b>Memo No:</b> ' + esc(m.memoNo) + '</div>' +
        '<div class="memo-docrow"><b>Date:</b> ' + esc(m.date) + '</div>' +
        '<div class="memo-docrow"><b>Total Qty:</b> ' + num(m.totalQty) + '</div></div>' +
    '</div>' +
    '<div class="memo-strip">' +
      '<div><b>Due Date:</b> ' + esc(m.dueDate || memoDueDate(m.date)) + '</div>' +
      '<div><b>Payment:</b> ' + esc(m.paymentMode || 'Cash / bKash') + '</div>' +
      '<div><b>Delivery:</b> ' + esc(m.deliveryMode || 'Shop pick-up') + '</div>' +
    '</div>' +
    '<div class="memo-cards">' +
      '<div class="memo-card"><h4>Bill To</h4>' +
        '<div class="memo-big">' + esc(m.customerName) + '</div>' +
        (m.customerPhone ? '<div>Phone: ' + esc(m.customerPhone) + '</div>' : '') +
        (m.customerAddress ? '<div>' + esc(m.customerAddress) + '</div>' : '') + '</div>' +
      '<div class="memo-card"><h4>From</h4>' +
        '<div class="memo-big">' + esc(c.name || '') + '</div>' + contacts + '</div>' +
    '</div>' +
    '<table class="memo-items"><thead><tr><th>SL</th><th>Product Description</th>' +
      '<th class="right">Rate</th><th class="right">Qty</th><th class="right">Amount</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table>' +
    '<div class="memo-foot"><div class="memo-left">' +
      '<div class="memo-words"><b>Amount in Words</b>' + esc(numberWords(num(m.grandTotal))) + ' Taka Only.</div>' +
      (m.note ? '<div class="memo-note"><b>Note</b>' + esc(m.note) + '</div>' : '') +
      '<div class="memo-terms"><b>Terms:</b> Goods are not taken back after sale (unless damaged). ' +
        'The delivery charge has been added to this memo. Please settle the due amount within 15 days of the memo date.</div>' +
      '</div>' +
      '<div class="memo-tot"><table>' +
        '<tr><td>Total Qty</td><td class="right">' + num(m.totalQty) + '</td></tr>' +
        '<tr><td>Subtotal</td><td class="right">' + money(m.subtotal) + '</td></tr>' +
        '<tr><td>Discount</td><td class="right">- ' + money(m.discount) + '</td></tr>' +
        '<tr><td>Delivery Charge</td><td class="right">+ ' + money(m.deliveryCharge) + '</td></tr>' +
        (num(m.vat) ? '<tr><td>VAT</td><td class="right">+ ' + money(m.vat) + '</td></tr>' : '') +
        '<tr class="memo-grand"><td>Grand Total</td><td class="right">' + money(m.grandTotal) + '</td></tr>' +
        (returnedValueOnMemo_(m) > 0
          ? '<tr><td>Less: Returned goods</td><td class="right">- ' + money(returnedValueOnMemo_(m)) + '</td></tr>'
          : '') +
        '<tr><td>Advance</td><td class="right">- ' + money(m.advance) + '</td></tr>' +
        (collectedOnMemo_(m) > 0
          ? '<tr><td>Received (delivery)</td><td class="right">- ' + money(collectedOnMemo_(m)) + '</td></tr>'
          : '') +
        '<tr class="memo-due"><td>Due</td><td class="right">' + money(memoRemainingDue(m)) + '</td></tr>' +
      '</table></div></div>' +
    '<div class="memo-sign"><div>Customer Signature</div><div>Authorized Signature</div></div>' +
    '<div class="memo-thanks">Thank you! Please report any issue with the goods within 3 days.</div>' +
    '</div>';
}

/* ===================== delivery & return ===================== */
/* One row per memo, with the two things that can happen to a parcel: it is
   delivered, or it comes back. They are separate records and separate totals, and
   both are subtracted from what is still out with the customer. */
function renderDelivery() {
  const rows = db.memos.map(m => {
    const d = deliveredQtyOf(m.id), r = returnedQtyOf(m.id);
    return { m, d, r, pend: pendingQtyOf(m) };
  }).slice().reverse();
  document.getElementById('deliveryTable').innerHTML = rows.length
    ? '<div class="tablewrap"><table><thead><tr><th>Memo</th><th>Customer</th><th>Phone</th><th class="right">Sold</th>' +
      '<th class="right">Delivered</th><th class="right">Return</th><th class="right">Pending</th><th>Status</th>' +
      '<th>Driver</th><th>Vehicle</th><th>Receiver</th><th></th></tr></thead><tbody>' +
      rows.map(x => {
        const st = x.pend <= 0 ? 'ok' : (x.d || x.r) ? 'warn' : 'danger';
        const label = x.pend <= 0 ? (x.r >= num(x.m.totalQty) ? 'Returned' : 'Delivered')
          : (x.d || x.r) ? 'Partial' : 'Pending';
        return '<tr><td>' + esc(x.m.memoNo) + '</td><td>' + esc(x.m.customerName) + '</td>' +
          '<td>' + esc(x.m.customerPhone || '') + '</td><td class="right">' + x.m.totalQty + '</td>' +
          '<td class="right">' + x.d + '</td>' +
          '<td class="right">' + (x.r ? '<b class="red">' + x.r + '</b>' : '0') + '</td>' +
          '<td class="right"><b>' + x.pend + '</b></td>' +
          '<td><span class="pill ' + st + '">' + label + '</span></td>' +
          '<td>' + esc(x.m.driver || '-') + '</td><td>' + esc(x.m.vehicle || '-') + '</td>' +
          '<td>' + esc(x.m.receiver || '-') + '</td>' +
          '<td><button class="btn-light btn-sm" onclick="openDelivery(\'' + x.m.id + '\')">Deliver</button> ' +
          '<button class="btn-pink btn-sm" onclick="openReturn(\'' + x.m.id + '\')">Return</button></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No memos</div>';
  const sel = document.getElementById('deliveryMemoSel');
  if (sel) sel.innerHTML = '<option value="">- select memo -</option>' +
    db.memos.slice().reverse().map(m => '<option value="' + m.id + '">' + esc(m.memoNo) + ' - ' + esc(m.customerName) + '</option>').join('');

  /* The return list is its own table: a returned parcel is a record the owner has to
     be able to find again, not just a number inside the delivery row. */
  const rets = (db.returns || []).slice().reverse();
  const rt = document.getElementById('returnTable');
  if (rt) rt.innerHTML = rets.length
    ? '<div class="tablewrap"><table><thead><tr><th>Date</th><th>Memo</th><th>Customer</th><th>Products</th>' +
      '<th class="right">Qty</th><th>Condition</th><th>Note</th><th></th></tr></thead><tbody>' +
      rets.map(x => {
        const m = db.memos.find(y => y.id === x.memoId);
        return '<tr><td>' + esc(x.date) + '</td><td>' + esc(m ? m.memoNo : (x.memoNo || '-')) + '</td>' +
          '<td>' + esc(m ? m.customerName : '-') + '</td>' +
          '<td>' + (x.items || []).map(i => esc(i.productName) + ' x' + num(i.qty)).join(', ') + '</td>' +
          '<td class="right">' + num(x.qty) + '</td>' +
          '<td><span class="pill ' + (x.condition === 'damaged' ? 'danger' : 'ok') + '">' +
            (x.condition === 'damaged' ? 'Damaged' : 'Good - stock e utheche') + '</span></td>' +
          '<td>' + esc(x.note || '') + '</td>' +
          '<td><button class="btn-danger btn-sm" onclick="deleteReturn(\'' + x.id + '\')">Delete</button></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No returns</div>';
}

/* The customer record a memo belongs to, matched the same way customerDue() matches
   memos to a customer, so a receipt lands on the right ledger. */
function customerIdForMemo_(m) {
  const c = db.customers.find(x => x.name === m.customerName && (x.phone || '') === (m.customerPhone || ''));
  return c ? c.id : '';
}

/* How much cash to prefill when a delivery goes out: the memo's remaining due, split
   in proportion to the qty being delivered. A partial delivery of 3 of 10 prefills
   three tenths of what is owed; a full one prefills the lot. The owner can overwrite
   it, including to 0. */
function collectedPrefill_(m, qty) {
  const remaining = memoRemainingDue(m);
  const sold = pendingQtyOf(m) + deliveredQtyOf(m.id) || num(m.totalQty) || 0;
  if (sold <= 0) return remaining;
  const share = Math.min(1, Math.max(0, num(qty) / sold));
  return round2(remaining * share);
}

function openDelivery(mid) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  const d = deliveredQtyOf(mid);
  document.getElementById('dlMemo').value = m.id;
  document.getElementById('dlInfo').innerHTML = esc(m.memoNo) + ' - ' + esc(m.customerName) +
    ' | Sold ' + m.totalQty + ' | Delivered ' + d + ' | Return ' + returnedQtyOf(mid) +
    ' | Pending <b>' + pendingQtyOf(m) + '</b>';
  document.getElementById('dlQty').value = pendingQtyOf(m);
  document.getElementById('dlDriver').value = m.driver || '';
  document.getElementById('dlVehicle').value = m.vehicle || '';
  document.getElementById('dlReceiver').value = m.receiver || '';
  document.getElementById('dlNote').value = m.deliveryNote || '';
  /* The box always starts from what is still owed on the memo, split for a partial
     delivery, so the owner sees the right figure without typing. He can overwrite it. */
  document.getElementById('dlCollect').value = collectedPrefill_(m, pendingQtyOf(m));
  document.getElementById('deliveryModal').classList.add('show');
}
function closeDelivery() { document.getElementById('deliveryModal').classList.remove('show'); }

/* Re-suggest the collection when the delivery qty changes, so the box tracks the
   parcel being sent rather than the one the modal opened with. */
function deliveryQtyChanged() {
  const m = db.memos.find(x => x.id === document.getElementById('dlMemo').value);
  if (!m) return;
  document.getElementById('dlCollect').value = collectedPrefill_(m, num(document.getElementById('dlQty').value));
}

/* Remove the receipt a delivery created. Used both when that delivery is deleted and
   when it is re-entered with different qty, and it is keyed on deliveryId so it can
   never remove a receipt some other delivery (or a manual payment) owns. */
function removePaymentForDelivery_(deliveryId) {
  const hit = db.payments.filter(p => p && !p.del && p.deliveryId === deliveryId);
  hit.forEach(p => { p.del = true; });
  return hit.length;
}

function saveDelivery() {
  const mid = document.getElementById('dlMemo').value;
  const q = num(document.getElementById('dlQty').value);
  const m = db.memos.find(x => x.id === mid);
  if (!m) return alert('Select a memo.');
  if (q <= 0) return alert('Enter a delivery qty.');
  if (q > pendingQtyOf(m)) return alert('Delivery qty cannot exceed what is pending. Pending: ' + pendingQtyOf(m));
  const already = deliveredQtyOf(mid);

  /* What the customer paid. Floored at 0; an over-payment is allowed but clamped down
     to what is actually still owed on the goods kept, with a warning, so the dashboard
     cannot show a negative due and no money is counted against returned goods. */
  let collected = Math.max(0, num(document.getElementById('dlCollect').value));
  const owed = collectableOnMemo_(m);
  if (collected > owed) {
    alert('Collected ' + money(collected) + ' is more than the ' + money(owed) +
      ' still due on this memo, so it is recorded as ' + money(owed) + '.');
    collected = owed;
  }

  /* Clicking Save twice must not create two deliveries or two receipts: if this memo's
     delivery was just saved with the same qty and no field changed, do nothing. */
  const last = db.deliveries[db.deliveries.length - 1];
  if (last && last.memoId === mid && num(last.qty) === q && last.driver === document.getElementById('dlDriver').value.trim()) {
    closeDelivery();
    return;
  }

  const deliveryId = id();
  db.deliveries.push({
    id: deliveryId, memoId: mid, qty: q, date: today(),
    driver: document.getElementById('dlDriver').value.trim(),
    vehicle: document.getElementById('dlVehicle').value.trim(),
    receiver: document.getElementById('dlReceiver').value.trim(),
    note: document.getElementById('dlNote').value.trim()
  });
  /* Status is decided after the record is in, from what is actually still pending -
     writing 'Delivered' unconditionally made every partial delivery read as complete. */
  const pend = pendingQtyOf(m);
  db.deliveries[db.deliveries.length - 1].status = pend <= 0 ? 'Delivered' : 'Partial';
  m.driver = document.getElementById('dlDriver').value.trim();
  m.vehicle = document.getElementById('dlVehicle').value.trim();
  m.receiver = document.getElementById('dlReceiver').value.trim();
  m.deliveryNote = document.getElementById('dlNote').value.trim();

  /* The collection and the delivery are saved in the SAME commit, so the dashboard,
     the memo history, the customer due and the reports all move together - there is no
     instant where a parcel reads delivered but the money is missing, or vice versa. */
  let payment = null;
  if (collected > 0) {
    payment = {
      id: id(), memoId: mid, deliveryId,
      customerId: customerIdForMemo_(m),
      date: today(), amount: collected,
      method: 'Cash', note: 'Collected on delivery ' + m.memoNo
    };
    db.payments.push(payment);
  }

  if (!commit()) return;
  syncPush('delivery', {
    memoNumber: m.memoNo, customer: m.customerName, qty: q, deliveredQty: already + q,
    pendingQty: pend, deliveryDate: today(),
    driver: m.driver, vehicle: m.vehicle, receiver: m.receiver,
    status: pend <= 0 ? 'Delivered' : 'Partial', note: m.deliveryNote
  }, 'Delivery ' + m.memoNo);
  if (payment) {
    syncPush('payment', {
      paymentId: payment.id, memoId: mid, deliveryId,
      memoNumber: m.memoNo, customerName: m.customerName, customerId: payment.customerId,
      date: payment.date, amount: collected, method: 'Cash'
    }, 'Payment ' + m.memoNo);
  }
  closeDelivery();
  alert(collected > 0
    ? 'Delivery updated. ' + money(collected) + ' collected.'
    : 'Delivery updated.');
}

/* ===================== parcel return ===================== */
/* The shop has many parcels coming back, so a return is entered as a record of its
   own. The qty box takes a whole-memo return or a partial one, and each product gets
   its own box when only some lines came back. */
function openReturn(mid) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  const pend = pendingQtyOf(m);
  document.getElementById('rtMemo').value = m.id;
  document.getElementById('rtInfo').innerHTML = esc(m.memoNo) + ' - ' + esc(m.customerName) +
    ' | Sold ' + m.totalQty + ' | Delivered ' + deliveredQtyOf(mid) +
    ' | Already returned ' + returnedQtyOf(mid) + ' | Available to return: <b>' + pend + '</b>';
  document.getElementById('rtDate').value = today();
  document.getElementById('rtCondition').value = 'good';
  document.getElementById('rtNote').value = '';
  document.getElementById('rtQty').value = pend;
  renderReturnLines(m);
  /* Fill the per-product boxes from the total, not the other way round: returnTotals
     would read the empty boxes and reset the total to 0. */
  returnQtyChanged();
  document.getElementById('returnModal').classList.add('show');
}
function closeReturn() { document.getElementById('returnModal').classList.remove('show'); }

function renderReturnLines(m) {
  document.getElementById('rtLines').innerHTML = m.items.map((it, i) =>
    '<div class="rtline"><span>' + esc(it.productName) + '</span>' +
    '<span class="muted">sold ' + num(it.qty) + '</span>' +
    '<input id="rtLine' + i + '" type="number" min="0" max="' + num(it.qty) + '" value="0" ' +
    'oninput="returnTotals()"></div>').join('');
}

/* The per-product boxes and the single qty box stay in step: whichever the owner
   touches, the other follows. Typing a total splits it across the lines, and typing
   lines adds up to the total. */
function returnTotals() {
  const m = db.memos.find(x => x.id === document.getElementById('rtMemo').value);
  if (!m) return;
  let sum = 0;
  m.items.forEach((it, i) => {
    const el = document.getElementById('rtLine' + i);
    if (!el) return;
    if (num(el.value) > num(it.qty)) el.value = num(it.qty);
    if (num(el.value) < 0) el.value = 0;
    sum += num(el.value);
  });
  const qtyEl = document.getElementById('rtQty');
  if (qtyEl && document.activeElement !== qtyEl) qtyEl.value = sum;
  const cond = document.getElementById('rtCondition').value;
  document.getElementById('rtHint').innerHTML = cond === 'damaged'
    ? 'Damaged: not added back to available stock, recorded as a loss.'
    : 'Good: the product goes back into available stock.';
}
function returnQtyChanged() {
  const m = db.memos.find(x => x.id === document.getElementById('rtMemo').value);
  if (!m) return;
  let left = Math.max(0, num(document.getElementById('rtQty').value));
  m.items.forEach((it, i) => {
    const el = document.getElementById('rtLine' + i);
    if (!el) return;
    const take = Math.min(left, num(it.qty));
    el.value = take;
    left -= take;
  });
  returnTotals();
}

function saveReturn() {
  const mid = document.getElementById('rtMemo').value;
  const m = db.memos.find(x => x.id === mid);
  if (!m) return alert('Select a memo.');
  const items = m.items.map((it, i) => ({
    productId: it.productId, productName: it.productName,
    qty: num((document.getElementById('rtLine' + i) || {}).value)
  })).filter(x => x.productId && x.qty > 0);
  const total = items.reduce((a, x) => a + x.qty, 0);
  if (!total) return alert('Enter a return qty.');
  if (total > pendingQtyOf(m)) {
    return alert('Return qty cannot exceed what is pending. Pending: ' + pendingQtyOf(m));
  }
  const ret = {
    id: id(), memoId: mid, memoNo: m.memoNo, date: document.getElementById('rtDate').value || today(),
    items, qty: total,
    condition: document.getElementById('rtCondition').value === 'damaged' ? 'damaged' : 'good',
    note: document.getElementById('rtNote').value.trim(),
    returnedAt: new Date().toISOString()
  };
  db.returns.push(ret);
  /* Stock moves here, at save time, so the Stock page shows the goods back the moment
     the parcel is entered. */
  applyReturnToStock(ret);
  if (!commit()) return;
  syncPush('return', {
    memoNumber: m.memoNo, customer: m.customerName, qty: total,
    returnedQty: returnedQtyOf(mid), pendingQty: pendingQtyOf(m), returnDate: ret.date,
    condition: ret.condition, note: ret.note,
    products: items.map(x => x.productName + ' x' + x.qty).join(', ')
  }, 'Return ' + m.memoNo);
  closeReturn();
  alert('Return saved.' + (ret.condition === 'good'
    ? '\nThe product is back in available stock.'
    : '\nDamaged - not added to available stock (recorded as a loss).'));
}

function deleteReturn(rid) {
  const r = (db.returns || []).find(x => x.id === rid);
  if (!r) return;
  if (!confirm('Delete this return? The stock will go back to how it was.')) return;
  reverseReturnFromStock(r);
  db.returns = db.returns.filter(x => x.id !== rid);
  if (!commit()) return;
  syncPush('return_delete', { returnId: rid, memoNumber: r.memoNo }, 'Return delete ' + (r.memoNo || ''));
  alert('Return deleted.');
}

/* ===================== customers ===================== */
function customerDue(c) {
  const ms = db.memos.filter(m => m.customerName === c.name && (m.customerPhone || '') === (c.phone || ''));
  /* Goods that came back are no longer sold, so their value comes off the customer's
     business. Netting each memo's charge keeps the ledger in step with the memo and
     the dashboard the moment a parcel is returned. */
  const sales = ms.reduce((a, m) => round2(a + memoCharge_(m)), 0);
  const adv = ms.reduce((a, m) => a + num(m.advance), 0);
  /* Live receipts only, so a receipt removed with its delivery or memo stops counting.
     Both the old customer-level receipts and the new memo-linked ones carry a
     customerId, so they are covered here; a tombstoned one is filtered by `del`. */
  const paid = db.payments.filter(p => p && !p.del && p.customerId === c.id)
    .reduce((a, p) => a + num(p.amount), 0);
  return { sales, adv, paid, due: Math.max(0, round2(sales - adv - paid)), memos: ms };
}

function renderCustomers() {
  const q = (document.getElementById('cSearch').value || '').toLowerCase();
  const arr = db.customers.filter(x => (x.name + ' ' + (x.phone || '') + ' ' + (x.address || '')).toLowerCase().includes(q));
  document.getElementById('customerTable').innerHTML = arr.length
    ? '<div class="tablewrap"><table><thead><tr><th>Name</th><th>Phone</th><th>Address</th>' +
      '<th class="right">Total Business</th><th class="right">Due</th><th></th></tr></thead><tbody>' +
      arr.map(x => {
        const d = customerDue(x);
        return '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.phone || '') + '</td><td>' + esc(x.address || '') + '</td>' +
          '<td class="right">' + money(d.sales) + '</td>' +
          '<td class="right"><b class="' + (d.due > 0 ? 'red' : 'green') + '">' + money(d.due) + '</b></td>' +
          '<td><button class="btn-green btn-sm" onclick="openPayment(\'' + x.id + '\')">Receive</button> ' +
          '<button class="btn-danger btn-sm" onclick="deleteCustomer(\'' + x.id + '\')">Delete</button></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No customers</div>';
}

function addCustomer() {
  const n = document.getElementById('cName').value.trim();
  if (!n) return alert('Enter a name.');
  db.customers.push({ id: id(), name: n, phone: document.getElementById('cPhone').value.trim(), address: document.getElementById('cAddress').value.trim() });
  ['cName', 'cPhone', 'cAddress'].forEach(i => document.getElementById(i).value = '');
  commit();
}

function deleteCustomer(cid) {
  const c = db.customers.find(x => x.id === cid);
  if (!c) return;
  if (db.memos.some(m => m.customerName === c.name)) return alert('This customer has memos, so cannot be deleted.');
  if (db.payments.some(p => p.customerId === cid)) return alert('This customer has payment records, so cannot be deleted.');
  if (!confirm('Delete this customer?')) return;
  db.customers = db.customers.filter(x => x.id !== cid);
  commit();
}

function openPayment(cid) {
  const c = db.customers.find(x => x.id === cid);
  if (!c) return;
  const d = customerDue(c);
  document.getElementById('payCustomer').value = cid;
  document.getElementById('payInfo').textContent = c.name + ' - current due ' + money(d.due);
  document.getElementById('payAmount').value = d.due > 0 ? d.due : 0;
  document.getElementById('payDate').value = today();
  document.getElementById('payModal').classList.add('show');
}
function closePayment() { document.getElementById('payModal').classList.remove('show'); }

function savePayment() {
  const cid = document.getElementById('payCustomer').value;
  const amt = num(document.getElementById('payAmount').value);
  if (amt <= 0) return alert('Enter an amount.');
  db.payments.push({
    id: id(), customerId: cid, date: document.getElementById('payDate').value || today(),
    amount: amt, method: document.getElementById('payMethod').value,
    note: document.getElementById('payNote').value.trim()
  });
  if (!commit()) return;
  syncPush('payment', { customerId: cid, amount: amt, date: today(), method: document.getElementById('payMethod').value }, 'Payment');
  closePayment();
  alert('Payment received.');
}

/* ===================== customer ledger ===================== */
function renderCustomerLedger() {
  const q = (document.getElementById('lSearch').value || '').toLowerCase();
  const arr = db.customers.filter(c => c.name.toLowerCase().includes(q));
  document.getElementById('ledgerTable').innerHTML = arr.length
    ? '<div class="tablewrap"><table><thead><tr><th>Customer</th><th class="right">Memos</th><th class="right">Total Sales</th>' +
      '<th class="right">Advance</th><th class="right">Received</th><th class="right">Due</th>' +
      '<th class="right">Due &gt;60d</th><th></th></tr></thead><tbody>' +
      arr.map(c => {
        const d = customerDue(c);
        const buck = ageingBuckets(d.memos, today());
        return '<tr><td>' + esc(c.name) + '</td><td class="right">' + d.memos.length + '</td>' +
          '<td class="right">' + money(d.sales) + '</td><td class="right">' + money(d.adv) + '</td>' +
          '<td class="right">' + money(d.paid) + '</td>' +
          '<td class="right"><b class="' + (d.due > 0 ? 'red' : 'green') + '">' + money(d.due) + '</b></td>' +
          '<td class="right">' + money(buck.d60 + buck.d90 + buck.over90) + '</td>' +
          '<td><button class="btn-light btn-sm" onclick="viewLedger(\'' + c.id + '\')">Statement</button></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No customers</div>';
}

function viewLedger(cid) {
  const c = db.customers.find(x => x.id === cid);
  if (!c) return;
  const d = customerDue(c);
  const lines = [];
  d.memos.forEach(m => lines.push({ date: m.date, t: 'Memo ' + m.memoNo, dr: num(m.grandTotal), cr: num(m.advance) }));
  db.payments.filter(p => p.customerId === cid).forEach(p => lines.push({ date: p.date, t: 'Received ' + (p.method || ''), dr: 0, cr: num(p.amount) }));
  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let run = 0;
  const body = lines.map(l => {
    run += l.dr - l.cr;
    return '<tr><td>' + l.date + '</td><td>' + esc(l.t) + '</td>' +
      '<td class="right">' + (l.dr ? money(l.dr) : '-') + '</td>' +
      '<td class="right">' + (l.cr ? money(l.cr) : '-') + '</td>' +
      '<td class="right"><b>' + money(run) + '</b></td></tr>';
  }).join('');
  const buck = ageingBuckets(d.memos, today());
  document.getElementById('viewBody').innerHTML =
    '<h2>' + esc(c.name) + ' - Statement</h2>' +
    '<div class="muted" style="margin-bottom:10px">' + esc(c.phone || '') + ' | ' + esc(c.address || '') + '</div>' +
    '<div class="grid3" style="margin-bottom:12px">' +
      statBox('Net Due', money(run), '') +
      statBox('0-30 days', money(buck.current), '') +
      statBox('60+ days', money(buck.d60 + buck.d90 + buck.over90), '') +
    '</div>' +
    '<div class="tablewrap"><table><thead><tr><th>Date</th><th>Particulars</th><th class="right">Debit</th>' +
    '<th class="right">Credit</th><th class="right">Balance</th></tr></thead><tbody>' +
    (body || '<tr><td colspan="5" class="empty">No transactions</td></tr>') + '</tbody></table></div>';
  document.getElementById('viewModal').classList.add('show');
}

/* ===================== purchases ===================== */
function renderPurchaseSuppliers() {
  document.getElementById('puSupplier').innerHTML = '<option value="">- select supplier -</option>' +
    db.suppliers.map(s => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('');
}

function addPurchaseLine(data) {
  purchaseDraft.items.push(Object.assign({ productId: '', qty: 1, cost: 0 }, data || {}));
  renderPurchaseLines();
}

function renderPurchaseLines() {
  document.getElementById('purchaseRows').innerHTML = purchaseDraft.items.map((it, i) =>
    '<tr><td class="right">' + (i + 1) + '</td>' +
    '<td><select onchange="purchaseSet(' + i + ',\'productId\',this.value)"><option value="">- select -</option>' +
      db.products.map(p => '<option value="' + p.id + '"' + (p.id === it.productId ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
    '</select></td>' +
    '<td><input type="number" min="0" value="' + num(it.qty) + '" oninput="purchaseSet(' + i + ',\'qty\',this.value)"></td>' +
    '<td><input type="number" step="0.01" value="' + num(it.cost) + '" oninput="purchaseSet(' + i + ',\'cost\',this.value)"></td>' +
    '<td class="right">' + money(num(it.qty) * num(it.cost)) + '</td>' +
    '<td><button class="btn-danger btn-sm" onclick="purchaseDel(' + i + ')">x</button></td></tr>').join('');
}

function purchaseSet(i, f, v) {
  if (f === 'productId') {
    const p = productById(v);
    purchaseDraft.items[i].productId = v;
    purchaseDraft.items[i].cost = num(p?.cost) || num(p?.rate);
  } else {
    purchaseDraft.items[i][f] = num(v);
  }
  renderPurchaseLines();
  calcPurchase();
}
function purchaseDel(i) { purchaseDraft.items.splice(i, 1); renderPurchaseLines(); calcPurchase(); }

function calcPurchase() {
  const valid = purchaseDraft.items.filter(x => x.productId && num(x.qty) > 0);
  const sub = valid.reduce((a, x) => a + round2(num(x.qty) * num(x.cost)), 0);
  const paid = num(document.getElementById('puPaid').value);
  set('puSubtotal', money(sub));
  set('puDue', money(Math.max(0, sub - paid)));
  document.getElementById('purchaseNo').value = nextPurchaseNo();
}

function savePurchase() {
  const sid = document.getElementById('puSupplier').value;
  const valid = purchaseDraft.items.filter(x => x.productId && num(x.qty) > 0);
  if (!valid.length) return alert('Add at least one product.');
  const sup = db.suppliers.find(s => s.id === sid);
  const sub = valid.reduce((a, x) => a + round2(num(x.qty) * num(x.cost)), 0);
  const paid = Math.min(num(document.getElementById('puPaid').value), sub);
  const purchase = {
    id: id(), purchaseNo: consumePurchaseNo(),
    date: document.getElementById('puDate').value || today(),
    supplierId: sid, supplierName: sup ? sup.name : '(none)',
    items: valid.map(x => ({
      productId: x.productId, productName: (productById(x.productId) || {}).name || '',
      qty: num(x.qty), cost: num(x.cost), amount: round2(num(x.qty) * num(x.cost))
    })),
    subtotal: sub, paid, due: round2(sub - paid),
    status: paid >= sub ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid',
    note: document.getElementById('puNote').value.trim(),
    savedAt: new Date().toISOString()
  };
  db.purchases.push(purchase);
  applyPurchaseToStock(purchase);
  if (!commit()) return;
  purchase.items.forEach(it => syncPush('purchase', {
    date: purchase.date, purchaseNo: purchase.purchaseNo, supplierName: purchase.supplierName,
    productId: it.productId, productName: it.productName, qty: it.qty, cost: it.cost, amount: it.amount,
    balance: num((db.stock.find(s => s.productId === it.productId) || {}).available), reference: purchase.purchaseNo
  }, 'Purchase ' + purchase.purchaseNo));
  alert('Purchase saved, stock increased.');
  purchaseDraft = { items: [] };
  document.getElementById('puPaid').value = 0;
  document.getElementById('puNote').value = '';
  addPurchaseLine(); addPurchaseLine();
  renderPurchaseHistory();
  calcPurchase();
}

function renderPurchaseHistory() {
  const arr = db.purchases.slice().reverse();
  document.getElementById('purchaseHistory').innerHTML = arr.length
    ? '<div class="tablewrap"><table><thead><tr><th>PO No</th><th>Date</th><th>Supplier</th><th class="right">Amount</th>' +
      '<th class="right">Paid</th><th class="right">Due</th><th>Status</th><th></th></tr></thead><tbody>' +
      arr.map(p => '<tr><td>' + esc(p.purchaseNo) + '</td><td>' + p.date + '</td><td>' + esc(p.supplierName) + '</td>' +
        '<td class="right">' + money(p.subtotal) + '</td><td class="right">' + money(p.paid) + '</td>' +
        '<td class="right">' + money(p.due) + '</td>' +
        '<td><span class="pill ' + (p.due <= 0 ? 'ok' : p.paid ? 'warn' : 'danger') + '">' + esc(p.status) + '</span></td>' +
        '<td><button class="btn-light btn-sm" onclick="payPurchase(\'' + p.id + '\')">Pay</button> ' +
        '<button class="btn-danger btn-sm" onclick="deletePurchase(\'' + p.id + '\')">Delete</button></td></tr>').join('') +
      '</tbody></table></div>'
    : '<div class="empty">No purchases</div>';
}

function payPurchase(pid) {
  const p = db.purchases.find(x => x.id === pid);
  if (!p) return;
  const v = prompt('Payment amount (due ' + money(p.due) + '):', p.due);
  if (v === null) return;
  const amt = Math.min(Math.max(0, num(v)), p.due);
  p.paid = round2(num(p.paid) + amt);
  p.due = round2(num(p.subtotal) - num(p.paid));
  p.status = p.due <= 0 ? 'Paid' : p.paid > 0 ? 'Partial' : 'Unpaid';
  commit();
  renderPurchaseHistory();
}

function deletePurchase(pid) {
  const p = db.purchases.find(x => x.id === pid);
  if (!p) return;
  if (!confirm('Delete purchase ' + p.purchaseNo + '? The stock will be reduced.')) return;
  p.items.forEach(it => {
    const s = db.stock.find(x => x.productId === it.productId);
    if (!s) return;
    s.purchased = Math.max(0, num(s.purchased) - num(it.qty));
    s.available = stockAvailable(s);
    logStock(it.productId, 'Adjustment', -num(it.qty), p.purchaseNo, 'Purchase deleted');
  });
  db.purchases = db.purchases.filter(x => x.id !== pid);
  commit();
  renderPurchaseHistory();
}

/* ===================== suppliers ===================== */
function renderSuppliers() {
  const q = (document.getElementById('sSearch').value || '').toLowerCase();
  const arr = db.suppliers.filter(s => (s.name + ' ' + (s.phone || '')).toLowerCase().includes(q));
  document.getElementById('supplierTable').innerHTML = arr.length
    ? '<div class="tablewrap"><table><thead><tr><th>Supplier</th><th>Contact</th><th>Phone</th>' +
      '<th class="right">Purchased</th><th class="right">Due</th><th></th></tr></thead><tbody>' +
      arr.map(s => {
        const ps = db.purchases.filter(p => p.supplierId === s.id);
        return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.contact || '') + '</td><td>' + esc(s.phone || '') + '</td>' +
          '<td class="right">' + money(ps.reduce((a, p) => a + num(p.subtotal), 0)) + '</td>' +
          '<td class="right"><b class="red">' + money(ps.reduce((a, p) => a + num(p.due), 0)) + '</b></td>' +
          '<td><button class="btn-danger btn-sm" onclick="deleteSupplier(\'' + s.id + '\')">Delete</button></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No suppliers</div>';
  renderPurchaseSuppliers();
}

function addSupplier() {
  const n = document.getElementById('sName').value.trim();
  if (!n) return alert('Enter a supplier name.');
  db.suppliers.push({
    id: id(), name: n, contact: document.getElementById('sContact').value.trim(),
    phone: document.getElementById('sPhone').value.trim(),
    address: document.getElementById('sAddress').value.trim()
  });
  ['sName', 'sContact', 'sPhone', 'sAddress'].forEach(i => document.getElementById(i).value = '');
  commit();
}

function deleteSupplier(sid) {
  if (db.purchases.some(p => p.supplierId === sid)) return alert('This supplier has purchase history, so cannot be deleted.');
  if (!confirm('Delete supplier?')) return;
  db.suppliers = db.suppliers.filter(x => x.id !== sid);
  commit();
}

/* ===================== products ===================== */
function renderProducts() {
  const q = (document.getElementById('pSearch').value || '').toLowerCase();
  const arr = db.products.filter(p => (p.name + ' ' + (p.sku || '') + ' ' + (p.category || '')).toLowerCase().includes(q));
  document.getElementById('productTable').innerHTML =
    '<div class="tablewrap"><table><thead><tr><th>Product</th><th>SKU</th><th>Category</th><th>Unit</th>' +
    '<th class="right">Cost</th><th class="right">Rate</th><th class="right">Margin</th><th class="right">Reorder</th>' +
    '<th class="right">Available</th><th></th></tr></thead><tbody>' +
    (arr.map(p => {
      const s = db.stock.find(x => x.productId === p.id);
      const av = num(s?.available);
      const margin = num(p.rate) - stockCost(p.id);
      return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.sku || '') + '</td><td>' + esc(p.category || '') + '</td>' +
        '<td>' + esc(p.unit || '') + '</td><td class="right">' + money(p.cost) + '</td>' +
        '<td class="right">' + money(p.rate) + '</td>' +
        '<td class="right"><b class="' + (margin >= 0 ? 'green' : 'red') + '">' + money(margin) + '</b></td>' +
        '<td class="right">' + num(p.reorderLevel) + '</td>' +
        '<td class="right"><span class="pill ' + (av <= 0 ? 'danger' : av <= num(p.reorderLevel) ? 'warn' : 'ok') + '">' + av + '</span></td>' +
        '<td><button class="btn-light btn-sm" onclick="editProduct(\'' + p.id + '\')">Edit</button> ' +
        '<button class="btn-danger btn-sm" onclick="deleteProduct(\'' + p.id + '\')">Delete</button></td></tr>';
    }).join('') || '<tr><td colspan="10" class="empty">No products</td></tr>') + '</tbody></table></div>';
}

/* Shared by the Products page and the Stock page - the Stock page also needs this
   list filled, otherwise opening it directly leaves the picker empty. */
function fillStockProductSelect() {
  const sp = document.getElementById('stockProduct');
  if (!sp) return;
  const keep = sp.value;
  sp.innerHTML = '<option value="">- select product -</option>' +
    db.products.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('');
  if (keep && db.products.some(p => p.id === keep)) sp.value = keep;
}

function addProduct() {
  const n = document.getElementById('pName').value.trim();
  if (!n) return alert('Enter a product name.');
  db.products.push({
    id: id(), name: n, sku: document.getElementById('pSku').value.trim(),
    category: document.getElementById('pCategory').value.trim() || 'General',
    unit: document.getElementById('pUnit').value.trim() || 'pcs',
    cost: num(document.getElementById('pCost').value),
    rate: num(document.getElementById('pRate').value),
    vat: num(document.getElementById('pVat').value),
    reorderLevel: num(document.getElementById('pReorder').value)
  });
  ['pName', 'pSku', 'pCategory', 'pCost', 'pRate', 'pVat', 'pReorder'].forEach(i => {
    const e = document.getElementById(i); if (e) e.value = '';
  });
  commit();
}

let editingProductId = null;
function editProduct(pid) {
  const p = productById(pid);
  if (!p) return;
  editingProductId = pid;
  document.getElementById('epName').value = p.name;
  document.getElementById('epSku').value = p.sku || '';
  document.getElementById('epCategory').value = p.category || '';
  document.getElementById('epUnit').value = p.unit || 'pcs';
  document.getElementById('epCost').value = p.cost;
  document.getElementById('epRate').value = p.rate;
  document.getElementById('epVat').value = p.vat || 0;
  document.getElementById('epReorder').value = p.reorderLevel || 0;
  document.getElementById('productModal').classList.add('show');
}
function closeProduct() { editingProductId = null; document.getElementById('productModal').classList.remove('show'); }

function saveProductEdit() {
  const p = productById(editingProductId);
  if (!p) return;
  p.name = document.getElementById('epName').value.trim() || p.name;
  p.sku = document.getElementById('epSku').value.trim();
  p.category = document.getElementById('epCategory').value.trim() || 'General';
  p.unit = document.getElementById('epUnit').value.trim() || 'pcs';
  p.cost = num(document.getElementById('epCost').value);
  p.rate = num(document.getElementById('epRate').value);
  p.vat = num(document.getElementById('epVat').value);
  p.reorderLevel = num(document.getElementById('epReorder').value);
  /* The buying price lives in two places - the product and the stock card - and
     stockCost() reads the card first. Without this the price the owner just typed
     on the Products page was silently ignored by every later memo, so profit kept
     using the old cost: a product bought at 120 still reported the margin of 100. */
  const s = db.stock.find(x => x.productId === p.id);
  if (s && num(p.cost) > 0) s.cost = num(p.cost);
  commit();
  closeProduct();
}

function deleteProduct(pid) {
  const used = db.memos.some(m => m.items.some(i => i.productId === pid));
  const s = db.stock.find(x => x.productId === pid);
  if (used || num(s?.sold) > 0) return alert('This product has sales history, so cannot be deleted. Edit it instead.');
  if (db.purchases.some(p => p.items.some(i => i.productId === pid))) return alert('This product has purchase history, so cannot be deleted.');
  if (!confirm('Delete this product?')) return;
  db.products = db.products.filter(x => x.id !== pid);
  db.stock = db.stock.filter(x => x.productId !== pid);
  commit();
}

/* ===================== stock ===================== */
function renderStock() {
  const q = (document.getElementById('stockSearch').value || '').toLowerCase();
  fillStockProductSelect();
  const arr = db.products.filter(p => p.name.toLowerCase().includes(q));
  document.getElementById('stockTable').innerHTML = arr.length
    ? '<div class="tablewrap"><table><thead><tr><th>Product</th><th class="right">Opening</th><th class="right">Purchased</th>' +
      '<th class="right">Sold</th><th class="right">Available</th><th class="right">Short</th><th class="right">Unit Cost</th>' +
      '<th class="right">Stock Value</th><th>Status</th><th></th></tr></thead><tbody>' +
      arr.map(p => {
        const s = db.stock.find(x => x.productId === p.id) || {};
        const av = num(s.available);
        const short = stockShort(s);
        const st = av <= 0 ? 'danger' : av <= num(p.reorderLevel) ? 'warn' : 'ok';
        return '<tr><td>' + esc(p.name) + '</td><td class="right">' + num(s.opening) + '</td>' +
          '<td class="right">' + num(s.purchased) + '</td><td class="right">' + num(s.sold) + '</td>' +
          '<td class="right"><b>' + av + '</b></td>' +
          '<td class="right">' + (short > 0 ? '<b class="red">' + short + '</b>' : '-') + '</td>' +
          '<td class="right">' + money(stockCost(p.id)) + '</td>' +
          '<td class="right">' + money(av * stockCost(p.id)) + '</td>' +
          '<td><span class="pill ' + st + '">' + (av <= 0 ? 'OUT' : av <= num(p.reorderLevel) ? 'LOW' : 'OK') + '</span></td>' +
          '<td><button class="btn-light btn-sm" onclick="openStockEdit(\'' + p.id + '\')">Edit</button> ' +
          '<button class="btn-orange btn-sm" onclick="openAdjust(\'' + p.id + '\')">Adjust</button></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No products</div>';
}

function addStockPurchase() {
  fillStockProductSelect();
  const pid = document.getElementById('stockProduct').value;
  const q = num(document.getElementById('stockAddQty').value);
  const c = num(document.getElementById('stockCost').value);
  if (!pid) return alert('Select a product.');
  if (q <= 0) return alert('Enter a quantity (greater than 0).');
  const p = productById(pid);
  const s = stockOf(pid);
  s.opening = num(s.opening) + q;
  if (c > 0) s.cost = c;
  s.available = stockAvailable(s);
  logStock(pid, 'Opening', q, 'Manual', 'Opening stock added');
  document.getElementById('stockAddQty').value = '';
  document.getElementById('stockCost').value = '';
  if (!commit()) return;
  alert('Stock added.\n' + (p ? p.name : 'Product') + ' - available now: ' + s.available);
}

let adjustProductId = null;
function openAdjust(pid) {
  adjustProductId = pid;
  const p = productById(pid);
  const s = db.stock.find(x => x.productId === pid) || {};
  document.getElementById('adProduct').textContent = p.name + ' - Available: ' + num(s.available);
  document.getElementById('adQty').value = '';
  document.getElementById('adReason').value = '';
  document.getElementById('adjustModal').classList.add('show');
}
function closeAdjust() { adjustProductId = null; document.getElementById('adjustModal').classList.remove('show'); }

function saveAdjust() {
  const pid = adjustProductId;
  const delta = num(document.getElementById('adQty').value);
  const reason = document.getElementById('adReason').value.trim();
  if (delta === 0) return alert('Enter an adjustment qty (positive to add, negative to reduce).');
  const s = stockOf(pid);
  /* Checked against the raw figure, not the clamped one: a card whose sales
     already ran ahead of its receipts sits at available 0 with a shortfall, and
     it must still accept a downward adjustment. */
  if (stockRaw(s) + delta < 0) {
    return alert('This adjustment would push stock below what was received. Available: ' + num(s.available));
  }
  if (delta > 0) s.opening = num(s.opening) + delta;
  else s.sold = num(s.sold) + Math.abs(delta);
  s.available = stockAvailable(s);
  logStock(pid, 'Adjustment', delta, 'Manual', reason || 'Stock adjustment');
  commit();
  closeAdjust();
  alert('Stock adjusted.');
}

let editingStockProductId = null;
function openStockEdit(pid) {
  const p = productById(pid);
  if (!p) return;
  const s = db.stock.find(x => x.productId === pid) || {};
  editingStockProductId = pid;
  document.getElementById('seProduct').textContent = p.name;
  document.getElementById('seOpening').value = num(s.opening);
  document.getElementById('sePurchased').value = num(s.purchased);
  document.getElementById('seSold').value = num(s.sold);
  document.getElementById('seCost').value = num(s.cost) || num(p.cost);
  document.getElementById('stockEditModal').classList.add('show');
}
function closeStockEdit() { editingStockProductId = null; document.getElementById('stockEditModal').classList.remove('show'); }

function saveStockEdit() {
  const pid = editingStockProductId;
  const p = productById(pid);
  if (!p) return;
  const opening = Math.max(0, num(document.getElementById('seOpening').value));
  const purchased = Math.max(0, num(document.getElementById('sePurchased').value));
  const sold = Math.max(0, num(document.getElementById('seSold').value));
  const cost = Math.max(0, num(document.getElementById('seCost').value));

  /* A stock edit can no longer silently erase real memo sales. */
  const memoSold = db.memos.reduce((a, m) =>
    a + m.items.filter(i => i.productId === pid).reduce((b, i) => b + num(i.qty), 0), 0);
  if (sold < memoSold) {
    return alert('Sold qty cannot go below what the memos actually sold (' + memoSold + ').');
  }
  const available = stockRaw({ opening, purchased, sold });
  /* A card whose sales ran ahead of its receipts is a normal state - the memo
     auto-add creates exactly that. It is kept as a shortfall to enter, not
     refused here, so the owner can always re-save the card he just looked at. */

  const s = stockOf(pid);
  const before = num(s.available);
  s.opening = opening; s.purchased = purchased; s.sold = sold;
  if (cost > 0) s.cost = cost;
  s.available = stockAvailable(s);
  logStock(pid, 'Adjustment', s.available - before, 'Manual', 'Stock card edited');
  commit();
  closeStockEdit();
  alert(available < 0
    ? 'Stock updated.\nReceived is less than sold - these ' + Math.abs(available) + ' will show in "Short".'
    : 'Stock updated.');
}

/* ===================== stock ledger (audit trail) ===================== */
function renderStockLog() {
  const q = (document.getElementById('slSearch').value || '').toLowerCase();
  const arr = db.ledger.slice().reverse().filter(l => {
    const p = productById(l.productId);
    return ((p?.name || '') + ' ' + l.type + ' ' + (l.ref || '')).toLowerCase().includes(q);
  }).slice(0, 400);
  document.getElementById('stockLogTable').innerHTML = arr.length
    ? '<div class="tablewrap"><table><thead><tr><th>Date</th><th>Product</th><th>Type</th>' +
      '<th class="right">In</th><th class="right">Out</th><th class="right">Balance</th><th>Reference</th><th>Note</th></tr></thead><tbody>' +
      arr.map(l => {
        const p = productById(l.productId);
        return '<tr><td>' + esc(l.date) + '</td><td>' + esc(p ? p.name : '(deleted)') + '</td>' +
          '<td><span class="pill ' + (/Sale$/.test(l.type) ? 'info' : l.type === 'Purchase' ? 'ok' : 'warn') + '">' + esc(l.type) + '</span></td>' +
          '<td class="right">' + (num(l.qty) > 0 ? num(l.qty) : '-') + '</td>' +
          '<td class="right">' + (num(l.qty) < 0 ? Math.abs(num(l.qty)) : '-') + '</td>' +
          '<td class="right"><b>' + num(l.balance) + '</b></td>' +
          '<td>' + esc(l.ref || '') + '</td><td>' + esc(l.note || '') + '</td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No stock movement yet</div>';
}

/* ===================== profit reports ===================== */
function profitRows(from, to) {
  const map = {};
  db.memos.forEach(m => {
    if (!dateInRange(m.date, from, to)) return;
    /* Returned pieces are not sales, so their qty, value and cost leave the item
       report. Per-product so the right line drops, not the whole memo's. */
    const soldValue = (m.items || []).reduce((a, it) => a + num(it.qty) * num(it.rate), 0);
    const ratio = soldValue > 0 ? Math.min(1, returnedValueOnMemo_(m) / soldValue) : 0;
    m.items.forEach(it => {
      const k = it.productId || it.productName;
      map[k] = map[k] || { name: it.productName, qty: 0, sales: 0, cost: 0, profit: 0 };
      const q = num(it.qty) * (1 - ratio);
      const sales = round2(num(it.amount) * (1 - ratio));
      const cost = round2(num(it.qty) * num(it.cost) * (1 - ratio));
      map[k].qty += q;
      map[k].sales += sales;
      map[k].cost += cost;
      map[k].profit += round2(sales - cost);
    });
  });
  return Object.values(map).sort((a, b) => b.profit - a.profit);
}

function renderProfit() {
  const from = document.getElementById('prFrom').value;
  const to = document.getElementById('prTo').value;
  const rows = profitRows(from, to);
  const tot = rows.reduce((a, r) => ({
    qty: a.qty + r.qty, sales: round2(a.sales + r.sales),
    cost: round2(a.cost + r.cost), profit: round2(a.profit + r.profit)
  }), { qty: 0, sales: 0, cost: 0, profit: 0 });
  const marginPct = tot.sales ? round2((tot.profit / tot.sales) * 100) : 0;

  document.getElementById('profitStats').innerHTML =
    statBox('Sales', money(tot.sales), tot.qty + ' pcs sold') +
    statBox('Cost of Goods', money(tot.cost), 'COGS') +
    statBox('Gross Profit', money(tot.profit), marginPct + '% margin') +
    statBox('Avg / Piece', money(tot.qty ? tot.profit / tot.qty : 0), 'profit per piece');

  document.getElementById('profitTable').innerHTML = rows.length
    ? '<div class="tablewrap"><table><thead><tr><th>Product</th><th class="right">Qty</th>' +
      '<th class="right">Sales</th><th class="right">Cost</th><th class="right">Profit</th>' +
      '<th class="right">Margin %</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td>' + esc(r.name) + '</td><td class="right">' + r.qty + '</td>' +
        '<td class="right">' + money(r.sales) + '</td><td class="right">' + money(r.cost) + '</td>' +
        '<td class="right"><b class="' + (r.profit >= 0 ? 'green' : 'red') + '">' + money(r.profit) + '</b></td>' +
        '<td class="right">' + (r.sales ? round2((r.profit / r.sales) * 100) : 0) + '%</td></tr>').join('') +
      '</tbody></table></div>'
    : '<div class="empty">No sales in this period</div>';

  renderCostWarn();
}

function renderPL() {
  const from = document.getElementById('plFrom').value;
  const to = document.getElementById('plTo').value;
  const s = plSummary(from, to);
  const m = plSummary(from.slice(0, 8) + '01', to);

  document.getElementById('plStats').innerHTML =
    statBox('Sales (subtotal)', money(s.sales), '') +
    statBox('Cost of Goods (COGS)', money(s.cogs), '') +
    statBox('Gross Profit', money(s.grossProfit), '') +
    statBox('Expenses', money(s.expense), '') +
    statBox('Net Profit', money(s.netProfit), s.sales ? round2((s.netProfit / s.sales) * 100) + '% of sales' : '');

  document.getElementById('plStatement').innerHTML =
    '<div class="tablewrap"><table><tbody>' +
    '<tr><td>Sales (subtotal)</td><td class="right"><b>' + money(s.sales) + '</b></td></tr>' +
    '<tr><td>Less: Discount given</td><td class="right">- ' + money(s.discount) + '</td></tr>' +
    '<tr><td>Less: Cost of goods sold</td><td class="right">- ' + money(s.cogs) + '</td></tr>' +
    '<tr style="background:#f2fbf6"><td><b>Gross Profit</b></td><td class="right"><b class="green">' + money(s.grossProfit) + '</b></td></tr>' +
    '<tr><td>Add: Delivery charge income</td><td class="right">+ ' + money(s.deliveryIncome) + '</td></tr>' +
    '<tr><td>Less: Operating expenses</td><td class="right">- ' + money(s.expense) + '</td></tr>' +
    '<tr style="background:#fff2f6"><td><b>Net Profit</b></td><td class="right"><b class="pink">' + money(s.netProfit) + '</b></td></tr>' +
    '<tr><td class="muted">VAT collected (payable)</td><td class="right muted">' + money(s.vatCollected) + '</td></tr>' +
    '</tbody></table></div>';

  document.getElementById('plMonthly').innerHTML = monthlyPLHTML();
}

function monthlyPLHTML() {
  const months = {};
  db.memos.forEach(m => {
    const k = (m.date || '').slice(0, 7);
    if (!k) return;
    months[k] = months[k] || { sales: 0, cogs: 0, profit: 0, exp: 0 };
    /* Net of returned goods so a returned parcel does not show as month sales. */
    const soldValue = (m.items || []).reduce((a, it) => a + num(it.qty) * num(it.rate), 0);
    const ratio = soldValue > 0 ? Math.min(1, returnedValueOnMemo_(m) / soldValue) : 0;
    const sales = round2(num(m.subtotal) * (1 - ratio));
    const cogs = round2(num(m.cogs) * (1 - ratio));
    months[k].sales = round2(months[k].sales + sales);
    months[k].cogs = round2(months[k].cogs + cogs);
    months[k].profit = round2(months[k].profit + round2(sales - cogs));
  });
  db.expenses.forEach(e => {
    const k = (e.date || '').slice(0, 7);
    if (!months[k]) months[k] = { sales: 0, cogs: 0, profit: 0, exp: 0 };
    months[k].exp = round2(months[k].exp + num(e.amount));
  });
  const keys = Object.keys(months).sort().slice(-12);
  if (!keys.length) return '<div class="empty">No data yet</div>';
  return '<div class="tablewrap"><table><thead><tr><th>Month</th><th class="right">Sales</th>' +
    '<th class="right">COGS</th><th class="right">Gross Profit</th><th class="right">Expense</th>' +
    '<th class="right">Net Profit</th></tr></thead><tbody>' +
    keys.map(k => '<tr><td>' + k + '</td><td class="right">' + money(months[k].sales) + '</td>' +
      '<td class="right">' + money(months[k].cogs) + '</td>' +
      '<td class="right">' + money(months[k].profit) + '</td>' +
      '<td class="right">' + money(months[k].exp) + '</td>' +
      '<td class="right"><b class="' + (months[k].profit - months[k].exp >= 0 ? 'green' : 'red') + '">' +
      money(months[k].profit - months[k].exp) + '</b></td></tr>').join('') +
    '</tbody></table></div>';
}

/* ===================== expenses ===================== */
function addExpense() {
  const amt = num(document.getElementById('exAmount').value);
  if (amt <= 0) return alert('Enter an amount.');
  db.expenses.push({
    id: id(),
    date: document.getElementById('exDate').value || today(),
    head: document.getElementById('exHead').value,
    amount: amt,
    note: document.getElementById('exNote').value.trim()
  });
  document.getElementById('exAmount').value = '';
  document.getElementById('exNote').value = '';
  if (!commit()) return;
  syncPush('expense', { date: today(), head: document.getElementById('exHead').value, amount: amt }, 'Expense');
}

function renderExpenses() {
  const arr = db.expenses.slice().reverse();
  const total = arr.reduce((a, e) => round2(a + num(e.amount)), 0);
  document.getElementById('expenseTotal').textContent = money(total);
  document.getElementById('expenseTable').innerHTML = arr.length
    ? '<div class="tablewrap"><table><thead><tr><th>Date</th><th>Head</th><th>Note</th>' +
      '<th class="right">Amount</th><th></th></tr></thead><tbody>' +
      arr.map(e => '<tr><td>' + esc(e.date) + '</td><td>' + esc(e.head) + '</td><td>' + esc(e.note || '') + '</td>' +
        '<td class="right"><b>' + money(e.amount) + '</b></td>' +
        '<td><button class="btn-danger btn-sm" onclick="deleteExpense(\'' + e.id + '\')">Delete</button></td></tr>').join('') +
      '</tbody></table></div>'
    : '<div class="empty">No expenses</div>';
}

function deleteExpense(eid) {
  if (!confirm('Delete this expense?')) return;
  db.expenses = db.expenses.filter(x => x.id !== eid);
  commit();
}

/* ===================== ledger / ageing report ===================== */
function renderLedgerReport() {
  const rows = [];
  db.customers.forEach(c => {
    const d = customerDue(c);
    if (d.due <= 0 && !d.memos.length) return;
    const b = ageingBuckets(d.memos, today());
    rows.push({ name: c.name, due: d.due, b });
  });
  const t = rows.reduce((a, r) => ({
    current: a.current + r.b.current, d30: a.d30 + r.b.d30,
    d60: a.d60 + r.b.d60, d90: a.d90 + r.b.d90, over90: a.over90 + r.b.over90, due: a.due + r.due
  }), { current: 0, d30: 0, d60: 0, d90: 0, over90: 0, due: 0 });

  document.getElementById('lrStats').innerHTML =
    statBox('Total Receivable', money(t.due), '') +
    statBox('0-30 days', money(t.current), '') +
    statBox('31-60 days', money(t.d30), '') +
    statBox('60+ days', money(t.d60 + t.d90 + t.over90), 'overdue');

  document.getElementById('ageingTable').innerHTML = rows.length
    ? '<div class="tablewrap"><table><thead><tr><th>Customer</th><th class="right">Due</th>' +
      '<th class="right">0-30</th><th class="right">31-60</th><th class="right">61-90</th>' +
      '<th class="right">91-120</th><th class="right">120+</th></tr></thead><tbody>' +
      rows.sort((a, b) => b.due - a.due).map(r => '<tr><td>' + esc(r.name) + '</td>' +
        '<td class="right"><b>' + money(r.due) + '</b></td>' +
        '<td class="right">' + money(r.b.current) + '</td><td class="right">' + money(r.b.d30) + '</td>' +
        '<td class="right">' + money(r.b.d60) + '</td><td class="right">' + money(r.b.d90) + '</td>' +
        '<td class="right"><b class="red">' + money(r.b.over90) + '</b></td></tr>').join('') +
      '</tbody></table></div>'
    : '<div class="empty">No outstanding due</div>';

  document.getElementById('payableTable').innerHTML = db.suppliers.length
    ? '<div class="tablewrap"><table><thead><tr><th>Supplier</th><th class="right">Total Purchase</th>' +
      '<th class="right">Paid</th><th class="right">Payable</th></tr></thead><tbody>' +
      db.suppliers.map(s => {
        const ps = db.purchases.filter(p => p.supplierId === s.id);
        return '<tr><td>' + esc(s.name) + '</td>' +
          '<td class="right">' + money(ps.reduce((a, p) => a + num(p.subtotal), 0)) + '</td>' +
          '<td class="right">' + money(ps.reduce((a, p) => a + num(p.paid), 0)) + '</td>' +
          '<td class="right"><b class="red">' + money(ps.reduce((a, p) => a + num(p.due), 0)) + '</b></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No suppliers</div>';
}

/* ===================== users ===================== */
function renderUsers() {
  document.getElementById('userTable').innerHTML =
    '<div class="tablewrap"><table><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>' +
    db.users.map(u => '<tr><td>' + esc(u.username) + '</td><td>' + esc(u.name) + '</td>' +
      '<td><span class="pill info">' + esc(u.role) + '</span></td>' +
      '<td><span class="pill ' + (u.active !== false ? 'ok' : 'danger') + '">' + (u.active !== false ? 'Active' : 'Disabled') + '</span></td>' +
      '<td><button class="btn-light btn-sm" onclick="toggleUser(\'' + u.id + '\')">' + (u.active !== false ? 'Disable' : 'Enable') + '</button> ' +
      '<button class="btn-light btn-sm" onclick="resetPass(\'' + u.id + '\')">Reset pass</button> ' +
      (u.username === 'admin' ? '' : '<button class="btn-danger btn-sm" onclick="delUser(\'' + u.id + '\')">Delete</button>') +
      '</td></tr>').join('') + '</tbody></table></div>';
}

function addUser() {
  const un = document.getElementById('uUsername').value.trim().toLowerCase();
  const nm = document.getElementById('uName').value.trim();
  const pw = document.getElementById('uPass').value;
  const rl = document.getElementById('uRole').value;
  if (!un || !nm || !pw) return alert('Enter username, name and password.');
  if (db.users.some(u => u.username === un)) return alert('That username already exists.');
  if (pw.length < 4) return alert('Password must be at least 4 characters.');
  db.users.push({ id: id(), username: un, name: nm, pass: hash(pw), role: rl, active: true, createdAt: new Date().toISOString() });
  ['uUsername', 'uName', 'uPass'].forEach(i => document.getElementById(i).value = '');
  commit();
}

function toggleUser(uid) {
  const u = db.users.find(x => x.id === uid);
  if (!u) return;
  if (u.username === 'admin' && u.active !== false) return alert('The admin account cannot be disabled.');
  u.active = u.active === false;
  commit();
}

function resetPass(uid) {
  const u = db.users.find(x => x.id === uid);
  if (!u) return;
  const v = prompt('New password for ' + u.username + ':', '');
  if (!v) return;
  if (v.length < 4) return alert('Enter at least 4 characters.');
  u.pass = hash(v);
  commit();
  alert('Password reset.');
}

function delUser(uid) {
  const u = db.users.find(x => x.id === uid);
  if (!u) return;
  if (u.id === session.userId) return alert('You cannot delete your own account.');
  if (!confirm('Delete user ' + u.username + '?')) return;
  db.users = db.users.filter(x => x.id !== uid);
  commit();
}

function changeMyPass() {
  const a = document.getElementById('myOldPass').value;
  const b = document.getElementById('myNewPass').value;
  const me = db.users.find(x => x.id === session.userId);
  if (!me) return;
  if (me.pass !== hash(a)) return alert('Current password is wrong.');
  if (b.length < 4) return alert('New password must be at least 4 characters.');
  me.pass = hash(b);
  document.getElementById('myOldPass').value = '';
  document.getElementById('myNewPass').value = '';
  commit();
  // The stored session carries the password hash as its version stamp, so it has
  // to be rewritten here. Otherwise the very next reload would see the old hash,
  // decide the session is stale, and sign the owner out.
  saveSession(me);
  alert('Password changed.');
}

/* ===================== settings ===================== */
function renderSettings() {
  const c = db.settings.company || {};
  ['name', 'tagline', 'md', 'phone', 'email', 'address', 'bin', 'vatReg'].forEach(k => {
    const e = document.getElementById('co_' + k);
    if (e) e.value = c[k] || '';
  });
  document.getElementById('stSyncUrl').value = db.settings.syncUrl || '';
  const fb = db.settings.firebase || {};
  const fbKeyEl = document.getElementById('stFbKey');
  if (fbKeyEl) fbKeyEl.value = fb.apiKey || '';
  const fbProjEl = document.getElementById('stFbProject');
  if (fbProjEl) fbProjEl.value = fb.projectId || '';
  const fbEmailEl = document.getElementById('stFbEmail');
  if (fbEmailEl && !fbEmailEl.value && typeof fbEmail === 'function') fbEmailEl.value = fbEmail() || '';
  if (typeof cloudStatusRender === 'function') cloudStatusRender();
  const ap = document.getElementById('stAutoPull');
  if (ap) ap.checked = db.settings.autoPull !== false;
  document.getElementById('stMemoPrefix').value = db.settings.memoPrefix || 'TXP/SM/';
  const dt = document.getElementById('stDeviceTag');
  if (dt) dt.value = db.settings.deviceTag || '';
  document.getElementById('stLowStock').value = db.settings.lowStockLevel || 10;
  const op = document.getElementById('stOrderPrefix');
  if (op) op.value = db.settings.orderPrefix || 'TP-';
  const rl = document.getElementById('stReminderLead');
  if (rl) rl.value = db.settings.reminderDefaultLead === undefined ? 1 : db.settings.reminderDefaultLead;
  document.getElementById('stShortWarn').checked = db.settings.warnOnShortStock !== false;
  document.getElementById('stAutoBackup').checked = db.settings.autoBackup !== false;
  const ck = document.getElementById('stCourierKey');
  if (ck && typeof courierKey === 'function') ck.value = courierKey();
  const csec = document.getElementById('stCourierSecret');
  if (csec && typeof courierSecret === 'function') csec.value = courierSecret();
  const cen = document.getElementById('stCourierEnabled');
  if (cen) cen.checked = db.settings.courierEnabled !== false;
  const ccod = document.getElementById('stCourierAutoCod');
  if (ccod) ccod.checked = db.settings.courierAutoCod !== false;
  const cret = document.getElementById('stCourierAutoReturn');
  if (cret) cret.checked = db.settings.courierAutoReturnGood !== false;
  const v = document.getElementById('appVersion');
  if (v) v.textContent = APP_VERSION;
  syncStatusRender();
}

/* Phones can sit on a cached old build. Ask the browser to re-check the
   service worker, then pull the files that were probably stale and report
   what is really out there versus what this device is running. */
function checkForUpdate() {
  const out = document.getElementById('updateOut');
  const say = msg => { if (out) out.innerHTML = msg; };
  say('Chek korchi...');

  const done = () => {
    const bust = url => fetch(url + '?v=' + Date.now(), { cache: 'reload' })
      .then(r => r.text()).catch(() => null);
    Promise.all([bust('js/app.js'), bust('css/app.css'), bust(RELEASE_URL + '/js/app.js')])
      .then(res => {
        const js = res[0] || '', css = res[1] || '', released = res[2] || '';
        const serverJs = (js.match(/APP_VERSION = '([^']+)'/) || [])[1] || '?';
        const releasedJs = (released.match(/APP_VERSION = '([^']+)'/) || [])[1] || '';
        const hasPhoneFix = /iOS zooms the whole page in/.test(css);
        /* A copy opened from an address that stopped being updated - an old
           mirror, a saved bookmark - sees its own host as current forever. The
           released address is the tie-breaker, so the owner is told where the
           new build actually is instead of being told he is up to date. */
        const staleOrigin = releasedJs && releasedJs !== serverJs &&
          versionNewer(releasedJs, serverJs);
        say('<div class="vp-block"><b>On this device: ' + APP_VERSION + '</b>' +
            'At this address: <b>' + serverJs + '</b>' +
            (staleOrigin
              ? '<br><b style="color:var(--red)">This address is out of date!</b> A newer version ' +
                '<b>' + releasedJs + '</b> is at: ' +
                '<a href="' + RELEASE_URL + '/" target="_blank">' + RELEASE_URL + '</a>' +
                '<br>Open that link, then use "Add to Home screen" in the browser.'
              : serverJs === APP_VERSION
                ? '<br>Both match — you are on the latest version.'
                : '<br>A newer version is available! Reload the page.') +
            '<br>Phone layout fix on the server: ' + (hasPhoneFix ? 'yes' : 'no') + '</div>');
      });
  };

  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) { done(); return; }
  navigator.serviceWorker.getRegistration().then(reg => {
    if (!reg) { done(); return; }
    reg.update().catch(() => {}).then(done);
  }).catch(done);
}

function saveCompany() {
  const c = db.settings.company;
  ['name', 'tagline', 'md', 'phone', 'email', 'address', 'bin', 'vatReg'].forEach(k => {
    const e = document.getElementById('co_' + k);
    if (e) c[k] = e.value.trim();
  });
  db.settings.memoPrefix = document.getElementById('stMemoPrefix').value.trim() || 'TXP/SM/';
  const dtEl = document.getElementById('stDeviceTag');
  db.settings.deviceTag = dtEl ? dtEl.value.trim() : '';
  db.settings.lowStockLevel = num(document.getElementById('stLowStock').value) || 10;
  const opEl = document.getElementById('stOrderPrefix');
  if (opEl) db.settings.orderPrefix = opEl.value.trim() || 'TP-';
  const rlEl = document.getElementById('stReminderLead');
  if (rlEl) db.settings.reminderDefaultLead = Math.max(0, num(rlEl.value));
  db.settings.autoBackup = document.getElementById('stAutoBackup').checked;
  // Stamp the edit, so the other machine can tell this settings value is newer than
  // its own instead of the two of them trading the same field back and forth.
  const now = new Date().toISOString();
  db.settings.companyUpdatedAt = now;
  db.settings.settingsUpdatedAt = now;
  commit();
  alert('Company settings saved.');
}

function saveSyncUrl() {
  db.settings.syncUrl = document.getElementById('stSyncUrl').value.trim();
  commit();
  // A URL just typed in should take effect at once - the owner is at the settings
  // screen precisely because they want the other machine's data to show up.
  if (db.settings.syncUrl) cloudAutoSync('url saved');
  alert('Sync URL saved.');
}

function saveAutoPull() {
  const on = document.getElementById('stAutoPull').checked;
  db.settings.autoPull = !!on;
  commit();
  if (on) cloudAutoSync('turned on');
  alert(on ? 'Auto-pull on — from now on it pulls from the sheet on open.'
           : 'Auto-pull off — now it only pulls from the sheet when you press the button.');
}

/* ===================== cloud (Firestore) settings ===================== */
function saveFirebaseConfig() {
  const key = (document.getElementById('stFbKey').value || '').trim();
  const proj = (document.getElementById('stFbProject').value || '').trim();
  db.settings.firebase = { apiKey: key, projectId: proj };
  // The keys are machine-local: syncing them would push one project's id onto every
  // device. They live in db.settings but are excluded from the merge like a sync URL.
  commit();
  cloudStatusRender();
  alert(key && proj ? 'Cloud keys saved. Now sign in and send your data to the cloud.'
                    : 'Cloud keys cleared — the app will use the Google Sheet only.');
}

function cloudOut(html) {
  const el = document.getElementById('cloudTestOut');
  if (el) el.innerHTML = html;
}

async function cloudSignIn() {
  const email = (document.getElementById('stFbEmail').value || '').trim();
  const pass = document.getElementById('stFbPass').value || '';
  if (!cloudConfigured()) return cloudOut('<span class="red">Save the Firebase key and project id first.</span>');
  if (!email || !pass) return cloudOut('<span class="red">Enter the cloud email and password.</span>');
  cloudOut('Signing in...');
  try {
    await fbSignIn(email, pass);
    if (!cloudMigrated()) await cloudMigrate(true);
    await cloudAutoSyncNew('signin');
    cloudOut('<span style="color:var(--green)">Signed in as ' + email + '. Cloud sync is live.</span>');
  } catch (e) { cloudOut('<span class="red">' + e.message + '</span>'); }
}

async function cloudCreateAccount() {
  const email = (document.getElementById('stFbEmail').value || '').trim();
  const pass = document.getElementById('stFbPass').value || '';
  if (!cloudConfigured()) return cloudOut('<span class="red">Save the Firebase key and project id first.</span>');
  if (!email || !pass) return cloudOut('<span class="red">Enter the cloud email and password.</span>');
  cloudOut('Creating the account...');
  try {
    await fbSignUp(email, pass);
    await cloudMigrate(true);
    cloudOut('<span style="color:var(--green)">Account created. Cloud sync is live.</span>');
  } catch (e) { cloudOut('<span class="red">' + e.message + '</span>'); }
}

function cloudSignOutNow() {
  fbSignOut();
  cloudStatusRender();
  cloudOut('Signed out of the cloud. The Google Sheet sync keeps working.');
}

async function testFirebase() {
  if (!cloudConfigured()) return cloudOut('<span class="red">Save the Firebase key and project id first.</span>');
  cloudOut('Testing the cloud...');
  try {
    const delta = await fbPullDelta();
    cloudOut('<span style="color:var(--green)">Cloud reachable. ' + delta.records.length +
      ' record(s) changed since the last sync.</span>');
  } catch (e) { cloudOut('<span class="red">' + e.message + '</span>'); }
}

async function migrateToCloud() {
  if (!cloudConfigured()) return cloudOut('<span class="red">Save the Firebase key and project id first.</span>');
  if (!fbSignedIn()) return cloudOut('<span class="red">Sign in to the cloud first.</span>');
  cloudOut('Sending every record to the cloud...');
  const ok = await cloudMigrate(false);
  cloudOut(ok ? '<span style="color:var(--green)">All data is in the cloud.</span>'
              : '<span class="red">Could not finish — it will resume next time.</span>');
}

function toggleShortStockWarn(on) {
  db.settings.warnOnShortStock = !!on;
  commit();
  calcMemo();
}

async function testSync() {
  const out = document.getElementById('syncTestOut');
  const url = (db.settings.syncUrl || '').trim();
  if (!url) { out.innerHTML = '<span class="red">No sync URL. Save a URL first.</span>'; return; }
  out.textContent = 'Testing...';
  try {
    /* Probe GET first. The old deployment answers every GET with a plain
       "running" message and has no doPost at all, so a POST alone looked like a
       network problem when it was really a stale deployment. Asking for the pull
       action tells the two apart: the current script echoes the action it ran. */
    const probe = await fetch(url + '?action=pullall', { method: 'GET' });
    const ptxt = await probe.text();
    let pj = null;
    try { pj = JSON.parse(ptxt); } catch (e) {}
    const stale = pj && pj.success === true && !('devices' in pj) && !('json' in pj);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ type: 'test', data: { time: new Date().toISOString() } })
    });
    const txt = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch (e) {}
    if (parsed && parsed.success !== false) {
      out.innerHTML = '<span class="green">✓ Sync is working. The sheet replied: ' + esc(parsed.message || 'ok') + '</span>';
    } else if (stale) {
      out.innerHTML = '<span class="red">✗ This URL is running an old Code.gs — sync will not work.</span>' +
        '<div class="hint">This deployment is old: it does not support POST (sending data) and ' +
        'does not understand GET ?action=pull. So memos will not reach the PC from the phone, and ' +
        'the phone will not receive the PC\'s data — you may think sync is working when it is not.<br><br>' +
        '<b>How to fix it:</b> open Apps Script → clear the whole <b>Code.gs</b> and paste the ' +
        'repo\'s <b>Code.gs</b> → <b>Deploy → Manage deployments → Edit (pencil) → ' +
        'Version: New version → Deploy</b>. The URL stays the same, but the new code runs. ' +
        'Then test again.</div>';
    } else {
      out.innerHTML = '<span class="orange">A reply came back but not success: ' + esc(txt.slice(0, 160)) + '</span>' +
        '<div class="hint">Check that you updated Code.gs and deployed a new version.</div>';
    }
  } catch (e) {
    out.innerHTML = '<span class="red">Sync test failed: ' + esc(e.message || 'network error') + '</span>' +
      '<div class="hint">Check the URL, the internet, and the Apps Script deployment permissions.</div>';
  }
}

/* ===================== backup ===================== */
function renderBackup() {
  const tag = document.getElementById('cloudDeviceTag');
  if (tag) tag.textContent = deviceTag();
  const counts = [
    ['Products', db.products.length], ['Customers', db.customers.length],
    ['Suppliers', db.suppliers.length], ['Sales Memos', db.memos.length],
    ['Purchases', db.purchases.length], ['Expenses', db.expenses.length],
    ['Payments', db.payments.length], ['Deliveries', db.deliveries.length], ['Returns', (db.returns || []).length],
    ['Stock movements', db.ledger.length], ['Users', db.users.length]
  ];
  document.getElementById('dataCounts').innerHTML =
    '<div class="tablewrap"><table><thead><tr><th>Table</th><th class="right">Records</th></tr></thead><tbody>' +
    counts.map(c => '<tr><td>' + c[0] + '</td><td class="right"><b>' + c[1] + '</b></td></tr>').join('') +
    '</tbody></table></div>';

  const q = syncQueue.slice().reverse().slice(0, 60);
  document.getElementById('syncQueueTable').innerHTML = q.length
    ? '<div class="tablewrap"><table><thead><tr><th>When</th><th>Job</th><th>State</th><th class="right">Tries</th><th>Last error</th></tr></thead><tbody>' +
      q.map(j => '<tr><td>' + esc(new Date(j.at).toLocaleString()) + '</td><td>' + esc(j.label) + '</td>' +
        '<td><span class="pill ' + (j.state === 'failed' ? 'danger' : 'warn') + '">' + esc(j.state) + '</span></td>' +
        '<td class="right">' + j.tries + '</td><td class="muted">' + esc(j.error || '') + '</td></tr>').join('') +
      '</tbody></table></div>'
    : '<div class="empty">Queue empty — everything is synced</div>';

  const snaps = listSnapshots();
  document.getElementById('snapshotTable').innerHTML = snaps.length
    ? '<div class="tablewrap"><table><thead><tr><th>When</th><th></th></tr></thead><tbody>' +
      snaps.map((s, i) => '<tr><td>' + esc(new Date(s.at).toLocaleString()) + '</td>' +
        '<td class="right"><button class="btn-light btn-sm" onclick="restoreSnapshot(' + i + ')">Restore this</button></td></tr>').join('') +
      '</tbody></table></div>'
    : '<div class="empty">No snapshots yet (one is taken automatically on every save)</div>';
}


/* ============ repairing old memos' cost (the profit fix, backwards) ============
   The plan itself lives in db.js so it can be tested without a DOM; these two only
   render it and ask before writing. */
function previewMemoCostRepair() {
  const out = document.getElementById('repairOut');
  const btn = document.getElementById('repairApplyBtn');
  const plan = planMemoCostRepair();
  if (!plan.length) {
    out.innerHTML = '<div class="note good">Every memo\'s profit is already correct — nothing to change.</div>';
    if (btn) btn.style.display = 'none';
    return;
  }
  const wasTotal = round2(plan.reduce((a, r) => a + r.wasProfit, 0));
  const nowTotal = round2(plan.reduce((a, r) => a + r.nowProfit, 0));
  const diff = round2(nowTotal - wasTotal);
  out.innerHTML =
    '<div class="note warn"><b>' + plan.length + ' memo(s)</b> were saved with the wrong buying price.</div>' +
    '<div class="tablewrap" style="margin-top:9px"><table><thead><tr>' +
      '<th>Memo</th><th>Date</th><th>Customer</th>' +
      '<th class="right">Old profit</th><th class="right">Correct profit</th>' +
    '</tr></thead><tbody>' +
    plan.map(r => '<tr><td>' + esc(r.memoNo) + '</td><td>' + esc(r.date) + '</td>' +
      '<td>' + esc(r.customerName) + '</td>' +
      '<td class="right"><span style="color:var(--red)">' + money(r.wasProfit) + '</span></td>' +
      '<td class="right"><b class="green">' + money(r.nowProfit) + '</b></td></tr>').join('') +
    '</tbody><tfoot><tr><th colspan="3">Total</th>' +
      '<th class="right">' + money(wasTotal) + '</th>' +
      '<th class="right">' + money(nowTotal) + '</th></tr></tfoot></table></div>' +
    '<div class="note ' + (diff >= 0 ? 'good' : 'warn') + '" style="margin-top:10px">' +
      'Profit in total becomes <b>' + (diff >= 0 ? '+' : '') + money(diff) + '</b>. ' +
      'Sales, qty, due and stock are <b>all untouched</b>.</div>';
  if (btn) btn.style.display = '';
}

function applyMemoCostRepairUI() {
  const out = document.getElementById('repairOut');
  const btn = document.getElementById('repairApplyBtn');
  const plan = planMemoCostRepair();
  if (!plan.length) { previewMemoCostRepair(); return; }
  if (!confirm('Fix the cost/profit of ' + plan.length + ' memo(s)?\n\n' +
      'Old profit: ' + money(round2(plan.reduce((a, r) => a + r.wasProfit, 0))) + '\n' +
      'New profit: ' + money(round2(plan.reduce((a, r) => a + r.nowProfit, 0))) + '\n\n' +
      'Sales, qty, due and stock are all untouched.')) return;
  const n = applyMemoCostRepair();
  if (!commit()) return;
  if (btn) btn.style.display = 'none';
  out.innerHTML = '<div class="note good"><b>' + n + ' memo(s)\'</b> profit corrected. ' +
    'The Profit page and Dashboard now show the new figures.</div>';
}

function backupJSON() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
  a.download = 'texpark_pro_backup_' + today() + '.json';
  a.click();
}

/* List what the sheet holds, so an operator can pick which machine to restore. */
async function cloudDeviceList() {
  const out = document.getElementById('cloudOut');
  out.textContent = 'Fetching from the sheet...';
  try {
    const devs = await cloudListDevices();
    if (!devs.length) { out.innerHTML = '<span class="muted">The sheet has no backups yet.</span>'; return; }
    out.innerHTML = '<div class="tablewrap"><table><thead><tr><th>Device</th><th>Date</th><th class="right">Size</th><th></th></tr></thead><tbody>' +
      devs.map(d => '<tr><td><b>' + esc(d.device) + '</b></td><td>' + esc(d.date) + '</td>' +
        '<td class="right">' + Math.round((d.bytes || 0) / 1024) + ' KB</td>' +
        '<td class="right"><button class="btn-light btn-sm" onclick="cloudRestore(\'' + esc(d.device) + '\')">Restore this</button></td></tr>').join('') +
      '</tbody></table></div>';
  } catch (e) {
    out.innerHTML = '<span style="color:var(--red)">' + esc(e.message) + '</span>';
  }
}

function restoreJSON(e) {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const incoming = JSON.parse(r.result);
      if (!incoming || typeof incoming !== 'object') throw new Error('bad file');
      if (!confirm('Restore this backup? The current data will be replaced.')) return;
      db = migrate(incoming);
      if (!db.users || !db.users.length) db.users = defaultUsers();
      commit();
      alert('Backup restored. The page will reload.');
      location.reload();
    } catch (err) {
      alert('The backup file is not valid: ' + err.message);
    }
  };
  r.readAsText(f);
}

/* Import old v1 data (read-only read from the old key, never writes to it). */
function importOldData() {
  const raw = localStorage.getItem(OLD_KEY);
  if (!raw) return alert('The old app data (texpark_biz_v1) is not on this PC.');
  if (!confirm('Import the old app\'s products, customers, stock and memos? The current data will be merged.')) return;
  try {
    const o = JSON.parse(raw);
    let prod = 0, cust = 0, memo = 0, stock = 0;

    const mapP = {};
    (o.products || []).forEach(p => {
      let ex = db.products.find(x => x.name.toLowerCase() === String(p.name || '').toLowerCase());
      if (!ex) {
        ex = { id: id(), name: p.name, sku: p.sku || '', category: 'Imported', unit: 'pcs', rate: num(p.rate), cost: 0, vat: 0, reorderLevel: 10 };
        db.products.push(ex);
      }
      mapP[p.id] = ex.id;
      prod++;
    });

    (o.stock || []).forEach(s => {
      const nid = mapP[s.productId];
      if (!nid) return;
      const t = stockOf(nid);
      t.opening = num(s.opening) + num(s.purchased) - num(s.sold);
      t.opening = Math.max(0, t.opening);
      t.purchased = 0; t.sold = 0;
      if (num(s.cost) > 0) t.cost = num(s.cost);
      t.available = stockAvailable(t);
      logStock(nid, 'Opening', t.opening, 'Import', 'Imported from old app');
      stock++;
    });

    (o.customers || []).forEach(c => {
      if (!db.customers.some(x => x.name.toLowerCase() === String(c.name || '').toLowerCase())) {
        db.customers.push({ id: id(), name: c.name, phone: c.phone || '', address: c.address || '' });
        cust++;
      }
    });

    (o.memos || []).forEach(m => {
      const exists = db.memos.some(x => x.memoNo === m.memoNo);
      if (exists) return;
      const items = (m.items || []).map(i => ({
        productId: mapP[i.productId] || '', productName: i.productName || '',
        qty: num(i.qty), rate: num(i.rate), cost: 0, vat: 0, amount: round2(num(i.qty) * num(i.rate))
      }));
      const memo = {
        id: id(), memoNo: m.memoNo, date: m.date, customerName: m.customerName,
        customerPhone: m.customerPhone || '', customerAddress: m.customerAddress || '',
        items, totalQty: num(m.totalQty),
        subtotal: num(m.subtotal), discount: num(m.discount), deliveryCharge: num(m.deliveryCharge),
        vat: 0, grandTotal: num(m.grandTotal), advance: num(m.advance), due: num(m.due),
        cogs: 0, profit: 0, note: 'Imported from v1 (profit unknown - no cost)', savedAt: new Date().toISOString()
      };
      db.memos.push(memo);
      items.forEach(it => {
        if (!it.productId) return;
        const s = stockOf(it.productId);
        s.sold = num(s.sold) + num(it.qty);
        s.available = stockAvailable(s);
        logStock(it.productId, 'Sale', -num(it.qty), memo.memoNo, 'Imported from v1');
      });
      memo++;
    });

    commit();
    alert('Import sesh:\n' + prod + ' product\n' + cust + ' customer\n' + memo + ' memo\n' + stock + ' stock row');
  } catch (e) {
    alert('Import fail: ' + e.message);
  }
}

function syncNow() { syncRetryAll(); setTimeout(renderBackup, 1500); }

/* ===================== boot ===================== */
window.addEventListener('DOMContentLoaded', function () {
  boot();
  window.addEventListener('online', () => { cloudAutoSync('online'); if (typeof cloudAutoSyncNew === 'function') cloudAutoSyncNew('online'); });
  // Push a full cloud backup once a day when the app is opened, so at least one
  // recent restorable copy always exists off-device without anyone remembering.
  setTimeout(maybeDailyCloudBackup, 4000);
  // Coming back to the tab is when stale numbers are most likely to be believed,
  // so re-check the cloud then too - not only on a cold open.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      // Leaving the page is the last moment an unsent edit can go up. Hiding runs
      // while the tab still gets to finish a request, unlike beforeunload, whose
      // upload the browser cancels halfway.
      if (cloudDirty) flushCloudPush();
      return;
    }
    cloudAutoSync('visible');
    if (typeof courierAutoSync === 'function') courierAutoSync();
  });
  window.addEventListener('pagehide', function () { if (cloudDirty) flushCloudPush(); });
  /* The tab staying open is the normal way this app is used, and until now a change
     made on the phone only appeared when the owner came back to the tab. Polling on
     a timer closes that gap. It runs only while the tab is visible: a background tab
     polling the sheet would spend the owner's data to update a screen nobody is
     looking at. cloudAutoSync() itself keeps the once-per-8s floor. */
  setInterval(function () { if (!document.hidden) cloudAutoSync('timer'); }, 30000);
  /* Steadfast status, the same way: on open, when the tab comes back, and on a slow
     timer. courierAutoSync() no-ops unless the owner set the keys, and it never
     blocks the app; it is the only path that turns a delivered parcel into a memo
     delivery without anyone typing it. */
  setTimeout(function () { if (typeof courierAutoSync === 'function') courierAutoSync(); }, 6000);
  setInterval(function () { if (typeof courierAutoSync === 'function') courierAutoSync(); }, 15 * 60 * 1000);
});

const CLOUD_DAY_KEY = 'texpark_pro_cloud_backup_day';
var cloudDirty = false;

function maybeDailyCloudBackup() {
  if (!syncUrl() || db.settings.autoBackup === false) return;
  let last = '';
  try { last = localStorage.getItem(CLOUD_DAY_KEY) || ''; } catch (e) {}
  if (last === today()) return;
  try { localStorage.setItem(CLOUD_DAY_KEY, today()); } catch (e) {}
  cloudBackupNow(true);
}

/* ===================== date range shortcuts ===================== */
function setRange(fromId, toId, mode) {
  const now = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  if (mode === 'today') {
    document.getElementById(fromId).value = iso(now);
    document.getElementById(toId).value = iso(now);
  } else if (mode === 'month') {
    document.getElementById(fromId).value = iso(new Date(now.getFullYear(), now.getMonth(), 1));
    document.getElementById(toId).value = iso(now);
  } else if (mode === 'year') {
    document.getElementById(fromId).value = iso(new Date(now.getFullYear(), 0, 1));
    document.getElementById(toId).value = iso(now);
  } else {
    document.getElementById(fromId).value = '';
    document.getElementById(toId).value = '';
  }
  renderAll();
}

/* ===================== print preview ===================== */
/* The memo on the form, as a sheet. Print and the two downloads all start from this
   one object, so a memo cannot be saved as a picture showing different figures from
   the copy that gets printed. Returns null when the form has no lines yet. */
function memoPreviewDraft() {
  const valid = memoDraft.items.filter(x => x.productId && num(x.qty) > 0);
  if (!valid.length) return null;
  const fin = memoMath(valid, memoCharges());
  return {
    memoNo: document.getElementById('memoNo').value,
    date: document.getElementById('memoDate').value || today(),
    customerName: document.getElementById('customerName').value.trim() || '-',
    customerPhone: document.getElementById('customerPhone').value.trim(),
    customerAddress: document.getElementById('customerAddress').value.trim(),
    items: valid.map(x => ({
      productName: (productById(x.productId) || {}).name || '',
      qty: num(x.qty), rate: num(x.rate), amount: round2(num(x.qty) * num(x.rate))
    })),
    totalQty: valid.reduce((a, x) => a + num(x.qty), 0),
    subtotal: fin.subtotal, discount: fin.discount, deliveryCharge: fin.deliveryCharge,
    vat: fin.vat, grandTotal: fin.grandTotal, advance: fin.advance, due: fin.due,
    note: document.getElementById('memoNote').value.trim()
  };
}

function printPreviewCurrent() {
  const preview = memoPreviewDraft();
  if (!preview) return alert('Add a product first, then print.');
  printMemoSheet(preview);
}

/* Preview the memo being written, in the same modal the history uses, so the export
   buttons sit next to it. Nothing is saved to the book by looking. */
function previewCurrentMemo() {
  const preview = memoPreviewDraft();
  if (!preview) return alert('Add a product first, then preview.');
  document.getElementById('viewBody').innerHTML = memoSheet(preview);
  const no = document.getElementById('viewMemoNo');
  if (no) no.textContent = (preview.memoNo || '(unsaved)') + '  |  ' + preview.customerName;
  document.getElementById('viewModal').classList.add('show');
}

function savePreviewMemo(kind) {
  const preview = memoPreviewDraft();
  if (!preview) return alert('Add a product first, then save.');
  kind === 'pdf' ? saveMemoPDF(preview) : saveMemoPNG(preview);
}

/* ===================== CSV export ===================== */
function download(name, rows) {
  const csv = rows.map(r => r.map(v => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
}

function exportMemosCSV() {
  const rows = [['Memo No', 'Date', 'Customer', 'Phone', 'Address', 'Total Qty', 'Subtotal', 'Discount',
    'Delivery Charge', 'VAT', 'Grand Total', 'Advance', 'Due', 'COGS', 'Profit']];
  db.memos.forEach(m => rows.push([m.memoNo, m.date, m.customerName, m.customerPhone, m.customerAddress,
    m.totalQty, m.subtotal, m.discount, m.deliveryCharge, m.vat, m.grandTotal, m.advance, m.due, m.cogs, m.profit]));
  download('texpark_memos.csv', rows);
}

function exportStockLogCSV() {
  const rows = [['Date', 'Product', 'Type', 'In', 'Out', 'Balance', 'Reference', 'Note']];
  db.ledger.forEach(l => {
    const p = productById(l.productId);
    rows.push([l.date, p ? p.name : '(deleted)', l.type,
      num(l.qty) > 0 ? num(l.qty) : '', num(l.qty) < 0 ? Math.abs(num(l.qty)) : '',
      num(l.balance), l.ref, l.note]);
  });
  download('texpark_stock_ledger.csv', rows);
}

function exportAllCSV() {
  const rows = [['Type', 'Date', 'Reference', 'Party', 'Item', 'Qty', 'Rate', 'Amount', 'Status']];
  db.memos.forEach(m => m.items.forEach(i => rows.push(['Sale', m.date, m.memoNo, m.customerName,
    i.productName, i.qty, i.rate, i.amount, m.due > 0 ? 'Due ' + m.due : 'Paid'])));
  db.purchases.forEach(p => p.items.forEach(i => rows.push(['Purchase', p.date, p.purchaseNo,
    p.supplierName, i.productName, i.qty, i.cost, i.amount, p.status])));
  db.expenses.forEach(e => rows.push(['Expense', e.date, e.head, '', e.note, '', '', e.amount, '']));
  db.payments.forEach(p => {
    const c = db.customers.find(x => x.id === p.customerId);
    rows.push(['Payment In', p.date, p.method, c ? c.name : '', '', '', '', p.amount, '']);
  });
  download('texpark_all_data.csv', rows);
}






