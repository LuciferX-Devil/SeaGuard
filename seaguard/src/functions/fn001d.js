// Shore ingest. Receives every uplink from MQTT (seaguard/up/+) and:
//  - tracks per-boat sequence numbers: loss (gaps), late arrivals that fill gaps,
//    duplicates and out-of-order frames
//  - acknowledges confirmed events (again, if a retry arrives after the ACK was lost)
//  - applies telemetry only if it is newer than what the shore already has
//    (a late frame never moves a boat backwards)
//  - raises COMMS_LOST when a boat has been silent too long, COMMS_RESTORED when heard again
// Outputs: 1 = applied telemetry (to geofence), 2 = events (to correlation), 3 = ACK downlinks (MQTT)
const cfg = global.get('cfg');
const ep = global.get('epoch');
const t = global.get('simTime') || 0;

let S = context.get('S');
if (!S || S.ep !== ep) { S = { ep, L: {}, staleEpoch: 0 }; context.set('S', S); }

function link(b) {
    if (!S.L[b]) S.L[b] = { highest: 0, seen: new Set(), seenQ: [], missing: new Set(), eids: new Set(),
        recv: 0, lost: 0, recovered: 0, dup: 0, ooo: 0, dupEvents: 0, retriesSeen: 0, staleRejected: 0, regressions: 0,
        lastSeen: null, silent: false, silentSince: null, rssi: null, snr: null, lastT: null };
    return S.L[b];
}
function saveLink() {
    const o = {};
    for (const b of Object.keys(S.L)) {
        const L = S.L[b];
        o[b] = { highest: L.highest, recv: L.recv, lost: L.lost, recovered: L.recovered, dup: L.dup, ooo: L.ooo,
            dupEvents: L.dupEvents, retriesSeen: L.retriesSeen, staleRejected: L.staleRejected, regressions: L.regressions,
            lastSeen: L.lastSeen, silent: L.silent, rssi: L.rssi, snr: L.snr };
    }
    global.set('linkShore', o);
}
function ev(type, boat, data, extra) {
    return { topic: 'event', payload: Object.assign({ type, boat, t, source: 'shore', data: data || {} }, extra || {}) };
}
const out1 = [], out2 = [], out3 = [];

if (msg.topic === 'tick') {
    for (const b of Object.keys(S.L)) {
        const L = S.L[b];
        if (L.lastSeen !== null && !L.silent && t - L.lastSeen > cfg.detect.commsLostS) {
            L.silent = true; L.silentSince = t;
            out2.push(ev('COMMS_LOST', b, { silentFor: t - L.lastSeen, lastHeard: L.lastSeen }));
        }
    }
    saveLink();
    return [null, out2.length ? out2 : null, null];
}

let p = msg.payload;
if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return null; } }
if (!p || typeof p !== 'object' || !p.b) return null;
if (p.ep !== ep) { S.staleEpoch++; return null; }
if (!cfg.fleet.some(b => b.id === p.b) || !['T', 'E'].includes(p.k) || !Number.isSafeInteger(p.s) || p.s < 1 || p.s > 10000000 || !Number.isFinite(p.t) || !Number.isFinite(p.la) || Math.abs(p.la) > 90 || !Number.isFinite(p.lo) || Math.abs(p.lo) > 180) return null;
if (p.k === 'E' && (typeof p.eid !== 'string' || p.eid.length < 1 || p.eid.length > 100 || !['CAPSIZE', 'FLOODING', 'MOB', 'SOS'].includes(p.ev))) return null;

const L = link(p.b);
function ack() { out3.push({ topic: 'seaguard/down/' + p.b, payload: { k: 'A', b: p.b, ep, eid: p.eid } }); }

if (L.seen.has(p.s)) {
    L.dup++;
    if (p.k === 'E') { L.retriesSeen++; ack(); }
    saveLink();
    return [null, null, out3.length ? out3 : null];
}
// Seen IDs are bounded. An old sequence outside the retained missing window must
// not be counted as a new frame again after its deduplication entry is evicted.
if (p.s <= L.highest && !L.missing.has(p.s)) {
    L.dup++;
    if (p.k === 'E') { L.retriesSeen++; ack(); }
    saveLink();
    return [null, null, out3.length ? out3 : null];
}
L.seen.add(p.s); L.seenQ.push(p.s);
if (L.seenQ.length > 2048) L.seen.delete(L.seenQ.shift());
L.recv++;
if (p.s > L.highest + 1) {
    // Keep only the recent recovery window; a large sequence gap must not allocate
    // millions of entries or block the Node-RED event loop.
    for (let k = Math.max(L.highest + 1, p.s - 4000); k < p.s; k++) { L.missing.add(k); }
    L.lost += p.s - L.highest - 1;
    if (L.missing.size > 4000) { const it = L.missing.values(); for (let k = 0; k < 1000; k++) L.missing.delete(it.next().value); }
} else if (p.s < L.highest) {
    L.ooo++;
    if (L.missing.has(p.s)) { L.missing.delete(p.s); L.lost--; L.recovered++; }
}
L.highest = Math.max(L.highest, p.s);
L.lastSeen = t;
if (p.rssi !== undefined) { L.rssi = p.rssi; L.snr = p.snr; }
if (L.silent) {
    L.silent = false;
    out2.push(ev('COMMS_RESTORED', p.b, { silentFor: t - L.silentSince }));
}

if (p.k === 'T') {
    const fleet = global.get('fleet') || {};
    const F = fleet[p.b] || { id: p.b, posT: -1e9 };
    if (p.t > F.posT) {
        if (F.posT > -1e9 && p.t < F.posT) L.regressions++; // cannot happen by construction; kept as a checked invariant
        Object.assign(F, { id: p.b, lat: p.la, lon: p.lo, spd: p.sp, hdg: p.hd, roll: p.r, level: p.wl, bat: p.bv,
            crew: p.cr, crewTotal: p.ct, hdop: p.hdop, posT: p.t, rxT: t });
        fleet[p.b] = F;
        global.set('fleet', fleet);
        out1.push({ topic: 'telemetry', payload: { boat: p.b, t: p.t, lat: p.la, lon: p.lo } });
    } else {
        L.staleRejected++;
    }
} else if (p.k === 'E') {
    ack();
    if (p.rt > 1) L.retriesSeen++;
    if (L.eids.has(p.eid)) { L.dupEvents++; }
    else {
        L.eids.add(p.eid);
        out2.push(ev(p.ev, p.b, Object.assign({}, p.d, { lat: p.la, lon: p.lo, tBoat: p.t, transmissions: p.rt }), { source: 'edge', eid: p.eid }));
    }
}
saveLink();
return [out1.length ? out1 : null, out2.length ? out2 : null, out3.length ? out3 : null];
