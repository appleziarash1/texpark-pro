/**
 * Texpark Pro — Google Apps Script sync endpoint (v2)
 *
 * Deploy: Deploy > New deployment > Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Then paste the /exec URL into the app's Settings > Google Sheets Sync.
 *
 * Every branch returns {success:true,...} so the client can VERIFY the write.
 * The old version replied without a usable body, which is why the previous app
 * could only say "request sent" and never "saved".
 */

const SPREADSHEET_ID = '1RtD4Bmz-WzCay42rv-IuTZFIQpV3v9PiLnCv1iSpHqQ';

const SHEETS = {
  sales: 'Sales',
  memoSummary: 'Memo_Summary',
  stock: 'Stock',
  purchases: 'Purchases',
  customers: 'Customers',
  suppliers: 'Suppliers',
  delivery: 'Delivery',
  payments: 'Payments',
  expenses: 'Expenses',
  profit: 'Profit',
  appLog: 'App_Log'
};

const HEADERS = {
  sales: ['Timestamp', 'Date', 'Memo No', 'Customer', 'Phone', 'Address', 'Product', 'Qty', 'Rate', 'Amount',
    'Cost', 'COGS', 'Profit', 'Available', 'Subtotal', 'Discount', 'Delivery Charge', 'VAT', 'Grand Total',
    'Advance', 'Due'],
  memoSummary: ['Timestamp', 'Date', 'Memo No', 'Customer', 'Phone', 'Address', 'Total Qty', 'Subtotal',
    'Discount', 'Delivery Charge', 'VAT', 'Grand Total', 'Advance', 'Due', 'COGS', 'Profit', 'Status'],
  stock: ['Timestamp', 'Date', 'Ref', 'Product ID', 'Product', 'Type', 'Qty', 'Rate', 'Balance', 'Note'],
  purchases: ['Timestamp', 'Date', 'Purchase No', 'Supplier', 'Product', 'Qty', 'Unit Cost', 'Amount', 'Balance'],
  customers: ['Timestamp', 'Name', 'Phone', 'Address'],
  suppliers: ['Timestamp', 'Name', 'Contact', 'Phone', 'Address'],
  delivery: ['Timestamp', 'Memo No', 'Customer', 'Qty', 'Delivered Qty', 'Pending Qty', 'Delivery Date',
    'Driver', 'Vehicle', 'Receiver', 'Status', 'Note'],
  payments: ['Timestamp', 'Date', 'Customer', 'Amount', 'Method', 'Note'],
  expenses: ['Timestamp', 'Date', 'Head', 'Amount', 'Note'],
  profit: ['Timestamp', 'Date', 'Ref', 'Sales', 'COGS', 'Profit', 'Type'],
  appLog: ['Timestamp', 'Type', 'Data']
};

function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }
function n_(v) { const x = Number(v); return isFinite(x) ? x : 0; }

function sheet_(ss, key) {
  const name = SHEETS[key];
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const h = HEADERS[key];
  const cur = sh.getRange(1, 1, 1, h.length).getValues()[0];
  let changed = false;
  h.forEach((x, i) => { if (!cur[i]) { cur[i] = x; changed = true; } });
  if (changed) sh.getRange(1, 1, 1, h.length).setValues([cur]);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, h.length).setFontWeight('bold');
  return sh;
}

function ensureAll_(ss) {
  Object.keys(SHEETS).forEach(k => sheet_(ss, k));
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return out_({ success: true, message: 'Texpark Pro sync API is running', version: 2 });
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const type = String(payload.type || '').toLowerCase();
    const d = payload.data || {};
    const ss = ss_();
    ensureAll_(ss);

    let result = 'Saved';
    if (type === 'test') { sheet_(ss, 'appLog').appendRow([new Date(), 'test', JSON.stringify(d)]); result = 'Test row written'; }
    else if (type === 'sale') saveSale_(ss, d);
    else if (type === 'memo' || type === 'memo_update') saveMemo_(ss, d);
    else if (type === 'memo_delete') result = deleteMemo_(ss, d);
    else if (type === 'purchase') savePurchase_(ss, d);
    else if (type === 'stock' || type === 'stock_purchase') saveStock_(ss, d);
    else if (type === 'delivery') saveDelivery_(ss, d);
    else if (type === 'payment') savePayment_(ss, d);
    else if (type === 'expense') saveExpense_(ss, d);
    else if (type === 'customer') sheet_(ss, 'customers').appendRow([new Date(), d.name || '', d.phone || '', d.address || '']);
    else if (type === 'supplier') sheet_(ss, 'suppliers').appendRow([new Date(), d.name || '', d.contact || '', d.phone || '', d.address || '']);
    else { sheet_(ss, 'appLog').appendRow([new Date(), type || 'unknown', JSON.stringify(d)]); result = 'Logged'; }

    return out_({ success: true, message: result, type: type });
  } catch (err) {
    return out_({ success: false, message: String((err && err.message) || err) });
  }
}

/* Upsert keyed on memo number so re-sends never duplicate the summary. */
function upsertMemoSummary_(ss, d) {
  const sh = sheet_(ss, 'memoSummary');
  const no = String(d.memoNo || '');
  if (!no) return;
  const vals = sh.getDataRange().getValues();
  let row = -1;
  for (let i = 1; i < vals.length; i++) if (String(vals[i][2] || '') === no) { row = i + 1; break; }
  const rec = [new Date(), d.date || '', no, d.customerName || '', d.phone || '', d.address || '',
    n_(d.totalQty), n_(d.subtotal), n_(d.discount), n_(d.deliveryCharge), n_(d.vat),
    n_(d.grandTotal), n_(d.advance), n_(d.due), n_(d.cogs), n_(d.profit), d.status || 'Saved'];
  if (row > 0) sh.getRange(row, 1, 1, rec.length).setValues([rec]);
  else sh.appendRow(rec);
}

function saveSale_(ss, d) {
  // One row per product line, tagged with its memo number.
  sheet_(ss, 'sales').appendRow([new Date(), d.date || '', d.memoNo || '', d.customerName || '', d.phone || '',
    d.address || '', d.productName || '', n_(d.qty), n_(d.rate), n_(d.amount), n_(d.cost),
    n_(d.qty) * n_(d.cost), n_(d.amount) - n_(d.qty) * n_(d.cost), n_(d.available), n_(d.subtotal),
    n_(d.discount), n_(d.deliveryCharge), n_(d.vat), n_(d.grandTotal), n_(d.advance), n_(d.due)]);
  upsertMemoSummary_(ss, d);
  sheet_(ss, 'profit').appendRow([new Date(), d.date || '', d.memoNo || '', n_(d.amount),
    n_(d.qty) * n_(d.cost), n_(d.amount) - n_(d.qty) * n_(d.cost), 'Sale']);
}

function saveMemo_(ss, d) {
  upsertMemoSummary_(ss, d);
  // Keep the money columns of existing sales rows for this memo in step.
  const sales = sheet_(ss, 'sales');
  const vals = sales.getDataRange().getValues();
  const no = String(d.memoNo || '');
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][2] || '') === no) {
      sales.getRange(i + 1, 14, 1, 8).setValues([[n_(d.subtotal), n_(d.discount), n_(d.deliveryCharge),
        n_(d.vat), n_(d.grandTotal), n_(d.advance), n_(d.due), n_(d.available || vals[i][13])]]);
    }
  }
}

function deleteMemo_(ss, d) {
  const no = String(d.memoNo || '');
  if (!no) throw new Error('Memo No required for deletion.');
  let removed = 0;
  ['sales', 'memoSummary'].forEach(k => {
    const sh = sheet_(ss, k);
    const col = k === 'sales' ? 3 : 3;
    const vals = sh.getDataRange().getValues();
    for (let i = vals.length - 1; i >= 1; i--) {
      if (String(vals[i][col - 1] || '') === no) { sh.deleteRow(i + 1); removed++; }
    }
  });
  const del = sheet_(ss, 'delivery');
  const dv = del.getDataRange().getValues();
  for (let i = dv.length - 1; i >= 1; i--) if (String(dv[i][1] || '') === no) { del.deleteRow(i + 1); removed++; }
  return 'Deleted ' + removed + ' row(s) for ' + no;
}

function savePurchase_(ss, d) {
  sheet_(ss, 'purchases').appendRow([new Date(), d.date || '', d.purchaseNo || '', d.supplierName || '',
    d.productName || '', n_(d.qty), n_(d.cost), n_(d.amount), n_(d.balance)]);
  sheet_(ss, 'stock').appendRow([new Date(), d.date || '', d.purchaseNo || '', d.productId || '',
    d.productName || '', 'Purchase', n_(d.qty), n_(d.cost), n_(d.balance), d.supplierName || '']);
}

function saveStock_(ss, d) {
  sheet_(ss, 'stock').appendRow([new Date(), d.date || '', d.reference || 'Manual', d.productId || '',
    d.productName || '', d.type || 'Adjustment', n_(d.qty || d.adjustment), n_(d.rate || d.cost),
    n_(d.balance || d.available), d.reason || d.note || '']);
}

function saveDelivery_(ss, d) {
  sheet_(ss, 'delivery').appendRow([new Date(), d.memoNumber || d.memoNo || '', d.customer || '',
    n_(d.qty), n_(d.deliveredQty), n_(d.pendingQty), d.deliveryDate || d.date || '',
    d.driver || '', d.vehicle || '', d.receiver || '', d.status || 'Pending', d.note || '']);
}

function savePayment_(ss, d) {
  sheet_(ss, 'payments').appendRow([new Date(), d.date || '', d.customerName || d.customerId || '',
    n_(d.amount), d.method || '', d.note || '']);
  sheet_(ss, 'profit').appendRow([new Date(), d.date || '', 'PAYMENT', 0, 0, n_(d.amount), 'Received']);
}

function saveExpense_(ss, d) {
  sheet_(ss, 'expenses').appendRow([new Date(), d.date || '', d.head || '', n_(d.amount), d.note || '']);
  sheet_(ss, 'profit').appendRow([new Date(), d.date || '', d.head || '', 0, n_(d.amount), -n_(d.amount), 'Expense']);
}

/* Optional: run once from the editor to create every tab with headers. */
function setupSheets() {
  const ss = ss_();
  ensureAll_(ss);
  Logger.log('Texpark Pro sheets ready: ' + Object.values(SHEETS).join(', '));
}

/* Optional: rebuild the Memo_Summary sheet from the Sales sheet if it ever drifts. */
function rebuildMemoSummary() {
  const ss = ss_();
  const sales = sheet_(ss, 'sales');
  const vals = sales.getDataRange().getValues();
  const seen = {};
  const target = sheet_(ss, 'memoSummary');
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    const no = String(r[2] || '');
    if (!no) continue;
    seen[no] = [new Date(), r[1], no, r[3], r[4], r[5], r[7], r[14], r[15], r[16], r[17], r[18], r[19], r[20],
      r[11], r[12], 'Rebuilt'];
  }
  const rows = Object.values(seen);
  if (rows.length) target.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log('Rebuilt ' + rows.length + ' memo summary row(s).');
}
