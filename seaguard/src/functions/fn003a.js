// Simulation clock. Every tick is one simulated second; speed sets how many
// simulated seconds pass per real second. All timing logic in SeaGuard uses
// simulated time, so a test run is repeatable regardless of speed.
// Commands: {cmd:'start', speed} | {cmd:'stop'} | {cmd:'speed', speed} | {cmd:'resume'}
const c = msg.payload || {};

function stop() {
    const h = context.get('handle');
    if (h) clearInterval(h);
    context.set('handle', null);
    global.set('simRunning', false);
    node.status({ fill: 'grey', shape: 'ring', text: 'paused at t=' + (global.get('simTime') || 0) + 's' });
}
function start(speed) {
    stop();
    speed = Math.max(0.5, Math.min(50, Number(speed) || 1));
    const ms = Math.round(1000 / speed);
    const h = setInterval(() => {
        const t = (global.get('simTime') || 0) + 1;
        global.set('simTime', t);
        node.send({ topic: 'tick', t, epoch: global.get('epoch') });
        if (t % 5 === 0) node.status({ fill: 'green', shape: 'dot', text: 't=' + t + 's  x' + speed });
    }, ms);
    context.set('handle', h);
    global.set('simRunning', true);
    global.set('simSpeed', speed);
}

if (c.cmd === 'start') start(c.speed);
else if (c.cmd === 'stop') stop();
else if (c.cmd === 'speed') { global.set('simSpeed', Number(c.speed)); if (global.get('simRunning')) start(c.speed); }
else if (c.cmd === 'resume') start(global.get('simSpeed') || 1);
return null;
