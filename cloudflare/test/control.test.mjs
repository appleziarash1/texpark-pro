/* Durable Object tests for the persistent, shop-wide sync control. */
import assert from 'node:assert/strict';
import { Shop } from '../src/index.js';

const values = new Map();
const frames = [];
const sql = { exec() { return { toArray: () => [] }; } };
const ctx = {
  blockConcurrencyWhile(fn) { this.ready = fn(); },
  storage: {
    sql,
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); }
  },
  acceptWebSocket() {},
  getWebSockets() { return [{ send: frame => frames.push(JSON.parse(frame)) }]; }
};

const shop = new Shop(ctx, {});
await ctx.ready;
let response = await shop.fetch(new Request('https://worker.test/sync-control'));
assert.deepEqual(await response.json(), { mode: 'live', updatedAt: '' }, 'defaults to live');

response = await shop.fetch(new Request('https://worker.test/sync-control', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: '1h' })
}));
const saved = await response.json();
assert.equal(saved.ok, true);
assert.equal(saved.syncControl.mode, '1h');
assert.ok(saved.syncControl.updatedAt);
assert.equal(frames.at(-1).type, 'sync-control');
assert.equal(frames.at(-1).syncControl.mode, '1h', 'broadcasts the changed mode');

response = await shop.fetch(new Request('https://worker.test/sync-control'));
assert.equal((await response.json()).mode, '1h', 'reads the persisted mode');

response = await shop.fetch(new Request('https://worker.test/sync-control', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: '2s' })
}));
assert.equal(response.status, 400, 'rejects unsupported modes');

console.log('PASS sync control default, persist, broadcast and validation');