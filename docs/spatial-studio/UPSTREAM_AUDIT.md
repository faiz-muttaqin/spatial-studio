# Upstream audit and reuse map

Source inspection 2026-11-25; fork main and upstream reference matched d7d0b436f2bda4bfb38fa3d083c1d1816ec7481c. Some upstream files were read from main rather than the pinned SHA; recheck at implementation. Root MIT LICENSE (Copyright (c) 2026 Pascal Group Inc.) verified; not a blanket license for third-party assets.

| Existing surface | Source | Decision |
|---|---|---|
| Node schemas, flat ID-keyed scene, registry, IndexedDB, Zundo | [Architecture](https://github.com/pascalorg/editor/blob/d7d0b436f2bda4bfb38fa3d083c1d1816ec7481c/docs/architecture.md) | Reuse; no parallel model |
| Building/level/wall/slab/ceiling/roof/zone/item, openings, materials, 2D and 3D | packages/core, packages/nodes, packages/editor, packages/viewer | Reuse; verify actual UI/exports |
| Capture V2 manifest: clocks, frames, streams, artifact refs; point cloud and mesh payload | [schema](https://github.com/pascalorg/editor/blob/d7d0b436f2bda4bfb38fa3d083c1d1816ec7481c/packages/core/src/capture/schema.ts) | Produce/adapt to V2; no duplicate wire protocol |
| Capture runtime, trajectory, point cloud, room model and mesh layers | packages/viewer/src/capture | Reuse reference visualization |
| @react-three/xr and pinned @webxr/plugin | apps/editor/package.json | Audit plugin capabilities before new scanner; pinned 9cd90457fc823d5d633d38e9575856c854aeb4d4 LICENSE MIT, README returned 404; room/depth capture unverified |
| furnishRoom, placeItems, placeInRoom, createRoom, moveNode, paint, setCheckpoint, verifyScene, layout-clearance | packages/core/src/agent-operations | Reuse shared operations; inspect contracts and checkpoints before extending |
| Agent parity and shared core operation | wiki/architecture/agent-surfaces.md | All surfaces use same authority |
| pascal-3d and furniture-fit | skills/ | Extend evidence-based skills, not recreate |
| CLI/MCP, SQLite, auth, scene/artifact API, public embeds | SETUP.md, packages/mcp, packages/cli | Reuse; verify actual self-host MCP surface and access |
| Bun 1.4.4, Node ^22.23.4 / ^24.22.1 / >=26.12.1, React 19.3.1, Next 16.4.6, Three 0.187.0, R3F 9.8.2, Turbo, Biome | package.json | Keep lockfile; no stack migration |

## Remaining gaps
Browser acquisition, automatic scan-to-semantic-scene, evidence provenance, granular locks, immutable as-built and variants need actual source/runtime gap analysis. Do not equate scan reference rendering with automatic reconstruction. Assess actual checkpoint, duplicate, mutation and storage semantics before writing new code.

## Other repositories — candidates, not dependencies
- [OpenPlan3D](https://github.com/laanlabs/openPlan3D): UX/editor reference, not a second editor.
- [Plan3D](https://github.com/apiel/plan3d): browser scanner ideas only; license not established, no source copying until permission.
- [Mesh2Plan](https://github.com/theLodgeBots/mesh2plan): extraction algorithms; README license claim must be verified per file.
- [Open3D](https://github.com/isl-org/Open3D): optional benchmarking or Python geometry.
- [MapAnything](https://github.com/facebookresearch/map-anything): P5; separate code and model-weight license audit.
- [InteriorAgent](https://github.com/KunalMGupta/interioragent): skills, relational placement and visual iteration; inspect separate dataset/asset licenses, no bulk dataset.
- [Radiance](https://github.com/LBNL-ETA/Radiance): P6 quantitative lighting candidate.

Before incorporating code/assets record exact source URL/ref, SPDX or text, obligations and distribution decision. Include pinned Git dependencies, fonts, textures, models, sample scenes and branding. Exclude unclear licenses. Retain upstream notice. No build, license inventory, actual device or MCP execution yet.
