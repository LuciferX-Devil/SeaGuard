// Focused tests for the standalone SeaGuard fleet snapshot store
// (seaguard/src/fleet/persistence.cjs). Runs without Node-RED or any service:
//     node seaguard/tests/fleet-persistence.mjs
// Scratch snapshots go to the fleet-dedicated seaguard/tests/fixtures/fleet-persistence
// directory (never the shared fixtures/temp used by the rescue persistence tests).
// The static baseline fixture JSON stays separate at
// seaguard/tests/fixtures/fleet-pending-trips.json and is never deleted.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import store from '../src/fleet/persistence.cjs';

const { ALLOWLIST, rng, createStore, encode, decode, validate, empty, PRNG_TAG, VERSION } = store;
const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures');
// Fleet-dedicated scratch directory. The shared fixtures/temp belongs to the
// rescue persistence tests; this suite must never delete or write into it.
const TEMP = path.join(FIX, 'fleet-persistence');
const reportPath = path.join(here, '..', 'reports', 'fleet-persistence.json');

// The recursive cleanup below may only touch the fleet scratch dir: verify it
// resolves inside the project root before deleting anything.
const PROJECT_ROOT = path.resolve(here, '..', '..');
const tempRel = path.relative(PROJECT_ROOT, TEMP);
assert.ok(tempRel && !tempRel.startsWith('..') && !path.isAbsolute(tempRel),
  'fleet scratch dir escapes the project root: ' + TEMP);

fs.rmSync(TEMP, { recursive: true, force: true });
fs.mkdirSync(TEMP, { recursive: true });

const outcomes = [];
function test(name, fn) {
  try { fn(); outcomes.push({ name, passed: true }); }
  catch (e) { outcomes.push({ name, passed: false, error: e.message }); }
}
function freshStore(name) { return createStore({ dataDir: path.join(TEMP, name) }); }

// Reference copy of the OLD lib.rng from fn0002, to prove identical output.
function oldRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Deterministic live-world snapshot using the REAL record/context shapes from the sources:
//  - notifications: fn0029 push shape {id,ref,incident,kind,role,chat,severity,text,status,
//    attempts,created,nextAt,inflight,deliveredAt,lastError} (+sentAt once sent)
//  - fn0006.S: {ep, boats:{[id]:{id,seq,lastTelem,hold,latched,tags,evN,pending,log,logSeq,
//    acked,inflight,batchN,adv,advCount,stats}}}; pending rows carry firstAt/nextAt
//  - fn0007.S: {ep, r, boats:{[id]:{...}}}; fn0010.G: {connected,forcedDown,ep,buffer,stats,lastHb};
//  - fn0020.M: {online,lastHb,reason}; fn0029.S: {ep,list,nextTestId}
//  - globals.fleet is an OBJECT MAP keyed by boat id (fn001d: fleet[p.b] = F)
//  - fn0029 publishes its context list as global 'notifications' (SAME array live),
//    so the fixture keeps one reference for both copies.
function liveSnapshot(over = {}) {
  const r = rng(1234);
  const notifications = [
    { id: 'INC-1/family', ref: 'INC-1', incident: 'INC-1', kind: 'CAPSIZE', role: 'family', chat: 'family-demo', severity: 3, text: 'b1', status: 'DELIVERED', attempts: 1, created: 90, nextAt: 90, sentAt: 100, inflight: false, deliveredAt: 101, lastError: null },
    { id: 'INC-2/coastguard', ref: 'INC-2', incident: 'INC-2', kind: 'FLOOD', role: 'coastguard', chat: 'coastguard-demo', severity: 2, text: 'b2', status: 'QUEUED', attempts: 0, created: 3600, nextAt: 3600, inflight: false, deliveredAt: null, lastError: null },
    { id: 'INC-3/coastguard', ref: 'INC-3', incident: 'INC-3', kind: 'MOM', role: 'coastguard', chat: 'coastguard-demo', severity: 3, text: 'b3', status: 'SENDING', attempts: 1, created: 3590, nextAt: 3590, sentAt: 3599, inflight: true, deliveredAt: null, lastError: null }
  ];
  const snap = {
    globals: {
      epoch: 7, simTime: 3600, simSpeed: 2, simRunning: true, mode: 'test', runSeed: 1234,
      notifications,
      syncStore: { B1: { count: 2, maxContig: 2, dupRecords: 0, batches: 1, firstT: 10, lastT: 20, recs: { 1: { t: 10, lat: 51.5, lon: 0.1 }, 2: { t: 20, lat: 51.51, lon: 0.11 } } } },
      incidents: [{ id: 'INC-1', kind: 'CAPSIZE', boat: 'B1', opened: 90, lastEventT: 90, events: [{ t: 90, type: 'CAPSIZE', source: 'shore', eid: null, data: {} }], status: 'OPEN' }],
      fleet: { B1: { lat: 51.5, lon: 0.1, spd: 0, hdg: 0, roll: 0, level: 2, bat: 12.6, crew: 2, crewTotal: 2, hdop: 1.2, posT: 3580, rxT: 3580 } }
    },
    nodes: {
      fn0006: { S: { ep: 7, boats: { B1: { id: 'B1', seq: 2, lastTelem: 3580, hold: { roll: 0, flood: 0 }, latched: { capsize: true, flood: false }, tags: { T1: { miss: 0, latched: false } }, evN: 1, pending: [{ eid: 'B1-1', pkt: { k: 'E', ev: 'CAPSIZE', eid: 'B1-1', b: 'B1', ep: 7, s: 1, t: 90, la: 51.5, lo: 0.1, d: { roll: 32 }, rt: 1 }, tries: 1, firstAt: 90, nextAt: 92 }], log: [{ s: 1, t: 10, lat: 51.5, lon: 0.1, spd: 0, roll: 0, lvl: 2, bat: 12.6, crew: 2 }], logSeq: 3, acked: 2, inflight: null, batchN: 1, adv: null, advCount: 0, stats: { sent: 1, retries: 0, acked: 2, gaveUp: 0, rttSum: 1.0, rttN: 1, dupAcks: 0, filtered: { roll: 0, splash: 0, tag: 0 }, syncBatches: 1, syncTimeouts: 0, syncErrors: 0 } } } } },
      fn0007: { S: { ep: 7, r, boats: { B1: { id: 'B1', x: 1.5, y: -2.5, hdg: 0.7, spd: 5, rollPhase: 1.2, bat: 12.6, capsized: false, capRoll: 0, flooding: false, floodLevel: 0, tags: [] } } } },
      fn0010: { G: { connected: true, forcedDown: false, ep: 7, buffer: [], stats: { fwd: 4, buffered: 0, bufDropped: 0, flushed: 0, down: 0 }, lastHb: 3595 } },
      fn0020: { M: { online: true, lastHb: 3595, reason: 'heartbeat' } },
      fn0029: { S: { ep: 7, list: notifications, nextTestId: 1 } }
    }
  };
  const out = Object.assign(snap, over);
  // Keep the two persisted copies of the notifier list in sync when the caller
  // overrides globals.notifications (they are the same array in the live system).
  if (out.nodes.fn0029 && out.nodes.fn0029.S && out.globals.notifications !== undefined) {
    out.nodes.fn0029.S.list = out.globals.notifications;
  }
  return out;
}

// ------------------------------------------------------------- deterministic RNG
test('rng(seed) produces the identical stream to the old lib.rng', () => {
  const a = rng(42), b = oldRng(42);
  for (let i = 0; i < 1000; i++) assert.equal(a(), b());
});
test('rng snapshot is pure data and continuation is exact', () => {
  const a = rng(99), b = oldRng(99);
  for (let i = 0; i < 37; i++) assert.equal(a(), b());
  const snap = a.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ['__tag', 'state']);
  assert.equal(snap.__tag, PRNG_TAG);
  assert.ok(Number.isSafeInteger(snap.state));
  assert.equal(JSON.parse(JSON.stringify(snap)).state, snap.state);
  const c = rng(0, snap); // different seed must not matter once state is given
  for (let i = 0; i < 1000; i++) assert.equal(c(), b());
});
test('rng treats only the known tag as a restorable state', () => {
  assert.equal(rng(1, { state: 5 })(), oldRng(1)()); // untagged -> seed path
  assert.equal(rng(1, { __tag: 'wrong', state: 5 })(), oldRng(1)()); // unknown tag -> seed path
  assert.notEqual(rng(1, { __tag: PRNG_TAG, state: 5 })(), oldRng(1)()); // known tag -> state path
});
test('encode revives only the tagged PRNG; decode gives a working continuation', () => {
  const doc = encode(liveSnapshot());
  const enc = doc.nodes.fn0007.S.r;
  assert.equal(typeof enc, 'object');
  assert.equal(enc.__tag, PRNG_TAG);
  const out = decode(doc);
  assert.equal(typeof out.nodes.fn0007.S.r, 'function');
  const live = liveSnapshot();
  const ref = live.nodes.fn0007.S.r;
  for (let i = 0; i < 50; i++) assert.equal(out.nodes.fn0007.S.r(), ref());
});

// ----------------------------------------------------------------------- allowlists
test('allowlists expose exactly the design globals and node keys', () => {
  assert.deepEqual([...ALLOWLIST.globals].sort(), [
    'chan', 'corr', 'epoch', 'eventLog', 'faults', 'fleet', 'fw', 'geo', 'gateway', 'gatewayShore',
    'incidents', 'layout', 'linkHist', 'linkLog', 'linkShore', 'mockDeliveryLedger', 'mockDeliverySeq', 'mockTelegram', 'mode', 'notifications',
    'runSeed', 'seaState', 'simRunning', 'simSpeed', 'simTime', 'suppressions', 'syncStore', 'test', 'truth', 'weather'
  ].sort());
  assert.deepEqual(Object.keys(ALLOWLIST.nodes).sort(), [
    'fn0006', 'fn0007', 'fn000a', 'fn0010', 'fn0011', 'fn0018', 'fn001b', 'fn001c', 'fn001d', 'fn0020', 'fn0028', 'fn0029'
  ].sort());
  assert.deepEqual(ALLOWLIST.nodes.fn0010, ['G']);
  assert.deepEqual(ALLOWLIST.nodes.fn0020, ['M']);
  for (const k of ['cfg', 'lib', 'credentials', 'services']) assert.ok(!ALLOWLIST.globals.includes(k));
});
test('non-allowlisted globals, nodes and context keys are rejected', () => {
  assert.throws(() => encode({ globals: { cfg: { a: 1 } }, nodes: {} }), /non-allowlisted global/);
  assert.throws(() => encode({ globals: {}, lib: 1, nodes: {} }), /unexpected key|non-allowlisted/);
  assert.throws(() => encode({ globals: {}, nodes: { fn003a: { S: {} } } }), /non-allowlisted node/);
  assert.throws(() => encode({ globals: {}, nodes: { fn0029: { S: {}, timer: 1 } } }), /non-allowlisted context key/);
});

// ------------------------------------------------------- invalid versions and data
test('unknown versions and formats are rejected', () => {
  const doc = encode(liveSnapshot());
  assert.throws(() => decode({ ...doc, version: 2 }), /unsupported version 2/);
  assert.throws(() => decode({ ...doc, version: 0 }), /unsupported version 0/);
  assert.throws(() => decode({ ...doc, format: 'other' }), /unknown format/);
  assert.throws(() => decode({ ...doc, savedAt: -5 }), /savedAt/);
  assert.throws(() => decode({ ...doc, savedAt: NaN }), /savedAt/);
});
test('nonfinite numbers, untagged functions, cycles and prototype keys are rejected', () => {
  assert.throws(() => encode({ globals: { simTime: Infinity }, nodes: {} }), /non-finite/);
  assert.throws(() => encode({ globals: { simTime: NaN }, nodes: {} }), /non-finite/);
  assert.throws(() => encode({ globals: {}, nodes: { fn0028: { S: { f: () => 1 } } } }), /function/);
  const cyc = { a: 1 }; cyc.self = cyc;
  assert.throws(() => encode({ globals: { test: cyc }, nodes: {} }), /cycle/);
  const proto = JSON.parse('{"__proto__": {"polluted": true}}');
  assert.throws(() => encode({ globals: { test: proto }, nodes: {} }), /prototype key/);
  assert.equal(({}).polluted, undefined);
});
test('oversized arrays and invalid clocks/epoch/mode are rejected', () => {
  const big = Array.from({ length: 20001 }, (_, i) => i);
  assert.throws(() => encode({ globals: { eventLog: big }, nodes: {} }), /exceeds/);
  assert.throws(() => encode({ globals: { epoch: -1 }, nodes: {} }), /epoch/);
  assert.throws(() => encode({ globals: { epoch: 1.5 }, nodes: {} }), /epoch/);
  assert.throws(() => encode({ globals: { simTime: -1 }, nodes: {} }), /simTime/);
  assert.throws(() => encode({ globals: { mode: 'chaos' }, nodes: {} }), /mode/);
});
test('invalid notification statuses, IDs and sync records are rejected', () => {
  const bad = s => liveSnapshot({ globals: { notifications: [{ id: 'A/x', status: s }], syncStore: {} } });
  assert.throws(() => encode(bad('MAYBE')), /status/);
  for (const s of ['QUEUED', 'SENDING', 'RETRY', 'FAILED']) validate(encode(bad(s)));
  validate(encode({ globals: { notifications: [{ id: 'A/x', status: 'DELIVERED', deliveredAt: 5 }], syncStore: {} }, nodes: {} }));
  assert.throws(() => encode({ globals: { notifications: [{ id: '', status: 'QUEUED' }], syncStore: {} }, nodes: {} }), /id/);
  assert.throws(() => encode({ globals: { notifications: [{ id: 'A', status: 'QUEUED' }, { id: 'A', status: 'QUEUED' }], syncStore: {} }, nodes: {} }), /unique/);
  assert.throws(() => encode({ globals: { syncStore: { B1: { recs: { 0: { t: 1, lat: 1, lon: 1 } } } } }, nodes: {} }), /sequence/);
  assert.throws(() => encode({ globals: { syncStore: { B1: { recs: { 1: { t: 1, lat: 91, lon: 1 } } } } }, nodes: {} }), /lat/);
});
test('deliveredAt is nullable (null until delivery) but must be finite-or-null', () => {
  const n = (deliveredAt) => ({ globals: { notifications: [{ id: 'A/x', status: 'QUEUED', deliveredAt }], syncStore: {} }, nodes: {} });
  validate(encode(n(null)));   // not yet delivered
  validate(encode(n(101)));    // delivered
  assert.throws(() => encode(n(NaN)), /deliveredAt/);
  assert.throws(() => encode(n(Infinity)), /deliveredAt/);
});
test('DELIVERED rows require a real finite deliveredAt (0 valid); null only before delivery', () => {
  const row = (deliveredAt) => ({ globals: { notifications: [{ id: 'A/x', status: 'DELIVERED', deliveredAt }], syncStore: {} }, nodes: {} });
  validate(encode(row(0)));     // 0 is a valid clock
  validate(encode(row(101)));
  assert.throws(() => encode(row(null)), /deliveredAt/);
  assert.throws(() => encode({ globals: { notifications: [{ id: 'A/x', status: 'DELIVERED' }], syncStore: {} }, nodes: {} }), /deliveredAt/);
  // Non-terminal statuses keep null legitimate.
  validate(encode({ globals: { notifications: [{ id: 'A/x', status: 'RETRY', deliveredAt: null }], syncStore: {} }, nodes: {} }));
});
test('malformed present incidents are rejected, not accepted to crash the restored engine', () => {
  const g = (incidents) => ({ globals: { incidents }, nodes: {} });
  assert.throws(() => encode(g([null])), /must be an object/);
  assert.throws(() => encode(g([{}])), /id/);
  assert.throws(() => encode(g([{ id: 'INC-1', status: 'ACTIVE', opened: 1, events: [] }])), /status/);
  assert.throws(() => encode(g([{ id: 'INC-1', status: 'OPEN', events: [] }])), /opened/);
  assert.throws(() => encode(g([{ id: 'INC-1', status: 'OPEN', opened: 1, events: 'none' }])), /events/);
  assert.throws(() => encode(g([{ id: 'INC-1', status: 'OPEN', opened: 1, events: [null] }])), /events\[0\]/);
  assert.throws(() => encode(g([{ id: 'INC-1', status: 'OPEN', opened: 1, events: [{ type: 'SOS' }] }])), /\.t/);
  assert.throws(() => encode(g([{ id: 'INC-1', status: 'OPEN', opened: 1, events: [{ t: 1 }] }])), /type/);
  assert.throws(() => encode(g([{ id: 'INC-1', status: 'OPEN', opened: 1, events: [] }, { id: 'INC-1', status: 'OPEN', opened: 2, events: [] }])), /unique/);
  for (const s of ['OPEN', 'ACKED', 'RESOLVED']) {
    validate(encode(g([{ id: 'INC-' + s, status: s, opened: 0, events: [{ t: 0, type: 'SOS', source: 'onboard', eid: null, data: {} }] }])));
  }
});
test('syncStore accounting must agree with the persisted record map', () => {
  const g = (B1) => ({ globals: { syncStore: { B1 } }, nodes: {} });
  // count claims two records but only one is persisted.
  assert.throws(() => encode(g({ count: 2, maxContig: 2, dupRecords: 0, batches: 1, firstT: 0, lastT: 2, recs: { 1: { t: 1, lat: 9, lon: 79 } } })), /count/);
  // maxContig claims a contiguous prefix the map does not have (gap at 2).
  assert.throws(() => encode(g({ count: 2, maxContig: 2, recs: { 1: { t: 1, lat: 9, lon: 79 }, 3: { t: 3, lat: 9, lon: 79 } } })), /maxContig/);
  // count set but recs missing entirely.
  assert.throws(() => encode(g({ count: 1 })), /recs/);
  // Consistent accounting passes, including an empty store and a valid gap.
  validate(encode(g({ count: 0, maxContig: 0, recs: {} })));
  validate(encode(g({ count: 2, maxContig: 1, recs: { 1: { t: 1, lat: 9, lon: 79 }, 3: { t: 3, lat: 9, lon: 79 } } })));
});
test('self-referential arrays are rejected (cycle), not infinite recursion', () => {
  const a = [1, 2]; a.push(a);
  assert.throws(() => encode({ globals: { eventLog: a }, nodes: {} }), /cycle/);
  const b = []; b.push(b);
  assert.throws(() => encode({ globals: { eventLog: b }, nodes: {} }), /cycle/);
});
test('PRNG state must be uint32; encoded tags are validated before decode', () => {
  // A well-formed tagged state round-trips.
  const good = { format: 'seaguard.fleet', version: VERSION, savedAt: 1, globals: {}, nodes: { fn0007: { S: { r: { __tag: PRNG_TAG, state: 0xDEADBEEF } } } } };
  const out = decode(good);
  assert.equal(typeof out.nodes.fn0007.S.r, 'function');
  // state above 2^32-1, negative, or non-integer is rejected.
  for (const s of [0x100000000, -1, 1.5]) {
    const doc = { ...good, nodes: { fn0007: { S: { r: { __tag: PRNG_TAG, state: s } } } } };
    assert.throws(() => decode(doc), /uint32|PRNG/);
  }
  // extra keys on a tagged object are rejected (malformed tag).
  assert.throws(() => decode({ ...good, nodes: { fn0007: { S: { r: { __tag: PRNG_TAG, state: 5, extra: 1 } } } } }), /PRNG/);
});

// ------------------------------------------------- atomic save, backup and fallback
test('save/load roundtrip keeps pending+confirmed notifications and trip buffers exactly', () => {
  const st = freshStore('roundtrip');
  const snap = liveSnapshot();
  const s1 = st.save(snap);
  assert.ok(s1.ok, s1.error);
  const l1 = st.load();
  assert.ok(l1.ok && l1.restored, l1.error);
  assert.equal(l1.data.globals.epoch, 7);
  assert.deepEqual(l1.data.globals.notifications.filter(n => n.status !== 'RETRY'),
    snap.globals.notifications.filter(n => n.status !== 'SENDING'));
  assert.deepEqual(l1.data.globals.syncStore, snap.globals.syncStore);
  assert.deepEqual(l1.data.nodes.fn0006.S, snap.nodes.fn0006.S);
  assert.equal(l1.meta.uncertainSending, 1);
  const sent = l1.data.globals.notifications.find(n => n.id === 'INC-3/coastguard');
  assert.equal(sent.status, 'RETRY');
  assert.equal(sent.inflight, false);
  assert.match(sent.lastError, /uncertain/);
  assert.equal(sent.deliveryUncertain, true, 'durable restore-uncertainty boolean set on the globals copy');
  const delivered = l1.data.globals.notifications.find(n => n.id === 'INC-1/family');
  assert.equal(delivered.status, 'DELIVERED'); // terminal rows are never requeued
  assert.equal(delivered.attempts, 1);
  // both persisted copies of the notifier list are normalized and still agree
  assert.deepEqual(l1.data.nodes.fn0029.S.list, l1.data.globals.notifications);
  assert.equal(l1.data.nodes.fn0029.S.list.find(n => n.id === 'INC-3/coastguard').status, 'RETRY');
  assert.equal(l1.data.nodes.fn0029.S.list.find(n => n.id === 'INC-3/coastguard').deliveryUncertain, true, 'durable flag set on the node-context copy too');
});
test('load forces simRunning=false (explicit) and keeps the clock frozen at the saved value', () => {
  const st = freshStore('paused');
  // Saved while running; restore must explicitly pause it.
  assert.ok(st.save(liveSnapshot({ globals: { epoch: 7, simTime: 3600, simSpeed: 2, simRunning: true, mode: 'test', runSeed: 1234, notifications: [], syncStore: {} } })).ok);
  const l = st.load();
  assert.equal(l.data.globals.simRunning, false);
  assert.equal(l.data.globals.simTime, 3600);
  assert.equal(l.data.globals.simSpeed, 2);
});
test('corrupt primary falls back to the previous-good backup across repeated saves', () => {
  const st = freshStore('fallback');
  const dir = path.join(TEMP, 'fallback');
  const primary = path.join(dir, 'fleet.json');
  const backup = path.join(dir, 'fleet.backup.json');
  const snapAt = e => liveSnapshot({ globals: { epoch: e, simTime: e * 100, simSpeed: 1, simRunning: false, mode: 'test', runSeed: 1, notifications: [], syncStore: {} } });
  const corrupt = () => fs.writeFileSync(primary, '{"format":"seaguard.fleet","version":1,"savedAt":9,', 'utf8');
  const expectBackup = (epoch, label) => {
    const l = st.load();
    assert.ok(l.ok && l.restored, label + ': ' + l.error);
    assert.equal(l.meta.source, 'backup');
    assert.equal(l.data.globals.epoch, epoch);
    assert.ok(fs.existsSync(backup));
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(backup, 'utf8'))); // backup stays valid
  };
  assert.ok(st.save(snapAt(1)).ok);
  assert.ok(st.save(snapAt(2)).ok); // backup now holds the epoch-1 document
  corrupt();
  expectBackup(1, 'after save 2');
  // repeated saves while the primary is corrupt must keep the backup valid, not lose it
  assert.ok(st.save(snapAt(3)).ok);
  corrupt();
  expectBackup(1, 'after save 3');
  assert.ok(st.save(snapAt(4)).ok);
  assert.ok(st.save(snapAt(5)).ok); // backup now holds the epoch-4 document
  corrupt();
  expectBackup(4, 'after save 5');
  // after the cycle the store still saves and loads normally
  assert.ok(st.save(snapAt(99)).ok);
  const l = st.load();
  assert.equal(l.meta.source, 'primary');
  assert.equal(l.data.globals.epoch, 99);
});
test('a write error leaves the previous snapshot and live state intact', () => {
  const st = freshStore('writeerr');
  const dir = path.join(TEMP, 'writeerr');
  const snap = liveSnapshot({ globals: { epoch: 3, simTime: 50, simSpeed: 1, simRunning: false, mode: 'test', runSeed: 1, notifications: [], syncStore: {} } });
  // Keep live references to the pending rows and trip buffers so we can prove they survive.
  const livePending = snap.nodes.fn0006.S.boats.B1.pending;
  const liveSync = snap.globals.syncStore;
  const liveNotifs = snap.globals.notifications;
  assert.ok(st.save(snap).ok);
  fs.rmSync(path.join(dir, 'fleet.json'));
  fs.mkdirSync(path.join(dir, 'fleet.json')); // rename target is a directory -> rename must fail
  const r = st.save(snap);
  assert.equal(r.ok, false);
  assert.ok(r.error);
  const s = st.status();
  assert.equal(s.ok, false);
  assert.ok(s.error);
  // live in-memory state is untouched by the failed save: same references, same pending rows
  assert.equal(snap.globals.epoch, 3);
  assert.equal(snap.globals.simTime, 50);
  assert.equal(snap.nodes.fn0006.S.boats.B1.pending, livePending);
  assert.equal(snap.globals.syncStore, liveSync);
  assert.equal(snap.globals.notifications, liveNotifs);
  assert.deepEqual(livePending, [{ eid: 'B1-1', pkt: { k: 'E', ev: 'CAPSIZE', eid: 'B1-1', b: 'B1', ep: 7, s: 1, t: 90, la: 51.5, lo: 0.1, d: { roll: 32 }, rt: 1 }, tries: 1, firstAt: 90, nextAt: 92 }]);
  // the store falls back to the last valid backup document
  const l = st.load();
  assert.ok(l.ok && l.restored, l.error);
  assert.equal(l.meta.source, 'backup');
  const bak = JSON.parse(fs.readFileSync(path.join(dir, 'fleet.backup.json'), 'utf8'));
  assert.equal(bak.format, 'seaguard.fleet');
  assert.equal(bak.version, VERSION);
  fs.rmdirSync(path.join(dir, 'fleet.json'));
  assert.ok(st.save(snap).ok); // store recovers once the fault is cleared
  assert.equal(st.load().data.globals.epoch, 3);
});
test('fresh store loads as un-restored with clean status; both-corrupt reports an error', () => {
  const st = freshStore('fresh');
  const l = st.load();
  assert.ok(l.ok && !l.restored);
  assert.equal(st.status().error, null);
  const st2 = freshStore('bothbad');
  fs.mkdirSync(path.join(TEMP, 'bothbad'), { recursive: true });
  fs.writeFileSync(path.join(TEMP, 'bothbad', 'fleet.json'), 'not json', 'utf8');
  fs.writeFileSync(path.join(TEMP, 'bothbad', 'fleet.backup.json'), 'also not json', 'utf8');
  const l2 = st2.load();
  assert.equal(l2.ok, false);
  assert.match(l2.error, /primary/);
  assert.match(l2.error, /backup/);
});

// ------------------------------------------------------------- static fixture file
test('static fixture with pending/delivered notifications and trip buffers retains exactly', () => {
  const fixturePath = path.join(FIX, 'fleet-pending-trips.json');
  const fixture = {
    format: 'seaguard.fleet', version: VERSION, savedAt: 1750000000000,
    globals: {
      epoch: 4, simTime: 7200, simSpeed: 1, simRunning: false, mode: 'test', runSeed: 77,
      notifications: [
        { id: 'INC-9/family', ref: 'INC-9', incident: 'INC-9', kind: 'SOS', role: 'family', chat: 'family-demo', severity: 3, text: 'sos', status: 'RETRY', attempts: 2, created: 7180, nextAt: 7205, inflight: false, deliveredAt: null, lastError: 'no response' },
        { id: 'INC-9/coastguard', ref: 'INC-9', incident: 'INC-9', kind: 'SOS', role: 'coastguard', chat: 'coastguard-demo', severity: 3, text: 'sos', status: 'DELIVERED', attempts: 1, created: 7180, nextAt: 7180, sentAt: 7190, inflight: false, deliveredAt: 7191, lastError: null },
        { id: 'INC-10/family', ref: 'INC-10', incident: 'INC-10', kind: 'FLOOD', role: 'family', chat: 'family-demo', severity: 2, text: 'flood', status: 'QUEUED', attempts: 0, created: 7200, nextAt: 7200, inflight: false, deliveredAt: null, lastError: null }
      ],
      syncStore: { B2: { count: 3, maxContig: 3, dupRecords: 1, batches: 2, firstT: 5, lastT: 15, recs: { 1: { t: 5, lat: 51.1, lon: 0.2 }, 2: { t: 10, lat: 51.11, lon: 0.21 }, 3: { t: 15, lat: 51.12, lon: 0.22 } } } },
      incidents: [{ id: 'INC-9', kind: 'SOS', boat: 'B2', opened: 7180, lastEventT: 7180, events: [{ t: 7180, type: 'SOS', source: 'onboard', eid: null, data: {} }], status: 'OPEN' }]
    },
    nodes: {
      fn0006: { S: { ep: 4, boats: { B2: { id: 'B2', seq: 4, lastTelem: 7150, hold: { roll: 0, flood: 0 }, latched: { capsize: false, flood: true }, tags: [], evN: 2, pending: [{ eid: 'E7', pkt: { ev: 'FLOOD', t: 7180 }, tries: 2 }], log: [{ s: 1, t: 5, lat: 51.1, lon: 0.2, spd: 1, roll: 0, lvl: 2, bat: 12.5, crew: 2 }, { s: 2, t: 10, lat: 51.11, lon: 0.21, spd: 1, roll: 0, lvl: 2, bat: 12.5, crew: 2 }, { s: 3, t: 15, lat: 51.12, lon: 0.22, spd: 1, roll: 0, lvl: 2, bat: 12.4, crew: 2 }], logSeq: 4, acked: 3, inflight: null, batchN: 2, adv: null, advCount: 0, stats: { sent: 2, retries: 1, acked: 3, gaveUp: 0, rttSum: 2.0, rttN: 2, dupAcks: 0, filtered: { roll: 0, splash: 0, tag: 0 }, syncBatches: 2, syncTimeouts: 0, syncErrors: 0 } } } } },
      fn0010: { G: { connected: true, forcedDown: false, ep: 4, buffer: [], stats: { fwd: 9, buffered: 0, bufDropped: 0, flushed: 0, down: 0 }, lastHb: 7190 } },
      fn0020: { M: { online: true, lastHb: 7190, reason: 'heartbeat' } }
    }
  };
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), 'utf8');
  const st = freshStore('fixture');
  fs.mkdirSync(path.join(TEMP, 'fixture'), { recursive: true });
  fs.copyFileSync(fixturePath, path.join(TEMP, 'fixture', 'fleet.json'));
  const l = st.load();
  assert.ok(l.ok && l.restored, l.error);
  assert.deepEqual(l.data.globals.notifications.map(n => n.id), ['INC-9/family', 'INC-9/coastguard', 'INC-10/family']);
  assert.deepEqual(l.data.globals.notifications.map(n => n.status), ['RETRY', 'DELIVERED', 'QUEUED']);
  assert.deepEqual(l.data.globals.syncStore, fixture.globals.syncStore);
  assert.deepEqual(l.data.nodes.fn0006.S.boats.B2.pending, [{ eid: 'E7', pkt: { ev: 'FLOOD', t: 7180 }, tries: 2 }]);
  assert.equal(l.data.globals.incidents.length, 1);
  assert.equal(l.data.globals.simRunning, false);
});

test('empty() is a valid versioned snapshot', () => {
  const doc = empty();
  validate(doc);
  assert.equal(doc.version, VERSION);
  const out = decode(doc);
  assert.deepEqual(out.globals.notifications, []);
});

test('arrays get the same depth/cycle checks as objects', () => {
  const self = []; self.push(self); // self-referential array
  assert.throws(() => encode({ globals: { layout: self }, nodes: {} }), /cycle/);
  const a = [], b = []; a.push(b); b.push(a); // two-array cycle
  assert.throws(() => encode({ globals: { layout: a }, nodes: {} }), /cycle/);
  // deep-but-acyclic arrays are fine
  let deep = 1;
  for (let i = 0; i < 20; i++) deep = [deep];
  assert.doesNotThrow(() => encode({ globals: { layout: deep }, nodes: {} }));
});

test('snapshot PRNG state must be a uint32', () => {
  const mk = state => ({ __tag: PRNG_TAG, state });
  const doc = (state) => ({ format: 'seaguard.fleet', version: VERSION, savedAt: 1750000000000, globals: {}, nodes: { fn000a: { S: { r: mk(state) } } } });
  // valid uint32 boundaries
  for (const ok of [0, 1, 4294967295]) assert.doesNotThrow(() => decode(doc(ok)), 'state ' + ok);
  // out of uint32 range / non-integer are rejected
  for (const bad of [-1, 4294967296, 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => decode(doc(bad)), /uint32|PRNG/);
  // the live rng() accessor must also only accept a uint32 state (throws at construction)
  assert.throws(() => rng(1, { __tag: PRNG_TAG, state: 4294967296 }), /uint32/);
  assert.doesNotThrow(() => rng(1, { __tag: PRNG_TAG, state: 4294967295 }));
});

test('encoded PRNG tags are validated before decoding', () => {
  const base = { format: 'seaguard.fleet', version: VERSION, savedAt: 1750000000000, globals: {}, nodes: {} };
  // well-formed tag revives to a working PRNG
  const good = decode(JSON.parse(JSON.stringify(Object.assign({}, base, { nodes: { fn000a: { S: { r: { __tag: PRNG_TAG, state: 99 } } } } }))));
  assert.equal(typeof good.nodes.fn000a.S.r, 'function');
  assert.deepEqual(good.nodes.fn000a.S.r.snapshot(), { __tag: PRNG_TAG, state: 99 });
  // tag present but extra key -> malformed, rejected (not silently treated as data)
  assert.throws(() => decode(Object.assign({}, base, { nodes: { fn000a: { S: { r: { __tag: PRNG_TAG, state: 99, extra: 1 } } } } })), /PRNG/);
  // tag present but non-uint32 state -> rejected
  assert.throws(() => decode(Object.assign({}, base, { nodes: { fn000a: { S: { r: { __tag: PRNG_TAG, state: 1e20 } } } } })), /PRNG|uint32/);
  // a different (non-PRNG) __tag is plain data, not revived
  const other = decode(Object.assign({}, base, { nodes: { fn000a: { S: { r: { __tag: 'something.else', state: 5 } } } } }));
  assert.deepEqual(other.nodes.fn000a.S.r, { __tag: 'something.else', state: 5 });
});

test('deliveredAt/sentAt are nullable timestamps; nextAt/created must be finite', () => {
  const mk = (over) => ({ globals: { epoch: 1, notifications: [Object.assign({ id: 'A/x', status: 'QUEUED', attempts: 0, inflight: false, deliveredAt: null, lastError: null }, over)], syncStore: {} }, nodes: {} });
  // null deliveredAt (never delivered) is valid
  assert.doesNotThrow(() => encode(mk({})), 'null deliveredAt');
  // finite deliveredAt is valid
  assert.doesNotThrow(() => encode(mk({ deliveredAt: 123, sentAt: 120 })), 'finite deliveredAt');
  // non-finite deliveredAt is rejected
  assert.throws(() => encode(mk({ deliveredAt: NaN })), /deliveredAt/);
  assert.throws(() => encode(mk({ deliveredAt: Infinity })), /deliveredAt/);
  // nextAt/created must be finite when present
  assert.throws(() => encode(mk({ nextAt: NaN })), /nextAt/);
});

test('simRunning is allowlisted and validated as a boolean', () => {
  const mk = v => ({ globals: { epoch: 1, simRunning: v, notifications: [], syncStore: {} }, nodes: {} });
  assert.doesNotThrow(() => encode(mk(true)));
  assert.doesNotThrow(() => encode(mk(false)));
  assert.throws(() => encode(mk('yes')), /simRunning/);
  assert.throws(() => encode(mk(1)), /simRunning/);
});

test('fleet/chan/linkHist are object maps keyed by id; the real arrays stay arrays', () => {
  const ok = encode({
    globals: {
      fleet: { B1: { lat: 51.5, lon: 0.1, rxT: 100 } },
      chan: { 'up:B1': { dropped: 0, dup: 0, held: 0 }, 'down:B1': { dropped: 1, dup: 0, held: 0 } },
      linkHist: { B1: [{ t0: 0, n: 5, lost: 0 }, { t0: 60, n: 4, lost: 1 }] },
      faults: [], incidents: [], eventLog: [], suppressions: [], linkLog: [], mockTelegram: []
    },
    nodes: {}
  });
  validate(ok);
  for (const k of ['fleet', 'chan', 'linkHist']) {
    assert.throws(() => encode({ globals: { [k]: [{ a: 1 }] }, nodes: {} }), /object map/);
  }
  for (const k of ['faults', 'incidents', 'eventLog', 'suppressions', 'linkLog', 'mockTelegram']) {
    assert.throws(() => encode({ globals: { [k]: { a: 1 } } }, { nodes: {} }), /array/);
  }
});

test('first successful save seeds the backup with the SAME document, not an empty world', () => {
  const st = freshStore('firstseed');
  const dir = path.join(TEMP, 'firstseed');
  const primary = path.join(dir, 'fleet.json');
  const snap = liveSnapshot({ globals: { epoch: 5, simTime: 100, simSpeed: 1, simRunning: false, mode: 'test', runSeed: 1, notifications: [], syncStore: {} } });
  assert.ok(st.save(snap).ok, st.save(snap) && st.save(snap).error);
  const bak = JSON.parse(fs.readFileSync(path.join(dir, 'fleet.backup.json'), 'utf8'));
  assert.equal(bak.globals.epoch, 5); // the user's real state, not empty()
  assert.equal(bak.globals.simTime, 100);
  // corrupt the FIRST primary: the non-empty world must survive via the backup
  fs.writeFileSync(primary, '{"broken":', 'utf8');
  const l = st.load();
  assert.ok(l.ok && l.restored, l.error);
  assert.equal(l.meta.source, 'backup');
  assert.equal(l.data.globals.epoch, 5);
  assert.equal(l.data.globals.simTime, 100);
});

test('readDoc treats ENOENT as missing but surfaces other read errors', () => {
  const st = freshStore('readerr');
  fs.mkdirSync(path.join(TEMP, 'readerr'), { recursive: true });
  fs.mkdirSync(path.join(TEMP, 'readerr', 'fleet.json')); // directory -> EISDIR on read
  const l = st.load();
  assert.equal(l.ok, false); // not silently "un-restored"
  assert.match(l.error, /primary/);
  assert.match(l.error, /cannot read|EISDIR/);
  // absent files remain a clean un-restored state
  const st2 = freshStore('readerr2');
  const l2 = st2.load();
  assert.ok(l2.ok && !l2.restored);
  assert.equal(st2.status().error, null);
});

test('vm realm plain objects and arrays are accepted; class instances are rejected', () => {
  // Node-RED runs function code in a vm realm: live objects carry a different
  // Object.prototype identity. They must still encode/validate/decode.
  const vmFleet = vm.runInNewContext('({ B1: { lat: 51.5, lon: 0.1, rxT: 100 } })');
  const vmLog = vm.runInNewContext('[{ t: 1, type: "x" }, { t: 2, type: "y" }]');
  const doc = encode({ globals: { fleet: vmFleet, eventLog: vmLog }, nodes: {} });
  validate(doc);
  const out = decode(doc);
  assert.deepEqual(out.globals.fleet, { B1: { lat: 51.5, lon: 0.1, rxT: 100 } });
  assert.deepEqual(out.globals.eventLog, [{ t: 1, type: 'x' }, { t: 2, type: 'y' }]);
  // cross-realm class instances are still unsupported data
  const vmDate = vm.runInNewContext('new Date(5)');
  assert.throws(() => encode({ globals: { test: vmDate }, nodes: {} }), /unsupported data/);
});

test('undefined optional fields are omitted; functions and unsupported values are not silently dropped', () => {
  const doc = encode({ globals: { test: { a: 1, b: undefined, c: null } }, nodes: {} });
  assert.deepEqual(doc.globals.test, { a: 1, c: null }); // undefined omitted, null kept
  assert.throws(() => encode({ globals: { test: { f: () => 1 } }, nodes: {} }), /function/);
  assert.throws(() => encode({ globals: { test: { d: new Date(5) } }, nodes: {} }), /unsupported data/);
});

test('fn0029 notifier context is validated (ep, list, retry metadata)', () => {
  const mk = S => ({ globals: { notifications: S.list || [] }, nodes: { fn0029: { S } } });
  assert.doesNotThrow(() => encode(mk({ ep: 7, list: [] })));
  assert.doesNotThrow(() => encode(mk({ ep: 7, list: [], nextTestId: 3, backlog: 0, backlogWarned: false })));
  assert.throws(() => encode(mk({ list: [] })), /ep/);
  assert.throws(() => encode(mk({ ep: -1, list: [] })), /ep/);
  assert.throws(() => encode(mk({ ep: 7 })), /list/);
  // A non-array list lands in the globals copy first (same value live), so the
  // rejection names globals.notifications; the missing-list case names S.list.
  assert.throws(() => encode(mk({ ep: 7, list: 'nope' })), /notifications must be an array/);
  assert.throws(() => encode(mk({ ep: 7, list: [], nextTestId: -2 })), /nextTestId/);
  assert.throws(() => encode(mk({ ep: 7, list: [{ id: 'A', status: 'MAYBE' }] })), /status/);
  assert.throws(() => encode(mk({ ep: 7, list: [{ id: 'A', status: 'QUEUED' }, { id: 'A', status: 'QUEUED' }] })), /unique/);
});

test('globals.notifications and fn0029.S.list must agree; SENDING is normalized in both', () => {
  const mk = (gList, sList) => ({ globals: { notifications: gList }, nodes: { fn0029: { S: { ep: 7, list: sList } } } });
  const row = (id, status) => ({ id, status, attempts: 1, created: 1, nextAt: 1, inflight: status === 'SENDING', deliveredAt: null, lastError: null });
  // agreeing copies with a SENDING row: valid, and restore normalizes BOTH copies
  const st = freshStore('agree');
  const snap = mk([row('A/x', 'SENDING'), row('B/y', 'QUEUED')], null);
  snap.nodes.fn0029.S.list = snap.globals.notifications; // same reference, as live
  assert.ok(st.save(snap).ok, st.save(snap).error);
  const l = st.load();
  assert.ok(l.ok && l.restored, l.error);
  assert.equal(l.meta.uncertainSending, 1); // counted once, not once per copy
  assert.equal(l.data.globals.notifications[0].status, 'RETRY');
  assert.equal(l.data.nodes.fn0029.S.list[0].status, 'RETRY');
  assert.equal(l.data.globals.notifications[0].deliveryUncertain, true, 'flag set on the globals copy');
  assert.equal(l.data.nodes.fn0029.S.list[0].deliveryUncertain, true, 'flag set on the node-context copy');
  assert.equal(l.data.globals.notifications[1].deliveryUncertain, undefined, 'non-SENDING rows are not flagged');
  assert.deepEqual(l.data.nodes.fn0029.S.list, l.data.globals.notifications);
  // disagreeing copies are rejected at save time
  assert.throws(() => encode(mk([row('A/x', 'SENDING')], [row('A/x', 'QUEUED')])), /same list/);
  // only one copy present is fine (the other was never persisted)
  assert.doesNotThrow(() => encode({ globals: { notifications: [row('A/x', 'QUEUED')] }, nodes: {} }));
});

// ----------------------------------------------------------------------------- report
const failed = outcomes.filter(o => !o.passed);
const report = {
  task: 'fleet-persistence', date: new Date().toISOString(),
  module: 'seaguard/src/fleet/persistence.cjs',
  format: 'seaguard.fleet', version: VERSION,
  rng: 'mulberry32 (identical to legacy lib.rng), tagged state ' + PRNG_TAG,
  allowlist: { globals: ALLOWLIST.globals.length, nodes: Object.keys(ALLOWLIST.nodes).length },
  tests: outcomes, passed: outcomes.length - failed.length, failed: failed.length
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ passed: report.passed, failed: report.failed, of: outcomes.length }, null, 0));
for (const o of failed) console.error('FAIL', o.name, '-', o.error);
process.exit(failed.length ? 1 : 0);
