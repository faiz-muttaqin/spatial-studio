import type { CaptureCoordinateFrame } from './schema'

/** Column-major 4x4 product `a * b`, the order three.js `Matrix4.multiply` uses. */
export function multiplyMatrix4(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0)
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[column * 4 + k]!
      out[column * 4 + row] = sum
    }
  }
  return out
}

export function isIdentityMatrix4(matrix: readonly number[]): boolean {
  return matrix.every((value, index) => Math.abs(value - (index % 5 === 0 ? 1 : 0)) < 1e-9)
}

/**
 * A stream's frame as a transform into the root frame, the way the viewer resolves it
 * (`packages/viewer/src/capture/frame.ts`): each frame's `transform` is applied, then its
 * parent's. `unresolved` is a frame id the manifest does not define, or a cycle; the stream is then
 * read as it is and the caller says so.
 */
export function resolveFrameTransform(
  frames: readonly CaptureCoordinateFrame[],
  frameId: string | undefined,
): { matrix: number[] | null; unresolved: boolean } {
  if (!frameId) return { matrix: null, unresolved: false }
  const byId = new Map(frames.map((frame) => [frame.id, frame]))
  const seen = new Set<string>()
  let matrix: number[] | null = null
  let current: string | undefined = frameId
  while (current) {
    if (seen.has(current)) return { matrix: null, unresolved: true }
    seen.add(current)
    const frame = byId.get(current)
    if (!frame) return { matrix: null, unresolved: true }
    if (frame.transform)
      matrix = matrix ? multiplyMatrix4(frame.transform, matrix) : [...frame.transform]
    current = frame.parentId
  }
  return { matrix: matrix && !isIdentityMatrix4(matrix) ? matrix : null, unresolved: false }
}
