// Disruptive live integration test: resets the rescue exercise and restarts
// only the SeaGuard process using its checked project scripts. No browser used.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import exercise from '../src/rescue/exercise.cjs';
import persistence from '../src/rescue/persistence.cjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = (process.env.SEAGUARD_BASE_URL||'http://127.0.0.1:1880')+'/seaguard/rescue';
const report = { at: new Date().toISOString(), passed: false, checks: [] };
const reportPath = path.join(root, 'seaguard/reports/rescue-restart-live.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function state() {
    const response = await fetch(base + '/state', { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    return response.json();
}
async function command(action, args = {}) {
    const response = await fetch(base + '/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...args }), signal: AbortSignal.timeout(5000)
    });
    const body = await response.json();
    assert.equal(response.status, 200, body.error);
    assert.equal(body.ok, true, body.error);
    return body.view;
}
async function until(predicate, timeout = 60000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const view = await state();
        if (predicate(view)) return view;
        await sleep(250);
    }
    throw Error('Rescue state deadline exceeded');
}
function check(name, fn) { fn(); report.checks.push(name); console.log('PASS ' + name); }
// Compare durable operational state, excluding expected restore/save metadata.
function operational(view) {
    const { save, restored, paused, ...rest } = view;
    return rest;
}
try {
    report.previous = await state();
    await command('reset');
    await command('start', { scenario: 'MAN_OVERBOARD' });
    await command('pause');
    await command('dispatch', { teamId: 'T2', personnel: 6, recoveryKit: true });
    await command('command', { teamId: 'T2', action2: 'ACKNOWLEDGE' });
    // Save a RUNNING checkpoint, so paused-on-restore is genuinely tested.
    await command('resume');
    const before = await command('save');
    check('running checkpoint contains en-route mission and pending command', () => {
        assert.equal(before.paused, false);
        assert.equal(before.missions[0].status, 'EN_ROUTE');
        assert.equal(before.commands[0].status, 'SENT');
        assert.equal(before.shared.recoveryKits.available, 0);
    });
    const pidPath = path.join(root, 'logs/demo.pid');
    report.oldPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    execFileSync(process.execPath, [path.join(root, 'launch.mjs'), 'stop'], { cwd: root, timeout: 15000, stdio: 'ignore' });
    // An automatic checkpoint may run between the HTTP response and stopping.
    // Compare with the last validated durable checkpoint after the process exits.
    const checkpoint = persistence.createStore({ dataDir: path.join(root, 'seaguard/data') }).load();
    assert.equal(checkpoint.ok, true, checkpoint.error);
    const durable = exercise.view(checkpoint.world.state, checkpoint.world.ex);
    report.durable = durable;
    execFileSync(process.execPath, [path.join(root, 'launch.mjs')], { cwd: root, timeout: 30000, stdio: 'ignore' });
    report.newPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    let after;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        try { after = await state(); break; } catch { await sleep(250); }
    }
    assert.ok(after, 'server must restart within 30 seconds');
    report.before = before;
    report.after = after;
    check('new process restores the saved exercise paused', () => {
        assert.notEqual(report.newPid, report.oldPid);
        assert.equal(after.restored, true);
        assert.equal(after.paused, true);
        assert.equal(after.save.ok, true);
    });
    check('mission, command, sensor queues, clock and reserved resources survive', () => {
        assert.deepEqual(operational(after), operational(durable));
    });
    await sleep(2200); // More than two real controller ticks.
    const stillPaused = await state();
    check('restored exercise does not advance without operator resume', () => {
        assert.deepEqual(operational(stillPaused), operational(after));
        assert.equal(stillPaused.paused, true);
    });
    await command('setSpeed', { speed: 20 });
    await command('resume');
    await until(view => view.teams.find(team => team.id === 'T2').status === 'ON_SCENE');
    const safe = await until(view => view.incident.status === 'RESOLVED');
    check('resumed queued acknowledgement executes and crew recovery completes', () => {
        assert.equal(safe.commands[0].status, 'CONFIRMED');
        assert.equal(safe.results.crewSafe, true);
        assert.equal(safe.allClear, false);
    });
    await command('command', { teamId: 'T2', action2: 'RETURN' });
    const end = await until(view => view.allClear);
    check('returned team releases personnel and kit and exercise pauses', () => {
        assert.equal(end.paused, true);
        assert.equal(end.teams.find(team => team.id === 'T2').personnel.assigned, 0);
        assert.equal(end.shared.recoveryKits.available, 1);
        assert.equal(end.missions[0].status, 'COMPLETED');
    });
    report.end = await command('save');
    report.passed = true;
} catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
    try { await command('pause'); } catch { /* server failure retained in report */ }
    console.error(error);
} finally {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
