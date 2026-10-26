// SeaGuard campaign results - pure metrics over the ACTUAL run state.
// Standalone module (no globals, no I/O) so it can be unit-tested offline and
// inlined verbatim into the fn003d oracle body at build time.
//
// Input: { schedule, eventLog, incidents, notifications, fw, syncStore, layout, cfg, D, evalT }
// Output: { detection, delivery, trips, scope } or null when inputs are unusable.
//
// Honesty rules:
//  - Every percentage/ratio carries an explicit denominator; zero denominator -> null (N/A).
//  - Decoys, not-yet-injected schedule entries, suppressions and other boats never count
//    as detections. Late detection is reported separately from no detection.
//  - Offshore buffered trip logs are not a failed recovery; only the harbour boat is
//    expected to be fully ashore.
//  - Physical crew rescue/dispatch response belongs to the rescue world, not here;
//    fleet operator response uses incident.ackedAt - incident.opened.

const DISTRESS = { CAPSIZE: 'CAPSIZE', FLOODING: 'FLOODING', MOB: 'MOB', SOS_BUTTON: 'SOS' };
const BASE_DL = { CAPSIZE: 60, FLOODING: 75, MOB: 70, SOS_BUTTON: 60 };
const ACCEPTED = ['NEW_INCIDENT', 'MERGED', 'REOPENED'];

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function deadlineFor(start, base, gwFault) {
  let dl = base;
  if (gwFault && start < gwFault.end && gwFault.start < start + base) dl = Math.max(base, gwFault.end - start + 30);
  return dl;
}

function computeDetection(schedule, eventLog, incidents, D, evalT) {
  const sched = Array.isArray(schedule) ? schedule : [];
  const ev = Array.isArray(eventLog) ? eventLog : [];
  const incs = Array.isArray(incidents) ? incidents : [];
  const gw = sched.find(f => f && f.type === 'GATEWAY_OUTAGE') || null;
  const tEval = num(evalT);
  const rows = [];
  let expected = 0, detected = 0, late = 0, missed = 0, notYet = 0;
  for (const f of sched) {
    if (!f || !DISTRESS[f.type]) continue; // other fault kinds: original oracle rows only
    const type = DISTRESS[f.type];
    const start = num(f.start);
    if (start === null) continue;
    // Matching window: [fault start, min(evalT, next same-type fault for this boat)).
    // Inclusive at the evaluation time (an event exactly at evalT is observed), but
    // EXCLUSIVE at the next same-type start: an event exactly at that boundary belongs
    // to the next occurrence and must not satisfy both faults.
    let to = tEval !== null ? tEval : Infinity;
    let toIsNext = false;
    for (const g of sched) {
      if (g === f || !g || g.type !== f.type || g.boat !== f.boat) continue;
      const gs = num(g.start);
      if (gs !== null && gs > start && gs <= to) { to = gs; toIsNext = true; }
    }
    if (tEval !== null && tEval < start) {
      notYet++;
      rows.push({ fault: f.id, type: f.type, boat: f.boat, status: 'NOT_YET', delayS: null, late: false, incident: null });
      continue;
    }
    expected++;
    const cands = ev.filter(e => e && e.type === type && e.boat === f.boat
      && ACCEPTED.indexOf(e.disposition) >= 0
      && num(e.t) !== null && e.t >= start
      && (toIsNext ? e.t < to : e.t <= to))
      .sort((a, b) => a.t - b.t);
    const hit = cands[0] || null;
    if (!hit) {
      missed++;
      rows.push({ fault: f.id, type: f.type, boat: f.boat, status: 'MISSED', delayS: null, late: false, incident: null });
      continue;
    }
    const inc = incs.find(i => i && i.id === hit.incident) || null;
    const dl = deadlineFor(start, BASE_DL[f.type], gw);
    const isLate = hit.t - start > dl;
    if (isLate) late++;
    detected++;
    rows.push({ fault: f.id, type: f.type, boat: f.boat, status: 'DETECTED', delayS: hit.t - start,
      deadlineS: dl, late: isLate, incident: hit.incident || null });
  }
  return {
    evalT: tEval,
    expected, detected, missed, late, notYet,
    rate: expected > 0 ? +(detected / expected).toFixed(3) : null,
    rows,
    excludedFromDenominator: 'decoys (WAVE_SPIKE/SPLASH/TAG_FLICKER), non-distress faults (link, boundary, weather, gateway, messaging, Wi-Fi, combo bookkeeping), future schedule entries and suppressions - those remain covered by the original oracle rows',
  };
}

function computeDelivery(notifications, incidents) {
  const notes = Array.isArray(notifications) ? notifications : [];
  const incs = Array.isArray(incidents) ? incidents : [];
  const created = notes.length;
  const delivered = notes.filter(n => n && n.status === 'DELIVERED').length;
  const pending = notes.filter(n => n && ['QUEUED', 'SENDING', 'RETRY'].indexOf(n.status) >= 0).length;
  const failed = notes.filter(n => n && n.status === 'FAILED').length;
  // Uncertain = delivery outcome unknown at evaluation, two distinct sources:
  //  - in-flight right now (SENDING): the HTTP response has not come back yet;
  //  - restore uncertainty: a row SENDING when the snapshot was written is normalized
  //    to RETRY by the store, which sets the durable boolean deliveryUncertain. The
  //    boolean (not lastError) is the flag of record: fn0029 overwrites lastError on
  //    every later retry error (HTTP 502 / no response), so the flag survives retry
  //    errors and budget-exhausted FAILED and an unresolved FAILED row still counts
  //    as uncertain. It clears only on confirmed DELIVERED. Legacy snapshots that
  //    predate the boolean fall back to the lastError marker text.
  const legacyMarker = n => typeof n.lastError === 'string' && n.lastError.indexOf('delivery uncertain') >= 0;
  const isUncertainFlag = n => !!n && n.status !== 'DELIVERED' && (n.deliveryUncertain === true || legacyMarker(n));
  const inFlight = n => !!n && n.status === 'SENDING';
  const uncertain = notes.filter(n => inFlight(n) || isUncertainFlag(n)).length;
  const uncertainInFlight = notes.filter(inFlight).length;
  const uncertainRestored = notes.filter(n => isUncertainFlag(n) && !inFlight(n)).length;
  const lats = [];
  for (const n of notes) {
    if (!n || n.status !== 'DELIVERED') continue;
    const c = num(n.created), d = num(n.deliveredAt);
    if (c !== null && d !== null && d >= c) lats.push(d - c);
  }
  lats.sort((a, b) => a - b);
  const lat = lats.length
    ? { minS: lats[0], maxS: lats[lats.length - 1], avgS: +(lats.reduce((a, b) => a + b, 0) / lats.length).toFixed(1) }
    : null;
  // Fleet operator response: acknowledged incidents only (rescue-world dispatch is separate).
  const resp = [];
  for (const i of incs) {
    if (!i || i.ackedAt === null || i.ackedAt === undefined) continue;
    const a = num(i.ackedAt), o = num(i.opened);
    if (a !== null && o !== null && a >= o) resp.push({ id: i.id, responseS: a - o });
  }
  resp.sort((x, y) => x.responseS - y.responseS);
  const op = resp.length
    ? { acked: resp.length, minS: resp[0].responseS, maxS: resp[resp.length - 1].responseS,
        avgS: +(resp.reduce((a, r) => a + r.responseS, 0) / resp.length).toFixed(1), rows: resp }
    : null;
  return {
    created, delivered, pending, failed, uncertain,
    uncertainInFlight, uncertainRestored,
    deliveredRate: created > 0 ? +(delivered / created).toFixed(3) : null,
    latency: lat,
    operatorResponse: op,
    note: created === 0
      ? 'no alert messages were created in this run - rates are N/A, not 100%'
      : (uncertain > 0
        ? 'uncertain = in-flight at evaluation (SENDING) + rows the store flagged deliveryUncertain at restore (SENDING->RETRY); the flag survives retry errors and FAILED and clears only on confirmed DELIVERED'
        : null),
  };
}

function computeTrips(fw, syncStore, layout) {
  const F = fw && typeof fw === 'object' ? fw : {};
  const S = syncStore && typeof syncStore === 'object' ? syncStore : {};
  const boats = layout && Array.isArray(layout.boats) ? layout.boats : [];
  const harbour = (layout && layout.roles && layout.roles.harbour) || null;
  const rows = [];
  let harbourComplete = null;
  for (const id of Object.keys(F)) {
    const f = F[id] || {}, s = S[id] || {};
    const logSeq = num(f.logSeq);
    if (logSeq === null) continue; // no trip log state for this vessel -> skip, not a failure
    const received = num(s.count);
    const maxContig = num(s.maxContig);
    const dupRecords = num(s.dupRecords) || 0;
    const buffered = num(f.logBuffered) || 0;
    const isHarbour = id === harbour;
    // Complete means the shore holds exactly the records the boat produced: the unique
    // count must equal the produced sequence, the contiguous prefix must reach it, and
    // nothing may still be buffered on board.
    const complete = logSeq > 0
      && received !== null && maxContig !== null
      && received === logSeq && maxContig === logSeq && buffered === 0;
    if (logSeq === 0) {
      // No records were ever produced: nothing to recover, nothing to hide.
      rows.push({ boat: id, role: isHarbour ? 'harbour' : 'offshore', logSeq: 0, received: received || 0,
        maxContig: maxContig || 0, dupRecords, buffered, complete: null, gapped: false,
        note: 'no records produced - N/A' });
      continue;
    }
    const gapped = received !== null && maxContig !== null && maxContig < received;
    // Duplicates are absorbed by the sync endpoint and never increase the unique count,
    // so received > logSeq is a cross-check mismatch regardless of dupRecords.
    const impossible = (received !== null && received > logSeq)
      || (maxContig !== null && maxContig > logSeq);
    if (isHarbour) harbourComplete = complete;
    rows.push({ boat: id, role: isHarbour ? 'harbour' : 'offshore', logSeq, received: received || 0,
      maxContig: maxContig || 0, dupRecords, buffered, complete, gapped,
      note: impossible ? 'cross-check mismatch: received/contiguous exceed produced sequence'
        : (isHarbour ? (complete ? 'complete upload' : 'incomplete at evaluation')
          : (buffered > 0 ? 'still buffered on board - not a failed recovery' : 'harbour-eligible complete')) });
  }
  return {
    rows,
    harbour: harbour,
    harbourComplete,
    offshoreBuffered: rows.filter(r => r.role === 'offshore' && r.buffered > 0).length,
    note: 'unique records counted from syncStore, not HTTP batch attempts; offshore buffered logs are not a failed recovery',
  };
}

function compute(inp) {
  if (!inp || typeof inp !== 'object') return null;
  if (!Array.isArray(inp.schedule) || !Array.isArray(inp.eventLog)) return null;
  const D = num(inp.D);
  const evalT = D !== null ? D : num(inp.evalT);
  return {
    detection: computeDetection(inp.schedule, inp.eventLog, inp.incidents, D, evalT),
    delivery: computeDelivery(inp.notifications, inp.incidents),
    trips: computeTrips(inp.fw, inp.syncStore, inp.layout),
    scope: 'fleet campaign metrics; physical crew rescue/dispatch response is measured in the separate rescue world',
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { compute, computeDetection, computeDelivery, computeTrips, DISTRESS, BASE_DL, ACCEPTED };
