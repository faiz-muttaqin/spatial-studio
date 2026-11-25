# Algorithm study: room scanning methods from reference projects

Status: study of 2026-11-25, owner request. The owner treats this fork as a private lab proof of concept. Methods are re-implemented in our TypeScript and Kotlin; where code is ported, the source file and commit below are cited in the code comment. Reference clones live outside this repository (`~/git/spatial-refs/`), never vendored.

## Sources

| Project | Commit | Licence file | What it teaches |
|---|---|---|---|
| Plan3D (`apiel/plan3d`) | `8d0692f4a496` | none (package.json says MIT) | Free-space carving to a room outline, Manhattan snap, doorway neck cut, least-squares tape solver, door-to-door room joining |
| Mesh2Plan (`theLodgeBots/mesh2plan`) | `5705548929ec` | none (README says MIT) | Height-span wall filter, multi-slice wall scoring; many one-dataset experiments |
| SceneView (`sceneview/sceneview`) | `820e17c8537b` | Apache-2.0 | Raw depth back-projection with colour along the same ray, 2 cm voxel colour fusion, per-plane photo texturing, coverage grid, pose-jump guard, ARCore torch config |
| 3DLiveScanner (`lvonasek/3DLiveScanner`) | `ea057def9270` | Apache-2.0 | Occlusion-tested texturing, per-row/column exposure offsets, bad-frame removal |
| RTAB-Map (`introlab/rtabmap`) | `018eeb2b3dac` | BSD-3-Clause | Proximity loop closure, ICP gates, pose-graph optimisation, view selection and gain compensation for texturing |
| ARCore SDK samples (`google-ar/arcore-android-sdk`) | `204ddfd1715e` | Apache-2.0 (samples) | Official raw depth unprojection, shared camera, recording and playback |

## Findings that change our pipeline

1. **Pixel-centre convention.** The official raw depth sample unprojects with integer pixel indices: `X = d(x - cx)/fx`, `Y = d(cy - y)/fy`, `Z = -d`, with intrinsics from `getTextureIntrinsics` scaled to the depth image, exactly as `ScanRecorder.kt` scales them. `depth-walls.ts` adds `+0.5`, a half depth pixel (about 1.5 cm at 5 m). Align with the sample and document it.
2. **Free-space carving is the best room-outline method we have seen without walls** (Plan3D `src/scan/extract.ts`, `run()`, `line()`, `cutNecks()`, `snapToWalls()`):
   - floor and ceiling from height percentiles (2nd and 98th);
   - a wall band above furniture (floor + 1.5 m to ceiling - 0.15 m);
   - a 5 cm grid counting wall hits (occupied at 2 or more) and camera-to-point ray crossings (free at 3 or more, rays stop at occupied cells);
   - close, fill and largest component;
   - a doorway neck cut that keeps the part holding most camera positions;
   - outline tracing, then a Manhattan snap by length-weighted 4θ voting, run twice so walls align with the grid.

   Caveat for us: rays pass through clear glass and carve the outside as free space, so our walked-path constraint and glass flags must still bound it.
3. **Colour from photos.** SceneView `DenseCloud.kt` / `DenseFusion.kt`:
   - keep depth pixels at 0.2 to 5 m with confidence of 128 or more;
   - reject edge-on pixels (cosθ under 0.15) and depth jumps;
   - weight = `conf/255 · min(1, (1 m/d)²) · cosθ`;
   - colour read from the camera image along the same ray;
   - 2 cm voxels holding a weighted mean of position, colour and normal, saved only with 2 or more views.
4. **Top-down colour map.** SceneView `PlaneBake.kt` (per-plane texel, up to 12 photos scored by squareness, closeness and centrality, consensus around an anchor colour) plus 3DLiveScanner `postproc/texturize.cc` (depth-test occlusion, per-row/column exposure offset) and RTAB-Map `util3d_surface.cpp` (frustum, occlusion, angle and distance view selection, gain compensation).
5. **Coverage feedback while scanning.** SceneView `ScanCoverage.kt`, `LiveCoverageGround.kt`, `ScanGuide.kt`: 25 cm floor cells, covered, frontier and hatched gaps, "wall missing" cues; `ScanPhotoMotion` speed gate; `PoseContinuity.kt` jump guard.
6. **Torch.** ARCore 1.45+ has `Config.FlashMode.TORCH` (back camera), probed with `session.isSupported(config)` and falling back to off (SceneView `ArSession.kt`). No shared-camera rework is needed. Physics: flash irradiance falls as 1/r², so torch-on minus torch-off frames give a near-range relative cue (about 3 to 5 m at most), weak on dark surfaces. A specular highlight at a depth hole is a glass hint, not a detector. Auto-exposure shifts must be compensated.
7. **Drift.** None of the Android scanners does loop closure; they guard against pose jumps instead. RTAB-Map's offline recipe is: proximity candidates (1 m, 30 degrees), ICP gates (max translation 0.2 m, correspondence ratio 0.1), pose-graph optimisation, and rejecting loops whose error ratio exceeds 3. That is a later step for multi-room scans.
8. **Measurement solver.** Plan3D `src/solver.ts` is Levenberg-Marquardt over corners with one scale per room. It takes tape distances, right angles, parallel and equal-length constraints, reports a per-wall sigma, and says which wall to measure next.
9. **Repeatable tests.** ARCore recording and playback (`RecordingConfig`, MP4 plus custom tracks) replays the scan UI and keyframe logic. Poses are re-estimated on each playback, so our own bundles remain the ground truth for offline algorithms.

## Adoption plan

| Step | What | Where | Effort |
|---|---|---|---|
| R1 | Coloured dense cloud and top-down orthomap from keyframes plus depth; MCP tool that returns the orthomap image to agents | `packages/core/src/capture` (pure), `packages/mcp` | M |
| R2 | Free-space carving outline as a third evidence source in the room proposal, plus the pixel-centre fix | `packages/core/src/capture` (`depth-walls.ts`, `room-proposal.ts`, new carving module) | M |
| R3 | Android coverage grid, speed and jump guard, torch experiment (flag recorded per keyframe) | `apps/android` | M |
| R4 | Mapping view: a host view beside 3D and 2D showing the colour orthomap with the scene's walls and the proposal overlaid, computed in a Web Worker | `apps/editor` host view | M |
| Later | Tape solver, door-to-door joining, loop closure, texture atlas | core and editor | M to L |

## RoomPlan and Polycam parity

Target experience: Apple RoomPlan (labelled walls, doors, windows, openings and furniture as sized objects) and Polycam (photoreal capture), built from open methods on this fork. Our differentiator stays the editable Pascal scene plus the MCP agent.

| Capability | Open source to learn from | Our route | Step |
|---|---|---|---|
| Guided capture, coverage | SceneView `ScanCoverage.kt` | Android coverage grid and guards | R3 |
| Walls and outline | Plan3D carving, our depth walls | carving plus depth-fit plus planes | R2 |
| Coloured scan, top-down map | SceneView fusion, 3DLiveScanner texturing | colour cloud and orthomap | R1 |
| Doors, windows, furniture as objects | SpatialLM (`8913c44d84a4`), RoomFormer (`e88a7e3a81e3`) | agent-driven semantics (below); SpatialLM as an optional GPU benchmark | R5, R7 |
| Photoreal capture | Brush (`d43bd1e6b232`, Apache-2.0) | Brush dataset export, splat layer in the viewer | R6 |
| Mapping view | (ours) | host view beside 3D and 2D | R4 |

### Semantics without a GPU (R5)

SpatialLM outputs `Wall(ax,ay,az,bx,by,bz,height,thickness)`, `Door/Window(wall, centre, width, height)` and `Bbox(class, centre, yaw, size)` from a Z-up metric point cloud. However, the shipped code needs CUDA, and the published checkpoints carry non-commercial terms. Its own phone-video test set gives F1@.25 of about 68 for walls, 47 for doors and 51 for windows, and weak scores for most furniture. Our primary path uses the MCP agent instead:
1. For each wall, choose keyframes that face it.
2. The agent marks doors, windows and furniture in those photos (label, 2D box, confidence).
3. Lift the marks to 3D with the 160x90 depth inside the box (confidence-filtered median), the intrinsics and the pose. Snap doors and windows to the nearest wall; fit oriented boxes for furniture.
4. Cluster detections across views (two or more views, or flag as uncertain).
5. Map to Pascal `door`/`window` nodes and catalogue items (`search_assets`, `place_items`), all as a draft for the user to verify.

SpatialLM's output grammar is a good target schema for the agent's structured answer. An optional SpatialLM GPU service (Z-up PLY in, layout JSON out, stored as a derived stream with model version and seed) can benchmark the agent path on the same scans (R7).

### Photoreal capture (R6)

Brush trains Gaussian splats on desktop, Android or browser WebGPU (Chrome 134+) from a nerfstudio `transforms.json` or COLMAP dataset, with poses fixed as given and an optional initial PLY.
- **Export.** A "Brush dataset" zip: `images/` with unrotated 1920x1080 keyframes, `transforms.json` with `transform_matrix` taken directly from our column-major OpenGL camera-to-world (written as rows) and `fl_x, fl_y, cx, cy, w, h`, and `points.ply` from the R1 colour cloud. Check the export by reprojecting the cloud into keyframes.
- **Training.** The owner trains in Brush on a GPU machine or a WebGPU laptop; the VM does not.
- **Upload and render.** The exported splat PLY (or a compressed format) is uploaded as a `gaussian-splat` stream (kind already named in the core schema) and rendered as a capture layer in ARCore world metres, so it needs no extra transform. Spark (three.js) is the first renderer to try.
- **Risks.** ARCore drift and exposure changes cause floaters; Brush has no pose refinement; splat files are large, so deliver them compressed.
