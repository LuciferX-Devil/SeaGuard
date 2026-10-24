// Focused tests for rescue persistence PUMP BATTERY snapshot validation and
// legacy migration (seaguard/src/rescue/persistence.cjs + battery.cjs).
// Runs without Node-RED or any service:
//     node seaguard/tests/rescue-battery-state.mjs
// All durable snapshots are written under seaguard/tests/fixtures/battery-state
// only — the live seaguard/data checkpoint is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ex from '../src/rescue/exercise.cjs';
import pers from '../src/rescue/persistence.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'battery-state');
const reportPath = path.join(here, '..', 'reports', 'rescue-battery-state.json');

fs.rmSync(FIX, { recursive: true, force: true });
fs.mkdirSync(FIX, { recursive: true });

const outcomes = [];
function test(name, fn) { try { fn(); outcomes.push({ name, passed: true }); } catch (e) { outcomes.push({ name, passed: false, error: e.message }); } }
function freshStore(name) { return pers.createStore({ dataDir: path.join(FIX, name) }); }
function freshWorld() { return ex.createExercise(); }
function teamOf(w, id = 'T1') { return w.state.teams.find(t => t.id === id); }

// ------------------------------------------------------------------ roundtrip

test('save/load roundtrip: default battery fields are strict and preserved', () => {
    const store = freshStore('roundtrip-default');
    const w = freshWorld();
    const t = teamOf(w);
    assert.deepEqual(t.pumpBattery, { capacityWh: 20, chargeWh: 20, drawW: 120, lowFraction: 0.2 });
    assert.equal(t.pumpRecharge, null);
    assert.equal(t.pumpLowAnnounced, false);
    assert.equal(t.pumpDepletedAnnounced, false);
    assert.ok(store.save(w).ok, 'save ok');
    const loaded = store.load();
    assert.ok(loaded.ok, 'load ok');
    assert.equal(loaded.world.ex.paused, true, 'load returns paused as before');
    const lt = teamOf(loaded.world);
    assert.deepEqual(lt.pumpBattery, t.pumpBattery, 'battery deep-equal after roundtrip');
    assert.equal(lt.pumpRecharge, null);
    assert.equal(lt.pumpLowAnnounced, false);
    assert.equal(lt.pumpDepletedAnnounced, false);
});

test('save/load roundtrip: in-progress recharge and partial charge survive', () => {
    const store = freshStore('roundtrip-recharge');
    const w = freshWorld();
    // A started (undispatched) scenario keeps ex.step advancing both clocks
    // while T1 stays IDLE at harbour. Start a 60s recharge, let 25s elapse.
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    ex.recharge(w.state, w.ex, { teamId: 'T1' });
    for (let i = 0; i < 25; i++) ex.step(w.state, w.ex, { realDeltaS: 1 });
    assert.equal(teamOf(w).pumpRecharge.remainingS, 35);
    const simBefore = w.ex.simTime;
    const r = store.save(w);
    assert.ok(r.ok, 'save ok: ' + (r.error || ''));
    const loaded = store.load();
    assert.ok(loaded.ok, 'load ok: ' + (loaded.error || ''));
    assert.equal(loaded.world.ex.simTime, simBefore);
    assert.deepEqual(teamOf(loaded.world).pumpRecharge, { remainingS: 35 }, 'partial recharge preserved');
    assert.equal(loaded.world.ex.paused, true);
    // Completing the recharge after load restores the full battery.
    loaded.world.ex.paused = false; // resume is an explicit operator action
    for (let i = 0; i < 35; i++) ex.step(loaded.world.state, loaded.world.ex, { realDeltaS: 1 });
    assert.equal(teamOf(loaded.world).pumpRecharge, null);
    assert.equal(teamOf(loaded.world).pumpBattery.chargeWh, 20);
    assert.ok(store.save(loaded.world).ok, 'post-completion save ok');
});

// ------------------------------------------------------- legacy migration

test('legacy snapshot: absent battery fields are migrated on a clone, original untouched', () => {
    const store = freshStore('legacy-migrate');
    const w = freshWorld();
    assert.ok(store.save(w).ok);
    // Simulate a pre-battery snapshot: delete ONLY the new fields on disk.
    const raw = JSON.parse(fs.readFileSync(store.primaryPath, 'utf8'));
    for (const t of raw.state.teams) {
        delete t.pumpBattery;
        delete t.pumpLowAnnounced;
        delete t.pumpDepletedAnnounced;
        delete t.pumpRecharge;
    }
    fs.writeFileSync(store.primaryPath, JSON.stringify(raw), 'utf8');
    const loaded = store.load();
    assert.ok(loaded.ok, 'legacy snapshot loads after migration: ' + (loaded.error || ''));
    assert.equal(loaded.source, 'primary');
    for (const t of loaded.world.state.teams) {
        assert.deepEqual(t.pumpBattery, { capacityWh: 20, chargeWh: 20, drawW: 120, lowFraction: 0.2 });
        assert.equal(t.pumpLowAnnounced, false);
        assert.equal(t.pumpDepletedAnnounced, false);
        assert.equal(t.pumpRecharge, null);
    }
    // The on-disk legacy file must not have been rewritten by the load.
    const after = JSON.parse(fs.readFileSync(store.primaryPath, 'utf8'));
    for (const t of after.state.teams) assert.ok(!('pumpBattery' in t), 'legacy file left untouched');
    // And the migrated world must save cleanly with strict fields.
    assert.ok(store.save(loaded.world).ok, 'migrated world saves');
});

test('validateSnapshot/migrateSnapshot never mutate the caller object', () => {
    const w = freshWorld();
    const snap = pers.buildSnapshot(w, 1234);
    for (const t of snap.state.teams) {
        delete t.pumpBattery;
        delete t.pumpLowAnnounced;
        delete t.pumpDepletedAnnounced;
        delete t.pumpRecharge;
    }
    const before = JSON.stringify(snap);
    const err = pers.validateSnapshot(snap); // strict: legacy shape must be rejected
    assert.ok(err && /pumpBattery/.test(err), 'legacy snapshot rejected without migration: ' + err);
    assert.equal(JSON.stringify(snap), before, 'validateSnapshot did not mutate input');
    const migrated = pers.migrateSnapshot(JSON.parse(JSON.stringify(snap)));
    assert.equal(migrated.state.teams[0].pumpBattery.chargeWh, 20);
    assert.equal(pers.validateSnapshot(migrated), null, 'migrated clone validates');
    assert.ok(!('pumpBattery' in snap.state.teams[0]), 'original still unmigrated');
});

test('present-but-null or invalid battery is NOT replaced by migration defaults', () => {
    const store = freshStore('legacy-null-battery');
    const w = freshWorld();
    assert.ok(store.save(w).ok);
    const raw = JSON.parse(fs.readFileSync(store.primaryPath, 'utf8'));
    raw.state.teams[0].pumpBattery = null; // present but invalid
    fs.writeFileSync(store.primaryPath, JSON.stringify(raw), 'utf8');
    const loaded = store.load();
    assert.ok(!loaded.ok, 'null battery must reject, not be defaulted');
    assert.match(loaded.error, /pumpBattery/);
});

// ------------------------------------------------------- invalid battery values

test('save rejects null / negative / excess / NaN battery fields', () => {
    const store = freshStore('bad-battery');
    const w = freshWorld();
    assert.ok(store.save(w).ok, 'baseline save ok');
    const cases = [
        ['null battery', t => { t.pumpBattery = null; }, /pumpBattery/],
        ['negative capacityWh', t => { t.pumpBattery.capacityWh = -5; }, /pumpBattery/],
        ['chargeWh above capacity', t => { t.pumpBattery.chargeWh = 999; }, /pumpBattery/],
        ['NaN drawW', t => { t.pumpBattery.drawW = NaN; }, /pumpBattery/],
        ['lowFraction above 1', t => { t.pumpBattery.lowFraction = 1.5; }, /pumpBattery/],
        ['unknown battery field', t => { t.pumpBattery.volts = 12; }, /pumpBattery/]
    ];
    for (const [label, mutate, re] of cases) {
        const t = teamOf(w);
        mutate(t);
        const r = store.save(w);
        assert.ok(!r.ok, label + ' must be rejected');
        assert.match(r.error, re, label + ' error mentions pumpBattery');
        t.pumpBattery = { capacityWh: 20, chargeWh: 20, drawW: 120, lowFraction: 0.2 };
    }
    assert.ok(store.save(w).ok, 'restored world saves again');
    // The rejected saves never touched the good snapshot on disk.
    assert.ok(store.load().ok, 'good snapshot still loads');
});

test('non-boolean pumpLowAnnounced / pumpDepletedAnnounced are rejected', () => {
    const store = freshStore('bad-flags');
    const w = freshWorld();
    assert.ok(store.save(w).ok);
    for (const [field, bad] of [['pumpLowAnnounced', 1], ['pumpDepletedAnnounced', 'false']]) {
        teamOf(w)[field] = bad;
        const r = store.save(w);
        assert.ok(!r.ok, field + ' = ' + JSON.stringify(bad) + ' must be rejected');
        assert.match(r.error, new RegExp(field));
        teamOf(w)[field] = false;
    }
    assert.ok(store.save(w).ok, 'strict booleans save');
});

// ------------------------------------------------------- recharge invariants

test('invalid recharge state / position / duration are rejected', () => {
    const store = freshStore('bad-recharge');
    const w = freshWorld();
    assert.ok(store.save(w).ok, 'baseline save ok');
    const t = teamOf(w);
    const good = { capacityWh: 20, chargeWh: 20, drawW: 120, lowFraction: 0.2 };
    const cases = [
        ['remainingS zero', () => { t.pumpRecharge = { remainingS: 0 }; }, /remainingS/],
        ['remainingS negative', () => { t.pumpRecharge = { remainingS: -10 }; }, /remainingS/],
        ['remainingS above 60', () => { t.pumpRecharge = { remainingS: 61 }; }, /remainingS/],
        ['remainingS NaN', () => { t.pumpRecharge = { remainingS: NaN }; }, /remainingS/],
        ['recharge with extra field', () => { t.pumpRecharge = { remainingS: 30, why: 'x' }; }, /pumpRecharge/],
        ['recharge while EN_ROUTE', () => { t.status = 'EN_ROUTE'; t.pumpRecharge = { remainingS: 30 }; }, /IDLE/],
        ['recharge away from harbour', () => { t.pumpRecharge = { remainingS: 30 }; t.pos = { lat: t.home.lat + 0.5, lon: t.home.lon }; }, /harbour/],
        ['recharge with assigned personnel', () => { t.pumpRecharge = { remainingS: 30 }; t.personnelAssigned = 2; }, /personnel/]
    ];
    for (const [label, mutate, re] of cases) {
        t.pumpRecharge = null;
        t.status = 'IDLE';
        t.pos = { ...t.home };
        t.personnelAssigned = 0;
        mutate(t);
        const r = store.save(w);
        assert.ok(!r.ok, label + ' must be rejected');
        assert.match(r.error, re, label + ' error: ' + r.error);
    }
    // Reset everything the cases touched (the loop only resets at iteration start).
    t.pumpRecharge = null;
    t.status = 'IDLE';
    t.pos = { ...t.home };
    t.personnelAssigned = 0;
    assert.ok(store.save(w).ok, 'restored world saves again');
});

test('exhausted battery with pumpRunning true is rejected (running/depleted contradiction)', () => {
    const store = freshStore('bad-running');
    const w = freshWorld();
    assert.ok(store.save(w).ok, 'baseline save ok');
    const t = teamOf(w);
    t.pumpBattery.chargeWh = 0;          // depleted
    t.pumpRunning = true;                 // contradiction
    const r = store.save(w);
    assert.ok(!r.ok, 'running + depleted must be rejected');
    assert.match(r.error, /pumpRunning/);
    // Depleted + not running is fine (a fresh zero-charge battery is low AND depleted).
    t.pumpRunning = false;
    assert.ok(store.save(w).ok, 'depleted + pump off saves');
    const loaded = store.load();
    assert.ok(loaded.ok);
    assert.equal(teamOf(loaded.world).pumpBattery.chargeWh, 0);
});

// ------------------------------------------------------- corruption recovery

test('corrupt primary still recovers the previous-good backup (with battery fields)', () => {
    const store = freshStore('corrupt-primary');
    const w = freshWorld();
    ex.start(w.state, w.ex, { scenario: 'FLOODING' });
    ex.recharge(w.state, w.ex, { teamId: 'T1' });
    for (let i = 0; i < 10; i++) ex.step(w.state, w.ex, { realDeltaS: 1 });
    assert.ok(store.save(w).ok, 'save 1 ok');
    for (let i = 0; i < 10; i++) ex.step(w.state, w.ex, { realDeltaS: 1 });
    assert.ok(store.save(w).ok, 'save 2 ok');
    fs.writeFileSync(store.primaryPath, '{ this is not json', 'utf8');
    const loaded = store.load();
    assert.ok(loaded.ok, 'backup recovered: ' + (loaded.error || ''));
    assert.equal(loaded.source, 'backup');
    assert.deepEqual(teamOf(loaded.world).pumpBattery, { capacityWh: 20, chargeWh: 20, drawW: 120, lowFraction: 0.2 });
    assert.equal(loaded.world.ex.paused, true);
    // Both files corrupted -> clean error, no throw.
    fs.writeFileSync(store.backupPath, 'also corrupt', 'utf8');
    let res;
    assert.doesNotThrow(() => { res = store.load(); });
    assert.ok(!res.ok && /no usable snapshot/.test(res.error), 'clean error: ' + res.error);
});

// ------------------------------------------------------------------ report

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
    at: new Date().toISOString(),
    suite: 'rescue-battery-state',
    total: outcomes.length,
    passed: outcomes.filter(r => r.passed).length,
    failed: outcomes.filter(r => !r.passed).length,
    rows: outcomes
}, null, 2));
for (const r of outcomes) console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error.split('\n')[0] : ''}`);
console.log(`${outcomes.filter(r => r.passed).length}/${outcomes.length} rescue-battery-state scenarios passed`);
if (outcomes.some(r => !r.passed)) process.exitCode = 1;
