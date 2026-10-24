// GET /seaguard/state?keys=fleet,fw - inspect the shared state (handy while developing or
// while writing up what happened during a run).
const allowed = ['simTime', 'mode', 'epoch', 'runSeed', 'fleet', 'fw', 'truth', 'geo', 'linkShore', 'chan', 'incidents',
    'eventLog', 'suppressions', 'notifications', 'mockTelegram', 'weather', 'seaState', 'syncStore', 'gateway',
    'gatewayShore', 'corr', 'linkLog', 'linkHist', 'edgeLog', 'faults', 'test', 'layout'];
const keys = String(msg.req.query.keys || 'test').split(',').filter(k => allowed.indexOf(k) >= 0);
const out = {};
for (const k of keys) out[k] = global.get(k);
msg.payload = out;
msg.statusCode = 200;
return msg;
