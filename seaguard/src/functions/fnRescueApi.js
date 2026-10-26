// Loopback JSON API for the rescue exercise:
//   GET  /seaguard/rescue/state   -> the current exercise view
//   POST /seaguard/rescue/command -> { action, ...args } (same handler as the UI)
// Shares the exact same controller instance (global.get('rescue')) and the
// same SHARED FLOW state (flow 'rescueWorld') as the dashboard fnRescue node,
// so UI and API never diverge even though they are different nodes.
const ex = global.get('rescue');
if (!ex) { msg.statusCode = 503; msg.payload = { ok: false, error: 'rescue exercise not configured' }; return msg; }
const store = global.get('rescueStore');
let S = flow.get('rescueWorld');
if (!S) {
    // Lazy one-shot restore — shares the same flow world and save path as
    // fnRescue, so UI and API never diverge.
    S = store ? store.restoreOnce(ex, flow) : ex.createExercise({});
    flow.set('rescueWorld', S);
}
function saveStatus() {
    if (!store) return null;
    const st = store.status();
    return { ok: (st.primary.valid || st.backup.valid) && !flow.get('rescueSaveError'), source: st.primary.valid ? 'primary' : (st.backup.valid ? 'backup' : null), simTime: st.primary.valid ? st.primary.simTime : st.backup.simTime, error: flow.get('rescueSaveError') || S.ex.restoreWarning || null };
}

if (msg.req.method === 'GET') {
    const v = ex.view(S.state, S.ex);
    v.save = saveStatus();
    v.restored = !!S.ex.restoredFromSnapshot;
    msg.payload = v;
    msg.statusCode = 200;
    return [msg, null];
}

// POST /seaguard/rescue/command
const c = msg.payload || {};
if (typeof c !== 'object' || Array.isArray(c) || typeof c.action !== 'string') {
    msg.statusCode = 400; msg.payload = { ok: false, error: 'body must be a JSON object with an "action" string' };
    return [null, msg];
}
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
        case 'assistance':
            ex.requestAssistance(S.state, S.ex, { helperId: c.helperId, personnel: c.personnel, recoveryKit: c.recoveryKit });
            break;
        case 'setRelay':
            ex.setRelay(S.state, S.ex, { helperId: c.helperId === undefined ? null : c.helperId });
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
            // Explicit reload from the durable store (replaces the live world).
            const loaded = store ? store.load() : { ok: false };
            if (!loaded.ok) throw new Error(loaded.error);
            S = loaded.world;
            S.ex.paused = true; // resume is an explicit operator action
            S.ex.restoredFromSnapshot = true;
            flow.set('rescueWorld', S);
            flow.set('RM', null);
            break;
        }
        case 'recenter':
            flow.set('RM', null);
            break;
        default:
            msg.statusCode = 400;
            msg.payload = { ok: false, error: 'unknown action ' + c.action };
            return [null, msg];
    }
    // Persist after every successful command; 'save' is an explicit checkpoint.
    if (store) {
        const saved = store.save(S);
        flow.set('rescueSaveError', saved.ok ? null : saved.error);
        if (!saved.ok && c.action === 'save') throw new Error(saved.error);
    }
    const v = ex.view(S.state, S.ex);
    v.save = saveStatus();
    v.restored = !!S.ex.restoredFromSnapshot;
    msg.payload = { ok: true, view: v };
    msg.statusCode = 200;
} catch (e) {
    msg.statusCode = 400;
    msg.payload = { ok: false, error: e.message, save: saveStatus() };
}
return [null, msg];
