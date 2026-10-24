// SeaGuard rescue pump energy model - standalone, dependency-free CommonJS.
//
// Bounded foundation for the pump energy module (rescue sprint, post-review).
// Deterministic simulated-time battery accounting for a pump load: no
// Node-RED globals, no Date.now(), no Math.random(). Every value derives
// from explicit inputs, so identical call sequences always produce
// identical results.
//
// Core rules
//  - Energy is watt-seconds converted to watt-hours:
//        energyWh = drawW * seconds / 3600
//    (1 Wh = 3600 Ws exactly).
//  - consume() is pure: it returns a NEW battery plus step metrics and
//    never mutates the input battery or the step options.
//  - The pump can only run while charge remains. If the step would exhaust
//    the battery mid-step, it runs for the exact (possibly fractional)
//    remaining seconds and stops; energyUsedWh never exceeds the charge
//    that was available, chargeWh never goes negative and never rises
//    above capacityWh.
//  - No auto recharge: nothing in this module ever adds energy.
//  - running=false (off) or fault=true consume zero energy and add zero
//    powered seconds; a fault while running simply stops the draw.
//  - "low" is INCLUSIVE: chargeWh <= capacityWh * lowFraction is low.
//  - "depleted" means chargeWh is exactly 0 (a fresh zero-charge battery
//    is therefore low AND depleted - a sensible initial status).
//  - dtS may be zero and is bounded to 0..3600 seconds (one simulated
//    hour per step), matching the model.cjs tick bound.
//
// All values are illustrative simulation constants, not hardware claims:
// no real battery, pump or vessel behaviour is asserted.
//
// API (every function validates ALL inputs first, then computes - atomic;
//      on any invalid input a TypeError is thrown and nothing is mutated)
//   createBattery({capacityWh, chargeWh, drawW, lowFraction? = 0.2})
//       -> { capacityWh, chargeWh, drawW, lowFraction }
//   consume(battery, {dtS, running, fault? = false})
//       -> {
//            battery:        NEW battery object (same shape as create),
//            poweredSeconds: seconds the pump actually drew power this step
//                            (0 when off/faulted or out of charge),
//            energyUsedWh:   drawW * poweredSeconds / 3600,
//            low:            new charge <= capacityWh * lowFraction (inclusive),
//            depleted:       new charge === 0
//          }

'use strict';

const MAX_DT_S = 3600;
const DEFAULT_LOW_FRACTION = 0.2;
const BATTERY_KEYS = ['capacityWh', 'chargeWh', 'drawW', 'lowFraction'];

// ---------- validation helpers ----------

function isFiniteNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isStrictBool(v) {
    return typeof v === 'boolean';
}

function assert(cond, msg) {
    if (!cond) throw new TypeError(msg);
}

// Validate a battery-shaped object (used for both create options and
// consume's battery argument). Returns a fresh, own-property-only copy.
function validateBatteryFields(v, label, opts) {
    assert(isPlainObject(v), label + ': must be a plain object');
    const keys = Object.keys(v).sort();
    const expected = BATTERY_KEYS.slice().sort();
    for (const k of keys) {
        assert(expected.includes(k), label + ': unknown field "' + k + '"');
    }
    for (const k of BATTERY_KEYS) {
        assert(k in v, label + ': missing field "' + k + '"');
    }
    assert(isFiniteNum(v.capacityWh) && v.capacityWh > 0,
        label + ': capacityWh must be a finite number > 0');
    assert(isFiniteNum(v.chargeWh) && v.chargeWh >= 0 && v.chargeWh <= v.capacityWh,
        label + ': chargeWh must be a finite number in [0, capacityWh]');
    assert(isFiniteNum(v.drawW) && v.drawW >= 0,
        label + ': drawW must be a finite number >= 0');
    assert(isFiniteNum(v.lowFraction) && v.lowFraction >= 0 && v.lowFraction <= 1,
        label + ': lowFraction must be a finite number in [0, 1]');
    return {
        capacityWh: v.capacityWh,
        chargeWh: v.chargeWh,
        drawW: v.drawW,
        lowFraction: v.lowFraction
    };
}

function validateBattery(v) {
    return validateBatteryFields(v, 'battery');
}

// ---------- API ----------

/**
 * Create a fresh battery. capacityWh > 0; 0 <= chargeWh <= capacityWh;
 * drawW >= 0; lowFraction defaults to 0.2 and must be in [0, 1].
 * Unknown fields are rejected.
 */
function createBattery(options) {
    assert(isPlainObject(options), 'createBattery: options must be a plain object');
    const keys = Object.keys(options);
    for (const k of keys) {
        assert(BATTERY_KEYS.includes(k),
            'createBattery: unknown field "' + k + '"');
    }
    assert(isFiniteNum(options.capacityWh) && options.capacityWh > 0,
        'createBattery: capacityWh must be a finite number > 0');
    assert(isFiniteNum(options.chargeWh) && options.chargeWh >= 0 &&
        options.chargeWh <= options.capacityWh,
        'createBattery: chargeWh must be a finite number in [0, capacityWh]');
    assert(isFiniteNum(options.drawW) && options.drawW >= 0,
        'createBattery: drawW must be a finite number >= 0');
    const lowFraction = options.lowFraction === undefined
        ? DEFAULT_LOW_FRACTION : options.lowFraction;
    assert(isFiniteNum(lowFraction) && lowFraction >= 0 && lowFraction <= 1,
        'createBattery: lowFraction must be a finite number in [0, 1]');
    return {
        capacityWh: options.capacityWh,
        chargeWh: options.chargeWh,
        drawW: options.drawW,
        lowFraction: lowFraction
    };
}

/**
 * Advance the battery by one step of dtS simulated seconds.
 *
 * - running must be a strict boolean; fault defaults to false and must be
 *   a strict boolean when given. dtS must be a finite number in [0, 3600].
 * - Off (running=false) or faulted steps consume zero energy.
 * - A running, non-faulted step consumes drawW * poweredSeconds / 3600 Wh,
 *   where poweredSeconds is dtS unless the charge runs out mid-step, in
 *   which case it is the exact fractional second at which charge hits 0.
 * - Returns a NEW battery plus { poweredSeconds, energyUsedWh, low,
 *   depleted }; "low" is inclusive (<=), "depleted" means charge === 0.
 */
function consume(battery, step) {
    const b = validateBattery(battery);
    assert(isPlainObject(step), 'consume: step must be a plain object');
    for (const k of Object.keys(step)) {
        assert(['dtS', 'running', 'fault'].includes(k),
            'consume: unknown step field "' + k + '"');
    }
    assert('dtS' in step, 'consume: missing field "dtS"');
    assert('running' in step, 'consume: missing field "running"');
    assert(isStrictBool(step.running), 'consume: running must be a boolean');
    const fault = step.fault === undefined ? false : step.fault;
    assert(isStrictBool(fault), 'consume: fault must be a boolean');
    assert(isFiniteNum(step.dtS) && step.dtS >= 0 && step.dtS <= MAX_DT_S,
        'consume: dtS must be a finite number in [0, ' + MAX_DT_S + ']');

    let poweredSeconds = 0;
    let energyUsedWh = 0;
    if (step.running && !fault && step.dtS > 0 && b.chargeWh > 0) {
        // A depleted battery (chargeWh === 0) powers nothing and reports
        // poweredSeconds 0 even when drawW is 0, keeping idle/depleted
        // semantics consistent.
        if (b.drawW === 0) {
            // Zero draw: the pump runs the whole step but uses no energy.
            poweredSeconds = step.dtS;
            energyUsedWh = 0;
        } else {
            // Overflow-safe energy: dtS/3600 is in [0,1], so this product
            // is <= drawW and stays finite for any finite drawW. The form
            // (drawW*dtS)/3600 can overflow to Infinity for valid inputs
            // (e.g. drawW = Number.MAX_VALUE, dtS = 3600).
            const fullStepWh = b.drawW * (step.dtS / 3600);
            if (fullStepWh >= b.chargeWh) {
                // Charge exhausted at or before the end of the step: run
                // until the exact exhaustion instant (fractional second
                // allowed) and use exactly the remaining charge. Entering
                // this branch implies drawW >= chargeWh, so the ratio below
                // is <= 1 and poweredSeconds <= 3600 (cannot overflow).
                poweredSeconds = (b.chargeWh / b.drawW) * 3600;
                energyUsedWh = b.chargeWh;
            } else {
                poweredSeconds = step.dtS;
                energyUsedWh = fullStepWh;
            }
        }
    }

    const newCharge = Math.min(b.capacityWh, Math.max(0, b.chargeWh - energyUsedWh));
    const low = newCharge <= b.capacityWh * b.lowFraction;
    return {
        battery: {
            capacityWh: b.capacityWh,
            chargeWh: newCharge,
            drawW: b.drawW,
            lowFraction: b.lowFraction
        },
        poweredSeconds: poweredSeconds,
        energyUsedWh: energyUsedWh,
        low: low,
        depleted: newCharge === 0
    };
}

module.exports = { createBattery, consume, MAX_DT_S, DEFAULT_LOW_FRACTION };
