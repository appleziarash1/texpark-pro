/* Bangladesh address → District / Thana(Upazila) resolver.

   Pure functions, no DOM and no network, so the whole thing is unit-testable and
   the booking code can call it without a socket. The location list is the offline
   bundle in js/bd-locations.js (see data/SOURCE.md for provenance).

   The rule that matters: a district is only trusted when it is the *place* the
   address is being sent to, not a reference point. "Deliver from Dhaka office,
   village Char Fasson, Bhola" must resolve to Bhola, never Dhaka. So the last,
   most specific location wins, a mid-string district that is followed by further
   location words is treated as weak, and a thana is never invented from a
   district alone — an unresolved thana means we ask, we do not guess. */

function bdLocationData() {
  return (typeof window !== 'undefined' && window.BD_LOCATIONS) ? window.BD_LOCATIONS : null;
}

function bdDatasetVersion() {
  const d = bdLocationData();
  return d ? String(d.datasetVersion || '') : '';
}

/* Lower-case, punctuation-stripped, so "Cox's Bazar", "Coxs Bazar" and the
   Bangla name all fold to one key. Apostrophes/dots/dashes are removed (not
   spaced) to line up with the keys built into the dataset; every other mark
   becomes a space. Bengali digits are mapped to ASCII so "১২৩" and "123" match. */
function normalizeBd_(text) {
  let s = String(text == null ? '' : text);
  if (s.normalize) s = s.normalize('NFC');
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  s = s.replace(/[\u09E6-\u09EF]/g, c => String(c.charCodeAt(0) - 0x09E6));
  s = s.replace(/[\u09F0-\u09F9]/g, '');
  s = s.replace(/['\u2019`.]/g, '');
  s = s.replace(/-/g, ' ');
  s = s.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}

function bdTokens_(text) {
  const n = normalizeBd_(text);
  return n ? n.split(' ') : [];
}

/* ---- lookup indexes, built once from the bundle ---- */
var _bdDistrictByAlias = null;
var _bdThanaByAlias = null;
var _bdThanaGlobal = null;

function bdBuildIndex_() {
  if (_bdDistrictByAlias) return;
  _bdDistrictByAlias = {};
  _bdThanaByAlias = {};
  _bdThanaGlobal = {};
  const data = bdLocationData();
  const districts = (data && data.districts) || [];
  districts.forEach(d => {
    const aliases = (d.aliases && d.aliases.length ? d.aliases : [normalizeBd_(d.name)])
      .concat([normalizeBd_(d.name), normalizeBd_(d.nameBn)]).filter(Boolean);
    aliases.forEach(a => { if (!(a in _bdDistrictByAlias)) _bdDistrictByAlias[a] = d; });
    (d.thanas || []).forEach(t => {
      const tal = (t.aliases && t.aliases.length ? t.aliases : [normalizeBd_(t.name)])
        .concat([normalizeBd_(t.name)]).filter(Boolean);
      tal.forEach(a => {
        _bdThanaByAlias[d.code + '|' + a] = { thana: t, district: d };
        (_bdThanaGlobal[a] = _bdThanaGlobal[a] || []).push({ thana: t, district: d });
      });
    });
  });
}

function bdDistricts() {
  const data = bdLocationData();
  return ((data && data.districts) || []).map(d => ({ code: d.code, name: d.name, nameBn: d.nameBn, division: d.division }));
}

function bdThanasFor(districtNameOrCode) {
  const data = bdLocationData();
  if (!data) return [];
  const want = normalizeBd_(districtNameOrCode);
  const d = (data.districts || []).find(x =>
    x.code === districtNameOrCode || normalizeBd_(x.name) === want || normalizeBd_(x.nameBn) === want ||
    (x.aliases || []).indexOf(want) !== -1);
  return d ? (d.thanas || []).map(t => ({ name: t.name, nameBn: t.nameBn, type: t.type })) : [];
}

/* Find every alias (1..3 words) of an index in the token stream. Returns the hits
   in order with their token span. */
function bdFindAliases_(tokens, index) {
  const hits = [];
  const maxLen = 3;
  for (let i = 0; i < tokens.length; i++) {
    for (let len = Math.min(maxLen, tokens.length - i); len >= 1; len--) {
      const phrase = tokens.slice(i, i + len).join(' ');
      if (index[phrase]) { hits.push({ key: phrase, start: i, end: i + len - 1, val: index[phrase] }); i += len - 1; break; }
    }
  }
  return hits;
}

/* A labelled field beats positional guessing: "district: X", "জেলা: X". */
function bdLabelled_(tokens) {
  const labels = ['district', 'zilla', 'jela', 'জেলা', 'জিলা'];
  for (let i = 0; i < tokens.length; i++) {
    if (labels.indexOf(tokens[i]) !== -1) {
      const after = tokens.slice(i + 1, i + 4);
      if (after.length) return after;
    }
  }
  return null;
}

/* Some districts the dataset spells one way are typed another; the generator puts
   those variants in the alias list, so nothing extra is needed here. */

/* Resolve an address to { district, thana, confidence, source }.
   structured (optional) = { district, thana } supplied by the user/record.
   confidence: 'high' | 'medium' | 'low' | 'none'. */
function resolveBdLocation(rawAddress, structured) {
  bdBuildIndex_();
  const tokens = bdTokens_(rawAddress);

  /* 1. an explicit, valid structured location wins (priority 1–2). If it also
        disagrees with the text, say so (conflict) so the UI can ask. */
  if (structured && structured.district) {
    const sd = bdResolveDistrictName_(structured.district);
    if (sd) {
      const st = structured.thana ? bdResolveThanaName_(sd, structured.thana) : null;
      const textHit = bdScanDistrict_(tokens);
      const conflict = !!(textHit && textHit.district.code !== sd.code);
      return {
        district: sd.name, districtCode: sd.code,
        thana: st ? st.name : null,
        confidence: conflict ? 'low' : (st ? 'high' : 'medium'),
        source: 'structured', conflict: conflict
      };
    }
  }

  /* 2. labelled district in the text */
  const lab = bdLabelled_(tokens);
  if (lab) {
    const sd = bdResolveDistrictNamePhrase_(lab);
    if (sd) {
      const th = bdScanThana_(tokens, sd);
      return { district: sd.name, districtCode: sd.code, thana: th ? th.name : null,
        confidence: th ? 'high' : 'medium', source: 'labeled', conflict: false };
    }
  }

  /* 3. positional scan */
  const dHit = bdScanDistrict_(tokens);

  /* 3a. no district named — but a thana might name its own district unambiguously */
  if (!dHit) {
    const g = bdScanThanaGlobal_(tokens);
    if (g && g.unique) {
      return { district: g.district.name, districtCode: g.district.code, thana: g.thana.name,
        confidence: 'medium', source: 'thana', conflict: false };
    }
    return { district: null, districtCode: null, thana: null, confidence: 'none', source: 'none', conflict: false };
  }

  const district = dHit.district;
  const th = bdScanThana_(tokens, district);

  /* 3b. confidence: a terminal district with a thana is certain; a district on its
        own is medium (ask for the thana); a lone non-terminal district that is
        followed by more words is weak (it may be a reference point). */
  const last = dHit.start;
  const nearTerminal = last >= tokens.length - 2;
  let confidence;
  if (th) confidence = nearTerminal ? 'high' : 'medium';
  else if (nearTerminal) confidence = 'medium';
  else confidence = 'low';

  return {
    district: district.name, districtCode: district.code,
    thana: th ? th.name : null,
    confidence: confidence, source: 'text', conflict: false
  };
}

/* --- internal matchers --------------------------------------------------- */

function bdScanDistrict_(tokens) {
  const hits = bdFindAliases_(tokens, _bdDistrictByAlias);
  if (!hits.length) return null;
  /* the LAST district mentioned is the most specific one named */
  const h = hits[hits.length - 1];
  return { district: h.val, start: h.start, end: h.end };
}

function bdScanThana_(tokens, district) {
  const hits = bdFindAliases_(tokens, _bdThanaGlobal);
  const own = hits.filter(h => (h.val || []).some(c => c.district.code === district.code));
  if (!own.length) return null;
  const last = own[own.length - 1];
  const cand = (last.val || []).find(c => c.district.code === district.code);
  return cand ? cand.thana : null;
}

function bdScanThanaGlobal_(tokens) {
  const hits = bdFindAliases_(tokens, _bdThanaGlobal);
  if (!hits.length) return null;
  /* use the last mention; unique if every candidate for that name is one district */
  const last = hits[hits.length - 1];
  const cands = last.val;
  const codes = new Set(cands.map(c => c.district.code));
  return { thana: cands[0].thana, district: cands[0].district, unique: codes.size === 1 };
}

function bdResolveDistrictName_(name) {
  bdBuildIndex_();
  const k = normalizeBd_(name);
  return _bdDistrictByAlias[k] || null;
}

function bdResolveDistrictNamePhrase_(tokensArr) {
  bdBuildIndex_();
  for (let len = Math.min(3, tokensArr.length); len >= 1; len--) {
    const k = tokensArr.slice(0, len).join(' ');
    if (_bdDistrictByAlias[k]) return _bdDistrictByAlias[k];
  }
  return null;
}

function bdResolveThanaName_(district, name) {
  bdBuildIndex_();
  const k = normalizeBd_(name);
  const hit = _bdThanaByAlias[district.code + '|' + k];
  return hit ? hit.thana : null;
}
