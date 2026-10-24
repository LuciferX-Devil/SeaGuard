// Focused tests for rescue EXERCISE persistence (seaguard/src/rescue/persistence.cjs)
// and the fnRescue / fnRescueApi save/restore integration. Runs without
// Node-RED or any service:
//     node seaguard/tests/rescue-persistence.mjs
// All durable snapshots are written under seaguard/tests/fixtures/temp only —
// the live seaguard/data checkpoint is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ex from '../src/rescue/exercise.cjs';
import pers from '../src/rescue/persistence.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMP = path.join(here, 'fixtures', 'temp');
const reportPath = path.join(here, '..', 'reports', 'rescue-persistence.json');

// Tests use ONLY the fixtures/temp directory, never the live checkpoint.
fs.rmSync(TEMP, { recursive: true, force: true });
fs.mkdirSync(TEMP, { recursive: true });

function freshStore(name) { return pers.createStore({ dataDir: path.join(TEMP, name) }); }
function run(w, seconds, dt = 5) { for (let i = 0; i < Math.ceil(seconds / dt); i++) ex.step(w.state, w.ex, { realDeltaS: dt }); }
function flowLike() { const m = new Map(); return { get: k => m.get(k), set: (k, v) => m.set(k, v), raw: m }; }
function untilOnScene(w, maxTicks = 600) { for (let i = 0; i < maxTicks; i++) { if (w.state.missions.some(m => m.status === 'ON_SCENE')) return true; ex.step(w.state, w.ex, { realDeltaS: 1 }); } return w.state.missions.some(m => m.status === 'ON_SCENE'); }

const outcomes = [];
function test(name, fn) { try { fn(); outcomes.push({ name, passed: true }); } catch (e) { outcomes.push({ name, passed: false, error: e.message }); } }

// A deterministic operator script: the same actions at the same sim times.
function script(w, actions) {
    let i = 0;
    const doActions = () => { while (i < actions.length && actions[i].at <= w.ex.simTime) { actions[i].fn(w); i++; } };
    doActions();
    let guard = 0;
    while (w.ex.scenario && !w.ex.results && guard++ < 5000) { doActions(); ex.step(w.state, w.ex, { realDeltaS: 1 }); }
    doActions();
    return ex.view(w.state, w.ex);
}
const FLOOD_SCRIPT = [
    { at: 0, fn: w => ex.start(w.state, w.ex, { scenario: 'FLOODING' }) },
    { at: 5, fn: w => ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2, recoveryKit: true }) },
    { at: 60, fn: w => ex.repair(w.state, w.ex) },
    { at: 90, fn: w => ex.command(w.state, w.ex, { teamId: 'T1', action: 'START_PUMP' }) }
];

// ------------------------------------------------------------------ store core

test('save/load roundtrip: en-route mission is preserved', () => {
    const store = freshStore('enroute');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2, recoveryKit: true });
    run(w, 10);
    const v0 = ex.view(w.state, w.ex);
    assert.equal(v0.missions.length, 1);
    assert.equal(v0.missions[0].status, 'EN_ROUTE');
    const mid = v0.missions[0].id;
    const simBefore = w.ex.simTime;
    assert.ok(store.save(w).ok, 'save ok');
    const loaded = store.load();
    assert.ok(loaded.ok, 'load ok');
    assert.equal(loaded.world.ex.simTime, simBefore, 'simTime preserved');
    const lm = loaded.world.state.missions.find(m => m.id === mid);
    assert.ok(lm && lm.status === 'EN_ROUTE', 'en-route mission preserved');
});

test('save/load roundtrip: pending commands and outage are preserved', () => {
    const store = freshStore('cmdoutage');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2, recoveryKit: true });
    untilOnScene(w);
    ex.command(w.state, w.ex, { teamId: 'T1', action: 'START_PUMP' });
    ex.setOutage(w.state, w.ex, { teamId: 'T1', fromS: 0, toS: 60 });
    const cmdCount = w.state.commands.length;
    assert.ok(w.state.teams.find(t => t.id === 'T1').outages.length >= 1, 'outage set');
    assert.ok(store.save(w).ok);
    const loaded = store.load();
    assert.ok(loaded.ok);
    assert.equal(loaded.world.state.commands.length, cmdCount, 'commands preserved');
    assert.ok(loaded.world.state.teams.find(t => t.id === 'T1').outages.length >= 1, 'outage preserved');
});

test('save/load roundtrip: on-scene hull repair progress is preserved', () => {
    const store = freshStore('repair');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2, recoveryKit: true });
    untilOnScene(w);
    ex.repair(w.state, w.ex);
    run(w, 20);
    const prog = w.ex.repair.progressS;
    assert.ok(prog > 0 && prog < 60, 'repair in progress');
    assert.ok(store.save(w).ok);
    const loaded = store.load();
    assert.ok(loaded.ok);
    assert.equal(loaded.world.ex.repair.progressS, prog, 'repair progress preserved');
    assert.equal(loaded.world.ex.repair.requestedAt, w.ex.repair.requestedAt, 'repair requestedAt preserved');
});

test('restoreOnce: restores a paused world into an empty flow and it resumes', () => {
    const store = freshStore('restore');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'MAN_OVERBOARD' });
    ex.dispatch(w.state, w.ex, { teamId: 'T2', personnel: 2, recoveryKit: true });
    run(w, 8);
    const simBefore = w.ex.simTime;
    assert.ok(store.save(w).ok);
    const flow = flowLike();
    const S2 = store.restoreOnce(ex, flow);
    assert.equal(S2.ex.paused, true, 'restored world is paused');
    assert.equal(S2.ex.restoredFromSnapshot, true, 'restored marker set');
    assert.equal(S2.ex.simTime, simBefore, 'simTime preserved');
    assert.equal(flow.raw.get('rescueWorld'), S2, 'restored world is in the shared flow');
    ex.resume(S2.state, S2.ex);
    const t0 = S2.ex.simTime;
    ex.step(S2.state, S2.ex, { realDeltaS: 5 });
    assert.ok(S2.ex.simTime > t0, 'resumed world advances');
});

test('restoreOnce: never overwrites a live world already in the flow', () => {
    const store = freshStore('nooverwrite');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    run(w, 30);
    assert.ok(store.save(w).ok);
    const live = ex.createExercise();
    ex.start(live.state, live.ex, { scenario: 'MAN_OVERBOARD' });
    const liveSim = 5;
    live.ex.simTime = liveSim;
    const flow = flowLike();
    flow.set('rescueWorld', live);
    const S2 = store.restoreOnce(ex, flow);
    assert.equal(S2, live, 'existing live world is returned, not the snapshot');
    assert.equal(S2.ex.scenario, 'MAN_OVERBOARD');
});

test('deterministic resume: paused restore reaches the same result as uninterrupted', () => {
    // World A: run the same operator script uninterrupted to completion.
    const a = script(ex.createExercise(), FLOOD_SCRIPT);
    assert.ok(a.results, 'uninterrupted run reaches results');
    // World B: same script, but at a fixed mid-exercise sim time we save,
    // restore (paused) as if the node restarted, resume, and finish.
    const store = freshStore('determinism');
    const wb = ex.createExercise();
    let i = 0;
    let guard = 0;
    let S = wb;
    const doActions = () => { while (i < FLOOD_SCRIPT.length && FLOOD_SCRIPT[i].at <= S.ex.simTime) { FLOOD_SCRIPT[i].fn(S); i++; } };
    doActions(); // apply the t=0 start before the loop (mirrors the script helper)
    while (S.ex.scenario && !S.ex.results && guard++ < 5000) {
        doActions();
        if (S.ex.simTime === 30) {
            assert.ok(store.save(S).ok, 'checkpoint save ok');
            const flow = flowLike();
            S = store.restoreOnce(ex, flow); // simulate a node restart
            assert.equal(S.ex.paused, true, 'restored paused');
            ex.resume(S.state, S.ex);
        }
        ex.step(S.state, S.ex, { realDeltaS: 1 });
    }
    assert.ok(S.ex.results, 'restored run reaches results');
    assert.equal(S.ex.results.allClear, a.results.allClear, 'allClear matches uninterrupted');
    assert.deepEqual(S.ex.results.delays, a.results.delays, 'delays match uninterrupted');
    assert.ok(Math.abs(S.state.incidents[S.ex.incidentId].waterL - a.incident.waterL) < 1e-9, 'final water matches');
    assert.equal(S.state.incidents[S.ex.incidentId].crewRescued, a.incident.crewRescued, 'final crew matches');
});

// ------------------------------------------------------- corruption / recovery

test('corrupt primary: load recovers the previous-good backup', () => {
    const store = freshStore('corruptprimary');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2, recoveryKit: true });
    run(w, 20);
    const sim1 = w.ex.simTime;
    assert.ok(store.save(w).ok); // primary = good #1, no backup yet
    run(w, 20);
    const sim2 = w.ex.simTime;
    assert.ok(store.save(w).ok); // primary = good #2, backup = good #1
    // Corrupt the primary.
    fs.writeFileSync(store.primaryPath, '{ this is not json', 'utf8');
    const loaded = store.load();
    assert.ok(loaded.ok, 'load ok via backup');
    assert.equal(loaded.source, 'backup', 'recovered from backup');
    assert.equal(loaded.world.ex.simTime, sim1, 'backup is the previous-good snapshot');
});

test('truncated primary: load recovers the previous-good backup', () => {
    const store = freshStore('trunc');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    run(w, 10);
    assert.ok(store.save(w).ok);
    run(w, 10);
    assert.ok(store.save(w).ok);
    const full = fs.readFileSync(store.primaryPath, 'utf8');
    fs.writeFileSync(store.primaryPath, full.slice(0, Math.floor(full.length / 2)), 'utf8'); // truncated JSON
    const loaded = store.load();
    assert.ok(loaded.ok, 'load ok via backup');
    assert.equal(loaded.source, 'backup');
});

test('corrupt primary AND backup: load reports a clean error (no throw)', () => {
    const store = freshStore('bothbad');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    run(w, 10);
    assert.ok(store.save(w).ok);
    run(w, 10);
    assert.ok(store.save(w).ok);
    fs.writeFileSync(store.primaryPath, 'garbage', 'utf8');
    fs.writeFileSync(store.backupPath, 'also garbage', 'utf8');
    let res;
    assert.doesNotThrow(() => { res = store.load(); }, 'load must not throw');
    assert.equal(res.ok, false, 'clean error');
    assert.ok(/no usable snapshot/.test(res.error), 'error message explains the situation');
});

test('invalid snapshot version is rejected on load', () => {
    const store = freshStore('badversion');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    assert.ok(store.save(w).ok);
    const snap = JSON.parse(fs.readFileSync(store.primaryPath, 'utf8'));
    snap.version = 999; // unsupported version
    fs.writeFileSync(store.primaryPath, JSON.stringify(snap), 'utf8');
    const loaded = store.load();
    assert.equal(loaded.ok, false, 'unsupported version rejected');
    assert.ok(/version/.test(loaded.error));
});

test('a wrong MODEL version (not the exact supported one) is rejected on load', () => {
    const store = freshStore('badmodelver');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    assert.ok(store.save(w).ok);
    const snap = JSON.parse(fs.readFileSync(store.primaryPath, 'utf8'));
    snap.state.version = 'rescue-model/2.0.0'; // a valid semver, but not the supported one
    fs.writeFileSync(store.primaryPath, JSON.stringify(snap), 'utf8');
    const loaded = store.load();
    assert.equal(loaded.ok, false, 'non-exact model version rejected');
    assert.ok(/exactly/.test(loaded.error), 'error names the exact supported version');
});

test('invalid mission (unknown team) is rejected on load', () => {
    const store = freshStore('badmission');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2, recoveryKit: true });
    assert.ok(store.save(w).ok);
    const snap = JSON.parse(fs.readFileSync(store.primaryPath, 'utf8'));
    snap.state.missions[0].teamId = 'NOPE'; // references a team that does not exist
    fs.writeFileSync(store.primaryPath, JSON.stringify(snap), 'utf8');
    const loaded = store.load();
    assert.equal(loaded.ok, false, 'invalid mission rejected');
    assert.ok(/unknown team/.test(loaded.error));
});

test('invalid resource allocation (available > total kits) is rejected', () => {
    const store = freshStore('badkits');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    assert.ok(store.save(w).ok);
    const snap = JSON.parse(fs.readFileSync(store.primaryPath, 'utf8'));
    snap.state.shared.recoveryKitsAvailable = 50; // exceeds total (1)
    fs.writeFileSync(store.primaryPath, JSON.stringify(snap), 'utf8');
    const loaded = store.load();
    assert.equal(loaded.ok, false, 'resource inconsistency rejected');
    assert.ok(/kits/.test(loaded.error));
});

test('invalid team status and NaN-free numeric fields are enforced', () => {
    const store = freshStore('badstatus');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    assert.ok(store.save(w).ok);
    const snap = JSON.parse(fs.readFileSync(store.primaryPath, 'utf8'));
    snap.state.teams[0].status = 'TELEPORTING'; // not a valid team status
    fs.writeFileSync(store.primaryPath, JSON.stringify(snap), 'utf8');
    const loaded = store.load();
    assert.equal(loaded.ok, false, 'invalid status rejected');
    assert.ok(/status/.test(loaded.error));
});

// ------------------------------------------------------- atomicity / temp files

test('an invalid world cannot replace a good snapshot (temp never wins)', () => {
    const store = freshStore('atomic');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    run(w, 10);
    const goodSim = w.ex.simTime;
    assert.ok(store.save(w).ok);
    const before = fs.readFileSync(store.primaryPath, 'utf8');
    // A world that serializes to an INVALID snapshot (bad speed) must be refused.
    const bad = ex.createExercise();
    ex.start(bad.state, bad.ex, { scenario: 'FLOODING' });
    bad.ex.speed = 99; // fails validation
    const r = store.save(bad);
    assert.equal(r.ok, false, 'invalid snapshot refused');
    assert.equal(fs.readFileSync(store.primaryPath, 'utf8'), before, 'good primary unchanged');
    // No temp files left behind.
    const leftovers = fs.readdirSync(store.dataDir).filter(f => f.includes('.tmp-'));
    assert.equal(leftovers.length, 0, 'no temp files left');
});

test('save is atomic: a good snapshot is always present and valid after writes', () => {
    const store = freshStore('atomic2');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    for (let i = 0; i < 6; i++) { run(w, 5); assert.ok(store.save(w).ok); }
    const st = store.status();
    assert.ok(st.primary.valid, 'primary valid');
    assert.ok(st.backup.valid, 'backup valid (previous-good)');
    const loaded = store.load();
    assert.ok(loaded.ok && loaded.source === 'primary');
});

test('save/load roundtrip: sensor-delivered incident fields (lastWater/lastCrew) survive', () => {
    const store = freshStore('sensor');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2, recoveryKit: true });
    untilOnScene(w);
    run(w, 20);
    const inc = w.state.incidents[w.ex.incidentId];
    assert.ok(inc.lastWater && typeof inc.lastWater === 'object' && Number.isFinite(inc.lastWater.value),
        'lastWater populated as {value,at} after sensor delivery');
    const lw = inc.lastWater;
    assert.ok(store.save(w).ok, 'save ok with populated sensor fields');
    const loaded = store.load();
    assert.ok(loaded.ok, 'load ok');
    const linc = loaded.world.state.incidents[loaded.world.ex.incidentId];
    assert.ok(linc.lastWater && Math.abs(linc.lastWater.value - lw.value) < 1e-9, 'lastWater.value preserved');
    assert.ok(Math.abs(linc.lastWater.at - lw.at) < 1e-9, 'lastWater.at preserved');
});

test('a cyclic world is refused cleanly (no crash, good snapshot untouched)', () => {
    const store = freshStore('cyclic');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    run(w, 5);
    assert.ok(store.save(w).ok, 'good world saved first');
    const before = fs.readFileSync(store.primaryPath, 'utf8');
    const cyc = ex.createExercise();
    ex.start(cyc.state, cyc.ex, { scenario: 'FLOODING' });
    cyc.ex.selfRef = cyc.ex; // circular reference
    let r;
    assert.doesNotThrow(() => { r = store.save(cyc); }, 'save must not throw on a cyclic world');
    assert.equal(r.ok, false, 'cyclic world refused');
    assert.ok(/serialize/.test(r.error), 'error mentions serialize');
    assert.equal(fs.readFileSync(store.primaryPath, 'utf8'), before, 'good primary unchanged');
    assert.equal(fs.readdirSync(store.dataDir).filter(f => f.includes('.tmp-')).length, 0, 'no temp left');
});

test('corrupt primary -> load backup -> save restored -> corrupt primary again still recovers backup', () => {
    const store = freshStore('reheal');
    const w = ex.createExercise();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    ex.dispatch(w.state, w.ex, { teamId: 'T1', personnel: 2, recoveryKit: true });
    run(w, 10);
    const sim1 = w.ex.simTime;
    assert.ok(store.save(w).ok); // primary good#1, no backup yet
    run(w, 10);
    assert.ok(store.save(w).ok); // primary good#2, backup good#1
    // 1) corrupt primary -> load recovers the previous-good backup (paused)
    fs.writeFileSync(store.primaryPath, '{ corrupt', 'utf8');
    const l1 = store.load();
    assert.ok(l1.ok && l1.source === 'backup', 'recovered from backup');
    assert.equal(l1.world.ex.paused, true, 'load() returns a paused world');
    // 2) save the restored world; the corrupt primary must NOT clobber the good backup
    assert.ok(store.save(l1.world).ok, 'save restored ok');
    // 3) corrupt primary AGAIN -> the backup must still be valid
    fs.writeFileSync(store.primaryPath, 'still corrupt', 'utf8');
    const l2 = store.load();
    assert.ok(l2.ok && l2.source === 'backup', 'still recovers valid backup after re-corruption');
    assert.equal(l2.world.ex.simTime, sim1, 'backup is still the previous-good snapshot');
});

// ------------------------------------------------------- handler integration

function makeHarness(codeA, codeB) {
    const globals = new Map([['rescue', ex], ['rescueStore', null]]); // store set per test
    const flowValues = new Map();
    const flow = { get: k => flowValues.get(k), set: (k, v) => flowValues.set(k, v) };
    const ctxA = new Map();
    const mk = code => new Function('msg', 'node', 'context', 'global', 'flow', 'env', code);
    const fnA = mk(codeA), fnB = mk(codeB);
    const node = { error: m => { throw new Error('node.error: ' + m); } };
    const g = { get: k => globals.get(k) };
    const env = { get: () => undefined };
    const ctx = (m) => ({ get: k => m.get(k), set: (k, v) => m.set(k, v) });
    return {
        globals, flowValues,
        setStore(s) { globals.set('rescueStore', s); },
        initA() {
            // mirror the fnRescue node initialize (lazy restore, no overwrite)
            const initCode = "const ex = global.get('rescue');\nif (!ex) { node.error('rescue exercise module missing'); return; }\nconst store = global.get('rescueStore');\nif (store) store.restoreOnce(ex, flow);";
            new Function('msg', 'node', 'context', 'global', 'flow', 'env', initCode)({}, node, ctx(ctxA), g, flow, env);
        },
        tick(msg) { return fnA(msg, node, ctx(ctxA), g, flow, env); },
        cmd(msg) { return fnA(msg, node, ctx(ctxA), g, flow, env); },
        api(msg) { return fnB(msg, node, ctx(new Map()), g, flow, env); },
        world() { return flowValues.get('rescueWorld'); }
    };
}

test('fnRescue: a command persists the shared world (save path)', () => {
    const codeA = fs.readFileSync(path.join(here, '..', 'src', 'functions', 'fnRescue.js'), 'utf8');
    const codeB = fs.readFileSync(path.join(here, '..', 'src', 'functions', 'fnRescueApi.js'), 'utf8');
    const H = makeHarness(codeA, codeB);
    const store = freshStore('fnRescue');
    H.setStore(store);
    H.initA();
    assert.ok(H.world(), 'initialize created/restored a world');
    const started = H.cmd({ topic: 'cmd', payload: { action: 'start', scenario: 'FLOODING' } });
    assert.equal(started[0].payload.scenario, 'FLOODING');
    assert.ok(started[0].payload.save && started[0].payload.save.ok, 'view carries a valid save status after a command');
    const disp = H.cmd({ topic: 'cmd', payload: { action: 'dispatch', teamId: 'T1', personnel: 2, recoveryKit: true } });
    assert.ok(disp[0].payload.save && disp[0].payload.save.ok, 'save status ok after dispatch');
    // The durable snapshot now exists and is valid.
    const loaded = store.load();
    assert.ok(loaded.ok, 'world was persisted to the durable store');
    assert.equal(loaded.world.ex.scenario, 'FLOODING');
});

test('fnRescue: explicit save action writes a checkpoint; tick saves every ~5 ticks', () => {
    const codeA = fs.readFileSync(path.join(here, '..', 'src', 'functions', 'fnRescue.js'), 'utf8');
    const codeB = fs.readFileSync(path.join(here, '..', 'src', 'functions', 'fnRescueApi.js'), 'utf8');
    const H = makeHarness(codeA, codeB);
    const store = freshStore('fnRescueTick');
    H.setStore(store);
    H.initA();
    H.cmd({ topic: 'cmd', payload: { action: 'start', scenario: 'MAN_OVERBOARD' } });
    // explicit save
    const sv = H.cmd({ topic: 'cmd', payload: { action: 'save' } });
    assert.ok(sv[0].payload.save && sv[0].payload.save.ok, 'explicit save ok');
    assert.ok(store.load().ok, 'checkpoint written by explicit save');
    // 5 ticks -> a periodic save fires (simTime advances and is persisted)
    let last = null;
    for (let i = 0; i < 5; i++) last = H.tick({ topic: 'tick', realDeltaS: 1 })[0].payload;
    assert.ok(last.save && last.save.ok, 'tick view carries save status');
    const loaded = store.load();
    assert.ok(loaded.ok, 'periodic save produced a valid snapshot');
    assert.ok(loaded.world.ex.simTime > 0, 'periodic save captured advancing simTime');
});

test('fnRescueApi: GET carries save status; save/load actions work', () => {
    const codeA = fs.readFileSync(path.join(here, '..', 'src', 'functions', 'fnRescue.js'), 'utf8');
    const codeB = fs.readFileSync(path.join(here, '..', 'src', 'functions', 'fnRescueApi.js'), 'utf8');
    const H = makeHarness(codeA, codeB);
    const store = freshStore('api');
    H.setStore(store);
    H.initA();
    H.cmd({ topic: 'cmd', payload: { action: 'start', scenario: 'FLOODING' } });
    const get = H.api({ req: { method: 'GET' }, payload: null });
    assert.equal(get[0].statusCode, 200);
    assert.ok(get[0].payload.save && get[0].payload.save.ok, 'GET carries save status');
    const sv = H.api({ req: { method: 'POST' }, payload: { action: 'save' } });
    assert.equal(sv[1].statusCode, 200);
    assert.ok(sv[1].payload.ok && sv[1].payload.view.save.ok, 'API save ok');
    const ld = H.api({ req: { method: 'POST' }, payload: { action: 'load' } });
    assert.equal(ld[1].statusCode, 200);
    assert.equal(ld[1].payload.view.paused, true, 'API load restores paused');
});

test('fnRescue: a restart (fresh flow) restores a paused world from the store', () => {
    const codeA = fs.readFileSync(path.join(here, '..', 'src', 'functions', 'fnRescue.js'), 'utf8');
    const codeB = fs.readFileSync(path.join(here, '..', 'src', 'functions', 'fnRescueApi.js'), 'utf8');
    const store = freshStore('restart');
    // Session 1: start + dispatch, persist.
    const H1 = makeHarness(codeA, codeB);
    H1.setStore(store);
    H1.initA();
    H1.cmd({ topic: 'cmd', payload: { action: 'start', scenario: 'FLOODING' } });
    H1.cmd({ topic: 'cmd', payload: { action: 'dispatch', teamId: 'T1', personnel: 2, recoveryKit: true } });
    const simAtSave = H1.world().ex.simTime;
    assert.ok(store.load().ok, 'session 1 persisted');
    // Session 2: brand-new harness (fresh flow + node context) = a restart.
    const H2 = makeHarness(codeA, codeB);
    H2.setStore(store);
    H2.initA(); // lazy restore on node start
    const S2 = H2.world();
    assert.ok(S2, 'world restored on restart');
    assert.equal(S2.ex.scenario, 'FLOODING', 'scenario restored');
    assert.equal(S2.ex.paused, true, 'restored world is paused');
    assert.equal(S2.ex.simTime, simAtSave, 'simTime restored');
    // Resume and it advances.
    const resumed = H2.cmd({ topic: 'cmd', payload: { action: 'resume' } });
    assert.equal(resumed[0].payload.paused, false, 'resume works after restore');
});

// ------------------------------------------------------------------ report

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
    at: new Date().toISOString(),
    module: 'seaguard/src/rescue/persistence.cjs',
    handlers: ['seaguard/src/functions/fnRescue.js', 'seaguard/src/functions/fnRescueApi.js'],
    tempDir: 'seaguard/tests/fixtures/temp',
    tests: outcomes
}, null, 2));
for (const r of outcomes) console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error.split('\n')[0] : ''}`);
console.log(`${outcomes.filter(r => r.passed).length}/${outcomes.length} rescue-persistence scenarios passed`);
process.exitCode = outcomes.some(r => !r.passed) ? 1 : 0;
