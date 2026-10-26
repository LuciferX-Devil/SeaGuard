// POST /seaguard/fleet/command - validated operator actions: {action: pause|resume|save|restart}.
// pause/resume/restart are accepted ASYNC and forwarded to the existing command router (fn0042),
// which owns the clock control and the test controller - exactly like the dashboard buttons.
// save completes SYNCHRONOUSLY through the persistence adapter and reports the checkpoint result.
// A blocked (corrupt-store) world refuses resume (409) until an explicit restart recovers it.
// TWO outputs: [0] command router (link to fn0042), [1] HTTP response (ho005f).
// Every HTTP-only result must be [null, msg] so the response lands on output 2;
// a bare msg would go to output 1 (router) and the HTTP request would hang.
const ACTIONS = new Set(['pause', 'resume', 'save', 'restart']);
const body = msg.payload || {};
const action = body.action;
function reject(status, error) { msg.statusCode = status; msg.payload = { ok: false, error }; return [null, msg]; }
if (typeof action !== 'string' || !ACTIONS.has(action)) return reject(400, 'action must be one of: pause, resume, save, restart');
const rt = global.get('fleetRuntime');
if (rt && typeof rt.status === 'function' && !rt.status().initialized) return reject(503, 'Fleet is starting; retry shortly.');
const blocked = rt && typeof rt.status === 'function' ? rt.status().blocked : false;
if (action === 'resume' && blocked) return reject(409, 'Fleet store is blocked (corrupt snapshot). Resume is refused; use restart to deliberately reset the world.');
if (action === 'save') {
    if (!rt || typeof rt.save !== 'function') return reject(503, 'Fleet persistence runtime is not available');
    const r = rt.save(global);
    const status = global.get('fleetSaveStatus') || null;
    msg.payload = r.ok
        ? { ok: true, action: 'save', completed: true, save: { ok: true, savedAt: r.savedAt ?? null, bytes: r.bytes ?? null, status } }
        : { ok: false, action: 'save', completed: true, save: { ok: false, error: r.error || 'save failed', status } };
    msg.statusCode = r.ok ? 200 : 500;
    return [null, msg];
}
// Async clock/world commands: forward to the existing command router.
const cmd = action === 'restart' ? 'live' : action; // restart = deliberate world reset (fn003e)
msg.payload = { ok: true, action, accepted: true, async: true,
    note: action === 'restart' ? 'forwarded to the test controller (deliberate world reset)' : 'forwarded to the simulation clock' };
msg.statusCode = 202;
return [{ topic: 'cmd', payload: { cmd } }, msg];
