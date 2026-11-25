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
