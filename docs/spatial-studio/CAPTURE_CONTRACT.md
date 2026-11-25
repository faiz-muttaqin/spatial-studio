# Capture contract: providers, scan bundle and Android bridge

Status: contract v1 proposed 2026-11-25; v1.1 (sensor streams) proposed 2026-11-25; v1.2 (boundary marks) proposed 2026-11-25; v1.3 (torch flag per keyframe, scan guard metadata) proposed 2026-11-25. Shared by the web `/scan` route (`apps/editor`) and the Android companion (`apps/android`). Change it in its own commit before changing either side. Nothing here is implemented until STATUS.md records evidence.

## Providers

| Provider id | Where | What it can claim |
|---|---|---|
| `browser-photo` | Any secure-context browser | Photos plus manually entered dimensions. No measured depth or pose. |
| `webxr` | Chrome Android with `immersive-ar` | Pose, hit-test, optional depth-sensing and camera-access, each negotiated individually. |
| `android-arcore` | Android companion app, native scan screen | ARCore pose, planes, point cloud, optional depth16 and RGB keyframes with intrinsics, plus device sensors (v1.1: orientation, compass heading, opt-in location, light estimate, barometer) and assisted boundary marks (v1.2). |

Every provider writes the same bundle. A provider never labels estimated values as measured: each measurement carries `source` (`manual`, `arcore`, `webxr`, `derived`) and, where known, a confidence.

## Scan bundle

A bundle is one `CaptureSessionManifest` schema version 2 (`packages/core/src/capture/schema.ts`) plus the artifacts it references.

### Storage and attachment

- Every artifact, and the manifest itself, is stored content-addressed with `PUT /api/artifacts/{sha256}` on the same origin (admin session cookie or `PASCAL_SCENE_API_TOKEN`). The route already rejects a hash mismatch.
- Artifact references in the manifest use `uri: "/api/artifacts/<sha256>"`, plus `sha256`, `byteLength` and `mediaType`.
- A project shows the capture through a `scan` node whose `captureSession` is `{ sessionId, schemaVersion: 2, manifestUrl: "/api/artifacts/<manifest sha256>" }`. The scan node is a reference layer; it does not create walls.
- Bounds per session: at most 300 keyframes, JPEG long edge at most 1920 px, each artifact at most 16 MB, point cloud at most 200,000 points after downsampling. Larger captures are split into sessions, not truncated silently.
- No private captures in Git. Test fixtures are synthetic.

### Frames and clocks

- `coordinateFrames`: `{ id: "world", convention: "arcore-world" }` for the companion (right-handed, Y up, metres, gravity aligned, origin at session start) or `"webxr-local-floor"` for WebXR. Browser-photo bundles have no world frame.
- Matrices are 16 numbers, column-major (Three.js `Matrix4.fromArray` and ARCore `Pose.toMatrix` order), camera-to-world.
- Camera poses use OpenGL camera axes: +X right, +Y up, -Z along the view direction. For `android-arcore`, keyframe and trajectory poses are ARCore `Camera.getPose()`, whose right and up are relative to the image readout, so they match the stored, unrotated JPEG and its intrinsics (`Camera.getImageIntrinsics()`, scaled to the stored size); depth intrinsics are `Camera.getTextureIntrinsics()` scaled to the depth image. The manifest records this as `metadata.camera: { convention: "opengl", frame: "image-readout", sensorOrientationDeg }`. Consumers using the computer-vision convention (+Y down, +Z forward) flip the Y and Z axes of the camera frame.
- Depth unprojection uses integer pixel indices with no half-pixel offset, as in the ARCore raw depth sample: for the pixel at column `x`, row `y` and depth `d` metres along the optical axis, the camera-frame point is `[d(x - cx)/fx, d(cy - y)/fy, -d]`, with `fx, fy, cx, cy` the depth intrinsics stored with the frame. Adding 0.5 would shift points by half a depth pixel, about 1.5 cm at 5 m.
- `clocks`: `{ id: "device", timebase: "nanoseconds" }` for ARCore frame timestamps and `{ id: "wall", timebase: "milliseconds", epoch: "unix" }` for capture times.

### Streams

| `kind` | `role` | Payload | Notes |
|---|---|---|---|
| `device-motion` | `deviceMotion` | inline `DeviceMotionTrajectory`, `coordinateSystem: "arcore-world"` | Existing viewer layer renders it. Tracking loss starts a new `segment`. |
| `point-cloud` | `pointCloud` | artifact `application/json`, `PointCloudPayload` | Existing viewer layer renders it. ARCore feature points with confidence at least 0.5 and within 8 m of the camera when seen (recorded in the stream `metadata` as `minConfidence` and `maxDistanceFromCameraM`), voxel downsampled. |
| `rgb-keyframes` | `photos` | artifact `application/json` index `{ frames: [entry, ...] }`, plus one `image/jpeg` artifact per frame | Entry: `{ id, timestamp, image: { uri, sha256 }, width, height, intrinsics: { fx, fy, cx, cy } | null, pose: number[16] | null, trackingState: "tracking" | "paused" | "stopped" | "none", torch?: boolean }`. `torch` is v1.3, see "Torch flag and scan guards (v1.3)". Browser-photo frames have `intrinsics` and `pose` null and `trackingState: "none"`. At most 300 entries; ids unique. |
| `depth-keyframes` | `depth` | artifact `application/json` index `{ frames: [entry, ...] }`, plus one `application/octet-stream` artifact per frame | Entry: `{ id, rgbKeyframeId, timestamp, width, height, intrinsics: { fx, fy, cx, cy }, depth: { uri, sha256 }, confidence: { uri, sha256 } | null }`. Depth is raw uint16 little-endian millimetres, row-major, `width` x `height`; confidence is uint8 in the same layout. Only when ARCore reports Depth API support. |
| `plane-set` | `planes` | artifact `application/json` `{ planes: [plane, ...] }` | ARCore planes: `{ id, orientation: "horizontal-up" | "horizontal-down" | "vertical", centerPose: number[16], extent: [x, z], polygon: [[x, z], ...] (plane-local metres, at least 3 points), subsumedBy: string | null }`. Primary input for wall, floor and ceiling candidates. |
| `manual-measurements` | `measurements` | artifact `application/json` | `{ units: "m", room: { width, length, height } (each positive or null), openings: [{ kind: "door" | "window", wall: string | null, width, height, sill }], notes, source: "manual" }`. Opening `width`, `height` and `sill` are nullable; an unknown value stays null. |
| `device-capabilities` | `capabilities` | inline | `{ probedAt (unix ms), browser: BrowserCapabilities | null, native: capabilities.get result | null }`. `browser` reports secure context, camera, WebXR `immersive-ar` (`supported`, `unsupported` or `unknown`; optional features stay `unknown` because they are only negotiated at session start), orientation and motion permission state, and the browser family and major version (for example `Chrome 140`), never the full user agent. |
| `device-orientation` | `orientation` | artifact `application/json` `{ samples: [{ timestamp, q: [x, y, z, w], headingAccuracyDeg }] }` | v1.1. See "Sensor streams (v1.1)". |
| `heading` | `heading` | artifact `application/json` `{ samples: [{ timestamp, azimuthMagneticDeg, azimuthTrueDeg, declinationDeg, magnetometerAccuracy, headingAccuracyDeg, worldBearingDeg }] }` | v1.1. Camera-direction compass samples paired with the ARCore world bearing. |
| `geolocation` | `geolocation` | artifact `application/json` `{ fixes: [{ timestamp, latitude, longitude, altitudeM, accuracyM, provider }] }` | v1.1, opt-in, off by default. Wall clock. |
| `light-estimate` | `lightEstimate` | artifact `application/json` `{ estimates: [{ keyframeId, timestamp, mode, state, pixelIntensity, colorCorrection, mainLightDirection, mainLightIntensity }] }` | v1.1. One entry per keyframe at most. |
| `barometer` | `barometer` | artifact `application/json` `{ samples: [{ timestamp, hPa }] }` | v1.1. |
| `boundary-marks` | `boundaryMarks` | artifact `application/json` `{ marks: [mark, ...] }` | v1.2. User-marked wall, glass, mirror, opening and door bases. See "Boundary marks (v1.2)". |

`metadata` on the manifest: `{ provider, appVersion, bridgeVersion?, device: { manufacturer, model, os } (each nullable), createdAt (ISO 8601), trackingLossCount, warnings: string[], trueNorth? }` (`trueNorth` is v1.1, see below). Browser providers record only the OS family (`os`) and leave `manufacturer` and `model` null; shared scenes can expose their artifacts.

The payload schemas live in `packages/core/src/capture/streams.ts` and, for the v1.1 sensor streams, `packages/core/src/capture/sensor-streams.ts` (both exported from `@pascal-app/core/capture`); a bundle that fails them is invalid.

### Sensor streams (v1.1)

All five are optional and additive: a v1 reader ignores streams it does not know, and a bundle without them stays valid. Every stream is an artifact (`application/json`) with a stream descriptor in the manifest; none is inline, because the sample counts below would bloat the manifest. All numbers are finite. Every sample list is in time order. Bounds are enforced by the schemas; a provider that reaches a bound stops recording that stream and adds the warning `<kind>-truncated` to `metadata.warnings` instead of dropping data silently.

| Stream | Clock | Units | Rate and bound |
|---|---|---|---|
| `device-orientation` | `device` (ns) | `q` is a unit quaternion `[x, y, z, w]` (Hamilton) rotating device axes into the Android east-north-up frame (+X east, +Y magnetic north, +Z up), from `TYPE_ROTATION_VECTOR`. `headingAccuracyDeg` is the sensor's estimated heading accuracy in degrees, or null when it reports none. | At most 50 Hz, at most 36,000 samples. `timestamp` is the sensor event timestamp in nanoseconds. |
| `heading` | `device` (ns) | Angles in degrees in [0, 360), clockwise seen from above. `azimuthMagneticDeg` is the compass bearing of the camera's forward direction relative to magnetic north; `azimuthTrueDeg` is that bearing plus `declinationDeg`; both are null unless the bundle holds a location fix. The companion records magnetic azimuth only and adds the declination at finalisation from the retained `geolocation` fixes, so a scan whose location was switched off carries no declination anywhere (heading samples, `trueNorth`). `magnetometerAccuracy` is the Android accuracy status 0 (unreliable) to 3 (high). `headingAccuracyDeg` as above. `worldBearingDeg` is the bearing of the same direction in the ARCore world frame, clockwise from world -Z seen from above (0 at -Z, 90 at +X). | At most 5 Hz, at most 6,000 samples. Written only while ARCore tracks and the camera looks within 60 degrees of the horizontal, because a near-vertical view has no stable bearing. |
| `geolocation` | `wall` (ms) | `latitude` and `longitude` in degrees (WGS 84), `altitudeM` metres or null, `accuracyM` horizontal accuracy in metres, `provider` one of `gps`, `network`, `fused`, `passive`, `unknown`. | At most 60 fixes, at least 10 s apart. |
| `light-estimate` | `device` (ns) | `mode` is `ambient-intensity` or `environmental-hdr`. `state` is `valid` or `invalid` (ARCore could not estimate; the other fields are then null). In `ambient-intensity` mode `pixelIntensity` is the average pixel intensity in [0, 1] and `colorCorrection` is `[r, g, b, gamma]`; the main-light fields are null. In `environmental-hdr` mode `mainLightDirection` is a unit vector in the ARCore world frame and `mainLightIntensity` an `[r, g, b]` linear radiance; the ambient fields are null. These are estimates, not lux. The sign convention of `mainLightDirection` follows ARCore and is not yet checked on a device. | At most one entry per RGB keyframe (`keyframeId`, `timestamp` equal to that keyframe's), so at most 300. |
| `barometer` | `device` (ns) | `hPa` is air pressure in hectopascals, 300 to 1100. Consumers derive relative height from pressure differences; absolute altitude is not claimed. | At most 2 Hz, at most 4,000 samples. |

Stream descriptor `metadata`: `device-orientation` and `heading` carry `{ source: "rotation-vector", timestampSource: "realtime" | "unknown" }`. `realtime` is written only when the companion verified at runtime that both ARCore frame timestamps and sensor event timestamps are on the boot-time clock (each compared with `elapsedRealtimeNanos()` on arrival: a small, steady, non-negative delivery delay), so they can be compared directly. Otherwise it is `unknown`, no `heading` samples are written, and `metadata.warnings` carries `sensor-clock-not-comparable`; consumers must not align the clocks below about 100 ms.

#### True north

`metadata.trueNorth` (optional, present only when enough samples exist):

```ts
type TrueNorth = {
  worldYawDeg: number // (-180, 180]: bearing of north in the ARCore world, clockwise from world -Z seen from above
  confidence: number // 0 to 1, from sample count and spread; not a probability
  method: 'compass-median-true' | 'compass-median-magnetic'
  reference: 'true' | 'magnetic' // which north worldYawDeg points to
  spreadDeg: number // robust spread (1.4826 x median absolute deviation) of the per-sample estimates
  sampleCount: number // samples that passed the filters
  declinationDeg: number | null // declination applied, null for magnetic
  segmentsAgree: boolean // false when tracking segments disagree; confidence is then at most 0.3
}
```

Derivation: for each `heading` sample the north estimate is `worldBearingDeg - azimuth` (true azimuth when a declination is known, magnetic otherwise), wrapped to (-180, 180]. Only samples with `magnetometerAccuracy` of at least 2 (medium) and, where reported, `headingAccuracyDeg` of at most 25 are used. The result is the circular median of those estimates. `confidence` is the product of: samples counted once per 2 s window (5 Hz samples are autocorrelated; 30 windows give full weight), one minus `spreadDeg` over 30, and the angular range of camera bearings covered over 180 degrees (all capped at 1), then capped at 0.6 when the median magnetometer accuracy is below high and at 0.3 when `segmentsAgree` is false. Samples are split into segments wherever more than 1 s passes between them (tracking loss); a segment of at least 10 samples whose median differs from the overall one by more than 15 degrees sets `segmentsAgree` to false and adds the warning `true-north-segments-disagree`. With no location fix there is no declination, so `reference` is `magnetic` and `method` is `compass-median-magnetic`: it points to magnetic north, which differs from true north by the local declination (up to about 20 degrees in parts of Asia). Indoor steel and wiring can bend the field by tens of degrees; `spreadDeg` and `confidence` show it. The value is an estimate to be confirmed by the user before it sets a site `northRotation` (ROADMAP P3b); it never changes geometry. It is relative to the ARCore world frame of this scan as recorded: P3b must add any alignment rotation applied to the scan (its node transform) to `worldYawDeg` before using it as `northRotation` (`worldYawDeg` times pi over 180, plus that rotation).

#### Privacy

- Location is off by default, requested per capture, and only the approximate location permission is asked for: the sun position and declination need kilometres, not metres. When a page asks for location the companion shows its own confirmation once per scan, before the system permission prompt, and the scan screen can switch it off again: off discards the fixes and the declination derived from them.
- A bundle with `geolocation` identifies a place. Treat it as personal data: no public artifacts, coarsen (about 1 km) before a scene is shared or the data goes to an external service, and do not send it to an external AI without explicit consent. The wall clock timestamps tie it to a moment.
- The other four streams contain no identifiers. `heading.declinationDeg` reveals the region only coarsely and is null when location is off.

### Boundary marks (v1.2)

Optional and additive: a v1 or v1.1 reader ignores the stream, and a bundle without it stays valid. It exists because ARCore finds floor and ceiling planes reliably but often finds no vertical plane on plain walls, and the camera sees through glass (see [GLASS_AND_MIRRORS.md](GLASS_AND_MIRRORS.md)). The user taps the floor at both ends of a boundary's base, where floor hit-tests are reliable. The stream carries only what the user marked; it never claims a fitted or measured surface.

The artifact is `application/json`, `{ marks: [mark, ...] }`, frame `world`, with at most 200 marks and unique ids. A stream descriptor carries `metadata: { source: "manual-ar-marking", count }`.

```ts
type BoundaryMark = {
  id: string // unique in the stream, 1 to 64 characters
  kind: 'wall' | 'glass' | 'mirror' | 'opening' | 'door'
  base: [BasePoint, BasePoint] // start, end; in the order tapped
  height: {
    metres: number | null // 0.1 to 10; null only when source is "unknown"
    source: 'ceiling-plane' | 'typed' | 'unknown'
    ceilingPlaneId: string | null // set only for "ceiling-plane": the plane-set id the height came from
  }
  source: 'manual-ar-marking'
  createdAt: number // unix ms (clock "wall"), when the second point was accepted
  notes: string | null // at most 500 characters
}
type BasePoint = {
  point: [x, y, z] // ARCore world metres; equals the translation of pose within 1 mm
  pose: number[16] // column-major hit pose; its Y axis is the plane normal at the hit
  planeId: string | null // the horizontal plane that was hit; may be absent from the plane-set stream
  timestamp: number // device clock, nanoseconds: the ARCore frame the tap was resolved against
}
```

Rules:

- Both base points come from ARCore hit-tests against a tracked, upward-facing horizontal plane, inside that plane's polygon, at the floor level (no higher than 0.25 m above the lowest tracked upward plane). Hits on feature points, depth points, instant placement or vertical planes are refused, because on clear glass those land on whatever lies behind it. The user taps the floor line at the base, not the glass. A tap resolves to a candidate point shown in the camera view, and the user confirms it before it becomes a base point. Because a ray through undetected glass can reach a floor far behind it, the companion also refuses a hit more than 4 m from the camera, or on a ray less than 15 degrees below the horizontal, or with something nearer than the floor along the ray.
- The two points are at least 0.05 m and at most 50 m apart horizontally, and differ in height by at most 0.5 m. A base is a floor line, not a slanted one.
- `ceiling-plane`: the user asked for "to ceiling", and the height is the tracked downward-facing plane's height above the mean base height, accepted from 1.8 m to 6 m. The companion offers the option for `wall` (on by default) and `glass` (off by default, because a balustrade is not ceiling height) and never for `mirror`, `door` or `opening`. It is never applied without the user's choice. `ceilingPlaneId` names the plane in the `plane-set` stream when that plane was still known at the end of the scan, and may otherwise not resolve there.
- `typed`: the user entered the height in metres. `unknown`: neither was available; a consumer chooses its own default and labels it an assumption.
- Marks are the user's statement of where a boundary stands. They do not say the surface was seen, and a `glass` or `mirror` mark is the only evidence of such a surface in the bundle. Consumers must not treat a mark as a measurement of thickness, material or reflectivity.
- Clocks: base point `timestamp` is on the `device` clock (nanoseconds) and `createdAt` on the `wall` clock (milliseconds), so the descriptor carries no single `clockId`.
- Coordinates are in the scan's world frame, so true north and any scan node transform apply exactly as for the other streams. Marks carry no personal data.

### Torch flag and scan guards (v1.3)

Optional and additive: a v1 to v1.2 reader ignores the new fields, and a bundle without them stays valid.

- `rgb-keyframes` entries may carry `torch: boolean`: whether the ARCore torch (`Config.FlashMode.TORCH`) was on when the frame was captured. Absent means unknown (older bundles, browser photos). It exists so offline code can compare torch-on and torch-off frames of the same place. Torch light falls off with the square of distance, auto-exposure shifts between the two states, and ARCore tracking can behave differently with the torch on, so a consumer must not treat the flag as a calibrated measurement.
- `metadata.arcore.torch`: `{ supported: boolean | null, framesOn: number, framesOff: number }`. `supported` is the result of `session.isSupported(config)` for the torch configuration, or null when the torch was never asked for; when it is false the torch stayed off and `metadata.warnings` carries `torch-unsupported`. A `configure` exception adds `torch-configure-failed` instead, and switching the torch after the first keyframe adds `torch-toggled-mid-scan` (ARCore may restart tracking on a configuration change; not yet verified on a device).
- `metadata.arcore.motionGuard`: `{ maxSpeedMps, maxTurnDegPerSecond, keyframeMaxSpeedMps, keyframeMaxTurnDegPerSecond, keyframeMaxHoldMs, fastKeyframeSkips, poseJumps: [{ timestampNs, metres, degrees, recoveredTimestampNs: number | null, manualResume: boolean }] }`. `maxSpeedMps` and `maxTurnDegPerSecond` only drive the on-screen hint. Keyframes whose capture was due while the camera moved faster than the looser `keyframe*` limits were held back, never longer than `keyframeMaxHoldMs`; `fastKeyframeSkips` counts episodes in which a due keyframe was held back (one per episode, not per frame) and `metadata.warnings` carries `keyframes-skipped-fast` when it is above zero. A pose jump is ARCore moving the camera pose further in one frame than a hand-held phone can while still reporting `TRACKING`. A jump ends when the pose jumps back, walks back onto the old trajectory, or the user taps "Resume recording here" (`manualResume`). While a jump is unresolved no keyframes, depth frames or points are recorded; the trajectory keeps recording. `metadata.warnings` carries `pose-jump` for each scan with at least one event, and `pose-jump-unrecovered` when the last one never recovered. At most 50 events are kept.

## Android bridge, protocol v1

The companion is a Kotlin WebView shell that loads the deployed web app and adds a narrow native bridge. It does not fork the editor or the scene graph.

### Transport

- `WebViewCompat.addWebMessageListener` injects `window.SpatialStudioNative` only for an explicit origin allowlist: the build-time studio origin (default `https://spatial-studio.faizmuttaqin.com`) and, in debug builds only, the local dev origin. The listener re-checks `sourceOrigin` and `isMainFrame` on every message. No `addJavascriptInterface`.
- Page to native: `SpatialStudioNative.postMessage(JSON.stringify(request))`; replies and events arrive on `SpatialStudioNative.onmessage`.
- Messages are JSON, at most 64 KiB. Binary data never crosses the bridge.

```ts
type BridgeRequest = { v: 1; id: string; method: string; params?: Record<string, unknown> }
type BridgeReply =
  | { v: 1; id: string; ok: true; result: unknown }
  | { v: 1; id: string; ok: false; error: { code: string; message: string } }
type BridgeEvent = { v: 1; event: 'scan.state' | 'scan.progress' | 'upload.progress'; data: unknown }
```

Event `data` is an object that carries the `sessionId` it belongs to. The page extends a pending `scan.upload` timeout only on `upload.progress` events for that upload's session.

Error codes: `forbidden`, `invalid_request`, `unknown_method`, `unsupported`, `permission_denied`, `busy`, `not_found`, `upload_failed`, `internal`.

### Methods

| Method | Params | Result |
|---|---|---|
| `bridge.hello` | none | `{ bridgeVersion: 1, appVersion, platform: "android", methods: string[] }` |
| `capabilities.get` | none | `{ arcore: { availability, depth: boolean, rawDepth: boolean }, cameras: [{ id, facing, focalLengths, intrinsics, depthOutput, logicalMultiCamera, physicalIds }], sensors: { accelerometer, gyroscope, rotationVector, magnetometer, barometer, ... }, device: { manufacturer, model, sdkInt, webViewVersion } }` |
| `scan.start` | `{ projectId?, options?: { depth?: boolean, keyframeSpacingM?: number, maxKeyframes?: number, location?: boolean, sensors?: boolean } }` | `{ sessionId }`, then `scan.state` and `scan.progress` events while the native scan screen runs |
| `scan.list` | none | `[{ sessionId, createdAt, state, keyframes, bytes, uploaded }]` |
| `scan.upload` | `{ sessionId }` | `{ sessionId, manifestUrl, manifestSha256 }` after every artifact and the manifest are stored; `upload.progress` events meanwhile |
| `scan.discard` | `{ sessionId }` | `{ sessionId }` |

### Upload and security rules

- The native side uploads with `PUT /api/artifacts/{sha256}` to the same allowlisted origin that sent `scan.upload`, using that origin's cookie from `CookieManager` and an `Origin` header for it. It never sends cookies anywhere else, never logs them, and never accepts a target URL from the page.
- Sensor opt-ins (v1.1): `options.sensors` (default `true`) records orientation, heading, light estimate and barometer; `false` records none of them. `options.location` (default `false`) records `geolocation` and gives the heading stream a declination. The native side asks for the approximate-location permission only when `location` is `true` and the permission is not yet held; a denial or a disabled system location setting does not fail the scan, it adds the warning `location-permission-denied` or `location-unavailable` and records no `geolocation`. The WebView never receives location access.
- Camera: the WebView grants only `RESOURCE_VIDEO_CAPTURE`, only to an allowlisted origin, and only when the app already holds `CAMERA`. Everything else is denied by omission.
- Top-level navigation: HTTPS and allowlisted host only; other links open in the system browser. No mixed content, no cleartext except the debug local origin.
- Scans live in app-private storage until uploaded or discarded. No background recording; the scan screen stops the camera on pause.
- The page treats the bridge as optional: when `window.SpatialStudioNative` is absent, `/scan` offers WebXR or browser-photo instead.

## Next stage (not part of v1)

Scan-to-scene (ROADMAP P3b) reads `plane-set`, `point-cloud`, `manual-measurements` and `boundary-marks` to propose wall, slab and ceiling nodes for human review. Agent read tools for scan bundles (P4a) expose manifest summaries, measurements and bounded keyframe images to MCP clients.
