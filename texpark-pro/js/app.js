/* Texpark Pro — UI + actions. */

/* Bump this together with CACHE in sw.js. Shown in Settings so a phone can
   prove which build it is actually running. */
const APP_VERSION = '2026-09-22.6';

const PAGES = [
  { id: 'dashboard',  label: 'Dashboard',      ic: '\u25A3', group: 'Overview' },
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
var purchaseDraft = { items: [] };
var currentPage = "dashboard";

function set(elId, v) { const e = document.getElementById(elId); if (e) e.textContent = v; }
function statBox(label, value, sub) {
  return '<div class="card stat"><div class="label">' + label + '</div><div class="value">' + value + '</div>' +
    (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
}

/* ===================== boot ===================== */
function boot() {
  db = loadDB();
  if (!db.users || !db.users.length) db.users = defaultUsers();
  syncLoad();
  buildLogin();
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
    document.getElementById('loginErr').textContent = 'Username ba password bhul.';
    return;
  }
  session = { userId: user.id, username: user.username, name: user.name, role: user.role };
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appRoot').style.display = '';
  buildNav();
  nav('dashboard');
  syncFlush();
}

function doLogout() { session = null; buildLogin(); }

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
  if (!can(page)) { alert('Ei page-er onumoti nei.'); return; }
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
    if (p === 'memo') calcMemo();
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
    db.memos.forEach(x => { if (x.date === d) { s += num(x.grandTotal); pr += num(x.profit); } });
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
}

function pendingDeliveryHTML() {
  const rows = db.memos.map(m => {
    const d = db.deliveries.filter(x => x.memoId === m.id).reduce((a, x) => a + num(x.qty), 0);
    return { m, pend: num(m.totalQty) - d };
  }).filter(x => x.pend > 0).slice(-8);
  if (!rows.length) return '<div class="empty">Nothing pending delivery</div>';
  return '<div class="tablewrap"><table><thead><tr><th>Memo</th><th>Customer</th><th>Pending</th></tr></thead><tbody>' +
    rows.map(x => '<tr><td>' + esc(x.m.memoNo) + '</td><td>' + esc(x.m.customerName) +
      '</td><td><span class="pill warn">' + x.pend + '</span></td></tr>').join('') + '</tbody></table></div>';
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
  document.getElementById('memoDiscount').value = 0;
  document.getElementById('memoDeliveryCharge').value = 0;
  document.getElementById('memoAdvance').value = 0;
  addMemoLine(); addMemoLine(); addMemoLine();
  calcMemo();
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
      '<td class="right"><span class="pill ' + (avail <= 0 ? 'danger' : avail <= num(p?.reorderLevel) ? 'warn' : 'ok') + '">' +
        (it.productId ? avail : '-') + '</span></td>' +
      '<td><input class="' + (notEntered ? 'warn-field' : '') + '" type="number" step="0.01" value="' + num(it.rate) + '" oninput="memoSet(' + i + ',\'rate\',this.value)"></td>' +
      '<td><input class="' + (notEntered ? 'warn-field' : '') + '" type="number" min="0" step="1" value="' + num(it.qty) + '" oninput="memoSet(' + i + ',\'qty\',this.value)"></td>' +
      '<td class="right">' + money(num(it.qty) * num(it.rate)) + '</td>' +
      '<td class="right">' + money(num(it.qty) * num(it.cost)) + '</td>' +
      '<td class="right"><b class="' + (margin >= 0 ? 'green' : 'red') + '">' + money(margin) + '</b></td>' +
      '<td><button class="btn-danger btn-sm" onclick="memoDel(' + i + ')">x</button></td>' +
      '</tr>';
  }).join('');
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
  renderMemoLines();
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
    box.innerHTML = '<div class="note warn"><b>Ei product gulor stock ekhono tola hoy ni:</b>' +
      '<div class="shortlist"><table><thead><tr><th>Product</th><th class="right">Memo te uthche</th>' +
      '<th class="right">Stock-e ache</th><th class="right">Stock-e tola baki</th></tr></thead><tbody>' +
      short.map(p => '<tr><td>' + esc(p.name) + '</td><td class="right">' + p.requested +
        '</td><td class="right">' + p.available + '</td><td class="right"><b>' + p.short +
        '</b></td></tr>').join('') + '</tbody></table></div>' +
      '<div class="hint">Memo save hobe — ar ei product gulo Stock page-e nijei bose jabe. ' +
      'Pore <b>Stock</b> page-e giye "Received / Opening" tole din. Memo kokhono atkabe na.</div></div>';
    if (saveBtn) saveBtn.disabled = false;
  } else {
    box.innerHTML = valid.length ? '<div class="note good">Stock mil ache - memo save korte paren.</div>' : '';
    if (saveBtn) saveBtn.disabled = false;
  }

  const cl = document.getElementById('memoCustList');
  if (cl) cl.innerHTML = '<option value="">- New / Select -</option>' +
    db.customers.map(c => '<option value="' + c.id + '">' + esc(c.name) + (c.phone ? ' - ' + esc(c.phone) : '') + '</option>').join('');
  renderMemoLines();
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
  if (!name) return alert('Customer name din.');
  if (!valid.length) return alert('Antoto ekta product o quantity din.');

  /* Memo is the source of truth. Stock na thakleo memo save hobe - ar jei product
     memo-te uthche seta stock book-e nijei bose jabe (0 received diye), jate pore
     apni received qty tulte paren. Memo kokhono atkabe na. */
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

  if (prev) { reverseSaleFromStock(prev); Object.assign(prev, memo); }
  else db.memos.push(memo);
  applySaleToStock(memo);

  const c = db.customers.find(x => x.name.toLowerCase() === name.toLowerCase() && (x.phone || '') === memo.customerPhone);
  if (!c) db.customers.push({ id: id(), name, phone: memo.customerPhone, address: memo.customerAddress });

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

  alert('Memo ' + memo.memoNo + ' save hoyeche.\n' +
    'Ei product gulor stock card banano hoyeche. Received/Opening qty Stock page theke tole nin.');
  newMemo();
}

/* ===================== history ===================== */
function renderHistory() {
  const q = (document.getElementById('hSearch').value || '').toLowerCase();
  const arr = db.memos.filter(m =>
    (m.memoNo + ' ' + m.customerName + ' ' + (m.customerPhone || '')).toLowerCase().includes(q)).slice().reverse();
  document.getElementById('historyTable').innerHTML = arr.length
    ? '<div class="tablewrap"><table><thead><tr><th>Memo No</th><th>Date</th><th>Customer</th><th class="right">Qty</th>' +
      '<th class="right">Grand</th><th class="right">Profit</th><th class="right">Due</th><th>Delivery</th><th></th></tr></thead><tbody>' +
      arr.map(m => {
        const d = db.deliveries.filter(x => x.memoId === m.id).reduce((a, x) => a + num(x.qty), 0);
        const st = d >= num(m.totalQty) ? 'ok' : d ? 'warn' : 'danger';
        return '<tr><td>' + esc(m.memoNo) + '</td><td>' + m.date + '</td><td>' + esc(m.customerName) + '</td>' +
          '<td class="right">' + m.totalQty + '</td><td class="right">' + money(m.grandTotal) + '</td>' +
          '<td class="right"><b class="' + (num(m.profit) >= 0 ? 'green' : 'red') + '">' + money(m.profit) + '</b></td>' +
          '<td class="right">' + money(m.due) + '</td>' +
          '<td><span class="pill ' + st + '">' + d + '/' + m.totalQty + '</span></td>' +
          '<td><button class="btn-light btn-sm" onclick="viewMemo(\'' + m.id + '\')">View</button> ' +
          '<button class="btn-light btn-sm" onclick="editMemo(\'' + m.id + '\')">Edit</button> ' +
          '<button class="btn-light btn-sm" onclick="printMemoById(\'' + m.id + '\')">Print</button> ' +
          '<button class="btn-danger btn-sm" onclick="deleteMemo(\'' + m.id + '\')">Delete</button></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No memos</div>';
}

function editMemo(mid) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  if (!can('memo')) return alert('Onumoti nei.');
  editingMemoId = mid;
  memoDraft = { items: m.items.map(i => ({ productId: i.productId, qty: i.qty, rate: i.rate, cost: i.cost, vat: i.vat })) };
  nav('memo');
  document.getElementById('memoNo').value = m.memoNo;
  document.getElementById('memoDate').value = m.date;
  document.getElementById('customerName').value = m.customerName;
  document.getElementById('customerPhone').value = m.customerPhone || '';
  document.getElementById('customerAddress').value = m.customerAddress || '';
  document.getElementById('memoDiscount').value = m.discount || 0;
  document.getElementById('memoDeliveryCharge').value = m.deliveryCharge || 0;
  document.getElementById('memoAdvance').value = m.advance || 0;
  document.getElementById('memoNote').value = m.note || '';
  const b = document.getElementById('memoEditingBanner');
  b.style.display = ''; 
  b.textContent = 'Editing ' + m.memoNo + ' - save korle age purono stock phiriye tarpor notun kore biyog hobe.';
  renderMemoLines();
  calcMemo();
}

function deleteMemo(mid) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  if (!confirm('Memo ' + m.memoNo + ' delete korben? Stock abar phiriye deya hobe.')) return;
  reverseSaleFromStock(m);
  db.deliveries = db.deliveries.filter(d => d.memoId !== m.id);
  db.memos = db.memos.filter(x => x.id !== mid);
  if (editingMemoId === mid) newMemo();
  if (!commit()) return;
  syncPush('memo_delete', { memoNo: m.memoNo }, 'Delete ' + m.memoNo);
  alert('Memo delete hoyeche, stock abar firiye deya hoyeche.');
}

function viewMemo(mid) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  document.getElementById('viewBody').innerHTML = memoSheet(m);
  document.getElementById('viewModal').classList.add('show');
}
function closeView() { document.getElementById('viewModal').classList.remove('show'); }

function printMemoById(mid) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  document.getElementById('printArea').innerHTML = memoSheet(m);
  window.print();
}

/* ===================== memo sheet (screen + A4 print) ===================== */
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

function memoSheet(m) {
  const c = db.settings.company || {};
  const rows = (m.items || []).map((x, i) => '<tr><td>' + String(i + 1).padStart(2, '0') + '</td><td>' +
    esc(x.productName) + '</td><td class="right">' + num(x.rate).toLocaleString('en-US') + '</td>' +
    '<td class="right">' + num(x.qty) + '</td><td class="right">' + num(x.amount).toLocaleString('en-US') + '</td></tr>').join('');
  return '<div class="memo-sheet">' +
    '<div class="mh"><div><h1>TEX<span>PARK</span></h1><div class="tl">' + esc(c.tagline || 'Buying House') + '</div>' +
    (c.md ? '<div style="font-size:11px;margin-top:3px"><b>MD:</b> ' + esc(c.md) + '</div>' : '') + '</div>' +
    '<div class="ct"><div><b>Phone:</b> ' + esc(c.phone || '') + '</div><div><b>Email:</b> ' + esc(c.email || '') + '</div>' +
    '<div><b>Address:</b> ' + esc(c.address || '') + '</div>' +
    (c.bin ? '<div><b>BIN:</b> ' + esc(c.bin) + '</div>' : '') + '</div></div>' +
    '<div class="mmeta"><div><b>Customer:</b> ' + esc(m.customerName) + '<br><b>Phone:</b> ' + esc(m.customerPhone || '-') +
    '<br><b>Address:</b> ' + esc(m.customerAddress || '-') + '</div>' +
    '<div style="text-align:right"><b>Memo No:</b> ' + esc(m.memoNo) + '<br><b>Date:</b> ' + esc(m.date) + '</div></div>' +
    '<table><thead><tr><th>SL</th><th>PRODUCT NAME</th><th class="right">RATE</th><th class="right">QTY</th>' +
    '<th class="right">AMOUNT</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="mtt"><table>' +
    '<tr><td>Total Qty</td><td class="right">' + num(m.totalQty) + '</td></tr>' +
    '<tr><td>Subtotal</td><td class="right">' + money(m.subtotal) + '</td></tr>' +
    '<tr><td>Discount</td><td class="right">- ' + money(m.discount) + '</td></tr>' +
    '<tr><td>Delivery Charge</td><td class="right">+ ' + money(m.deliveryCharge) + '</td></tr>' +
    (num(m.vat) ? '<tr><td>VAT</td><td class="right">+ ' + money(m.vat) + '</td></tr>' : '') +
    '<tr class="g"><td>Grand Total</td><td class="right">' + money(m.grandTotal) + '</td></tr>' +
    '<tr><td>Advance</td><td class="right">- ' + money(m.advance) + '</td></tr>' +
    '<tr class="g"><td>Due</td><td class="right">' + money(m.due) + '</td></tr>' +
    '</table></div>' +
    '<div class="words"><b>Amount in Words:</b> ' + numberWords(num(m.grandTotal)) + ' Taka Only.</div>' +
    (m.note ? '<div style="margin-top:8px;font-size:11px"><b>Note:</b> ' + esc(m.note) + '</div>' : '') +
    '<div class="sign"><div>Customer Signature</div><div>Authorized Signature</div></div></div>';
}

/* ===================== delivery ===================== */
function renderDelivery() {
  const rows = db.memos.map(m => {
    const d = db.deliveries.filter(x => x.memoId === m.id).reduce((a, x) => a + num(x.qty), 0);
    return { m, d, pend: num(m.totalQty) - d };
  }).slice().reverse();
  document.getElementById('deliveryTable').innerHTML = rows.length
    ? '<div class="tablewrap"><table><thead><tr><th>Memo</th><th>Customer</th><th>Phone</th><th class="right">Sold</th>' +
      '<th class="right">Delivered</th><th class="right">Pending</th><th>Status</th><th>Driver</th><th>Vehicle</th><th>Receiver</th></tr></thead><tbody>' +
      rows.map(x => {
        const st = x.pend <= 0 ? 'ok' : x.d ? 'warn' : 'danger';
        return '<tr><td>' + esc(x.m.memoNo) + '</td><td>' + esc(x.m.customerName) + '</td>' +
          '<td>' + esc(x.m.customerPhone || '') + '</td><td class="right">' + x.m.totalQty + '</td>' +
          '<td class="right">' + x.d + '</td><td class="right"><b>' + x.pend + '</b></td>' +
          '<td><span class="pill ' + st + '">' + (x.pend <= 0 ? 'Delivered' : x.d ? 'Partial' : 'Pending') + '</span> ' +
          '<button class="btn-light btn-sm" onclick="openDelivery(\'' + x.m.id + '\')">Update</button></td>' +
          '<td>' + esc(x.m.driver || '-') + '</td><td>' + esc(x.m.vehicle || '-') + '</td><td>' + esc(x.m.receiver || '-') + '</td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No memos</div>';
  document.getElementById('deliveryMemoSel').innerHTML = '<option value="">- select memo -</option>' +
    db.memos.slice().reverse().map(m => '<option value="' + m.id + '">' + esc(m.memoNo) + ' - ' + esc(m.customerName) + '</option>').join('');
}

function openDelivery(mid) {
  const m = db.memos.find(x => x.id === mid);
  if (!m) return;
  const d = db.deliveries.filter(x => x.memoId === mid).reduce((a, x) => a + num(x.qty), 0);
  document.getElementById('dlMemo').value = m.id;
  document.getElementById('dlInfo').innerHTML = esc(m.memoNo) + ' - ' + esc(m.customerName) +
    ' | Sold ' + m.totalQty + ' | Delivered ' + d + ' | Pending <b>' + (num(m.totalQty) - d) + '</b>';
  document.getElementById('dlQty').value = Math.max(0, num(m.totalQty) - d);
  document.getElementById('dlDriver').value = m.driver || '';
  document.getElementById('dlVehicle').value = m.vehicle || '';
  document.getElementById('dlReceiver').value = m.receiver || '';
  document.getElementById('dlNote').value = m.deliveryNote || '';
  document.getElementById('deliveryModal').classList.add('show');
}
function closeDelivery() { document.getElementById('deliveryModal').classList.remove('show'); }

function saveDelivery() {
  const mid = document.getElementById('dlMemo').value;
  const q = num(document.getElementById('dlQty').value);
  const m = db.memos.find(x => x.id === mid);
  if (!m) return alert('Memo select korun.');
  const already = db.deliveries.filter(x => x.memoId === mid).reduce((a, x) => a + num(x.qty), 0);
  if (q <= 0) return alert('Delivery qty din.');
  if (already + q > num(m.totalQty)) {
    return alert('Delivery qty memo qty-er beshi hote pare na. Baki: ' + (num(m.totalQty) - already));
  }
  db.deliveries.push({
    id: id(), memoId: mid, qty: q, date: today(),
    driver: document.getElementById('dlDriver').value.trim(),
    vehicle: document.getElementById('dlVehicle').value.trim(),
    receiver: document.getElementById('dlReceiver').value.trim(),
    note: document.getElementById('dlNote').value.trim(),
    status: already + q >= num(m.totalQty) ? 'Delivered' : 'Partial'
  });
  m.driver = document.getElementById('dlDriver').value.trim();
  m.vehicle = document.getElementById('dlVehicle').value.trim();
  m.receiver = document.getElementById('dlReceiver').value.trim();
  m.deliveryNote = document.getElementById('dlNote').value.trim();
  if (!commit()) return;
  syncPush('delivery', {
    memoNumber: m.memoNo, customer: m.customerName, qty: q, deliveredQty: already + q,
    pendingQty: num(m.totalQty) - already - q, deliveryDate: today(),
    driver: m.driver, vehicle: m.vehicle, receiver: m.receiver,
    status: already + q >= num(m.totalQty) ? 'Delivered' : 'Partial', note: m.deliveryNote
  }, 'Delivery ' + m.memoNo);
  closeDelivery();
  alert('Delivery update hoyeche.');
}

/* ===================== customers ===================== */
function customerDue(c) {
  const ms = db.memos.filter(m => m.customerName === c.name && (m.customerPhone || '') === (c.phone || ''));
  const sales = ms.reduce((a, m) => a + num(m.grandTotal), 0);
  const adv = ms.reduce((a, m) => a + num(m.advance), 0);
  const paid = db.payments.filter(p => p.customerId === c.id).reduce((a, p) => a + num(p.amount), 0);
  return { sales, adv, paid, due: round2(sales - adv - paid), memos: ms };
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
  if (!n) return alert('Name din.');
  db.customers.push({ id: id(), name: n, phone: document.getElementById('cPhone').value.trim(), address: document.getElementById('cAddress').value.trim() });
  ['cName', 'cPhone', 'cAddress'].forEach(i => document.getElementById(i).value = '');
  commit();
}

function deleteCustomer(cid) {
  const c = db.customers.find(x => x.id === cid);
  if (!c) return;
  if (db.memos.some(m => m.customerName === c.name)) return alert('Ei customer-er memo ache, delete kora jabe na.');
  if (db.payments.some(p => p.customerId === cid)) return alert('Ei customer-er payment record ache, delete kora jabe na.');
  if (!confirm('Customer delete korben?')) return;
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
  if (amt <= 0) return alert('Amount din.');
  db.payments.push({
    id: id(), customerId: cid, date: document.getElementById('payDate').value || today(),
    amount: amt, method: document.getElementById('payMethod').value,
    note: document.getElementById('payNote').value.trim()
  });
  if (!commit()) return;
  syncPush('payment', { customerId: cid, amount: amt, date: today(), method: document.getElementById('payMethod').value }, 'Payment');
  closePayment();
  alert('Payment receive hoyeche.');
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
      statBox('0-30 din', money(buck.current), '') +
      statBox('60+ din', money(buck.d60 + buck.d90 + buck.over90), '') +
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
  if (!valid.length) return alert('Antoto ekta product din.');
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
  alert('Purchase save hoyeche, stock bcreche.');
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
  if (!confirm('Purchase ' + p.purchaseNo + ' delete korben? Stock theke biyog hobe.')) return;
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
  if (!n) return alert('Supplier name din.');
  db.suppliers.push({
    id: id(), name: n, contact: document.getElementById('sContact').value.trim(),
    phone: document.getElementById('sPhone').value.trim(),
    address: document.getElementById('sAddress').value.trim()
  });
  ['sName', 'sContact', 'sPhone', 'sAddress'].forEach(i => document.getElementById(i).value = '');
  commit();
}

function deleteSupplier(sid) {
  if (db.purchases.some(p => p.supplierId === sid)) return alert('Ei supplier-er purchase history ache, delete kora jabe na.');
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
  if (!n) return alert('Product name din.');
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
  commit();
  closeProduct();
}

function deleteProduct(pid) {
  const used = db.memos.some(m => m.items.some(i => i.productId === pid));
  const s = db.stock.find(x => x.productId === pid);
  if (used || num(s?.sold) > 0) return alert('Ei product-er sales history ache, delete kora jabe na. Edit korun.');
  if (db.purchases.some(p => p.items.some(i => i.productId === pid))) return alert('Ei product-er purchase history ache, delete kora jabe na.');
  if (!confirm('Product delete korben?')) return;
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
      '<th class="right">Sold</th><th class="right">Available</th><th class="right">Unit Cost</th>' +
      '<th class="right">Stock Value</th><th>Status</th><th></th></tr></thead><tbody>' +
      arr.map(p => {
        const s = db.stock.find(x => x.productId === p.id) || {};
        const av = num(s.available);
        const st = av <= 0 ? 'danger' : av <= num(p.reorderLevel) ? 'warn' : 'ok';
        return '<tr><td>' + esc(p.name) + '</td><td class="right">' + num(s.opening) + '</td>' +
          '<td class="right">' + num(s.purchased) + '</td><td class="right">' + num(s.sold) + '</td>' +
          '<td class="right"><b>' + av + '</b></td><td class="right">' + money(stockCost(p.id)) + '</td>' +
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
  if (!pid) return alert('Product select korun.');
  if (q <= 0) return alert('Quantity din (0 theke beshi).');
  const p = productById(pid);
  const s = stockOf(pid);
  s.opening = num(s.opening) + q;
  if (c > 0) s.cost = c;
  s.available = stockAvailable(s);
  logStock(pid, 'Opening', q, 'Manual', 'Opening stock added');
  document.getElementById('stockAddQty').value = '';
  document.getElementById('stockCost').value = '';
  if (!commit()) return;
  alert('Stock jog hoyeche.\n' + (p ? p.name : 'Product') + ' - available ekhon: ' + s.available);
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
  if (delta === 0) return alert('Adjustment qty din (positive add, negative kom).');
  const s = stockOf(pid);
  if (num(s.available) + delta < 0) {
    return alert('Adjustment korle stock negative hoye jabe. Available: ' + num(s.available));
  }
  if (delta > 0) s.opening = num(s.opening) + delta;
  else s.sold = num(s.sold) + Math.abs(delta);
  s.available = stockAvailable(s);
  logStock(pid, 'Adjustment', delta, 'Manual', reason || 'Stock adjustment');
  commit();
  closeAdjust();
  alert('Stock adjustment hoyeche.');
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
    return alert('Sold qty memo-r asol bikri (' + memoSold + ') theke kome hote pare na.');
  }
  const available = opening + purchased - sold;
  if (available < 0) return alert('Available stock negative hote pare na. Opening/Purchased baran.');

  const s = stockOf(pid);
  const before = num(s.available);
  s.opening = opening; s.purchased = purchased; s.sold = sold;
  if (cost > 0) s.cost = cost;
  s.available = stockAvailable(s);
  logStock(pid, 'Adjustment', s.available - before, 'Manual', 'Stock card edited');
  commit();
  closeStockEdit();
  alert('Stock update hoyeche.');
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
    m.items.forEach(it => {
      const k = it.productId || it.productName;
      map[k] = map[k] || { name: it.productName, qty: 0, sales: 0, cost: 0, profit: 0 };
      map[k].qty += num(it.qty);
      map[k].sales += round2(num(it.amount));
      map[k].cost += round2(num(it.qty) * num(it.cost));
      map[k].profit += round2(num(it.amount) - num(it.qty) * num(it.cost));
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
    : '<div class="empty">Ei timeframe-e kono sale nei</div>';
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
    months[k].sales = round2(months[k].sales + num(m.subtotal));
    months[k].cogs = round2(months[k].cogs + num(m.cogs));
    months[k].profit = round2(months[k].profit + num(m.profit));
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
  if (amt <= 0) return alert('Amount din.');
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
  if (!confirm('Expense delete korben?')) return;
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
  if (!un || !nm || !pw) return alert('Username, name o password din.');
  if (db.users.some(u => u.username === un)) return alert('Ei username agei ache.');
  if (pw.length < 4) return alert('Password antoto 4 character din.');
  db.users.push({ id: id(), username: un, name: nm, pass: hash(pw), role: rl, active: true, createdAt: new Date().toISOString() });
  ['uUsername', 'uName', 'uPass'].forEach(i => document.getElementById(i).value = '');
  commit();
}

function toggleUser(uid) {
  const u = db.users.find(x => x.id === uid);
  if (!u) return;
  if (u.username === 'admin' && u.active !== false) return alert('admin disable kora jabe na.');
  u.active = u.active === false;
  commit();
}

function resetPass(uid) {
  const u = db.users.find(x => x.id === uid);
  if (!u) return;
  const v = prompt('Notun password for ' + u.username + ':', '');
  if (!v) return;
  if (v.length < 4) return alert('Antoto 4 character din.');
  u.pass = hash(v);
  commit();
  alert('Password reset hoyeche.');
}

function delUser(uid) {
  const u = db.users.find(x => x.id === uid);
  if (!u) return;
  if (u.id === session.userId) return alert('Nijer account delete kora jabe na.');
  if (!confirm('User ' + u.username + ' delete korben?')) return;
  db.users = db.users.filter(x => x.id !== uid);
  commit();
}

function changeMyPass() {
  const a = document.getElementById('myOldPass').value;
  const b = document.getElementById('myNewPass').value;
  const me = db.users.find(x => x.id === session.userId);
  if (!me) return;
  if (me.pass !== hash(a)) return alert('Purono password bhul.');
  if (b.length < 4) return alert('Notun password antoto 4 character din.');
  me.pass = hash(b);
  document.getElementById('myOldPass').value = '';
  document.getElementById('myNewPass').value = '';
  commit();
  alert('Password change hoyeche.');
}

/* ===================== settings ===================== */
function renderSettings() {
  const c = db.settings.company || {};
  ['name', 'tagline', 'md', 'phone', 'email', 'address', 'bin', 'vatReg'].forEach(k => {
    const e = document.getElementById('co_' + k);
    if (e) e.value = c[k] || '';
  });
  document.getElementById('stSyncUrl').value = db.settings.syncUrl || '';
  document.getElementById('stMemoPrefix').value = db.settings.memoPrefix || 'TXP/SM/';
  const dt = document.getElementById('stDeviceTag');
  if (dt) dt.value = db.settings.deviceTag || '';
  document.getElementById('stLowStock').value = db.settings.lowStockLevel || 10;
  document.getElementById('stShortWarn').checked = db.settings.warnOnShortStock !== false;
  document.getElementById('stAutoBackup').checked = db.settings.autoBackup !== false;
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
    Promise.all([bust('js/app.js'), bust('css/app.css')]).then(res => {
      const js = res[0] || '', css = res[1] || '';
      const serverJs = (js.match(/APP_VERSION = '([^']+)'/) || [])[1] || '?';
      const hasPhoneFix = /iOS zooms the whole page in/.test(css);
      say('<div class="vp-block"><b>Ei device e: ' + APP_VERSION + '</b>' +
          'Server e ache: <b>' + serverJs + '</b>' +
          (serverJs === APP_VERSION
            ? '<br>Duitai same — apni latest version e achen.'
            : '<br>Notun version ache! Reload korun.') +
          '<br>Phone layout fix server e: ' + (hasPhoneFix ? 'ache' : 'nei') + '</div>');
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
  db.settings.autoBackup = document.getElementById('stAutoBackup').checked;
  commit();
  alert('Company setting save hoyeche.');
}

function saveSyncUrl() {
  db.settings.syncUrl = document.getElementById('stSyncUrl').value.trim();
  commit();
  alert('Sync URL save hoyeche.');
}

function toggleShortStockWarn(on) {
  db.settings.warnOnShortStock = !!on;
  commit();
  calcMemo();
}

async function testSync() {
  const out = document.getElementById('syncTestOut');
  const url = (db.settings.syncUrl || '').trim();
  if (!url) { out.innerHTML = '<span class="red">Sync URL nei. Age URL save korun.</span>'; return; }
  out.textContent = 'Testing...';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ type: 'test', data: { time: new Date().toISOString() } })
    });
    const txt = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch (e) {}
    if (parsed && parsed.success !== false) {
      out.innerHTML = '<span class="green">✓ Sync kaj korche. Sheet-e response esheche: ' + esc(parsed.message || 'ok') + '</span>';
    } else {
      out.innerHTML = '<span class="orange">Response esheche kintu success na: ' + esc(txt.slice(0, 160)) + '</span>' +
        '<div class="hint">Code.gs update kore notun version deploy korechen kina check korun.</div>';
    }
  } catch (e) {
    out.innerHTML = '<span class="red">Sync test fail: ' + esc(e.message || 'network error') + '</span>' +
      '<div class="hint">URL, internet o Apps Script deployment permission check korun.</div>';
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
    ['Payments', db.payments.length], ['Deliveries', db.deliveries.length],
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
    : '<div class="empty">Queue khali - shob sync hoye geche</div>';

  const snaps = listSnapshots();
  document.getElementById('snapshotTable').innerHTML = snaps.length
    ? '<div class="tablewrap"><table><thead><tr><th>When</th><th></th></tr></thead><tbody>' +
      snaps.map((s, i) => '<tr><td>' + esc(new Date(s.at).toLocaleString()) + '</td>' +
        '<td class="right"><button class="btn-light btn-sm" onclick="restoreSnapshot(' + i + ')">Restore this</button></td></tr>').join('') +
      '</tbody></table></div>'
    : '<div class="empty">Kono snapshot nei (prottek save-e auto snapshot hoy)</div>';
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
  out.textContent = 'Sheet theke ana hocche...';
  try {
    const devs = await cloudListDevices();
    if (!devs.length) { out.innerHTML = '<span class="muted">Sheet-e ekhono kono backup nei.</span>'; return; }
    out.innerHTML = '<div class="tablewrap"><table><thead><tr><th>Device</th><th>Date</th><th class="right">Size</th><th></th></tr></thead><tbody>' +
      devs.map(d => '<tr><td><b>' + esc(d.device) + '</b></td><td>' + esc(d.date) + '</td>' +
        '<td class="right">' + Math.round((d.bytes || 0) / 1024) + ' KB</td>' +
        '<td class="right"><button class="btn-light btn-sm" onclick="cloudRestore(\'' + esc(d.device) + '\')">Ei ta fire aan</button></td></tr>').join('') +
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
      if (!confirm('Ei backup restore korben? Ekhonkar data replace hobe.')) return;
      db = migrate(incoming);
      if (!db.users || !db.users.length) db.users = defaultUsers();
      commit();
      alert('Backup restore hoyeche. Page reload hobe.');
      location.reload();
    } catch (err) {
      alert('Backup file ta thik na: ' + err.message);
    }
  };
  r.readAsText(f);
}

/* Import old v1 data (read-only read from the old key, never writes to it). */
function importOldData() {
  const raw = localStorage.getItem(OLD_KEY);
  if (!raw) return alert('Purono app-er data (texpark_biz_v1) ei PC-te nei.');
  if (!confirm('Purono app-er product, customer, stock o memo import korben? Ekhonkar data merge hobe.')) return;
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
        cogs: 0, profit: 0, note: 'Imported from v1 (profit unknown - cost nei)', savedAt: new Date().toISOString()
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
  window.addEventListener('online', () => syncFlush());
  // Push a full cloud backup once a day when the app is opened, so at least one
  // recent restorable copy always exists off-device without anyone remembering.
  setTimeout(maybeDailyCloudBackup, 4000);
  window.addEventListener('beforeunload', () => { if (cloudDirty) cloudBackupNow(true); });
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
function printPreviewCurrent() {
  const valid = memoDraft.items.filter(x => x.productId && num(x.qty) > 0);
  if (!valid.length) return alert('Age product din, tarpor print korun.');
  const fin = memoMath(valid, memoCharges());
  const preview = {
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
  document.getElementById('printArea').innerHTML = memoSheet(preview);
  window.print();
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






