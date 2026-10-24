// Shore LoRa gateway. Bridges the radio side to the MQTT broker.
//  - forwards uplinks to  seaguard/up/<boat>
//  - relays downlinks from seaguard/down/<boat> onto the radio
//  - publishes a heartbeat every 5 s (plus birth/close/will status via the MQTT config)
//  - store-and-forward: if the MQTT backhaul is down it buffers up to 60 packets
// A GATEWAY_OUTAGE fault really disconnects this gateway's MQTT client.
// Outputs: 1 = to MQTT out (publish or connect/disconnect action), 2 = downlink to radio
const lib = global.get('lib');
const ep = global.get('epoch');
const t = global.get('simTime') || 0;
const MAXBUF = 60;

let G = context.get('G');
if (!G) { G = { connected: true, forcedDown: false, ep: null, buffer: [], stats: { fwd: 0, buffered: 0, bufDropped: 0, flushed: 0, down: 0 }, lastHb: -999 }; context.set('G', G); }
if (G.ep !== ep) { G.ep = ep; G.buffer = []; G.stats = { fwd: 0, buffered: 0, bufDropped: 0, flushed: 0, down: 0 }; G.lastHb = -999; }

function pub(p) { return { topic: 'seaguard/up/' + p.b, payload: p, qos: 0 }; }
function save() {
    global.set('gateway', { connected: G.connected, forcedDown: G.forcedDown, buffered: G.buffer.length, stats: G.stats, t });
}
function glog(kind, text) {
    const L = global.get('linkLog') || [];
    L.push({ t, dir: 'gw', boat: '-', kind, text });
    if (L.length > 250) L.splice(0, L.length - 250);
    global.set('linkLog', L);
}
const out1 = [], out2 = [];

if (msg.topic === 'mqttStatus') {
    const txt = String((msg.status && msg.status.text) || '');
    const nowConnected = /\.connected$|^connected$/.test(txt);
    const wasConnected = G.connected;
    G.connected = nowConnected;
    if (nowConnected && !wasConnected) {
        glog('UP', `Backhaul reconnected; flushing ${G.buffer.length} buffered packet(s)`);
        for (const p of G.buffer) { out1.push(pub(p)); G.stats.flushed++; G.stats.fwd++; }
        G.buffer = [];
    } else if (!nowConnected && wasConnected) {
        glog('DOWN', 'Backhaul MQTT connection lost; buffering uplinks');
    }
    save();
    return [out1.length ? out1 : null, null];
}

if (msg.topic === 'tick') {
    const outage = lib.findFault(global.get('faults') || [], t, null, 'GATEWAY_OUTAGE');
    if (outage && !G.forcedDown) { G.forcedDown = true; out1.push({ action: 'disconnect' }); glog('FAULT', 'Backhaul link cut (injected outage)'); }
    if (!outage && G.forcedDown) { G.forcedDown = false; out1.push({ action: 'connect' }); glog('FAULT', 'Backhaul link restored'); }
    if (G.connected && !G.forcedDown && t - G.lastHb >= 5) {
        G.lastHb = t;
        out1.push({ topic: 'seaguard/gateway/hb', payload: { t, ep, fwd: G.stats.fwd, buffered: G.buffer.length } });
    }
    save();
    return [out1.length ? out1 : null, null];
}

if (msg.topic === 'up') {
    const p = msg.payload;
    if (G.connected && !G.forcedDown) { G.stats.fwd++; save(); return [pub(p), null]; }
    G.buffer.push(p); G.stats.buffered++;
    if (G.buffer.length > MAXBUF) { G.buffer.shift(); G.stats.bufDropped++; }
    save();
    return null;
}

if (typeof msg.topic === 'string' && msg.topic.indexOf('seaguard/down/') === 0) {
    let p = msg.payload;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return null; } }
    G.stats.down++;
    save();
    return [null, { topic: 'downlink', payload: p }];
}
return null;
