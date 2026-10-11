/* Bangladesh address → Division / District / City Corporation / Thana /
   Union / Paurashava / Ward resolver.

   Pure functions, no DOM and no network, so the whole thing is unit-testable and
   the booking code can call it without a socket. The location list is the offline
   bundle in js/bd-locations.js (see data/SOURCE.md for provenance).

   The rule that matters: a district is only trusted when it is the *place* the
   address is being sent to, not a reference point. "Deliver from Dhaka office,
   village Char Fasson, Bhola" must resolve to Bhola, never Dhaka. So the last,
   most specific location wins, a mid-string district that is followed by further
   location words is treated as weak, and a thana is never invented from a
   district alone — an unresolved thana means we ask, we do not guess.

   Districts and thanas/upazilas are matched from the dataset. Unions,
   paurashavas and wards are matched too, but only exact names within the
   district/thana already found, because those names repeat across the country.
   The address sent to Steadfast is never rewritten; this only reads it. */

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
var _bdUnionByKey = null;
var _bdPaurashavaByKey = null;
var _bdWardByKey = null;

function bdBuildIndex_() {
  if (_bdDistrictByAlias) return;
  _bdDistrictByAlias = {};
  _bdThanaByAlias = {};
  _bdThanaGlobal = {};
  _bdUnionByKey = {};
  _bdPaurashavaByKey = {};
  _bdWardByKey = {};
  const data = bdLocationData();
  const districts = (data && data.districts) || [];
  districts.forEach(d => {
    const aliases = (d.aliases && d.aliases.length ? d.aliases : [normalizeBd_(d.name)])
      .concat([normalizeBd_(d.name), normalizeBd_(d.nameBn)]).filter(Boolean);
    aliases.forEach(a => { if (!(a in _bdDistrictByAlias)) _bdDistrictByAlias[a] = d; });
  });
  /* Areas are a flat list keyed to a district; a metro thana also names its
     city corporation, so the same thana name can appear under two districts. */
  ((data && data.areas) || []).forEach(a => {
    const tal = (a.aliases && a.aliases.length ? a.aliases : [])
      .concat([normalizeBd_(a.name), normalizeBd_(a.nameBn)]).filter(Boolean);
    tal.forEach(k => {
      if (!(normalizeBd_(a.district) + '|' + k in _bdThanaByAlias)) _bdThanaByAlias[normalizeBd_(a.district) + '|' + k] = a;
      (_bdThanaGlobal[k] = _bdThanaGlobal[k] || []).push(a);
    });
  });
  ((data && data.unions) || []).forEach(u => {
    _bdUnionByKey[normalizeBd_(u.district) + '|' + normalizeBd_(u.upazila) + '|' + normalizeBd_(u.name)] = u;
  });
  ((data && data.paurashavas) || []).forEach(p => {
    _bdPaurashavaByKey[normalizeBd_(p.district) + '|' + normalizeBd_(p.name)] = p;
  });
  ((data && data.wards) || []).forEach(w => {
    _bdWardByKey[normalizeBd_(w.district) + '|' + normalizeBd_(w.parent) + '|' + normalizeBd_(w.wardCode)] = w;
  });
}

/* The district record for a name or code. */
function bdFindDistrict_(nameOrCode) {
  bdBuildIndex_();
  const data = bdLocationData();
  if (!data) return null;
  const want = normalizeBd_(nameOrCode);
  return (data.districts || []).find(x =>
    x.name === nameOrCode || x.code === nameOrCode ||
    normalizeBd_(x.name) === want || normalizeBd_(x.nameBn) === want ||
    (x.aliases || []).indexOf(want) !== -1) || null;
}

function bdDistricts() {
  const data = bdLocationData();
  return ((data && data.districts) || []).map(d => ({
    code: d.code, name: d.name, nameBn: d.nameBn, division: d.division
  }));
}

/* The thanas/upazilas of a district: every area whose `district` matches.
   `city` is the city corporation for a metro thana (Dhaka North/South), else null. */
function bdThanasFor(districtNameOrCode) {
  const data = bdLocationData();
  const d = bdFindDistrict_(districtNameOrCode);
  if (!data || !d) return [];
  return (data.areas || []).filter(a => a.district === d.name)
    .map(a => ({ name: a.name, nameBn: a.nameBn, type: a.type, city: a.city || null }));
}

function bdUnionsFor(districtNameOrCode, upazilaName) {
  const data = bdLocationData();
  if (!data) return [];
  const d = bdFindDistrict_(districtNameOrCode);
  const dk = normalizeBd_(d ? d.name : districtNameOrCode);
  const uk = normalizeBd_(upazilaName);
  return (data.unions || []).filter(u => normalizeBd_(u.district) === dk && (!uk || normalizeBd_(u.upazila) === uk));
}

function bdPaurashavasFor(districtNameOrCode) {
  const data = bdLocationData();
  if (!data) return [];
  const d = bdFindDistrict_(districtNameOrCode);
  return (data.paurashavas || []).filter(p => p.district === (d ? d.name : districtNameOrCode));
}

function bdWardsFor(districtNameOrCode, parentName) {
  const data = bdLocationData();
  if (!data) return [];
  const d = bdFindDistrict_(districtNameOrCode);
  const dn = d ? d.name : districtNameOrCode;
  const pk = normalizeBd_(parentName);
  return (data.wards || []).filter(w => w.district === dn && (!pk || normalizeBd_(w.parent) === pk));
}

function bdCityCorporations() {
  const data = bdLocationData();
  return ((data && data.cityCorporations) || []).map(c => ({ code: c.code, name: c.name, district: c.district }));
}

/* City corporations of a district, e.g. Dhaka -> [Dhaka North, Dhaka South]. */
function bdCitiesFor(districtNameOrCode) {
  const d = bdFindDistrict_(districtNameOrCode);
  return bdCityCorporations().filter(c => c.district === (d ? d.name : districtNameOrCode));
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

/* First token index where a name phrase appears, or -1. */
function bdNameIndex_(tokens, name) {
  const parts = normalizeBd_(name).split(' ').filter(Boolean);
  if (!parts.length) return -1;
  for (let i = 0; i + parts.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < parts.length; j++) if (tokens[i + j] !== parts[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

/* Walk the address and collect the union / paurashava / ward the text names,
   limited to the district (and, for a union, the thana) already found. The
   leftmost hit wins, because an address is written smallest-to-largest; a name
   that merely repeats the thana is dropped so it cannot stand in for the union.
   A ward is only trusted when a number is written next to the word "ward". */
function bdScanDetails_(tokens, district, thana) {
  const out = { union: null, paurashava: null, ward: null, wardParent: null, thana: null };
  if (!district) return out;
  const dn = district.name;
  const tn = thana || '';
  const tnk = normalizeBd_(tn);

  const uHits = bdUnionsFor(dn, tn)
    .map(u => ({ rec: u, name: u.name, i: bdNameIndex_(tokens, u.name) }))
    .filter(h => h.i !== -1 && normalizeBd_(h.name) !== tnk)
    .sort((a, b) => a.i - b.i);
  if (uHits.length) {
    out.union = uHits[0].name;
    /* The registry links every union to its upazila, so an address that names a
       village or union can fill the Thana the owner would otherwise pick by hand. */
    if (!tn && uHits[0].rec && uHits[0].rec.upazila) out.thana = uHits[0].rec.upazila;
  }

  const pHits = bdPaurashavasFor(dn)
    .map(p => ({ name: p.name, i: bdNameIndex_(tokens, p.name) }))
    .filter(h => h.i !== -1 && normalizeBd_(h.name) !== normalizeBd_(dn))
    .sort((a, b) => a.i - b.i);
  if (pHits.length) out.paurashava = pHits[0].name;

  const wi = tokens.indexOf('ward');
  if (wi !== -1) {
    const near = tokens.slice(wi + 1, wi + 3).concat(tokens.slice(Math.max(0, wi - 2), wi));
    const num = near.find(x => /^\d{1,3}$/.test(x));
    if (num) {
      const code = String(parseInt(num, 10)).padStart(2, '0');
      const w = bdWardsFor(dn).find(x => x.wardCode === code);
      if (w) { out.ward = /^ward\b/i.test(w.name) ? w.name : (w.name + ' (Ward ' + code + ')'); out.wardParent = w.parent; }
    }
  }
  return out;
}

/* The resolved levels as {name, nameBn}, smallest -> largest (Ward -> Division),
   dropping a level whose name repeats one already listed so a Dhaka address does
   not come out as "Dhaka, Dhaka". */
function bdAreaParts_(r) {
  const raw = [
    { name: r.ward, nameBn: null },
    { name: r.union, nameBn: r.unionBn || null },
    { name: r.paurashava, nameBn: r.paurashavaBn || null },
    { name: r.thana, nameBn: r.thanaBn || null },
    { name: r.city, nameBn: r.cityBn || null },
    { name: r.district, nameBn: r.districtBn || null },
    { name: r.division, nameBn: r.divisionBn || null }
  ];
  const seen = {};
  const out = [];
  raw.forEach(p => {
    const v = String(p.name == null ? '' : p.name).trim();
    if (!v) return;
    const k = normalizeBd_(v);
    if (!k || seen[k]) return;
    seen[k] = 1;
    out.push({ name: v, nameBn: p.nameBn ? String(p.nameBn).trim() : '' });
  });
  return out;
}

/* The English names in order. */
function bdAreaTail_(r) {
  return bdAreaParts_(r).map(p => p.name);
}

/* True when the address carries nothing but the area: every word is a number or
   part of a resolved name (in either script). A house/road/flat word makes it
   false, so that part is never thrown away when the address is rebuilt. */
function bdAreaOnly_(tokens, r) {
  const known = { ward: 1 };
  bdAreaParts_(r).forEach(p => {
    normalizeBd_(p.name).split(' ').forEach(w => { if (w) known[w] = 1; });
    normalizeBd_(p.nameBn).split(' ').forEach(w => { if (w) known[w] = 1; });
  });
  let extra = 0;
  tokens.forEach(t => { if (!/^\d{1,4}$/.test(t) && !known[t]) extra++; });
  return extra === 0;
}

/* Correct an address from a resolved area. When the address is only area it is
   rebuilt in a canonical smallest-to-largest order; when it also has house/road
   text, only the levels it does not already name are appended, so nothing the
   owner typed is lost. Returns the address unchanged when the area is unknown. */
function bdCorrectAddress_(rawAddress, r) {
  const address = String(rawAddress == null ? '' : rawAddress).trim();
  if (!r || !r.district) return address;
  const tail = bdAreaTail_(r);
  if (!tail.length) return address;
  const tokens = bdTokens_(address);
  if (!address || bdAreaOnly_(tokens, r)) return tail.join(', ');
  const have = {};
  tokens.forEach(t => { have[t] = 1; });
  const missing = tail.filter(p => normalizeBd_(p).split(' ').every(w => !have[w]));
  return missing.length ? address + ', ' + missing.join(', ') : address;
}

/* Bangla names for the resolved levels, so an address written in Bangla is still
   recognised as area-only and rebuilt. Missing ones stay null. */
function bdAreaBn_(r) {
  const data = bdLocationData();
  const out = { districtBn: null, thanaBn: null, cityBn: null, unionBn: null, paurashavaBn: null, wardBn: null };
  if (!data) return out;
  const find = (arr, val, parentKey, parentVal) => {
    const k = normalizeBd_(val);
    if (!k) return null;
    return (arr || []).find(x => normalizeBd_(x.name) === k &&
      (!parentKey || normalizeBd_(x[parentKey]) === normalizeBd_(parentVal))) || null;
  };
  const dist = find(data.districts, r.district);
  const city = find(data.cityCorporations, r.city, 'district', r.district);
  const th = find(data.areas, r.thana, 'district', r.district);
  const un = find(data.unions, r.union, 'district', r.district);
  const pa = find(data.paurashavas, r.paurashava, 'district', r.district);
  const wa = find(data.wards, r.ward, 'district', r.district);
  const bn = (x) => (x && x.nameBn ? String(x.nameBn).trim() : null);
  out.districtBn = bn(dist); out.cityBn = bn(city); out.thanaBn = bn(th);
  out.unionBn = bn(un); out.paurashavaBn = bn(pa); out.wardBn = bn(wa);
  return out;
}

/* Resolve an address to { division, district, thana, city, union, paurashava,
   ward, confidence, source }.
   structured (optional) = { district, thana } supplied by the user/record.
   confidence: 'high' | 'medium' | 'low' | 'none'. */
function resolveBdLocation(rawAddress, structured) {
  bdBuildIndex_();
  const tokens = bdTokens_(rawAddress);

  /* attach the lower levels the text names, once the district (and thana) are known */
  const finish = (o) => {
    const dist = o.district ? bdFindDistrict_(o.district) : null;
    const det = bdScanDetails_(tokens, dist, o.thana);
    /* A union named in the text carries its upazila, so the Thana can be filled
       even when the address never names it. */
    const thana = o.thana || det.thana || null;
    const merged = Object.assign({
      division: dist ? dist.division : null,
      city: (o.city || null),
      union: det.union, paurashava: det.paurashava, ward: det.ward, wardParent: det.wardParent
    }, o);
    merged.thana = thana;
    if (!merged.city && thana) {
      const tr = bdResolveThanaName_(dist, thana);
      merged.city = (tr && tr.city) || null;
    }
    if (!merged.conflict && !o.thana && thana && merged.confidence === 'medium') merged.confidence = 'high';
    return Object.assign(merged, bdAreaBn_(merged));
  };

  /* 1. an explicit, valid structured location wins (priority 1–2). If it also
        disagrees with the text, say so (conflict) so the UI can ask. */
  if (structured && structured.district) {
    const sd = bdResolveDistrictName_(structured.district);
    if (sd) {
      const st = structured.thana ? bdResolveThanaName_(sd, structured.thana) : null;
      const textHit = bdScanDistrict_(tokens);
      const conflict = !!(textHit && textHit.district.name !== sd.name);
      return finish({
        district: sd.name, districtCode: sd.code,
        thana: st ? st.name : null,
        city: st ? st.city : null,
        confidence: conflict ? 'low' : (st ? 'high' : 'medium'),
        source: 'structured', conflict: conflict
      });
    }
  }

  /* 2. labelled district in the text */
  const lab = bdLabelled_(tokens);
  if (lab) {
    const sd = bdResolveDistrictNamePhrase_(lab);
    if (sd) {
      const th = bdScanThana_(tokens, sd);
      return finish({ district: sd.name, districtCode: sd.code, thana: th ? th.name : null,
        city: th ? th.city : null, confidence: th ? 'high' : 'medium', source: 'labeled', conflict: false });
    }
  }

  /* 3. positional scan */
  const dHit = bdScanDistrict_(tokens);

  /* 3a. no district named — but a thana might name its own district unambiguously */
  if (!dHit) {
    const g = bdScanThanaGlobal_(tokens);
    if (g && g.unique) {
      return finish({ district: g.district.name, districtCode: g.district.code, thana: g.thana.name,
        city: g.thana.city || null, confidence: 'medium', source: 'thana', conflict: false });
    }
    return finish({ district: null, districtCode: null, thana: null, city: null,
      confidence: 'none', source: 'none', conflict: false });
  }

  const district = dHit.district;
  const th = bdScanThana_(tokens, district);

  /* 3b. confidence: a terminal district with a thana is certain; a district on its
        own is medium (ask for the thana); a lone non-terminal district that is
        followed by more words is weak (it may be a reference point). */
  const nearTerminal = dHit.start >= tokens.length - 2;
  let confidence;
  if (th) confidence = nearTerminal ? 'high' : 'medium';
  else if (nearTerminal) confidence = 'medium';
  else confidence = 'low';

  return finish({
    district: district.name, districtCode: district.code,
    thana: th ? th.name : null, city: th ? th.city : null,
    confidence: confidence, source: 'text', conflict: false
  });
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
  const own = hits.filter(h => (h.val || []).some(a => a.district === district.name));
  if (!own.length) return null;
  const last = own[own.length - 1];
  return (last.val || []).find(a => a.district === district.name) || null;
}

function bdScanThanaGlobal_(tokens) {
  const hits = bdFindAliases_(tokens, _bdThanaGlobal);
  if (!hits.length) return null;
  /* use the last mention; unique if every candidate for that name is one district */
  const last = hits[hits.length - 1];
  const cands = last.val;
  const districts = new Set(cands.map(a => a.district));
  return { thana: cands[0], district: bdFindDistrict_(cands[0].district), unique: districts.size === 1 };
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
  return _bdThanaByAlias[normalizeBd_(district.name) + '|' + k] || null;
}
