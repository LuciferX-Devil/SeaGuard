// Focused offline tests for the SeaGuard fleet persistence RUNTIME adapter
// (seaguard/src/fleet/runtime.cjs). No Node-RED, no services:
//     node seaguard/tests/fleet-runtime.mjs
// Contexts and globals are Map-backed get/set fixtures, so the adapter is exercised
// exactly the way the injected before/after hooks will call it. Scratch snapshots go
// to the fleet-dedicated seaguard/tests/fixtures/fleet-runtime directory only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import store from '../src/fleet/persistence.cjs';
import runtimeMod from '../src/fleet/runtime.cjs';
const { createRuntime } = runtimeMod;

const { createStore, rng, ALLOWLIST } = store;
const here = path.dirname(fileURLToPath(import.meta.url));
const TEMP = path.join(here, 'fixtures', 'fleet-runtime');
const reportPath = path.join(here, '..', 'reports', 'fleet-runtime.json');

// The recursive cleanup below may only touch the fleet scratch dir: verify it
// resolves inside the project root before deleting anything.
const PROJECT_ROOT = path.resolve(here, '..', '..');
const tempRel = path.relative(PROJECT_ROOT, TEMP);
assert.ok(tempRel && !tempRel.startsWith('..') && !path.isAbsolute(tempRel),
  'fleet-runtime scratch dir escapes the project root: ' + TEMP);
fs.rmSync(TEMP, { recursive: true, force: true });
fs.mkdirSync(TEMP, { recursive: true });

const outcomes = [];
function test(name, fn) {
  try { fn(); outcomes.push({ name, passed: true }); }
  catch (e) { outcomes.push({ name, passed: false, error: e.message }); }
}

// --- Map-backed get/set fixtures (stand-ins for Node-RED context / global context) ---
function makeScope() {
  const m = new Map();
  return { map: m, get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } };
}

// Real Node-RED mqtt-in connection-status message shapes.
const mqttOn = () => ({ topic: 'mqttStatus', status: { text: 'node-red:common.status.connected' } });
const mqttOff = () => ({ topic: 'mqttStatus', status: { text: 'node-red:common.status.disconnected' } });

// A valid live-shaped world snapshot (real record shapes, see fleet-persistence.mjs).
function worldSnapshot(over = {}) {
  const notifications = [
    { id: 'INC-1/family', ref: 'INC-1', incident: 'INC-1', kind: 'CAPSIZE', role: 'family', chat: 'family-demo', severity: 3, text: 'b1', status: 'DELIVERED', attempts: 1, created: 90, nextAt: 90, sentAt: 100, inflight: false, deliveredAt: 101, lastError: null },
    { id: 'INC-2/coastguard', ref: 'INC-2', incident: 'INC-2', kind: 'FLOOD', role: 'coastguard', chat: 'coastguard-demo', severity: 2, text: 'b2', status: 'QUEUED', attempts: 0, created: 3600, nextAt: 3600, inflight: false, deliveredAt: null, lastError: null }
  ];
  return {
    globals: Object.assign({
      epoch: 7, simTime: 3600, simSpeed: 2, simRunning: true, mode: 'test', runSeed: 1234,
      notifications, syncStore: { b1: { count: 2, maxContig: 2, dupRecords: 0, batches: 1, firstT: 10, lastT: 20, recs: { 1: { t: 10, lat: 1.5, lon: 2.5 }, 2: { t: 20, lat: 1.6, lon: 2.6 } } } },
      fleet: { b1: { id: 'b1', name: 'Boat 1' } }, incidents: [{ id: 'INC-1', kind: 'CAPSIZE', boat: 'b1', opened: 90, lastEventT: 90, events: [{ t: 90, type: 'CAPSIZE', source: 'shore', eid: null, data: {} }], status: 'OPEN' }]
    }, over.globals || {}),
    nodes: Object.assign({
      fn0006: { S: { ep: 7, boats: { b1: { id: 'b1', seq: 5, pending: { eid: 'e1', pkt: { t: 1, lat: 1, lon: 1 }, tries: 1, firstAt: 100, nextAt: 200 }, log: [], logSeq: 5, stats: { sent: 3, failed: 0 } } } } },
      fn0010: { G: { connected: true, forcedDown: false, ep: 7, buffer: [{ t: 3500, b: 'b1', d: 'x' }], stats: { up: 9 }, lastHb: 3590 } },
      fn0018: { S: { ep: 7, queued: [{ t: 3550, to: 'b1', text: 'saved-downlink' }] } },
      fn0029: { S: { ep: 7, list: notifications, nextTestId: 3 } }
    }, over.nodes || {}),
  };
}

function seedDir(name, snap) {
  const dir = path.join(TEMP, name);
  const st = createStore({ dataDir: dir });
  const res = st.save(snap);
  assert.ok(res.ok, 'seed save failed: ' + res.error);
  return dir;
}

function readDoc(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'fleet.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
test('initialize: one-shot load, restored world paused with frozen clock', () => {
  const dir = seedDir('oneshot', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  const first = rt.initialize(global);
  assert.equal(first.ok, true);
  assert.equal(first.restored, true);
  assert.equal(global.get('epoch'), 7);
  assert.equal(global.get('simTime'), 3600);
  assert.equal(global.get('simRunning'), false, 'restored world must be paused');
  const status = global.get('fleetSaveStatus');
  assert.equal(status.ok, true);
  assert.equal(status.restored, true);
  // One-shot: a second initialize must not reload or re-apply.
  const before2 = global.get('simTime');
  const second = rt.initialize(global);
  assert.equal(second.already, true);
  assert.equal(global.get('simTime'), before2);
  assert.equal(rt.status().restored, true);
  assert.equal(rt.status().pausedHold, true);
});

test('initialize: missing store allows a fresh world; saves work', () => {
  const dir = path.join(TEMP, 'fresh');
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  const res = rt.initialize(global);
  assert.equal(res.ok, true);
  assert.equal(res.restored, false);
  assert.equal(rt.status().blocked, false);
  global.set('epoch', 1);
  global.set('simTime', 0);
  global.set('simSpeed', 1);
  global.set('simRunning', true);
  global.set('mode', 'test');
  global.set('runSeed', 42);
  const save = rt.save(global);
  assert.equal(save.ok, true, 'fresh-world save failed: ' + (save.error || ''));
  assert.equal(readDoc(dir).globals.epoch, 1);
});

test('before(): hydrates saved allowlisted context before the body', () => {
  const dir = seedDir('hydrate', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  const ctx6 = makeScope();
  const go = rt.before('fn0006', ctx6, global, null);
  assert.equal(go, true);
  const S = ctx6.get('S');
  assert.ok(S && typeof S === 'object', 'saved fn0006.S must be hydrated');
  assert.equal(S.ep, 7);
  assert.equal(S.boats.b1.seq, 5);
  assert.deepEqual(S.boats.b1.pending, { eid: 'e1', pkt: { t: 1, lat: 1, lon: 1 }, tries: 1, firstAt: 100, nextAt: 200 });
  // Body mutates the hydrated context; after() captures the live ref.
  S.boats.b1.seq = 6;
  rt.after('fn0006', ctx6, global, null);
  assert.equal(rt._rt.contexts.get('fn0006').S, S, 'after() must capture the live ref');
});

test('unvisited saved contexts are preserved and hydrated on first visit', () => {
  const dir = seedDir('unvisited', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  // fn0018 has a saved context but has not run yet. Visiting fn0006 must not drop it.
  const ctx6 = makeScope();
  rt.before('fn0006', ctx6, global, null);
  rt.after('fn0006', ctx6, global, null);
  assert.ok(rt._rt.contexts.has('fn0018'), 'unvisited fn0018 cache entry must survive');
  // A save in the meantime must still persist the unvisited context.
  const save = rt.save(global);
  assert.equal(save.ok, true, 'save failed: ' + (save.error || ''));
  const doc = readDoc(dir);
  assert.deepEqual(doc.nodes.fn0018.S, { ep: 7, queued: [{ t: 3550, to: 'b1', text: 'saved-downlink' }] });
  // First visit to fn0018: it is a transport node now held during the restored
  // pause, so before() returns false (body suppressed) BUT the saved context is
  // still hydrated before the hold check.
  const ctx18 = makeScope();
  assert.equal(rt.before('fn0018', ctx18, global, null), false, 'downlink held during restored pause');
  assert.equal(ctx18.get('S').queued[0].text, 'saved-downlink', 'saved context still hydrated while held');
});

test('notifier alias: global notifications is the SAME array as fn0029 S.list', () => {
  const dir = seedDir('alias', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  const ctx29 = makeScope();
  rt.before('fn0029', ctx29, global, null);
  const S = ctx29.get('S');
  assert.ok(Array.isArray(S.list), 'hydrated notifier S.list');
  assert.equal(global.get('notifications'), S.list, 'global list must be aliased to S.list');
  // Body replaces S with a new list; after() must re-alias so both copies agree.
  const newList = [{ id: 'INC-9/family', ref: 'INC-9', incident: 'INC-9', kind: 'MOM', role: 'family', chat: 'family-demo', severity: 1, text: 'new', status: 'QUEUED', attempts: 0, created: 3700, nextAt: 3700, inflight: false, deliveredAt: null, lastError: null }];
  ctx29.set('S', { ep: 7, list: newList, nextTestId: 4 });
  rt.after('fn0029', ctx29, global, null);
  assert.equal(global.get('notifications'), newList, 'after() must re-bind global to the new S.list');
  const save = rt.save(global);
  assert.equal(save.ok, true, 'aliased save failed: ' + (save.error || ''));
  assert.equal(save.bytes > 0, true);
});

test('paused startup: MQTT/tick bodies suppressed, saved buffer unchanged, clock frozen', () => {
  const dir = seedDir('paused-start', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  const ctx10 = makeScope();
  // Gateway connection-status message arrives while the restored world is paused:
  // the body (which would flush the saved uplink buffer) must be skipped.
  assert.equal(rt.before('fn0010', ctx10, global, mqttOn()), false, 'gateway body must be held');
  // Hydration still ran (saved G present), but the body's flush logic never did:
  // the saved uplink buffer is intact and the tracked state is only ephemeral.
  assert.ok(ctx10.get('G'), 'saved G must be hydrated even while held');
  assert.equal(ctx10.get('G').buffer.length, 1, 'saved buffer must not be flushed by a held body');
  assert.equal(rt._rt.ephemeralMqtt, 'online');
  // Publisher is presentation only: it must KEEP running so a fresh browser can
  // render the paused UI and the resume button.
  const ctx4e = makeScope();
  assert.equal(rt.before('fn004e', ctx4e, global, { payload: 'tick' }), true, 'publisher body must run while restored-paused');
  // Saved buffer and clock are untouched.
  assert.equal(global.get('simTime'), 3600, 'clock must stay frozen during the hold');
  const save = rt.save(global);
  assert.equal(save.ok, true);
  assert.deepEqual(readDoc(dir).nodes.fn0010.G.buffer, [{ t: 3500, b: 'b1', d: 'x' }], 'saved buffer must be unchanged');
});

test('explicit resume: releases hold, applies tracked MQTT connection, no clock advance', () => {
  const dir = seedDir('resume', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  const ctx10 = makeScope();
  rt.before('fn0010', ctx10, global, mqttOn()); // held
  // Real connection dropped while paused: tracked ephemerally, body still held.
  assert.equal(rt.before('fn0010', ctx10, global, mqttOff()), false);
  assert.equal(rt._rt.ephemeralMqtt, 'offline', 'actual connection state must be tracked ephemerally');
  // Non-status messages carry no tracking and stay held.
  assert.equal(rt.before('fn0010', ctx10, global, { payload: 'downlink-for-b1' }), false);
  const frozen = global.get('simTime');
  const res = rt.resume(global);
  assert.equal(res.ok, true);
  assert.equal(res.resumedFromHold, true);
  assert.equal(global.get('simRunning'), true, 'resume must set simRunning');
  assert.equal(global.get('simTime'), frozen, 'resume must NOT advance the clock');
  assert.equal(rt._rt.pausedHold, false);
  // The tracked real connection is applied to the live gateway context.
  const G = ctx10.get('G');
  assert.ok(G, 'hydrated G present for resume apply');
  assert.equal(G.connected, false, 'tracked offline state must be applied');
  // After resume the gateway body runs normally again.
  assert.equal(rt.before('fn0010', ctx10, global, mqttOn()), true, 'hold released: body runs');
});

test('ordinary pause (fn003a) never sets the hold: in-flight responses still accepted', () => {
  const dir = path.join(TEMP, 'ordinary-pause');
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  const res = rt.initialize(global); // missing store -> fresh world, no hold
  assert.equal(res.restored, false);
  global.set('epoch', 1); global.set('simTime', 100); global.set('simSpeed', 1);
  global.set('simRunning', true); global.set('mode', 'test'); global.set('runSeed', 1);
  // Operator pauses a RUNNING session via fn003a.
  const ctx3a = makeScope();
  assert.equal(rt.before('fn003a', ctx3a, global, { payload: { cmd: 'pause' } }), true);
  global.set('simRunning', false); // what the body would do
  rt.after('fn003a', ctx3a, global, { payload: { cmd: 'pause' } });
  assert.equal(rt._rt.pausedHold, false, 'ordinary pause must not create a restored hold');
  // In-flight responses and operational bodies keep being accepted while paused.
  const ctx10 = makeScope();
  assert.equal(rt.before('fn0010', ctx10, global, mqttOn()), true, 'gateway body must run under ordinary pause');
  const ctx4e = makeScope();
  assert.equal(rt.before('fn004e', ctx4e, global, { payload: 'tick' }), true, 'publisher body must run under ordinary pause');
  // ...and the pause itself triggered an immediate save.
  const st = global.get('fleetSaveStatus');
  assert.equal(st.ok, true);
  assert.equal(st.reason, 'immediate');
});

test('corrupt snapshot blocks bootstrap and autosave, file left untouched', () => {
  const dir = path.join(TEMP, 'corrupt');
  fs.mkdirSync(dir, { recursive: true });
  const corrupt = '{ this is not a valid fleet snapshot';
  fs.writeFileSync(path.join(dir, 'fleet.json'), corrupt, 'utf8');
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  const res = rt.initialize(global);
  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
  assert.ok(res.error && res.error.length > 0, 'visible error required');
  const st = global.get('fleetSaveStatus');
  assert.equal(st.ok, false, 'fleetSaveStatus must surface the block visibly');
  assert.ok(st.error, 'fleetSaveStatus.error required');
  // Bootstrap blocked: no fleet body may run.
  const ctx6 = makeScope();
  assert.equal(rt.before('fn0006', ctx6, global, null), false, 'bootstrap must be blocked');
  // Autosave blocked: the corrupt file must never be overwritten.
  global.set('epoch', 99); global.set('simTime', 1); global.set('simRunning', false);
  global.set('simSpeed', 1); global.set('mode', 'test'); global.set('runSeed', 0);
  const save = rt.save(global);
  assert.equal(save.ok, false);
  assert.equal(save.blocked, true);
  assert.equal(fs.readFileSync(path.join(dir, 'fleet.json'), 'utf8'), corrupt, 'corrupt file must be untouched');
  assert.equal(rt.status().blocked, true);
  assert.ok(rt.status().error);
});

test('save error keeps live refs and state intact; status surfaced', () => {
  const dir = seedDir('save-error', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  const ctx6 = makeScope();
  rt.before('fn0006', ctx6, global, null);
  const S = ctx6.get('S');
  const goodSave = rt.save(global);
  assert.equal(goodSave.ok, true);
  // Inject a save fault: make the primary path a directory so the atomic write cannot proceed.
  fs.rmSync(path.join(dir, 'fleet.json'));
  fs.mkdirSync(path.join(dir, 'fleet.json'));
  S.boats.b1.seq = 42; // live mutation while saves are failing
  const badSave = rt.save(global);
  assert.equal(badSave.ok, false, 'save must fail against the blocked path');
  assert.ok(badSave.error, 'save error must be reported');
  const st = global.get('fleetSaveStatus');
  assert.equal(st.ok, false, 'fleetSaveStatus must surface the failure');
  assert.ok(st.error);
  // Live state untouched by the failed save: refs and values intact.
  assert.equal(rt._rt.contexts.get('fn0006').S, S, 'live ref must be retained');
  assert.equal(S.boats.b1.seq, 42);
  assert.equal(global.get('simTime'), 3600);
  assert.equal(rt._rt.saves, 1, 'failed save must not count as a save');
  // Recovery: fix the path, the next save succeeds with the live values.
  fs.rmdirSync(path.join(dir, 'fleet.json'));
  const okSave = rt.save(global);
  assert.equal(okSave.ok, true, 'recovered save failed: ' + (okSave.error || ''));
  assert.equal(readDoc(dir).nodes.fn0006.S.boats.b1.seq, 42, 'recovered save must carry live values');
  assert.equal(global.get('fleetSaveStatus').ok, true);
});

test('newWorld: releases the hold and clears the saved context cache', () => {
  const dir = seedDir('newworld', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  assert.equal(rt._rt.pausedHold, true);
  rt.newWorld(global);
  assert.equal(rt._rt.pausedHold, false, 'newWorld must release the pause hold');
  assert.equal(rt._rt.contexts.size, 0, 'newWorld must clear the saved context cache');
  // Fresh nodes hydrate nothing; old saved contexts are not resurrected.
  const ctx6 = makeScope();
  assert.equal(rt.before('fn0006', ctx6, global, null), true);
  assert.equal(ctx6.get('S'), undefined, 'stale saved fn0006.S must not be hydrated');
  ctx6.set('S', { ep: 8, boats: {} }); // body starts fresh
  rt.after('fn0006', ctx6, global, null);
  const save = rt.save(global);
  assert.equal(save.ok, true, 'post-newWorld save failed: ' + (save.error || ''));
  const doc = readDoc(dir);
  assert.equal(doc.nodes.fn0006.S.ep, 8);
  assert.ok(!doc.nodes.fn0018, 'cleared unvisited context must not be persisted');
});

test('save cadence: periodic on fn004e, immediate on fn0029/fn002e/fn0031 and fn003a stop/pause', () => {
  const dir = path.join(TEMP, 'cadence');
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  global.set('epoch', 1); global.set('simTime', 0); global.set('simSpeed', 1);
  global.set('simRunning', true); global.set('mode', 'test'); global.set('runSeed', 1);
  global.set('notifications', []);
  const saves = [];
  const run = (id, msg) => {
    const n0 = rt._rt.saves;
    const c = makeScope();
    rt.before(id, c, global, msg);
    rt.after(id, c, global, msg);
    if (rt._rt.saves > n0) saves.push(global.get('fleetSaveStatus').reason);
  };
  run('fn004e', { payload: 'tick' });
  run('fn0029', { payload: 'send' });
  run('fn002e', { payload: 'sync' });
  run('fn0031', { payload: 'ledger' });
  run('fn003a', { payload: { cmd: 'pause' } });
  run('fn003a', { payload: { cmd: 'stop' } });
  run('fn003a', { payload: { cmd: 'run' } }); // run: no save
  run('fn0006', null);               // non-trigger node: no save
  assert.deepEqual(saves, ['periodic', 'immediate', 'immediate', 'immediate', 'immediate', 'immediate'],
    'unexpected save cadence: ' + JSON.stringify(saves));
  assert.equal(rt._rt.saves, 6);
  for (const s of saves) assert.equal(s === 'periodic' || s === 'immediate', true);
});

test('capture is allowlist-only: cfg/lib/timers/secrets never persisted', () => {
  const dir = path.join(TEMP, 'allowlist-only');
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  global.set('epoch', 1); global.set('simTime', 0); global.set('simSpeed', 1);
  global.set('simRunning', true); global.set('mode', 'test'); global.set('runSeed', 1);
  global.set('cfg', { apiKey: 'SECRET-DO-NOT-PERSIST' });
  global.set('lib', { rng });
  global.set('timerHandle', { ref: 'setInterval-handle' });
  const ctx6 = makeScope();
  assert.equal(rt.before('fn0006', ctx6, global, null), true);
  ctx6.set('S', { ep: 1, boats: {} });
  ctx6.set('timer', { handle: 'node-timer' }); // non-allowlisted context key
  rt.after('fn0006', ctx6, global, null);
  const save = rt.save(global);
  assert.equal(save.ok, true, 'save failed: ' + (save.error || ''));
  const doc = readDoc(dir);
  const text = JSON.stringify(doc);
  assert.ok(!text.includes('SECRET-DO-NOT-PERSIST'), 'secrets must not be persisted');
  assert.ok(!('cfg' in doc.globals) && !('lib' in doc.globals) && !('timerHandle' in doc.globals));
  assert.deepEqual(Object.keys(doc.globals).every((k) => ALLOWLIST.globals.includes(k)), true);
  assert.deepEqual(Object.keys(doc.nodes.fn0006), ['S'], 'only allowlisted context keys captured');
  assert.ok(!text.includes('node-timer'), 'timer handles must not be persisted');
});

test('rng is exposed and resumable from a snapshot state', () => {
  const rt = createRuntime({ dataDir: path.join(TEMP, 'rng') });
  assert.equal(typeof rt.rng, 'function');
  const a = rt.rng(99);
  const b = rt.rng(99);
  assert.equal(a(), b());
  a(); a(); // advance a few draws
  const snap = a.snapshot();
  const cont = rt.rng(99, snap); // resumed stream continues exactly where a left off
  assert.equal(cont(), a());
  assert.equal(cont(), a());
  assert.throws(() => rt.rng(99, { __tag: 'seaguard.mulberry32.v1', state: 1.5 }), /uint32/);
});

test('status(): reflects restore, hold, saves and errors', () => {
  const dir = seedDir('status', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const s0 = rt.status();
  assert.equal(s0.initialized, false);
  const global = makeScope();
  rt.initialize(global);
  const s1 = rt.status();
  assert.equal(s1.initialized, true);
  assert.equal(s1.restored, true);
  assert.equal(s1.pausedHold, true);
  assert.equal(s1.saves, 0);
  assert.equal(s1.error, null);
  const save = rt.save(global);
  assert.equal(save.ok, true);
  const s2 = rt.status();
  assert.equal(s2.saves, 1);
  assert.ok(s2.lastSave && s2.lastSave.bytes > 0);
});

test('before/after/save reject or no-op until initialize', () => {
  const dir = path.join(TEMP, 'uninit');
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  const ctx = makeScope();
  assert.equal(rt.before('fn0007', ctx, global, null), false, 'before must reject until initialized');
  rt.after('fn0007', ctx, global, null); // must be a no-op
  assert.equal(rt._rt.saves, 0, 'after must not save before initialize');
  const s = rt.save(global);
  assert.equal(s.ok, false, 'manual save must reject before initialize');
  assert.match(s.error, /not initialized/);
  assert.equal(global.get('fleetSaveStatus'), undefined, 'no save status written before initialize');
  // After initialize, the same calls work normally.
  const res = rt.initialize(global);
  assert.equal(res.ok, true);
  assert.equal(rt.before('fn0007', ctx, global, null), true);
  assert.equal(rt.save(global).ok, true);
});

test('publisher is presentation only: not held on restored pause, gateway is', () => {
  const dir = seedDir('pub-held', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  const ctx4e = makeScope();
  assert.equal(rt.before('fn004e', ctx4e, global, { payload: 'tick' }), true, 'publisher body must run so a fresh browser renders the paused UI');
  const ctx10 = makeScope();
  assert.equal(rt.before('fn0010', ctx10, global, mqttOn()), false, 'gateway body must still be held');
  assert.equal(rt._rt.pausedHold, true, 'hold remains until explicit resume');
});

test('mqttStatus message format: connected/disconnected tracked, non-status ignored', () => {
  const dir = seedDir('mqtt-fmt', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  const ctx10 = makeScope();
  assert.equal(rt.before('fn0010', ctx10, global, mqttOn()), false);
  assert.equal(rt._rt.ephemeralMqtt, 'online');
  assert.equal(rt.before('fn0010', ctx10, global, mqttOff()), false);
  assert.equal(rt._rt.ephemeralMqtt, 'offline');
  // Non-status messages must not change the tracked state.
  assert.equal(rt.before('fn0010', ctx10, global, { payload: 'downlink-for-b1' }), false);
  assert.equal(rt._rt.ephemeralMqtt, 'offline');
  assert.equal(rt.before('fn0010', ctx10, global, { topic: 'other', payload: 'online' }), false);
  assert.equal(rt._rt.ephemeralMqtt, 'offline');
});

test('tracked connection applies only after explicit resume, never during repeated before while held', () => {
  const dir = seedDir('mqtt-apply', worldSnapshot()); // saved G.connected = true
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  const ctx10 = makeScope();
  // Repeated held before calls: tracked state must NOT be written to the live G.
  assert.equal(rt.before('fn0010', ctx10, global, mqttOn()), false);
  assert.equal(ctx10.get('G').connected, true, 'hydrated value untouched while held');
  assert.equal(rt.before('fn0010', ctx10, global, mqttOff()), false);
  assert.equal(ctx10.get('G').connected, true, 'still untouched on the next held call');
  assert.equal(rt._rt.ephemeralMqtt, 'offline');
  // Explicit resume is the ONLY moment the tracked state is applied.
  const res = rt.resume(global);
  assert.equal(res.ok, true);
  assert.equal(ctx10.get('G').connected, false, 'tracked offline applied at resume');
  assert.equal(rt._rt.ephemeralMqtt, null, 'tracked state consumed');
});

test('clock control payload.cmd: stop/pause save immediately, run does not', () => {
  const dir = path.join(TEMP, 'cmd-shape');
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  global.set('epoch', 1); global.set('simTime', 5); global.set('simSpeed', 1);
  global.set('simRunning', true); global.set('mode', 'test'); global.set('runSeed', 1);
  const ctx3a = makeScope();
  const run = (msg) => {
    const n0 = rt._rt.saves;
    rt.before('fn003a', ctx3a, global, msg);
    rt.after('fn003a', ctx3a, global, msg);
    return rt._rt.saves - n0;
  };
  assert.equal(run({ payload: { cmd: 'stop' } }), 1, 'payload.cmd stop must save immediately');
  assert.equal(run({ payload: { cmd: 'pause' } }), 1, 'payload.cmd pause must save immediately');
  assert.equal(run({ payload: { cmd: 'run' } }), 0, 'payload.cmd run must not save');
  assert.equal(global.get('fleetSaveStatus').reason, 'immediate');
});

test('newWorld clears the store block: corrupt-store recovery is not permanently stuck', () => {
  const dir = path.join(TEMP, 'recovery');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fleet.json'), '{"format":"seaguard.fleet","version":1,"savedAt":1,"globals":{"epoch":-5},"nodes":{}}', 'utf8');
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  const init = rt.initialize(global);
  assert.equal(init.ok, false);
  assert.equal(init.blocked, true);
  assert.equal(rt.before('fn004e', makeScope(), global, null), true, 'publisher (presentation) passes through while blocked');
  const nw = rt.newWorld(global);
  assert.equal(nw.ok, true);
  const st = rt.status();
  assert.equal(st.blocked, false, 'storeBlocked must be cleared');
  assert.equal(st.restored, false, 'restored flag must be cleared');
  assert.equal(st.error, null, 'lastError must be cleared');
  assert.equal(rt.before('fn004e', makeScope(), global, null), true, 'bodies run after reset');
  assert.equal(rt.save(global).ok, true, 'saves work again after reset');
  assert.equal(global.get('fleetSaveStatus').ok, true);
});

test('transport/monitor context nodes held on restored pause (fn0020 gateway monitor: no new incidents before resume)', () => {
  // Seed a saved gateway-monitor context so hydration is observable while held.
  const dir = seedDir('transport-held', worldSnapshot({ nodes: { fn0020: { M: { online: true, lastHb: 3590, reason: null } } } }));
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  rt.initialize(global);
  // Every transport/monitor context node is held while the restored world is paused.
  for (const id of ['fn0010', 'fn0011', 'fn0018', 'fn001b', 'fn001d', 'fn0020']) {
    const ctx = makeScope();
    assert.equal(rt.before(id, ctx, global, mqttOn()), false, id + ' body must be held during restored pause');
  }
  // The gateway monitor (fn0020) in particular: a retained birth/status arriving while
  // paused must NOT run its body (which would raise a new incident) before resume.
  // Its saved context is still hydrated, and the clock stays frozen.
  const ctx20 = makeScope();
  assert.equal(rt.before('fn0020', ctx20, global, mqttOn()), false, 'fn0020 held');
  assert.ok(ctx20.get('M'), 'fn0020 saved M must be hydrated even while held');
  assert.equal(global.get('simTime'), 3600, 'clock must stay frozen while transport/monitor held');
  // Publisher + control nodes are NOT held: presentation and operator control keep working.
  assert.equal(rt.before('fn004e', makeScope(), global, { payload: 'tick' }), true, 'publisher runs');
  assert.equal(rt.before('fn003a', makeScope(), global, { payload: { cmd: 'run' } }), true, 'run control runs');
  // After explicit resume the held transport/monitor bodies run again.
  const res = rt.resume(global);
  assert.equal(res.ok, true);
  assert.equal(rt.before('fn0020', ctx20, global, mqttOn()), true, 'fn0020 body runs after resume');
});

test('operator reset path (fn003e) passes through a blocked adapter; other nodes stay blocked', () => {
  const dir = path.join(TEMP, 'reset-through-blocked');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fleet.json'), '{"format":"seaguard.fleet","version":1,"savedAt":1,"globals":{"epoch":-5},"nodes":{}}', 'utf8');
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  const init = rt.initialize(global);
  assert.equal(init.blocked, true);
  // While blocked: the reset path is allowed through, everything else is held.
  assert.equal(rt.before('fn003e', makeScope(), global, null), true, 'reset path must pass through a blocked adapter');
  assert.equal(rt.before('fn0010', makeScope(), global, mqttOn()), false, 'operational node stays blocked');
  assert.equal(rt.before('fn004e', makeScope(), global, { payload: 'tick' }), true, 'publisher (presentation) passes through while blocked');
  // The operator invokes the reset (what fn003e's body calls): the adapter recovers.
  const nw = rt.newWorld(global);
  assert.equal(nw.ok, true);
  assert.equal(rt.status().blocked, false, 'adapter unblocked after reset');
  assert.equal(rt.before('fn004e', makeScope(), global, { payload: 'tick' }), true, 'publisher runs after reset');
  assert.equal(rt.save(global).ok, true, 'saves work after reset');
});

// ---------------------------------------------------------------------------
const passed = outcomes.filter((o) => o.passed).length;
const failed = outcomes.length - passed;
const report = {
  suite: 'fleet-runtime',
  module: 'seaguard/src/fleet/runtime.cjs',
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
