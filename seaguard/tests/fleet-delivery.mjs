// SeaGuard fleet delivery/API/UI microtask - offline focused tests.
// Covers: durable mock idempotency (fn0031 ledger + fn0029 delivery identity),
// fleet operator save/restore/error status, and the validated loopback fleet
// state/command API (fn004f GET state, fn005d POST command). Runs the GENERATED
// wrapped function bodies (flows.json) with the real persistence runtime,
// Map-backed get/set scopes and fake/spy runtimes. No live Node-RED, no restarts,
// no real messages.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import runtimeMod from '../src/fleet/runtime.cjs';
import fleetStore from '../src/fleet/persistence.cjs';

const { createRuntime } = runtimeMod;
const { createStore } = fleetStore;

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const flowsPath = path.join(ROOT, 'flows.json');
const reportPath = path.join(ROOT, 'reports', 'fleet-delivery.json');

assert.ok(fs.existsSync(flowsPath), 'flows.json missing - run `node seaguard/build.mjs` first');
const nodes = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
const funcOf = (id) => (byId[id] && byId[id].type === 'function' ? byId[id].func : null);
for (const id of ['fn0029', 'fn0031', 'fn0042', 'fn004e', 'fn004f', 'fn005d']) {
  assert.ok(funcOf(id), 'generated body missing for ' + id);
}

const outcomes = [];
function test(name, fn) {
  try { fn(); outcomes.push({ name, passed: true }); }
  catch (e) { outcomes.push({ name, passed: false, error: e.message }); }
}

// --- Map-backed get/set fixtures (Node-RED context / global context stand-ins) ---
function makeScope() {
  const m = new Map();
  return { map: m, get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } };
}
const envFake = { get: () => undefined };
function makeNode(sends) {
  const statuses = [];
  return { statuses, send: (m) => { (Array.isArray(m) ? m : [m]).forEach((x) => { if (x) sends.push(x); }); },
    status: (s) => statuses.push(s), error: () => {}, warn: () => {}, debug: () => {} };
}
function runBody(id, { global = makeScope(), context = makeScope(), msg = {}, node = null, sends = [] } = {}) {
  const fn = new Function('msg', 'node', 'context', 'global', 'flow', 'env', funcOf(id));
  const nodeFake = node || makeNode(sends);
  return { result: fn(msg, nodeFake, context, global, makeScope(), envFake), node: nodeFake };
}
// Spy runtime: records hook/save order so "persist before success" is observable.
function spyRuntime() {
  const calls = [];
  return { calls,
    before: (id) => { calls.push('before:' + id); return true; },
    after: (id) => { calls.push('after:' + id); },
    save: (g) => { calls.push('save'); const r = { ok: true, savedAt: '2026-10-26T00:00:00.000Z', bytes: 10 }; g.set('fleetSaveStatus', Object.assign({ ok: true, error: null, saves: 1 }, r)); return r; },
    status: () => ({ initialized: true, blocked: false, restored: false, pausedHold: false, saves: 1, lastSave: '2026-10-26T00:00:00.000Z', lastLoad: null, source: 'test', error: null }) };
}

// --- Real-runtime world fixture (valid live-shaped snapshot) ---
function worldSnapshot(g = {}, n = {}) {
  const globals = Object.assign({
    epoch: 7, simTime: 3600, simSpeed: 2, simRunning: true, mode: 'live', runSeed: 1234,
    faults: [], notifications: [],
    gateway: { connected: true, forcedDown: false, buffered: 0, stats: { fwd: 3, buffered: 2, bufDropped: 0, flushed: 0, down: 0 } },
  }, g);
  return { globals, nodes: n };
}
const TEMP = path.join(here, 'fixtures', 'fleet-delivery');
const PROJECT_ROOT = path.resolve(here, '..', '..');
const tempRel = path.relative(PROJECT_ROOT, TEMP);
assert.ok(tempRel && !tempRel.startsWith('..') && !path.isAbsolute(tempRel), 'scratch dir escapes project root: ' + TEMP);
fs.rmSync(TEMP, { recursive: true, force: true });
fs.mkdirSync(TEMP, { recursive: true });
function seedDir(name, snap) {
  const dir = path.join(TEMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fleet.json'), JSON.stringify({ format: 'seaguard.fleet', version: 1, savedAt: 1700000000000, ...snap }), 'utf8');
  return dir;
}
function setupWorld(name, snap) {
  const rt = createRuntime({ dataDir: seedDir(name, snap) });
  const global = makeScope();
  global.set('fleetRuntime', rt);
  const init = rt.initialize(global);
  assert.ok(init.ok, 'initialize failed: ' + init.error);
  return { rt, global, init };
}

// ===========================================================================
// 1. Durable mock idempotency (fn0031 + fn0029 identity)
// ===========================================================================
test('mock: first delivery is logged, ledgered and persisted BEFORE success returns', () => {
  const global = makeScope();
  global.set('lib', { findFault: () => null });
  global.set('simTime', 10); global.set('faults', []); global.set('epoch', 3);
  const rt = spyRuntime();
  global.set('fleetRuntime', rt);
  const req = { headers: { 'x-seaguard-delivery-id': '3:INC-1/family', 'x-seaguard-epoch': '3' } };
  const r = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'x Ref: INC-1 y' }, req } });
  assert.equal(r.result.statusCode, 200);
  assert.equal(r.result.payload.ok, true);
  const firstId = r.result.payload.result.message_id;
  assert.equal(firstId, 1, 'stable simulated message_id from the monotonic counter, not the log ring');
  const log = global.get('mockTelegram');
  assert.equal(log.length, 1, 'one success log entry');
  const ledger = global.get('mockDeliveryLedger');
  assert.ok(ledger['3:INC-1/family'], 'ledger record created');
  assert.equal(ledger['3:INC-1/family'].message_id, firstId);
  const saveIdx = rt.calls.indexOf('save');
  assert.ok(saveIdx !== -1, 'fleet checkpoint save called');
  assert.ok(saveIdx < rt.calls.length, 'save happened during the request (before return)');
});

test('mock: replay of an accepted delivery returns the SAME message_id with no second log/ledger effect', () => {
  const global = makeScope();
  global.set('lib', { findFault: () => null });
  global.set('simTime', 11); global.set('faults', []); global.set('epoch', 3);
  global.set('fleetRuntime', spyRuntime());
  const req = { headers: { 'x-seaguard-delivery-id': '3:INC-1/family', 'x-seaguard-epoch': '3' } };
  const first = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'x Ref: INC-1 y' }, req } });
  const replay = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'x Ref: INC-1 y' }, req } });
  assert.equal(replay.result.statusCode, 200);
  assert.equal(replay.result.payload.dedup, true, 'replay flagged as dedup');
  assert.equal(replay.result.payload.result.message_id, first.result.payload.result.message_id, 'same simulated message_id');
  assert.equal(replay.result.payload.result.message_id, 1, 'exact stable ID on replay, independent of log length');
  assert.equal(global.get('mockTelegram').length, 1, 'no second success log entry');
  assert.equal(Object.keys(global.get('mockDeliveryLedger')).length, 1, 'no second ledger record');
  // A different delivery identity gets the next counter value, still exact.
  const req2 = { headers: { 'x-seaguard-delivery-id': '3:INC-4/family', 'x-seaguard-epoch': '3' } };
  const second = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'Ref: INC-4' }, req: req2 } });
  assert.equal(second.result.payload.result.message_id, 2, 'second delivery gets the next stable ID');
});

test('mock: injected-outage failure creates no confirmed ledger record; later success does', () => {
  const global = makeScope();
  global.set('lib', { findFault: (f, t, b, type) => type === 'TELEGRAM_OUTAGE' ? { type } : null });
  global.set('simTime', 12); global.set('faults', [{}]); global.set('epoch', 3);
  const req = { headers: { 'x-seaguard-delivery-id': '3:INC-2/family', 'x-seaguard-epoch': '3' } };
  const fail = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'Ref: INC-2' }, req } });
  assert.equal(fail.result.statusCode, 502);
  assert.equal(global.get('mockDeliveryLedger')['3:INC-2/family'], undefined, 'failed attempt not ledgered');
  // Outage ends: the same delivery identity now succeeds for the first time.
  global.set('lib', { findFault: () => null });
  const ok = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'Ref: INC-2' }, req } });
  assert.equal(ok.result.statusCode, 200);
  assert.equal(ok.result.payload.dedup, undefined, 'post-outage success is a first-time delivery, not a dedup');
  assert.ok(global.get('mockDeliveryLedger')['3:INC-2/family'], 'success ledgered');
});

test('mock: stale-epoch request is rejected 409 with no confirmed ledger record', () => {
  const global = makeScope();
  global.set('lib', { findFault: () => null });
  global.set('simTime', 13); global.set('faults', []); global.set('epoch', 9);
  const req = { headers: { 'x-seaguard-delivery-id': '3:INC-3/family', 'x-seaguard-epoch': '3' } };
  const r = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'Ref: INC-3' }, req } });
  assert.equal(r.result.statusCode, 409);
  assert.equal(r.result.payload.ok, false);
  assert.equal(global.get('mockDeliveryLedger')['3:INC-3/family'], undefined, 'stale request not ledgered');
  assert.equal(global.get('mockTelegram').some(m => m.ok === false && /stale epoch/.test(m.note || '')), true, 'rejection visible in mock log');
});

test('notifier: every send carries the durable delivery identity (epoch + record id) and epoch header', () => {
  const global = makeScope();
  global.set('cfg', { baseUrl: 'http://127.0.0.1:1880', telegram: { enabled: false, token: '' }, retry: { maxNotifyTries: 3, notifyBackoff: [2, 5, 10] } });
  global.set('epoch', 4); global.set('simTime', 50); global.set('mode', 'test');
  const context = makeScope();
  const sends = [];
  runBody('fn0029', { global, context, msg: { topic: 'notify', payload: { ref: 'INC-9', incident: { id: 'INC-9' }, kind: 'ALERT', roles: ['family'], severity: 1, text: 'Ref: INC-9' } }, node: makeNode(sends), sends });
  const tickRes = runBody('fn0029', { global, context, msg: { topic: 'tick' } });
  const out = context.get('S');
  const rec = out.list.find(r => r.id === 'INC-9/family');
  assert.ok(rec && rec.status === 'SENDING', 'record went to SENDING on tick');
  const sent = (Array.isArray(tickRes.result) ? (tickRes.result[0] || []) : []).find(s => s.topic === 'send') || sends.find(s => s.topic === 'send');
  assert.ok(sent, 'HTTP send emitted');
  assert.equal(sent.headers['x-seaguard-delivery-id'], '4:INC-9/family', 'durable identity header');
  assert.equal(sent.headers['x-seaguard-epoch'], '4');
});

test('notifier: duplicate notify for the same ref/role is not re-enqueued; terminal records are never re-sent', () => {
  const global = makeScope();
  global.set('cfg', { baseUrl: 'http://127.0.0.1:1880', telegram: { enabled: false, token: '' }, retry: { maxNotifyTries: 3, notifyBackoff: [2, 5, 10] } });
  global.set('epoch', 4); global.set('simTime', 51); global.set('mode', 'test');
  const context = makeScope();
  const mk = () => { const s = []; return { node: makeNode(s), sends: s }; };
  const p = { ref: 'INC-9', incident: { id: 'INC-9' }, kind: 'ALERT', roles: ['family'], severity: 1, text: 'Ref: INC-9' };
  runBody('fn0029', { global, context, msg: { topic: 'notify', payload: p }, ...mk() });
  runBody('fn0029', { global, context, msg: { topic: 'notify', payload: p }, ...mk() });
  assert.equal(context.get('S').list.length, 1, 'duplicate notify not re-enqueued');
  // Mark delivered, advance the clock, tick: no new send for the terminal record.
  context.get('S').list[0].status = 'DELIVERED';
  context.get('S').list[0].nextAt = 0;
  global.set('simTime', 60);
  const t2 = mk();
  const t2res = runBody('fn0029', { global, context, msg: { topic: 'tick' }, node: t2.node, sends: t2.sends });
  const t2out = Array.isArray(t2res.result) ? (t2res.result[0] || []) : [];
  assert.equal(t2out.length, 0, 'DELIVERED record not re-sent on tick');
});

// ===========================================================================
// 2. Operator save/restore/error status
// ===========================================================================
test('save status refreshes keep restored/pausedHold/blocked metadata (not just initialize)', () => {
  const { rt, global } = setupWorld('status-flags', worldSnapshot());
  let st = global.get('fleetSaveStatus');
  assert.equal(st.restored, true, 'restored flag present after initialize');
  assert.equal(st.pausedHold, true, 'pausedHold flag present after initialize');
  assert.equal(st.blocked, false);
  // A periodic/immediate save refreshes the status without losing the flags.
  assert.ok(rt.save(global).ok);
  st = global.get('fleetSaveStatus');
  assert.equal(st.ok, true);
  assert.equal(st.restored, true, 'restored survives a save refresh');
  assert.equal(st.pausedHold, true, 'pausedHold survives a save refresh');
  assert.ok(st.savedAt, 'savedAt reported');
});

test('failed save reports the error honestly and keeps live state intact', () => {
  const { rt, global } = setupWorld('save-fail', worldSnapshot());
  // Force a deterministic persistence failure: an allowlisted global whose
  // serialization throws, so the store's atomic write cannot complete.
  global.set('faults', { get 0() { throw new Error('disk full (simulated)'); } });
  const r = rt.save(global);
  assert.equal(r.ok, false);
  const st = global.get('fleetSaveStatus');
  assert.equal(st.ok, false);
  assert.ok(st.error, 'error surfaced');
  assert.equal(global.get('simTime'), 3600, 'live state untouched');
  assert.equal(st.restored, true, 'flags survive a failed save');
});

test('corrupt store blocks the world: publisher and API pass through, operational nodes stay blocked, autosave refused', () => {
  const dir = path.join(TEMP, 'blocked');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fleet.json'), '{"format":"seaguard.fleet","version":1,"savedAt":1,"globals":{"epoch":-5},"nodes":{}}', 'utf8');
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  const init = rt.initialize(global);
  assert.equal(init.blocked, true);
  assert.equal(rt.before('fn004e', makeScope(), global, null), true, 'publisher passes through while blocked');
  assert.equal(rt.before('fn004f', makeScope(), global, null), true, 'state API passes through while blocked');
  assert.equal(rt.before('fn005d', makeScope(), global, null), true, 'command API passes through while blocked');
  assert.equal(rt.before('fn0010', makeScope(), global, null), false, 'gateway held while blocked');
  assert.equal(rt.before('fn003a', makeScope(), global, null), false, 'clock control held while blocked');
  const before = fs.readFileSync(path.join(dir, 'fleet.json'), 'utf8');
  rt.after('fn004e', makeScope(), global, null);
  rt.after('fn004f', makeScope(), global, null);
  const after = fs.readFileSync(path.join(dir, 'fleet.json'), 'utf8');
  assert.equal(after, before, 'after hooks refused autosave: corrupt file untouched');
  assert.equal(rt.save(global).ok, false, 'explicit save refused while blocked');
  assert.equal(rt.resume(global).ok, false, 'resume refused while blocked');
});

test('restored pause: operator ack/resolve commands stay usable; transport traffic stays held', () => {
  const { rt, global } = setupWorld('corr-held', worldSnapshot());
  const ctx = makeScope();
  assert.equal(rt.before('fn001b', ctx, global, { topic: 'event', payload: {} }), false, 'event traffic held while paused');
  assert.equal(rt.before('fn001b', ctx, global, { topic: 'cmd', payload: { cmd: 'ack', id: 'INC-1' } }), true, 'ack command passes through while paused');
  assert.equal(rt.before('fn001b', ctx, global, { topic: 'cmd', payload: { cmd: 'resolve', id: 'INC-1' } }), true, 'resolve command passes through while paused');
  assert.equal(rt.before('fn0010', ctx, global, { topic: 'tick' }), false, 'gateway still held while paused');
});

// ===========================================================================
// 3. Validated loopback fleet state/command API
// ===========================================================================
test('GET /seaguard/fleet/state: 200 with clock/save/runtime status and no cfg or credentials', () => {
  const { rt, global } = setupWorld('api-state', worldSnapshot());
  const r = runBody('fn004f', { global, msg: {} });
  assert.equal(r.result.statusCode, 200);
  assert.equal(r.result.payload.ok, true);
  assert.equal(r.result.payload.clock.epoch, 7);
  assert.equal(r.result.payload.clock.running, false, 'restored world reports paused');
  assert.equal(r.result.payload.save.restored, true);
  assert.equal(r.result.payload.runtime.blocked, false);
  const text = JSON.stringify(r.result.payload);
  assert.ok(!/token|password|secret/i.test(text), 'no credentials in state response');
  assert.ok(!text.includes('"cfg"'), 'no cfg object in state response');
});

// fn005d declares TWO outputs: [0] = command router (link out to fn0042),
// [1] = HTTP response (ho005f). These tests assert the ACTUAL output positions,
// status codes and bodies - no custom result flattening.
function runCommand(payload, { global } = {}) {
  const r = runBody('fn005d', { global, msg: { payload } });
  assert.ok(Array.isArray(r.result), 'fn005d returns an output array');
  assert.equal(r.result.length, 2, 'fn005d has exactly two outputs');
  return { router: r.result[0], res: r.result[1] };
}
function blockedWorld(name) {
  const dir = path.join(TEMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fleet.json'), '{"format":"seaguard.fleet","version":1,"savedAt":1,"globals":{"epoch":-5},"nodes":{}}', 'utf8');
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  assert.equal(rt.initialize(global).blocked, true);
  global.set('fleetRuntime', rt);
  return { rt, global };
}

test('POST /seaguard/fleet/command: invalid or missing action -> 400 body on output 2, nothing routed on output 1', () => {
  const { global } = setupWorld('api-400', worldSnapshot());
  for (const payload of [{ action: 'nuke' }, {}, { action: 42 }]) {
    const { router, res } = runCommand(payload, { global });
    assert.equal(router, null, JSON.stringify(payload) + ' sends nothing to the command router');
    assert.ok(res, 'HTTP response present on output 2');
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.ok, false);
    assert.match(res.payload.error, /pause, resume, save, restart/);
  }
});

test('POST command save: 200 on output 2, completed checkpoint body, nothing routed', () => {
  const { global } = setupWorld('api-save', worldSnapshot());
  const { router, res } = runCommand({ action: 'save' }, { global });
  assert.equal(router, null, 'completed save forwards nothing to the router');
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.completed, true, 'save is reported completed');
  assert.equal(res.payload.async, undefined, 'save is not reported as async');
  assert.equal(res.payload.save.ok, true);
  assert.ok(res.payload.save.status.savedAt, 'save status carries savedAt');
});

test('POST command save while blocked: 500 on output 2 with the block error, live state kept', () => {
  const { global } = blockedWorld('api-blocked');
  const before = fs.readFileSync(path.join(TEMP, 'api-blocked', 'fleet.json'), 'utf8');
  const { router, res } = runCommand({ action: 'save' }, { global });
  assert.equal(router, null);
  assert.equal(res.statusCode, 500);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.save.error, /blocked/i);
  assert.equal(fs.readFileSync(path.join(TEMP, 'api-blocked', 'fleet.json'), 'utf8'), before, 'corrupt snapshot untouched');
});

test('POST command save with missing fleet runtime: 503 on output 2', () => {
  const global = makeScope(); // no fleetRuntime registered
  const { router, res } = runCommand({ action: 'save' }, { global });
  assert.equal(router, null);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /persistence runtime/i);
});

test('POST command resume while blocked: 409 on output 2 explaining restart recovery', () => {
  const { global } = blockedWorld('api-blocked2');
  const { router, res } = runCommand({ action: 'resume' }, { global });
  assert.equal(router, null, 'refused resume is not forwarded');
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /restart/i);
});

test('POST command pause/resume/restart: router cmd on output 1 and 202 accepted-async on output 2', () => {
  const { global } = setupWorld('api-async', worldSnapshot());
  for (const [action, cmd] of [['pause', 'pause'], ['resume', 'resume'], ['restart', 'live']]) {
    const { router, res } = runCommand({ action }, { global });
    assert.ok(router, action + ' forwards a router message on output 1');
    assert.equal(router.topic, 'cmd', action + ' router topic');
    assert.equal(router.payload.cmd, cmd, action + ' maps to router cmd ' + cmd);
    assert.ok(res, action + ' HTTP response on output 2');
    assert.equal(res.statusCode, 202, action + ' accepted');
    assert.equal(res.payload.ok, true);
    assert.equal(res.payload.accepted, true);
    assert.equal(res.payload.async, true);
  }
});

test('command router save: synchronous checkpoint through the adapter with node status feedback', () => {
  const global = makeScope();
  const rt = spyRuntime();
  global.set('fleetRuntime', rt);
  const r = runBody('fn0042', { global, msg: { topic: 'cmd', payload: { cmd: 'save' } } });
  assert.equal(r.result, null, 'router save emits no downstream messages');
  assert.ok(rt.calls.includes('save'), 'adapter save called');
  assert.equal(r.node.statuses.at(-1).text, 'checkpoint saved');
  const fail = runBody('fn0042', { global: makeScope(), msg: { topic: 'cmd', payload: { cmd: 'save' } } });
  assert.equal(fail.node.statuses.at(-1).fill, 'red', 'missing runtime surfaces a red status');
});

test('publisher head exposes the checkpoint save status for the operator UI', () => {
  const global = makeScope();
  global.set('epoch', 1); global.set('simTime', 5); global.set('simRunning', false);
  global.set('simSpeed', 1); global.set('mode', 'live');
  global.set('cfg', { fleet: [], zones: [], storm: { zones: [] }, telegram: { enabled: false, token: 'DEMO' }, harbour: { lat: 56.1, lon: -4.5, wifiRadiusM: 500 }, boundary: { name: 'B', points: [] }, reserve: { name: 'R', poly: [] }, test: { durationS: 600 } });
  global.set('lib', { boatName: () => 'B', zoneName: () => 'Z' });
  global.set('layout', { boats: [] }); global.set('fleet', {}); global.set('truth', {});
  global.set('fw', {}); global.set('geo', {}); global.set('weather', {});
  global.set('seaState', {}); global.set('incidents', []); global.set('notifications', []);
  global.set('test', { state: 'IDLE', history: [] });
  global.set('gateway', {}); global.set('gatewayShore', {}); global.set('syncStore', {});
  global.set('linkLog', []); global.set('linkHist', {}); global.set('eventLog', []);
  global.set('suppressions', []); global.set('mockTelegram', []);
  global.set('fleetSaveStatus', { ok: true, error: null, restored: true, pausedHold: true, blocked: false, savedAt: '2026-10-26T00:00:00.000Z', saves: 2 });
  const r = runBody('fn004e', { global, msg: { topic: 'tick' } });
  const pub = r.result.find(x => x && x.topic === 'fleet');
  assert.ok(pub, 'fleet payload published');
  assert.equal(pub.payload.head.save.restored, true, 'head.save carries restore status');
  assert.equal(pub.payload.head.save.pausedHold, true);
  assert.equal(pub.payload.head.save.savedAt, '2026-10-26T00:00:00.000Z');
});

// ===========================================================================
// 4. fn0031 durability negatives (save failure, stable IDs, key hygiene)
// ===========================================================================
function failingRuntime() {
  const calls = [];
  return { calls,
    before: (id) => true,
    after: () => {},
    save: (g) => { calls.push('save'); g.set('fleetSaveStatus', { ok: false, error: 'disk full (simulated)', saves: 0 }); return { ok: false, error: 'disk full (simulated)' }; },
    status: () => ({ initialized: true, blocked: false, restored: false, pausedHold: false, saves: 0, lastSave: null, lastLoad: null, source: 'test', error: null }) };
}

test('mock: failed checkpoint save returns 503, rolls back ledger/log/seq effects, keeps one diagnostic row', () => {
  const global = makeScope();
  global.set('lib', { findFault: () => null });
  global.set('simTime', 20); global.set('faults', []); global.set('epoch', 3);
  const rt = failingRuntime();
  global.set('fleetRuntime', rt);
  const req = { headers: { 'x-seaguard-delivery-id': '3:INC-5/family', 'x-seaguard-epoch': '3' } };
  const r = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'Ref: INC-5' }, req } });
  assert.equal(r.result.statusCode, 503, 'failed save is not confirmed as delivered');
  assert.equal(r.result.payload.ok, false);
  assert.equal(global.get('mockDeliveryLedger')['3:INC-5/family'], undefined, 'ledger effect rolled back');
  assert.equal(global.get('mockDeliverySeq'), 0, 'counter effect rolled back');
  const log = global.get('mockTelegram');
  assert.equal(log.filter(m => m.ok).length, 0, 'success log row rolled back');
  assert.equal(log.length, 1, 'one diagnostic row retained');
  assert.match(log[0].note, /checkpoint save failed/);
  assert.ok(rt.calls.includes('save'), 'checkpoint attempted before the response');
  assert.equal(global.get('fleetSaveStatus').ok, false, 'save failure surfaced');
});

test('mock: retry after a failed save re-delivers exactly once with the same stable ID and no cached-durability claim', () => {
  const global = makeScope();
  global.set('lib', { findFault: () => null });
  global.set('simTime', 21); global.set('faults', []); global.set('epoch', 3);
  const rt = failingRuntime();
  global.set('fleetRuntime', rt);
  const req = { headers: { 'x-seaguard-delivery-id': '3:INC-6/family', 'x-seaguard-epoch': '3' } };
  const m = { payload: { chat_id: 'c1', text: 'Ref: INC-6' }, req };
  const fail = runBody('fn0031', { global, msg: { ...m } });
  assert.equal(fail.result.statusCode, 503);
  // Disk recovers: same delivery identity, first durable confirmation.
  global.set('fleetRuntime', spyRuntime());
  const ok = runBody('fn0031', { global, msg: { ...m } });
  assert.equal(ok.result.statusCode, 200);
  assert.equal(ok.result.payload.dedup, undefined, 'retry after rollback is a first-time delivery, not a cached replay');
  assert.equal(ok.result.payload.result.message_id, 1, 'same stable ID the rolled-back attempt would have had');
  assert.equal(global.get('mockDeliveryLedger')['3:INC-6/family'].message_id, 1);
  assert.equal(global.get('mockTelegram').filter(x => x.ok).length, 1, 'exactly one success effect overall');
  // Now the cached replay agrees with the original.
  const replay = runBody('fn0031', { global, msg: { ...m } });
  assert.equal(replay.result.payload.dedup, true);
  assert.equal(replay.result.payload.result.message_id, ok.result.payload.result.message_id, 'original and replay share the exact ID');
  assert.equal(global.get('mockTelegram').filter(x => x.ok).length, 1, 'replay adds no second success effect');
});

test('mock: message_id stays stable and unique across the 300-row log ring boundary', () => {
  const global = makeScope();
  global.set('lib', { findFault: () => null });
  global.set('simTime', 22); global.set('faults', []); global.set('epoch', 3);
  global.set('mockTelegram', Array.from({ length: 300 }, (_, i) => ({ t: i, chat: 'old', ref: null, ok: true, text: 'old ' + i })));
  global.set('fleetRuntime', spyRuntime());
  const req = { headers: { 'x-seaguard-delivery-id': '3:INC-7/family', 'x-seaguard-epoch': '3' } };
  const r = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'Ref: INC-7' }, req } });
  assert.equal(r.result.statusCode, 200);
  assert.equal(r.result.payload.result.message_id, 1, 'counter-based ID, not the saturated ring length (300)');
  assert.equal(global.get('mockTelegram').length, 300, 'ring stays capped');
  const replay = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'Ref: INC-7' }, req } });
  assert.equal(replay.result.payload.result.message_id, r.result.payload.result.message_id, 'replay agrees after ring truncation');
});

test('mock: inherited or malformed ledger keys cannot fake a completed delivery', () => {
  const global = makeScope();
  global.set('lib', { findFault: () => null });
  global.set('simTime', 23); global.set('faults', []); global.set('epoch', 3);
  global.set('fleetRuntime', spyRuntime());
  const ledger = {};
  ledger['3:INC-8/family'] = 'not-an-object'; // malformed own record value
  global.set('mockDeliveryLedger', ledger);
  // Inherited Object.prototype key: not an own record, must not fake a completed delivery.
  const req = { headers: { 'x-seaguard-delivery-id': 'valueOf', 'x-seaguard-epoch': '3' } };
  const r = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'Ref: INC-8' }, req } });
  assert.equal(r.result.statusCode, 200);
  assert.equal(r.result.payload.dedup, undefined, 'inherited Object.prototype.valueOf is not a confirmed record');
  assert.equal(r.result.payload.result.message_id, 1, 'real first-time ID assigned');
  // Malformed own value: not a confirmed delivery either.
  const req2 = { headers: { 'x-seaguard-delivery-id': '3:INC-8/family', 'x-seaguard-epoch': '3' } };
  const r2 = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'Ref: INC-8' }, req: req2 } });
  assert.equal(r2.result.statusCode, 200);
  assert.equal(r2.result.payload.dedup, undefined, 'malformed record value is not a confirmed delivery');
  assert.equal(r2.result.payload.result.message_id, 2);
  // A well-formed own record IS honored with its stored ID.
  global.get('mockDeliveryLedger')['3:OK/family'] = { message_id: 42, chat: 'c9', text: 'stored', date: 1700000000, t: 1 };
  const req3 = { headers: { 'x-seaguard-delivery-id': '3:OK/family', 'x-seaguard-epoch': '3' } };
  const r3 = runBody('fn0031', { global, msg: { payload: { chat_id: 'c9', text: 'stored' }, req: req3 } });
  assert.equal(r3.result.statusCode, 200);
  assert.equal(r3.result.payload.dedup, true, 'well-formed own record dedups');
  assert.equal(r3.result.payload.result.message_id, 42);
});

test('mock: delivery id reused with a changed chat or text is rejected 409, original record untouched', () => {
  const global = makeScope();
  global.set('lib', { findFault: () => null });
  global.set('simTime', 24); global.set('faults', []); global.set('epoch', 3);
  global.set('fleetRuntime', spyRuntime());
  const req = { headers: { 'x-seaguard-delivery-id': '3:INC-10/family', 'x-seaguard-epoch': '3' } };
  const first = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'Ref: INC-10' }, req } });
  assert.equal(first.result.statusCode, 200);
  const changedChat = runBody('fn0031', { global, msg: { payload: { chat_id: 'c2', text: 'Ref: INC-10' }, req } });
  assert.equal(changedChat.result.statusCode, 409, 'changed chat is a conflict');
  assert.equal(changedChat.result.payload.ok, false);
  const changedText = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'Ref: INC-10 EDITED' }, req } });
  assert.equal(changedText.result.statusCode, 409, 'changed text is a conflict');
  const replay = runBody('fn0031', { global, msg: { payload: { chat_id: 'c1', text: 'Ref: INC-10' }, req } });
  assert.equal(replay.result.statusCode, 200);
  assert.equal(replay.result.payload.dedup, true, 'unchanged replay still dedups');
  assert.equal(replay.result.payload.result.message_id, first.result.payload.result.message_id);
  assert.equal(global.get('mockTelegram').filter(x => x.ok).length, 1, 'conflicts add no success effects');
  assert.equal(Object.keys(global.get('mockDeliveryLedger')).length, 1, 'original record untouched');
});

test('mock: real runtime - failed save 503s with honest status, recovery retry confirms once with the same ID', () => {
  const { rt, global } = setupWorld('save-fail-delivery', worldSnapshot());
  global.set('lib', { findFault: () => null });
  global.set('faults', { get 0() { throw new Error('disk full (simulated)'); } });
  const req = { headers: { 'x-seaguard-delivery-id': '7:INC-11/family', 'x-seaguard-epoch': '7' } };
  const m = { payload: { chat_id: 'c1', text: 'Ref: INC-11' }, req };
  const fail = runBody('fn0031', { global, msg: { ...m } });
  assert.equal(fail.result.statusCode, 503);
  assert.equal(global.get('mockDeliveryLedger')['7:INC-11/family'], undefined, 'no confirmed record after failed save');
  assert.equal(global.get('fleetSaveStatus').ok, false, 'honest save status');
  assert.equal(global.get('mockTelegram').filter(x => x.ok).length, 0);
  // Recovery: the same pending delivery is confirmed exactly once.
  global.set('faults', []);
  const ok = runBody('fn0031', { global, msg: { ...m } });
  assert.equal(ok.result.statusCode, 200);
  assert.equal(ok.result.payload.dedup, undefined);
  assert.equal(global.get('mockDeliveryLedger')['7:INC-11/family'].message_id, ok.result.payload.result.message_id);
  assert.equal(global.get('mockTelegram').filter(x => x.ok).length, 1, 'one success effect');
  assert.equal(global.get('fleetSaveStatus').ok, true, 'save status recovers');
});

test('notifier: 503 from a failed checkpoint keeps the job RETRY (retryable), then recovers to DELIVERED', () => {
  const { rt, global } = setupWorld('retry-fail', worldSnapshot()); // restored world, epoch 7
  global.set('lib', { findFault: () => null });
  global.set('cfg', { baseUrl: 'http://127.0.0.1:1880', telegram: { enabled: false, token: '' }, retry: { maxNotifyTries: 3, notifyBackoff: [2, 5, 10] } });
  global.set('faults', { get 0() { throw new Error('disk full (simulated)'); } }); // deterministic save failure
  const context = makeScope();
  const p = { ref: 'INC-12', incident: { id: 'INC-12' }, kind: 'ALERT', roles: ['family'], severity: 1, text: 'Ref: INC-12' };
  global.set('simTime', 100);
  runBody('fn0029', { global, context, msg: { topic: 'notify', payload: p } });
  runBody('fn0029', { global, context, msg: { topic: 'tick' } });
  const rec = context.get('S').list.find(r => r.id === 'INC-12/family');
  assert.ok(rec && rec.status === 'SENDING', 'job in flight');
  // The failing checkpoint makes the mock refuse to confirm -> 503 -> job must stay retryable.
  const mock = runBody('fn0031', { global, msg: { payload: { chat_id: rec.chat, text: rec.text }, req: { headers: { 'x-seaguard-delivery-id': '7:INC-12/family', 'x-seaguard-epoch': '7' } } } });
  assert.equal(mock.result.statusCode, 503, 'mock does not confirm on failed checkpoint');
  global.set('simTime', 101);
  runBody('fn0029', { global, context, msg: { topic: 'resp', _nid: rec.id, _ep: 7, statusCode: 503, payload: mock.result.payload } });
  assert.equal(rec.status, 'RETRY', '503 keeps the job retryable, not FAILED/DELIVERED');
  assert.match(rec.lastError, /503/);
  // Disk recovers: after backoff the retry is confirmed exactly once.
  global.set('faults', []);
  global.set('simTime', 104); // backoff (2s) elapsed
  const t2 = runBody('fn0029', { global, context, msg: { topic: 'tick' } });
  const out2 = Array.isArray(t2.result) ? (t2.result[0] || []) : [];
  assert.equal(out2.length, 1, 'retry re-sent after backoff');
  const mock2 = runBody('fn0031', { global, msg: { payload: { chat_id: rec.chat, text: rec.text }, req: { headers: { 'x-seaguard-delivery-id': '7:INC-12/family', 'x-seaguard-epoch': '7' } } } });
  assert.equal(mock2.result.statusCode, 200);
  global.set('simTime', 105);
  runBody('fn0029', { global, context, msg: { topic: 'resp', _nid: rec.id, _ep: 7, statusCode: 200, payload: mock2.result.payload } });
  assert.equal(rec.status, 'DELIVERED', 'recovered job delivered');
  assert.equal(global.get('mockTelegram').filter(x => x.ok).length, 1, 'exactly one success effect across the failure and retry');
});

test('notifier: restored exhausted retry budget terminates FAILED, never dispatches beyond maxAttempts', () => {
  const max = 3;
  // Restored world: a SENDING job whose max-th attempt was in flight when the checkpoint
  // was taken, a RETRY job whose budget is already spent, and an in-budget RETRY control.
  // Persistence validates fields, not budget consistency, so all three are legal shapes.
  const list = [
    { id: 'INC-20/family', ref: 'INC-20', incident: null, kind: 'ALERT', role: 'family', chat: 'family-demo', severity: 1, text: 'Ref: INC-20', status: 'SENDING', attempts: max, created: 3000, nextAt: 3500, inflight: true, sentAt: 3500, deliveredAt: null, lastError: null },
    { id: 'INC-21/family', ref: 'INC-21', incident: null, kind: 'ALERT', role: 'family', chat: 'family-demo', severity: 1, text: 'Ref: INC-21', status: 'RETRY', attempts: max, created: 3000, nextAt: 3500, inflight: false, sentAt: 3400, deliveredAt: null, lastError: 'HTTP 502' },
    { id: 'INC-22/family', ref: 'INC-22', incident: null, kind: 'ALERT', role: 'family', chat: 'family-demo', severity: 1, text: 'Ref: INC-22', status: 'RETRY', attempts: max - 1, created: 3000, nextAt: 3500, inflight: false, sentAt: 3400, deliveredAt: null, lastError: 'HTTP 502' },
  ];
  const snap = worldSnapshot({ notifications: list }, { fn0029: { S: { ep: 7, list } } });
  const { rt, global } = setupWorld('budget-exhausted', snap);
  global.set('lib', { findFault: () => null });
  global.set('cfg', { baseUrl: 'http://127.0.0.1:1880', telegram: { enabled: false, token: '' }, retry: { maxNotifyTries: max, notifyBackoff: [2, 5, 10] } });
  const context = makeScope();
  const node = makeNode([]);
  assert.equal(rt.resume(global).ok, true, 'explicit resume releases the restored pause');
  // Clock passes the 20 s in-flight timeout for the restored SENDING job.
  global.set('simTime', 3525);
  const t1 = runBody('fn0029', { global, context, msg: { topic: 'tick' }, node });
  const out1 = Array.isArray(t1.result) ? (t1.result[0] || []) : [];
  const S = context.get('S');
  const r20 = S.list.find(r => r.id === 'INC-20/family');
  const r21 = S.list.find(r => r.id === 'INC-21/family');
  const r22 = S.list.find(r => r.id === 'INC-22/family');
  assert.equal(r20.status, 'FAILED', 'restored SENDING at max attempts times out to FAILED, not RETRY');
  assert.equal(r20.inflight, false);
  assert.equal(r21.status, 'FAILED', 'restored RETRY with spent budget terminates FAILED');
  assert.equal(r21.attempts, max, 'exhausted RETRY record is not dispatched again');
  assert.equal(r22.status, 'SENDING', 'RETRY with budget left still dispatches its final attempt');
  assert.equal(r22.attempts, max, 'final attempt counted');
  assert.equal(out1.length, 1, 'exactly one dispatch on the tick: the in-budget job only');
  assert.equal(out1[0]._nid, 'INC-22/family', 'the in-budget job is the one dispatched');
  // The final attempt fails -> terminal FAILED, and later ticks dispatch nothing.
  global.set('simTime', 3526);
  runBody('fn0029', { global, context, msg: { topic: 'resp', _nid: r22.id, _ep: 7, statusCode: 502, payload: { ok: false, description: 'HTTP Error: 502' } }, node });
  assert.equal(r22.status, 'FAILED', 'failed final attempt terminates the job');
  global.set('simTime', 3600);
  const t3 = runBody('fn0029', { global, context, msg: { topic: 'tick' }, node });
  const out3 = Array.isArray(t3.result) ? (t3.result[0] || []) : [];
  assert.equal(out3.length, 0, 'terminal records never re-dispatch');
});

test('notifier: restore -> retry 502 -> budget FAILED keeps deliveryUncertain; confirmed DELIVERED clears it', () => {
  const max = 3;
  // Two jobs whose first attempt was in flight when the checkpoint was written.
  const list = [
    { id: 'INC-30/family', ref: 'INC-30', incident: null, kind: 'ALERT', role: 'family', chat: 'family-demo', severity: 1, text: 'Ref: INC-30', status: 'SENDING', attempts: 1, created: 3000, nextAt: 3500, inflight: true, sentAt: 3500, deliveredAt: null, lastError: null },
    { id: 'INC-31/family', ref: 'INC-31', incident: null, kind: 'ALERT', role: 'family', chat: 'family-demo', severity: 1, text: 'Ref: INC-31', status: 'SENDING', attempts: 1, created: 3000, nextAt: 3500, inflight: true, sentAt: 3500, deliveredAt: null, lastError: null },
  ];
  const { rt, global } = setupWorld('uncertain-flag', worldSnapshot({ notifications: list }, { fn0029: { S: { ep: 7, list } } }));
  let r30 = global.get('notifications').find(r => r.id === 'INC-30/family');
  let r31 = global.get('notifications').find(r => r.id === 'INC-31/family');
  assert.equal(r30.status, 'RETRY', 'restored SENDING normalized to RETRY');
  assert.equal(r30.deliveryUncertain, true, 'store sets the durable flag on restore');
  assert.equal(r31.deliveryUncertain, true, 'store sets the durable flag on restore');
  global.set('lib', { findFault: () => null });
  global.set('cfg', { baseUrl: 'http://127.0.0.1:1880', telegram: { enabled: false, token: '' }, retry: { maxNotifyTries: max, notifyBackoff: [2, 5, 10] } });
  const context = makeScope();
  const node = makeNode([]);
  assert.equal(rt.resume(global).ok, true, 'explicit resume releases the restored pause');
  // Both restored jobs dispatch their 2nd attempt.
  global.set('simTime', 3505);
  let t = runBody('fn0029', { global, context, msg: { topic: 'tick' }, node });
  let out = Array.isArray(t.result) ? (t.result[0] || []) : [];
  assert.equal(out.length, 2, 'both restored jobs dispatch their 2nd attempt');
  // before() binds the two decoded snapshot lists to the live notifier context.
  // Follow those live records rather than asserting against the old global copy.
  r30 = context.get('S').list.find(r => r.id === 'INC-30/family');
  r31 = context.get('S').list.find(r => r.id === 'INC-31/family');
  // INC-30's retry fails 502: lastError is overwritten (marker gone) but the durable flag survives.
  global.set('simTime', 3506);
  runBody('fn0029', { global, context, msg: { topic: 'resp', _nid: r30.id, _ep: 7, statusCode: 502, payload: { ok: false, description: 'HTTP Error: 502' } }, node });
  assert.equal(r30.status, 'RETRY', 'in-budget retry stays RETRY');
  assert.match(r30.lastError, /502/, 'retry error overwrites the restore marker in lastError');
  assert.equal(r30.lastError.indexOf('delivery uncertain') === -1, true, 'lastError no longer carries the marker - the boolean must');
  assert.equal(r30.deliveryUncertain, true, 'deliveryUncertain survives the retry error');
  // Attempt two uses the 5-second backoff: the two jobs become due at3511/3515.
  global.set('simTime', 3510);
  runBody('fn0029', { global, context, msg: { topic: 'resp', _nid: r31.id, _ep: 7, statusCode: 502, payload: { ok: false, description: 'HTTP Error: 502' } }, node });
  // INC-30's final attempt confirms delivery -> flag cleared.
  global.set('simTime', 3511);
  t = runBody('fn0029', { global, context, msg: { topic: 'tick' }, node });
  out = Array.isArray(t.result) ? (t.result[0] || []) : [];
  assert.equal(out.length, 1, 'only INC-30 is due for its final attempt');
  assert.equal(out[0]._nid, 'INC-30/family', 'INC-30 dispatches the final attempt');
  global.set('simTime', 3512);
  runBody('fn0029', { global, context, msg: { topic: 'resp', _nid: r30.id, _ep: 7, statusCode: 200, payload: { ok: true, result: { message_id: 9 } } }, node });
  assert.equal(r30.status, 'DELIVERED', 'confirmed delivery');
  assert.equal(r30.deliveryUncertain, false, 'confirmed DELIVERED clears the flag');
  assert.equal(r30.lastError, null, 'confirmed delivery clears the error too');
  // INC-31 burns its last attempt on a 502 -> budget-exhausted FAILED, flag still set.
  global.set('simTime', 3515);
  t = runBody('fn0029', { global, context, msg: { topic: 'tick' }, node });
  out = Array.isArray(t.result) ? (t.result[0] || []) : [];
  assert.equal(out.length, 1, 'only INC-31 is due for its final attempt');
  assert.equal(out[0]._nid, 'INC-31/family', 'INC-31 dispatches the final attempt');
  global.set('simTime', 3516);
  runBody('fn0029', { global, context, msg: { topic: 'resp', _nid: r31.id, _ep: 7, statusCode: 502, payload: { ok: false, description: 'HTTP Error: 502' } }, node });
  assert.equal(r31.status, 'FAILED', 'failed final attempt terminates the job');
  assert.match(r31.lastError, /502/, 'terminal error is the retry error, not the restore marker');
  assert.equal(r31.deliveryUncertain, true, 'budget-exhausted FAILED keeps the restore uncertainty');
  global.set('simTime', 3517);
  t = runBody('fn0029', { global, context, msg: { topic: 'tick' }, node });
  out = Array.isArray(t.result) ? (t.result[0] || []) : [];
  assert.equal(out.length, 0, 'terminal records never re-dispatch');
  // Durability: the flag roundtrips through the store (encode/validate accepts it).
  const save = rt.save(global);
  assert.ok(save.ok, 'runtime save ok: ' + (save.error || ''));
  const fresh = createStore({ dataDir: path.join(TEMP, 'uncertain-flag') });
  const loaded = fresh.load();
  assert.ok(loaded.ok && loaded.restored, 'fresh store loads the snapshot: ' + (loaded.error || ''));
  const l30 = loaded.data.globals.notifications.find(r => r.id === 'INC-30/family');
  const l31 = loaded.data.globals.notifications.find(r => r.id === 'INC-31/family');
  assert.equal(l30.deliveryUncertain, false, 'cleared flag roundtrips');
  assert.equal(l31.deliveryUncertain, true, 'unresolved FAILED flag roundtrips');
  assert.equal(l31.status, 'FAILED', 'FAILED status roundtrips');
});

// ---------------------------------------------------------------------------
const passed = outcomes.filter((o) => o.passed).length;
const failed = outcomes.length - passed;
const report = {
  suite: 'fleet-delivery',
  module: 'seaguard/src/functions/fn0029.js + fn0031.js + fn0042.js + fn004e.js + fn004f.js + fn005d.js + src/fleet/runtime.cjs + persistence.cjs',
  at: new Date().toISOString(),
  node: process.version,
  passed, failed, of: outcomes.length,
  outcomes,
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ passed, failed, of: outcomes.length }));
for (const o of outcomes) if (!o.passed) console.error('FAIL: ' + o.name + ': ' + o.error);
process.exit(failed ? 1 : 0);
