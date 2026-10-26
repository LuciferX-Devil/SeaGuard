'use strict';
// SeaGuard fleet snapshot store (standalone, no Node-RED runtime required).
// Persists the allowlisted fleet globals and node context keys as a versioned
// pure-data snapshot with atomic checked writes and previous-good backup.
// Design: coordination/FLEET_PERSISTENCE_DESIGN.md
const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 'seaguard.fleet';
const VERSION = 1;
const PRNG_TAG = 'seaguard.mulberry32.v1';
// Tagged revival ONLY for the allowlisted shore-ingest (fn001d) dedup/gap/event-ID
// sets, which the live function keeps as (vm-realm) Set instances in context S.
const SET_TAG = 'seaguard.fleet.set.v1';
// The `what` path encodeValue/decodeValue builds for fn001d context S is
// 'nodes.fn001d.S' + '.' + <key path>. Sets are accepted/revived ONLY at these
// three leaf fields per boat; anywhere else a Set (or a SET_TAG object) is rejected.
const SHORE_SET_PATH = /^nodes\.fn001d\.S\.L\.([^.]+)\.(seen|missing|eids)$/;
// seen/missing hold positive sequence numbers; 10^7 is far above any realistic
// per-boat window and bounds the tagged items arrays.
const SHORE_SET_MAX_SEQ = 10000000;
// Which shore field a `what` path points at ('seen'|'missing'|'eids'), or null
// when the path is not one of the three allowlisted leaves. The [^.]+ boat
// segment rejects nested paths such as S.L.<boat>.extra.seen.
function shoreSetField(what) {
  const m = SHORE_SET_PATH.exec(what);
  return m ? m[2] : null;
}
const NOTIFICATION_STATUSES = ['QUEUED', 'SENDING', 'RETRY', 'DELIVERED', 'FAILED'];
const MODES = ['test', 'live'];
const LIMITS = { maxBytes: 8 * 1024 * 1024, maxDepth: 24, maxArray: 20000, maxKey: 128, maxString: 65536 };

// Explicit allowlists from the design. Never cfg/lib/credentials/services/timers.
const ALLOWLIST = Object.freeze({
  globals: Object.freeze([
    'epoch', 'simTime', 'simSpeed', 'simRunning', 'mode', 'runSeed', 'layout', 'test', 'faults', 'incidents',
    'eventLog', 'suppressions', 'linkLog', 'linkHist', 'chan', 'syncStore', 'fleet', 'fw', 'truth',
    'geo', 'weather', 'seaState', 'notifications', 'corr', 'linkShore', 'gateway', 'gatewayShore', 'mockTelegram', 'mockDeliveryLedger', 'mockDeliverySeq'
  ]),
  // nodeId -> context keys persisted for that node. fn003a handle timer and UI/map caches excluded.
  nodes: Object.freeze({
    fn0006: ['S'], // firmware buffers (unsynced onboard records)
    fn0007: ['S'], // physics (contains the rng closure r)
    fn000a: ['S'], // Wi-Fi rng
    fn0010: ['G'], // gateway (connected/forcedDown/buffer/stats)
    fn0011: ['S'], // uplink
    fn0018: ['S'], // downlink
    fn001b: ['C'], // correlation counters/queues
    fn001c: ['S'], // geofence
    fn001d: ['S'], // shore ingest
    fn0020: ['M'], // gateway monitor (online/lastHb/reason)
    fn0028: ['S'], // weather
    fn0029: ['S']  // notifier list + retry metadata
  })
});

// mulberry32, byte-identical output stream to the old lib.rng(seed) in fn0002.
// rng(seed) starts fresh; rng(seed, state) continues from an encoded snapshot.
// fn.snapshot() is the pure-data accessor; fn.__tag marks the known PRNG.
function rng(seed, state) {
  let a;
  if (state && typeof state === 'object' && state.__tag === PRNG_TAG) {
    if (!isUint32(state.state)) throw bad('rng state must be a uint32');
    a = state.state >>> 0;
  } else {
    a = Number(seed) >>> 0;
  }
  const fn = function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  fn.__tag = PRNG_TAG;
  fn.snapshot = () => ({ __tag: PRNG_TAG, state: a >>> 0 });
  return fn;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  if (p === null || p === Object.prototype) return true;
  // Node-RED executes function code in a vm realm, so live objects can carry a
  // DIFFERENT Object.prototype. Accept any realm's Object.prototype, still reject
  // Date/Map/class instances (their prototype's constructor is not named Object).
  const c = p.constructor;
  return typeof c === 'function' && c.name === 'Object' && c.prototype === p;
}

function isTaggedPrng(v) {
  return typeof v === 'function' && v.__tag === PRNG_TAG && typeof v.snapshot === 'function';
}

// Cross-realm Set detector: Node-RED function code runs in a vm realm, so live
// Sets fail `instanceof Set` here. Match by prototype constructor name, exactly
// like isPlainObject does for objects (rejects subclass/class Set lookalikes).
function isSet(v) {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  if (!p) return false;
  const c = p.constructor;
  return typeof c === 'function' && c.name === 'Set' && c.prototype === p;
}

// Per-field member rules (product fn001d already enforces these shapes):
// seen/missing are positive sequence integers <= 10^7; eids are non-empty
// event-ID strings <= 100 chars. A null field (non-shore path) keeps the old
// generic rule so the path allowlist stays the primary rejection there.
function validSetItem(x, field) {
  if (field === 'eids') return typeof x === 'string' && x.length >= 1 && x.length <= 100;
  if (field === 'seen' || field === 'missing') return Number.isSafeInteger(x) && x >= 1 && x <= SHORE_SET_MAX_SEQ;
  return Number.isSafeInteger(x) || (typeof x === 'string' && x.length >= 1 && x.length <= 100);
}

function checkSetTagShape(v, what) {
  if (!isPlainObject(v)) throw bad(what + ' has a malformed Set tag');
  if (Object.keys(v).length !== 2 || !Array.isArray(v.items)) throw bad(what + ' has a malformed Set tag (must be {__tag, items})');
  if (v.items.length > LIMITS.maxArray) throw bad(what + ' Set items exceed limit');
  const field = shoreSetField(what);
  const dup = new Set();
  for (let i = 0; i < v.items.length; i++) {
    const x = v.items[i];
    if (!validSetItem(x, field)) throw bad(what + ' Set items[' + i + '] is invalid for field ' + (field || 'shore') + ' (seen/missing: positive integer <= 10000000; eids: non-empty string <= 100)');
    // A revived Set dedupes: duplicate items would silently shrink the Set,
    // making the tagged cardinality ambiguous.
    if (dup.has(x)) throw bad(what + ' Set items[' + i + '] is duplicated (ambiguous cardinality)');
    dup.add(x);
  }
}

function bad(msg) { const e = new Error('Invalid fleet snapshot: ' + msg); e.code = 'FLEET_SNAPSHOT_INVALID'; return e; }

// Walk a live (or pure-data) value tree, copying plain data and encoding the
// known PRNG closure as a tagged pure-data object. Everything else must be
// finite plain data; functions, dates, maps, prototypes and cycles are rejected.
function encodeValue(v, what, depth, seen) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw bad(what + ' has a non-finite number');
    return v;
  }
  if (typeof v === 'string') {
    if (v.length > LIMITS.maxString) throw bad(what + ' has an oversized string');
    return v;
  }
  if (isTaggedPrng(v)) {
    const s = v.snapshot();
    if (!s || s.__tag !== PRNG_TAG || !isUint32(s.state)) throw bad(what + ' has an invalid PRNG state (must be uint32)');
    return { __tag: PRNG_TAG, state: s.state >>> 0 };
  }
  if (isSet(v)) {
    const field = shoreSetField(what);
    if (!field) throw bad(what + ' has a Set outside the allowlisted shore fields (fn001d S.L.<boat>.seen|missing|eids)');
    if (v.size > LIMITS.maxArray) throw bad(what + ' Set exceeds ' + LIMITS.maxArray + ' members');
    if (seen.has(v)) throw bad(what + ' contains a cycle');
    seen.add(v);
    // Allocate with THIS realm's Array (cross-realm v.map would leak a foreign prototype).
    const items = [];
    for (const x of v) {
      if (!validSetItem(x, field)) throw bad(what + ' Set has an unsupported member for field ' + field + ' (seen/missing: positive integer <= 10000000; eids: non-empty string <= 100)');
      items.push(x);
    }
    seen.delete(v);
    return { __tag: SET_TAG, items };
  }
  if (typeof v === 'function') throw bad(what + ' contains a function');
  if (Array.isArray(v)) {
    if (v.length > LIMITS.maxArray) throw bad(what + ' array exceeds ' + LIMITS.maxArray + ' elements');
    if (depth > LIMITS.maxDepth) throw bad(what + ' exceeds nesting depth');
    if (seen.has(v)) throw bad(what + ' contains a cycle');
    seen.add(v);
    // Allocate with THIS realm's Array: v.map() would use the cross-realm
    // constructor for Node-RED vm-realm arrays, leaking a foreign prototype.
    const out = [];
    for (let i = 0; i < v.length; i++) out.push(encodeValue(v[i], what + '[' + i + ']', depth + 1, seen));
    seen.delete(v);
    return out;
  }
  if (isPlainObject(v)) {
    if (depth > LIMITS.maxDepth) throw bad(what + ' exceeds nesting depth');
    if (seen.has(v)) throw bad(what + ' contains a cycle');
    // A plain object may itself carry the Set tag (live or from a prior encode).
    // Validate its shape BEFORE recursing so an oversized or malformed items
    // array fails with the Set-specific message, not the generic array-limit
    // message from the child walk.
    if (v.__tag === SET_TAG) checkSetTagShape(v, what);
    seen.add(v);
    const out = {};
    for (const k of Object.keys(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw bad(what + ' has a prototype key');
      if (k.length > LIMITS.maxKey) throw bad(what + ' has an oversized key');
      // Live objects may carry explicitly-undefined optional fields: omit them
      // (matching JSON semantics). Functions and other unsupported values still
      // throw below and are never silently dropped.
      if (v[k] === undefined) continue;
      out[k] = encodeValue(v[k], what + '.' + k, depth + 1, seen);
    }
    // Validate an encoded PRNG tag before it can be decoded: exactly {__tag, state:uint32}.
    if (out.__tag === PRNG_TAG) {
      if (Object.keys(out).length !== 2 || !isUint32(out.state)) throw bad(what + ' has a malformed PRNG state');
    }
    // A live plain object may itself carry the Set tag; validate its shape so a
    // hand-built {__tag, items} cannot smuggle bad items through encoding, and
    // enforce the SAME path allowlist decodeValue enforces, so a validated
    // snapshot is always loadable.
    if (out.__tag === SET_TAG) {
      checkSetTagShape(out, what);
      if (!SHORE_SET_PATH.test(what)) throw bad(what + ' has a Set tag outside the allowlisted shore fields (fn001d S.L.<boat>.seen|missing|eids)');
    }
    seen.delete(v);
    return out;
  }
  throw bad(what + ' has unsupported data (' + (v && v.constructor ? v.constructor.name : typeof v) + ')');
}

// Revive a validated pure-data value tree; only the tagged PRNG becomes a function.
function decodeValue(v, what, depth, seen) {
  if (v === null || typeof v !== 'object') return v;
  if (v.__tag === PRNG_TAG) {
    if (Object.keys(v).length !== 2 || !isUint32(v.state)) throw bad(what + ' has a malformed PRNG state (must be uint32)');
    return rng(0, { __tag: PRNG_TAG, state: v.state });
  }
  if (v.__tag === SET_TAG) {
    checkSetTagShape(v, what);
    if (!SHORE_SET_PATH.test(what)) throw bad(what + ' has a Set tag outside the allowlisted shore fields (fn001d S.L.<boat>.seen|missing|eids)');
    // Revive with THIS realm's Set: .has/.add/.delete/.values/.size all work
    // cross-realm, and fn001d only uses those members.
    return new Set(v.items);
  }
  if (typeof v === 'function') throw bad(what + ' contains a function');
  if (Array.isArray(v)) {
    if (v.length > LIMITS.maxArray) throw bad(what + ' array exceeds limit');
    if (depth > LIMITS.maxDepth) throw bad(what + ' exceeds nesting depth');
    if (seen.has(v)) throw bad(what + ' contains a cycle');
    seen.add(v);
    const out = [];
    for (let i = 0; i < v.length; i++) out.push(decodeValue(v[i], what + '[' + i + ']', depth + 1, seen));
    seen.delete(v);
    return out;
  }
  if (isPlainObject(v)) {
    if (depth > LIMITS.maxDepth) throw bad(what + ' exceeds nesting depth');
    if (seen.has(v)) throw bad(what + ' contains a cycle');
    seen.add(v);
    const out = {};
    for (const k of Object.keys(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw bad(what + ' has a prototype key');
      out[k] = decodeValue(v[k], what + '.' + k, depth + 1, seen);
    }
    seen.delete(v);
    return out;
  }
  throw bad(what + ' has unsupported data');
}

function isNonNegSafeInt(v) { return Number.isSafeInteger(v) && v >= 0; }
// PRNG state is an unsigned 32-bit integer (the mulberry32 accumulator, stored >>> 0).
function isUint32(v) { return Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF; }
// A timestamp that may legitimately be null (e.g. deliveredAt before delivery) or absent.
function isNullableTime(v) { return v === null || v === undefined || Number.isFinite(v); }

function validateNotifications(v, what) {
  if (!Array.isArray(v)) throw bad(what + ' must be an array');
  if (v.length > LIMITS.maxArray) throw bad(what + ' exceeds limit');
  const ids = new Set();
  for (let i = 0; i < v.length; i++) {
    const r = v[i], w = what + '[' + i + ']';
    if (!isPlainObject(r)) throw bad(w + ' must be an object');
    if (typeof r.id !== 'string' || r.id.length < 1 || r.id.length > LIMITS.maxKey) throw bad(w + '.id must be a non-empty string');
    if (ids.has(r.id)) throw bad(w + '.id is not unique');
    ids.add(r.id);
    if (!NOTIFICATION_STATUSES.includes(r.status)) throw bad(w + '.status must be one of ' + NOTIFICATION_STATUSES.join(','));
    if (r.attempts !== undefined && !isNonNegSafeInt(r.attempts)) throw bad(w + '.attempts must be a non-negative integer');
    if (r.inflight !== undefined && typeof r.inflight !== 'boolean') throw bad(w + '.inflight must be a boolean');
    if (r.sentAt !== undefined && !isNullableTime(r.sentAt)) throw bad(w + '.sentAt must be finite or null');
    if (r.deliveredAt !== undefined && !isNullableTime(r.deliveredAt)) throw bad(w + '.deliveredAt must be finite or null');
    if (r.nextAt !== undefined && !Number.isFinite(r.nextAt)) throw bad(w + '.nextAt must be finite');
    if (r.created !== undefined && !Number.isFinite(r.created)) throw bad(w + '.created must be finite');
    if (r.status === 'DELIVERED' && (r.inflight === true || r.status === 'SENDING')) throw bad(w + ' terminal row must not be in flight');
    // null deliveredAt is legitimate only before delivery; a confirmed row must
    // carry a real finite timestamp (0 is a valid clock).
    if (r.status === 'DELIVERED' && (r.deliveredAt === undefined || !Number.isFinite(r.deliveredAt))) throw bad(w + '.deliveredAt must be a finite timestamp once delivered');
  }
}

// fn0029 notifier context: S = { ep, list, nextTestId?, backlog?, backlogWarned? }.
// list is the SAME array the notifier publishes as global 'notifications'.
function validateNotifierContext(v, what) {
  if (!isPlainObject(v)) throw bad(what + ' must be an object');
  if (!isNonNegSafeInt(v.ep)) throw bad(what + '.ep must be a non-negative safe integer');
  if (!Array.isArray(v.list)) throw bad(what + '.list must be an array');
  validateNotifications(v.list, what + '.list');
  if (v.nextTestId !== undefined && !isNonNegSafeInt(v.nextTestId)) throw bad(what + '.nextTestId must be a non-negative integer');
  if (v.backlog !== undefined && !isNonNegSafeInt(v.backlog)) throw bad(what + '.backlog must be a non-negative integer');
  if (v.backlogWarned !== undefined && typeof v.backlogWarned !== 'boolean') throw bad(what + '.backlogWarned must be a boolean');
}

function validateSyncStore(v, what) {
  if (v === undefined || v === null) return;
  if (!isPlainObject(v)) throw bad(what + ' must be an object');
  for (const boat of Object.keys(v)) {
    const st = v[boat], w = what + '.' + boat;
    if (!isPlainObject(st)) throw bad(w + ' must be an object');
    for (const k of ['count', 'maxContig', 'dupRecords', 'batches']) {
      if (st[k] !== undefined && !isNonNegSafeInt(st[k])) throw bad(w + '.' + k + ' must be a non-negative integer');
    }
    for (const k of ['firstT', 'lastT']) {
      if (st[k] !== undefined && !Number.isFinite(st[k])) throw bad(w + '.' + k + ' must be finite');
    }
    if (st.recs !== undefined) {
      if (!isPlainObject(st.recs)) throw bad(w + '.recs must be an object');
      const keys = Object.keys(st.recs);
      if (keys.length > LIMITS.maxArray) throw bad(w + '.recs exceeds limit');
      for (const s of keys) {
        const r = st.recs[s];
        if (!/^[1-9][0-9]*$/.test(s)) throw bad(w + '.recs has an invalid sequence key');
        if (!isPlainObject(r) || !Number.isFinite(r.t) || !Number.isFinite(r.lat) || Math.abs(r.lat) > 90 || !Number.isFinite(r.lon) || Math.abs(r.lon) > 180) {
          throw bad(w + '.recs[' + s + '] must be finite t/lat/lon within bounds');
        }
      }
    }
    // Semantic agreement with the persisted record map: count must equal the
    // number of unique persisted record keys, and maxContig must equal the
    // actual contiguous prefix starting at sequence 1. Accounting fields must
    // never claim records that are not present in the snapshot.
    if (st.count !== undefined) {
      if (!isPlainObject(st.recs)) throw bad(w + '.count is set but recs is missing');
      if (st.count !== Object.keys(st.recs).length) throw bad(w + '.count must equal the number of persisted record keys');
    }
    if (st.maxContig !== undefined) {
      const recs = isPlainObject(st.recs) ? st.recs : {};
      let prefix = 0;
      while (recs[String(prefix + 1)] !== undefined) prefix++;
      if (st.maxContig !== prefix) throw bad(w + '.maxContig must equal the contiguous record prefix');
    }
  }
}

// Incident statuses written by the correlation engine (fn001b).
const INCIDENT_STATUSES = Object.freeze(['OPEN', 'ACKED', 'RESOLVED']);

// Incident records as created by fn001b: plain objects with a unique id, a valid
// status, a finite opened clock and an events array of { t, type, ... } records.
// Restored engine code reads these fields unconditionally, so a corrupt present
// record (null, missing id/status/opened/events) must fail validation, not the
// restored run.
function validateIncidents(v, what) {
  if (!Array.isArray(v)) throw bad(what + ' must be an array');
  if (v.length > LIMITS.maxArray) throw bad(what + ' exceeds limit');
  const ids = new Set();
  for (let i = 0; i < v.length; i++) {
    const r = v[i], w = what + '[' + i + ']';
    if (!isPlainObject(r)) throw bad(w + ' must be an object');
    if (typeof r.id !== 'string' || r.id.length < 1 || r.id.length > LIMITS.maxKey) throw bad(w + '.id must be a non-empty string');
    if (ids.has(r.id)) throw bad(w + '.id is not unique');
    ids.add(r.id);
    if (!INCIDENT_STATUSES.includes(r.status)) throw bad(w + '.status must be one of ' + INCIDENT_STATUSES.join(','));
    if (!Number.isFinite(r.opened) || r.opened < 0) throw bad(w + '.opened must be a finite clock >= 0');
    if (!Array.isArray(r.events)) throw bad(w + '.events must be an array');
    if (r.events.length > LIMITS.maxArray) throw bad(w + '.events exceeds limit');
    for (let j = 0; j < r.events.length; j++) {
      const e = r.events[j], ew = w + '.events[' + j + ']';
      if (!isPlainObject(e)) throw bad(ew + ' must be an object');
      if (!Number.isFinite(e.t) || e.t < 0) throw bad(ew + '.t must be a finite clock >= 0');
      if (typeof e.type !== 'string' || e.type.length < 1) throw bad(ew + '.type must be a non-empty string');
    }
  }
}

function validateGlobals(v, what) {
  if (!isPlainObject(v)) throw bad(what + ' must be an object');
  for (const k of Object.keys(v)) {
    if (!ALLOWLIST.globals.includes(k)) throw bad(what + ' has a non-allowlisted global "' + k + '"');
  }
  if (v.epoch !== undefined && !isNonNegSafeInt(v.epoch)) throw bad(what + '.epoch must be a non-negative safe integer');
  if (v.simTime !== undefined && !Number.isFinite(v.simTime) || v.simTime < 0) throw bad(what + '.simTime must be a finite clock >= 0');
  if (v.simSpeed !== undefined && !Number.isFinite(v.simSpeed) || v.simSpeed < 0) throw bad(what + '.simSpeed must be finite >= 0');
  if (v.simRunning !== undefined && typeof v.simRunning !== 'boolean') throw bad(what + '.simRunning must be a boolean');
  if (v.mode !== undefined && !MODES.includes(v.mode)) throw bad(what + '.mode must be test or live');
  if (v.runSeed !== undefined && !isNonNegSafeInt(v.runSeed)) throw bad(what + '.runSeed must be a non-negative safe integer');
  if (v.notifications !== undefined) validateNotifications(v.notifications, what + '.notifications');
  if (v.syncStore !== undefined) validateSyncStore(v.syncStore, what + '.syncStore');
  // Arrays in the live system (fn003e/fn001b/fn0031 write sites).
  for (const k of ['faults', 'eventLog', 'suppressions', 'linkLog', 'mockTelegram']) {
    if (v[k] !== undefined && !Array.isArray(v[k])) throw bad(what + '.' + k + ' must be an array');
  }
  if (v.incidents !== undefined) validateIncidents(v.incidents, what + '.incidents');
  // Object maps keyed by boat/channel id (fn001d/fn0011/fn0018 write sites).
  for (const k of ['fleet', 'chan', 'linkHist']) {
    if (v[k] !== undefined && !isPlainObject(v[k])) throw bad(what + '.' + k + ' must be an object map');
  }
}

function validateNodes(v, what) {
  if (!isPlainObject(v)) throw bad(what + ' must be an object');
  for (const id of Object.keys(v)) {
    if (!ALLOWLIST.nodes[id]) throw bad(what + ' has a non-allowlisted node "' + id + '"');
    const ctx = v[id];
    if (!isPlainObject(ctx)) throw bad(what + '.' + id + ' must be an object');
    for (const k of Object.keys(ctx)) {
      if (!ALLOWLIST.nodes[id].includes(k)) throw bad(what + '.' + id + ' has a non-allowlisted context key "' + k + '"');
    }
    if (id === 'fn0029' && ctx.S !== undefined) validateNotifierContext(ctx.S, what + '.fn0029.S');
  }
}

function validate(doc) {
  if (!isPlainObject(doc)) throw bad('snapshot must be a plain object');
  if (doc.format !== FORMAT) throw bad('unknown format');
  if (doc.version !== VERSION) throw bad('unsupported version ' + JSON.stringify(doc.version));
  if (!Number.isFinite(doc.savedAt) || doc.savedAt < 0) throw bad('savedAt must be a finite timestamp >= 0');
  if (doc.globals === undefined || doc.nodes === undefined) throw bad('globals and nodes are required');
  validateGlobals(doc.globals, 'globals');
  validateNodes(doc.nodes, 'nodes');
  // In the live system fn0029 publishes its context list as global 'notifications'
  // (the SAME array), so the two persisted copies must agree, not diverge.
  const gList = doc.globals.notifications;
  const nList = doc.nodes.fn0029 && doc.nodes.fn0029.S && doc.nodes.fn0029.S.list;
  if (Array.isArray(gList) && Array.isArray(nList) && !sameValue(gList, nList)) {
    throw bad('globals.notifications and nodes.fn0029.S.list must be the same list');
  }
  // Whole-snapshot data walk: finite numbers, bounded depth/arrays, no functions or cycles.
  // Walk globals/nodes from their REAL roots ('globals'/'nodes'), not from a
  // 'snapshot' wrapper: the paths built here must be byte-identical to the ones
  // encode/decode build, so the shore Set path allowlist applies identically and
  // a validated snapshot is always loadable.
  encodeValue(doc.globals, 'globals', 0, new Set());
  encodeValue(doc.nodes, 'nodes', 0, new Set());
}

// Semantic deep-equality for already-validated pure data (key order insensitive).
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((el, i) => sameValue(el, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
}

// Encode a live {globals, nodes} snapshot into a versioned pure-data document.
function encode(snapshot) {
  if (!isPlainObject(snapshot)) throw bad('snapshot must be a plain object');
  for (const k of Object.keys(snapshot)) {
    if (k !== 'globals' && k !== 'nodes') throw bad('snapshot has an unexpected key "' + k + '"');
  }
  const globals = encodeValue(snapshot.globals === undefined ? {} : snapshot.globals, 'globals', 0, new Set());
  const nodes = {};
  const src = isPlainObject(snapshot.nodes) ? snapshot.nodes : {};
  for (const id of Object.keys(src)) {
    if (!ALLOWLIST.nodes[id]) throw bad('nodes has a non-allowlisted node "' + id + '"');
    const ctx = isPlainObject(src[id]) ? src[id] : null;
    if (!ctx) throw bad('nodes.' + id + ' must be an object');
    const out = {};
    for (const k of Object.keys(ctx)) {
      if (!ALLOWLIST.nodes[id].includes(k)) throw bad('nodes.' + id + ' has a non-allowlisted context key "' + k + '"');
      out[k] = encodeValue(ctx[k], 'nodes.' + id + '.' + k, 1, new Set());
    }
    nodes[id] = out;
  }
  const doc = { format: FORMAT, version: VERSION, savedAt: Date.now(), globals, nodes };
  validate(doc);
  if (Buffer.byteLength(JSON.stringify(doc), 'utf8') > LIMITS.maxBytes) throw bad('snapshot exceeds ' + LIMITS.maxBytes + ' bytes');
  return doc;
}

function decode(doc) {
  validate(doc);
  return {
    globals: decodeValue(doc.globals, 'globals', 0, new Set()),
    nodes: decodeValue(doc.nodes, 'nodes', 0, new Set())
  };
}

// A brand-new world: paused clock, fresh epoch, no history.
function empty() {
  return {
    format: FORMAT, version: VERSION, savedAt: 0,
    globals: { epoch: 0, simTime: 0, simSpeed: 1, simRunning: false, mode: 'test', runSeed: 0, notifications: [], syncStore: {} },
    nodes: {}
  };
}

function createStore({ dataDir } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('createStore requires dataDir');
  const primary = path.join(dataDir, 'fleet.json');
  const backup = path.join(dataDir, 'fleet.backup.json');
  const status = { ok: true, error: null, lastSave: null, lastLoad: null, source: null, version: VERSION, format: FORMAT };

  function readDoc(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') return null; // absent file is a clean "no data yet"
      throw bad('cannot read ' + path.basename(file) + ': ' + e.message); // EACCES/EISDIR/... must surface
    }
    if (Buffer.byteLength(raw, 'utf8') > LIMITS.maxBytes) throw bad(file + ' exceeds size limit');
    let doc;
    try { doc = JSON.parse(raw); } catch (e) { throw bad(file + ' is not valid JSON: ' + e.message); }
    validate(doc);
    return doc;
  }

  function applyDoc(doc, source) {
    const data = decode(doc);
    // A restored world is always paused: the clock stays frozen until an explicit resume.
    data.globals.simRunning = false;
    const meta = { loadedAt: Date.now(), source, version: doc.version, savedAt: doc.savedAt, uncertainSending: 0 };
    // SENDING rows may have been in flight when the process died; external delivery is
    // uncertain. Normalize them in BOTH persisted copies of the notifier list
    // (globals.notifications and nodes.fn0029.S.list are the same array live) so the
    // restored copies cannot disagree. Never claim exactly-once.
    // deliveryUncertain is the DURABLE boolean flag: lastError alone is not durable
    // because fn0029 overwrites it on every later retry error (HTTP 502, no response),
    // which would silently turn previously unknown delivery into false certainty.
    // The flag survives retry errors and budget-exhausted FAILED; fn0029 clears it
    // only on confirmed DELIVERED.
    const lists = [];
    if (Array.isArray(data.globals.notifications)) lists.push(data.globals.notifications);
    const s29 = data.nodes && data.nodes.fn0029 && data.nodes.fn0029.S;
    if (s29 && Array.isArray(s29.list)) lists.push(s29.list);
    const counted = new Set();
    for (const list of lists) {
      for (const r of list) {
        if (r.status === 'SENDING') {
          if (!counted.has(r.id)) { counted.add(r.id); meta.uncertainSending++; }
          r.status = 'RETRY';
          r.inflight = false;
          r.lastError = 'in-flight at restore; delivery uncertain';
          r.deliveryUncertain = true;
        }
      }
    }
    return { doc, data, meta };
  }

  return {
    status: () => ({ ...status, lastSave: status.lastSave && { ...status.lastSave }, lastLoad: status.lastLoad && { ...status.lastLoad } }),
    encode,
    decode,
    validate,
    empty,
    // Load the latest valid snapshot: primary first, previous-good backup as fallback.
    load() {
      try {
        let doc = null, source = null, pErr = null, bErr = null;
        try { doc = readDoc(primary); source = 'primary'; } catch (e) { pErr = e; }
        if (!doc) {
          try { doc = readDoc(backup); source = 'backup'; } catch (e) { bErr = e; }
        }
        if (!doc) {
          if (pErr || bErr) {
            status.ok = false; status.source = null;
            status.error = (pErr ? 'primary: ' + pErr.message : '') + (pErr && bErr ? ' | ' : '') + (bErr ? 'backup: ' + bErr.message : '');
            return { ok: false, restored: false, data: null, meta: null, error: status.error, status: this.status() };
          }
          status.ok = true; status.error = null; status.source = null; status.lastLoad = null;
          return { ok: true, restored: false, data: null, meta: null, status: this.status() };
        }
        const { data, meta } = applyDoc(doc, source);
        status.ok = true; status.error = null; status.source = source; status.lastLoad = { at: Date.now(), source };
        return { ok: true, restored: true, data, meta, status: this.status() };
      } catch (e) {
        status.ok = false; status.error = e.message; status.source = null;
        return { ok: false, restored: false, data: null, meta: null, error: e.message, status: this.status() };
      }
    },
    // Atomically write the snapshot: validate, write temp, read back and re-validate,
    // then rename over the primary, keeping the previous-good as backup.
    save(snapshot) {
      try {
        const doc = encode(snapshot);
        fs.mkdirSync(dataDir, { recursive: true });
        const tmp = path.join(dataDir, 'fleet.tmp-' + process.pid + '-' + Date.now() + '.json');
        const text = JSON.stringify(doc);
        fs.writeFileSync(tmp, text, 'utf8');
        try {
          const check = readDoc(tmp); // temp file must read back as a valid snapshot
          if (check.version !== VERSION) throw bad('temp re-read version mismatch');
          let prev = null;
          try { prev = readDoc(primary); } catch { /* corrupt/absent primary: backup remains authoritative */ }
          if (prev) {
            const prevText = JSON.stringify(prev);
            fs.writeFileSync(backup, prevText, 'utf8');
            readDoc(backup); // backup must itself validate before we trust the pair
          } else {
            // No previous-good primary: keep an existing valid backup, else seed it
            // with THIS same document so corrupting the first primary falls back to
            // the user's real state, not an empty world.
            let keep = null;
            try { keep = readDoc(backup); } catch { /* absent/corrupt backup */ }
            if (!keep) {
              fs.writeFileSync(backup, text, 'utf8');
              readDoc(backup);
            }
          }
          fs.renameSync(tmp, primary);
        } finally {
          try { fs.unlinkSync(tmp); } catch { /* already renamed */ }
        }
        status.ok = true; status.error = null;
        status.lastSave = { at: Date.now(), epoch: doc.globals.epoch || null, bytes: Buffer.byteLength(text, 'utf8') };
        return { ok: true, savedAt: doc.savedAt, bytes: Buffer.byteLength(text, 'utf8'), status: this.status() };
      } catch (e) {
        status.ok = false; status.error = e.message; // live in-memory state is untouched
        return { ok: false, error: e.message, status: this.status() };
      }
    }
  };
}

module.exports = { FORMAT, VERSION, PRNG_TAG, SET_TAG, NOTIFICATION_STATUSES, INCIDENT_STATUSES, LIMITS, ALLOWLIST, rng, createStore, encode, decode, validate, empty };
