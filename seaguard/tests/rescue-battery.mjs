// SeaGuard rescue battery module tests (standalone, deterministic).
//
// Runs against seaguard/src/rescue/battery.cjs with local mocks only.
// Writes actual results to seaguard/reports/rescue-battery.json and exits
// nonzero on any failure. No services, no hardware, no real messages.

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { createBattery, consume } = require(join(here, '..', 'src', 'rescue', 'battery.cjs'));

const results = [];
let pass = 0, fail = 0;

function check(name, fn) {
    const details = [];
    let ok = true;
    let err = null;
    try {
        fn((cond, note) => {
            details.push({ ok: !!cond, note });
            if (!cond) ok = false;
        });
    } catch (e) {
        ok = false;
        err = String(e && e.message ? e.message : e);
    }
    if (ok) pass++; else fail++;
    results.push({ name, ok, error: err, details });
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (err ? '  [' + err + ']' : ''));
}

function deepEq(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
function near(a, b, tol = 1e-9) {
    return Math.abs(a - b) <= tol;
}
function expectThrow(fn, label) {
    try {
        fn();
    } catch (e) {
        if (e instanceof TypeError) return;
        throw new Error(label + ': threw non-TypeError: ' + e);
    }
    throw new Error(label + ': did not throw');
}
const snap = (b) => JSON.parse(JSON.stringify(b));

// 1. Exact unit conversion: 10 W for 3600 s = exactly 10 Wh.
check('exact-unit-conversion', (t) => {
    const b = createBattery({ capacityWh: 100, chargeWh: 100, drawW: 10 });
    const r = consume(b, { dtS: 3600, running: true });
    t(r.energyUsedWh === 10, 'energyUsedWh === 10 (got ' + r.energyUsedWh + ')');
    t(r.battery.chargeWh === 90, 'chargeWh === 90 (got ' + r.battery.chargeWh + ')');
    t(r.poweredSeconds === 3600, 'poweredSeconds === 3600');
    t(r.low === false, 'low false above threshold');
    t(r.depleted === false, 'depleted false');
});

// 2. Partial-second exhaustion: 1 Wh at 10 W lasts exactly 360 s.
check('partial-second-exhaustion', (t) => {
    const b = createBattery({ capacityWh: 10, chargeWh: 1, drawW: 10 });
    const r = consume(b, { dtS: 1000, running: true });
    t(r.poweredSeconds === 360, 'poweredSeconds === 360 (got ' + r.poweredSeconds + ')');
    t(r.energyUsedWh === 1, 'energyUsedWh === 1 (got ' + r.energyUsedWh + ')');
    t(r.battery.chargeWh === 0, 'chargeWh === 0 (got ' + r.battery.chargeWh + ')');
    t(r.depleted === true, 'depleted true');
    t(r.low === true, 'low true at zero');
});

// 3. Fractional-second exhaustion: 1 Wh at 3.65 W lasts 3600/3.65 s.
check('fractional-second-exhaustion', (t) => {
    const b = createBattery({ capacityWh: 10, chargeWh: 1, drawW: 3.65 });
    const r = consume(b, { dtS: 1000, running: true });
    t(near(r.poweredSeconds, 3600 / 3.65), 'poweredSeconds === 3600/3.65 (got ' + r.poweredSeconds + ')');
    t(r.energyUsedWh === 1, 'energyUsedWh === 1 (got ' + r.energyUsedWh + ')');
    t(r.battery.chargeWh === 0, 'chargeWh === 0 (got ' + r.battery.chargeWh + ')');
    t(r.depleted === true, 'depleted true');
});

// 4. Idle (running=false) consumes nothing for a full step.
check('idle-no-consume', (t) => {
    const b = createBattery({ capacityWh: 100, chargeWh: 42, drawW: 10 });
    const r = consume(b, { dtS: 3600, running: false });
    t(r.poweredSeconds === 0, 'poweredSeconds 0');
    t(r.energyUsedWh === 0, 'energyUsedWh 0');
    t(r.battery.chargeWh === 42, 'charge unchanged');
    t(r.depleted === false, 'not depleted');
});

// 5. Fault while running consumes zero.
check('fault-consumes-zero', (t) => {
    const b = createBattery({ capacityWh: 100, chargeWh: 42, drawW: 10 });
    const r = consume(b, { dtS: 3600, running: true, fault: true });
    t(r.poweredSeconds === 0, 'poweredSeconds 0');
    t(r.energyUsedWh === 0, 'energyUsedWh 0');
    t(r.battery.chargeWh === 42, 'charge unchanged');
});

// 6. Zero dtS: valid, no consumption, even while running.
check('zero-dt', (t) => {
    const b = createBattery({ capacityWh: 100, chargeWh: 42, drawW: 10 });
    const r = consume(b, { dtS: 0, running: true });
    t(r.poweredSeconds === 0, 'poweredSeconds 0');
    t(r.energyUsedWh === 0, 'energyUsedWh 0');
    t(r.battery.chargeWh === 42, 'charge unchanged');
});

// 7. Zero draw: pump runs the full step, uses no energy.
check('zero-draw', (t) => {
    const b = createBattery({ capacityWh: 100, chargeWh: 7, drawW: 0 });
    const r = consume(b, { dtS: 3600, running: true });
    t(r.poweredSeconds === 3600, 'poweredSeconds 3600');
    t(r.energyUsedWh === 0, 'energyUsedWh 0');
    t(r.battery.chargeWh === 7, 'charge unchanged');
    t(r.depleted === false, '7 Wh is not depleted');
});

// 8. Low threshold is inclusive: landing exactly at 20% reads low.
check('low-threshold-inclusive', (t) => {
    const at = createBattery({ capacityWh: 100, chargeWh: 20, drawW: 10 });
    const r0 = consume(at, { dtS: 0, running: true });
    t(r0.low === true, 'charge exactly at 20% is low');
    const above = createBattery({ capacityWh: 100, chargeWh: 20.0001, drawW: 10 });
    const r1 = consume(above, { dtS: 0, running: true });
    t(r1.low === false, 'just above 20% is not low');
    const step = createBattery({ capacityWh: 100, chargeWh: 25, drawW: 5 });
    const r2 = consume(step, { dtS: 3600, running: true });
    t(r2.battery.chargeWh === 20, 'step lands exactly on threshold (got ' + r2.battery.chargeWh + ')');
    t(r2.low === true, 'landing exactly on threshold is low');
});

// 9. Custom lowFraction: 50% of 10 Wh, inclusive.
check('custom-low-fraction', (t) => {
    const b = createBattery({ capacityWh: 10, chargeWh: 5, drawW: 1, lowFraction: 0.5 });
    t(b.lowFraction === 0.5, 'lowFraction stored');
    const r = consume(b, { dtS: 0, running: true });
    t(r.low === true, 'exactly at 50% is low');
    const b2 = createBattery({ capacityWh: 10, chargeWh: 5.1, drawW: 1, lowFraction: 0.5 });
    t(consume(b2, { dtS: 0, running: true }).low === false, 'above 50% not low');
});

// 10. Fresh zero-charge battery: sensible initial status.
check('initial-zero-charge', (t) => {
    const b = createBattery({ capacityWh: 100, chargeWh: 0, drawW: 10 });
    const r = consume(b, { dtS: 3600, running: true });
    t(r.depleted === true, 'depleted true');
    t(r.low === true, 'low true');
    t(r.poweredSeconds === 0, 'cannot run on zero charge');
    t(r.energyUsedWh === 0, 'no negative energy');
});

// 11. Non-mutation: input battery and step object are untouched.
check('non-mutation', (t) => {
    const b = createBattery({ capacityWh: 100, chargeWh: 30, drawW: 10 });
    const before = snap(b);
    const step = { dtS: 3600, running: true };
    const stepBefore = snap(step);
    const r = consume(b, { dtS: 3600, running: true });
    t(deepEq(b, before), 'input battery unchanged');
    t(deepEq(step, stepBefore), 'step object unchanged');
    t(r.battery !== b, 'returns a NEW battery object');
    t(deepEq(r.battery, { capacityWh: 100, chargeWh: 20, drawW: 10, lowFraction: 0.2 }),
        'new battery shape exact (got ' + JSON.stringify(r.battery) + ')');
});

// 12. Step-partition equivalence: one 3600 s step == split steps.
check('step-partition-equivalence', (t) => {
    const mk = () => createBattery({ capacityWh: 100, chargeWh: 100, drawW: 10 });
    const whole = consume(mk(), { dtS: 3600, running: true });
    const halves = consume(mk(), { dtS: 1800, running: true });
    const halves2 = consume(halves.battery, { dtS: 1800, running: true });
    const thirds = consume(mk(), { dtS: 1000, running: true });
    const thirds2 = consume(thirds.battery, { dtS: 1300, running: true });
    const thirds3 = consume(thirds2.battery, { dtS: 1300, running: true });
    const sum2 = halves.energyUsedWh + halves2.energyUsedWh;
    const sum3 = thirds.energyUsedWh + thirds2.energyUsedWh + thirds3.energyUsedWh;
    t(near(sum2, whole.energyUsedWh), 'two-step total energy matches whole (got ' + sum2 + ')');
    t(near(sum3, whole.energyUsedWh), 'three-step total energy matches whole (got ' + sum3 + ')');
    t(near(halves2.battery.chargeWh, whole.battery.chargeWh), 'two-step final charge matches');
    t(near(thirds3.battery.chargeWh, whole.battery.chargeWh), 'three-step final charge matches');
    t(halves2.low === whole.low && halves2.depleted === whole.depleted, 'two-step flags match');
    t(thirds3.low === whole.low && thirds3.depleted === whole.depleted, 'three-step flags match');
});

// 13. Partition across the exhaustion instant conserves energy.
check('partition-across-exhaustion', (t) => {
    const mk = () => createBattery({ capacityWh: 10, chargeWh: 1, drawW: 10 }); // exhausts at 360 s
    const whole = consume(mk(), { dtS: 720, running: true });
    const a = consume(mk(), { dtS: 360, running: true });
    const b = consume(a.battery, { dtS: 360, running: true });
    const c = consume(mk(), { dtS: 500, running: true });
    const d = consume(c.battery, { dtS: 220, running: true });
    t(near(a.energyUsedWh + b.energyUsedWh, whole.energyUsedWh), '360+360 energy == 720 energy (got ' + (a.energyUsedWh + b.energyUsedWh) + ')');
    t(near(c.energyUsedWh + d.energyUsedWh, whole.energyUsedWh), '500+220 energy == 720 energy (got ' + (c.energyUsedWh + d.energyUsedWh) + ')');
    t(b.battery.chargeWh === 0 && d.battery.chargeWh === 0, 'all partitions end depleted');
    t(b.depleted && d.depleted, 'all partitions report depleted');
    t(near(whole.poweredSeconds, 360), 'whole step powers exactly 360 s');
});

// 14. Invalid parameters: every bad input throws TypeError atomically.
check('invalid-parameters-atomicity', (t) => {
    // createBattery rejections
    expectThrow(() => createBattery({ capacityWh: 0, chargeWh: 0, drawW: 1 }), 'capacityWh 0');
    expectThrow(() => createBattery({ capacityWh: -5, chargeWh: 0, drawW: 1 }), 'negative capacity');
    expectThrow(() => createBattery({ capacityWh: NaN, chargeWh: 0, drawW: 1 }), 'NaN capacity');
    expectThrow(() => createBattery({ capacityWh: Infinity, chargeWh: 0, drawW: 1 }), 'Infinity capacity');
    expectThrow(() => createBattery({ capacityWh: '10', chargeWh: 0, drawW: 1 }), 'string capacity');
    expectThrow(() => createBattery({ capacityWh: 10, chargeWh: 11, drawW: 1 }), 'charge > capacity');
    expectThrow(() => createBattery({ capacityWh: 10, chargeWh: -0.1, drawW: 1 }), 'negative charge');
    expectThrow(() => createBattery({ capacityWh: 10, chargeWh: 10, drawW: -1 }), 'negative drawW');
    expectThrow(() => createBattery({ capacityWh: 10, chargeWh: 10, drawW: 1, lowFraction: 1.5 }), 'lowFraction > 1');
    expectThrow(() => createBattery({ capacityWh: 10, chargeWh: 10, drawW: 1, extra: 1 }), 'unknown create field');
    expectThrow(() => createBattery(null), 'null options');
    // consume rejections, with the input battery provably unmutated
    const b = createBattery({ capacityWh: 100, chargeWh: 30, drawW: 10 });
    const before = snap(b);
    expectThrow(() => consume(b, { dtS: NaN, running: true }), 'NaN dtS');
    expectThrow(() => consume(b, { dtS: -1, running: true }), 'negative dtS');
    expectThrow(() => consume(b, { dtS: 3600.0001, running: true }), 'dtS over bound');
    expectThrow(() => consume(b, { dtS: '3600', running: true }), 'string dtS');
    expectThrow(() => consume(b, { dtS: 10, running: 1 }), 'running 1');
    expectThrow(() => consume(b, { dtS: 10, running: 'true' }), 'running string');
    expectThrow(() => consume(b, { dtS: 10, running: true, fault: 'x' }), 'fault string');
    expectThrow(() => consume(b, { running: true }), 'missing dtS');
    expectThrow(() => consume(b, { dtS: 10 }), 'missing running');
    expectThrow(() => consume(b, { dtS: 10, running: true, extra: 1 }), 'unknown step field');
    expectThrow(() => consume({ ...b, chargeWh: 101 }, { dtS: 10, running: true }), 'battery charge > capacity');
    const { lowFraction, ...noLow } = b;
    expectThrow(() => consume(noLow, { dtS: 10, running: true }), 'battery missing lowFraction');
    expectThrow(() => consume(null, { dtS: 10, running: true }), 'null battery');
    t(deepEq(b, before), 'battery unmutated after 13 failed consumes');
});

// 15. dtS bounds: 0 and 3600 both accepted (endpoints inclusive).
check('dtS-boundaries-inclusive', (t) => {
    const b = createBattery({ capacityWh: 100, chargeWh: 100, drawW: 1 });
    const lo = consume(b, { dtS: 0, running: true });
    const hi = consume(b, { dtS: 3600, running: true });
    t(lo.energyUsedWh === 0, 'dtS 0 accepted, zero energy');
    t(hi.energyUsedWh === 1, 'dtS 3600 accepted, 1 Wh at 1 W');
});

// 16. Default lowFraction is 0.2 and createBattery returns a plain copy.
check('default-low-fraction-and-copy', (t) => {
    const opts = { capacityWh: 50, chargeWh: 25, drawW: 2 };
    const b = createBattery(opts);
    t(b.lowFraction === 0.2, 'default lowFraction 0.2 (got ' + b.lowFraction + ')');
    t(b !== opts, 'returns a new object');
    opts.chargeWh = 1;
    t(b.chargeWh === 25, 'input options mutation does not affect battery');
    const r = consume(b, { dtS: 0, running: true });
    t(r.low === false, '25 of 50 (50%) is above the 20% threshold, not low');
    const lowB = createBattery({ capacityWh: 50, chargeWh: 10, drawW: 2 });
    t(consume(lowB, { dtS: 0, running: true }).low === true, 'exactly 10 of 50 (20%) is low');
});

// 17. Extreme finite values must not overflow to Infinity.
check('extreme-finite-no-overflow', (t) => {
    const M = Number.MAX_VALUE;
    // Non-exhausted: fullStepWh = M*(1800/3600) = M/2 < chargeWh = M.
    const b = createBattery({ capacityWh: M, chargeWh: M, drawW: M });
    const r = consume(b, { dtS: 1800, running: true });
    t(Number.isFinite(r.energyUsedWh), 'energyUsedWh finite (got ' + r.energyUsedWh + ')');
    t(r.energyUsedWh === M * 0.5, 'energyUsedWh === M/2 (got ' + r.energyUsedWh + ')');
    t(r.poweredSeconds === 1800, 'runs the full step (got ' + r.poweredSeconds + ')');
    t(r.battery.chargeWh === M * 0.5, 'charge decremented by M/2 to M/2 (got ' + r.battery.chargeWh + ')');
    // Exhausted at the extreme: fullStepWh = M >= chargeWh = M.
    const e = createBattery({ capacityWh: M, chargeWh: M, drawW: M });
    const er = consume(e, { dtS: 3600, running: true });
    t(Number.isFinite(er.energyUsedWh) && er.energyUsedWh === M, 'exhausted energyUsedWh === M (got ' + er.energyUsedWh + ')');
    t(er.poweredSeconds === 3600, 'exhausted poweredSeconds === 3600, no overflow (got ' + er.poweredSeconds + ')');
    t(er.battery.chargeWh === 0, 'fully depleted (got ' + er.battery.chargeWh + ')');
});

// 18. A depleted battery reports poweredSeconds 0 even with zero draw.
check('zero-charge-zero-draw', (t) => {
    const b = createBattery({ capacityWh: 10, chargeWh: 0, drawW: 0 });
    const r = consume(b, { dtS: 3600, running: true });
    t(r.poweredSeconds === 0, 'depleted battery powers no seconds even at drawW 0 (got ' + r.poweredSeconds + ')');
    t(r.energyUsedWh === 0, 'zero energy (got ' + r.energyUsedWh + ')');
    t(r.depleted === true, 'depleted true (got ' + r.depleted + ')');
    t(r.low === true, 'low true at zero charge (got ' + r.low + ')');
    t(r.battery.chargeWh === 0, 'charge stays 0 (got ' + r.battery.chargeWh + ')');
});

// ---- report ----
const report = {
    module: 'seaguard/src/rescue/battery.cjs',
    testFile: 'seaguard/tests/rescue-battery.mjs',
    generatedAt: new Date().toISOString(),
    note: 'Deterministic local simulation only; illustrative values, no hardware claim.',
    total: results.length,
    pass,
    fail,
    results
};
const out = join(here, '..', 'reports', 'rescue-battery.json');
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log('\n' + pass + ' passed, ' + fail + ' failed of ' + results.length + ' tests');
console.log('report written: ' + out);
process.exit(fail > 0 ? 1 : 0);
