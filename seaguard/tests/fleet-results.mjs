// SeaGuard campaign results - focused offline tests for src/fleet/results.cjs and its
// propagation into the generated fn003d oracle, fn004e publisher and ui0057 Test lab.
// Deliberate failure cases: missed emergency, late detection, decoys/future expectations,
// wrong boat/type/time, zero denominators, duplicate trip upload, gapped logs.
// No live Node-RED, no campaigns, no restarts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import resultsMod from '../src/fleet/results.cjs';

const { compute } = resultsMod;
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const flowsPath = path.join(ROOT, 'flows.json');
const reportPath = path.join(ROOT, 'reports', 'sprint-results.json');

assert0(fs.existsSync(flowsPath), 'flows.json missing - run `node seaguard/build.mjs` first');
const nodes = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

function assert0(cond, msg) { if (!cond) throw new Error(msg); }

const outcomes = [];
function test(name, fn) {
  try { fn(); outcomes.push({ name, passed: true }); }
  catch (e) { outcomes.push({ name, passed: false, error: e.message }); }
}

// ---------------------------------------------------------------- detection
const evAcc = (t, type, boat, incident, disposition = 'NEW_INCIDENT') =>
  ({ t, type, boat, incident, disposition, source: 'test' });

test('missed injected emergency increments missed, not detected', () => {
  const r = compute({
    schedule: [{ id: 'F1', type: 'CAPSIZE', boat: 'B1', start: 100, end: 1e9 }],
    eventLog: [], incidents: [], notifications: [], fw: {}, syncStore: {}, layout: {}, D: 300,
  });
  const d = r.detection;
  assert0(d.expected === 1, 'expected 1, got ' + d.expected);
  assert0(d.detected === 0, 'detected should be 0');
  assert0(d.missed === 1, 'missed should be 1, got ' + d.missed);
  assert0(d.late === 0, 'late should be 0');
  assert0(d.rate === 0, 'rate should be 0, got ' + d.rate);
  assert0(d.rows[0].status === 'MISSED', 'row status MISSED');
});

test('late detection is detected+late, distinct from missed', () => {
  const r = compute({
    schedule: [{ id: 'F1', type: 'CAPSIZE', boat: 'B1', start: 100, end: 1e9 }],
    eventLog: [evAcc(180, 'CAPSIZE', 'B1', 'i1')], incidents: [{ id: 'i1' }],
    notifications: [], fw: {}, syncStore: {}, layout: {}, D: 300,
  });
  const d = r.detection;
  assert0(d.detected === 1 && d.late === 1 && d.missed === 0, 'detected/late/missed = ' + d.detected + '/' + d.late + '/' + d.missed);
  assert0(d.rows[0].status === 'DETECTED' && d.rows[0].late === true && d.rows[0].delayS === 80, 'row late DETECTED +80s');
  assert0(d.rows[0].deadlineS === 60, 'base deadline 60 for CAPSIZE');
});

test('in-time detection with gateway outage deadline adjustment', () => {
  const r = compute({
    schedule: [
      { id: 'F1', type: 'CAPSIZE', boat: 'B1', start: 100, end: 1e9 },
      { id: 'F2', type: 'GATEWAY_OUTAGE', boat: null, start: 90, end: 200 },
    ],
    eventLog: [evAcc(210, 'CAPSIZE', 'B1', 'i1')], incidents: [{ id: 'i1' }],
    notifications: [], fw: {}, syncStore: {}, layout: {}, D: 400,
  });
  const row = r.detection.rows.find(x => x.fault === 'F1');
  // deadline = max(60, 200-100+30) = 130; delay 110 is in time under the adjusted window
  assert0(row.deadlineS === 130, 'adjusted deadline 130, got ' + row.deadlineS);
  assert0(row.status === 'DETECTED' && row.late === false, 'in time after gateway adjustment');
});

test('decoys and future schedule entries never count as detections', () => {
  const r = compute({
    schedule: [
      { id: 'F1', type: 'WAVE_SPIKE', boat: 'B1', start: 10, end: 12, decoy: true },
      { id: 'F2', type: 'SPLASH', boat: 'B2', start: 20, end: 22, decoy: true },
      { id: 'F3', type: 'MOB', boat: 'B1', start: 900, end: 1e9 }, // future: not yet injected at eval
    ],
    eventLog: [evAcc(905, 'MOB', 'B1', 'i9')], incidents: [{ id: 'i9' }],
    notifications: [], fw: {}, syncStore: {}, layout: {}, D: 600,
  });
  const d = r.detection;
  assert0(d.expected === 0 && d.detected === 0 && d.missed === 0, 'decoys excluded from denominator');
  assert0(d.notYet === 1, 'future MOB is not-yet-exercised, got ' + d.notYet);
  assert0(d.rate === null, 'zero denominator -> N/A (null), got ' + d.rate);
});

test('wrong boat, wrong type and pre-fault events do not match', () => {
  const r = compute({
    schedule: [{ id: 'F1', type: 'CAPSIZE', boat: 'B1', start: 100, end: 1e9 }],
    eventLog: [
      evAcc(120, 'CAPSIZE', 'B2', 'iX'),       // wrong boat
      evAcc(120, 'MOB', 'B1', 'iY'),           // wrong type
      evAcc(90, 'CAPSIZE', 'B1', 'iZ'),        // before fault start
    ],
    incidents: [], notifications: [], fw: {}, syncStore: {}, layout: {}, D: 300,
  });
  assert0(r.detection.missed === 1 && r.detection.detected === 0, 'no spurious match');
});

test('SOS_BUTTON maps to SOS event type; non-accepted dispositions ignored', () => {
  const r = compute({
    schedule: [{ id: 'F1', type: 'SOS_BUTTON', boat: 'B1', start: 50, end: 53 }],
    eventLog: [evAcc(60, 'SOS', 'B1', 'i1', 'SUPPRESSED'), evAcc(70, 'SOS', 'B1', 'i2', 'MERGED')],
    incidents: [{ id: 'i2' }], notifications: [], fw: {}, syncStore: {}, layout: {}, D: 300,
  });
  const d = r.detection;
  assert0(d.detected === 1 && d.rows[0].incident === 'i2', 'MERGED counts, SUPPRESSED does not');
  assert0(d.rows[0].delayS === 20, 'delay measured from fault start');
});

test('same-boat same-type window stops at the next occurrence', () => {
  const r = compute({
    schedule: [
      { id: 'F1', type: 'CAPSIZE', boat: 'B1', start: 100, end: 1e9 },
      { id: 'F2', type: 'CAPSIZE', boat: 'B1', start: 300, end: 1e9 },
    ],
    eventLog: [evAcc(150, 'CAPSIZE', 'B1', 'i1'), evAcc(350, 'CAPSIZE', 'B1', 'i2')],
    incidents: [{ id: 'i1' }, { id: 'i2' }], notifications: [], fw: {}, syncStore: {}, layout: {}, D: 600,
  });
  const d = r.detection;
  assert0(d.detected === 2 && d.missed === 0, 'both faults matched their own events');
  assert0(d.rows[0].incident === 'i1' && d.rows[1].incident === 'i2', 'each fault matched its own window');
});

test('event exactly at the next same-type start belongs to the next fault only', () => {
  const r = compute({
    schedule: [
      { id: 'F1', type: 'CAPSIZE', boat: 'B1', start: 100, end: 1e9 },
      { id: 'F2', type: 'CAPSIZE', boat: 'B1', start: 300, end: 1e9 },
    ],
    eventLog: [evAcc(300, 'CAPSIZE', 'B1', 'i2')],
    incidents: [{ id: 'i2' }], notifications: [], fw: {}, syncStore: {}, layout: {}, D: 600,
  });
  const d = r.detection;
  assert0(d.detected === 1 && d.missed === 1, 'one event cannot satisfy both faults: detected/missed = ' + d.detected + '/' + d.missed);
  assert0(d.rows[0].status === 'MISSED', 'F1 preceding window is exclusive at next-start: ' + d.rows[0].status);
  assert0(d.rows[1].status === 'DETECTED' && d.rows[1].incident === 'i2' && d.rows[1].delayS === 0, 'F2 owns the boundary event with zero delay');
});

test('eval-time boundary stays inclusive when no next same-type fault exists', () => {
  const r = compute({
    schedule: [{ id: 'F1', type: 'MOB', boat: 'B1', start: 100, end: 1e9 }],
    eventLog: [evAcc(300, 'MOB', 'B1', 'i1')], incidents: [{ id: 'i1' }],
    notifications: [], fw: {}, syncStore: {}, layout: {}, D: 300,
  });
  const row = r.detection.rows[0];
  assert0(row.status === 'DETECTED' && row.delayS === 200, 'event exactly at evalT is observed');
  assert0(row.late === true, 'delay 200 > MOB base deadline 70 -> late');
});

test('compute() rejects unusable inputs instead of fabricating numbers', () => {
  assert0(compute(null) === null, 'null input -> null');
  assert0(compute({ schedule: 'nope', eventLog: [] }) === null, 'non-array schedule -> null');
  const r = compute({ schedule: [], eventLog: [], incidents: [], notifications: [], fw: null, syncStore: null, layout: null, D: null });
  assert0(r.detection.rate === null && r.delivery.deliveredRate === null && r.delivery.latency === null, 'all zero denominators N/A');
  assert0(r.delivery.note && r.delivery.note.indexOf('N/A') >= 0, 'zero-eligible note present');
});

// ---------------------------------------------------------------- delivery
const note = (status, created, deliveredAt) => ({ id: 'n' + created, status, created, deliveredAt: deliveredAt === undefined ? null : deliveredAt });

test('delivery counts and deliveredAt-created latency', () => {
  const r = compute({
    schedule: [], eventLog: [],
    incidents: [],
    notifications: [note('DELIVERED', 10, 14), note('DELIVERED', 20, 29), note('RETRY', 30), note('FAILED', 40), note('SENDING', 50)],
    fw: {}, syncStore: {}, layout: {}, D: 300,
  });
  const dl = r.delivery;
  assert0(dl.created === 5 && dl.delivered === 2 && dl.pending === 2 && dl.failed === 1 && dl.uncertain === 1, // RETRY + SENDING are both pending; SENDING is additionally uncertain-at-restore
    'counts = ' + JSON.stringify([dl.created, dl.delivered, dl.pending, dl.failed, dl.uncertain]));
  assert0(dl.deliveredRate === 0.4, 'delivered rate 2/5');
  assert0(dl.latency.minS === 4 && dl.latency.maxS === 9 && dl.latency.avgS === 6.5, 'latency min/max/avg = ' + JSON.stringify(dl.latency));
});

test('restored SENDING->RETRY rows stay uncertain via the durable deliveryUncertain flag; in-flight vs restore labelled', () => {
  const marker = 'in-flight at restore; delivery uncertain';
  const restored = { id: 'n1', status: 'RETRY', created: 10, deliveredAt: null, lastError: marker, deliveryUncertain: true };
  const restoredDelivered = { id: 'n2', status: 'DELIVERED', created: 10, deliveredAt: 40, lastError: null, deliveryUncertain: false };
  const legacy = { id: 'n3', status: 'RETRY', created: 10, deliveredAt: null, lastError: marker }; // pre-flag snapshot: lastError fallback
  const r = compute({
    schedule: [], eventLog: [], incidents: [],
    notifications: [restored, restoredDelivered, legacy, note('SENDING', 20), note('RETRY', 30)],
    fw: {}, syncStore: {}, layout: {}, D: 300,
  });
  const dl = r.delivery;
  assert0(dl.uncertain === 3, 'flagged RETRY + legacy-marker RETRY + live SENDING are uncertain, got ' + dl.uncertain);
  assert0(dl.uncertainInFlight === 1 && dl.uncertainRestored === 2, 'honest in-flight vs restore breakdown: ' + dl.uncertainInFlight + '/' + dl.uncertainRestored);
  assert0(dl.delivered === 1 && dl.pending === 4 && dl.failed === 0, '1 delivered, 4 pending (3 RETRY + 1 SENDING), 0 failed');
  assert0(dl.note && dl.note.indexOf('deliveryUncertain') >= 0, 'note names the durable flag: ' + dl.note);
  const clean = compute({ schedule: [], eventLog: [], incidents: [], notifications: [note('DELIVERED', 1, 5)], fw: {}, syncStore: {}, layout: {}, D: 300 });
  assert0(clean.delivery.uncertain === 0 && clean.delivery.uncertainInFlight === 0 && clean.delivery.uncertainRestored === 0 && clean.delivery.note === null, 'no uncertainty -> zero breakdown, no note');
});

test('unresolved FAILED keeps the restore flag and counts uncertain; clean FAILED and confirmed DELIVERED do not', () => {
  const failedFlagged = { id: 'f1', status: 'FAILED', created: 10, deliveredAt: null, lastError: 'HTTP 502 Bad Gateway', deliveryUncertain: true };
  const failedClean = { id: 'f2', status: 'FAILED', created: 10, deliveredAt: null, lastError: 'HTTP 502 Bad Gateway', deliveryUncertain: false };
  const deliveredStaleFlag = { id: 'f3', status: 'DELIVERED', created: 10, deliveredAt: 40, lastError: null, deliveryUncertain: true };
  const r = compute({
    schedule: [], eventLog: [], incidents: [],
    notifications: [failedFlagged, failedClean, deliveredStaleFlag],
    fw: {}, syncStore: {}, layout: {}, D: 300,
  });
  const dl = r.delivery;
  assert0(dl.uncertain === 1, 'only the unresolved flagged FAILED is uncertain, got ' + dl.uncertain);
  assert0(dl.uncertainInFlight === 0 && dl.uncertainRestored === 1, 'flagged FAILED lands in the restored bucket: ' + dl.uncertainInFlight + '/' + dl.uncertainRestored);
  assert0(dl.failed === 2 && dl.delivered === 1, 'statuses still counted as failed/delivered');
  assert0(dl.note && dl.note.indexOf('deliveryUncertain') >= 0, 'note names the durable flag: ' + dl.note);
});

test('fleet operator response uses incident.ackedAt - opened; none acked -> N/A', () => {
  const withAck = compute({
    schedule: [], eventLog: [], notifications: [],
    incidents: [{ id: 'i1', opened: 100, ackedAt: 130 }, { id: 'i2', opened: 200, ackedAt: null }],
    fw: {}, syncStore: {}, layout: {}, D: 300,
  });
  assert0(withAck.delivery.operatorResponse.acked === 1 && withAck.delivery.operatorResponse.minS === 30 && withAck.delivery.operatorResponse.maxS === 30,
    'one acknowledged incident, 30 s response');
  const none = compute({ schedule: [], eventLog: [], notifications: [], incidents: [{ id: 'i1', opened: 1, ackedAt: null }], fw: {}, syncStore: {}, layout: {}, D: 300 });
  assert0(none.delivery.operatorResponse === null, 'no acknowledgements -> null, not 0%');
});

// ---------------------------------------------------------------- trips
const fwB = (id, logSeq, buffered) => ({ [id]: { logSeq, logBuffered: buffered } });

test('duplicate trip upload: unique records counted, duplicates ignored, complete', () => {
  const r = compute({
    schedule: [], eventLog: [], incidents: [], notifications: [],
    fw: fwB('H1', 5, 0),
    syncStore: { H1: { count: 5, maxContig: 5, dupRecords: 2, batches: 3 } },
    layout: { boats: [], roles: { harbour: 'H1' } }, D: 300,
  });
  const v = r.trips.rows[0];
  assert0(v.received === 5 && v.logSeq === 5 && v.dupRecords === 2 && v.gapped === false, 'unique 5/5 with 2 duplicates ignored');
  assert0(v.complete === true && r.trips.harbourComplete === true, 'harbour-eligible complete upload');
});

test('incomplete and gapped harbour logs are reported, not hidden', () => {
  const r = compute({
    schedule: [], eventLog: [], incidents: [], notifications: [],
    fw: fwB('H1', 10, 3),
    syncStore: { H1: { count: 7, maxContig: 4, dupRecords: 0, batches: 2 } },
    layout: { boats: [], roles: { harbour: 'H1' } }, D: 300,
  });
  const v = r.trips.rows[0];
  assert0(v.received === 7 && v.maxContig === 4 && v.buffered === 3, 'received/contiguous/buffered shown');
  assert0(v.gapped === true && v.complete === false, 'gap (4 < 7) and incomplete flagged');
  assert0(r.trips.harbourComplete === false, 'harbour complete = false');
});

test('offshore buffered logs are not a failed recovery; impossible ratios cross-checked', () => {
  const r = compute({
    schedule: [], eventLog: [], incidents: [], notifications: [],
    fw: { O1: { logSeq: 8, logBuffered: 5 }, O2: { logSeq: 4, logBuffered: 0 } },
    syncStore: { O1: { count: 3, maxContig: 3, dupRecords: 0 }, O2: { count: 9, maxContig: 4, dupRecords: 0 } },
    layout: { boats: [], roles: { harbour: null } }, D: 300,
  });
  const o1 = r.trips.rows.find(x => x.boat === 'O1');
  const o2 = r.trips.rows.find(x => x.boat === 'O2');
  assert0(o1.complete === false && o1.note.indexOf('not a failed recovery') >= 0, 'offshore buffer note');
  assert0(r.trips.offshoreBuffered === 1, 'one offshore vessel still buffering');
  assert0(o2.note.indexOf('cross-check mismatch') >= 0, 'received 9 > produced 4 flagged');
});

test('received unique > produced is a mismatch even with dupRecords > 0; complete requires received === logSeq', () => {
  const r = compute({
    schedule: [], eventLog: [], incidents: [], notifications: [],
    fw: { H1: { logSeq: 4, logBuffered: 0 } },
    syncStore: { H1: { count: 5, maxContig: 4, dupRecords: 3, batches: 4 } },
    layout: { boats: [], roles: { harbour: 'H1' } }, D: 300,
  });
  const v = r.trips.rows[0];
  assert0(v.note.indexOf('cross-check mismatch') >= 0, '5 unique > 4 produced flagged despite 3 duplicates: ' + v.note);
  assert0(v.complete === false, 'complete false - received does not equal produced sequence');
  assert0(r.trips.harbourComplete === false, 'harbour not complete');
});

test('no trip log state anywhere -> empty rows, harbourComplete null (N/A)', () => {
  const r = compute({ schedule: [], eventLog: [], incidents: [], notifications: [], fw: {}, syncStore: {}, layout: {}, D: 300 });
  assert0(r.trips.rows.length === 0 && r.trips.harbourComplete === null, 'N/A, not a failure');
});

// ---------------------------------------------------------------- propagation into generated code
const fn003dSrc = byId.fn003d && byId.fn003d.func;
const fn004eSrc = byId.fn004e && byId.fn004e.func;
const ui0057Src = byId.ui0057 && byId.ui0057.format;

test('build inlined results module into fn003d and wired T.results.metrics', () => {
  assert0(fn003dSrc && fn003dSrc.indexOf('function compute(') >= 0, 'compute() inlined');
  assert0(fn003dSrc.indexOf('metrics: metrics') >= 0, 'metrics attached to T.results');
  assert0(fn003dSrc.indexOf('const ACCEPTED = [') >= 0, 'renamed constant avoids oracle ACCEPT collision');
  assert0(fn003dSrc.indexOf('const ACCEPT = [') >= 0, 'original oracle ACCEPT preserved');
});

test('fn004e publishes metrics to the Test lab payload', () => {
  assert0(fn004eSrc && fn004eSrc.indexOf('metrics: (T.results && T.results.metrics) || null') >= 0, 'testMsg carries metrics');
});

test('ui0057 shows metrics with tested field names and seed-zero-safe visibility', () => {
  assert0(ui0057Src && ui0057Src.indexOf('p.metrics.detection.rows') >= 0, 'detection rows bound');
  assert0(ui0057Src.indexOf('p.metrics.trips.rows') >= 0, 'trip rows bound');
  assert0(ui0057Src.indexOf('p.seed != null') >= 0, 'seed-zero visibility fixed');
  assert0(ui0057Src.indexOf('v-if="p.seed"') < 0, 'no bare p.seed v-if remains');
});

test('generated fn003d runs end-to-end and propagates metrics (missed emergency, seed 0)', () => {
  const scope = new Map();
  const T = {
    state: 'EVALUATING', seed: 0, D: 300, startedWall: Date.now(),
    schedule: [{ id: 'F1', type: 'CAPSIZE', boat: 'B1', start: 100, end: 1e9 }],
    layout: { boats: [], roles: { harbour: null } },
  };
  scope.set('test', T);
  scope.set('cfg', { detect: { escalateAfterS: 120, restoreGraceS: 30 }, weather: { testEverySimS: 30 } });
  scope.set('lib', { zoneOfXY: () => null });
  scope.set('eventLog', []);
  scope.set('incidents', []);
  scope.set('suppressions', []);
  scope.set('notifications', []);
  scope.set('mockTelegram', []);
  scope.set('linkShore', {});
  scope.set('chan', {});
  scope.set('fw', {});
  scope.set('syncStore', {});
  scope.set('weather', {});
  scope.set('gateway', {});
  const g = { get: (k) => scope.get(k), set: (k, v) => scope.set(k, v) };
  let warned = [];
  const node = { status: () => {}, warn: (m) => warned.push(m) };
  const fn = new Function('msg', 'node', 'context', 'global', 'flow', 'env', fn003dSrc);
  const out = fn(null, node, {}, g, {}, { get: () => undefined });
  assert0(out && out.topic === 'results', 'oracle returned results topic');
  assert0(out.payload.metrics && out.payload.metrics.detection.missed === 1, 'missed emergency propagated into metrics, got ' + JSON.stringify(out.payload.metrics && out.payload.metrics.detection));
  assert0(out.payload.metrics.detection.expected === 1 && out.payload.metrics.detection.rate === 0, 'explicit denominator in generated run');
  assert0(scope.get('test').results.metrics === out.payload.metrics, 'T.results.metrics persisted on the test global');
  assert0(scope.get('test').history[0].seed === 0, 'seed 0 recorded in history');
  assert0(warned.length === 0, 'no metrics warnings: ' + warned.join('; '));
});

// ---------------------------------------------------------------- report
const pass = outcomes.filter(o => o.passed).length;
const fail = outcomes.length - pass;
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({
  file: 'seaguard/tests/fleet-results.mjs',
  module: 'seaguard/src/fleet/results.cjs',
  passed: pass, failed: fail, of: outcomes.length,
  checks: outcomes.map(o => ({ name: o.name, passed: o.passed, error: o.error || undefined })),
  deliberateCases: {
    missedEmergency: 'missed injected emergency increments missed, not detected',
    lateDetection: 'late detection is detected+late, distinct from missed',
    decoysFuture: 'decoys and future schedule entries never count as detections',
    wrongBoatTypeTime: 'wrong boat, wrong type and pre-fault events do not match',
    zeroDenominator: 'compute() rejects unusable inputs instead of fabricating numbers',
    duplicateTripUpload: 'duplicate trip upload: unique records counted, duplicates ignored, complete',
    gappedLogs: 'incomplete and gapped harbour logs are reported, not hidden',
    exactBoundary: 'event exactly at the next same-type start belongs to the next fault only',
    evalTimeInclusive: 'eval-time boundary stays inclusive when no next same-type fault exists',
    restoredUncertain: 'restored SENDING->RETRY rows stay uncertain via the store flag until confirmed; in-flight vs restore labelled',
    receivedAboveProducedWithDups: 'received unique > produced is a mismatch even with dupRecords > 0; complete requires received === logSeq',
  },
}, null, 2) + '\n');
console.log(JSON.stringify({ passed: pass, failed: fail, of: outcomes.length }));
if (fail) {
  for (const o of outcomes) if (!o.passed) console.log('FAIL ' + o.name + ': ' + o.error);
  process.exit(1);
}