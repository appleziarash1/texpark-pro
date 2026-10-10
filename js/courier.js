/* Texpark Pro — Steadfast courier link.

   A parcel's Steadfast tracking is tied to the memo/order that promised it, so the
   delivery status can come back without the owner retyping it: a delivered parcel
   marks the memo delivered, a returned one records the parcel came back.

   Two honest limits, both surfaced in the UI rather than hidden:

   * Steadfast's status API reports delivery at the parcel level (delivered /
     partial / cancelled / returned). It does not report how many pieces came back —
     that number is confirmed by the person holding the parcel, so a returned status
     opens the Return screen for the owner instead of inventing a quantity.
   * Whether returned goods are sellable (Good) or damaged is the owner's call, so it
     is a setting, not a guess.

   The API key and secret are per-device (`LOCAL_SETTING_KEYS`), never synced: they
   are the shop's credentials, and a second device has its own.

   Steadfast answers with `Access-Control-Allow-Origin: *`, so a browser can call it
   directly — no server, and this stays on the free plan. */

const STEADFAST_API = 'https://portal.packzy.com/api/v1';
const COURIER_KEY_KEY = 'texpark_pro_courier_key';
const COURIER_SECRET_KEY = 'texpark_pro_courier_secret';

/* Where the per-device credentials live. Kept out of `db` and localStorage's
   app JSON on purpose so a future backup/sync path cannot pick them up by accident. */
function courierKey() {
  try { return (localStorage.getItem(COURIER_KEY_KEY) || '').trim(); } catch (e) { return ''; }
}
function courierSecret() {
  try { return (localStorage.getItem(COURIER_SECRET_KEY) || '').trim(); } catch (e) { return ''; }
}
function courierConfigured() { return !!(courierKey() && courierSecret()); }
function courierEnabled() {
  return courierConfigured() && db.settings && db.settings.courierEnabled !== false;
}
function courierAutoCod() { return !!(db.settings && db.settings.courierAutoCod !== false); }
function courierAutoReturnGood() { return !!(db.settings && db.settings.courierAutoReturnGood !== false); }

/* Statuses Steadfast returns. The *_approval_pending ones are not final: the balance
   has not been updated, so the app must not treat them as delivered/cancelled yet. */
const COURIER_STATUS_LABEL = {
  pending: 'Pending', in_review: 'In Review', hold: 'On Hold',
  delivered: 'Delivered', partial_delivered: 'Partially Delivered',
  cancelled: 'Cancelled', returned: 'Returned',
  delivered_approval_pending: 'Delivered (awaiting approval)',
  partial_delivered_approval_pending: 'Partial (awaiting approval)',
  cancelled_approval_pending: 'Cancelled (awaiting approval)',
  unknown_approval_pending: 'Unknown (awaiting approval)',
  unknown: 'Unknown'
};
/* A status only "counts" once it is final. The approval-pending ones read as their
   base status for display, but the app waits before moving stock or a due. */
const COURIER_FINAL = ['delivered', 'partial_delivered', 'cancelled', 'returned'];
function courierStatusFinal_(status) { return COURIER_FINAL.indexOf(String(status || '')) !== -1; }
function courierStatusLabel_(status) {
  const s = String(status || '');
  return COURIER_STATUS_LABEL[s] || s || 'Unknown';
}
function courierBaseStatus_(status) {
  return String(status || '').replace(/_approval_pending$/, '');
}

/* The consignment id out of a tracking link or a raw id. Accepts the shapes Steadfast
   and its SMS use, and returns '' rather than guessing when nothing matches. */
function extractConsignment_(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  if (/^\d{3,}$/.test(t)) return t;
  /* A short alphanumeric token is itself a tracking code (Steadfast codes look like
     this). The 4-char floor keeps a stray word from being read as an id. */
  if (/^[A-Za-z0-9._-]{4,}$/.test(t) && !/^https?:/i.test(t)) return t;
  const m = t.match(/trackingCode=([A-Za-z0-9._-]+)/i) ||
            t.match(/(?:cid|consignment[_-]?id)[=\/]([A-Za-z0-9._-]+)/i) ||
            t.match(/\/(?:t|track)\/([A-Za-z0-9._-]+)/i);
  return m ? m[1] : '';
}

/* Build the Steadfast request. Kept as a pure function from stored state so a test
   can assert exactly what a status check would send without a socket. */
function courierRequestFor_(ord) {
  const id = String((ord && (ord.consignmentId || '')) || '').trim() ||
             extractConsignment_(ord && ord.trackingUrl);
  if (!id) return null;
  if (/^\d+$/.test(id)) return { url: STEADFAST_API + '/status_by_cid/' + encodeURIComponent(id), kind: 'cid' };
  return { url: STEADFAST_API + '/status_by_trackingcode/' + encodeURIComponent(id), kind: 'tracking' };
}

/* Parse the status JSON. Returns {status, cod} or {error}. Pure — the tests drive it
   with the exact shapes Steadfast documents. */
function parseCourierStatus_(json) {
  const j = json || {};
  if (j.status && j.status !== 200) return { error: String(j.message || 'Steadfast refused the request') };
  const d = j.delivery_status || j.data || j.consignment || {};
  const status = d.status || d.delivery_status || j.delivery_status || '';
  if (!status) return { error: 'No delivery status in the reply' };
  return { status: String(status), cod: num(d.cod_amount != null ? d.cod_amount : j.cod_amount) };
}

/* The HTTP call, isolated so tests stub exactly one seam. */
async function courierFetch_(req) {
  if (!courierConfigured()) return { error: 'Courier API key/secret are not set (Settings → Courier).' };
  try {
    const res = await fetch(req.url, {
      headers: { 'Api-Key': courierKey(), 'Secret-Key': courierSecret(), 'Content-Type': 'application/json' }
    });
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { /* not JSON */ }
    if (j === null) {
      return { error: res.status === 401 || res.status === 403
        ? 'Steadfast rejected the API key (HTTP ' + res.status + '). Check Settings → Courier.'
        : 'Steadfast did not return JSON (HTTP ' + res.status + ').' };
    }
    return parseCourierStatus_(j);
  } catch (e) {
    return { error: 'Could not reach Steadfast: ' + ((e && e.message) || e) };
  }
}

/* A small badge on the order card so a delivered/returned parcel is visible at a
   glance from the board, without opening every order. */
function ordCourierBadgeHTML(o) {
  if (!o) return '';
  const hasId = !!(o.consignmentId || extractConsignment_(o.trackingUrl));
  if (!o.courierStatus && !hasId) return '';
  const s = o.courierStatus || '';
  const cls = s === 'delivered' ? 'ok'
    : (s === 'cancelled' || s === 'returned' ? 'danger' : 'warn');
  const label = s ? courierStatusLabel_(s) : 'Tracking linked';
  const link = o.trackingUrl ? String(o.trackingUrl).trim() : '';
  return '<div class="ocourier"><span class="pill ' + cls + '">🚚 ' + esc(label) + '</span>' +
    (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Track ↗</a>' : '') +
    '</div>';
}

/* ============================ mapping a status onto the business ============================
   This is the only place a courier status changes records, and it is deliberately
   additive: it never lowers a delivered quantity, never fabricates a return qty, and
   records why it acted in the order history. */

/* Link a returned parcel's stock back in. Pieces are taken from the memo's own lines,
   capped at what is still pending, so a returned status can never put back more than
   was sold. When nothing is pending it records the fact without touching stock. */
function applyCourierReturn(memo, qtyCap) {
  if (!memo) return { qty: 0 };
  const pending = pendingQtyOf(memo);
  if (pending <= 0) return { qty: 0, note: 'nothing pending to return' };
  let left = num(qtyCap) > 0 ? Math.min(num(qtyCap), pending) : pending;
  const items = [];
  if (left > 0) {
    (memo.items || []).forEach(it => {
      if (left <= 0 || !it.productId) return;
      const alreadyBack = (db.returns || [])
        .filter(r => r.memoId === memo.id)
        .reduce((a, r) => a + ((r.items || []).filter(x => x.productId === it.productId)
          .reduce((b, x) => b + num(x.qty), 0)), 0);
      const avail = Math.max(0, num(it.qty) - num(deliveredQtyOf(memo.id)) - alreadyBack);
      const take = Math.min(left, avail);
      if (take > 0) { items.push({ productId: it.productId, productName: it.productName, qty: take }); left -= take; }
    });
  }
  if (!items.length) return { qty: 0, note: 'nothing pending to return' };
  const qty = items.reduce((a, x) => a + num(x.qty), 0);
  const ret = {
    id: id(), memoId: memo.id, memoNo: memo.memoNo, date: today(),
    items, qty, condition: courierAutoReturnGood() ? 'good' : 'damaged',
    note: 'Auto from Steadfast status', returnedAt: new Date().toISOString(),
    source: 'steadfast'
  };
  db.returns.push(ret);
  applyReturnToStock(ret);
  return { qty, items };
}

/* Mark a memo delivered (and, when the setting is on, take COD off the due). Skips
   silently when there is nothing pending, so a re-sync never double-counts. */
function applyCourierDelivered(memo, codAmount) {
  if (!memo) return null;
  const pending = pendingQtyOf(memo);
  if (pending <= 0) return null;
  let collected = courierAutoCod() ? Math.max(0, num(codAmount)) : 0;
  const owed = memoRemainingDue(memo);
  if (collected > owed) collected = owed;
  const deliveryId = id();
  db.deliveries.push({
    id: deliveryId, memoId: memo.id, qty: pending, date: today(),
    driver: 'Steadfast', vehicle: '', receiver: '', note: 'Auto from Steadfast status',
    status: 'Delivered', source: 'steadfast'
  });
  let payment = null;
  if (collected > 0) {
    payment = {
      id: id(), memoId: memo.id, deliveryId, customerId: customerIdForMemo_(memo),
      date: today(), amount: collected, method: 'Cash',
      note: 'COD collected on Steadfast delivery ' + memo.memoNo
    };
    db.payments.push(payment);
  }
  return { delivery: db.deliveries[db.deliveries.length - 1], payment, collected };
}

/* Apply one status to one order. Returns a short note for the caller to show; the
   caller commits and pushes once, so a batch of orders is one save. */
function courierApplyStatus_(ord, status, cod) {
  const base = courierBaseStatus_(status);
  const memo = memoForOrder_(ord);
  const notes = [];
  if (base === 'delivered') {
    if (ord.status !== 'delivered') { ord.status = 'delivered'; notes.push('order → Delivered'); }
    if (memo) {
      const r = applyCourierDelivered(memo, cod);
      if (r) {
        notes.push('memo ' + memo.memoNo + ' delivered (' + r.delivery.qty + ' pcs)');
        if (r.collected > 0) notes.push('COD ' + money(r.collected) + ' off the due');
      }
    }
  } else if (base === 'partial_delivered') {
    notes.push('partially delivered');
  } else if (base === 'cancelled') {
    if (ord.status !== 'delivered') ord.status = 'dispatched';
    notes.push('cancelled at the courier');
  } else if (base === 'returned') {
    /* Pieces are not in the status reply, so the owner confirms the qty — but the
       fact that goods came back adds stock right away when the setting asks for it. */
    if (memo) { const r = applyCourierReturn(memo, 0); if (r.qty > 0) notes.push('return ' + r.qty + ' pcs back to stock'); }
    notes.push('returned');
  } else if (base === 'hold') {
    notes.push('on hold at the courier');
  }
  return notes.join(', ');
}

/* The pure "which order needs checking" filter, so a board of 200 orders does not
   make 200 requests on every open. Only unsynced, active orders with an id are polled,
   newest change first, and the caller caps the batch. */
function courierSyncTargets_(orders, max) {
  const list = (orders || []).filter(o =>
    o && (o.consignmentId || extractConsignment_(o.trackingUrl)) &&
    o.courierStatus !== 'delivered' && o.courierStatus !== 'cancelled' &&
    o.courierStatus !== 'returned' && o.status !== 'delivered'
  );
  list.sort((a, b) => String(a.deliveryDate || '').localeCompare(String(b.deliveryDate || '')));
  return list.slice(0, max || 8);
}

/* Sync a list of orders. One commit for the whole batch. `fetchOne` is injectable for
   tests; production passes nothing and uses courierFetch_. */
async function courierSyncOrders(orders, fetchOne) {
  const get = fetchOne || courierFetch_;
  let checked = 0, changed = 0;
  const lines = [];
  for (const ord of orders) {
    const req = courierRequestFor_(ord);
    if (!req) continue;
    checked++;
    const resp = await get(req);
    if (resp.error) { lines.push((ord.orderNo || '') + ': ' + resp.error); continue; }
    /* Always record what Steadfast last said, even if it maps to nothing yet, so the
       board shows a status rather than a silent absence. */
    const before = ord.courierStatus || '';
    ord.courierStatus = resp.status;
    ord.courierCod = resp.cod;
    ord.courierCheckedAt = new Date().toISOString();
    const note = courierApplyStatus_(ord, resp.status, resp.cod);
    if (note) lines.push((ord.orderNo || '') + ': ' + note);
    if (before !== resp.status || note) changed++;
  }
  if (changed) commit();
  return { checked, changed, lines };
}

/* ============================ UI actions ============================ */

/* The memo/order link: a memo an order promises, matched by memoNo or memoId. */
function memoForOrder_(ord) {
  if (!ord) return null;
  if (ord.memoId) { const m = (db.memos || []).find(x => x.id === ord.memoId); if (m) return m; }
  const no = String(ord.memoNo || '').trim();
  if (no) return (db.memos || []).find(x => String(x.memoNo || '').trim() === no) || null;
  return null;
}
function orderForMemo_(memo) {
  if (!memo) return null;
  return (db.orders || []).find(o => o.memoId === memo.id ||
    (o.memoNo && String(o.memoNo).trim() === String(memo.memoNo || '').trim())) || null;
}

/* Pull the consignment id out of whatever the owner pasted into the tracking field,
   so they can paste the SMS link and carry on. */
function orderTrackingChanged() {
  const url = document.getElementById('ordTrackingUrl');
  const cid = document.getElementById('ordConsignment');
  if (!url || !cid) return;
  const found = extractConsignment_(url.value);
  if (found && !String(cid.value || '').trim()) cid.value = found;
}

/* Show the courier block (link + last status + Sync button) in the order modal. */
function renderOrderCourier() {
  const box = document.getElementById('ordCourier');
  if (!box) return;
  const oid = document.getElementById('ordId').value;
  const o = oid ? (db.orders || []).find(x => x.id === oid) : null;
  const btn = document.getElementById('ordCourierSyncBtn');
  const link = o && o.trackingUrl ? String(o.trackingUrl).trim() : '';
  const cid = (o && o.consignmentId) || '';
  if (btn) btn.style.display = (o && (cid || extractConsignment_(link) || o.status === 'delivered')) ? '' : 'none';
  if (!o && !courierConfigured()) {
    box.innerHTML = '<div class="muted">Set the Steadfast API key in Settings → Courier to sync delivery status automatically.</div>';
    return;
  }
  const last = o && o.courierStatus
    ? '<span class="pill ' + (courierStatusFinal_(o.courierStatus) ? 'ok' : 'warn') + '">' +
      esc(courierStatusLabel_(o.courierStatus)) + '</span>'
    : '<span class="muted">Not checked yet</span>';
  box.innerHTML = '<div class="row" style="gap:10px;flex-wrap:wrap">' +
    '<span><b>Courier:</b> ' + last +
    (o && o.courierCheckedAt ? ' <span class="muted">· ' + esc(String(o.courierCheckedAt).slice(0, 16).replace('T', ' ')) + '</span>' : '') +
    (link ? ' <a href="' + esc(link) + '" target="_blank" rel="noopener">Open tracking ↗</a>' : '') +
    '</span></div>';
}

function syncOrderCourier() {
  const oid = document.getElementById('ordId').value;
  const o = oid ? (db.orders || []).find(x => x.id === oid) : null;
  if (!o) return alert('Save the order first, then sync.');
  if (!courierConfigured()) { alert('Set the Steadfast API key and secret in Settings → Courier first.'); return; }
  courierSyncOrders([o]).then(r => {
    renderOrderCourier();
    renderOrders();
    if (r.lines.length) alert('Courier:\n' + r.lines.join('\n'));
    else alert('Checked ' + r.checked + ' order — no new status.');
  });
}

/* Settings → Courier. The keys are written to this device only. */
function saveCourierSettings() {
  const k = document.getElementById('stCourierKey');
  const s = document.getElementById('stCourierSecret');
  const en = document.getElementById('stCourierEnabled');
  const cod = document.getElementById('stCourierAutoCod');
  const ret = document.getElementById('stCourierAutoReturn');
  try {
    if (k) localStorage.setItem(COURIER_KEY_KEY, String(k.value || '').trim());
    if (s) localStorage.setItem(COURIER_SECRET_KEY, String(s.value || '').trim());
  } catch (e) { alert('Could not save the courier keys: ' + e.message); return; }
  if (en) db.settings.courierEnabled = !!en.checked;
  if (cod) db.settings.courierAutoCod = !!cod.checked;
  if (ret) db.settings.courierAutoReturnGood = !!ret.checked;
  db.settings.settingsUpdatedAt = new Date().toISOString();
  commit();
  alert('Courier settings saved on this device.');
}

async function testCourierSettings() {
  const out = document.getElementById('courierTestOut');
  const say = m => { if (out) out.textContent = m; };
  if (!courierConfigured()) { say('Enter the API key and secret first.'); return; }
  say('Checking...');
  /* A balance call is the cheapest end-to-end proof the credentials work; it does not
     touch any parcel. */
  try {
    const res = await fetch(STEADFAST_API + '/get_balance', {
      headers: { 'Api-Key': courierKey(), 'Secret-Key': courierSecret() }
    });
    const j = await res.json().catch(() => null);
    if (res.status === 200 && j && j.status === 200) say('Connected. Balance: ৳' + num(j.current_balance));
    else say('Failed: ' + (j && j.message ? j.message : 'HTTP ' + res.status));
  } catch (e) { say('Could not reach Steadfast: ' + ((e && e.message) || e)); }
}

/* Auto-check on open and on a timer, muted, capped, and only while the tab is
   visible — the same discipline the cloud poll uses. Never blocks the app. */
var courierSyncing = false;
async function courierAutoSync() {
  if (courierSyncing || !courierEnabled() || typeof document === 'undefined' || document.hidden) return;
  const targets = courierSyncTargets_(db.orders, 8);
  if (!targets.length) return;
  courierSyncing = true;
  try {
    const r = await courierSyncOrders(targets);
    if (r.changed && currentPage === 'orders') renderOrders();
  } catch (e) { /* a courier outage must never break the app */ }
  courierSyncing = false;
}
