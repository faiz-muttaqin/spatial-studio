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
