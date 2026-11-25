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

## 2026-11-25: second scan (local server) and live-site scan (P2N.2 fix build)

- Build: `apps/android` debug APK from the P2N.2 branch, first at `a9baf89` (second scan) and then at `39c81e4` with the plane and heading fixes (live scan). Same phone.
- Second scan, uploaded to the local server: 101 s, 17.6 m, 107 keyframes, one tracking loss; point cloud 11,204 points within y -2.4 to 4.7 m (acquisition filtering works). Still no planes and no true north, which led to the fixes below. Location was recorded; the code only starts it when `scan.start` asks for it or the scan-screen toggle is ticked, and this `/scan` page never asks.
- Root causes found: the once-a-second plane snapshot never ran (timestamp overflow against a `Long.MIN_VALUE` sentinel, which also froze the HUD on "Starting camera…"), and heading samples were paired with the newest compass reading instead of the one nearest the frame time, so all were rejected.
- Live-site scan with `39c81e4`, signed in inside the app on https://spatial-studio.faizmuttaqin.com, uploaded and attached to a new project there:
  - 56.3 s, 17.7 m path, 87 keyframes, no tracking loss, no warnings.
  - Planes: 28 in total, 20 active (15 upward, 5 downward, 0 vertical). Largest floor plane 24.6 m², largest ceiling plane 19.1 m², about 4.2 m apart.
  - True north: confidence 0.93 from 277 samples, spread 1.2 degrees, segments agree, declination applied from opt-in location.
  - Point cloud: 17,907 points, 2nd to 98th percentile height span 4.6 m.
- Open: no vertical planes on plain or glass walls; the live MCP scan tools were not yet deployed at the time of the scan.
