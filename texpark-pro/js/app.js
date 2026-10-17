/* Texpark Pro â€” UI + actions. */

/* Bump this together with CACHE in sw.js. Shown in Settings so a phone can
   prove which build it is actually running. */
const APP_VERSION = '2027-01-01.12';

/* Where the released build is published. Used only to tell an owner whose copy
   was opened from a stale address where the current one lives. */
const RELEASE_URL = 'https://appleziarash1.github.io/texpark-pro';

/* Numeric version compare, so 2027-01-01.10 sorts above 2027-01-01.9. A plain
   string compare puts .10 first, which is the wrong way round for releases. */
function versionNewer(a, b) {
  const parts = v => String(v || '').split(/[^0-9]+/).filter(s => s.length).map(Number);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const xi = i < x.length ? x[i] : 0, yi = i < y.length ? y[i] : 0;
    if (xi !== yi) return xi > yi;
  }
  return false;
}

/* ---- live update: a device picks up a new release without a manual reload ----
   GitHub Pages serves the app with an ETag, and that ETag changes the moment a
   new build is published. A HEAD request reads it in a few bytes, so a device can
   tell a release has landed even when APP_VERSION was not bumped - the version
   number only moves when the APK has to be rebuilt, which is a much rarer event.

   It reloads only when it is safe: never while the owner is typing, never with a
   modal open, never on the New Sales Memo page, and never with unsent cloud
   changes. A reload keeps this device's data (it lives in localStorage and in the
   sheet); throwing away a half-written memo would be far worse than an old screen.
   The new release is recorded before reloading, so a device cannot reload in a
   loop even if a host serves a stale ETag. */
const LIVE_UPDATE_KEY = 'texpark_pro_live_etag';
function liveUpdateTag_(next) {
  try {
    if (next) { localStorage.setItem(LIVE_UPDATE_KEY, next); return next; }
    return localStorage.getItem(LIVE_UPDATE_KEY) || '';
  } catch (e) { return ''; }
}
function updatePaused_() {
  if (typeof document === 'undefined' || document.hidden) return true;
  try {
    const a = document.activeElement;
    if (a && a.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    if (a && a.isContentEditable) return true;
  } catch (e) {}
  const modals = document.querySelectorAll ? document.querySelectorAll('.modal.show') : null;
  if (modals && modals.length) return true;
  if (typeof currentPage !== 'undefined' && currentPage === 'memo') return true;
  return typeof cloudDirty !== 'undefined' && cloudDirty;
}
function applyLiveUpdate_() {
  return fetch(RELEASE_URL + '/js/app.js', { method: 'HEAD', cache: 'no-store' })
    .then(r => r.headers.get('etag') || r.headers.get('last-modified') || '')
    .then(tag => {
      if (!tag) return;
      const last = liveUpdateTag_();
      if (!last) { liveUpdateTag_(tag); return; }   /* first run: just remember it */
      if (tag === last) return;                      /* same release as last time */
      if (updatePaused_()) return;                   /* not a safe moment - try again later */
      liveUpdateTag_(tag);
      location.reload();
    })
    .catch(() => {});
}
window.addEventListener('load', function () {
  setTimeout(applyLiveUpdate_, 4000);
  setInterval(function () { if (!document.hidden) applyLiveUpdate_(); }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) applyLiveUpdate_(); });
});

/* ---- live delta pull: a change on another device lands almost at once ----
   Firestore is the primary sync path when it is configured, but it used to be read
   only on open, on visibilitychange, and on a 30 s timer - so a memo typed on the
   phone could take up to 30 s to reach the PC. This is the fast lane.

   It is adaptive: while the owner is using the app it pulls every ~2 s, so another
   device's change lands almost immediately; after a short idle it backs off to a
   calm ~10 s. That keeps it "live" while it matters and cheap (a delta read is a few
   documents, not the whole book) the rest of the time.

   It reuses the ONE merge the sync tests already prove (cloudPullMerge ->
   cloudMergeDelta -> mergeCloudInto_ -> commit); it adds no second definition of
   "newer wins". It runs only the Firestore delta pull, never the slow Sheet pull, so
   frequent ticks stay cheap. It stands down while the tab is hidden, while a sync is
   already in flight, and while this device has an unsent edit (so it cannot race the
   device's own upload). The 30 s cloudAutoSync keeps running underneath as the
   safety net; its own 8 s floor stops it double-pulling right after a live tick. */
const LIVE_SYNC_ACTIVE_MS = 2000;      // the stream is down: poll fast, it is the only path
const LIVE_SYNC_IDLE_MS   = 2000;     // the stream is up: push does the work, poll is a safety net
const LIVE_ACTIVE_WINDOW_MS = 60000;   // recently touched the app = "active"
/* A cold open is the one moment the owner is definitely watching, and it is also the
   moment sign-in may still be in flight. Polling at the idle cadence until they
   happen to touch the screen is what made the first load feel 20 s behind. Stay on
   the fast cadence for a short window after load so the first pull lands as soon as
   the session is ready, then fall back. */
const LIVE_BOOT_WINDOW_MS = 20000;
var liveSyncInFlight = false;
var liveLastActivityAt = 0;
var liveBootAt = Date.now();

function liveNoteActivity_() { liveLastActivityAt = Date.now(); }
/* Cadence depends on whether the push stream is carrying the load:
   - stream connected  -> calm poll (15 s) as a belt-and-braces net; the ~0.3 s push
     is what actually delivers a change, so a fast poll here would only burn the free
     read quota for no visible gain.
   - stream down/absent -> fast poll (2 s): with no push, polling IS the path, and this
     is what makes the app still feel live under the old Sheet-only setup (no Firebase).
   - cold open / recent touch -> fast for a moment regardless, so the first change and
     the one the owner is watching for never wait out a tick. */
function livePushHealthy_() {
  return typeof fbRealtimeLive === 'function' && fbRealtimeLive();
}
/* Flash the sync badge when a change from another device lands, so "real time" is
   something the owner sees rather than has to trust. Pure UI; swallows everything. */
var livePulseTimer = null;
function livePulse_() {
  try {
    var el = document.getElementById('syncBadge');
    if (!el) return;
    el.classList.remove('sync-bump');
    void el.offsetWidth;                 // restart the animation if it is already running
    el.classList.add('sync-bump');
    if (typeof syncStatusRender === 'function') syncStatusRender();
    if (livePulseTimer) clearTimeout(livePulseTimer);
    livePulseTimer = setTimeout(function () {
      livePulseTimer = null;
      try { el.classList.remove('sync-bump'); } catch (e) {}
      if (typeof syncStatusRender === 'function') syncStatusRender();
    }, 700);
  } catch (e) {}
}
function liveDelay_() {
  if (!livePushHealthy_()) return LIVE_SYNC_ACTIVE_MS;
  const warm = (Date.now() - liveLastActivityAt < LIVE_ACTIVE_WINDOW_MS) ||
               (Date.now() - liveBootAt < LIVE_BOOT_WINDOW_MS);
  return warm ? LIVE_SYNC_ACTIVE_MS : LIVE_SYNC_IDLE_MS;
}
async function liveDeltaPull_() {
  if (typeof cloudConfigured !== 'function' || !cloudConfigured()) return;
  if (typeof session === 'undefined' || !session) return;
  const cfOn = typeof cfBackendOn === 'function' && cfBackendOn();
  if (!cfOn && typeof fbSignedIn === 'function' && !fbSignedIn()) return;
  if (typeof cloudBusy !== 'undefined' && cloudBusy) return;
  if (typeof cloudDirty !== 'undefined' && cloudDirty) return;   // our own edit is going up
  if (liveSyncInFlight) return;
  liveSyncInFlight = true;
  try { await cloudPullMerge(); } catch (e) { /* offline is normal; the 30 s net retries */ }
  finally { liveSyncInFlight = false; }
}
window.addEventListener('load', function () {
  ['pointerdown', 'keydown', 'input', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, liveNoteActivity_, { passive: true, capture: true });
  });
  // Pull once immediately instead of waiting out the first interval. cloudBoot()
  // usually starts the realtime stream first, so this is a no-op on a warm device;
  // on a cold one it is the difference between the first change appearing in ~2 s
  // and waiting a full poll tick. Bounded by the same guards, so it is always safe.
  liveDeltaPull_();
  (function liveLoop() {
    var wait = liveDelay_();
    setTimeout(function () {
      if (!document.hidden) liveDeltaPull_();
      liveLoop();
    }, wait);
  })();
});

const PAGES = [
  { id: 'dashboard',  label: 'Dashboard',      ic: '\u25A3', group: 'Overview' },
  { id: 'orders',     label: 'Orders',         ic: '\u26A1', group: 'Overview' },
  { id: 'memo',       label: 'New Sales Memo', ic: '\uFF0B', group: 'Sales' },
  { id: 'history',    label: 'Memo History',   ic: '\u25F7', group: 'Sales' },
  { id: 'delivery',   label: 'Delivery',       ic: '\u2713', group: 'Sales' },
  { id: 'customers',  label: 'Customers',      ic: '\u2659', group: 'Sales' },
  { id: 'ledger',     label: 'Customer Ledger',ic: '\u2261', group: 'Sales' },
  { id: 'purchase',   label: 'Purchases',      ic: '\u21A5', group: 'Purchase' },
  { id: 'supplier',   label: 'Suppliers',      ic: '\u21A6', group: 'Purchase' },
  { id: 'products',   label: 'Products',       ic: '\u25A4', group: 'Inventory' },
  { id: 'stock',      label: 'Stock',          ic: '\u25A5', group: 'Inventory' },
  { id: 'stocklog',   label: 'Stock Ledger',   ic: '\u2263', group: 'Inventory' },
  { id: 'profit',     label: 'Profit / Item',  ic: '\u2197', group: 'Accounts' },
  { id: 'pl',         label: 'Profit & Loss',  ic: '\u2211', group: 'Accounts' },
  { id: 'expense',    label: 'Expenses',       ic: '\u2212', group: 'Accounts' },
  { id: 'ledgerreport', label: 'Ledger / Ageing', ic: '\u2696', group: 'Accounts' },
  { id: 'users',      label: 'Users & Roles',  ic: '\u26BF', group: 'Admin' },
  { id: 'settings',   label: 'Settings',       ic: '\u2699', group: 'Admin' },
  { id: 'backup',     label: 'Backup / Data',  ic: '\u2913', group: 'Admin' }
];

var memoDraft = { items: [] };
var editingMemoId = null;
/** Which memo the preview modal is showing, so its Print/Save buttons act on that
 *  one. Cleared on close: a stale id would export the memo looked at last. */
var viewingMemoId = null;
var purchaseDraft = { items: [] };
var currentPage = "dashboard";

function set(elId, v) { const e = document.getElementById(elId); if (e) e.textContent = v; }
/* Read an optional input's value without crashing when the element is absent
   (e.g. a stripped-down build or a test shim that never created it). */
function valueOfEl_(elId) { const e = document.getElementById(elId); return e ? (e.value || '') : ''; }
function statBox(label, value, sub) {
  return '<div class="card stat"><div class="label">' + label + '</div><div class="value">' + value + '</div>' +
    (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
}

/* ===================== boot ===================== */
/* Booting waits until IndexedDB has opened, any old data has been copied and verified,
   and the in-memory mirror is ready. Browser builds refuse to run without IndexedDB:
   volatile storage would make a successful-looking save disappear on reload. Node
   tests use a memory-only store. */
function boot() {
  // The memo sheet's stylesheet, so the preview is not unstyled HTML. First, before
  // anything can render a memo.
  memoCssTag();
  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
  if (!idbAvailable && !isNode) {
    alert('IndexedDB is not available. Texpark Pro needs IndexedDB to store data safely. Your saved data has not been changed.');
    return Promise.resolve(false);
  }
  if (typeof storageInit === 'function' && idbAvailable) {
    return storageInit(STORAGE_KEYS).then(function (ready) {
      if (!ready) throw new Error('IndexedDB could not be initialized or verified.');
      bootFromStore();
      return true;
    }).catch(function (error) {
      alert('Texpark Pro could not open its IndexedDB database. Your existing data was left unchanged. ' + (error && error.message || ''));
      return false;
    });
  }
  bootFromStore();
  return Promise.resolve(true);
}

/* Everything after the store is ready. Kept separate so the async and synchronous
   paths run the identical sequence and cannot drift. */
function bootFromStore() {
  db = loadDB();
  if (!db.users || !db.users.length) db.users = defaultUsers();
  // Before anything reads the settings: a ?sync=<url> link is how a phone gets the
  // sheet URL, which cannot arrive over the sync itself.
  adoptSyncFromLink();
  // The merge compares each commit against this index to see what moved, so it has
  // to be seeded with what was actually loaded - otherwise the very first save
  // would look like every record was created and stamp the lot with one timestamp.
  lastCommitted = frozenIndex_(db);
  syncLoad();
  if (restoreSession()) {
    enterApp();
    // Opening the app while already signed in is the same moment as logging in:
    // push what is pending, then pull the other devices' work down.
    syncFlush();
    cloudAutoSync('open');
    // Live Firestore sync, kept separate from the Sheet path above so a device with
    // no cloud keys is untouched. Quiet on boot: it never pops an alert.
    if (typeof cloudBoot === 'function') cloudBoot();
  } else {
    buildLogin();
  }
}

/* ===================== session ===================== */
/* The session used to live only in memory, so any reload dropped the owner back
   to the login screen. That happened on its own, too: the service worker reloads
   the page whenever its bytes change. Persist the signed-in user and restore it
   here, so a reload keeps you signed in until you press Sign out. */
const SESSION_KEY = 'texpark_pro_session';

function saveSession(user) {
  session = { userId: user.id, username: user.username, name: user.name, role: user.role };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      userId: user.id, username: user.username, name: user.name, role: user.role, pass: user.pass
    }));
  } catch (e) {}
}

function clearSession() {
  session = null;
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}

/* Bring back a persisted session, but only while the user still exists, is still
   active, and has not changed their password since the session was written. The
   stored password hash is a cheap version stamp: changing the password signs out
   every device that was signed in with the old one. */
function restoreSession() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { saved =×n8Û»h‘éì¶»§q«^vRævWD—FVÒ„ôÄEô´U’“°¢–b‚&r’&WGW&âÆW'B‚uF†RöÆBFF‡FW‡&µö&—¥÷c’—2æ÷BöâF†—22âr“°¢–b‚6öæf—&Ò‚t–×÷'BF†RöÆBÂw2&öGV7G2Â7W7FöÖW'2Â7Fö6²æBÖVÖ÷3òF†R7W'&VçBFFv–ÆÂ&RÖW&vVBâr’’&WGW&ã°¢G'’°¢6öç7BòÒ¥4ôâç'6R‡&r“°¢ÆWB&öBÒÂ7W7BÒÂÖVÖòÒÂ7Fö6²Ò° ¢6öç7BÖÒ·Ó°¢†òç&öGV7G2ÇÂµÒ’æf÷$V6‚‡Óâ°¢ÆWBW‚ÒF"ç&öGV7G2æf–æB‡‚Óâ‚ææÖRçFôÆ÷vW$66R‚’ÓÓÒ7G&–ær‡ææÖRÇÂrr’çFôÆ÷vW$66R‚’“°¢–b‚W‚’°¢W‚Ò²–C¢–B‚’ÂæÖS¢ææÖRÂ6·S¢ç6·RÇÂrrÂ6FVv÷'“¢t–×÷'FVBrÂVæ—C¢w72rÂ&FS¢çVÒ‡ç&FR’Â6÷7C¢ÂfC¢Â&V÷&FW$ÆWfVÃ¢Ó°¢F"ç&öGV7G2çW6‚†W‚“°¢Ğ¢Ö·æ–EÒÒW‚æ–C°¢&öB²³°¢Ò“° ¢†òç7Fö6²ÇÂµÒ’æf÷$V6‚‡2Óâ°¢6öç7Bæ–BÒÖ·2ç&öGV7D–EÓ°¢–b‚æ–B’&WGW&ã°¢6öç7BBÒ7Fö6´öb†æ–B“°¢Bæ÷Væ–ærÒçVÒ‡2æ÷Væ–ær’²çVÒ‡2çW&6†6VB’ÒçVÒ‡2ç6öÆB“°¢Bæ÷Væ–ærÒÖF‚æÖ‚ƒÂBæ÷Væ–ær“°¢BçW&6†6VBÒ²Bç6öÆBÒ°¢–b†çVÒ‡2æ6÷7B’â’Bæ6÷7BÒçVÒ‡2æ6÷7B“°¢Bæf–Æ&ÆRÒ7Fö6´f–Æ&ÆR‡B“°¢Æöu7Fö6²†æ–BÂt÷Væ–ærrÂBæ÷Væ–ærÂt–×÷'BrÂt–×÷'FVBg&öÒöÆBr“°¢7Fö6²²³°¢Ò“° ¢†òæ7W7FöÖW'2ÇÂµÒ’æf÷$V6‚†2Óâ°¢–b‚F"æ7W7FöÖW'2ç6öÖR‡‚Óâ‚ææÖRçFôÆ÷vW$66R‚’ÓÓÒ7G&–ær†2ææÖRÇÂrr’çFôÆ÷vW$66R‚’’’°¢F"æ7W7FöÖW'2çW6‚‡²–C¢–B‚’ÂæÖS¢2ææÖRÂ†öæS¢2ç†öæRÇÂrrÂFG&W73¢2æFG&W72ÇÂrrÒ“°¢7W7B²³°¢Ğ¢Ò“° ¢†òæÖVÖ÷2ÇÂµÒ’æf÷$V6‚†ÒÓâ°¢6öç7BW†—7G2ÒF"æÖVÖ÷2ç6öÖR‡‚Óâ‚æÖVÖôæòÓÓÒÒæÖVÖôæò“°¢–b†W†—7G2’&WGW&ã°¢6öç7B—FV×2Ò†Òæ—FV×2ÇÂµÒ’æÖ†’Óâ‡°¢&öGV7D–C¢Ö¶’ç&öGV7D–EÒÇÂrrÂ&öGV7DæÖS¢’ç&öGV7DæÖRÇÂrrÀ¢G“¢çVÒ†’çG’’Â&FS¢çVÒ†’ç&FR’Â6÷7C¢ÂfC¢ÂÖ÷VçC¢&÷VæC"†çVÒ†’çG’’¢çVÒ†’ç&FR’¢Ò’“°¢6öç7BÖVÖòÒ°¢–C¢–B‚’ÂÖVÖôæó¢ÒæÖVÖôæòÂFFS¢ÒæFFRÂ7W7FöÖW$æÖS¢Òæ7W7FöÖW$æÖRÀ¢7W7FöÖW%†öæS¢Òæ7W7FöÖW%†öæRÇÂrrÂ7W7FöÖW$FG&W73¢Òæ7W7FöÖW$FG&W72ÇÂrrÀ¢—FV×2ÂF÷FÅG“¢çVÒ†ÒçF÷FÅG’’À¢7V'F÷FÃ¢çVÒ†Òç7V'F÷FÂ’ÂF—66÷VçC¢çVÒ†ÒæF—66÷VçB’ÂFVÆ—fW'”6†&vS¢çVÒ†ÒæFVÆ—fW'”6†&vR’À¢fC¢Âw&æEF÷FÃ¢çVÒ†Òæw&æEF÷FÂ’ÂGfæ6S¢çVÒ†ÒæGfæ6R’ÂGVS¢çVÒ†ÒæGVR’À¢6öw3¢Â&öf—C¢Âæ÷FS¢t–×÷'FVBg&öÒc‡&öf—BVæ¶æ÷vâÒæò6÷7B’rÂ6fVDC¢æWrFFR‚’çFô•4õ7G&–ær‚¢Ó°¢F"æÖVÖ÷2çW6‚†ÖVÖò“°¢—FV×2æf÷$V6‚†—BÓâ°¢–b‚—Bç&öGV7D–B’&WGW&ã°¢6öç7B2Ò7Fö6´öb†—Bç&öGV7D–B“°¢2ç6öÆBÒçVÒ‡2ç6öÆB’²çVÒ†—BçG’“°¢2æf–Æ&ÆRÒ7Fö6´f–Æ&ÆR‡2“°¢Æöu7Fö6²†—Bç&öGV7D–BÂu6ÆRrÂÖçVÒ†—BçG’’ÂÖVÖòæÖVÖôæòÂt–×÷'FVBg&öÒcr“°¢Ò“°¢ÖVÖò²³°¢Ò“° ¢6öÖÖ—B‚“°¢ÆW'B‚t–×÷'B6W6ƒ¥Æâr²&öB²r&öGV7EÆâr²7W7B²r7W7FöÖW%Æâr²ÖVÖò²rÖVÖõÆâr²7Fö6²²r7Fö6²&÷rr“°¢Ò6F6‚†R’°¢ÆW'B‚t–×÷'Bf–Ã¢r²RæÖW76vR“°¢Ğ§Ğ ¦gVæ7F–öâ7–æ4æ÷r‚’²7–æ5&WG'”ÆÂ‚“²6WEF–ÖV÷WB‡&VæFW$&6·WÂS“²Ğ ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ&ö÷BÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ§v–æF÷ræFDWfVçDÆ—7FVæW"‚tDôÔ6öçFVçDÆöFVBrÂgVæ7F–öâ‚’°¢ò¢v&ÒF†Rf—&V&6R4D²&Vf÷&RF†R÷væW"6âÆör–âÂ6òF†R&VÇF–ÖR7G&VÒ—0¢&VG’Fò7F'BF†R–ç7FçB6–vâÖ–â6ö×ÆWFW2–ç7FVBöbfWF6†–ærF‡&VRÖöGVÆW0¢f—'7Bâ—BöæÇ’fWF6†W3²—BæWfW"F÷V6†W2F†RFFF‚â¢ğ¢–b‡G—Vöbf%6F´ÆöBÓÓÒvgVæ7F–öâr’²G'’²f%6F´ÆöB‚“²Ò6F6‚†R’·ÒĞ¢&ö÷B‚“°¢ò¢&—fFR66Æ÷VCÒÆ–æ²7FVB–çFòF†R4ÔRF"öæÇ’6†ævW2F†Rg&vÖVçBÂ6ğ¢F†R'&÷w6W"FöW26ÖRÖFö7VÖVçBæf–vF–öâæB&ö÷B‚’æWfW"'Vç2v–âÒF†P¢FWf–6R6B&Ææ²VçF–ÂÖçVÂ&VÆöBâF÷BF†RÆ–æ²F†RÖöÖVçBF†Rg&vÖVç@¢6†ævW2ÂF†Vâ'&–ærF†R6Æ÷VBWÂ6ò7F–ærö÷Væ–ærF†RÆ–æ²&§W7Bv÷&·2"â¢ğ¢v–æF÷ræFDWfVçDÆ—7FVæW"‚v†6†6†ævRrÂgVæ7F–öâ‚’°¢–b‡G—Vöb6Æ÷VDF÷Dg&öÔ†6…òÓÓÒvgVæ7F–öâr’²G'’²6Æ÷VDF÷Dg&öÔ†6…ò‚“²Ò6F6‚†R’·ÒĞ¢Ò“°¢v–æF÷ræFDWfVçDÆ—7FVæW"‚vöæÆ–æRrÂ‚’Óâ²–b‡G—Vöb7–æ5&WVWVTf–ÆVBÓÓÒvgVæ7F–öâr’²G'’²7–æ5&WVWVTf–ÆVB‚“²Ò6F6‚†R’·ÒÒ6Æ÷VDWFõ7–æ2‚vöæÆ–æRr“²–b‡G—Vöb6Æ÷VDWFõ7–æ4æWrÓÓÒvgVæ7F–öâr’6Æ÷VDWFõ7–æ4æWr‚vöæÆ–æRr“²Ò“°¢òòW6‚gVÆÂ6Æ÷VB&6·Wöæ6RF’v†VâF†R—2÷VæVBÂ6òBÆV7BöæP¢òò&V6VçB&W7F÷&&ÆR6÷’Çv—2W†—7G2öfbÖFWf–6Rv—F†÷WBç–öæR&VÖVÖ&W&–ærà¢6WEF–ÖV÷WB†Ö–&TF–Ç”6Æ÷VD&6·WÂC“°¢òò6öÖ–ær&6²FòF†RF"—2v†Vâ7FÆRçVÖ&W'2&RÖ÷7BÆ–¶VÇ’Fò&R&VÆ–WfVBÀ¢òò6ò&RÖ6†V6²F†R6Æ÷VBF†VâFöòÒæ÷BöæÇ’öâ6öÆB÷Vâà¢Fö7VÖVçBæFDWfVçDÆ—7FVæW"‚wf—6–&–Æ—G–6†ævRrÂgVæ7F–öâ‚’°¢–b†Fö7VÖVçBæ†–FFVâ’°¢òòÆVf–ærF†RvR—2F†RÆ7BÖöÖVçBâVç6VçBVF—B6âvòWâ†–F–ær'Vç0¢òòv†–ÆRF†RF"7F–ÆÂvWG2Fòf–æ—6‚&WVW7BÂVæÆ–¶R&Vf÷&WVæÆöBÂv†÷6P¢òòWÆöBF†R'&÷w6W"6æ6VÇ2†Ægv’à¢–b†6Æ÷VDF—'G’’fÇW6„6Æ÷VEW6‚‚“°¢&WGW&ã°¢Ğ¢6Æ÷VDWFõ7–æ2‚wf—6–&ÆRr“°¢òòF"F†Bv2&6¶w&÷VæFVBÖ’†fR†B—G27G&VÒF÷&âF÷vâ'’F†R'&÷w6W"à¢òò6²f÷"—B&6²6ò&WGW&æ–ærFòF†RF"&W7F÷&W2G'VRW6‚Âæ÷B§W7BöÆÂà¢–b‡G—Vöbf%&VÇF–ÖTÆ—fRÓÓÒvgVæ7F–öârbbG—Vöbf%&VÇF–ÖU7F'BÓÓÒvgVæ7F–öârbbf%&VÇF–ÖTÆ—fR‚’’°¢f%&VÇF–ÖU7F'B‚’æ6F6‚†gVæ7F–öâ‚’·Ò“°¢Ğ¢–b‡G—Vöb6÷W&–W$WFõ7–æ2ÓÓÒvgVæ7F–öâr’6÷W&–W$WFõ7–æ2‚“°¢Ò“°¢v–æF÷ræFDWfVçDÆ—7FVæW"‚wvV†–FRrÂgVæ7F–öâ‚’²–b†6Æ÷VDF—'G’’fÇW6„6Æ÷VEW6‚‚“²Ò“°¢ò¢F†Rf—6–&ÆR×F"öÆÂÆ—fW2–âÆ—fTÆö÷&VÆ÷rƒ"2v†–ÆRF†RW6‚7G&VÒ—2F÷vâÀ¢R2v†–ÆR—B—2W’Â6òF–ÖW"f÷"F†R6ÖRVÆÂ†W&RöæÇ’GWÆ–6FVB—Bà¢6÷W&–W"7FGW2¶VW2—G2÷vâ6FVæ6S¢—BæòÖ÷2VæÆW72F†R÷væW"6WBF†R¶W—2À¢æB—B—2F†RöæÇ’F‚F†BGW&ç2FVÆ—fW&VB&6VÂ–çFòÖVÖòFVÆ—fW'¢v—F†÷WBç–öæRG—–ærâ¢ğ¢6WEF–ÖV÷WB†gVæ7F–öâ‚’²–b‡G—Vöb6÷W&–W$WFõ7–æ2ÓÓÒvgVæ7F–öâr’6÷W&–W$WFõ7–æ2‚“²ÒÂc“°¢6WD–çFW'fÂ†gVæ7F–öâ‚’²–b‡G—Vöb6÷W&–W$WFõ7–æ2ÓÓÒvgVæ7F–öâr’6÷W&–W$WFõ7–æ2‚“²ÒÂR¢c¢“°§Ò“° ¦6öç7B4ÄõTEôD•ô´U’ÒwFW‡&µ÷&õö6Æ÷VEö&6·WöF’s°§f"6Æ÷VDF—'G’ÒfÇ6S° ¦gVæ7F–öâÖ–&TF–Ç”6Æ÷VD&6·W‚’°¢–b‚7–æ5W&Â‚’ÇÂF"ç6WGF–æw2æWFô&6·WÓÓÒfÇ6R’&WGW&ã°¢ÆWBÆ7BÒrs°¢G'’²Æ7BÒÆö6Å7F÷&vRævWD—FVÒ„4ÄõTEôD•ô´U’’ÇÂrs²Ò6F6‚†R’·Ğ¢–b†Æ7BÓÓÒFöF’‚’’&WGW&ã°¢G'’²Æö6Å7F÷&vRç6WD—FVÒ„4ÄõTEôD•ô´U’ÂFöF’‚’“²Ò6F6‚†R’·Ğ¢6Æ÷VD&6·Wæ÷r‡G'VR“°§Ğ ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒFFR&ævR6†÷'F7WG2ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ¦gVæ7F–öâ6WE&ævR†g&öÔ–BÂFô–BÂÖöFR’°¢6öç7Bæ÷rÒæWrFFR‚“°¢6öç7B—6òÒBÓâ–ÖEò†B“°¢–b†ÖöFRÓÓÒwFöF’r’°¢Fö7VÖVçBævWDVÆVÖVçD'”–B†g&öÔ–B’çfÇVRÒ—6ò†æ÷r“°¢Fö7VÖVçBævWDVÆVÖVçD'”–B‡Fô–B’çfÇVRÒ—6ò†æ÷r“°¢ÒVÇ6R–b†ÖöFRÓÓÒvÖöçF‚r’°¢Fö7VÖVçBævWDVÆVÖVçD'”–B†g&öÔ–B’çfÇVRÒ—6ò†æWrFFR†æ÷rævWDgVÆÅ–V"‚’Âæ÷rævWDÖöçF‚‚’Â’“°¢Fö7VÖVçBævWDVÆVÖVçD'”–B‡Fô–B’çfÇVRÒ—6ò†æ÷r“°¢ÒVÇ6R–b†ÖöFRÓÓÒw–V"r’°¢Fö7VÖVçBævWDVÆVÖVçD'”–B†g&öÔ–B’çfÇVRÒ—6ò†æWrFFR†æ÷rævWDgVÆÅ–V"‚’ÂÂ’“°¢Fö7VÖVçBævWDVÆVÖVçD'”–B‡Fô–B’çfÇVRÒ—6ò†æ÷r“°¢ÒVÇ6R°¢Fö7VÖVçBævWDVÆVÖVçD'”–B†g&öÔ–B’çfÇVRÒrs°¢Fö7VÖVçBævWDVÆVÖVçD'”–B‡Fô–B’çfÇVRÒrs°¢Ğ¢&VæFW$ÆÂ‚“°§Ğ ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ&–çB&Wf–WrÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ¢ò¢F†RÖVÖòöâF†Rf÷&ÒÂ26†VWBâ&–çBæBF†RGvòF÷væÆöG2ÆÂ7F'Bg&öÒF†—0¢öæRö&¦V7BÂ6òÖVÖò6ææ÷B&R6fVB2–7GW&R6†÷v–ærF–ffW&VçBf–wW&W2g&öĞ¢F†R6÷’F†BvWG2&–çFVBâ&WGW&ç2çVÆÂv†VâF†Rf÷&Ò†2æòÆ–æW2–WBâ¢ğ¦gVæ7F–öâÖVÖõ&Wf–WtG&gB‚’°¢6öç7BfÆ–BÒÖVÖôG&gBæ—FV×2æf–ÇFW"‡‚Óâ‚ç&öGV7D–BbbçVÒ‡‚çG’’â“°¢–b‚fÆ–BæÆVæwF‚’&WGW&âçVÆÃ°¢6öç7Bf–âÒÖVÖôÖF‚‡fÆ–BÂÖVÖô6†&vW2‚’“°¢&WGW&â°¢ÖVÖôæó¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚vÖVÖôæòr’çfÇVRÀ¢FFS¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚vÖVÖôFFRr’çfÇVRÇÂFöF’‚’À¢7W7FöÖW$æÖS¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚v7W7FöÖW$æÖRr’çfÇVRçG&–Ò‚’ÇÂrÒrÀ¢7W7FöÖW%†öæS¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚v7W7FöÖW%†öæRr’çfÇVRçG&–Ò‚’À¢7W7FöÖW$FG&W73¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚v7W7FöÖW$FG&W72r’çfÇVRçG&–Ò‚’À¢—FV×3¢fÆ–BæÖ‡‚Óâ‡°¢&öGV7DæÖS¢‡&öGV7D'”–B‡‚ç&öGV7D–B’ÇÂ·Ò’ææÖRÇÂrrÀ¢G“¢çVÒ‡‚çG’’Â&FS¢çVÒ‡‚ç&FR’ÂÖ÷VçC¢&÷VæC"†çVÒ‡‚çG’’¢çVÒ‡‚ç&FR’¢Ò’’À¢F÷FÅG“¢fÆ–Bç&VGV6R‚†Â‚’Óâ²çVÒ‡‚çG’’Â’À¢7V'F÷FÃ¢f–âç7V'F÷FÂÂF—66÷VçC¢f–âæF—66÷VçBÂFVÆ—fW'”6†&vS¢f–âæFVÆ—fW'”6†&vRÀ¢fC¢f–âçfBÂw&æEF÷FÃ¢f–âæw&æEF÷FÂÂGfæ6S¢f–âæGfæ6RÂGVS¢f–âæGVRÀ¢æ÷FS¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚vÖVÖôæ÷FRr’çfÇVRçG&–Ò‚¢Ó°§Ğ ¦gVæ7F–öâ&–çE&Wf–Wt7W'&VçB‚’°¢6öç7B&Wf–WrÒÖVÖõ&Wf–WtG&gB‚“°¢–b‚&Wf–Wr’&WGW&âÆW'B‚tFB&öGV7Bf—'7BÂF†Vâ&–çBâr“°¢&–çDÖVÖõ6†VWB‡&Wf–Wr“°§Ğ ¢ò¢&Wf–WrF†RÖVÖò&V–ærw&—GFVâÂ–âF†R6ÖRÖöFÂF†R†—7F÷'’W6W2Â6òF†RW‡÷'@¢'WGFöç26—BæW‡BFò—Bâæ÷F†–ær—26fVBFòF†R&öö²'’Æöö¶–ærâ¢ğ¦gVæ7F–öâ&Wf–Wt7W'&VçDÖVÖò‚’°¢6öç7B&Wf–WrÒÖVÖõ&Wf–WtG&gB‚“°¢–b‚&Wf–Wr’&WGW&âÆW'B‚tFB&öGV7Bf—'7BÂF†Vâ&Wf–Wrâr“°¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚wf–Wt&öG’r’æ–ææW$…DÔÂÒÖVÖõ6†VWB‡&Wf–Wr“°¢6öç7BæòÒFö7VÖVçBævWDVÆVÖVçD'”–B‚wf–WtÖVÖôæòr“°¢–b†æò’æòçFW‡D6öçFVçBÒ‡&Wf–WræÖVÖôæòÇÂr‡Vç6fVB’r’²rÂr²&Wf–Wræ7W7FöÖW$æÖS°¢Fö7VÖVçBævWDVÆVÖVçD'”–B‚wf–WtÖöFÂr’æ6Æ74Æ—7BæFB‚w6†÷rr“°§Ğ ¦gVæ7F–öâ6fU&Wf–WtÖVÖò†¶–æB’°¢6öç7B&Wf–WrÒÖVÖõ&Wf–WtG&gB‚“°¢–b‚&Wf–Wr’&WGW&âÆW'B‚tFB&öGV7Bf—'7BÂF†Vâ6fRâr“°¢¶–æBÓÓÒwFbrò6fTÖVÖõDb‡&Wf–Wr’¢6fTÖVÖõär‡&Wf–Wr“°§Ğ ¢ò¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ55bW‡÷'BÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒ¢ğ¦gVæ7F–öâF÷væÆöB†æÖRÂ&÷w2’°¢6öç7B77bÒ&÷w2æÖ‡"Óâ"æÖ‡bÓâr"r²7G&–ær‡bóòrr’ç&WÆ6TÆÂ‚r"rÂr""r’²r"r’æ¦ö–â‚rÂr’’æ¦ö–â‚uÆâr“°¢6öç7BÒFö7VÖVçBæ7&VFTVÆVÖVçB‚vr“°¢æ‡&VbÒU$Âæ7&VFTö&¦V7EU$Â†æWr&Æö"…²uÇTdTdbr²77eÒÂ²G—S¢wFW‡Bö77c¶6†'6WC×WFbÓ‚rÒ’“°¢æF÷væÆöBÒæÖS°¢æ6Æ–6²‚“°§Ğ ¦gVæ7F–öâW‡÷'DÖVÖ÷455b‚’°¢6öç7B&÷w2Òµ²tÖVÖòæòrÂtFFRrÂt7W7FöÖW"rÂu†öæRrÂtFG&W72rÂuF÷FÂG’rÂu7V'F÷FÂrÂtF—66÷VçBrÀ¢tFVÆ—fW'’6†&vRrÂudBrÂtw&æBF÷FÂrÂtGfæ6RrÂtGVRrÂt4ôu2rÂu&öf—BuÕÓ°¢F"æÖVÖ÷2æf÷$V6‚†ÒÓâ&÷w2çW6‚…¶ÒæÖVÖôæòÂÒæFFRÂÒæ7W7FöÖW$æÖRÂÒæ7W7FöÖW%†öæRÂÒæ7W7FöÖW$FG&W72À¢ÒçF÷FÅG’ÂÒç7V'F÷FÂÂÒæF—66÷VçBÂÒæFVÆ—fW'”6†&vRÂÒçfBÂÒæw&æEF÷FÂÂÒæGfæ6RÂÒæGVRÂÒæ6öw2ÂÒç&öf—EÒ’“°¢F÷væÆöB‚wFW‡&µöÖVÖ÷2æ77brÂ&÷w2“°§Ğ ¦gVæ7F–öâW‡÷'E7Fö6´Æöt55b‚’°¢6öç7B&÷w2Òµ²tFFRrÂu&öGV7BrÂuG—RrÂt–ârÂt÷WBrÂt&Ææ6RrÂu&VfW&Væ6RrÂtæ÷FRuÕÓ°¢F"æÆVFvW"æf÷$V6‚†ÂÓâ°¢6öç7BÒ&öGV7D'”–B†Âç&öGV7D–B“°¢&÷w2çW6‚…¶ÂæFFRÂòææÖR¢r†FVÆWFVB’rÂÂçG—RÀ¢çVÒ†ÂçG’’âòçVÒ†ÂçG’’¢rrÂçVÒ†ÂçG’’ÂòÖF‚æ'2†çVÒ†ÂçG’’’¢rrÀ¢çVÒ†Âæ&Ææ6R’ÂÂç&VbÂÂææ÷FUÒ“°¢Ò“°¢F÷væÆöB‚wFW‡&µ÷7Fö6µöÆVFvW"æ77brÂ&÷w2“°§Ğ ¦gVæ7F–öâW‡÷'DÆÄ55b‚’°¢6öç7B&÷w2Òµ²uG—RrÂtFFRrÂu&VfW&Væ6RrÂu'G’rÂt—FVÒrÂuG’rÂu&FRrÂtÖ÷VçBrÂu7FGW2uÕÓ°¢F"æÖVÖ÷2æf÷$V6‚†ÒÓâÒæ—FV×2æf÷$V6‚†’Óâ&÷w2çW6‚…²u6ÆRrÂÒæFFRÂÒæÖVÖôæòÂÒæ7W7FöÖW$æÖRÀ¢’ç&öGV7DæÖRÂ’çG’Â’ç&FRÂ’æÖ÷VçBÂÒæGVRâòtGVRr²ÒæGVR¢u–BuÒ’’“°¢F"çW&6†6W2æf÷$V6‚‡Óâæ—FV×2æf÷$V6‚†’Óâ&÷w2çW6‚…²uW&6†6RrÂæFFRÂçW&6†6TæòÀ¢ç7WÆ–W$æÖRÂ’ç&öGV7DæÖRÂ’çG’Â’æ6÷7BÂ’æÖ÷VçBÂç7FGW5Ò’’“°¢F"æW‡Vç6W2æf÷$V6‚†RÓâ&÷w2çW6‚…²tW‡Vç6RrÂRæFFRÂRæ†VBÂrrÂRææ÷FRÂrrÂrrÂRæÖ÷VçBÂruÒ’“°¢F"ç–ÖVçG2æf÷$V6‚‡Óâ°¢6öç7B2ÒF"æ7W7FöÖW'2æf–æB‡‚Óâ‚æ–BÓÓÒæ7W7FöÖW$–B“°¢&÷w2çW6‚…²u–ÖVçB–ârÂæFFRÂæÖWF†öBÂ2ò2ææÖR¢rrÂrrÂrrÂrrÂæÖ÷VçBÂruÒ“°¢Ò“°¢F÷væÆöB‚wFW‡&µöÆÅöFFæ77brÂ&÷w2“°§Ğ       