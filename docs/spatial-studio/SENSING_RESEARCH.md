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
- Whether an HTTPS page in Android WebView and in Chrome can reach a loopback WebSocket, and its latency and CPU cost.
- Wi-Fi RTT support on the test phone and the owner's access points.
- Whether ARCore light estimation helps place lamps and windows.
- Sun check: render the sun for the capture's date, time, location and north, and compare with a real shadow photographed at that moment.

## Roadmap placement

- P2N.2: Android capture of orientation, heading, geolocation (opt-in), light estimate and barometer into the bundle. It can be built alongside the first real-device test of P2N v1; its accuracy figures come only from that device.
- P2N.3: live telemetry transport spike (options 1 and 2 above).
- P3b: set site latitude, longitude and `northRotation` from a capture, with user confirmation; sun direction then follows from the existing daylight code.
- P5 (optional): radio-signal observations for multi-room registration and re-localisation.
