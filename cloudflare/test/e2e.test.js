/* End-to-end check against a RUNNING Worker (wrangler dev, or the deployed URL).

   Proves the parts the pure unit tests cannot: token auth over HTTP, a push that fans
   out to a second device's WebSocket, the delta pull, stale-write rejection, and the
   tombstone. Start the server first, then:

     cd cloudflare && npx wrangler dev --port 8787        # in one shell
     node test/e2e.test.js                                # in another

   Against the deployed Worker:
     CF_URL=https://texpark-sync.<you>.workers.dev CF_TOKEN=<token> node test/e2e.test.js */

const BASE = (process.env.CF_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN = process.env.CF_TOKEN || 'dev-secret-token-12345';
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function ok(name, cond, extra) { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fails++; }

(async () => {
  ok('health (no token)', (await j(await fetch(BASE + '/health'))).body.ok === true);
  ok('unauthorized rejected', (await j(await fetch(BASE + '/records'))).status === 401);
  ok('wrong token rejected', (await j(await fetch(BASE + '/records?token=nope'))).status === 401);

  const H = { 'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json' };

  // device B connects its live stream first
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/live?token=' + TOKEN);
  const frames = [];
  ws.addEventListener('message', e => { try { frames.push(JSON.parse(e.data)); } catch (x) { frames.push(e.data); } });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', e => rej(new Error('ws error'))); });
  await sleep(300);
  ok('hello on connect', frames[0] && frames[0].type === 'hello');
  const control0 = await j(await fetch(BASE + '/sync-control', { headers: H }));
  ok('new shop defaults to live push', control0.body && control0.body.mode === 'live');
  const controlPut = await j(await fetch(BASE + '/sync-control', { method: 'PUT', headers: H, body: JSON.stringify({ mode: '1m' }) }));
  ok('shop-wide mode accepted', controlPut.body && controlPut.body.ok && controlPut.body.syncControl.mode === '1m');
  await sleep(150);
  ok('setting broadcasts to connected devices', frames.some(f => f && f.type === 'sync-control' && f.syncControl.mode === '1m'));
  const control1 = await j(await fetch(BASE + '/sync-control', { headers: H }));
  ok('shop-wide mode persists', control1.body && control1.body.mode === '1m');
  const badControl = await j(await fetch(BASE + '/sync-control', { method: 'PUT', headers: H, body: JSON.stringify({ mode: '2s' }) }));
  ok('unsupported mode rejected', badControl.status === 400);

  // device A writes two records (fresh timestamps so a persisted DO from an earlier
  // run cannot treat them as stale; unique ids so the assertions stay exact)
  const base = Date.now() - 1000;
  const t1 = new Date(base).toISOString(), t2 = new Date(base + 1).toISOString();
  const CID = 'c' + base, PID = 'p' + base;
  const push = await j(await fetch(BASE + '/records', { method: 'POST', headers: H, body: JSON.stringify({ records: [
    { key: 'customers', id: CID, at: t1, deleted: false, device: 'A', data: { id: CID, name: 'Rahim', at: t1 } },
    { key: 'products', id: PID, at: t2, deleted: false, device: 'A', data: { id: PID, name: 'Shirt', at: t2 } }
  ] }) }));
  ok('push accepted', push.body && push.body.ok === true && push.body.applied === 2, JSON.stringify(push.body));

  await sleep(400);
  const changes = frames.filter(f => f && f.type === 'change');
  const got = changes.flatMap(f => f.records).map(r => r.key + '/' + r.id).filter(x => x.endsWith(base)).sort();
  ok('B got both over WebSocket', JSON.stringify(got) === JSON.stringify(['customers/' + CID, 'products/' + PID].sort()), JSON.stringify(got));
  ok('payload round-trips', changes[0] && changes[0].records[0].data && changes[0].records[0].data.name === 'Rahim');

  // delta pull: only what is newer than the cursor
  const d1 = await j(await fetch(BASE + '/records?token=' + TOKEN + '&since=' + encodeURIComponent(t1), { headers: H }));
  ok('delta since t1 returns only p1', d1.body.records.length === 1 && d1.body.records[0].id === PID, JSON.stringify(d1.body.records.map(r => r.id)));
  ok('now cursor returned', typeof d1.body.now === 'string' && d1.body.now >= t2);

  // stale write must not win
  const stale = await j(await fetch(BASE + '/records', { method: 'POST', headers: H, body: JSON.stringify({ records: [
    { key: 'customers', id: CID, at: '2025-01-01T00:00:00.000Z', deleted: false, device: 'X', data: { id: CID, name: 'OLD' } }
  ] }) }));
  ok('stale write ignored', stale.body.applied === 0);
  const d2 = await j(await fetch(BASE + '/records?token=' + TOKEN + '&since=' + encodeURIComponent(new Date(base - 10).toISOString()), { headers: H }));
  const c1 = d2.body.records.find(r => r.id === CID);
  ok('stored value unchanged', c1 && c1.data.name === 'Rahim');

  // delete tombstone syncs too
  await fetch(BASE + '/records', { method: 'POST', headers: H, body: JSON.stringify({ records: [
    { key: 'customers', id: CID, at: new Date(base + 9).toISOString(), deleted: true, device: 'A', data: { id: CID } }
  ] }) });
  await sleep(300);
  const last = frames.filter(f => f && f.type === 'change').pop();
  ok('delete fans out as tombstone', last.records[0].deleted === true);

  ws.close();
  console.log(fails ? ('\nFAILURES: ' + fails) : '\nALL BACKEND CHECKS PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FATAL ' + e.message); process.exit(1); });
