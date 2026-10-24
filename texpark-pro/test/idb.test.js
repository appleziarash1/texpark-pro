/* IndexedDB storage. Run: node test/idb.test.js

   Node has no indexedDB, so every other suite exercises only the memory-only fallback
   in db.js. That means the path the owner's browser actually takes - open
   IndexedDB, move the old localStorage copy in, verify it, then keep the book there -
   would otherwise ship untested.

   The shim below is a small in-memory IndexedDB: async callbacks, a structured clone
   on put, get/put/delete on one object store. It is deliberately not a mock of the
   app's own code: db.js runs unchanged against it, so what is proven is the real
   storageInit/idbMigrateKey_/commit/syncSave path. */

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

/* ---------------- an in-memory IndexedDB ---------------- */
function makeIndexedDB() {
  const dbs = {};                          // name -> { version, stores: { name -> Map } }
  const stats = { opens: 0, puts: 0, gets: 0 };
  let failNextTransaction = false;

  function req(result, err, tx) {
    const r = { result: result, error: err || null, onsuccess: null, onerror: null };
    // genuinely asynchronous, like the real API, so a synchronous reader that ran
    // before the write landed would be caught here
    Promise.resolve().then(() => {
      if (r.error) { if (r.onerror) r.onerror(); }
      else {
        if (r.onsuccess) r.onsuccess();
        if (tx && tx.oncomplete) tx.oncomplete();
      }
    });
    return r;
  }

  function store(name, map, tx) {
    return {
      get(key) { stats.gets++; return req(map.has(key) ? clone(map.get(key)) : undefined, null, tx); },
      put(value, key) { stats.puts++; map.set(key, clone(value)); return req(key, null, tx); },
      delete(key) { map.delete(key); return req(undefined, null, tx); }
    };
  }

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  function open(name, version) {
    stats.opens++;
    const r = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
    Promise.resolve().then(() => {
      let db = dbs[name];
      const isNew = !db;
      if (!db) db = dbs[name] = { version: version || 1, stores: {} };
      const handle = {
        objectStoreNames: { contains: n => Object.prototype.hasOwnProperty.call(db.stores, n) },
        createObjectStore(n) { if (!db.stores[n]) db.stores[n] = new Map(); return store(n, db.stores[n]); },
        transaction(n, mode) {
          if (failNextTransaction) {
            failNextTransaction = false;
            const e = new Error('The database connection is closing');
            e.name = 'InvalidStateError';
            throw e;
          }
          if (!db.stores[n]) throw new Error('no such store ' + n);
          const tx = { objectStore: () => store(n, db.stores[n], tx), onabort: null, oncomplete: null, error: null };
          return tx;
        }
      };
      r.result = handle;
      if (isNew && r.onupgradeneeded) r.onupgradeneeded();
      if (r.onsuccess) r.onsuccess();
    });
    return r;
  }

  /* Reach into a database the way a second page would, to prove what really landed. */
  function peek(name, storeName, key) {
    const db = dbs[name];
    if (!db || !db.stores[storeName]) return undefined;
    const v = db.stores[storeName].get(key);
    return v === undefined ? undefined : clone(v);
  }
  function seed(name, storeName, key, value) {
    const db = dbs[name] = dbs[name] || { version: 1, stores: {} };
    const map = db.stores[storeName] = db.stores[storeName] || new Map();
    map.set(key, clone(value));
  }
  return { open, peek, seed, stats, dbs, failNextTransaction() { failNextTransaction = true; } };
}

/* A device: the real db.js + sync.js over a private localStorage and one IndexedDB. */
function makeDevice(idb) {
  const store = {};
  const alerts = [], toasts = [];
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  const sandbox = {
    localStorage, console, alert(message) { alerts.push(message); }, toast(message) { toasts.push(message); }, confirm: () => true,
    document: { getElementById: () => null, addEventListener() {} },
    navigator: { userAgent: 'Mozilla/5.0' },
    setTimeout, clearTimeout, Promise, JSON,
    indexedDB: idb
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.alerts = alerts;
  sandbox.toasts = toasts;
  vm.createContext(sandbox);
  for (const f of ['js/db.js', 'js/sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  sandbox.STORAGE_KEYS = vm.runInContext('STORAGE_KEYS', sandbox);
  return sandbox;
}

(async function () {
  console.log('\n--- one-time migration out of localStorage ---');
  const idb = makeIndexedDB();
  const dev = makeDevice(idb);

  const book = dev.blankDB();
  book.memos.push({ id: 'm1', memoNo: 'TXP/SM/1', customerName: 'Karim', items: [], due: 500 });
  const raw = JSON.stringify(book);
  dev.localStorage.setItem('texpark_pro_v2', raw);
  dev.localStorage.setItem('texpark_pro_syncq', JSON.stringify([{ id: 'j1', type: 'memo', state: 'pending' }]));
  dev.localStorage.setItem('texpark_pro_snapshots', JSON.stringify([{ at: 1, sig: 'x', data: raw }]));

  const p = dev.storageInit(dev.STORAGE_KEYS);
  ok(p && typeof p.then === 'function', 'storageInit returns a promise, so boot can await it');
  eq(dev.storeAsync, false, 'the device does not use a legacy store before migration finishes');
  const migrated = await p;
  eq(migrated, true, 'the migration reported success');
  eq(dev.storeAsync, true, 'the device switched to IndexedDB');

  eq(dev.localStorage.getItem('texpark_pro_v2'), null, 'the old localStorage book was cleaned up');
  eq(dev.localStorage.getItem('texpark_pro_syncq'), null, 'so was the sync queue');
  eq(dev.localStorage.getItem('texpark_pro_snapshots'), null, 'and the snapshots');

  const stored = idb.peek('texpark_pro_db', 'kv', 'texpark_pro_v2');
  ok(!!stored, 'the book is really in IndexedDB');
  eq(stored.memos.length, 1, 'with its memos');
  eq(stored.memos[0].customerName, 'Karim', 'and the memo content, verified after the write');
  ok(Array.isArray(idb.peek('texpark_pro_db', 'kv', 'texpark_pro_syncq')), 'the queue moved too');

  console.log('\n--- boot reads the migrated book ---');
  const loaded = dev.loadDB();
  eq(loaded.memos.length, 1, 'loadDB reads the book back out of IndexedDB');
  eq(loaded.memos[0].memoNo, 'TXP/SM/1', 'the memo is intact');

  console.log('\n--- commit writes to IndexedDB and reports the async write ---');
  dev.db = loaded;
  dev.lastCommitted = dev.frozenIndex_(dev.db);
  dev.db.memos.push({ id: 'm2', memoNo: 'TXP/SM/2', customerName: 'Rahim', items: [], due: 900 });
  const w = dev.commit();
  ok(w && typeof w.then === 'function', 'commit returns the pending IndexedDB write');
  ok(!!w, 'so `if (!commit()) return;` still lets the save through');
  eq(idb.peek('texpark_pro_db', 'kv', 'texpark_pro_v2').memos.length, 1,
     'the new memo is not on disk until the write lands');
  await w;
  eq(idb.peek('texpark_pro_db', 'kv', 'texpark_pro_v2').memos.length, 2,
     'awaiting the commit persists the second memo');
  ok(dev.storeMirror['texpark_pro_v2'].memos.length === 2,
     'the mirror already held both, so a reader never saw the old book');

  console.log('\\n--- repeated save failures never open blocking browser dialogs ---');
  dev.notifyCommitFailure_(new Error('disk temporarily unavailable'));
  dev.notifyCommitFailure_(new Error('disk temporarily unavailable'));
  eq(dev.alerts.length, 0, 'save errors do not use browser alert dialogs');
  eq(dev.toasts.length, 1, 'the same save failure is shown once as a non-blocking toast');

  console.log('\\n--- a closed IndexedDB connection is reopened and the write retried ---');
  const opensBeforeRetry = idb.stats.opens;
  idb.failNextTransaction();
  dev.db.memos.push({ id: 'm3', memoNo: 'TXP/SM/3', customerName: 'Nadia', items: [], due: 300 });
  const retried = dev.commit();
  await retried;
  eq(idb.stats.opens, opensBeforeRetry + 1, 'the closed connection was discarded and a fresh one opened');
  eq(idb.peek('texpark_pro_db', 'kv', 'texpark_pro_v2').memos.length, 3,
     'the write succeeded after reopening without losing the memo');

  console.log('\n--- the sync queue persists to IndexedDB ---');
  dev.syncQueue = [{ id: 'j9', type: 'memo', state: 'pending', label: 'Memo' }];
  dev.syncSave();
  await new Promise(r => setTimeout(r, 0));
  const q = idb.peek('texpark_pro_db', 'kv', 'texpark_pro_syncq');
  ok(Array.isArray(q) && q.some(j => j.id === 'j9'), 'syncSave put the queue in IndexedDB, not localStorage');
  eq(dev.localStorage.getItem('texpark_pro_syncq'), null, 'and nothing went back to localStorage');

  console.log('\n--- the migration runs once, not every boot ---');
  const putsBefore = idb.stats.puts;
  const again = makeDevice(idb);
  await again.storageInit(again.STORAGE_KEYS);
  eq(again.storeAsync, true, 'a second boot stays on IndexedDB');
  eq(idb.stats.puts, putsBefore, 'and does not rewrite the book just to open it');
  eq(again.loadDB().memos.length, 3, 'it reads all three saved memos after reopening');

  console.log('\n--- an existing IndexedDB copy is never overwritten by a stale localStorage one ---');
  const idb2 = makeIndexedDB();
  const dev2 = makeDevice(idb2);
  const newer = dev2.blankDB();
  newer.memos.push({ id: 'new', memoNo: 'NEW', customerName: 'Newer', items: [], due: 1 });
  idb2.seed('texpark_pro_db', 'kv', 'texpark_pro_v2', newer);
  const older = dev2.blankDB();
  older.memos.push({ id: 'old', memoNo: 'OLD', customerName: 'Older', items: [], due: 1 });
  dev2.localStorage.setItem('texpark_pro_v2', JSON.stringify(older));
  await dev2.storageInit(dev2.STORAGE_KEYS);
  const kept = idb2.peek('texpark_pro_db', 'kv', 'texpark_pro_v2');
  eq(kept.memos.length, 1, 'still one memo after the merge attempt');
  eq(kept.memos[0].memoNo, 'NEW', 'the copy already in IndexedDB won');

  console.log('\n--- a corrupt localStorage value is not moved ---');
  const idb3 = makeIndexedDB();
  const dev3 = makeDevice(idb3);
  dev3.localStorage.setItem('texpark_pro_v2', '{not valid json');
  const corruptReady = await dev3.storageInit(dev3.STORAGE_KEYS);
  eq(corruptReady, false, 'startup refuses to load an unparseable legacy database');
  eq(dev3.storeAsync, false, 'the app does not switch to the incomplete migration');
  eq(idb3.peek('texpark_pro_db', 'kv', 'texpark_pro_v2'), undefined, 'nothing half-written was put in the store');
  eq(dev3.localStorage.getItem('texpark_pro_v2'), '{not valid json', 'the bad value is left where it was');
  eq(dev3.loadDB().memos.length, 0, 'the test memory store remains blank while legacy data is preserved');

  console.log('\n--- with no IndexedDB the fallback is memory-only ---');
  const dev4 = makeDevice(undefined);
  eq(dev4.idbAvailable, false, 'IndexedDB is detected as absent');
  const migrated4 = await dev4.storageInit(dev4.STORAGE_KEYS);
  eq(migrated4, false, 'storageInit reports IndexedDB is unavailable');
  eq(dev4.storeAsync, false, 'the memory-only fallback is not IndexedDB');
  dev4.db = dev4.blankDB();
  dev4.lastCommitted = dev4.frozenIndex_(dev4.db);
  eq(dev4.commit(), true, 'commit is synchronous and true, as the old code returned');
  eq(dev4.storeGet('texpark_pro_v2').memos.length, 0, 'the book is available in memory');
  eq(dev4.localStorage.getItem('texpark_pro_v2'), null, 'the database was not written to localStorage');

  console.log('\n=================');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  console.log('=================');
  process.exit(fail ? 1 : 0);
})();
