# Glass, mirrors and the room boundary

Status: plan, owner context of 2026-11-25. Nothing implemented. Phones without LiDAR see through clear glass and into mirrors, so the visible scene is not the physical room. The first device test showed it: 28% of the point cloud lay more than 6 m beyond the walked path ([DEVICE_TESTS.md](DEVICE_TESTS.md)).

## Principle

Keep three things apart and never merge them silently: physical boundary (what you cannot walk through), visual observations (everything the camera saw, including outside the glass and inside reflections), and semantics (window, glass partition, mirror, door). When the scanner cannot tell, it asks the user to confirm a boundary instead of guessing (draft capture phase, [SENSING_RESEARCH.md](SENSING_RESEARCH.md)).

## Evidence that works without LiDAR

| Evidence | Why it helps | Stage |
|---|---|---|
| Walked path | The phone never passes through glass, so the room boundary must enclose the trajectory; a wall candidate that cuts the path is wrong | P3b |
| Floor and ceiling planes | Hit-tests on the floor next to the glass are reliable even when the glass itself is not; the glass plane stands on that floor line | P2N, P3b |
| Frames and mullions | Textured frames give feature points and depth near the true glass plane | P3b |
| Acquisition filtering | Drop feature points far from the camera and with low confidence | P2N.2 (in progress) |
| Mirror symmetry | A mirror produces geometry symmetric to the real room across its plane; reflecting points across a candidate plane and finding overlap flags a mirror | P5 research |
| Vision model on keyframes | Identifies windows, glass doors and mirrors in photos through `view_scan_photos`; poses and intrinsics turn a 2D finding into a ray, and the floor line fixes its depth | P4a/P4b, user-verified |
| Temporary markers | Masking tape or printed ArUco/AprilTag markers on frameless glass give trackable points on the plane | Optional, assisted |

Hit-testing the middle of clear glass is not trusted: it returns whatever is behind it.

## Assisted marking (planned)

On the scan screen: "Mark boundary" with kind `glass`, `mirror`, `opening` or `door`. The user taps the floor at both ends of the glass base (floor hit-tests), then the height comes from the ceiling plane or a typed value. Recorded as a new `boundary-marks` stream (contract change first) with the hit-test poses, kind and source `manual-ar-marking`.

## Classification, not deletion

Observations outside the confirmed boundary move to separate layers (exterior context, reflection artefacts, unclassified); they are never deleted, and can still inform daylight and views. Across a glass partition between rooms, they belong to the neighbouring room rather than to the exterior.

## Mapping to Pascal

Use existing nodes, verified before anything new is proposed: full-height glass as a wall with `wallType: 'curtain'` (`packages/core/src/schema/nodes/wall.ts`, glazed curtain-wall layout in `packages/nodes/src/wall`), glass in a solid wall as `window` or `door` nodes, an open boundary as a `separator`, and a mirror as a finish or item on a standard wall. Evidence and verification status stay in the scan bundle and the review flow, not in new node fields, until a gap is proven.

## Research candidates (P5, unverified here)

Single-image glass detection (for example GDNet, CVPR 2020) and later glass-segmentation and glass-aware SLAM work. Check each paper, code licence and weight licence before use; several published checkpoints are non-commercial.

## Test fixtures to add

Window in a solid wall, glass wall from floor to ceiling, frameless partition, large mirror, glass door open and closed. Synthetic fixtures in tests; real captures stay outside Git.
