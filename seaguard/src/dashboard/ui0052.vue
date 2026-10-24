<template>
    <div class="sg" v-if="p">
        <div class="sg-h">
            <h2>Fleet</h2>
            <span class="sg-sub" v-if="p.head.mode === 'test'">Test campaign {{ p.head.seed }} · {{ p.head.testState.toLowerCase() }} · t+{{ p.head.t }} s</span>
            <span class="sg-sub" v-else>Live simulation · t+{{ p.head.t }} s</span>
            <span class="sg-sub">speed &times;{{ p.head.speed }}{{ p.head.running ? '' : ' · paused' }}</span>
            <span class="sg-spacer"></span>
            <button class="sg-btn" @click="cmd({cmd: p.head.running ? 'pause' : 'resume'})">{{ p.head.running ? 'Pause' : 'Resume' }}</button>
            <button v-for="s in [1,5,10,20]" :key="s" class="sg-btn" :class="{on: p.head.speed == s}" @click="cmd({cmd:'speed', speed:s})">&times;{{ s }}</button>
            <button class="sg-btn" @click="cmd({cmd:'live'})">Restart simulation</button>
        </div>
        <div class="sg-notice">Simulation only · Boat positions, maritime boundaries and emergencies are illustrative. Alerts use the local mock unless live messaging is explicitly enabled.</div>

        <div class="sg-kpis">
            <div class="sg-kpi"><b class="sg-num">{{ p.kpi.atSea }}</b><span>boats at sea</span></div>
            <div class="sg-kpi" :class="p.kpi.critical ? 'alert' : ''"><b class="sg-num">{{ p.kpi.open }}</b><span>open incidents</span></div>
            <div class="sg-kpi" :class="p.kpi.critical ? 'alert' : ''"><b class="sg-num">{{ p.kpi.critical }}</b><span>critical</span></div>
            <div class="sg-kpi" :class="p.kpi.gateway === 'offline' ? 'warn' : ''"><b>{{ p.kpi.gateway }}</b><span>shore gateway</span></div>
            <div class="sg-kpi" :class="p.kpi.storms ? 'warn' : ''"><b>{{ p.kpi.storms ? p.kpi.storms + ' storm' : p.kpi.weather.toLowerCase() }}</b><span>weather feed</span></div>
            <div class="sg-kpi" :class="p.kpi.alerts ? 'warn' : ''"><b class="sg-num">{{ p.kpi.alerts }}</b><span>alerts in flight</span></div>
        </div>

        <div class="sg-boats">
            <div v-for="b in p.boats" :key="b.id" class="sg-boat" :class="b.level">
                <div class="nm">{{ b.id }} · {{ b.name }}</div>
                <div class="st" :class="'lvl-' + b.level">{{ b.text }}</div>
                <div class="sg-kv">
                    <span>Last fix</span><span>{{ b.shore.lat ? b.shore.lat.toFixed(4) + ', ' + b.shore.lon.toFixed(4) : 'no fix yet' }}</span>
                    <span>Heard</span><span>{{ b.shore.age == null ? '-' : b.shore.age + ' s ago' }}<template v-if="b.shore.rssi"> · {{ b.shore.rssi }} dBm</template></span>
                    <span>Speed</span><span>{{ b.shore.spd == null ? '-' : (b.shore.spd * 1.94).toFixed(1) + ' kn' }}</span>
                    <span>Roll</span><span>{{ b.shore.roll == null ? '-' : b.shore.roll + '&deg;' }}</span>
                    <span>Bilge</span><span>{{ b.shore.level == null ? '-' : b.shore.level + ' %' }}</span>
                    <span>Crew aboard</span><span>{{ b.shore.crew == null ? '-' : b.shore.crew + '/' + b.shore.crewTotal }}</span>
                    <span>Battery</span><span>{{ b.shore.bat == null ? '-' : b.shore.bat + ' %' }}</span>
                    <span>Boundary</span><span>{{ b.geo.d == null ? '-' : b.geo.d < 0 ? (-b.geo.d / 1000).toFixed(1) + ' km beyond' : (b.geo.d / 1000).toFixed(1) + ' km off' }}</span>
                </div>
                <div class="sg-note" v-if="b.incident">
                    {{ b.incident.id }} · {{ b.incident.severityName }}<template v-if="b.incident.rules.length"> · {{ b.incident.rules.join(', ').toLowerCase().replace(/_/g,' ') }}</template>
                    <template v-if="b.incident.status === 'ACKED'"> · acknowledged</template>
                    <template v-else-if="b.incident.escalation > 1"> · escalated to the coast guard</template>
                    <button class="sg-btn" style="margin-left:.4rem" v-if="b.incident.status === 'OPEN'" @click="cmd({cmd:'ack', id:b.incident.id, by:'dashboard'})">Acknowledge</button>
                </div>
                <div class="sg-note" v-if="b.adv">On-board advisory: {{ b.adv.text }}</div>
            </div>
        </div>

        <h3>What the shore knows, and what is really happening</h3>
        <div class="sg-sub" style="margin-bottom:.3rem">The right-hand columns come from the simulator itself, not from the radio link, so the gap between them is the effect of packet loss and delay.</div>
        <table class="sg-table">
            <thead><tr><th>Boat</th><th>Shore position</th><th>Age</th><th>Simulated position</th><th>Error</th><th>State</th><th>Crew</th><th>Zone</th><th>Waves</th></tr></thead>
            <tbody>
                <tr v-for="b in p.boats" :key="b.id">
                    <td>{{ b.id }}</td>
                    <td class="sg-num">{{ b.shore.lat ? b.shore.lat.toFixed(4) + ', ' + b.shore.lon.toFixed(4) : '-' }}</td>
                    <td class="sg-num">{{ b.shore.posAge == null ? '-' : b.shore.posAge + ' s' }}</td>
                    <td class="sg-num">{{ b.truth.lat ? b.truth.lat.toFixed(4) + ', ' + b.truth.lon.toFixed(4) : '-' }}</td>
                    <td class="sg-num">{{ err(b) }}</td>
                    <td>{{ b.truth.capsized ? 'capsized' : b.truth.flooding ? 'taking water' : b.truth.mode }}</td>
                    <td class="sg-num">{{ b.truth.crewAboard }}/{{ b.truth.crewTotal }}</td>
                    <td>{{ b.truth.zoneName }}</td>
                    <td class="sg-num">{{ b.truth.wave == null ? '-' : b.truth.wave.toFixed(1) + ' m' }}</td>
                </tr>
            </tbody>
        </table>
    </div>
    <div class="sg" v-else>Waiting for the first simulation tick.</div>
</template>

<script>
    export default {
        computed: {
            p() { return this.msg && this.msg.payload ? this.msg.payload : null; }
        },
        methods: {
            cmd(c) { this.send({ topic: 'cmd', payload: c }); },
            err(b) {
                if (!b.shore.lat || !b.truth.lat) return '-';
                const dy = (b.truth.lat - b.shore.lat) * 111320;
                const dx = (b.truth.lon - b.shore.lon) * 109800;
                return Math.round(Math.sqrt(dx * dx + dy * dy)) + ' m';
            }
        }
    }
</script>
