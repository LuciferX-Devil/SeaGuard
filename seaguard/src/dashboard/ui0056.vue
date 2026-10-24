<template>
    <div class="sg" v-if="p">
        <div class="sg-h">
            <h2>Alert messages</h2>
            <span class="sg-sub" v-if="p.live">Sending through your Telegram bot.</span>
            <span class="sg-sub" v-else>Local simulated delivery — no real messages sent. {{ p.configured ? 'Test campaigns always use the mock.' : 'Live Telegram requires an explicit opt-in and configured recipients.' }}</span>
            <span class="sg-spacer"></span>
            <button class="sg-btn" @click="send({topic:'cmd', payload:{cmd:'testMessage'}})">Send a test message</button>
        </div>
        <div class="sg-kpis">
            <div class="sg-kpi"><b class="sg-num">{{ p.counts.total }}</b><span>messages</span></div>
            <div class="sg-kpi"><b class="sg-num">{{ p.counts.delivered }}</b><span>delivered</span></div>
            <div class="sg-kpi" :class="p.counts.retrying ? 'warn' : ''"><b class="sg-num">{{ p.counts.retrying }}</b><span>in flight or retrying</span></div>
            <div class="sg-kpi" :class="p.counts.failed ? 'alert' : ''"><b class="sg-num">{{ p.counts.failed }}</b><span>given up</span></div>
        </div>
        <table class="sg-table">
            <thead><tr><th>Ref</th><th>Sent to</th><th>Kind</th><th>Status</th><th>Attempts</th><th>Delay</th><th>Message</th></tr></thead>
            <tbody>
                <tr v-for="r in p.rows" :key="r.id">
                    <td>{{ r.ref }}</td>
                    <td>{{ label(r.role) }}</td>
                    <td>{{ r.kind.toLowerCase() }}</td>
                    <td :class="r.status === 'DELIVERED' ? 'lvl-ok' : r.status === 'FAILED' ? 'lvl-critical' : 'lvl-warn'">{{ r.status.toLowerCase() }}</td>
                    <td class="sg-num">{{ r.attempts }}</td>
                    <td class="sg-num">{{ r.deliveredAt == null ? (r.lastError || '-') : (r.deliveredAt - r.created) + ' s' }}</td>
                    <td style="white-space:pre-line;font-size:.78rem">{{ r.text }}</td>
                </tr>
            </tbody>
        </table>
    </div>
    <div class="sg" v-else>No alerts yet.</div>
</template>

<script>
    export default {
        computed: { p() { return this.msg && this.msg.payload ? this.msg.payload : null; } },
        methods: { label(r) { return r === 'family' ? 'family ashore' : r === 'coastguard' ? 'coast guard' : 'harbour control'; } }
    }
</script>
