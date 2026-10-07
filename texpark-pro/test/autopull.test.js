/* Auto-pull end to end. Run: node test/autopull.test.js

   Drives the REAL sync.js pullAndMerge() against a fetch shim that speaks the
   real Code.gs protocol, with the real db.js underneath. The claim being tested
   is the one the owner makes: "I typed it on the phone, now the PC shows it" -
   which is only true if push, pull and merge happen in the right order and the
   merge survives a second round trip. */

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

/* The sheet, as Code.gs stores it: one row per device per day. */
function makeFakeSheet() {
  const rows = {};                       // device -> json
  return {
    rows,
    fetch(url) {
      const u = String(url);
      const action = (u.match(/action=([a-z]+)/) || [])[1] || '';
      const dev = decodeURIComponent((u.match(/device=([^&]+)/) || [])[1] || '');
      if (u.indexOf('?action=pullall') >= 0) {
        const jsons = {};
        Object.keys(rows).forEach(k => { if (rows[k]) jsons[k] = rows[k]; });
        return { ok: true, text: async () => JSON.stringify({ success: true, devices: Object.keys(rows).map(k => ({ device: k })), json: JSON.stringify(jsons) }) };
      }
      if (u.indexOf('?action=pull') >= 0) {
        return { ok: true, text: async () => JSON.stringify({ success: true, device: dev, json: rows[dev] || '' }) };
      }
      return { ok: true, text: async () => JSON.stringify({ success: true, message: 'ok' }) };
    },
    /* A device uploading its snapshot. */
    put(device, json) { rows[device] = json; }
  };
}

/* A device running the real db.js + sync.js over the shared fake sheet. */
function makeDevice(name, sheet) {
  const store = {};
  const sandbox = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    console, alert() {}, confirm: () => true,
    document: { getElementById: () => null, addEventListener() {} },
    navigator: { userAgent: name === 'PH' ? 'Android Mobile' : 'Mozilla/5.0' },
    setTimeout, clearTimeout,
    APP_VERSION: 'test',
    fetch: (url, opts) => {
      // A POST is a push: record what the device sent, like doPost would.
      if (opts && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        if (body.type === 'backup') sheet.put(body.data.device, body.data.json);
        return Promise.resolve({ ok: true, text: async () => JSON.stringify({ success: true, message: 'Saved' }) });
      }
      return Promise.resolve(sheet.fetch(url));
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['js/db.js', 'js/sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  sandbox.db = sandbox.blankDB();
  sandbox.db.settings.deviceTag = name;
  sandbox.db.settings.syncUrl = 'https://example.test/exec';
  sandbox.lastCommitted = sandbox.indexRecs_(sandbox.db);
  sandbox.session = { userId: 'u1', username: 'admin' };
  return sandbox;
}

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

/* ------------------------------ the phone writes, the PC has never seen it ------------------------------ */
console.log('\n--- phone memo, PC opens later ---');
const sheet = makeFakeSheet();
const pc = makeDevice('PC', sheet);
const ph = makeDevice('PH', sheet);

addMemo(ph, 'TXP/SM/1-PH001', 'Phone Customer', 3, 250);

/* The phone's sync on login: pushes itself, then pulls and merges. */
(async function () {
  let r = await ph.pullAndMerge();
  ok(sheet.rows.PH, 'the phone pushed its snapshot before pulling');
  /* The phone is the first device to ever sync, so the cloud held only what it had
     just uploaded: a merge of its own snapshot back onto itself, which changes
     nothing. Either answer is correct here - what matters is the next assertion. */
  ok(r.merged === true || r.reason === 'nothing to merge', 'the first sync is harmless');

  r = await pc.pullAndMerge();
  ok(sheet.rows.PC, 'the PC pushed its own (empty) state first');
  ok(r.merged === true, 'the PC pulled and merged');
  eq(pc.db.memos.filter(m => m.memoNo === 'TXP/SM/1-PH001').length, 1, 'the phone memo is now on the PC');
  eq(pc.db.products.length, ph.db.products.length, 'the three starter products did not duplicate into six');
  eq(pc.db.products.filter(p => p.sku === 'K3S').length, 1, 'the same starter product exists once, not twice');

  /* Running it once more must be stable - this happens on every open. */
  r = await pc.pullAndMerge();
  eq(pc.db.memos.filter(m => m.memoNo === 'TXP/SM/1-PH001').length, 1, 'a second open did not duplicate it');

  /* And the phone must not lose its own memo. */
  r = await ph.pullAndMerge();
  ok(ph.db.memos.some(m => m.memoNo === 'TXP/SM/1-PH001'), 'the phone still has the memo it wrote');

  /* ------------------------------ a delete on the PC reaches the phone ------------------------------ */
  console.log('\n--- PC deletes it, the phone must follow ---');
  const doomed = pc.db.memos.find(m => m.memoNo === 'TXP/SM/1-PH001');
  pc.db.memos = pc.db.memos.filter(m => m.id !== doomed.id);
  pc.commit();
  await pc.pullAndMerge();
  await ph.pullAndMerge();
  ok(!ph.db.memos.some(m => m.memoNo === 'TXP/SM/1-PH001'), 'the phone stopped showing the deleted memo');
  ok(!pc.db.memos.some(m => m.memoNo === 'TXP/SM/1-PH001'), 'and it stays gone on the PC');

  /* ------------------------------ no sync URL means no calls ------------------------------ */
  console.log('\n--- a device with no URL does nothing at all ---');
  const lonely = makeDevice('PC2', sheet);
  lonely.db.settings.syncUrl = '';
  let calls = 0;
  const realFetch = lonely.fetch;
  lonely.fetch = () => { calls++; return realFetch.apply(null, arguments); };
  const quiet = await lonely.pullAndMerge();
  eq(quiet.merged, false, 'no merge attempted');
  eq(calls, 0, 'not one network call');

  /* ------------------------------ a dead network must not break the app ------------------------------ */
  console.log('\n--- offline is survivable ---');
  const flaky = makeDevice('PC3', sheet);
  flaky.db.settings.syncUrl = 'https://example.test/exec';
  flaky.fetch = () => Promise.reject(new Error('no internet'));
  let threw = false;
  try { await flaky.pullAndMerge(); } catch (e) { threw = true; }
  ok(threw, 'the pull rejects rather than pretending to sync');
  /* cloudAutoSync is the caller that must swallow it, and it does. */
  flaky.autoSyncBusy = false;
  flaky.db.memos.push({ id: 'x1', memoNo: 'LOCAL', items: [] });
  let crashed = false;
  try { flaky.cloudAutoSync('test'); } catch (e) { crashed = true; }
  ok(!crashed, 'cloudAutoSync swallows an offline pull so the app keeps working');

  /* ------------------------------ a save must reach the sheet by itself ------------------------------ */
  console.log('\n--- a web edit is uploaded without waiting for the tab to close ---');
  const web = makeDevice('PC', sheet);
  web.db.settings.autoPull = false;          // no polling, so the only writer is the save
  let posts = 0;
  const webFetch = web.fetch;
  web.fetch = function (url, opts) {
    if (opts && opts.method === 'POST') posts++;
    return webFetch.apply(null, arguments);
  };
  sheet.rows.PC = '';                        // forget what PC held
  addMemo(web, 'TXP/SM/9-PC001', 'Web Customer', 2, 300);
  /* commit() marks the upload due and schedules it; a browser would cancel a
     request started from beforeunload, so waiting for the tab to close used to
     lose the edit entirely. */
  ok(web.cloudPushTimer, 'a save schedules an upload instead of waiting for the tab to close');
  eq(web.window.cloudDirty, true, 'and it is remembered as unsent');
  web.flushCloudPush();
  await new Promise(r => setTimeout(r, 50));
  eq(web.cloudDirty, false, 'the flush clears the unsent mark so it is not sent twice');
  ok(posts >= 1, 'the flush pushed to the sheet');
  ok(/TXP\/SM\/9-PC001/.test(sheet.rows.PC || ''), 'the sheet now holds the memo made on the web app');

  /* ------------------------------ device tags are unique per install ------------------------------ */
  console.log('\n--- two machines cannot claim one sheet row ---');
  const a = makeDevice('', sheet), b = makeDevice('', sheet);
  ok(a.deviceTag() !== b.deviceTag(),
    'two installs get different tags, so neither overwrites the other: ' + a.deviceTag() + ' vs ' + b.deviceTag());
  eq(a.deviceTag(), a.deviceTag(), 'a tag is minted once and kept, so memo numbers stay stable');

  /* ------------------------------ a large db converges too ------------------------------ */
  console.log('\n--- two devices converge with a large db ---');
  /* The sheet stores chunks now, so the client must not care how big the snapshot
     is. This is the case that used to fail forever: the owner's db grew past one
     cell and no backup ever landed, so the phone and the PC stopped seeing each
     other's work. */
  const bigSheet = makeFakeSheet();
  const bigA = makeDevice('PC', bigSheet);
  const bigB = makeDevice('PH', bigSheet);
  // Pad both databases well past one sheet cell.
  bigA.db.customers.push({ id: 'padA', name: 'Pad', note: 'q'.repeat(120000) });
  bigB.db.customers.push({ id: 'padB', name: 'Pad', note: 'r'.repeat(120000) });
  addMemo(bigA, 'TXP/SM/BIG-PC001', 'Big A', 4, 500);
  addMemo(bigB, 'TXP/SM/BIG-PH001', 'Big B', 2, 700);

  await bigA.pullAndMerge();
  ok((bigSheet.rows.PC || '').length > 50000, 'the big snapshot actually exceeded one cell (' +
    Math.round((bigSheet.rows.PC || '').length / 1024) + ' KB)');
  await bigB.pullAndMerge();
  await bigA.pullAndMerge();
  ok(bigA.db.memos.some(m => m.memoNo === 'TXP/SM/BIG-PH001'), 'the PC sees the phone memo in a large db');
  ok(bigB.db.memos.some(m => m.memoNo === 'TXP/SM/BIG-PC001'), 'the phone sees the PC memo in a large db');
  ok(bigA.db.customers.some(c => c.id === 'padB'), 'the PC kept the phone\'s other data too');

  /* ------------------------------ superseded backups do not pile up ------------------------------ */
  console.log('\n--- a newer backup replaces the older one in the queue ---');
  const q = makeDevice('PC', bigSheet);
  q.db.settings.autoPull = false;
  q.db.settings.syncUrl = 'https://example.test/exec';
  // Three backups queued before any can be sent (offline), then a fourth.
  q.fetch = () => Promise.reject(new Error('offline'));
  q.syncQueue = [];
  q.syncPush('backup', { device: 'PC', date: '2026-10-09', json: '{"n":1}' }, 'Cloud backup (PC)');
  q.syncPush('backup', { device: 'PC', date: '2026-10-09', json: '{"n":2}' }, 'Cloud backup (PC)');
  q.syncPush('memo', { memoNo: 'KEEP-ME' }, 'Memo KEEP-ME');
  q.syncPush('backup', { device: 'PC', date: '2026-10-09', json: '{"n":3}' }, 'Cloud backup (PC)');
  const backupJobs = q.syncQueue.filter(j => j.type === 'backup');
  eq(backupJobs.length, 1, 'only the newest backup job per device is kept');
  eq(JSON.parse(backupJobs[0].data.json).n, 3, 'and it is the latest payload, not an older one');
  eq(q.syncQueue.filter(j => j.type === 'memo').length, 1, 'a real data job (a memo) is never coalesced away');

  /* A failed-as-too-large backup is retried once the chunking fix is in. */
  console.log('\n--- a backup parked as "too large" is requeued ---');
  const rq = makeDevice('PC', bigSheet);
  rq.syncQueue = [
    { id: 'b1', type: 'backup', data: { device: 'PC' }, state: 'failed', tries: 9, error: 'Backup too large for one sheet cell (52 KB)', reTried: false },
    { id: 'm1', type: 'memo', data: { memoNo: 'X' }, state: 'failed', tries: 9, error: 'some other failure', reTried: false }
  ];
  rq.syncSave();
  rq.syncLoad();
  eq(rq.syncQueue.find(j => j.id === 'b1').state, 'pending', 'the oversize backup is pending again');
  eq(rq.syncQueue.find(j => j.id === 'b1').tries, 0, 'with its retry count reset');
  eq(rq.syncQueue.find(j => j.id === 'm1').state, 'failed', 'a memo that failed for another reason is left alone');

  console.log('\n=================');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  console.log('=================');
  process.exit(fail ? 1 : 0);
})();
