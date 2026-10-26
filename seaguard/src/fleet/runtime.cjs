'use strict';
// SeaGuard fleet persistence RUNTIME adapter (standalone, no Node-RED runtime required).
// Sits between the allowlisted fleet function nodes and the snapshot store
// (persistence.cjs). The build injects two hooks around each wrapped fleet function
// body:
//   const __rt = global.get('fleetRuntime');
//   if (__rt && __rt.before('fnXXXX', context, global, msg) === false) return;
//   ... original body ...
//   __rt && __rt.after('fnXXXX', context, global, msg);
// The adapter is a no-op when the 'fleetRuntime' global is absent (old unit harnesses).
//
// Responsibilities (see coordination/FLEET_PERSISTENCE_DESIGN.md):
//  - initialize(global) ONCE: restore the latest valid snapshot. A restored world is
//    always paused (simRunning=false, clock frozen). A missing store is a clean fresh
//    world. An INVALID store blocks bootstrap and autosave with a visible error in
//    global.fleetSaveStatus - it must never overwrite the user's data.
//  - before(): register the live context refs, hydrate the saved allowlisted G/M/S/C
//    keys before the body, keep unvisited saved contexts in the cache, bind the
//    notifier global list to fn0029 S.list (one live array, both persisted copies),
//    and while a restored world is still paused suppress operational MQTT/tick bodies
//    (fn0010/fn004e) so saved queues are not flushed, tracking the real MQTT
//    connection state ephemerally instead.
//  - after(): re-capture allowlisted refs; periodic save on fn004e (publisher tick),
//    immediate save on fn0029 (notifier send/response), fn002e (sync commit), fn0031
//    (mock idempotency ledger) and fn003a stop/pause.
//  - save(global) serializes ONLY allowlisted globals and captured node contexts.
//    Never cfg/lib/credentials/services/timer handles. A failed save leaves live
//    state untouched and surfaces fleetSaveStatus.
//  - resume(global) is the ONLY thing that releases the restored pause: it sets
//    simRunning=true and applies the tracked MQTT connection without advancing the
//    clock. An ordinary pause (fn003a) never sets the hold, so in-flight responses
//    keep being accepted.
const store = require('./persistence.cjs');
const { createStore, rng, ALLOWLIST } = store;

const NOTIFIER = 'fn0029';   // notifier: S.list is the live list, published as global 'notifications'
const SYNC = 'fn002e';       // sync receiver: commits into global.syncStore
const LEDGER = 'fn0031';     // mock delivery idempotency ledger
const RUNCTRL = 'fn003a';    // run/pause/stop control
const NEWWORLD = 'fn003e';   // operator reset: must pass through a blocked adapter to recover
const PUBLISHER = 'fn004e';  // publisher tick (~1 real second): periodic save cadence; PRESENTATION ONLY
const GATEWAY = 'fn0010';    // gateway: MQTT connection status + buffered uplinks

// Operational fleet bodies suppressed while a restored world is still paused. The
// transport/monitor context nodes are held so that retained gateway birth/status
// and any stale buffered work do NOT flush saved queues or generate NEW incidents
// before an explicit resume:
//   fn0010 gateway (flushes saved uplink buffer on a connection transition),
//   fn0011 uplink / fn0018 downlink (would send/receive operational traffic),
//   fn001b correlation / fn001d shore ingest / fn0020 gateway monitor (would
//     correlate/ingest/monitor retained status and raise new incidents).
// The publisher (fn004e) is presentation only (dashboard state + resume button) and
// must keep running so a fresh browser can render the paused UI. Control nodes
// (fn003a run/pause/stop, fn003e reset) are never held so the operator stays in command.
const PAUSED_HOLD_NODES = new Set(['fn0010', 'fn0011', 'fn0018', 'fn001b', 'fn001d', 'fn0020']);

function createRuntime({ dataDir } = {}) {
  const st = createStore({ dataDir });
  const rt = {
    initialized: false,
    storeBlocked: false,   // invalid snapshot present: block bootstrap + autosave
    restored: false,       // a snapshot was actually restored
    pausedHold: false,     // restored world paused before an explicit resume
    ephemeralMqtt: null,   // real connection state tracked while gateway bodies were suppressed
    contexts: new Map(),   // nodeId -> { allowlistedKey: liveRef } (seeded from restore, refreshed in after)
    saves: 0,
    lastSave: null,
    lastError: null,
  };
  const ctxRefs = new Map(); // nodeId -> live context object (registered in before)

  function nodeKeys(id) { return ALLOWLIST.nodes[id] || null; }

  function setSaveStatus(global, ok, error, extra) {
    const s = st.status();
    global.set('fleetSaveStatus', {
      ok, error: error || null,
      // Keep the recovery flags on EVERY refresh (periodic/immediate saves), not just initialize.
      restored: rt.restored,
      blocked: rt.storeBlocked,
      pausedHold: rt.pausedHold,
      lastSave: s.lastSave ? { at: s.lastSave.at, bytes: s.lastSave.bytes, epoch: s.lastSave.epoch } : null,
      lastLoad: s.lastLoad ? { at: s.lastLoad.at, source: s.lastLoad.source } : null,
      source: s.source || null,
      saves: rt.saves,
      ...(extra || {}),
    });
  }

  // Serialize ONLY allowlisted keys from the live global context + captured refs.
  // Reads only: a failed save never mutates live state.
  function buildSnapshot(global) {
    const globals = {};
    for (const k of ALLOWLIST.globals) globals[k] = global.get(k);
    const nodes = {};
    for (const [id, saved] of rt.contexts) nodes[id] = { ...saved };
    return { globals, nodes };
  }

  function doSave(global, reason) {
    if (rt.storeBlocked) return { ok: false, error: 'fleet store blocked (invalid snapshot): ' + (rt.lastError || 'unknown'), blocked: true };
    let snap;
    try { snap = buildSnapshot(global); }
    catch (e) {
      rt.lastError = e.message;
      setSaveStatus(global, false, e.message, { reason });
      return { ok: false, error: e.message, reason };
    }
    const res = st.save(snap);
    if (res.ok) {
      rt.saves++;
      rt.lastSave = res.status.lastSave;
      rt.lastError = null;
      setSaveStatus(global, true, null, { reason, savedAt: res.savedAt, bytes: res.bytes });
    } else {
      rt.lastError = res.error;
      setSaveStatus(global, false, res.error, { reason });
    }
    return res;
  }

  // fn0029: one live array behind both persisted copies (global 'notifications' and
  // S.list), so the store's same-list validation always agrees.
  function bindNotifierList(context, global) {
    const S = context.get('S');
    if (S && Array.isArray(S.list)) { global.set('notifications', S.list); return S.list; }
    return null;
  }

  // Real mqtt-in connection-status message shape:
  //   { topic: 'mqttStatus', status: { text: 'node-red:common.status.connected' } }
  // or ...status.disconnected. Anything else is not a connection-status message.
  function mqttStatusOf(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const t = msg.status && typeof msg.status === 'object' ? msg.status.text : null;
    if (typeof t !== 'string') return null;
    if (t.includes('disconnected')) return 'offline'; // check first: 'disconnected' contains 'connected'
    if (t.includes('connected')) return 'online';
    return null;
  }

  // Apply the ephemerally-tracked real connection to the live gateway context
  // WITHOUT advancing the clock (no simTime write, no body execution).
  // Returns true once the tracked state has been applied (and is cleared).
  // If the gateway context has no G yet, the tracked state is KEPT and applied
  // on the gateway's next before() instead of being silently dropped.
  function applyTrackedMqtt(context) {
    if (!rt.ephemeralMqtt) return false;
    const G = context.get('G');
    if (!G || typeof G !== 'object') return false;
    G.connected = rt.ephemeralMqtt === 'online';
    context.set('G', G);
    rt.ephemeralMqtt = null;
    return true;
  }

  function initialize(global) {
    if (rt.initialized) return { ok: true, already: true, restored: rt.restored, blocked: rt.storeBlocked };
    rt.initialized = true;
    const res = st.load();
    if (!res.ok) {
      // Invalid snapshot present: block bootstrap and autosave, surface visibly.
      // Never fall back to an empty world over the user's data.
      rt.storeBlocked = true;
      rt.lastError = res.error;
      setSaveStatus(global, false, res.error, { blocked: true });
      return { ok: false, blocked: true, error: res.error };
    }
    if (res.restored) {
      rt.restored = true;
      rt.pausedHold = true; // a restored world is always paused until explicit resume
      const g = res.data.globals;
      for (const k of ALLOWLIST.globals) global.set(k, g[k]);
      // Seed the context cache for EVERY allowlisted node, visited or not: unvisited
      // saved contexts must survive until their node first runs (or the world is replaced).
      for (const [id, keys] of Object.entries(ALLOWLIST.nodes)) {
        const saved = res.data.nodes && res.data.nodes[id];
        if (saved) rt.contexts.set(id, { ...saved });
      }
      // Restore forces simRunning=false in the store; make the live global explicit.
      global.set('simRunning', false);
      setSaveStatus(global, true, null, { restored: true, source: res.status.source, meta: res.meta });
    } else {
      // Missing store: clean fresh world, nothing to hydrate, saves allowed.
      setSaveStatus(global, true, null, { restored: false });
    }
    return { ok: true, restored: rt.restored, meta: res.meta || null, source: res.status.source };
  }

  function before(id, context, global, msg) {
    // HTTP callers must receive a readiness response, rather than hang during bootstrap.
    if (!rt.initialized) return id === 'fn004f' || id === 'fn005d';
    // Blocked (corrupt store): everything is held EXCEPT the operator reset path
    // (fn003e), which must be allowed through so newWorld() can intentionally
    // recover and unblock the adapter, and the PRESENTATION nodes (publisher fn004e,
    // inspection API fn004f/fn005d) so the recovery error and restart control stay
    // visible. Their after() hooks still refuse autosave, so the corrupt file is safe.
    if (rt.storeBlocked && id !== NEWWORLD && id !== PUBLISHER && id !== 'fn004f' && id !== 'fn005d') return false;
    ctxRefs.set(id, context); // register live context refs for capture/hydration/resume
    const keys = nodeKeys(id);
    if (keys) {
      let saved = rt.contexts.get(id);
      if (!saved) { saved = {}; rt.contexts.set(id, saved); }
      for (const k of keys) if (k in saved) context.set(k, saved[k]);
    }
    if (id === NOTIFIER) bindNotifierList(context, global);
    if (rt.pausedHold && PAUSED_HOLD_NODES.has(id)) {
      if (id === GATEWAY) {
        const s = mqttStatusOf(msg);
        if (s) rt.ephemeralMqtt = s; // keep the ACTUAL connection state ephemerally
      }
      // Operator correlation commands (ack/resolve) never advance the clock or send
      // traffic, so they stay usable while a restored world is paused.
      if (id === 'fn001b' && msg && msg.topic === 'cmd') return true;
      return false; // hold: no flush of saved queues, no operational tick, no clock advance
    }
    // Hold released (or never restored): if a real connection state was tracked during
    // the hold and resume could not apply it (gateway not registered yet), apply it now,
    // on the gateway's first post-resume call. No clock advance either way.
    if (id === GATEWAY) applyTrackedMqtt(context);
    return true;
  }

  function after(id, context, global, msg) {
    if (!rt.initialized) return; // no-op: nothing captured or saved before initialize
    if (rt.storeBlocked) return;
    ctxRefs.set(id, context);
    const keys = nodeKeys(id);
    if (keys) {
      let saved = rt.contexts.get(id);
      if (!saved) { saved = {}; rt.contexts.set(id, saved); }
      for (const k of keys) {
        const v = context.get(k); // capture live refs
        if (v === undefined) delete saved[k]; else saved[k] = v;
      }
    }
    if (id === NOTIFIER) bindNotifierList(context, global);
    let reason = null;
    if (id === PUBLISHER) reason = 'periodic';
    else if (id === NOTIFIER || id === SYNC || id === LEDGER) reason = 'immediate';
    else if (id === RUNCTRL) {
      // Real clock-control shape: msg.payload = { cmd: 'stop' | 'pause' | 'run' }.
      const p = msg && msg.payload;
      const cmd = p && typeof p === 'object' ? p.cmd : p;
      if (cmd === 'stop' || cmd === 'pause') reason = 'immediate';
    }
    if (reason) doSave(global, reason);
  }

  function save(global) {
    if (!rt.initialized) return { ok: false, error: 'runtime not initialized' };
    return doSave(global, 'manual');
  }

  // The ONLY release of the restored pause. Sets simRunning=true, applies the
  // tracked MQTT connection (now if the gateway context is registered, else on the
  // gateway's first later before) and does NOT advance simTime: the frozen clock
  // continues from the saved value on the next tick body.
  function resume(global) {
    if (rt.storeBlocked) return { ok: false, blocked: true, error: rt.lastError };
    if (!rt.initialized) return { ok: false, error: 'runtime not initialized' };
    global.set('simRunning', true);
    const wasHold = rt.pausedHold;
    rt.pausedHold = false;
    if (wasHold && rt.ephemeralMqtt) {
      const ctx = ctxRefs.get(GATEWAY);
      if (ctx) applyTrackedMqtt(ctx);
      // else: keep rt.ephemeralMqtt; the gateway's next before() applies it
    }
    return { ok: true, resumedFromHold: wasHold };
  }

  // Explicit new campaign / clear world (fn003e): intentionally releases the pause
  // hold and clears the saved context cache so stale saved contexts are neither
  // hydrated into fresh nodes nor persisted over the new world.
  function newWorld(global) {
    rt.pausedHold = false;
    rt.ephemeralMqtt = null;
    rt.contexts.clear();
    // Explicit user reset must clear the failure state too, or a corrupt-store
    // recovery (initialize blocked) would be permanently stuck.
    rt.storeBlocked = false;
    rt.lastError = null;
    rt.restored = false;
    setSaveStatus(global, true, null, { newWorld: true });
    return { ok: true };
  }

  function status() {
    const s = st.status();
    return {
      initialized: rt.initialized,
      blocked: rt.storeBlocked,
      restored: rt.restored,
      pausedHold: rt.pausedHold,
      saves: rt.saves,
      lastSave: s.lastSave ? { ...s.lastSave } : null,
      lastLoad: s.lastLoad ? { ...s.lastLoad } : null,
      source: s.source || null,
      // Surface the store-level error only while blocked: an explicit newWorld
      // reset clears rt.lastError, and a stale load error must not linger.
      error: rt.storeBlocked ? (rt.lastError || s.error || null) : (rt.lastError || null),
      store: s,
    };
  }

  return {
    initialize, before, after, save, status, resume, newWorld,
    rng, // resumable mulberry32: rng(seed) or rng(seed, savedState) with fn.snapshot()
    allowlist: ALLOWLIST,
    _rt: rt, // test/inspection handle (not persisted)
  };
}

module.exports = { createRuntime, rng: store.rng, ALLOWLIST, NOTIFIER, SYNC, LEDGER, RUNCTRL, PUBLISHER, GATEWAY, PAUSED_HOLD_NODES };
