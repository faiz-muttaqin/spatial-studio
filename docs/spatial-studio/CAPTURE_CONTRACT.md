# Capture contract: providers, scan bundle and Android bridge

Status: contract v1 proposed 2026-11-25; v1.1 (sensor streams) proposed 2026-11-25. Shared by the web `/scan` route (`apps/editor`) and the Android companion (`apps/android`). Change it in its own commit before changing either side. Nothing here is implemented until STATUS.md records evidence.

## Providers

| Provider id | Where | What it can claim |
|---|---|---|
| `browser-photo` | Any secure-context browser | Photos plus manually entered dimensions. No measured depth or pose. |
| `webxr` | Chrome Android with `immersive-ar` | Pose, hit-test, optional depth-sensing and camera-access, each negotiated individually. |
| `android-arcore` | Android companion app, native scan screen | ARCore pose, planes, point cloud, optional depth16 and RGB keyframes with intrinsics, plus device sensors (v1.1: orientation, compass heading, opt-in location, light estimate, barometer). |

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
- `clocks`: `{ id: "device", timebase: "nanoseconds" }` for ARCore frame timestamps and `{ id: "wall", timebase: "milliseconds", epoch: "unix" }` for capture times.

### Streams

| `kind` | `role` | Payload | Notes |
|---|---|---|---|
| `device-motion` | `deviceMotion` | inline `DeviceMotionTrajectory`, `coordinateSystem: "arcore-world"` | Existing viewer layer renders it. Tracking loss starts a new `segment`. |
| `point-cloud` | `pointCloud` | artifact `application/json`, `PointCloudPayload` | Existing viewer layer renders it. ARCore feature points with confidence at least 0.3, voxel downsampled. |
| `rgb-keyframes` | `photos` | artifact `application/json` index `{ frames: [entry, ...] }`, plus one `image/jpeg` artifact per frame | Entry: `{ id, timestamp, image: { uri, sha256 }, width, height, intrinsics: { fx, fy, cx, cy } | null, pose: number[16] | null, trackingState: "tracking" | "paused" | "stopped" | "none" }`. Browser-photo frames have `intrinsics` and `pose` null and `trackingState: "none"`. At most 300 entries; ids unique. |
| `depth-keyframes` | `depth` | artifact `application/json` index `{ frames: [entry, ...] }`, plus one `application/octet-stream` artifact per frame | Entry: `{ id, rgbKeyframeId, timestamp, width, height, intrinsics: { fx, fy, cx, cy }, depth: { uri, sha256 }, confidence: { uri, sha256 } | null }`. Depth is raw uint16 little-endian millimetres, row-major, `width` x `height`; confidence is uint8 in the same layout. Only when ARCore reports Depth API support. |
| `plane-set` | `planes` | artifact `application/json` `{ planes: [plane, ...] }` | ARCore planes: `{ id, orientation: "horizontal-up" | "horizontal-down" | "vertical", centerPose: number[16], extent: [x, z], polygon: [[x, z], ...] (plane-local metres, at least 3 points), subsumedBy: string | null }`. Primary input for wall, floor and ceiling candidates. |
| `manual-measurements` | `measurements` | artifact `application/json` | `{ units: "m", room: { width, length, height } (each positive or null), openings: [{ kind: "door" | "window", wall: string | null, width, height, sill }], notes, source: "manual" }`. Opening `width`, `height` and `sill` are nullable; an unknown value stays null. |
| `device-capabilities` | `capabilities` | inline | `{ probedAt (unix ms), browser: BrowserCapabilities | null, native: capabilities.get result | null }`. `browser` reports secure context, camera, WebXR `immersive-ar` (`supported`, `unsupported` or `unknown`; optional features stay `unknown` because they are only negotiated at session start), orientation and motion permission state, and the browser family and major version (for example `Chrome 140`), never the full user agent. |
| `device-orientation` | `orientation` | artifact `application/json` `{ samples: [{ timestamp, q: [x, y, z, w], headingAccuracyDeg }] }` | v1.1. See "Sensor streams (v1.1)". |
| `heading` | `heading` | artifact `application/json` `{ samples: [{ timestamp, azimuthMagneticDeg, azimuthTrueDeg, declinationDeg, magnetometerAccuracy, headingAccuracyDeg, worldBearingDeg }] }` | v1.1. Camera-direction compass samples paired with the ARCore world bearing. |
| `geolocation` | `geolocation` | artifact `application/json` `{ fixes: [{ timestamp, latitude, longitude, altitudeM, accuracyM, provider }] }` | v1.1, opt-in, off by default. Wall clock. |
| `light-estimate` | `lightEstimate` | artifact `application/json` `{ estimates: [{ keyframeId, timestamp, mode, state, pixelIntensity, colorCorrection, mainLightDirection, mainLightIntensity }] }` | v1.1. One entry per keyframe at most. |
| `barometer` | `barometer` | artifact `application/json` `{ samples: [{ timestamp, hPa }] }` | v1.1. |

`metadata` on the manifest: `{ provider, appVersion, bridgeVersion?, device: { manufacturer, model, os } (each nullable), createdAt (ISO 8601), trackingLossCount, warnings: string[], trueNorth? }` (`trueNorth` is v1.1, see below). Browser providers record only the OS family (`os`) and leave `manufacturer` and `model` null; shared scenes can expose their artifacts.

The payload schemas live in `packages/core/src/capture/streams.ts` and, for the v1.1 sensor streams, `packages/core/src/capture/sensor-streams.ts` (both exported from `@pascal-app/core/capture`); a bundle that fails them is invalid.

### Sensor streams (v1.1)

All five are optional and additive: a v1 reader ignores streams it does not know, and a bundle without them stays valid. Every stream is an artifact (`application/json`) with a stream descriptor in the manifest; none is inline, because the sample counts below would bloat the manifest. All numbers are finite. Every sample list is in time order. Bounds are enforced by the schemas; a provider that reaches a bound stops recording that stream and adds the warning `<kind>-truncated` to `metadata.warnings` instead of dropping data silently.

| Stream | Clock | Units | Rate and bound |
|---|---|---|---|
| `device-orientation` | `device` (ns) | `q` is a unit quaternion `[x, y, z, w]` (Hamilton) rotating device axes into the Android east-north-up frame (+X east, +Y magnetic north, +Z up), from `TYPE_ROTATION_VECTOR`. `headingAccuracyDeg` is the sensor's estimated heading accuracy in degrees, or null when it reports none. | At most 50 Hz, at most 36,000 samples. `timestamp` is the sensor event timestamp in nanoseconds. |
| `heading` | `device` (ns) | Angles in degrees in [0, 360), clockwise seen from above. `azimuthMagneticDeg` is the compass bearing of the camera's forward direction relative to magnetic north; `azimuthTrueDeg` is that bearing plus `declinationDeg`; both are null unless a location fix gave a declination. `magnetometerAccuracy` is the Android accuracy status 0 (unreliable) to 3 (high). `headingAccuracyDeg` as above. `worldBearingDeg` is the bearing of the same direction in the ARCore world frame, clockwise from world -Z seen from above (0 at -Z, 90 at +X). | At most 5 Hz, at most 6,000 samples. Written only while ARCore tracks and the camera looks within 60 degrees of the horizontal, because a near-vertical view has no stable bearing. |
| `geolocation` | `wall` (ms) | `latitude` and `longitude` in degrees (WGS 84), `altitudeM` metres or null, `accuracyM` horizontal accuracy in metres, `provider` one of `gps`, `network`, `fused`, `passive`, `unknown`. | At most 60 fixes, at least 10 s apart. |
| `light-estimate` | `device` (ns) | `mode` is `ambient-intensity` or `environmental-hdr`. `state` is `valid` or `invalid` (ARCore could not estimate; the other fields are then null). In `ambient-intensity` mode `pixelIntensity` is the average pixel intensity in [0, 1] and `colorCorrection` is `[r, g, b, gamma]`; the main-light fields are null. In `environmental-hdr` mode `mainLightDirection` is a unit vector in the ARCore world frame and `mainLightIntensity` an `[r, g, b]` linear radiance; the ambient fields are null. These are estimates, not lux. The sign convention of `mainLightDirection` follows ARCore and is not yet checked on a device. | At most one entry per RGB keyframe (`keyframeId`, `timestamp` equal to that keyframe's), so at most 300. |
| `barometer` | `device` (ns) | `hPa` is air pressure in hectopascals, 300 to 1100. Consumers derive relative height from pressure differences; absolute altitude is not claimed. | At most 2 Hz, at most 4,000 samples. |

Stream descriptor `metadata`: `device-orientation` and `heading` carry `{ source: "rotation-vector", timestampSource: "realtime" | "unknown" }`. `realtime` means the camera reports timestamps on the same boot-time clock as sensor events (Camera2 `SENSOR_INFO_TIMESTAMP_SOURCE`), so sensor and ARCore frame timestamps can be compared directly; `unknown` means the offset between the two clocks is not known and consumers must not align them below about 100 ms.

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
}
```

Derivation: for each `heading` sample the north estimate is `worldBearingDeg - azimuth` (true azimuth when a declination is known, magnetic otherwise), wrapped to (-180, 180]. Only samples with `magnetometerAccuracy` of at least 2 (medium) and, where reported, `headingAccuracyDeg` of at most 25 are used. The result is the circular median of those estimates. With no location fix there is no declination, so `reference` is `magnetic` and `method` is `compass-median-magnetic`: it points to magnetic north, which differs from true north by the local declination (up to about 20 degrees in parts of Asia). Indoor steel and wiring can bend the field by tens of degrees; `spreadDeg` and `confidence` show it. The value is an estimate to be confirmed by the user before it sets a site `northRotation` (ROADMAP P3b); it never changes geometry.

#### Privacy

- Location is off by default, requested per capture, and only the approximate location permission is asked for: the sun position and declination need kilometres, not metres.
- A bundle with `geolocation` identifies a place. Treat it as personal data: no public artifacts, coarsen (about 1 km) before a scene is shared or the data goes to an external service, and do not send it to an external AI without explicit consent. The wall clock timestamps tie it to a moment.
- The other four streams contain no identifiers. `heading.declinationDeg` reveals the region only coarsely and is null when location is off.

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

Scan-to-scene (ROADMAP P3b) reads `plane-set`, `point-cloud` and `manual-measurements` to propose wall, slab and ceiling nodes for human review. Agent read tools for scan bundles (P4a) expose manifest summaries, measurements and bounded keyframe images to MCP clients.
