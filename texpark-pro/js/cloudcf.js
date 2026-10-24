/* Texpark Pro - Cloudflare sync transport (client side).
 *
 * The app's sync logic (merge, cursor, outbox, badges) lives in js/cloud.js and does
 * not care where records are stored. This file is the storage half: the same handful
 * of primitives cloud.js used to call directly on Firestore, implemented against the
 * Cloudflare Worker + Durable Object in /cloudflare.
 *
 *   cfBackendOn()   is this the selected backend?
 *   cfPullDelta()   every record newer than the cursor          (GET  /records)
 *   cfWriteBatch()  send many records in one request             (POST /records)
 *   cfRealtime*()   the live stream, so a change lands in ~0.1s   (WebSocket /live)
 *
 * Records keep the exact shape cloud.js already speaks - {key, id, at, deleted,
 * device, data} - so the merge and "newer wins" rules are untouched and there is no
 * second copy of that logic to drift.
 *
 * Auth is one shop token, sent as `Authorization: Bearer` on requests and as a query
 * parameter on the WebSocket (a browser cannot set a header on one). The token is a
 * build value, like the old Firebase apiKey: it names the shop, it does not grant
 * access to anything else. */

const CF_STATE_KEY = 'texpark_pro_cloudflare_state';   // {state, reason, retryAt}

function cfConfig() {
  const c = (typeof window !== 'undefined' && window.CLOUDFLARE_SYNC) || {};
  const saved = (db && db.settings && db.settings.cloudflare) || {};
  return {
    url: String(saved.url || c.url || '').trim().replace(/\/+$/, ''),
    token: String(saved.token || c.token || '').trim()
  };
}

/* Which transport this device uses. Defaults to Firestore so an existing install is
   not switched by surprise; the build turns it on by setting backend:'cloudflare'. */
function cfSelected_() {
  const c = (typeof window !== 'undefined' && window.CLOUDFLARE_SYNC) || {};
  return String(c.backend || 'firebase') === 'cloudflare';
}

function cfBackendOn() { const c = cfConfig(); return cfSelected_() && !!(c.url && c.token); }

/* Records live under one shop, like the old shops/{uid}. With one token there is one
   shop, so the name is a constant - the object is created on first use. */
const CF_SHOP = 'shop';
const CF_CURSOR_KEY = 'texpark_pro_cloudflare_cursor';

function cfCursor() { try { return localStorage.getItem(CF_CURSOR_KEY) || ''; } catch (e) { return ''; } }
function cfCursorSet(at) { try { localStorage.setItem(CF_CURSOR_KEY, String(at || '')); } catch (e) {} }

function cfHeaders_() {
  const c = cfConfig();
  return { 'Authorization': 'Bearer ' + c.token, 'Content-Type': 'application/json' };
}

/* The records array out of a response body, tolerant of a transient proxy page. */
function cfRecords_(body) { return (body && Array.isArray(body.records)) ? body.records : []; }

/* Every record whose `at` is newer than the cursor. Same delta contract as before, so
   the free plan stays free and the merge is unchanged. */
async function cfPullDelta() {
  const c = cfConfig();
  const cursor = cfCursor();
  const res = await fetch(c.url + '/records?since=' + encodeURIComponent(cursor),
    { headers: cfHeaders_() });
  if (!res.ok) throw new Error(await cfErrorText_(res));
  const body = await res.json();
  const records = cfRecords_(body).map(r => ({
    key: r.key,
    rec: r.data,
    at: r.at,
    deleted: !!r.deleted
  }));
  let newest = cursor;
  records.forEach(r => { if (String(r.at) > String(newest)) newest = r.at; });
  /* Never let the cursor run ahead of this device's own clock. A record stamped in
     the future - another device with a wrong clock - would otherwise push the cursor
     past every change written after it, and this device would silently stop seeing
     updates until real time caught up. Clamping also pulls a poisoned cursor back on
     the next pull, so the device heals itself. */
  const myNow = new Date().toISOString();
  if (String(newest) > myNow) newest = myNow;
  return { records: records, newest: newest };
}

/* Many records in one request - used by the first migration and by settings pushes. */
async function cfWriteBatch(pairs) {
  const c = cfConfig();
  const records = (pairs || []).map(p => ({
    key: p.key,
    id: (p.rec && p.rec.id) != null ? p.rec.id : '',
    at: (p.rec && p.rec.at) || new Date().toISOString(),
    deleted: !!p.deleted,
    device: (typeof deviceTag === 'function' ? deviceTag() : ''),
    data: p.rec || { id: p.rec && p.rec.id }
  }));
  if (!records.length) return true;
  const res = await fetch(c.url + '/records',
    { method: 'POST', headers: cfHeaders_(), body: JSON.stringify({ records: records }) });
  if (!res.ok) throw new Error(await cfErrorText_(res));
  return true;
}

/* One record. cloudSendJob() calls this with {key, record, at, deleted}; the batch
   form is the same write, so both paths share one implementation. */
async function cfWriteRecord(key, rec, opts) {
  const o = opts || {};
  const at = o.at || (rec && rec.at) || new Date().toISOString();
  return cfWriteBatch([{ key: key, rec: Object.assign({}, rec, { at: at }), deleted: !!o.deleted }]);
}

async function cfErrorText_(res) {
  let t = '';
  try { t = (await res.text()).slice(0, 200); } catch (e) {}
  if (res.status === 401) return 'cloudflare unauthorized (token mismatch)';
  if (res.status === 503) return 'cloudflare not configured (AUTH_TOKEN not set)';
  return 'cloudflare HTTP ' + res.status + (t ? ': ' + t : '');
}

/* ===================== the live stream =====================
   A WebSocket from the Worker: the Durable Object pushes {type:'change',records:[...]}
   the instant a write lands, so there is no polling at all on a healthy device. On any
   change it calls the SAME cloudPullMerge() the rest of the app uses, so there is one
   definition of "newer wins". The stream reconnects with bounded backoff, and the
   adaptive poll stays the floor if the socket cannot be held. */
var cfRtSocket = null;
var cfRtStarting = false;
var cfRtMergeQueued = false;
var cfRtChangePending = false;
var cfRtDrainTimer = null;
var cfRtHeartbeatTimer = null;
var cfRtLastPong = 0;
var CF_RT_HEARTBEAT_MS = 10000;
var CF_RT_PONG_TIMEOUT_MS = 30000;
var cfRtRetryTimer = null;
var cfRtRetryMs = 1000;
var CF_RT_RETRY_MAX_MS = 30000;
/* A token that is not accepted will not be accepted on retry; stop instead of
   hammering the endpoint. Cleared by a manual reconnect or a page reload. */
var cfRtFatal = false;

function cfRealtimeShouldRun() {
  return cfBackendOn() && (typeof liveSyncMode_ !== 'function' || liveSyncMode_() === 'live') && (typeof session !== 'undefined' && !!session);
}
function cfRealtimeLive() { return !!cfRtSocket && cfRtSocket.readyState === 1 && Date.now() - cfRtLastPong < CF_RT_PONG_TIMEOUT_MS; }
function cfRealtimeRetryClear() {
  if (cfRtRetryTimer) { try { clearTimeout(cfRtRetryTimer); } catch (e) {} cfRtRetryTimer = null; }
  cfRtRetryMs = 1000;
}
function cfRealtimeArmRetry() {
  if (cfRtFatal) return;
  if (cfRtRetryTimer || cfRtSocket) return;
  if (!cfRealtimeShouldRun()) return;
  var wait = cfRtRetryMs;
  cfRtRetryMs = Math.min(cfRtRetryMs * 2, CF_RT_RETRY_MAX_MS);
  cfRtRetryTimer = setTimeout(function () {
    cfRtRetryTimer = null;
    return cfRealtimeStart().catch(function () {});
  }, wait);
}
function cfRealtimeStop() {
  cfRtStarting = false;
  cfRealtimeRetryClear();
  if (cfRtHeartbeatTimer) { clearInterval(cfRtHeartbeatTimer); cfRtHeartbeatTimer = null; }
  if (cfRtDrainTimer) { clearTimeout(cfRtDrainTimer); cfRtDrainTimer = null; }
  cfRtChangePending = false;
  if (cfRtSocket) { try { cfRtSocket.close(); } catch (e) {} cfRtSocket = null; }
}
function cfRealtimeDrainChanges_() {
  if (!cfRtChangePending || cfRtMergeQueued) return;
  if (!cfRealtimeShouldRun()) { cfRtChangePending = false; return; }
  if (cloudBusy || (typeof cloudDirty !== 'undefined' && cloudDirty)) {
    if (!cfRtDrainTimer) cfRtDrainTimer = setTimeout(function () { cfRtDrainTimer = null; cfRealtimeDrainChanges_(); }, 150);
    return;
  }
  cfRtChangePending = false;
  cfRtMergeQueued = true;
  Promise.resolve().then(function () { return cloudPullMerge(); }).catch(function () {})
    .then(function () { cfRtMergeQueued = false; cfRealtimeDrainChanges_(); });
}
function cfRealtimeOnChange() {
  cfRtChangePending = true;
  cfRealtimeDrainChanges_();
}
function cfRealtimeStart() {
  if (cfRtSocket || cfRtStarting) return Promise.resolve();
  if (!cfRealtimeShouldRun()) return Promise.resolve();
  cfRtStarting = true;
  return new Promise(function (resolve) {
    const c = cfConfig();
    let ws;
    try {
      ws = new WebSocket(c.url.replace(/^http/, 'ws') + '/live?token=' + encodeURIComponent(c.token));
    } catch (e) { cfRtStarting = false; cfRealtimeArmRetry(); resolve(); return; }
    /* A stream that never opens would hang the promise forever; give it 8 s. */
    const openTimer = setTimeout(function () {
      if (cfRtSocket !== ws) { try { ws.close(); } catch (e) {} }
    }, 8000);
    ws.addEventListener('open', function () {
      clearTimeout(openTimer);
      cfRtSocket = ws;
      cfRtStarting = false;
      cfRealtimeRetryClear();
      cfRtFatal = false;
      cfRtLastPong = Date.now();
      if (cfRtHeartbeatTimer) clearInterval(cfRtHeartbeatTimer);
      cfRtHeartbeatTimer = setInterval(function () {
        if (cfRtSocket !== ws || ws.readyState !== 1) return;
        if (Date.now() - cfRtLastPong > CF_RT_PONG_TIMEOUT_MS) { try { ws.close(); } catch (e) {} return; }
        try { ws.send('ping'); } catch (e) { try { ws.close(); } catch (ignore) {} }
      }, CF_RT_HEARTBEAT_MS);
      if (typeof syncStatusRender === 'function') { try { syncStatusRender(); } catch (e) {} }
      resolve();
    });
    ws.addEventListener('message', function (ev) {
      if (ev.data === 'pong') { cfRtLastPong = Date.now(); return; }
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || msg.type !== 'change') return;
      cfRtLastPong = Date.now();
      cfRtRetryMs = 1000;                       // a healthy message resets the backoff
      cfRealtimeOnChange();
    });
    ws.addEventListener('close', function (ev) {
      clearTimeout(openTimer);
      if (cfRtHeartbeatTimer) { clearInterval(cfRtHeartbeatTimer); cfRtHeartbeatTimer = null; }
      if (cfRtSocket === ws) cfRtSocket = null;
      cfRtStarting = false;
      if (typeof syncStatusRender === 'function') { try { syncStatusRender(); } catch (e) {} }
      /* 1008 policy violation / 1002 protocol error are the server refusing the
         token; retrying cannot help until the token changes. */
      if (ev && (ev.code === 1008 || ev.code === 1002)) cfRtFatal = true;
      cfRealtimeArmRetry();
      resolve();
    });
    ws.addEventListener('error', function () {
      /* 'close' always follows and does the bookkeeping; nothing to do here. */
    });
  });
}

/* The endpoint is reachable and the token works. Used by the cloud card's test. */
async function cfPing() {
  const c = cfConfig();
  const res = await fetch(c.url + '/records?since=', { headers: cfHeaders_() });
  if (!res.ok) throw new Error(await cfErrorText_(res));
  return await res.json();
}

