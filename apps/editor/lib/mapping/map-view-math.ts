/**
 * Pan, zoom and turn for the map canvas, and the mapping between level metres and the screen.
 *
 * The 2D plan draws level x to the right and level z downward, and turns its scene group by
 * `FLOORPLAN_VIEW_ROTATION_DEG + userRotation - buildingRotation` (SVG `rotate`, clockwise on
 * screen). The map applies the same turn about the level origin:
 * `screen = offset + scale * R(rotationDeg) * (x, z)`. With no turn it is `offset + scale * (x, z)`,
 * so nothing is flipped and walls and the orthomap stay on top of each other.
 */
export type MapViewport = {
  /** Screen pixels of level origin (0, 0). */
  offsetX: number
  offsetY: number
  /** Screen pixels per metre. */
  scale: number
  /** Clockwise screen turn of the scene in degrees, as the 2D plan applies it. */
  rotationDeg: number
}

export const MIN_SCALE = 5
export const MAX_SCALE = 2000

function turn(x: number, z: number, rotationDeg: number): [number, number] {
  if (rotationDeg === 0) return [x, z]
  const radians = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return [x * cos - z * sin, x * sin + z * cos]
}

export function levelToScreen(view: MapViewport, x: number, z: number): [number, number] {
  const [tx, tz] = turn(x, z, view.rotationDeg)
  return [view.offsetX + tx * view.scale, view.offsetY + tz * view.scale]
}

export function screenToLevel(view: MapViewport, sx: number, sy: number): [number, number] {
  return turn((sx - view.offsetX) / view.scale, (sy - view.offsetY) / view.scale, -view.rotationDeg)
}

/** Zooms by `factor` keeping the level point under (sx, sy) fixed. */
export function zoomAt(view: MapViewport, sx: number, sy: number, factor: number): MapViewport {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor))
  const [x, z] = screenToLevel(view, sx, sy)
  const [tx, tz] = turn(x, z, view.rotationDeg)
  return { ...view, scale, offsetX: sx - tx * scale, offsetY: sy - tz * scale }
}

/** A viewport that shows `bounds` (level metres, as turned) inside a screen with a margin. */
export function fitBounds(
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
  width: number,
  height: number,
  rotationDeg = 0,
  margin = 32,
): MapViewport {
  const corners = [bounds.minX, bounds.maxX].flatMap((x) =>
    [bounds.minZ, bounds.maxZ].map((z) => turn(x, z, rotationDeg)),
  )
  const xs = corners.map((corner) => corner[0])
  const zs = corners.map((corner) => corner[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minZ = Math.min(...zs)
  const maxZ = Math.max(...zs)
  const spanX = Math.max(0.01, maxX - minX)
  const spanZ = Math.max(0.01, maxZ - minZ)
  const scale = Math.min(
    MAX_SCALE,
    Math.max(MIN_SCALE, Math.min((width - 2 * margin) / spanX, (height - 2 * margin) / spanZ)),
  )
  return {
    scale,
    rotationDeg,
    offsetX: (width - spanX * scale) / 2 - minX * scale,
    offsetY: (height - spanZ * scale) / 2 - minZ * scale,
  }
}

/** A round length (1, 2, 5 times a power of ten metres) that spans roughly `targetPx` pixels. */
export function scaleBar(scale: number, targetPx = 120): { metres: number; pixels: number } {
  const raw = targetPx / scale
  const exponent = 10 ** Math.floor(Math.log10(raw))
  const fraction = raw / exponent
  const nice = fraction >= 5 ? 5 : fraction >= 2 ? 2 : 1
  const metres = nice * exponent
  return { metres, pixels: metres * scale }
}

/**
 * Clockwise angle from screen-up, in degrees, of a level direction (x, z) once the scene is
 * turned by `rotationDeg`.
 */
export function northScreenAngle(north: readonly [number, number], rotationDeg = 0): number {
  const [x, z] = turn(north[0], north[1], rotationDeg)
  return (Math.atan2(x, -z) * 180) / Math.PI
}
