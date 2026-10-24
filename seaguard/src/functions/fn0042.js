// Routes dashboard commands to the right part of the system.
// Outputs: 1 clock, 2 test controller, 3 correlation engine, 4 notifier
const c = (msg.payload && msg.payload.cmd) ? msg.payload : (msg.payload || {});
const cmd = c.cmd;
if (cmd === 'pause') return [{ payload: { cmd: 'stop' } }, null, null, null];
if (cmd === 'resume') return [{ payload: { cmd: 'resume' } }, null, null, null];
if (cmd === 'speed') return [{ payload: { cmd: 'speed', speed: c.speed } }, null, null, null];
if (cmd === 'run' || cmd === 'abort' || cmd === 'live' || cmd === 'inject') return [null, { topic: 'cmd', payload: c }, null, null];
if (cmd === 'ack' || cmd === 'resolve') return [null, null, { topic: 'cmd', payload: c }, null];
if (cmd === 'testMessage') return [null, null, null, { topic: 'test' }];
return null;
