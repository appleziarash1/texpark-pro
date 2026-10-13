/* Texpark Pro - Cloudflare sync backend (Workers + Durable Objects).
 *
 * WHY THIS EXISTS
 * The app's live sync used Firebase Firestore. The owner wants the business data to
 * live in his own infrastructure instead, and to stay genuinely instant. This Worker
 * is that backend: one Durable Object per shop, holding the shop's records in SQLite
 * and pushing every change to the other devices over a WebSocket the moment it lands.
 *
 * SHAPE OF A RECORD (mirrors the old Firestore document, so the client keeps the same
 * merge logic):  key, id, at, deleted, device, data
 *   key      the collection the record lives in ("customers", "products", ...)
 *   id       the record id inside that collection
 *   at       ISO timestamp of the last write, monotonic per record ("last write wins")
 *   deleted  a tombstone, so a delete syncs too
 *   data     the whole record as JSON
 *
 * API (all require the shop token, either `Authorization: Bearer <token>` or
 * `?token=`; the WebSocket is browser-native, so it uses the query form):
 *   GET  /health                 -> { ok:true }          (no token, no data)
 *   GET  /records?since=<at>     -> { records:[...], now }
 *   POST /records                -> { ok:true, now }     body { records:[...] }
 *   GET  /live?token=...         -> WebSocket: {type:'hello',now} then
 *                                  {type:'change', records:[...]} on each write
 *
 * The worker itself holds NO state and NO logic beyond routing and the token check:
 * everything that must be decided once is decided inside the object.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/* The app is served from a different origin (GitHub Pages, Cloudflare Pages, or a
   local dev server) than this Worker, so every fetch is cross-origin and the browser
   will not even send the request without a preflight answer. The token, not the
   origin, is what guards the shop, so any origin may read the responses. */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400'
};

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({}, JSON_HEADERS, CORS_HEADERS, extra || {})
  });
}

/* Constant-time-ish comparison so a wrong token cannot be found byte by byte.
   Both sides are trimmed first: the secret is set by `echo "$TOKEN" | wrangler
   secret put`, which appends a newline, and a token that differs only by trailing
   whitespace must still match. */
function tokenMatches(given, expected) {
  given = String(given == null ? '' : given).trim();
  expected = String(expected == null ? '' : expected).trim();
  if (!expected || !given) return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= (given.charCodeAt(i) ^ expected.charCodeAt(i));
  return diff === 0;
}

function tokenFrom(request, url) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  return (url.searchParams.get('token') || '').trim();
}

function isSecure(url) {
  if (url.protocol === 'https:') return true;
  // Local development (wrangler dev) is plain http on the loopback address; that is
  // not the public internet, so the token-in-query form is safe there.
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/health') {
      return json({ ok: true, service: 'texpark-sync', v: 3 });
    }

    /* The browser's preflight. It carries no token (a preflight never does), so it is
       answered before the token check - with no data, only the CORS grant. */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!env.AUTH_TOKEN) {
      // Nothing is exposed until the owner sets the secret, so a half-configured
      // deploy can never serve the shop to the world.
      return json({ error: 'no_token_configured' }, 503);
    }
    if (!tokenMatches(tokenFrom(request, url), env.AUTH_TOKEN)) {
      return json({ error: 'unauthorized' }, 401);
    }

    // The WebSocket carries the token in the query string; a browser cannot set a
    // header on it. The upgrade is blocked on a plain-HTTP origin so the token is
    // never sent in clear.
    if (request.headers.get('upgrade') === 'websocket' && !isSecure(url)) {
      return json({ error: 'websocket_requires_https' }, 400);
    }

    const id = env.SHOP.idFromName('shop');
    const stub = env.SHOP.get(id);
    return stub.fetch(request);
  }
};

/* ============================ the shop object ============================ */
export class Shop {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      this.db = await ctx.storage.get('db');           // { lastAt }
      if (!this.db) this.db = { lastAt: '' };
      ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS records (' +
        'key TEXT, id TEXT, at TEXT, deleted INTEGER, device TEXT, data TEXT, ' +
        'PRIMARY KEY (key, id))'
      );
      ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS records_at ON records (at)');
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.headers.get('upgrade') === 'websocket' && path === '/live') {
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      // The hibernation API takes over the accept: calling accept() first and then
      // acceptWebSocket() throws ("already accepted"), so acceptWebSocket alone.
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'hello', now: this.db.lastAt }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === '/records' && request.method === 'GET') {
      return json(this.pull(url.searchParams.get('since') || ''));
    }

    if (path === '/records' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
      const result = this.apply(Array.isArray(body && body.records) ? body.records : []);
      return json({ ok: true, now: result.now, applied: result.records.length });
    }

    return json({ error: 'not_found' }, 404);
  }

  /* Durable Object WebSocket handlers: this is what makes a dead client not leak. */
  async webSocketMessage(ws, message) {
    if (message === 'ping') { try { ws.send('pong'); } catch (e) {} }
  }
  async webSocketClose(ws) { try { ws.close(); } catch (e) {} }

  /* Every record whose `at` is greater than the cursor, ascending - the same delta
     contract the client already speaks, so the merge code is untouched. The filter
     and order are done by selectDelta() so the tested function is the one in the
     path; a shop's record table is small enough that this is not a cost. */
  pull(since) {
    const rows = this.ctx.storage.sql.exec(
      'SELECT key, id, at, deleted, device, data FROM records'
    ).toArray();
    return { records: selectDelta(rows, since).map(rowToRecord), now: this.db.lastAt };
  }

  /* Insert or replace each record, then fan the applied ones out to every listener. */
  apply(incoming) {
    const currentAtOf = (key, id) => {
      const cur = this.ctx.storage.sql.exec(
        'SELECT at FROM records WHERE key = ? AND id = ?', key, id
      ).toArray()[0];
      return cur ? String(cur.at) : null;
    };
    const decided = decideApply(currentAtOf, incoming, this.db.lastAt);

    for (const rec of decided.applied) {
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO records (key, id, at, deleted, device, data) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
        rec.key, rec.id, rec.at, rec.deleted ? 1 : 0, rec.device, JSON.stringify(rec.data)
      );
    }

    if (decided.applied.length) {
      this.db.lastAt = decided.maxAt;
      this.ctx.storage.put('db', this.db);
      const frame = JSON.stringify({ type: 'change', records: decided.applied });
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(frame); } catch (e) { /* the close handler reaps it */ }
      }
    }
    return { records: decided.applied, now: this.db.lastAt };
  }
}

/* The whole write decision, as a pure function, so it can be tested without a Worker.

   A record is applied only if its `at` is strictly newer than what is stored, so a
   stale write cannot roll the shop back. `currentAtOf(key, id)` returns the stored
   timestamp or null. Returns the records to write and the new high-water mark. */
function decideApply(currentAtOf, incoming, lastAt) {
  const applied = [];
  let maxAt = lastAt;
  for (const r of incoming) {
    if (!r || typeof r.key !== 'string' || !r.key) continue;
    const id = String(r.id == null ? '' : r.id);
    const at = String(r.at == null ? '' : r.at);
    const cur = currentAtOf(r.key, id);
    if (cur != null && cur >= at) continue;              // not newer: ignore it
    const rec = {
      key: r.key, id, at,
      deleted: !!r.deleted,
      device: String(r.device == null ? '' : r.device),
      data: r.data == null ? null : r.data
    };
    applied.push(rec);
    if (at > maxAt) maxAt = at;
  }
  return { applied, maxAt };
}

/* Records newer than the cursor, oldest first. */
function selectDelta(rows, since) {
  const c = String(since == null ? '' : since);
  return rows
    .filter(r => String(r.at) > c)
    .sort((a, b) => (String(a.at) < String(b.at) ? -1 : String(a.at) > String(b.at) ? 1 : 0));
}

/* SQLite stores the JSON as text; hand the client the same object shape it had. */
function rowToRecord(r) {
  let data = null;
  try { data = JSON.parse(r.data); } catch (e) { data = null; }
  return { key: r.key, id: r.id, at: r.at, deleted: !!r.deleted, device: r.device, data };
}

export { tokenMatches, decideApply, selectDelta, rowToRecord };
