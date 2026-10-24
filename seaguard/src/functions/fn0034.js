// Local Open-Meteo mock (test runs). Returns the same JSON shape as the real API,
// using the simulated "true" sea state, or HTTP 503 during an injected API failure.
const lib = global.get('lib'), cfg = global.get('cfg');
const t = global.get('simTime') || 0;
const faults = global.get('faults') || [];
if (lib.findFault(faults, t, null, 'WEATHER_API_FAIL')) {
    msg.statusCode = 503;
    msg.payload = { error: true, reason: 'Service temporarily unavailable (injected fault)' };
    return msg;
}
const kind = msg.req.params.kind;
const lats = String(msg.req.query.latitude || '').split(',');
const lons = String(msg.req.query.longitude || '').split(',');
msg.payload = lats.map((la, i) => {
    const z = cfg.zones[i] || cfg.zones[0];
    const s = lib.mockSea(z.id, t, faults);
    const current = kind === 'marine'
        ? { time: new Date().toISOString().slice(0, 16), interval: 900, wave_height: s.wave, wave_period: 4.2, wave_direction: 200 }
        : { time: new Date().toISOString().slice(0, 16), interval: 900, wind_speed_10m: s.wind, wind_gusts_10m: s.gust, wind_direction_10m: 195 };
    return { latitude: +la, longitude: +lons[i], location_id: i, current };
});
msg.statusCode = 200;
return msg;
