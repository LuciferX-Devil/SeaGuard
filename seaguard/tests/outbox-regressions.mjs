// Focused regressions for the alert notifier (fn0029) retention logic.
// Verifies that history pruning never silently discards an undelivered alert:
// terminal records (DELIVERED/FAILED) are shed first, pending records are kept,
// and an over-full pending backlog is surfaced rather than dropped.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const values = new Map([['epoch', 1], ['simTime', 10]]);
const global = { get: k => values.get(k), set: (k, v) => values.set(k, v) };
const warnings = [];
const node = { status() {}, warn: m => warnings.push(m), error() {} };
function invokeCode(code, msg = {}, contextValues = new Map()) {
    return new Function('msg', 'node', 'context', 'global', 'flow', 'env', code)(
        msg, node, { get: k => contextValues.get(k), set: (k, v) => contextValues.set(k, v) }, global, {}, { get: () => undefined });
}
function invoke(id, msg = {}, contextValues = new Map()) {
    const code = fs.readFileSync(`seaguard/src/functions/${id}.js`, 'utf8');
    return invokeCode(code, msg, contextValues);
}
// Populate the shared global cfg exactly as the real runtime does (fn0002 sets it).
invoke('fn0002');
const cfg = values.get('cfg');
assert.ok(cfg && Array.isArray(cfg.retry.notifyBackoff), 'cfg must be configured by fn0002');

// Build a notifier state with a list of records. `noop` runs the retention pass without
// mutating record status, so it isolates the pruning behaviour under test.
function stateWith(records) { return new Map([['S', { ep: 1, list: records }]]); }
function rec(id, status, i) {
    return { id, ref: 'R' + i, incident: null, kind: 'ALERT', role: 'family', chat: 'c',
        severity: 1, text: 't', status, attempts: 1, created: i, nextAt: 0, inflight: false, deliveredAt: null, lastError: null };
}
const noop = c => invoke('fn0029', { topic: 'noop' }, c); // no branch matches -> retention only

// Exercise the REAL notify branch: preload 300 pending, then enqueue one more alert.
// Returns which pending IDs survived so old-vs-new behaviour can be compared directly.
function notifyScenario(code) {
    const pending = Array.from({ length: 300 }, (_, i) => rec('P' + i, 'QUEUED', i));
    const c = stateWith(pending);
    invokeCode(code, { topic: 'notify', payload: { ref: 'R300', incident: null, kind: 'ALERT', roles: ['family'], severity: 1, text: 't' } }, c);
    const list = c.get('S').list;
    return {
        total: list.length,
        oldest: list.some(x => x.id === 'P0'),
        allPreloaded: Array.from({ length: 300 }, (_, i) => 'P' + i).every(id => list.some(x => x.id === id)),
        newest: list.some(x => x.id === 'R300/family'),
        backlog: c.get('S').backlog,
        backlogExceeded: c.get('S').backlogExceeded,
    };
}

const outcomes = [];
function test(name, fn) { try { fn(); outcomes.push({ name, passed: true }); } catch (e) { outcomes.push({ name, passed: false, error: e.message }); } }

test('301 pending alerts are all retained (no loss when backlog exceeds the history window)', () => {
    const pending = Array.from({ length: 301 }, (_, i) => rec('P' + i, 'QUEUED', i));
    const c = stateWith(pending);
    noop(c);
    const list = c.get('S').list;
    assert.equal(list.length, 301, 'every pending alert must survive');
    for (const r of pending) assert.ok(list.some(x => x.id === r.id), 'pending ' + r.id + ' dropped');
    assert.equal(c.get('S').backlog, 301);
    assert.equal(c.get('S').backlogExceeded, true);
});

test('mixed delivered/failed history sheds oldest terminal first, never pending', () => {
    const terminal = Array.from({ length: 300 }, (_, i) => rec('T' + i, i % 2 ? 'FAILED' : 'DELIVERED', i));
    const pending = Array.from({ length: 50 }, (_, i) => rec('P' + i, 'RETRY', 300 + i));
    const c = stateWith([...terminal, ...pending]); // 350 total
    noop(c);
    const list = c.get('S').list;
    assert.equal(list.length, 300, 'history window must hold 300');
    for (const r of pending) assert.ok(list.some(x => x.id === r.id), 'pending ' + r.id + ' dropped');
    for (let i = 0; i < 50; i++) assert.ok(!list.some(x => x.id === 'T' + i), 'oldest terminal T' + i + ' should be shed');
    for (let i = 50; i < 300; i++) assert.ok(list.some(x => x.id === 'T' + i), 'recent terminal T' + i + ' must be kept');
    assert.equal(c.get('S').backlogExceeded, false);
});

test('a response that transitions SENDING->DELIVERED then new alerts prune terminal not pending', () => {
    const old = Array.from({ length: 299 }, (_, i) => rec('T' + i, 'DELIVERED', i));
    const inFlight = rec('P1', 'SENDING', 299);
    const c = stateWith([...old, inFlight]);
    invoke('fn0029', { topic: 'resp', _ep: 1, _nid: 'P1', statusCode: 200, payload: { ok: true } }, c);
    assert.equal(inFlight.status, 'DELIVERED', 'response must mark delivered');
    const fresh = rec('P2', 'QUEUED', 300);
    c.get('S').list.push(fresh);
    noop(c);
    const list = c.get('S').list;
    assert.equal(list.length, 300);
    assert.ok(list.some(x => x.id === 'P2'), 'new pending must be kept');
    assert.ok(list.some(x => x.id === 'P1'), 'just-delivered record must be kept (newest terminal)');
    assert.ok(!list.some(x => x.id === 'T0'), 'oldest delivered record should be shed');
});

test('test alerts created in the same paused second keep distinct IDs', () => {
    values.set('simTime', 10);
    const c = stateWith([]);
    invoke('fn0029', { topic: 'test' }, c);
    invoke('fn0029', { topic: 'test' }, c);
    const rows = c.get('S').list;
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].id, rows[1].id);
});

test('notification timeouts still obey the retry limit (existing semantics intact)', () => {
    values.set('simTime', 100);
    const recT = { id: 'X', inflight: true, sentAt: 0, attempts: cfg.retry.maxNotifyTries, status: 'SENDING' };
    invoke('fn0029', { topic: 'tick' }, stateWith([recT]));
    assert.equal(recT.status, 'FAILED');
    assert.equal(recT.attempts, cfg.retry.maxNotifyTries);
});

test('a pending backlog under the window coexists with full terminal history (total capped at 300)', () => {
    const terminal = Array.from({ length: 280 }, (_, i) => rec('T' + i, 'DELIVERED', i));
    const pending = Array.from({ length: 20 }, (_, i) => rec('P' + i, 'QUEUED', 280 + i));
    const c = stateWith([...terminal, ...pending]); // 300 total, 20 pending
    noop(c);
    const list = c.get('S').list;
    assert.equal(list.length, 300);
    assert.equal(c.get('S').backlog, 20);
    for (const r of pending) assert.ok(list.some(x => x.id === r.id));
});

// NEW: the real notify-branch loss reproduction (this is the actual dropped-alert case).
test('real notify branch: enqueuing a 301st alert keeps the oldest pending (no loss)', () => {
    const code = fs.readFileSync('seaguard/src/functions/fn0029.js', 'utf8');
    const r = notifyScenario(code);
    assert.equal(r.total, 301, 'all 301 pending must remain');
    assert.ok(r.oldest, 'oldest pending P0 must survive');
    assert.ok(r.allPreloaded, 'every preloaded pending must remain');
    assert.ok(r.newest, 'the new 301st pending must remain');
});

// NEW: baseline comparison against the old notifier snapshot from the running runtime.
test('baseline: the old notifier drops the oldest pending on the 301st alert', () => {
    const oldPath = 'seaguard/tests/fixtures/notifier-before-retention.js';
    if (!fs.existsSync(oldPath)) throw new Error('old notifier snapshot missing: ' + oldPath);
    const oldCode = fs.readFileSync(oldPath, 'utf8');
    const r = notifyScenario(oldCode);
    assert.equal(r.total, 300, 'old notifier caps the list at 300');
    assert.ok(!r.oldest, 'old notifier drops the oldest pending P0 (reproduced actual loss)');
    assert.ok(r.newest, 'old notifier keeps the newest');
});

// NEW: overflow warning behaviour (one warning, no spam, flag clears on recovery).
test('overflow warns once, does not spam on repeats, and clears the flag on recovery', () => {
    warnings.length = 0;
    const pending = Array.from({ length: 301 }, (_, i) => rec('P' + i, 'QUEUED', i));
    const c = stateWith(pending);
    invoke('fn0029', { topic: 'noop' }, c);
    assert.equal(c.get('S').backlogExceeded, true, '301 pending exceeds the window');
    assert.equal(warnings.length, 1, 'first overflow must warn exactly once');
    invoke('fn0029', { topic: 'noop' }, c);
    invoke('fn0029', { topic: 'noop' }, c);
    assert.equal(warnings.length, 1, 'repeated overflow must not warn again');
    for (const r of c.get('S').list) r.status = 'DELIVERED';
    invoke('fn0029', { topic: 'noop' }, c);
    assert.equal(c.get('S').backlogExceeded, false, 'recovery clears the overflow flag');
    assert.equal(c.get('S').backlog, 0, 'recovery leaves no pending');
    assert.equal(warnings.length, 1, 'recovery must not add warnings');
});

fs.writeFileSync('seaguard/reports/outbox-regressions.json', JSON.stringify({ at: new Date().toISOString(), tests: outcomes }, null, 2));
for (const r of outcomes) console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error.split('\n')[0] : ''}`);
console.log(`${outcomes.filter(r => r.passed).length}/${outcomes.length} outbox scenarios passed`);
process.exitCode = outcomes.some(r => !r.passed) ? 1 : 0;
