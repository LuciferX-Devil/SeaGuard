// Rescue exercise controller node.
// Input (any one):
//   { topic: 'tick', realDeltaS: <wall seconds since last tick> }  -> advances the exercise clock
//   { topic: 'cmd',  payload: { action, ...args } }                -> operator/admin action
//   { topic: 'mapconnect' }                                        -> worldmap reconnected: re-emit map layers
// Output 1: the exercise view (every tick, and after every command)
// Output 2: worldmap messages for the /rescue map (only when the exercise is running)
//
// The exercise state lives in SHARED FLOW context (flow.get/set 'rescueWorld'),
// so this node and the HTTP API node (different node, different node context)
// always operate on the same world. The independent exercise clock accumulates
// real seconds between ticks and advances the model by realDeltaS * speed
// (capped at 20x, and the model substeps internally at 1-second resolution).
const ex = global.get('rescue');
if (!ex) return null;
const store = global.get('rescueStore');
let S = flow.get('rescueWorld');
if (!S) {
    // Lazy one-shot restore: recover a durable snapshot if present (restoring
    // paused), otherwise create a fresh world. restoreOnce never overwrites a
    // world that already exists in the shared flow, so a live world survives.
    S = store ? store.restoreOnce(ex, flow) : ex.createExercise({});
    flow.set('rescueWorld', S);
}

// Durable save of the shared world (atomic temp->rename + previous-good
// backup inside the store). Returns a small status object for the view.
function saveWorld() {
    if (!store) return { ok: false, reason: 'no store' };
    const r = store.save(S);
    flow.set('rescueSaveError', r.ok ? null : r.error);
    return r.ok ? { ok: true, simTime: S.ex.simTime } : { ok: false, reason: r.error };
}
function saveStatus() {
    if (!store) return null;
    const st = store.status();
    return {
        ok: (st.primary.valid || st.backup.valid) && !flow.get('rescueSaveError'),
        source: st.primary.valid ? 'primary' : (st.backup.valid ? 'backup' : null),
        simTime: st.primary.valid ? st.primary.simTime : st.backup.simTime,
        error: flow.get('rescueSaveError') || S.ex.restoreWarning || null
    };
}

let out1 = null;
let out2 = null;
const reconnect = msg.payload && msg.payload.action === 'connected';
if (reconnect || msg.topic === 'mapconnect') flow.set('RM', null);

if (msg.topic === 'tick') {
    const wasPaused = S.ex.paused;
    const realDeltaS = Number(msg.realDeltaS);
    if (Number.isFinite(realDeltaS) && realDeltaS > 0) {
        ex.step(S.state, S.ex, { realDeltaS });
    }
    // Durable save every ~5 real ticks while an exercise is in progress.
    const tickN = (context.get('rescueTicks') || 0) + 1;
    context.set('rescueTicks', tickN);
    if (S.ex.scenario && ((!wasPaused && S.ex.paused) || (!S.ex.paused && tickN % 5 === 0))) saveWorld();
    out1 = ex.view(S.state, S.ex);
    out1.save = saveStatus();
    out1.restored = !!S.ex.restoredFromSnapshot;
    out2 = mapMessages(S);
} else if (msg.topic === 'cmd') {
    const c = msg.payload || {};
    try {
        switch (c.action) {
            case 'start':
                ex.start(S.state, S.ex, { scenario: c.scenario, vesselId: c.vesselId || undefined });
                flow.set('RM', null);
                break;
            case 'reset':
                ex.reset(S.state, S.ex);
                flow.set('RM', null);
                break;
            case 'pause':
                ex.pause(S.state, S.ex);
                break;
            case 'resume':
                ex.resume(S.state, S.ex);
                break;
            case 'setSpeed':
                ex.setSpeed(S.state, S.ex, { speed: c.speed });
                break;
            case 'dispatch':
                ex.dispatch(S.state, S.ex, { teamId: c.teamId, personnel: c.personnel, recoveryKit: c.recoveryKit });
                break;
            case 'reinforce':
                ex.reinforce(S.state, S.ex, { teamId: c.teamId, personnel: c.personnel, recoveryKit: c.recoveryKit });
                break;
            case 'command':
                ex.command(S.state, S.ex, { teamId: c.teamId, action: c.action2 });
                break;
            case 'setOutage':
                ex.setOutage(S.state, S.ex, { teamId: c.teamId, fromS: c.fromS, toS: c.toS });
                break;
            case 'setPumpFault':
                ex.setPumpFault(S.state, S.ex, { teamId: c.teamId, fault: c.fault });
                break;
            case 'repair':
                ex.repair(S.state, S.ex);
                break;
            case 'returnSafe':
                ex.returnSafe(S.state, S.ex);
                break;
            case 'radioRepair':
                ex.radioRepair(S.state, S.ex);
                break;
            case 'recharge':
                ex.recharge(S.state, S.ex, { teamId: c.teamId });
                break;
            case 'save':
                break; // explicit durable checkpoint (no state change)
            case 'load': {
                if (!store) throw new Error('Checkpoint store unavailable');
                const loaded = store.load();
                if (!loaded.ok) throw new Error(loaded.error);
                S = loaded.world;
                S.ex.restoredFromSnapshot = true;
                flow.set('rescueWorld', S);
                flow.set('RM', null);
                break;
            }
            case 'recenter':
                flow.set('RM', null);
                break;
            default:
                throw new Error('Unknown rescue action');
        }
        // Persist after every successful command; 'save' is an explicit
        // checkpoint (no state change, but still written to disk).
        const saved = saveWorld();
        if (c.action === 'save' && !saved.ok) throw new Error(saved.reason);
        out1 = ex.view(S.state, S.ex);
        out1.save = saveStatus();
        out1.restored = !!S.ex.restoredFromSnapshot;
        out2 = mapMessages(S);
    } catch (e) {
        out1 = Object.assign(ex.view(S.state, S.ex), { error: e.message, save: saveStatus() });
    }
}
if (msg.topic === 'mapconnect' || reconnect) {
    out2 = mapMessages(S);
}
return [out1 ? { payload: out1 } : null, out2];

// Build the worldmap payload for the /rescue map: team RECEIVED fixes only
// (with staleness), the scenario casualty, the harbour, and dashed planned
// routes for teams still moving. No GPS is shown until a fix has been received.
function mapMessages(S) {
    const v = ex.view(S.state, S.ex);
    const out = [];
    let M = flow.get('RM');
    if (!M || M.scenario !== v.scenario) {
        M = { scenario: v.scenario, moving: {} };
        flow.set('RM', M);
        out.push({ payload: { command: { clearlayer: ['Rescue teams', 'Rescue incidents', 'Rescue routes'],
            layer: 'OSM', lat: S.state.harbour.lat, lon: S.state.harbour.lon, zoom: 14 } } });
        if (v.scenario) {
            out.push({ payload: { name: 'Harbour', lat: v.harbour.lat, lon: v.harbour.lon, icon: 'anchor',
                iconColor: '#2f7d5b', layer: 'Rescue incidents', ttl: 600 } });
        }
    }
    if (!v.scenario) return out;
    // Scenario casualty (true position — the exercise knows it; the operator
    // sees it as the distress location).
    const safe = v.incident.status === 'RESOLVED' && !v.incident.unsafe.length;
    out.push({ payload: { name: v.incident.id + ' ' + v.incident.kind, lat: v.incident.position.lat,
        lon: v.incident.position.lon, icon: safe ? 'check' : 'warning', iconColor: safe ? '#2f7d5b' : '#c0392b', layer: 'Rescue incidents', ttl: 600,
        popup: '<b>' + v.incident.id + '</b><br/>' + v.incident.kind + '<br/>crew ' + v.incident.crewRescued + '/' + v.incident.crewOnboard +
            '<br/>water ' + v.incident.waterL.toFixed(1) + ' L, ingress ' + v.incident.ingressLpm + ' L/min' } });
    // Teams: RECEIVED fixes only, with the fix age; no marker until a fix arrived.
    for (const t of v.teams) {
        const tel = t.telemetry;
        if (!tel.receivedPos) continue;
        const stale = tel.stale;
        out.push({ payload: { name: t.id + ' ' + t.name,
            lat: tel.receivedPos.lat, lon: tel.receivedPos.lon, icon: 'ship',
            iconColor: stale ? '#c9a227' : '#2f7d5b', layer: 'Rescue teams', ttl: 600,
            popup: '<b>' + t.id + ' ' + t.name + '</b><br/>status ' + t.status +
                '<br/>fix ' + (stale ? 'STALE ' + Math.round(tel.ageS) + 's' : 'fresh') +
                '<br/>fuel ' + t.fuelL.toFixed(1) + ' L' } });
        // Dashed planned route while moving.
        if (t.status === 'EN_ROUTE' || t.status === 'RETURNING') {
            M.moving[t.id] = true;
            const dest = t.status === 'EN_ROUTE' ? v.incident.position : v.harbour;
            out.push({ payload: { name: t.id + ' route', line: [[tel.receivedPos.lat, tel.receivedPos.lon], [dest.lat, dest.lon]],
                color: '#1f6f8b', weight: 2, dashArray: '6,6', layer: 'Rescue routes' } });
        } else if (M.moving[t.id]) {
            // Team stopped moving: remove its completed route from the map.
            M.moving[t.id] = false;
            out.push({ payload: { name: t.id + ' route', deleted: true } });
        }
    }
    return out;
}
