/* ============================================================================
   Voice Entry  -  say "ajke ei product ta in hoise, naam eita X, quantity 50,
   price porche 120" and this module understands it and files it into stock/memo.

   Two parts:
     1. parseVoiceCommand()  - turns text into structured actions (pure, testable)
     2. applyVoiceActions()  - applies those actions to stock / memo
   Mic + TTS use the browser's SpeechRecognition / speechSynthesis.

   The spoken-word vocabulary (V_IN_WORDS, V_FILLER, ...) is deliberately left in
   Bangla and romanized Banglish: it is the input the parser has to recognise, not
   interface text.
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
  'mail', 'milo', 'stok', 'stock e', 'baralam', 'barlam', 'joma', 'dhuklo', 'dhukche', 'kinechi', 'kinlam', 'purchase',
  /* Bangla script: speech recognition returns Bangla, not roman, for bn-BD */
  'ইন', 'আসছে', 'এসেছে', 'এলো', ' ঢুকলো', 'ঢুকেছে', 'পেয়েছি', 'কিনেছি', 'কিনলাম', 'পেলাম', 'স্টক', 'মাল'];
const V_OUT_WORDS = ['sell', 'sold', 'bikri', 'bech', 'bechlam', 'memo', 'chole gelo', 'delivery hoyeche',
  'বিক্রি', 'বেচা', 'বেচলাম', 'বেচেছে', 'মেমো', 'সেল', 'গেলো', 'ডেলিভারি'];

/* Which number-slot a keyword announces. */
const V_FIELDS = [
  { key: 'qty', words: ['quantity', 'qty', 'kot', 'koto', 'piece', 'pieces', 'pcs', 'pc', 'poriman', 'lagbe',
      'পরিমাণ', 'কত', 'কতটা', 'পিস', 'পিচ', 'সংখ্যা'] },
  { key: 'cost', words: ['price porche', 'porche', 'cost', 'kinechi', 'kinlam', 'kroy', 'dar', 'buy price',
      'দাম', 'পড়ছে', 'পড়লো', 'ক্রয়', 'কিনদাম', 'মূল্য'] },
  { key: 'rate', words: ['sell price', 'sell rate', 'sell', 'bikri', 'bikroy', 'rate',
      'বিক্রয়', 'বিক্রি মূল্য', 'দরে', 'রেট'] }
];
const V_FIELD_WORDS = V_FIELDS.reduce((a, f) => a.concat(f.words), []);

const V_NAME_WORDS = ['naam', 'nam', 'product', 'ei product', 'নাম', 'প্রোডাক্ট', 'পণ্য', 'জিনিস'];
const V_FILLER = [
  ...V_IN_WORDS, ...V_OUT_WORDS, ...V_FIELD_WORDS, ...V_NAME_WORDS,
  'ajke', 'aj', 'ei', 'eita', 'ta', 'the', 'hoise', 'hoyeche', 'holo', 'hoy',
  'ke', 're', 'ra', 'ko', 'er', 'amar', 'ami', 'bhai', 'please', 'koro', 'kore', 'dao', 'den', 'din',
  'bol', 'boli', 'bolchi', 'ar', 'ebong', 'and', 'o', 'name', 'number',
  /* Bangla fillers - without these every Bangla sentence names a product "হয়" */
  'আজ', 'আজকে', 'এই', 'এটা', 'জিনিসটা', 'পণ্যটা', 'হয়েছে', 'হয়', 'হলো', 'হইলো', 'হৈছে',
  'কে', 'এর', 'আমার', 'আমি', 'ভাই', 'প্লিজ', 'কর', 'করে', 'দাও', 'দেন', 'দিন',
  'বল', 'বলি', 'বলছি', 'আর', 'এবং', 'টা', 'টি', 'ও', 'নাম', 'নাম্বার', 'পরে', 'হছে', 'হইছে'
].sort((a, b) => b.length - a.length);

/* These alone are never a product name. */
const V_META = new Set(['price', 'rate', 'quantity', 'qty', 'cost', 'pcs', 'pc', 'piece', 'pieces',
  'name', 'naam', 'nam', 'sell', 'sold', 'stock', 'memo', 'delivery', 'total', 'amount', 'taka', 'purchase',
  'দাম', 'রেট', 'পরিমাণ', 'পিস', 'নাম', 'বিক্রি', 'স্টক', 'মেমো', 'ডেলিভারি', 'মোট', 'টাকা']);

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
      title: 'The mic will not work from this installed app on iPhone',
      body: 'This is an Apple limitation — not a permission problem. Apple turns off speech ' +
        'recognition in apps installed to the home screen. Open the same link in the Safari ' +
        'browser (Share > Open in Safari) and the mic will work.'
    };
  }
  if (!voiceSupported()) {
    return {
      title: 'This browser has no voice support',
      body: 'Use Chrome (Android/PC) or Safari (iPhone). Listening will not work in this browser.'
    };
  }
  if (!env.secure) {
    return {
      title: 'The mic needs https://',
      body: 'This page was not opened over a secure connection (https://), so the browser has ' +
        'kept the mic off — it will not even ask for permission. Open it from an https:// link or localhost.'
    };
  }
  return null;
}

function voiceTypeFocus() {
  const i = document.getElementById('voiceTypeInput');
  if (i) { try { i.focus(); } catch (e) {} }
}

/* Chrome's speech engine has no Bangla model. Asking for bn-BD does not error -
   it simply never recognises anything, which looks exactly like a dead mic.
   So we listen in a language it does have; the parser understands both Bangla
   script and roman input either way. */
const V_LANG_TRY = ['bn-BD', 'bn-IN', 'en-IN', 'en-US'];
let voiceLangIdx = 0;

function voiceLang() { return V_LANG_TRY[Math.min(voiceLangIdx, V_LANG_TRY.length - 1)]; }

function voiceLangNext() { return V_LANG_TRY[Math.min(voiceLangIdx + 1, V_LANG_TRY.length - 1)]; }

/* Step to the next candidate language. False when we have run out. */
function voiceAdvanceLang() {
  if (voiceLangIdx >= V_LANG_TRY.length - 1) return false;
  voiceLangIdx++;
  return true;
}

let voiceWant = false;        // the user still wants to be listening
let voiceRestarts = 0;        // guards against a restart loop on a silent mic
let voiceGotAnything = false; // anything at all came back from the engine

function voiceToggle() {
  if (voiceListening || voiceWant) { voiceStop(); return; }

  const blocked = voiceMicBlocked();
  if (blocked) {
    voiceShow('<div class="vp-head"><b>Voice</b><button class="btn-light btn-sm" onclick="voiceHide()">x</button></div>' +
      '<div class="vp-body"><div class="vp-block"><b>' + blocked.title + '</b>' + blocked.body + '</div>' +
      '<div class="vp-hint">You can do everything without the mic — type below; ' +
      'stock and memos both work the same way.</div></div>');
    voiceTypeFocus();
    return;
  }
  voiceStart();
}

function voiceStart() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  voiceRec = new SR();
  voiceRec.lang = voiceLang();
  voiceRec.continuous = true;
  voiceRec.interimResults = true;

  voiceWant = true;
  voiceRestarts = 0;
  voiceGotAnything = false;
  voiceListening = true;
  voiceUpdateButton();
  voiceStatus('Listening... go ahead. (' + voiceLang() + ')');
  voiceShow('<div class="vp-head"><b>Voice</b><span class="vp-live">&#9679; listening ' + esc(voiceLang()) + '</span>' +
    '<button class="btn-light btn-sm" onclick="voiceStop()">Stop</button></div>' +
    '<div class="vp-body"><div class="vp-hint">Say: "Kids 3pcs Set received, quantity 50, cost 120"</div></div>');

  voiceRec.onresult = e => {
    voiceRestarts = 0;
    voiceGotAnything = true;
    let finalText = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' ';
    }
    const interim = [...e.results].map(r => r[0].transcript).join(' ');
    voiceShow('<div class="vp-head"><b>Voice</b><span class="vp-live">&#9679; listening</span>' +
      '<button class="btn-light btn-sm" onclick="voiceStop()">Stop</button></div>' +
      '<div class="vp-body"><div class="vp-heard">' + esc(interim) + '</div>' +
      '<div class="vp-hint">Say: "Kids 3pcs Set received, quantity 50, cost 120"</div></div>');
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
        ? 'In Safari\'s address bar tap "AA" (or Settings > Safari > Microphone), set ' +
          'Microphone > Allow, then reload the page.'
        : 'Use the lock icon in the address bar > Permissions > Microphone > Allow, ' +
          'then reload the page.';
      voiceShow('<div class="vp-head"><b>Voice</b><button class="btn-light btn-sm" onclick="voiceHide()">x</button></div>' +
        '<div class="vp-body"><div class="vp-block"><b>The browser did not grant mic permission</b>' + how + '</div>' +
        '<div class="vp-hint">You can also type below — it works the same way.</div></div>');
      voiceTypeFocus();
      return;
    }
    if (err === 'audio-capture') {
      voiceWant = false; voiceListening = false; voiceUpdateButton();
      voiceStatus('No microphone found. Check that the device\'s mic is working.');
      return;
    }
    if (err === 'network') { voiceStatus('No internet — voice recognition needs a connection.'); return; }
    voiceStatus('Error: ' + err);
  };

  voiceRec.onend = () => {
    voiceListening = false; voiceUpdateButton();
    if (!voiceWant) {
      if (!voiceLastActions.length) voiceStatus('Stopped. Press the mic again and speak.');
      return;
    }
    // Chrome and Safari end a session on their own after a pause; keep listening
    // until the user says stop.
    if (voiceRestarts >= 3 && !voiceGotAnything) {
      // Nothing at all came back, which for a silent engine means the requested
      // language has no model here. Try another instead of looping forever.
      if (voiceAdvanceLang()) {
        voiceRestarts = 0;
        voiceShow('<div class="vp-head"><b>Voice</b><span class="vp-live">&#9679; listening</span>' +
          '<button class="btn-light btn-sm" onclick="voiceStop()">Stop</button></div>' +
          '<div class="vp-body"><div class="vp-hint">Nothing came back in ' + voiceLang() +
          ', so now listening in <b>' + esc(voiceLangNext()) + '</b>. Speak again.</div></div>');
        try { voiceRec.lang = voiceLang(); voiceRec.start(); voiceListening = true; voiceUpdateButton(); } catch (e) { voiceWant = false; }
        return;
      }
      voiceWant = false;
      voiceShow('<div class="vp-head"><b>Voice</b><button class="btn-light btn-sm" onclick="voiceHide()">x</button></div>' +
        '<div class="vp-body"><div class="vp-block"><b>The mic is listening but understands nothing</b>' +
        'This browser\'s speech engine has no Bangla model, so nothing comes back even when you ' +
        'speak, and it shows no error either. That is a browser limitation, not a fault of the mic ' +
        'or the permission.<br><br>' +
        'To get the job done, <b>type it below</b> — stock and memos both work the same way. ' +
        'Or open it in Chrome (Android/PC) or Safari (iPhone).</div></div>');
      voiceTypeFocus();
      return;
    }
    voiceRestarts++;
    try { voiceRec.start(); voiceListening = true; voiceUpdateButton(); } catch (e) { voiceWant = false; }
  };

  try { voiceRec.start(); } catch (e) { voiceStatus('Could not start: ' + e.message); }
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
    voiceStatus('Could not understand that. Please say it again.');
    return;
  }
  const done = applyVoiceActions(parsed.actions);

  const lines = parsed.actions.map(a => {
    const p = productById(a.productId);
    const nm = p ? p.name : (a.name || '?');
    if (a.kind === 'in') {
      return '<div class="vp-row"><b>' + esc(nm) + '</b>' +
        (a.created ? ' <span class="vp-new">new product</span>' : '') +
        ' &middot; received <b>' + num(a.qty) + '</b>' +
        (num(a.cost) ? ' &middot; cost ' + money(a.cost) : '') +
        '</div>';
    }
    return '<div class="vp-row"><b>' + esc(nm) + '</b>' +
      (a.created ? ' <span class="vp-new">new product</span>' : '') +
      ' &middot; on memo <b>' + num(a.qty) + '</b> pcs &middot; rate ' + money(a.rate) +
      ' &middot; line total <b>' + money(num(a.qty) * num(a.rate)) + '</b></div>';
  }).join('');

  const speech = parsed.actions.map(a => {
    const p = productById(a.productId);
    const nm = p ? p.name : (a.name || '');
    if (a.kind === 'in') {
      const s = findStock(a.productId);
      return nm + ' now has ' + (s ? num(s.available) : 0) + ' in stock';
    }
    const line = num(a.qty) * num(a.rate);
    return nm + ' added to the memo, line total ' + money(line);
  }).join('. ');

  voiceShow('<div class="vp-head"><b>Voice</b><span class="vp-ok">&#10003; done</span>' +
    '<button class="btn-light btn-sm" onclick="voiceStop()">Stop</button></div>' +
    '<div class="vp-body"><div class="vp-heard">"' + esc(text) + '"</div>' + lines +
    '<div class="vp-hint">Everything was saved. If something is wrong, edit it from the page.</div></div>');
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
