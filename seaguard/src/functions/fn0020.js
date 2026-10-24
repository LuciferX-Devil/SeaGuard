// Gateway monitor (shore side). Watches seaguard/gateway/status (birth / close / last-will
// messages set on the gateway's MQTT connection) and the heartbeat topic. Raises
// GATEWAY_OUTAGE / GATEWAY_RESTORED, which the correlation engine uses as a root cause.
const cfg = global.get('cfg');
const ep = global.get('epoch');
const t = global.get('simTime') || 0;
let M = context.get('M');
if (!M) { M = { online: true, lastHb: t, reason: 'startup' }; context.set('M', M); }
if (M.ep !== ep) { M.ep = ep; M.lastHb = t; }

function setState(online, reason) {
    if (online === M.online) return null;
    M.online = online; M.reason = reason; M.since = t;
    return { topic: 'event', payload: { type: online ? 'GATEWAY_RESTORED' : 'GATEWAY_OUTAGE', boat: 'FLEET', t, source: 'shore', data: { reason } } };
}
let out = null;
if (msg.topic === 'tick') {
    if (M.online && t - M.lastHb > cfg.detect.gatewayHbTimeoutS) out = setState(false, 'heartbeat missing for ' + (t - M.lastHb) + 's');
} else if (msg.topic === 'seaguard/gateway/status') {
    const v = String(msg.payload).trim();
    if (v === 'offline') out = setState(false, 'gateway reported offline (close / last will)');
    if (v === 'online') { M.lastHb = t; out = setState(true, 'gateway back online (birth message)'); }
} else if (msg.topic === 'seaguard/gateway/hb') {
    M.lastHb = t;
    if (!M.online) out = setState(true, 'heartbeat resumed');
}
global.set('gatewayShore', { online: M.online, reason: M.reason, since: M.since, lastHb: M.lastHb, t });
return out;
