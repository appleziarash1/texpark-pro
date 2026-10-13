/* The Cloudflare backend, driven through the REAL js/cloudcf.js and js/cloud.js.

   A stand-in WebSocket and fetch let the test watch exactly what the client would
   put on the wire, and then feed a server push back in - so the live path (socket ->
   the ONE proven merge) and the delta/write paths are exercised as written, with no
   network and no Worker.

   Run: node test/cloudflare.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

const tick = () => new Promise(r => setImmediate(r));
const ticks = async (n) => { for (let i = 0; i < n; i++) await tick(); };

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* Every WebSocket the client opens, so the test can open it, push a change, or drop
   it the way a server refusal would. */
function makeWS() {
  const sockets = [];
  function Fake(url) {
    this.url = url;
    this.sent = [];
    this.listeners = {};
    this.closed = false;
    sockets.push(this);
  }
  Fake.prototype.addEventListener = function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); };
  Fake.prototype.emit = function (t, ev) { (this.listeners[t] || []).forEach(fn => fn(ev || {})); };
  Fake.prototype.send = function (m) { this.sent.push(m); };
  Fake.prototype.close = function () { this.closed = true; this.emit('close', { code: 1000 }); };
  return { Fake, sockets };
}

/* fetch returns one queued response per call and records the request. */
function makeFetch() {
  const calls = [];
  const queue = [];
  const fn = async (url, opts) => {
    calls.push({ url: url, opts: opts || {} });
    const r = queue.shift();
    if (!r) throw new Error('no queued response for ' + url);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body)
    };
  };
  fn.calls = calls;
  fn.queue = queue;
  fn.reply = (status, body) => queue.push({ status, body });
  return fn;
}

function makeSandbox(cfg) {
  const store = {};
  const ws = makeWS();
  const fetchFn = makeFetch();
  const sandbox = {
    console, TextEncoder, TextDecoder, Promise, JSON, Date, Object, Array, Math, String, Number, RegExp, Error,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    setTimeout: () => 0, clearTimeout: () => {},
    fetch: fetchFn,
    WebSocket: ws.Fake,
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    location: { hash: '', pathname: '/', search: '', origin: 'https://site.example' },
    history: { replaceState: (st, ti, url) => { const i = String(url || '').indexOf('#'); sandbox.location.hash = i >= 0 ? String(url).slice(i) : ''; } },
    document: { getElementById: () => null, addEventListener() {} },
    import: () => Promise.reject(new Error('the test forbids the CDN'))
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['js/db.js', 'js/firebase-config.js', 'js/cloudflare-config.js', 'js/cloudcf.js', 'js/cloud.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  sandbox.db = sandbox.blankDB();
  sandbox.session = { userId: 'u1', username: 'admin' };
  sandbox.cloudBusy = false;
  Object.assign(sandbox.window.CLOUDFLARE_SYNC, cfg || {});
  return { s: sandbox, ws, fetch: fetchFn };
}

(async () => {
  console.log('\n--- which backend is selected ---');
  {
    const { s } = makeSandbox({ backend: 'cloudflare', url: 'https://texpark-sync.example.workers.dev', token: 'tok-123' });
    ok(s.cfBackendOn(), 'cloudflare backend is on with a url and token');
    ok(s.cloudConfigured(), 'the cloud counts as configured with no Firebase keys at all');
    s.window.CLOUDFLARE_SYNC.backend = 'firebase';
    ok(!s.cfBackendOn(), 'switching the build back to firebase turns the adapter off');
  }
  {
    const { s } = makeSandbox({ backend: 'cloudflare', url: '', token: '' });
    ok(!s.cfBackendOn(), 'cloudflare with no url/token is off, so the app falls back cleanly');
  }

  console.log('\n--- the delta pull ---');
  {
    const { s, fetch } = makeSandbox({ backend: 'cloudflare', url: 'https://w.example.dev', token: 'tok-123' });
    fetch.reply(200, { records: [{ key: 'customers', id: 'c1', at: '2026-01-01T00:00:01.000Z', deleted: false, data: { id: 'c1', name: 'Rahim', at: '2026-01-01T00:00:01.000Z' } }], now: '2026-01-01T00:00:01.000Z' });
    const d = await s.fbPullDelta();
    eq(fetch.calls[0].url, 'https://w.example.dev/records?since=', 'it asks the Worker for everything since the (empty) cursor');
    eq(fetch.calls[0].opts.headers.Authorization, 'Bearer tok-123', 'the shop token rides as a bearer header');
    eq(d.records.length, 1, 'one record came back');
    eq(d.records[0].key, 'customers', 'mapped to the {key, rec} shape the merge already speaks');
    eq(d.records[0].rec.name, 'Rahim', 'with the record body intact');
    eq(d.newest, '2026-01-01T00:00:01.000Z', 'and the newest `at` for the cursor');
  }

  console.log('\n--- a future-stamped record cannot poison the cursor ---');
  {
    const { s, fetch } = makeSandbox({ backend: 'cloudflare', url: 'https://w.example.dev', token: 'tok-123' });
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();   // another device's clock, 30 min fast
    fetch.reply(200, { records: [{ key: 'memos', id: 'm1', at: future, deleted: true, data: { id: 'm1', at: future } }], now: future });
    const d = await s.fbPullDelta();
    ok(String(d.newest) <= new Date().toISOString(), 'the cursor never runs past this device\'s own clock');
    ok(String(d.newest) < future, 'a future `at` is not adopted as the cursor');
  }

  console.log('\n--- a write goes up as one batch ---');
  {
    const { s, fetch } = makeSandbox({ backend: 'cloudflare', url: 'https://w.example.dev', token: 'tok-123' });
    fetch.reply(200, { ok: true, applied: 1 });
    await s.fbWriteRecord('customers', { id: 'c1', name: 'Rahim', at: '2026-01-01T00:00:05.000Z' }, { at: '2026-01-01T00:00:05.000Z' });
    const sent = JSON.parse(fetch.calls[0].opts.body);
    eq(fetch.calls[0].opts.method, 'POST', 'a write is a POST');
    eq(sent.records[0].key, 'customers', 'the record keeps its collection key');
    eq(sent.records[0].id, 'c1', 'and its id');
    eq(sent.records[0].at, '2026-01-01T00:00:05.000Z', 'and its timestamp');
    eq(sent.records[0].deleted, false, 'a live write is not a tombstone');
  }

  console.log('\n--- the live stream ---');
  {
    const { s, ws } = makeSandbox({ backend: 'cloudflare', url: 'https://w.example.dev', token: 'tok-123' });
    let pulls = 0;
    s.cloudPullMerge = async () => { pulls++; return {}; };

    s.cfRealtimeStart(); await ticks(3);
    eq(ws.sockets.length, 1, 'one socket was opened');
    eq(ws.sockets[0].url, 'wss://w.example.dev/live?token=tok-123', 'it upgrades https to wss and carries the token in the query');

    ws.sockets[0].emit('open'); await ticks(3);
    ok(s.fbRealtimeLive(), 'an open socket counts as live');

    ws.sockets[0].emit('message', { data: JSON.stringify({ type: 'change', records: [{ key: 'customers', id: 'c1' }] }) });
    await ticks(3);
    eq(pulls, 1, 'a server push wakes the ONE proven merge exactly once');

    ws.sockets[0].emit('message', { data: JSON.stringify({ type: 'hello', now: '' }) });
    await ticks(3);
    eq(pulls, 1, 'the greeting is not a change and does not merge');

    ws.sockets[0].emit('message', { data: 'not json' });
    await ticks(3);
    eq(pulls, 1, 'a malformed frame is ignored, not fatal');
  }

  console.log('\n--- a refused token stops instead of hammering ---');
  {
    const { s, ws } = makeSandbox({ backend: 'cloudflare', url: 'https://w.example.dev', token: 'bad' });
    s.cloudPullMerge = async () => ({});
    s.cfRealtimeStart(); await ticks(3);
    ws.sockets[0].emit('open'); await ticks(2);
    ws.sockets[0].emit('close', { code: 1008 }); await ticks(3);
    ok(!s.fbRealtimeLive(), 'the socket is forgotten');
    ok(s.cfRtFatal, 'a policy-violation close is treated as a bad token, so it will not retry');
    eq(s.cfRtRetryTimer, null, 'and no retry was armed');
  }

  console.log('\n--- sign-out tears the stream down ---');
  {
    const { s, ws } = makeSandbox({ backend: 'cloudflare', url: 'https://w.example.dev', token: 'tok-123' });
    s.cloudPullMerge = async () => ({});
    s.cfRealtimeStart(); await ticks(3);
    ws.sockets[0].emit('open'); await ticks(2);
    s.fbRealtimeStop(); await ticks(2);
    ok(ws.sockets[0].closed, 'the socket was closed');
    ok(!s.fbRealtimeLive(), 'and the live flag cleared');
  }

  console.log('\n--- the Firestore sign-in guard does not block the Cloudflare backend ---');
  {
    const { s, fetch } = makeSandbox({ backend: 'cloudflare', url: 'https://w.example.dev', token: 'tok-123' });
    s.cloudPullMerge = async () => ({ merged: true });
    const r = await s.cloudAutoSyncNew('test');
    ok(!(r && r.skipped === 'firebase not signed in'), 'it did not stand down for a Firebase session it does not use');
    eq(s.fbSignedIn(), false, 'and there is genuinely no Firebase session');
  }

  console.log('\n--- the shop token arrives by private link, never from the repo ---');
  {
    const token = 'sh0p-s3cret-abcdef';
    const { s, fetch } = makeSandbox({ backend: 'cloudflare', url: 'https://w.example.dev', token: '' });
    ok(!s.cfBackendOn(), 'with no token the backend stays off, so a public build cannot reach the shop');

    // the link carries base64('cf|' + token) in the fragment, like the Firebase one
    s.location.hash = '#cloud=' + encodeURIComponent(Buffer.from('cf|' + token).toString('base64'));
    const adopted = s.fbAdoptProvision();
    ok(adopted, 'opening the private link is adopted');
    eq(s.location.hash, '', 'and the secret is scrubbed from the address bar');
    eq(s.cfProvToken_(), token, 'the token is now stored on this device');
    ok(s.cfBackendOn(), 'and the Cloudflare backend turns on');

    // a token-only paste (no link) works too
    s.cfProvSave('another-token');
    eq(s.cfProvToken_(), 'another-token', 'a pasted token is saved the same way');
    s.cfProvSave(token);   // restore for the link check

    const link = s.cfProvisionLink();
    ok(link.indexOf('#cloud=') > 0, 'the device can re-issue its own private link');
    eq(Buffer.from(decodeURIComponent(link.split('#cloud=')[1]), 'base64').toString('binary'), 'cf|' + token,
      'and that link carries the same cf| token');

    fetch.reply(200, { records: [], now: '' });
    await s.cfPullDelta();
    eq(fetch.calls[0].opts.headers.Authorization, 'Bearer ' + token, 'requests then carry the adopted token');
  }

  console.log('\n=================');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})();
