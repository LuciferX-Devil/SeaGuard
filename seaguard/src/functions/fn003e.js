// Test controller. Builds a randomized campaign from a seed, lays the fleet out, and feeds
// faults into the running simulation at their scheduled simulated times. Everything it injects
// is written to the injection log so the dashboard can show exactly what the stack was fed.
// Outputs: 1 = clock control, 2 = correlation commands (operator acknowledgements), 3 = evaluate request
const cfg = global.get('cfg'), lib = global.get('lib');
const out1 = [], out2 = [], out3 = [];

function mkTags(b, r) { return b.crew.map((c, i) => ({ id: 'T' + (i + 1), name: c, base: -56 - Math.floor(r() * 6) })); }

function liveLayout() {
    const r = lib.rng((Date.now() & 0xffffffff) >>> 0);
    const boats = cfg.fleet.map((b, i) => {
        const tags = mkTags(b, r);
        if (i === 0) {
            const p = { x: 1500 + r() * 500, y: 2500 + r() * 800 };
            return { id: b.id, name: b.name, role: 'live', x: p.x, y: p.y, hdg: Math.PI, spd: 5, mode: 'return', cruise: 6,
                tags, preLog: 1200, startLL: lib.toLL(p.x, p.y) };
        }
        return { id: b.id, name: b.name, role: 'live', x: (r() - 0.5) * 60, y: 40 + (r() - 0.5) * 60, hdg: 0, spd: 0,
            mode: 'docked', departAt: 20 + i * 45, cruise: 5.5 + r(), tags, preLog: 0, startLL: { lat: cfg.harbour.lat, lon: cfg.harbour.lon } };
    });
    return { mode: 'live', boats };
}

function generate(seed) {
    const r = lib.rng(seed);
    const D = cfg.test.durationS;
    const pick = a => a[Math.floor(r() * a.length)];
    const between = (a, b) => a + r() * (b - a);
    const ib = (a, b) => Math.floor(between(a, b + 1));
    const ids = cfg.fleet.map(b => b.id);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp; }
    const open = ids.slice(0, 3), border = ids[3], harbour = ids[4];
    const boats = [], schedule = [];
    let fid = 0;
    const add = f => { f.id = 'F' + (++fid); schedule.push(f); return f; };
    const cfgOf = id => cfg.fleet.find(b => b.id === id);
    const placed = [];
    function sampleSpot() {
        for (let i = 0; i < 300; i++) {
            const p = { x: 3000 + r() * 11000, y: 4000 + r() * 23000 };
            if (lib.boundaryDist(p) < 4500 || lib.reserveDist(p) < 900) continue;
            if (placed.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 1800)) continue;
            placed.push(p); return p;
        }
        const p = { x: 6000 + r() * 2000, y: 12000 + r() * 6000 }; placed.push(p); return p;
    }
    function boatEntry(id, role, p, extra) {
        const b = cfgOf(id);
        return Object.assign({ id, name: b.name, role, x: p.x, y: p.y, hdg: r() * 6.28, spd: 0.4, mode: 'fish',
            center: { x: p.x, y: p.y }, loiterR: 200, cruise: 6, tags: mkTags(b, r), preLog: 0, startLL: lib.toLL(p.x, p.y) }, extra || {});
    }

    // ---------- open-water boats: decoys, link impairments and one real emergency
    const criticals = ['CAPSIZE', 'FLOODING', 'DISTRESS_COMBO', 'MOB', 'SOS_BUTTON', 'RESERVE_INCURSION'];
    const decoys = ['WAVE_SPIKE', 'SPLASH', 'TAG_FLICKER'];
    const links = ['LINK_DEGRADE', 'DUP_BURST', 'REORDER_BURST', 'RADIO_BLACKOUT'];
    const plans = [];
    for (const id of open) {
        const plan = { id, decoy: r() < 0.75 ? pick(decoys) : null, link: r() < 0.6 ? pick(links) : null, critical: r() < 0.85 ? pick(criticals) : null };
        if (!plan.decoy && !plan.link && !plan.critical) plan.critical = pick(criticals);
        plans.push(plan);
    }
    for (const plan of plans) {
        const id = plan.id;
        let p;
        if (plan.critical === 'RESERVE_INCURSION') {
            const rx = lib.reserveXY;
            const top = Math.max.apply(null, rx.map(q => q.y));
            const x0 = Math.min.apply(null, rx.map(q => q.x)), x1 = Math.max.apply(null, rx.map(q => q.x));
            p = { x: between(x0 + 600, x1 - 600), y: top + between(320, 460) };
            placed.push(p);
        } else p = sampleSpot();
        const entry = boatEntry(id, 'open', p, plan.critical === 'RESERVE_INCURSION' ? { loiterR: 60 } : {});
        boats.push(entry);
        const tags = entry.tags;
        let cur = ib(15, 40);
        if (plan.decoy) {
            const dur = plan.decoy === 'TAG_FLICKER' ? ib(3, 6) : ib(2, 3);
            const params = plan.decoy === 'WAVE_SPIKE' ? { roll: +between(68, 88).toFixed(1), sign: r() < 0.5 ? -1 : 1 }
                : plan.decoy === 'SPLASH' ? { level: +between(66, 92).toFixed(1) }
                    : { tag: pick(tags).id };
            if (plan.decoy === 'TAG_FLICKER') params.crew = tags.find(x => x.id === params.tag).name;
            add({ type: plan.decoy, boat: id, start: cur, end: cur + dur, dur, params, decoy: true });
            cur += dur + ib(25, 45);
        }
        if (plan.link) {
            const dur = plan.link === 'RADIO_BLACKOUT' ? ib(60, 80) : plan.link === 'LINK_DEGRADE' ? ib(40, 60) : ib(35, 50);
            const params = plan.link === 'LINK_DEGRADE' ? { loss: +between(0.3, 0.4).toFixed(2) }
                : plan.link === 'DUP_BURST' ? { p: +between(0.4, 0.6).toFixed(2) }
                    : plan.link === 'REORDER_BURST' ? { p: +between(0.4, 0.6).toFixed(2) } : {};
            const f = add({ type: plan.link, boat: id, start: cur, end: cur + dur, dur, params });
            cur = f.end + ib(25, 45);
        }
        if (plan.critical && cur <= 235) {
            const big = 1e9;
            if (plan.critical === 'DISTRESS_COMBO') {
                const gap = ib(1, 5);
                const g = 'G' + fid;
                add({ type: 'CAPSIZE', boat: id, start: cur, end: big, params: {}, group: g, combo: true });
                add({ type: 'FLOODING', boat: id, start: cur + gap, end: big, params: {}, group: g, combo: true });
            } else if (plan.critical === 'MOB') {
                const tg = pick(tags);
                add({ type: 'MOB', boat: id, start: cur, end: big, params: { tag: tg.id, crew: tg.name } });
            } else if (plan.critical === 'SOS_BUTTON') {
                add({ type: 'SOS_BUTTON', boat: id, start: cur, end: cur + 3, params: {} });
            } else if (plan.critical === 'RESERVE_INCURSION') {
                const c = lib.reserveXY.reduce((a, q) => ({ x: a.x + q.x / 4, y: a.y + q.y / 4 }), { x: 0, y: 0 });
                add({ type: 'RESERVE_INCURSION', boat: id, start: Math.min(cur, 140), end: 1e9, params: { target: c, speed: +between(3.5, 5).toFixed(1) } });
            } else {
                add({ type: plan.critical, boat: id, start: cur, end: big, params: {} });
            }
        } else plan.critical = null;
    }

    // ---------- boat working close to the boundary
    const scenario = r() < 0.45 ? 'DRIFT' : r() < 0.7 ? 'JITTER' : 'CALM';
    const by = between(10000, 22000);
    const d0 = scenario === 'DRIFT' ? between(1300, 1450) : scenario === 'JITTER' ? cfg.boundary.warnM + between(25, 45) : between(1350, 1550);
    const bp = lib.boundaryPoint(by, d0);
    boats.push(boatEntry(border, 'border', bp, { loiterR: 40 }));
    if (scenario === 'DRIFT') {
        const s = ib(15, 70);
        add({ type: 'BOUNDARY_DRIFT', boat: border, start: s, end: 1e9, params: { speed: +between(6.5, 8).toFixed(1), from: Math.round(d0) } });
    } else if (scenario === 'JITTER') {
        const s = ib(20, 120), dur = ib(60, 110);
        add({ type: 'GPS_JITTER', boat: border, start: s, end: s + dur, dur, params: { sigma: Math.round(between(35, 50)), at: Math.round(d0) }, decoy: true });
    }

    // ---------- boat coming home: Wi-Fi log sync, sometimes through a flaky hotspot
    const hp = { x: between(-120, 120), y: between(650, 780) };
    boats.push(boatEntry(harbour, 'harbour', hp, { mode: 'return', cruise: 5, spd: 5, hdg: Math.PI, preLog: ib(2400, 3400) }));
    if (r() < 0.6) {
        const s = ib(62, 100), dur = ib(20, 35);
        add({ type: 'WIFI_FLAP', boat: harbour, start: s, end: s + dur, dur, params: { reqLoss: +between(0.45, 0.7).toFixed(2), respLoss: +between(0.35, 0.6).toFixed(2) } });
    }

    // ---------- fleet-wide faults
    const used = [];
    function slot(minS, maxS, dur, gap) {
        for (let i = 0; i < 60; i++) {
            const s = Math.floor(between(minS, maxS));
            if (!used.some(u => s < u[1] + gap && u[0] - gap < s + dur)) { used.push([s, s + dur]); return s; }
        }
        return null;
    }
    let stormZone = null;
    if (r() < 0.6) {
        const wb = boats.find(b => b.role === 'open') || boats[0];
        stormZone = lib.zoneOfXY(wb);
        const dur = ib(90, 150), s = slot(20, 150, dur, 35);
        if (s !== null) add({ type: 'STORM', boat: null, start: s, end: s + dur, dur, params: { zone: stormZone, zoneName: lib.zoneName(stormZone), wave: +between(2.9, 3.8).toFixed(1), wind: +between(52, 75).toFixed(0) } });
    }
    if (r() < 0.45) {
        const dur = ib(40, 70), s = slot(30, 250, dur, 35);
        if (s !== null) add({ type: 'WEATHER_API_FAIL', boat: null, start: s, end: s + dur, dur, params: {} });
    }
    if (r() < 0.5) {
        const dur = ib(50, 70);
        // keep the gateway outage clear of the radio blackouts so the two are told apart
        const blk = schedule.filter(f => f.type === 'RADIO_BLACKOUT');
        let s = null;
        for (let i = 0; i < 60; i++) {
            const c = ib(40, Math.max(45, D - 90 - dur));
            if (!blk.some(b => c < b.end + 25 && b.start - 25 < c + dur)) { s = c; break; }
        }
        if (s !== null) add({ type: 'GATEWAY_OUTAGE', boat: null, start: s, end: s + dur, dur, params: {} });
    }
    if (r() < 0.55) {
        const dur = ib(30, 60), s = ib(30, Math.max(35, D - 90 - dur));
        add({ type: 'TELEGRAM_OUTAGE', boat: null, start: s, end: s + dur, dur, params: {} });
    }
    schedule.sort((a, b) => a.start - b.start);
    return { layout: { mode: 'test', boats, roles: { open, border, harbour }, scenario }, schedule, D };
}

function describe(f) {
    const who = f.boat ? f.boat + ' ' + lib.boatName(f.boat) : 'fleet';
    const p = f.params || {};
    switch (f.type) {
        case 'CAPSIZE': return who + ': hull rolls past 140 deg and stays over';
        case 'FLOODING': return who + ': bilge water rising 4 %/s';
        case 'MOB': return who + ': crew tag ' + p.tag + ' (' + p.crew + ') goes into the water';
        case 'SOS_BUTTON': return who + ': crew presses the SOS button';
        case 'WAVE_SPIKE': return who + ': one wave rolls the boat to ' + p.roll + ' deg for ' + f.dur + ' s (decoy, must not alarm)';
        case 'SPLASH': return who + ': bilge sensor splashed to ' + p.level + ' % for ' + f.dur + ' s (decoy, must not alarm)';
        case 'TAG_FLICKER': return who + ': tag ' + p.tag + ' (' + p.crew + ') drops out for ' + f.dur + ' s (decoy, must not alarm)';
        case 'RADIO_BLACKOUT': return who + ': radio dead for ' + f.dur + ' s';
        case 'LINK_DEGRADE': return who + ': interference, ' + Math.round(p.loss * 100) + ' % packet loss for ' + f.dur + ' s';
        case 'DUP_BURST': return who + ': repeater echoes ' + Math.round(p.p * 100) + ' % of packets for ' + f.dur + ' s';
        case 'REORDER_BURST': return who + ': ' + Math.round(p.p * 100) + ' % of packets held back 6-12 s for ' + f.dur + ' s';
        case 'BOUNDARY_DRIFT': return who + ': chases fish towards the boundary at ' + p.speed + ' m/s from ' + p.from + ' m';
        case 'GPS_JITTER': return who + ': GPS noise ' + p.sigma + ' m while sitting ' + p.at + ' m off the boundary (decoy, must not flap)';
        case 'RESERVE_INCURSION': return who + ': heads into the no-fishing reserve at ' + p.speed + ' m/s';
        case 'WIFI_FLAP': return who + ': harbour Wi-Fi drops ' + Math.round(p.reqLoss * 100) + ' % of uploads, ' + Math.round(p.respLoss * 100) + ' % of replies for ' + f.dur + ' s';
        case 'STORM': return 'fleet: storm in ' + p.zoneName + ', waves ' + p.wave + ' m, wind ' + p.wind + ' km/h for ' + f.dur + ' s';
        case 'WEATHER_API_FAIL': return 'fleet: weather API returns 503 for ' + f.dur + ' s';
        case 'GATEWAY_OUTAGE': return 'fleet: shore gateway backhaul cut for ' + f.dur + ' s';
        case 'TELEGRAM_OUTAGE': return 'fleet: messaging service returns 502 for ' + f.dur + ' s';
        default: return who + ': ' + f.type;
    }
}

function clearWorld() {
    // Deliberate run/live reset: let the persistence adapter release the
    // restored-pause hold and drop saved context caches so a fresh world can be
    // saved over them (also clears a corrupt-store block). Only called on explicit
    // operator reset - never at restored-config bootstrap.
    const rt = global.get('fleetRuntime');
    if (rt && typeof rt.newWorld === 'function') rt.newWorld(global);
    for (const k of ['faults', 'incidents', 'eventLog', 'suppressions', 'linkLog', 'linkHist', 'chan', 'mockTelegram',
        'syncStore', 'fleet', 'fw', 'truth', 'geo', 'weather', 'seaState', 'notifications', 'corr', 'linkShore', 'gateway'])
        global.set(k, undefined);
}

const c = msg.payload || {};
const T = global.get('test') || { state: 'IDLE', history: [] };

if (msg.topic === 'cmd' && c.cmd === 'live') {
    global.set('epoch', (global.get('epoch') || 0) + 1);
    clearWorld();
    global.set('mode', 'live');
    // Explicit reset freezes the clock state (also for corrupt-store recovery,
    // where the clock control is held and never ran): the emitted start command
    // below re-runs it through the clock control, which sets simRunning=true.
    global.set('simRunning', false);
    global.set('simTime', 0);
    global.set('faults', []);
    global.set('layout', liveLayout());
    T.state = 'IDLE';
    global.set('test', T);
    out1.push({ payload: { cmd: 'start', speed: cfg.speeds.live } });
    node.status({ fill: 'blue', shape: 'dot', text: 'live mode' });
    return [out1, null, null];
}

if (msg.topic === 'cmd' && c.cmd === 'run') {
    if (T.state === 'RUNNING' || T.state === 'EVALUATING') return null;
    const seed = (c.seed !== undefined && c.seed !== null && c.seed !== '' && !isNaN(+c.seed)) ? (+c.seed >>> 0) : (Math.random() * 4294967296) >>> 0;
    const g = generate(seed);
    global.set('epoch', (global.get('epoch') || 0) + 1);
    clearWorld();
    global.set('runSeed', seed);
    global.set('mode', 'test');
    // Same explicit freeze as the live reset: the start command re-runs the clock.
    global.set('simRunning', false);
    global.set('simTime', 0);
    global.set('faults', []);
    global.set('layout', g.layout);
    const speed = Math.max(1, Math.min(30, +c.speed || cfg.speeds.test));
    Object.assign(T, {
        state: 'RUNNING', seed, epoch: global.get('epoch'), measurementEnd: g.D, D: g.D + cfg.test.drainS, speed, startedWall: Date.now(),
        schedule: g.schedule.map(f => Object.assign({}, f, { text: describe(f), injected: false, cleared: false })),
        layout: { roles: g.layout.roles, scenario: g.layout.scenario },
        injLog: [{ t: 0, phase: 'START', text: 'Campaign ' + seed + ': ' + g.schedule.length + ' scheduled faults over ' + g.D + ' simulated seconds' }],
        results: null, ackPlan: {}
    });
    T.history = T.history || [];
    global.set('test', T);
    out1.push({ payload: { cmd: 'start', speed } });
    node.status({ fill: 'yellow', shape: 'dot', text: 'test ' + seed });
    return [out1, null, null];
}

if (msg.topic === 'cmd' && c.cmd === 'abort') {
    T.state = 'ABORTED';
    global.set('test', T);
    out1.push({ payload: { cmd: 'stop' } });
    return [out1, null, null];
}

if (msg.topic === 'cmd' && c.cmd === 'inject') {
    // manual injection from the dashboard (works in live mode too)
    const t = global.get('simTime') || 0;
    const faults = global.get('faults') || [];
    const b = c.boat ? ((global.get('layout') || {}).boats || []).find(x => x.id === c.boat) : null;
    const tag = b && b.tags.length ? b.tags[0] : { id: 'T1', name: 'crew' };
    const defs = {
        CAPSIZE: { end: 1e9, params: {} }, FLOODING: { end: 1e9, params: {} },
        MOB: { end: 1e9, params: { tag: tag.id, crew: tag.name } }, SOS_BUTTON: { end: t + 3, params: {} },
        WAVE_SPIKE: { end: t + 2, params: { roll: 78, sign: 1 } }, SPLASH: { end: t + 2, params: { level: 80 } },
        TAG_FLICKER: { end: t + 4, params: { tag: tag.id, crew: tag.name } },
        RADIO_BLACKOUT: { end: t + 70, params: {} }, LINK_DEGRADE: { end: t + 50, params: { loss: 0.35 } },
        DUP_BURST: { end: t + 35, params: { p: 0.5 } }, REORDER_BURST: { end: t + 40, params: { p: 0.4 } },
        BOUNDARY_DRIFT: { end: 1e9, params: { speed: 7, from: 0 } }, GPS_JITTER: { end: t + 90, params: { sigma: 40, at: 0 } },
        WIFI_FLAP: { end: t + 30, params: { reqLoss: 0.6, respLoss: 0.5 } },
        STORM: { end: t + 150, params: { zone: c.zone || 'Z2', zoneName: lib.zoneName(c.zone || 'Z2'), wave: 3.2, wind: 60 } },
        WEATHER_API_FAIL: { end: t + 60, params: {} }, GATEWAY_OUTAGE: { end: t + 60, params: {} }, TELEGRAM_OUTAGE: { end: t + 45, params: {} }
    };
    const d = defs[c.type];
    if (d) {
        const f = { id: 'M' + Math.floor(Math.random() * 10000), type: c.type, boat: c.boat || null, start: t, end: d.end, dur: d.end > 1e8 ? null : d.end - t, params: d.params, manual: true };
        faults.push(f);
        global.set('faults', faults);
        T.injLog = T.injLog || [];
        T.injLog.push({ t, phase: 'MANUAL', id: f.id, type: f.type, boat: f.boat, text: describe(f) });
        global.set('test', T);
    }
    return null;
}

// A run that reached EVALUATING and was interrupted by a restart: the clock is
// already stopped and the oracle never ran. Re-emit the SAME evaluate request the
// normal end-of-run path emits - no simTime advance, no fabricated results. The
// oracle (fn003d) only acts while T.state === 'EVALUATING' and sets DONE, so a
// duplicate evaluate cannot append duplicate history.
if (msg.topic === 'cmd' && c.cmd === 'finishRestoredEvaluation') {
    if (T.state !== 'EVALUATING') return null;
    out3.push({ topic: 'evaluate', payload: { seed: T.seed } });
    return [null, null, out3.length ? out3 : null];
}

if (msg.topic === 'tick' && T.state === 'RUNNING') {
    const t = msg.t;
    const faults = global.get('faults') || [];
    for (const f of T.schedule) {
        if (!f.injected && t >= f.start) {
            f.injected = true;
            faults.push({ id: f.id, type: f.type, boat: f.boat, start: f.start, end: f.end, dur: f.dur, params: f.params });
            T.injLog.push({ t, phase: 'INJECT', id: f.id, type: f.type, boat: f.boat, text: f.text });
        }
        if (f.injected && !f.cleared && f.end < 1e8 && t >= f.end) {
            f.cleared = true;
            T.injLog.push({ t, phase: 'CLEAR', id: f.id, type: f.type, boat: f.boat, text: (f.boat || 'fleet') + ': ' + f.type + ' ended' });
        }
    }
    global.set('faults', faults);
    // randomized operator behaviour: some critical incidents get acknowledged, some do not
    const incidents = global.get('incidents') || [];
    for (const inc of incidents) {
        if (inc.severity < 4 || inc.kind !== 'boat') continue;
        if (T.ackPlan[inc.id] === undefined) {
            const r = lib.rng((T.seed ^ (inc.id.length * 7919) ^ (inc.opened * 104729)) >>> 0);
            T.ackPlan[inc.id] = r() < 0.5 ? { at: inc.opened + 10 + Math.floor(r() * 25) } : null;
        }
        const plan = T.ackPlan[inc.id];
        if (plan && !plan.done && t >= plan.at && inc.status === 'OPEN') {
            plan.done = true;
            out2.push({ topic: 'cmd', payload: { cmd: 'ack', id: inc.id, by: 'duty officer (simulated)' } });
            T.injLog.push({ t, phase: 'OPERATOR', text: 'Duty officer acknowledged ' + inc.id + ' (' + inc.title + ')' });
        }
    }
    if (T.injLog.length > 400) T.injLog.splice(0, T.injLog.length - 400);
    if (t >= T.D) {
        T.state = 'EVALUATING';
        out1.push({ payload: { cmd: 'stop' } });
        out3.push({ topic: 'evaluate', payload: { seed: T.seed } });
    }
    global.set('test', T);
    return [out1.length ? out1 : null, out2.length ? out2 : null, out3.length ? out3 : null];
}
return null;
