# Mobile architecture — same repository, browser first

The owner requested single-repo mobile maintenance and a possible WebView wrapper for deeper hardware access. Keep the existing Next.js host and a lightweight mobile scanner route (proposed /scan, not implemented). Do not fork the editor UI or scene graph. Native companion is a conditional enhancement, not required for P1–P4.

## Provider ladder
- Browser Chrome Android: negotiate immersive-ar, hit-test, pose, depth and optional raw camera access individually. On unsupported devices use MediaDevices photos + manual corner/measurement workflow; do not pretend it is automatic metric scanning. Mobile scanner should not load the entire desktop editor.
- PWA / installed web shortcut: same browser pipeline; cache UI and draft data, not sensitive images by default. HTTPS and real device testing.
- Optional Android companion: evaluate Capacitor shell with Kotlin native plugin or small Kotlin app launching native scan screen. WebView handles existing web UI; native ARCore/Camera2/SensorManager handle camera/pose/depth where supported. Android System WebView does not generally offer immersive WebXR; never assume wrapping grants ARCore, stereo or CSI. Offer Chrome handoff or native scan screen. Evaluate native iOS/RoomPlan later only if needed.
- Same manifest V2 and artifact API for all providers. Native bridge sends capability/session/status/metadata, not unbounded video base64 through JS. Stream/upload bounded binary chunks through authorized API or files, normalize units/coordinate transforms/timestamps and resume. Avoid simultaneous ownership of camera; explicit stop and permission revocation handling.

## Proposed layout
    apps/editor/                  existing web host + scanner route
    packages/core/src/capture/    existing V2 contract
    packages/viewer/src/capture/  existing reference runtime
    packages/scan-core/           proposed browser acquisition/normalization if needed
    packages/scan-geometry/       proposed worker-friendly algorithms if needed
    apps/mobile/                  optional Capacitor/Kotlin Android shell, isolated build

No directory is created by this plan. Prefer adding code to existing package owners until a real boundary warrants a new package. Mobile Gradle/SDK/CI independent from web build; no Android toolchain requirement for VM or web contributors. Start with native capability probe only after P2 browser evaluation, and develop native provider if browser gaps justify it. Compare native ARCore vs Chrome on same measured room before promoting to required path.

## Bridge security
Only trusted HTTPS origin or bundled assets; strict allowlist (no wildcard), reject arbitrary redirects/iframes, origin-aware WebView messaging, schema and size validation, narrow capability allowlist, no generic JavaScript-to-native execution, explicit camera consent, no background recording. Never grant all permission requests or disable TLS checks. Keep credentials in appropriate platform storage and never log scans/tokens. Avoid sending raw frames to external AI without explicit consent.

## References
- [Google WebXR requirements](https://developers.google.com/ar/develop/webxr/requirements)
- [Android native bridge guidance](https://developer.android.com/develop/ui/views/layout/webapps/native-api-access-jsbridge)
- [Google three-live XR runtime notes](https://github.com/google/three-live/blob/main/docs/xr-live.md)

Caddy is the optional HTTPS reverse proxy on VM, distinct from the native mobile shell. It does not expand browser hardware permissions.
