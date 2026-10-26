// SeaGuard rescue EXERCISE controller — wraps the standalone rescue model
// (seaguard/src/rescue/model.cjs) in a deterministic local exercise:
//
//   - four guided scenarios: FLOODING, MAN_OVERBOARD, RADIO_FAILURE,
//     BOUNDARY_APPROACH (each with its own physics/actions — not all
//     flooding),
//   - its own simulated clock (independent of the main SeaGuard campaign):
//     start / pause / resume / speed 1..20,
//   - validated dispatch / reinforce / command / outage / pump-fault calls,
//   - delayed automatic sensor feedback (water level, pump state) that is
//     affected by the team link: reports queue during outages and arrive
//     with a one-way delay after the link is back,
//   - scenario actions: REPAIR (flooding: stop the ingress after on-scene
//     work), RETURN_SAFE (boundary: vessel turns back into safe water),
//     RADIO_REPAIR (radio: delayed repair of the vessel link),
//   - timeline and computed results (delays, verdicts, allClear).
//
// All exercise updates run in an internal ONE-SIM-SECOND loop so that
// speed changes, sensor sampling, repair progress and feedback delivery
// never skip transitions. Crew safety (people recovered) and vessel safety
// (water / position / radio conditions) are tracked separately; the
// exercise is green (allClear) only when every condition is actually safe
// and every team is home.
//
// Standalone CommonJS, zero dependencies, deterministic. Used by:
//   - fnRescue.js (dashboard publisher + command handler, Node-RED),
//   - fnRescueApi.js (loopback JSON API, Node-RED),
//   - seaguard/tests/rescue-exercise.mjs (unit tests).

'use strict';

const model = require('./model.cjs');
const energy = require('./battery.cjs');

const SCENARIOS = ['FLOODING', 'MAN_OVERBOARD', 'RADIO_FAILURE', 'BOUNDARY_APPROACH'];
const SPEEDS = [1, 2, 5, 10, 20];
const MAX_SPEED = 20;
const MAX_STEP_S = 300;
const HULL_REPAIR_S = 60;      // on-scene work to stop the ingress
const RADIO_REPAIR_S = 90;     // on-scene work to restore the vessel radio
const RETURN_SAFE_S = 60;      // vessel turns and steams back into safe water

// ---- nearby vessels (helpers) and the short-range radio relay -------------
//
// The default exercise world adds two finite nearby vessels N1/N2 at sea
// (status IDLE = available) on top of T1/T2, so the operator can request
// assistance from a passing boat and use one of them as a short-range radio
// RELAY for the vessel's own sensor reports. Helpers are ordinary model teams:
// same dispatch/reinforce, shared single-kit reservation, commands (pump /
// return) and home travel — no separate allocation path can double-book them.
// Custom team sets (options.teams) are used as given.
const HELPER_TEAMS = [
    { teamId: 'N1', name: 'Nearby helper 1', personnel: 2, speedKn: 8, fuelL: 30, pumpLpm: 10, eastKm: 0.2 },
    { teamId: 'N2', name: 'Nearby helper 2', personnel: 2, speedKn: 10, fuelL: 40, pumpLpm: 15, eastKm: 0.6 }
];
const HELPER_BATTERY = { capacityWh: 10, chargeWh: 10, drawW: 120 };
const GPS_FRESH_S = 30;              // helper GPS fix older than this: not dispatchable
const RELAY_VESSEL_KM = 0.6;         // helper must be this close to the vessel to relay
const RELAY_HARBOUR_KM = 2;          // ... and this close to the harbour
const RELAY_EXTRA_DELAY_S = 3;       // vessel -> helper -> shore adds this to the normal delay
const REPORT_QUEUE_MAX = 200;        // bounded backlog while no path is available
const KM_PER_HOUR_PER_KNOT = 1.852;  // exact: 1 knot = 1 nautical mile/hour (model.cjs)
const MODEL_FUEL_LPH_PER_KN = 8;     // model.cjs C.fuelLphPerKn: L/hour per knot

// Per-scenario exercise parameters (simulated, illustrative).
const SC = {
    FLOODING: {
        crew: 3, waterL: 20, ingressLpm: 25, distKm: 0.5,
        reportEveryS: 15, reportDelayS: 5
    },
    MAN_OVERBOARD: {
        crew: 2, waterL: 0, ingressLpm: 0, distKm: 0.8,
        reportEveryS: 15, reportDelayS: 5
    },
    RADIO_FAILURE: {
        crew: 2, waterL: 0, ingressLpm: 0, distKm: 1.0,
        repairDelayS: RADIO_REPAIR_S,
        reportEveryS: 15, reportDelayS: 5
    },
    BOUNDARY_APPROACH: {
        crew: 2, waterL: 0, ingressLpm: 0, distKm: 1.2,
        driftKmPerMin: 0.12, safeMarginKm: 0.05,
        reportEveryS: 15, reportDelayS: 5
    }
};

// Guided operator text shown in the view for the running scenario.
const GUIDANCE = {
    FLOODING: 'Water is rising on the exercise vessel. Dispatch a team with a recovery kit; when on scene, START_PUMP to slow the rise and REPAIR the hull to stop the ingress. The exercise is only green once the water is sensor-confirmed safe AND every team is home.',
    MAN_OVERBOARD: 'Crew are in the water. Only a team carrying a recovery kit can recover them. Resolution needs the automatic water-level sensor confirmation — do not mark anything green before the reports arrive.',
    RADIO_FAILURE: 'The vessel radio is down from the start, so its sensor reports queue. Dispatch a team; once on scene, RADIO_REPAIR (90s of on-scene work) restores the link and the queued reports arrive. Confirm the crew before anything is green.',
    BOUNDARY_APPROACH: 'The vessel is drifting toward the boundary. When it is out of safe water, send it back with RETURN_TO_SAFE_WATER (60s of steaming). It only stays safe once the return motion is finished and acknowledged.'
};

function isId(v) { return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(v); }
function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function isCoord(p) {
    return p !== null && typeof p === 'object' &&
        isFiniteNum(p.lat) && p.lat >= -90 && p.lat <= 90 &&
        isFiniteNum(p.lon) && p.lon >= -180 && p.lon <= 180;
}
function isPersonnel(v) { return Number.isSafeInteger(v) && v >= 0; }
function fail(action, msg) { throw new Error('exercise.' + action + ': ' + msg); }

function posEast(harbour, km) {
    return { lat: harbour.lat, lon: harbour.lon + km / (111.1949 * Math.cos(harbour.lat * Math.PI / 180)) };
}

function newExercise() {
    return {
        scenario: null,
        running: false,
        paused: false,
        speed: 1,
        simTime: 0,
        realAccum: 0,
        modelEventIndex: 0,
        restoredFromSnapshot: false,
        restoreWarning: null,
        restoreSource: null,
        startedAt: null,
        incidentId: null,
        vessel: { id: 'VX', name: 'Exercise vessel', pos: null, crewTotal: 0, crewRescued: 0,
            waterL: 0, ingressLpm: 0, radioUp: true, inSafeWater: true, repairDone: false },
        repair: { requestedAt: null, progressS: 0, done: false },
        radio: { repairRequestedAt: null, repairProgressS: 0, restored: false },
        returnSafe: { requestedAt: null, progressS: 0, done: false },
        helpers: [],                          // nearby-vessel metadata (default world)
        relay: { helperId: null },            // short-range radio relay selection
        relayStats: { delivered: 0, dropped: 0 },
        link: {
            pendingReports: [],
            lastReportAt: null,
            lastWaterReportAt: null,      // per sample timestamp, not a shared value
            lastPumpReport: {}            // per-team last reported pump state
        },
        marks: { detectedAt: null, acknowledgedAt: null, firstDispatchAt: null,
            firstArrivalAt: null, repairDoneAt: null, radioRestoredAt: null,
            returnSafeDoneAt: null, completed: false },
        timeline: [],
        results: null
    };
}

function createExercise(options = {}) {
    if (options === null || typeof options !== 'object') fail('create', 'options must be an object');
    const harbour = options.harbour || { lat: 9.28, lon: 79.335 };
    if (!isCoord(harbour)) fail('create', 'harbour must be a valid coordinate');
    const teams = options.teams || undefined; // model defaults: T1/T2
    const shared = options.shared || { recoveryKits: 1 };
    let state;
    try {
        state = model.createState({ harbour, teams: teams, shared: shared });
    } catch (e) {
        fail('create', e.message);
    }
    // Default world only: two finite nearby vessels at sea (IDLE = available).
    // Custom team sets are used as given — helpers are never injected.
    const helpers = [];
    if (!options.teams) {
        for (const h of HELPER_TEAMS) {
            state.teams.push({
                id: h.teamId, name: h.name, home: { ...harbour },
                capacity: h.personnel, personnel: h.personnel,
                pump: { available: true, lpm: h.pumpLpm },
                pumpBattery: energy.createBattery({ ...HELPER_BATTERY }),
                pumpRecharge: null, pumpLowAnnounced: false, pumpDepletedAnnounced: false,
                pumpFault: false, pumpRunning: false,
                fuelL: h.fuelL, speedKn: h.speedKn,
                status: 'IDLE', pos: posEast(harbour, h.eastKm),
                personnelAssigned: 0, outages: [],
                telemetry: { receivedFix: null, receivedAt: null, pending: [] }
            });
            helpers.push({ teamId: h.teamId, name: h.name, radioUp: true, available: true });
        }
    }
    const ex = newExercise();
    ex.harbour = { ...harbour };
    ex.helpers = helpers;
    return { state, ex };
}

function ensureRunning(ex, action) {
    if (!ex.scenario) fail(action, 'no exercise started; call start first');
}

function timeline(ex, kind, detail) {
    ex.timeline.push({ t: ex.simTime, kind, detail: detail || null });
}

function start(state, ex, input) {
    if (!input || typeof input !== 'object') fail('start', 'input must be an object');
    const { scenario, vesselId } = input;
    if (!SCENARIOS.includes(scenario)) fail('start', 'scenario must be one of ' + SCENARIOS.join(', '));
    if (vesselId !== undefined && !isId(vesselId)) fail('start', 'vesselId must be a valid id');
    if (ex.scenario) fail('start', 'an exercise is already running; finish or reset it first');
    // Fresh world: a new exercise must not inherit the previous one's teams/missions.
    const fresh = createExercise({ harbour: ex.harbour });
    const st = fresh.state;
    const ex2 = fresh.ex;
    const p = SC[scenario];
    const pos = posEast(ex.harbour, p.distKm);
    ex2.scenario = scenario;
    ex2.running = true;
    ex2.paused = false;
    ex2.speed = 1;
    ex2.startedAt = 0;
    ex2.vessel.id = vesselId || 'VX';
    ex2.vessel.pos = { ...pos };
    ex2.vessel.crewTotal = p.crew;
    ex2.vessel.waterL = p.waterL;
    ex2.vessel.ingressLpm = p.ingressLpm;
    // RADIO_FAILURE: the vessel radio is failed from the very first second —
    // nothing from the vessel can arrive until a team repairs it on scene.
    ex2.vessel.radioUp = scenario !== 'RADIO_FAILURE';
    ex2.radio.restored = scenario !== 'RADIO_FAILURE';
    ex2.vessel.inSafeWater = true; // BOUNDARY_APPROACH starts in safe water; drift takes it out
    ex2.incidentId = 'INC-' + scenario;
    // The model knows FLOODING / MAN_OVERBOARD / BOUNDARY_APPROACH; the radio
    // scenario is a man-overboard rescue whose link is down (mapping only —
    // the scenario itself is preserved in ex2.scenario).
    const kind = scenario === 'RADIO_FAILURE' ? 'MAN_OVERBOARD' : scenario;
    model.addIncident(st, {
        id: ex2.incidentId, kind: kind,
        position: pos, crewOnboard: p.crew, initialWaterL: p.waterL, ingressLpm: p.ingressLpm
    });
    ex2.marks.detectedAt = 0; // the exercise world detects the incident at t=0
    timeline(ex2, 'EXERCISE_STARTED', { scenario, crew: p.crew, radioUp: ex2.vessel.radioUp });
    // Swap the live references.
    state.teams = st.teams;
    state.shared = st.shared;
    state.incidents = st.incidents;
    state.missions = st.missions;
    state.commands = st.commands;
    state.events = st.events;
    state.counters = st.counters;
    state.time = st.time;
    state.harbour = st.harbour;
    state.version = st.version;
    Object.assign(ex, ex2);
    return view(state, ex);
}

function reset(state, ex) {
    // A deliberate reset may update the retired illustrative default. Never move
    // an in-progress restored exercise or a caller's custom launch coordinates.
    const retiredDefault = ex.harbour.lat === 9.2876 && ex.harbour.lon === 79.3129;
    const fresh = createExercise(retiredDefault ? {} : { harbour: ex.harbour });
    state.harbour = { ...fresh.state.harbour };
    state.teams = fresh.state.teams;
    state.shared = fresh.state.shared;
    state.incidents = fresh.state.incidents;
    state.missions = fresh.state.missions;
    state.commands = fresh.state.commands;
    state.events = fresh.state.events;
    state.counters = fresh.state.counters;
    state.time = fresh.state.time;
    state.version = fresh.state.version;
    Object.assign(ex, fresh.ex);
    return view(state, ex);
}

function pause(state, ex) {
    ensureRunning(ex, 'pause');
    ex.paused = true;
    timeline(ex, 'PAUSED');
    return view(state, ex);
}

function resume(state, ex) {
    ensureRunning(ex, 'resume');
    ex.paused = false;
    timeline(ex, 'RESUMED');
    return view(state, ex);
}

function setSpeed(state, ex, input) {
    ensureRunning(ex, 'setSpeed');
    const speed = (input && typeof input === 'object') ? input.speed : input;
    if (!SPEEDS.includes(speed)) fail('setSpeed', 'speed must be one of ' + SPEEDS.join(', '));
    ex.speed = speed;
    timeline(ex, 'SPEED', { speed });
    return view(state, ex);
}

// ---- dispatch / reinforce / commands (all validated, incident-linked) ----

function dispatch(state, ex, input) {
    ensureRunning(ex, 'dispatch');
    if (!input || typeof input !== 'object') fail('dispatch', 'input must be an object');
    const { teamId, personnel, recoveryKit } = input;
    if (!isId(teamId)) fail('dispatch', 'teamId must be a valid id');
    if (!isPersonnel(personnel) || personnel < 1) fail('dispatch', 'personnel must be a safe integer >= 1');
    if (typeof recoveryKit !== 'boolean') fail('dispatch', 'recoveryKit must be a boolean');
    if ((ex.helpers || []).some(h => h.teamId === teamId)) {
        // Nearby vessels go through the assistance path: received-GPS
        // freshness, helper health/availability and the round-trip fuel
        // check all apply — a bare model.dispatch would bypass them.
        return requestAssistance(state, ex, { helperId: teamId, personnel, recoveryKit });
    }
    const m = model.dispatch(state, { incidentId: ex.incidentId, teamId, personnel, recoveryKit });
    if (ex.marks.firstDispatchAt === null) ex.marks.firstDispatchAt = ex.simTime;
    timeline(ex, 'DISPATCHED', { mission: m.id, team: teamId, personnel, recoveryKit });
    return view(state, ex);
}

function reinforce(state, ex, input) {
    ensureRunning(ex, 'reinforce');
    if (!input || typeof input !== 'object') fail('reinforce', 'input must be an object');
    const { teamId, personnel, recoveryKit } = input;
    if (!isId(teamId)) fail('reinforce', 'teamId must be a valid id');
    if (!isPersonnel(personnel) || personnel < 1) fail('reinforce', 'personnel must be a safe integer >= 1');
    if (typeof recoveryKit !== 'boolean') fail('reinforce', 'recoveryKit must be a boolean');
    if ((ex.helpers || []).some(h => h.teamId === teamId))
        fail('reinforce', 'helper ' + teamId + ' cannot be reinforced; use the assistance action (requestAssistance)');
    const m = model.reinforce(state, { incidentId: ex.incidentId, teamId, personnel, recoveryKit });
    timeline(ex, 'REINFORCED', { mission: m.id, team: teamId, personnel, recoveryKit });
    return view(state, ex);
}

function command(state, ex, input) {
    ensureRunning(ex, 'command');
    if (!input || typeof input !== 'object') fail('command', 'input must be an object');
    const { teamId, action } = input;
    if (!isId(teamId)) fail('command', 'teamId must be a valid id');
    if (!model.ACTIONS.includes(action)) fail('command', 'action must be one of ' + model.ACTIONS.join(', '));
    const c = model.command(state, { incidentId: ex.incidentId, teamId, action });
    if (action === 'ACKNOWLEDGE' && ex.marks.acknowledgedAt === null) {
        ex.marks.acknowledgedAt = ex.simTime;
    }
    timeline(ex, 'COMMAND_SENT', { command: c.id, team: teamId, action });
    return view(state, ex);
}

function setOutage(state, ex, input) {
    ensureRunning(ex, 'setOutage');
    if (!input || typeof input !== 'object') fail('setOutage', 'input must be an object');
    const { teamId, fromS, toS } = input;
    if (!isId(teamId)) fail('setOutage', 'teamId must be a valid id');
    if (!isFiniteNum(fromS) || fromS < 0) fail('setOutage', 'fromS must be finite >= 0');
    if (!isFiniteNum(toS) || toS <= fromS) fail('setOutage', 'toS must be finite > fromS');
    model.setOutage(state, { teamId, fromS: ex.simTime + fromS, toS: ex.simTime + toS });
    timeline(ex, 'OUTAGE_SET', { team: teamId, fromS: ex.simTime + fromS, toS: ex.simTime + toS });
    return view(state, ex);
}

function setPumpFault(state, ex, input) {
    ensureRunning(ex, 'setPumpFault');
    if (!input || typeof input !== 'object') fail('setPumpFault', 'input must be an object');
    const { teamId, fault } = input;
    if (!isId(teamId)) fail('setPumpFault', 'teamId must be a valid id');
    if (typeof fault !== 'boolean') fail('setPumpFault', 'fault must be a boolean');
    model.setPumpFault(state, { teamId, fault });
    timeline(ex, 'PUMP_FAULT_SET', { teamId, fault });
    return view(state, ex);
}

// ---- scenario-specific actions (each scenario behaves differently) ----

function onSceneTeams(state, ex) {
    return state.missions
        .filter(m => m.incidentId === ex.incidentId && m.status === 'ON_SCENE')
        .map(m => m.teamId);
}

function repair(state, ex) {
    // FLOODING only: the crew repairs the hull and stops the ingress. The
    // repair takes HULL_REPAIR_S of CONTINUOUS on-scene work: if no assigned
    // team is on scene the work pauses (progress is kept, not lost).
    ensureRunning(ex, 'repair');
    if (ex.scenario !== 'FLOODING') fail('repair', 'repair is only available in the FLOODING scenario');
    if (ex.repair.done) fail('repair', 'the hull is already repaired');
    if (ex.repair.requestedAt === null) ex.repair.requestedAt = ex.simTime;
    timeline(ex, 'REPAIR_STARTED', { workS: HULL_REPAIR_S });
    return view(state, ex);
}

function returnSafe(state, ex) {
    // BOUNDARY_APPROACH only: the vessel steams back into safe water over
    // RETURN_SAFE_S of continuous motion. It is not safe until the motion
    // actually finishes, and the action requires an ACKNOWLEDGE delivery
    // (unless the vessel radio is down, in which case the order is local).
    ensureRunning(ex, 'returnSafe');
    if (ex.scenario !== 'BOUNDARY_APPROACH') fail('returnSafe', 'return-to-safe-water is only available in the BOUNDARY_APPROACH scenario');
    if (ex.vessel.inSafeWater) fail('returnSafe', 'the vessel is already in safe water');
    if (ex.returnSafe.requestedAt === null) {
        ex.returnSafe.requestedAt = ex.simTime;
        ex.returnSafe.startPos = { ...ex.vessel.pos };
    }
    timeline(ex, 'RETURN_SAFE_STARTED', { workS: RETURN_SAFE_S });
    return view(state, ex);
}

function radioRepair(state, ex) {
    // RADIO_FAILURE only: restoring the vessel link takes RADIO_REPAIR_S of
    // CONTINUOUS on-scene work by an assigned team; it pauses if they leave.
    ensureRunning(ex, 'radioRepair');
    if (ex.scenario !== 'RADIO_FAILURE') fail('radioRepair', 'radio repair is only available in the RADIO_FAILURE scenario');
    if (ex.radio.restored) fail('radioRepair', 'the radio link is already restored');
    if (ex.radio.repairRequestedAt === null) ex.radio.repairRequestedAt = ex.simTime;
    timeline(ex, 'RADIO_REPAIR_STARTED', { workS: RADIO_REPAIR_S });
    return view(state, ex);
}

function recharge(state, ex, input) {
    ensureRunning(ex, 'recharge');
    // Battery replacement at harbour (illustrative simulated 60s change —
    // not a physical charge model). model.recharge validates that the team is
    // IDLE at harbour and not already recharging. An explicit replacement
    // resumes a paused exercise clock so the countdown can finish.
    model.recharge(state, { teamId: input && input.teamId });
    timeline(ex, 'RECHARGE_REQUESTED', { team: input.teamId });
    if (ex.scenario && ex.paused) ex.paused = false;
    return view(state, ex);
}

// ---- nearby vessels: assistance requests and the short-range relay --------

function helperTeam(state, ex, helperId) {
    if (!isId(helperId)) return null;
    const meta = (ex.helpers || []).find(h => h.teamId === helperId);
    const team = state.teams.find(t => t.id === helperId);
    return meta && team ? { meta, team } : null;
}

function relayPath(state, ex) {
    // A valid short-range relay path needs: relay enabled on a KNOWN helper
    // whose radio is up, the helper healthy (fuel, not NO_FUEL), no outage on
    // the helper's channel, the helper within RELAY_VESSEL_KM of the vessel
    // AND within RELAY_HARBOUR_KM of the harbour. The relay is a BACKUP path
    // only: it never repairs the vessel's main radio.
    const rid = ex.relay && ex.relay.helperId;
    if (!rid) return { ok: false, reason: 'no relay selected' };
    const h = helperTeam(state, ex, rid);
    if (!h) return { ok: false, reason: 'relay helper unknown' };
    const inc = state.incidents[ex.incidentId];
    const vesselPos = inc ? inc.position : (ex.vessel.pos || null);
    if (!vesselPos) return { ok: false, reason: 'no vessel position' };
    if (!h.meta.radioUp) return { ok: false, reason: 'relay helper radio down' };
    if (!h.meta.available) return { ok: false, reason: 'relay helper unavailable' };
    if (h.team.status === 'NO_FUEL' || h.team.fuelL <= 0) return { ok: false, reason: 'relay helper unhealthy' };
    if (teamOutageNow(state, h.team.id, state.time)) return { ok: false, reason: 'relay helper in outage' };
    const dVessel = model.distanceKm(h.team.pos, vesselPos);
    if (dVessel > RELAY_VESSEL_KM) return { ok: false, reason: 'relay helper > ' + RELAY_VESSEL_KM + ' km from vessel' };
    const dHarbour = model.distanceKm(h.team.pos, state.harbour);
    if (dHarbour > RELAY_HARBOUR_KM) return { ok: false, reason: 'relay helper > ' + RELAY_HARBOUR_KM + ' km from harbour' };
    return { ok: true, reason: null, helperId: rid, distanceToVesselKm: dVessel, distanceToHarbourKm: dHarbour };
}

function requestAssistance(state, ex, input) {
    ensureRunning(ex, 'requestAssistance');
    if (!input || typeof input !== 'object') fail('requestAssistance', 'input must be an object');
    const { helperId, personnel, recoveryKit } = input;
    const h = helperTeam(state, ex, helperId);
    if (!h) fail('requestAssistance', 'unknown helper ' + JSON.stringify(helperId) + ' (only default-world nearby vessels can assist)');
    if (!h.meta.available) fail('requestAssistance', 'helper ' + helperId + ' is marked unavailable');
    if (!h.meta.radioUp) fail('requestAssistance', 'helper ' + helperId + ' radio is down');
    if (!isCoord(h.team.pos)) fail('requestAssistance', 'helper ' + helperId + ' has no finite position');
    if (h.team.status === 'NO_FUEL' || h.team.fuelL <= 0) fail('requestAssistance', 'helper ' + helperId + ' has no usable fuel');
    if (h.team.personnelAssigned > 0) fail('requestAssistance', 'helper ' + helperId + ' is already assigned');
    if (h.team.status !== 'IDLE') fail('requestAssistance', 'helper ' + helperId + ' is ' + h.team.status + ', not available');
    if (h.team.pumpRecharge) fail('requestAssistance', 'helper ' + helperId + ' is mid battery replacement');
    // The operator only knows the helper from its RECEIVED GPS fixes: the last
    // received fix must be fresh (<= GPS_FRESH_S) before a boat can be tasked.
    const fix = h.team.telemetry.receivedFix;
    if (!fix) fail('requestAssistance', 'helper ' + helperId + ' has no received GPS fix yet');
    const ageS = state.time - fix.sentAt;
    if (ageS > GPS_FRESH_S) fail('requestAssistance', 'helper ' + helperId + ' GPS fix is ' + Math.round(ageS) + 's old (max ' + GPS_FRESH_S + 's)');
    if (!Number.isSafeInteger(personnel) || personnel < 1)
        fail('requestAssistance', 'personnel must be an integer >= 1');
    if (personnel > h.team.personnel - h.team.personnelAssigned)
        fail('requestAssistance', 'helper ' + helperId + ' has only ' + (h.team.personnel - h.team.personnelAssigned) + ' personnel available');
    if (typeof recoveryKit !== 'boolean') fail('requestAssistance', 'recoveryKit must be a boolean');
    const inc = state.incidents[ex.incidentId];
    if (!inc || inc.status === 'RESOLVED') fail('requestAssistance', 'no open incident to assist');
    // Finite fuel check: the helper must be able to make the ACTUAL round
    // trip — out to the incident, then back to its home (the harbour). The
    // helper starts offshore, so the home leg is distance(incident, home),
    // not a mirror of the outbound leg; assuming 2*out could under-reserve
    // fuel and strand the helper on the way home.
    const there = model.distanceKm(h.team.pos, inc.position);
    const back = model.distanceKm(inc.position, h.team.home);
    // The model burns speedKn * MODEL_FUEL_LPH_PER_KN L/h; a leg of d km
    // takes d / (speedKn * 1.852) hours, so the speed cancels:
    const fuelNeeded = (there + back) / KM_PER_HOUR_PER_KNOT * MODEL_FUEL_LPH_PER_KN;
    if (h.team.fuelL < fuelNeeded)
        fail('requestAssistance', 'helper ' + helperId + ' fuel ' + h.team.fuelL.toFixed(1) + ' L cannot cover the round trip (' + fuelNeeded.toFixed(1) + ' L for ' + there.toFixed(2) + ' km out + ' + back.toFixed(2) + ' km home)');
    // Real model dispatch: the helper travels, works on scene (manpower and
    // pump affect outcomes through the normal model), and returns to harbour
    // via the existing RETURN command. No instantaneous rescue.
    const m = model.dispatch(state, { incidentId: ex.incidentId, teamId: helperId, personnel, recoveryKit });
    if (ex.marks.firstDispatchAt === null) ex.marks.firstDispatchAt = ex.simTime;
    timeline(ex, 'ASSISTANCE_REQUESTED', { helper: helperId, mission: m.id, personnel, recoveryKit });
    return view(state, ex);
}

function setRelay(state, ex, input) {
    ensureRunning(ex, 'setRelay');
    if (!input || typeof input !== 'object') fail('setRelay', 'input must be an object');
    const { helperId } = input;
    if (helperId === null) {
        ex.relay.helperId = null;
        timeline(ex, 'RELAY_DISABLED');
        return view(state, ex);
    }
    const h = helperTeam(state, ex, helperId);
    if (!h) fail('setRelay', 'unknown helper ' + JSON.stringify(helperId));
    if (!h.meta.available) fail('setRelay', 'helper ' + helperId + ' is marked unavailable');
    if (h.team.status === 'NO_FUEL' || h.team.fuelL <= 0) fail('setRelay', 'helper ' + helperId + ' is not healthy');
    if (!h.meta.radioUp) fail('setRelay', 'helper ' + helperId + ' radio is down');
    ex.relay.helperId = helperId;
    timeline(ex, 'RELAY_ENABLED', { helper: helperId });
    return view(state, ex);
}

function helperCandidates(state, ex) {
    // Read-only candidate list for the UI: distance/ETA from the LAST RECEIVED
    // GPS fix, fix freshness, status, free crew and equipment.
    const inc = state.incidents[ex.incidentId];
    return (ex.helpers || []).map(meta => {
        const team = state.teams.find(t => t.id === meta.teamId);
        if (!team) return { teamId: meta.teamId, name: meta.name, radioUp: meta.radioUp, available: false, status: 'UNKNOWN' };
        const fix = team.telemetry.receivedFix;
        const knownPos = fix ? fix.pos : null;
        const ageS = fix ? state.time - fix.sentAt : null;
        const distKm = knownPos && inc ? model.distanceKm(knownPos, inc.position) : null;
        // model.travelSeconds is not exported: same formula as model.cjs.
        const etaS = knownPos && inc ? model.distanceKm(knownPos, inc.position) / (team.speedKn * KM_PER_HOUR_PER_KNOT) * 3600 : null;
        const busy = state.missions.some(m => m.teamId === team.id && (m.status === 'EN_ROUTE' || m.status === 'ON_SCENE' || m.status === 'RETURNING'));
        return {
            teamId: meta.teamId, name: meta.name, radioUp: meta.radioUp,
            available: meta.available && meta.radioUp && team.status === 'IDLE' && !team.pumpRecharge && !busy &&
                team.fuelL > 0 && !!fix && ageS <= GPS_FRESH_S,
            status: team.status,
            gps: fix ? { pos: { ...fix.pos }, ageS, stale: ageS > GPS_FRESH_S } : null,
            distanceKm: distKm === null ? null : +distKm.toFixed(3),
            etaS: etaS === null ? null : Math.ceil(etaS),
            crewFree: team.personnel - team.personnelAssigned,
            fuelL: team.fuelL,
            pumpLpm: team.pump.lpm,
            kitHeld: state.missions.some(m => m.teamId === team.id && m.recoveryKit && m.status !== 'COMPLETED')
        };
    });
}

// ---- deterministic simulated-time step ----
//
// `realDeltaS` is wall-clock seconds accumulated by the caller (the 1-second
// inject in the flow). The exercise advances min(realDeltaS * speed,
// MAX_STEP_S) simulated seconds, but ALWAYS in one-sim-second substeps so
// speed changes can never skip sensor sampling, repair progress, feedback
// delivery or the delayed scenario motions.

function vesselRadioUp(ex, state) {
    if (ex.scenario !== 'RADIO_FAILURE') return true;
    if (ex.radio.restored) return true;
    // While a team is on scene, work proceeds — but the link stays down until
    // the full RADIO_REPAIR_S of continuous work is done.
    return false;
}

function teamOutageNow(state, teamId, t) {
    const team = state.teams.find(x => x.id === teamId);
    if (!team) return false;
    return team.outages.some(o => t >= o.fromS && t < o.toS);
}

// One simulated second of exercise life. All scenario physics, feedback and
// completion logic lives here so it is identical at any speed.
function substep1(state, ex) {
    ex.simTime += 1;
    const t = ex.simTime;
    model.tick(state, 1);
    // All-clear already reached: keep the clock alive only while a battery
    // replacement is pending, then auto-pause again once none remain.
    if (ex.marks.completed && ex.results && ex.results.allClear && !ex.paused &&
        !state.teams.some(x => x.pumpRecharge)) ex.paused = true;
    const visibleEvents = new Set(['ARRIVED','RETURNED','NO_FUEL','CMD_RECEIVED','CMD_EXECUTED','CMD_CONFIRMED','CMD_FAILED','RESOLVED','REOPENED','LOW_BATTERY','BATTERY_DEPLETED','RECHARGE_START','RECHARGE_COMPLETE']);
    for (const e of state.events.slice(ex.modelEventIndex || 0)) {
        if (visibleEvents.has(e.kind)) ex.timeline.push({ t: e.t, kind: e.kind, detail: e.detail });
    }
    ex.modelEventIndex = state.events.length;
    if (state.events.length > 4000) {
        state.events.splice(0, state.events.length - 4000);
        ex.modelEventIndex = state.events.length;
    }
    if (ex.timeline.length > 4000) ex.timeline.splice(0, ex.timeline.length - 4000);

    const inc = state.incidents[ex.incidentId];
    const p = SC[ex.scenario];

    // First arrival mark.
    if (ex.marks.firstArrivalAt === null &&
        state.missions.some(m => m.incidentId === ex.incidentId && m.status !== 'EN_ROUTE' && m.arrivedAt !== null)) {
        ex.marks.firstArrivalAt = t;
    }

    // FLOODING: hull repair needs continuous on-scene work.
    if (ex.scenario === 'FLOODING' && ex.repair.requestedAt !== null && !ex.repair.done) {
        if (onSceneTeams(state, ex).length > 0) ex.repair.progressS += 1;
        if (ex.repair.progressS >= HULL_REPAIR_S) {
            ex.repair.done = true;
            ex.marks.repairDoneAt = t;
            inc.ingressLpm = 0;
            timeline(ex, 'HULL_REPAIRED', { ingressStopped: true });
        }
    }

    // RADIO_FAILURE: radio repair needs continuous on-scene work.
    if (ex.scenario === 'RADIO_FAILURE' && ex.radio.repairRequestedAt !== null && !ex.radio.restored) {
        if (onSceneTeams(state, ex).length > 0) ex.radio.repairProgressS += 1;
        if (ex.radio.repairProgressS >= RADIO_REPAIR_S) {
            ex.radio.restored = true;
            ex.vessel.radioUp = true;
            ex.marks.radioRestoredAt = t;
            timeline(ex, 'RADIO_RESTORED');
        }
    }

    // BOUNDARY_APPROACH: continuous drift out, continuous return motion in.
    if (ex.scenario === 'BOUNDARY_APPROACH') {
        if (ex.vessel.driftKm === undefined) ex.vessel.driftKm = 0;
        if (ex.returnSafe.requestedAt !== null && !ex.returnSafe.done) {
            // Return motion: 60s of steaming back toward the safe coordinate.
            ex.returnSafe.progressS += 1;
            const f = ex.returnSafe.progressS / RETURN_SAFE_S;
            // Interpolate from the position where the return started back to
            // the safe-water position (the incident line minus the margin).
            const startPos = ex.returnSafe.startPos || ex.vessel.pos;
            const safePos = posEast(ex.harbour, p.distKm - p.safeMarginKm);
            ex.vessel.pos = {
                lat: startPos.lat + (safePos.lat - startPos.lat) * f,
                lon: startPos.lon + (safePos.lon - startPos.lon) * f
            };
            if (f >= 1) {
                ex.returnSafe.done = true;
                ex.vessel.pos = { ...safePos };
                ex.vessel.inSafeWater = true;
                ex.marks.returnSafeDoneAt = t;
                timeline(ex, 'RETURNED_SAFE_WATER');
            }
        } else if (ex.returnSafe.requestedAt === null) {
            // Still drifting outward (cumulative distance, not per-tick delta).
            ex.vessel.driftKm += p.driftKmPerMin / 60;
            ex.vessel.pos = posEast(ex.harbour, p.distKm + ex.vessel.driftKm);
            ex.vessel.inSafeWater = ex.vessel.driftKm <= p.safeMarginKm;
        }
    }

    // ---- Automatic sensor feedback (vessel -> shore), per-second ----
    //
    // The vessel's own instruments report through the vessel link:
    //   - WATER_LEVEL every p.reportEveryS, carrying the SAMPLE timestamp,
    //   - PUMP_STATE per team, when that team's pump state changes,
    //     tracked in a PER-TEAM cache (one team's report never suppresses
    //     another team's).
    // A report only leaves the vessel while the vessel radio is up; it then
    // arrives shore-side after p.reportDelayS. Team outages block the
    // shore-side team channel: a PUMP_STATE report from a team is dropped
    // (re-sampled later) if that team is in outage when it would arrive.
    const radioUp = vesselRadioUp(ex, state);
    const relay = relayPath(state, ex);
    // The report's CURRENT route: 'direct' (main radio), the relay helper's
    // teamId (short-range backup), or null while no path is available.
    const route = radioUp ? 'direct' : (relay.ok ? relay.helperId : null);
    if (t - (ex.link.lastReportAt === null ? -Infinity : ex.link.lastReportAt) >= p.reportEveryS) {
        ex.link.lastReportAt = t;
        // SAMPLES are always taken and always ENQUEUED, even while the main
        // vessel radio is down (and while no relay path is up): the backlog is
        // bounded (REPORT_QUEUE_MAX) and the oldest samples are dropped with an
        // explicit count. Delivery below still requires a current valid path.
        if (ex.link.pendingReports.length >= REPORT_QUEUE_MAX) {
            ex.link.pendingReports.shift();
            ex.relayStats.dropped += 1;
            timeline(ex, 'REPORT_QUEUE_DROPPED', { backlog: ex.link.pendingReports.length });
        }
        ex.link.lastWaterReportAt = t;
        ex.link.pendingReports.push({
            kind: 'WATER_LEVEL', value: inc.waterL, sampleAt: t,
            arriveAt: null, route: null, relayed: false
        });
        for (const m of state.missions) {
            if (m.incidentId !== ex.incidentId || m.status !== 'ON_SCENE') continue;
            const team = state.teams.find(x => x.id === m.teamId);
            const running = team.pumpRunning;
            const last = ex.link.lastPumpReport[m.teamId];
            if (running !== last) {
                ex.link.lastPumpReport[m.teamId] = running;
                if (ex.link.pendingReports.length >= REPORT_QUEUE_MAX) {
                    ex.link.pendingReports.shift();
                    ex.relayStats.dropped += 1;
                    timeline(ex, 'REPORT_QUEUE_DROPPED', { backlog: ex.link.pendingReports.length });
                }
                ex.link.pendingReports.push({
                    kind: 'PUMP_STATE', value: running ? 'on' : 'off', teamId: m.teamId,
                    sampleAt: t, sentAt: t, arriveAt: null, route: null, relayed: false
                });
            }
        }
    }
    // A report leaves the vessel only while a path is available: the direct
    // main radio (normal p.reportDelayS) or the short-range relay (adds
    // RELAY_EXTRA_DELAY_S). The relay is a BACKUP path — it does NOT repair
    // the main radio and does NOT make the scenario vessel-safe. While no path
    // is available the reports HOLD in the backlog; when a path appears the
    // delivery delay is scheduled again (retaining the original sampleAt, so a
    // stale sample can never masquerade as fresh). Existing team-channel
    // outage handling at delivery is unchanged.
    for (const r of ex.link.pendingReports) {
        if (r.arriveAt !== null && r.route === route) continue; // same path: keep due time
        // No path yet, or the path changed (direct <-> relay, helper switch,
        // or loss): restart the delivery delay on the CURRENT path, keeping
        // the original sampleAt so a stale sample never masquerades as fresh.
        r.arriveAt = null;
        if (route === null) continue;
        r.route = route;
        r.relayed = route !== 'direct';
        r.arriveAt = t + (r.relayed ? p.reportDelayS + RELAY_EXTRA_DELAY_S : p.reportDelayS);
    }
    // Deliver due reports (a report is due only once a path scheduled it and
    // the path is still of the same kind — see above).
    const keep = [];
    for (const r of ex.link.pendingReports) {
        if (r.arriveAt !== null && t >= r.arriveAt && r.route === route) {
            if (r.kind === 'PUMP_STATE' && teamOutageNow(state, r.teamId, t)) {
                // Team channel down at arrival: the report is lost, the team's
                // pump state will be re-sampled on a later report interval.
                ex.link.lastPumpReport[r.teamId] = undefined;
                timeline(ex, 'SENSOR_DROPPED', { kind: r.kind, team: r.teamId, reason: 'team outage' });
                continue;
            }
            if (r.kind === 'WATER_LEVEL') {
                model.sensorReport(state, { incidentId: ex.incidentId, kind: 'WATER_LEVEL', value: r.value, sampleAt: r.sampleAt });
            } else if (r.kind === 'PUMP_STATE') {
                model.sensorReport(state, { incidentId: ex.incidentId, kind: 'PUMP_STATE', value: r.value, teamId: r.teamId, sampleAt: r.sampleAt ?? r.sentAt });
            }
            if (r.relayed) ex.relayStats.delivered += 1;
            timeline(ex, 'SENSOR_RECEIVED', { kind: r.kind, value: r.value, at: t, sampleAt: r.sampleAt || null, relayed: r.relayed });
        } else {
            keep.push(r);
        }
    }
    ex.link.pendingReports = keep;

    // Mirror vessel facts from the incident.
    ex.vessel.crewRescued = inc.crewRescued;
    ex.vessel.waterL = inc.waterL;
    ex.vessel.ingressLpm = inc.ingressLpm;
}

function step(state, ex, input = {}) {
    if (!ex.scenario) return view(state, ex); // idle: nothing to advance
    if (ex.paused) return view(state, ex);
    const realDeltaS = (input && isFiniteNum(input.realDeltaS)) ? input.realDeltaS : 1;
    if (realDeltaS <= 0) return view(state, ex);
    const simDeltaS = Math.min(Math.round(realDeltaS * ex.speed), MAX_STEP_S);
    for (let i = 0; i < simDeltaS; i++) substep1(state, ex);

    // Completion: the incident resolves via the model's sensor-confirmed
    // rules; scenario-specific vessel-safety conditions are folded into the
    // results and the view.
    const inc = state.incidents[ex.incidentId];
    if (inc.status === 'RESOLVED' || ex.results) {
        computeResults(state, ex);
    }
    return view(state, ex);
}

function scenarioVesselSafe(state, ex) {
    const inc = state.incidents[ex.incidentId];
    const base = inc.vesselSafe && ex.vessel.inSafeWater;
    if (ex.scenario === 'RADIO_FAILURE') return base && ex.vessel.radioUp;
    if (ex.scenario === 'BOUNDARY_APPROACH') return base && ex.vessel.inSafeWater;
    return base;
}

function computeResults(state, ex) {
    const inc = state.incidents[ex.incidentId];
    const marks = ex.marks;
    const vesselSafe = scenarioVesselSafe(state, ex);
    const crewSafe = inc.crewRescued >= inc.crewOnboard;
    const teamsHome = !state.missions.some(m => ['EN_ROUTE', 'ON_SCENE', 'RETURNING'].includes(m.status));
    const results = {
        scenario: ex.scenario,
        resolved: inc.status === 'RESOLVED',
        crewSafe, vesselSafe,
        allClear: inc.status === 'RESOLVED' && crewSafe && vesselSafe && teamsHome &&
            !state.teams.some(t => t.status === 'NO_FUEL'),
        delays: {
            detectionS: marks.detectedAt === null ? null : marks.detectedAt,
            acknowledgementS: marks.acknowledgedAt === null ? null : marks.acknowledgedAt - (marks.detectedAt || 0),
            dispatchS: marks.firstDispatchAt === null ? null : marks.firstDispatchAt,
            arrivalS: marks.firstArrivalAt === null ? null : marks.firstArrivalAt,
            repairS: marks.repairDoneAt === null ? null : HULL_REPAIR_S,
            resolutionS: inc.resolvedAt === null ? null : inc.resolvedAt
        },
        crew: { onboard: inc.crewOnboard, rescued: inc.crewRescued },
        water: { levelL: inc.waterL, ingressLpm: inc.ingressLpm },
        radio: ex.scenario === 'RADIO_FAILURE' ? {
            restored: ex.radio.restored,
            restoredAt: marks.radioRestoredAt
        } : null,
        repair: ex.scenario === 'FLOODING' ? {
            done: ex.repair.done,
            doneAt: marks.repairDoneAt
        } : null,
        returnSafe: ex.scenario === 'BOUNDARY_APPROACH' ? {
            done: ex.returnSafe.done,
            doneAt: marks.returnSafeDoneAt
        } : null,
        helpers: {
            dispatches: state.missions.filter(m => (ex.helpers || []).some(h => h.teamId === m.teamId)).length
        },
        relay: { delivered: ex.relayStats.delivered, dropped: ex.relayStats.dropped }
    };
    ex.results = results;
    if (results.allClear && !marks.completed) {
        marks.completed = true;
        timeline(ex, 'EXERCISE_COMPLETE', { crewSafe, vesselSafe });
        // Auto-pause only when no battery replacement is pending; a pending
        // recharge keeps the clock alive until it completes (see substep1).
        if (!state.teams.some(x => x.pumpRecharge)) ex.paused = true;
    }
    return results;
}

// ---- read-only view (what the UI and API show) ----

function missionEta(m, state) {
    if (m.status === 'EN_ROUTE') {
        return Math.max(0, m.arriveAt - state.time);
    }
    if (m.status === 'RETURNING' && m.returnDepartedAt !== null && m.returnTravelS !== null) {
        return Math.max(0, (m.returnDepartedAt + m.returnTravelS) - state.time);
    }
    return null;
}

function view(state, ex) {
    const st = model.status(state);
    const inc = ex.incidentId ? state.incidents[ex.incidentId] : null;
    const helperIds = new Set((ex.helpers || []).map(h => h.teamId));
    const teams = st.teams.map(t => {
        const raw = state.teams.find(x => x.id === t.id);
        return {
            id: t.id, name: t.name, status: t.status,
            pos: t.pos, fuelL: t.fuelL, speedKn: t.speedKn,
            personnel: t.personnel, pump: t.pump,
            telemetry: t.telemetry,
            helper: helperIds.has(t.id),
            atHome: raw ? model.distanceKm(raw.pos, raw.home) < 0.001 : false
        };
    });
    const missions = st.missions.map(m => {
        const team = state.teams.find(x => x.id === m.teamId);
        const etaS = missionEta(state.missions.find(raw => raw.id === m.id), state);
        return {
            id: m.id, teamId: m.teamId, purpose: m.purpose,
            personnel: m.personnel, recoveryKit: m.recoveryKit,
            status: m.status, departedAt: m.departedAt, arrivedAt: m.arrivedAt,
            completedAt: m.completedAt, etaS,
            distanceKm: team && (m.status === 'EN_ROUTE' || m.status === 'RETURNING')
                ? model.distanceKm(team.pos, m.status === 'EN_ROUTE' ? (inc ? inc.position : team.home) : team.home) : 0
        };
    });
    const commands = st.commands.map(c => ({
        id: c.id, teamId: c.teamId, missionId: c.missionId, action: c.action,
        status: c.status, sentAt: c.sentAt, receivedAt: c.receivedAt,
        executedAt: c.executedAt, confirmedAt: c.confirmedAt,
        failedAt: c.failedAt, failReason: c.failReason
    }));
    // Scenario safety beyond the generic water/crew rules.
    const unsafe = inc && inc.status !== 'RESOLVED' ? [
        ...(inc.crewRescued < inc.crewOnboard ? ['CREW_UNRESCUED'] : []),
        ...(!inc.vesselSafe ? ['WATER_ABOVE_SAFE'] : []),
        ...(!inc.sensorConfirmed ? ['NOT_SENSOR_CONFIRMED'] : [])
    ] : (inc ? [] : undefined);
    if (inc && ex.scenario === 'RADIO_FAILURE' && !ex.vessel.radioUp) unsafe.push('RADIO_DOWN');
    if (inc && ex.scenario === 'BOUNDARY_APPROACH' && !ex.vessel.inSafeWater) unsafe.push('OUT_OF_SAFE_WATER');
    return {
        scenario: ex.scenario,
        running: ex.running,
        paused: ex.paused,
        speed: ex.speed,
        simTime: ex.simTime,
        startedAt: ex.startedAt,
        allClear: ex.scenario
            ? !!(ex.results && ex.results.allClear)
            : st.allClear,
        limits: st.limits,
        harbour: st.harbour,
        guidance: ex.scenario ? GUIDANCE[ex.scenario] : null,
        sensors: inc ? { waterSampleAt: inc.lastWater ? inc.lastWater.at : null, waterAgeS: inc.lastWater ? state.time - inc.lastWater.at : null,
            stale: !inc.lastWater || state.time - inc.lastWater.at > st.limits.staleAfterS,
            disagreement: !!inc.lastWater && Math.abs(inc.lastWater.value - inc.waterL) > 15 } : null,
        teams,
        shared: st.shared,
        incident: inc ? {
            id: inc.id, kind: inc.kind, status: inc.status,
            position: inc.position, crewOnboard: inc.crewOnboard,
            crewRescued: inc.crewRescued, waterL: inc.waterL,
            ingressLpm: inc.ingressLpm, vesselSafe: inc.vesselSafe,
            sensorConfirmed: inc.sensorConfirmed, acknowledged: inc.acknowledged,
            resolvedAt: inc.resolvedAt, unsafe
        } : null,
        vessel: {
            id: ex.vessel.id, pos: ex.vessel.pos, crewTotal: ex.vessel.crewTotal,
            crewRescued: ex.vessel.crewRescued, waterL: ex.vessel.waterL,
            ingressLpm: ex.vessel.ingressLpm, radioUp: ex.vessel.radioUp,
            inSafeWater: ex.vessel.inSafeWater
        },
        repair: ex.scenario === 'FLOODING' ? {
            requestedAt: ex.repair.requestedAt,
            progressS: ex.repair.progressS, workS: HULL_REPAIR_S,
            done: ex.repair.done
        } : null,
        radio: ex.scenario === 'RADIO_FAILURE' ? {
            up: ex.vessel.radioUp,
            repairRequestedAt: ex.radio.repairRequestedAt,
            repairProgressS: ex.radio.repairProgressS, workS: RADIO_REPAIR_S,
            restored: ex.radio.restored
        } : null,
        returnSafe: ex.scenario === 'BOUNDARY_APPROACH' ? {
            requestedAt: ex.returnSafe.requestedAt,
            progressS: ex.returnSafe.progressS, workS: RETURN_SAFE_S,
            done: ex.returnSafe.done
        } : null,
        helpers: ex.scenario ? helperCandidates(state, ex) : [],
        relay: (() => {
            const rp = relayPath(state, ex);
            const meta = ex.relay.helperId ? (ex.helpers || []).find(h => h.teamId === ex.relay.helperId) : null;
            return {
                helperId: ex.relay.helperId || null,
                route: vesselRadioUp(ex, state) ? 'direct' : (rp.ok ? rp.helperId : null),
                enabled: rp.ok,
                reason: rp.ok ? null : rp.reason,
                distanceToVesselKm: rp.distanceToVesselKm === undefined ? null : +rp.distanceToVesselKm.toFixed(3),
                distanceToHarbourKm: rp.distanceToHarbourKm === undefined ? null : +rp.distanceToHarbourKm.toFixed(3),
                radioUp: meta ? meta.radioUp : null,
                backlog: ex.link.pendingReports.length,
                dropped: ex.relayStats.dropped,
                delivered: ex.relayStats.delivered
            };
        })(),
        link: { pendingReports: ex.link.pendingReports.length, dropped: ex.relayStats.dropped },
        missions,
        commands,
        timeline: ex.timeline.slice(-100),
        results: ex.results
    };
}

module.exports = {
    SCENARIOS, SPEEDS, MAX_SPEED, MAX_STEP_S,
    HULL_REPAIR_S, RADIO_REPAIR_S, RETURN_SAFE_S,
    createExercise, start, reset, pause, resume, setSpeed,
    dispatch, reinforce, command, setOutage, setPumpFault,
    repair, returnSafe, radioRepair, recharge,
    requestAssistance, setRelay,
    step, view
};
