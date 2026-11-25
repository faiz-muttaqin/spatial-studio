# Sensing research: live telemetry, orientation, location and radio signals

Status: research track requested by the owner on 2026-11-25. Nothing here is implemented or adopted. ARCore pose, planes and depth stay the authority for geometry; every other signal adds context, registration or confidence and is labelled as estimated unless verified.

The charter in [README.md](README.md) excluded RF sensing from the MVP. It is now allowed as optional research only, and it never becomes a dependency of the browser path.

## Goal: a draft capture phase

1. **Record everything** the phone can sense during a capture into the scan bundle (raw evidence, never edited).
2. **Agent proposes** the space through MCP: walls, openings, fixtures, finishes, site location, true north and sun direction. Each proposal names the evidence it used and its confidence.
3. **User verifies** each proposed element (accept, adjust, reject) while the plan is built. Only verified elements enter the as-built baseline (ARCHITECTURE.md steps 2 to 5, ROADMAP P3a and P3b).

## Signals and what they can honestly give

Accuracy figures are expectations to be measured on the owner's test phone, not claims.

| Signal | Android source | What it gives | Expected limits | Use |
|---|---|---|---|---|
| Orientation | `TYPE_ROTATION_VECTOR`, `TYPE_GAME_ROTATION_VECTOR`, accelerometer, gyroscope | Device attitude at 100 Hz or more, gravity | Drifts in yaw without the magnetometer | Cross-check ARCore pose, detect shake and blur, choose sharp keyframes |
| Heading | Magnetometer plus `GeomagneticField` declination | Bearing of the ARCore world to true north | Indoors steel and wiring can bend it by tens of degrees; needs a median over the session and a confidence | Site `northRotation`, sun direction |
| Location | Fused location (GNSS, Wi-Fi, cell) | Latitude, longitude, altitude, accuracy | Weak indoors; capture near a window or entrance. Kilometre accuracy is enough for sun position | Site latitude and longitude, sun direction |
| Date and time | Device wall clock | Capture moment | None of note | With location and north: sun position through the existing `solarPosition` in `packages/viewer/src/lib/daylight` |
| Light | ARCore light estimation (ambient intensity, colour correction, environmental HDR main light direction) | Brightness and dominant light direction per keyframe | Estimates, not lux | Lamp and window hints for the agent, colour correction of textures |
| Camera metadata | Camera2 capture results (exposure, ISO, white balance, focus distance) | Photometric context per keyframe | Device dependent | Texture colour calibration |
| Pressure | Barometer | Relative height change | Roughly 0.1 to 0.3 m after filtering | Floor changes, stairs, multi-floor (P5) |
| Wi-Fi RTT | `WifiRttManager` (802.11mc fine timing) | Distance to compatible access points | 1 to 2 m in open space, only with RTT-capable access points | Room-level position, registering several rooms or visits |
| Wi-Fi and Bluetooth signal strength | Wi-Fi scan results, BLE scan | Signal-strength fingerprints | Several metres of noise; not geometry | Recognising which room a capture belongs to |
| UWB | `androidx.core.uwb` on supported phones | 10 to 30 cm ranging to UWB anchors | Needs UWB hardware and anchors | Optional precise anchors |

## Live telemetry transport (spike)

The recorded bundle stays the source of truth. A live stream is for preview and for an agent working while the user is still scanning. Options to compare on a real device:

1. **Bridge events (protocol v1).** Small JSON events at 10 to 30 Hz over the existing origin-checked WebMessage bridge. No open port. Probably enough for orientation and heading.
2. **Loopback WebSocket in the app.** Bound to `127.0.0.1` only, with a random per-session token handed to the page through the bridge, an `Origin` check and binary frames. Suits high-rate sensor batches and preview frames. Must be tested against Chrome and Android WebView local-network-access rules for an HTTPS page calling loopback. A LAN-reachable mode (for a desktop on the same Wi-Fi) stays off by default and needs authentication and TLS before it is considered.
3. **Record, then upload** (current v1). Always available; the other two only add liveness.

### Spike result (P2N.3, 2026-11-25)

**Decision: use a `WebMessagePort` channel (option 1, binary), not a loopback WebSocket.** Both carry the planned load with no loss; the port needs no open socket, no token and no network-security exception.

What was built (all behind `options.livePreview`, off by default; the recording does not depend on it):

- Wire format: one binary frame per message, little endian, 24 byte header (`SSL1`, type, flags, `seq`, `timestampNs`, payload length), then a depth (with confidence), pose, coverage or plane payload. Encoder `apps/android/.../live/LiveFrames.kt`, decoder `packages/core/src/capture/live-frames.ts`; both check the same bounds (128 KiB payload, 40,000 depth pixels, 4,096 coverage cells, 32 planes) and the decoder drops anything malformed.
- Rates: depth 5 Hz, pose 10 Hz, coverage 2 Hz, planes 1 Hz, and a byte budget of 400 KB/s. The scan screen builds a frame only when the stream wants one, and drops it when the transport is behind. A 160 x 90 depth frame with confidence is 43,308 bytes.
- Transport (a): `WebViewCompat.createWebMessageChannel`, the page end sent with `postWebMessage` to the trusted origin only, frames as `WebMessageCompat(byte[])` (ArrayBuffers in the page). Needs `CREATE_WEB_MESSAGE_CHANNEL`, `POST_WEB_MESSAGE`, `WEB_MESSAGE_PORT_POST_MESSAGE`, `WEB_MESSAGE_PORT_CLOSE` and `WEB_MESSAGE_ARRAY_BUFFER`, all present in `androidx.webkit` 1.13.0 and in the emulator's WebView 133.
- Transport (b): a hand-written RFC 6455 server on `127.0.0.1`, random port, one client, 128-bit per-session token in the query, exact `Origin` match, `Host` must be the loopback address and port (DNS rebinding), client data frames refused. Kept as a fallback the page requests only when the WebView reports binary messages as unsupported.
- Live view: when the page opts in, the scan screen shows a small WebView (220 x 300 dp, right side) loading `/scan/live` from the origin that started the scan. A Web Worker owns the stream, decodes frames and runs the existing `carveRoomOutline` on the last 24 depth frames (about one pass a second, paced at three times its own duration); the page draws a coverage map, the camera and the outline. No algorithm was ported to Kotlin.
- The panel's only native handle is `SpatialStudioLive` with `live.open` and `live.close`; scan methods are not reachable from it. The stream is closed on pause, finish, cancel and destroy (the page is told on pause and reopens on resume).

Measurements, API 36 emulator on a Mac, WebView 133, synthetic frames at the planned rates through the real stream code, page on `https://spatial-studio.faizmuttaqin.com` (the deployed origin) and latency as the page's `Date.now()` minus the sender's stamp on the same clock. The owner's phone was not used, so CPU and battery cost on real hardware are not measured.

| Run | Frames | Offered | p50 / p95 / max latency | Lost |
|---|---|---|---|---|
| Port, nominal, 20 s | 339 | 218 KB/s | 2 / 3 / 24 ms | 0 |
| Port, nominal, 30 s | 430 | 190 KB/s | 3 / 7 / 88 ms | 0 |
| Loopback socket, nominal, 12 s | 203 | 220 KB/s | 2 / 3 / 5 ms | 0 |
| Loopback socket, nominal, 30 s | 448 | 197 KB/s | 3 / 8 / 36 ms | 0 |
| Port, rates x10, 10 s | 563 | 819 KB/s | 3 / 6 / 35 ms | 0 |
| Loopback socket, rates x10, 10 s | 629 | 900 KB/s | 3 / 7 / 63 ms | 4 (queue full) |

Both are far below what the link can carry; the x10 runs were limited by the benchmark's 10 ms feeder loop, so they show headroom, not a ceiling. The app process used about 2 to 3 % of one core at nominal rates and 6 to 7 % at x10 (`top`, emulator, page worker not included). The latency numbers say nothing about a real phone's CPU under ARCore load.

Can an HTTPS page open `ws://127.0.0.1`?

- With `MIXED_CONTENT_NEVER_ALLOW` set, the debug build (which allows cleartext to loopback in its network security config) opened it in 20 ms. WebView treats `127.0.0.1` as potentially trustworthy, so mixed-content rules did not block it, and no local-network permission prompt appeared in WebView 133.
- With the release network security config (cleartext not permitted, no loopback exception) the same page failed: `error`, close code 1006, no frame delivered. A loopback WebSocket in a release build therefore needs a `cleartextTrafficPermitted` exception for `127.0.0.1`, a standing weakening of the app's transport policy, for the benefit of one preview.
- Chrome's local network access rules (permission prompt for a secure page reaching loopback) were not tested, because this app uses WebView. If the stream is ever needed from a desktop or Chrome page, that test comes first.

Why the port wins: same latency and loss at the planned rates, no listening socket (any other app on the phone can connect to a loopback port; the token and Origin check are the only gate), no cleartext exception, the channel dies with the page, and it works under the existing origin allowlist. The loopback server stays in the code only as a request-time fallback; remove it if a WebView without binary messages never shows up in the device list.

Limits: the preview's carving ran on synthetic depth in tests (a 4 x 3 m room walked on an ellipse gives 10 to 14 m²) and took 315 ms for 24 frames and 38,880 rays on the Mac; on a phone expect more, hence the pacing. A real scan with the panel open has not been run (the emulator has no ARCore capture), so the first thing to check on the phone is frame rate with the panel and ARCore together, and whether a second WebView costs ARCore frames.

## Contract additions (v1.1)

Adopted for the first five items in [CAPTURE_CONTRACT.md](CAPTURE_CONTRACT.md) (2026-11-25); `rf-observations` stays research and has no schema.

- `device-orientation`: rotation-vector quaternions with accuracy, device clock.
- `heading`: true-north heading samples with magnetic accuracy and declination; manifest metadata `trueNorth: { worldYawDeg, confidence, method }`.
- `geolocation` (opt-in): fixes with accuracy, provider and wall clock.
- `light-estimate`: ARCore light estimate per keyframe.
- `barometer`: pressure samples.
- `rf-observations` (opt-in): Wi-Fi RTT ranges and signal strengths, identifiers hashed with a per-project salt.

## Privacy

Location and radio identifiers are personal data. They are off by default, opted into per capture, stored hashed where they identify a place or device, never sent to an external AI without explicit consent, and coarsened before a scene is shared. Artifacts are never public unless their scene is shared.

## Research questions

- Indoor heading error against a wall of known bearing, after median filtering (target 10 degrees or better).
- Whether an HTTPS page in Android WebView and in Chrome can reach a loopback WebSocket, and its latency and CPU cost. Android WebView answered in the spike below (yes in debug, blocked by the release cleartext policy); Chrome and CPU on a phone are open.
- Wi-Fi RTT support on the test phone and the owner's access points.
- Whether ARCore light estimation helps place lamps and windows.
- Sun check: render the sun for the capture's date, time, location and north, and compare with a real shadow photographed at that moment.

## Depth sources without LiDAR

Measured on the owner's test phone (Samsung SM-S937B): ARCore depth and raw depth are supported, no Camera2 camera reports `DEPTH_OUTPUT` (no time-of-flight sensor), and the back camera is a logical multi-camera (wide and ultrawide). Depth therefore comes from ARCore depth-from-motion, which needs the phone to move sideways, not only rotate.

| Source | Status | Notes |
|---|---|---|
| ARCore raw depth with confidence | Recorded (P2N v1) | 160 x 90 per keyframe on the test phone; primary geometry source with poses |
| ARCore planes | Recorded (fixed in #5) | Floors and ceilings found on the test phone; no vertical planes on plain or glass walls |
| ARCore feature points | Recorded | Filtered at acquisition by distance and confidence |
| Camera2 `DEPTH16` / ToF | Probed only | Absent on the test phone; use when a device reports it |
| Learned monocular depth (for example Depth Anything V2) | P5 candidate | For phones without the Depth API; check code and weight licences per model size before use |

Walls without texture or made of glass give no vertical planes, so P3b needs wall fitting from raw depth, floor-plane boundaries and the walked path, plus assisted marking ([GLASS_AND_MIRRORS.md](GLASS_AND_MIRRORS.md)).

## Acoustic ranging (spike, opt-in)

The phone's speaker emits a short near-ultrasonic chirp and the microphone times its echo (distance = speed of sound x delay / 2, about 5.8 ms per metre of round trip). It is the bat-like option that works on a standard phone, and it is complementary to the camera: clear glass reflects sound strongly, so echoes can locate glass the camera sees through. Published work on smartphone acoustic floor plans and echo-based SLAM (for example BatMapper, MobiSys 2017) supports the idea; their accuracy figures do not transfer without our own measurements.

Constraints: request unprocessed microphone input (vendor echo cancellation and noise suppression can remove the echo), calibrate speaker-to-microphone latency per device, combine echoes with ARCore poses from several positions (one echo is ambiguous), keep volume low and chirps short (near-ultrasound can still be audible to some people and animals). Privacy: microphone use needs explicit per-scan opt-in, raw audio is never stored or uploaded, and only echo profiles (delays, strengths, confidence, pose reference) enter the bundle through a new contract stream.

First experiment: distances of 0.5 to 4 m to concrete, wood, glass, a mirror and a curtain, at several angles, compared with a tape measure.

Wi-Fi and Bluetooth on a standard phone measure distance to other devices (Wi-Fi RTT, Bluetooth channel sounding, UWB), not to walls; reflection analysis (Wi-Fi CSI) needs extra hardware. They stay optional research for positioning, not geometry.

## Roadmap placement

- P2N.2: Android capture of orientation, heading, geolocation (opt-in), light estimate and barometer into the bundle. It can be built alongside the first real-device test of P2N v1; its accuracy figures come only from that device.
- P2N.3: live telemetry transport spike (options 1 and 2 above). Done on the emulator 2026-11-25: binary `WebMessagePort`, preview panel and worker built, see the spike result above; real-phone run pending.
- P2N.4 (spike): acoustic ranging, opt-in, echo profiles only, measured against a tape on several materials before any adoption.
- P3b: set site latitude, longitude and `northRotation` from a capture, with user confirmation; sun direction then follows from the existing daylight code.
- P5 (optional): radio-signal observations for multi-room registration and re-localisation.
