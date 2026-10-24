// Correlation engine. Every event from the boats, the geofence, the gateway monitor and the
// weather service ends up here. It turns a stream of events into a small number of
// incidents and decides who gets told what.
// Rules:
//  R1 Vessel in distress   two or more of capsize / flooding / man overboard / SOS on one
//                          boat inside the correlation window -> ONE critical incident
//  R2 Storm amplified      a high/critical boat incident inside a zone with an active storm
//  R3 Silent in storm      no contact from a boat that is inside a storm zone -> high
//  R4 Root cause           "no contact" from boats while the shore gateway is offline is
//                          suppressed; one fleet incident for the gateway instead
//  R5 Dedup / cooldown     repeats of the same event type fold into the open incident;
//                          a recurrence soon after resolution reopens it (no new alert)
//  R6 Escalation           a critical incident not acknowledged in time is re-sent to the
//                          coast guard marked ESCALATED
// Outputs: 1 = notifications (to notifier), 2 = advisory downlinks (to MQTT)
const cfg = global.get('cfg'), lib = global.get('lib');
const ep = global.get('epoch');
const t = global.get('simTime') || 0;
const D = cfg.detect;

const SEV = { CAPSIZE: 4, SOS: 4, MOB: 4, FLOODING: 3, BOUNDARY_VIOLATION: 3, COMMS_LOST: 2, RESTRICTED_ZONE: 2, BOUNDARY_WARNING: 1, STORM_WARNING: 1, GATEWAY_OUTAGE: 2 };
const SEVNAME = ['Info', 'Advisory', 'Medium', 'High', 'Critical'];
const FAMILY = { CAPSIZE: 'distress', FLOODING: 'distress', MOB: 'distress', SOS: 'distress', BOUNDARY_WARNING: 'boundary', BOUNDARY_VIOLATION: 'boundary', RESTRICTED_ZONE: 'boundary', COMMS_LOST: 'comms' };
const INFO = ['COMMS_RESTORED', 'BOUNDARY_CLEAR', 'BOUNDARY_RETURNED', 'RESTRICTED_EXIT', 'STORM_CLEARED', 'GATEWAY_RESTORED', 'WEATHER_DEGRADED', 'WEATHER_RESTORED'];
const LABEL = { CAPSIZE: 'Capsize', FLOODING: 'Flooding', MOB: 'Man overboard', SOS: 'SOS button pressed', BOUNDARY_WARNING: 'Approaching maritime boundary', BOUNDARY_VIOLATION: 'Crossed maritime boundary', RESTRICTED_ZONE: 'Inside no-fishing reserve', COMMS_LOST: 'No contact', STORM_WARNING: 'Storm warning', GATEWAY_OUTAGE: 'Shore gateway offline' };
const RULE = { VESSEL_IN_DISTRESS: 'R1 vessel in distress', STORM_AMPLIFIED: 'R2 storm amplified', SILENT_IN_STORM: 'R3 silent in storm' };

let C = context.get('C');
if (!C || C.ep !== ep) {
    C = { ep, n: 0, nn: 0, en: 0, storm: {}, gw: { active: false, since: null, restoredAt: null }, advQ: [],
        ruleCount: { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0 } };
    context.set('C', C);
    global.set('incidents', []); global.set('eventLog', []); global.set('suppressions', []);
}
const incidents = global.get('incidents') || [];
const eventLog = global.get('eventLog') || [];
const suppressions = global.get('suppressions') || [];
const notifyOut = [], downOut = [];

function logEvent(e, disposition, incId, note) {
    eventLog.push({ n: ++C.en, t, type: e.type, boat: e.boat, source: e.source, eid: e.eid || null, disposition, incident: incId || null, note: note || '', data: e.data || {} });
    if (eventLog.length > 500) eventLog.splice(0, eventLog.length - 500);
}
function suppress(e, rule, reason, incId) {
    suppressions.push({ t, type: e.type, boat: e.boat, rule, reason, incident: incId || null });
    if (suppressions.length > 200) suppressions.shift();
    C.ruleCount[rule] = (C.ruleCount[rule] || 0) + 1;
}
function lastPos(inc) {
    for (let i = inc.events.length - 1; i >= 0; i--) { const d = inc.events[i].data || {}; if (d.lat) return { lat: d.lat, lon: d.lon }; }
    const f = (global.get('fleet') || {})[inc.boat];
    return f && f.lat ? { lat: f.lat, lon: f.lon } : null;
}
function zoneOfBoat(b) {
    const f = (global.get('fleet') || {})[b];
    return f && f.lat ? lib.zoneOf(f.lat, f.lon) : null;
}
function describe(x) {
    const d = x.data || {};
    switch (x.type) {
        case 'CAPSIZE': return 'capsize (roll ' + d.roll + '°)';
        case 'FLOODING': return 'flooding (bilge ' + d.level + '%)';
        case 'MOB': return 'man overboard: ' + (d.crew || d.tag);
        case 'SOS': return 'SOS button pressed';
        case 'COMMS_LOST': return 'no contact for ' + d.silentFor + ' s';
        case 'BOUNDARY_WARNING': return d.distM + ' m from the boundary';
        case 'BOUNDARY_VIOLATION': return Math.abs(d.distM) + ' m across the boundary';
        case 'RESTRICTED_ZONE': return 'inside ' + (d.zone || 'reserve');
        case 'STORM_WARNING': return (d.zoneName || d.zone) + ': waves ' + d.wave + ' m, wind ' + d.wind + ' km/h';
        case 'GATEWAY_OUTAGE': return d.reason || 'backhaul offline';
        default: return x.type;
    }
}
function recipients(inc) {
    if (inc.kind === 'fleet') return inc.key.indexOf('STORM') === 0 ? ['ops', 'family'] : ['ops'];
    if (inc.severity >= 3) return ['family', 'coastguard'];
    if (inc.severity === 2) return ['ops'];
    return [];
}
function notify(inc, kind, roles) {
    roles = roles || recipients(inc);
    if (!roles.length) return;
    const ref = inc.id + '/N' + (++C.nn);
    const head = { NEW: '', UPDATE: 'UPDATE: ', ESCALATION: 'ESCALATED, not acknowledged: ', RESOLVED: 'RESOLVED: ' }[kind] || '';
    const icon = inc.severity >= 4 ? '🔴' : inc.severity === 3 ? '🟠' : inc.severity === 2 ? '🟡' : '🔵';
    const lines = [icon + ' ' + head + SEVNAME[inc.severity] + ': ' + inc.title];
    if (inc.kind === 'boat') lines.push('Boat: ' + inc.boat + ' ' + lib.boatName(inc.boat));
    lines.push('Events: ' + inc.events.map(describe).join('; '));
    const p = lastPos(inc);
    if (p) { lines.push('Position: ' + lib.fmtLL(p.lat, p.lon)); lines.push('Map: https://maps.google.com/?q=' + p.lat.toFixed(5) + ',' + p.lon.toFixed(5)); }
    if (inc.rules.length) lines.push('Correlation: ' + inc.rules.map(r => RULE[r] || r).join(', '));
    lines.push('Ref: ' + ref);
    inc.notifications.push({ ref, kind, roles, t });
    inc.lastNotifyT = t;
    notifyOut.push({ topic: 'notify', payload: { ref, incident: inc.id, kind, roles, severity: inc.severity, text: lines.join('\n') } });
}
function advisory(boat, text, level, repeats, spacing) {
    const n = repeats || 1, gap = spacing || 15;
    for (let k = 0; k < n; k++) C.advQ.push({ boat, text, level, at: t + k * gap, expires: t + (n - 1) * gap + 150 });
}
function evaluate(inc) {
    if (inc.kind !== 'boat') return false;
    const types = new Set(inc.events.map(x => x.type));
    let sev = Math.max(inc.severity || 0, ...inc.events.map(x => SEV[x.type] || 0));
    const rules = inc.rules.slice();
    const add = (r, code) => { if (rules.indexOf(r) < 0) { rules.push(r); C.ruleCount[code]++; } };
    const distress = ['CAPSIZE', 'FLOODING', 'MOB', 'SOS'].filter(x => types.has(x)).length;
    if (distress >= 2) { add('VESSEL_IN_DISTRESS', 'R1'); sev = 4; }
    const zone = zoneOfBoat(inc.boat);
    if (zone && C.storm[zone]) {
        if (types.has('COMMS_LOST')) { add('SILENT_IN_STORM', 'R3'); sev = Math.max(sev, 3); }
        if (sev >= 3 && inc.family !== 'comms') add('STORM_AMPLIFIED', 'R2');
        if (rules.indexOf('STORM_AMPLIFIED') >= 0 || rules.indexOf('SILENT_IN_STORM') >= 0) inc.stormZone = zone;
    }
    let lead = inc.events[0];
    for (const x of inc.events) if ((SEV[x.type] || 0) >= (SEV[lead.type] || 0)) lead = x;
    const title = rules.indexOf('VESSEL_IN_DISTRESS') >= 0 ? 'Vessel in distress'
        : rules.indexOf('SILENT_IN_STORM') >= 0 ? 'Possible distress: no contact during storm'
            : LABEL[lead.type] || lead.type;
    const changed = sev !== inc.severity || rules.length !== inc.rules.length;
    inc.severity = sev; inc.rules = rules; inc.title = title; inc.severityName = SEVNAME[sev];
    return changed;
}
function scheduleUpdate(inc) {
    if (!recipients(inc).length) return;
    if (t - (inc.lastNotifyT || -1e9) >= D.updateMinGapS) { notify(inc, 'UPDATE'); inc.pendingUpdate = false; }
    else inc.pendingUpdate = true;
}
function resolve(inc, why) {
    inc.status = 'RESOLVED'; inc.resolvedAt = t; inc.resolution = why;
}
function newIncident(e, kind, key) {
    const inc = { id: 'INC-' + (++C.n), kind, key: key || null, boat: e.boat, family: FAMILY[e.type] || e.type, opened: t, lastEventT: t,
        events: [{ t, type: e.type, source: e.source, eid: e.eid || null, data: e.data || {} }], status: 'OPEN',
        severity: 0, severityName: '', rules: [], title: LABEL[e.type] || e.type, escalation: 1, ackedAt: null,
        notifications: [], lastNotifyT: null, pendingUpdate: false, reopened: 0, folded: 0 };
    inc.severity = SEV[e.type] || 1;
    evaluate(inc);
    incidents.push(inc);
    if (incidents.length > 200) incidents.shift();
    return inc;
}

function handle(e) {
    if (INFO.indexOf(e.type) >= 0) {
        let incId = null, note = '';
        if (e.type === 'COMMS_RESTORED') {
            const inc = incidents.find(i => i.boat === e.boat && i.status !== 'RESOLVED' && i.family === 'comms');
            if (inc && inc.events.every(x => x.type === 'COMMS_LOST')) { resolve(inc, 'contact restored'); incId = inc.id; note = 'auto-resolved'; }
        } else if (e.type === 'BOUNDARY_CLEAR') {
            const inc = incidents.find(i => i.boat === e.boat && i.status !== 'RESOLVED' && i.family === 'boundary');
            if (inc && inc.events.every(x => x.type === 'BOUNDARY_WARNING')) { resolve(inc, 'moved away from boundary'); incId = inc.id; note = 'auto-resolved'; }
        } else if (e.type === 'RESTRICTED_EXIT') {
            const inc = incidents.find(i => i.boat === e.boat && i.status !== 'RESOLVED' && i.family === 'boundary');
            if (inc && inc.events.every(x => x.type === 'RESTRICTED_ZONE')) { resolve(inc, 'left reserve'); incId = inc.id; note = 'auto-resolved'; }
        } else if (e.type === 'STORM_CLEARED') {
            delete C.storm[e.data.zone];
            const inc = incidents.find(i => i.kind === 'fleet' && i.key === 'STORM-' + e.data.zone && i.status !== 'RESOLVED');
            if (inc) { resolve(inc, 'storm cleared'); incId = inc.id; note = 'auto-resolved'; }
        } else if (e.type === 'GATEWAY_RESTORED') {
            C.gw.active = false; C.gw.restoredAt = t;
            const inc = incidents.find(i => i.kind === 'fleet' && i.key === 'GATEWAY' && i.status !== 'RESOLVED');
            if (inc) { resolve(inc, 'gateway back online'); incId = inc.id; note = 'auto-resolved'; }
        }
        logEvent(e, 'INFO', incId, note);
        return;
    }
    if (e.type === 'GATEWAY_OUTAGE') {
        C.gw.active = true; C.gw.since = t;
        let inc = incidents.find(i => i.kind === 'fleet' && i.key === 'GATEWAY' && i.status !== 'RESOLVED');
        if (inc) { inc.folded++; suppress(e, 'R5', 'gateway incident already open', inc.id); logEvent(e, 'FOLDED', inc.id); return; }
        inc = newIncident(e, 'fleet', 'GATEWAY');
        notify(inc, 'NEW');
        logEvent(e, 'NEW_INCIDENT', inc.id);
        return;
    }
    if (e.type === 'STORM_WARNING') {
        const z = e.data.zone;
        C.storm[z] = { since: t, wave: e.data.wave, wind: e.data.wind };
        let inc = incidents.find(i => i.kind === 'fleet' && i.key === 'STORM-' + z && i.status !== 'RESOLVED');
        if (inc) { inc.folded++; logEvent(e, 'FOLDED', inc.id); return; }
        inc = newIncident(e, 'fleet', 'STORM-' + z);
        inc.title = 'Storm warning: ' + (e.data.zoneName || z);
        const fleet = global.get('fleet') || {};
        const inZone = Object.keys(fleet).filter(b => fleet[b].lat && lib.zoneOf(fleet[b].lat, fleet[b].lon) === z);
        inc.boatsNotified = inZone;
        for (const b of inZone) advisory(b, 'Storm in ' + (e.data.zoneName || z) + ': waves ' + e.data.wave + ' m. Return to harbour.', 'storm', 4, 25);
        notify(inc, 'NEW');
        logEvent(e, 'NEW_INCIDENT', inc.id, 'advisory to ' + (inZone.join(', ') || 'no boats'));
        for (const o of incidents) {
            if (o.kind === 'boat' && o.status !== 'RESOLVED' && zoneOfBoat(o.boat) === z && evaluate(o)) scheduleUpdate(o);
        }
        return;
    }
    if (e.type === 'COMMS_LOST' && (C.gw.active || (C.gw.restoredAt !== null && t - C.gw.restoredAt < D.restoreGraceS))) {
        suppress(e, 'R4', 'shore gateway offline: silence is explained by the outage');
        logEvent(e, 'SUPPRESSED', null, 'R4 root cause: gateway');
        return;
    }
    // ---- boat incidents
    const fam = FAMILY[e.type] || e.type;
    let inc = incidents.find(i => i.kind === 'boat' && i.boat === e.boat && i.status !== 'RESOLVED' &&
        (i.family === fam || t - i.lastEventT <= D.correlationWindowS));
    let reopened = false;
    if (!inc) {
        inc = incidents.find(i => i.kind === 'boat' && i.boat === e.boat && i.status === 'RESOLVED' && i.family === fam &&
            t - i.resolvedAt <= D.cooldownS && i.events.some(x => x.type === e.type));
        if (inc) { inc.status = 'OPEN'; inc.reopened++; inc.resolvedAt = null; reopened = true; C.ruleCount.R5++; }
    }
    if (inc) {
        const same = inc.events.find(x => x.type === e.type && (e.type !== 'MOB' || (x.data || {}).tag === (e.data || {}).tag));
        if (same && !reopened) {
            inc.folded++;
            suppress(e, 'R5', 'repeat of ' + e.type + ' folded into ' + inc.id, inc.id);
            logEvent(e, 'FOLDED', inc.id);
            return;
        }
        inc.events.push({ t, type: e.type, source: e.source, eid: e.eid || null, data: e.data || {} });
        inc.lastEventT = t;
        if (reopened) { suppress(e, 'R5', 'recurrence within cooldown reopened ' + inc.id + ' without a new alert', inc.id); logEvent(e, 'REOPENED', inc.id); evaluate(inc); return; }
        const changed = evaluate(inc);
        logEvent(e, 'MERGED', inc.id, changed ? 'incident upgraded' : '');
        if (changed) scheduleUpdate(inc);
    } else {
        inc = newIncident(e, 'boat');
        logEvent(e, 'NEW_INCIDENT', inc.id);
        notify(inc, 'NEW');
    }
    if (e.type === 'BOUNDARY_WARNING') advisory(e.boat, 'Maritime boundary ' + e.data.distM + ' m ahead. Turn back.', 'boundary', 2);
    if (e.type === 'BOUNDARY_VIOLATION') advisory(e.boat, 'You have crossed the maritime boundary. Return immediately.', 'boundary', 3);
    if (e.type === 'RESTRICTED_ZONE') advisory(e.boat, 'Inside a no-fishing reserve. Leave the area.', 'reserve', 2);
}

if (msg.topic === 'event') {
    handle(msg.payload);
} else if (msg.topic === 'cmd') {
    const c = msg.payload || {};
    const inc = incidents.find(i => i.id === c.id);
    if (inc && c.cmd === 'ack' && inc.status === 'OPEN') { inc.status = 'ACKED'; inc.ackedAt = t; inc.ackedBy = c.by || 'operator'; }
    if (inc && c.cmd === 'resolve' && inc.status !== 'RESOLVED') resolve(inc, 'closed by ' + (c.by || 'operator'));
} else if (msg.topic === 'tick') {
    for (const inc of incidents) {
        if (inc.status === 'RESOLVED') continue;
        if (inc.pendingUpdate && t - (inc.lastNotifyT || -1e9) >= D.updateMinGapS) { notify(inc, 'UPDATE'); inc.pendingUpdate = false; }
        if (inc.severity >= 4 && inc.status === 'OPEN' && inc.escalation === 1 && t - inc.opened >= D.escalateAfterS) {
            inc.escalation = 2; inc.escalatedAt = t; C.ruleCount.R6++;
            notify(inc, 'ESCALATION', ['coastguard']);
        }
    }
    // advisories are only worth transmitting while the gateway can actually reach the boats
    const gwOnline = (global.get('gatewayShore') || {}).online !== false;
    const due = C.advQ.filter(a => a.at <= t);
    C.advQ = C.advQ.filter(a => a.at > t);
    for (const a of due) {
        if (gwOnline) downOut.push({ topic: 'seaguard/down/' + a.boat, payload: { k: 'ADV', b: a.boat, ep, text: a.text, level: a.level } });
        else if (t < a.expires) { a.at = t + 10; C.advQ.push(a); }
    }
}
global.set('incidents', incidents);
global.set('eventLog', eventLog);
global.set('suppressions', suppressions);
global.set('corr', { storm: C.storm, gw: C.gw, ruleCount: C.ruleCount });
return [notifyOut.length ? notifyOut : null, downOut.length ? downOut : null];
