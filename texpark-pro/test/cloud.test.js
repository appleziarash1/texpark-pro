/* Phase 3 end to end: the REAL js/cloud.js against an in-memory fake of the two
   services it talks to - Firebase Auth (identitytoolkit) and Firestore REST - with
   the real db.js and sync.js underneath.

   Run: node test/cloud.test.js

   What is being proven, in the owner's terms:
     - two devices signed into the same account see each other's work;
     - only what CHANGED moves, so the free plan stays free (delta reads/writes);
     - when the cloud is down or over quota the app degrades to the Sheet and the
       work is not lost, then recovers by itself;
     - a delete travels and cannot be resurrected by a stale copy;
     - receipts (payments) sync like any other record;
     - a device with no Firebase keys is untouched. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}
function eq(a, b, label) { ok(a === b, label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* ------------------------------------------------------------------ fakes */

/* A whole Firestore project, minus the JSON typing: shops{uid}{docName} records. It
   speaks just enough of the REST shapes cloud.js uses. `quotaFor`/`offline` let a
   test make it fail the way the real service does. */
function makeFirestore() {
  const shops = {};               // uid -> { docName: {key,id,at,deleted,data} }
  const state = { offline: false, quota: false, reads: 0, writes: 0, queries: 0 };

  function fsJson(status, code, msg) {
    return { ok: false, status: status, json: async () => ({ error: { status: code, message: msg } }) };
  }
  function fsOk(body) {
    return { ok: true, status: 200, json: async () => (body || {}), text: async () => JSON.stringify(body || {}) };
  }
  function uidFrom(url) {
    const m = url.match(/\/documents\/shops\/([^/]+)\//);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function docFrom(url) {
    const m = url.match(/\/documents\/shops\/[^/]+\/records\/([^?]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function handle(url, opts) {
    if (state.offline) throw new TypeError('Failed to fetch');
    if (state.quota) return fsJson(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.');

    // Firestore: one document upsert.
    if (/firestore.googleapis.com/.test(url) && opts && opts.method === 'PATCH') {
      const uid = uidFrom(url), name = docFrom(url);
      const fields = JSON.parse(opts.body).fields;
      const rec = {
        key: fields.key.stringValue, id: fields.id.stringValue, at: fields.at.stringValue,
        deleted: !!fields.deleted.booleanValue, data: fields.data
      };
      (shops[uid] = shops[uid] || {})[name] = rec;
      state.writes++;
      return fsOk({ name: name });
    }

    // Firestore: batch commit.
    if (/firestore.googleapis.com/.test(url) && /:commit/.test(url)) {
      const body = JSON.parse(opts.body);
      const uid = (body.writes[0].update.name.match(/\/shops\/([^/]+)\//) || [])[1];
      body.writes.forEach(w => {
        const name = w.update.name.split('/records/')[1];
        const fields = w.update.fields;
        (shops[uid] = shops[uid] || {})[decodeURIComponent(name)] = {
          key: fields.key.stringValue, id: fields.id.stringValue, at: fields.at.stringValue,
          deleted: !!fields.deleted.booleanValue, data: fields.data
        };
        state.writes++;
      });
      return fsOk({});
    }

    // Firestore: delta query. Reimplements the where at > cursor + orderBy at that
    // cloud.js asks for, so the test is exercising the documented query, not a stand-in.
    if (/firestore.googleapis.com/.test(url) && /:runQuery/.test(url)) {
      const uid = uidFrom(url);
      const sq = JSON.parse(opts.body).structuredQuery;
      let cursor = '';
      const wf = sq.where && sq.where.fieldFilter;
      if (wf && wf.value && wf.value.stringValue) cursor = wf.value.stringValue;
      state.queries++;
      const all = Object.keys(shops[uid] || {}).map(k => shops[uid][k])
        .filter(r => !cursor || String(r.at) > String(cursor))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
      state.reads += all.length;
      const out = all.map(r => ({ document: { fields: {
        key: { stringValue: r.key }, id: { stringValue: r.id }, at: { stringValue: r.at },
        deleted: { booleanValue: r.deleted }, data: r.data
      } } }));
      return fsOk(out);
    }
    return fsOk({});
  }
  return { shops, state, handle };
}

function makeAuth() {
  const users = {};              // email -> {password, uid}
  let nextUid = 1;
  return {
    users,
    handle(url, opts) {
      const body = JSON.parse(opts.body);
      if (/accounts:signUp/.test(url)) {
        if (users[body.email]) return { ok: false, status: 400, json: async () => ({ error: { message: 'EMAIL_EXISTS' } }) };
        const uid = 'uid-' + (nextUid++);
        users[body.email] = { password: body.password, uid: uid };
        return { ok: true, status: 200, json: async () => ({ idToken: 'tok-' + uid, refreshToken: 'ref-' + uid, localId: uid, email: body.email, expiresIn: '3600' }) };
      }
      if (/accounts:signInWithPassword/.test(url)) {
        const u = users[body.email];
        if (!u || u.password !== body.password) return { ok: false, status: 400, json: async () => ({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }) };
        return { ok: true, status: 200, json: async () => ({ idToken: 'tok-' + u.uid, refreshToken: 'ref-' + u.uid, localId: u.uid, email: body.email, expiresIn: '3600' }) };
      }
      if (/securetoken/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ id_token: 'tok-fresh', refresh_token: body.refresh_token, user_id: body.refresh_token.replace('ref-', ''), expires_in: '3600' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  };
}

/* The Sheets endpoint, as Code.gs would answer it: remembers records pushed the
   fallback way and hands them back by `since`. */
function makeSheet() {
  const rows = {};               // key__id -> {key,id,at,deleted,json}
  return {
    rows,
    handle(url, opts) {
      const u = String(url);
      if (opts && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        if (body.type === 'record') {
          const d = body.data;
          rows[d.key + '__' + d.id] = { key: d.key, id: d.id, at: d.at, deleted: !!d.deleted, json: d.json };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, message: 'Saved' }) };
      }
      if (u.indexOf('action=records') >= 0) {
        const since = (u.match(/since=([^&]+)/) || [])[1] || '';
        const list = Object.keys(rows).map(k => rows[k]).filter(r => !since || String(r.at) > decodeURIComponent(since));
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, records: list }) };
      }
      if (u.indexOf('action=pullall') >= 0) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, devices: [], json: '{}' }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, message: 'ok' }) };
    }
  };
}

/* A device: real db.js + sync.js + cloud.js over the shared fakes. */
function makeDevice(name, firestore, auth, sheet) {
  const store = {};
  const timers = [];
  const sandbox = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    console, alert() {}, confirm: () => true,
    document: { getElementById: () => null, addEventListener() {} },
    navigator: { userAgent: name === 'PH' ? 'Android Mobile' : 'Mozilla/5.0' },
    // Fire-and-forget timers are captured, never run, so a scheduled retry cannot
    // keep the process alive or fire mid-assertion. Tests call the functions directly.
    setTimeout: (fn, ms) => { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout: () => {},
    APP_VERSION: 'test',
    window: null,
    fetch: (url, opts) => {
      const u = String(url);
      if (/identitytoolkit|securetoken/.test(u)) return Promise.resolve(auth.handle(u, opts));
      if (/firestore.googleapis.com/.test(u)) return Promise.resolve(firestore.handle(u, opts));
      return Promise.resolve(sheet.handle(u, opts));
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['js/db.js', 'js/sync.js', 'js/firebase-config.js', 'js/cloud.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  sandbox.db = sandbox.blankDB();
  sandbox.db.settings.deviceTag = name;
  sandbox.db.settings.syncUrl = 'https://sheet.test/exec';
  sandbox.db.settings.firebase = { apiKey: 'AIzaTEST', projectId: 'texpark-test' };
  sandbox.lastCommitted = sandbox.indexRecs_(sandbox.db);
  sandbox.session = { userId: 'u1', username: 'admin' };
  sandbox.__timers = timers;
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

/* Drain the outbox through cloud.js's transport, then let it settle. This stands in
   for "a little time passed and any armed retry timer fired": syncRetryAll() clears
   that timer (its callback would), re-arms failed jobs, and flushes. */
async function settle(dev) { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); }
async function flush(dev) {
  dev.syncRetryAll();
  await settle(dev);
  await dev.syncFlush();
  await settle(dev);
}

(async function () {
  const firestore = makeFirestore();
  const auth = makeAuth();
  const sheet = makeSheet();

  /* ------------------- the two devices sign into one account ------------------- */
  console.log('\n--- two devices on one shop account ---');
  const pc = makeDevice('PC', firestore, auth, sheet);
  const ph = makeDevice('PH', firestore, auth, sheet);
  await pc.fbSignUp('shop@example.com', 'secret1');
  await ph.fbSignIn('shop@example.com', 'secret1');
  ok(pc.fbSignedIn() && ph.fbSignedIn(), 'both devices signed in');
  eq(pc.fbAuthLoad().uid, ph.fbAuthLoad().uid, 'the same account is the same shop');

  /* ------------------- a memo pushes as per-record documents ------------------- */
  console.log('\n--- a save pushes records, not the whole book ---');
  // The first commit seeds a stamp on every pre-existing record, so steady state is
  // measured on a second change.
  addMemo(pc, 'TXP/SM/0-PC000', 'Seed', 1, 100);
  await flush(pc);
  const before = firestore.state.writes;
  addMemo(pc, 'TXP/SM/1-PC001', 'Karim', 3, 250);
  await flush(pc);
  ok(firestore.state.writes > before, 'Firestore received the change');
  const shopUid = pc.fbAuthLoad().uid;
  const memoDoc = Object.keys(firestore.shops[shopUid] || {}).find(k => k.indexOf('memos__') === 0 && firestore.shops[shopUid][k].data.mapValue.fields.memoNo.stringValue === 'TXP/SM/1-PC001');
  ok(!!memoDoc, 'the memo is one document keyed memos__<id>');
  ok(firestore.state.writes - before <= 6, 'a save is a handful of documents, not a snapshot (' + (firestore.state.writes - before) + ')');

  /* ------------------- the phone pulls only the delta ------------------- */
  console.log('\n--- the phone sees it, reading only the delta ---');
  const r = await ph.cloudPullMerge();
  ok(r.merged === true, "the phone merged the change [" + JSON.stringify(r) + "]");
  const gotMemo = ph.db.memos.filter(m => m.memoNo === 'TXP/SM/1-PC001');
  eq(gotMemo.length, 1, 'the phone now has the PC memo');
  eq(ph.db.products.length, pc.db.products.length, 'the starter products did not duplicate');

  const readsBefore = firestore.state.reads;
  const r2 = await ph.cloudPullMerge();
  eq(firestore.state.reads - readsBefore, 0, 'a second pull with nothing new reads ZERO documents (the free-plan rule)');
  ok(r2.merged === false, 'and merges nothing');

  /* ------------------- the phone writes, the PC reads the delta ------------------- */
  console.log('\n--- the phone writes, the PC reads the delta ---');
  addMemo(ph, 'TXP/SM/2-PH001', 'Rahim', 2, 200);
  await flush(ph);
  const pcReads = firestore.state.reads;
  const r3 = await pc.cloudPullMerge();
  ok(r3.merged === true, "the PC merged [" + JSON.stringify(r3) + "]");
  // A memo legitimately touches its own document PLUS the stock row it consumed and
  // the ledger line it wrote, so this is a handful, not the whole book.
  ok(firestore.state.reads - pcReads >= 1 && firestore.state.reads - pcReads <= 8,
    'only the phone\'s few changed documents were read (' + (firestore.state.reads - pcReads) + ')');
  eq(pc.db.memos.filter(m => m.memoNo === 'TXP/SM/2-PH001').length, 1, 'the PC has the phone memo');

  /* ------------------- a delete travels as a tombstone ------------------- */
  console.log('\n--- a delete travels and cannot be resurrected ---');
  const victim = pc.db.memos.filter(m => m.memoNo === 'TXP/SM/1-PC001')[0];
  // A delete is a removal plus a commit; stampChanged_ turns the disappearance into a
  // tombstone and cloud.js ships it, exactly as deleting a memo in the UI does.
  pc.db.memos = pc.db.memos.filter(m => m.id !== victim.id);
  pc.commit();
  await flush(pc);
  const delDoc = Object.keys(firestore.shops[shopUid] || {}).find(k => k === 'memos__' + victim.id);
  ok(!!delDoc && firestore.shops[shopUid][delDoc].deleted === true, 'Firestore holds the tombstone');
  await ph.cloudPullMerge();
  eq(ph.db.memos.filter(m => m.id === victim.id).length, 0, 'the phone no longer has the deleted memo');
  // Re-pulling the phone's own (stale) copy of it must not bring it back.
  const stale = { memos: [Object.assign({}, victim)], tombstones: [] };
  ph.mergeCloudInto_(stale);
  eq(ph.db.memos.filter(m => m.id === victim.id).length, 0, 'a stale copy cannot resurrect it');

  /* ------------------- receipts (payments) sync too ------------------- */
  console.log('\n--- a delivery receipt (payments) syncs as a record ---');
  const pay = { id: 'pay-1', date: pc.today(), customerId: 'c1', amount: 500, method: 'Cash',
    memoId: 'm-TXP/SM/2-PH001', deliveryId: 'd1', at: new Date().toISOString() };
  pc.db.payments.push(pay);
  pc.commit();
  await flush(pc);
  await ph.cloudPullMerge();
  eq(ph.db.payments.filter(p => p.id === 'pay-1').length, 1, 'the phone received the receipt');
  // Soft-deleting it (del:true) travels like any tombstone.
  const rec = pc.db.payments.filter(p => p.id === 'pay-1')[0];
  rec.del = true; rec.at = new Date(Date.now() + 1000).toISOString();
  pc.mergeCloudInto_({ payments: [Object.assign({}, rec)], tombstones: [] });
  await flush(pc);

  /* ------------------- quota -> degrade to Sheet -> auto-recover ------------------- */
  console.log('\n--- the cloud goes over quota: degrade to the Sheet, then recover ---');
  firestore.state.quota = true;
  const before2 = firestore.state.writes;
  addMemo(pc, 'TXP/SM/3-PC002', 'Quota', 1, 100);
  await flush(pc);
  eq(pc.cloudState(), 'DEGRADED_SHEET', 'the device reports DEGRADED_SHEET');
  ok(pc.CLOUD_STATE.retryAt > Date.now(), 'a retry was armed');
  const mirrored = Object.keys(sheet.rows).filter(k => k.indexOf('memos__') === 0 && sheet.rows[k].json.indexOf('TXP/SM/3-PC002') >= 0);
  ok(mirrored.length === 1, 'the record still reached the Sheet Records tab (the phone will see it)');
  // The phone has no Firestore at all; it catches up from the Sheet fallback.
  const recs = JSON.parse(await sheet.handle('https://sheet.test/exec?action=records', {}).text());
  ok(recs.records.some(x => x.json.indexOf('TXP/SM/3-PC002') >= 0), 'the fallback Sheet read returns the record');

  // Quota lifts: the next sync puts it back online.
  firestore.state.quota = false;
  pc.CLOUD_STATE.retryAt = 0;
  // The queued Firestore job is still pending, so an ordinary flush drains it.
  await flush(pc);
  eq(pc.cloudState(), 'ONLINE_FIRESTORE', 'a success put the device back ONLINE');
  const backDoc = Object.keys(firestore.shops[shopUid] || {}).some(k => k.indexOf('memos__') === 0 &&
    JSON.stringify(firestore.shops[shopUid][k].data).indexOf('TXP/SM/3-PC002') >= 0);
  ok(backDoc, 'the record is now in Firestore too, not only the Sheet');

  /* ------------------- offline is not data loss ------------------- */
  console.log('\n--- offline: the outbox holds everything ---');
  firestore.state.offline = true;
  addMemo(pc, 'TXP/SM/4-PC003', 'Offline', 1, 50);
  await flush(pc);
  const pending = pc.syncQueue.filter(j => j.state === 'pending' && j.via === 'firestore');
  ok(pending.length >= 1, 'the Firestore job waits in the outbox, not dropped');
  firestore.state.offline = false;
  await flush(pc);
  const okDoc = Object.keys(firestore.shops[shopUid] || {}).some(k =>
    JSON.stringify(firestore.shops[shopUid][k].data).indexOf('TXP/SM/4-PC003') >= 0);
  ok(okDoc, 'when the cloud returns, the held job is delivered');
  ok(pc.syncQueue.filter(j => j.via === 'firestore').length === 0, 'the outbox drains');

  /* ------------------- migration is idempotent ------------------- */
  console.log('\n--- one-time migration pushes the whole book once ---');
  const fresh = makeDevice('PC2', firestore, auth, sheet);
  fresh.db = fresh.blankDB();
  fresh.db.settings.deviceTag = 'PC2';
  fresh.db.settings.firebase = { apiKey: 'AIzaTEST', projectId: 'texpark-test' };
  fresh.lastCommitted = fresh.indexRecs_(fresh.db);
  fresh.session = { userId: 'u1', username: 'admin' };
  await fresh.fbSignIn('shop@example.com', 'secret1');
  ok(!fresh.cloudMigrated(), 'not yet migrated');
  const w0 = firestore.state.writes;
  await fresh.cloudMigrate(true);
  ok(fresh.cloudMigrated(), 'the migration is recorded');
  ok(firestore.state.writes > w0, 'records were written');
  const w1 = firestore.state.writes;
  await fresh.cloudMigrate(true);
  ok(firestore.state.writes > w1, 're-running is a safe idempotent upsert, not a crash');

  /* ------------------- unconfigured device is untouched ------------------- */
  console.log('\n--- a device with no cloud keys behaves exactly as before ---');
  const plain = makeDevice('OLD', firestore, auth, sheet);
  plain.db = plain.blankDB();
  plain.db.settings.firebase = { apiKey: '', projectId: '' };
  plain.lastCommitted = plain.indexRecs_(plain.db);
  const n = plain.cloudQueueChanges(plain.lastCommitted);
  eq(n, 0, 'no records are queued when the cloud is not configured');
  eq(plain.cloudConfigured(), false, 'and it reports itself unconfigured');
  const qLen = plain.syncQueue.length;
  const p2 = { id: 'm-plain', memoNo: 'X', at: new Date().toISOString(), items: [], grandTotal: 0, due: 0 };
  plain.db.memos.push(p2);
  plain.commit();
  eq(plain.syncQueue.filter(j => j.via === 'firestore').length, 0, 'a commit queues no Firestore job');

  console.log('\n=================');
  console.log('cloud: ' + pass + ' pass / ' + fail + ' fail');
  console.log('=================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('cloud test crashed: ' + (e && e.stack || e)); process.exit(1); });
