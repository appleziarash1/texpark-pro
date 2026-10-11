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

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
console.log('=================');
process.exit(fail ? 1 : 0);
