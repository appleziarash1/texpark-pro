/* ============================================================================
   Voice Entry  -  "ajke ei product ta in hoise, naam eita X, quantity 50,
   price porche 120" bole dile ei module nijei bujhe stock/memo te boshiye dey.

   Do part ache:
     1. parseVoiceCommand()  - text theke structured action banay (pure, testable)
     2. applyVoiceActions()  - oi action gulo stock / memo te apply kore
   Mic + TTS ta browser-er SpeechRecognition / speechSynthesis use kore.
   ========================================================================== */

/* ---------- Bangla number handling ---------- */
const BN_DIGITS = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };

/* Multi-word amounts are replaced first, otherwise "ek shoto" (100) would read as
   a 1 followed by a 100. */
const BN_NUM_PHRASES = {
  'ek shoto': 100, 'dui shoto': 200, 'tin shoto': 300, 'char shoto': 400, 'panch shoto': 500,
  'choy shoto': 600, 'shat shoto': 700, 'aat shoto': 800, 'noy shoto': 900,
  'ek hazar': 1000, 'dui hazar': 2000, 'tin hazar': 3000, 'panch hazar': 5000, 'dosh hazar': 10000
};

/* Deliberately small and unambiguous. English number words are left out: "One Plus"
   and "Kids 3pcs Set" are product names, not quantities. */
const BN_NUM_WORDS = {
  shunno: 0, sunno: 0,
  ek: 1, ekta: 1,
  dui: 2, duita: 2,
  tin: 3, tinta: 3,
  char: 4,
  panch: 5, pach: 5,
  choy: 6, soy: 6,
  shat: 7, saat: 7,
  aat: 8,
  dosh: 10, dash: 10,
  bish: 20, kuri: 20,
  ponchash: 50, pachash: 50,
  shoto: 100, hundred: 100
};

function bnNormalizeNumbers(text) {
  let s = String(text || '').toLowerCase();
  Object.keys(BN_NUM_PHRASES).sort((a, b) => b.length - a.length).forEach(k => {
    s = s.replace(new RegExp('\\b' + k.replace(/ /g, '\\s+') + '\\b', 'g'), String(BN_NUM_PHRASES[k]));
  });
  s = s.replace(/[\u09E6-\u09EF]/g, d => BN_DIGITS[d]);
  s = s.replace(/\b([a-z]+)\b/g, w => (w in BN_NUM_WORDS) ? String(BN_NUM_WORDS[w]) : w);
  return s;
}

/* Strip punctuation and squeeze whitespace; keep Bangla + latin. */
function voiceNormalize(text) {
  return bnNormalizeNumbers(String(text || '').toLowerCase())
    .replace(/[^a-z0-9\u0980-\u09FF\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escRx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function phraseRe(w) { return new RegExp('(^|\\s)' + escRx(w) + '(?=\\s|$)', 'g'); }
const hasAny = (t, list) => list.some(w => t.includes(w));

/* ---------- product matching (fuzzy, handles ASR spelling wobble) ---------- */
function voiceProductScore(query, product) {
  const q = voiceNormalize(query);
  const full = voiceNormalize(product.name + ' ' + (product.sku || ''));
  if (!q || !full) return 0;
  if (full === q) return 100;
  if (full.includes(q)) return 70 + Math.min(q.length, 20);
  if (q.includes(full)) return 65 + Math.min(full.length, 20);
  const qt = q.split(' ').filter(t => t.length > 1);
  const nt = full.split(' ').filter(t => t.length > 1);
  let hits = 0;
  qt.forEach(t => { if (nt.some(x => x.includes(t) || t.includes(x))) hits++; });
  return hits ? 25 + hits * 12 : 0;
}

function findProductByName(name) {
  if (!name) return null;
  let best = null, bestScore = 0;
  db.products.forEach(p => {
    const sc = voiceProductScore(name, p);
    if (sc > bestScore) { bestScore = sc; best = p; }
  });
  return bestScore >= 25 ? best : null;
}

/* ---------- keyword sets ---------- */
const V_IN_WORDS = ['in hoise', 'in hoyeche', 'in holo', 'ashche', 'ashe', 'ashlo', 'elo', 'elom', 'received', 'receive',
  'mail', 'milo', 'stok', 'stock e', 'baralam', 'barlam', 'joma', 'dhuklo', 'dhukche', 'kinechi', 'kinlam', 'purchase'];
const V_OUT_WORDS = ['sell', 'sold', 'bikri', 'bech', 'bechlam', 'memo', 'chole gelo', 'delivery hoyeche'];

/* Which number-slot a keyword announces. */
const V_FIELDS = [
  { key: 'qty', words: ['quantity', 'qty', 'kot', 'koto', 'piece', 'pieces', 'pcs', 'pc', 'poriman', 'lagbe'] },
  { key: 'cost', words: ['price porche', 'porche', 'cost', 'kinechi', 'kinlam', 'kroy', 'dar', 'buy price'] },
  { key: 'rate', words: ['sell price', 'sell rate', 'sell', 'bikri', 'bikroy', 'rate'] }
];
const V_FIELD_WORDS = V_FIELDS.reduce((a, f) => a.concat(f.words), []);

const V_NAME_WORDS = ['naam', 'nam', 'product', 'ei product'];
const V_FILLER = [
  ...V_IN_WORDS, ...V_OUT_WORDS, ...V_FIELD_WORDS, ...V_NAME_WORDS,
  'ajke', 'aj', 'ei', 'eita', 'ta', 'the', 'hoise', 'hoyeche', 'holo', 'hoy',
  'ke', 're', 'ra', 'ko', 'er', 'amar', 'ami', 'bhai', 'please', 'koro', 'kore', 'dao', 'den', 'din',
  'bol', 'boli', 'bolchi', 'ar', 'ebong', 'and', 'o', 'name', 'number'
].sort((a, b) => b.length - a.length);

/* These alone are never a product name. */
const V_META = new Set(['price', 'rate', 'quantity', 'qty', 'cost', 'pcs', 'pc', 'piece', 'pieces',
  'name', 'naam', 'nam', 'sell', 'sold', 'stock', 'memo', 'delivery', 'total', 'amount', 'taka', 'purchase']);

/* What is left of a chunk once numbers and filler words are removed is the name. */
function voiceExtractName(chunk) {
  let s = ' ' + String(chunk || '') + ' ';
  // "Rahim ke" / "Karim ke" is the customer, not the product
  s = s.replace(/(^|\s)[a-z\u0980-\u09FF]+\s+ke(?=\s|$)/gi, ' ');
  s = s.replace(/\d+(?:\.\d+)?/g, ' ');
  V_FILLER.forEach(w => { s = s.replace(phraseRe(w), ' '); });
  s = voiceNormalize(s);
  if (!s) return '';
  const words = s.split(' ').filter(Boolean);
  if (words.every(w => V_META.has(w))) return '';
  return s;
}

/* Names in the order they were spoken - one per product. */
function voiceExtractNames(text) {
  const segs = text.split(/\s+ar\s+|\s+ebong\s+|\s+and\s+|\s*,\s*/i);
  const out = [];
  segs.forEach(seg => {
    const nm = voiceExtractName(seg);
    if (nm && out.indexOf(nm) === -1) out.push(nm);
  });
  return out;
}

/* Bind a number to the keyword that sits closest *before* it, but never looking
   further back than the previous number - that keeps "quantity 10 ar quantity 6"
   as two separate quantity slots. */
function voiceFieldOfNumber(text, from, at) {
  let best = null, bestDist = Infinity;
  const window = text.slice(from, at);
  const base = from;
  V_FIELDS.forEach(f => {
    f.words.forEach(w => {
      const re = new RegExp('(^|\\s)' + escRx(w) + '(?=\\s|$)', 'g');
      let m;
      while ((m = re.exec(window)) !== null) {
        const end = base + m.index + m[0].length;
        const dist = at - end;
        if (dist < bestDist) { bestDist = dist; best = f.key; }
      }
    });
  });
  return best;
}

/* ---------- the parser ---------- */
function parseVoiceCommand(text, opts) {
  opts = opts || {};
  const clean = voiceNormalize(text);
  const actions = [];
  const transcript = String(text || '');
  if (!clean) return { actions, transcript };

  const nums = [...clean.matchAll(/\d+(?:\.\d+)?/g)].map(m => ({ v: Number(m[0]), at: m.index, end: m.index + m[0].length }));
  // A sentence with no number in it can never be a stock or sales entry.
  if (!nums.length) return { actions, transcript };

  let prevEnd = 0;
  nums.forEach(n => { n.field = voiceFieldOfNumber(clean, prevEnd, n.at); prevEnd = n.end; });

  const kind = hasAny(clean, V_OUT_WORDS) ? 'out' : (hasAny(clean, V_IN_WORDS) ? 'in' : (opts.defaultKind || 'in'));
  const names = voiceExtractNames(clean);
  const take = f => { const n = nums.find(x => !x.used && x.field === f); if (n) { n.used = true; return n.v; } return null; };

  if (names.length > 1) {
    // several products in one breath: qty/price line up in the order spoken
    names.forEach(nm => {
      actions.push({ kind, name: nm, qty: take('qty'), cost: take('cost'), rate: take('rate'), productId: null });
    });
  } else {
    let qty = take('qty'), cost = take('cost'), rate = take('rate');
    const left = nums.filter(x => !x.used);
    if (qty === null && left.length) qty = left.shift().v;                     // first leftover number is the qty
    if (cost === null && rate === null && left.length) {
      if (kind === 'out') rate = left.shift().v; else cost = left.shift().v;   // next leftover is the price
    }
    if (kind === 'out' && rate === null && cost !== null) { rate = cost; cost = null; }
    actions.push({ kind, name: names[0] || '', qty, cost, rate, productId: null });
  }

  // Never write a row that carries no product and no quantity.
  const usable = actions.filter(a => {
    if (!a.name) return false;
    return num(a.qty) > 0;   // a row with no quantity is not an entry
  });

  return { actions: usable, transcript };
}

/* ---------- resolving + applying ---------- */
/* Attach a product to every action: reuse the existing one, else make a new
   product on the spot so nothing the boss says gets lost. */
function voiceResolveProducts(actions) {
  actions.forEach(a => {
    if (!a.name && a.productId) return;
    const exact = (db.products || []).find(p => voiceNormalize(p.name) === a.name);
    const found = exact || findProductByName(a.name);
    if (found) { a.productId = found.id; a.matched = true; return; }
    if (a.kind === 'in' && a.name) {
      const p = {
        id: id(), name: a.name, sku: '', category: 'Voice Entry', unit: 'pcs',
        rate: num(a.rate) || 0, cost: num(a.cost) || 0, vat: 0,
        reorderLevel: num(db.settings.lowStockLevel)
      };
      db.products.push(p);
      a.productId = p.id; a.created = true; a.matched = false;
    }
  });
  return actions;
}

function applyVoiceActions(actions) {
  voiceResolveProducts(actions);
  const done = [];
  actions.forEach(a => {
    if (!a.productId) return;
    const p = productById(a.productId);
    if (a.kind === 'in') {
      const s = stockOf(a.productId);
      const q = num(a.qty);
      if (q > 0) {
        s.opening = num(s.opening) + q;
        s.available = stockAvailable(s);
        logStock(a.productId, 'Opening', q, 'Voice', 'Voice entry - received');
      }
      if (num(a.cost) > 0) s.cost = num(a.cost);
      if (num(a.rate) > 0 && !num(p.rate)) p.rate = num(a.rate);
      if (num(a.cost) > 0) p.cost = num(a.cost);
      done.push({ a, product: p, qty: q, available: s.available, cost: stockCost(a.productId) });
    } else {
      const rate = num(a.rate) || num(p.rate);
      const cost = stockCost(a.productId) || num(p.cost);
      addMemoLine({ productId: a.productId, qty: num(a.qty) || 1, rate, cost, vat: num(p.vat) || 0 });
      done.push({ a, product: p, qty: num(a.qty) || 1, rate, cost });
    }
  });
  const okCommit = commit();
  if (okCommit) renderAll();
  if (done.some(d => d.a.kind === 'out')) calcMemo();
  return done;
}

/* ---------- spoken feedback ---------- */
function voiceSpeak(text) {
  try {
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'bn-BD';
    u.rate = 0.98;
    const bn = (speechSynthesis.getVoices() || []).find(v => /bn|bangla|bengali/i.test(v.lang + v.name));
    if (bn) u.voice = bn;
    speechSynthesis.speak(u);
  } catch (e) { /* voice output is a nicety, never break the entry */ }
}

/* ---------- mic + panel UI ---------- */
let voiceRec = null;
let voiceListening = false;
let voiceLastActions = [];

function voiceSupported() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function voicePanel() { return document.getElementById('voicePanel'); }

/* The panel markup (status line, result body, type-in fallback) lives in index.html,
   so we only swap the body and open/close. */
function voiceShow(html) {
  const p = voicePanel();
  if (p) p.classList.add('show');
  const b = document.getElementById('voiceBody');
  if (b) b.innerHTML = html;
}

function voiceHide() {
  voiceStop();
  const p = voicePanel();
  if (p) p.classList.remove('show');
}

function voiceStatus(msg) {
  const s = document.getElementById('voiceStatus');
  if (s) s.textContent = msg;
}

/* Which book should an ambiguous sentence go to? Take it from the page the user
   is standing on, so the mic on Stock means "received" and on Memo means "sold". */
function voiceDefaultKind() {
  if (currentPage === 'memo') return 'out';
  return 'in';
}

/* ---------- why the mic may refuse to work ----------
   Two traps worth knowing about:
   * iPhone/iPad: speech recognition works in Safari but Apple blocks it inside an
     app installed to the home screen. Turning the site into an app is exactly what
     stops the mic, so send people back to plain Safari.
   * Any plain-http page is not a "secure context", so the browser hides the mic
     without ever asking. */
function voiceEnv() {
  const win = (typeof window !== 'undefined' && window) || {};
  const nav = win.navigator || (typeof navigator !== 'undefined' && navigator) || {};
  const ua = nav.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const standalone = nav.standalone === true ||
    !!(win.matchMedia && win.matchMedia('(display-mode: standalone)').matches);
  // a stub location (tests, odd embeds) has no protocol; fall back to the real one
  const loc = (win.location && win.location.protocol) ? win.location
    : ((typeof location !== 'undefined' && location) || {});
  const host = loc.hostname || '';
  const secure = win.isSecureContext === true ||
    loc.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1';
  return { iOS, standalone, secure, ua };
}

/* Returns {title, body} in Bangla when the mic cannot work here, else null. */
function voiceMicBlocked() {
  const env = voiceEnv();
  if (env.iOS && env.standalone) {
    return {
      title: 'iPhone-e mic cholbe na ei installed app theke',
      body: 'Ei ta Apple-er limitation — permission-er problem na. Home screen e install kora app-e ' +
        'Apple speech recognition bondho rakhe. Safari browser khule same link ta kholun ' +
        '(Share > Open in Safari), tahole mic kaj korbe.'
    };
  }
  if (!voiceSupported()) {
    return {
      title: 'Ei browser-e voice support nei',
      body: 'Chrome (Android/PC) ba Safari (iPhone) use korun. Ei browser e sona jabe na.'
    };
  }
  if (!env.secure) {
    return {
      title: 'Mic er jonno https:// dorkar',
      body: 'Ei page ta secure connection (https://) theke khulechen na, tai browser mic ta ' +
        'bondho rekheche — onumoti cheyeo na. https:// link ba localhost theke kholun.'
    };
  }
  return null;
}

function voiceTypeFocus() {
  const i = document.getElementById('voiceTypeInput');
  if (i) { try { i.focus(); } catch (e) {} }
}

let voiceWant = false;        // the user still wants to be listening
let voiceRestarts = 0;        // guards against a restart loop on a silent mic

function voiceToggle() {
  if (voiceListening || voiceWant) { voiceStop(); return; }

  const blocked = voiceMicBlocked();
  if (blocked) {
    voiceShow('<div class="vp-head"><b>Voice</b><button class="btn-light btn-sm" onclick="voiceHide()">x</button></div>' +
      '<div class="vp-body"><div class="vp-block"><b>' + blocked.title + '</b>' + blocked.body + '</div>' +
      '<div class="vp-hint">Mic chara-o sob kichu korte parben — niche type kore likhe din, ' +
      'stock o memo duitai same bhabe kaj korbe.</div></div>');
    voiceTypeFocus();
    return;
  }
  voiceStart();
}

function voiceStart() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  voiceRec = new SR();
  voiceRec.lang = 'bn-BD';
  voiceRec.continuous = true;
  voiceRec.interimResults = true;

  voiceWant = true;
  voiceRestarts = 0;
  voiceListening = true;
  voiceUpdateButton();
  voiceStatus('Shunchi... bole jaan.');
  voiceShow('<div class="vp-head"><b>Voice</b><span class="vp-live">&#9679; shunchi</span>' +
    '<button class="btn-light btn-sm" onclick="voiceStop()">Stop</button></div>' +
    '<div class="vp-body"><div class="vp-hint">Boliye din: "naam eita Kids 3pcs Set, quantity 50, price porche 120"</div></div>');

  voiceRec.onresult = e => {
    voiceRestarts = 0;
    let finalText = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' ';
    }
    const interim = [...e.results].map(r => r[0].transcript).join(' ');
    voiceShow('<div class="vp-head"><b>Voice</b><span class="vp-live">&#9679; shunchi</span>' +
      '<button class="btn-light btn-sm" onclick="voiceStop()">Stop</button></div>' +
      '<div class="vp-body"><div class="vp-heard">' + esc(interim) + '</div>' +
      '<div class="vp-hint">Boliye din: "naam eita Kids 3pcs Set, quantity 50, price porche 120"</div></div>');
    if (finalText.trim()) voiceHandle(finalText.trim());
  };

  voiceRec.onerror = e => {
    const err = e.error;
    if (err === 'aborted') return;                       // we stopped it on purpose
    if (err === 'no-speech') return;                     // silence; onend listens again
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      voiceWant = false; voiceListening = false; voiceUpdateButton();
      const env = voiceEnv();
      const how = env.iOS
        ? 'Safari-r address bar er "AA" (othoba Settings > Safari > Microphone) theke ' +
          'Microphone > Allow korun, tarpor page ta reload korun.'
        : 'Address bar er lock icon > Permissions > Microphone > Allow korun, ' +
          'tarpor page ta reload korun.';
      voiceShow('<div class="vp-head"><b>Voice</b><button class="btn-light btn-sm" onclick="voiceHide()">x</button></div>' +
        '<div class="vp-body"><div class="vp-block"><b>Browser mic er onumoti dey nai</b>' + how + '</div>' +
        '<div class="vp-hint">Onumoti chara-o niche type kore likhe din — kaj same bhabe hobe.</div></div>');
      voiceTypeFocus();
      return;
    }
    if (err === 'audio-capture') {
      voiceWant = false; voiceListening = false; voiceUpdateButton();
      voiceStatus('Mic pawa gelo na. Device-er mic thik ache kina dekhun.');
      return;
    }
    if (err === 'network') { voiceStatus('Internet nei — voice recognition er net dorkar.'); return; }
    voiceStatus('Error: ' + err);
  };

  voiceRec.onend = () => {
    voiceListening = false; voiceUpdateButton();
    if (!voiceWant) {
      if (!voiceLastActions.length) voiceStatus('Theme giyeche. Abar mic chepe bolun.');
      return;
    }
    // Chrome/Safari end the session on their own after a pause; keep listening
    // until the user says stop, but give up if nothing came through at all.
    if (voiceRestarts >= 25) {
      voiceWant = false;
      voiceStatus('Onek khon shuneo kichu pelam na. Mic abar chepe bolun.');
      return;
    }
    voiceRestarts++;
    try { voiceRec.start(); voiceListening = true; voiceUpdateButton(); } catch (e) { voiceWant = false; }
  };

  try { voiceRec.start(); } catch (e) { voiceStatus('Start korte parlam na: ' + e.message); }
}

function voiceStop() {
  voiceWant = false;
  voiceListening = false;
  try { if (voiceRec) voiceRec.stop(); } catch (e) {}
  voiceUpdateButton();
}

function voiceUpdateButton() {
  const b = document.getElementById('voiceBtn');
  if (b) b.classList.toggle('listening', voiceListening);
}

/* A finished sentence arrived: understand it, apply it, say it back. */
function voiceHandle(text) {
  const parsed = parseVoiceCommand(text, { defaultKind: voiceDefaultKind() });
  if (!parsed.actions.length) {
    voiceStatus('Bujhte parlam na. Abar bolun.');
    return;
  }
  const done = applyVoiceActions(parsed.actions);

  const lines = parsed.actions.map(a => {
    const p = productById(a.productId);
    const nm = p ? p.name : (a.name || '?');
    if (a.kind === 'in') {
      return '<div class="vp-row"><b>' + esc(nm) + '</b>' +
        (a.created ? ' <span class="vp-new">notun product</span>' : '') +
        ' &middot; received <b>' + num(a.qty) + '</b>' +
        (num(a.cost) ? ' &middot; cost ' + money(a.cost) : '') +
        '</div>';
    }
    return '<div class="vp-row"><b>' + esc(nm) + '</b>' +
      (a.created ? ' <span class="vp-new">notun product</span>' : '') +
      ' &middot; memo te <b>' + num(a.qty) + '</b> pcs &middot; rate ' + money(a.rate) +
      ' &middot; line total <b>' + money(num(a.qty) * num(a.rate)) + '</b></div>';
  }).join('');

  const speech = parsed.actions.map(a => {
    const p = productById(a.productId);
    const nm = p ? p.name : (a.name || '');
    if (a.kind === 'in') {
      const s = findStock(a.productId);
      return nm + ' ekhon stock e ' + (s ? num(s.available) : 0) + ' ache';
    }
    const line = num(a.qty) * num(a.rate);
    return nm + ' memo te boshalam, line total ' + money(line);
  }).join('. ');

  voiceShow('<div class="vp-head"><b>Voice</b><span class="vp-ok">&#10003; hoye geche</span>' +
    '<button class="btn-light btn-sm" onclick="voiceStop()">Stop</button></div>' +
    '<div class="vp-body"><div class="vp-heard">"' + esc(text) + '"</div>' + lines +
    '<div class="vp-hint">Sob kichu save hoye geche. Bhul hole page theke edit kore nin.</div></div>');
  voiceSpeak(speech);
  voiceLastActions = parsed.actions;
}

/* Type instead of talking - same brain, useful in a quiet office or a browser
   without mic access. */
function voiceTypeSubmit() {
  const inp = document.getElementById('voiceTypeInput');
  if (!inp) return;
  const v = inp.value.trim();
  if (!v) return;
  inp.value = '';
  voiceHandle(v);
}

/* ---------- voices warm-up (Chrome loads them async) ---------- */
if (typeof window !== 'undefined' && typeof speechSynthesis !== 'undefined') {
  try { speechSynthesis.getVoices(); } catch (e) {}
}
