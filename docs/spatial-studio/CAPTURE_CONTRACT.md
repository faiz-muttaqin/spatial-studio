# Capture contract: providers, scan bundle and Android bridge

Status: contract v1, proposed 2026-11-25. Shared by the web `/scan` route (`apps/editor`) and the Android companion (`apps/android`). Change it in its own commit before changing either side. Nothing here is implemented until STATUS.md records evidence.

## Providers

| Provider id | Where | What it can claim |
|---|---|---|
| `browser-photo` | Any secure-context browser | Photos plus manually entered dimensions. No measured depth or pose. |
| `webxr` | Chrome Android with `immersive-ar` | Pose, hit-test, optional depth-sensing and camera-access, each negotiated individually. |
| `android-arcore` | Android companion app, native scan screen | ARCore pose, planes, point cloud, optional depth16 and RGB keyframes with intrinsics, plus device sensors. |

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
| `device-capabilities` | `capabilities` | inline | `{ probedAt (unix ms), browser: BrowserCapabilities | null, native: capabilities.get result | null }`. `browser` reports secure context, camera, WebXR `immersive-ar` (`supported`, `unsupported` or `unknown`; optional features stay `unknown` because they are only negotiated at session start), and orientation and motion permission state. |

`metadata` on the manifest: `{ provider, appVersion, bridgeVersion?, device: { manufacturer, model, os } (each nullable), createdAt (ISO 8601), trackingLossCount, warnings: string[] }`.

The payload schemas live in `packages/core/src/capture/streams.ts` (exported from `@pascal-app/core/capture`); a bundle that fails them is invalid.

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

Error codes: `forbidden`, `invalid_request`, `unknown_method`, `unsupported`, `permission_denied`, `busy`, `not_found`, `upload_failed`, `internal`.

### Methods

| Method | Params | Result |
|---|---|---|
| `bridge.hello` | none | `{ bridgeVersion: 1, appVersion, platform: "android", methods: string[] }` |
| `capabilities.get` | none | `{ arcore: { availability, depth: boolean, rawDepth: boolean }, cameras: [{ id, facing, focalLengths, intrinsics, depthOutput, logicalMultiCamera, physicalIds }], sensors: { accelerometer, gyroscope, rotationVector, magnetometer, barometer, ... }, device: { manufacturer, model, sdkInt, webViewVersion } }` |
| `scan.start` | `{ projectId?, options?: { depth?: boolean, keyframeSpacingM?: number, maxKeyframes?: number } }` | `{ sessionId }`, then `scan.state` and `scan.progress` events while the native scan screen runs |
| `scan.list` | none | `[{ sessionId, createdAt, state, keyframes, bytes, uploaded }]` |
| `scan.upload` | `{ sessionId }` | `{ sessionId, manifestUrl, manifestSha256 }` after every artifact and the manifest are stored; `upload.progress` events meanwhile |
| `scan.discard` | `{ sessionId }` | `{ sessionId }` |

### Upload and security rules

- The native side uploads with `PUT /api/artifacts/{sha256}` to the same allowlisted origin that sent `scan.upload`, using that origin's cookie from `CookieManager` and an `Origin` header for it. It never sends cookies anywhere else, never logs them, and never accepts a target URL from the page.
- Camera: the WebView grants only `RESOURCE_VIDEO_CAPTURE`, only to an allowlisted origin, and only when the app already holds `CAMERA`. Everything else is denied by omission.
- Top-level navigation: HTTPS and allowlisted host only; other links open in the system browser. No mixed content, no cleartext except the debug local origin.
- Scans live in app-private storage until uploaded or discarded. No background recording; the scan screen stops the camera on pause.
- The page treats the bridge as optional: when `window.SpatialStudioNative` is absent, `/scan` offers WebXR or browser-photo instead.

## Next stage (not part of v1)

Scan-to-scene (ROADMAP P3b) reads `plane-set`, `point-cloud` and `manual-measurements` to propose wall, slab and ceiling nodes for human review. Agent read tools for scan bundles (P4a) expose manifest summaries, measurements and bounded keyframe images to MCP clients.
