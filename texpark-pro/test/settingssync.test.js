/* Settings and users travelling between the PC and the phone.
 *
 * Three things the owner asked for, and each one has a way of going wrong that
 * loses data rather than merely failing:
 *
 *   1. Company details, memo prefix and low-stock level must arrive on the other
 *      machine - but the sync URL and device tag must NOT, because a phone that
 *      adopts the PC's device tag renames its own memos and one that adopts a bad
 *      URL stops syncing entirely.
 *   2. A user created on the web must work on the phone. Two machines that each
 *      started fresh both hold an `admin`, so a naive merge produces two admins
 *      and the login picks whichever comes first.
 *   3. A pull must not empty the users list, or the owner is locked out of his own
 *      books on that device.
 *
 * Run: node test/settingssync.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}
function eq(a, b, label) { ok(a === b, label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

function makeDevice(name) {
  const store = {};
  const sandbox = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    console, alert() {}, confirm: () => true,
    document: { getElementById: () => null, addEventListener() {} },
    navigator: { userAgent: 'Mozilla/5.0' },
    setTimeout, clearTimeout, fetch: undefined,
    APP_VERSION: 'test'
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['js/db.js', 'js/sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
  sandbox.db = sandbox.blankDB();
  sandbox.db.settings.deviceTag = name;
  sandbox.lastCommitted = sandbox.indexRecs_(sandbox.db);
  return sandbox;
}

function snapshotOf(dev) { return JSON.parse(JSON.stringify(dev.db)); }

function setCompany(dev, fields, stamp) {
  Object.assign(dev.db.settings.company, fields);
  dev.db.settings.companyUpdatedAt = stamp;
  dev.db.settings.settingsUpdatedAt = stamp;
  dev.commit();
}

const pc = makeDevice('PC');
const ph = makeDevice('PH');

/* ------------------------------ company details ------------------------------ */
console.log('\n--- company details reach the other machine ---');
setCompany(pc, { name: 'TEXPARK BUYING HOUSE', phone: '01621-008204' }, '2026-01-01T00:00:00.000Z');
ph.mergeCloudInto_(snapshotOf(pc));
ph.commit();
eq(ph.db.settings.company.name, 'TEXPARK BUYING HOUSE', 'the company name arrived on the phone');
eq(ph.db.settings.company.phone, '01621-008204', 'the phone number arrived too');

console.log('\n--- memo prefix and low-stock level travel ---');
pc.db.settings.memoPrefix = 'TXP/NEW/';
pc.db.settings.lowStockLevel = 25;
pc.db.settings.settingsUpdatedAt = '2026-01-02T00:00:00.000Z';
pc.commit();
ph.mergeCloudInto_(snapshotOf(pc));
ph.commit();
eq(ph.db.settings.memoPrefix, 'TXP/NEW/', 'the memo prefix followed the newer edit');
eq(ph.db.settings.lowStockLevel, 25, 'the low-stock level followed the newer edit');

/* ------------------------- what must NOT travel ------------------------- */
console.log('\n--- the sync URL and device tag stay on their own machine ---');
ph.db.settings.syncUrl = 'https://script.google.com/macros/s/PHONE_ONLY/exec';
ph.db.settings.autoPull = false;
ph.commit();
pc.mergeCloudInto_(snapshotOf(ph));
pc.commit();
ok(pc.db.settings.syncUrl !== 'https://script.google.com/macros/s/PHONE_ONLY/exec',
   'the PC did not adopt the phone\'s sync URL');
eq(pc.db.settings.deviceTag, 'PC', 'the PC kept its own device tag');
eq(pc.db.settings.autoPull, true, 'turning auto-pull off on the phone did not silence the PC');

console.log('\n--- a phone that never had a URL does not get one from the PC ---');
const fresh = makeDevice('NEW');
fresh.mergeCloudInto_(snapshotOf(pc));
fresh.commit();
ok(!fresh.db.settings.syncUrl, 'a machine without a URL did not inherit the PC\'s');

/* ------------------------------ newer edit wins ------------------------------ */
console.log('\n--- the phone\'s later edit wins over the PC\'s earlier one ---');
setCompany(ph, { name: 'TEXPARK BUYING HOUSE (UPDATED)' }, '2026-03-01T00:00:00.000Z');
pc.mergeCloudInto_(snapshotOf(ph));
pc.commit();
eq(pc.db.settings.company.name, 'TEXPARK BUYING HOUSE (UPDATED)', 'the newer company name won on the PC');

console.log('\n--- and the PC\'s later edit wins back ---');
setCompany(pc, { name: 'TEXPARK FINAL' }, '2026-04-01T00:00:00.000Z');
ph.mergeCloudInto_(snapshotOf(pc));
ph.commit();
eq(ph.db.settings.company.name, 'TEXPARK FINAL', 'the newer company name won on the phone');

console.log('\n--- an empty field on one side does not wipe the other ---');
setCompany(pc, { email: 'texpark.international01@gmail.com' }, '2026-05-01T00:00:00.000Z');
ph.mergeCloudInto_(snapshotOf(pc));
ph.commit();
eq(ph.db.settings.company.email, 'texpark.international01@gmail.com', 'the email arrived');
setCompany(ph, { email: '' }, '2026-06-01T00:00:00.000Z');
pc.mergeCloudInto_(snapshotOf(ph));
pc.commit();
eq(pc.db.settings.company.email, 'texpark.international01@gmail.com', 'a blank field did not erase the saved email');

/* ------------------------------ users ------------------------------ */
console.log('\n--- a user created on the web appears on the phone ---');
pc.db.users.push({
  id: 'u-salesman', username: 'rakib', name: 'Rakib', pass: pc.hash('rakib123'),
  role: 'salesman', active: true, createdAt: '2026-01-01T00:00:00.000Z'
});
pc.commit();
ph.mergeCloudInto_(snapshotOf(pc));
ph.commit();
ok(ph.db.users.some(u => u.username === 'rakib'), 'the new user reached the phone');
eq(ph.db.users.filter(u => u.username === 'rakib').length, 1, 'exactly one copy of that user');

console.log('\n--- two fresh installs do not merge into two admins ---');
const a = makeDevice('A');
const b = makeDevice('B');
eq(a.db.users.length, 1, 'device A starts with one admin');
eq(b.db.users.length, 1, 'device B starts with one admin');
eq(a.db.users[0].id, b.db.users[0].id, 'both seed admins share the same id');
a.mergeCloudInto_(snapshotOf(b));
a.commit();
b.mergeCloudInto_(snapshotOf(a));
b.commit();
eq(a.db.users.filter(u => u.username === 'admin').length, 1, 'device A has one admin, not two');
eq(b.db.users.filter(u => u.username === 'admin').length, 1, 'device B has one admin, not two');

console.log('\n--- the same user added on both sides merges to one ---');
const c = makeDevice('C');
const d = makeDevice('D');
c.db.users.push({ id: 'c-1', username: 'sumon', name: 'Sumon', pass: c.hash('aaaa'), role: 'salesman', active: true, at: '2026-01-01T00:00:00.000Z' });
d.db.users.push({ id: 'd-1', username: 'sumon', name: 'Sumon', pass: d.hash('bbbb'), role: 'manager', active: true, at: '2026-02-01T00:00:00.000Z' });
c.commit(); d.commit();
c.mergeCloudInto_(snapshotOf(d));
c.commit();
eq(c.db.users.filter(u => u.username === 'sumon').length, 1, 'one account, not two');
eq(c.db.users.find(u => u.username === 'sumon').role, 'manager', 'the newer role won');

console.log('\n--- a password reset on the PC works on the phone ---');
const pcUser = pc.db.users.find(u => u.username === 'rakib');
pcUser.pass = pc.hash('newpass99');
pc.commit();
ph.mergeCloudInto_(snapshotOf(pc));
ph.commit();
eq(ph.db.users.find(u => u.username === 'rakib').pass, ph.hash('newpass99'), 'the phone has the new password');

console.log('\n--- a user deleted on the phone does not come back ---');
const delUser = ph.db.users.find(u => u.username === 'rakib');
ph.db.users = ph.db.users.filter(u => u.id !== delUser.id);
ph.markDeleted_('users', delUser.id, new Date().toISOString());
ph.commit();
pc.mergeCloudInto_(snapshotOf(ph));
pc.commit();
ok(!pc.db.users.some(u => u.username === 'rakib'), 'the deleted user stayed deleted after a pull');

console.log('\n--- a pull can never leave a device with no users ---');
const empty = makeDevice('E');
empty.db.users = [];
empty.commit();
const other = makeDevice('F');
other.mergeCloudInto_(snapshotOf(empty));
other.commit();
ok(other.db.users.length >= 1, 'the other device still has a way in');
const empty2 = makeDevice('G');
empty2.db.users = [];
empty2.mergeCloudInto_({ products: [], settings: {} });
ok(empty2.db.users.length >= 1, 'merging an empty payload still leaves an admin');

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
console.log('=================');
process.exit(fail ? 1 : 0);
