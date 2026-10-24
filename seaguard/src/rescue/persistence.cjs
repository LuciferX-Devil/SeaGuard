'use strict';
// SeaGuard rescue EXERCISE persistence — durable save/resume of the shared
// exercise world ({ state, ex }).
//
//   - versioned local snapshots under a configurable data directory
//   - atomic write: serialize -> temp file -> validate temp -> previous-good
//     backup -> rename temp onto the primary file
//   - strict schema + invariant validation; snapshot contents are only ever
//     READ (never executed / evaluated)
//   - load recovers the previous-good backup when the primary is
//     corrupted/truncated/invalid, and reports a clean error when neither is
//     usable
//
// Standalone CommonJS. The sibling exercise module is required only for its
// SCENARIOS/SPEEDS constants (no side effects, no cycle). Used by:
//   - seaguard/settings.js (functionGlobalContext.rescueStore)
//   - fnRescue.js / fnRescueApi.js (lazy restore + save)
//   - seaguard/tests/rescue-persistence.mjs (unit tests)

const fs = require('fs');
const path = require('path');
const model = require('./model.cjs');
const ex = require('./exercise.cjs');
const energy = require('./battery.cjs');

const FORMAT = 'seaguard/rescue-snapshot';
const VERSION = 1;
const SUPPORTED_VERSIONS = [1];

// Bounded arrays (defense against unbounded growth / hostile snapshots).
const BOUNDS = {
    teams: 50, missions: 500, commands: 500, events: 5000,
    pendingReports: 500, timeline: 5000, outages: 100, fixes: 100
};

const SCENARIOS = ex.SCENARIOS;
const SPEEDS = ex.SPEEDS;
// model.cjs C.rechargeS: a recharge lasts at most this many simulated seconds.
const RECHARGE_MAX_S = 60;
// Legacy snapshots predate the pump battery fields; migration fills ONLY
// absent fields with the model's default full 20Wh / 120W battery.
const LEGACY_BATTERY = { capacityWh: 20, chargeWh: 20, drawW: 120, lowFraction: 0.2 };

const TEAM_STATUS = new Set(['IDLE', 'EN_ROUTE', 'ON_SCENE', 'RETURNING', 'NO_FUEL']);
const MISSION_STATUS = new Set(['EN_ROUTE', 'ON_SCENE', 'RETURNING', 'STALLED', 'COMPLETED']);
const COMMAND_STATUS = new Set(['SENT', 'RECEIVED', 'EXECUTED', 'CONFIRMED', 'FAILED', 'LOST']);
const INCIDENT_STATUS = new Set(['OPEN', 'IN_PROGRESS', 'RESOLVED']);
const INCIDENT_KINDS = new Set(['FLOODING', 'MAN_OVERBOARD', 'CAPSIZED', 'BOUNDARY_APPROACH']);
const TIMELINE_KIND = /^[A-Z][A-Z0-9_]*$/;
// Exact model version the current model.cjs produces (not any semver).
const SUPPORTED_MODEL_VERSION = model.createState({}).version;

// ---- small predicates -------------------------------------------------------
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(v);
const fin = v => typeof v === 'number' && Number.isFinite(v);
const fin0 = v => fin(v) && v >= 0;
const int0 = v => Number.isSafeInteger(v) && v >= 0;
const bool = v => typeof v === 'boolean';
const str = v => typeof v === 'string';
function coord(v) {
    return isObj(v) && fin(v.lat) && v.lat >= -90 && v.lat <= 90 &&
        fin(v.lon) && v.lon >= -180 && v.lon <= 180;
}

// ---- strict snapshot validation (returns an error string, or null) ---------
function validateSnapshot(s) {
    if (!isObj(s)) return 'snapshot must be a plain object';
    if (s.format !== FORMAT) return 'unknown snapshot format';
    if (!SUPPORTED_VERSIONS.includes(s.version)) return 'unsupported snapshot version ' + JSON.stringify(s.version);
    if (!fin0(s.savedAt)) return 'savedAt must be a finite number >= 0';
    const st = s.state, x = s.ex;
    if (!isObj(st)) return 'state must be an object';
    if (!isObj(x)) return 'ex must be an object';
    const err = validateState(st) || validateEx(x);
    if (err) return err;
    return crossValidate(st, x);
}

function validateState(st) {
    if (st.version !== SUPPORTED_MODEL_VERSION) return 'state.version must be exactly ' + SUPPORTED_MODEL_VERSION;
    if (!fin0(st.time)) return 'state.time must be finite >= 0';
    if (!coord(st.harbour)) return 'state.harbour must be a valid coordinate';
    if (!Array.isArray(st.teams) || st.teams.length < 1 || st.teams.length > BOUNDS.teams)
        return 'state.teams must be a non-empty array (bounded)';
    const teamIds = new Set();
    for (const t of st.teams) {
        const e = validateTeam(t);
        if (e) return 'state.teams: ' + e;
        if (teamIds.has(t.id)) return 'state.teams: duplicate id ' + t.id;
        teamIds.add(t.id);
    }
    if (!isObj(st.shared)) return 'state.shared must be an object';
    if (!int0(st.shared.recoveryKitsTotal)) return 'state.shared.recoveryKitsTotal must be an integer >= 0';
    if (!int0(st.shared.recoveryKitsAvailable)) return 'state.shared.recoveryKitsAvailable must be an integer >= 0';
    if (st.shared.recoveryKitsAvailable > st.shared.recoveryKitsTotal)
        return 'state.shared: available kits exceed total';
    if (!isObj(st.incidents)) return 'state.incidents must be an object';
    for (const id of Object.keys(st.incidents)) {
        const e = validateIncident(st.incidents[id]);
        if (e) return 'state.incidents[' + id + ']: ' + e;
    }
    if (!Array.isArray(st.missions) || st.missions.length > BOUNDS.missions)
        return 'state.missions must be a bounded array';
    for (const m of st.missions) {
        const e = validateMission(m);
        if (e) return 'state.missions: ' + e;
    }
    if (!Array.isArray(st.commands) || st.commands.length > BOUNDS.commands)
        return 'state.commands must be a bounded array';
    for (const c of st.commands) {
        const e = validateCommand(c);
        if (e) return 'state.commands: ' + e;
    }
    if (!Array.isArray(st.events) || st.events.length > BOUNDS.events)
        return 'state.events must be a bounded array';
    for (const ev of st.events) {
        if (!isObj(ev) || !fin0(ev.t) || !str(ev.kind)) return 'state.events: each entry needs t (finite >= 0) and kind (string)';
    }
    if (!isObj(st.counters) || !int0(st.counters.mission) || !int0(st.counters.command))
        return 'state.counters must be { mission: int >= 0, command: int >= 0 }';
    return null;
}

function validateTeam(t) {
    if (!isObj(t)) return 'team must be an object';
    if (!isId(t.id)) return 'team.id must be a valid id';
    if (!str(t.name) || t.name.length === 0) return 'team.name must be a non-empty string';
    if (!coord(t.home)) return 'team.home must be a valid coordinate';
    if (!coord(t.pos)) return 'team.pos must be a valid coordinate';
    if (!int0(t.capacity) || t.capacity < 1) return 'team.capacity must be an integer >= 1';
    if (!int0(t.personnel) || t.personnel > t.capacity) return 'team.personnel must be an integer <= capacity';
    if (!isObj(t.pump) || !bool(t.pump.available) || !fin0(t.pump.lpm)) return 'team.pump must be { available: bool, lpm: finite >= 0 }';
    if (!bool(t.pumpFault) || !bool(t.pumpRunning)) return 'team.pumpFault/pumpRunning must be booleans';
    const batErr = validateBatteryField(t.pumpBattery, 'team.pumpBattery');
    if (batErr) return batErr;
    if (!bool(t.pumpLowAnnounced)) return 'team.pumpLowAnnounced must be a strict boolean';
    if (!bool(t.pumpDepletedAnnounced)) return 'team.pumpDepletedAnnounced must be a strict boolean';
    if (t.pumpRecharge !== null) {
        if (!isObj(t.pumpRecharge)) return 'team.pumpRecharge must be null or an object';
        if (Object.keys(t.pumpRecharge).sort().join(',') !== 'remainingS')
            return 'team.pumpRecharge must be exactly { remainingS }';
        if (!fin(t.pumpRecharge.remainingS) || t.pumpRecharge.remainingS <= 0 ||
            t.pumpRecharge.remainingS > RECHARGE_MAX_S)
            return 'team.pumpRecharge.remainingS must be finite in (0, ' + RECHARGE_MAX_S + ']';
    }
    // A depleted battery powers nothing: the model stops the pump the moment
    // charge hits 0, so a saved running pump with zero charge is impossible.
    if (t.pumpRunning && t.pumpBattery.chargeWh === 0)
        return 'team ' + t.id + ' reports pumpRunning with a depleted pump battery';
    // A recharge only ever happens for an idle team at its harbour position.
    if (t.pumpRecharge !== null) {
        if (t.status !== 'IDLE') return 'team ' + t.id + ' is recharging but is not IDLE';
        if (t.pos.lat !== t.home.lat || t.pos.lon !== t.home.lon)
            return 'team ' + t.id + ' is recharging away from its harbour position';
        if (t.personnelAssigned !== 0) return 'team ' + t.id + ' is recharging with assigned personnel';
    }
    if (!fin0(t.fuelL)) return 'team.fuelL must be finite >= 0';
    if (!fin(t.speedKn) || t.speedKn <= 0) return 'team.speedKn must be finite > 0';
    if (!TEAM_STATUS.has(t.status)) return 'team.status invalid: ' + JSON.stringify(t.status);
    if (!int0(t.personnelAssigned) || t.personnelAssigned > t.personnel)
        return 'team.personnelAssigned must be an integer <= personnel';
    if (!Array.isArray(t.outages) || t.outages.length > BOUNDS.outages) return 'team.outages must be a bounded array';
    for (const o of t.outages) {
        if (!isObj(o) || !fin0(o.fromS) || !fin0(o.toS) || o.toS <= o.fromS)
            return 'team.outages: each entry needs fromS <= toS (finite >= 0)';
    }
    if (!isObj(t.telemetry)) return 'team.telemetry must be an object';
    const tel = t.telemetry;
    if (tel.receivedFix !== null) {
        if (!isObj(tel.receivedFix) || !coord(tel.receivedFix.pos) || !fin0(tel.receivedFix.sentAt))
            return 'team.telemetry.receivedFix must be null or { pos, sentAt }';
    }
    if (tel.receivedAt !== null && !fin0(tel.receivedAt)) return 'team.telemetry.receivedAt must be null or finite >= 0';
    if (!Array.isArray(tel.pending) || tel.pending.length > BOUNDS.fixes) return 'team.telemetry.pending must be a bounded array';
    for (const f of tel.pending) {
        if (!isObj(f) || !coord(f.pos) || !fin0(f.sentAt)) return 'team.telemetry.pending: each fix needs pos and sentAt';
    }
    if (t.lastPumpState !== null && t.lastPumpState !== undefined) {
        if (!isObj(t.lastPumpState) || !fin0(t.lastPumpState.at)) return 'team.lastPumpState must be null or { value, at }';
    }
    return null;
}

// Validate a stored pump battery with the energy module's own rules
// (own fields capacityWh/chargeWh/drawW/lowFraction; unknown fields and
// out-of-range values rejected). Returns an error string, or null.
function validateBatteryField(b, label) {
    if (!isObj(b)) return label + ' must be a plain object';
    try { energy.createBattery(b); return null; }
    catch (e) { return label + ' invalid: ' + e.message; }
}

function validateIncident(inc) {
    if (!isObj(inc)) return 'incident must be an object';
    if (!isId(inc.id)) return 'incident.id must be a valid id';
    if (!INCIDENT_KINDS.has(inc.kind)) return 'incident.kind invalid: ' + JSON.stringify(inc.kind);
    if (!coord(inc.position)) return 'incident.position must be a valid coordinate';
    if (!fin0(inc.reportedAt)) return 'incident.reportedAt must be finite >= 0';
    if (!int0(inc.crewOnboard)) return 'incident.crewOnboard must be an integer >= 0';
    if (!int0(inc.crewRescued) || inc.crewRescued > inc.crewOnboard)
        return 'incident.crewRescued must be an integer <= crewOnboard';
    if (!fin0(inc.rescueProgress)) return 'incident.rescueProgress must be finite >= 0';
    if (!fin0(inc.waterL)) return 'incident.waterL must be finite >= 0';
    if (!fin0(inc.ingressLpm)) return 'incident.ingressLpm must be finite >= 0';
    if (!bool(inc.vesselSafe) || !bool(inc.sensorConfirmed) || !bool(inc.acknowledged))
        return 'incident vesselSafe/sensorConfirmed/acknowledged must be booleans';
    if (inc.lastWater !== null) {
        if (!isObj(inc.lastWater) || !fin0(inc.lastWater.value) || !fin0(inc.lastWater.at))
            return 'incident.lastWater must be null or { value: finite >= 0, at: finite >= 0 }';
    }
    if (inc.lastCrew !== null) {
        if (!isObj(inc.lastCrew) || !int0(inc.lastCrew.value) || !fin0(inc.lastCrew.at))
            return 'incident.lastCrew must be null or { value: integer >= 0, at: finite >= 0 }';
    }
    if (!INCIDENT_STATUS.has(inc.status)) return 'incident.status invalid: ' + JSON.stringify(inc.status);
    if (inc.resolvedAt !== null && !fin0(inc.resolvedAt)) return 'incident.resolvedAt must be null or finite >= 0';
    return null;
}

function validateMission(m) {
    if (!isObj(m)) return 'mission must be an object';
    if (!isId(m.id)) return 'mission.id must be a valid id';
    if (!isId(m.incidentId)) return 'mission.incidentId must be a valid id';
    if (!isId(m.teamId)) return 'mission.teamId must be a valid id';
    if (m.purpose !== 'PRIMARY' && m.purpose !== 'REINFORCEMENT') return 'mission.purpose invalid: ' + JSON.stringify(m.purpose);
    if (!int0(m.personnel) || m.personnel < 1) return 'mission.personnel must be an integer >= 1';
    if (!bool(m.recoveryKit)) return 'mission.recoveryKit must be a boolean';
    if (!coord(m.origin)) return 'mission.origin must be a valid coordinate';
    if (!fin0(m.departedAt)) return 'mission.departedAt must be finite >= 0';
    if (!fin0(m.travelS)) return 'mission.travelS must be finite >= 0';
    if (!fin0(m.arriveAt)) return 'mission.arriveAt must be finite >= 0';
    if (!MISSION_STATUS.has(m.status)) return 'mission.status invalid: ' + JSON.stringify(m.status);
    if (m.arrivedAt !== null && !fin0(m.arrivedAt)) return 'mission.arrivedAt must be null or finite >= 0';
    if (m.returnOrigin !== null && !coord(m.returnOrigin)) return 'mission.returnOrigin must be null or a valid coordinate';
    if (m.returnDepartedAt !== null && !fin0(m.returnDepartedAt)) return 'mission.returnDepartedAt must be null or finite >= 0';
    if (m.returnTravelS !== null && !fin0(m.returnTravelS)) return 'mission.returnTravelS must be null or finite >= 0';
    if (m.completedAt !== null && !fin0(m.completedAt)) return 'mission.completedAt must be null or finite >= 0';
    return null;
}

function validateCommand(c) {
    if (!isObj(c)) return 'command must be an object';
    if (!isId(c.id)) return 'command.id must be a valid id';
    if (!isId(c.incidentId)) return 'command.incidentId must be a valid id';
    if (!isId(c.teamId)) return 'command.teamId must be a valid id';
    if (c.missionId !== null && !isId(c.missionId)) return 'command.missionId must be null or a valid id';
    if (typeof c.action !== 'string' || c.action.length === 0) return 'command.action must be a non-empty string';
    if (!fin0(c.sentAt)) return 'command.sentAt must be finite >= 0';
    for (const k of ['receivedAt', 'executedAt', 'confirmedAt', 'failedAt', 'lostAt']) {
        if (c[k] !== null && !fin0(c[k])) return 'command.' + k + ' must be null or finite >= 0';
    }
    if (c.failReason !== null && c.failReason !== undefined && !str(c.failReason)) return 'command.failReason must be null or a string';
    if (!COMMAND_STATUS.has(c.status)) return 'command.status invalid: ' + JSON.stringify(c.status);
    if (!fin0(c.sentElapsed)) return 'command.sentElapsed must be finite >= 0';
    if (!fin0(c.receivedElapsed)) return 'command.receivedElapsed must be finite >= 0';
    if (!fin0(c.levelAtSend)) return 'command.levelAtSend must be finite >= 0';
    if (c.levelAtExec !== null && !fin0(c.levelAtExec)) return 'command.levelAtExec must be null or finite >= 0';
    return null;
}

function validateEx(x) {
    if (x.scenario !== null && !SCENARIOS.includes(x.scenario)) return 'ex.scenario invalid: ' + JSON.stringify(x.scenario);
    if (!bool(x.running)) return 'ex.running must be a boolean';
    if (!bool(x.paused)) return 'ex.paused must be a boolean';
    if (!SPEEDS.includes(x.speed)) return 'ex.speed must be one of ' + SPEEDS.join(', ');
    if (!fin0(x.simTime)) return 'ex.simTime must be finite >= 0';
    if (!fin0(x.realAccum)) return 'ex.realAccum must be finite >= 0';
    if (x.startedAt !== null && !fin0(x.startedAt)) return 'ex.startedAt must be null or finite >= 0';
    if (x.incidentId !== null && !isId(x.incidentId)) return 'ex.incidentId must be null or a valid id';
    if (!isObj(x.vessel)) return 'ex.vessel must be an object';
    const v = x.vessel;
    if (!isId(v.id)) return 'ex.vessel.id must be a valid id';
    if (!str(v.name) || v.name.length === 0) return 'ex.vessel.name must be a non-empty string';
    if (v.pos !== null && !coord(v.pos)) return 'ex.vessel.pos must be null or a valid coordinate';
    if (!int0(v.crewTotal)) return 'ex.vessel.crewTotal must be an integer >= 0';
    if (!int0(v.crewRescued) || v.crewRescued > v.crewTotal) return 'ex.vessel.crewRescued must be an integer <= crewTotal';
    if (!fin0(v.waterL)) return 'ex.vessel.waterL must be finite >= 0';
    if (!fin0(v.ingressLpm)) return 'ex.vessel.ingressLpm must be finite >= 0';
    if (!bool(v.radioUp) || !bool(v.inSafeWater) || !bool(v.repairDone))
        return 'ex.vessel radioUp/inSafeWater/repairDone must be booleans';
    if (v.driftKm !== undefined && !fin0(v.driftKm)) return 'ex.vessel.driftKm must be undefined or finite >= 0';
    if (!isObj(x.repair)) return 'ex.repair must be an object';
    if (x.repair.requestedAt !== null && !fin0(x.repair.requestedAt)) return 'ex.repair.requestedAt must be null or finite >= 0';
    if (!fin0(x.repair.progressS)) return 'ex.repair.progressS must be finite >= 0';
    if (!bool(x.repair.done)) return 'ex.repair.done must be a boolean';
    if (!isObj(x.radio)) return 'ex.radio must be an object';
    if (x.radio.repairRequestedAt !== null && !fin0(x.radio.repairRequestedAt)) return 'ex.radio.repairRequestedAt must be null or finite >= 0';
    if (!fin0(x.radio.repairProgressS)) return 'ex.radio.repairProgressS must be finite >= 0';
    if (!bool(x.radio.restored)) return 'ex.radio.restored must be a boolean';
    if (!isObj(x.returnSafe)) return 'ex.returnSafe must be an object';
    if (x.returnSafe.requestedAt !== null && !fin0(x.returnSafe.requestedAt)) return 'ex.returnSafe.requestedAt must be null or finite >= 0';
    if (!fin0(x.returnSafe.progressS)) return 'ex.returnSafe.progressS must be finite >= 0';
    if (!bool(x.returnSafe.done)) return 'ex.returnSafe.done must be a boolean';
    if (x.returnSafe.startPos !== undefined && x.returnSafe.startPos !== null && !coord(x.returnSafe.startPos))
        return 'ex.returnSafe.startPos must be null/undefined or a valid coordinate';
    if (!isObj(x.link)) return 'ex.link must be an object';
    const lk = x.link;
    if (!Array.isArray(lk.pendingReports) || lk.pendingReports.length > BOUNDS.pendingReports)
        return 'ex.link.pendingReports must be a bounded array';
    for (const r of lk.pendingReports) {
        if (!isObj(r) || typeof r.kind !== 'string' || !fin0(r.sampleAt))
            return 'ex.link.pendingReports: each report needs kind/value/sampleAt';
        // WATER_LEVEL carries a finite number; PUMP_STATE carries 'on'/'off'.
        if (!(fin(r.value) || r.value === 'on' || r.value === 'off'))
            return 'ex.link.pendingReports: report value must be a finite number or on/off';
        // arriveAt is null while no path (direct radio or relay) is available;
        // a scheduled delivery must be a finite time >= 0.
        if (r.arriveAt !== null && r.arriveAt !== undefined && !fin0(r.arriveAt))
            return 'ex.link.pendingReports: report arriveAt must be null or finite >= 0';
        if (r.relayed !== undefined && !bool(r.relayed))
            return 'ex.link.pendingReports: report relayed must be a boolean';
        // route: null while held, 'direct', or the relay helper's teamId.
        if (r.route !== null && !(typeof r.route === 'string' && r.route.length > 0 && r.route.length <= 32))
            return 'ex.link.pendingReports: report route must be null or a short string';
    }
    if (lk.lastReportAt !== null && !fin0(lk.lastReportAt)) return 'ex.link.lastReportAt must be null or finite >= 0';
    if (lk.lastWaterReportAt !== null && !fin0(lk.lastWaterReportAt)) return 'ex.link.lastWaterReportAt must be null or finite >= 0';
    if (!isObj(lk.lastPumpReport)) return 'ex.link.lastPumpReport must be an object';
    for (const k of Object.keys(lk.lastPumpReport)) {
        if (!bool(lk.lastPumpReport[k])) return 'ex.link.lastPumpReport values must be booleans';
    }
    // Nearby-vessel (helper) metadata: optional for legacy snapshots (migrated
    // to safe defaults), strictly validated when present.
    if (x.helpers !== undefined) {
        if (!Array.isArray(x.helpers) || x.helpers.length > 8) return 'ex.helpers must be a small array';
        for (const h of x.helpers) {
            if (!isObj(h) || !isId(h.teamId) || !str(h.name) || !bool(h.radioUp) || !bool(h.available))
                return 'ex.helpers entries need teamId/name/radioUp/available';
        }
    }
    if (x.relay !== undefined) {
        if (!isObj(x.relay)) return 'ex.relay must be an object';
        if (x.relay.helperId !== null && !isId(x.relay.helperId)) return 'ex.relay.helperId must be null or a valid id';
    }
    if (x.relayStats !== undefined) {
        if (!isObj(x.relayStats) || !int0(x.relayStats.delivered) || !int0(x.relayStats.dropped))
            return 'ex.relayStats must be { delivered: integer >= 0, dropped: integer >= 0 }';
    }
    if (!isObj(x.marks)) return 'ex.marks must be an object';
    for (const k of ['detectedAt', 'acknowledgedAt', 'firstDispatchAt', 'firstArrivalAt', 'repairDoneAt', 'radioRestoredAt', 'returnSafeDoneAt']) {
        if (x.marks[k] !== null && !fin0(x.marks[k])) return 'ex.marks.' + k + ' must be null or finite >= 0';
    }
    if (!bool(x.marks.completed)) return 'ex.marks.completed must be a boolean';
    if (!Array.isArray(x.timeline) || x.timeline.length > BOUNDS.timeline) return 'ex.timeline must be a bounded array';
    for (const e of x.timeline) {
        if (!isObj(e) || !fin0(e.t) || !str(e.kind) || !TIMELINE_KIND.test(e.kind))
            return 'ex.timeline: each entry needs t (finite >= 0) and kind (UPPER_SNAKE string)';
    }
    if (x.results !== null && x.results !== undefined && !isObj(x.results)) return 'ex.results must be null or an object';
    if (!coord(x.harbour)) return 'ex.harbour must be a valid coordinate';
    return null;
}

function crossValidate(st, x) {
    for (const m of st.missions) {
        if (!st.teams.some(t => t.id === m.teamId)) return 'mission references unknown team';
        if (!Object.hasOwn(st.incidents, m.incidentId)) return 'mission references unknown incident';
    }
    if (st.time !== x.simTime) return 'model and exercise clocks disagree';
    const missionIds = new Set(), commandIds = new Set();
    for (const [key, inc] of Object.entries(st.incidents)) if (key !== inc.id) return 'incident key/id mismatch';
    for (const m of st.missions) {
        if (missionIds.has(m.id)) return 'duplicate mission id';
        missionIds.add(m.id);
        if (!/^M[1-9]\d*$/.test(m.id) || Number(m.id.slice(1)) > st.counters.mission) return 'mission counter behind allocated ids';
    }
    for (const c of st.commands) {
        if (commandIds.has(c.id)) return 'duplicate command id';
        commandIds.add(c.id);
        if (!/^C[1-9]\d*$/.test(c.id) || Number(c.id.slice(1)) > st.counters.command) return 'command counter behind allocated ids';
        if (c.missionId) {
            const m = st.missions.find(m => m.id === c.missionId);
            if (!m || m.teamId !== c.teamId || m.incidentId !== c.incidentId) return 'command mission ownership mismatch';
        }
    }
    const reserved = st.missions.filter(m => m.status !== 'COMPLETED');
    if (st.shared.recoveryKitsTotal - st.shared.recoveryKitsAvailable !== reserved.filter(m => m.recoveryKit).length) return 'recovery kit reservation mismatch';
    for (const t of st.teams) {
        const active = reserved.filter(m => m.teamId === t.id);
        if (active.length > 1) return 'team double booked';
        if (t.personnelAssigned !== active.reduce((n,m) => n + m.personnel, 0)) return 'personnel reservation mismatch';
        if (!active.length && t.status !== 'IDLE') return 'busy team has no mission';
        if (active.length && t.status !== (active[0].status === 'STALLED' ? 'NO_FUEL' : active[0].status)) return 'team and mission status mismatch';
    }
    // Helper metadata must reference real teams; a relay selection must
    // reference a known helper that is also a real team.
    if (Array.isArray(x.helpers)) {
        for (const h of x.helpers) {
            if (!st.teams.some(t => t.id === h.teamId)) return 'ex.helpers references unknown team ' + h.teamId;
        }
    }
    if (isObj(x.relay) && x.relay.helperId) {
        if (!Array.isArray(x.helpers) || !x.helpers.some(h => h.teamId === x.relay.helperId))
            return 'ex.relay.helperId references no known helper';
        if (!st.teams.some(t => t.id === x.relay.helperId))
            return 'ex.relay.helperId references no team';
    }
    // A running exercise must reference an incident that exists in the model.
    if (x.incidentId !== null && !st.incidents[x.incidentId])
        return 'ex.incidentId ' + x.incidentId + ' has no matching state.incidents entry';
    if (x.scenario !== null && !x.running) return 'ex.scenario set but ex.running is false';
    // Every mission / command must reference a real team and incident.
    for (const m of st.missions) {
        if (!st.teams.some(t => t.id === m.teamId)) return 'mission ' + m.id + ' references unknown team ' + m.teamId;
        if (!st.incidents[m.incidentId]) return 'mission ' + m.id + ' references unknown incident ' + m.incidentId;
    }
    for (const c of st.commands) {
        if (!st.teams.some(t => t.id === c.teamId)) return 'command ' + c.id + ' references unknown team ' + c.teamId;
        if (!st.incidents[c.incidentId]) return 'command ' + c.id + ' references unknown incident ' + c.incidentId;
        if (c.missionId !== null && !st.missions.some(m => m.id === c.missionId))
            return 'command ' + c.id + ' references unknown mission ' + c.missionId;
    }
    // A team cannot be assigned more personnel than it has.
    for (const t of st.teams) {
        if (t.personnelAssigned > t.personnel) return 'team ' + t.id + ' has more assigned personnel than it has';
    }
    return null;
}

// ---- legacy migration -------------------------------------------------------
// Fill ONLY the pump battery fields that are ABSENT (Object.hasOwn) on each
// team: full 20Wh/120W battery, both announce flags false, recharge null.
// Present-but-invalid or null values are left untouched so validation can
// reject them; migration never papers over a corrupt snapshot. Mutates and
// returns the object it is given (callers pass a clone).
function migrateSnapshot(obj) {
    if (!isObj(obj) || !isObj(obj.state) || !Array.isArray(obj.state.teams)) return obj;
    for (const t of obj.state.teams) {
        if (!isObj(t)) continue;
        if (!Object.hasOwn(t, 'pumpBattery')) t.pumpBattery = { ...LEGACY_BATTERY };
        if (!Object.hasOwn(t, 'pumpLowAnnounced')) t.pumpLowAnnounced = false;
        if (!Object.hasOwn(t, 'pumpDepletedAnnounced')) t.pumpDepletedAnnounced = false;
        if (!Object.hasOwn(t, 'pumpRecharge')) t.pumpRecharge = null;
    }
    // Nearby-vessel / relay metadata predates these snapshots: fill ONLY
    // absent fields with safe defaults (no synthetic helper missions).
    const x = obj.ex;
    if (isObj(x)) {
        if (!Object.hasOwn(x, 'helpers')) {
            x.helpers = x && obj.state.teams
                .filter(t => isObj(t) && (t.id === 'N1' || t.id === 'N2'))
                .map(t => ({ teamId: t.id, name: t.name, radioUp: true, available: true }));
        }
        if (!Object.hasOwn(x, 'relay')) x.relay = { helperId: null };
        if (!Object.hasOwn(x, 'relayStats')) x.relayStats = { delivered: 0, dropped: 0 };
        if (isObj(x.link) && Array.isArray(x.link.pendingReports)) {
            for (const r of x.link.pendingReports) {
                if (!isObj(r)) continue;
                if (!Object.hasOwn(r, 'relayed')) r.relayed = false;
                if (r.arriveAt === undefined) r.arriveAt = null;
                if (r.route === undefined) r.route = null;
            }
        }
    }
    return obj;
}

// ---- snapshot construction --------------------------------------------------
function buildSnapshot(world, nowMs) {
    return {
        format: FORMAT,
        version: VERSION,
        savedAt: (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now(),
        state: world.state,
        ex: world.ex
    };
}

function serialize(world) {
    return JSON.stringify(buildSnapshot(world));
}

// ---- store ------------------------------------------------------------------
function createStore(options = {}) {
    if (options === null || typeof options !== 'object') throw new Error('rescueStore: options must be an object');
    const dataDir = options.dataDir || path.join(__dirname, '..', '..', 'data');
    const primaryName = options.primaryName || 'rescue-snapshot.json';
    const backupName = options.backupName || 'rescue-snapshot.prev.json';
    const primaryPath = path.join(dataDir, primaryName);
    const backupPath = path.join(dataDir, backupName);

    function readAndValidate(p) {
        let text;
        try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return { ok: false, error: 'unreadable: ' + e.message }; }
        let obj;
        try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: 'not valid JSON: ' + e.message }; }
        // Legacy snapshots predate the pump battery fields: migrate ONLY absent
        // fields on a deep clone (JSON round-trip) so the parsed input is never
        // mutated, validate strictly, and return the MIGRATED world.
        const migrated = migrateSnapshot(JSON.parse(JSON.stringify(obj)));
        const err = validateSnapshot(migrated);
        if (err) return { ok: false, error: 'invalid snapshot: ' + err };
        return { ok: true, world: { state: migrated.state, ex: migrated.ex }, savedAt: migrated.savedAt };
    }

    // Atomic save: serialize -> temp -> validate temp -> previous-good backup
    // -> rename temp onto primary. On any failure the temp is removed and the
    // primary is left untouched (a temp can never replace a good snapshot).
    function save(world) {
        if (!world || !isObj(world.state) || !isObj(world.ex))
            return { ok: false, error: 'world must be { state, ex }' };
        let text;
        try {
            text = serialize(world);
        } catch (e) {
            // A cyclic / non-serializable world must not crash the node.
            return { ok: false, error: 'serialize failed: ' + e.message };
        }
        // Re-validate what we are about to write (defense in depth).
        const pre = validateSnapshot(JSON.parse(text));
        if (pre) return { ok: false, error: 'refusing to write invalid snapshot: ' + pre };
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            const tmp = path.join(dataDir, '.' + primaryName + '.tmp-' + process.pid + '-' + Date.now());
            fs.writeFileSync(tmp, text, 'utf8');
            // Verify the temp on disk before promoting it.
            const check = readAndValidate(tmp);
            if (!check.ok) { try { fs.unlinkSync(tmp); } catch (_) {} return { ok: false, error: check.error }; }
            // Previous-good backup: only promote the current primary if it is
            // itself valid, so a corrupt primary can never clobber the backup.
            if (fs.existsSync(primaryPath)) {
                if (readAndValidate(primaryPath).ok) {
                    try { fs.copyFileSync(primaryPath, backupPath); } catch (_) { /* best effort */ }
                }
            }
            fs.renameSync(tmp, primaryPath);
            return { ok: true, primary: primaryPath, backup: backupPath };
        } catch (e) {
            return { ok: false, error: 'save failed: ' + e.message };
        }
    }

    // Lazy, one-shot restore into a flow context: recover a durable snapshot
    // if one exists (restoring paused), otherwise create a fresh world. Never
    // overwrites a world that is already present in the flow.
    function restoreOnce(exModule, flowLike) {
        if (flowLike.get('rescueWorld')) return flowLike.get('rescueWorld');
        const loaded = load();
        const S = loaded.ok ? loaded.world : exModule.createExercise({});
        if (loaded.ok) {
            S.ex.paused = true; // resume is an explicit operator action
            S.ex.restoredFromSnapshot = true;
            S.ex.restoreSource = loaded.source;
            S.ex.restoreWarning = loaded.note || null;
        } else if (fs.existsSync(primaryPath) || fs.existsSync(backupPath)) {
            S.ex.restoreWarning = loaded.error;
        }
        flowLike.set('rescueWorld', S);
        return S;
    }

    // Load with previous-good recovery. Never throws for expected corruption.
    function load() {
        const p = readAndValidate(primaryPath);
        if (p.ok) { p.world.ex.paused = true; return { ok: true, world: p.world, source: 'primary' }; }
        const b = readAndValidate(backupPath);
        if (b.ok) { b.world.ex.paused = true; return { ok: true, world: b.world, source: 'backup', note: 'primary invalid: ' + p.error }; }
        return { ok: false, error: 'no usable snapshot (primary: ' + p.error + '; backup: ' + b.error + ')' };
    }

    function status() {
        const p = readAndValidate(primaryPath);
        const b = readAndValidate(backupPath);
        return {
            primary: { path: primaryPath, exists: fs.existsSync(primaryPath), valid: p.ok, simTime: p.ok ? p.world.ex.simTime : null, savedAt: p.savedAt },
            backup: { path: backupPath, exists: fs.existsSync(backupPath), valid: b.ok, simTime: b.ok ? b.world.ex.simTime : null, savedAt: b.savedAt }
        };
    }

    return { dataDir, primaryPath, backupPath, save, load, status, restoreOnce };
}

module.exports = {
    FORMAT, VERSION, SUPPORTED_VERSIONS, BOUNDS, RECHARGE_MAX_S,
    validateSnapshot, migrateSnapshot, buildSnapshot, serialize, createStore
};
