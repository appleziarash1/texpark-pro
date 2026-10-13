/* The bug: today() used toISOString(), which is UTC. Bangladesh is UTC+6, so between
   midnight and 6am the app answered YESTERDAY - a memo written at 1am was dated the
   previous day and "Today's sales" read zero even though sales had been made.
   Run: node test/date.test.js */

process.env.TZ = 'Asia/Dhaka';   // the shop's clock, not the runner's

const fakeStore = {};
global.localStorage = {
  getItem: k => (k in fakeStore ? fakeStore[k] : null),
  setItem: (k, v) => { fakeStore[k] = String(v); },
  removeItem: k => { delete fakeStore[k]; }
};
global.alert = function () {};
global.document = { getElementById: () => null };

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'db.js'), 'utf8'), { filename: 'db.js' });

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}
function eq(a, b, label) { ok(a === b, label + '  (got ' + a + ', want ' + b + ')'); }

console.log('\n--- the date the shop sees ---');
const early = new Date('2026-10-13T01:00:00+06:00');   // 1am in Dhaka
eq(ymd_(early), '2026-10-13', 'a 1am sale is dated today, not yesterday');
eq(early.toISOString().slice(0, 10), '2026-10-12', 'the old UTC answer was yesterday (the bug)');

const late = new Date('2026-10-13T23:30:00+06:00');    // 11:30pm in Dhaka
eq(ymd_(late), '2026-10-13', 'a late-night sale is still today');

eq(today(), ymd_(new Date()), 'today() agrees with the device clock');
ok(/^\d{4}-\d{2}-\d{2}$/.test(today()), 'today() is a plain YYYY-MM-DD date');

console.log('\n--- adding days stays exact ---');
eq(addDays_('2026-10-13', 1), '2026-10-14', 'addDays_ +1');
eq(addDays_('2026-10-31', 1), '2026-11-01', 'addDays_ crosses a month end');

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
console.log('=================');
process.exit(fail ? 1 : 0);
