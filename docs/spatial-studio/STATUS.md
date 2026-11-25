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

### 2026-11-25: P2.1 web `/scan` route (branch `fix/p2-web-scan-route-9d7653`)

- Base `692c031`. The contract change is its own commit: index artifacts wrap entries (`{ frames }`, `{ planes }`), `trackingState` is `tracking | paused | stopped | none`, `device-capabilities` is `{ probedAt, browser, native }`.
- Core: `packages/core/src/capture/streams.ts`, Zod schemas for the keyframe index, depth index, plane set, manual measurements, capabilities and manifest metadata, exported from `@pascal-app/core/capture`. No three import.
- App: `/scan` with a capability probe, a browser-photo provider (JPEG at most 1920 px long edge, EXIF dropped by re-encoding, SHA-256 with WebCrypto, `PUT /api/artifacts/{sha256}` for each artifact, then the manifest), a measurements form, and a typed bridge v1 client (request ids, timeouts, error codes, events). Attach goes through the scene API: `POST /api/scenes` for a new project, or `GET` then `PUT /api/scenes/{id}` with `If-Match` (re-read and retry on 409). `embed`, `import` and `project` moved into an `app/(studio)` route group whose layout loads the node registry and plugins, so `/scan`, `/login`, `/setup`, `/settings` and `/` no longer download the editor.
- Commands, local macOS, Bun 1.4.4: `bun run check` exit 0 (169 warnings and 19 infos repo-wide, none in the 32 touched files); `bun run i18n:check` exit 0 (83 new `app.scan.*` messages, zh-CN, fr, es and ja drafts are `fuzzy` + `Review: required`); `check-types` exit 0 for `packages/core`, `packages/editor` and `apps/editor`; `bun test` passes for core `src/capture` (31), `apps/editor` `lib` (123, 41 new in `lib/scan`), `apps/editor/proxy.test.ts` (12), `packages/editor` `src/i18n` (5) and the i18n script tests (70); `apps/editor` `next build` exit 0.
- Browser run: in-app Chromium with 375x812 mobile emulation, `bun dev` on port 3012, loopback (open) auth, `PASCAL_DATA_DIR` in a scratch folder. The probe showed a secure context, 1 camera, WebXR `immersive-ar` not supported, orientation and motion denied, and no companion. Three synthetic 4032x3024 canvas JPEGs plus measurements: 6 artifact PUTs returned 200 and `POST /api/scenes` returned 201; the manifest, keyframe index and measurements read back and the image hash matched; the editor Scene panel lists the scan under Ground floor. Attaching to the existing project: `PUT /api/scenes/{id}` 200, version 1 to 2. Native flow with a fake `SpatialStudioNative` injected into the page (no device): hello, capabilities, start, events, upload and attach (version 3).
- Bundle, production `next start`, resource timing: `/scan` loads 13 scripts, 418 KB compressed (1.6 MB decoded), with no three, viewer, editor or node-schema code; `/login` 321 KB; `/project/{id}` 158 scripts, 7.4 MB. The node schemas load only when a scan is attached.
- Not verified: a real phone over HTTPS, a real camera capture (the run used synthetic images through the file input), the companion app, the password-gated deployment (covered by `proxy.test.ts` only), and `bun run ci` end to end.
- Known gaps: artifact GET still answers `text/plain` (media-type branch in progress); `CaptureRuntime` is not mounted in the editor, so a capture-session scan is a reference entry with nothing drawn in 3D (browser-photo bundles have no 3D streams); the root layout ships the `agentation` dev tool to every production page (pre-existing).
- Next: phone run on the deployment after merge, then P2.2 (WebXR capture session).
