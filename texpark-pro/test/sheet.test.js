/* Exercises the real Code.gs against a fake SpreadsheetApp, so the backup/pull
   round trip and the per-device upsert are proven rather than assumed. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } }

/* Minimal in-memory sheet. It now enforces a FINITE grid - a fixed number of rows
   and columns - and throws the exact errors Google Sheets does when a range reaches
   outside it, so Code.gs cannot pass these tests by writing past the grid. This is
   the whole point: the chunked backup used to do exactly that and fail on every
   upload with "Those rows are out of bounds." */
function makeSheet(name, width, maxRows, maxCols) {
  const rows = [[]];
  let nRows = maxRows || 1000, nCols = maxCols || 26;
  const cols = Math.max(width || 0, nCols);
  const pad = (r) => { while (r.length < cols) r.push(''); return r; };
  const cellEmpty = (v) => v === undefined || v === null || v === '';
  const lastRow = () => {
    for (let i = Math.max(rows.length - 1, 0); i >= 0; i--) {
      const r = rows[i] || [];
      for (let j = 0; j < r.length; j++) if (!cellEmpty(r[j])) return i + 1;
    }
    return 0;
  };
  const assertRows = (row, nr) => {
    if (!(row >= 1) || nr < 0 || row + nr - 1 > nRows) throw new Error('Those rows are out of bounds.');
  };
  const assertCols = (col, nc) => {
    if (!(col >= 1) || nc < 0 || col + nc - 1 > nCols) throw new Error('Those columns are out of bounds.');
  };
  const range = (row, col, nr, nc) => {
    if (nr === undefined) { nr = row; row = col; col = 1; }   // getRange(a1) is not used, but keep it honest
    nr = nr || 1; nc = nc || 1;
    assertRows(row, nr); assertCols(col, nc);
    return {
      getValues: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const src = rows[row - 1 + i] || [];
          const line = [];
          for (let j = 0; j < nc; j++) line.push(src[col - 1 + j] !== undefined ? src[col - 1 + j] : '');
          out.push(line);
        }
        return out;
      },
      setValues: (vals) => {
        vals.forEach((line, i) => {
          const idx = row - 1 + i;
          if (!rows[idx]) rows[idx] = [];
          line.forEach((v, j) => { rows[idx][col - 1 + j] = v; });
          pad(rows[idx]);
        });
      },
      clearContent: () => {
        for (let i = 0; i < nr; i++) {
          const idx = row - 1 + i;
          if (!rows[idx]) rows[idx] = [];
          for (let j = 0; j < nc; j++) rows[idx][col - 1 + j] = '';
          pad(rows[idx]);
        }
      },
      setFontWeight: () => {}
    };
  };
  return {
    _rows: rows,
    getName: () => name,
    getMaxRows: () => nRows,
    getMaxColumns: () => nCols,
    getLastRow: lastRow,
    getDataRange: () => range(1, 1, Math.max(lastRow(), 1), cols),
    getRange: range,
    insertRowsAfter: (afterRow, howMany) => { nRows += howMany; },
    insertColumnsAfter: (afterCol, howMany) => { nCols += howMany; },
    appendRow: (r) => {
      // Like Sheets: appendRow writes just below the last row of data and does NOT
      // grow the sheet, so on a full grid it throws instead of adding the row.
      if (!(lastRow() < nRows)) throw new Error('Those rows are out of bounds.');
      const idx = lastRow();
      rows[idx] = pad(r.slice());
    },
    deleteRow: (n) => {
      assertRows(n, 1);
      rows.splice(n - 1, 1);
    },
    deleteRows: (start, howMany) => {
      assertRows(start, howMany);
      rows.splice(start - 1, howMany);
    },
    setFrozenRows: () => {}
  };
}

function makeSpreadsheet() {
  const sheets = {};
  return {
    _sheets: sheets,
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { const s = makeSheet(n, 26, 1000, 26); sheets[n] = s; return s; }
  };
}

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

/* Load Code.gs into a fresh sandbox bound to `SS`, so a test can give it a
   spreadsheet with an unusually small grid and prove it copes. */
function buildApi(SS) {
  const sandbox = {
    console,
    Date,
    isFinite,
    JSON,
    Number,
    String,
    Object,
    Array,
    Math,
    Error,
    SpreadsheetApp: { openById: () => SS },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } })
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return {
    SS,
    post: (type, data) => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify({ type, data }) } }).getContent()),
    get: (params) => JSON.parse(sandbox.doGet({ parameter: params || {} }).getContent()),
    save: (d) => sandbox.saveBackup_(SS, d)
  };
}

const api = buildApi(makeSpreadsheet());
const SS = api.SS;
const post = api.post;
const get = api.get;
/* Raw rows of a sheet, for asserting the stored shape rather than the API's view. */
const rowsIn = (spreadsheet, name) => (spreadsheet._sheets[name]._rows || []).slice(1).filter(r => r && r.length);

console.log('\n--- the sheet answers a health check ---');
const health = get({});
ok(health.success === true, 'doGet succeeds');
ok(health.version === 4, 'it reports the chunked-backup version');

console.log('\n--- a device backs itself up, then reads it back ---');
const pcDb = { products: [{ id: 'p1', name: 'Kids 3pcs Set' }], memos: [{ memoNo: 'TXP/SM/2026/09/22-PC001' }], customers: [] };
const saved = post('backup', { device: 'PC', date: '2026-09-22', version: '2026-09-22.5', json: JSON.stringify(pcDb) });
ok(saved.success === true, 'the backup write is acknowledged');
ok(/PC/.test(saved.message), 'the reply names the device');

const pulled = get({ action: 'pull', device: 'PC' });
ok(pulled.success === true, 'pull succeeds');
ok(!!pulled.json, 'a payload comes back');
const restored = JSON.parse(pulled.json);
ok(restored.memos.length === 1 && restored.memos[0].memoNo === 'TXP/SM/2026/09/22-PC001', 'the memo survives the round trip');
ok(restored.products.length === 1, 'products survive too');

console.log('\n--- the same device re-backs-up, replacing its previous rows ---');
const pcDb2 = { products: [{ id: 'p1' }], memos: [{ memoNo: 'TXP/SM/2026/09/22-PC001' }, { memoNo: 'TXP/SM/2026/09/22-PC002' }], customers: [] };
post('backup', { device: 'PC', date: '2026-09-22', version: '2026-09-22.5', json: JSON.stringify(pcDb2) });
const rows = SS._sheets['Backup']._rows.filter(r => r && String(r[1]) === 'PC');
ok(rows.length === 1, 'still exactly one row for that device (a small snapshot is one chunk)');
const pulled2 = JSON.parse(get({ action: 'pull', device: 'PC' }).json);
ok(pulled2.memos.length === 2, 'the pull sees the newer, larger snapshot');

console.log('\n--- the phone backs up separately and both are listed ---');
post('backup', { device: 'PH', date: '2026-09-22', version: '2026-09-22.5', json: JSON.stringify({ products: [], memos: [{ memoNo: 'TXP/SM/2026/09/22-PH001' }], customers: [] }) });
const list = get({ action: 'pull' });
ok(list.success === true, 'listing all devices succeeds');
ok(list.devices.length === 2, 'both PC and phone appear (' + list.devices.map(d => d.device).join(',') + ')');
const ph = JSON.parse(get({ action: 'pull', device: 'PH' }).json);
ok(ph.memos[0].memoNo.indexOf('-PH001') > 0, 'the phone gets its own memo back');
const pcm = JSON.parse(get({ action: 'pull', device: 'PC' }).json).memos.map(m => m.memoNo).join(',');
ok(pcm.indexOf('-PH001') < 0, 'the PC never receives the phone memo');

console.log('\n--- an unknown device gets a clear empty answer ---');
const none = get({ action: 'pull', device: 'LAPTOP-X' });
ok(none.success === true && !none.json, 'no snapshot means no payload, not an error');

console.log('\n--- pullall hands back every device in one reply ---');
const all = get({ action: 'pullall' });
ok(all.success === true, 'pullall succeeds');
ok(!!all.json, 'it returns a payload, not an empty string');
const byDevice = JSON.parse(all.json);
ok(typeof byDevice === 'object' && byDevice !== null, 'the payload is keyed by device');
ok(!!byDevice.PC && !!byDevice.PH, 'both devices are present (' + Object.keys(byDevice).join(',') + ')');
ok(JSON.parse(byDevice.PC).memos.length === 2, 'the PC snapshot is the full one');
ok(JSON.parse(byDevice.PH).memos[0].memoNo.indexOf('-PH001') > 0, 'the phone snapshot is its own');
/* The merge on the client needs both, so one call must carry both - a call that
   quietly returned only the newest device would leave the other machine's work
   permanently invisible on a fresh install. */
ok(Object.keys(byDevice).length === all.devices.length, 'every listed device carries its snapshot');
ok(all.devices.length === 2, 'and the device list still describes them');

console.log('\n--- a bad payload is refused instead of wiping a backup ---');
let threw = false;
try { sandbox.saveBackup_(SS, { device: 'PC', date: '2026-09-22', json: '' }); } catch (e) { threw = true; }
ok(threw, 'an empty backup is rejected');
const stillThere = JSON.parse(get({ action: 'pull', device: 'PC' }).json);
ok(stillThere.memos.length === 2, 'the earlier good backup is untouched');

console.log('\n--- a snapshot far bigger than one cell round-trips byte-identically ---');
/* 52 KB of JSON (the size that used to be refused outright), then 240 KB, each
   with non-ASCII and a confusing tail so a lost chunk cannot pass by luck. */
const big = JSON.stringify({
  products: [{ id: 'p1', name: '\u0989\u09AA\u09B9\u09BE\u09B0 Kids 3pcs Set', note: 'x'.repeat(60000) }],
  memos: [{ memoNo: 'TXP/SM/2026/10/07-PC001', tail: 'THE-END-OF-THE-BIG-PAYLOAD' }],
  customers: []
});
ok(big.length > 52000, 'the payload is bigger than one cell (' + Math.round(big.length / 1024) + ' KB)');
const bigSaved = post('backup', { device: 'PC', date: '2026-10-07', version: '2027-01-01.11', json: big });
ok(bigSaved.success === true, 'an oversize backup is now accepted');
ok(/chunk/.test(bigSaved.message), 'the reply says it was chunked: ' + bigSaved.message);
const bigRows = SS._sheets['Backup']._rows.filter(r => r && String(r[1]) === 'PC');
ok(bigRows.length > 1, 'it is stored across several rows (' + bigRows.length + ')');
ok(bigRows.every(r => String(r[4] || '').length <= 40000), 'no single cell exceeds the 40,000-char chunk size');
const bigBack = get({ action: 'pull', device: 'PC' });
ok(bigBack.json === big, 'the pull reassembles it byte-identically');
ok(JSON.parse(bigBack.json).memos[0].tail === 'THE-END-OF-THE-BIG-PAYLOAD', 'the tail of the payload survived');

console.log('\n--- a multi-megabyte snapshot also round-trips ---');
const huge = JSON.stringify({ blob: 'A\u00E9\u0989'.repeat(700000), end: 'HUGE-END' });
ok(huge.length > 2000000, 'the payload is over 2 MB (' + Math.round(huge.length / 1048576) + ' MB)');
post('backup', { device: 'PC', date: '2026-10-08', version: '2027-01-01.11', json: huge });
const hugeBack = get({ action: 'pull', device: 'PC' });
ok(hugeBack.json === huge, 'a several-MB snapshot survives chunking in both directions');

console.log('\n--- a smaller backup over a bigger one leaves no stale chunks ---');
const small = JSON.stringify({ products: [], memos: [{ memoNo: 'TXP/SM/2026/10/09-PC001' }], customers: [] });
post('backup', { device: 'PC', date: '2026-10-09', version: '2027-01-01.11', json: small });
const afterSmall = SS._sheets['Backup']._rows.filter(r => r && String(r[1]) === 'PC');
ok(afterSmall.length === 1, 'only the new, single-chunk backup remains (' + afterSmall.length + ' row)');
const smallBack = get({ action: 'pull', device: 'PC' });
ok(smallBack.json === small, 'and the pull returns exactly the small payload, with no tail of the old one');

console.log('\n--- the old single-cell format already in the sheet is still read ---');
/* Write a legacy row by hand: whole JSON in column 5, no chunk columns - exactly
   what the previous Code.gs left behind. */
const legacyJson = JSON.stringify({ products: [{ id: 'old' }], memos: [{ memoNo: 'LEGACY-1' }], customers: [] });
SS._sheets['Backup']._rows.push([new Date(), 'OLD', '2026-09-01', '2026-09-01.1', legacyJson, '', '', '', '']);
const legacyBack = get({ action: 'pull', device: 'OLD' });
ok(legacyBack.success === true && legacyBack.json === legacyJson, 'a legacy single-cell backup is pulled unchanged');
const legacyAll = JSON.parse(get({ action: 'pullall' }).json);
ok(legacyAll.OLD === legacyJson, 'and pullall carries it alongside the chunked devices');

console.log('\n--- a corrupted / missing chunk is reported, not half-restored ---');
/* Append a second device so we can prove a broken one does not hide a good one. */
post('backup', { device: 'GOOD', date: '2026-10-09', version: '2027-01-01.11', json: small });
const brokenChars = 'z'.repeat(90000);
post('backup', { device: 'BROKEN', date: '2026-10-09', version: '2027-01-01.11', json: brokenChars });
const brokenRows = SS._sheets['Backup']._rows.filter(r => r && String(r[1]) === 'BROKEN');
ok(brokenRows.length >= 3, 'the broken device has several chunks to damage');
// Delete the middle chunk, as a partial write or a manual sheet edit would.
const victim = brokenRows[Math.floor(brokenRows.length / 2)];
const vIdx = SS._sheets['Backup']._rows.indexOf(victim);
SS._sheets['Backup']._rows.splice(vIdx, 1);
const brokenPull = get({ action: 'pull', device: 'BROKEN' });
ok(brokenPull.success === false, 'a missing chunk makes the pull fail, not return a half-backup');
ok(/incomplete|missing/i.test(brokenPull.message), 'and it says a chunk is missing: ' + brokenPull.message);
ok(!brokenPull.json, 'no truncated payload is handed to a restore');

/* A wrong checksum (a chunk silently overwritten) must fail the same way. */
post('backup', { device: 'BROKEN2', date: '2026-10-09', version: '2027-01-01.11', json: brokenChars });
const b2 = SS._sheets['Backup']._rows.filter(r => r && String(r[1]) === 'BROKEN2');
const lastChunk = b2[b2.length - 1];
lastChunk[4] = String(lastChunk[4]).replace(/z$/, 'y');
const corruptPull = get({ action: 'pull', device: 'BROKEN2' });
ok(corruptPull.success === false && /corrupt|checksum/i.test(corruptPull.message),
  'a corrupted chunk is caught by the checksum: ' + corruptPull.message);

console.log('\n--- one broken device does not hide the others in pullall ---');
const mixed = get({ action: 'pullall' });
ok(mixed.success === true, 'pullall still succeeds');
const mixedJson = JSON.parse(mixed.json);
ok(!!mixedJson.GOOD, 'the healthy device is still delivered');
ok(!mixedJson.BROKEN, 'the broken device is withheld rather than truncated');
ok(!!mixed.errors && /BROKEN/.test(Object.keys(mixed.errors).join(',')),
  'and the broken device is named in an errors map: ' + JSON.stringify(mixed.errors));
const goodPull = get({ action: 'pull', device: 'GOOD' });
ok(goodPull.success === true && goodPull.json === small, 'the healthy device was never affected');

console.log('\n--- a backup on a fresh, empty sheet works ---');
/* A brand-new spreadsheet: one blank row, nothing written. The old saveBackup_ got
   "Those rows are out of bounds." here the moment a snapshot needed more than one
   row, because it appended past a grid that had never been grown. */
(() => {
  const a = buildApi(makeSpreadsheet());          // fresh: no sheets yet
  const small = JSON.stringify({ products: [], memos: [{ memoNo: 'FRESH-1' }], customers: [] });
  const r = a.post('backup', { device: 'PC', date: '2026-10-10', version: '2027-01-01.10', json: small });
  ok(r.success === true, 'the very first backup on a fresh sheet is accepted');
  const back = a.get({ action: 'pull', device: 'PC' });
  ok(back.json === small, 'and reads back byte-identically');
})();

console.log('\n--- a backup bigger than the grid forces rows to be added ---');
(() => {
  // A normal 26-column tab trimmed to 5 rows (header takes one). That is far too few
  // for a big snapshot's chunks unless the grid is grown first, and it is exactly the
  // shape that made Google answer "Those rows are out of bounds." on every upload.
  const sSS = makeSpreadsheet();
  sSS.insertSheet = (n) => { const s = makeSheet(n, 26, 5, 26); sSS._sheets[n] = s; return s; };
  const a = buildApi(sSS);
  const big = JSON.stringify({ blob: 'Q'.repeat(300000), tail: 'GRID-GROWN-END' });
  const chunks = Math.ceil(big.length / 40000);
  ok(chunks > 5, 'the snapshot needs more chunks than the grid has rows (' + chunks + ' > 5)');
  const r = a.post('backup', { device: 'PC', date: '2026-10-10', version: '2027-01-01.10', json: big });
  ok(r.success === true, 'the backup succeeds instead of failing out of bounds: ' + r.message);
  const sheet = sSS._sheets['Backup'];
  ok(sheet.getMaxRows() >= 1 + chunks, 'the sheet grew to hold every chunk (' + sheet.getMaxRows() + ' rows)');
  const back = a.get({ action: 'pull', device: 'PC' });
  ok(back.json === big, 'and the grown sheet reassembles the payload byte-identically');
})();

console.log('\n--- a second, smaller backup upserts with no stale rows ---');
(() => {
  const a = buildApi(makeSpreadsheet());
  // >2 MB, i.e. more than 40 chunks, so the payload cannot hide in one cell even
  // if the writer ignored CHUNK_CHARS entirely.
  const first = JSON.stringify({ blob: 'W'.repeat(2100000), tail: 'FIRST' });
  const second = JSON.stringify({ memos: [{ memoNo: 'SECOND' }] });
  a.post('backup', { device: 'PC', date: '2026-10-10', version: '2027-01-01.10', json: first });
  const many = rowsIn(a.SS, 'Backup').filter(r => String(r[1]) === 'PC').length;
  ok(many > 1, 'the first backup is stored across several rows (' + many + ')');
  a.post('backup', { device: 'PC', date: '2026-10-11', version: '2027-01-01.10', json: second });
  const after = rowsIn(a.SS, 'Backup').filter(r => String(r[1]) === 'PC');
  ok(after.length === 1, 'the smaller backup leaves exactly one row for the device (' + after.length + ')');
  ok(a.get({ action: 'pull', device: 'PC' }).json === second, 'and no tail of the old, larger payload survives');
})();

console.log('\n--- many devices and dates coexist, then each is read back ---');
(() => {
  const a = buildApi(makeSpreadsheet());
  const devices = ['PC', 'PH', 'LAPTOP'];
  const expected = {};
  devices.forEach((dev, k) => {
    expected[dev] = JSON.stringify({ device: dev, memos: [{ memoNo: dev + '-' + k }], blob: dev.repeat(1) + 'x'.repeat(k * 60000) });
    // Two writes per device: an earlier one, then the newer one that must win.
    a.post('backup', { device: dev, date: '2026-10-0' + (k + 1), version: '2027-01-01.10', json: JSON.stringify({ device: dev, old: true }) });
    a.post('backup', { device: dev, date: '2026-10-1' + k, version: '2027-01-01.10', json: expected[dev] });
  });
  const all = JSON.parse(a.get({ action: 'pullall' }).json);
  devices.forEach(dev => ok(all[dev] === expected[dev], dev + ' reads back its newest snapshot'));
  ok(a.get({ action: 'pull' }).devices.length === 3, 'all three devices are listed');
})();

console.log('\n--- a legacy single-cell backup in a grown sheet still reads back ---');
(() => {
  const a = buildApi(makeSpreadsheet());
  const legacy = JSON.stringify({ products: [{ id: 'old' }], memos: [{ memoNo: 'LEGACY-BOUNDS' }], customers: [] });
  // Write it the way the previous Code.gs did: whole JSON in one cell, no chunk cols.
  a.post('test', {});   // a harmless write, so every tab (Backup included) exists
  const bkB = a.SS._sheets['Backup'];
  bkB._rows[bkB.getLastRow()] = [new Date(), 'OLD', '2026-09-01', '2026-09-01.1', legacy, '', '', '', ''];
  ok(a.get({ action: 'pull', device: 'OLD' }).json === legacy, 'a legacy row is returned unchanged');
  // And a chunked backup alongside it must not disturb it or be disturbed.
  const fresh = JSON.stringify({ memos: [{ memoNo: 'NEW' }] });
  a.post('backup', { device: 'PC', date: '2026-10-10', version: '2027-01-01.10', json: fresh });
  ok(a.get({ action: 'pull', device: 'OLD' }).json === legacy, 'the legacy row still reads back after a chunked write');
  ok(a.get({ action: 'pull', device: 'PC' }).json === fresh, 'and the chunked device is unaffected');
})();

console.log('\n--- a payment re-send upserts instead of duplicating a row ---');
(() => {
  const a = buildApi(makeSpreadsheet());
  a.post('test', {});   // create every tab, Payments included
  const payRows = () => rowsIn(a.SS, 'Payments').filter(r => r && r.length);
  a.post('payment', { paymentId: 'pay-1', date: '2026-10-01', customerName: 'Karim', amount: 600, method: 'Cash', memoNumber: 'TXP/SM/1' });
  ok(payRows().length === 1, 'the first receipt writes one row');
  ok(String(payRows()[0][6]) === 'pay-1', 'the Payment ID is stored in its own column (' + String(payRows()[0][6]) + ')');
  ok(String(payRows()[0][7]) === 'TXP/SM/1', 'the memo number is stored too');
  // The same payment re-sent (a retry, or a sync replay) must update, not pile up.
  a.post('payment', { paymentId: 'pay-1', date: '2026-10-01', customerName: 'Karim', amount: 600, method: 'bKash', memoNumber: 'TXP/SM/1' });
  ok(payRows().length === 1, 'a re-sent receipt does not create a second row');
  ok(String(payRows()[0][4]) === 'bKash', 'and the row is updated in place');
  // A different receipt still appends.
  a.post('payment', { paymentId: 'pay-2', date: '2026-10-02', customerName: 'Rahim', amount: 300, method: 'Cash' });
  ok(payRows().length === 2, 'a different receipt appends normally');
  // The old client sends no id: it must still write, exactly as before.
  a.post('payment', { date: '2026-10-03', customerName: 'Legacy', amount: 100, method: 'Cheque' });
  ok(payRows().length === 3, 'a receipt with no id still writes (old client)');
})();

console.log('\n--- a payment on a narrow Payments tab grows the columns first ---');
(() => {
  // A Payments tab the owner has had since before the two new columns existed:
  // six columns wide, so writing Payment ID/Memo No would run off the grid.
  const sSS = makeSpreadsheet();
  sSS.insertSheet = (n) => {
    const s = n === 'Payments' ? makeSheet(n, 6, 1000, 6) : makeSheet(n, 26, 1000, 26);
    sSS._sheets[n] = s; return s;
  };
  const a = buildApi(sSS);
  a.post('test', {});
  const r = a.post('payment', { paymentId: 'pay-wide', date: '2026-10-04', customerName: 'Karim', amount: 250, method: 'Cash' });
  ok(r.success === true, 'the payment succeeds instead of failing out of bounds: ' + r.message);
  ok(a.SS._sheets['Payments'].getMaxColumns() >= 8, 'the tab was widened to the full header width');
  const row = rowsIn(a.SS, 'Payments').filter(x => String(x[6]) === 'pay-wide')[0];
  ok(!!row && String(row[7]) === '', 'the receipt is stored whole, with its id in the id column');
})();

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
console.log('=================');
process.exit(fail ? 1 : 0);
