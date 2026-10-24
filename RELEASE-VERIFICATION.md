# SeaGuard demo — release verification and scope

Frozen 2026-10-24 for Windows x64. Download **SeaGuard-Demo-Windows-x64-2026-10-24.zip** for the ready-to-run demo; extract it and run START.cmd. The automatically generated GitHub source archives require dependency installation and do not contain Node.js.

## Verified on the actual frozen package

| Check | Result |
|---|---|
| Standalone battery arithmetic | 18/18 pass |
| Battery controller | 2/2 pass |
| Battery/model integration | 9/9 pass |
| Battery snapshot validation/migration | 10/10 pass |
| Rescue model | 17/17 pass |
| Rescue exercise | 11/11 pass |
| Rescue persistence / backup recovery | 23/23 pass |
| Rescue review regressions | 12/12 pass |
| Fleet regressions | 28/28 pass |
| Notification outbox regressions | 9/9 pass |
| Vue/template/style syntax compilation | 10/10 pass |
| Real local HTTP rejection/validation checks | 11/11 pass |
| Real Node-RED rescue workflows | Flooding, man overboard, radio failure, boundary approach: all 4 pass |
| Real Node-RED fleet campaigns | Seeds 0 and 42: 47 pass, 0 fail, 0 not exercised |
| Real process restart using bundled Node | 6/6 pass: active mission saved, new process/paused restore, operational-state equality, no paused advancement, resumed command/recovery, return/resource release |

Offline functional checks total 139 plus 10 template compilation checks. Raw JSON evidence is included under `seaguard/reports`. Live checks used an isolated loopback API server on port 1882. The default demo starts at 1880. MQTT clients and HTTP self-calls follow the configured demo port. Runtime rejects dependencies resolved outside the extracted demo folder; it must not borrow a development machine's parent node_modules.

Packaging validation initially exposed omitted npm packages whose names overlap Node built-ins, and MQTT clients pointing at the development broker. Both packaging issues were corrected. The final isolated campaigns and process restart passed. No failing campaign was relabelled as passing or removed from the development history; only final release evidence is bundled.

## Included

Five-vessel fleet simulation, real local MQTT/WebSocket and HTTP flows, simulated edge sensors/radio/weather, mock alert delivery, duplicate-safe trip upload, seeded fault campaigns, four interactive rescue scenarios, constrained teams/manpower/equipment, delayed commands and feedback, finite pump batteries, delayed harbour battery replacement, timelines/results and durable rescue checkpoints with paused recovery.

## Pending / excluded

- Nearby-vessel assistance and relay are disabled in this frozen demo. Heretic completed a development checkpoint reporting green scoped tests, but independent acceptance and deployment remain pending.
- Fleet incident/trip/pending-alert durability and complete missed-emergency/recovered-trip results remain next-sprint work.
- Rendered UI/map acceptance was not exercised because browser origin access was denied. Template compilation and API tests do not replace it. Inspect the actual pages before a presentation.
- No field/hardware validation, real LoRaWAN deployment, real emergency dispatch or real messaging is claimed. Map tiles require internet.

Development is paused and checkpointed separately. This release has no Unsloth dependency, AI bridge, API token, live Telegram credential, development snapshot or GPU project. It is a review/demo prerelease, not an operational safety product. See README.md for the complete walkthrough, architecture, protocols and roadmap.
