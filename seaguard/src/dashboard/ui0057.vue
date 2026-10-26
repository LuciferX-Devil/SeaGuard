<template>
    <div class="sg" v-if="p">
        <div class="sg-h">
            <h2>Test lab</h2>
            <span class="sg-sub">Each run builds a fresh random campaign of faults, feeds them into the running system and checks what the system did about them.</span>
        </div>
        <div v-if="inputError" class="sg-notice" role="alert">{{ inputError }}</div>

        <div class="sg-card" style="margin-bottom:.6rem">
            <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
                <button class="sg-btn go" :disabled="p.state === 'RUNNING' || p.state === 'EVALUATING'" @click="run()">Run a randomized test</button>
                <label class="sg-sub">Seed <input class="sg-in" style="width:7rem" v-model="seed" placeholder="random" inputmode="numeric" aria-label="Replay seed"></label>
                <label class="sg-sub">Speed
                    <select class="sg-in" v-model="speed"><option :value="5">&times;5</option><option :value="10">&times;10</option><option :value="20">&times;20</option></select>
                </label>
                <button class="sg-btn" v-if="p.state === 'RUNNING'" @click="cmd({cmd:'abort'})">Stop</button>
                <button class="sg-btn" @click="cmd({cmd:'live'})">Back to live mode</button>
                <button class="sg-btn" @click="cmd({cmd:'save'})">Save fleet checkpoint</button>
                <span class="sg-spacer"></span>
                <span class="sg-sub" v-if="p.seed != null">campaign {{ p.seed }} · {{ p.schedule.length }} faults · {{ p.state.toLowerCase() }} · t+{{ p.head.t }}s of {{ p.D }}s</span>
            </div>
            <div class="sg-bar" style="margin-top:.45rem" v-if="p.seed != null"><i :style="{width: p.progress + '%'}"></i></div>
            <div class="sg-sub" style="margin-top:.35rem" v-if="p.head.save">
                <template v-if="p.head.save.blocked">Fleet store blocked: {{ p.head.save.error || 'invalid snapshot' }} — use "Back to live mode" to reset the world.</template>
                <template v-else-if="p.head.save.pausedHold && !p.head.running">Restored world is paused — Resume from the Fleet page to continue.</template>
                <template v-else-if="!p.head.save.ok">Checkpoint save failed: {{ p.head.save.error }} (live state kept, last good checkpoint unchanged).</template>
                <template v-else>Last checkpoint {{ saveTime(p.head.save.savedAt) ? saveTime(p.head.save.savedAt) + ' UTC' : 'not saved yet' }} · {{ p.head.save.saves || 0 }} save(s) this session.</template>
            </div>
            <div class="sg-sub" style="margin-top:.35rem" v-if="p.roles">
                Roles this run: {{ p.roles.open.join(', ') }} fishing offshore · {{ p.roles.border }} working the boundary ({{ p.scenario.toLowerCase() }}) · {{ p.roles.harbour }} coming home to sync its log.
                Re-enter the seed to replay the same campaign.
            </div>
        </div>

        <div v-if="p.results" class="sg-card" style="margin-bottom:.6rem"
             :style="{borderLeft: '5px solid ' + (p.results.fail ? '#b02418' : '#2f7d5b')}">
            <div style="display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap">
                <span :class="p.results.fail ? 'sg-fail' : 'sg-pass'" style="font-size:1.1rem">{{ p.results.verdict === 'PASS' ? 'All exercised checks passed' : p.results.fail + ' check(s) failed' }}</span>
                <span class="sg-sub">{{ p.results.pass }} passed · {{ p.results.fail }} failed · {{ p.results.skip }} not exercised · campaign {{ p.seed }} · {{ p.results.wallSec }} s of wall clock</span>
            </div>
            <table class="sg-table" style="margin-top:.35rem">
                <thead><tr><th>Fault</th><th>Check</th><th>Expected</th><th>Observed</th><th>Result</th></tr></thead>
                <tbody>
                    <tr v-for="(r,i) in p.results.rows" :key="i">
                        <td>{{ r.fault }}</td><td>{{ r.title }}</td><td class="sg-sub">{{ r.expected }}</td><td>{{ r.observed }}</td>
                        <td :class="r.result === 'PASS' ? 'sg-pass' : r.result === 'FAIL' ? 'sg-fail' : 'sg-skip'">{{ r.result.toLowerCase() }}</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div v-if="p.metrics" class="sg-card" style="margin-bottom:.6rem">
            <h3 style="margin:0 0 .3rem 0">Results at campaign completion</h3>
            <table class="sg-table">
                <thead><tr><th>Area</th><th>Numbers</th><th>Detail</th></tr></thead>
                <tbody>
                    <tr>
                        <td>Physical distress detection</td>
                        <td class="sg-num">{{ p.metrics.detection.detected }}/{{ p.metrics.detection.expected }} detected</td>
                        <td class="sg-sub">{{ p.metrics.detection.missed }} missed · {{ p.metrics.detection.late }} late · {{ p.metrics.detection.notYet }} not yet exercised (window closed {{ p.metrics.detection.evalT == null ? 'N/A' : 'at t+' + p.metrics.detection.evalT + ' s' }}) · other fault kinds stay in the oracle rows above</td>
                    </tr>
                    <tr v-for="d in p.metrics.detection.rows" :key="d.fault">
                        <td class="sg-sub">{{ d.fault }} {{ d.type }} · {{ d.boat }}</td>
                        <td class="sg-num">{{ d.status === 'DETECTED' ? '+' + d.delayS + ' s' : '—' }}</td>
                        <td class="sg-sub">{{ d.status === 'DETECTED' ? (d.late ? 'LATE (deadline ' + d.deadlineS + ' s)' : 'in time (deadline ' + d.deadlineS + ' s)') : (d.status === 'NOT_YET' ? 'not yet injected at evaluation' : 'no accepted event in window') }} · incident {{ d.incident || '—' }}</td>
                    </tr>
                    <tr>
                        <td>Alert delivery</td>
                        <td class="sg-num">{{ p.metrics.delivery.delivered }}/{{ p.metrics.delivery.created }} delivered</td>
                        <td class="sg-sub">{{ p.metrics.delivery.pending }} pending · {{ p.metrics.delivery.failed }} failed · {{ p.metrics.delivery.uncertain }} uncertain ({{ p.metrics.delivery.uncertainInFlight || 0 }} in flight, {{ p.metrics.delivery.uncertainRestored || 0 }} retained after restart) · latency {{ p.metrics.delivery.latency ? p.metrics.delivery.latency.minS + '–' + p.metrics.delivery.latency.maxS + ' s (avg ' + p.metrics.delivery.latency.avgS + ')' : 'N/A' }}</td>
                    </tr>
                    <tr>
                        <td>Operator response</td>
                        <td class="sg-num">{{ p.metrics.delivery.operatorResponse ? p.metrics.delivery.operatorResponse.acked : 0 }} incident(s) acked</td>
                        <td class="sg-sub">{{ p.metrics.delivery.operatorResponse ? 'acked ' + p.metrics.delivery.operatorResponse.minS + '–' + p.metrics.delivery.operatorResponse.maxS + ' s after open (avg ' + p.metrics.delivery.operatorResponse.avgS + ')' : 'N/A (none acknowledged)' }}</td>
                    </tr>
                    <tr v-for="v in p.metrics.trips.rows" :key="v.boat">
                        <td>Trip log · {{ v.boat }}<template v-if="v.role === 'harbour'"> (harbour)</template></td>
                        <td class="sg-num">{{ v.received }}/{{ v.logSeq }} ashore</td>
                        <td class="sg-sub">contiguous to seq {{ v.maxContig }} · {{ v.received === 0 ? 'no records received' : (v.gapped ? 'GAPS' : 'gapless') }} · {{ v.dupRecords }} duplicate(s) ignored · {{ v.buffered }} still on board · {{ v.complete === null ? 'N/A' : (v.complete ? 'complete upload' : (v.role === 'harbour' ? 'incomplete at evaluation' : 'awaiting harbour upload')) }}</td>
                    </tr>
                    <tr v-if="!p.metrics.trips.rows.length"><td>Trip log</td><td class="sg-num">N/A</td><td class="sg-sub">no onboard log sequences in this run</td></tr>
                </tbody>
            </table>
        </div>

        <div class="sg-two">
            <div>
                <h3>What was fed into the stack</h3>
                <div class="sg-log sg-scroll">
                    <div v-for="(l,i) in p.injLog" :key="i">
                        <span class="tt">t+{{ l.t }}s</span>
                        <span class="sg-tag" :class="l.phase === 'INJECT' ? 'crit' : l.phase === 'OPERATOR' ? 'mag' : ''">{{ l.phase.toLowerCase() }}</span>
                        <span>{{ l.text }}</span>
                    </div>
                    <div v-if="!p.injLog.length"><span class="sg-sub">Press "Run a randomized test" to start feeding faults in.</span></div>
                </div>
                <h3>Campaign plan</h3>
                <table class="sg-table">
                    <thead><tr><th>At</th><th>Ends</th><th>Fault</th><th>Target</th><th>State</th></tr></thead>
                    <tbody>
                        <tr v-for="f in p.schedule" :key="f.id">
                            <td class="sg-num">t+{{ f.t }}s</td>
                            <td class="sg-num">{{ f.end == null ? '-' : 't+' + f.end + 's' }}</td>
                            <td>{{ f.type.toLowerCase().replace(/_/g,' ') }} <span class="sg-tag" v-if="f.decoy">decoy</span></td>
                            <td>{{ f.boat || 'fleet' }}</td>
                            <td>{{ f.cleared ? 'ended' : f.injected ? 'active' : 'pending' }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div>
                <h3>What the stack made of it</h3>
                <div class="sg-log sg-scroll">
                    <div v-for="(e,i) in p.events" :key="i">
                        <span class="tt">t+{{ e.t }}s</span>
                        <span class="sg-tag" :class="e.disposition === 'NEW_INCIDENT' ? 'crit' : e.disposition === 'SUPPRESSED' ? 'mag' : ''">{{ e.disposition.toLowerCase().replace(/_/g,' ') }}</span>
                        <span>{{ e.boat }} {{ e.type.toLowerCase().replace(/_/g,' ') }}<template v-if="e.incident"> &rarr; {{ e.incident }}</template></span>
                    </div>
                </div>

                <h3>Inject a fault by hand</h3>
                <div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">
                    <select class="sg-in" v-model="mBoat"><option value="">fleet-wide</option><option v-for="b in p.boats" :key="b.id" :value="b.id">{{ b.id }} {{ b.name }}</option></select>
                    <select class="sg-in" v-model="mType"><option v-for="f in p.faultTypes" :key="f" :value="f">{{ f.toLowerCase().replace(/_/g,' ') }}</option></select>
                    <button class="sg-btn" :disabled="p.state === 'RUNNING' || p.state === 'EVALUATING'" @click="inject()">Inject now</button>
                </div>

                <h3>Previous runs</h3>
                <table class="sg-table">
                    <thead><tr><th>Seed</th><th>Faults</th><th>Passed</th><th>Failed</th><th>Not exercised</th><th>Verdict</th><th>Wall clock</th></tr></thead>
                    <tbody>
                        <tr v-for="(h,i) in p.history" :key="i">
                            <td class="sg-num">{{ h.seed }}</td><td class="sg-num">{{ h.faults }}</td><td class="sg-num">{{ h.pass }}</td>
                            <td class="sg-num">{{ h.fail }}</td><td class="sg-num">{{ h.skip }}</td>
                            <td :class="h.verdict === 'PASS' ? 'sg-pass' : 'sg-fail'">{{ h.verdict.toLowerCase() }}</td>
                            <td class="sg-num">{{ h.wallSec }} s</td>
                        </tr>
                        <tr v-if="!p.history.length"><td colspan="7" class="sg-sub">No runs yet.</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>
    <div class="sg" v-else>Loading.</div>
</template>

<script>
    export default {
        data() { return { seed: '', speed: 10, mBoat: 'B1', mType: 'CAPSIZE', inputError: '' }; },
        computed: { p() { return this.msg && this.msg.payload ? this.msg.payload : null; } },
        methods: {
            cmd(c) { this.send({ topic: 'cmd', payload: c }); },
            // fleetSaveStatus.savedAt is numeric Date.now() ms from persistence.save (0 is a
            // valid timestamp); legacy/ISO strings are tolerated. Returns '' for anything unusable.
            saveTime(ts) {
                if (ts === null || ts === undefined) return '';
                let d;
                if (typeof ts === 'number') {
                    if (!Number.isFinite(ts) || ts < 0) return '';
                    d = new Date(ts);
                } else if (typeof ts === 'string') {
                    const s = ts.trim();
                    if (!s) return '';
                    d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
                } else { return ''; }
                if (isNaN(d.getTime())) return '';
                const p = (n) => String(n).padStart(2, '0');
                return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
                    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
            },
            run() {
                if (this.seed !== '' && (!/^\d+$/.test(this.seed) || Number(this.seed) > 4294967295)) { this.inputError = 'Enter a whole replay seed between 0 and 4294967295, or leave it blank.'; return; }
                this.inputError = '';
                this.cmd({ cmd: 'run', seed: this.seed === '' ? null : Number(this.seed), speed: Number(this.speed) });
            },
            inject() {
                const fleetTypes = ['STORM','WEATHER_API_FAIL','GATEWAY_OUTAGE','TELEGRAM_OUTAGE'];
                if (!this.mBoat && !fleetTypes.includes(this.mType)) { this.inputError = 'Select a boat for this fault.'; return; }
                this.inputError = '';
                this.cmd({cmd:'inject', boat:this.mBoat || null, type:this.mType});
            }
        }
    }
</script>
