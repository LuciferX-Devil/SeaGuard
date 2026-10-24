// Harbour Wi-Fi sync endpoint (POST /seaguard/sync). Stores onboard log records by their
// sequence number, so a resent batch is absorbed instead of duplicated, and answers with the
// highest contiguous record it holds so the boat knows what it can delete.
const ep = global.get('epoch');
const t = global.get('simTime') || 0;
const p = msg.payload || {};
if (p.ep !== ep) { msg.statusCode = 409; msg.payload = { error: 'stale epoch' }; return msg; }
function reject(status, error) { msg.statusCode = status; msg.payload = { error }; return msg; }
const cfg = global.get('cfg');
if (!cfg.fleet.some(b => b.id === p.boat)) return reject(400, 'Unknown boat');
if (!Array.isArray(p.records) || p.records.length < 1 || p.records.length > cfg.sync.batch) return reject(400, 'Invalid or oversized records batch');
for (const r of p.records) {
    if (!r || !Number.isSafeInteger(r.s) || r.s < 1 || !Number.isFinite(r.t) || !Number.isFinite(r.lat) || Math.abs(r.lat) > 90 || !Number.isFinite(r.lon) || Math.abs(r.lon) > 180) return reject(400, 'Invalid log record');
}
const store = global.get('syncStore') || {};
const existing = store[p.boat];
const incoming = new Map();
for (const r of p.records) {
    const previous = incoming.get(r.s) || (existing && existing.recs[r.s]);
    if (previous && (previous.t !== r.t || previous.lat !== r.lat || previous.lon !== r.lon)) return reject(409, 'Conflicting record for an existing sequence');
    incoming.set(r.s, r);
}
const st = store[p.boat] || (store[p.boat] = { count: 0, maxContig: 0, dupRecords: 0, batches: 0, firstT: t, lastT: t, recs: {} });
for (const r of (p.records || [])) {
    if (st.recs[r.s]) st.dupRecords++;
    else { st.recs[r.s] = { t: r.t, lat: r.lat, lon: r.lon }; st.count++; }
}
while (st.recs[st.maxContig + 1]) st.maxContig++;
st.batches++; st.lastT = t;
global.set('syncStore', store);
msg.statusCode = 200;
msg.payload = { boat: p.boat, ep, ackedThrough: st.maxContig, stored: st.count };
return msg;
