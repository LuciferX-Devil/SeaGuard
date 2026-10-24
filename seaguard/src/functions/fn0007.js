// Boat physics + sensor model (the "real world" the IoT nodes measure).
// Produces one raw sensor reading per boat per simulated second.
// Faults injected by the test harness change the physical truth here
// (a capsize really rolls the boat over, a man overboard really removes the tag).
if (msg.topic !== 'tick') return null;
const cfg = global.get('cfg'), lib = global.get('lib');
const t = msg.t, ep = global.get('epoch');
const layout = global.get('layout');
if (!layout) return null;

let S = context.get('S');
if (!S || S.ep !== ep) {
    const r = lib.rng(((global.get('runSeed') || 12345) + 101) >>> 0);
    const boats = {};
    for (const b of layout.boats) {
        boats[b.id] = Object.assign({}, b, {
            center: b.center ? Object.assign({}, b.center) : { x: b.x, y: b.y },
            target: b.target ? Object.assign({}, b.target) : null,
            hdg: b.hdg || 0, spd: b.spd || 0,
            rollPhase: r() * 6, bat: 12.75 - r() * 0.25,
            capsized: false, capRoll: 0, flooding: false, floodLevel: 0,
            tags: b.tags.map(tg => Object.assign({}, tg, { overboard: false }))
        });
    }
    S = { ep, r, boats };
    context.set('S', S);
}
const r = S.r;
const faults = global.get('faults') || [];
const mode = global.get('mode');
const seaState = global.get('seaState') || {};
const dock = { x: 0, y: 40 };
const out = [];
const truth = {};

function steerTo(B, p, spd) {
    B.hdg = Math.atan2(p.x - B.x, p.y - B.y);
    B.spd = spd;
    return Math.hypot(p.x - B.x, p.y - B.y);
}
function sampleFishingSpot() {
    for (let i = 0; i < 200; i++) {
        const p = { x: 3000 + r() * 11500, y: 4000 + r() * 24000 };
        if (lib.boundaryDist(p) > 4000 && lib.reserveDist(p) > 800) return p;
    }
    return { x: 8000, y: 15000 };
}

for (const id of Object.keys(S.boats)) {
    const B = S.boats[id];
    const has = type => lib.findFault(faults, t, id, type);

    // ---- navigation
    const drift = has('BOUNDARY_DRIFT'), incursion = has('RESERVE_INCURSION');
    if (B.capsized) { B.spd = 0.3; B.hdg += lib.gauss(r) * 0.05; B.mode = 'distress'; }
    else if (drift) {
        const bp = lib.boundaryPoint(B.y, 0);
        if (bp) B.hdg = Math.atan2(-bp.nx, -bp.ny);
        B.spd = drift.params.speed; B.mode = 'transit';
    } else if (incursion) {
        steerTo(B, incursion.params.target, incursion.params.speed); B.mode = 'transit';
    } else if (B.mode === 'fish') {
        const dc = Math.hypot(B.x - B.center.x, B.y - B.center.y);
        if (dc > (B.loiterR || 250)) steerTo(B, B.center, 0.8);
        else { B.hdg += lib.gauss(r) * 0.35; B.spd = 0.3 + r() * 0.5; }
        if (mode === 'live' && B.fishUntil && t >= B.fishUntil) B.mode = 'return';
    } else if (B.mode === 'transit') {
        const d = steerTo(B, B.target, B.cruise || 6);
        if (d < 40) { B.mode = 'fish'; B.center = Object.assign({}, B.target); B.fishUntil = t + 900 + Math.floor(r() * 600); }
    } else if (B.mode === 'return') {
        const d = steerTo(B, dock, Math.min(B.cruise || 6, 5));
        if (d < 25) { B.mode = 'docked'; B.spd = 0; B.departAt = t + 300 + Math.floor(r() * 300); }
    } else if (B.mode === 'docked') {
        B.spd = 0;
        if (mode === 'live' && B.departAt && t >= B.departAt) { B.target = sampleFishingSpot(); B.mode = 'transit'; }
    }
    B.x += Math.sin(B.hdg) * B.spd;
    B.y += Math.cos(B.hdg) * B.spd;

    // ---- sea state (truth): mock sea in test runs, polled Open-Meteo values in live mode
    const zone = lib.zoneOfXY(B);
    const sea = mode === 'test' ? lib.mockSea(zone, t, faults) : (seaState[zone] || { wave: 0.6, wind: 18 });
    const wave = sea.wave || 0.6;

    // ---- IMU roll
    let roll = (4 + 7 * wave) * Math.sin(2 * Math.PI * t / 6 + B.rollPhase) + lib.gauss(r) * 1.5;
    const spike = has('WAVE_SPIKE');
    if (B.capsized) { B.capRoll = Math.min(150, B.capRoll + 40); roll = B.capRoll + lib.gauss(r) * 3; }
    else if (has('CAPSIZE')) { B.capsized = true; B.capRoll = Math.abs(roll) + 40; roll = B.capRoll; }
    else if (spike) roll = spike.params.roll * spike.params.sign + lib.gauss(r);

    // ---- bilge water level (%)
    let level = 2 + (wave > 2 ? 6 : 0) + lib.gauss(r) * 1.2;
    const splash = has('SPLASH');
    if (B.flooding) { B.floodLevel = Math.min(100, B.floodLevel + 4); level = B.floodLevel + lib.gauss(r); }
    else if (has('FLOODING')) { B.flooding = true; B.floodLevel = 22; level = 22; }
    else if (splash) level = splash.params.level;
    level = Math.max(0, Math.min(100, level));

    // ---- BLE crew tags (RSSI seen by the boat hub)
    const mob = has('MOB'), flicker = has('TAG_FLICKER');
    const ble = B.tags.map(tg => {
        let rssi;
        if (mob && mob.params.tag === tg.id && !tg.overboard) { tg.overboard = true; rssi = -93; }
        else if (tg.overboard) rssi = null;
        else if (flicker && flicker.params.tag === tg.id) rssi = null;
        else rssi = Math.round(tg.base + lib.gauss(r) * 3);
        return { tag: tg.id, name: tg.name, rssi };
    });

    // ---- GPS fix with noise
    const jitter = has('GPS_JITTER');
    const sigma = jitter ? jitter.params.sigma : 4;
    const g = lib.toLL(B.x + lib.gauss(r) * sigma, B.y + lib.gauss(r) * sigma);

    // ---- battery, SOS button, harbour Wi-Fi coverage
    B.bat = Math.max(11.2, B.bat - 0.00004 * (B.spd > 1 ? 3 : 1));
    const sosF = has('SOS_BUTTON');
    const sos = !!(sosF && B.lastSos !== sosF.id);
    if (sos) B.lastSos = sosF.id;
    const inHarbour = Math.hypot(B.x - dock.x, B.y - dock.y) < cfg.harbour.wifiRadiusM;

    const reading = {
        boat: id, t, ep,
        gps: { lat: g.lat, lon: g.lon, spd: +B.spd.toFixed(2), hdg: Math.round(((B.hdg / Math.PI * 180) + 360) % 360), hdop: jitter ? 6.5 : 0.9 },
        imu: { roll: +roll.toFixed(1) },
        water: { level: +level.toFixed(1) },
        bat: { v: +B.bat.toFixed(2) },
        ble, sos, inHarbour
    };
    out.push({ topic: 'reading', payload: reading });

    const ll = lib.toLL(B.x, B.y);
    truth[id] = {
        lat: ll.lat, lon: ll.lon, x: B.x, y: B.y, spd: B.spd, mode: B.mode, roll: reading.imu.roll, level: reading.water.level,
        capsized: B.capsized, flooding: B.flooding, inHarbour, zone,
        crewAboard: B.tags.filter(tg => !tg.overboard).length, crewTotal: B.tags.length,
        boundaryDist: Math.round(lib.boundaryDist(B)), wave
    };
}
global.set('truth', truth);
return [out];
