/* Texpark Pro — sync queue.
   The old app posted with mode:'no-cors' and then showed "✓ sent" without ever
   reading a response. This version verifies, retries, and queues while offline. */

const SYNC_KEY = 'texpark_pro_syncq';

var syncQueue = [];
let syncTimer = null;
/* syncFlush is not re-entrant. Before cloud.js, commit() queued one job and
   syncPush's flush usually found nothing else to do; now a single save queues many
   records, so the flush that each syncPush starts could run nested over the same
   queue. A commit kicks off one flush at the end; the nested ones just return. */
let syncFlushing = false;

function syncLoad() {
  try { syncQueue = JSON.parse(localStorage.getItem(SYNC_KEY) || '[]'); }
  catch (e) { syncQueue = []; }
  syncRequeueBackups();
}
function syncSave() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(syncQueue.slice(-500))); } catch (e) {}
}
function syncUrl() { return (db?.settings?.syncUrl || '').trim(); }

/* A backup is a full snapshot, so an older queued one is worthless the moment a
   newer snapshot for the same device is queued - it would write yesterday's books
   over today's. Keep only the newest backup job per device and drop the rest. */
function syncCoalesceBackups() {
  const latest = {};
  syncQueue.forEach(j => {
    if (j.type !== 'backup') return;
    const dev = (j.data && j.data.device) || '';
    // On an equal timestamp the later entry wins, which is the one whose payload
    // was serialised most recently.
    if (!latest[dev] || String(j.at || '') >= String(latest[dev].at || '')) latest[dev] = j;
  });
  syncQueue = syncQueue.filter(j =>
    j.type !== 'backup' || latest[(j.data && j.data.device) || ''] === j);
}

/* Once a device's snapshot has actually reached the sheet, every earlier queued or
   parked snapshot for that same device is dead weight: it is an older set of books
   and re-uploading it would only overwrite the newer one that just landed. Drop
   them, but never a job stamped later than the one that succeeded (that is a newer
   snapshot still waiting to go) and never a non-backup job. */
function syncDropSupersededBackups(device, succeededAt) {
  const before = syncQueue.length;
  syncQueue = syncQueue.filter(j => {
    if (j.type !== 'backup') return true;
    if (((j.data && j.data.device) || '') !== device) return true;
    return String(j.at || '') > String(succeededAt || '');
  });
  return before - syncQueue.length;
}

/* The oversized-cell failure is gone now that Code.gs chunks the backup, so a job
   that was parked as failed by "Backup too large" only needs one more attempt.
   Marked so it is requeued once rather than on every load. */
function syncRequeueBackups() {
  let changed = false;
  syncQueue.forEach(j => {
    if (j.type === 'backup' && j.state === 'failed' && !j.reTried && /too large|too big|cell/i.test(j.error || '')) {
      j.state = 'pending';
      j.tries = 0;
      j.reTried = true;
      changed = true;
    }
  });
  if (changed) syncSave();
}

/* Queue one job. type is what Code.gs dispatches on. `via` selects the transport:
   the default is the Sheets endpoint; 'firestore' jobs are sent by cloud.js to
   Firestore and never POSTed to the sheet, so the two paths share one durable
   queue and one retry/backoff instead of each growing its own. */
function syncPush(type, data, label, via) {
  if (via !== 'firestore' && !syncUrl()) return;
  syncQueue.push({
    id: id(),
    type,
    data,
    label: label || type,
    via: via || 'sheet',
    tries: 0,
    state: 'pending',            // pending | failed
    at: new Date().toISOString(),
    error: ''
  });
  syncCoalesceBackups();
  syncSave();
  syncStatusRender();
  syncFlush();
}

/* The sheet's own verdict on a reply, and an honest reason when it is not one.
   Apps Script answers 200 whether it wrote or refused, and a proxy or a login page
   answers 200 with HTML. Only a JSON object with success not-false is a save, and
   when it is not, the owner is told which of the two it was instead of a bare
   "failed" - an HTML page means the URL is wrong or the deployment is stale, not
   that the data was too big. */
function syncReply(txt, status) {
  const body = String(txt == null ? '' : txt).trim();
  if (!body) return { ok: false, message: 'The sheet returned an empty reply (HTTP ' + status + ').' };
  try {
    const j = JSON.parse(body);
    if (j && j.success !== false) return { ok: true, message: j.message || 'ok' };
    return { ok: false, message: (j && j.message) || ('the sheet refused the write (HTTP ' + status + ')') };
  } catch (e) { /* not JSON */ }
  if (/^\s*<(!doctype|html)/i.test(body)) {
    return { ok: false, message: 'The sync URL did not return the app script - it sent an HTML page. Check the /exec URL and that the deployment is up to date.' };
  }
  if (/success|true/i.test(body)) return { ok: true, message: body.slice(0, 120) };
  return { ok: false, message: body.slice(0, 160) || ('HTTP ' + status) };
}

async function syncFlush() {
  if (!syncUrl() && !(typeof cloudConfigured === 'function' && cloudConfigured())) { syncStatusRender(); return; }
  if (syncTimer) return;
  if (syncFlushing) return;            // a flush is already walking the queue
  syncFlushing = true;
  const attempted = {};
  try {
    const url = syncUrl();
    // Drain until nothing new is left. A commit adds its jobs while the first of
    // them is still in flight, so a single snapshot of the queue would leave the
    // rest waiting for the retry timer; picking the next pending job each turn
    // sends them all in one pass.
    for (let guard = 0; guard < 1000; guard++) {
      const job = syncQueue.find(j => j.state === 'pending' && !attempted[j.id]);
      if (!job) break;
      attempted[job.id] = true;
      try {
        // A Firestore job is sent by cloud.js, not POSTed to the sheet. Its failure
        // mode (quota, offline) degrades the device to the Sheet path, and the job
        // stays queued for the retry timer.
        if (job.via === 'firestore') {
          const r = await cloudSendJob(job);
          if (!r.ok) {
            job.tries++;
            job.error = String(r.message || r);
            if (job.tries >= 5) job.state = 'failed';
            continue;
          }
          syncQueue = syncQueue.filter(j => j.id !== job.id);
          syncSave();
          continue;
        }
        if (!url) { continue; }   // a sheet job with no URL simply waits
        const res = await fetch(url, {
          method: 'POST',
          // text/plain avoids the CORS preflight that Apps Script cannot answer.
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ type: job.type, data: job.data })
        });
        // We now actually READ the reply instead of assuming success.
        const txt = await res.text();
        const verdict = syncReply(txt, res.status);
        if (!verdict.ok) throw new Error(verdict.message);

        syncQueue = syncQueue.filter(j => j.id !== job.id);
        // This device's snapshot is now in the sheet; any older backup job for it -
        // including ones parked as failed - is stale and must not go up later.
        if (job.type === 'backup') syncDropSupersededBackups((job.data && job.data.device) || '', job.at);
        syncSave();
      } catch (e) {
        job.tries++;
        job.error = String(e.message || e);
        // Keep retrying on a backoff; after 5 tries mark failed but never drop.
        if (job.tries >= 5) job.state = 'failed';
      }
    }
    syncStatusRender();
  } finally {
    syncFlushing = false;
  }
  if (syncQueue.some(j => j.state === 'pending')) {
    syncTimer = setTimeout(() => { syncTimer = null; syncFlush(); }, 8000);
  }
}

function syncRetryAll() {
  syncQueue.forEach(j => { j.state = 'pending'; j.tries = 0; j.error = ''; });
  syncSave();
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  syncFlush();
}

function syncCounts() {
  const pending = syncQueue.filter(j => j.state === 'pending').length;
  const failed = syncQueue.filter(j => j.state === 'failed').length;
  return { pending, failed };
}

function syncStatusRender() {
  const el = document.getElementById('syncBadge');
  if (!el) return;
  const { pending, failed } = syncCounts();
  const on = !!syncUrl();
  let cls = 'sync-blue', txt = 'Sync off';
  if (on && failed) { cls = 'sync-red'; txt = failed + ' failed' + (pending ? ' · ' + pending + ' pending' : ''); }
  else if (on && pending) { cls = 'sync-amber'; txt = pending + ' pending'; }
  else if (on) { cls = 'sync-green'; txt = '✓ All synced'; }
  el.className = 'sync-badge ' + cls;
  el.textContent = txt;
}

/* ===================== cloud backup / restore =====================
   The queue above only ever PUSHES, so losing a phone or a PC lost everything
   that machine had entered — nothing could read the data back. These two paths
   close that hole: cloudBackupNow() writes a full snapshot into the sheet,
   cloudRestore() reads the newest one back. */

function cloudBackupNow(quiet) {
  if (!syncUrl()) { if (!quiet) alert('First set the Google Sheet sync URL in Settings.'); return false; }
  try {
    syncPush('backup', {
      device: deviceTag(),
      date: today(),
      version: (typeof APP_VERSION === 'string' ? APP_VERSION : ''),
      json: JSON.stringify(db)
    }, 'Cloud backup (' + deviceTag() + ')');
    if (!quiet) alert('Cloud backup sent (' + deviceTag() + '). Check the sync badge to confirm.');
    return true;
  } catch (e) {
    if (!quiet) alert('Could not send the backup: ' + e.message);
    return false;
  }
}

async function cloudListDevices() {
  const url = syncUrl();
  if (!url) { alert('First set the Google Sheet sync URL in Settings.'); return []; }
  const res = await fetch(url + '?action=pull', { method: 'GET' });
  const txt = await res.text();
  let j = {};
  try { j = JSON.parse(txt); } catch (e) { throw new Error('The sheet did not return a valid response'); }
  if (j.success === false) throw new Error(j.message || 'pull failed');
  return j.devices || [];
}

/* Pull a device's newest cloud snapshot back into this browser. This replaces
   local data, so it always asks first and keeps a local snapshot behind. */
async function cloudRestore(device) {
  const url = syncUrl();
  if (!url) return alert('First set the Google Sheet sync URL in Settings.');
  const dev = device || deviceTag();
  const res = await fetch(url + '?action=pull&device=' + encodeURIComponent(dev), { method: 'GET' });
  const txt = await res.text();
  let j = {};
  try { j = JSON.parse(txt); } catch (e) { throw new Error('The sheet did not return a valid response'); }
  if (!j.success) throw new Error(j.message || 'pull failed');
  if (!j.json) return alert('The sheet has no backup for "' + dev + '".');
  if (!confirm('Restore "' + dev + '" backup from ' + (j.date || '') + ' and replace the current data?')) return;
  restoreFromJSONText(j.json);
}

function restoreFromJSONText(text, opts) {
  try {
    const incoming = JSON.parse(text);
    if (!incoming || typeof incoming !== 'object') throw new Error('bad payload');
    snapshot();                       // local safety copy before the swap
    db = migrate(incoming);
    if (!db.users || !db.users.length) db.users = defaultUsers();
    if (!commit()) return;
    if (!opts || !opts.silent) alert('Restored from the cloud. The page will reload.');
    location.reload();
  } catch (e) {
    alert('The backup is not valid: ' + e.message);
  }
}

/* ===================== automatic pull (both directions, no button) =====================
   Backup alone made the sheet a graveyard: everything this device ever did went up,
   nothing ever came down, so the PC and the phone each showed only their own work
   and the newest snapshot silently replaced the other's. cloudAutoSync() closes the
   loop. It pushes first, then pulls every device's snapshot and merges.

   Pushing first matters: if this machine's work only exists locally, a pull before
   the push would merge the cloud over the top of it. Sending it up first makes the
   cloud a superset, and the merge then has both sides of every record to compare.

   The merge is per record, not per snapshot - see mergeCloudInto_ in db.js. Newer
   wins, deletes stick, and nothing that only one side knew about is dropped. */

const AUTOSYNC_KEY = 'texpark_pro_autosync_at';
const AUTOSYNC_MIN_MS = 8000;          // one pull at a time; opening pages in a row is common
var autoSyncBusy = false;

var cloudPushTimer = null;

/* Saves come in bursts - a memo, then a stock top-up, then a correction - so the
   upload waits for a short quiet period and sends one snapshot for all of them. */
const CLOUD_PUSH_QUIET_MS = 2000;

function scheduleCloudPush() {
  if (!syncUrl()) return;
  if (typeof session === 'undefined' || !session) return;
  if (cloudPushTimer) clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(function () {
    cloudPushTimer = null;
    if (typeof window !== 'undefined') window.cloudDirty = false;
    cloudBackupNow(true);
  }, CLOUD_PUSH_QUIET_MS);
}

/* Send anything still waiting. Called when the tab is hidden, which is the last
   reliable moment - unlike beforeunload, a hidden tab keeps running long enough
   for the request to leave. */
function flushCloudPush() {
  if (cloudPushTimer) { clearTimeout(cloudPushTimer); cloudPushTimer = null; }
  if (typeof window !== 'undefined') window.cloudDirty = false;
  try { cloudBackupNow(true); } catch (e) { /* offline is normal */ }
}

function autosyncEnabled() {
  return !!syncUrl() && !(db && db.settings && db.settings.autoPull === false);
}

/* Push the snapshot and wait for it. cloudBackupNow() queues the upload and returns
   immediately, which is right for a button but wrong before a pull: the pull would
   race the upload and read a cloud that does not have this machine's work yet. On
   failure the queue still holds a copy via cloudBackupNow(), so nothing is lost. */
async function pushBackupNow() {
  const url = syncUrl();
  if (!url) return false;
  const payload = {
    type: 'backup',
    data: {
      device: deviceTag(),
      date: today(),
      version: (typeof APP_VERSION === 'string' ? APP_VERSION : ''),
      json: JSON.stringify(db)
    }
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const txt = await res.text();
    // Same honesty as syncFlush: an HTML page is not a save even with a 200.
    if (syncReply(txt, res.status).ok) return true;
  } catch (e) { /* fall through to the queue */ }
  cloudBackupNow(true);
  return false;
}

/* Called on login/open and whenever the tab becomes visible again, which is the
   moment someone comes back to look at the numbers. */
function cloudAutoSync(reason) {
  if (!autosyncEnabled()) return;
  // Only once someone is signed in. Running it over the login screen would rewrite
  // the books under a user who has not yet chosen an account - and the login form
  // itself is built from db, so it would flicker as the merge lands.
  if (typeof session === 'undefined' || !session) return;
  if (autoSyncBusy) return;
  let last = 0;
  try { last = Number(localStorage.getItem(AUTOSYNC_KEY) || 0); } catch (e) {}
  if (Date.now() - last < AUTOSYNC_MIN_MS) return;
  autoSyncBusy = true;
  try { localStorage.setItem(AUTOSYNC_KEY, String(Date.now())); } catch (e) {}

  // Flush what is already queued (memos, stock, deliveries) before reading the cloud.
  try { syncFlush(); } catch (e) {}

  pullAndMerge().catch(function () { /* offline is normal; the next open retries */ })
    .then(function () { autoSyncBusy = false; });
}

/* One run of it, exposed so the tests can drive it without the timers. */
async function pullAndMerge() {
  const url = syncUrl();
  if (!url) return { merged: false, reason: 'no url' };

  // Ordered deliberately: our own state goes up first, so the pull that follows
  // merges against a cloud that already contains this machine's work. Pulling
  // first would let the merge overwrite a memo this device had not uploaded yet.
  await pushBackupNow();

  const res = await fetch(url + '?action=pullall', { method: 'GET' });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch (e) { throw new Error('The sheet did not return a valid response'); }
  if (!j.success) throw new Error(j.message || 'pull failed');
  if (!j.json) return { merged: false, reason: 'cloud empty' };

  let all = {};
  try { all = JSON.parse(j.json); } catch (e) { return { merged: false, reason: 'bad payload' }; }

  let merged = false;
  for (const dev of Object.keys(all)) {
    if (!all[dev]) continue;
    let incoming = null;
    try { incoming = JSON.parse(all[dev]); } catch (e) { continue; }
    if (!incoming || typeof incoming !== 'object') continue;
    if (!merged) { snapshot(); merged = true; }   // one safety copy before any merge
    mergeCloudInto_(migrate(incoming));
  }
  if (!merged) return { merged: false, reason: 'nothing to merge' };
  if (!commit()) return { merged: false, reason: 'save failed' };
  // Push the merged result back up, so the other devices inherit what this one just
  // learned instead of each machine holding a different half of the picture.
  await pushBackupNow();
  return { merged: true };
}
