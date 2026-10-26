// Focused tests for nearby-vessel assistance (Stage B) in
// seaguard/src/rescue/exercise.cjs. Runs without Node-RED or any service:
//     node seaguard/tests/rescue-assistance.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ex from '../src/rescue/exercise.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function world() {
    const w = ex.createExercise();
    return { state: w.state, ex: w.ex };
}
function run(w, seconds, dt = 1) {
    for (let i = 0; i < Math.ceil(seconds / dt); i++) ex.step(w.state, w.ex, { realDeltaS: dt });
}
function until(w, pred, maxS = 1200, dt = 1) {
    for (let i = 0; i < Math.ceil(maxS / dt); i++) {
        const v = ex.view(w.state, w.ex);
        if (pred(v)) return v;
        ex.step(w.state, w.ex, { realDeltaS: dt });
    }
    throw new Error('until: condition not met within ' + maxS + 's');
}
function helper(w, id) { return w.state.teams.find(t => t.id === id); }
function received(w, kind) {
    return w.ex.timeline.filter(e => e.kind === 'SENSOR_RECEIVED' && (!kind || e.detail.kind === kind));
}

const outcomes = [];
function test(name, fn) {
    try { fn(); outcomes.push({ name, passed: true }); }
    catch (e) { outcomes.push({ name, passed: false, error: e.message }); }
}

// ---------------------------------------------------------------- candidates

test('default world: two finite helpers, candidate ETA computed locally (no model.travelSeconds)', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    run(w, 10); // helpers are stationary; telemetry fixes arrive after 5s
    const v = ex.view(w.state, w.ex);
    assert.equal(v.helpers.length, 2, 'default world has exactly two helpers');
    const n1 = v.helpers.find(h => h.teamId === 'N1');
    const n2 = v.helpers.find(h => h.teamId === 'N2');
    for (const h of [n1, n2]) {
        assert.equal(h.status, 'IDLE');
        assert.equal(h.radioUp, true);
        assert.equal(h.available, true, h.teamId + ' should be available with a fresh fix');
        assert.equal(typeof h.distanceKm, 'number');
        assert.equal(typeof h.etaS, 'number');
        assert.ok(h.etaS > 0 && Number.isFinite(h.etaS), 'finite ETA, got ' + h.etaS);
    }
    // FLOODING vessel sits 0.5 km east of the harbour; N1 is at 0.2 km east,
    // so the known distance is ~0.3 km and the ETA at 8 kn is ~73s.
    assert.ok(n1.distanceKm > 0.29 && n1.distanceKm < 0.31, 'N1 distance ~0.3 km, got ' + n1.distanceKm);
    assert.ok(n1.etaS >= 70 && n1.etaS <= 77, 'N1 ETA ~73s, got ' + n1.etaS);
});

// ------------------------------------------------------------------ dispatch

test('requestAssistance: travel before work, pump slows the rise, repair resolves, RETURN home', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    run(w, 10);
    const v0 = ex.view(w.state, w.ex);
    const water0 = v0.incident.waterL;
    // N2 (10 kn, 15 lpm pump) is only ~0.1 km from the FLOODING vessel. The
    // recovery kit is required: FLOODING's 3 crew are only rescued while a kit
    // is held on scene, so without it the incident can never resolve.
    const v = ex.requestAssistance(w.state, w.ex, { helperId: 'N2', personnel: 2, recoveryKit: true });
    const m = v.missions.find(x => x.teamId === 'N2');
    assert.ok(m, 'N2 mission exists');
    assert.equal(m.status, 'EN_ROUTE');
    assert.equal(helper(w, 'N2').personnelAssigned, 2);
    // No instantaneous rescue: water keeps rising while N2 is en route.
    run(w, 30);
    const v1 = ex.view(w.state, w.ex);
    assert.ok(v1.incident.waterL > water0, 'water rises while helper travels');
    // N2 (10 kn) covers ~0.1 km in ~19s; wait for arrival.
    const va = until(w, x => x.missions.some(xm => xm.teamId === 'N2' && xm.status === 'ON_SCENE'), 300);
    assert.ok(va.simTime > 15, 'helper actually travelled, on scene at t=' + va.simTime);
    // On scene: repair the hull and start N2's pump (real work, not instant).
    ex.repair(w.state, w.ex);
    ex.command(w.state, w.ex, { teamId: 'N2', action: 'START_PUMP' });
    const vp = until(w, x => received(w, 'PUMP_STATE').some(e => e.detail.value === 'on'), 60);
    assert.ok(vp, 'PUMP_STATE on report delivered');
    const wA = vp.incident.waterL;
    // The 60s repair (started on scene, same time as the pump) stops the
    // ingress partway through a long window, so measure over a short window
    // that provably ends before the repair completes. Oracle computed from
    // the ACTUAL ingress just before the interval: (ingress - pump 15 lpm)
    // net rate x 25s; with the scenario's 25 lpm ingress that is ~4.2 L
    // (clearly positive: the pump slows the rise, it does not stop it).
    const ingress = vp.incident.ingressLpm;
    assert.ok(ingress > 15, 'ingress still above the pump rate: ' + ingress);
    const expected = (ingress - 15) * 25 / 60;
    run(w, 25);
    const v2 = ex.view(w.state, w.ex);
    assert.ok(v2.incident.ingressLpm > 0, 'window ends before repair stops the ingress');
    const rise = v2.incident.waterL - wA;
    assert.ok(Math.abs(rise - expected) < 1, 'net rise with pump ~' + expected.toFixed(1) + ' L over 25s, got ' + rise.toFixed(1));
    // Repair (60s continuous on-scene work) stops the ingress; the 3 crew are
    // rescued while N2 holds the kit on scene (2 personnel * 0.5/min = 1/min,
    // so ~180s), the water is then sensor-confirmed below the safe level and
    // the incident resolves. Allow a generous window for all of that.
    const vr = until(w, x => x.incident.status === 'RESOLVED', 600);
    assert.ok(vr, 'incident resolved by helper work');
    // Return via the existing RETURN command; allClear only when home.
    ex.command(w.state, w.ex, { teamId: 'N2', action: 'RETURN' });
    const vh = until(w, x => x.results && x.results.allClear, 600);
    assert.equal(helper(w, 'N2').status, 'IDLE');
    assert.ok(vh.missions.every(xm => xm.status === 'COMPLETED'), 'N2 mission completed');
});

// ------------------------------------------------------------ allocation

test('no double booking or over-allocation of helpers', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    run(w, 10);
    ex.requestAssistance(w.state, w.ex, { helperId: 'N1', personnel: 1, recoveryKit: false });
    assert.throws(() => ex.requestAssistance(w.state, w.ex, { helperId: 'N1', personnel: 1, recoveryKit: false }),
        /already assigned/, 'N1 already has personnel assigned');
    // N2 has 2 personnel: asking for 3 is an over-allocation.
    assert.throws(() => ex.requestAssistance(w.state, w.ex, { helperId: 'N2', personnel: 3, recoveryKit: false }),
        /only 2 personnel/);
    assert.throws(() => ex.requestAssistance(w.state, w.ex, { helperId: 'N2', personnel: 0, recoveryKit: false }),
        /personnel/);
    // The single shared recovery kit: T1 takes it, N2 (still unassigned) cannot
    // also take it. (N1 is already assigned above, so it would reject earlier.)
    ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2, recoveryKit: true });
    assert.throws(() => ex.requestAssistance(w.state, w.ex, { helperId: 'N2', personnel: 1, recoveryKit: true }),
        /kit/i, 'shared kit already reserved by T1');
    // Unknown helpers and non-boolean kit are rejected.
    assert.throws(() => ex.requestAssistance(w.state, w.ex, { helperId: 'NOPE', personnel: 1, recoveryKit: false }),
        /unknown helper/);
    assert.throws(() => ex.requestAssistance(w.state, w.ex, { helperId: 'N2', personnel: 1, recoveryKit: 'yes' }),
        /recoveryKit/);
});

// ------------------------------------------------------------------ GPS age

test('assistance requires a fresh received GPS fix (stale fix rejected)', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    // No fix received yet at t=0.
    assert.throws(() => ex.requestAssistance(w.state, w.ex, { helperId: 'N1', personnel: 1, recoveryKit: false }),
        /no received GPS fix/);
    run(w, 10);
    // Outage on N1 from t=10 for 200s: no new fixes are received, so the last
    // fix goes stale (age > 30s) while the exercise clock keeps running.
    ex.setOutage(w.state, w.ex, { teamId: 'N1', fromS: 0, toS: 200 });
    run(w, 50); // t=60: last fix is >= 50s old
    const v = ex.view(w.state, w.ex);
    const n1 = v.helpers.find(h => h.teamId === 'N1');
    assert.ok(n1.gps.ageS > 30, 'fix is stale, age ' + n1.gps.ageS + 's');
    assert.equal(n1.available, false);
    assert.throws(() => ex.requestAssistance(w.state, w.ex, { helperId: 'N1', personnel: 1, recoveryKit: false }),
        /s old/);
});

// --------------------------------------------------------------------- fuel

test('finite round-trip fuel check uses the actual home leg (pos->incident + incident->home)', () => {
    // FLOODING: vessel 0.5 km east of harbour; N1 starts 0.2 km east.
    // Out leg 0.3 km + home leg 0.5 km = 0.8 km -> 0.8/1.852*8 = 3.46 L.
    // 3 L is NOT enough (the old 2*out formula said 2.59 L and would have
    // accepted it, stranding the helper on the home leg).
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    run(w, 10);
    helper(w, 'N1').fuelL = 3;
    assert.throws(() => ex.requestAssistance(w.state, w.ex, { helperId: 'N1', personnel: 1, recoveryKit: false }),
        /cannot cover the round trip/, '3 L < 3.46 L actual round trip');
    // 4 L covers it: dispatch, then actually RETURN to the harbour and
    // verify the helper arrives with positive fuel (not stranded).
    const w2 = world();
    ex.start(w2.state, w2.ex, { scenario: 'FLOODING' });
    run(w2, 10);
    helper(w2, 'N1').fuelL = 4;
    const v = ex.requestAssistance(w2.state, w2.ex, { helperId: 'N1', personnel: 1, recoveryKit: false });
    assert.equal(v.missions.find(x => x.teamId === 'N1').status, 'EN_ROUTE', '4 L covers the actual round trip');
    until(w2, x => x.missions.some(m => m.teamId === 'N1' && m.status === 'ON_SCENE'), 300);
    ex.command(w2.state, w2.ex, { teamId: 'N1', action: 'RETURN' });
    until(w2, x => x.missions.some(m => m.teamId === 'N1' && m.status === 'COMPLETED'), 600);
    const n1 = helper(w2, 'N1');
    assert.equal(n1.status, 'IDLE', 'N1 back at harbour and idle');
    assert.ok(n1.fuelL > 0, 'N1 home with positive fuel, got ' + n1.fuelL.toFixed(2));
    assert.ok(n1.fuelL < 4,
        'fuel was actually burned on both legs, got ' + n1.fuelL.toFixed(2));
});

// ------------------------------- generic dispatch/reinforce bypass (Stage B review)

test('generic dispatch routes helpers through the assistance checks (no bypass)', () => {
    // Fresh fix: generic dispatch must behave exactly like requestAssistance.
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    run(w, 10);
    const v = ex.dispatch(w.state, w.ex, { teamId: 'N1', personnel: 1, recoveryKit: false });
    assert.equal(v.missions.find(x => x.teamId === 'N1').status, 'EN_ROUTE');
    assert.ok(w.ex.marks.firstDispatchAt !== null, 'first dispatch mark set via generic dispatch');
    // Stale fix: the freshness check must apply to the generic path too.
    const w2 = world();
    ex.start(w2.state, w2.ex, { scenario: 'FLOODING' });
    run(w2, 10);
    // Fixes are re-sampled every second and received after a 5s delay, so
    // simply running time never stales a fix: block new receptions with an
    // outage, then let the last received fix age past the 30s freshness limit.
    ex.setOutage(w2.state, w2.ex, { teamId: 'N1', fromS: 0, toS: 200 });
    run(w2, 50); // t=60: last received fix is now >= 50s old
    assert.throws(() => ex.dispatch(w2.state, w2.ex, { teamId: 'N1', personnel: 1, recoveryKit: false }),
        /GPS fix/);
    // Radio-down helper: rejected by the generic path and the candidate list.
    const w3 = world();
    ex.start(w3.state, w3.ex, { scenario: 'FLOODING' });
    run(w3, 10);
    w3.ex.helpers.find(h => h.teamId === 'N2').radioUp = false;
    assert.throws(() => ex.dispatch(w3.state, w3.ex, { teamId: 'N2', personnel: 1, recoveryKit: false }),
        /radio is down/);
    assert.equal(ex.view(w3.state, w3.ex).helpers.find(h => h.teamId === 'N2').available, false,
        'candidate list marks a radio-down helper unavailable');
});

test('reinforce rejects helpers: use the assistance action', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    run(w, 10);
    assert.throws(() => ex.reinforce(w.state, w.ex, { teamId: 'N1', personnel: 1, recoveryKit: false }),
        /assistance/);
    // Non-helper teams still reinforce through the normal model path: T1 is
    // dispatched (EN_ROUTE), then T2 (still IDLE) reinforces the same active
    // incident. A team cannot reinforce itself once it is no longer IDLE.
    ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 1, recoveryKit: false });
    const v = ex.reinforce(w.state, w.ex, { teamId: 'T2', personnel: 1, recoveryKit: false });
    const m2 = v.missions.find(x => x.teamId === 'T2');
    assert.ok(m2, 'T2 reinforce still works');
    assert.equal(m2.status, 'EN_ROUTE');
});

// -------------------------------------------------------------------- report

const failed = outcomes.filter(o => !o.passed);
for (const o of outcomes) console.log((o.passed ? 'PASS' : 'FAIL') + '  ' + o.name + (o.error ? '\n      ' + o.error : ''));
console.log('rescue-assistance: ' + (outcomes.length - failed.length) + '/' + outcomes.length + ' pass');
process.exit(failed.length ? 1 : 0);
