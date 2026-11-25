'use client'

import { useEffect, useMemo } from 'react'
import { DoubleSide, FrontSide } from 'three'
import { createClayMatcap } from './clay-matcap'
import { createSurfaceMeshGeometry } from './surface-mesh-data'

export { buildSurfaceMeshData, type SurfaceMeshData } from './surface-mesh-data'

export function CaptureSurfaceMeshLayer({
  inline,
  dollhouse = false,
  appearance = 'recorded',
  opacity = 1,
}: {
  inline: unknown
  dollhouse?: boolean
  appearance?: 'clay' | 'recorded'
  /** 0 to 1. */
  opacity?: number
}) {
  const blended = opacity < 1
  const matcap = useMemo(() => (appearance === 'clay' ? createClayMatcap() : null), [appearance])
  useEffect(() => () => matcap?.dispose(), [matcap])
  const geometry = useMemo(() => createSurfaceMeshGeometry(inline), [inline])
  useEffect(() => () => geometry?.dispose(), [geometry])
  if (!geometry) return null

  return (
    <mesh frustumCulled={false} geometry={geometry}>
      {matcap ? (
        <meshMatcapMaterial
          depthWrite={!blended}
          matcap={matcap}
          opacity={opacity}
          side={dollhouse ? FrontSide : DoubleSide}
          transparent={blended}
        />
      ) : (
        <meshStandardMaterial
          depthWrite={!blended}
          metalness={0}
          opacity={opacity}
          roughness={0.9}
          side={dollhouse ? FrontSide : DoubleSide}
          transparent={blended}
          vertexColors
        />
      )}
    </mesh>
  )
}
