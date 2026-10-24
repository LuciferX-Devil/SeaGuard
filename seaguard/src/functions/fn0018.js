// LoRa radio channel model (downlink). Packets pass through here between the
// boat radio and the shore gateway. Impairments: background loss that grows with
// distance, interference bursts, duplicates, late delivery that reorders packets,
// and total radio blackout. Every notable impairment is written to the link log.
const DIR = 'down';
const cfg = global.get('cfg'), lib = global.get('lib');
const ep = global.get('epoch');
const t = global.get('simTime') || 0;

let S = context.get('S');
if (!S || S.ep !== ep) {
    S = { ep, q: [], r: lib.rng(((global.get('runSeed') || 777) + (DIR === 'up' ? 202 : 303)) >>> 0), stats: {} };
    context.set('S', S);
}
const stats = global.get('chan') || {};
function st(boat) {
    const k = DIR + ':' + boat;
    if (!stats[k]) stats[k] = { in: 0, out: 0, dropped: 0, dup: 0, delayed: 0, held: 0 };
    return stats[k];
}
function linkLog(boat, kind, text) {
    const L = global.get('linkLog') || [];
    L.push({ t, dir: DIR, boat, kind, text });
    if (L.length > 250) L.splice(0, L.length - 250);
    global.set('linkLog', L);
}
function hist(boat, dropped) {
    if (DIR !== 'up') return;
    const H = global.get('linkHist') || {};
    const arr = H[boat] || (H[boat] = []);
    const b0 = Math.floor(t / 10) * 10;
    let last = arr[arr.length - 1];
    if (!last || last.t0 !== b0) { last = { t0: b0, n: 0, lost: 0 }; arr.push(last); if (arr.length > 36) arr.shift(); }
    last.n++; if (dropped) last.lost++;
    global.set('linkHist', H);
}
function describe(p) {
    if (p.k === 'T') return `telemetry #${p.s}`;
    if (p.k === 'E') return `${p.ev} event #${p.s}${p.rt > 1 ? ' (retry ' + p.rt + ')' : ''}`;
    if (p.k === 'A') return `ACK for ${p.eid}`;
    if (p.k === 'ADV') return 'advisory';
    return 'packet';
}

if (msg.topic === 'tick') {
    const due = S.q.filter(x => x.due <= t);
    if (!due.length) return null;
    S.q = S.q.filter(x => x.due > t);
    for (const x of due) st(x.p.b).out++;
    global.set('chan', stats);
    return [due.map(x => ({ topic: DIR === 'up' ? 'up' : 'downlink', payload: x.p }))];
}

const p = msg.payload;
if (!p || !p.b) return null;
const s = st(p.b);
s.in++;
const faults = global.get('faults') || [];
const truth = (global.get('truth') || {})[p.b];
const distM = truth ? Math.max(50, Math.hypot(truth.x, truth.y)) : 1000;

let loss = cfg.lora.baseLoss + cfg.lora.lossPer10km * distM / 10000;
let reason = 'fading';
const blackout = lib.findFault(faults, t, p.b, 'RADIO_BLACKOUT');
const degrade = lib.findFault(faults, t, p.b, 'LINK_DEGRADE');
if (blackout) { loss = 1; reason = 'radio blackout'; }
else if (degrade) { loss = Math.max(loss, degrade.params.loss); reason = 'interference burst'; }

if (S.r() < loss) {
    s.dropped++; hist(p.b, true); global.set('chan', stats);
    linkLog(p.b, 'DROP', `${describe(p)} lost (${reason})`);
    return null;
}
hist(p.b, false);

const meta = Object.assign({}, p);
if (DIR === 'up') {
    meta.rssi = Math.round(-25 - 20 * Math.log10(distM) + lib.gauss(S.r) * 2);
    meta.snr = +(((meta.rssi + 118) / 4) + lib.gauss(S.r)).toFixed(1);
}
let delay = S.r() < cfg.lora.delayProb ? 1 : 0;
const reorder = lib.findFault(faults, t, p.b, 'REORDER_BURST');
if (reorder && S.r() < reorder.params.p) {
    delay = 6 + Math.floor(S.r() * 7);
    s.held++;
    linkLog(p.b, 'DELAY', `${describe(p)} held ${delay}s in a relay queue (will arrive out of order)`);
}
const outNow = [];
function emit(d) {
    if (d <= 0) { outNow.push({ topic: DIR === 'up' ? 'up' : 'downlink', payload: Object.assign({}, meta) }); s.out++; }
    else { S.q.push({ due: t + d, p: Object.assign({}, meta) }); s.delayed++; }
}
emit(delay);
const dupB = lib.findFault(faults, t, p.b, 'DUP_BURST');
const dupP = dupB ? dupB.params.p : cfg.lora.dupProb;
if (S.r() < dupP) {
    s.dup++;
    emit(delay + (S.r() < 0.5 ? 0 : 1));
    linkLog(p.b, 'DUP', `${describe(p)} delivered twice (echo/repeater)`);
}
global.set('chan', stats);
return outNow.length ? [outNow] : null;
