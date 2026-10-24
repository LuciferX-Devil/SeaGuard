<template>
    <div class="sg" v-if="p">
        <div class="sg-h">
            <h2>Sea state</h2>
            <span class="sg-sub">Weather source is shown below; the default is local simulated weather. Storm above {{ p.thresholds.waveM }} m or {{ p.thresholds.windKmh }} km/h.</span>
        </div>
        <div class="sg-kpis">
            <div class="sg-kpi" :class="p.status === 'OK' ? '' : 'warn'"><b>{{ p.status.toLowerCase() }}</b><span>feed status</span></div>
            <div class="sg-kpi"><b style="font-size:.95rem">{{ p.source }}</b><span>source</span></div>
            <div class="sg-kpi"><b class="sg-num">{{ p.lastOk == null ? '-' : 't+' + p.lastOk + 's' }}</b><span>last good reading</span></div>
            <div class="sg-kpi" :class="p.failures ? 'warn' : ''"><b class="sg-num">{{ p.failures }}</b><span>consecutive failures</span></div>
        </div>
        <div class="sg-sub" v-if="p.lastError" style="margin-bottom:.5rem">Last error: {{ p.lastError }} &mdash; the last good values are kept and marked stale rather than dropped.</div>

        <div class="sg-three">
            <div v-for="z in p.zones" :key="z.id" class="sg-card" :style="{borderTop: '4px solid ' + (z.storm ? '#b02418' : '#2f7d5b')}">
                <div style="font-weight:600">{{ z.name }}</div>
                <div class="sg-sub">{{ p.boatsPerZone[z.id] || 0 }} boat(s) in this zone<template v-if="z.stale"> · values are stale</template></div>
                <div class="sg-kv">
                    <span>Wave height</span><span>{{ z.wave == null ? '-' : z.wave + ' m' }}</span>
                    <span>Wave period</span><span>{{ z.period == null ? '-' : z.period + ' s' }}</span>
                    <span>Wind</span><span>{{ z.wind == null ? '-' : z.wind + ' km/h' }}</span>
                    <span>Gusts</span><span>{{ z.gust == null ? '-' : z.gust + ' km/h' }}</span>
                </div>
                <div class="sg-note" v-if="z.storm">Storm warning active since t+{{ z.stormSince }}s. Boats in the zone were told to head home.</div>
            </div>
        </div>

        <h3>Feed history</h3>
        <table class="sg-table">
            <thead><tr><th>Time</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
                <tr v-for="(h,i) in p.history" :key="i">
                    <td class="sg-num">t+{{ h.t }}s</td>
                    <td :class="h.status === 'OK' ? 'lvl-ok' : h.status === 'STORM' ? 'lvl-critical' : 'lvl-warn'">{{ h.status.toLowerCase() }}</td>
                    <td>{{ h.note }}</td>
                </tr>
            </tbody>
        </table>
    </div>
    <div class="sg" v-else>Waiting for the first weather poll.</div>
</template>

<script>
    export default { computed: { p() { return this.msg && this.msg.payload ? this.msg.payload : null; } } }
</script>
