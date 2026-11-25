/**
 * Pan and zoom for the map canvas, and the mapping between level metres and the screen.
 *
 * The 2D plan draws level x to the right and level z downward, so the map uses the same axes:
 * `screenX = offsetX + x * pxPerMetre`, `screenY = offsetY + z * pxPerMetre`. No flip, which is
 * what keeps walls and the orthomap on top of each other.
 */
export type MapViewport = {
  /** Screen pixels of level origin (0, 0). */
  offsetX: number
  offsetY: number
  /** Screen pixels per metre. */
  scale: number
}

export const MIN_SCALE = 5
export const MAX_SCALE = 2000

export function levelToScreen(view: MapViewport, x: number, z: number): [number, number] {
  return [view.offsetX + x * view.scale, view.offsetY + z * view.scale]
}

export function screenToLevel(view: MapViewport, sx: number, sy: number): [number, number] {
  return [(sx - view.offsetX) / view.scale, (sy - view.offsetY) / view.scale]
}

/** Zooms by `factor` keeping the level point under (sx, sy) fixed. */
export function zoomAt(view: MapViewport, sx: number, sy: number, factor: number): MapViewport {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor))
  const [x, z] = screenToLevel(view, sx, sy)
  return { scale, offsetX: sx - x * scale, offsetY: sy - z * scale }
}

/** A viewport that shows `bounds` (level metres) inside a `width` x `height` screen with a margin. */
export function fitBounds(
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
  width: number,
  height: number,
  margin = 32,
): MapViewport {
  const spanX = Math.max(0.01, bounds.maxX - bounds.minX)
  const spanZ = Math.max(0.01, bounds.maxZ - bounds.minZ)
  const scale = Math.min(
    MAX_SCALE,
    Math.max(MIN_SCALE, Math.min((width - 2 * margin) / spanX, (height - 2 * margin) / spanZ)),
  )
  return {
    scale,
    offsetX: (width - spanX * scale) / 2 - bounds.minX * scale,
    offsetY: (height - spanZ * scale) / 2 - bounds.minZ * scale,
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

/** Clockwise angle from screen-up, in degrees, of a level direction (x, z). */
export function northScreenAngle(north: readonly [number, number]): number {
  return (Math.atan2(north[0], -north[1]) * 180) / Math.PI
}
