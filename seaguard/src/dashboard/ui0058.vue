<template>
    <div class="sg" style="height:100%">
        <div class="sg-h"><h2>Chart</h2><span class="sg-sub">Boat markers show the last position the shore actually received. Dashed line: maritime boundary. Shaded box: no-fishing reserve.</span></div>
        <p v-if="mapNotice" class="sg-notice" role="status">{{ mapNotice }}</p><iframe title="Fleet geographical map" @load="mapLoaded" src="/worldmap" style="width:100%;height:620px;border:1px solid #b9cdd6;background:#fff"></iframe>
        <div style="margin-top:.4rem"><a class="sg-btn" href="/dashboard/rescue" target="_self">Open rescue exercise &rarr;</a></div>
    </div>
</template>

<script>
export default { data(){return {mapNotice:""};}, methods:{mapLoaded(event) {
            const frame = event.target, key = 'seaguard.map.' + frame.getAttribute('src');
            let attempts = 0;
            const attach = () => {
                if (!frame.isConnected) return;
                const w = frame.contentWindow;
                if (!w || !w.map || !w.basemaps || !w.basemaps.OSM) {
                    if (++attempts < 50) setTimeout(attach, 100);
                    else this.mapNotice = 'Map controls could not load. Refresh this page to retry.';
                    return;
                }
                const map = w.map, layers = w.basemaps;
                const select = name => {
                    if (!layers[name]) name = 'OSM';
                    for (const layer of Object.values(layers)) if (map.hasLayer(layer)) map.removeLayer(layer);
                    layers[name].addTo(map);
                    map.fire('baselayerchange', {name, layer: layers[name]});
                };
                let saved = 'OSM';
                try { saved = localStorage.getItem(key) || 'OSM'; } catch {}
                select(saved);
                map.on('baselayerchange', e => {
                    this.mapNotice = '';
                    try { localStorage.setItem(key, e.name); } catch {}
                });
                for (const [name, layer] of Object.entries(layers)) {
                    if (!layer.on) continue;
                    layer.on('tileerror', () => {
                        if (!map.hasLayer(layer)) return;
                        if (name !== 'OSM') {
                            select('OSM');
                            this.mapNotice = 'The selected map could not load. OpenStreetMap is shown instead.';
                        } else this.mapNotice = 'Map tiles are unavailable. Check your internet connection; vessel overlays remain visible.';
                    });
                }
            };
            // Wait for the map client to apply its initial server configuration.
            setTimeout(attach, 1000);
        }} };
</script>
