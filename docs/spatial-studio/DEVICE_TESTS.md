# Device test log

Real-device evidence only. No captured images, locations or other private capture content in Git; summaries and numbers only.

## 2026-11-25: first Android companion scan (P2N v1)

- Device: Samsung SM-S937B, Android 17 (API 37), Google Play Services for AR 1.57, Android System WebView 157.
- Build: `apps/android` debug APK from `main` at `678c672` (`./gradlew :app:assembleDebug`, local JDK 21).
- Server: `main` at `678c672` run locally with `bun run dev` in a clean worktree (no `.env`, open loopback mode, scratch `PASCAL_DATA_DIR`), reached from the phone through `adb reverse` on the app's debug origin `http://localhost:3002`. The deployed site was not used because it still served `96de268`.
- `/scan` inside the app: bridge connected (`app 0.1.0-debug, bridge v1`), ARCore `supported_installed`, ARCore depth supported, WebXR `immersive-ar` not supported in the WebView (expected), orientation and motion sensors allowed.
- Scan: native ARCore screen started from `/scan`, owner walked an indoor space with glass and polished surfaces. 163.6 s, 1,632 trajectory samples, one segment, 42.7 m path, no tracking loss, 240 keyframes (all `tracking`), 69.7 MB.
- Upload: 720 artifacts plus indexes and manifest, paced at about 90 requests a minute. The app was replaced mid-upload by another debug build (a coordination slip, not a user action); after reinstalling, `scan.upload` resumed from the 317 stored artifacts and finished. The scan was attached to a new project through the web attach path.
- Validation against `@pascal-app/core/capture` schemas: manifest V2, metadata (`camera: opengl, image-readout, sensorOrientationDeg 90`), trajectory, rgb and depth indexes, point cloud and capabilities all parse. Sample keyframe JPEG 1920x1080 matches its index entry, intrinsics fx 1252, fy 1254, cx 965, cy 538, and its SHA-256 matches. Sample depth frame 160x90, 28,800 bytes, median 2.34 m (p5 1.67 m, p95 4.28 m). Artifacts were served with `image/jpeg` and `application/json` types.

Findings:

- No ARCore planes at all (`no-planes-detected`), so no `plane-set` stream. Plausibly the glass and reflective surfaces; to be re-tested in an ordinary room.
- Point cloud: 40,391 points, of which 28% lie more than 6 m from the walked path (p99 78 m, max 114 m), consistent with features seen through glass or in reflections. Acquisition-time distance and confidence filtering is being added, and consumers must use robust bounds.
- The scan HUD reads "Starting camera…" until tracking starts; it should prompt the user to move the phone.
- Upload time for a full scan with depth is about 10 to 11 minutes at the current pacing.

Not yet tested on a device: the deployed site, a sign-in through the app, planes, P2N.2 sensors, and drawing the capture in the editor.
