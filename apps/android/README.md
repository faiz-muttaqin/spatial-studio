# Spatial Studio Android companion

A Kotlin WebView shell that loads the deployed studio and adds a native ARCore scan screen. The web app talks to it through the bridge in [CAPTURE_CONTRACT.md](../../docs/spatial-studio/CAPTURE_CONTRACT.md) (protocol v1). Scans are written as Capture Manifest V2 bundles and uploaded to the studio's artifact store.

This is an isolated Gradle project. Web contributors and the VM never need the Android toolchain; `bun install` and turbo ignore this folder (it has no `package.json`), and `.dockerignore` keeps it out of the image.

## Build

Requirements: JDK 17 or newer (21 tested), Android SDK with platform 35. Point Gradle at the SDK with `ANDROID_HOME` or a git-ignored `local.properties`:

```bash
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties
```

Unit tests, lint and the debug APK:

```bash
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

The APK is `app/build/outputs/apk/debug/app-debug.apk` (application id `com.faizmuttaqin.spatialstudio.debug`). CI (`.github/workflows/android.yml`) runs the same tasks on changes under `apps/android/` and uploads the debug APK as a workflow artifact. There is no release signing or store publishing.

## Install and run

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

```bash
adb shell am start -n com.faizmuttaqin.spatialstudio.debug/com.faizmuttaqin.spatialstudio.MainActivity
```

Sign in to the studio inside the app before uploading: uploads use the WebView's session cookie for the studio origin.

Scanning needs a phone with [Google Play Services for AR](https://developers.google.com/ar/devices); the app installs on other phones and reports ARCore as unavailable. Depth is recorded only where ARCore supports the Depth API.

## Configure the origin

The studio origin is a Gradle property, default `https://spatial-studio.faizmuttaqin.com`:

```bash
./gradlew -PstudioOrigin=https://studio.example.com :app:assembleDebug
```

Debug builds also trust `devOrigin` (default `http://localhost:3002`). It must be `localhost`, `127.0.0.1` or the emulator alias `10.0.2.2`; the build fails otherwise, and release builds never trust it. To use a local `bun dev` server from a phone:

```bash
adb reverse tcp:3002 tcp:3002
```

```bash
adb shell am start -n com.faizmuttaqin.spatialstudio.debug/com.faizmuttaqin.spatialstudio.MainActivity -d http://localhost:3002/
```

A launch URL is honoured only when it is on a trusted origin.

## Upload time

The studio allows 120 API requests a minute per client, and every artifact is one request. The app paces uploads at about 90 requests a minute to leave the page some headroom, waits for `Retry-After` on a 429, and records each stored artifact in the scan folder, so an interrupted upload resumes where it stopped instead of starting again.

Estimate (not measured on a device yet): a 300-keyframe scan with raw depth is about 905 requests (300 JPEGs, 300 depth frames, 300 confidence frames, 4 JSON files, the manifest). Pacing alone makes that about 10 minutes. The JPEGs are roughly 50 to 200 MB depending on the camera image size, which takes 1 to 3 minutes at 10 Mbit/s and overlaps with the pacing; on a slower connection the transfer time dominates. Smaller scans scale down roughly in proportion.

## Saving and failures

If saving a finished scan fails (for example the disk is full), the scan is kept with state `failed` and the reason in `scan.list` (`error`), and the page can discard it. Scans left in `recording` because the app was killed are removed after 24 hours. A scan start that never reaches the scan screen (for example because the app was sent to the background) is released after 10 seconds with a `failed` event, so the next `scan.start` is not refused as busy.

## Security and privacy

- One allowlist (`AppConfig.allowlist`) drives top-level navigation, the bridge's origin rules, camera grants and the upload target, so they cannot drift apart.
- Top-level navigation stays on HTTPS trusted origins; other web links open in the system browser and other schemes are blocked. Cleartext is off except for the loopback debug hosts (`src/debug/res/xml/network_security_config.xml`). WebView debugging is on only in debug builds.
- The bridge uses `WebViewCompat.addWebMessageListener` (object `SpatialStudioNative`), re-checks the origin and `isMainFrame` on every message, rejects messages over 64 KiB, and offers only the six contract methods. There is no `addJavascriptInterface` and no generic file, URL or intent access.
- The WebView gets the camera only for video capture, only for a trusted origin, and only after the app holds `CAMERA`. Everything else is denied.
- Scans live in app-private storage (`files/scans/<sessionId>`) until uploaded or discarded. Backup and device transfer are disabled. The scan screen stops the camera when paused; there is no background capture. Cancelling or leaving the scan screen discards the partial scan.
- Uploads go only to the trusted origin that sent `scan.upload`, with that origin's cookie and a matching `Origin` header. Redirects are not followed, cookies are never logged, and the page cannot choose the target URL.

## Layout

| Path | What |
|---|---|
| `security/` | Origin allowlist, WebView permission policy |
| `bridge/` | Protocol v1 parsing and envelopes (`BridgeProtocol`), WebView glue (`NativeBridge`) |
| `capabilities/` | `capabilities.get`: ARCore, Camera2, sensors, device and WebView versions |
| `scan/` | Scan screen, ARCore recorder, keyframe and trajectory logic, voxel downsampling, bundle and manifest writer, local store |
| `scan/gl/` | Camera background and feature-point overlay (GLES 2) |
| `upload/` | Content-addressed uploader with retry and rate-limit handling |

Pure logic has JVM unit tests under `app/src/test`. Set `SCAN_BUNDLE_FIXTURE_DIR` when running `ScanBundleWriterTest` to keep a synthetic bundle for checking against the TypeScript capture schemas.
