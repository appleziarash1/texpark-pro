/* Realtime push (documents:listen): the "0" path. Driven through the REAL cloud.js
   against a fake streaming fetch, so the framing, the wake-up merge, the coalescing,
   the abort-on-sign-out and the resume token are all exercised as written.

   Run: node test/realtime.test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

function makeSandbox() {
  const store = {};
  const sandbox = {
    console, TextEncoder, TextDecoder, AbortController, Promise, JSON, Date, Object, Array, Math, String, Number,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    __timers: [],
    setTimeout: (fn, ms) => { sandbox.__timers.push({ fn, ms }); return sandbox.__timers.length; },
    clearTimeout: () => {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['js/db.js', 'js/firebase-config.js', 'js/cloud.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  sandbox.db = sandbox.blankDB();
  sandbox.session = { userId: 'u1', username: 'admin' };
  sandbox.localStorage.setItem('texpark_pro_firebase_auth', JSON.stringify({
    idToken: 'tok-uid-1', refreshToken: 'ref-uid-1', uid: 'uid-1',
    email: 'shop@example.com', expiresAt: Date.now() + 3600000
  }));
  return sandbox;
}

/* A streaming fetch: yields the given NDJSON lines, then either hangs until the
   request is aborted (a live stream) or ends (a dropped stream). */
function streamFetch(lines, { hangAfter = true } = {}) {
  const calls = [];
  const fn = (url, opts) => {
    calls.push({ url, opts });
    const signal = opts && opts.signal;
    let idx = 0;
    const reader = {
      read() {
        if (signal && signal.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (idx < lines.length) return Promise.resolve({ done: false, value: new TextEncoder().encode(lines[idx++]) });
        if (hangAfter) {
          return new Promise((res, rej) => {
            if (signal) signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          });
        }
        return Promise.resolve({ done: true, value: undefined });
      }
    };
    return Promise.resolve({ ok: true, status: 200, body: { getReader() { return reader; } } });
  };
  fn.calls = calls;
  return fn;
}

const tick = () => new Promise(r => setImmediate(r));
const ticks = async (n) => { for (let i = 0; i < n; i++) await tick(); };

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

(async () => {
  console.log('\n--- realtime push: opens a listen stream over the records subcollection ---');
  {
    const s = makeSandbox();
    let pulls = 0;
    s.cloudPullMerge = async () => { pulls++; return { merged: false }; };
    s.fetch = streamFetch([
      JSON.stringify({ targetChange: { targetIds: [1], resumeToken: 'TOK-A', readTime: '2026-10-12T10:00:00Z' } }) + '\n',
      JSON.stringify({ documentChange: { document: { name: 'x' } } }) + '\n'
    ], { hangAfter: true });
    s.fbListenLoop();
    await ticks(6);

    eq(s.fetch.calls.length, 1, 'one listen request was opened');
    ok(/:listen$/.test(s.fetch.calls[0].url), 'it POSTs to the documents:listen endpoint');
    const body = JSON.parse(s.fetch.calls[0].opts.body.trim());
    ok(body.addTarget && body.addTarget.targetId === 1, 'the first frame is an addTarget');
    ok(body.addTarget.query && /\/shops\/uid-1$/.test(body.addTarget.query.parent),
      'the target is scoped to this uid, like the delta query');
    eq(body.addTarget.query.structuredQuery.from[0].collectionId, 'records', 'it listens on the records collection');
    ok(/Bearer tok-uid-1/.test(s.fetch.calls[0].opts.headers.Authorization), 'it authenticates as the signed-in user');
    eq(pulls, 1, 'a documentChange wakes the ONE proven merge exactly once');

    /* A burst of changes coalesces into one merge while one is already running. */
    pulls = 0;
    let release;
    s.cloudPullMerge = () => new Promise(r => { release = () => { pulls++; r({}); }; });
    s.fbListenOnChange(); s.fbListenOnChange(); s.fbListenOnChange();
    await tick();
    eq(pulls, 0, 'while a merge is in flight, further changes do not stack');
    release(); await tick();
    eq(pulls, 1, 'the burst produced exactly one merge');

    /* Sign-out aborts the stream and does not schedule a reconnect. */
    const timersBefore = s.__timers.length;
    s.fbListenStop();
    await ticks(3);
    eq(s.fbListenActive, false, 'after stop, the listener is not active');
    eq(s.__timers.length, timersBefore, 'stopping does not arm a retry (no reconnect loop after sign-out)');
  }

  console.log('\n--- malformed frames are ignored, a dropped stream reconnects ---');
  {
    const s = makeSandbox();
    let pulls = 0;
    s.cloudPullMerge = async () => { pulls++; return {}; };
    s.fetch = streamFetch([
      'not json at all\n',
      JSON.stringify({ documentChange: {} }) + '\n'
    ], { hangAfter: false });   // stream ends right after the frames
    s.fbListenLoop();
    await ticks(6);
    eq(pulls, 1, 'the malformed line was ignored, the real change still merged');
    ok(s.__timers.length >= 1, 'a dropped stream arms a reconnect timer');
    const retry = s.__timers[s.__timers.length - 1];
    eq(retry.ms, 5000, 'the first reconnect waits 5 s');
  }

  console.log('\n--- the resume token is carried into the next addTarget ---');
  {
    const s = makeSandbox();
    s.cloudPullMerge = async () => ({});
    s.fetch = streamFetch([
      JSON.stringify({ targetChange: { targetIds: [1], resumeToken: 'TOK-A' } }) + '\n'
    ], { hangAfter: false });
    s.fbListenLoop();
    await ticks(6);
    s.fetch = streamFetch([], { hangAfter: false });
    s.fbListenActive = false;
    s.fbListenLoop();
    await ticks(4);
    const body = JSON.parse(s.fetch.calls[0].opts.body.trim());
    eq(body.addTarget.resumeToken, 'TOK-A', 'the reconnect resumes from the last token, so no gap is lost');
  }

  console.log('\n--- it stays off when there is no session or no sign-in ---');
  {
    const s = makeSandbox();
    s.fetch = streamFetch([], { hangAfter: true });
    s.session = null;
    s.fbListenLoop();
    await ticks(3);
    eq(s.fetch.calls.length, 0, 'no session: no stream');

    s.session = { userId: 'u1' };
    s.localStorage.removeItem('texpark_pro_firebase_auth');
    s.fbListenLoop();
    await ticks(3);
    eq(s.fetch.calls.length, 0, 'not signed in to Firestore: no stream');
  }

  console.log('\n=================');
  console.log('PASS ' + pass + '   FAIL ' + fail);
  if (fail) process.exit(1);
})();
