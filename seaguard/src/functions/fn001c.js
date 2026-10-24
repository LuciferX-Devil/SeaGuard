// Geofence (shore side) on every applied GPS position.
// Boundary: SAFE -> WARNING when closer than warnM on 2 consecutive fixes,
//           -> VIOLATION when across the line on 2 consecutive fixes.
// Hysteresis stops GPS jitter from flapping: a warning only clears beyond warnExitM,
// a violation only clears returnM back on the home side.
// Reserve (no-fishing zone): inside on 2 consecutive fixes -> RESTRICTED_ZONE.
const cfg = global.get('cfg'), lib = global.get('lib');
const ep = global.get('epoch');
const t = global.get('simTime') || 0;
let S = context.get('S');
if (!S || S.ep !== ep) { S = { ep, B: {} }; context.set('S', S); }
const p = msg.payload;
const B = S.B[p.boat] || (S.B[p.boat] = { state: 'SAFE', cWarn: 0, cViol: 0, cExit: 0, inRes: false, cIn: 0, cOut: 0 });
const xy = lib.toXY(p.lat, p.lon);
const d = lib.boundaryDist(xy);
const inside = lib.inReserve(xy);
const K = cfg.boundary;
const out = [];
function ev(type, data) { out.push({ topic: 'event', payload: { type, boat: p.boat, t, source: 'shore', data: Object.assign({ distM: Math.round(d), lat: p.lat, lon: p.lon }, data || {}) } }); }

if (B.state === 'SAFE') {
    B.cViol = d < 0 ? B.cViol + 1 : 0;
    B.cWarn = d < K.warnM ? B.cWarn + 1 : 0;
    if (B.cViol >= 2) { B.state = 'VIOLATION'; B.cViol = 0; B.cExit = 0; ev('BOUNDARY_VIOLATION'); }
    else if (B.cWarn >= 2) { B.state = 'WARNING'; B.cWarn = 0; B.cExit = 0; ev('BOUNDARY_WARNING'); }
} else if (B.state === 'WARNING') {
    B.cViol = d < 0 ? B.cViol + 1 : 0;
    B.cExit = d > K.warnExitM ? B.cExit + 1 : 0;
    if (B.cViol >= 2) { B.state = 'VIOLATION'; B.cViol = 0; B.cExit = 0; ev('BOUNDARY_VIOLATION'); }
    else if (B.cExit >= 2) { B.state = 'SAFE'; B.cExit = 0; ev('BOUNDARY_CLEAR'); }
} else if (B.state === 'VIOLATION') {
    B.cExit = d > K.returnM ? B.cExit + 1 : 0;
    if (B.cExit >= 2) { B.state = 'WARNING'; B.cExit = 0; ev('BOUNDARY_RETURNED'); }
}

if (!B.inRes) {
    B.cIn = inside ? B.cIn + 1 : 0;
    if (B.cIn >= 2) { B.inRes = true; B.cIn = 0; ev('RESTRICTED_ZONE', { zone: cfg.reserve.name }); }
} else {
    B.cOut = inside ? 0 : B.cOut + 1;
    if (B.cOut >= 3) { B.inRes = false; B.cOut = 0; ev('RESTRICTED_EXIT', { zone: cfg.reserve.name }); }
}

const G = global.get('geo') || {};
G[p.boat] = { d: Math.round(d), state: B.state, inReserve: B.inRes };
global.set('geo', G);
return [out];
