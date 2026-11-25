# Roadmap — P1–P4 required, P5–P6 optional

## P1 — foundation & editable space
- P1.0 Pin fork base, check dependency/asset licenses, Actions and upstream publish guards; install locked Bun and supported Node, run build/CI and VM smoke. Baseline failures documented, never mask.
- P1.1 Make one fixture room with dimensions, walls/slab/ceiling, doors/windows, lamps/furniture; verify 2D/3D, materials, save/load/export/undo. Run actual local MCP reads and edits; inventory tools/checkpoints. Audit existing WebXR plugin, capture layers and mobile renderer; distinguish immersive preview from room capture.
- P1.2 Define coordinate conventions, V2 provider contract, baseline/variant/lock authority, fixture strategy. Gate: fork runs, manual room round-trip, agent edits disposable scene, phone HTTPS test or explicit blocker.

## P2 — mobile browser capture
- P2.1 Lightweight same-origin scanner route, device capability probe, permissions, capture lifecycle, mobile fallback UX.
- P2.2 WebXR pose/depth where supported, optional synchronized RGB if allowed, otherwise separate photos; manual corner/dimension/opening/lamp marking. Bounded V2 evidence artifacts and reference layer preview; record tracking loss and confidence.
- P2.3 Import/export scan bundle, authenticated transfer to desktop, actual Android test and manual fallback. Gate: real room capture and photos + manual dimensions fallback both persisted. Browser-only is required; native companion conditional, same repo. P2N (active, owner priority): Android companion in `apps/android` with native ARCore capture (pose, planes, point cloud, depth, intrinsics, sensors) producing the same bundle as the browser ([CAPTURE_CONTRACT.md](CAPTURE_CONTRACT.md)); compare against Chrome WebXR on the same measured room; never a dependency for web deployment. P2N.2 adds orientation, true-north heading, opt-in geolocation, light estimate and barometer to the bundle; P2N.3 spikes live telemetry (bridge events vs a loopback WebSocket). See [SENSING_RESEARCH.md](SENSING_RESEARCH.md).
- No automatic RGB-only AI reconstruction in MVP; explicitly assisted workflow.

## P3 — recreate space
- P3a: baseline/variant persistence, revision checks and granular locks on common authority; test UI/CLI/MCP, batch/import/parent/delete/restore bypass paths, rollback and concurrency. Can start after P1.
- P3b: plane fit, polygons, nonorthogonal walls, dimension correction, opening and fixture review, finish color and photo texture assignment, canonical scene import. Draft capture phase: every recorded signal stays as evidence, the agent proposes elements with their evidence and confidence, the user verifies each before it enters the baseline. Site latitude, longitude and true north from a capture (user-confirmed) drive the existing daylight sun position for the capture date. Preserve evidence and uncertain attributes.
- P3c: two connected rooms with common frame or manually aligned doorway anchors; validate heights/adjacency/closed boundaries. Multi-floor P5. Gate: as-built editable, evidence survives, ground-truth measurements reported. Unknown thickness/substrate/roof not fabricated.

## P4 — AI redesign and MVP release
- P4a: audit MCP and CLI contracts/skills; add missing read/permission/variant/measurement tools, safe typed writes once P3a authority exists. Reuse agent operations and renderer.
- P4b: extend skills for spatial inspection, interior layout, material/light preview, relational furniture placement, collision/clearance/door access and rendering review. No model training.
- P4c: agent reads scan-derived scene, creates two variants, places/moves furniture, changes permitted finishes, checks/iterates/renders/saves. User manually edits variant; original baseline and locked properties unchanged. Local MCP first; authenticated remote later if verified. Gate: replayable demo, zero unauthorized mutations and verified round-trip, no cost engine.

## P5 — optional advanced reconstruction
Multi-view AI (MapAnything or alternatives), metric scale checks, automatic openings/object/material recognition, advanced texture projection, registration/loop closure, multi-floor and optional native providers where needed. GPU separately profiled; license weights. No automatic inferred data treated as measured.

## P6 — optional advanced simulation
Daylight preview, quantitative Radiance if justified, complex roofs, performance profiling and WASM/WebGPU only if measured bottleneck. Visual lighting not lux. Costing remains out of scope.

## Parallel work
P1 -> P2, P3a, P4a(read only). P2 -> P3b; P3a + P3b -> P3c; P3 + P4a -> P4b/c. P2N runs in parallel with P2.1 on the shared contract, not blocking web. P5/P6 after MVP. Separate downstream PRs, keep shared contracts stable. Integrator handles schema/merge and updates STATUS. Never merge unverified code.

## Tests and targets
Use upstream bun run ci (check, i18n, skills, types, tests, build, render bundle, smoke), focused tests and real-device acceptance. Synthetic rooms rectangle, L, oblique, occlusion/blank walls, openings, connected rooms and varying ceiling. Private real captures stay outside Git. Proposed targets only: simple-room wall lengths <=5% raw and <=2% after measured correction, ceiling/opening error <=10cm, valid closed boundaries, zero locked edits, unchanged baseline, semantic save/load and deterministic undo, no mandatory GPU. Record device/OS/browser, sample counts, failed cases and raw vs corrected accuracy.
