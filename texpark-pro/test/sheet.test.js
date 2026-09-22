/* Exercises the real Code.gs against a fake SpreadsheetApp, so the backup/pull
   round trip and the per-device upsert are proven rather than assumed. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } }

/* Minimal in-memory sheet: a grid of rows, enough of the API surface that
   Code.gs uses (getDataRange, getRange, setValues, appendRow, getSheetByName). */
function makeSheet(name, width) {
  const rows = [[]];
  const pad = (r) => { while (r.length < width) r.push(''); return r; };
  const range = (row, col, nr, nc) => ({
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
    setFontWeight: () => {}
  });
  return {
    _rows: rows,
    getDataRange: () => range(1, 1, rows.length, width),
    getRange: range,
    appendRow: (r) => { rows.push(pad(r.slice())); },
    setFrozenRows: () => {}
  };
}

function makeSpreadsheet() {
  const sheets = {};
  return {
    _sheets: sheets,
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { const s = makeSheet(n, 40); sheets[n] = s; return s; }
  };
}

const SS = makeSpreadsheet();
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
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox);

const post = (type, data) => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify({ type, data }) } }).getContent());
const get = (params) => JSON.parse(sandbox.doGet({ parameter: params || {} }).getContent());

console.log('\n--- the sheet answers a health check ---');
const health = get({});
ok(health.success === true, 'doGet succeeds');
ok(health.version === 3, 'it reports the backup-capable version');

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

console.log('\n--- the same device re-backs-up the same day, replacing its row ---');
const before = SS._sheets['Backup']._rows.filter(r => r && r[0]).length;
const pcDb2 = { products: [{ id: 'p1' }], memos: [{ memoNo: 'TXP/SM/2026/09/22-PC001' }, { memoNo: 'TXP/SM/2026/09/22-PC002' }], customers: [] };
post('backup', { device: 'PC', date: '2026-09-22', version: '2026-09-22.5', json: JSON.stringify(pcDb2) });
const rows = SS._sheets['Backup']._rows.filter(r => r && String(r[1]) === 'PC');
ok(rows.length === 1, 'still exactly one row for that device and day');
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

console.log('\n--- a bad payload is refused instead of wiping a backup ---');
let threw = false;
try { sandbox.saveBackup_(SS, { device: 'PC', date: '2026-09-22', json: '' }); } catch (e) { threw = true; }
ok(threw, 'an empty backup is rejected');
const stillThere = JSON.parse(get({ action: 'pull', device: 'PC' }).json);
ok(stillThere.memos.length === 2, 'the earlier good backup is untouched');

console.log('\n--- a database too big for one cell is refused, not truncated ---');
let tooBig = '';
try { sandbox.saveBackup_(SS, { device: 'PC', date: '2026-09-22', json: 'x'.repeat(50000) }); }
catch (e) { tooBig = e.message; }
ok(/too large/.test(tooBig), 'the oversize error explains itself');
ok(tooBig.indexOf('KB') > 0, 'it tells the operator how big the data is');
const unchanged = JSON.parse(get({ action: 'pull', device: 'PC' }).json);
ok(unchanged.memos.length === 2, 'the good backup is still intact after the refusal');

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
console.log('=================');
process.exit(fail ? 1 : 0);
