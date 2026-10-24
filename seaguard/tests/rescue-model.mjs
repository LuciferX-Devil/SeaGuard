// Focused tests for the standalone rescue state model (seaguard/src/rescue/model.cjs).
// Rescue sprint task 1, review revision 2. Runs without Node-RED or any service:
//     node seaguard/tests/rescue-model.mjs
// Covers: undersized rescue needing reinforcement, no early travel completion,
// resources unavailable until return, stale GPS (sample-time based),
// lost/delayed commands, team-specific sensor-confirmed resolution,
// resolved-incident water dynamics reopening, atomic input validation,
// impossible transitions, fuel stranding, partial personnel allocation,
// exact knots conversion and determinism.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import model from '../src/rescue/model.cjs';

const { createState, addIncident, dispatch, reinforce, command, sensorReport,
    setOutage, setPumpFault, dropCommand, tick, status, distanceKm } = model;

const here = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.join(here, '..', 'reports', 'rescue-model.json');

// Illustrative harbour, same as the SeaGuard cfg (not navigational data).
const HARBOUR = { lat: 9.2876, lon: 79.3129 };
function posEast(km) {
    return { lat: HARBOUR.lat, lon: HARBOUR.lon + km / (111.1949 * Math.cos(HARBOUR.lat * Math.PI / 180)) };
}
function tickUntil(s, pred, maxTicks = 2000, dt = 5) {
    for (let i = 0; i < maxTicks; i++) {
        if (pred(status(s))) return i;
        tick(s, dt);
    }
    throw new Error('tickUntil: condition not met within ' + maxTicks + ' ticks of ' + dt + 's');
}
const team = (st, id) => st.teams.find(t => t.id === id);
const inc = (st, id) => st.incidents.find(i => i.id === id);
const cmd = (st, id) => st.commands.find(c => c.id === id);
function pumpCmds(st, teamId) { return st.commands.filter(c => c.teamId === teamId && c.action === 'START_PUMP'); }

const outcomes = [];
function test(name, fn) {
    try { fn(); outcomes.push({ name, passed: true }); }
    catch (e) { outcomes.push({ name, passed: false, error: e.message }); }
}

test('createState defaults: two finite teams at the harbour, all resources finite, allClear', () => {
    const s = createState();
    const st = status(s);
    assert.equal(st.teams.length, 2);
    assert.equal(st.shared.recoveryKits.available, 1);
    assert.equal(st.time, 0);
    assert.equal(st.allClear, true);
    for (const t of st.teams) {
        assert.ok(Number.isFinite(t.fuelL) && t.fuelL > 0, 'finite fuel');
        assert.ok(Number.isFinite(t.speedKn) && t.speedKn > 0, 'finite speed');
        assert.ok(Number.isInteger(t.personnel.available) && t.personnel.available >= 0);
        assert.equal(t.status, 'IDLE');
        assert.ok(Number.isFinite(t.pos.lat) && t.pos.lat >= -90 && t.pos.lat <= 90);
        assert.ok(Number.isFinite(t.pos.lon) && t.pos.lon >= -180 && t.pos.lon <= 180);
        assert.equal(t.telemetry.receivedPos, null, 'no fix received yet');
        assert.equal(t.telemetry.stale, true, 'no fix yet is not a fresh fix');
    }
});

test('knots conversion is exact: 12 kn team covers the distance in distance/(12*1.852) hours', () => {
    const s = createState();
    const dest = posEast(1);
    addIncident(s, { id: 'INC-K', kind: 'MAN_OVERBOARD', position: dest, crewOnboard: 1, initialWaterL: 0, ingressLpm: 0 });
    const m = dispatch(s, { incidentId: 'INC-K', teamId: 'T1', personnel: 1, recoveryKit: true });
    const d = distanceKm(HARBOUR, dest);
    const expectedS = d / (12 * 1.852) * 3600;
    assert.ok(Math.abs(m.travelS - expectedS) < 1e-6, 'travelS must use 1 kn = 1.852 km/h, got ' + m.travelS + ' expected ' + expectedS);
    // Sanity: 12 kn = 22.224 km/h -> ~16.2 s per km, not ~4.8 s (the old 3.6x error).
    assert.ok(expectedS > 10, 'sanity: the leg must take tens of seconds, not ~5s');
});

test('undersized first team fails alone; reinforcement with bigger pump resolves (sensor-confirmed)', () => {
    const s = createState();
    addIncident(s, { id: 'INC-1', kind: 'FLOODING', position: posEast(0.4), crewOnboard: 6, initialWaterL: 20, ingressLpm: 30 });
    dispatch(s, { incidentId: 'INC-1', teamId: 'T1', personnel: 4, recoveryKit: true });
    tickUntil(s, st => team(st, 'T1').status === 'ON_SCENE', 400, 5);
    assert.equal(status(s).incidents[0].status, 'IN_PROGRESS');
    // T1 pump (25 lpm) < ingress (30 lpm): water must keep rising even with the pump running.
    const c1 = command(s, { incidentId: 'INC-1', teamId: 'T1', action: 'START_PUMP' });
    tickUntil(s, st => cmd(st, c1.id).status === 'EXECUTED', 100, 5);
    tick(s, 300);
    let st = status(s);
    assert.ok(st.incidents[0].waterL > 20, 'undersized pump cannot hold the water');
    // Crew can still be rescued (T1 holds the kit) while the vessel stays unsafe.
    tickUntil(s, st2 => st2.incidents[0].crewRescued >= 6 && st2.incidents[0].waterL > 50, 800, 5);
    st = status(s);
    assert.equal(st.incidents[0].status, 'IN_PROGRESS', 'crew rescued is NOT resolution while water is unsafe');
    assert.ok(st.incidents[0].unsafe.includes('WATER_ABOVE_SAFE'));
    // Reinforcement with the bigger pump (40 lpm) turns the net flow negative.
    reinforce(s, { incidentId: 'INC-1', teamId: 'T2', personnel: 6, recoveryKit: false });
    const m2 = status(s).missions.find(m => m.teamId === 'T2');
    assert.equal(m2.purpose, 'REINFORCEMENT');
    tickUntil(s, st2 => team(st2, 'T2').status === 'ON_SCENE', 400, 5);
    const c2 = command(s, { incidentId: 'INC-1', teamId: 'T2', action: 'START_PUMP' });
    tickUntil(s, st2 => cmd(st2, c2.id).status === 'EXECUTED', 100, 5);
    tickUntil(s, st2 => st2.incidents[0].waterL <= 50, 800, 5);
    // Fresh team-specific sensor feedback confirms the pump and the safe water.
    st = status(s);
    sensorReport(s, { incidentId: 'INC-1', kind: 'PUMP_STATE', value: 'on', teamId: 'T2' });
    tick(s, 30); // net -5 lpm -> water falls below levelAtExec
    sensorReport(s, { incidentId: 'INC-1', kind: 'PUMP_STATE', value: 'on', teamId: 'T2' });
    sensorReport(s, { incidentId: 'INC-1', kind: 'WATER_LEVEL', value: status(s).incidents[0].waterL });
    tickUntil(s, st2 => cmd(st2, c2.id).status === 'CONFIRMED', 100, 5);
    tickUntil(s, st2 => st2.incidents[0].status === 'RESOLVED', 100, 5);
    st = status(s);
    assert.ok(st.incidents[0].resolvedAt > 0);
    assert.equal(st.incidents[0].unsafe.length, 0);
    assert.equal(cmd(st, c2.id).confirmedAt > cmd(st, c2.id).executedAt, true);
    // T1's undersized pump command is NOT confirmed: no fresh feedback for it.
    assert.equal(cmd(st, c1.id).status, 'EXECUTED', 'no team-specific fresh feedback -> no confirmation');
});

test('travel completes only after the full distance; no early arrival, no overshoot, no work before arrival', () => {
    const s = createState();
    const dest = posEast(1);
    addIncident(s, { id: 'INC-2', kind: 'FLOODING', position: dest, crewOnboard: 1, initialWaterL: 5, ingressLpm: 10 });
    const m = dispatch(s, { incidentId: 'INC-2', teamId: 'T2', personnel: 2, recoveryKit: true });
    assert.ok(m.arriveAt > 0, 'arrival must be in the future');
    const dt = 7; // awkward step so ticks do not land on arriveAt
    let lastDist = distanceKm(team(status(s), 'T2').pos, dest);
    let st = status(s);
    while (team(st, 'T2').status !== 'ON_SCENE') {
        tick(s, dt);
        st = status(s);
        const d = distanceKm(team(st, 'T2').pos, dest);
        assert.ok(d <= lastDist + 1e-9, 'distance to incident must not increase (no overshoot)');
        lastDist = d;
        if (st.time < m.arriveAt) {
            assert.equal(team(st, 'T2').status, 'EN_ROUTE', 'no early travel completion');
            assert.ok(d > 0, 'not at the destination before arriveAt');
            assert.ok(st.incidents[0].waterL < 5 + 10 * st.time / 60 * 1.0001, 'no pump work before arrival (water only rises by ingress)');
        }
    }
    assert.ok(st.time >= m.arriveAt, 'arrives once the full distance is covered');
    assert.ok(st.time - m.arriveAt <= dt, 'arrives on the first tick that reaches arriveAt');
    assert.equal(distanceKm(team(st, 'T2').pos, dest), 0, 'position clamps exactly to the incident');
});

test('resources unavailable until return; released and reusable after arrival at harbour', () => {
    const s = createState();
    addIncident(s, { id: 'INC-3', kind: 'MAN_OVERBOARD', position: posEast(0.2), crewOnboard: 1, initialWaterL: 0, ingressLpm: 0 });
    dispatch(s, { incidentId: 'INC-3', teamId: 'T1', personnel: 2, recoveryKit: true }); // partial: 2 of 4
    assert.equal(team(status(s), 'T1').personnel.available, 2, 'unassigned personnel stay ashore');
    tickUntil(s, st => team(st, 'T1').status === 'ON_SCENE', 400, 5);
    tickUntil(s, st => st.incidents[0].crewRescued >= 1, 400, 5);
    assert.equal(status(s).incidents[0].status, 'IN_PROGRESS', 'no green without sensor confirmation');
    sensorReport(s, { incidentId: 'INC-3', kind: 'WATER_LEVEL', value: 0 });
    tickUntil(s, st => st.incidents[0].status === 'RESOLVED', 100, 5);
    const r = command(s, { incidentId: 'INC-3', teamId: 'T1', action: 'RETURN' });
    tickUntil(s, st => cmd(st, r.id).status === 'CONFIRMED', 200, 5);
    // While returning: team busy, kit still reserved.
    addIncident(s, { id: 'INC-4', kind: 'MAN_OVERBOARD', position: posEast(0.2), crewOnboard: 1, initialWaterL: 0, ingressLpm: 0 });
    assert.throws(() => dispatch(s, { incidentId: 'INC-4', teamId: 'T1', personnel: 1, recoveryKit: false }), /not IDLE/);
    assert.throws(() => dispatch(s, { incidentId: 'INC-4', teamId: 'T2', personnel: 1, recoveryKit: true }), /recovery kit/);
    // Return completes: personnel and kit are released.
    tickUntil(s, st => team(st, 'T1').status === 'IDLE', 800, 5);
    let st = status(s);
    assert.equal(st.shared.recoveryKits.available, 1, 'kit released on return');
    assert.equal(team(st, 'T1').personnel.available, 4);
    // Reusable afterwards.
    dispatch(s, { incidentId: 'INC-4', teamId: 'T2', personnel: 1, recoveryKit: true });
    tickUntil(s, st2 => team(st2, 'T2').status === 'ON_SCENE', 400, 5);
    tickUntil(s, st2 => inc(st2, 'INC-4').crewRescued >= 1, 400, 5);
    sensorReport(s, { incidentId: 'INC-4', kind: 'WATER_LEVEL', value: 0 });
    tickUntil(s, st2 => inc(st2, 'INC-4').status === 'RESOLVED', 100, 5);
    const r2 = command(s, { incidentId: 'INC-4', teamId: 'T2', action: 'RETURN' });
    tickUntil(s, st2 => team(st2, 'T2').status === 'IDLE', 800, 5);
    st = status(s);
    assert.equal(st.allClear, true, 'green once everything is resolved and released');
});

test('received GPS staleness derives from fix sample time; old backlog after outage does not look fresh', () => {
    const s = createState();
    addIncident(s, { id: 'INC-5', kind: 'FLOODING', position: posEast(2), crewOnboard: 2, initialWaterL: 10, ingressLpm: 10 });
    dispatch(s, { incidentId: 'INC-5', teamId: 'T1', personnel: 2, recoveryKit: true });
    for (let i = 0; i < 12; i++) tick(s, 5); // 60s of continuous fixes
    let st = status(s);
    const t1 = team(st, 'T1');
    assert.ok(t1.telemetry.ageS <= 5 + 1e-9, 'telemetry fresh while moving (fix sampled within the last tick)');
    assert.ok(!t1.telemetry.stale);
    // Comms outage: fixes keep being sampled but cannot be delivered.
    setOutage(s, { teamId: 'T1', fromS: s.time, toS: s.time + 60 });
    tickUntil(s, st2 => team(st2, 'T1').telemetry.ageS > 45, 100, 5);
    st = status(s);
    const t2 = team(st, 'T1');
    assert.ok(t2.telemetry.stale, 'received fix must be stale after ' + st.limits.staleAfterS + 's without fixes');
    assert.ok(t2.telemetry.ageS > st.limits.staleAfterS);
    assert.notDeepEqual(t2.telemetry.receivedPos, t2.pos, 'received position lags the true position');
    assert.equal(t2.status, 'EN_ROUTE', 'true movement continues through the outage');
    assert.ok(t2.telemetry.receivedAt >= t2.telemetry.fixSentAt, 'receivedAt is tracked separately from the sample time');
    // Outage ends: queued fixes deliver in order; the last one is the freshest
    // sample, so staleness clears and the received position catches up.
    tickUntil(s, st3 => !team(st3, 'T1').telemetry.stale, 100, 5);
    st = status(s);
    const t3 = team(st, 'T1');
    assert.ok(t3.telemetry.ageS <= 10, 'freshest queued fix is recent after recovery');
    assert.ok(distanceKm(t3.telemetry.receivedPos, t3.pos) < 0.05, 'received position catches up after recovery');
});

test('lost command never executes; retransmit works; an outage delays (does not lose) commands', () => {
    const s = createState();
    addIncident(s, { id: 'INC-6', kind: 'FLOODING', position: posEast(0.3), crewOnboard: 2, initialWaterL: 10, ingressLpm: 20 });
    dispatch(s, { incidentId: 'INC-6', teamId: 'T1', personnel: 2, recoveryKit: true });
    tickUntil(s, st => team(st, 'T1').status === 'ON_SCENE', 400, 5);
    // 1) lost command
    const c1 = command(s, { incidentId: 'INC-6', teamId: 'T1', action: 'START_PUMP' });
    dropCommand(s, c1.id);
    tick(s, 30);
    let st = status(s);
    assert.equal(cmd(st, c1.id).status, 'LOST');
    assert.equal(cmd(st, c1.id).executedAt, null, 'a lost command never executes');
    assert.ok(st.incidents[0].waterL > 10, 'without the pump the water keeps rising');
    // 2) retransmit
    const c2 = command(s, { incidentId: 'INC-6', teamId: 'T1', action: 'START_PUMP' });
    tickUntil(s, st2 => cmd(st2, c2.id).status === 'EXECUTED', 100, 5);
    const w0 = status(s).incidents[0].waterL;
    tick(s, 60);
    assert.ok(status(s).incidents[0].waterL < w0, 'retransmitted pump is effective (25 > 20 lpm)');
    // 3) command sent during an outage: delayed, not lost
    setOutage(s, { teamId: 'T1', fromS: s.time, toS: s.time + 25 });
    const c3 = command(s, { incidentId: 'INC-6', teamId: 'T1', action: 'STOP_PUMP' });
    tick(s, 10);
    assert.equal(cmd(status(s), c3.id).status, 'SENT', 'waits in SENT during the outage');
    tickUntil(s, st3 => ['EXECUTED', 'CONFIRMED'].includes(cmd(st3, c3.id).status), 200, 5);
    st = status(s);
    const c3v = cmd(st, c3.id);
    assert.ok(c3v.executedAt !== null, 'stop was executed');
    assert.ok(c3v.receivedAt > c3v.sentAt + st.limits.propagationS, 'reception delayed by the outage');
    assert.equal(team(st, 'T1').pump.running, false, 'stop executed after recovery');
});

test('pump fault: command fails, sensors disagree, resolution only after a healthy pump', () => {
    const s = createState();
    addIncident(s, { id: 'INC-7', kind: 'FLOODING', position: posEast(0.3), crewOnboard: 2, initialWaterL: 10, ingressLpm: 20 });
    setPumpFault(s, { teamId: 'T1', fault: true });
    dispatch(s, { incidentId: 'INC-7', teamId: 'T1', personnel: 2, recoveryKit: true });
    tickUntil(s, st => team(st, 'T1').status === 'ON_SCENE', 400, 5);
    const c = command(s, { incidentId: 'INC-7', teamId: 'T1', action: 'START_PUMP' });
    tickUntil(s, st2 => cmd(st2, c.id).status === 'FAILED', 100, 5);
    let st = status(s);
    assert.equal(cmd(st, c.id).failReason, 'pump fault');
    assert.equal(team(st, 'T1').pump.running, false);
    // Sensor reading while the crew is still unrecovered -> not resolved.
    sensorReport(s, { incidentId: 'INC-7', kind: 'WATER_LEVEL', value: st.incidents[0].waterL });
    assert.equal(st.incidents[0].status, 'IN_PROGRESS', 'not resolved while crew is unrecovered');
    assert.ok(st.incidents[0].unsafe.includes('CREW_UNRESCUED'), 'crew unrecovered is visible as unsafe');
    // Healthy reinforcement resolves it.
    reinforce(s, { incidentId: 'INC-7', teamId: 'T2', personnel: 2, recoveryKit: false });
    tickUntil(s, st3 => team(st3, 'T2').status === 'ON_SCENE', 400, 5);
    const c2 = command(s, { incidentId: 'INC-7', teamId: 'T2', action: 'START_PUMP' });
    tickUntil(s, st4 => cmd(st4, c2.id).status === 'EXECUTED', 100, 5);
    // Crew is rescued by T1 (holds the kit) while T2 brings the water down.
    tickUntil(s, st5 => st5.incidents[0].crewRescued >= 2, 800, 5);
    tickUntil(s, st5b => st5b.incidents[0].waterL <= 50, 800, 5);
    st = status(s);
    assert.ok(st.incidents[0].crewRescued >= 2, 'crew recovered by T1 while T2 fixed the water');
    sensorReport(s, { incidentId: 'INC-7', kind: 'WATER_LEVEL', value: st.incidents[0].waterL });
    tickUntil(s, st6 => st6.incidents[0].status === 'RESOLVED', 100, 5);
    assert.equal(status(s).incidents[0].status, 'RESOLVED');
});

test('input validation: IDs, finite numbers, safe-integer personnel, coordinates, time — atomic rejection', () => {
    const s = createState();
    addIncident(s, { id: 'INC-V', kind: 'FLOODING', position: posEast(0.3), crewOnboard: 2, initialWaterL: 10, ingressLpm: 20 });
    assert.throws(() => dispatch(s, { incidentId: 'bad id!', teamId: 'T1', personnel: 1, recoveryKit: false }), /incidentId/);
    assert.throws(() => dispatch(s, { incidentId: 'INC-V', teamId: 'T9', personnel: 1, recoveryKit: false }), /unknown team/);
    for (const p of [0, -1, 2.5, NaN, Infinity, 1e21])
        assert.throws(() => dispatch(s, { incidentId: 'INC-V', teamId: 'T1', personnel: p, recoveryKit: false }), /personnel/);
    assert.throws(() => dispatch(s, { incidentId: 'INC-V', teamId: 'T1', personnel: 99, recoveryKit: false }), /personnel/);
    assert.throws(() => dispatch(s, { incidentId: 'INC-V', teamId: 'T1', personnel: 2, recoveryKit: 'yes' }), /recoveryKit/);
    // Valid dispatch, then double-booking checks.
    dispatch(s, { incidentId: 'INC-V', teamId: 'T1', personnel: 2, recoveryKit: true });
    assert.throws(() => dispatch(s, { incidentId: 'INC-V', teamId: 'T2', personnel: 2, recoveryKit: true }), /recovery kit/);
    assert.throws(() => dispatch(s, { incidentId: 'INC-V', teamId: 'T1', personnel: 1, recoveryKit: false }), /not IDLE/);
    // addIncident validation.
    assert.throws(() => addIncident(s, { id: 'INC-X', kind: 'FLOODING', position: { lat: 91, lon: 0 }, crewOnboard: 1, initialWaterL: 0, ingressLpm: 0 }), /position/);
    assert.throws(() => addIncident(s, { id: 'INC-X', kind: 'FLOODING', position: { lat: 0, lon: -181 }, crewOnboard: 1, initialWaterL: 0, ingressLpm: 0 }), /position/);
    assert.throws(() => addIncident(s, { id: 'INC-X', kind: 'FLOODING', position: { lat: NaN, lon: 0 }, crewOnboard: 1, initialWaterL: 0, ingressLpm: 0 }), /position/);
    assert.throws(() => addIncident(s, { id: 'INC-X', kind: 'FLOODING', position: posEast(1), crewOnboard: 1, initialWaterL: -5, ingressLpm: 0 }), /initialWaterL/);
    assert.throws(() => addIncident(s, { id: 'INC-X', kind: 'FLOODING', position: posEast(1), crewOnboard: 1.5, initialWaterL: 0, ingressLpm: 0 }), /crewOnboard/);
    assert.throws(() => addIncident(s, { id: 'INC-X', kind: 'FLOODING', position: posEast(1), crewOnboard: 1, initialWaterL: 0, ingressLpm: 0, reportedAt: -1 }), /reportedAt/);
    assert.throws(() => addIncident(s, { id: 'INC-X', kind: 'NOT_A_KIND', position: posEast(1), crewOnboard: 1, initialWaterL: 0, ingressLpm: 0 }), /kind/);
    assert.throws(() => addIncident(s, { id: 'INC-V', kind: 'FLOODING', position: posEast(1), crewOnboard: 1, initialWaterL: 0, ingressLpm: 0 }), /already exists/);
    // tick validation.
    assert.throws(() => tick(s, 0), /dtS/);
    assert.throws(() => tick(s, NaN), /dtS/);
    assert.throws(() => tick(s, -5), /dtS/);
    assert.throws(() => tick(s, 1e9), /dtS/);
    // sensorReport validation.
    assert.throws(() => sensorReport(s, { incidentId: 'INC-V', kind: 'PUMP_STATE', value: 'weird' }), /PUMP_STATE/);
    assert.throws(() => sensorReport(s, { incidentId: 'INC-V', kind: 'PUMP_STATE', value: 'on' }), /teamId/);
    assert.throws(() => sensorReport(s, { incidentId: 'INC-V', kind: 'WATER_LEVEL', value: -1 }), /WATER_LEVEL/);
    // Atomicity: only the single valid dispatch was applied.
    const st = status(s);
    assert.equal(team(st, 'T1').status, 'EN_ROUTE');
    assert.equal(st.missions.length, 1);
    assert.equal(st.shared.recoveryKits.available, 0);
    assert.equal(st.incidents.length, 1);
});

test('impossible transitions rejected: return off-scene, work on resolved incident, reinforce without mission, drop executed command', () => {
    const s = createState();
    addIncident(s, { id: 'INC-T', kind: 'MAN_OVERBOARD', position: posEast(0.2), crewOnboard: 1, initialWaterL: 0, ingressLpm: 0 });
    assert.throws(() => command(s, { incidentId: 'INC-T', teamId: 'T1', action: 'RETURN' }), /no active mission/);
    assert.throws(() => command(s, { incidentId: 'INC-T', teamId: 'T1', action: 'STOP_PUMP' }), /no active mission/);
    dispatch(s, { incidentId: 'INC-T', teamId: 'T1', personnel: 1, recoveryKit: true });
    tickUntil(s, st => team(st, 'T1').status === 'ON_SCENE', 400, 5);
    tickUntil(s, st => st.incidents[0].crewRescued >= 1, 400, 5);
    sensorReport(s, { incidentId: 'INC-T', kind: 'WATER_LEVEL', value: 0 });
    tickUntil(s, st => st.incidents[0].status === 'RESOLVED', 100, 5);
    assert.throws(() => dispatch(s, { incidentId: 'INC-T', teamId: 'T2', personnel: 1, recoveryKit: false }), /resolved/);
    assert.throws(() => command(s, { incidentId: 'INC-T', teamId: 'T1', action: 'START_PUMP' }), /resolved/);
    // Reinforce requires an existing active mission.
    addIncident(s, { id: 'INC-U', kind: 'MAN_OVERBOARD', position: posEast(0.2), crewOnboard: 1, initialWaterL: 0, ingressLpm: 0 });
    assert.throws(() => reinforce(s, { incidentId: 'INC-U', teamId: 'T2', personnel: 1, recoveryKit: false }), /no active mission/);
    // RETURN is still allowed on a resolved incident; a confirmed command cannot be lost.
    const r = command(s, { incidentId: 'INC-T', teamId: 'T1', action: 'RETURN' });
    tickUntil(s, st => cmd(st, r.id).status === 'CONFIRMED', 400, 5);
    assert.throws(() => dropCommand(s, r.id), /can no longer be lost/);
    assert.throws(() => dropCommand(s, 'C-999'), /unknown command/);
});

test('pump commands are incident-scoped: STOP_PUMP for incident B cannot stop incident A pump', () => {
    const s = createState();
    addIncident(s, { id: 'INC-A', kind: 'FLOODING', position: posEast(0.3), crewOnboard: 1, initialWaterL: 10, ingressLpm: 20 });
    addIncident(s, { id: 'INC-B', kind: 'FLOODING', position: posEast(0.5), crewOnboard: 1, initialWaterL: 10, ingressLpm: 20 });
    dispatch(s, { incidentId: 'INC-A', teamId: 'T1', personnel: 2, recoveryKit: true });
    tickUntil(s, st => team(st, 'T1').status === 'ON_SCENE', 400, 5);
    const cA = command(s, { incidentId: 'INC-A', teamId: 'T1', action: 'START_PUMP' });
    tickUntil(s, st => cmd(st, cA.id).status === 'EXECUTED', 100, 5);
    assert.equal(team(status(s), 'T1').pump.running, true);
    // No active mission for B: a B-scoped command cannot be sent at all.
    assert.throws(() => command(s, { incidentId: 'INC-B', teamId: 'T1', action: 'STOP_PUMP' }), /no active mission/);
    // The A-scoped stop works and is confirmed.
    const cStop = command(s, { incidentId: 'INC-A', teamId: 'T1', action: 'STOP_PUMP' });
    tickUntil(s, st => cmd(st, cStop.id).status === 'CONFIRMED', 200, 5);
    assert.equal(team(status(s), 'T1').pump.running, false);
});

test('resolved incident is not frozen: continuing ingress reopens it after the pump stops', () => {
    const s = createState();
    addIncident(s, { id: 'INC-R', kind: 'FLOODING', position: posEast(0.3), crewOnboard: 1, initialWaterL: 10, ingressLpm: 10 });
    dispatch(s, { incidentId: 'INC-R', teamId: 'T1', personnel: 2, recoveryKit: true });
    tickUntil(s, st => team(st, 'T1').status === 'ON_SCENE', 400, 5);
    const c1 = command(s, { incidentId: 'INC-R', teamId: 'T1', action: 'START_PUMP' });
    tickUntil(s, st => cmd(st, c1.id).status === 'EXECUTED', 100, 5);
    tickUntil(s, st => st.incidents[0].waterL <= 50, 800, 5);
    sensorReport(s, { incidentId: 'INC-R', kind: 'WATER_LEVEL', value: status(s).incidents[0].waterL });
    tickUntil(s, st => st.incidents[0].status === 'RESOLVED', 100, 5);
    // Operator stops the pump and returns; ingress (10 lpm) continues.
    const cStop = command(s, { incidentId: 'INC-R', teamId: 'T1', action: 'STOP_PUMP' });
    tickUntil(s, st => ['EXECUTED', 'CONFIRMED'].includes(cmd(st, cStop.id).status), 100, 5);
    const r = command(s, { incidentId: 'INC-R', teamId: 'T1', action: 'RETURN' });
    tickUntil(s, st => cmd(st, r.id).status === 'CONFIRMED', 400, 5);
    // Water must rise back above the safe level and the incident reopens.
    tickUntil(s, st => st.incidents[0].status === 'IN_PROGRESS', 800, 5);
    const st = status(s);
    assert.ok(st.incidents[0].waterL > 50, 'physical water dynamics continue after resolution');
    assert.ok(st.incidents[0].unsafe.includes('WATER_ABOVE_SAFE'));
    assert.equal(st.allClear, false, 'no green while the condition is unsafe again');
    assert.ok(st.events.last.some(e => e.kind === 'REOPENED'), 'reopening is visible in the event log');
});

test('deterministic: identical inputs produce identical state trajectories', () => {
    function run() {
        const s = createState();
        addIncident(s, { id: 'INC-D', kind: 'FLOODING', position: posEast(0.2), crewOnboard: 3, initialWaterL: 15, ingressLpm: 25 });
        dispatch(s, { incidentId: 'INC-D', teamId: 'T1', personnel: 3, recoveryKit: true });
        for (let i = 0; i < 40; i++) tick(s, 5);
        command(s, { incidentId: 'INC-D', teamId: 'T1', action: 'START_PUMP' });
        for (let i = 0; i < 40; i++) tick(s, 5);
        sensorReport(s, { incidentId: 'INC-D', kind: 'WATER_LEVEL', value: status(s).incidents[0].waterL });
        tick(s, 5);
        return JSON.stringify(status(s));
    }
    assert.equal(run(), run(), 'two identical runs must produce byte-identical state views');
});

test('fuel is consumed on the move; a low-fuel team strands and the incident stays unresolved', () => {
    const s = createState({
        harbour: { ...HARBOUR },
        teams: [{ id: 'T1', name: 'Low Fuel', home: { ...HARBOUR }, capacity: 2, personnel: 2,
            pump: { available: true, lpm: 30 }, fuelL: 5, speedKn: 12 }],
        shared: { recoveryKits: 1 }
    });
    addIncident(s, { id: 'INC-F', kind: 'FLOODING', position: posEast(5), crewOnboard: 2, initialWaterL: 10, ingressLpm: 10 });
    dispatch(s, { incidentId: 'INC-F', teamId: 'T1', personnel: 2, recoveryKit: true });
    tickUntil(s, st => st.teams[0].status === 'NO_FUEL', 4000, 10);
    const st = status(s);
    assert.equal(st.teams[0].status, 'NO_FUEL');
    assert.ok(st.teams[0].fuelL <= 1e-9, 'fuel cannot go negative');
    assert.equal(st.missions[0].status, 'STALLED');
    assert.equal(st.incidents[0].status, 'OPEN', 'never arrived, so the incident was never made in-progress');
    assert.equal(st.allClear, false, 'no green while a team is stranded at sea');
});

test('partial personnel allocation limits the rescue rate and leaves crew ashore', () => {
    const s = createState();
    addIncident(s, { id: 'INC-P', kind: 'MAN_OVERBOARD', position: posEast(0.2), crewOnboard: 2, initialWaterL: 0, ingressLpm: 0 });
    dispatch(s, { incidentId: 'INC-P', teamId: 'T2', personnel: 3, recoveryKit: true }); // 3 of 6
    assert.equal(team(status(s), 'T2').personnel.available, 3, 'unassigned personnel remain ashore');
    tickUntil(s, st => team(st, 'T2').status === 'ON_SCENE', 400, 5);
    const t0 = status(s).time;
    tickUntil(s, st => st.incidents[0].crewRescued >= 2, 400, 5);
    const elapsed = status(s).time - t0;
    // 3 personnel * 0.5/min = 1.5 crew/min -> 2 crew in ~80s (not the 40s a full crew would take).
    assert.ok(elapsed >= 75 && elapsed <= 100, 'rescue time must reflect the 3 assigned personnel, got ' + elapsed + 's');
});


test('large-tick equivalence: a 300s tick equals sixty 5s ticks (no event skipped)', () => {
    function build() {
        const s = createState();
        addIncident(s, { id: 'INC-EQ', kind: 'FLOODING', position: posEast(0.5), crewOnboard: 2, initialWaterL: 15, ingressLpm: 20 });
        dispatch(s, { incidentId: 'INC-EQ', teamId: 'T1', personnel: 2, recoveryKit: true });
        return s;
    }
    const big = build();
    tick(big, 300);
    const small = build();
    for (let i = 0; i < 60; i++) tick(small, 5);
    const a = status(big);
    const b = status(small);
    assert.equal(a.time, b.time, 'same simulated time');
    assert.equal(a.incidents[0].waterL, b.incidents[0].waterL, 'same water level');
    assert.equal(a.teams[0].fuelL, b.teams[0].fuelL, 'same fuel');
    assert.equal(a.teams[0].status, b.teams[0].status, 'same team status');
    assert.equal(a.missions[0].status, b.missions[0].status, 'same mission status');
    assert.ok(Math.abs(a.teams[0].pos.lat - b.teams[0].pos.lat) < 1e-9, 'same latitude');
    assert.ok(Math.abs(a.teams[0].pos.lon - b.teams[0].pos.lon) < 1e-9, 'same longitude');
});

test('final-return fuel exhaustion: a team stranding on the return leg does not release resources', () => {
    const s = createState({
        harbour: { ...HARBOUR },
        teams: [{ id: 'T1', name: 'Tight Fuel', home: { ...HARBOUR }, capacity: 2, personnel: 2,
            pump: { available: true, lpm: 30 }, fuelL: 10, speedKn: 12 }],
        shared: { recoveryKits: 1 }
    });
    addIncident(s, { id: 'INC-RT', kind: 'MAN_OVERBOARD', position: posEast(2), crewOnboard: 1, initialWaterL: 0, ingressLpm: 0 });
    dispatch(s, { incidentId: 'INC-RT', teamId: 'T1', personnel: 2, recoveryKit: true });
    tickUntil(s, st => team(st, 'T1').status === 'ON_SCENE', 400, 5);
    tickUntil(s, st => st.incidents[0].crewRescued >= 1, 400, 5);
    sensorReport(s, { incidentId: 'INC-RT', kind: 'WATER_LEVEL', value: 0 });
    tickUntil(s, st => st.incidents[0].status === 'RESOLVED', 100, 5);
    const r = command(s, { incidentId: 'INC-RT', teamId: 'T1', action: 'RETURN' });
    tickUntil(s, st => ['EXECUTED', 'CONFIRMED'].includes(cmd(st, r.id).status), 200, 5);
    // The return leg (2 km at 12 kn) costs more fuel than remains: the team strands at sea.
    tickUntil(s, st => st.teams[0].status === 'NO_FUEL', 4000, 5);
    const st = status(s);
    assert.equal(st.teams[0].status, 'NO_FUEL', 'stranded on the return leg');
    assert.equal(st.missions[0].status, 'STALLED', 'mission stalled, not completed');
    assert.equal(st.shared.recoveryKits.available, 0, 'kit NOT released while stranded');
    assert.equal(st.teams[0].personnel.available, 0, 'personnel NOT released while stranded');
    assert.equal(st.allClear, false, 'no green while a team is stranded at sea');
});

fs.writeFileSync(reportPath, JSON.stringify({
    at: new Date().toISOString(),
    model: 'seaguard/src/rescue/model.cjs',
    revision: 2,
    tests: outcomes
}, null, 2));
for (const r of outcomes) console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error.split('\n')[0] : ''}`);
console.log(`${outcomes.filter(r => r.passed).length}/${outcomes.length} rescue-model scenarios passed`);
process.exitCode = outcomes.some(r => !r.passed) ? 1 : 0;
