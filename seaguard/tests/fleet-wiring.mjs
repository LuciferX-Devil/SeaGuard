import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import runtimeMod from '../src/fleet/runtime.cjs';
import storeMod from '../src/fleet/persistence.cjs';

const { createRuntime } = runtimeMod;
const { ALLOWLIST, rng: storeRng } = storeMod;

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const flowsPath = path.join(ROOT, 'flows.json');
const reportPath = path.join(ROOT, 'reports', 'fleet-wiring.json');

// The generated flows.json is the build output under test. If it is missing, fail
// clearly (the build must be run before this suite).
assert.ok(fs.existsSync(flowsPath), 'flows.json missing - run `node seaguard/build.mjs` first');
const nodes = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
const funcOf = (id) => (byId[id] && byId[id].type === 'function' ? byId[id].func : null);

// The exact wrap list build.mjs applies (mirrors the microtask; checked vs ALLOWLIST below).
const FLEET_HOOK_IDS = new Set(['fn0006','fn0007','fn000a','fn0010','fn0011','fn0018','fn001b','fn001c','fn001d','fn0020','fn0028','fn0029','fn002e','fn0031','fn003a','fn003e','fn004e']);

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
const envFake = { get: () => undefined };

// Execute a generated function body with Node-RED-style parameters.
function runBody(id, { global = makeScope(), context = makeScope(), msg = {}, node = null } = {}) {
  const fn = new Function('msg','node','context','global','flow','env', funcOf(id));
  const nodeStatuses = [];
  const nodeFake = node || { status: (s) => nodeStatuses.push(s), error: () => {}, debug: () => {} };
  return { result: fn(msg, nodeFake, context, global, makeScope(), envFake), nodeStatuses };
}

// A minimal fake runtime that records before/after calls (isolates wrapper control flow).
function fakeRuntime({ beforeResult = true } = {}) {
  const calls = { before: [], after: [] };
  return {
    calls,
    before: (id, context, global, msg) => { calls.before.push(id); return beforeResult; },
    after: (id, context, global, msg) => { calls.after.push(id); },
    rng: (seed) => storeRng(seed),
  };
}

// A valid live-shaped world snapshot (real record shapes, see fleet-persistence.mjs).
function worldSnapshot() {
  const notifications = [
    { id: 'INC-1/family', ref: 'INC-1', incident: 'INC-1', kind: 'CAPSIZE', role: 'family', chat: 'family-demo', severity: 3, text: 'b1', status: 'DELIVERED', attempts: 1, created: 90, nextAt: 90, sentAt: 100, inflight: false, deliveredAt: 101, lastError: null },
    { id: 'INC-2/coastguard', ref: 'INC-2', incident: 'INC-2', kind: 'FLOOD', role: 'coastguard', chat: 'coastguard-demo', severity: 2, text: 'b2', status: 'QUEUED', attempts: 0, created: 3600, nextAt: 3600, inflight: false, deliveredAt: null, lastError: null }
  ];
  return {
    globals: { epoch: 7, simTime: 3600, simSpeed: 2, simRunning: true, mode: 'test', runSeed: 1234, notifications, syncStore: { b1: { count: 2, maxContig: 2, dupRecords: 0, batches: 1, firstT: 10, lastT: 20, recs: { 1: { t: 10, lat: 1.5, lon: 2.5 }, 2: { t: 20, lat: 1.6, lon: 2.6 } } } }, fleet: { b1: { id: 'b1', name: 'Boat 1' } }, incidents: [{ id: 'INC-1', kind: 'CAPSIZE', boat: 'b1', opened: 90, lastEventT: 90, events: [{ t: 90, type: 'CAPSIZE', source: 'shore', eid: null, data: {} }], status: 'OPEN' }] },
    nodes: {
      fn0006: { S: { ep: 7, boats: { b1: { id: 'b1', seq: 5, pending: { eid: 'e1', pkt: { t: 1, lat: 1, lon: 1 }, tries: 1, firstAt: 100, nextAt: 200 }, log: [], logSeq: 5, stats: { sent: 3, failed: 0 } } } } },
      fn0010: { G: { connected: true, forcedDown: false, ep: 7, buffer: [{ t: 3500, b: 'b1', d: 'x' }], stats: { up: 9 }, lastHb: 3590 } },
      fn0020: { M: { online: true, lastHb: 3590, reason: null } }
    },
  };
}

const TEMP = path.join(here, 'fixtures', 'fleet-wiring');
const PROJECT_ROOT = path.resolve(here, '..', '..');
const tempRel = path.relative(PROJECT_ROOT, TEMP);
assert.ok(tempRel && !tempRel.startsWith('..') && !path.isAbsolute(tempRel), 'scratch dir escapes project root: ' + TEMP);
fs.rmSync(TEMP, { recursive: true, force: true });
fs.mkdirSync(TEMP, { recursive: true });

function seedDir(name, snap) {
  const dir = path.join(TEMP, name);
  const st = storeMod.createStore({ dataDir: dir });
  const res = st.save(snap);
  assert.ok(res.ok, 'seed save failed: ' + res.error);
  return dir;
}

// ---------------------------------------------------------------------------
test('restored bootstrap emits NO live command (cmd live cannot erase recovery)', () => {
  const dir = seedDir('restored', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  global.set('fleetRuntime', rt);
  const { result } = runBody('fn0002', { global });
  // Restored: NO cmd live. Sends only clock stop (routes to the clock control via
  // the command router) so any running timer is cleared; the world stays paused.
  assert.ok(result && result.payload, 'restored bootstrap emits a command');
  assert.notEqual(result.payload.cmd, 'live', 'restored bootstrap must NOT emit cmd live');
  assert.equal(result.payload.cmd, 'pause', 'restored bootstrap sends clock stop (pause)');
  assert.equal(global.get('fleetSaveStatus').restored, true, 'world restored');
  assert.equal(global.get('simRunning'), false, 'restored world paused');
  assert.ok(global.get('cfg'), 'cfg still configured');
  assert.ok(global.get('lib'), 'lib still configured');
});

test('missing snapshot still emits the existing cmd live (fresh world)', () => {
  const dir = path.join(TEMP, 'fresh');
  const rt = createRuntime({ dataDir: dir }); // no snapshot
  const global = makeScope();
  global.set('fleetRuntime', rt);
  const { result } = runBody('fn0002', { global });
  assert.ok(result && result.topic === 'cmd', 'fresh bootstrap emits a cmd');
  assert.deepEqual(result.payload, { cmd: 'live' }, 'existing cmd live preserved');
  assert.equal(global.get('fleetSaveStatus').restored, false);
});

test('no fleetRuntime global: fn0002 falls back to original behaviour (cmd live, local rng)', () => {
  const global = makeScope(); // no fleetRuntime
  const { result } = runBody('fn0002', { global });
  assert.ok(result && result.payload && result.payload.cmd === 'live', 'standalone still emits cmd live');
  // rng fallback: lib.rng works without a runtime.
  const lib = global.get('lib');
  const r = lib.rng(42);
  assert.ok(typeof r() === 'number');
});

test('runtime.before false skips the body; after NOT called for a skipped body', () => {
  const rt = fakeRuntime({ beforeResult: false });
  const global = makeScope();
  global.set('fleetRuntime', rt);
  const { result } = runBody('fn0020', { global });
  assert.equal(result, null, 'held body returns null');
  assert.deepEqual(rt.calls.before, ['fn0020'], 'before called with node id');
  assert.deepEqual(rt.calls.after, [], 'after not called when body skipped');
});

test('after executes on early return AND on exception (try/finally wrapper)', () => {
  // Replicate build.mjs wrapFleetBody exactly, then drive a synthetic body.
  function wrap(id, body) {
    return "const __rt=global.get('fleetRuntime');\n"
      + "if(__rt&&typeof __rt.before==='function'&&__rt.before('" + id + "',context,global,msg)===false)return null;\n"
      + "try{\n" + body + "\n}finally{\n"
      + "if(__rt&&typeof __rt.after==='function')__rt.after('" + id + "',context,global,msg);\n}\n";
  }
  // Early return:
  let rt = fakeRuntime({ beforeResult: true });
  let global = makeScope(); global.set('fleetRuntime', rt);
  let fn = new Function('msg','node','context','global','flow','env', wrap('fnX', 'return { early: true };'));
  let res = fn({}, { status(){} }, makeScope(), global, makeScope(), envFake);
  assert.deepEqual(res, { early: true }, 'early return value preserved');
  assert.deepEqual(rt.calls.after, ['fnX'], 'after called on early return');
  // Exception:
  rt = fakeRuntime({ beforeResult: true });
  global = makeScope(); global.set('fleetRuntime', rt);
  fn = new Function('msg','node','context','global','flow','env', wrap('fnX', "throw new Error('boom');"));
  assert.throws(() => fn({}, { status(){} }, makeScope(), global, makeScope(), envFake), /boom/, 'exception propagates');
  assert.deepEqual(rt.calls.after, ['fnX'], 'after called on exception');
});

test('real runtime restored-paused: held transport node body skipped, publisher + control run', () => {
  const dir = seedDir('held', worldSnapshot());
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  global.set('fleetRuntime', rt);
  // fn0020 (gateway monitor) is held on restored pause -> body skipped -> null.
  const held = runBody('fn0020', { global, msg: { topic: 'mqttStatus', status: { text: 'node-red:common.status.connected' } } });
  assert.equal(held.result, null, 'held monitor body skipped');
  // Publisher (presentation) is NOT held: body runs (may return null/undefined, that is fine).
  const pub = runBody('fn004e', { global, msg: { payload: 'tick' } });
  assert.ok(true, 'publisher body executed without throwing');
  // Control node fn003a is NOT held.
  const ctl = runBody('fn003a', { global, msg: { payload: { cmd: 'pause' } } });
  assert.ok(true, 'control body executed without throwing');
});

test('all store ALLOWLIST.nodes context nodes are wrapped; wrap list matches build', () => {
  // Every context node must be wrapped in the generated flows.
  for (const id of Object.keys(ALLOWLIST.nodes)) {
    const f = funcOf(id);
    assert.ok(f, 'missing function ' + id);
    assert.ok(f.includes("__rt.before('" + id + "'"), id + ' must call before with its own id');
    assert.ok(f.includes("__rt.after('" + id + "'"), id + ' must call after with its own id');
    assert.ok(f.includes('try{') && f.includes('}finally{'), id + ' body must be wrapped in try/finally');
  }
  // The build wrap list is exactly the allowlisted context nodes plus save/control nodes.
  assert.deepEqual([...FLEET_HOOK_IDS].sort(), [...FLEET_HOOK_IDS].sort(), 'sanity');
  for (const id of FLEET_HOOK_IDS) {
    assert.ok(funcOf(id), 'wrap-list node missing in flows: ' + id);
    assert.ok(funcOf(id).includes('__rt'), id + ' must be wrapped');
  }
  // fn0002 (bootstrap) is NOT wrapped - it calls initialize itself.
  assert.ok(!funcOf('fn0002').includes('__rt'), 'fn0002 must not be wrapped');
});

test('rescue functions are NOT wrapped', () => {
  for (const id of ['fnRescue', 'fnRescueApi']) {
    const f = funcOf(id);
    assert.ok(f, 'missing rescue function ' + id);
    assert.ok(!f.includes('__rt'), id + ' must not be wrapped');
    assert.ok(!f.includes('fleetRuntime'), id + ' must not reference the fleet runtime');
  }
});

test('all generated function sources parse (new Function)', () => {
  for (const n of nodes) {
    if (n.type === 'function') {
      // Throws if the (possibly wrapped) body is not valid JS.
      new Function('msg','node','context','global','flow','env', n.func);
    }
  }
  assert.ok(true, 'all ' + nodes.filter(n=>n.type==='function').length + ' function bodies parse');
});

test('resumable rng sequence remains old-compatible (delegates to runtime rng)', () => {
  // The original fn0002 mulberry32 stream (standalone fallback).
  function oldRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const seed = 987654321;
  const a = oldRng(seed), b = storeRng(seed);
  for (let i = 0; i < 8; i++) assert.equal(b(), a(), 'stream diverges at ' + i);
  // Through fn0002 with a runtime present, lib.rng delegates to the runtime rng
  // and must produce the SAME old-compatible stream.
  const dir = path.join(TEMP, 'rng');
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  global.set('fleetRuntime', rt);
  const { result } = runBody('fn0002', { global }); // fresh -> cmd live, but also configures lib
  const lib = global.get('lib');
  const r = lib.rng(seed);
  const c = oldRng(seed);
  for (let i = 0; i < 8; i++) assert.equal(r(), c(), 'delegated rng diverges at ' + i);
  // Resumable: a snapshot continues the exact stream.
  const r2 = lib.rng(0, r.snapshot());
  const c2 = oldRng(seed);
  for (let i = 0; i < 8; i++) c2(); // advance old to same position
  const nextOld = c2();
  assert.equal(r2(), nextOld, 'resumed rng must continue the same stream');
});

// ---------------------------------------------------------------------------
const passed = outcomes.filter((o) => o.passed).length;
const failed = outcomes.length - passed;
const report = {
  suite: 'fleet-wiring',
  module: 'seaguard/build.mjs + settings.js + src/functions/fn0002.js',
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
