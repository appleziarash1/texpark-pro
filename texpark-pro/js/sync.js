/* Texpark Pro — sync queue.
   The old app posted with mode:'no-cors' and then showed "✓ sent" without ever
   reading a response. This version verifies, retries, and queues while offline. */

const SYNC_KEY = 'texpark_pro_syncq';

var syncQueue = [];
let syncTimer = null;

function syncLoad() {
  try { syncQueue = JSON.parse(localStorage.getItem(SYNC_KEY) || '[]'); }
  catch (e) { syncQueue = []; }
}
function syncSave() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(syncQueue.slice(-500))); } catch (e) {}
}
function syncUrl() { return (db?.settings?.syncUrl || '').trim(); }

/* Queue one job. type is what Code.gs dispatches on. */
function syncPush(type, data, label) {
  if (!syncUrl()) return;
  syncQueue.push({
    id: id(),
    type,
    data,
    label: label || type,
    tries: 0,
    state: 'pending',            // pending | failed
    at: new Date().toISOString(),
    error: ''
  });
  syncSave();
  syncStatusRender();
  syncFlush();
}

async function syncFlush() {
  if (!syncUrl()) { syncStatusRender(); return; }
  if (syncTimer) return;
  const url = syncUrl();
  const pending = syncQueue.filter(j => j.state === 'pending');
  if (!pending.length) { syncStatusRender(); return; }

  for (const job of pending) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        // text/plain avoids the CORS preflight that Apps Script cannot answer.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ type: job.type, data: job.data })
      });
      // We now actually READ the reply instead of assuming success.
      const txt = await res.text();
      let ok = false, msg = '';
      try {
        const j = JSON.parse(txt);
        ok = j.success !== false;
        msg = j.message || '';
      } catch (e) {
        ok = res.ok && /success|true/i.test(txt);
        msg = txt.slice(0, 120);
      }
      if (!ok) throw new Error(msg || ('HTTP ' + res.status));

      syncQueue = syncQueue.filter(j => j.id !== job.id);
      syncSave();
    } catch (e) {
      job.tries++;
      job.error = String(e.message || e);
      // Keep retrying on a backoff; after 5 tries mark failed but never drop.
      if (job.tries >= 5) job.state = 'failed';
    }
  }
  syncStatusRender();
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
    let ok = false;
    try { ok = JSON.parse(txt).success !== false; } catch (e) { ok = res.ok; }
    if (ok) return true;
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
