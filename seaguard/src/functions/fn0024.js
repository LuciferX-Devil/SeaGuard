// Weather evaluation. Builds the per-zone picture, raises STORM_WARNING / STORM_CLEARED
// with hysteresis, and degrades gracefully (keeps last good values, marks them stale)
// when the API fails or times out.
const cfg = global.get('cfg');
const ep = global.get('epoch');
const t = global.get('simTime') || 0;
if (!msg.wx || msg.wx.ep !== ep) return null;
let W = global.get('weather');
if (!W || W.ep !== ep) {
    W = { ep, status: 'UNKNOWN', source: msg.wx.source, lastOk: null, failures: 0, lastError: null, zones: {}, history: [] };
}
W.source = msg.wx.source;
const events = [];
function ev(type, data, boat) { events.push({ topic: 'event', payload: { type, boat: boat || 'FLEET', t, source: 'shore', data } }); }
function hist(status, note) { W.history.push({ t, status, note }); if (W.history.length > 60) W.history.shift(); }

let err = msg.wx.error;
if (!err && (msg.statusCode !== 200 || !Array.isArray(msg.payload))) err = 'Forecast API ' + (msg.statusCode || 'no response');
if (err) {
    W.failures++; W.lastError = err;
    if (W.status !== 'DEGRADED') { ev('WEATHER_DEGRADED', { error: err }); hist('DEGRADED', err); }
    W.status = 'DEGRADED';
    for (const z of Object.values(W.zones)) z.stale = true;
} else {
    if (W.status === 'DEGRADED') { ev('WEATHER_RESTORED', { after: W.failures }); hist('OK', 'feed restored'); }
    else if (W.status === 'UNKNOWN') hist('OK', 'first reading');
    W.status = 'OK'; W.failures = 0; W.lastOk = t; W.lastOkWall = Date.now();
    const seaState = {};
    cfg.zones.forEach((z, i) => {
        const m = (msg.wx.marine || [])[i] || {}, f = (msg.payload[i] || {}).current || {};
        const Z = W.zones[z.id] || (W.zones[z.id] = { id: z.id, name: z.name, storm: false });
        Z.wave = m.wave_height == null ? null : m.wave_height;
        Z.period = m.wave_period == null ? null : m.wave_period;
        Z.wind = f.wind_speed_10m == null ? null : f.wind_speed_10m;
        Z.gust = f.wind_gusts_10m == null ? null : f.wind_gusts_10m;
        Z.stale = false; Z.t = t;
        const K = cfg.storm;
        if (!Z.storm && ((Z.wave || 0) >= K.waveM || (Z.wind || 0) >= K.windKmh)) {
            Z.storm = true; Z.stormSince = t;
            ev('STORM_WARNING', { zone: z.id, zoneName: z.name, wave: Z.wave, wind: Z.wind });
            hist('STORM', z.name + ': wave ' + Z.wave + ' m, wind ' + Z.wind + ' km/h');
        } else if (Z.storm && (Z.wave || 0) < K.clearWaveM && (Z.wind || 0) < K.clearWindKmh) {
            Z.storm = false;
            ev('STORM_CLEARED', { zone: z.id, zoneName: z.name, wave: Z.wave, wind: Z.wind });
            hist('OK', z.name + ' storm cleared');
        }
        seaState[z.id] = { wave: Z.wave == null ? 0.6 : Z.wave, wind: Z.wind == null ? 18 : Z.wind };
    });
    global.set('seaState', seaState);
}
global.set('weather', W);
return [events];
