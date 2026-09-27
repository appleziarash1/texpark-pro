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
  if (!syncUrl()) { if (!quiet) alert('Age Settings-e Google Sheet sync URL bosan.'); return false; }
  try {
    syncPush('backup', {
      device: deviceTag(),
      date: today(),
      version: (typeof APP_VERSION === 'string' ? APP_VERSION : ''),
      json: JSON.stringify(db)
    }, 'Cloud backup (' + deviceTag() + ')');
    if (!quiet) alert('Cloud backup pathano holo (' + deviceTag() + '). Sync badge dekhe confirm korun.');
    return true;
  } catch (e) {
    if (!quiet) alert('Backup pathate parlam na: ' + e.message);
    return false;
  }
}

async function cloudListDevices() {
  const url = syncUrl();
  if (!url) { alert('Age Settings-e Google Sheet sync URL bosan.'); return []; }
  const res = await fetch(url + '?action=pull', { method: 'GET' });
  const txt = await res.text();
  let j = {};
  try { j = JSON.parse(txt); } catch (e) { throw new Error('Sheet theke thik response ashe ni'); }
  if (j.success === false) throw new Error(j.message || 'pull failed');
  return j.devices || [];
}

/* Pull a device's newest cloud snapshot back into this browser. This replaces
   local data, so it always asks first and keeps a local snapshot behind. */
async function cloudRestore(device) {
  const url = syncUrl();
  if (!url) return alert('Age Settings-e Google Sheet sync URL bosan.');
  const dev = device || deviceTag();
  const res = await fetch(url + '?action=pull&device=' + encodeURIComponent(dev), { method: 'GET' });
  const txt = await res.text();
  let j = {};
  try { j = JSON.parse(txt); } catch (e) { throw new Error('Sheet theke thik response ashe ni'); }
  if (!j.success) throw new Error(j.message || 'pull failed');
  if (!j.json) return alert('"' + dev + '" er kono backup sheet-e nei.');
  if (!confirm('"' + dev + '" er ' + (j.date || '') + ' er backup niye ekhonkar data replace korben?')) return;
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
    if (!opts || !opts.silent) alert('Cloud theke restore hoyeche. Page reload hobe.');
    location.reload();
  } catch (e) {
    alert('Backup ta thik na: ' + e.message);
  }
}
