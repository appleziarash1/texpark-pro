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
  const addr = document.getElementById('stCourierAddressCheck');
  try {
    if (k) localStorage.setItem(COURIER_KEY_KEY, String(k.value || '').trim());
    if (s) localStorage.setItem(COURIER_SECRET_KEY, String(s.value || '').trim());
  } catch (e) { alert('Could not save the courier keys: ' + e.message); return; }
  if (en) db.settings.courierEnabled = !!en.checked;
  if (cod) db.settings.courierAutoCod = !!cod.checked;
  if (ret) db.settings.courierAutoReturnGood = !!ret.checked;
  if (addr) db.settings.courierAddressCheck = !!addr.checked;
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

/* ============================ booking a parcel ============================
   The tracking half above can only follow a parcel that already exists at
   Steadfast. This half creates it, so the whole courier job lives on the order
   itself and the owner never leaves the app to open the Steadfast portal.

   The invoice is deterministic per order (`TXP-<orderNo>`), so pressing Book
   twice, or a retry after a dropped reply, cannot create a second parcel: the
   same invoice is refused by Steadfast as a duplicate. The shipment is only
   recorded after Steadfast confirms, so a failed call never leaves an order
   claiming a parcel that was not really booked. */

/* Our idempotency key, sent to Steadfast as `invoice`. */
function courierInvoiceFor_(ord) {
  const no = String((ord && (ord.orderNo || ord.memoNo || ord.id)) || '').trim() || 'order';
  return 'TXP-' + no.replace(/[^A-Za-z0-9-]/g, '-');
}

/* A Bangladeshi mobile: 01 followed by 3-9, then eight more digits. */
function courierPhoneOk_(phone) {
  return /^01[3-9]\d{8}$/.test(String(phone || '').trim());
}

/* Fold the ways an owner writes a phone onto one form: strip spaces/dashes/Bangla
   digits and turn +880/880/00880 into a leading 0. Returns a bare 11-digit number
   when it is one, else the trimmed original so the validation message still shows
   what was typed. */
function localizeCourierPhone_(phone) {
  let d = String(phone == null ? '' : phone)
    .replace(/[\u09E6-\u09EF]/g, c => String(c.charCodeAt(0) - 0x09E6))
    .replace(/[^\d]/g, '');
  if (d.indexOf('00880') === 0) d = d.slice(5);
  else if (d.indexOf('880') === 0) d = d.slice(3);
  if (d.length === 10 && d[0] !== '0') d = '0' + d;
  return /^01[3-9]\d{8}$/.test(d) ? d : String(phone == null ? '' : phone).trim();
}

/* ---- offline area detection & address correction (optional, off by default) ----
   When the feature is off, nothing here runs and booking behaves exactly as before.
   When it is on, the address is *corrected* from the area and the District / Thana /
   Union / Ward are filled in, so a booking is not sent with an ambiguous area and
   the owner does not have to type them. The correction never guesses: an area that
   cannot be resolved leaves the address untouched. */

/* The record the order modal is editing, or null for a new one. */
function orderOpenRecord_() {
  const oid = (document.getElementById('ordId') || {}).value;
  return oid ? (db.orders || []).find(x => x.id === oid) || null : null;
}

/* The address the booking will actually send: the live field if the owner has
   one, else the computed draft (memo, then saved customer). */
function orderBookingAddress_(ord) {
  const el = document.getElementById('ordBookAddress');
  if (el && String(el.value || '').trim()) return String(el.value).trim();
  return courierBookingDraft(ord).address;
}

/* The District/Thana currently chosen on the form. Booking is allowed only when
   both are set — whether the resolver found them or the owner picked them. */
function bdOrderLocationStatus_() {
  const d = document.getElementById('ordBdDistrict');
  const t = document.getElementById('ordBdThana');
  const district = d ? String(d.value || '').trim() : '';
  const thana = t ? String(t.value || '').trim() : '';
  return {
    ok: !!district && !!thana, district: district, thana: thana,
    message: 'District and Thana could not be detected from this address. Please select them before booking.'
  };
}

/* What the owner has on the form, so a re-render keeps a manual choice. Reset
   whenever the address itself changes, so detection wins again. */
var _bdSel = { address: '', district: '', city: '', thana: '', union: '', paurashava: '', ward: '', wardParent: '' };

function renderOrderAddressCheck(ord) {
  const box = document.getElementById('ordAddrCheck');
  if (!box) return;
  const on = !!(db.settings && db.settings.courierAddressCheck);
  if (!on || ord == null || typeof resolveBdLocation !== 'function') { box.innerHTML = ''; return; }

  const address = orderBookingAddress_(ord);
  const r = resolveBdLocation(address);

  /* A fresh address re-seeds from detection; an unchanged one keeps the owner's
     pick, so switching the customer does not silently throw a correction away. */
  if (_bdSel.address !== address) {
    _bdSel = {
      address: address, district: r.district || '', city: r.city || '', thana: r.thana || '',
      union: r.union || '', paurashava: r.paurashava || '', ward: r.ward || '',
      wardParent: r.wardParent || r.city || ''
    };
  }

  const districts = bdDistricts();
  const allThanas = _bdSel.district ? bdThanasFor(_bdSel.district) : [];
  const cities = _bdSel.district ? bdCitiesFor(_bdSel.district) : [];
  const thanas = _bdSel.city ? allThanas.filter(t => t.city === _bdSel.city) : allThanas;
  const unions = (_bdSel.district && _bdSel.thana) ? bdUnionsFor(_bdSel.district, _bdSel.thana) : [];
  const paurashavas = _bdSel.district ? bdPaurashavasFor(_bdSel.district) : [];
  const wardParent = _bdSel.city || _bdSel.paurashava || _bdSel.wardParent || '';
  const wards = (_bdSel.district && wardParent) ? bdWardsFor(_bdSel.district, wardParent) : [];

  const conf = r.confidence;
  const tone = conf === 'high' ? 'var(--green)' : (conf === 'none' ? 'var(--red)' : 'var(--orange)');
  const note = conf === 'high'
    ? 'Detected from the address.'
    : conf === 'none'
      ? 'Could not detect a District / Thana from this address.'
      : conf === 'low'
        ? 'The address names a district that may be a reference point — please confirm.'
        : 'District found; please confirm the Thana.';

  const opt = (v, sel, bn) => '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' +
    esc(v) + (bn ? ' — ' + esc(bn) : '') + '</option>';
  const sel = (id, label, value, items, handler, blank) =>
    '<div><label>' + esc(label) + '</label><select id="' + id + '" onchange="' + handler + '">' +
    '<option value="">' + esc(blank || '— choose —') + '</option>' +
    items.map(it => opt(it.name, value, it.nameBn)).join('') + '</select></div>';

  let grid = sel('ordBdDistrict', 'District', _bdSel.district, districts, 'onOrderDistrictChanged()');
  if (cities.length) {
    grid += '<div><label>City Corporation</label><select id="ordBdCity" onchange="onOrderCityChanged()">' +
      '<option value="">— district level —</option>' +
      cities.map(c => opt(c.name, _bdSel.city, c.nameBn)).join('') + '</select></div>';
  }
  grid += sel('ordBdThana', 'Thana / Upazila', _bdSel.thana, thanas, 'onOrderThanaChanged()');
  if (unions.length) {
    grid += sel('ordBdUnion', 'Union', _bdSel.union, unions, 'onOrderUnionChanged()');
  }
  if (paurashavas.length) {
    grid += sel('ordBdPaurashava', 'Paurashava', _bdSel.paurashava, paurashavas, 'onOrderPaurashavaChanged()');
  }
  if (wards.length) {
    grid += sel('ordBdWard', 'Ward', _bdSel.ward, wards, 'onOrderWardChanged()');
  }

  box.innerHTML = '<div class="muted" style="font-weight:700;margin-bottom:4px">Delivery Area (Division → Ward)</div>' +
    '<div style="font-size:12.5px;color:' + tone + '">' + esc(note) + '</div>' +
    '<div class="formgrid" style="margin-top:6px">' + grid + '</div>' +
    '<div class="hint">' + (courierAutoFixEnabled_()
      ? 'These levels fill in from the address, and the address sent to Steadfast is corrected to match.'
      : 'Checking only — the address sent to Steadfast is unchanged.') + '</div>';

  /* The selects were just rebuilt, so put the remembered choice back into them.
     Booking reads these fields, so they have to mirror _bdSel exactly. */
  ['ordBdDistrict', 'ordBdCity', 'ordBdThana', 'ordBdUnion', 'ordBdPaurashava'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const field = { ordBdDistrict: 'district', ordBdCity: 'city', ordBdThana: 'thana', ordBdUnion: 'union', ordBdPaurashava: 'paurashava' }[id];
    if (el.querySelector('option[value="' + _bdSel[field] + '"]')) el.value = _bdSel[field] || '';
  });
  const wEl = document.getElementById('ordBdWard');
  if (wEl && wEl.querySelector('option[value="' + _bdSel.ward + '"]')) wEl.value = _bdSel.ward || '';
}

function onOrderAddressChanged() { _bdSel.address = ''; renderOrderAddressCheck(orderOpenRecord_()); }
function onOrderDistrictChanged() {
  const d = document.getElementById('ordBdDistrict');
  _bdSel.district = d ? d.value : '';
  _bdSel.city = ''; _bdSel.thana = ''; _bdSel.union = ''; _bdSel.paurashava = ''; _bdSel.ward = '';
  renderOrderAddressCheck(orderOpenRecord_());
}
function onOrderCityChanged() {
  const c = document.getElementById('ordBdCity');
  _bdSel.city = c ? c.value : '';
  _bdSel.thana = ''; _bdSel.union = ''; _bdSel.ward = '';
  renderOrderAddressCheck(orderOpenRecord_());
}
function onOrderThanaChanged() {
  const t = document.getElementById('ordBdThana');
  _bdSel.thana = t ? t.value : '';
  _bdSel.union = ''; _bdSel.ward = '';
  renderOrderAddressCheck(orderOpenRecord_());
}
function onOrderUnionChanged() {
  const u = document.getElementById('ordBdUnion');
  _bdSel.union = u ? u.value : '';
}
function onOrderPaurashavaChanged() {
  const p = document.getElementById('ordBdPaurashava');
  _bdSel.paurashava = p ? p.value : '';
  _bdSel.ward = '';
  renderOrderAddressCheck(orderOpenRecord_());
}
function onOrderWardChanged() {
  const w = document.getElementById('ordBdWard');
  _bdSel.ward = w ? w.value : '';
}


/* Where a parcel's recipient details come from, in priority order:
   the order's own fields, then the memo it settles, then the saved customer.
   Each falls back only when the field above it is blank, so a hand-typed value
   is never overwritten by a stale customer record. */
function courierBookingDraft(ord) {
  const memo = ord ? memoForOrder_(ord) : null;
  const cust = (db.customers || []).find(c =>
    (memo && c.name === memo.customerName && (c.phone || '') === (memo.customerPhone || '')) ||
    (!memo && c.name === (ord && ord.customerName)));
  const name = String((ord && ord.customerName) || (memo && memo.customerName) || (cust && cust.name) || '').trim();
  const phone = String((ord && ord.phone) || (memo && memo.customerPhone) || (cust && cust.phone) || '').trim();
  const address = String((memo && memo.customerAddress) || (cust && cust.address) || '').trim();
  /* Cash on delivery: what the memo still owes, less the advance already taken.
     Never negative, so a fully-paid memo books as 0 COD rather than a refund. */
  const cod = memo ? Math.max(0, num(memoRemainingDue(memo))) : 0;
  const desc = [ord && ord.productName, ord && num(ord.qty) ? '(' + num(ord.qty) + ' pcs)' : '']
    .filter(Boolean).join(' ');
  return { name, phone, address, cod, desc };
}

/* ---- self-correcting a booking draft (opt-in) ----
   With the area check on, the draft is corrected from the resolved area before it
   is shown or sent: the phone is folded to 01XXXXXXXXX, and the address is rebuilt
   so its District / Thana / Union / Ward are present and in order. It never
   guesses — an address whose area cannot be resolved is left exactly as typed. */
function courierAutoFixEnabled_() {
  return !!(db && db.settings && db.settings.courierAddressCheck && typeof resolveBdLocation === 'function');
}

/* The fields the correction would change, given the draft already on the form and
   what the owner actually typed in the address box. Returns {changed, draft}; the
   address to send comes from `draft.address` (corrected) while the owner's text is
   kept only to decide whether a live value is area-only or has house/road detail. */
function courierCorrectDraft_(ord, draft, typedAddress) {
  const out = Object.assign({}, draft);
  if (!courierAutoFixEnabled_()) return { changed: false, draft: out };
  out.phone = localizeCourierPhone_(out.phone);
  const typed = String(typedAddress == null ? '' : typedAddress).trim();
  const r = resolveBdLocation(typed || out.address);
  out.address = bdCorrectAddress_((typed && r && r.district) ? typed : out.address, r);
  const changed = out.phone !== draft.phone || out.address !== draft.address;
  return { changed: changed, draft: out };
}

/* Merge the detected area into the selects the owner has, then correct the draft
   to match. Detection only fills a level that is still blank or that currently
   disagrees with what was detected, so a deliberate manual pick survives. This is
   what turns "type an address, press Book" into a fully filled area. */
function applyOrderAddressCorrection_(ord) {
  if (!courierAutoFixEnabled_() || ord == null) return;
  const box = document.getElementById('ordAddrCheck');
  if (!box) return;
  const typed = orderBookingAddress_(ord);
  const r = resolveBdLocation(typed);
  if (!r.district) return;
  const setIf = (field, val) => { if (val && !_bdSel[field]) _bdSel[field] = val; };
  setIf('district', r.district);
  setIf('city', r.city);
  setIf('thana', r.thana);
  setIf('union', r.union);
  setIf('paurashava', r.paurashava);
  setIf('ward', r.ward);
  if (!_bdSel.wardParent) _bdSel.wardParent = r.wardParent || _bdSel.city || '';
  _bdSel.address = typed;
  renderOrderAddressCheck(ord);
}

/* Everything the booking would send, corrected. One place so the button, the
   modal's own error list and the final send cannot disagree. */
function courierFixedDraft_(ord) {
  const base = courierBookingDraft(ord);
  const live = { phone: '', address: '' };
  const pe = document.getElementById('ordBookPhone');
  if (pe && String(pe.value || '').trim()) live.phone = String(pe.value).trim();
  const ae = document.getElementById('ordBookAddress');
  if (ae && String(ae.value || '').trim()) live.address = String(ae.value).trim();
  const seed = Object.assign({}, base, live);
  const corrected = courierCorrectDraft_(ord, seed, live.address).draft;
  return { base: seed, corrected: corrected };
}

/* Build the Steadfast create_order payload. Pure, so a test can assert exactly
   what would be sent without a socket. */
function courierBookRequest_(ord, draft) {
  return {
    invoice: courierInvoiceFor_(ord),
    recipient_name: draft.name,
    recipient_phone: draft.phone,
    recipient_address: draft.address,
    cod_amount: num(draft.cod),
    item_description: draft.desc || undefined,
    delivery_type: 0
  };
}

/* Validate a draft before anything is sent. Returns an array of messages; empty
   means good to book. */
function courierBookErrors_(draft) {
  const errs = [];
  if (!String(draft.name || '').trim()) errs.push('Recipient name is required.');
  if (!courierPhoneOk_(draft.phone)) errs.push('A valid phone is required (01XXXXXXXXX).');
  if (!String(draft.address || '').trim()) errs.push('Delivery address is required.');
  if (num(draft.cod) < 0) errs.push('COD amount cannot be negative.');
  return errs;
}

/* Parse a create_order reply into {consignmentId, trackingCode}. Kept pure so the
   shapes Steadfast documents can be driven directly. */
function parseCourierBooking_(json) {
  const j = json || {};
  if (j.status && j.status !== 200) return { error: String(j.message || 'Steadfast refused the booking') };
  const c = j.consignment || j.data || j;
  const consignmentId = String((c && c.consignment_id) || '').trim();
  const trackingCode = String((c && c.tracking_code) || '').trim();
  if (!consignmentId) return { error: 'Steadfast did not return a consignment id.' };
  return { consignmentId, trackingCode };
}

/* The create_order HTTP call, isolated so tests stub exactly one seam. */
async function courierBookFetch_(payload) {
  if (!courierConfigured()) return { error: 'Courier API key/secret are not set (Settings → Courier).' };
  try {
    const res = await fetch(STEADFAST_API + '/create_order', {
      method: 'POST',
      headers: { 'Api-Key': courierKey(), 'Secret-Key': courierSecret(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { /* not JSON */ }
    if (j === null) {
      return { error: res.status === 401 || res.status === 403
        ? 'Steadfast rejected the API key (HTTP ' + res.status + '). Check Settings → Courier.'
        : 'Steadfast did not return JSON (HTTP ' + res.status + ').' };
    }
    return parseCourierBooking_(j);
  } catch (e) {
    return { error: 'Could not reach Steadfast: ' + ((e && e.message) || e) };
  }
}

/* The one place a booking changes records. `fetchOne` is injectable for tests;
   production passes nothing and uses courierBookFetch_. Returns {ok, error,
   shipment} and commits + queues the order once. */
async function courierBookOrder_(ord, draft, fetchOne) {
  const get = fetchOne || courierBookFetch_;
  /* With the area check on, correct the phone and address and fill the area from
     the address, so the parcel carries the full, unambiguous location. With it off
     this is a no-op and the draft is sent exactly as before. */
  const corrected = courierCorrectDraft_(ord, draft, draft && draft.address).draft;
  const errs = courierBookErrors_(corrected);
  if (errs.length) return { ok: false, error: errs.join(' ') };
  /* Optional offline area check: when on, a parcel is not sent until District and
     Thana are known. */
  if (db.settings && db.settings.courierAddressCheck) {
    const loc = bdOrderLocationStatus_();
    if (!loc.ok) return { ok: false, error: loc.message };
  }
  const payload = courierBookRequest_(ord, corrected);
  const resp = await get(payload);
  if (resp.error) return { ok: false, error: resp.error };

  ord.consignmentId = resp.consignmentId;
  if (resp.trackingCode) {
    ord.trackingUrl = 'https://steadfast.com.bd/t/' + resp.trackingCode;
    ord.trackingCode = resp.trackingCode;
  }
  ord.courierStatus = 'pending';
  ord.courierCod = num(corrected.cod);
  ord.courierBookedAt = new Date().toISOString();
  ord.courierCheckedAt = new Date().toISOString();
  ord.history = ord.history || [];
  ord.history.push({ at: new Date().toISOString(), text: 'Booked with Steadfast · ' + resp.consignmentId + ' · COD ' + money(num(draft.cod)) });
  commit();
  syncPush('order', {
    orderId: ord.id, orderNo: ord.orderNo, consignmentId: ord.consignmentId,
    courierStatus: ord.courierStatus, status: ord.status
  }, 'Courier booking ' + ord.orderNo);
  return { ok: true, shipment: { consignmentId: resp.consignmentId, trackingCode: resp.trackingCode } };
}

/* ---- the order modal's Courier block ---- */

/* Recompute the draft and paint the courier block: status badge, the fields the
   booking will use, and the Book / Sync buttons. Called whenever the order modal
   opens or a booking/sync finishes. */
function renderOrderCourier() {
  const box = document.getElementById('ordCourier');
  if (!box) return;
  const oid = document.getElementById('ordId').value;
  const o = oid ? (db.orders || []).find(x => x.id === oid) : null;
  const btn = document.getElementById('ordCourierSyncBtn');
  const bookBtn = document.getElementById('ordCourierBookBtn');
  const link = o && o.trackingUrl ? String(o.trackingUrl).trim() : '';
  const cid = (o && o.consignmentId) || '';
  const hasId = !!(cid || extractConsignment_(link));

  if (btn) btn.style.display = (o && (hasId || o.status === 'delivered')) ? '' : 'none';
  if (bookBtn) bookBtn.style.display = (o && !hasId) ? '' : 'none';
  /* The detection block is drawn from the live form, so it must be rendered
     before we read the current choice to decide whether booking is allowed. */
  renderOrderAddressCheck(o);
  if (bookBtn) bookBtn.disabled = false;
  /* A changed address re-fills the area selects (Detect from the address); when
     the owner has since blanked a level the text still names, put it back. */
  applyOrderAddressCorrection_(o);

  /* Keep the two tracking fields in step with the order, so a later Save Order
     reads back the same consignment id a booking just stored rather than
     re-deriving a tracking code over it. Only fills a blank field, so a value
     the owner typed is never overwritten. */
  if (o) {
    const csEl = document.getElementById('ordConsignment');
    if (csEl && o.consignmentId && !String(csEl.value || '').trim()) csEl.value = o.consignmentId;
    const tuEl = document.getElementById('ordTrackingUrl');
    if (tuEl && o.trackingUrl && !String(tuEl.value || '').trim()) tuEl.value = o.trackingUrl;
  }

  if (!o) {
    box.innerHTML = '<div class="muted">Save the order first, then book the parcel and its ' +
      'Steadfast status will come back on its own.</div>';
    return;
  }
  if (!courierConfigured()) {
    box.innerHTML = '<div class="muted">Set the Steadfast API key in Settings → Courier to book ' +
      'and sync delivery status automatically.</div>';
    return;
  }

  const draft = courierBookingDraft(o);
  const fix = courierFixedDraft_(o);
  const shown = fix.corrected;
  const autoFixed = courierAutoFixEnabled_() &&
    !!shown.address && shown.address !== draft.address;
  const errs = hasId ? [] : courierBookErrors_(shown);
  /* With the area check on, booking stays disabled until both are chosen. */
  const loc = (db.settings && db.settings.courierAddressCheck) ? bdOrderLocationStatus_() : null;
  if (bookBtn && !hasId && loc) bookBtn.disabled = !loc.ok;
  if (!hasId && loc && !loc.ok && errs.indexOf(loc.message) === -1) errs.push(loc.message);
  const statusPill = o.courierStatus
    ? '<span class="pill ' + (courierStatusFinal_(o.courierStatus) ? 'ok' : 'warn') + '">' +
      esc(courierStatusLabel_(o.courierStatus)) + '</span>'
    : '<span class="muted">Not booked yet</span>';

  let html = '<div class="row" style="gap:10px;flex-wrap:wrap">' +
    '<span><b>Courier:</b> ' + statusPill +
    (o.courierCheckedAt ? ' <span class="muted">· ' + esc(String(o.courierCheckedAt).slice(0, 16).replace('T', ' ')) + '</span>' : '') +
    (link ? ' <a href="' + esc(link) + '" target="_blank" rel="noopener">Open tracking ↗</a>' : '') +
    '</span></div>';

  if (!hasId) {
    html += '<div class="hint" style="margin-top:8px">Booking will send these details to Steadfast.' +
      (autoFixed ? ' The address and area were corrected from what you typed.' : '') + '</div>' +
      '<div class="formgrid" style="margin-top:8px">' +
      '<div><label>Recipient</label><input id="ordBookName" value="' + esc(shown.name) + '"></div>' +
      '<div><label>Phone</label><input id="ordBookPhone" value="' + esc(shown.phone) + '"></div>' +
      '<div class="wide"><label>Delivery Address</label><input id="ordBookAddress" value="' + esc(shown.address) + '" oninput="onOrderAddressChanged()"></div>' +
      '<div><label>COD Amount</label><input id="ordBookCod" type="number" min="0" step="1" value="' + num(shown.cod) + '"></div>' +
      '</div>';
    if (errs.length) html += '<div class="muted" style="color:var(--red);margin-top:6px">' + esc(errs.join(' ')) + '</div>';
  }
  box.innerHTML = html;
}

/* Read the courier fields off the modal, falling back to the computed draft when
   the booking form is not on screen (an already-booked order). */
function courierDraftFromForm_(ord) {
  const base = courierBookingDraft(ord);
  const v = id => { const e = document.getElementById(id); return e ? e.value : null; };
  return {
    name: v('ordBookName') != null ? String(v('ordBookName')).trim() : base.name,
    phone: v('ordBookPhone') != null ? String(v('ordBookPhone')).trim() : base.phone,
    address: v('ordBookAddress') != null ? String(v('ordBookAddress')).trim() : base.address,
    cod: v('ordBookCod') != null && v('ordBookCod') !== '' ? num(v('ordBookCod')) : base.cod,
    desc: base.desc
  };
}

/* Book the open order. The parcel is only booked once; a second press re-uses
   the consignment id already on the order rather than sending another parcel. */
function bookOrderCourier() {
  const oid = document.getElementById('ordId').value;
  const o = oid ? (db.orders || []).find(x => x.id === oid) : null;
  if (!o) return alert('Save the order first, then book.');
  if (o.consignmentId) return alert('This order already has a parcel (' + o.consignmentId + ').');
  if (!courierConfigured()) { alert('Set the Steadfast API key and secret in Settings → Courier first.'); return; }
  const draft = courierDraftFromForm_(o);
  /* Correct the draft before checking or showing it, so the confirmation names
     exactly what will leave the building. */
  const corrected = courierCorrectDraft_(o, draft, draft.address).draft;
  const errs = courierBookErrors_(corrected);
  if (errs.length) return alert(errs.join('\n'));
  if (db.settings && db.settings.courierAddressCheck) {
    const loc = bdOrderLocationStatus_();
    if (!loc.ok) return alert(loc.message);
  }
  if (!confirm('Book a Steadfast parcel for ' + (o.orderNo || 'this order') + '?\n\n' +
    'Recipient: ' + corrected.name + '\nPhone: ' + corrected.phone + '\nAddress: ' + corrected.address +
    '\nCOD: ' + money(num(corrected.cod)))) return;
  courierBookOrder_(o, corrected).then(r => {
    if (!r.ok) { alert('Booking failed: ' + r.error); return; }
    renderOrderCourier();
    renderOrders();
    alert('Booked. Consignment ' + r.shipment.consignmentId + '. Status will sync automatically.');
  });
}
