<template>
    <div class="sg">
        <div class="sg-h">
            <h2>How SeaGuard is put together</h2>
            <span class="sg-sub">Small fishing boats lose contact the moment they leave the harbour. SeaGuard gives each boat a low-power radio link, watches for capsize, flooding, man overboard and boundary crossings, and tells the family and the coast guard within seconds.</span>
        </div>

        <svg viewBox="0 0 980 300" style="width:100%;height:auto;max-height:320px" role="img" aria-label="SeaGuard architecture">
            <defs>
                <marker id="ar" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                    <path d="M0,0 L7,3 L0,6 z" fill="#3e6e8e"/>
                </marker>
            </defs>
            <g font-family="Barlow, sans-serif" font-size="12" fill="#14324a">
                <rect x="8" y="30" width="176" height="150" fill="#fbfaf5" stroke="#14324a"/>
                <text x="16" y="48" font-weight="600" font-size="13">On the boat</text>
                <text x="16" y="70">GPS fix, speed, heading</text>
                <text x="16" y="88">IMU roll for capsize</text>
                <text x="16" y="106">Bilge water sensor</text>
                <text x="16" y="124">BLE crew tags</text>
                <text x="16" y="146" fill="#3e6e8e">Firmware: debounce,</text>
                <text x="16" y="162" fill="#3e6e8e">retry until acknowledged</text>

                <rect x="232" y="46" width="128" height="58" fill="#fbfaf5" stroke="#14324a"/>
                <text x="240" y="66" font-weight="600">LoRa link</text>
                <text x="240" y="84" fill="#3e6e8e">loss, echo, delay</text>

                <rect x="232" y="128" width="128" height="58" fill="#fbfaf5" stroke="#14324a"/>
                <text x="240" y="148" font-weight="600">Harbour Wi-Fi</text>
                <text x="240" y="166" fill="#3e6e8e">trip log upload</text>

                <rect x="404" y="46" width="130" height="58" fill="#fbfaf5" stroke="#14324a"/>
                <text x="412" y="66" font-weight="600">Shore gateway</text>
                <text x="412" y="84" fill="#3e6e8e">store and forward</text>

                <rect x="404" y="128" width="130" height="58" fill="#fbfaf5" stroke="#14324a"/>
                <text x="412" y="148" font-weight="600">REST endpoint</text>
                <text x="412" y="166" fill="#3e6e8e">/seaguard/sync</text>

                <rect x="578" y="30" width="170" height="156" fill="#f0e7d0" stroke="#14324a"/>
                <text x="586" y="48" font-weight="600" font-size="13">Shore server</text>
                <text x="586" y="70">MQTT ingest, sequence</text>
                <text x="586" y="86">tracking and acks</text>
                <text x="586" y="106">Geofence</text>
                <text x="586" y="126">Weather (Open-Meteo)</text>
                <text x="586" y="146" font-weight="600">Correlation engine</text>
                <text x="586" y="164" fill="#3e6e8e">incidents, escalation</text>

                <rect x="792" y="30" width="176" height="70" fill="#fbfaf5" stroke="#b0277a"/>
                <text x="800" y="50" font-weight="600">Telegram alerts</text>
                <text x="800" y="68" fill="#3e6e8e">family, coast guard,</text>
                <text x="800" y="84" fill="#3e6e8e">retry until delivered</text>

                <rect x="792" y="116" width="176" height="70" fill="#fbfaf5" stroke="#14324a"/>
                <text x="800" y="136" font-weight="600">Dashboard</text>
                <text x="800" y="154" fill="#3e6e8e">chart, link health,</text>
                <text x="800" y="170" fill="#3e6e8e">incidents, test lab</text>

                <rect x="232" y="222" width="516" height="56" fill="#fff" stroke="#b0277a" stroke-dasharray="6,4"/>
                <text x="240" y="242" font-weight="600" fill="#b0277a">Test harness</text>
                <text x="240" y="262" fill="#3e6e8e">injects faults into the physics, the radio, the gateway, the weather feed and the messaging service, then checks the outcome</text>

                <g stroke="#3e6e8e" fill="none" marker-end="url(#ar)">
                    <path d="M186,76 L228,76"/>
                    <path d="M186,150 L228,150"/>
                    <path d="M362,76 L400,76"/>
                    <path d="M362,150 L400,150"/>
                    <path d="M536,76 L574,76"/>
                    <path d="M536,150 L574,150"/>
                    <path d="M750,80 L788,66"/>
                    <path d="M750,140 L788,150"/>
                    <path d="M572,120 L190,120"/>
                </g>
                <text x="300" y="114" font-size="11" fill="#3e6e8e">acknowledgements and advisories travel back the same way</text>
            </g>
        </svg>

        <div class="sg-two" style="margin-top:.6rem">
            <div>
                <h3>The ten technologies</h3>
                <table class="sg-table">
                    <thead><tr><th>Technology</th><th>Where it lives</th></tr></thead>
                    <tbody>
                        <tr v-for="t in tech" :key="t.n"><td>{{ t.n }}</td><td>{{ t.w }}</td></tr>
                    </tbody>
                </table>
            </div>
            <div>
                <h3>What the tests actually prove</h3>
                <p class="sg-sub">Each run drives the whole stack: sensors feed firmware, firmware talks over a lossy radio to a real MQTT broker, the shore services correlate what arrives, and alerts go out over HTTP. The checks measure system behaviour end to end &mdash; detection latency, deduplication, suppression, escalation, recovery after outages and log integrity.</p>
                <p class="sg-sub">What they do not prove is physical realism. The sensor models are plausible, not calibrated against real boats, so the thresholds would need tuning against real IMU and bilge data before anyone trusted this at sea.</p>
                <h3>Running it yourself</h3>
                <p class="sg-sub">Open the test lab, press the run button, and watch the injection log fill up. Enter the same seed twice to replay the same campaign. Everything runs inside Node-RED: the MQTT broker, the weather API mock and the messaging mock are all local, so no hardware, no accounts and no internet are needed for a test run.</p>
            </div>
        </div>
    </div>
</template>

<script>
    export default {
        data() {
            return {
                tech: [
                    { n: 'GPS', w: 'Position, speed and heading in every telemetry frame; drives the geofence' },
                    { n: 'IMU / accelerometer', w: 'Roll angle held past a threshold is a capsize, a single wave is not' },
                    { n: 'Water ingress sensor', w: 'Bilge level with debounce, so spray does not raise a flooding alert' },
                    { n: 'Bluetooth Low Energy', w: 'Crew tags; a tag that stays out of range is a man overboard' },
                    { n: 'LoRa', w: 'Long-range boat to shore link, with confirmed uplinks for emergencies' },
                    { n: 'MQTT', w: 'Gateway to shore-server messaging, with birth, close and last-will status' },
                    { n: 'Wi-Fi', w: 'Harbour hotspot uploads the full trip log in resumable batches' },
                    { n: 'REST API', w: 'Open-Meteo marine and forecast APIs for waves and wind, plus the sync endpoint' },
                    { n: 'Telegram bot', w: 'Alerts to family and coast guard with retry and escalation' },
                    { n: 'Dashboard and mapping', w: 'Live chart, fleet status, link health, incidents and the test lab' }
                ]
            };
        }
    }
</script>
