# SeaGuard

SeaGuard explores a practical question: how can a small fishing boat report trouble when its radio link is unreliable, and how can people ashore turn that warning into an effective rescue?

The project brings a simulated fishing fleet and a rescue control room into one local application. It follows an emergency from the first sensor reading through radio delivery, incident detection, alerting, dispatch and recovery. The goal is to make the consequences of lost packets, delayed information and limited rescue resources visible.

## Watching the fleet

Each boat has a simulated GPS receiver, roll sensor, bilge-water sensor and crew tags. Its onboard logic filters brief disturbances before raising an emergency. Routine telemetry can be lost; emergency reports are acknowledged and retried. This lets the project distinguish a single large wave or a brief tag dropout from a sustained danger.

A shore gateway buffers reports when its backhaul goes down. The shore server tracks packet sequence numbers, rejects stale positions, groups related events into incidents and escalates unacknowledged critical alerts. The dashboard shows what the shore has actually received alongside a clearly separated view of the simulation's underlying state.

Trip records stay onboard while a vessel is offshore. Harbour Wi-Fi uploads them in resumable batches, with duplicate detection and checks for missing records. The chart displays received vessel positions, incident colours and illustrative maritime boundaries over a geographical basemap.

## Responding to an emergency

The rescue exercise covers flooding, a person overboard, radio failure and a boundary approach. It has its own clock and does not change the fleet test campaign.

An operator allocates a rescue boat, personnel and equipment. Travel takes time and consumes fuel. A pump can remove water only while its battery has energy; repairs and battery replacement take time as well. Nearby vessels can assist when their reported position, crew and resources make them eligible. A short-range relay can restore the flow of sensor reports without pretending that the damaged main radio has been repaired.

The exercise separates acknowledging an incident, confirming crew safety, making the vessel safe and bringing rescue teams home. Equipment remains reserved until the team returns. The final all-clear requires safe conditions and recovered teams, rather than a button that simply turns an incident green.

## Technologies and protocols

| Component | Role in this project |
|---|---|
| Node-RED | Connects simulation, gateway, incident processing, HTTP services and dashboard |
| GPS and IMU | Simulated position, speed, heading and roll measurements |
| Bilge sensor | Simulated water ingress and filtered flooding detection |
| Bluetooth Low Energy | Models crew-tag presence and dropout |
| LoRa | Models a low-power boat-to-shore radio channel with loss, delay and retries |
| MQTT over WebSocket | Actual local broker and gateway/server messaging on a loopback connection |
| HTTP and JSON | Trip-log uploads, local service endpoints, weather and messaging mocks |
| Wi-Fi | Models harbour connectivity and interrupted batch uploads |
| Leaflet / OpenStreetMap | Geographical basemap, vessel markers, rescue routes and overlays |
| Telegram-compatible messaging | Local alert-delivery mock with retry and escalation behavior |

The sensor hardware, LoRa channel, crew tags and harbour radio conditions are simulated. The local MQTT broker, HTTP endpoints and dashboard run as working software. Weather and message delivery use local mocks by default. Map tiles require an internet connection; the underlying simulation does not depend on them.

## Reliability and evaluation

Fleet and rescue checkpoints are stored separately and restore paused. The fleet checkpoint includes incidents, trip records, onboard buffers, pending alerts, packet history and the simulation's random-generator state. Writes are validated and use a previous-good backup. Failed saves are reported rather than treated as successful checkpoints.

The local messaging mock records a stable delivery identity before confirming success, so a retry after restart does not create a second confirmed mock delivery. A real external message that was in flight at shutdown may have an uncertain outcome; the project keeps that uncertainty visible rather than claiming exactly-once delivery.

Seeded fault campaigns make results repeatable. They exercise false-alarm filtering, outages, duplicate and out-of-order packets, delayed reports, weather warnings and interrupted trip uploads. Results show detection delay, missed and late emergencies, alert delivery, acknowledgement timing and trip-record recovery. Checks that a campaign did not actually exercise are reported separately from passing checks.

## Scope and limits

SeaGuard is an educational simulation and software prototype. Names, boundaries, routes, sensor thresholds and rescue parameters are illustrative. Its results demonstrate software behavior under modeled conditions; they do not establish performance on physical boats, radio equipment or emergency networks. It is not a navigation aid or an operational rescue service.

Future work includes physical sensor integration, authenticated devices, measured radio conditions and field calibration. Those steps would require separate validation with suitable hardware and maritime expertise.
