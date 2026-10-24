// Boat firmware (runs "on the boat hub"). Consumes raw sensor readings and:
//  - detects capsize / flooding / man-overboard / SOS with debounce so transients are ignored
//  - sends periodic telemetry over LoRa (unconfirmed) and critical events as confirmed
//    uplinks that are retried with backoff until the shore acknowledges them
//  - keeps a full-resolution onboard log and syncs it over harbour Wi-Fi in batches
// Outputs: 1 = LoRa uplink, 2 = Wi-Fi sync request, 3 = diagnostics
const cfg = global.get('cfg');
const ep = global.get('epoch');
const D = cfg.detect;

let S = context.get('S');
if (!S || S.ep !== ep) { S = { ep, boats: {} }; context.set('S', S); }

function state(id) {
    if (S.boats[id]) return S.boats[id];
    const lb = ((global.get('layout') || {}).boats || []).find(b => b.id === id) || {};
    const st = {
        id, seq: 0, lastTelem: -999, hold: { roll: 0, flood: 0 }, latched: { capsize: false, flood: false },
        tags: {}, evN: 0, pending: [], log: [], logSeq: 0, acked: 0, inflight: null, batchN: 0,
        adv: null, advCount: 0,
        stats: { sent: 0, retries: 0, acked: 0, gaveUp: 0, rttSum: 0, rttN: 0, dupAcks: 0,
            filtered: { roll: 0, splash: 0, tag: 0 }, syncBatches: 0, syncTimeouts: 0, syncErrors: 0 }
    };
    // Records already logged earlier in the trip (before this simulation window started).
    const pre = lb.preLog || 0;
    const ll = lb.startLL || { lat: cfg.harbour.lat, lon: cfg.harbour.lon };
    for (let i = 0; i < pre; i++) {
        st.log.push({ s: ++st.logSeq, t: -(pre - i), lat: ll.lat, lon: ll.lon, spd: 0, roll: 0, lvl: 2, bat: 12.6, crew: (lb.tags || []).length });
    }
    S.boats[id] = st;
    return st;
}
function backoff(n) { const b = cfg.retry.eventBackoff; return b[Math.min(n - 1, b.length - 1)]; }

const up = [], sync = [], diag = [];
const t = global.get('simTime') || 0;

function publishSummary(b) {
    const fw = global.get('fw') || {};
    fw[b.id] = {
        pending: b.pending.map(p => ({ eid: p.eid, ev: p.pkt.ev, tries: p.tries })),
        sent: b.stats.sent, retries: b.stats.retries, acked: b.stats.acked, gaveUp: b.stats.gaveUp, dupAcks: b.stats.dupAcks,
        avgAckS: b.stats.rttN ? +(b.stats.rttSum / b.stats.rttN).toFixed(1) : null,
        filtered: b.stats.filtered, logBuffered: b.log.length, logSeq: b.logSeq, syncedThrough: b.acked,
        syncBatches: b.stats.syncBatches, syncTimeouts: b.stats.syncTimeouts, syncErrors: b.stats.syncErrors,
        adv: b.adv, advCount: b.advCount, seq: b.seq
    };
    global.set('fw', fw);
}

if (msg.topic === 'downlink') {
    const d = msg.payload || {};
    if (d.ep !== ep || !d.b) return null;
    const b = state(d.b);
    if (d.k === 'A') {
        const i = b.pending.findIndex(p => p.eid === d.eid);
        if (i >= 0) {
            const p = b.pending[i];
            b.pending.splice(i, 1);
            b.stats.acked++; b.stats.rttSum += (t - p.firstAt); b.stats.rttN++;
            diag.push({ boat: b.id, t, text: `Shore acknowledged ${p.pkt.ev} (${p.eid}) after ${p.tries} transmission(s), ${t - p.firstAt}s` });
        } else b.stats.dupAcks++;
    } else if (d.k === 'ADV') {
        b.adv = { text: d.text, level: d.level, t }; b.advCount++;
        diag.push({ boat: b.id, t, text: `Advisory shown on deck display: ${d.text}` });
    }
    publishSummary(b);
    return [null, null, diag.length ? diag.map(x => ({ topic: 'diag', payload: x })) : null];
}

if (msg.topic === 'syncResp') {
    const bId = msg.boat;
    if (msg.ep !== ep || !bId) return null;
    const b = state(bId);
    if (msg._syncBatch !== undefined && (!b.inflight || msg._syncBatch !== b.inflight.id)) return null;
    if (msg.statusCode === 200 && msg.payload && Number.isSafeInteger(msg.payload.ackedThrough) && msg.payload.ackedThrough >= 0 && msg.payload.ackedThrough <= b.logSeq && b.inflight && msg.payload.ackedThrough <= b.inflight.to) {
        const a = msg.payload.ackedThrough;
        if (a > b.acked) b.acked = a;
        let k = 0; while (k < b.log.length && b.log[k].s <= b.acked) k++;
        if (k) b.log.splice(0, k);
        b.inflight = null;
    } else {
        b.stats.syncErrors++;
        b.inflight = null;
    }
    publishSummary(b);
    return null;
}

if (msg.topic !== 'reading') return null;
const r = msg.payload;
if (r.ep !== ep) return null;
const b = state(r.boat);

function sendPkt(pkt, isRetry) {
    up.push({ topic: 'uplink', payload: Object.assign({}, pkt) });
    b.stats.sent++;
    if (isRetry) b.stats.retries++;
}
function raise(type, data) {
    const eid = b.id + '-' + (++b.evN);
    const pkt = { k: 'E', ev: type, eid, b: b.id, ep, s: ++b.seq, t: r.t, la: r.gps.lat, lo: r.gps.lon, d: data, rt: 1 };
    b.pending.push({ eid, pkt, tries: 1, firstAt: r.t, nextAt: r.t + backoff(1) });
    sendPkt(pkt, false);
    diag.push({ boat: b.id, t: r.t, text: `Edge detected ${type}; confirmed uplink ${eid} sent` });
}

// ---- onboard log (1 Hz, full resolution)
const aboard = r.ble.filter(x => x.rssi !== null && x.rssi >= D.tagLostDbm).length;
// A test freezes new log production during its final drain window. The real radio/HTTP
// path continues so the oracle can require complete delivery, rather than tolerate loss.
const testState = global.get('test') || {};
if (global.get('mode') !== 'test' || !testState.measurementEnd || r.t <= testState.measurementEnd) {
    b.log.push({ s: ++b.logSeq, t: r.t, lat: +r.gps.lat.toFixed(6), lon: +r.gps.lon.toFixed(6), spd: r.gps.spd, roll: r.imu.roll, lvl: r.water.level, bat: r.bat.v, crew: aboard });
}
if (b.log.length > 20000) b.log.shift();

// ---- capsize: roll beyond threshold held for capsizeHoldS
if (Math.abs(r.imu.roll) > D.capsizeRollDeg) b.hold.roll++;
else {
    if (b.hold.roll > 0 && b.hold.roll < D.capsizeHoldS && !b.latched.capsize) {
        b.stats.filtered.roll++;
        diag.push({ boat: b.id, t: r.t, text: `Ignored roll spike (${b.hold.roll}s above ${D.capsizeRollDeg} deg): not a capsize` });
    }
    b.hold.roll = 0;
}
if (b.hold.roll >= D.capsizeHoldS && !b.latched.capsize) { b.latched.capsize = true; raise('CAPSIZE', { roll: Math.round(r.imu.roll) }); }

// ---- flooding: bilge level above threshold held for floodHoldS
if (r.water.level > D.floodPct) b.hold.flood++;
else {
    if (b.hold.flood > 0 && b.hold.flood < D.floodHoldS && !b.latched.flood) {
        b.stats.filtered.splash++;
        diag.push({ boat: b.id, t: r.t, text: `Ignored bilge splash (${b.hold.flood}s above ${D.floodPct}%): not flooding` });
    }
    b.hold.flood = 0;
}
if (b.hold.flood >= D.floodHoldS && !b.latched.flood) { b.latched.flood = true; raise('FLOODING', { level: Math.round(r.water.level) }); }

// ---- man overboard: crew tag missing for mobMissingS
for (const tg of r.ble) {
    const ts = b.tags[tg.tag] || (b.tags[tg.tag] = { miss: 0, latched: false });
    const lost = tg.rssi === null || tg.rssi < D.tagLostDbm;
    if (lost) ts.miss++;
    else {
        if (ts.miss > 0 && ts.miss < D.mobMissingS && !ts.latched) {
            b.stats.filtered.tag++;
            diag.push({ boat: b.id, t: r.t, text: `Ignored tag dropout for ${tg.name} (${ts.miss}s): tag came back` });
        }
        ts.miss = 0;
    }
    if (ts.miss >= D.mobMissingS && !ts.latched) { ts.latched = true; raise('MOB', { tag: tg.tag, crew: tg.name }); }
}

// ---- SOS button
if (r.sos) raise('SOS', {});

// ---- periodic telemetry (unconfirmed)
if (r.t - b.lastTelem >= cfg.lora.telemetryEveryS) {
    b.lastTelem = r.t;
    sendPkt({ k: 'T', b: b.id, ep, s: ++b.seq, t: r.t, la: +r.gps.lat.toFixed(6), lo: +r.gps.lon.toFixed(6), sp: r.gps.spd, hd: r.gps.hdg,
        r: r.imu.roll, wl: r.water.level, bv: r.bat.v, cr: aboard, ct: r.ble.length, hdop: r.gps.hdop }, false);
}

// ---- retransmit unacknowledged confirmed events (same sequence number, like LoRaWAN)
for (const p of b.pending) {
    if (r.t >= p.nextAt) {
        if (p.tries >= cfg.retry.maxEventTries) {
            p.gaveUp = true; b.stats.gaveUp++;
            diag.push({ boat: b.id, t: r.t, text: `Gave up on ${p.eid} after ${p.tries} transmissions` });
        } else {
            p.tries++; p.pkt.rt = p.tries;
            sendPkt(p.pkt, true);
            p.nextAt = r.t + backoff(p.tries);
        }
    }
}
b.pending = b.pending.filter(p => !p.gaveUp);

// ---- harbour Wi-Fi: batch sync of the onboard log (one batch in flight)
if (r.inHarbour) {
    if (b.inflight && r.t - b.inflight.sentAt > cfg.sync.timeoutS) {
        b.stats.syncTimeouts++;
        diag.push({ boat: b.id, t: r.t, text: `Wi-Fi sync batch #${b.inflight.id} timed out; resending from record ${b.acked + 1}` });
        b.inflight = null;
    }
    if (!b.inflight && b.log.length) {
        const batch = b.log.slice(0, cfg.sync.batch);
        b.inflight = { id: ++b.batchN, sentAt: r.t, from: batch[0].s, to: batch[batch.length - 1].s };
        b.stats.syncBatches++;
        sync.push({
            topic: 'sync', boat: b.id, ep, _syncBatch: b.inflight.id, url: cfg.baseUrl + '/seaguard/sync',
            headers: { 'content-type': 'application/json' }, requestTimeout: 5000,
            payload: { boat: b.id, ep, batch: b.inflight.id, records: batch }
        });
    }
}

publishSummary(b);
return [up.length ? up : null, sync.length ? sync : null, diag.length ? diag.map(x => ({ topic: 'diag', payload: x })) : null];
