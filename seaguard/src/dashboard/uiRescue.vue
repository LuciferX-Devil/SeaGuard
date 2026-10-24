<template>
    <div class="sg" v-if="p">
        <div class="sg-h">
            <h2>Rescue exercise</h2>
            <span class="sg-sub">Guided rescue scenarios with simulated teams, equipment and comms. Independent of the fleet campaign — its own clock, no real messages.</span>
        </div>
        <div v-if="p.error" class="sg-notice" role="alert">{{ p.error }}</div>
        <div v-if="p.guidance" class="sg-notice">{{ p.guidance }}</div>
        <div v-if="p.save && p.save.error" class="sg-notice" role="alert">Checkpoint failed: {{ p.save.error }}. The current exercise is still in memory.</div>
        <div v-if="p.running && p.paused" class="sg-notice" role="status">
            Exercise paused{{ p.restored ? ' — restored from a durable checkpoint' : '' }}. Press Resume to continue.
        </div>

        <div class="sg-card" style="margin-bottom:.6rem">
            <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
                <label class="sg-sub">Scenario
                    <select class="sg-in" v-model="scenario" :disabled="p.running">
                        <option value="">—</option>
                        <option value="FLOODING">Flooding</option>
                        <option value="MAN_OVERBOARD">Man overboard</option>
                        <option value="RADIO_FAILURE">Radio failure</option>
                        <option value="BOUNDARY_APPROACH">Boundary approach</option>
                    </select>
                </label>
                <button class="sg-btn go" :disabled="!scenario || p.running" @click="cmd({action:'start', scenario})">Start</button>
                <button class="sg-btn" v-if="p.running" @click="cmd({action:'reset'})">Reset</button>
                <button class="sg-btn" v-if="p.running && !p.paused" @click="cmd({action:'pause'})">Pause</button>
                <button class="sg-btn" v-if="p.running && p.paused" @click="cmd({action:'resume'})">Resume</button>
                <button class="sg-btn" v-if="p.running" @click="cmd({action:'save'})" title="Write a durable checkpoint now">Save checkpoint</button>
                <button class="sg-btn" v-if="p.running" @click="cmd({action:'load'})" title="Reload the last durable checkpoint">Load checkpoint</button>
                <label class="sg-sub" v-if="p.running">Speed
                    <select class="sg-in" v-model="speed" @change="cmd({action:'setSpeed', speed: Number(speed)})">
                        <option :value="1">&times;1</option><option :value="2">&times;2</option><option :value="5">&times;5</option>
                        <option :value="10">&times;10</option><option :value="20">&times;20</option>
                    </select>
                </label>
                <span class="sg-spacer"></span>
                <span class="sg-sub" v-if="p.running">t+{{ p.simTime }}s · {{ p.paused ? 'paused' : 'running' }}</span>
                <span class="sg-sub" v-if="p.save" :class="p.save.ok ? 'sg-pass' : 'sg-fail'" title="Durable checkpoint status">
                    checkpoint: {{ p.save.ok ? (p.save.source + ' @ t+' + p.save.simTime + 's') : 'none' }}
                </span>
            </div>
            <div v-if="p.results" class="sg-bar" style="margin-top:.45rem">
                <i :style="{width: (p.results.allClear ? 100 : 50) + '%'}"></i>
            </div>
            <div class="sg-sub" style="margin-top:.35rem" v-if="p.incident">
                {{ p.incident.id }} · crew {{ p.incident.crewRescued }}/{{ p.incident.crewOnboard }} · water {{ p.incident.waterL.toFixed(1) }} L (ingress {{ p.incident.ingressLpm }} L/min) ·
                <span :class="p.incident.status === 'RESOLVED' ? 'sg-pass' : 'sg-fail'">{{ p.incident.status.toLowerCase() }}</span>
                <span v-if="p.incident.unsafe.length"> · unsafe: {{ p.incident.unsafe.join(', ') }}</span>
            </div>
        </div>

        <div class="sg-two">
            <div>
                <h3>Dispatch and actions</h3>
                <div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin-bottom:.4rem">
                    <label class="sg-sub">Team
                        <select class="sg-in" v-model="teamId">
                            <option v-for="t in p.teams" :key="t.id" :value="t.id">{{ t.id }} ({{ t.personnel.available }} free)</option>
                        </select>
                    </label>
                    <label class="sg-sub">Crew
                        <input class="sg-in" type="number" style="width:4rem" v-model.number="manpower" min="1" :max="selectedTeam ? selectedTeam.personnel.available : 0" step="1" inputmode="numeric">
                    </label>
                    <label class="sg-sub"><input type="checkbox" v-model="kit"> recovery kit</label>
                    <button class="sg-btn go" :disabled="!canDispatch" @click="cmd({action:'dispatch', teamId, personnel: manpower, recoveryKit: kit})">Dispatch</button>
                    <button class="sg-btn" :disabled="!canDispatch || !p.missions.some(m => ['EN_ROUTE','ON_SCENE'].includes(m.status))" @click="cmd({action:'reinforce', teamId, personnel: manpower, recoveryKit: kit})">Reinforce</button>
                </div>
                <p class="sg-sub">Recovery kits available: {{ p.shared.recoveryKits.available }}. A team's boat must return before another mission can use it.</p>
                <div v-for="t in p.teams" :key="t.id" class="sg-card" style="margin-bottom:.4rem">
                    <b>{{ t.id }} · {{ t.name }}</b> · {{ t.status.toLowerCase().replace(/_/g,' ') }} · fuel {{ t.fuelL.toFixed(1) }} L<br>
                    <span :class="t.telemetry.stale ? 'sg-fail' : 'sg-sub'">GPS: {{ t.telemetry.ageS == null ? 'awaiting first received fix' : Math.round(t.telemetry.ageS) + 's old' }}{{ t.telemetry.stale ? ' (unverified)' : '' }}</span>
                    · pump {{ t.pump.fault ? 'fault' : t.pump.running ? 'running' : 'off' }}<br>
                    <span :class="t.pump.battery.depleted || t.pump.battery.low ? 'sg-fail' : 'sg-sub'">battery (simulated) {{ t.pump.battery.chargeWh.toFixed(1) }}/{{ t.pump.battery.capacityWh }} Wh · {{ Math.round(t.pump.battery.percent * 100) }}%{{ t.pump.battery.depleted ? ' · DEPLETED' : t.pump.battery.low ? ' · LOW' : '' }} · est. run {{ t.pump.estimatedRunS == null ? '—' : Math.round(t.pump.estimatedRunS / 60) + ' min' }}{{ t.pump.recharge ? ' · replacement ' + Math.ceil(t.pump.recharge.remainingS) + 's left' : '' }}</span>
                    <button v-if="t.status === 'IDLE' && !t.pump.recharge" class="sg-btn" style="margin-left:.4rem" :disabled="!p.running" title="Illustrative simulated battery replacement (60s)" @click="cmd({action:'recharge', teamId: t.id})">Replace battery (60s)</button>
                </div>
                <div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin-bottom:.4rem">
                    <button class="sg-btn" :disabled="!onScene || selectedTeam.pump.running" @click="cmd({action:'command', teamId, action2:'START_PUMP'})">Start pump</button>
                    <button class="sg-btn" :disabled="!onScene || !selectedTeam.pump.running" @click="cmd({action:'command', teamId, action2:'STOP_PUMP'})">Stop pump</button>
                    <button class="sg-btn" :disabled="!p.running" @click="cmd({action:'command', teamId, action2:'ACKNOWLEDGE'})">Acknowledge</button>
                    <button class="sg-btn" :disabled="!onScene" @click="cmd({action:'command', teamId, action2:'RETURN'})">Return to harbour</button>
                </div>
                <div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin-bottom:.4rem">
                    <button class="sg-btn" v-if="p.scenario === 'FLOODING'" :disabled="!p.running" @click="cmd({action:'repair'})">Repair hull (stop ingress)</button>
                    <button class="sg-btn" v-if="p.scenario === 'BOUNDARY_APPROACH'" :disabled="!p.running" @click="cmd({action:'returnSafe'})">Return to safe water</button>
                    <button class="sg-btn" v-if="p.scenario === 'RADIO_FAILURE'" :disabled="!p.running" @click="cmd({action:'radioRepair'})">Repair radio (delayed)</button>
                </div>
                <div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
                    <label class="sg-sub"><input type="checkbox" v-model="pumpFault"> pump fault ({{ teamId }})</label>
                    <button class="sg-btn" :disabled="!p.running" @click="cmd({action:'setPumpFault', teamId, fault: pumpFault})">Apply</button>
                    <label class="sg-sub">Outage ({{ teamId }}): now +
                        <input class="sg-in" style="width:3.5rem" v-model.number="outFrom" inputmode="numeric">s for
                        <input class="sg-in" style="width:3.5rem" v-model.number="outDur" inputmode="numeric">s
                    </label>
                    <button class="sg-btn" :disabled="!p.running" @click="cmd({action:'setOutage', teamId, fromS: outFrom, toS: outFrom + outDur})">Apply outage</button>
                </div>

                <h3>Missions</h3>
                <table class="sg-table">
                    <thead><tr><th>Mission</th><th>Team</th><th>Purpose</th><th>Crew</th><th>Kit</th><th>Stage</th><th>ETA</th></tr></thead>
                    <tbody>
                        <tr v-for="m in p.missions" :key="m.id">
                            <td class="sg-sub">{{ m.id }}</td>
                            <td>{{ m.teamId }}</td>
                            <td>{{ m.purpose === 'REINFORCEMENT' ? 'reinforce' : 'primary' }}</td>
                            <td>{{ m.personnel }}</td>
                            <td>{{ m.recoveryKit ? 'yes' : '—' }}</td>
                            <td :class="m.status === 'STALLED' ? 'sg-fail' : m.status === 'COMPLETED' ? 'sg-pass' : ''">{{ m.status.toLowerCase() }}</td>
                            <td class="sg-num">{{ m.etaS == null ? '—' : Math.ceil(m.etaS) + 's' }}</td>
                        </tr>
                        <tr v-if="!p.missions.length"><td colspan="7" class="sg-sub">No missions yet — dispatch a team.</td></tr>
                    </tbody>
                </table>

                <h3>Commands</h3>
                <table class="sg-table">
                    <thead><tr><th>Cmd</th><th>Team</th><th>Action</th><th>Sent</th><th>Received</th><th>Executed</th><th>Confirmed</th><th>Stage</th></tr></thead>
                    <tbody>
                        <tr v-for="c in p.commands" :key="c.id">
                            <td class="sg-sub">{{ c.id }}</td>
                            <td>{{ c.teamId }}</td>
                            <td>{{ c.action.toLowerCase() }}</td>
                            <td class="sg-num">{{ c.sentAt }}</td>
                            <td class="sg-num">{{ c.receivedAt == null ? '—' : c.receivedAt }}</td>
                            <td class="sg-num">{{ c.executedAt == null ? '—' : c.executedAt }}</td>
                            <td class="sg-num">{{ c.confirmedAt == null ? '—' : c.confirmedAt }}</td>
                            <td :class="c.status === 'FAILED' ? 'sg-fail' : c.status === 'CONFIRMED' ? 'sg-pass' : ''">{{ c.status.toLowerCase() }}<span v-if="c.failReason"> ({{ c.failReason }})</span></td>
                        </tr>
                        <tr v-if="!p.commands.length"><td colspan="8" class="sg-sub">No commands yet.</td></tr>
                    </tbody>
                </table>
            </div>

            <div>
                <h3>Rescue map</h3>
                <button class="sg-btn" @click="cmd({action:'recenter'})">Centre rescue area</button>
                <iframe title="Geographical rescue map" src="/rescue" style="width:100%;height:440px;border:1px solid #b9cdd6;background:#fff;margin-top:.4rem"></iframe>
                <p class="sg-sub">Geographical tiles need internet access; a grey background means tiles are unavailable or loading. Positions and routes are simulated and not navigational data. Team markers use received GPS fixes; amber means stale. The casualty marker is the exercise distress location.</p>
                <p v-if="p.sensors" :class="p.sensors.stale || p.sensors.disagreement ? 'sg-fail' : 'sg-sub'">Water telemetry: {{ p.sensors.waterAgeS == null ? 'awaiting report' : p.sensors.waterAgeS + 's old' }}{{ p.sensors.stale ? ' · stale' : '' }}{{ p.sensors.disagreement ? ' · differs from simulated instrument truth' : '' }}</p>
                <h3>Timeline</h3>
                <div class="sg-log sg-scroll">
                    <div v-for="(e, i) in timeline" :key="i">
                        <span class="tt">t+{{ e.t }}s</span>
                        <span class="sg-tag" :class="e.kind === 'REOPENED' || e.kind === 'NO_FUEL' || e.kind === 'CMD_FAILED' ? 'crit' : e.kind === 'RESOLVED' || e.kind === 'EXERCISE_COMPLETE' ? 'mag' : ''">{{ e.kind.toLowerCase().replace(/_/g, ' ') }}</span>
                        <span v-if="e.detail && e.detail.team">team {{ e.detail.team }}</span>
                        <span v-if="e.detail && e.detail.mission"> {{ e.detail.mission }}</span>
                        <span v-if="e.detail && e.detail.kind"> {{ e.detail.kind }}={{ typeof e.detail.value === 'number' ? Number(e.detail.value.toFixed(1)) : e.detail.value }}</span>
                    </div>
                    <div v-if="!timeline.length"><span class="sg-sub">Start a scenario to see the exercise timeline.</span></div>
                </div>

                <h3>Results</h3>
                <div v-if="p.results" class="sg-card"
                     :style="{borderLeft: '5px solid ' + (p.results.allClear ? '#2f7d5b' : '#b02418')}">
                    <div style="display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap">
                        <span :class="p.results.allClear ? 'sg-pass' : 'sg-fail'" style="font-size:1.05rem">
                            {{ p.results.allClear ? 'All clear — teams home' : (p.results.resolved && p.results.vesselSafe ? 'Casualty safe — recover your teams' : 'In progress — hazards remain') }}
                        </span>
                        <span class="sg-sub">crew safe: {{ p.results.crewSafe ? 'yes' : 'no' }} · vessel safe: {{ p.results.vesselSafe ? 'yes' : 'no' }}</span>
                    </div>
                    <table class="sg-table" style="margin-top:.35rem">
                        <thead><tr><th>Metric</th><th>Value</th></tr></thead>
                        <tbody>
                            <tr><td>First dispatch</td><td class="sg-num">{{ p.results.delays.dispatchS == null ? '—' : 't+' + p.results.delays.dispatchS + 's' }}</td></tr>
                            <tr><td>First arrival</td><td class="sg-num">{{ p.results.delays.arrivalS == null ? '—' : 't+' + p.results.delays.arrivalS + 's' }}</td></tr>
                            <tr><td>Resolved</td><td class="sg-num">{{ p.results.delays.resolutionS == null ? '—' : 't+' + p.results.delays.resolutionS + 's' }}</td></tr>
                            <tr><td>Acknowledgement delay</td><td>{{ p.results.delays.acknowledgementS == null ? 'not acknowledged' : p.results.delays.acknowledgementS + 's' }}</td></tr>
                            <tr v-if="p.results.repair"><td>Hull repair</td><td>{{ p.results.repair.done ? 'done' : 'pending' }}</td></tr>
                            <tr v-if="p.results.radio"><td>Radio</td><td>{{ p.results.radio.restored ? 'restored' : 'down' }}</td></tr>
                        </tbody>
                    </table>
                </div>
                <div v-else class="sg-sub">Results appear when the incident resolves.</div>

            </div>
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return { scenario: '', speed: 1, teamId: 'T1', manpower: 2, kit: true, pumpFault: false, outFrom: 0, outDur: 60 };
    },
    computed: {
        p() { return this.msg && this.msg.payload ? this.msg.payload : null; },
        timeline() { return this.p ? this.p.timeline.slice().reverse() : []; }
        ,selectedTeam() { return this.p && this.p.teams.find(t => t.id === this.teamId); }
        ,onScene() { return !!this.selectedTeam && this.selectedTeam.status === 'ON_SCENE'; }
        ,canDispatch() { return this.p && this.p.running && this.selectedTeam && this.selectedTeam.status === 'IDLE' && Number.isSafeInteger(this.manpower) && this.manpower > 0 && this.manpower <= this.selectedTeam.personnel.available && (!this.kit || this.p.shared.recoveryKits.available > 0) && this.p.incident && this.p.incident.status !== 'RESOLVED'; }
    },
    watch: { msg: { handler(m) { if(m && m.payload) { if(m.payload.scenario) this.scenario = m.payload.scenario; this.speed = m.payload.speed; } } } },
    methods: {
        cmd(c) { this.send({ topic: 'cmd', payload: c }); }
    }
};
</script>
