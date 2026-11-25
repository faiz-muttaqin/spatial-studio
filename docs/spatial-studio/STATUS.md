# Development status and handoff

2026-11-25: owner created public fork faiz-muttaqin/spatial-studio. Connector verified push/admin access; main matched upstream reference d7d0b436f2bda4bfb38fa3d083c1d1816ec7481c. Documentation initial commit targets main, as explicitly permitted. Root upstream instructions retained with downstream pointer. Source inspection and VM/mobile plan recorded. No runtime changes, no build, no actual camera/MCP test, no deployment and no CI pass claimed. Review this commit via Git history; no fabricated self-referential SHA.

| Phase | State | Next / blocker |
|---|---|---|
| P1 | In progress | P1.0 merged (#1). Deployed at https://spatial-studio.faizmuttaqin.com (owner VM, auto-deploys `main`). Remaining: license inventory, MCP self-host test, CI runs on the fork |
| P2 | In progress | Contract v1 in CAPTURE_CONTRACT.md; web `/scan` route (probe, browser-photo fallback, attach scan node) |
| P2N | In progress (owner priority) | Android companion `apps/android`: WebView shell, bridge v1, capability probe, native ARCore scan; needs a real device |
| P3 | Planned | Capture and mutation authority contracts |
| P4 | Planned | P3a protection + scene reconstruction |
| P5/P6 | Deferred | Optional after MVP |

Next actionable work: P1.0 PR for fork release/registry guard and CI hygiene (do not weaken checks), then locked build and VM/device smoke following DEPLOYMENT.md. Owner deploys VM; record domain only if intentionally public, no secrets. If build fails, capture logs and fix baseline separately. Inspect actual WebXR plugin before duplicate scanner. No mandatory native or GPU service. For each session update date / phase / branch / PR / base SHA / files / commands + actual results / device evidence / blockers / next task.

### P1.0 fork publishing guards: merged as #1 (2026-11-25)

Branch `p1/fork-publishing-guards` from `96de268`. Guard release, registry publish/hosted checks and legacy deprecation; normal CI untouched. Source-level checks only; YAML re-parsed before merge and every guarded job confirmed. No GitHub Actions run was created for the PR, so CI on the fork is still unverified. See [P1_FORK_SAFETY.md](P1_FORK_SAFETY.md). VM deployment handled in parallel by another agent. No runtime modifications.

### 2026-11-25: links, contract and parallel split

- Base `96194a9` (main after #1). Fork-facing links (settings source link, README banner, CONTRIBUTING, SECURITY, issue template, `open-pr` skill) now target `faiz-muttaqin/spatial-studio`; upstream docs, npm, hosted MCP and attribution links unchanged. `gh repo set-default` pinned locally because `gh` defaults to the upstream parent in a fork.
- Added [CAPTURE_CONTRACT.md](CAPTURE_CONTRACT.md): providers, scan bundle on Capture V2 + artifact store, Android bridge protocol v1. Promoted P2N to active.
- Checks run: `biome check` on the edited TSX, `bun scripts/validate-skills.ts` (pass). No build or device test in this step.
- Parallel work, each on its own branch and PR: Android companion (`apps/android`), web `/scan` route (`apps/editor/app/scan`), artifact media types (`apps/editor/app/api/artifacts`). Integrator (main session) reviews, merges and updates this file.

### 2026-11-25: P2N Android companion (branch `fix/p2n-android-companion-fb3f32`)

- Base `692c031`. New isolated Gradle project [apps/android](../../apps/android/README.md): WebView shell, bridge protocol v1, capability probe, native ARCore scan screen, bundle writer and uploader per [CAPTURE_CONTRACT.md](CAPTURE_CONTRACT.md). AGP 8.8.2, Kotlin 2.0.21, Gradle 8.10.2 wrapper (jar checksum matches Gradle's published one), compile/target SDK 35, min SDK 24, ARCore 1.57.0. Added `.github/workflows/android.yml` (paths `apps/android/**`: unit tests, lint, debug APK artifact; no signing, no publishing) and `apps/android` to `.dockerignore`.
- Local commands (macOS, JDK 21): `./gradlew clean :app:testDebugUnitTest :app:assembleDebug` passed, 68 JVM tests, 0 failures, debug APK 3.3 MB. `./gradlew :app:lintDebug`: 0 errors, 17 warnings (newer dependency versions, portrait-locked scan screen, button styles). `bun install --frozen-lockfile`: exit 0, lockfile unchanged. `turbo ls`: 14 packages, none from `apps/android`. `turbo run check-types --dry=json`: exit 0.
- Schema check: a synthetic bundle from `ScanBundleWriterTest` parses with `CaptureSessionManifestV2Schema`, `normalizeCaptureSessionManifest`, `DeviceMotionTrajectorySchema` and `PointCloudPayloadSchema`, and with the web branch's work-in-progress keyframe, depth, plane, capabilities and metadata schemas.
- Emulator (local API 36 arm64 Google APIs image, WebView 133, no Play Store), page driven over WebView DevTools on the deployed origin: bridge injected; `bridge.hello`, `capabilities.get` and `scan.list` replied; unknown method, wrong version, bad session id, missing scan, out-of-range options and a 70 KB message were rejected with contract error codes. `scan.start` opened the scan screen; denying the camera gave `scan.state` `failed` / `permission_denied`; with the camera granted, ARCore could not be installed and the result was `failed` / `unsupported`; no partial scan was left on disk. WebView `getUserMedia`: video denied before the Android camera permission and granted after it; audio denied. An external link opened in Chrome and a cross-origin form POST left the WebView on the studio origin. The real `capabilities.get` output passes the web branch's `NativeCapabilitiesSchema`.
- Upload end to end: debug dev origin `http://localhost:3002` through `adb reverse` to a local `apps/editor` dev server in password mode (throwaway test password, scratch data directory), synthetic bundle placed in app storage. Signed out: one 401 and `upload_failed`. After signing in inside the WebView: 9 PUTs returned 200 with the manifest last, the server's copy of the manifest was byte-identical, and `scan.list` showed `uploaded` with the `manifestUrl`. Concurrent `scan.upload` and `scan.discard` during an upload returned `busy`.
- Not tested: anything that needs ARCore on a real phone (no device was connected; the owner is preparing one): camera background, tracking, keyframe JPEG and depth capture, planes, point cloud, finalizing a real scan, and uploading a real scan to the deployed site. Also not tested: the `Origin` header on the wire (unit tests only), Android 7 to 9, and the Android workflow on GitHub.
- Next: install the CI APK on the owner's phone, scan a room, upload from the deployed site and open the bundle in the web viewer.
