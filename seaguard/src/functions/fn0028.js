// Weather poller. Live mode: real Open-Meteo marine + forecast APIs every 10 minutes.
// Test runs: the local Open-Meteo mock every 30 simulated seconds (same JSON format),
// so storms and API failures can be injected without touching the real service.
const cfg = global.get('cfg');
const mode = global.get('mode');
const ep = global.get('epoch');
const t = global.get('simTime') || 0;
let S = context.get('S');
if (!S || S.ep !== ep) { S = { ep, last: null, lastWall: 0 }; context.set('S', S); }

let fire = msg.topic === 'cmd';
if (msg.topic === 'tick') {
    if (mode === 'test' || cfg.weather.offline) fire = S.last === null || t - S.last >= cfg.weather.testEverySimS;
    else fire = !S.lastWall || Date.now() - S.lastWall >= cfg.weather.liveEverySec * 1000;
}
if (!fire) return null;
S.last = t; S.lastWall = Date.now();
const lats = cfg.zones.map(z => z.lat).join(','), lons = cfg.zones.map(z => z.lon).join(',');
const mock = mode === 'test' || cfg.weather.offline;
const base = cfg.baseUrl + '/mock-openmeteo';
return {
    topic: 'weather',
    url: (mock ? base + '/marine' : cfg.weather.marineUrl) + `?latitude=${lats}&longitude=${lons}&current=wave_height,wave_period,wave_direction`,
    requestTimeout: 8000,
    wx: {
        ep, t, source: mock ? 'Local simulated weather' : 'Open-Meteo (live)',
        forecastUrl: (mock ? base + '/forecast' : cfg.weather.forecastUrl) + `?latitude=${lats}&longitude=${lons}&current=wind_speed_10m,wind_gusts_10m,wind_direction_10m`
    }
};
