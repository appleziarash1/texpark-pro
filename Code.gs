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
  returns: 'Returns',
  payments: 'Payments',
  expenses: 'Expenses',
  profit: 'Profit',
  backup: 'Backup',
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
  /* Parcel returns. Condition decides whether the goods went back into sellable
     stock, so it is written down next to the qty rather than inferred. */
  returns: ['Timestamp', 'Return Date', 'Memo No', 'Customer', 'Products', 'Qty', 'Returned Qty',
    'Pending Qty', 'Condition', 'Note'],
  payments: ['Timestamp', 'Date', 'Customer', 'Amount', 'Method', 'Note'],
  expenses: ['Timestamp', 'Date', 'Head', 'Amount', 'Note'],
  profit: ['Timestamp', 'Date', 'Ref', 'Sales', 'COGS', 'Profit', 'Type'],
  /* Full app snapshots, so a lost PC or phone can be restored instead of lost.
     Keyed on Device + Date by upsert, so one row per device per day.

     A snapshot larger than one cell is split across rows: column 5 holds the chunk
     and columns 6-9 describe the set (which chunk, how many, the total length and a
     checksum). The old single-cell format - one row, whole JSON in column 5 and no
     chunk marker - is still read, because the sheet already holds rows written by
     the previous Code.gs. See chunked backup notes in AGENTS.md. */
  backup: ['Timestamp', 'Device', 'Date', 'App Version', 'JSON',
    'Chunk', 'Of', 'Total Len', 'Checksum'],
  appLog: ['Timestamp', 'Type', 'Data']
};

function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }
function n_(v) { const x = Number(v); return isFinite(x) ? x : 0; }

function sheet_(ss, key) {
  const name = SHEETS[key];
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const h = HEADERS[key];
  // A tab can be narrower than its header row; writing one column past the grid is
  // the same "out of bounds" failure as a row, so widen before touching row 1.
  ensureCols_(sh, h.length);
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

/* ===================== backup storage: chunked, not one cell =====================
   A Google Sheets cell holds 50,000 characters, so a whole db that grows past ~49 KB
   could not be written at all and the backup failed forever. A snapshot is now split
   across several rows of the Backup tab, CHUNK_CHARS at a time. The rows for one
   backup share Device + Date and carry Chunk / Of / Total Len / Checksum, so a pull
   can reassemble them and can tell a complete backup from a half-written one.

   The old format - a single row whose column 5 is the whole JSON and whose chunk
   columns are empty - is still read, because the owner's sheet already contains rows
   written by the previous Code.gs and a restore must not break on them. */

const CHUNK_CHARS = 40000;

/* djb2 over UTF-16 code units. Cheap, runs in Apps Script, and good enough to catch
   a sheet that dropped or reordered a chunk - which is the failure it has to detect. */
function checksum_(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/* Chunk number as stored: 0 means "the old, unchunked format". */
function chunkNum_(v) {
  const x = Number(v);
  return isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

/* Rebuild one device's newest snapshot from all the Backup rows that belong to it.
   `rows` is the grid with the header stripped. A set is identified by its row
   timestamp (column 1) so two backups of the same device are never mixed; the newest
   set is the one to return. Returns {json, date, at, bytes}; throws if the newest set
   is incomplete, so a half-written backup is reported rather than silently restored. */
function assembleBackup_(rows, wantDevice) {
  // Group the device's rows into sets, newest set first.
  const sets = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const dev = String(r[1] || 'unknown');
    if (dev !== wantDevice) continue;
    const key = String(r[0] === undefined || r[0] === null ? '' : r[0]);
    let set = sets.filter(s => s.key === key)[0];
    if (!set) { set = { key: key, at: r[0] ? new Date(r[0]).getTime() : 0, date: r[2] || '', parts: {} }; sets.push(set); }
    const n = chunkNum_(r[5]);
    if (n > 0) set.parts[n] = { text: String(r[4] === undefined || r[4] === null ? '' : r[4]), of: chunkNum_(r[6]), len: Number(r[7]), sum: String(r[8] || '') };
    else set.parts[0] = { text: String(r[4] === undefined || r[4] === null ? '' : r[4]), of: 0, len: 0, sum: '' };
  }
  if (!sets.length) return null;
  sets.sort((a, b) => b.at - a.at);
  const set = sets[0];

  const nums = Object.keys(set.parts).map(Number).sort((a, b) => a - b);
  const isLegacy = nums.length === 1 && nums[0] === 0;

  if (isLegacy) {
    const row = set.parts[0];
    return { json: row.text, date: set.date, at: set.at, bytes: row.text.length, chunks: 1 };
  }

  // Chunked: the count, the total length and the checksum must all agree.
  const of = set.parts[1] ? set.parts[1].of : 0;
  if (!of) throw new Error('Backup for ' + wantDevice + ' has no chunk count.');
  const json = nums.map(n => set.parts[n].text).join('');

  for (let n = 1; n <= of; n++) {
    if (!set.parts[n]) {
      throw new Error('Backup for ' + wantDevice + ' is incomplete: chunk ' + n + ' of ' + of +
        ' is missing. Wait for the device to back up again.');
    }
  }
  const total = Number(set.parts[1].len);
  if (isFinite(total) && total > 0 && json.length !== total) {
    throw new Error('Backup for ' + wantDevice + ' is corrupt: read ' + json.length +
      ' of ' + total + ' characters. It will be overwritten by the next backup.');
  }
  const sum = set.parts[1].sum;
  if (sum && checksum_(json) !== sum) {
    throw new Error('Backup for ' + wantDevice + ' is corrupt: checksum mismatch. It will be overwritten by the next backup.');
  }
  return { json: json, date: set.date, at: set.at, bytes: json.length, chunks: of };
}

function doGet(e) {
  // ?action=pull returns the newest full snapshot per device so a new PC or
  // phone can be restored from the cloud instead of starting empty.
  try {
    const p = (e && e.parameter) || {};
    const action = String(p.action || '').toLowerCase();
    if (action === 'pull' || action === 'pullall') {
      const ss = ss_();
      ensureAll_(ss);
      const sh = sheet_(ss, 'backup');
      const vals = sh.getDataRange().getValues();
      const rows = vals.slice(1);

      // Every device that has at least one backup row, newest row time first.
      const at = {};
      for (let i = 0; i < rows.length; i++) {
        const dev = String(rows[i][1] || 'unknown');
        const t = rows[i][0] ? new Date(rows[i][0]).getTime() : 0;
        if (!at[dev] || t > at[dev]) at[dev] = t;
      }
      const devNames = Object.keys(at).sort((a, b) => at[b] - at[a]);

      // Reassembling can fail (a half-written set), and in pullall one broken
      // device must not hide every other device's good backup. The error is kept
      // per device and returned in `errors`, not thrown past the whole reply.
      const assembled = {};
      const errors = {};
      devNames.forEach(dev => {
        try { assembled[dev] = assembleBackup_(rows, dev); }
        catch (err) { errors[dev] = String((err && err.message) || err); }
      });

      const devs = devNames.map(dev => {
        const a = assembled[dev];
        return {
          device: dev,
          date: a ? a.date : '',
          at: at[dev],
          bytes: a ? a.bytes : 0,
          chunks: a ? a.chunks || 0 : 0,
          error: errors[dev] || ''
        };
      });

      // ?action=pullall returns every device's newest snapshot in one reply, keyed
      // by device. The new PC/phone needs all of them, not just one: its own data
      // may live on the phone, while the memos it entered last week live on the PC.
      // One round trip also means one moment in time, so two snapshots cannot be
      // read either side of a write and merged as if they were consistent.
      if (action === 'pullall') {
        const jsons = {};
        devNames.forEach(dev => { const a = assembled[dev]; if (a && a.json) jsons[dev] = a.json; });
        const reply = { success: true, devices: devs, json: JSON.stringify(jsons) };
        if (Object.keys(errors).length) reply.errors = errors;
        return out_(reply);
      }

      const want = String(p.device || '').trim();
      if (want) {
        if (errors[want]) return out_({ success: false, message: errors[want], devices: devs });
        const a = assembled[want];
        if (a) return out_({ success: true, device: want, date: a.date, json: a.json, devices: devs });
      }
      return out_({ success: true, devices: devs, json: '' });
    }
    return out_({ success: true, message: 'Texpark Pro sync API is running', version: 4 });
  } catch (err) {
    return out_({ success: false, message: String((err && err.message) || err) });
  }
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
    else if (type === 'return') saveReturn_(ss, d);
    else if (type === 'return_delete') result = 'Return ' + (d.memoNumber || '') + ' delete hoyeche (app side)';
    else if (type === 'payment') savePayment_(ss, d);
    else if (type === 'expense') saveExpense_(ss, d);
    else if (type === 'backup') result = saveBackup_(ss, d);
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

/* Grow a sheet's grid so `need` rows fit. A Google sheet is not infinite: it holds a
   fixed number of rows, and a long-lived one can be trimmed to very few. Writing at a
   row past the last one throws "Those rows are out of bounds." - which is exactly what
   a chunked backup did once it needed more rows than the Backup tab had. */
function ensureRows_(sh, need) {
  const max = sh.getMaxRows();
  if (need > max) sh.insertRowsAfter(max, need - max);
}

/* The same for columns, if a chunk ever needs more columns than the tab holds. */
function ensureCols_(sh, need) {
  const max = sh.getMaxColumns();
  if (need > max) sh.insertColumnsAfter(max, need - max);
}

/* A device's snapshot, split across rows. The device's previous rows are cleared and
   a fresh contiguous block is written at the bottom, so the tab keeps exactly one
   backup per device and does not grow without bound. The write is all-or-nothing from
   the reader's point of view: the client only calls it a success when this returns,
   which is after every chunk landed.

   Nothing here deletes rows, and nothing appends into a grid that is already full.
   deleteRow/deleteRows shift every row below and can throw "Those rows are out of
   bounds." on the row past the grid; and appendRow does not grow the sheet, so on a
   full tab it throws the same error. Clearing contents and writing an explicit range
   whose size the grid has been grown to fit avoids both. */
function saveBackup_(ss, d) {
  const sh = sheet_(ss, 'backup');
  const dev = String(d.device || 'unknown');
  const date = String(d.date || '');
  const json = String(d.json || '');
  if (!json) throw new Error('Empty backup payload');

  const cols = HEADERS.backup.length;
  const chunks = Math.max(1, Math.ceil(json.length / CHUNK_CHARS));
  const sum = checksum_(json);
  const now = new Date();

  // The new block: timestamp, device, date, version, chunk, n, of, total, sum. The
  // full length and checksum ride on the first chunk; the others repeat `of` so a
  // stray row still looks like part of a set rather than a legacy single-cell backup.
  const block = [];
  for (let n = 1; n <= chunks; n++) {
    block.push([now, dev, date, String(d.version || ''),
      json.substring((n - 1) * CHUNK_CHARS, n * CHUNK_CHARS), n, chunks,
      n === 1 ? json.length : '', n === 1 ? sum : '']);
  }

  ensureCols_(sh, cols);

  // 1. Clear every row this device already occupies, read from the sheet rather than
  //    assumed, so a hand-edited tab cannot make us overwrite a different device and
  //    no stale chunk of a larger previous backup survives below the new block.
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][1] || '') === dev) sh.getRange(i + 1, 1, 1, cols).clearContent();
  }

  // 2. Write the new block at the bottom, one contiguous range. getLastRow is read
  //    after the clear, so the cleared rows are not counted, and the grid is grown
  //    first because a write past the last row is the "out of bounds" failure.
  const last = sh.getLastRow();
  ensureRows_(sh, last + chunks);
  sh.getRange(last + 1, 1, chunks, cols).setValues(block);

  return 'Backup saved for ' + dev + ' (' + Math.round(json.length / 1024) + ' KB in ' + chunks + ' chunk' + (chunks === 1 ? '' : 's') + ')';
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

function saveReturn_(ss, d) {
  sheet_(ss, 'returns').appendRow([new Date(), d.returnDate || d.date || '', d.memoNumber || d.memoNo || '',
    d.customer || '', d.products || '', n_(d.qty), n_(d.returnedQty), n_(d.pendingQty),
    d.condition || 'good', d.note || '']);
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
