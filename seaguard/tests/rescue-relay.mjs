// Focused tests for the short-range radio RELAY and report backlog in the
// rescue EXERCISE controller (seaguard/src/rescue/exercise.cjs).
//     node seaguard/tests/rescue-relay.mjs
//
// Facts used (all deterministic):
//   - RADIO_FAILURE: the vessel main radio is DOWN from t=0; a valid relay is
//     the only path. Vessel sits 1.0 km east of harbour.
//   - N2 (posEast 0.6 km) is 0.4 km from the vessel -> within RELAY_VESSEL_KM
//     (0.6) and 1.0 km from harbour -> within RELAY_HARBOUR_KM (2). N1
//     (posEast 0.2 km) is 0.8 km from the vessel -> OUT of range.
//   - reportEveryS=15, reportDelayS=5, RELAY_EXTRA_DELAY_S=3: a relayed
//     sample taken at t=15 is delivered at t=23, a direct one at t=20.
//   - The relay is a BACKUP path: it never restores the main radio.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ex from '../src/rescue/exercise.cjs';
import pers from '../src/rescue/persistence.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMP = path.join(here, 'fixtures', 'temp');
const reportPath = path.join(here, '..', 'reports', 'rescue-relay.json');
fs.rmSync(TEMP, { recursive: true, force: true });
fs.mkdirSync(TEMP, { recursive: true });

function world() { const w = ex.createExercise(); return { state: w.state, ex: w.ex }; }
function run(w, seconds, dt = 5) { for (let i = 0; i < Math.ceil(seconds / dt); i++) ex.step(w.state, w.ex, { realDeltaS: dt }); }
function until(w, pred, maxTicks = 400, dt = 1) {
    for (let i = 0; i < maxTicks; i++) {
        const v = ex.view(w.state, w.ex);
        if (pred(v)) return v;
        ex.step(w.state, w.ex, { realDeltaS: dt });
    }
    throw new Error('until: condition not met within ' + maxTicks + ' ticks');
}
function received(w, kind) {
    return w.ex.timeline.filter(e => e.kind === 'SENSOR_RECEIVED' && e.detail && e.detail.kind === kind);
}
function vesselPos(w) { return w.state.incidents[w.ex.incidentId].position; }
function setPos(w, teamId, pos) { w.state.teams.find(t => t.id === teamId).pos = { ...pos }; }
function meta(w, teamId) { return w.ex.helpers.find(h => h.teamId === teamId); }

const outcomes = [];
function test(name, fn) {
    try { fn(); outcomes.push({ name, passed: true }); }
    catch (e) { outcomes.push({ name, passed: false, error: e.message }); }
}

// ---------------------------------------------------------------- direct path

test('direct path: radio up delivers after the normal 5s delay, relayed=false', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' }); // main radio up from t=0
    // lastReportAt starts null (-Infinity), so the FIRST sample is taken on
    // the very first 1s tick (t=1); direct delivery is sampleAt + 5s = t=6.
    const v = until(w, x => received(w, 'WATER_LEVEL').length >= 1, 40);
    const e = received(w, 'WATER_LEVEL')[0];
    assert.equal(e.detail.sampleAt, 1, 'first sample taken on the first tick');
    assert.equal(e.t, e.detail.sampleAt + 5, 'delivered after the normal 5s delay');
    assert.equal(e.detail.relayed, false, 'direct path is not a relay delivery');
    assert.equal(v.simTime, e.t, 'no rescheduling loop: delivered on first due tick');
});

test('direct path keeps delivering every sample (no reschedule starvation)', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    run(w, 60);
    const got = received(w, 'WATER_LEVEL');
    assert.ok(got.length >= 3, 'at least 3 of the 4 samples delivered, got ' + got.length);
    for (const e of got) assert.equal(e.t - e.detail.sampleAt, 5, 'each sample delayed exactly 5s');
});

// ----------------------------------------------------------------- relay path

test('relay path: radio down + in-range helper delivers at +8s with sampleAt kept', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'RADIO_FAILURE' });
    ex.setRelay(w.state, w.ex, { helperId: 'N2' }); // N2 is 0.4 km from the vessel
    const v0 = ex.view(w.state, w.ex);
    assert.equal(v0.relay.helperId, 'N2');
    assert.equal(v0.relay.route, 'N2', 'view exposes the current route key');
    assert.equal(v0.relay.enabled, true);
    // Radio is still down: the relay is a backup, it does not repair the main link.
    assert.equal(v0.vessel.radioUp, false);
    assert.ok(v0.incident.unsafe.includes('RADIO_DOWN'), 'scenario not made safe by the relay');
    const v = until(w, x => received(w, 'WATER_LEVEL').length >= 1, 40);
    const e = received(w, 'WATER_LEVEL')[0];
    assert.equal(e.detail.sampleAt, 1, 'first sample taken on the first tick');
    assert.equal(e.t, e.detail.sampleAt + 8, 'delivered at sample + 5s + 3s relay delay');
    assert.equal(e.detail.relayed, true, 'counted as a relayed delivery');
    assert.equal(v.relay.delivered, 1);
    assert.equal(v.vessel.radioUp, false, 'relay delivery does not restore the main radio');
});

test('relay loss: backlog holds (no false-green), recovery restarts the delay', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'RADIO_FAILURE' });
    ex.setRelay(w.state, w.ex, { helperId: 'N2' });
    const v = until(w, x => received(w, 'WATER_LEVEL').length >= 1, 40); // t=9 (sample 1 + 8)
    assert.equal(v.simTime, 9);
    // N2 sails away (to the harbour: 1.0 km from the vessel -> out of range).
    setPos(w, 'N2', w.state.harbour);
    run(w, 10); // dt=5 ticks at t=14,19: the next sample (t>=16) is taken and must HOLD
    const vh = ex.view(w.state, w.ex);
    assert.equal(vh.relay.enabled, false, 'relay path lost');
    assert.ok(vh.relay.reason, 'reason: ' + vh.relay.reason);
    const held = w.ex.link.pendingReports[0];
    assert.equal(vh.relay.backlog, 1, 'the new sample holds in the backlog');
    assert.ok(held.sampleAt > v.simTime, 'held report is a NEW sample: ' + held.sampleAt);
    assert.equal(held.arriveAt, null, 'held report has no due time');
    assert.equal(held.route, null, 'held report has no route');
    run(w, 10); // still no delivery while the path is lost
    assert.equal(received(w, 'WATER_LEVEL').length, 1, 'no delivery while the path is lost');
    // N2 returns to the vessel: the FIRST tick after the path is restored
    // reschedules the held report NOW on the recovered route (delay restarted,
    // NOT held.sampleAt + 8), keeping its original sampleAt (stale stays stale).
    setPos(w, 'N2', vesselPos(w));
    ex.step(w.state, w.ex, { realDeltaS: 1 }); // first tick that sees the restored path
    const tResched = ex.view(w.state, w.ex).simTime;
    const due = w.ex.link.pendingReports[0].arriveAt;
    assert.equal(due, tResched + 8, 'delay restarted on path recovery, got due=' + due);
    const v2 = until(w, x => received(w, 'WATER_LEVEL').length >= 2, 40);
    const e = received(w, 'WATER_LEVEL')[1];
    assert.equal(e.t, due, 'delivered on the rescheduled tick, got t=' + e.t);
    assert.equal(e.detail.sampleAt, held.sampleAt, 'stale sample keeps its original age');
    assert.equal(e.detail.relayed, true);
    assert.equal(v2.relay.delivered, 2);
});

test('relay helper switch restarts the delay (route key is the helper id)', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'RADIO_FAILURE' });
    ex.setRelay(w.state, w.ex, { helperId: 'N1' }); // N1 is 0.8 km away: NO path
    const v0 = ex.view(w.state, w.ex);
    assert.equal(v0.relay.enabled, false);
    assert.match(v0.relay.reason, /km from vessel/, 'out of range reason: ' + v0.relay.reason);
    run(w, 15); // dt=5 ticks at t=5,10,15: first sample (t=5) taken, no path -> held
    const heldAt = w.ex.link.pendingReports[0].sampleAt;
    assert.equal(ex.view(w.state, w.ex).relay.backlog, 1);
    // Switch to N2 (in range): the FIRST tick after the switch reschedules the
    // held report on the new helper (delay restarted), keeping sampleAt.
    ex.setRelay(w.state, w.ex, { helperId: 'N2' });
    ex.step(w.state, w.ex, { realDeltaS: 1 }); // first tick that sees the new route
    const tResched = ex.view(w.state, w.ex).simTime;
    const due = w.ex.link.pendingReports[0].arriveAt;
    assert.equal(due, tResched + 8, 'delay restarted on the new helper, got due=' + due);
    const v = until(w, x => received(w, 'WATER_LEVEL').length >= 1, 40);
    const e = received(w, 'WATER_LEVEL')[0];
    assert.equal(e.t, due, 'delivered on the rescheduled tick, got t=' + e.t);
    assert.equal(e.detail.sampleAt, heldAt, 'stale sample keeps its original age');
    assert.equal(e.detail.relayed, true);
    assert.equal(v.relay.route, 'N2');
});

test('relayPath respects helper meta.available (and radioUp) as well as range', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'RADIO_FAILURE' });
    ex.setRelay(w.state, w.ex, { helperId: 'N2' });
    meta(w, 'N2').available = false; // operator marks the helper unavailable
    const v0 = ex.view(w.state, w.ex);
    assert.equal(v0.relay.enabled, false, 'unavailable helper cannot relay');
    assert.match(v0.relay.reason, /unavailable/);
    run(w, 15); // dt=5 ticks at t=5,10,15: first sample (t=5) held, no path
    const heldAt = w.ex.link.pendingReports[0].sampleAt;
    assert.equal(ex.view(w.state, w.ex).relay.backlog, 1);
    meta(w, 'N2').available = true;
    const v = until(w, x => received(w, 'WATER_LEVEL').length >= 1, 40);
    const e = received(w, 'WATER_LEVEL')[0];
    assert.equal(e.detail.sampleAt, heldAt, 'stale sample keeps its original age');
    assert.equal(e.detail.relayed, true);
    // radioUp=false on the helper also kills the path.
    meta(w, 'N2').radioUp = false;
    assert.equal(ex.view(w.state, w.ex).relay.enabled, false);
    assert.match(ex.view(w.state, w.ex).relay.reason, /radio/);
});

test('setRelay validation: unknown helper, null disables, radio-down rejected', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'RADIO_FAILURE' });
    assert.throws(() => ex.setRelay(w.state, w.ex, { helperId: 'T1' }), /unknown helper/);
    assert.throws(() => ex.setRelay(w.state, w.ex, { helperId: 'NOPE' }), /unknown helper/);
    ex.setRelay(w.state, w.ex, { helperId: 'N2' });
    assert.equal(ex.view(w.state, w.ex).relay.helperId, 'N2');
    ex.setRelay(w.state, w.ex, { helperId: null });
    const v0 = ex.view(w.state, w.ex);
    assert.equal(v0.relay.helperId, null);
    assert.equal(v0.relay.route, null, 'no relay selected -> route null');
    assert.equal(v0.relay.enabled, false);
    meta(w, 'N2').radioUp = false;
    assert.throws(() => ex.setRelay(w.state, w.ex, { helperId: 'N2' }), /radio is down/);
});

test('backlog is bounded at 200 with an explicit dropped count', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'RADIO_FAILURE' }); // no path at all
    // Samples every 15s: 200 samples at t=3000, then drops begin.
    const v = until(w, x => x.relay.dropped >= 1, 700, 5);
    assert.ok(v.relay.backlog <= 200, 'backlog bounded, got ' + v.relay.backlog);
    assert.ok(v.relay.dropped >= 1, 'drops counted: ' + v.relay.dropped);
    assert.ok(w.ex.timeline.some(e => e.kind === 'REPORT_QUEUE_DROPPED'), 'drop event on timeline');
});

// ------------------------------------------------------------- persistence

test('save/load roundtrip: queued reports keep route/relayed/arriveAt; world resumes paused', () => {
    const store = pers.createStore({ dataDir: path.join(TEMP, 'relay') });
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'RADIO_FAILURE' });
    ex.setRelay(w.state, w.ex, { helperId: 'N2' });
    const v = until(w, x => received(w, 'WATER_LEVEL').length >= 1, 40); // t=9 (sample 1 + 8)
    assert.equal(v.simTime, 9);
    // Move N2 away BEFORE the next sample so that sample is taken with no
    // path and is immediately held (arriveAt null, route null).
    setPos(w, 'N2', w.state.harbour);
    run(w, 10); // dt=5 ticks at t=14,19: the next sample (t>=16) is taken, held
    const held = w.ex.link.pendingReports[0];
    assert.ok(held.sampleAt > v.simTime, 'held report is a NEW sample: ' + held.sampleAt);
    assert.equal(held.arriveAt, null, 'held report has no due time');
    assert.equal(held.route, null, 'held report has no route');
    assert.equal(held.relayed, false, 'held report is not a relay delivery');
    const saved = store.save(w);
    assert.ok(saved.ok, 'save ok');
    const loaded = store.load();
    assert.ok(loaded.ok, 'load ok');
    const lw = loaded.world;
    assert.equal(lw.ex.relay.helperId, 'N2', 'relay selection restored');
    assert.equal(lw.ex.relayStats.delivered, 1, 'relay stats restored');
    const lr = lw.ex.link.pendingReports[0];
    assert.equal(lr.sampleAt, held.sampleAt, 'sampleAt preserved through the snapshot');
    assert.equal(lr.arriveAt, null);
    assert.equal(lr.route, null);
    assert.equal(lr.relayed, false);
    const lv = ex.view(lw.state, lw.ex);
    assert.equal(lv.paused, true, 'restored world is paused');
    assert.equal(lv.relay.backlog, 1);
});

test('legacy snapshot without route/relayed/arriveAt migrates and validates', () => {
    const store = pers.createStore({ dataDir: path.join(TEMP, 'legacy') });
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'RADIO_FAILURE' });
    // Craft a legacy-shaped pending report (pre-Stage B fields).
    w.ex.link.pendingReports.push({ kind: 'WATER_LEVEL', value: 0, sampleAt: 5 });
    // buildSnapshot returns the snapshot object directly ({format,version,savedAt,state,ex}).
    const snap = pers.buildSnapshot(w);
    assert.ok(snap && snap.state && snap.ex, 'snapshot built');
    assert.equal(snap.ex.link.pendingReports.length, 1, 'crafted report is in the snapshot');
    const obj = JSON.parse(JSON.stringify(snap));
    delete obj.ex.link.pendingReports[0].arriveAt;
    delete obj.ex.link.pendingReports[0].relayed;
    delete obj.ex.link.pendingReports[0].route;
    const migrated = pers.migrateSnapshot(obj);
    const r = migrated.ex.link.pendingReports[0];
    assert.equal(r.arriveAt, null, 'legacy arriveAt -> null');
    assert.equal(r.relayed, false, 'legacy relayed -> false');
    assert.equal(r.route, null, 'legacy route -> null');
    assert.equal(pers.validateSnapshot(migrated), null, 'migrated snapshot validates');
    // A corrupt route is rejected, not papered over.
    r.route = 42;
    assert.match(pers.validateSnapshot(migrated), /route/);
});

// -------------------------------------------------------------------- report

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const failed = outcomes.filter(o => !o.passed);
fs.writeFileSync(reportPath, JSON.stringify({
    file: 'rescue-relay.mjs', at: new Date().toISOString(),
    total: outcomes.length, passed: outcomes.length - failed.length, failed: failed.length,
    results: outcomes
}, null, 2));
console.log('rescue-relay: ' + (outcomes.length - failed.length) + '/' + outcomes.length + ' pass');
for (const o of outcomes) console.log((o.passed ? 'PASS' : 'FAIL') + '  ' + o.name + (o.passed ? '' : '  -> ' + o.error));
process.exit(failed.length ? 1 : 0);
