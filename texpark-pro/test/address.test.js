/* Address resolver: the 10 required cases plus the guardrails. Pure code only —
   no DOM, no network, no booking. Run: node test/address.test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

/* the generated bundle assigns window.BD_LOCATIONS */
global.window = {};
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'bd-locations.js'), 'utf8'), { filename: 'bd-locations.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'address.js'), 'utf8'), { filename: 'address.js' });

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

function R(text, structured) { return resolveBdLocation(text, structured); }

console.log('\n--- 1. Battala Bangla: শিবপুর নরসিংদী ---');
let r = R('শিবপুর নরসিংদী');
eq(r.district, 'Narsingdi', 'district Narsingdi');
eq(r.thana, 'Shibpur', 'thana Shibpur');
eq(r.confidence, 'high', 'high confidence');

console.log('\n--- 2. English: Shibpur, Narsingdi ---');
r = R('Shibpur, Narsingdi');
eq(r.district, 'Narsingdi', 'district Narsingdi');
eq(r.thana, 'Shibpur', 'thana Shibpur');

console.log('\n--- 3. a complete Dhaka address with a known thana ---');
r = R('House 12, Road 3, Dhanmondi, Dhaka');
eq(r.district, 'Dhaka', 'district Dhaka');
eq(r.thana, 'Dhanmondi', 'thana Dhanmondi');
eq(r.confidence, 'high', 'high confidence');

r = R('Mirpur, Dhaka');
eq(r.district, 'Dhaka', 'district Dhaka');
eq(r.thana, 'Mirpur', 'thana Mirpur');

console.log('\n--- 4. Dhaka only as a reference point ---');
r = R('Deliver from Dhaka office, village Char Fasson, Bhola');
eq(r.district, 'Bhola', 'district is Bhola, NOT Dhaka');
ok(r.district !== 'Dhaka', 'never classified as Dhaka');

console.log('\n--- 5. district but no identifiable thana ---');
r = R('Narsingdi');
eq(r.district, 'Narsingdi', 'district Narsingdi');
eq(r.thana, null, 'no thana invented from the district alone');
eq(r.confidence, 'medium', 'medium -> ask the user');

console.log('\n--- 6. a misspelled district still resolves ---');
r = R('Shibpur, Norshingdi');
eq(r.district, 'Narsingdi', 'Norshingdi alias -> Narsingdi');
eq(r.thana, 'Shibpur', 'thana Shibpur');
r = R('Chittagong');
eq(r.district, 'Chattogram', 'Chittagong alias -> Chattogram');
r = R('Cumilla');
eq(r.district, 'Cumilla', 'Comilla -> Cumilla');

console.log('\n--- 7. structured field conflicts with the text ---');
r = R('Shibpur, Narsingdi', { district: 'Dhaka', thana: 'Mirpur' });
eq(r.district, 'Dhaka', 'structured value is used (priority 1)');
eq(r.conflict, true, 'the conflict is flagged so the UI can ask');
eq(r.confidence, 'low', 'conflict lowers confidence');

console.log('\n--- 8. extra spaces and punctuation ---');
r = R('   শিবপুর ,   নরসিংদী  !! ');
eq(r.district, 'Narsingdi', 'normalized district');
eq(r.thana, 'Shibpur', 'normalized thana');

console.log('\n--- 9. an address that cannot be resolved ---');
r = R('xyz abc unknown place');
eq(r.district, null, 'no district');
eq(r.thana, null, 'no thana');
eq(r.confidence, 'none', 'none -> booking is blocked');

console.log('\n--- 10. a valid address then a manual correction ---');
r = R('Shibpur, Narsingdi', { district: 'Narsingdi', thana: 'Palash' });
eq(r.district, 'Narsingdi', 'district from the user');
eq(r.thana, 'Palash', 'thana from the user (their correction wins)');
eq(r.confidence, 'high', 'high confidence after correction');

console.log('\n--- dataset integrity ---');
ok(bdDatasetVersion().length > 0, 'dataset version is present');
eq(bdDistricts().length, 64, '64 districts');
const all = bdDistricts();
let thanasTotal = 0, emptyDistricts = 0;
all.forEach(d => { const t = bdThanasFor(d.name); thanasTotal += t.length; if (!t.length) emptyDistricts++; });
eq(emptyDistricts, 0, 'every district has at least one thana');
ok(thanasTotal > 500, 'more than 500 thanas total (' + thanasTotal + ')');
eq(bdThanasFor('Narsingdi').filter(t => t.name === 'Shibpur').length, 1, 'Shibpur is under Narsingdi');
eq(bdThanasFor('Narsingdi').filter(t => t.name === 'Palash').length, 1, 'Palash is under Narsingdi');
ok(bdThanasFor('Dhaka').some(t => t.name === 'Dhanmondi'), 'Dhaka carries the metro thana Dhanmondi');

console.log('\n--- determinism ---');
eq(JSON.stringify(R('শিবপুর নরসিংদী')), JSON.stringify(R('শিবপুর নরসিংদী')), 'same input -> same output');

console.log('\n--- 11. the full hierarchy: Division -> District -> City Corporation -> Thana -> Union -> Paurashava -> Ward ---');
r = R('Shibpur, Narsingdi');
eq(r.division, 'Dhaka', 'division filled from the district');

r = R('Mirpur, Dhaka');
eq(r.city, 'Dhaka North', 'Mirpur sits in Dhaka North City Corporation');
r = R('Shahbag, Dhaka');
eq(r.city, 'Dhaka South', 'Shahbag sits in Dhaka South City Corporation');
r = R('Uttara, Dhaka');
eq(r.city, 'Dhaka North', 'Uttara sits in Dhaka North City Corporation');
r = R('ধানমন্ডি, ঢাকা');
eq(r.city, 'Dhaka South', 'Dhanmondi sits in Dhaka South City Corporation');

r = R('Amta, Dhamrai, Dhaka');
eq(r.district, 'Dhaka', 'district Dhaka');
eq(r.thana, 'Dhamrai', 'thana Dhamrai');
eq(r.union, 'Amta', 'union Amta is under Dhamrai');

r = R('Bancharampur, Brahmanbaria');
eq(r.district, 'Brahmanbaria', 'district Brahmanbaria');
eq(r.paurashava, 'Bancharampur', 'paurashava Bancharampur found');

r = R('Ward 19, Uttara, Dhaka');
eq(r.city, 'Dhaka North', 'ward 19 is in Dhaka North');
eq(r.ward, 'Ward 19', 'ward detected from the number');

r = R('Char Fasson, Bhola');
eq(r.district, 'Bhola', 'old spelling still resolves to Bhola');
eq(r.thana, 'Charfasson', 'Char Fasson folds onto the registry Charfasson');

console.log('\n--- full-hierarchy helpers ---');
eq(bdCityCorporations().length, 12, '12 city corporations');
eq(bdCitiesFor('Dhaka').length, 2, 'Dhaka has two city corporations');
ok(bdCitiesFor('Dhaka').some(c => c.name === 'Dhaka North'), 'Dhaka North present');
ok(bdCitiesFor('Dhaka').some(c => c.name === 'Dhaka South'), 'Dhaka South present');
ok(bdThanasFor('Dhaka').some(t => t.name === 'Shahbag' && t.city === 'Dhaka South'), 'Shahbag is a Dhaka South thana');
ok(bdThanasFor('Dhaka').some(t => t.name === 'Mirpur' && t.city === 'Dhaka North'), 'Mirpur is a Dhaka North thana');
ok(bdUnionsFor('Dhaka', 'Dhamrai').some(u => u.name === 'Amta'), 'Amta union under Dhamrai');
ok(bdPaurashavasFor('Brahmanbaria').some(p => p.name === 'Bancharampur'), 'Bancharampur paurashava under Brahmanbaria');
ok(bdWardsFor('Dhaka', 'Dhaka North').length > 0, 'Dhaka North has wards');

console.log('\n--- 12. address correction from the area ---');
/* area-only text is rebuilt in a canonical smallest-to-largest order */
eq(bdCorrectAddress_('Shibpur Narsingdi', R('Shibpur Narsingdi')), 'Shibpur, Narsingdi, Dhaka', 'area-only address rebuilt and ordered');
eq(bdCorrectAddress_('ধানমন্ডি ঢাকা', R('ধানমন্ডি ঢাকা')), 'Dhanmondi, Dhaka South, Dhaka', 'Dhaka thana corrects to its city corporation, duplicate name collapsed');
/* house/road detail is kept, and only the missing levels are appended */
eq(bdCorrectAddress_('House 12, Road 3, Dhanmondi, Dhaka', R('House 12, Road 3, Dhanmondi, Dhaka')),
  'House 12, Road 3, Dhanmondi, Dhaka', 'a complete address with detail is left unchanged');
eq(bdCorrectAddress_('House 5, Road 2, Shibpur', R('House 5, Road 2, Shibpur')),
  'House 5, Road 2, Shibpur, Narsingdi, Dhaka', 'detail kept, missing levels appended');
eq(bdCorrectAddress_('Bancharampur, Brahmanbaria', R('Bancharampur, Brahmanbaria')),
  'Bancharampur, Brahmanbaria, Chattogram', 'a paurashava address gains its district and division');
/* never guesses */
eq(bdCorrectAddress_('somewhere unknown 123', R('somewhere unknown 123')), 'somewhere unknown 123', 'an unresolved address is left untouched');
eq(bdCorrectAddress_('', R('')), '', 'an empty address stays empty');

console.log('\n--- determinism ---');
eq(JSON.stringify(R('শিবপুর নরসিংদী')), JSON.stringify(R('শিবপুর নরসিংদী')), 'same input -> same output');

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
console.log('=================');
process.exit(fail ? 1 : 0);
