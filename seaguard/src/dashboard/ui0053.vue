<template>
    <div class="sg" v-if="p">
        <div class="sg-h">
            <h2>Radio and network health</h2>
            <span class="sg-sub">LoRa uplink is unconfirmed telemetry plus confirmed emergency events; harbour Wi-Fi carries the full trip log.</span>
        </div>

        <div class="sg-kpis">
            <div class="sg-kpi" :class="p.gateway.online ? '' : 'alert'"><b>{{ p.gateway.online ? 'online' : 'offline' }}</b><span>shore gateway backhaul</span></div>
            <div class="sg-kpi" :class="p.gateway.buffered ? 'warn' : ''"><b class="sg-num">{{ p.gateway.buffered }}</b><span>packets held in the gateway</span></div>
            <div class="sg-kpi"><b class="sg-num">{{ p.gateway.stats.fwd || 0 }}</b><span>uplinks forwarded</span></div>
            <div class="sg-kpi"><b class="sg-num">{{ p.gateway.stats.flushed || 0 }}</b><span>flushed after reconnect</span></div>
            <div class="sg-kpi" :class="(p.gateway.stats.bufDropped || 0) ? 'warn' : ''"><b class="sg-num">{{ p.gateway.stats.bufDropped || 0 }}</b><span>dropped, buffer full</span></div>
            <div class="sg-kpi"><b class="sg-num">{{ p.gateway.hbAge == null ? '-' : p.gateway.hbAge }}</b><span>s since heartbeat</span></div>
        </div>
        <div class="sg-sub" v-if="!p.gateway.online" style="margin-bottom:.5rem">Reason: {{ p.gateway.reason }}</div>

        <h3>Per boat, as measured ashore</h3>
        <table class="sg-table">
            <thead><tr><th>Boat</th><th>Received</th><th>Missing</th><th>Filled late</th><th>Duplicates</th><th>Out of order</th><th>Stale rejected</th><th>Signal</th><th>Silent</th><th>Retries</th><th>Unacked</th><th>Avg ack</th><th>Loss, last 6 min</th></tr></thead>
            <tbody>
                <tr v-for="r in p.rows" :key="r.id">
                    <td>{{ r.id }} {{ r.name }}</td>
                    <td class="sg-num">{{ r.recv }}</td>
                    <td class="sg-num" :class="r.lost ? 'lvl-warn' : ''">{{ r.lost }}</td>
                    <td class="sg-num">{{ r.recovered }}</td>
                    <td class="sg-num">{{ r.dup }}</td>
                    <td class="sg-num">{{ r.ooo }}</td>
                    <td class="sg-num">{{ r.stale }}</td>
                    <td class="sg-num">{{ r.rssi == null ? '-' : r.rssi + ' dBm / ' + r.snr + ' dB' }}</td>
                    <td class="sg-num" :class="r.silent ? 'lvl-critical' : ''">{{ r.age == null ? '-' : r.age + ' s' }}</td>
                    <td class="sg-num">{{ r.retries }}</td>
                    <td class="sg-num" :class="r.pending ? 'lvl-warn' : ''">{{ r.pending }}</td>
                    <td class="sg-num">{{ r.avgAckS == null ? '-' : r.avgAckS + ' s' }}</td>
                    <td>
                        <svg :width="Math.max(20, r.hist.length * 5 + 2)" height="20" style="vertical-align:middle">
                            <rect v-for="(h,i) in r.hist" :key="i" :x="i * 5" :y="20 - bar(h)" width="4" :height="bar(h)"
                                  :fill="h.lost ? '#b02418' : '#3e6e8e'"><title>{{ h.lost }}/{{ h.n }} lost</title></rect>
                        </svg>
                    </td>
                </tr>
            </tbody>
        </table>

        <div class="sg-two" style="margin-top:.8rem">
            <div>
                <h3>Harbour Wi-Fi log sync</h3>
                <table class="sg-table">
                    <thead><tr><th>Boat</th><th>In range</th><th>Records logged</th><th>Still on board</th><th>Stored ashore</th><th>Batches</th><th>Timeouts</th><th>Duplicates absorbed</th></tr></thead>
                    <tbody>
                        <tr v-for="r in p.sync" :key="r.id">
                            <td>{{ r.id }}</td>
                            <td>{{ r.inHarbour ? 'yes' : 'no' }}</td>
                            <td class="sg-num">{{ r.logged }}</td>
                            <td class="sg-num">{{ r.onboard }}</td>
                            <td class="sg-num">{{ r.ashore }}</td>
                            <td class="sg-num">{{ r.batches }}</td>
                            <td class="sg-num">{{ r.timeouts }}</td>
                            <td class="sg-num">{{ r.dupRecords }}</td>
                        </tr>
                    </tbody>
                </table>
                <h3>Radio channel, as it really behaved</h3>
                <table class="sg-table">
                    <thead><tr><th>Boat</th><th>Uplinks dropped</th><th>Echoed</th><th>Held back</th><th>Downlinks dropped</th></tr></thead>
                    <tbody>
                        <tr v-for="r in p.rows" :key="r.id">
                            <td>{{ r.id }}</td><td class="sg-num">{{ r.chanDropUp }}</td><td class="sg-num">{{ r.chanDupUp }}</td>
                            <td class="sg-num">{{ r.chanHeldUp }}</td><td class="sg-num">{{ r.chanDropDown }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div>
                <h3>Link events</h3>
                <div class="sg-log sg-scroll">
                    <div v-for="(l,i) in p.log" :key="i">
                        <span class="tt">t+{{ l.t }}s</span>
                        <span class="sg-tag" :class="l.kind === 'DROP' ? 'crit' : l.kind === 'DUP' ? 'high' : l.kind === 'WIFI' ? 'mag' : ''">{{ l.kind }}</span>
                        <span>{{ l.boat !== '-' ? l.boat + ' ' : '' }}{{ l.text }}</span>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <div class="sg" v-else>Waiting for link statistics.</div>
</template>

<script>
    export default {
        computed: { p() { return this.msg && this.msg.payload ? this.msg.payload : null; } },
        methods: { bar(h) { return Math.max(2, Math.round((h.lost / Math.max(1, h.n)) * 18) + 2); } }
    }
</script>
