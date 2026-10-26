// Focused tests for bounded tagged-Set snapshot support (fn001d shore ingest
// seen/missing/eids) in seaguard/src/fleet/persistence.cjs + runtime.cjs.
// Runs offline without Node-RED or any service:
//     node seaguard/tests/fleet-shore-sets.mjs
// Scratch snapshots go to the dedicated seaguard/tests/fixtures/fleet-shore-sets
// directory. The REAL generated fn001d.js source is executed in a node:vm realm
// (as Node-RED would), so the Sets under test are genuine cross-realm Sets.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import store from '../src/fleet/persistence.cjs';
import { createRuntime } from '../src/fleet/runtime.cjs';

const { SET_TAG, LIMITS, encode, decode, validate, empty } = store;
const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'fleet-shore-sets');
const REPORT = path.join(here, '..', 'reports', 'fleet-shore-sets.json');
const FN001D = path.join(here, '..', 'src', 'functions', 'fn001d.js');

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push({ name, ok: true }); console.log('PASS ' + name);
  } catch (e) { failed++; results.push({ name, ok: false, error: e.message }); console.log('FAIL ' + name + ': ' + e.message); }
}
function throws(fn, re) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected throw, got none');
  assert.equal(err.code, 'FLEET_SNAPSHOT_INVALID');
  assert.match(err.message, re);
  return err.message;
}

// A minimal valid doc skeleton with fn001d S context, for encode/validate probes.
function shoreDoc(L) {
  return { format: store.FORMAT, version: store.VERSION, savedAt: 1, globals: {}, nodes: { fn001d: { S: { ep: 1, L } } } };
}

test('shore Set fields reject wrong member types and sequence ranges',()=>{
  for(const [field,items] of [['seen',['1']],['seen',[0]],['missing',[-1]],['missing',[10000001]],['eids',[7]],['eids',['']]]){
    const doc=shoreDoc({B1:{[field]:{__tag:SET_TAG,items}}});
    throws(()=>validate(doc),/invalid for field/);
    throws(()=>decode(doc),/invalid for field/);
  }
});
test('nested and unknown Set tag paths are rejected by validate and decode',()=>{
  for(const data of [{extra:{seen:{__tag:SET_TAG,items:[1]}}},{other:{__tag:SET_TAG,items:[1]}}]){
    const doc=shoreDoc({B1:data});
    throws(()=>validate(doc),/outside the allowlisted/);
    throws(()=>decode(doc),/outside the allowlisted/);
  }
});
test('duplicate tagged Set members cannot silently shrink the restored cardinality',()=>{
  for(const [field,items] of [['seen',[1,1]],['eids',['E1','E1']]]){
    const doc=shoreDoc({B1:{[field]:{__tag:SET_TAG,items}}});
    throws(()=>validate(doc),/duplicated/);throws(()=>decode(doc),/duplicated/);
  }
});
test('well-formed Set tag outside shore is rejected during validation too',()=>{
  const doc=shoreDoc({});doc.nodes.fn0011={S:{queue:{__tag:SET_TAG,items:[1]}}};
  throws(()=>validate(doc),/outside the allowlisted/);
});

// ---------------------------------------------------------------------------
// 1. Store-level: tagged Set encode/decode, membership + insertion order
// ---------------------------------------------------------------------------
test('roundtrip: shore Sets encode to tagged pure data and revive as Sets', () => {
  const seen = new Set([5, 3, 9]);
  const missing = new Set([4]);
  const eids = new Set(['E1', 'E2']);
  const doc = encode({ globals: {}, nodes: { fn001d: { S: { ep: 1, L: { B1: { highest: 9, seen, missing, eids } } } } } });
  // Encoded form is tagged pure data (JSON-safe), order preserved.
  assert.deepEqual(doc.nodes.fn001d.S.L.B1.seen, { __tag: SET_TAG, items: [5, 3, 9] });
  assert.deepEqual(doc.nodes.fn001d.S.L.B1.missing, { __tag: SET_TAG, items: [4] });
  assert.deepEqual(doc.nodes.fn001d.S.L.B1.eids, { __tag: SET_TAG, items: ['E1', 'E2'] });
  JSON.stringify(doc); // must be serializable
  const data = decode(doc);
  const L = data.nodes.fn001d.S.L.B1;
  for (const [k, src] of [['seen', seen], ['missing', missing], ['eids', eids]]) {
    assert.ok(L[k] instanceof Set, k + ' revived as Set');
    assert.deepEqual([...L[k]], [...src], k + ' membership + insertion order');
  }
  // .has/.add/.delete behavior after load.
  assert.ok(L.seen.has(3) && !L.seen.has(6));
  L.seen.add(6); L.seen.delete(5);
  assert.ok(L.seen.has(6) && !L.seen.has(5));
  assert.equal(L.seen.size, 3);
});

test('vm-realm Sets (Node-RED function realm) encode and revive', () => {
  const realm = vm.createContext({});
  const foreign = vm.runInContext('({ seen: new Set([2, 7]), missing: new Set(), eids: new Set(["EV"]) })', realm);
  assert.ok(!(foreign.seen instanceof Set)); // genuinely cross-realm
  const doc = encode({ globals: {}, nodes: { fn001d: { S: { ep: 1, L: { B9: { highest: 7, ...foreign } } } } } });
  assert.deepEqual(doc.nodes.fn001d.S.L.B9.seen, { __tag: SET_TAG, items: [2, 7] });
  assert.deepEqual(doc.nodes.fn001d.S.L.B9.missing, { __tag: SET_TAG, items: [] });
  const L = decode(doc).nodes.fn001d.S.L.B9;
  assert.ok(L.seen instanceof Set);
  assert.deepEqual([...L.seen], [2, 7]);
  assert.deepEqual([...L.eids], ['EV']);
  assert.ok(L.missing instanceof Set && L.missing.size === 0);
});

// ---------------------------------------------------------------------------
// 2. Store-level: narrow rejection (paths, item types, count, malformed tags)
// ---------------------------------------------------------------------------
test('Set outside allowlisted shore path is rejected (fn0011 S)', () => {
  const doc = shoreDoc({ B1: { highest: 1 } });
  doc.nodes.fn0011 = { S: { ep: 1, queue: new Set([1, 2]) } };
  assert.throws(() => encode({ globals: doc.globals, nodes: doc.nodes }), /outside the allowlisted shore fields/);
});
test('Set in globals is rejected', () => {
  assert.throws(() => encode({ globals: { fleet: { B1: { seen: new Set([1]) } } }, nodes: {} }), /outside the allowlisted shore fields/);
});
test('Set tag decoded at a non-shore path is rejected', () => {
  const doc = shoreDoc({ B1: { highest: 1, seen: { __tag: SET_TAG, items: [1] } } });
  doc.nodes.fn0011 = { S: { ep: 1, queue: { __tag: SET_TAG, items: [1] } } };
  // The tag is well-shaped, but fn0011.S.queue is outside the shore allowlist:
  // validate()'s data walk rejects it, and decodeValue enforces the same path
  // on revival, so a validated snapshot is always loadable.
  assert.throws(() => decode(doc), /fn0011.S.queue has a Set tag outside the allowlisted shore fields/);
  assert.throws(() => validate(doc), /fn0011.S.queue has a Set tag outside the allowlisted shore fields/);
});
test('Set member type violations are rejected', () => {
  const base = () => shoreDoc({ B1: { highest: 1, seen: new Set([1]) } });
  const d1 = base(); d1.nodes.fn001d.S.L.B1.seen.add(1.5);
  assert.throws(() => encode({ globals: {}, nodes: d1.nodes }), /unsupported member/);
  const d2 = base(); d2.nodes.fn001d.S.L.B1.seen.add({ a: 1 });
  assert.throws(() => encode({ globals: {}, nodes: d2.nodes }), /unsupported member/);
  const d3 = base(); d3.nodes.fn001d.S.L.B1.seen.add('x'.repeat(101));
  assert.throws(() => encode({ globals: {}, nodes: d3.nodes }), /unsupported member/);
});
test('oversized Set (member count) is rejected', () => {
  const big = new Set(); for (let i = 0; i <= LIMITS.maxArray; i++) big.add(i);
  const doc = shoreDoc({ B1: { highest: 1, seen: big } });
  assert.throws(() => encode({ globals: {}, nodes: doc.nodes }), /Set exceeds/);
});
test('malformed SET_TAG objects are rejected (encode + validate)', () => {
  // Live plain object carrying the tag with bad items.
  const d1 = shoreDoc({ B1: { highest: 1, seen: { __tag: SET_TAG, items: [1, 2.5] } } });
  assert.throws(() => encode({ globals: {}, nodes: d1.nodes }), /malformed Set tag|items\[1\]/);
  // items not an array.
  const d2 = shoreDoc({ B1: { highest: 1, seen: { __tag: SET_TAG, items: 'nope' } } });
  assert.throws(() => validate(d2), /malformed Set tag/);
  // extra key.
  const d3 = shoreDoc({ B1: { highest: 1, seen: { __tag: SET_TAG, items: [1], extra: 1 } } });
  assert.throws(() => validate(d3), /malformed Set tag/);
  // items over the array limit.
  const d4 = shoreDoc({ B1: { highest: 1, seen: { __tag: SET_TAG, items: new Array(LIMITS.maxArray + 1).fill(1) } } });
  assert.throws(() => validate(d4), /Set items exceed limit/);
});
test('cycle through a Set-adjacent object is rejected', () => {
  const S = { ep: 1, L: { B1: { highest: 1, seen: new Set([1]) } } };
  S.self = S;
  assert.throws(() => encode({ globals: {}, nodes: { fn001d: { S } } }), /cycle/);
});
test('arbitrary Map and class instances are still rejected', () => {
  const d1 = shoreDoc({ B1: { highest: 1, seen: new Map([[1, 2]]) } });
  assert.throws(() => encode({ globals: {}, nodes: d1.nodes }), /unsupported data \(Map\)/);
  const d2 = shoreDoc({ B1: { highest: 1, seen: new Set([1]), when: new Date(0) } });
  assert.throws(() => encode({ globals: {}, nodes: d2.nodes }), /unsupported data \(Date\)/);
});

// ---------------------------------------------------------------------------
// 3. Runtime integration: REAL generated fn001d.js in a vm realm, save ->
//    fresh runtime restore -> duplicate + gap recovery with exact accounting.
// ---------------------------------------------------------------------------
const fn001dSource = fs.readFileSync(FN001D, 'utf8');
const fn001dFactory = new vm.Script('(function(context, global, msg){\n' + fn001dSource + '\n})');

function makeStubs() {
  const g = new Map();
  const c = new Map();
  return {
    g,
    global: { get: k => g.get(k), set: (k, v) => { g.set(k, v); } },
    context: { get: k => c.get(k), set: (k, v) => { c.set(k, v); } },
    run(msg) {
      const fn = fn001dFactory.runInContext(vm.createContext({}));
      return fn(this.context, this.global, msg);
    },
  };
}
function seedGlobals(g) {
  g.set('cfg', { detect: { commsLostS: 30 }, fleet: [{ id: 'B1' }] });
  g.set('epoch', 1);
  g.set('simTime', 0);
  g.set('simSpeed', 1);
  g.set('simRunning', true);
  g.set('mode', 'test');
  g.set('runSeed', 7);
  g.set('notifications', []);
  g.set('syncStore', {});
  g.set('fleet', {});
  g.set('linkShore', {});
}
const T = (s, t, extra = {}) => ({ topic: 'up/B1', payload: Object.assign({ b: 'B1', ep: 1, k: 'T', s, t, la: 10, lo: 20, sp: 1, hd: 0, r: 0, wl: 0, bv: 1, cr: 1, ct: 1, hdop: 1 }, extra) });
const E = (s, eid, ev, rt, t) => ({ topic: 'up/B1', payload: { b: 'B1', ep: 1, k: 'E', s, eid, ev, rt, t, d: {}, la: 10, lo: 20 } });

let r1, g1, c1, stubs1, preSave, evCount1, ackCount1;

test('runtime1: real fn001d in vm realm builds Sets; periodic save PASSES (was HTTP500)', () => {
  fs.rmSync(FIX, { recursive: true, force: true });
  r1 = createRuntime({ dataDir: FIX });
  stubs1 = makeStubs();
  seedGlobals(stubs1.g);
  const init = r1.initialize(stubs1.global);
  assert.equal(init.ok, true);
  assert.equal(init.restored, false);
  // fn001d is not a paused-hold node on a fresh world: body runs.
  assert.equal(r1.before('fn001d', stubs1.context, stubs1.global, T(1, 100)), true);
  const outs = [];
  const feed = (m) => {
    const out = stubs1.run(m);
    const got = [];
    for (const o of out) if (o) got.push(...o);
    for (const x of got) outs.push(x);
    return got; // per-call outputs (fn001d returns [o1|null, o2|null, o3|null] or null)
  };
  feed(T(1, 100));                       // applied
  const e1 = feed(E(2, 'E1', 'SOS', 1, 101)); // event + ack
  const g1out = feed(T(5, 102));          // gap: missing {3,4}, lost=2
  feed(T(5, 103));                        // duplicate of s=5
  feed(E(6, 'E1', 'SOS', 2, 104));        // eids duplicate + ack
  assert.ok(outs.some(o => o.topic === 'telemetry'), 'first telemetry applied');
  assert.ok(e1.some(o => o.payload.type === 'SOS'), 'E1 event emitted once at first sight');
  assert.equal(r1.after('fn001d', stubs1.context, stubs1.global, T(1, 100)), undefined);
  const S = c1 = stubs1.context.get('S');
  const L = S.L.B1;
  // Live Sets are vm-realm: `instanceof Set` (main realm) is false by design.
  const isSetLike = (v) => Object.prototype.toString.call(v) === '[object Set]';
  assert.ok(isSetLike(L.seen) && isSetLike(L.missing) && isSetLike(L.eids));
  assert.deepEqual([...L.seen], [1, 2, 5, 6]);
  assert.deepEqual([...L.missing], [3, 4]);
  assert.deepEqual([...L.eids], ['E1']);
  assert.equal(L.highest, 5 + 1);
  assert.equal(L.lost, 2);
  evCount1 = outs.filter(o => o.topic === 'event').length;
  ackCount1 = outs.filter(o => o.topic === 'seaguard/down/B1').length;
  assert.equal(evCount1, 1);
  // Acks only exist for EVENT frames (ack payload carries the eid): the s=5
  // duplicate is a T frame (no eid) and is counted in dup WITHOUT an ack.
  assert.equal(ackCount1, 2); // first E1 + s=6 E1 retry (eids-dup)
  // THE LIVE DEFECT: this save used to throw 'unsupported data (Set)' -> HTTP 500.
  const res = r1.save(stubs1.global);
  assert.equal(res.ok, true, 'save after real fn001d: ' + (res.error || ''));
  preSave = { ...L, seen: [...L.seen], missing: [...L.missing], eids: [...L.eids] };
  // On-disk doc carries tagged pure-data Sets in insertion order.
  const doc = JSON.parse(fs.readFileSync(path.join(FIX, 'fleet.json'), 'utf8'));
  assert.deepEqual(doc.nodes.fn001d.S.L.B1.seen, { __tag: SET_TAG, items: [1, 2, 5, 6] });
  assert.deepEqual(doc.nodes.fn001d.S.L.B1.missing, { __tag: SET_TAG, items: [3, 4] });
  assert.deepEqual(doc.nodes.fn001d.S.L.B1.eids, { __tag: SET_TAG, items: ['E1'] });
  assert.equal(doc.globals.epoch, 1);
});

let r2, stubs2, L2, postEv, postAcks, postOuts;

test('runtime2: fresh runtime restores paused, fn001d held, Sets revived with order', () => {
  r2 = createRuntime({ dataDir: FIX });
  stubs2 = makeStubs(); // module-level: the post-resume test feeds through it
  // cfg is NON-persisted config (absent from the allowlist): the real runtime
  // gets it from the config node, so the harness must seed it before restore.
  stubs2.g.set('cfg', { detect: { commsLostS: 30 }, fleet: [{ id: 'B1' }] });
  const init = r2.initialize(stubs2.global);
  assert.equal(init.ok, true);
  assert.equal(init.restored, true);
  assert.equal(stubs2.g.get('epoch'), 1, 'restored globals hydrated');
  assert.equal(stubs2.g.get('simRunning'), false, 'restored world paused');
  // Restored-paused: operational shore ingest body is held.
  assert.equal(r2.before('fn001d', stubs2.context, stubs2.global, T(1, 100)), false);
  const S2 = stubs2.context.get('S');
  L2 = S2.L.B1;
  assert.ok(L2.seen instanceof Set, 'seen revived as Set');
  assert.deepEqual([...L2.seen], preSave.seen, 'seen membership + order preserved');
  assert.deepEqual([...L2.missing], preSave.missing, 'missing membership + order preserved');
  assert.deepEqual([...L2.eids], preSave.eids, 'eids membership + order preserved');
  assert.equal(L2.highest, 6);
  assert.equal(L2.lost, 2);
  assert.ok(L2.seen.has(5) && L2.missing.has(3) && L2.eids.has('E1'));
  const res = r2.resume(stubs2.global);
  assert.equal(res.ok, true);
  assert.equal(res.resumedFromHold, true);
  assert.equal(stubs2.g.get('simRunning'), true);
});

test('runtime2 post-resume: duplicate + gap recovery, no extra event/ack effects, accounting preserved', () => {
  stubs2.g.set('simTime', 200); // frozen clock continues from operator resume
  const outs = [];
  const feed = (m) => {
    assert.equal(r2.before('fn001d', stubs2.context, stubs2.global, m), true, 'body runs after resume');
    const out = stubs2.run(m);
    for (const o of out) if (o) outs.push(...o);
    r2.after('fn001d', stubs2.context, stubs2.global, m);
  };
  feed(T(3, 105));  // late frame fills gap 3: recovered, telemetry applied (t=105 > posT=102)
  feed(T(5, 106));  // exact duplicate of seen s=5: no event, no telemetry
  feed(E(6, 'E1', 'SOS', 3, 107)); // duplicate E1 retry: NO new event, ack only
  feed(E(4, 'E2', 'MOB', 1, 108)); // late NEW event filling gap 4: one event + ack
  postOuts = outs;
  postEv = outs.filter(o => o.topic === 'event');
  postAcks = outs.filter(o => o.topic === 'seaguard/down/B1');
  assert.equal(postEv.length, 1, 'exactly one new event (E2)');
  assert.equal(postEv[0].payload.type, 'MOB');
  assert.equal(postEv[0].payload.eid, 'E2');
  // The s=5 dup is a T frame: counted in dup, no ack (acks carry an eid).
  assert.equal(postAcks.length, 2, 'acks: s=6 dup (E1 retry) + E2');
  assert.ok(outs.some(o => o.topic === 'telemetry'), 'late s=3 telemetry applied');
  const L = stubs2.context.get('S').L.B1;
  // Loss/recovery accounting preserved across the restore boundary.
  assert.equal(L.recovered, 2, 'recovered: pre-save 0 + gap3 + gap4');
  assert.equal(L.lost, 0, 'lost: pre-save 2, both gaps recovered');
  assert.equal(L.dup, preSave.dup + 2, 'dup: pre-save 1 + s=5 + s=6');
  assert.equal(L.ooo, 2, 'ooo: s=3 and s=4 late frames');
  assert.equal(L.dupEvents, 1, 'dupEvents unchanged (E1 dup counted pre-save only)');
  assert.equal(L.retriesSeen, preSave.retriesSeen + 1, 'retriesSeen: pre-save 1 + s=6 E1 retry');
  assert.equal(L.highest, 6);
  assert.deepEqual([...L.eids], ['E1', 'E2']);
  assert.deepEqual([...L.missing], [], 'missing window fully recovered');
  assert.deepEqual([...L.seen], [1, 2, 5, 6, 3, 4], 'seen order: restored prefix + new appends');
  // linkShore global (plain-data copy) still agrees on the counters.
  const ls = stubs2.g.get('linkShore').B1;
  assert.equal(ls.lost, 0);
  assert.equal(ls.recovered, 2);
  assert.equal(ls.dup, preSave.dup + 2);
  // Final save re-encodes the revived Sets and round-trips.
  const res = r2.save(stubs2.global);
  assert.equal(res.ok, true, 'final save: ' + (res.error || ''));
  const doc = JSON.parse(fs.readFileSync(path.join(FIX, 'fleet.json'), 'utf8'));
  assert.deepEqual(doc.nodes.fn001d.S.L.B1.seen, { __tag: SET_TAG, items: [1, 2, 5, 6, 3, 4] });
  assert.deepEqual(doc.nodes.fn001d.S.L.B1.missing, { __tag: SET_TAG, items: [] });
  assert.deepEqual(doc.nodes.fn001d.S.L.B1.eids, { __tag: SET_TAG, items: ['E1', 'E2'] });
  // And a THIRD fresh runtime still restores cleanly (no drift, no rejection).
  const r3 = createRuntime({ dataDir: FIX });
  const stubs3 = makeStubs();
  stubs3.g.set('cfg', { detect: { commsLostS: 30 }, fleet: [{ id: 'B1' }] });
  const i3 = r3.initialize(stubs3.global);
  assert.equal(i3.restored, true);
  // initialize() hydrates globals/cache only; the first before() registers the
  // context refs and hydrates the saved S into the context (body held while
  // restored-paused, so it returns false).
  assert.equal(r3.before('fn001d', stubs3.context, stubs3.global, T(1, 100)), false);
  const L3 = stubs3.context.get('S').L.B1;
  assert.deepEqual([...L3.seen], [1, 2, 5, 6, 3, 4]);
  assert.deepEqual([...L3.eids], ['E1', 'E2']);
  const s3 = r3.save(stubs3.global);
  assert.equal(s3.ok, true, 'third-runtime save: ' + (s3.error || ''));
});

// ---------------------------------------------------------------------------
// Report + exit code
// ---------------------------------------------------------------------------
const report = {
  suite: 'fleet-shore-sets',
  at: new Date().toISOString(),
  node: process.version,
  passed, failed, total: passed + failed,
  results,
};
fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
console.log('\n' + passed + '/' + (passed + failed) + ' passed; report: ' + REPORT);
process.exit(failed ? 1 : 0);
