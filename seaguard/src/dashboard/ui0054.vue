<template>
    <div class="sg" v-if="p">
        <div class="sg-h">
            <h2>Incidents and correlation</h2>
            <span class="sg-sub">Raw events are grouped into incidents so one emergency produces one alert, not five.</span>
        </div>

        <div class="sg-two">
            <div>
                <h3>Incidents</h3>
                <div class="sg-scroll" style="max-height:620px">
                    <div v-for="i in p.incidents" :key="i.id" class="sg-card" style="margin-bottom:.4rem"
                         :style="{borderLeft: '4px solid ' + colour(i)}">
                        <div style="display:flex;gap:.4rem;align-items:baseline;flex-wrap:wrap">
                            <b>{{ i.id }}</b>
                            <span class="st" style="font-weight:600">{{ i.title }}</span>
                            <span class="sg-tag" :class="i.severity >= 4 ? 'crit' : i.severity === 3 ? 'high' : ''">{{ i.severityName }}</span>
                            <span class="sg-tag">{{ i.kind === 'boat' ? i.boat + ' ' + i.boatName : 'fleet' }}</span>
                            <span class="sg-tag ok" v-if="i.status === 'RESOLVED'">resolved: {{ i.resolution }}</span>
                            <span class="sg-tag ok" v-else-if="i.status === 'ACKED'">acknowledged by {{ i.ackedBy }}</span>
                            <span class="sg-tag crit" v-else-if="i.escalation > 1">escalated to the coast guard</span>
                            <span class="sg-spacer"></span>
                            <button class="sg-btn" v-if="i.status === 'OPEN'" @click="cmd({cmd:'ack', id:i.id, by:'dashboard'})">Acknowledge</button>
                            <button class="sg-btn" v-if="i.status !== 'RESOLVED'" @click="cmd({cmd:'resolve', id:i.id, by:'dashboard'})">Close</button>
                        </div>
                        <div class="sg-sub" v-if="i.rules.length">Rules applied: {{ i.rules.map(r => ruleName(r)).join(', ') }}</div>
                        <div class="sg-log" style="margin-top:.2rem">
                            <div v-for="(e,k) in i.events" :key="k">
                                <span class="tt">t+{{ e.t }}s</span>
                                <span class="sg-tag">{{ e.source }}</span>
                                <span>{{ describe(e) }}</span>
                            </div>
                        </div>
                        <div class="sg-sub" style="margin-top:.2rem">
                            opened t+{{ i.opened }}s · {{ i.notifications.length }} message batch(es) sent<template v-if="i.folded"> · {{ i.folded }} repeat event(s) folded in</template><template v-if="i.reopened"> · reopened {{ i.reopened }}&times;</template>
                        </div>
                    </div>
                </div>
            </div>
            <div>
                <h3>How correlation is decided</h3>
                <table class="sg-table">
                    <thead><tr><th>Rule</th><th>What it does</th><th>Used</th></tr></thead>
                    <tbody>
                        <tr v-for="r in rules" :key="r.k">
                            <td>{{ r.k }}</td><td>{{ r.d }}</td><td class="sg-num">{{ p.rules[r.k] || 0 }}</td>
                        </tr>
                    </tbody>
                </table>

                <h3>Events the engine chose not to alarm on</h3>
                <div class="sg-log sg-scroll" style="max-height:170px">
                    <div v-for="(s,i) in p.suppressions" :key="i">
                        <span class="tt">t+{{ s.t }}s</span>
                        <span class="sg-tag mag">{{ s.rule }}</span>
                        <span>{{ s.boat !== 'FLEET' ? s.boat + ' ' : '' }}{{ s.type }} &mdash; {{ s.reason }}</span>
                    </div>
                    <div v-if="!p.suppressions.length"><span class="sg-sub">Nothing suppressed yet.</span></div>
                </div>

                <h3>Event stream into the engine</h3>
                <div class="sg-log sg-scroll" style="max-height:220px">
                    <div v-for="(e,i) in p.events" :key="i">
                        <span class="tt">t+{{ e.t }}s</span>
                        <span class="sg-tag" :class="e.disposition === 'NEW_INCIDENT' ? 'crit' : e.disposition === 'MERGED' ? 'high' : ''">{{ e.disposition }}</span>
                        <span>{{ e.boat }} {{ e.type }}<template v-if="e.incident"> &rarr; {{ e.incident }}</template><template v-if="e.note"> ({{ e.note }})</template></span>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <div class="sg" v-else>Waiting for events.</div>
</template>

<script>
    export default {
        data() {
            return {
                rules: [
                    { k: 'R1', d: 'Two or more emergencies on one boat inside 90 s become a single "vessel in distress" alert' },
                    { k: 'R2', d: 'An emergency inside a zone with an active storm is marked storm amplified' },
                    { k: 'R3', d: 'A boat that falls silent inside a storm zone is treated as possible distress, not a radio fault' },
                    { k: 'R4', d: 'While the shore gateway is offline, per-boat "no contact" alerts are suppressed in favour of one gateway incident' },
                    { k: 'R5', d: 'Repeats of an event fold into the open incident; a recurrence just after closure reopens it without a new alert' },
                    { k: 'R6', d: 'A critical incident nobody acknowledges within 60 s is re-sent to the coast guard, marked escalated' }
                ]
            };
        },
        computed: { p() { return this.msg && this.msg.payload ? this.msg.payload : null; } },
        methods: {
            cmd(c) { this.send({ topic: 'cmd', payload: c }); },
            colour(i) { return i.severity >= 4 ? '#b02418' : i.severity === 3 ? '#c07c0d' : i.severity === 2 ? '#b0277a' : '#3e6e8e'; },
            ruleName(r) { return r.toLowerCase().replace(/_/g, ' '); },
            describe(e) {
                const d = e.data || {};
                switch (e.type) {
                    case 'CAPSIZE': return 'capsize, roll ' + d.roll + ' deg';
                    case 'FLOODING': return 'flooding, bilge ' + d.level + ' %';
                    case 'MOB': return 'man overboard: ' + (d.crew || d.tag);
                    case 'SOS': return 'SOS button pressed';
                    case 'COMMS_LOST': return 'no contact for ' + d.silentFor + ' s';
                    case 'BOUNDARY_WARNING': return d.distM + ' m from the boundary';
                    case 'BOUNDARY_VIOLATION': return Math.abs(d.distM) + ' m across the boundary';
                    case 'RESTRICTED_ZONE': return 'inside the reserve';
                    case 'STORM_WARNING': return 'storm: waves ' + d.wave + ' m, wind ' + d.wind + ' km/h';
                    case 'GATEWAY_OUTAGE': return d.reason;
                    default: return e.type;
                }
            }
        }
    }
</script>
