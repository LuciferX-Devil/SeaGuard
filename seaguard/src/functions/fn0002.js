// SeaGuard configuration and shared helper library.
// Edit the values in `cfg` to change behaviour. Everything else reads from here.
// NOTE: coordinates of the boundary, reserve and harbour are ILLUSTRATIVE ONLY,
// chosen to make a realistic simulation. They are not navigational data.

const cfg = {
    version: '1.1.0',

    // Where Node-RED itself is reachable from Node-RED (used for the Wi-Fi sync
    // endpoint and the local Telegram / Open-Meteo mocks). Change the port if you
    // run Node-RED on something other than 1880.
    baseUrl: env.get('SEAGUARD_BASE_URL') || 'http://127.0.0.1:1880',

    // Telegram bot (optional). Leave token empty to keep everything on the local mock.
    // Test runs ALWAYS use the mock, so a real bot only receives live-mode alerts.
    telegram: {
        enabled: false,
        token: '',
        familyChatId: '',
        coastGuardChatId: ''
    },

    harbour: { name: 'Home harbour', lat: 9.2876, lon: 79.3129, wifiRadiusM: 400 },
    boundary: {
        name: 'Maritime boundary (illustrative)',
        points: [[9.72, 79.47], [9.40, 79.50], [9.10, 79.53]],
        warnM: 1000,      // warn when closer than this on the home side
        warnExitM: 1300,  // hysteresis: only clear the warning beyond this
        returnM: 150      // hysteresis: a violation clears only this far back on the home side
    },
    reserve: {
        name: 'Coral reserve, no fishing (illustrative)',
        poly: [[9.37, 79.36], [9.37, 79.41], [9.34, 79.41], [9.34, 79.36]]
    },
    zones: [
        { id: 'Z1', name: 'Near-shore', lat: 9.35, lon: 79.35 },
        { id: 'Z2', name: 'Mid Palk Bay', lat: 9.50, lon: 79.40 },
        { id: 'Z3', name: 'Boundary waters', lat: 9.45, lon: 79.50 }
    ],
    fleet: [
        { id: 'B1', name: 'Sagar Rani', crew: ['Murugan', 'Selvam', 'Arul'] },
        { id: 'B2', name: 'Meenakshi', crew: ['Karthik', 'Anthony'] },
        { id: 'B3', name: 'Kadal Pura', crew: ['Ravi', 'Joseph', 'Manoj'] },
        { id: 'B4', name: 'Velankanni', crew: ['Sebastian', 'Kumar'] },
        { id: 'B5', name: 'Neela Megam', crew: ['Prakash', 'Irudayaraj', 'Siva'] }
    ],

    lora: {
        telemetryEveryS: 5,   // periodic uplink interval (duty-cycle friendly)
        baseLoss: 0.05,       // background packet loss
        lossPer10km: 0.02,    // extra loss per 10 km from the shore gateway
        dupProb: 0.02,        // background duplicate delivery
        delayProb: 0.25       // chance a packet arrives one tick late
    },
    detect: {
        capsizeRollDeg: 65, capsizeHoldS: 4,
        floodPct: 60, floodHoldS: 3,
        tagLostDbm: -95, mobMissingS: 8,
        commsLostS: 45,
        correlationWindowS: 90,
        cooldownS: 120,
        escalateAfterS: 60,
        updateMinGapS: 20,
        restoreGraceS: 15,
        gatewayHbTimeoutS: 15
    },
    storm: { waveM: 2.5, windKmh: 45, clearWaveM: 2.0, clearWindKmh: 35 },
    weather: {
        offline: env.get('SEAGUARD_LIVE_WEATHER') !== 'true',
        liveEverySec: 600,
        testEverySimS: 30,
        marineUrl: 'https://marine-api.open-meteo.com/v1/marine',
        forecastUrl: 'https://api.open-meteo.com/v1/forecast'
    },
    retry: { eventBackoff: [3, 3, 4, 5, 6], maxEventTries: 40, notifyBackoff: [2, 4, 8, 16], maxNotifyTries: 15 },
    sync: { batch: 50, timeoutS: 5 },
    speeds: { live: 5, test: 10 },
    test: { durationS: 360, drainS: 20 }
};

// ---------------------------------------------------------------- helpers
const DEG = Math.PI / 180, R = 6371000;
const ref = { lat: cfg.harbour.lat, lon: cfg.harbour.lon };
const cosRef = Math.cos(ref.lat * DEG);

function toXY(lat, lon) { return { x: (lon - ref.lon) * DEG * R * cosRef, y: (lat - ref.lat) * DEG * R }; }
function toLL(x, y) { return { lat: ref.lat + y / R / DEG, lon: ref.lon + x / (R * cosRef) / DEG }; }

const bXY = cfg.boundary.points.map(p => toXY(p[0], p[1]));
const home = { x: 0, y: 0 };

function segInfo(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    let u = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
    u = Math.max(0, Math.min(1, u));
    const fx = a.x + u * dx, fy = a.y + u * dy;
    return {
        d: Math.hypot(p.x - fx, p.y - fy), fx, fy,
        cross: dx * (p.y - a.y) - dy * (p.x - a.x),
        homeCross: dx * (home.y - a.y) - dy * (home.x - a.x)
    };
}
// Signed distance (m) to the boundary polyline: positive = home side, negative = crossed.
function boundaryDist(p) {
    let best = null;
    for (let i = 0; i < bXY.length - 1; i++) {
        const s = segInfo(p, bXY[i], bXY[i + 1]);
        if (!best || s.d < best.d) best = s;
    }
    return Math.sign(best.cross) === Math.sign(best.homeCross) ? best.d : -best.d;
}
// A point at signed distance d from the boundary, at northing y. Also returns the unit
// normal (nx, ny) pointing towards the home side.
function boundaryPoint(y, d) {
    for (let i = 0; i < bXY.length - 1; i++) {
        const a = bXY[i], b = bXY[i + 1];
        const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
        if (y >= lo && y <= hi) {
            const u = (y - a.y) / (b.y - a.y);
            const fx = a.x + u * (b.x - a.x), fy = y;
            let nx = -(b.y - a.y), ny = (b.x - a.x);
            const L = Math.hypot(nx, ny); nx /= L; ny /= L;
            if (nx * (home.x - fx) + ny * (home.y - fy) < 0) { nx = -nx; ny = -ny; }
            return { x: fx + nx * d, y: fy + ny * d, nx, ny };
        }
    }
    return null;
}
const reserveXY = cfg.reserve.poly.map(p => toXY(p[0], p[1]));
function inPoly(p, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if (((a.y > p.y) !== (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) c = !c;
    }
    return c;
}
function inReserve(p) { return inPoly(p, reserveXY); }
// Distance from a point outside the polygon to its nearest edge (0 if inside).
function reserveDist(p) {
    if (inReserve(p)) return 0;
    let best = Infinity;
    for (let i = 0; i < reserveXY.length; i++) {
        const s = segInfo(p, reserveXY[i], reserveXY[(i + 1) % reserveXY.length]);
        best = Math.min(best, s.d);
    }
    return best;
}
const zonesXY = cfg.zones.map(z => Object.assign({}, z, toXY(z.lat, z.lon)));
function zoneOfXY(p) {
    let best = null, bd = Infinity;
    for (const z of zonesXY) { const d = Math.hypot(p.x - z.x, p.y - z.y); if (d < bd) { bd = d; best = z.id; } }
    return best;
}
function zoneOf(lat, lon) { return zoneOfXY(toXY(lat, lon)); }
function zoneName(id) { const z = cfg.zones.find(z => z.id === id); return z ? z.name : id; }

// Seeded PRNG (mulberry32) so a test campaign can be replayed from its seed.
function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
function gauss(r) {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function activeFaults(faults, t, boat) {
    return (faults || []).filter(f => (boat === undefined || f.boat === boat) && t >= f.start && t < f.end);
}
function findFault(faults, t, boat, type) {
    return (faults || []).find(f => f.type === type && (boat == null || f.boat === boat) && t >= f.start && t < f.end) || null;
}
// "Ground truth" sea state used by the Open-Meteo mock and by the boat physics in test runs.
function mockSea(zoneId, t, faults) {
    const zi = cfg.zones.findIndex(z => z.id === zoneId);
    let wave = 0.55 + 0.08 * Math.sin(t / 97 + zi), wind = 17 + 3 * Math.sin(t / 131 + zi * 2);
    let gust = wind * 1.3;
    const s = (faults || []).find(f => f.type === 'STORM' && f.params.zone === zoneId && t >= f.start && t < f.end);
    if (s) { wave = s.params.wave; wind = s.params.wind; gust = s.params.wind * 1.35; }
    return { wave: +wave.toFixed(2), wind: +wind.toFixed(1), gust: +gust.toFixed(1) };
}
function boatName(id) { const b = cfg.fleet.find(b => b.id === id); return b ? b.name : id; }
function fmtLL(lat, lon) { return lat.toFixed(4) + ' N, ' + lon.toFixed(4) + ' E'; }

const lib = {
    toXY, toLL, boundaryDist, boundaryPoint, inReserve, reserveDist, reserveXY, zoneOf, zoneOfXY, zoneName,
    rng, gauss, activeFaults, findFault, mockSea, boatName, fmtLL, bXY
};

global.set('cfg', cfg);
global.set('lib', lib);
if (global.get('epoch') === undefined) global.set('epoch', 0);
node.status({ fill: 'green', shape: 'dot', text: 'SeaGuard ' + cfg.version + ' configured' });
// Start the system in live mode once configured.
return { topic: 'cmd', payload: { cmd: 'live' } };
