/* The Worker's decision logic, as plain functions.

   These are the same functions the Durable Object calls (see src/index.js), so the
   "newer wins" rule, the delta window and the token compare are tested without a
   Worker or a network. Run: node test/logic.test.mjs */

import { tokenMatches, decideApply, selectDelta, rowToRecord } from '../src/index.js';

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

console.log('\n--- token compare ---');
{
  eq(tokenMatches('abc', 'abc'), true, 'the right token matches');
  eq(tokenMatches('abd', 'abc'), false, 'a near miss does not');
  eq(tokenMatches('ab', 'abc'), false, 'a shorter one does not');
  eq(tokenMatches('', 'abc'), false, 'an empty one does not');
  eq(tokenMatches('abc', ''), false, 'and nothing matches an unset secret');
}

console.log('\n--- newer wins, stale loses ---');
{
  const stored = { 'customers/c1': '2026-01-01T00:00:05.000Z' };
  const at = (key, id) => (key + '/' + id in stored ? stored[key + '/' + id] : null);
  const r = decideApply(at, [
    { key: 'customers', id: 'c1', at: '2026-01-01T00:00:09.000Z', data: { name: 'new' } },
    { key: 'customers', id: 'c1', at: '2026-01-01T00:00:01.000Z', data: { name: 'old' } },
    { key: 'customers', id: 'c1', at: '2026-01-01T00:00:05.000Z', data: { name: 'same' } }
  ], '2026-01-01T00:00:05.000Z');
  eq(r.applied.length, 1, 'only the strictly-newer write is applied');
  eq(r.applied[0].data.name, 'new', 'and it is the new one');
  eq(r.maxAt, '2026-01-01T00:00:09.000Z', 'the high-water mark moved');
}

console.log('\n--- a fresh record is always applied ---');
{
  const r = decideApply(() => null, [{ key: 'products', id: 'p1', at: '2026-01-01T00:00:01.000Z', data: { name: 'Shirt' } }], '');
  eq(r.applied.length, 1, 'a record the shop has never seen is written');
  eq(r.applied[0].key, 'products', 'under its collection');
  eq(r.applied[0].deleted, false, 'as a live record');
}

console.log('\n--- a tombstone is a write too ---');
{
  const r = decideApply(() => '2026-01-01T00:00:01.000Z', [
    { key: 'customers', id: 'c1', at: '2026-01-01T00:00:09.000Z', deleted: true, data: { id: 'c1' } }
  ], '');
  eq(r.applied.length, 1, 'a newer delete is applied');
  eq(r.applied[0].deleted, true, 'and carries the tombstone flag');
}

console.log('\n--- junk is dropped, not stored ---');
{
  const r = decideApply(() => null, [
    null,
    { id: 'no-key', at: '2026-01-01T00:00:01.000Z' },
    { key: '', id: 'x', at: '2026-01-01T00:00:01.000Z' },
    { key: 'products', id: 'ok', at: '2026-01-01T00:00:01.000Z', data: { id: 'ok' } }
  ], '');
  eq(r.applied.length, 1, 'only the well-formed record survives');
  eq(r.applied[0].id, 'ok', 'and it is the valid one');
}

console.log('\n--- the delta window ---');
{
  const rows = [
    { key: 'customers', id: 'c1', at: '2026-01-01T00:00:01.000Z', deleted: 0, device: '', data: '{"id":"c1"}' },
    { key: 'products', id: 'p1', at: '2026-01-01T00:00:03.000Z', deleted: 0, device: '', data: '{"id":"p1"}' },
    { key: 'products', id: 'p2', at: '2026-01-01T00:00:02.000Z', deleted: 0, device: '', data: '{"id":"p2"}' }
  ];
  const d = selectDelta(rows, '2026-01-01T00:00:01.000Z');
  eq(d.length, 2, 'only what is newer than the cursor');
  eq(d[0].id, 'p2', 'oldest first');
  eq(d[1].id, 'p1', 'then newer');
  eq(selectDelta(rows, '').length, 3, 'an empty cursor is everything');
  eq(selectDelta(rows, '2026-01-01T00:00:03.000Z').length, 0, 'the newest cursor is nothing');
}

console.log('\n--- rows come back as the client shape ---');
{
  const rec = rowToRecord({ key: 'customers', id: 'c1', at: 'x', deleted: 1, device: 'phone', data: '{"name":"Rahim"}' });
  eq(rec.deleted, true, 'deleted is a boolean, not 1');
  eq(rec.data.name, 'Rahim', 'the JSON body is parsed back to an object');
  const bad = rowToRecord({ key: 'customers', id: 'c2', at: 'x', deleted: 0, device: '', data: '{not json' });
  eq(bad.data, null, 'a corrupt body becomes null, never a throw');
}

console.log('\n=================');
console.log('PASS ' + pass + '   FAIL ' + fail);
if (fail) process.exit(1);
