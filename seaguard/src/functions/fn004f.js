// GET /seaguard/fleet/state - machine-readable fleet clock/persistence status for operators and
// the restart harness. Allowlisted world state plus save status only: never cfg, lib or credentials.
const rt = global.get('fleetRuntime');
const st = rt && typeof rt.status === 'function' ? rt.status() : null;
const T = global.get('test') || {};
msg.payload = {
    ok: !!(st && st.initialized),
    clock: { running: global.get('simRunning') || false, speed: global.get('simSpeed') || null, t: global.get('simTime') || 0,
        epoch: global.get('epoch') || 0, mode: global.get('mode') || null },
    test: { state: T.state || 'IDLE', seed: T.seed ?? null },
    save: global.get('fleetSaveStatus') || null,
    runtime: st ? { initialized: st.initialized, blocked: st.blocked, restored: st.restored, pausedHold: st.pausedHold,
        saves: st.saves, lastSave: st.lastSave, lastLoad: st.lastLoad, source: st.source, error: st.error } : null
};
msg.statusCode = st && st.initialized ? 200 : 503;
return msg;
