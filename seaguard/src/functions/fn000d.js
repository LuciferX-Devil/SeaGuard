// Keeps the last edge-firmware notes (filtered transients, retries, advisories) for the dashboard.
const L = global.get('edgeLog') || [];
const ep = global.get('epoch');
if (L.ep !== ep) { L.length = 0; L.ep = ep; }
L.push(Object.assign({ ep }, msg.payload));
if (L.length > 120) L.splice(0, L.length - 120);
global.set('edgeLog', L);
return null;