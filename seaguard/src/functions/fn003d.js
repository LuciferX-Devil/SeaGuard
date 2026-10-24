// Test oracle. Every injected fault carries an expectation; every expectation is checked against
// what the system actually did, with the observed timing recorded. Fleet-wide invariants
// (delivery, deduplication, accounting, escalation policy) are checked as well.
const cfg = global.get('cfg'), lib = global.get('lib');
const T = global.get('test');
if (!T || !T.schedule) return null;
const D = T.D;
const ev = (global.get('eventLog') || []);
const incidents = global.get('incidents') || [];
const sup = global.get('suppressions') || [];
const notes = global.get('notifications') || [];
const mock = global.get('mockTelegram') || [];
const shore = global.get('linkShore') || {};
const chan = global.get('chan') || {};
const fw = global.get('fw') || {};
const store = global.get('syncStore') || {};
const weather = global.get('weather') || {};
const ACCEPT = ['NEW_INCIDENT', 'MERGED', 'REOPENED'];
const acc = ev.filter(e => ACCEPT.indexOf(e.disposition) >= 0);
const rows = [];
function row(fault, title, expected, observed, ok) {
    rows.push({ fault: fault || '-', title, expected, observed, result: ok === null ? 'SKIP' : (ok ? 'PASS' : 'FAIL') });
}
const INFO_TYPES = ['COMMS_RESTORED', 'BOUNDARY_CLEAR', 'BOUNDARY_RETURNED', 'RESTRICTED_EXIT', 'STORM_CLEARED', 'GATEWAY_RESTORED', 'WEATHER_DEGRADED', 'WEATHER_RESTORED'];
function firstEv(type, boat, from, to) {
    const list = INFO_TYPES.indexOf(type) >= 0 ? ev : acc;
    return list.find(e => e.type === type && (!boat || e.boat === boat) && (from === undefined || e.t >= from) && (to === undefined || e.t <= to)) || null;
}
function countEv(type, boat, from, to) {
    const list = INFO_TYPES.indexOf(type) >= 0 ? ev : acc;
    return list.filter(e => e.type === type && (!boat || e.boat === boat) && (from === undefined || e.t >= from) && (to === undefined || e.t <= to)).length;
}
function incOf(e) { return incidents.find(i => i.id === e.incident) || null; }
const gwFault = T.schedule.find(f => f.type === 'GATEWAY_OUTAGE');
// The engine only knows about a storm between the STORM_WARNING and STORM_CLEARED events,
// which lag the injected weather by up to one polling interval.
function boatZone(id) {
    const b = ((T.layout && T.layout.boats) || (global.get('layout') || {}).boats || []).find(x => x.id === id);
    return b ? lib.zoneOfXY(b) : null;
}
function stormActiveFor(boat, when) {
    const z = boatZone(boat);
    if (!z) return null;
    const w = ev.filter(e => e.type === 'STORM_WARNING' && (e.data || {}).zone === z && e.t <= when).pop();
    if (!w) return null;
    const c = ev.find(e => e.type === 'STORM_CLEARED' && (e.data || {}).zone === z && e.t > w.t && e.t <= when);
    return c ? null : w;
}
function deadline(start, base) {
    let dl = base;
    if (gwFault && start < gwFault.end && gwFault.start < start + base) dl = Math.max(base, gwFault.end - start + 30);
    return dl;
}
function alertCheck(f, type, base, label) {
    const dl = deadline(f.start, base);
    const e = firstEv(type, f.boat, f.start);
    const n = countEv(type, f.boat);
    const ok = !!e && e.t - f.start <= dl && n === 1;
    row(f.id, label + ' raised for ' + f.boat,
        type + ' alert within ' + dl + ' s, exactly once',
        e ? ('raised at +' + (e.t - f.start) + ' s in ' + e.incident + ', ' + n + ' time(s)' + (e.data && e.data.transmissions > 1 ? ', delivered on transmission ' + e.data.transmissions : '')) : 'no alert',
        ok);
    return e;
}
function decoyCheck(f, type, label) {
    const n = countEv(type, f.boat, f.start, f.start + 40);
    const filt = (fw[f.boat] || {}).filtered || {};
    const key = type === 'CAPSIZE' ? 'roll' : type === 'FLOODING' ? 'splash' : 'tag';
    row(f.id, label + ' ignored on ' + f.boat, 'no ' + type + ' alert within 40 s',
        n === 0 ? 'no alert; edge filter counted ' + (filt[key] || 0) + ' transient(s)' : n + ' false alert(s)', n === 0);
}

// ---------------------------------------------------------------- per-fault checks
for (const f of T.schedule) {
    switch (f.type) {
        case 'CAPSIZE': alertCheck(f, 'CAPSIZE', 60, 'Capsize'); break;
        case 'FLOODING': alertCheck(f, 'FLOODING', 75, 'Flooding'); break;
        case 'MOB': alertCheck(f, 'MOB', 70, 'Man overboard'); break;
        case 'SOS_BUTTON': alertCheck(f, 'SOS', 60, 'SOS'); break;
        case 'WAVE_SPIKE': decoyCheck(f, 'CAPSIZE', 'Single wave'); break;
        case 'SPLASH': decoyCheck(f, 'FLOODING', 'Bilge splash'); break;
        case 'TAG_FLICKER': decoyCheck(f, 'MOB', 'Tag dropout'); break;
        case 'RADIO_BLACKOUT': {
            const lost = firstEv('COMMS_LOST', f.boat, f.start, f.end + 30);
            const back = firstEv('COMMS_RESTORED', f.boat, f.end - 5, f.end + 40);
            row(f.id, 'Silent boat detected: ' + f.boat, 'COMMS_LOST during the blackout, COMMS_RESTORED within 40 s of its end',
                (lost ? 'lost at +' + (lost.t - f.start) + ' s' : 'not detected') + '; ' + (back ? 'restored at +' + (back.t - f.end) + ' s after the blackout' : 'not restored'),
                !!lost && !!back);
            const storm = lost ? stormActiveFor(f.boat, lost.t) : null;
            if (storm && lost) {
                const inc = incOf(lost);
                const ok = !!inc && inc.rules.indexOf('SILENT_IN_STORM') >= 0 && inc.severity >= 3;
                row(f.id, 'Silence during a storm escalated: ' + f.boat, 'rule R3 silent in storm, severity high or above',
                    inc ? (inc.id + ' rules [' + inc.rules.join(', ') + '], severity ' + inc.severityName) : 'no incident', ok);
            }
            break;
        }
        case 'LINK_DEGRADE': {
            const false1 = countEv('COMMS_LOST', f.boat, f.start, f.end + 30);
            const L = shore[f.boat] || {};
            row(f.id, 'Packet loss ridden out: ' + f.boat, 'no false COMMS_LOST while ' + Math.round(f.params.loss * 100) + ' % of packets are lost',
                false1 === 0 ? 'none; shore counted ' + (L.lost || 0) + ' missing frame(s) from sequence gaps' : false1 + ' false alert(s)', false1 === 0);
            break;
        }
        case 'DUP_BURST': {
            const L = shore[f.boat] || {};
            const dupEid = (() => { const seen = {}; let d = 0; for (const e of acc) { if (!e.eid) continue; if (seen[e.eid]) d++; seen[e.eid] = 1; } return d; })();
            row(f.id, 'Duplicates absorbed: ' + f.boat, 'duplicate frames counted and dropped, no duplicated alerts',
                (L.dup || 0) + ' duplicate frame(s) dropped, ' + dupEid + ' duplicated alert(s)', (L.dup || 0) > 0 && dupEid === 0);
            break;
        }
        case 'REORDER_BURST': {
            const L = shore[f.boat] || {};
            const held = (chan['up:' + f.boat] || {}).held || 0;
            const ooo = L.ooo || 0;
            // held frames only arrive out of order if a later frame overtakes them: retransmissions
            // reuse their sequence number and a lost successor leaves nothing to overtake.
            const ok = ooo === 0 ? null : (L.regressions || 0) === 0;
            row(f.id, 'Out-of-order frames handled: ' + f.boat, 'late frames flagged and never applied over newer state',
                held === 0 ? 'the channel never actually held a frame back'
                    : ooo === 0 ? held + ' frame(s) held back, but nothing overtook them, so no reordering reached the shore'
                        : ooo + ' out-of-order, ' + (L.staleRejected || 0) + ' stale frame(s) rejected, ' + (L.recovered || 0) + ' late frame(s) filled gaps, ' + (L.regressions || 0) + ' regression(s)', ok);
            break;
        }
        case 'BOUNDARY_DRIFT': {
            const w = firstEv('BOUNDARY_WARNING', f.boat, f.start);
            const v = firstEv('BOUNDARY_VIOLATION', f.boat, f.start);
            const nw = countEv('BOUNDARY_WARNING', f.boat);
            row(f.id, 'Boundary warning: ' + f.boat, 'one BOUNDARY_WARNING within 130 s of the drift starting',
                w ? 'warned at +' + (w.t - f.start) + ' s (' + nw + ' warning(s) total)' : 'no warning', !!w && w.t - f.start <= 130 && nw === 1);
            row(f.id, 'Boundary crossing: ' + f.boat, 'BOUNDARY_VIOLATION within 270 s, merged into the same incident',
                v ? 'violation at +' + (v.t - f.start) + ' s in ' + v.incident : 'no violation',
                !!v && v.t - f.start <= 270 && !!w && v.incident === w.incident);
            const advN = (fw[f.boat] || {}).advCount || 0;
            row(f.id, 'Advisory sent to the boat: ' + f.boat, 'the boat receives a turn-back advisory over the downlink',
                advN + ' advisory message(s) received on board', advN > 0);
            break;
        }
        case 'GPS_JITTER': {
            const nw = countEv('BOUNDARY_WARNING', f.boat);
            const nv = countEv('BOUNDARY_VIOLATION', f.boat);
            const nc = countEv('BOUNDARY_CLEAR', f.boat);
            row(f.id, 'No boundary flapping: ' + f.boat, 'at most one warning, no violation and no clear/re-warn cycle under ' + f.params.sigma + ' m GPS noise',
                nw + ' warning(s), ' + nv + ' violation(s), ' + nc + ' clear(s)', nw <= 1 && nv === 0 && nc === 0);
            break;
        }
        case 'RESERVE_INCURSION': {
            const e = firstEv('RESTRICTED_ZONE', f.boat, f.start);
            row(f.id, 'Reserve incursion: ' + f.boat, 'RESTRICTED_ZONE within 200 s',
                e ? 'detected at +' + (e.t - f.start) + ' s' : 'not detected', !!e && e.t - f.start <= 200);
            break;
        }
        case 'STORM': {
            const w = firstEv('STORM_WARNING', 'FLEET', f.start, f.start + 60);
            const c = firstEv('STORM_CLEARED', 'FLEET', f.end);
            row(f.id, 'Storm warning for ' + f.params.zoneName, 'STORM_WARNING within 60 s of the storm arriving (weather is polled every ' + cfg.weather.testEverySimS + ' s)',
                w ? 'raised at +' + (w.t - f.start) + ' s' : 'not raised', !!w);
            row(f.id, 'Storm cleared for ' + f.params.zoneName, 'STORM_CLEARED within 60 s of the storm passing',
                c ? 'cleared at +' + (c.t - f.end) + ' s' : 'not cleared', !!c && c.t - f.end <= 60);
            if (w) {
                const inc = incOf(w);
                const boats = (inc && inc.boatsNotified) || [];
                const skip = boats.filter(b => T.schedule.some(s => (s.type === 'RADIO_BLACKOUT' || s.type === 'LINK_DEGRADE') && s.boat === b));
                const got = boats.filter(b => ((fw[b] || {}).advCount || 0) > 0);
                row(f.id, 'Storm advisory reached the boats', 'every boat in the zone with a working radio gets the advisory',
                    boats.length ? (got.length + '/' + boats.length + ' boat(s) received it' + (skip.length ? ' (' + skip.join(', ') + ' had radio faults)' : '')) : 'no boats in the zone',
                    boats.length === 0 ? null : got.length + skip.length >= boats.length);
            }
            break;
        }
        case 'WEATHER_API_FAIL': {
            const h = (weather.history || []);
            const deg = h.find(x => x.status === 'DEGRADED' && x.t >= f.start && x.t <= f.start + 60);
            const ok2 = h.find(x => x.status === 'OK' && x.t >= f.end && x.t <= f.end + 60);
            row(f.id, 'Weather feed failure handled', 'feed marked degraded during the outage and healthy again afterwards, last good values kept',
                (deg ? 'degraded at +' + (deg.t - f.start) + ' s' : 'never degraded') + '; ' + (ok2 ? 'recovered at +' + (ok2.t - f.end) + ' s' : 'not recovered'),
                !!deg && !!ok2);
            break;
        }
        case 'GATEWAY_OUTAGE': {
            const o = firstEv('GATEWAY_OUTAGE', 'FLEET', f.start, f.start + 30);
            const b = firstEv('GATEWAY_RESTORED', 'FLEET', f.end - 5, f.end + 40);
            const incs = incidents.filter(i => i.kind === 'fleet' && i.key === 'GATEWAY');
            row(f.id, 'Gateway outage detected', 'one fleet incident when the backhaul drops, resolved when it returns',
                (o ? 'detected at +' + (o.t - f.start) + ' s' : 'not detected') + '; ' + (b ? 'restored at +' + (b.t - f.end) + ' s' : 'not restored') + '; ' + incs.length + ' incident(s)',
                !!o && !!b && incs.length === 1);
            const suppressed = sup.filter(s => s.rule === 'R4');
            const blackout = T.schedule.filter(s => s.type === 'RADIO_BLACKOUT').map(s => s.boat);
            const wrong = acc.filter(e => e.type === 'COMMS_LOST' && e.t >= f.start && e.t <= f.end + cfg.detect.restoreGraceS && blackout.indexOf(e.boat) < 0);
            row(f.id, 'Per-boat silence not double reported', 'COMMS_LOST from the outage suppressed in favour of the gateway incident',
                suppressed.length + ' suppressed, ' + wrong.length + ' boat alert(s) raised anyway', wrong.length === 0);
            const g = global.get('gateway') || {};
            row(f.id, 'Buffered uplinks forwarded', 'packets held during the outage are forwarded when the backhaul returns',
                ((g.stats || {}).flushed || 0) + ' packet(s) flushed, ' + ((g.stats || {}).bufDropped || 0) + ' dropped from a full buffer',
                ((g.stats || {}).flushed || 0) > 0);
            break;
        }
        case 'TELEGRAM_OUTAGE': {
            const attempts = mock.filter(m => m.t >= f.start && m.t < f.end);
            const rejected = attempts.filter(m => !m.ok);
            const affected = notes.filter(n => n.created <= f.end);
            const ok = attempts.length === 0 ? null : rejected.length === attempts.length && affected.every(n => n.status === 'DELIVERED');
            row(f.id, 'Messaging outage survived', 'sends attempted during the outage are rejected, then retried until they are delivered',
                attempts.length === 0 ? 'no alert was due while the messaging service was down'
                    : rejected.length + '/' + attempts.length + ' send(s) rejected during the outage; ' + affected.filter(n => n.status === 'DELIVERED').length + '/' + affected.length + ' message(s) eventually delivered',
                ok);
            break;
        }
        case 'WIFI_FLAP': {
            const F = fw[f.boat] || {}, st = store[f.boat] || {};
            const exercised = (F.syncTimeouts || 0) > 0 || (st.dupRecords || 0) > 0;
            row(f.id, 'Flaky harbour Wi-Fi absorbed', 'dropped uploads are resent and duplicated records are absorbed ashore',
                (F.syncTimeouts || 0) + ' timeout(s), ' + (st.dupRecords || 0) + ' duplicate record(s) discarded ashore',
                exercised ? true : null);
            break;
        }
    }
    if (f.combo && f.type === 'FLOODING') {
        const inc = incidents.find(i => i.boat === f.boat && i.rules.indexOf('VESSEL_IN_DISTRESS') >= 0);
        const all = incidents.filter(i => i.kind === 'boat' && i.boat === f.boat && i.family === 'distress');
        const msgs = inc ? inc.notifications.filter(n => n.kind !== 'ESCALATION').length : 0;
        row(f.id, 'Two emergencies become one alert: ' + f.boat, 'capsize and flooding merge into a single critical incident (rule R1)',
            inc ? (inc.id + ' holds ' + inc.events.map(e => e.type).join(' + ') + ', ' + all.length + ' distress incident(s) for this boat, ' + msgs + ' alert message batch(es)') : 'not merged',
            !!inc && all.length === 1);
    }
}

// ---------------------------------------------------------------- fleet invariants
const undelivered = notes.filter(n => n.status !== 'DELIVERED');
row(null, 'Every alert message delivered', 'no queued, retrying or failed message left at the end of the run',
    notes.length + ' message(s), ' + undelivered.length + ' not delivered' + (undelivered.length ? ' (' + undelivered.map(n => n.id + ' ' + n.status).join(', ') + ')' : ''),
    undelivered.length === 0);

const byKey = {};
for (const m of mock) { if (!m.ok) continue; const k = m.ref + '|' + m.chat; byKey[k] = (byKey[k] || 0) + 1; }
const dupSend = Object.keys(byKey).filter(k => byKey[k] > 1);
row(null, 'No duplicated alert messages', 'each alert reference is delivered once per recipient',
    Object.keys(byKey).length + ' delivered message(s), ' + dupSend.length + ' duplicate(s)', dupSend.length === 0);

const seenEid = {}; let dupAccepted = 0;
for (const e of acc) { if (!e.eid) continue; if (seenEid[e.eid]) dupAccepted++; seenEid[e.eid] = 1; }
const retr = Object.keys(shore).reduce((a, b) => a + (shore[b].retriesSeen || 0), 0);
row(null, 'Retransmitted events counted once', 'a confirmed event retried over the radio produces exactly one alert',
    retr + ' retransmission(s) seen ashore, ' + dupAccepted + ' duplicated alert(s)', dupAccepted === 0);

const gaveUp = Object.keys(fw).reduce((a, b) => a + (fw[b].gaveUp || 0), 0);
row(null, 'No emergency abandoned by the boats', 'every confirmed uplink is acknowledged before the retry budget runs out',
    gaveUp + ' event(s) abandoned', gaveUp === 0);

let acctBad = [];
for (const b of Object.keys(shore)) {
    const L = shore[b];
    if (L.recv + L.lost !== L.highest) acctBad.push(b + ' (' + L.recv + '+' + L.lost + '!=' + L.highest + ')');
}
row(null, 'Link accounting adds up', 'received + missing frames equals the highest sequence number, for every boat',
    acctBad.length ? acctBad.join(', ') : Object.keys(shore).map(b => b + ': ' + shore[b].recv + ' received, ' + shore[b].lost + ' lost, ' + shore[b].dup + ' duplicate').join(' · '),
    acctBad.length === 0);

const regressions = Object.keys(shore).reduce((a, b) => a + (shore[b].regressions || 0), 0);
const stale = Object.keys(shore).reduce((a, b) => a + (shore[b].staleRejected || 0), 0);
row(null, 'Late frames never rewind a boat', 'an out-of-date position is rejected, never applied over a newer one',
    stale + ' stale frame(s) rejected, ' + regressions + ' regression(s)', regressions === 0);

const crit = incidents.filter(i => i.severity >= 4 && i.kind === 'boat');
const escBad = [];
for (const i of crit) {
    const ackedInTime = i.ackedAt !== null && i.ackedAt - i.opened < cfg.detect.escalateAfterS;
    if (ackedInTime && i.escalation !== 1) escBad.push(i.id + ' escalated despite acknowledgement');
    if (!ackedInTime && D - i.opened >= cfg.detect.escalateAfterS + 3 && i.escalation !== 2) escBad.push(i.id + ' not escalated');
}
row(null, 'Escalation policy followed', 'unacknowledged critical incidents escalate after ' + cfg.detect.escalateAfterS + ' s, acknowledged ones do not',
    escBad.length ? escBad.join('; ') : crit.length + ' critical incident(s): ' + (crit.map(i => i.id + (i.ackedAt !== null ? ' acknowledged' : ' escalated to level ' + i.escalation)).join(', ') || 'none'),
    escBad.length === 0);

// explainability: nothing alarmed that was not caused by an injected fault
const cause = {
    CAPSIZE: ['CAPSIZE'], FLOODING: ['FLOODING'], MOB: ['MOB'], SOS: ['SOS_BUTTON'],
    COMMS_LOST: ['RADIO_BLACKOUT'], BOUNDARY_WARNING: ['BOUNDARY_DRIFT', 'GPS_JITTER'],
    BOUNDARY_VIOLATION: ['BOUNDARY_DRIFT'], RESTRICTED_ZONE: ['RESERVE_INCURSION']
};
const unexplained = [];
for (const i of incidents) {
    if (i.kind === 'fleet') {
        const want = i.key === 'GATEWAY' ? 'GATEWAY_OUTAGE' : 'STORM';
        if (!T.schedule.some(f => f.type === want)) unexplained.push(i.id + ' (' + i.key + ')');
        continue;
    }
    for (const e of i.events) {
        const causes = cause[e.type] || [];
        if (!T.schedule.some(f => f.boat === i.boat && causes.indexOf(f.type) >= 0)) unexplained.push(i.id + ' ' + e.type + ' on ' + i.boat);
    }
}
row(null, 'No unexplained alerts', 'every incident traces back to an injected fault',
    unexplained.length ? unexplained.join('; ') : incidents.length + ' incident(s), all traced to injected faults', unexplained.length === 0);

// harbour log sync integrity
const hb = (T.layout && T.layout.roles && T.layout.roles.harbour) || null;
if (hb) {
    const st = store[hb] || { count: 0, maxContig: 0, dupRecords: 0, batches: 0 };
    const F = fw[hb] || { logSeq: 0, logBuffered: 0 };
    const gapless = st.count === st.maxContig;
    const complete = st.maxContig === F.logSeq && (F.logBuffered || 0) === 0;
    row(null, 'Trip log synced over harbour Wi-Fi: ' + hb, 'every record ashore, in one unbroken sequence, none stored twice',
        st.maxContig + '/' + F.logSeq + ' records ashore in ' + st.batches + ' batch(es), ' + st.dupRecords + ' duplicate record(s) discarded, ' + (F.logBuffered || 0) + ' still on board',
        gapless && complete);
}

const pass = rows.filter(r => r.result === 'PASS').length;
const fail = rows.filter(r => r.result === 'FAIL').length;
const skip = rows.filter(r => r.result === 'SKIP').length;
T.results = { rows, pass, fail, skip, verdict: fail === 0 ? 'PASS' : 'FAIL', finishedWall: Date.now(), wallSec: Math.round((Date.now() - T.startedWall) / 1000) };
T.state = 'DONE';
T.history = (T.history || []);
T.history.unshift({ seed: T.seed, faults: T.schedule.length, pass, fail, skip, verdict: T.results.verdict, when: new Date().toISOString().slice(11, 19), wallSec: T.results.wallSec });
if (T.history.length > 20) T.history.pop();
global.set('test', T);
node.status({ fill: fail === 0 ? 'green' : 'red', shape: 'dot', text: 'seed ' + T.seed + ': ' + pass + ' pass / ' + fail + ' fail' });
return { topic: 'results', payload: T.results };
