# Photoreal capture with Brush (R6)

Owner workflow: export a scan as a training dataset, train a Gaussian splat in [Brush](https://github.com/ArthurBrussee/brush) (Apache-2.0, checked against commit `d43bd1e6b232`), upload the PLY and view it as a layer. The VM does not train.

## 1. Download the dataset

Open the project, select the scan, and in the **Scan evidence** panel under **Photoreal capture** choose **Download Brush dataset (.zip)**. The same file is served by `GET /api/scans/{sceneId}/{scanId}/brush-dataset` (session cookie or `PASCAL_SCENE_API_TOKEN`).

The zip holds:

- `images/<keyframe id>.jpg`: the stored, unrotated keyframes (at most 1920 px on the long edge), unchanged.
- `transforms.json`: nerfstudio format, `camera_model: "PERSPECTIVE"` (Brush rejects `PINHOLE`; a plain pinhole is `PERSPECTIVE`), one frame per tracked keyframe with `file_path`, `fl_x`, `fl_y`, `cx`, `cy`, `w`, `h` in pixels of the stored image, and `transform_matrix` as the four rows of the camera-to-world pose (OpenGL axes, ARCore world, Y up, metres). Brush reads that convention directly, so no axis flip is applied.
- `points.ply`: the initial cloud, binary PLY with `x y z red green blue`, named in `transforms.json` as `ply_file_path`. It comes from the bundle's `point-cloud` stream, in the same world as the poses, and is mid grey where the bundle has no colours. The coloured dense cloud from `buildDenseCloud` can replace it through the `cloud` option of `exportBrushDataset`; that is not wired to the route yet.

The download link uses the browser's session cookie. A deployment that only sets `PASCAL_SCENE_API_TOKEN` has no cookie, so fetch the zip with `curl -H "Authorization: Bearer $TOKEN" -o dataset.zip <url>` instead. Images keep their real type (`.jpg`, `.png` or `.webp`).

Keyframes that are not tracking, or lack a pose, intrinsics or a stored image, are left out and counted in the `X-Brush-Skipped-Frames` response header. Nothing in the zip identifies a place beyond the images and poses themselves, so treat it like the scan.

## 2. Train in Brush

Use the desktop app (a GPU machine) or the WebGPU web app (Chrome 134 or later) and load the zip or its extracted folder. Poses are used as given; Brush does no pose refinement, so ARCore drift shows up as blur and floaters.

Suggested starting settings for a laptop (not tuned on a real scan; adjust to what fits in memory and time):

- Maximum resolution 1280 (the keyframes are 1920x1080).
- Spherical-harmonics degree 0 or 1. The viewer layer draws only the degree-0 colour, so degree 0 gives the smallest file and loses nothing here.
- Keep the splat count modest: the file limit is 96 MiB and the viewer draws at most 1,000,000 splats (about 60 MB at degree 0).

Export the result as PLY. Brush keeps the world it was given, so the splat should line up with the scan's point cloud with no transform. That follows from Brush's source and the layer was only exercised with a synthetic splat, so check the alignment on the first real result.

## 3. Upload and view

In the same panel choose **Upload trained splat (.ply)**. The file must be a binary little-endian 3DGS PLY of at most 96 MiB; the server checks the header too. The "Trained with" field (default `brush`) is recorded as the stream's `trainer`. The editor stores it as an artifact (`PUT /api/artifacts/{sha256}` with `X-Artifact-Kind: gaussian-splat`), writes a new manifest with a `gaussian-splat` stream (see [CAPTURE_CONTRACT.md](CAPTURE_CONTRACT.md), "Gaussian splat stream (v1.4)") and points the scan at it. The project autosaves. A **Gaussian splat** checkbox then appears under Layers.

Uploading again replaces the stream; the old artifacts stay in the store.

## Renderer choice

Spark (`@sparkjsdev/spark` 2.4.0, MIT, published 2026-10-20, peer `three >=0.180`) was checked first. It needs a `THREE.WebGLRenderer`, and the viewer renders with `WebGPURenderer` (with its WebGL 2 fallback backend, which is still not a `WebGLRenderer`), so it cannot draw in the viewer's canvas. Running it on a second canvas would lose the shared camera and layering. The layer is therefore in-house: `packages/viewer/src/capture/layers/splat-layer.tsx`, a TSL node material (3D covariance projected to a 2D footprint, 3 sigma quads, alpha blended, depth-sorted on the CPU by a 16-bit counting sort when the view moves). It adds no dependency and is loaded lazily, so `/project/[id]` only fetches it when a scan has a splat.

Limits: view-dependent colour (SH above degree 0) is not drawn; the layer draws on the overlay layer, so it is not occluded by walls and furniture; compressed formats (SPZ, SOG) are not accepted; sorting runs on the main thread. Performance with a large real splat has not been measured.
