/* Builds js/bd-locations.js (and the reference data/bd-locations.json) from a
   pinned release of the government-published Bangladesh location registry.

   Run: node tools/gen-bd-locations.js [path-to-extracted-release-json-dir]
   With no argument it downloads the pinned release asset from GitHub and checks
   its SHA-256. The archive is never shipped; only the extracted names are
   committed, so the app keeps no runtime dependency.

   Why this dataset: it carries every administrative level the courier form can
   need, each traceable to a Bangladesh government publisher (BBS, Bangladesh
   Post, LGD, DGHS): 8 divisions, 64 districts, 495 upazilas, 105 metropolitan
   thanas, 4762 unions, 329 paurashavas and urban wards. The earlier
   @olism/bd-geo list had districts + upazilas/city-thanas only, so a village
   address had no Union to resolve to. */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

const RELEASE = 'data-2026.08.04';
const ASSET = 'address-bd-data-2026.08.04-json.tar.zst';
const ASSET_SHA256 = '9b76179403d735231604aa460031b29b1a60123112f6ea5b27996269c1cd604c';
const VERSION = 'bd-admin@' + RELEASE + ' (gov)';
const URL = 'https://github.com/montasim/bangladesh-location-registry/releases/download/' + RELEASE + '/' + ASSET;

/* The government registry is English-only below union level, but shopkeepers
   write Bangla, so district and thana Bangla names come from the MIT-licensed
   @olism/bd-geo package and are merged in by English name. */
const OLISM_URL = 'https://cdn.jsdelivr.net/npm/@olism/bd-geo@1.0.0/dist/index.cjs';
const OLISM_VERSION = 'olism-bd-geo@1.0.0';
const root = path.join(__dirname, '..');

/* English spellings seen in the wild that differ from the dataset's own name.
   The dataset is not wrong; shopkeepers simply type the older or phonetic form. */
const DISTRICT_VARIANTS = {
  Chattogram: ['chittagong', 'chattagram', 'chattagon'],
  Cumilla: ['comilla'],
  Jashore: ['jessore'],
  Barishal: ['barisal'],
  Bogura: ['bogra'],
  "Cox's Bazar": ['coxs bazar', 'cox bazar'],
  Jhalokati: ['jhalokathi'],
  Khagrachhari: ['khagrachari'],
  Moulvibazar: ['maulvibazar', 'moulvi bazar'],
  Netrokona: ['netrakona'],
  Chapainawabganj: ['chapai nawabganj'],
  Brahmanbaria: ['brahmanbariya'],
  Narayanganj: ['narayangonj'],
  Munshiganj: ['munshigonj'],
  Narsingdi: ['narshingdi', 'norshingdi'],
  Gopalganj: ['gopalgonj'],
  Kishoreganj: ['kishorganj']
};

/* The courier world uses shorter names than BBS for some metropolitan thanas,
   and BBS spells a couple of Dhaka ones with a typo. These extras are added as
   aliases only; the stored name stays the official one. */
const THANA_VARIANTS = {
  'Uttara Purba': ['uttara east', 'uttara', 'উত্তরা পূর্ব'],
  'Uttra Pashchim': ['uttara west', 'uttara pashchim', 'উত্তরা পশ্চিম'],
  'Uttara Centre': ['uttara center', 'uttara centre', 'উত্তরা সেন্টার'],
  'Shere Bangla Nagar': ['sher e bangla nagar', 'shre bangla nagar'],
  'Tejgaon Shilpa Elaka': ['tejgaon industrial area'],
  'Chakbazar': ['chawkbazar'],
  'Hazaribag': ['hazaribagh'],
  'Kamrangichar': ['kamrangirchar'],
  'Dakkhinkhan': ['dakshinkhan'],
  'Bimanbandar': ['biman bandar'],
  'Sabujbag': ['sabujbagh'],
  'Lalbag': ['lalbagh'],
  'Newmarket': ['new market'],
  'Chattogram Kotwali': ['kotwali chattogram']
};

/* Dhaka has two city corporations; the registry knows them by BBS code only. */
const CC_NAMES = {
  Dhaka: { 30262000: 'Dhaka South', 30262500: 'Dhaka North' },
  Chattogram: { 20151600: 'Chattogram' },
  Barishal: { 10065000: 'Barishal' },
  Cumilla: { 20195000: 'Cumilla' },
  Gazipur: { 30333300: 'Gazipur' },
  Narayanganj: { 30674400: 'Narayanganj' },
  Khulna: { 40473300: 'Khulna' },
  Mymensingh: { 45614000: 'Mymensingh' },
  Rajshahi: { 50816600: 'Rajshahi' },
  Rangpur: { 55857500: 'Rangpur' },
  Sylhet: { 70915000: 'Sylhet' }
};
const CC_NAME_BN = {
  'Dhaka North': 'ঢাকা উত্তর', 'Dhaka South': 'ঢাকা দক্ষিণ',
  Chattogram: 'চট্টগ্রাম', Barishal: 'বরিশাল', Cumilla: 'কুমিল্লা', Gazipur: 'গাজীপুর',
  Narayanganj: 'নারায়ণগঞ্জ', Khulna: 'খুলনা', Mymensingh: 'ময়মনসিংহ', Rajshahi: 'রাজশাহী',
  Rangpur: 'রংপুর', Sylhet: 'সিলেট'
};

function key(s) {
  return String(s || '').toLowerCase()
    .replace(/['\u2019`.]/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

/* Minimal tar reader: walk 512-byte headers, hand back the entries we ask for. */
function readTarMembers(buf, wanted) {
  const out = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '').trim();
    const sizeStr = buf.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = buf.toString('utf8', off + 156, off + 157);
    const dataStart = off + 512;
    if (name && wanted.indexOf(name) !== -1 && type === '0') out[name] = buf.slice(dataStart, dataStart + size);
    if (!name) { off += 512; continue; }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

const WANT = [
  'json/entities/divisions.json',
  'json/entities/zillas.json',
  'json/entities/upazilas.json',
  'json/entities/metropolitan-thanas.json',
  'json/entities/unions.json',
  'json/facts/paurashavas.json',
  'json/facts/urban-wards.json'
];

const REL = {
  'json/entities/divisions.json': 'divisions.json',
  'json/entities/zillas.json': 'zillas.json',
  'json/entities/upazilas.json': 'upazilas.json',
  'json/entities/metropolitan-thanas.json': 'metropolitan-thanas.json',
  'json/entities/unions.json': 'unions.json',
  'json/facts/paurashavas.json': 'paurashavas.json',
  'json/facts/urban-wards.json': 'urban-wards.json'
};

function loadSources(dir) {
  if (dir) {
    const out = {};
    Object.keys(REL).forEach(k => { out[k] = JSON.parse(fs.readFileSync(path.join(dir, REL[k]), 'utf8')); });
    return Promise.resolve(out);
  }
  return fetch(URL).then(buf => {
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== ASSET_SHA256) throw new Error('release checksum mismatch: ' + sha);
    console.log('downloaded ' + ASSET + ' (' + buf.length + ' bytes, sha256 ok)');
    const members = readTarMembers(zlib.zstdDecompressSync(buf), WANT);
    const out = {};
    Object.keys(members).forEach(k => { out[k] = JSON.parse(members[k].toString('utf8')); });
    return out;
  });
}

function records(doc) { return (doc && doc.records) || []; }
function en(r) { return r.name && r.name.en ? r.name.en : (r.name || ''); }
function bn(r) { return (r.name && r.name.bn) || r.bnName || ''; }

/* Bangla names and alternative spellings for districts and thanas, from
   @olism/bd-geo, matched by English letters only so "Char Fasson" folds onto the
   registry's "Charfasson". Optional: if the fetch fails the app still works,
   only Bangla matching and those variants are lost. */
async function loadOlism() {
  try {
    const body = await fetch(OLISM_URL);
    const tmp = path.join(require('os').tmpdir(), 'bd-geo-' + Date.now() + '.cjs');
    fs.writeFileSync(tmp, body);
    const geo = require(tmp);
    const distById = {};
    const districts = (geo.getDistricts() || []).map(d => { distById[d.id] = d.name; return { name: d.name, nameBn: d.nameBn || '' }; });
    const thanas = (geo.getThanas() || []).map(t => ({
      name: t.name, nameBn: t.nameBn || '', district: distById[t.districtId] || ''
    }));
    console.log('merged names from ' + OLISM_VERSION);
    return { districts: districts, thanas: thanas };
  } catch (e) {
    console.warn('WARN: could not fetch @olism/bd-geo (' + e.message + '); continuing without it');
    return { districts: [], thanas: [] };
  }
}

const letters = (s) => key(s).replace(/[^a-z0-9]/g, '');

/* Fold the @olism spellings and Bangla names into the registry records. The
   registry name stays canonical; the other spelling becomes an alias. */
function mergeOlism(olism, districts, areas, cities) {
  const byLetter = {};
  areas.forEach(a => { const k = letters(a.name); if (k) (byLetter[k] = byLetter[k] || []).push(a); });
  olism.thanas.forEach(t => {
    const hits = byLetter[letters(t.name)] || [];
    const own = hits.find(a => !t.district || a.district === t.district) || hits[0];
    if (!own) return;
    if (!own.nameBn && t.nameBn) own.nameBn = t.nameBn;
    own.aliases = Array.from(new Set((own.aliases || []).concat([key(t.name)]).filter(Boolean))).sort();
  });
  const dByLetter = {};
  districts.forEach(d => { const k = letters(d.name); if (k) dByLetter[k] = d; });
  olism.districts.forEach(d => {
    const own = dByLetter[letters(d.name)];
    if (!own) return;
    if (!own.nameBn && d.nameBn) own.nameBn = d.nameBn;
    own.aliases = Array.from(new Set((own.aliases || []).concat([key(d.name)]).filter(Boolean))).sort();
  });
  cities.forEach(c => { c.aliases = Array.from(new Set([key(c.name), key(c.nameBn)].filter(Boolean))).sort(); });
}

function cleanWardLabel(raw, code) {
  const t = String(raw || '').trim();
  if (/\bward\b/i.test(t)) return 'Ward ' + code;
  return t;
}


(async () => {
  const src = await loadSources(process.argv[2]);
  const olism = await loadOlism();
  const divs = records(src['json/entities/divisions.json']);
  const zillas = records(src['json/entities/zillas.json']);
  const upazilas = records(src['json/entities/upazilas.json']);
  const metThanas = records(src['json/entities/metropolitan-thanas.json']);
  const unions = records(src['json/entities/unions.json']);
  const paurashavas = records(src['json/facts/paurashavas.json']);
  const urbanWards = records(src['json/facts/urban-wards.json']);

  const divName = {}; divs.forEach(r => { divName[r.key] = en(r); });
  const zillaName = {}; zillas.forEach(r => { zillaName[r.key] = en(r); });

  /* City corporations: one per BBS code, named for the district it sits in. */
  const ccByCode = {};
  metThanas.forEach(r => {
    const cc = r.cityCorporationBbsCode;
    if (cc && !ccByCode[cc]) ccByCode[cc] = { zillaKey: (r.relations || {}).zillaKey };
  });
  const cityCorporations = [];
  Object.keys(ccByCode).sort().forEach(code => {
    const d = zillaName[ccByCode[code].zillaKey] || '';
    const nm = (CC_NAMES[d] && CC_NAMES[d][code]) || (d ? d + ' City Corporation' : 'City Corporation');
    cityCorporations.push({ code: code, name: nm, nameBn: CC_NAME_BN[nm] || '', district: d });
  });

  /* Areas: upazilas and metropolitan thanas, both keyed to a district. A metro
     thana also names its city corporation so Dhaka can show North and South. */
  const areas = [];
  upazilas.forEach(r => areas.push({
    name: en(r), nameBn: bn(r), type: 'upazila',
    district: zillaName[r.relations.zillaKey] || '', city: null
  }));
  metThanas.forEach(r => {
    const d = zillaName[r.relations.zillaKey] || '';
    const cc = (CC_NAMES[d] && CC_NAMES[d][r.cityCorporationBbsCode]) || null;
    areas.push({ name: en(r), nameBn: bn(r), type: 'thana', district: d, city: cc });
  });
  areas.sort((a, b) => a.name.localeCompare(b.name));
  areas.forEach(a => {
    const extras = (THANA_VARIANTS[a.name] || []).map(key);
    const set = new Set(extras.concat([key(a.name), key(a.nameBn)]).filter(Boolean));
    a.aliases = Array.from(set).sort();
  });

  /* Unions belong to an upazila; carry that name so the form can cascade. */
  const upazilaName = {};
  upazilas.forEach(r => { upazilaName[r.key] = en(r); });
  const unionList = unions.map(r => ({
    name: en(r), nameBn: bn(r),
    district: zillaName[r.relations.zillaKey] || '',
    upazila: upazilaName[(r.relations.administrativeArea || {}).key] || null
  }));

  /* Paurashavas sit at district level in the source (relationshipConfidence is
     "district-only" / "dghs-code"), so the parent upazila is not invented here;
     the form lets the owner pick one. The name is kept as written. */
  const paurashavaList = paurashavas.map(r => {
    const d = zillaName[r.locationKey] || '';
    return {
      name: String(r.name || '').trim(), nameBn: r.bnName || '', district: d,
      classification: r.classification || '', source: r.sourceId || ''
    };
  });

  /* Wards: urban wards under a city corporation or a paurashava. The source's
     city-corporation ward mapping is incomplete for Dhaka, so a ward keeps the
     parent the source names rather than an invented one. */
  const wardList = urbanWards.map(r => {
    const d = zillaName[r.locationKey] || '';
    let parentKind = r.parentKind || 'urban';
    let parent = '';
    if (r.cityCorporationId) {
      const code = String(r.cityCorporationId).replace(/^cod:BD/, '');
      parent = (CC_NAMES[d] && CC_NAMES[d][code]) || d + ' City Corporation';
    } else if (r.paurashavaId) {
      parentKind = 'paurashava';
      parent = String(r.paurashavaId).replace(/^paurashava-\d+-/, '').replace(/-/g, ' ');
    } else {
      parentKind = 'union';
    }
    return { name: cleanWardLabel(r.name, r.wardCode || ''), nameBn: r.nameBn || '', district: d, parent: parent, parentKind: parentKind, wardCode: r.wardCode || '' };
  });

  /* Fold in @olism spellings and Bangla names, then hand the arrays to the doc. */
  const districtDoc = zillas.map(d => {
    const name = en(d);
    const aliases = new Set([key(name), key(bn(d))]);
    (DISTRICT_VARIANTS[name] || []).forEach(a => aliases.add(key(a)));
    return {
      name: name, nameBn: bn(d),
      division: divName[d.relations.divisionKey] || '',
      aliases: Array.from(aliases).filter(Boolean).sort()
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  mergeOlism(olism, districtDoc, areas, cityCorporations);

  const doc = {
    schemaVersion: 2,
    datasetVersion: VERSION,
    attribution: 'Bangladesh administrative names from the government-published location ' +
      'registry release ' + RELEASE + ' (BBS, Bangladesh Post, LGD, DGHS; montasim/bangladesh-location-registry). ' +
      'English spelling variants curated in-repo.',
    generatedAt: new Date().toISOString().slice(0, 10),
    divisions: divs.map(r => ({ name: en(r) })).sort((a, b) => a.name.localeCompare(b.name)),
    districts: districtDoc,
    cityCorporations: cityCorporations,
    areas: areas,
    unions: unionList,
    paurashavas: paurashavaList,
    wards: wardList
  };

  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'bd-locations.json'), JSON.stringify(doc, null, 2) + '\n');

  const bundle = '/* GENERATED by tools/gen-bd-locations.js from ' + VERSION + ' - do not edit by hand.\n' +
    '   ' + doc.attribution + ' */\n' +
    'window.BD_LOCATIONS = ' + JSON.stringify(doc) + ';\n';
  fs.writeFileSync(path.join(root, 'js', 'bd-locations.js'), bundle);

  console.log('wrote data/bd-locations.json and js/bd-locations.js: ' +
    doc.divisions.length + ' divisions, ' + doc.districts.length + ' districts, ' +
    doc.areas.length + ' thanas/upazilas, ' + doc.unions.length + ' unions, ' +
    doc.paurashavas.length + ' paurashavas, ' + doc.wards.length + ' wards, ' +
    doc.cityCorporations.length + ' city corporations');
})().catch(e => { console.error('generation failed: ' + e.message); process.exit(1); });
