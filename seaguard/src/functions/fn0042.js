// Routes dashboard commands to the right part of the system.
// Outputs: 1 clock, 2 test controller, 3 correlation engine, 4 notifier
const c = (msg.payload && msg.payload.cmd) ? msg.payload : (msg.payload || {});
const cmd = c.cmd;
if (cmd === 'pause') return [{ payload: { cmd: 'stop' } }, null, null, null];
if (cmd === 'resume') {
    // Interrupted EVALUATING: the run already stopped the clock and the oracle
    // never ran. Release the restored-pause hold, keep the clock stopped, and ask
    // the test controller to re-emit its evaluate request.
    const T = global.get('test');
    if (T && T.state === 'EVALUATING') {
        const rt = global.get('fleetRuntime');
        if (rt && typeof rt.resume === 'function') {
            const r = rt.resume(global);
            if (r && r.blocked) node.status({ fill: 'red', shape: 'ring', text: 'resume blocked: ' + (r.error || 'store error') });
        }
        return [{ payload: { cmd: 'stop' } }, { topic: 'cmd', payload: { cmd: 'finishRestoredEvaluation' } }, null, null];
    }
    return [{ payload: { cmd: 'resume' } }, null, null, null];
}
if (cmd === 'speed') return [{ payload: { cmd: 'speed', speed: c.speed } }, null, null, null];
if (cmd === 'run' || cmd === 'abort' || cmd === 'live' || cmd === 'inject') return [null, { topic: 'cmd', payload: c }, null, null];
if (cmd === 'ack' || cmd === 'resolve') return [null, null, { topic: 'cmd', payload: c }, null];
if (cmd === 'save') {
    // Operator checkpoint from the dashboard: synchronous, completed save through the
    // persistence adapter. The result is surfaced in global.fleetSaveStatus, which the
    // dashboard publisher publishes on its next tick.
    const rt = global.get('fleetRuntime');
    const r = rt && typeof rt.save === 'function' ? rt.save(global) : { ok: false, error: 'fleet runtime not available' };
    node.status({ fill: r.ok ? 'green' : 'red', shape: 'dot', text: r.ok ? 'checkpoint saved' : 'save failed: ' + (r.error || 'unknown') });
    return null;
}
if (cmd === 'testMessage') return [null, null, null, { topic: 'test' }];
return null;
