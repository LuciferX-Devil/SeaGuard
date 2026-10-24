// SeaGuard rescue state model — standalone, dependency-free CommonJS.
//
// Rescue sprint task 1 (review revision 3): a deterministic simulated-time
// model of two (or more, explicitly) finite rescue teams responding to
// incident-linked dispatches. No Node-RED globals, no Date.now(), no
// Math.random(): every value derives from explicit inputs and state.time,
// so identical call sequences always produce identical state.
//
// Core rules
//  - Dispatches are incident-linked; a team or shared recovery kit already
//    reserved by an active mission cannot be double-booked.
//  - Personnel may be allocated partially (1..available); unassigned crew
//    stays ashore and is visible in status().
//  - Movement is deterministic simulated-time travel at each team's speed
//    (1 knot = 1.852 km/h exactly). A mission arrives only after the full
//    distance is covered — no early completion, no overshoot. tick() works
//    in <=1-second substeps and splits every substep at its own arrival /
//    return-arrival events, so a team never works before it arrives and
//    never moves after it has arrived. Fuel is charged on every travel
//    substep INCLUDING the final leg: the arrival branch moves the team to
//    the destination first, then charges that substep's fuel, so a team can
//    strand (NO_FUEL / mission STALLED) at the destination.
//  - A zero-distance dispatch (team already at the incident) is an
//    instantaneous arrival: it completes in the first substep without any
//    zero-length loop (the substep list is built from distinct, strictly
//    increasing event times).
//  - On scene: pumps fight water ingress (effectiveness = net litres per
//    minute), and crew are recovered at a rate proportional to assigned
//    personnel. A recovery kit must be held by an on-scene mission for any
//    crew recovery to happen.
//  - Water balance runs for EVERY incident every substep — including
//    resolved ones — so a resolved incident is not frozen: if ingress
//    continues after the pumps stop, the water rises and the incident
//    reopens (RESOLVED -> IN_PROGRESS) with sensorConfirmed cleared and the
//    unsafe reasons visible. A green state requires the physical condition
//    to actually hold.
//  - "Crew rescued" is distinct from "vessel safe": an incident resolves
//    only when every person is recovered AND the water level is at or below
//    the safe level AND a FRESH sensor report confirms it. No green while
//    unsafe conditions remain: unresolved incidents, stranded teams or
//    teams still at sea keep allClear false.
//  - GPS: each team has a TRUE position and a separate last-RECEIVED fix.
//    The fix carries its SENT (sample) time; staleness is derived from the
//    SAMPLE time (state.time - receivedFix.sentAt), not from when the fix
//    happened to arrive, so a backlog of queued fixes delivered after a
//    comms outage still reads stale. receivedAt is tracked separately and
//    reported for observability.
//  - Commands (START_PUMP / STOP_PUMP / RETURN / ACKNOWLEDGE) move through
//    explicit stages SENT -> RECEIVED -> EXECUTED -> CONFIRMED. Every
//    command is bound to the team's ACTIVE MISSION for that incident at
//    send time (missionId), and the mission must still be active at
//    execution time — a STOP_PUMP for incident B cannot stop a pump working
//    incident A, and a command whose mission has ended fails visibly.
//    Outages delay reception (they do not lose commands); dropCommand()
//    simulates a lost in-transit frame. Execution may still FAIL when
//    preconditions no longer hold (e.g. a pump fault), which stays visible
//    and blocks confirmation.
//  - START_PUMP confirmation needs team-specific fresh telemetry: a
//    PUMP_STATE "on" reading for this team at or after execution, plus a
//    WATER_LEVEL reading at or after execution that is below the level
//    recorded at execution. Readings are kept separately (latest water
//    level per incident, latest pump state per team) so one unrelated old
//    low-water report never confirms a pump.
//
// API (every function validates ALL inputs first, then mutates — atomic)
//   createState(options?)            -> state
//   addIncident(state, incident)     -> incident
//   dispatch(state, {incidentId, teamId, personnel, recoveryKit}) -> mission
//   reinforce(state, same)           -> mission (requires an active mission)
//   command(state, {incidentId, teamId, action}) -> command
//   sensorReport(state, {incidentId, kind, value, teamId?})
//   setOutage(state, {teamId, fromS, toS})
//   setPumpFault(state, {teamId, fault})
//   dropCommand(state, commandId)
//   tick(state, dtS)
//   status(state)                    -> computed read-only view
//   distanceKm(a, b)

'use strict';

const energy = require('./battery.cjs');

const KINDS = ['FLOODING', 'MAN_OVERBOARD', 'CAPSIZED', 'BOUNDARY_APPROACH'];
const ACTIONS = ['START_PUMP', 'STOP_PUMP', 'RETURN', 'ACKNOWLEDGE'];
const SENSOR_KINDS = ['WATER_LEVEL', 'PUMP_STATE', 'CREW_RESCUED'];

// Fixed model constants (simulated, illustrative — not navigational data).
const C = {
    propagationS: 2,              // SENT -> RECEIVED, only while comms are up
    executionS: 5,                // RECEIVED -> EXECUTED
    telemetryDelayS: 5,           // fix sampled -> fix received
    staleAfterS: 30,              // a fix SAMPLED older than this is stale
    safeWaterL: 50,               // water level at/below this is safe
    rescueRatePerPersonPerMin: 0.5,
    fuelLphPerKn: 8,              // litres per hour per knot of speed
    maxTickS: 3600,
    maxSubstepS: 1,               // internal tick resolution for event splitting
    fixQueueMax: 12,              // bounded pending-fix memory per team
    rechargeS: 60                 // simulated battery replacement/charge duration
};

const EARTH_R_KM = 6371;
const KM_PER_HOUR_PER_KNOT = 1.852; // exact: 1 knot = 1 nautical mile/hour

// ---------- validation helpers (exported for reuse by later tasks) ----------

function isId(v) {
    return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(v);
}
function isFiniteNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}
function isCoord(p) {
    return p !== null && typeof p === 'object' &&
        isFiniteNum(p.lat) && p.lat >= -90 && p.lat <= 90 &&
        isFiniteNum(p.lon) && p.lon >= -180 && p.lon <= 180;
}
function isPersonnel(v) {
    return Number.isSafeInteger(v) && v >= 0;
}
function isTime(v) {
    return isFiniteNum(v) && v >= 0;
}
function fail(fn, msg) {
    throw new Error(fn + ': ' + msg);
}

function distanceKm(a, b) {
    if (!isCoord(a) || !isCoord(b)) fail('distanceKm', 'both points must be valid coordinates');
    const rad = d => d * Math.PI / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function travelSeconds(from, to, speedKn) {
    if (!isFiniteNum(speedKn) || speedKn <= 0) fail('travelSeconds', 'speedKn must be a finite number > 0');
    return distanceKm(from, to) / (speedKn * KM_PER_HOUR_PER_KNOT) * 3600;
}

function lerpPos(a, b, f) {
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

// ---------- state ----------

function defaultTeams(harbour) {
    return [
        { id: 'T1', name: 'Harbour Swift', home: { ...harbour }, capacity: 4, personnel: 4,
          pump: { available: true, lpm: 25 }, fuelL: 120, speedKn: 12 },
        { id: 'T2', name: 'Harbour Guardian', home: { ...harbour }, capacity: 6, personnel: 6,
          pump: { available: true, lpm: 40 }, fuelL: 200, speedKn: 18 }
    ];
}

function createState(options = {}) {
    if (options === null || typeof options !== 'object') fail('createState', 'options must be an object');
    const harbour = options.harbour || { lat: 9.2876, lon: 79.3129 }; // illustrative, matches SeaGuard cfg
    if (!isCoord(harbour)) fail('createState', 'harbour must be a valid coordinate');
    const teamsIn = options.teams || defaultTeams(harbour);
    if (!Array.isArray(teamsIn) || teamsIn.length === 0) fail('createState', 'teams must be a non-empty array');
    const sharedIn = options.shared || { recoveryKits: 1 };
    if (sharedIn === null || typeof sharedIn !== 'object' || !isPersonnel(sharedIn.recoveryKits))
        fail('createState', 'shared.recoveryKits must be a safe integer >= 0');

    const teams = [];
    const seen = new Set();
    for (const t of teamsIn) {
        if (!t || typeof t !== 'object') fail('createState', 'each team must be an object');
        if (!isId(t.id)) fail('createState', 'team id must be a valid id');
        if (seen.has(t.id)) fail('createState', 'duplicate team id ' + t.id);
        seen.add(t.id);
        if (typeof t.name !== 'string' || t.name.length === 0)
            fail('createState', 'team ' + t.id + ': name must be a non-empty string');
        if (!isCoord(t.home)) fail('createState', 'team ' + t.id + ': home must be a valid coordinate');
        if (!isPersonnel(t.capacity) || t.capacity < 1)
            fail('createState', 'team ' + t.id + ': capacity must be a safe integer >= 1');
        if (!isPersonnel(t.personnel) || t.personnel > t.capacity)
            fail('createState', 'team ' + t.id + ': personnel must be a safe integer <= capacity');
        if (!t.pump || typeof t.pump !== 'object' || typeof t.pump.available !== 'boolean' ||
            !isFiniteNum(t.pump.lpm) || t.pump.lpm < 0)
            fail('createState', 'team ' + t.id + ': pump must be {available: boolean, lpm: finite >= 0}');
        if (!isFiniteNum(t.fuelL) || t.fuelL < 0) fail('createState', 'team ' + t.id + ': fuelL must be finite >= 0');
        if (!isFiniteNum(t.speedKn) || t.speedKn <= 0) fail('createState', 'team ' + t.id + ': speedKn must be finite > 0');
        // Finite pump battery: per-team option (tests), illustrative 20Wh / 120W default.
        // createBattery validates (TypeError on bad values) before any state is built.
        const bIn = t.pump.battery === undefined ? { capacityWh: 20, chargeWh: 20, drawW: 120 } : t.pump.battery;
        const pumpBattery = energy.createBattery(bIn);
        teams.push({
            id: t.id, name: t.name, home: { ...t.home },
            capacity: t.capacity, personnel: t.personnel,
            pump: { available: t.pump.available, lpm: t.pump.lpm },
            pumpBattery,
            pumpRecharge: null,           // { remainingS } while a charge/replacement is in progress
            pumpLowAnnounced: false,      // LOW_BATTERY once per crossing
            pumpDepletedAnnounced: false, // BATTERY_DEPLETED once per crossing
            pumpFault: false, pumpRunning: false,
            fuelL: t.fuelL, speedKn: t.speedKn,
            status: 'IDLE', pos: { ...t.home },
            personnelAssigned: 0,
            outages: [],
            telemetry: { receivedFix: null, receivedAt: null, pending: [] }
        });
    }
    return {
        version: 'rescue-model/1.0.2',
        time: 0,
        harbour: { ...harbour },
        teams,
        shared: { recoveryKitsTotal: sharedIn.recoveryKits, recoveryKitsAvailable: sharedIn.recoveryKits },
        incidents: {},
        missions: [],
        commands: [],
        events: [],
        counters: { mission: 0, command: 0 }
    };
}

// ---------- lookups & events ----------

function teamById(state, id) {
    const t = state.teams.find(x => x.id === id);
    if (!t) fail('lookup', 'unknown team ' + id);
    return t;
}
function incidentById(state, id) {
    const i = state.incidents[id];
    if (!i) fail('lookup', 'unknown incident ' + id);
    return i;
}
function missionById(state, id) {
    const m = state.missions.find(x => x.id === id);
    if (!m) fail('lookup', 'unknown mission ' + id);
    return m;
}
function event(state, kind, detail) {
    state.events.push({ t: state.time, kind, detail });
}
function inOutage(team, t) {
    return team.outages.some(o => t >= o.fromS && t < o.toS);
}

// ---------- explicit simulated inputs ----------

function addIncident(state, input) {
    if (!input || typeof input !== 'object') fail('addIncident', 'input must be an object');
    const { id, kind, position, crewOnboard, initialWaterL, ingressLpm, reportedAt } = input;
    if (!isId(id)) fail('addIncident', 'id must be a valid id');
    if (state.incidents[id]) fail('addIncident', 'incident id ' + id + ' already exists');
    if (!KINDS.includes(kind)) fail('addIncident', 'kind must be one of ' + KINDS.join(', '));
    if (!isCoord(position)) fail('addIncident', 'position must be a valid coordinate');
    if (!isPersonnel(crewOnboard)) fail('addIncident', 'crewOnboard must be a safe integer >= 0');
    if (!isFiniteNum(initialWaterL) || initialWaterL < 0) fail('addIncident', 'initialWaterL must be finite >= 0');
    if (!isFiniteNum(ingressLpm) || ingressLpm < 0) fail('addIncident', 'ingressLpm must be finite >= 0');
    const rt = reportedAt === undefined || reportedAt === null ? state.time : reportedAt;
    if (!isTime(rt)) fail('addIncident', 'reportedAt must be a finite time >= 0');
    const inc = {
        id, kind, position: { ...position }, reportedAt: rt,
        crewOnboard, crewRescued: 0, rescueProgress: 0,
        waterL: initialWaterL, ingressLpm,
        vesselSafe: initialWaterL <= C.safeWaterL,
        sensorConfirmed: false, acknowledged: false,
        lastWater: null, lastCrew: null,
        status: 'OPEN', resolvedAt: null
    };
    state.incidents[id] = inc;
    event(state, 'INCIDENT', { incident: id, kind, crewOnboard, reportedAt: rt });
    return { ...inc };
}

function dispatch(state, input, opts = {}) {
    if (!input || typeof input !== 'object') fail('dispatch', 'input must be an object');
    const { incidentId, teamId, personnel, recoveryKit } = input;
    // Validate everything before mutating (atomic).
    if (!isId(incidentId)) fail('dispatch', 'incidentId must be a valid id');
    if (!isId(teamId)) fail('dispatch', 'teamId must be a valid id');
    if (!isPersonnel(personnel) || personnel < 1) fail('dispatch', 'personnel must be a safe integer >= 1');
    if (typeof recoveryKit !== 'boolean') fail('dispatch', 'recoveryKit must be a boolean');
    const inc = state.incidents[incidentId];
    if (!inc) fail('dispatch', 'unknown incident ' + incidentId);
    if (inc.status === 'RESOLVED') fail('dispatch', 'incident ' + incidentId + ' is already resolved');
    if (!isCoord(inc.position)) fail('dispatch', 'incident position is invalid');
    const team = teamById(state, teamId);
    if (team.status !== 'IDLE') fail('dispatch', 'team ' + teamId + ' is ' + team.status + ', not IDLE');
    if (team.pumpRecharge)
        fail('dispatch', 'team ' + teamId + ' is mid-recharge (' + team.pumpRecharge.remainingS + 's remaining)');
    const available = team.personnel - team.personnelAssigned;
    if (personnel > available) fail('dispatch', 'team ' + teamId + ' has only ' + available + ' personnel available');
    if (recoveryKit && state.shared.recoveryKitsAvailable < 1)
        fail('dispatch', 'recovery kit unavailable (all kits reserved)');
    const hasActive = state.missions.some(m =>
        m.incidentId === incidentId && (m.status === 'EN_ROUTE' || m.status === 'ON_SCENE'));
    if (opts.requireActive && !hasActive)
        fail('reinforce', 'incident ' + incidentId + ' has no active mission to reinforce');

    const travelS = travelSeconds(team.pos, inc.position, team.speedKn);
    const mission = {
        id: 'M' + (++state.counters.mission),
        incidentId, teamId,
        purpose: hasActive ? 'REINFORCEMENT' : 'PRIMARY',
        personnel, recoveryKit,
        origin: { ...team.pos },
        departedAt: state.time, travelS, arriveAt: state.time + travelS,
        status: 'EN_ROUTE', arrivedAt: null,
        returnOrigin: null, returnDepartedAt: null, returnTravelS: null,
        completedAt: null
    };
    state.missions.push(mission);
    team.status = 'EN_ROUTE';
    team.personnelAssigned += personnel;
    // Charge and warning state carry between missions; only replacement resets them.
    if (recoveryKit) state.shared.recoveryKitsAvailable -= 1;
    event(state, 'DISPATCH', { mission: mission.id, team: teamId, incident: incidentId, personnel, recoveryKit, purpose: mission.purpose, travelS });
    return { ...mission };
}

function reinforce(state, input) {
    return dispatch(state, input, { requireActive: true });
}

function activeMissionFor(state, teamId, incidentId) {
    return state.missions.find(m =>
        m.teamId === teamId && m.incidentId === incidentId &&
        (m.status === 'EN_ROUTE' || m.status === 'ON_SCENE'));
}

function command(state, input) {
    if (!input || typeof input !== 'object') fail('command', 'input must be an object');
    const { incidentId, teamId, action } = input;
    if (!isId(incidentId)) fail('command', 'incidentId must be a valid id');
    if (!isId(teamId)) fail('command', 'teamId must be a valid id');
    if (!ACTIONS.includes(action)) fail('command', 'action must be one of ' + ACTIONS.join(', '));
    const inc = incidentById(state, incidentId);
    const team = teamById(state, teamId);
    if (action !== 'RETURN' && action !== 'STOP_PUMP' && inc.status === 'RESOLVED')
        fail('command', 'incident ' + incidentId + ' is already resolved');
    // Every command is bound to the team's active mission for the incident.
    let missionId = null;
    if (action !== 'ACKNOWLEDGE') {
        const m = activeMissionFor(state, teamId, incidentId);
        if (!m) fail('command', 'team ' + teamId + ' has no active mission for ' + incidentId);
        if (action === 'START_PUMP' || action === 'RETURN') {
            if (m.status !== 'ON_SCENE')
                fail('command', 'team ' + teamId + ' is not on scene at ' + incidentId);
        }
        missionId = m.id;
    }
    if (action === 'START_PUMP' && !team.pump.available) fail('command', 'team ' + teamId + ' has no pump');
    if (action === 'STOP_PUMP' && !team.pumpRunning) fail('command', 'pump on ' + teamId + ' is not running');
    const cmd = {
        id: 'C' + (++state.counters.command),
        incidentId, teamId, missionId, action,
        sentAt: state.time, receivedAt: null, executedAt: null, confirmedAt: null,
        failedAt: null, failReason: null, lostAt: null,
        status: 'SENT', sentElapsed: 0, receivedElapsed: 0,
        levelAtSend: inc.waterL, levelAtExec: null
    };
    state.commands.push(cmd);
    event(state, 'CMD_SENT', { command: cmd.id, action, team: teamId, incident: incidentId, mission: missionId });
    return { ...cmd };
}

function sensorReport(state, input) {
    if (!input || typeof input !== 'object') fail('sensorReport', 'input must be an object');
    const { incidentId, kind, value, teamId } = input;
    if (!isId(incidentId)) fail('sensorReport', 'incidentId must be a valid id');
    const inc = incidentById(state, incidentId);
    if (!SENSOR_KINDS.includes(kind)) fail('sensorReport', 'kind must be one of ' + SENSOR_KINDS.join(', '));
    if (teamId !== undefined && teamId !== null) {
        if (!isId(teamId)) fail('sensorReport', 'teamId must be a valid id');
        teamById(state, teamId);
    }
    const at = input.sampleAt === undefined ? state.time : input.sampleAt;
    if (!isTime(at) || at > state.time) fail('sensorReport', 'sampleAt must be a finite past or current time');
    if (state.time - at > C.staleAfterS) return false;
    if (kind === 'WATER_LEVEL') {
        if (!isFiniteNum(value) || value < 0) fail('sensorReport', 'WATER_LEVEL value must be finite >= 0');
        if (inc.lastWater && at < inc.lastWater.at) return false;
        inc.lastWater = { value, at };
        inc.sensorConfirmed = value <= C.safeWaterL;
    } else if (kind === 'CREW_RESCUED') {
        if (!isPersonnel(value) || value > inc.crewOnboard)
            fail('sensorReport', 'CREW_RESCUED value must be a safe integer <= crewOnboard');
        inc.lastCrew = { value, at };
    } else if (kind === 'PUMP_STATE') {
        if (value !== 'on' && value !== 'off') fail('sensorReport', 'PUMP_STATE value must be "on" or "off"');
        if (!teamId) fail('sensorReport', 'PUMP_STATE is team-specific and requires teamId');
        const team = teamById(state, teamId);
        if (team.lastPumpState && at < team.lastPumpState.at) return false;
        team.lastPumpState = { value, at, incidentId };
    }
    event(state, 'SENSOR', { incident: incidentId, kind, value, teamId: teamId || null, at });
}

function setOutage(state, input) {
    if (!input || typeof input !== 'object') fail('setOutage', 'input must be an object');
    const { teamId, fromS, toS } = input;
    if (!isId(teamId)) fail('setOutage', 'teamId must be a valid id');
    if (!isTime(fromS)) fail('setOutage', 'fromS must be a finite time >= 0');
    if (!isTime(toS) || toS <= fromS) fail('setOutage', 'toS must be a finite time > fromS');
    const team = teamById(state, teamId);
    team.outages.push({ fromS, toS });
    team.outages.sort((a, b) => a.fromS - b.fromS);
    event(state, 'OUTAGE_SET', { team: teamId, fromS, toS });
}

function setPumpFault(state, input) {
    if (!input || typeof input !== 'object') fail('setPumpFault', 'input must be an object');
    const { teamId, fault } = input;
    if (!isId(teamId)) fail('setPumpFault', 'teamId must be a valid id');
    if (typeof fault !== 'boolean') fail('setPumpFault', 'fault must be a boolean');
    const team = teamById(state, teamId);
    team.pumpFault = fault;
    if (fault) team.pumpRunning = false;
    event(state, 'PUMP_FAULT_SET', { team: teamId, fault });
}

function dropCommand(state, commandId) {
    if (!isId(commandId)) fail('dropCommand', 'commandId must be a valid id');
    const cmd = state.commands.find(c => c.id === commandId);
    if (!cmd) fail('dropCommand', 'unknown command ' + commandId);
    if (cmd.status !== 'SENT' && cmd.status !== 'RECEIVED')
        fail('dropCommand', 'command ' + commandId + ' is ' + cmd.status + ' and can no longer be lost in transit');
    cmd.status = 'LOST';
    cmd.lostAt = state.time;
    event(state, 'CMD_LOST', { command: commandId });
}

// ---------- simulated-time step ----------
//
// tick() advances in substeps of at most maxSubstepS (1s). Each substep is
// split at the exact arrival / return-arrival event times of the teams in
// it. The substep list is built from distinct, strictly increasing event
// times, so a zero-distance dispatch (instantaneous arrival) completes in
// the first substep without any zero-length loop.
//
// Within a substep, order is: movement (fuel charged on the final leg too,
// so a team can strand at the destination), then the water/crew balance for
// EVERY incident (resolved ones included — that is what reopens them), then
// the command lifecycle, then GPS sampling/delivery.

function consumeFuel(state, team, dtS) {
    team.fuelL = Math.max(0, team.fuelL - team.speedKn * C.fuelLphPerKn * dtS / 3600);
    if (team.fuelL <= 0) {
        team.status = 'NO_FUEL';
        for (const m of state.missions) {
            if (m.teamId === team.id && (m.status === 'EN_ROUTE' || m.status === 'RETURNING')) {
                m.status = 'STALLED';
                event(state, 'NO_FUEL', { team: team.id, mission: m.id });
            }
        }
    }
}

function stepMovement(state, team, mission, t0, dtS) {
    const inc = state.incidents[mission.incidentId];
    consumeFuel(state, team, dtS);
    if (team.status === 'NO_FUEL') return;
    if (mission.status === 'EN_ROUTE') {
        const f = (t0 + dtS - mission.departedAt) / mission.travelS;
        if (f >= 1) {
            team.pos = { ...inc.position };
            team.status = 'ON_SCENE';
            mission.status = 'ON_SCENE';
            mission.arrivedAt = t0 + dtS;
            if (inc.status === 'OPEN') inc.status = 'IN_PROGRESS';
            event(state, 'ARRIVED', { mission: mission.id, team: team.id, incident: mission.incidentId });
        } else {
            team.pos = lerpPos(mission.origin, inc.position, f);
        }
    } else if (mission.status === 'RETURNING') {
        const f = (t0 + dtS - mission.returnDepartedAt) / mission.returnTravelS;
        if (f >= 1) {
            team.pos = { ...team.home };
            team.status = 'IDLE';
            team.personnelAssigned = 0;
            team.pumpRunning = false;
            if (mission.recoveryKit) state.shared.recoveryKitsAvailable += 1;
            mission.status = 'COMPLETED';
            mission.completedAt = t0 + dtS;
            event(state, 'RETURNED', { mission: mission.id, team: team.id });
        } else {
            team.pos = lerpPos(mission.returnOrigin, team.home, f);
        }
    }
}

function stepWork(state, dtS) {
    const t1 = state.time;
    for (const inc of Object.values(state.incidents)) {
        // One water balance for every incident, resolved or not.
        let pumpLpm = 0, personnel = 0, kitHeld = false;
        for (const m of state.missions) {
            if (m.incidentId !== inc.id || m.status !== 'ON_SCENE') continue;
            const team = teamById(state, m.teamId);
            personnel += m.personnel;
            if (m.recoveryKit) kitHeld = true;
            if (team.pumpRunning && team.pump.available && !team.pumpFault) {
                // Consume the pump battery for this substep; a mid-step
                // exhaustion powers only the exact fractional seconds left,
                // and the litres removed use those powered seconds.
                const res = energy.consume(team.pumpBattery, { dtS, running: true });
                team.pumpBattery = res.battery;
                if (res.depleted) team.pumpRunning = false;
                pumpLpm += team.pump.lpm * (res.poweredSeconds / dtS);
                if (res.low && !team.pumpLowAnnounced) {
                    team.pumpLowAnnounced = true;
                    event(state, 'LOW_BATTERY', { team: team.id, mission: m.id, chargeWh: res.battery.chargeWh });
                }
                if (res.depleted && !team.pumpDepletedAnnounced) {
                    team.pumpDepletedAnnounced = true;
                    event(state, 'BATTERY_DEPLETED', { team: team.id, mission: m.id });
                }
            }
        }
        inc.waterL = Math.max(0, inc.waterL + (inc.ingressLpm - pumpLpm) * dtS / 60);
        inc.vesselSafe = inc.waterL <= C.safeWaterL;
        if (inc.status !== 'RESOLVED' && kitHeld && personnel > 0) {
            inc.rescueProgress = Math.min(inc.crewOnboard,
                inc.rescueProgress + personnel * C.rescueRatePerPersonPerMin * dtS / 60);
            inc.crewRescued = Math.min(inc.crewOnboard, Math.floor(inc.rescueProgress + 1e-9));
        }
        if (inc.status === 'RESOLVED') {
            if (!inc.vesselSafe) {
                inc.status = 'IN_PROGRESS';
                inc.resolvedAt = null;
                inc.sensorConfirmed = false;
                event(state, 'REOPENED', { incident: inc.id, reason: 'water above safe level' });
            }
            continue;
        }
        if (!inc.vesselSafe) inc.sensorConfirmed = false; // unsafe again: clear stale confirmation
        if (inc.crewRescued >= inc.crewOnboard && inc.vesselSafe && inc.sensorConfirmed) {
            inc.status = 'RESOLVED';
            inc.resolvedAt = t1;
            event(state, 'RESOLVED', { incident: inc.id });
        }
    }
}

function stepCommands(state, dtS) {
    for (const cmd of state.commands) {
        const team = teamById(state, cmd.teamId);
        const inc = state.incidents[cmd.incidentId];
        if (cmd.status === 'SENT') {
            if (!inOutage(team, state.time)) {
                cmd.sentElapsed += dtS;
                if (cmd.sentElapsed >= C.propagationS) {
                    cmd.status = 'RECEIVED';
                    cmd.receivedAt = state.time;
                    cmd.receivedElapsed = 0;
                    event(state, 'CMD_RECEIVED', { command: cmd.id });
                }
            }
        } else if (cmd.status === 'RECEIVED') {
            cmd.receivedElapsed += dtS;
            if (cmd.receivedElapsed >= C.executionS) {
                // The bound mission must still be active at execution time.
                const m = cmd.missionId ? missionById(state, cmd.missionId) : null;
                const missionOk = m && m.status === 'ON_SCENE';
                let ok = true;
                let reason = null;
                switch (cmd.action) {
                    case 'START_PUMP':
                        if (!missionOk) { ok = false; reason = 'bound mission is no longer on scene'; }
                        else if (!team.pump.available) { ok = false; reason = 'no pump fitted'; }
                        else if (team.pumpFault) { ok = false; reason = 'pump fault'; }
                        else if (team.pumpBattery.chargeWh <= 0) { ok = false; reason = 'pump battery depleted'; }
                        else team.pumpRunning = true;
                        break;
                    case 'STOP_PUMP':
                        if (!missionOk) { ok = false; reason = 'bound mission is no longer on scene'; }
                        else if (!team.pumpRunning) { ok = false; reason = 'pump not running'; }
                        else team.pumpRunning = false;
                        break;
                    case 'RETURN':
                        if (!missionOk) { ok = false; reason = 'bound mission is no longer on scene'; }
                        else {
                            m.status = 'RETURNING';
                            team.status = 'RETURNING';
                            m.returnOrigin = { ...team.pos };
                            m.returnDepartedAt = state.time;
                            m.returnTravelS = travelSeconds(team.pos, team.home, team.speedKn);
                        }
                        break;
                    case 'ACKNOWLEDGE':
                        inc.acknowledged = true;
                        break;
                    default:
                        ok = false;
                        reason = 'unknown action';
                }
                if (ok) {
                    cmd.status = 'EXECUTED';
                    cmd.executedAt = state.time;
                    cmd.levelAtExec = inc.waterL;
                    event(state, 'CMD_EXECUTED', { command: cmd.id, action: cmd.action });
                } else {
                    cmd.status = 'FAILED';
                    cmd.failedAt = state.time;
                    cmd.failReason = reason;
                    event(state, 'CMD_FAILED', { command: cmd.id, reason });
                }
            }
        } else if (cmd.status === 'EXECUTED') {
            if (cmd.action === 'START_PUMP') {
                // Team-specific fresh feedback from SEPARATE reading stores:
                // a PUMP_STATE "on" for this team at/after execution, plus a
                // WATER_LEVEL reading at/after execution below levelAtExec.
                const ps = team.lastPumpState;
                const pumpOk = ps && ps.value === 'on' && ps.at >= cmd.executedAt && state.time - ps.at <= C.staleAfterS && (!ps.incidentId || ps.incidentId === inc.id);
                const wl = inc.lastWater;
                const waterOk = wl && wl.at >= cmd.executedAt && state.time - wl.at <= C.staleAfterS &&
                    cmd.levelAtExec !== null && wl.value < cmd.levelAtExec;
                if (pumpOk && waterOk) {
                    cmd.status = 'CONFIRMED';
                    cmd.confirmedAt = state.time;
                    event(state, 'CMD_CONFIRMED', { command: cmd.id });
                }
            } else if (cmd.action === 'STOP_PUMP' && !team.pumpRunning) {
                cmd.status = 'CONFIRMED'; cmd.confirmedAt = state.time;
                event(state, 'CMD_CONFIRMED', { command: cmd.id });
            } else if (cmd.action === 'RETURN' && (team.status === 'RETURNING' || team.status === 'IDLE')) {
                cmd.status = 'CONFIRMED'; cmd.confirmedAt = state.time;
                event(state, 'CMD_CONFIRMED', { command: cmd.id });
            } else if (cmd.action === 'ACKNOWLEDGE' && inc.acknowledged) {
                cmd.status = 'CONFIRMED'; cmd.confirmedAt = state.time;
                event(state, 'CMD_CONFIRMED', { command: cmd.id });
            }
        }
    }
}

function stepTelemetry(state, dtS) {
    const t1 = state.time;
    for (const team of state.teams) {
        const tel = team.telemetry;
        // Sample a fix at the TRUE position every substep end.
        tel.pending.push({ pos: { ...team.pos }, sentAt: t1 });
        if (tel.pending.length > C.fixQueueMax) tel.pending.shift();
        const keep = [];
        for (const fix of tel.pending) {
            if (t1 - fix.sentAt >= C.telemetryDelayS && !inOutage(team, t1)) {
                tel.receivedFix = fix;
                tel.receivedAt = t1;
            } else {
                keep.push(fix);
            }
        }
        tel.pending = keep;
    }
}

function stepRecharge(state, dtS) {
    for (const team of state.teams) {
        if (!team.pumpRecharge) continue;
        team.pumpRecharge.remainingS -= dtS;
        if (team.pumpRecharge.remainingS <= 0) {
            team.pumpRecharge = null;
            team.pumpBattery = energy.createBattery({ ...team.pumpBattery, chargeWh: team.pumpBattery.capacityWh });
            team.pumpLowAnnounced = false;
            team.pumpDepletedAnnounced = false;
            event(state, 'RECHARGE_COMPLETE', { team: team.id, chargeWh: team.pumpBattery.chargeWh });
        }
    }
}

function tick(state, dtS) {
    if (!isFiniteNum(dtS) || dtS <= 0 || dtS > C.maxTickS)
        fail('tick', 'dtS must be a finite number in (0, ' + C.maxTickS + ']');
    // Build the substep list: boundaries at state.time and state.time+dtS,
    // plus each team's arrival/return event time strictly inside that range.
    // Distinct and strictly increasing -> no zero-length substeps, even for
    // instantaneous (zero-distance) arrivals.
    const bounds = [state.time];
    const tEnd = state.time + dtS;
    for (let at = state.time + 1; at < tEnd; at += 1) bounds.push(at);
    for (const m of state.missions) {
        const team = teamById(state, m.teamId);
        if (team.status === 'NO_FUEL') continue;
        let ev = null;
        if (m.status === 'EN_ROUTE') ev = m.arriveAt;
        else if (m.status === 'RETURNING') ev = m.returnDepartedAt + m.returnTravelS;
        if (ev !== null && ev > state.time + 1e-9 && ev < tEnd - 1e-9) bounds.push(ev);
    }
    bounds.push(tEnd);
    bounds.sort((a, b) => a - b);
    const substeps = [];
    let prev = bounds[0];
    for (let i = 1; i < bounds.length; i++) {
        const b = bounds[i];
        if (b - prev > 1e-9) substeps.push(b - prev);
        prev = b;
    }
    for (const sub of substeps) {
        state.time += sub;
        stepRecharge(state, sub); // progresses even with no active mission
        // Only teams already on scene at the start of this interval can work.
        stepWork(state, sub);
        for (const m of state.missions) {
            const team = teamById(state, m.teamId);
            if (team.status === 'NO_FUEL') continue;
            if (m.status === 'EN_ROUTE' || m.status === 'RETURNING') {
                stepMovement(state, team, m, state.time - sub, sub);
            }
        }
        stepCommands(state, sub);
        stepTelemetry(state, sub);
    }
}

// ---------- read-only view ----------

function recharge(state, input) {
    if (!input || typeof input !== 'object') fail('recharge', 'input must be an object');
    const { teamId } = input;
    if (!isId(teamId)) fail('recharge', 'teamId must be a valid id');
    const team = teamById(state, teamId);
    if (team.status !== 'IDLE')
        fail('recharge', 'team ' + teamId + ' is ' + team.status + ', must be IDLE at harbour');
    if (distanceKm(team.pos, team.home) > 1e-6)
        fail('recharge', 'team ' + teamId + ' is not at its harbour position');
    if (team.pumpRecharge)
        fail('recharge', 'team ' + teamId + ' is already recharging (' + team.pumpRecharge.remainingS + 's remaining)');
    team.pumpRecharge = { remainingS: C.rechargeS };
    event(state, 'RECHARGE_START', { team: teamId, remainingS: C.rechargeS });
    return { teamId, remainingS: C.rechargeS };
}

function status(state) {
    const teams = state.teams.map(t => {
        const fix = t.telemetry.receivedFix;
        const ageS = fix ? state.time - fix.sentAt : null;
        const bat = t.pumpBattery;
        return {
            id: t.id, name: t.name, status: t.status,
            pos: { ...t.pos },
            fuelL: t.fuelL, speedKn: t.speedKn,
            personnel: { total: t.personnel, assigned: t.personnelAssigned, available: t.personnel - t.personnelAssigned },
            pump: {
                available: t.pump.available, lpm: t.pump.lpm,
                running: t.pumpRunning, fault: t.pumpFault,
                battery: {
                    capacityWh: bat.capacityWh, chargeWh: bat.chargeWh,
                    drawW: bat.drawW, lowFraction: bat.lowFraction,
                    percent: bat.capacityWh > 0 ? bat.chargeWh / bat.capacityWh : 0,
                    low: bat.chargeWh <= bat.capacityWh * bat.lowFraction,
                    depleted: bat.chargeWh === 0
                },
                recharge: t.pumpRecharge ? { remainingS: t.pumpRecharge.remainingS } : null,
                estimatedRunS: bat.drawW > 0 ? (bat.chargeWh / bat.drawW) * 3600 : null
            },
            lastPumpState: t.lastPumpState ? { ...t.lastPumpState } : null,
            telemetry: {
                receivedPos: fix ? { ...fix.pos } : null,
                fixSentAt: fix ? fix.sentAt : null,
                receivedAt: t.telemetry.receivedAt,
                ageS,
                stale: ageS === null || ageS > C.staleAfterS,
                pendingFixes: t.telemetry.pending.length
            }
        };
    });
    const incidents = Object.values(state.incidents).map(i => ({
        id: i.id, kind: i.kind, status: i.status,
        position: { ...i.position }, reportedAt: i.reportedAt, resolvedAt: i.resolvedAt,
        crewOnboard: i.crewOnboard, crewRescued: i.crewRescued,
        waterL: i.waterL, ingressLpm: i.ingressLpm, vesselSafe: i.vesselSafe,
        sensorConfirmed: i.sensorConfirmed, acknowledged: i.acknowledged,
        lastWater: i.lastWater ? { ...i.lastWater } : null,
        lastCrew: i.lastCrew ? { ...i.lastCrew } : null,
        unsafe: i.status === 'RESOLVED' ? [] : [
            ...(i.crewRescued < i.crewOnboard ? ['CREW_UNRESCUED'] : []),
            ...(!i.vesselSafe ? ['WATER_ABOVE_SAFE'] : []),
            ...(!i.sensorConfirmed ? ['NOT_SENSOR_CONFIRMED'] : [])
        ]
    }));
    const missions = state.missions.map(m => ({
        id: m.id, incidentId: m.incidentId, teamId: m.teamId, purpose: m.purpose,
        personnel: m.personnel, recoveryKit: m.recoveryKit,
        status: m.status, departedAt: m.departedAt, arriveAt: m.arriveAt,
        arrivedAt: m.arrivedAt, completedAt: m.completedAt
    }));
    const commands = state.commands.map(c => ({
        id: c.id, incidentId: c.incidentId, teamId: c.teamId, missionId: c.missionId,
        action: c.action,
        status: c.status, sentAt: c.sentAt, receivedAt: c.receivedAt,
        executedAt: c.executedAt, confirmedAt: c.confirmedAt,
        failedAt: c.failedAt, failReason: c.failReason
    }));
    const allClear =
        incidents.every(i => i.status === 'RESOLVED') &&
        !teams.some(t => t.status === 'NO_FUEL') &&
        !missions.some(m => m.status === 'EN_ROUTE' || m.status === 'ON_SCENE' || m.status === 'RETURNING');
    return {
        version: state.version,
        time: state.time,
        allClear,
        limits: {
            safeWaterL: C.safeWaterL, staleAfterS: C.staleAfterS,
            propagationS: C.propagationS, executionS: C.executionS,
            telemetryDelayS: C.telemetryDelayS,
            rescueRatePerPersonPerMin: C.rescueRatePerPersonPerMin,
            fuelLphPerKn: C.fuelLphPerKn
        },
        harbour: { ...state.harbour },
        teams,
        shared: { recoveryKits: { total: state.shared.recoveryKitsTotal, available: state.shared.recoveryKitsAvailable } },
        incidents, missions, commands,
        events: { count: state.events.length, last: state.events.slice(-25) }
    };
}

module.exports = {
    KINDS, ACTIONS, SENSOR_KINDS,
    createState, addIncident, dispatch, reinforce, command, recharge,
    sensorReport, setOutage, setPumpFault, dropCommand,
    tick, status, distanceKm,
    isId, isCoord, isPersonnel, isTime, isFiniteNum
};
