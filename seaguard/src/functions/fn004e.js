// Dashboard publisher. Reads the shared state once a second and builds one view model per
// dashboard page, so the UI is decoupled from the simulation tick rate.
// Outputs: 1 fleet, 2 link, 3 incidents, 4 weather, 5 alerts, 6 test lab, 7 map
const cfg = global.get('cfg'), lib = global.get('lib');
if (!cfg) return null;
const t = global.get('simTime') || 0;
const ep = global.get('epoch') || 0;
const mode = global.get('mode') || 'live';
const layout = global.get('layout') || { boats: [] };
const fleetG = global.get('fleet') || {}, truth = global.get('truth') || {}, fw = global.get('fw') || {};
const shore = global.get('linkShore') || {}, chan = global.get('chan') || {}, geo = global.get('geo') || {};
const incidents = global.get('incidents') || [], weather = global.get('weather') || {}, corr = global.get('corr') || {};
const notes = global.get('notifications') || [], T = global.get('test') || { state: 'IDLE', history: [] };
const gw = global.get('gateway') || {}, gwS = global.get('gatewayShore') || {}, store = global.get('syncStore') || {};
const linkLog = global.get('linkLog') || [], linkHist = global.get('linkHist') || {}, eventLog = global.get('eventLog') || [];
const sup = global.get('suppressions') || [], mock = global.get('mockTelegram') || [];

const pct = v => v == null ? null : Math.max(0, Math.min(100, Math.round((v - 11.2) / 1.6 * 100)));
const head = { running: global.get('simRunning') || false, speed: global.get('simSpeed') || 1, t, mode, seed: T.seed ?? null,
    testState: T.state, epoch: ep };

const boats = (layout.boats || []).map(b => {
    const s = fleetG[b.id] || {}, tr = truth[b.id] || {}, L = shore[b.id] || {}, F = fw[b.id] || {}, g = geo[b.id] || {};
    const inc = incidents.find(i => i.kind === 'boat' && i.boat === b.id && i.status !== 'RESOLVED');
    let level = 'ok', text = 'Fishing';
    if (tr.mode === 'docked') { level = 'ok'; text = 'In harbour'; }
    else if (tr.mode === 'transit') text = 'Under way';
    else if (tr.mode === 'return') text = 'Heading home';
    if (g.state === 'WARNING') { level = 'warn'; text = 'Near boundary'; }
    if (g.state === 'VIOLATION') { level = 'high'; text = 'Across the boundary'; }
    if (g.inReserve) { level = 'warn'; text = 'Inside reserve'; }
    if (L.silent) { level = 'warn'; text = 'No contact'; }
    if (inc) {
        text = inc.title;
        level = inc.severity >= 4 ? 'critical' : inc.severity === 3 ? 'high' : inc.severity === 2 ? 'warn' : level;
    }
    return {
        id: b.id, name: b.name, role: b.role, level, text,
        incident: inc ? { id: inc.id, title: inc.title, severity: inc.severity, severityName: inc.severityName, rules: inc.rules, status: inc.status, escalation: inc.escalation } : null,
        shore: { lat: s.lat, lon: s.lon, spd: s.spd, hdg: s.hdg, roll: s.roll, level: s.level, bat: pct(s.bat), crew: s.crew, crewTotal: s.crewTotal,
            age: s.rxT == null ? null : t - s.rxT, posAge: s.posT == null ? null : t - s.posT, rssi: L.rssi, snr: L.snr, silent: !!L.silent },
        truth: { lat: tr.lat, lon: tr.lon, spd: tr.spd == null ? null : +tr.spd.toFixed(1), roll: tr.roll, level: tr.level, mode: tr.mode,
            crewAboard: tr.crewAboard, crewTotal: tr.crewTotal, capsized: tr.capsized, flooding: tr.flooding, inHarbour: tr.inHarbour,
            zone: tr.zone, zoneName: tr.zone ? lib.zoneName(tr.zone) : null, boundaryDist: tr.boundaryDist, wave: tr.wave },
        geo: { d: g.d, state: g.state || 'SAFE', inReserve: !!g.inReserve },
        radio: { pending: (F.pending || []).length, retries: F.retries || 0, acked: F.acked || 0, avgAckS: F.avgAckS,
            lost: L.lost || 0, recv: L.recv || 0, dup: L.dup || 0, ooo: L.ooo || 0 },
        adv: F.adv || null,
        filtered: F.filtered || { roll: 0, splash: 0, tag: 0 }
    };
});

const openInc = incidents.filter(i => i.status !== 'RESOLVED');
const kpi = {
    atSea: boats.filter(b => b.truth.mode && b.truth.mode !== 'docked').length,
    open: openInc.length,
    critical: openInc.filter(i => i.severity >= 4).length,
    gateway: gwS.online === false ? 'offline' : 'online',
    buffered: gw.buffered || 0,
    weather: weather.status || 'UNKNOWN',
    storms: Object.keys((corr.storm) || {}).length,
    alerts: notes.filter(n => n.status !== 'DELIVERED').length
};

const fleetMsg = { topic: 'fleet', payload: { head, kpi, boats, harbour: cfg.harbour.name, zones: cfg.zones } };

const linkMsg = {
    topic: 'link', payload: {
        head,
        gateway: { online: gwS.online !== false, reason: gwS.reason, buffered: gw.buffered || 0, stats: gw.stats || {}, hbAge: gwS.lastHb == null ? null : t - gwS.lastHb },
        rows: boats.map(b => {
            const L = shore[b.id] || {}, F = fw[b.id] || {}, cu = chan['up:' + b.id] || {}, cd = chan['down:' + b.id] || {};
            return { id: b.id, name: b.name, recv: L.recv || 0, lost: L.lost || 0, recovered: L.recovered || 0, dup: L.dup || 0,
                ooo: L.ooo || 0, stale: L.staleRejected || 0, highest: L.highest || 0, rssi: L.rssi, snr: L.snr,
                silent: !!L.silent, age: L.lastSeen == null ? null : t - L.lastSeen,
                pending: (F.pending || []).length, retries: F.retries || 0, acked: F.acked || 0, avgAckS: F.avgAckS, gaveUp: F.gaveUp || 0,
                chanDropUp: cu.dropped || 0, chanDupUp: cu.dup || 0, chanHeldUp: cu.held || 0, chanDropDown: cd.dropped || 0,
                hist: (linkHist[b.id] || []).map(h => ({ t: h.t0, n: h.n, lost: h.lost })) };
        }),
        sync: boats.map(b => {
            const F = fw[b.id] || {}, st = store[b.id] || {};
            return { id: b.id, name: b.name, onboard: F.logBuffered || 0, logged: F.logSeq || 0, ashore: st.maxContig || 0,
                batches: st.batches || 0, timeouts: F.syncTimeouts || 0, dupRecords: st.dupRecords || 0, inHarbour: !!(truth[b.id] || {}).inHarbour };
        }),
        log: linkLog.slice(-70).reverse()
    }
};

const incMsg = {
    topic: 'incidents', payload: {
        head,
        incidents: incidents.slice().reverse().map(i => ({
            id: i.id, kind: i.kind, boat: i.boat, boatName: i.kind === 'boat' ? lib.boatName(i.boat) : 'Fleet', title: i.title,
            severity: i.severity, severityName: i.severityName, rules: i.rules, status: i.status, opened: i.opened, lastEventT: i.lastEventT,
            escalation: i.escalation, ackedAt: i.ackedAt, ackedBy: i.ackedBy, resolvedAt: i.resolvedAt, resolution: i.resolution,
            folded: i.folded, reopened: i.reopened,
            events: i.events.map(e => ({ t: e.t, type: e.type, source: e.source, data: e.data })),
            notifications: i.notifications
        })).slice(0, 25),
        rules: corr.ruleCount || {},
        storm: corr.storm || {},
        suppressions: sup.slice(-25).reverse(),
        events: eventLog.slice(-60).reverse()
    }
};

const wxMsg = {
    topic: 'weather', payload: {
        head,
        status: weather.status || 'UNKNOWN', source: weather.source || '-', failures: weather.failures || 0,
        lastError: weather.lastError || null, lastOk: weather.lastOk,
        zones: cfg.zones.map(z => Object.assign({ id: z.id, name: z.name }, (weather.zones || {})[z.id] || {})),
        history: (weather.history || []).slice(-14).reverse(),
        boatsPerZone: boats.reduce((a, b) => { if (b.truth.zone) a[b.truth.zone] = (a[b.truth.zone] || 0) + 1; return a; }, {}),
        thresholds: cfg.storm
    }
};

const alertMsg = {
    topic: 'alerts', payload: {
        head,
        live: mode === 'live' && cfg.telegram.enabled && !!cfg.telegram.token,
        configured: cfg.telegram.enabled && !!cfg.telegram.token,
        rows: notes.slice().reverse().slice(0, 40),
        counts: { total: notes.length, delivered: notes.filter(n => n.status === 'DELIVERED').length,
            retrying: notes.filter(n => n.status === 'RETRY' || n.status === 'SENDING' || n.status === 'QUEUED').length,
            failed: notes.filter(n => n.status === 'FAILED').length },
        mock: mock.slice(-12).reverse()
    }
};

const testMsg = {
    topic: 'test', payload: {
        head,
        state: T.state, seed: T.seed ?? null, D: T.D || cfg.test.durationS, progress: T.D ? Math.min(100, Math.round(t / T.D * 100)) : 0,
        scenario: (T.layout || {}).scenario, roles: (T.layout || {}).roles,
        schedule: (T.schedule || []).map(f => ({ id: f.id, t: f.start, end: f.end < 1e8 ? f.end : null, type: f.type, boat: f.boat, text: f.text, injected: f.injected, cleared: f.cleared, decoy: !!f.decoy })),
        injLog: (T.injLog || []).slice(-90).reverse(),
        events: eventLog.slice(-40).reverse().map(e => ({ t: e.t, type: e.type, boat: e.boat, source: e.source, disposition: e.disposition, incident: e.incident, note: e.note })),
        results: T.results || null,
        history: T.history || [],
        boats: (layout.boats || []).map(b => ({ id: b.id, name: b.name, role: b.role })),
        faultTypes: ['CAPSIZE', 'FLOODING', 'MOB', 'SOS_BUTTON', 'WAVE_SPIKE', 'SPLASH', 'TAG_FLICKER', 'RADIO_BLACKOUT',
            'LINK_DEGRADE', 'DUP_BURST', 'REORDER_BURST', 'BOUNDARY_DRIFT', 'GPS_JITTER', 'WIFI_FLAP', 'STORM',
            'WEATHER_API_FAIL', 'GATEWAY_OUTAGE', 'TELEGRAM_OUTAGE']
    }
};

// ---------------------------------------------------------------- map
const mapOut = [];
let M = context.get('M');
if (!M || M.ep !== ep || msg.topic === 'mapconnect') {
    M = { ep };
    context.set('M', M);
    mapOut.push({ payload: { command: { clearlayer: ['Fleet', 'Sea marks'], lat: cfg.harbour.lat + 0.12, lon: cfg.harbour.lon + 0.1, zoom: 10 } } });
    mapOut.push({ payload: { name: cfg.boundary.name, line: cfg.boundary.points, color: '#b0277a', weight: 3, dashArray: '8,6', layer: 'Sea marks' } });
    mapOut.push({ payload: { name: cfg.reserve.name, area: cfg.reserve.poly, color: '#b0277a', fillColor: '#b0277a', fillOpacity: 0.12, weight: 1, layer: 'Sea marks' } });
    mapOut.push({ payload: { name: 'Harbour Wi-Fi', lat: cfg.harbour.lat, lon: cfg.harbour.lon, radius: cfg.harbour.wifiRadiusM, color: '#2f7d5b', fillOpacity: 0.08, layer: 'Sea marks' } });
}
const colors = { critical: '#c0392b', high: '#d4741b', warn: '#c9a227', ok: '#2f7d5b' };
for (const b of boats) {
    if (b.shore.lat == null) continue;
    mapOut.push({
        payload: {
            name: b.id + ' ' + b.name, lat: b.shore.lat, lon: b.shore.lon, icon: 'ship', iconColor: colors[b.level] || '#2f7d5b',
            hdg: b.shore.hdg, layer: 'Fleet', ttl: 600,
            popup: '<b>' + b.id + ' ' + b.name + '</b><br/>' + b.text + '<br/>crew ' + (b.shore.crew == null ? '?' : b.shore.crew) + '/' + (b.shore.crewTotal || '?') +
                '<br/>heard ' + (b.shore.age == null ? '-' : b.shore.age + ' s ago') + (b.shore.rssi ? ' at ' + b.shore.rssi + ' dBm' : '')
        }
    });
}

return [fleetMsg, linkMsg, incMsg, wxMsg, alertMsg, testMsg, mapOut];
