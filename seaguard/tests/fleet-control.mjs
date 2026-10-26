// SeaGuard fleet control microtask - offline focused tests.
// Covers: real clock resume/newWorld controls, gateway buffer/outage restoration,
// interrupted-EVALUATING recovery. Runs the GENERATED wrapped function bodies
// (flows.json) with the real persistence runtime, Map-backed get/set scopes and a
// captured-timer harness. No live Node-RED, no restarts, no real messages.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import runtimeMod from '../src/fleet/runtime.cjs';
import storeMod from '../src/fleet/persistence.cjs';

const { createRuntime } = runtimeMod;

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const flowsPath = path.join(ROOT, 'flows.json');
const reportPath = path.join(ROOT, 'reports', 'fleet-control.json');

assert.ok(fs.existsSync(flowsPath), 'flows.json missing - run `node seaguard/build.mjs` first');
const nodes = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
const funcOf = (id) => (byId[id] && byId[id].type === 'function' ? byId[id].func : null);

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
  return {
    statuses,
    send: (m) => { (Array.isArray(m) ? m : [m]).forEach((x) => { if (x) sends.push(x); }); },
    status: (s) => statuses.push(s),
    error: () => {}, debug: () => {},
  };
}

// Execute a generated (possibly wrapped) function body with Node-RED-style parameters.
function runBody(id, { global = makeScope(), context = makeScope(), msg = {}, node = null, sends = [] } = {}) {
  const fn = new Function('msg', 'node', 'context', 'global', 'flow', 'env', funcOf(id));
  const nodeFake = node || makeNode(sends);
  return { result: fn(msg, nodeFake, context, global, makeScope(), envFake), node: nodeFake };
}

// Timer harness: capture the clock control's setInterval/clearInterval without
// scheduling real timers, so ticks are driven manually and nothing leaks.
function timerHarness() {
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  const timers = [];
  globalThis.setInterval = (fn, ms) => { timers.push({ id: timers.length + 1, fn, ms, cleared: false }); return timers[timers.length - 1].id; };
  globalThis.clearInterval = (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; };
  return {
    timers,
    tick: () => { const t = timers[timers.length - 1]; if (t && !t.cleared) t.fn(); },
    restore: () => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; },
  };
}

// --- Valid live-shaped world snapshots (real record shapes) ---
function gwStats() { return { fwd: 3, buffered: 2, bufDropped: 0, flushed: 0, down: 0 }; }

function worldSnapshot(g = {}, n = {}) {
  const globals = Object.assign({
    epoch: 7, simTime: 3600, simSpeed: 2, simRunning: true, mode: 'live', runSeed: 1234,
    faults: [], notifications: [],
    gateway: { connected: true, forcedDown: false, buffered: 0, stats: gwStats(), t: 3599 },
  }, g);
  const G = Object.assign({ connected: true, forcedDown: false, ep: 7, buffer: [], stats: gwStats(), lastHb: -999 }, n.G);
  return { globals, nodes: { fn0010: { G } } };
}

const TEMP = path.join(here, 'fixtures', 'fleet-control');
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

// Boot a world exactly like the live flow: seed store -> createRuntime -> fn0002
// bootstrap (which calls rt.initialize and emits the restored/fresh command).
function setupWorld(name, snap, { corrupt = false } = {}) {
  const dir = seedDir(name, snap);
  if (corrupt) {
    // Corrupt BOTH primary and backup: a valid previous-good backup would be
    // restored, not blocked (load() falls back to it).
    const broken = '{"version": 1, "globals": {broken';
    fs.writeFileSync(path.join(dir, 'fleet.json'), broken);
    fs.writeFileSync(path.join(dir, 'fleet.backup.json'), broken);
  }
  const rt = createRuntime({ dataDir: dir });
  const global = makeScope();
  global.set('fleetRuntime', rt);
  const boot = runBody('fn0002', { global });
  return { dir, rt, global, boot };
}

// Operator resume through the real command router (fn0042) -> clock control (fn003a).
// clockSends captures the clock's REAL tick messages (node.send), which the tests
// feed to the gateway instead of hand-building them.
// clockCtx: the clock node's persistent context scope (one node = one context in
// Node-RED); without it the resume's internal stop() cannot find the running handle.
function resumeThroughRouter(global, clockSends, clockCtx) {
  const r = runBody('fn0042', { global, msg: { payload: { cmd: 'resume' } } });
  const clock = runBody('fn003a', { global, msg: r.result[0], sends: clockSends || [], context: clockCtx });
  return { router: r.result, clock };
}

function lastTick(clockSends) {
  const m = clockSends[clockSends.length - 1];
  assert.ok(m && m.topic === 'tick', 'clock sent a tick message');
  return m;
}

// ---------------------------------------------------------------------------
test('restored G buffer: intact through held reconnect, flushed exactly once on first tick', () => {
  const snap = worldSnapshot({}, { G: { buffer: [{ t: 3590, b: 'B1', d: 'x' }, { t: 3595, b: 'B2', d: 'y' }] } });
  const { rt, global } = setupWorld('buffer', snap);
  const gwCtx = makeScope();
  // Retained birth arrives during the restored hold: body skipped, buffer intact.
  const held = runBody('fn0010', { global, context: gwCtx, msg: { topic: 'mqttStatus', status: { text: 'node-red:common.status.connected' } } });
  assert.equal(held.result, null, 'held gateway body skipped');
  assert.equal(gwCtx.get('G').buffer.length, 2, 'buffer intact while held');
  // Uplink while held: no new buffering, no forwarding.
  const heldUp = runBody('fn0010', { global, context: gwCtx, msg: { topic: 'up', payload: { b: 'B3', d: 'z' } } });
  assert.equal(heldUp.result, null, 'held uplink skipped');
  assert.equal(gwCtx.get('G').buffer.length, 2, 'no new buffer entry while held');

  const harness = timerHarness();
  try {
    const clockSends = [];
    const r = runBody('fn0042', { global, msg: { payload: { cmd: 'resume' } } });
    assert.equal(r.result[1], null, 'non-EVALUATING resume does not route to the test controller');
    runBody('fn003a', { global, msg: r.result[0], sends: clockSends });
    assert.equal(global.get('simRunning'), true, 'clock running after explicit resume');
    assert.equal(rt.status().pausedHold, false, 'hold released by runtime.resume');
    assert.equal(harness.timers.length, 1, 'one clock interval started');

    // First tick after resume: flush the saved buffer once, with the original stats.
    harness.tick();
    const tickMsg = lastTick(clockSends);
    assert.equal(tickMsg.t, 3601, 'clock continues from the saved simTime');
    const tick1 = runBody('fn0010', { global, context: gwCtx, msg: tickMsg });
    const out1 = tick1.result && tick1.result[0];
    const pubs = (out1 || []).filter((m) => m.topic && String(m.topic).startsWith('seaguard/up/'));
    const hbs = (out1 || []).filter((m) => m.topic === 'seaguard/gateway/hb');
    const acts = (out1 || []).filter((m) => m.action);
    assert.equal(pubs.length, 2, 'both saved packets flushed on the first tick');
    assert.deepEqual(pubs.map((p) => p.payload.d), ['x', 'y'], 'flushed in saved order');
    assert.equal(hbs.length, 1, 'heartbeat still emitted on the first tick');
    assert.equal(acts.length, 0, 'no connect/disconnect churn on a healthy restore');
    const G1 = gwCtx.get('G');
    assert.equal(G1.buffer.length, 0, 'buffer cleared after flush');
    assert.equal(G1.stats.flushed, 2, 'original stats: flushed incremented');
    assert.equal(G1.stats.fwd, 5, 'original stats: fwd incremented per flushed packet');

    // Second healthy tick: nothing re-sent.
    harness.tick();
    const tick2 = runBody('fn0010', { global, context: gwCtx, msg: lastTick(clockSends) });
    const out2 = tick2.result && tick2.result[0];
    assert.ok(!out2 || out2.length === 0, 'repeated healthy tick transmits nothing');
    assert.equal(gwCtx.get('G').stats.flushed, 2, 'no duplicate flush on later ticks');
  } finally { harness.restore(); }
});

test('saved forcedDown + fresh connected client: outage disconnect re-issued on resume, not repeated', () => {
  const snap = worldSnapshot(
    { faults: [{ id: 'F1', type: 'GATEWAY_OUTAGE', boat: null, start: 3550, end: 3650, dur: 100, params: {} }] },
    { G: { forcedDown: true, connected: true } }
  );
  const { global } = setupWorld('outage', snap);
  const gwCtx = makeScope();
  const clockSends = [];
  const harness = timerHarness();
  try {
    resumeThroughRouter(global, clockSends);
    // First post-resume tick: outage still active (t=3601 < 3650), fresh client
    // connected -> the saved flag alone cannot control it, re-issue disconnect.
    harness.tick();
    const tick1 = runBody('fn0010', { global, context: gwCtx, msg: lastTick(clockSends) });
    const acts1 = ((tick1.result && tick1.result[0]) || []).filter((m) => m.action);
    assert.deepEqual(acts1, [{ action: 'disconnect' }], 'outage disconnect re-issued for the fresh client');
    // The fresh client actually disconnects -> mqttStatus disconnected (body runs now).
    runBody('fn0010', { global, context: gwCtx, msg: { topic: 'mqttStatus', status: { text: 'node-red:common.status.disconnected' } } });
    assert.equal(gwCtx.get('G').connected, false, 'fresh client now disconnected');
    // Second tick: no repeat disconnect (connected already false), no heartbeat.
    harness.tick();
    const tick2 = runBody('fn0010', { global, context: gwCtx, msg: lastTick(clockSends) });
    const out2 = tick2.result && tick2.result[0];
    assert.ok(!out2 || out2.every((m) => !m.action), 'disconnect not repeated once the client is down');
    // Outage ends at t=3650: existing restore behaviour (connect) preserved.
    while (global.get('simTime') < 3651) harness.tick();
    const tick3 = runBody('fn0010', { global, context: gwCtx, msg: lastTick(clockSends) });
    const acts3 = ((tick3.result && tick3.result[0]) || []).filter((m) => m.action);
    assert.deepEqual(acts3, [{ action: 'connect' }], 'outage end still emits the original connect');
    assert.equal(gwCtx.get('G').forcedDown, false, 'forcedDown cleared on restore');
  } finally { harness.restore(); }
});

test('normal clock resume calls the runtime; blocked (corrupt store) resume starts no interval', () => {
  // Normal: fresh world (no snapshot), operator resume -> runtime.resume + interval.
  const freshDir = path.join(TEMP, 'fresh');
  fs.mkdirSync(freshDir, { recursive: true });
  const freshRt = createRuntime({ dataDir: freshDir });
  const freshGlobal = makeScope();
  freshGlobal.set('fleetRuntime', freshRt);
  const h1 = timerHarness();
  try {
    // Real fresh-world flow: fn0002 bootstrap -> router -> test controller -> clock.
    const boot = runBody('fn0002', { global: freshGlobal });
    assert.equal(boot.result.payload.cmd, 'live', 'fresh bootstrap emits cmd live');
    const routed = runBody('fn0042', { global: freshGlobal, msg: { topic: 'cmd', payload: { cmd: 'live' } } });
    const ctl = runBody('fn003e', { global: freshGlobal, msg: routed.result[1] });
    assert.ok(Array.isArray(ctl.result[0]), 'controller output 1 is an array of messages');
    const clockSends = [];
    const clockCtx = makeScope(); // the clock node's persistent context (one node = one context)
    for (const m of ctl.result[0]) runBody('fn003a', { global: freshGlobal, msg: m, sends: clockSends, context: clockCtx });
    assert.equal(freshGlobal.get('simRunning'), true, 'live bootstrap starts the clock');
    assert.equal(h1.timers.length, 1, 'bootstrap interval started');
    assert.equal(h1.timers[0].ms, 200, 'live bootstrap runs at cfg.speeds.live (5x = 200ms)');
    // Operator resume: the clock gate calls runtime.resume() before the original
    // start() re-owns the interval (same persistent node context, so the previous
    // handle is found and cleared).
    resumeThroughRouter(freshGlobal, clockSends, clockCtx);
    assert.equal(freshGlobal.get('simRunning'), true, 'fresh-world resume keeps the clock running');
    assert.equal(h1.timers.length, 2, 'resume started a new interval');
    assert.equal(h1.timers[0].cleared, true, 'previous interval cleared');
    assert.equal(h1.timers[1].ms, 200, 'resume honours the saved simSpeed (5x live = 200ms)');
    assert.equal(freshRt.status().pausedHold, false, 'no hold on a fresh world');
  } finally { h1.restore(); }

  // Blocked: corrupt snapshot -> bootstrap blocked. While blocked the adapter
  // holds every node except the NEWWORLD reset (fn003e), so the clock body itself
  // never runs: the resume is refused at the adapter, no interval, world frozen.
  const blocked = setupWorld('blocked', worldSnapshot(), { corrupt: true });
  assert.equal(blocked.boot.result, null, 'blocked bootstrap emits nothing');
  assert.equal(blocked.rt.status().blocked, true, 'store blocked after bootstrap');
  const saveStatus = blocked.global.get('fleetSaveStatus');
  assert.equal(saveStatus.ok, false, 'block surfaced in fleetSaveStatus');
  const h2 = timerHarness();
  try {
    const { clock } = resumeThroughRouter(blocked.global);
    assert.equal(clock.result, null, 'blocked store holds the clock control body');
    assert.equal(h2.timers.length, 0, 'blocked resume starts NO interval');
    assert.ok(!blocked.global.get('simRunning'), 'world stays frozen: blocked resume never starts the clock');
  } finally { h2.restore(); }
});

test('explicit operator reset recovers a blocked world via newWorld; bootstrap never calls it', () => {
  const blocked = setupWorld('reset', worldSnapshot(), { corrupt: true });
  assert.equal(blocked.rt.status().blocked, true, 'starts blocked');
  // Restored (non-corrupt) bootstrap must NOT call newWorld: hold stays intact.
  const restored = setupWorld('reset-kept', worldSnapshot());
  assert.equal(restored.rt.status().restored, true, 'restored flag survives bootstrap');
  assert.equal(restored.rt.status().pausedHold, true, 'hold intact after bootstrap (no newWorld at bootstrap)');
  // Deliberate reset: fn003e 'live' runs through the blocked adapter (NEWWORLD
  // is always allowed) and releases the block so a fresh world can be saved.
  const h = timerHarness();
  try {
    runBody('fn003e', { global: blocked.global, msg: { topic: 'cmd', payload: { cmd: 'live' } } });
    assert.equal(blocked.rt.status().blocked, false, 'newWorld cleared the corrupt-store block');
    assert.equal(blocked.rt.status().restored, false, 'newWorld cleared the restored flag');
    assert.equal(blocked.global.get('simRunning'), false, 'reset explicitly freezes the clock (newWorld recovery)');
    // Recovery complete: the live reset's clock output routes to the clock
    // control, and the gate now passes (store unblocked) so the interval starts.
    const routed2 = runBody('fn0042', { global: blocked.global, msg: { topic: 'cmd', payload: { cmd: 'live' } } });
    const ctl2 = runBody('fn003e', { global: blocked.global, msg: routed2.result[1] });
    assert.ok(Array.isArray(ctl2.result[0]), 'reset output 1 is an array of messages');
    const resetClockCtx = makeScope();
    for (const m of ctl2.result[0]) runBody('fn003a', { global: blocked.global, msg: m, context: resetClockCtx });
    assert.equal(blocked.global.get('simRunning'), true, 'clock runs after recovered reset');
    assert.equal(h.timers.length, 1, 'interval started after recovery');
  } finally { h.restore(); }
});

test('interrupted EVALUATING: resume routes a real evaluate command and stops the clock', () => {
  const snap = worldSnapshot({ test: { state: 'EVALUATING', seed: 4242, history: [], schedule: [], D: 380, startedWall: 0 } });
  const { global } = setupWorld('evaluating', snap);
  const harness = timerHarness();
  try {
    const r = runBody('fn0042', { global, msg: { payload: { cmd: 'resume' } } });
    assert.deepEqual(r.result[0], { payload: { cmd: 'stop' } }, 'EVALUATING resume keeps the clock stopped');
    assert.deepEqual(r.result[1], { topic: 'cmd', payload: { cmd: 'finishRestoredEvaluation' } }, 'EVALUATING resume re-emits the evaluate request');
    assert.equal(r.result[2], null, 'no correlation route');
    assert.equal(r.result[3], null, 'no notifier route');
    // The clock stop lands: no interval, clock frozen.
    const h2 = timerHarness();
    try {
      runBody('fn003a', { global, msg: r.result[0] });
      assert.equal(h2.timers.length, 0, 'no interval started for an EVALUATING resume');
      assert.equal(global.get('simRunning'), false, 'clock stays stopped');
    } finally { h2.restore(); }
    // The test controller re-emits the SAME evaluate request the normal end-of-run
    // path emits (out3), without advancing simTime.
    const simBefore = global.get('simTime');
    const ctl = runBody('fn003e', { global, msg: r.result[1] });
    assert.ok(Array.isArray(ctl.result[2]), 'evaluate output is an array of messages');
    assert.equal(ctl.result[2][0].topic, 'evaluate', 'controller re-emits its existing oracle output');
    assert.deepEqual(ctl.result[2][0].payload, { seed: 4242 }, 'evaluate carries the run seed');
    assert.equal(global.get('simTime'), simBefore, 'no simTime advance');
    // A second finishRestoredEvaluation after the oracle ran (state DONE) is a no-op.
    // (Oracle run itself is covered by the next test; here: while still EVALUATING
    // it re-emits, which is safe because the oracle is idempotent via state DONE.)
    const ctl2 = runBody('fn003e', { global, msg: r.result[1] });
    assert.equal(ctl2.result[2][0].topic, 'evaluate', 're-emit while still EVALUATING is allowed (oracle dedupes)');
  } finally { harness.restore(); }
});

test('oracle evaluates once: duplicate evaluate cannot append duplicate history', () => {
  const snap = worldSnapshot({ test: { state: 'EVALUATING', seed: 4242, history: [{ seed: 1, faults: 0, pass: 1, fail: 0, verdict: 'PASS', when: 'x', wallSec: 1 }], schedule: [], D: 380, startedWall: 0 } });
  const { global } = setupWorld('oracle', snap);
  const evalMsg = { topic: 'evaluate', payload: { seed: 4242 } };
  const first = runBody('fn003d', { global, msg: evalMsg });
  assert.ok(first.result && first.result.topic === 'results', 'first evaluation returns results');
  assert.equal(first.result.payload.verdict, 'PASS', 'empty-schedule invariants all pass');
  const T1 = global.get('test');
  assert.equal(T1.state, 'DONE', 'first evaluation sets DONE');
  assert.equal(T1.history.length, 2, 'one history entry appended');
  assert.equal(T1.history[0].seed, 4242, 'newest history entry first');
  // Duplicate evaluate (restored re-emit racing the original): ignored.
  const second = runBody('fn003d', { global, msg: evalMsg });
  assert.equal(second.result, null, 'duplicate evaluate ignored after DONE');
  const T2 = global.get('test');
  assert.equal(T2.history.length, 2, 'no duplicate history entry');
  // A run that never reached EVALUATING (e.g. RUNNING) is not evaluated either.
  global.set('test', { state: 'RUNNING', seed: 7, history: [], schedule: [], D: 100, startedWall: 0 });
  const third = runBody('fn003d', { global, msg: { topic: 'evaluate', payload: { seed: 7 } } });
  assert.equal(third.result, null, 'non-EVALUATING run is not evaluated');
});

// ---------------------------------------------------------------------------
const passed = outcomes.filter((o) => o.passed).length;
const failed = outcomes.length - passed;
const report = {
  suite: 'fleet-control',
  module: 'seaguard/src/functions/fn0010.js + fn003a.js + fn003d.js + fn003e.js + fn0042.js',
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
