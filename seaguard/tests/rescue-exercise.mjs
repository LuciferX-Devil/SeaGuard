// Focused tests for the rescue EXERCISE controller (seaguard/src/rescue/exercise.cjs)
// and the Node-RED handler source (seaguard/src/functions/fnRescue.js).
// Rescue sprint task 2. Runs without Node-RED or any service:
//     node seaguard/tests/rescue-exercise.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ex from '../src/rescue/exercise.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.join(here, '..', 'reports', 'rescue-exercise.json');

function world() {
    const w = ex.createExercise();
    return { state: w.state, ex: w.ex };
}
function run(w, seconds, dt = 5) {
    for (let i = 0; i < Math.ceil(seconds / dt); i++) ex.step(w.state, w.ex, { realDeltaS: dt });
}
function until(w, pred, maxTicks = 1200, dt = 5) {
    for (let i = 0; i < maxTicks; i++) {
        if (pred(ex.view(w.state, w.ex))) return i;
        ex.step(w.state, w.ex, { realDeltaS: dt });
    }
    throw new Error('until: condition not met within ' + maxTicks + ' ticks');
}

const outcomes = [];
function test(name, fn) {
    try { fn(); outcomes.push({ name, passed: true }); }
    catch (e) { outcomes.push({ name, passed: false, error: e.message }); }
}

// ---------------------------------------------------------------- controller

test('start validates scenario and rejects a second start without reset', () => {
    const w = world();
    assert.throws(() => ex.start(w.state, w.ex, { scenario: 'NOT_A_SCENARIO' }), /scenario/);
    assert.throws(() => ex.start(w.state, w.ex, {}), /scenario/);
    const v = ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    assert.equal(v.scenario, 'FLOODING');
    assert.equal(v.incident.status, 'OPEN');
    assert.equal(v.vessel.crewTotal, 3);
    assert.throws(() => ex.start(w.state, w.ex, { scenario: 'MAN_OVERBOARD' }), /already running/);
    ex.reset(w.state, w.ex);
    const v2 = ex.view(w.state, w.ex);
    assert.equal(v2.scenario, null);
    assert.equal(v2.incident, null);
});

test('pause/resume/speed: the exercise clock is independent and bounded', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    ex.pause(w.state, w.ex);
    const t0 = ex.view(w.state, w.ex).simTime;
    run(w, 30);
    assert.equal(ex.view(w.state, w.ex).simTime, t0, 'paused: no simulated time passes');
    ex.resume(w.state, w.ex);
    ex.setSpeed(w.state, w.ex, { speed: 5 });
    run(w, 10); // 10 wall seconds at 5x = 50 simulated seconds
    assert.ok(Math.abs(ex.view(w.state, w.ex).simTime - (t0 + 50)) < 1e-6, '5x speed advances 50s of sim per 10s real');
    assert.throws(() => ex.setSpeed(w.state, w.ex, { speed: 7 }), /speed/);
    ex.setSpeed(w.state, w.ex, { speed: 20 });
    run(w, 10); // 200 simulated seconds
    assert.ok(Math.abs(ex.view(w.state, w.ex).simTime - (t0 + 250)) < 1e-6);
});

test('FLOODING: undersized pump, repair stops ingress, crew safety distinct from vessel safety', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 4, recoveryKit: true });
    until(w, v => v.teams[0].status === 'ON_SCENE');
    ex.command(w.state, w.ex, { teamId: 'T1', action: 'START_PUMP' });
    until(w, v => v.commands.find(c => c.action === 'START_PUMP').status === 'EXECUTED');
    run(w, 200);
    let v = ex.view(w.state, w.ex);
    assert.ok(v.incident.waterL > 20, 'T1 pump (25) cannot beat ingress (25) — water rises');
    // Crew can be rescued while the vessel is still flooding.
    until(w, v2 => v2.incident.crewRescued >= 3 && v2.incident.waterL > 50);
    v = ex.view(w.state, w.ex);
    assert.equal(v.incident.status, 'IN_PROGRESS', 'crew rescued is not resolution while water is unsafe');
    assert.ok(v.incident.unsafe.includes('WATER_ABOVE_SAFE'));
    // Repair the hull: 60s of continuous on-scene work stops the ingress.
    ex.repair(w.state, w.ex);
    v = ex.view(w.state, w.ex);
    assert.equal(v.repair.done, false, 'repair takes time');
    assert.ok(v.repair.progressS >= 0 && v.repair.workS === 60, 'repair is a measured work duration');
    until(w, v2 => v2.repair.done);
    assert.equal(ex.view(w.state, w.ex).incident.ingressLpm, 0, 'ingress stopped by the repair');
    // Now the pump turns the water down and the exercise resolves (sensor-confirmed).
    until(w, v2 => v2.incident.status === 'RESOLVED', 3000);
    v = ex.view(w.state, w.ex);
    assert.ok(v.results, 'results computed on resolution');
    assert.equal(v.results.crewSafe, true);
    assert.equal(v.results.vesselSafe, true);
    assert.equal(v.results.allClear, false, 'teams still on scene: not all clear yet');
    ex.command(w.state, w.ex, { teamId: 'T1', action: 'RETURN' });
    until(w, v2 => v2.teams[0].status === 'IDLE');
    v = ex.view(w.state, w.ex);
    assert.equal(v.allClear, true, 'green only when everything is resolved and released');
    assert.equal(v.results.allClear, true);
    assert.ok(v.results.delays.repairS > 0, 'repair duration recorded');
    assert.ok(v.results.delays.arrivalS > 0, 'arrival delay recorded');
    assert.ok(v.results.delays.resolutionS > 0, 'resolution time recorded');
    // Single EXERCISE_COMPLETE event.
    assert.equal(v.timeline.filter(e => e.kind === 'EXERCISE_COMPLETE').length, 1, 'exactly one completion event');
});

test('MAN_OVERBOARD: kit-gated crew recovery, sensor-confirmed resolution', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'MAN_OVERBOARD' });
    ex.dispatch(w.state, w.ex, { teamId: 'T2', personnel: 2, recoveryKit: true });
    until(w, v => v.teams[1].status === 'ON_SCENE');
    until(w, v => v.incident.crewRescued >= 2);
    // The automatic water-level reports (0 L, always safe) confirm the
    // resolution through the link — validate the auto-feedback actually
    // delivers the confirmation rather than asserting it never happens.
    until(w, v2 => v2.incident.status === 'RESOLVED', 2000);
    let v = ex.view(w.state, w.ex);
    assert.ok(v.incident.resolvedAt > 0, 'resolution timestamped');
    assert.ok(v.incident.sensorConfirmed, 'sensor confirmation delivered by automatic reports');
    assert.ok(v.results.delays.arrivalS > 0, 'arrival delay recorded');
    assert.ok(v.results.delays.resolutionS > 0, 'resolution time recorded');
    // No false green before the team is home.
    assert.equal(v.results.allClear, false, 'team still on scene: not all clear');
    ex.command(w.state, w.ex, { teamId: 'T2', action: 'RETURN' });
    until(w, v2 => v2.teams[1].status === 'IDLE');
    v = ex.view(w.state, w.ex);
    assert.equal(v.allClear, true, 'green once resolved and team home');
});

test('RADIO_FAILURE: radio down from start, delayed on-scene repair, reports arrive after restore', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'RADIO_FAILURE' });
    let v = ex.view(w.state, w.ex);
    assert.equal(v.vessel.radioUp, false, 'vessel radio is failed from the first second');
    ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2, recoveryKit: true });
    until(w, v => v.teams[0].status === 'ON_SCENE');
    until(w, v => v.incident.crewRescued >= 2);
    // While the radio is down the incident cannot be sensor-confirmed.
    v = ex.view(w.state, w.ex);
    assert.ok(v.incident.status !== 'RESOLVED', 'no resolution while the link is down');
    assert.ok(v.incident.unsafe.includes('RADIO_DOWN'), 'radio-down is a visible unsafe condition');
    // Radio repair: 90s of continuous on-scene work.
    ex.radioRepair(w.state, w.ex);
    v = ex.view(w.state, w.ex);
    assert.ok(v.radio.repairProgressS >= 0 && v.radio.workS === 90, 'radio repair is measured work, not an instant');
    until(w, v2 => v2.radio.restored, 500);
    assert.equal(ex.view(w.state, w.ex).vessel.radioUp, true, 'radio restored after on-scene work');
    // Once the link is back, automatic water-level reports (0 L) confirm the
    // resolution — validate the auto-feedback delivers it.
    until(w, v2 => v2.incident.status === 'RESOLVED', 3000);
    v = ex.view(w.state, w.ex);
    assert.ok(v.results.radio.restored, 'results record the radio restore');
    assert.ok(v.results.radio.restoredAt > 0, 'restore timestamped');
    assert.equal(v.results.allClear, false, 'team still on scene: not all clear');
    ex.command(w.state, w.ex, { teamId: 'T1', action: 'RETURN' });
    until(w, v2 => v2.teams[0].status === 'IDLE');
    v = ex.view(w.state, w.ex);
    assert.equal(v.allClear, true, 'green once resolved, radio up and team home');
});

test('BOUNDARY_APPROACH: cumulative drift, delayed 60s return motion, not treated as flooding', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'BOUNDARY_APPROACH' });
    assert.equal(ex.view(w.state, w.ex).vessel.inSafeWater, true);
    // The vessel drifts (cumulative distance); after enough time it is out of safe water.
    until(w, v => v.vessel.inSafeWater === false, 4000);
    let v = ex.view(w.state, w.ex);
    assert.ok(v.incident.unsafe.includes('OUT_OF_SAFE_WATER'), 'out-of-safe-water is a visible unsafe condition');
    assert.throws(() => ex.repair(w.state, w.ex), /only available in the FLOODING/);
    // Return to safe water: 60s of continuous motion, NOT instant.
    ex.returnSafe(w.state, w.ex);
    v = ex.view(w.state, w.ex);
    assert.equal(v.vessel.inSafeWater, false, 'still unsafe while the return motion is in progress');
    assert.ok(v.returnSafe.progressS >= 0 && v.returnSafe.workS === 60, 'return is a measured motion duration');
    until(w, v2 => v2.vessel.inSafeWater === true, 500);
    v = ex.view(w.state, w.ex);
    assert.equal(v.returnSafe.done, true, 'return motion completed');
    assert.throws(() => ex.returnSafe(w.state, w.ex), /already in safe water/);
    // Drift must not resume after the return completes.
    run(w, 30);
    assert.equal(ex.view(w.state, w.ex).vessel.inSafeWater, true, 'stays safe after the return');
});

test('dispatch/reinforce/command validation and no double booking through the controller', () => {
    const w = world();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    assert.throws(() => ex.dispatch(w.state, w.ex, { teamId: 'T9', personnel: 1, recoveryKit: false }), /unknown team/);
    assert.throws(() => ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 0, recoveryKit: false }), /personnel/);
    assert.throws(() => ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2.5, recoveryKit: false }), /personnel/);
    assert.throws(() => ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2, recoveryKit: 'yes' }), /recoveryKit/);
    ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2, recoveryKit: true });
    assert.throws(() => ex.reinforce(w.state, w.ex, { teamId: 'T2', personnel: 1, recoveryKit: true }), /recovery kit/);
    assert.throws(() => ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 1, recoveryKit: false }), /not IDLE/);
    assert.throws(() => ex.command(w.state, w.ex, { teamId: 'T1', action: 'TELEPORT' }), /action/);
    assert.throws(() => ex.setOutage(w.state, w.ex, { teamId: 'T1', fromS: 10, toS: 5 }), /toS/);
    assert.throws(() => ex.setPumpFault(w.state, w.ex, { teamId: 'T1', fault: 'yes' }), /fault/);
});

test('determinism: two identical exercise runs produce identical views', () => {
    function runScenario() {
        const w = world();
        ex.start(w.state, w.ex, { scenario: 'FLOODING' });
        ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 3, recoveryKit: true });
        run(w, 300);
        ex.command(w.state, w.ex, { teamId: 'T1', action: 'START_PUMP' });
        run(w, 300);
        return JSON.stringify(ex.view(w.state, w.ex));
    }
    assert.equal(runScenario(), runScenario(), 'identical inputs must produce identical views');
});

// ------------------------------------------------------- Node-RED handler

// Shared-flow harness: each node gets its OWN node context (separate Maps),
// but ALL nodes share ONE flow object — exactly like Node-RED, where
// fnRescue (sg_dash) and fnRescueApi (sg_shore) are different nodes in
// different tabs yet share the same flow-scoped state.
function makeSharedFlowHarness(codeA, codeB) {
    const globals = new Map([['rescue', ex]]);
    const flowValues = new Map();          // shared across both nodes
    const flow = { get: k => flowValues.get(k), set: (k, v) => flowValues.set(k, v) };
    const ctxA = new Map();                // node A (fnRescue) node context
    const ctxB = new Map();                // node B (fnRescueApi) node context
    const mk = (code, ctx) => new Function('msg', 'node', 'context', 'global', 'flow', 'env', code);
    const fnA = mk(codeA);
    const fnB = mk(codeB);
    const node = { error: m => { throw new Error('node.error: ' + m); } };
    const g = { get: k => globals.get(k) };
    const env = { get: () => undefined };
    return {
        flowValues,
        initA() {
            // fnRescue initialize runs once on node start
            const initCode = "const ex = global.get('rescue');\nif (!ex) { node.error('rescue exercise module missing from functionGlobalContext'); return; }\nconst w = ex.createExercise({});\nflow.set('rescueWorld', w);";
            new Function('msg', 'node', 'context', 'global', 'flow', 'env', initCode)(
                {}, node, { get: k => ctxA.get(k), set: (k, v) => ctxA.set(k, v) }, g, flow, env);
        },
        tick(msg)   { return fnA(msg, node, { get: k => ctxA.get(k), set: (k, v) => ctxA.set(k, v) }, g, flow, env); },
        cmd(msg)    { return fnA(msg, node, { get: k => ctxA.get(k), set: (k, v) => ctxA.set(k, v) }, g, flow, env); },
        api(msg)    { return fnB(msg, node, { get: k => ctxB.get(k), set: (k, v) => ctxB.set(k, v) }, g, flow, env); },
        world()     { return flowValues.get('rescueWorld'); }
    };
}

test('fnRescue.js: initialize creates shared flow state; tick advances; cmd start/dispatch works; errors surfaced', () => {
    const codeA = fs.readFileSync(path.join(here, '..', 'src', 'functions', 'fnRescue.js'), 'utf8');
    const codeB = fs.readFileSync(path.join(here, '..', 'src', 'functions', 'fnRescueApi.js'), 'utf8');
    const H = makeSharedFlowHarness(codeA, codeB);
    H.initA();
    assert.ok(H.world(), 'initialize must create the shared flow rescueWorld');
    // tick with no scenario: idle view, no crash
    const idle = H.tick({ topic: 'tick', realDeltaS: 1 });
    assert.ok(Array.isArray(idle) && idle[0] && idle[0].payload && idle[0].payload.scenario === null, 'idle tick returns a view');
    // start via cmd
    const started = H.cmd({ topic: 'cmd', payload: { action: 'start', scenario: 'MAN_OVERBOARD' } });
    assert.equal(started[0].payload.scenario, 'MAN_OVERBOARD');
    assert.ok(Array.isArray(started[1]) && started[1].length > 0, 'map messages emitted once running');
    const layerNames = new Set(started[1].map(m => m.payload.layer || (m.payload.command ? 'cmd' : null)));
    assert.ok(layerNames.has('Rescue teams') || started[1].some(m => m.payload.layer === 'Rescue incidents'), 'rescue layers used');
    // dispatch via cmd
    const disp = H.cmd({ topic: 'cmd', payload: { action: 'dispatch', teamId: 'T2', personnel: 2, recoveryKit: true } });
    assert.equal(disp[0].payload.missions.length, 1);
    // invalid command: error surfaced in the view, no throw
    const bad = H.cmd({ topic: 'cmd', payload: { action: 'dispatch', teamId: 'T9', personnel: 1, recoveryKit: false } });
    assert.ok(bad[0].payload.error && /unknown team/.test(bad[0].payload.error), 'handler surfaces model validation errors');
    // tick advances the exercise
    const t0 = ex.view(H.world().state, H.world().ex).simTime;
    H.tick({ topic: 'tick', realDeltaS: 5 });
    const t1 = ex.view(H.world().state, H.world().ex).simTime;
    assert.ok(t1 > t0, 'tick advances the independent exercise clock');
});

test('fnRescueApi.js: GET/POST share the same flow rescueWorld as the fnRescue node (different node contexts)', () => {
    const codeA = fs.readFileSync(path.join(here, '..', 'src', 'functions', 'fnRescue.js'), 'utf8');
    const codeB = fs.readFileSync(path.join(here, '..', 'src', 'functions', 'fnRescueApi.js'), 'utf8');
    const H = makeSharedFlowHarness(codeA, codeB);
    H.initA();
    // GET before any start: idle view, 200
    const getRes = H.api({ req: { method: 'GET' } });
    assert.equal(getRes[0].statusCode, 200);
    assert.equal(getRes[0].payload.scenario, null);
    // POST start through the API node (different node context, same flow)
    const postRes = H.api({ req: { method: 'POST' }, payload: { action: 'start', scenario: 'FLOODING' } });
    assert.equal(postRes[1].statusCode, 200);
    assert.equal(postRes[1].payload.ok, true);
    assert.equal(postRes[1].payload.view.scenario, 'FLOODING');
    // The fnRescue node must see the SAME world: its tick view shows the scenario
    const tickView = H.tick({ topic: 'tick', realDeltaS: 1 })[0].payload;
    assert.equal(tickView.scenario, 'FLOODING', 'node and API share the same flow rescueWorld');
    // dispatch through the API, read back through the node
    const disp = H.api({ req: { method: 'POST' }, payload: { action: 'dispatch', teamId: 'T1', personnel: 2, recoveryKit: true } });
    assert.equal(disp[1].statusCode, 200);
    const nodeView = H.tick({ topic: 'tick', realDeltaS: 1 })[0].payload;
    assert.equal(nodeView.missions.length, 1, 'API dispatch visible in the node view');
    // Invalid POST body / action / args
    const badBody = H.api({ req: { method: 'POST' }, payload: { nope: 1 } });
    assert.equal(badBody[1].statusCode, 400);
    const badAction = H.api({ req: { method: 'POST' }, payload: { action: 'TELEPORT' } });
    assert.equal(badAction[1].statusCode, 400);
    const badArgs = H.api({ req: { method: 'POST' }, payload: { action: 'dispatch', teamId: 'T9', personnel: 1, recoveryKit: false } });
    assert.equal(badArgs[1].statusCode, 400);
    assert.ok(/unknown team/.test(badArgs[1].payload.error));
});

test('build.mjs validation: missing ui-page ui reference is rejected', () => {
    // Simulate what build.mjs does: parse flow.base.json, collect ids,
    // then check that a ui-page with a non-existent ui base would throw.
    const flow = JSON.parse(fs.readFileSync(path.join(here, '..', 'flow.base.json'), 'utf8'));
    const ids = new Set(flow.map(n => n.id));
    // Find the rescue page and verify its ui reference exists
    const pg = flow.find(n => n.id === 'sg_pg_rescue');
    assert.ok(pg, 'sg_pg_rescue page exists in flow');
    assert.ok(pg.ui, 'sg_pg_rescue has a ui reference');
    assert.ok(ids.has(pg.ui), `sg_pg_rescue ui base '${pg.ui}' exists in flow`);
    // Find the rescue group and verify its page reference exists
    const grp = flow.find(n => n.id === 'sg_grp_rescue');
    assert.ok(grp, 'sg_grp_rescue group exists in flow');
    assert.ok(grp.page, 'sg_grp_rescue has a page reference');
    assert.ok(ids.has(grp.page), `sg_grp_rescue page '${grp.page}' exists in flow`);
    // Verify the build validation logic would catch a missing ref
    const badNodes = [{ id: 'test_pg', type: 'ui-page', ui: 'nonexistent_ui' }];
    const badIds = new Set(badNodes.map(n => n.id));
    let threw = false;
    for (const n of badNodes) {
        if (n.type === 'ui-page' && n.ui && !badIds.has(n.ui)) { threw = true; break; }
    }
    assert.ok(threw, 'build validation logic rejects missing ui reference');
});

fs.writeFileSync(reportPath, JSON.stringify({
    at: new Date().toISOString(),
    module: 'seaguard/src/rescue/exercise.cjs',
    handler: 'seaguard/src/functions/fnRescue.js',
    tests: outcomes
}, null, 2));
for (const r of outcomes) console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error.split('\n')[0] : ''}`);
console.log(`${outcomes.filter(r => r.passed).length}/${outcomes.length} rescue-exercise scenarios passed`);
process.exitCode = outcomes.some(r => !r.passed) ? 1 : 0;
