// Harbour Wi-Fi link model. Sits on both sides of the sync HTTP call: it can drop the request
// (boat out of coverage / AP down) and drop the response (batch stored ashore but the boat
// never hears the acknowledgement, so it resends the same records).
// Outputs: 1 = to HTTP request, 2 = back to boat firmware
const lib = global.get('lib');
const t = global.get('simTime') || 0;
let S = context.get('S');
if (!S) { S = { r: lib.rng(4242) }; context.set('S', S); }
const flap = lib.findFault(global.get('faults') || [], t, msg.boat, 'WIFI_FLAP');
function log(text) {
    const L = global.get('linkLog') || [];
    L.push({ t, dir: 'wifi', boat: msg.boat, kind: 'WIFI', text });
    if (L.length > 250) L.splice(0, L.length - 250);
    global.set('linkLog', L);
}
if (msg.statusCode === undefined) {
    if (flap && S.r() < flap.params.reqLoss) { log('Wi-Fi dropout: sync batch never left the boat'); return null; }
    return [msg, null];
}
if (flap && S.r() < flap.params.respLoss) { log('Wi-Fi dropout: shore stored the batch but the acknowledgement was lost'); return null; }
msg.topic = 'syncResp';
return [null, msg];
