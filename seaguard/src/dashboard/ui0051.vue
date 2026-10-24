<style>
/* System-font fallbacks keep the dashboard usable without external font requests. */

.sg { font-family: Barlow, system-ui, "Segoe UI", sans-serif; color: #14324a; font-size: 14px; line-height: 1.35; }
.sg h2 { font-family: "Barlow Condensed", Barlow, sans-serif; font-size: 1.4rem; font-weight: 600; margin: 0; color: #14324a; }
.sg h3 { font-family: "Barlow Condensed", Barlow, sans-serif; font-size: 1.05rem; font-weight: 600; margin: .6rem 0 .3rem; color: #14324a; }
.sg-h { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; border-bottom: 2px solid #14324a; padding-bottom: .35rem; margin-bottom: .6rem; }
.sg-sub { color: #3e6e8e; font-size: .84rem; }
.sg-notice { background: #eaf1f4; border-left: 3px solid #3e6e8e; padding: .45rem .6rem; margin-bottom: .6rem; font-size: .82rem; }
.sg-spacer { flex: 1 1 auto; }
.sg-num { font-variant-numeric: tabular-nums; }
.sg-btn { font: inherit; font-size: .82rem; border: 1px solid #b9cdd6 !important; background: #fff !important;
    color: #14324a !important; border-radius: 2px; padding: .18rem .55rem; cursor: pointer; }
.sg-btn:hover { background: #e4edf1 !important; }
.sg-btn:focus-visible { outline: 2px solid #3e6e8e; outline-offset: 1px; }
.sg-btn.on { background: #14324a !important; color: #fff !important; border-color: #14324a !important; }
.sg-btn.go { background: #b0277a !important; color: #fff !important; border-color: #b0277a !important; font-weight: 600; }
.sg-btn:disabled { opacity: .45; cursor: default; }
.sg-in { font: inherit; color: #14324a !important; font-size: .82rem; border: 1px solid #b9cdd6; border-radius: 2px; padding: .16rem .4rem; background: #fff; color: #14324a; }
.sg-card { background: #fbfaf5; border: 1px solid #b9cdd6; padding: .5rem .6rem; color: #14324a; }
.sg-kpis { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: .6rem; }
.sg-kpi { border-left: 3px solid #3e6e8e; padding: .1rem .5rem; min-width: 84px; }
.sg-kpi b { font-family: "Barlow Condensed", sans-serif; font-size: 1.5rem; font-weight: 600; display: block; line-height: 1.1; }
.sg-kpi span { font-size: .74rem; color: #3e6e8e; }
.sg-kpi.alert { border-left-color: #b02418; }
.sg-kpi.warn { border-left-color: #c07c0d; }
.sg-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
.sg-table th { text-align: left; font-weight: 600; font-size: .72rem; color: #3e6e8e; border-bottom: 1px solid #b9cdd6; padding: .22rem .35rem; white-space: nowrap; }
.sg-table td { padding: .22rem .35rem; border-bottom: 1px solid #e4edf1; vertical-align: top; color: #14324a; }
.sg-table tr:hover td { background: #e4edf1; }
.sg-scroll { max-height: 330px; overflow: auto; }
.sg-log { font-size: .78rem; }
.sg-log div { padding: .12rem 0; border-bottom: 1px solid #e4edf1; display: flex; gap: .45rem; }
.sg-log .tt { color: #3e6e8e; min-width: 3.1rem; text-align: right; font-variant-numeric: tabular-nums; }
.sg-tag { font-size: .7rem; border: 1px solid #b9cdd6; padding: 0 .28rem; border-radius: 2px; color: #3e6e8e; white-space: nowrap; }
.sg-tag.crit { border-color: #b02418; color: #b02418; }
.sg-tag.high { border-color: #c07c0d; color: #c07c0d; }
.sg-tag.ok { border-color: #2f7d5b; color: #2f7d5b; }
.sg-tag.mag { border-color: #b0277a; color: #b0277a; }
.lvl-critical { color: #b02418; }
.lvl-high { color: #c07c0d; }
.lvl-warn { color: #b0277a; }
.lvl-ok { color: #2f7d5b; }
.sg-boats { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: .5rem; }
.sg-boat { background: #fbfaf5; border: 1px solid #b9cdd6; border-top: 4px solid #2f7d5b; padding: .4rem .55rem; color: #14324a; }
.sg-boat.critical { border-top-color: #b02418; background: #fdf3f1; }
.sg-boat.high { border-top-color: #c07c0d; }
.sg-boat.warn { border-top-color: #b0277a; }
.sg-boat .nm { font-weight: 600; }
.sg-boat .st { font-family: "Barlow Condensed", sans-serif; font-size: 1.05rem; }
.sg-kv { display: grid; grid-template-columns: auto 1fr; gap: 0 .5rem; font-size: .8rem; margin-top: .25rem; }
.sg-kv span:nth-child(odd) { color: #3e6e8e; }
.sg-kv span:nth-child(even) { text-align: right; font-variant-numeric: tabular-nums; }
.sg-note { font-size: .78rem; background: #f0e7d0; border-left: 3px solid #c07c0d; padding: .2rem .4rem; margin-top: .3rem; }
.sg-bar { height: 6px; background: #e4edf1; position: relative; }
.sg-bar i { position: absolute; left: 0; top: 0; bottom: 0; background: #b0277a; }
.sg-two { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; }
.sg-three { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: .8rem; }
@media (max-width: 860px) { .sg-two, .sg-three { grid-template-columns: 1fr; } }
.sg-pass { color: #2f7d5b; font-weight: 600; }
.sg-fail { color: #b02418; font-weight: 600; }
.sg-skip { color: #3e6e8e; }

</style>
